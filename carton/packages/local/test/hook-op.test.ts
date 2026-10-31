// The `hook` write (H8): an agent's Claude Code hook events (read, write, stop) for the lease holder's materializer.
// Here without processes: what a hook input means (`hookEventFor`), how the holder runs it (`runWrite`: once per request
// id, no `cb`-call freeze, no notices given away), `runHook`'s `send`, and the `--settings` matcher. hook-holder.test.ts
// sends them across processes to cardboard-adapter's real Materializer.
import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { Carton } from "@carton/core";
import type { Actor } from "@carton/core";
import { createMemoryStore } from "@carton/store-memory";
import { hookEventFor, prefixCommand, preToolUse } from "../src/hooks.ts";
import { hookDelivered, parseActorId } from "../src/identity.ts";
import { hookSettings, runHook } from "../src/hook-cli.ts";
import { actorKey, runWrite, tellBusy } from "../src/writes.ts";
import type { CbResult, ViewPrinter } from "../src/writes.ts";
import { adapter, doc0 } from "./support/real.ts";

const dir = join("/", "work", "Demo.cardboard");
const at = (...p: string[]) => join(dir, ...p);
const session = { session_id: "abcdef1234" };

test("hookEventFor: a Read of the shared file, a Write/Edit of it, a stop; the prefixer's actor", () => {
  const read = hookEventFor("pre-tool-use", { ...session, tool_name: "Read", tool_input: { file_path: at("timeline.tsx") } }, { projectDir: dir })!;
  assert.deepEqual(read.op, { kind: "hook", event: "read", file: "timeline.tsx" });
  assert.equal(read.actor.id, "claude-code/abcdef12");
  assert.ok(hookDelivered(read.actor), "a hooked agent: its view is named after it, its pins are its turn's");
  // the same actor the prefixer exports for its `cb` calls, down to the subagent
  const sub = { ...session, agent_type: "editor", agent_id: "q", tool_name: "Edit", tool_input: { file_path: at("timeline.tsx") } };
  const e = hookEventFor("pre-tool-use", sub, { projectDir: dir })!;
  assert.deepEqual(e.op, { kind: "hook", event: "write", file: "timeline.tsx" });
  assert.equal(e.actor.id, prefixCommand({ ...sub, tool_input: { command: "cb history Demo" } })!.actor);
  assert.equal(e.actor.kind, "subagent");
  const director = hookEventFor("pre-tool-use", { ...session, tool_name: "Read", tool_input: { file_path: at("timeline.tsx") } }, { projectDir: dir, turn: { chat: "c1", turn: "t9" } })!;
  assert.equal(director.actor.id, "director/c1/t9");
  assert.equal(director.actor.turn, "t9");

  assert.deepEqual(hookEventFor("pre-tool-use", { ...session, tool_name: "MultiEdit", tool_input: { file_path: at("timeline.tsx") } }, { projectDir: dir })?.op, { kind: "hook", event: "write", file: "timeline.tsx" });
  assert.deepEqual(hookEventFor("pre-tool-use", { ...session, tool_name: "Write", tool_input: { file_path: "timeline.tsx" }, cwd: dir }, { projectDir: dir })?.op, { kind: "hook", event: "write", file: "timeline.tsx" }, "relative to the hook's cwd");
  assert.deepEqual(hookEventFor("pre-tool-use", { ...session, tool_name: "Edit", tool_input: { file_path: at("Timeline.tsx") } }, { projectDir: dir, foldCase: true })?.op, { kind: "hook", event: "write", file: "timeline.tsx" }, "case-insensitive file systems");
  const none: [string, string, boolean?][] = [
    ["Read", at("project.json")], // reading project.json starts no freeze
    ["Edit", at("project.json")], // denied (preToolUse), never credited
    ["Read", at(".scratch", "views", "mine.tsx")], // a view: its own pins, no hook needed
    ["Edit", at(".scratch", "views", "mine.tsx")], // credited to its owner without a hook
    ["Write", at("media", "notes.tsx")],
    ["Read", join("/", "elsewhere", "timeline.tsx")],
    ["Edit", at("..", "timeline.tsx")],
    ["Edit", at("Timeline.tsx"), false], // case-sensitive: another file
    ["Bash", at("timeline.tsx")],
  ];
  for (const [tool, file, fold] of none) assert.equal(hookEventFor("pre-tool-use", { ...session, tool_name: tool, tool_input: { file_path: file } }, { projectDir: dir, ...(fold === false ? { foldCase: false } : {}) }), null, `${tool} ${file}`);
  assert.equal(hookEventFor("pre-tool-use", { ...session, tool_name: "Read", tool_input: { file_path: at("timeline.tsx") } }), null, "no project: nothing to match");
  assert.deepEqual(hookEventFor("stop", { ...session, hook_event_name: "SubagentStop", agent_type: "editor", agent_id: "q" })!.op, { kind: "hook", event: "stop" });
});

test("preToolUse: a Write, Edit or MultiEdit of the project's project.json is denied, with the way to edit instead (§6.4, review H8 #5)", () => {
  for (const tool of ["Write", "Edit", "MultiEdit"]) {
    const r = preToolUse({ ...session, tool_name: tool, tool_input: { file_path: at("project.json") } }, { projectDir: dir });
    assert.equal(r.event, null, `${tool}: nothing told, the write won't happen`);
    const h = (r.output as any).hookSpecificOutput;
    assert.deepEqual([h.hookEventName, h.permissionDecision], ["PreToolUse", "deny"], tool);
    assert.match(h.permissionDecisionReason, /cb source print --view <name>/);
    assert.equal(h.updatedInput, undefined);
  }
  // case-insensitive file systems; relative to the hook's cwd
  assert.equal((preToolUse({ ...session, tool_name: "Write", tool_input: { file_path: at("Project.JSON") } }, { projectDir: dir, foldCase: true }).output as any).hookSpecificOutput?.permissionDecision, "deny");
  assert.equal((preToolUse({ ...session, tool_name: "Edit", tool_input: { file_path: "project.json" }, cwd: dir }, { projectDir: dir }).output as any).hookSpecificOutput?.permissionDecision, "deny");
  // not denied: reading it, another project's, a project.json deeper in the bundle, no project known
  for (const [tool, file, o] of [["Read", at("project.json"), { projectDir: dir }], ["Edit", join("/", "other", "project.json"), { projectDir: dir }], ["Edit", at("media", "project.json"), { projectDir: dir }], ["Edit", at("project.json"), {}]] as const) {
    assert.deepEqual(preToolUse({ ...session, tool_name: tool, tool_input: { file_path: file } }, o).output, {}, `${tool} ${file}`);
  }
});

/** A materializer that records the hook calls (and can be made to fail, or to take a while). */
function recorder() {
  const calls: string[] = [];
  let fail = 0;
  let gate: Promise<void> | null = null;
  const rec = (s: string) => async () => {
    calls.push(s);
    if (gate) await gate;
    if (fail > 0) { fail--; throw new Error("materializer busy"); }
  };
  const mz: ViewPrinter & { onCbs: number } = {
    onCbs: 0,
    async printView(name) { return { name, path: `.scratch/views/${name}.tsx`, ref: "Main@1~0000 b:x p:y" }; },
    async onCb() { mz.onCbs++; },
    hookRead: (a: Actor) => rec(`read ${a.id}`)(),
    hookWrite: (a: Actor, rel: string) => rec(`write ${a.id} ${rel}`)(),
    hookStop: (a: Actor) => rec(`stop ${a.id}`)(),
  };
  return { mz, calls, failNext: (n = 1) => { fail = n; }, hold: () => { let open!: () => void; gate = new Promise((r) => (open = r)); return () => { gate = null; open(); }; } };
}

const agent = parseActorId("claude-code/abcdef12")!;
const codex: Actor = { kind: "agent", id: "codex/fix", name: "Codex (fix)", provider: "codex" };
async function opened() {
  return Carton.open({ adapter, store: createMemoryStore(), init: { doc: doc0() }, actor: { kind: "system", id: "engine" } });
}
const hookOf = (r: CbResult) => r.hook as { event: string; delivered: boolean; again?: boolean } | undefined;

test("runWrite `hook`: the materializer's hookRead / hookWrite / hookStop with the request's actor; no cb-call freeze", async () => {
  const c = await opened();
  try {
    const { mz, calls } = recorder();
    const r1 = await runWrite(c, { id: "h.1", actor: agent, op: { kind: "hook", event: "read", file: "timeline.tsx" } }, { materializer: mz });
    assert.equal(r1.status, "confirmed", JSON.stringify(r1));
    assert.deepEqual(hookOf(r1), { event: "read", delivered: true });
    await runWrite(c, { id: "h.2", actor: agent, op: { kind: "hook", event: "write", file: "./timeline.tsx" } }, { materializer: mz });
    await runWrite(c, { id: "h.3", actor: agent, op: { kind: "hook", event: "write", file: "sub\\project.json" } }, { materializer: mz });
    await runWrite(c, { id: "h.4", actor: agent, op: { kind: "hook", event: "stop" } }, { materializer: mz });
    assert.deepEqual(calls, ["read claude-code/abcdef12", "write claude-code/abcdef12 timeline.tsx", "write claude-code/abcdef12 sub/project.json", "stop claude-code/abcdef12"]);
    assert.equal(mz.onCbs, 0, "a hook event is not a cb call: it doesn't freeze the shared file by itself");
    await runWrite(c, { id: "h.5", actor: codex, op: { kind: "pin", owner: "x" } }, { materializer: mz });
    assert.equal(mz.onCbs, 1, "a cb call does");

    for (const file of [undefined, "", "../timeline.tsx", "/etc/passwd", "C:\\x\\timeline.tsx", "a//b"]) {
      const bad = await runWrite(c, { id: `h.bad.${file}`, actor: agent, op: { kind: "hook", event: "write", ...(file === undefined ? {} : { file }) } }, { materializer: mz });
      assert.equal(bad.status, "error", `${file}: ${JSON.stringify(bad)}`);
    }
    const odd = await runWrite(c, { id: "h.odd", actor: agent, op: { kind: "hook", event: "peek" as never } }, { materializer: mz });
    assert.equal(odd.status, "error");
    assert.equal(calls.length, 4, "nothing told for a refused event");

    // nobody to tell: no materializer, or one without hooks
    assert.deepEqual(hookOf(await runWrite(c, { id: "h.6", actor: agent, op: { kind: "hook", event: "read" } })), { event: "read", delivered: false });
    const bare: ViewPrinter = { printView: mz.printView };
    assert.deepEqual(hookOf(await runWrite(c, { id: "h.7", actor: agent, op: { kind: "hook", event: "stop" } }, { materializer: bare })), { event: "stop", delivered: false });
  } finally {
    await c.close();
  }
});

test("a cb call: a hooked agent's is hookRead (its Stop ends the freeze), anyone else's onCb (windows-sync H8)", async () => {
  const c = await opened();
  try {
    const { mz, calls } = recorder();
    const sub = parseActorId("claude-code/abcdef12/sub-editor-q")!;
    const director = parseActorId("director/chat1/turn2")!;
    const person = { kind: "human" as const, id: "human:me" };
    const w = (id: string, actor: Actor, m: ViewPrinter = mz) => runWrite(c, { id, actor, op: { kind: "pin", owner: id } }, { materializer: m });
    for (const [i, a] of [agent, sub, director].entries()) {
      assert.ok(hookDelivered(a), a.id);
      await w(`b.${i}`, a);
    }
    assert.deepEqual(calls.splice(0), ["read claude-code/abcdef12", "read claude-code/abcdef12/sub-editor-q", "read director/chat1/turn2"]);
    assert.equal(mz.onCbs, 0, "no windowless freeze: the agent's Stop ends it");
    await w("b.codex", codex);
    await w("b.person", person);
    await w("b.unknown", { kind: "agent", id: "claude-code" });
    assert.deepEqual([calls, mz.onCbs], [[], 3], "nothing reports their stop: onCb");
    // a materializer that can't end a hooked freeze (no hookStop): onCb for everyone
    let read = 0, cbs = 0;
    const noStop: ViewPrinter = { printView: mz.printView, hookRead: async () => void read++, onCb: async () => void cbs++ };
    await w("b.noStop", agent, noStop);
    assert.deepEqual([read, cbs], [0, 1]);
    // a hook event is none of these (the Stop must not freeze the file again)
    await runWrite(c, { id: "b.stop", actor: agent, op: { kind: "hook", event: "stop" } }, { materializer: mz });
    assert.deepEqual([calls, mz.onCbs], [["stop claude-code/abcdef12"], 3]);
  } finally {
    await c.close();
  }
});

test("tellBusy: one hookRead per hooked author; onCb once if anyone else (or nobody known) is among them", async () => {
  const { mz, calls } = recorder();
  await tellBusy(mz, [agent, agent, null, codex]);
  assert.deepEqual([calls.splice(0), mz.onCbs], [["read claude-code/abcdef12"], 1]);
  await tellBusy(mz, []);
  assert.deepEqual([calls.splice(0), mz.onCbs], [[], 2], "authors unknown: as a windowless call");
  await tellBusy(mz, [agent]);
  assert.deepEqual([calls.splice(0), mz.onCbs], [["read claude-code/abcdef12"], 2]);
  await tellBusy(null, [agent]);
});

test("runWrite `hook`: one request id is told once (a retry, or the same request twice at once, or after it failed)", async () => {
  const c = await opened();
  try {
    const { mz, calls, failNext, hold } = recorder();
    const req = { id: "h.retry", actor: agent, op: { kind: "hook" as const, event: "write" as const, file: "timeline.tsx" } };
    assert.deepEqual(hookOf(await runWrite(c, req, { materializer: mz })), { event: "write", delivered: true });
    assert.deepEqual(hookOf(await runWrite(c, req, { materializer: mz })), { event: "write", delivered: true, again: true });
    assert.equal(calls.length, 1, "hookWrite queues one credit per call: a retry must not add a second");
    // the same request twice at once: the second waits for the first's call
    const open = hold();
    const both = Promise.all([runWrite(c, { ...req, id: "h.twice" }, { materializer: mz }), runWrite(c, { ...req, id: "h.twice" }, { materializer: mz })]);
    await new Promise((r) => setTimeout(r, 20));
    open();
    const [a, b] = await both;
    assert.equal(calls.length, 2);
    assert.deepEqual([hookOf(a)?.again, hookOf(b)?.again], [undefined, true]);
    // a call that failed may have taken effect first (cardboard's hookWrite queues the credit, then updates the freeze):
    // its retry gets the failure, and the materializer isn't called again (review H8 #3)
    failNext();
    await assert.rejects(runWrite(c, { ...req, id: "h.fails" }, { materializer: mz }), /materializer busy/);
    await assert.rejects(runWrite(c, { ...req, id: "h.fails" }, { materializer: mz }), /materializer busy/);
    assert.equal(calls.length, 3);
    // another materializer (a new holder) was never told: the retry tells it
    const other = recorder();
    assert.deepEqual(hookOf(await runWrite(c, req, { materializer: other.mz })), { event: "write", delivered: true });
    assert.equal(other.calls.length, 1);
  } finally {
    await c.close();
  }
});

test("runWrite `hook`: a request in flight, or one settled earlier, is still known after hundreds of others (review H8 #4)", async () => {
  const c = await opened();
  try {
    const { mz, calls, hold } = recorder();
    const req = (id: string) => ({ id, actor: agent, op: { kind: "hook" as const, event: "write" as const, file: "timeline.tsx" } });
    await runWrite(c, req("h.early"), { materializer: mz });
    const open = hold();
    const slow = runWrite(c, req("h.slow"), { materializer: mz }); // still running while the others come and go
    await new Promise((r) => setTimeout(r, 5));
    open();
    await Promise.all(Array.from({ length: 700 }, (_, i) => runWrite(c, req(`h.n${i}`), { materializer: mz })));
    await slow;
    const n = calls.length;
    assert.equal(n, 702);
    assert.deepEqual(hookOf(await runWrite(c, req("h.slow"), { materializer: mz })), { event: "write", delivered: true, again: true });
    assert.deepEqual(hookOf(await runWrite(c, req("h.early"), { materializer: mz })), { event: "write", delivered: true, again: true });
    assert.equal(calls.length, n, "neither was told again");
  } finally {
    await c.close();
  }
});

test("runWrite `hook`: its answer gives no notice away (no agent reads it): the agent's next cb call still gets it", async () => {
  const store = createMemoryStore();
  const c = await Carton.open({ adapter, store, init: { doc: doc0() }, actor: { kind: "system", id: "engine" } });
  try {
    await store.write([{ table: "notices", key: [actorKey(agent), 1000, 0], value: { to: actorKey(agent), kind: "late-conflict", change: "r.1", text: "Your change r.1 conflicted after your turn", cards: [] } }]);
    const { mz } = recorder();
    const h = await runWrite(c, { id: "h.n1", actor: agent, op: { kind: "hook", event: "read" } }, { materializer: mz });
    assert.deepEqual(h.notices, []);
    const next = await runWrite(c, { id: "h.n2", actor: agent, op: { kind: "pin", owner: "x" } }, { materializer: mz });
    assert.deepEqual(next.notices.map((n) => n.change), ["r.1"], "delivered with the agent's next cb call");
  } finally {
    await c.close();
  }
});

test("printView answers the view's status file too", async () => {
  const c = await opened();
  try {
    const { mz } = recorder();
    const r = await runWrite(c, { id: "h.p", actor: { kind: "agent", id: "codex/fix", provider: "codex" }, op: { kind: "printView", name: "mine" } }, { materializer: mz, viewName: async (_a, w) => w ?? "x" });
    assert.deepEqual(r.view, { name: "mine", path: ".scratch/views/mine.tsx", ref: "Main@1~0000 b:x p:y", status: ".scratch/views/mine.status" });
  } finally {
    await c.close();
  }
});

test("runHook `send`: file tools and an allowed stop are told; a blocked stop is not (the turn goes on); failures are swallowed", async () => {
  const sent: string[] = [];
  const send = async (e: { actor: Actor; op: { event: string; file?: string } }) => { sent.push(`${e.op.event} ${e.actor.id}${e.op.file ? ` ${e.op.file}` : ""}`); };
  const pre = (tool: string, input: object) => runHook("pre-tool-use", { ...session, tool_name: tool, ...input }, { env: {}, projectDir: dir, send });
  assert.deepEqual(await pre("Read", { tool_input: { file_path: at("timeline.tsx") } }), {});
  assert.deepEqual(await pre("Edit", { tool_input: { file_path: at("timeline.tsx") } }), {});
  const denied: any = await pre("Edit", { tool_input: { file_path: at("project.json") } });
  assert.equal(denied.hookSpecificOutput.permissionDecision, "deny", "§6.4: agents don't edit project.json");
  const bash: any = await pre("Bash", { tool_input: { command: "cb history Demo" } });
  assert.match(bash.hookSpecificOutput.updatedInput.command, /^export CARDBOARD_ACTOR='claude-code\/abcdef12'; /, "the prefixer as before");
  assert.deepEqual(sent, ["read claude-code/abcdef12 timeline.tsx", "write claude-code/abcdef12 timeline.tsx"], "nothing sent for the denied write");

  // the Stop hook: a late conflict blocks the stop once (nothing told), then the stop goes through (told)
  const store = createMemoryStore();
  await store.write([{ table: "notices", key: [actorKey(agent), 1000, 0], value: { to: actorKey(agent), kind: "late-conflict", change: "r.1", text: "Your change r.1 conflicted after your turn", cards: [{ kind: "group", path: "timelineItems/c1/name", base: 1, ours: 2, theirs: 3 }] } }]);
  let closed = 0;
  const openStore = async () => { const s = createMemoryStore({ shared: store.data }); const close = s.close.bind(s); s.close = async () => { closed++; return close(); }; return s; };
  const blocked: any = await runHook("stop", { ...session, hook_event_name: "Stop" }, { env: {}, openStore, send });
  assert.equal(blocked.decision, "block");
  assert.equal(sent.length, 2, "a blocked stop: the turn goes on, its freeze and pins stay");
  const sendSeesStore = async (e: any) => { assert.equal(closed, 1, "told before its store closes"); await send(e); };
  assert.deepEqual(await runHook("stop", { ...session, hook_event_name: "Stop", stop_hook_active: true }, { env: {}, openStore, send: sendSeesStore }), {});
  assert.equal(closed, 2);
  assert.deepEqual(sent.slice(2), ["stop claude-code/abcdef12"]);
  // no store to read notices from: the stop still ends the turn
  await runHook("stop", { session_id: "99999999zz", hook_event_name: "SubagentStop", agent_type: "editor", agent_id: "q" }, { env: {}, openStore: async () => null, send });
  assert.equal(sent.at(-1), "stop claude-code/99999999/sub-editor-q");
  // a sender that fails never fails the hook
  assert.deepEqual(await runHook("stop", { ...session, hook_event_name: "Stop" }, { env: {}, send: async () => { throw new Error("no holder"); } }), {});
});

test("hookSettings: Read/Write/Edit/MultiEdit go to `hook pre-tool-use --project <dir>` too", () => {
  const s: any = hookSettings({ command: "carton", projectDir: "/Users/x/Movies/My Project.cardboard" });
  assert.deepEqual(s.hooks.PreToolUse.map((m: any) => [m.matcher, m.hooks[0].command]), [
    ["Bash", "carton hook pre-tool-use"],
    ["Read|Write|Edit|MultiEdit", "carton hook pre-tool-use --project '/Users/x/Movies/My Project.cardboard'"],
  ]);
});
