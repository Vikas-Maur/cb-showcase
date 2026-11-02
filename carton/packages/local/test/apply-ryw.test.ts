// apply-ryw: read-your-writes for the shared timeline.tsx. On the laptop an agent ran `cb source apply` with the app open
// and read timeline.tsx at once: the file still showed the old value (the app's materializer heard of a write committed
// in cb's own process only at its next poll of carton.db, then rewrote the file 20 ms later), and the agent took it for
// a freeze of its turn's start. Now a cb write asks the lease holder (`carton.shown`), which looks at carton.db at once,
// makes its rewrite and answers with the print that shows the write. Here the app is the real thing as far as Carton
// goes (the engine thread holds the lease and runs cardboard's Materializer on the bundle), with its poll of carton.db
// off where it matters, so only the request can make the file show the write:
//   - an agent's write committed in its own process shows once carton.shown answers, before any poll;
//   - during a hooked agent's turn (the file frozen) its own write shows, and the person's change stays out ("held");
//   - a terminal's cb holds the file as a windowless agent does, and its own write shows in it (it was held back from
//     it for a minute), while the person's change stays out;
//   - a holder that is gone answers "later", never an error.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Rec } from "@carton/core";
import { openLocal } from "../src/open.ts";
import { EngineThread } from "../src/engine-thread.ts";
import { showOnHolder } from "../src/client.ts";
import { runHook } from "../src/hook-cli.ts";
import { sendHookEvent } from "../src/hook-send.ts";
import { localGroup, parseActorId } from "../src/identity.ts";
import type { HookSend } from "../src/hooks.ts";
import { adapter, bundle, doc0 } from "./support/real.ts";

const here = (f: string) => fileURLToPath(new URL(f, import.meta.url));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const me = { kind: "human" as const, id: "human:me", name: "me" };
const set = (id: string, f: string, v: unknown) => ({ op: "set" as const, path: ["timelineItems", id, f], value: v });

async function until(f: () => unknown, ms: number, what: string, now: () => unknown = () => null) {
  for (const end = Date.now() + ms; !(await f()); await sleep(25)) if (Date.now() > end) throw new Error(`timed out waiting for ${what}; now: ${JSON.stringify(now())}`);
}
/** The shared timeline.tsx's items (null mid-rename). */
function shared(dir: string): Rec[] | null {
  try {
    const text = readFileSync(join(dir, "timeline.tsx"), "utf8");
    return JSON.parse(text.slice(text.indexOf("\n{") + 1)).timelineItems as Rec[];
  } catch { return null; }
}
const named = (items: Rec[] | null | undefined, id: string) => items?.find((i) => i.id === id)?.name;

/** The app (engine thread: lease holder + cardboard's Materializer on the bundle) and another process's handle. */
async function world(t: { after(f: () => Promise<void>): void }, name: string, config: Record<string, unknown> = {}) {
  const { dir, projectId } = bundle(name);
  const init = await openLocal({ projectDir: dir, projectId, adapter, init: { doc: doc0() }, actor: me });
  const dbPath = init.dbPath;
  await init.close();
  const th = await EngineThread.start({ dbPath, factory: here("./support/real-mz-factory.ts"), config: { projectDir: dir, ...config } });
  const other = await openLocal({ projectDir: dir, projectId, adapter, actor: me });
  t.after(async () => { await other.close(); await th.stop(); });
  await until(() => named(shared(dir), "c1") === "c1", 10_000, "the app's first print", () => shared(dir));
  const socket = (await other.lease.read())!.socketPath;
  /** The person's edit in the app (a GUI save of project.json, applied by the materializer: it freezes nothing). */
  const person = async (id: string, v: string) => {
    const file = join(dir, "project.json");
    const env = JSON.parse(readFileSync(file, "utf8"));
    env.project.timelineItems.find((i: Rec) => i.id === id).name = v;
    writeFileSync(file, JSON.stringify(env));
    await until(async () => named((await other.carton.head()).doc.timelineItems as Rec[], id) === v, 10_000, `the person's ${id} to land`);
  };
  const hook = (event: "pre-tool-use" | "stop", input: object) =>
    runHook(event, { session_id: "ryw000012", ...input }, { env: {}, projectDir: dir, send: async (e: HookSend) => void (await sendHookEvent({ projectDir: dir, projectId, ...e })) });
  return { dir, projectId, th, other, socket, person, hook };
}

test("an agent's write committed in its own process shows in timeline.tsx once carton.shown answers, with no poll of carton.db", { timeout: 60_000 }, async (t) => {
  const { dir, projectId, socket } = await world(t, "ryw-inproc", { followMs: 0, hostChanges: true });
  const agent = parseActorId("claude-code/ryw0001")!;
  const cb = await openLocal({ projectDir: dir, projectId, adapter, actor: agent });
  t.after(() => cb.close());
  for (const v of ["first", "second", "third"]) {
    // a local cut with the app open: cb commits in its own process (as Cardboard's `cb source apply` does), then asks
    const r = await cb.carton.commit({ author: agent, ops: [set("c1", "name", v)] });
    assert.equal(r.status, "confirmed");
    const shown = await showOnHolder(socket, { id: (r as { change: { id: string } }).change.id, cut: (r as { ref: { branchId: string } }).ref.branchId, seq: (r as { seq: number }).seq, author: agent });
    assert.equal(shown, "shown");
    assert.equal(named(shared(dir), "c1"), v, "the very next read of timeline.tsx shows the write");
  }
});

test("during a hooked agent's turn its own write shows at once and the person's change stays out ('held')", { timeout: 60_000 }, async (t) => {
  const { dir, projectId, socket, other, person, hook } = await world(t, "ryw-frozen", { followMs: 0, hostChanges: true });
  // the agent's Read of timeline.tsx freezes it (claude-code/<session>, as its hooks name it)
  assert.deepEqual(await hook("pre-tool-use", { tool_name: "Read", tool_input: { file_path: join(dir, "timeline.tsx") } }), {});
  const agent = parseActorId("claude-code/ryw00001")!;
  await person("c3", "the person's edit");
  const cb = await openLocal({ projectDir: dir, projectId, adapter, actor: agent });
  t.after(() => cb.close());
  const r = await cb.carton.commit({ author: agent, ops: [set("c1", "name", "the agent's edit")] });
  assert.equal(await showOnHolder(socket, { id: (r as { change: { id: string } }).change.id, cut: (r as { ref: { branchId: string } }).ref.branchId, seq: (r as { seq: number }).seq, author: agent }), "shown");
  const now = shared(dir);
  assert.equal(named(now, "c1"), "the agent's edit", "the agent's own write is in the frozen file");
  assert.equal(named(now, "c3"), "c3", "the person's edit stays out while the agent works");
  // someone else's cb write in the turn (a named person's, not a terminal's) is held back, and the answer says so
  const p = await other.carton.commit({ author: me, ops: [set("c4", "name", "someone else's cb")] });
  assert.equal(await showOnHolder(socket, { id: (p as { change: { id: string } }).change.id, cut: (p as { ref: { branchId: string } }).ref.branchId, seq: (p as { seq: number }).seq, author: me }), "held");
  assert.equal(named(shared(dir), "c4"), "c4");
  assert.deepEqual(await hook("stop", { hook_event_name: "Stop" }), {});
});

test("a terminal's cb holds the file as a windowless agent does, and its own write shows in it; the person's stays out", { timeout: 60_000 }, async (t) => {
  const { dir, projectId, socket, person } = await world(t, "ryw-terminal", { hostChanges: true });
  const terminal = { kind: "external" as const, id: `terminal:${localGroup().slice("local:".length)}`, name: "Terminal", group: localGroup() };
  const cb = await openLocal({ projectDir: dir, projectId, adapter, actor: terminal });
  t.after(() => cb.close());
  // served by the app's holder: the call holds the file (a windowless caller, for a while after it)
  const w = await cb.write({ kind: "commit", ops: [set("c1", "name", "typed in a terminal")] });
  assert.equal(w.status, "confirmed", JSON.stringify(w));
  assert.equal(await showOnHolder(socket, { id: String(w.id), seq: (w as { seq: number }).seq, author: terminal }), "shown");
  assert.equal(named(shared(dir), "c1"), "typed in a terminal", "the terminal's own write is in the file its call holds");
  await person("c3", "the person's edit");
  await sleep(500);
  assert.equal(named(shared(dir), "c3"), "c3", "the file is still held: the person's edit stays out");
  // and its next write too, with the person's still out
  const w2 = await cb.write({ kind: "commit", ops: [set("c2", "name", "again from the terminal")] });
  assert.equal(await showOnHolder(socket, { id: String(w2.id), seq: (w2 as { seq: number }).seq, author: terminal }), "shown");
  assert.deepEqual([named(shared(dir), "c2"), named(shared(dir), "c3")], ["again from the terminal", "c3"]);
});

test("a holder that is gone answers 'later', never an error", async () => {
  assert.equal(await showOnHolder(join(bundle("ryw-gone").dir, "no-such-holder.sock"), { id: "x.1" }, 200), "later");
});
