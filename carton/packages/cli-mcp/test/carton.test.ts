// The commands on real Carton and a real carton.db (store-sqlite), through `openLocal`'s write routing.
import { test } from "node:test";
import assert from "node:assert/strict";
import type { Actor, Rec } from "@carton/core";
import { runCb } from "../src/cb.ts";
import type { CbProject } from "../src/commands.ts";
import { realProject } from "./support/real.ts";

const human: Actor = { kind: "human", id: "human:me", name: "me", group: "local:me@box" };
const director = (turn: string, sub?: [string, string]): Actor => ({
  kind: sub ? "subagent" : "agent", id: `director/c1/${turn}${sub ? `/sub-${sub[0]}-${sub[1]}` : ""}`, name: sub ? `Director › ${sub[0]}` : "Director", chat: "c1", turn, provider: "claude-code", group: "local:me@box", ...(sub ? { agentType: sub[0], agentId: sub[1] } : {}),
});
const set = (id: string, f: string, v: unknown) => ({ op: "set", path: ["timelineItems", id, f], value: v });

async function cb(project: CbProject, argv: string[], actor: Actor = human) {
  let out = "", err = "";
  const code = await runCb(argv, { cwd: ".", env: {}, stdout: (t) => (out += t), stderr: (t) => (err += t) }, { open: async () => project, actor: () => actor });
  return { code, out: out.trim(), err: err.trim(), json: () => JSON.parse(out) };
}

test("real Carton: history, credits down to the subagent, compare, activity", async () => {
  const { local } = await realProject("cli-real-1", human);
  try {
    assert.equal((await local.write({ kind: "commit", ops: [set("c1", "name", "Cold open")] }, { actor: director("t1") })).status, "confirmed");
    assert.equal((await local.write({ kind: "commit", ops: [set("c2", "startTime", 10.5), set("c2", "trimStart", 0.5)] }, { actor: director("t1", ["editor", "a1"]) })).status, "confirmed");
    const h = await cb(local, ["history", "--json", "--stats"]);
    assert.equal(h.code, 0, h.err);
    const v = h.json().versions;
    assert.deepEqual(v.map((x: any) => x.version), ["main@3", "main@2", "main@1", "main@0"], "the starting state is main@1, the import");
    // the import is told as the person whose project it was (ui-words), recorded as the import
    assert.deepEqual([v[2].kind, v[2].by.kind, v[2].by.id], ["import", "human", "person"]);
    assert.equal(v[0].by.agentType, "editor");
    assert.deepEqual([v[0].tracks, v[0].items, v[0].duration], [2, 5, 30]);
    assert.match((await cb(local, ["credits", "c2"])).out, /^c2: last changed by Director › editor \(turn t1\) \(subagent editor a1, chat c1\)$/);
    assert.match((await cb(local, ["blame", "Cold open"])).out, /^c1: last changed by Director \(turn t1\)/);
    const cmp = await cb(local, ["compare", "main@0", "--json"]);
    assert.ok(cmp.json().changes.length >= 2, cmp.out);
    const act = await cb(local, ["activity", "--json"]);
    assert.deepEqual(act.json().activity.map((g: any) => [g.by.id, g.changes]), [["director/c1/t1/sub-editor-a1", 1], ["director/c1/t1", 1], ["person", 1]]);
  } finally {
    await local.close();
  }
});

test("real Carton: cuts, fold --check, fold in some of it, publish", async () => {
  const { local } = await realProject("cli-real-2", human);
  try {
    assert.equal((await cb(local, ["cut", "new", "Short"])).code, 0);
    await local.write({ kind: "commit", cut: (await local.carton.cuts()).find((c) => c.name === "Short")!.id, ops: [set("c1", "name", "short-1"), set("c3", "name", "short-3")] });
    await local.write({ kind: "commit", ops: [set("c0", "name", "main-0")] });
    const chk = await cb(local, ["fold", "Short", "--check"]);
    assert.equal(chk.out, "Would fold in cleanly (no cards)");
    assert.equal((await local.carton.head()).ref.seq, 2, "the dry run saved nothing (main@1 is the import, main@2 the edit)");
    const f = await cb(local, ["merge", "Short", "--reject", "timelineItems/c3", "--json"]);
    assert.equal(f.json().status, "confirmed", f.out);
    const head = (await local.carton.head()).doc.timelineItems as Rec[];
    const name = (id: string) => head.find((i) => i.id === id)!.name;
    assert.deepEqual([name("c0"), name("c1"), name("c3")], ["main-0", "short-1", "c3"], "c3 was kept out (partial accept)");
    // UI audit P1-3: the partial fold is one version, a merge that says what it left out
    const h = await cb(local, ["history", "--json", "--limit", "2"]);
    assert.deepEqual(h.json().versions.map((v: any) => [v.kind, v.leftOut ?? null]), [["merge", ["timelineItems/c3"]], ["edit", null]], h.out);
    assert.match((await cb(local, ["history", "--limit", "1"])).out.split("\n")[1]!, /\smerge \(1 left out\)$/);
    const p = await cb(local, ["publish", "--name", "Sent to client"]);
    assert.equal(p.code, 0, p.err);
    assert.match((await cb(local, ["cut", "list"])).out, /Sent to client\s+published/);
  } finally {
    await local.close();
  }
});

test("real Carton: undo by actor group; undo --turn as one change keeps the person's edit made in between; restore", async () => {
  const { local } = await realProject("cli-real-3", human);
  try {
    const items = () => local.carton.head().then((h) => Object.fromEntries((h.doc.timelineItems as Rec[]).map((i) => [i.id, i.name])));
    // ⌘Z-style undo by actor group (§8): the newest change of the local group, here the person's own
    await local.write({ kind: "commit", ops: [set("c0", "name", "oops")] }, { actor: human });
    const g = await cb(local, ["undo", "--json"], human);
    assert.equal(g.json().status, "confirmed", g.out);
    assert.equal((await items()).c0, "c0");
    await local.write({ kind: "commit", ops: [set("c1", "name", "A")] }, { actor: director("t9") });
    await local.write({ kind: "commit", ops: [set("m1", "name", "Song")] }, { actor: human });
    await local.write({ kind: "commit", ops: [set("c2", "name", "B")] }, { actor: director("t9", ["editor", "x"]) });
    const before = (await local.carton.log()).length;
    const u = await cb(local, ["undo", "--turn", "t9", "--json"], director("t9"));
    assert.equal(u.json().status, "confirmed", u.out);
    assert.deepEqual(await items(), { c0: "c0", c1: "c1", c2: "c2", c3: "c3", m1: "Song" });
    assert.equal((await local.carton.log()).length, before + 1, "one undo change for the whole turn (Director and subagent)");
    const r = await cb(local, ["restore", "main@6"]); // main@1 is the import
    assert.equal(r.code, 0, r.err);
    assert.deepEqual(await items(), { c0: "c0", c1: "A", c2: "B", c3: "c3", m1: "Song" });
    assert.equal((await local.carton.log())[0].author?.id, "human:me", "the restore is credited to the caller");
  } finally {
    await local.close();
  }
});

test("real Carton: a stale-base save lands except its cards; the cards stay until resolved (other writes don't eat them)", async () => {
  const { local, reopen } = await realProject("cli-real-4", human);
  try {
    const agent = await reopen(director("t2"));
    const pin = await agent.carton.pin({ owner: "turn:t2" });
    await local.write({ kind: "commit", ops: [set("c3", "endTime", 19), set("c3", "trimEnd", 4), set("c2", "name", "theirs-2")] });
    // the agent applies different edits of the same fields from the version it printed, plus an unrelated rename
    const mine = structuredClone((await agent.carton.checkout(pin.ref)) as any);
    Object.assign(mine.timelineItems.find((i: Rec) => i.id === "c3"), { endTime: 18.5, trimEnd: 3.5 });
    mine.timelineItems.find((i: Rec) => i.id === "c2").name = "mine-2";
    mine.timelineItems.find((i: Rec) => i.id === "c1").name = "kept";
    const r = await agent.write({ kind: "commit", base: pin.header, doc: mine });
    assert.equal(r.status, "conflicts", JSON.stringify(r));
    assert.ok(r.status === "conflicts" && r.conflicts.some((c) => c.path === "timelineItems/c3/#time") && r.conflicts.some((c) => c.path === "timelineItems/c2/name"));
    const item = async (id: string) => ((await local.carton.head()).doc.timelineItems as Rec[]).find((i) => i.id === id)!;
    assert.equal((await item("c1")).name, "kept", "the non-conflicting part landed");
    assert.deepEqual([(await item("c3")).endTime, (await item("c2")).name], [19, "theirs-2"], "each card kept head's value");
    // an unrelated write by the same agent must not consume the cards
    await agent.write({ kind: "commit", ops: [set("c0", "name", "other")] });
    const c = await cb(agent, ["conflicts", "--json"], director("t2"));
    assert.equal(c.json().cards.length, 2, c.out);
    const n = c.json().cards.findIndex((x: any) => x.path === "timelineItems/c3/#time") + 1;
    const res = await cb(agent, ["resolve", String(n), "--keep", "mine"], director("t2"));
    assert.equal(res.code, 0, res.out + res.err);
    assert.deepEqual([(await item("c3")).endTime, (await item("c3")).trimEnd], [18.5, 3.5], "resolving picked the agent's trim");
    const left = await cb(agent, ["conflicts", "--json"], director("t2"));
    assert.deepEqual(left.json().cards.map((x: any) => x.path), ["timelineItems/c2/name"], "only the resolved card went away");
    await agent.close();
  } finally {
    await local.close();
  }
});

test("real Carton: --as names the actor of the write, not the process's environment identity", async () => {
  const { local } = await realProject("cli-real-5", human);
  try {
    const codex: Actor = { kind: "agent", id: "codex/fix-captions", name: "Codex (fix-captions) (terminal)", provider: "codex", group: "local:me@box" };
    // the project was opened as `human`; the command runs as codex (what `--as codex/fix-captions` resolves to)
    const r = await cb(local, ["cut", "new", "Alt", "--json"], codex);
    assert.equal(r.code, 0, r.out);
    await cb(local, ["publish", "--name", "P"], codex);
    await local.write({ kind: "commit", ops: [set("c0", "name", "x")] }, { actor: codex });
    const u = await cb(local, ["undo", "--json"], codex);
    assert.equal(u.json().status, "confirmed", u.out);
    assert.equal((await local.carton.log())[0].author?.id, "codex/fix-captions", "the undo is credited to the --as actor");
  } finally {
    await local.close();
  }
});

test("real Carton: undo --turn is recorded as an undo of every change of the turn", async () => {
  const { local } = await realProject("cli-real-6", human);
  try {
    await local.write({ kind: "commit", ops: [set("c1", "name", "A")] }, { actor: director("t7") });
    await local.write({ kind: "commit", ops: [set("c2", "name", "B")] }, { actor: director("t7", ["editor", "q"]) });
    const ids = (await local.carton.log()).filter((v) => v.author?.turn === "t7").map((v) => v.change);
    const u = await cb(local, ["undo", "--turn", "t7", "--json"], director("t7"));
    assert.equal(u.json().status, "confirmed", u.out);
    const top = (await local.carton.log())[0];
    assert.equal(top.kind, "undo");
    const stack = await local.carton.undoStack("local:me@box");
    assert.ok(!stack.some((e) => ids.includes(e.changeId)), "the turn's changes are no longer undoable: they are undone");
    // a second undo --turn of the same turn finds nothing left to undo
    const again = await cb(local, ["undo", "--turn", "t7", "--json"], director("t7"));
    assert.equal(again.json().empty, true, again.out);
  } finally {
    await local.close();
  }
});

test("real Carton: check_timeline dry-runs the proposed edit against head, writing nothing", async () => {
  const { local } = await realProject("cli-real-7", human);
  try {
    const { mcpTools } = await import("../src/mcp.ts");
    const check = mcpTools().find((t) => t.name === "check_timeline")!;
    const head = await local.carton.head();
    const doc = structuredClone(head.doc) as any;
    doc.timelineItems.find((i: Rec) => i.id === "c1").name = "proposed";
    const r = await check.call({ project: local, actor: human }, { doc });
    assert.match(r.text, /c1|proposed/i, r.text);
    assert.equal((r.result as any).ops, 1);
    assert.equal(r.isError, false);
    const bad = structuredClone(head.doc) as any;
    bad.timelineItems.find((i: Rec) => i.id === "c2").endTime = 1; // ends before it starts
    const b = await check.call({ project: local, actor: human }, { doc: bad });
    assert.ok((b.result as any).conflicts.some((c: any) => c.kind === "invalid" && c.path === "timelineItems/c2"), b.text);
    assert.equal(b.isError, true);
    assert.equal((await local.carton.head()).ref.seq, head.ref.seq, "nothing was written");
  } finally {
    await local.close();
  }
});

test("real Carton: a fold with cards names both cuts, saves nothing, and is decided by folding again with --keep", async () => {
  const { local } = await realProject("cli-real-fold-cards", human);
  try {
    assert.equal((await cb(local, ["cut", "new", "Short"])).code, 0);
    const short = (await local.carton.cuts()).find((c) => c.name === "Short")!.id;
    await local.write({ kind: "commit", cut: short, ops: [set("c1", "endTime", 8), set("c1", "trimEnd", 3)] });
    await local.write({ kind: "commit", ops: [set("c1", "endTime", 9), set("c1", "trimEnd", 4)] });
    const before = (await local.carton.head()).ref.seq;
    const chk = await cb(local, ["fold", "Short", "--check"]);
    assert.match(chk.out, /^Would fold in with 1 card:\n  #1 timelineItems\/c1\/#time \(group[^)]*\) — Main cut: \{[^}]*"endTime":9[^}]*\} · Short: \{[^}]*"endTime":8[^}]*\}\n/);
    assert.match(chk.out, /`cb fold <project> Short --keep mine` \(keep Main cut's\) or `--keep theirs` \(keep Short's\), or keep a clip out with `--reject timelineItems\/c1`/);
    const f = await cb(local, ["fold", "Short"]);
    assert.equal(f.code, 1);
    assert.match(f.out, /^Not folded in: 1 card, nothing was saved\.\n  #1 timelineItems\/c1\/#time .* — Main cut: .* · Short: /);
    assert.equal((await local.carton.head()).ref.seq, before, "a fold with cards saves nothing");
    assert.equal((await cb(local, ["conflicts"])).out, "No open conflict cards", "a fold's cards are not notices");
    const k = await cb(local, ["fold", "Short", "--keep", "theirs"]);
    assert.equal(k.code, 0, k.out);
    const c1 = ((await local.carton.head()).doc.timelineItems as Rec[]).find((i) => i.id === "c1")!;
    assert.deepEqual([c1.endTime, c1.trimEnd], [8, 3], "--keep theirs keeps the folded cut's value, the one named Short");
  } finally {
    await local.close();
  }
});

test("real Carton: undo --turn undoes what it can and raises cards for what was changed again since; the cards are listed and resolved", async () => {
  const { local, reopen } = await realProject("cli-real-undo-cards", human);
  try {
    const agent = await reopen(director("t5"));
    // the turn renames c1 and trims c3; the person then trims c3 differently
    await agent.write({ kind: "commit", ops: [set("c1", "name", "turn name")] });
    await agent.write({ kind: "commit", ops: [set("c3", "endTime", 19), set("c3", "trimEnd", 4)] });
    await local.write({ kind: "commit", ops: [set("c3", "endTime", 19.4), set("c3", "trimEnd", 4.4)] });
    const item = async (id: string) => ((await local.carton.head()).doc.timelineItems as Rec[]).find((i) => i.id === id)!;
    const before = (await local.carton.log()).length;
    const u = await cb(agent, ["undo", "--turn", "t5"], director("t5"));
    assert.match(u.out, /^Undid turn t5: conflicts \(1 card; nothing else was lost\)\n  #1 timelineItems\/c3\/#time/, u.out);
    assert.equal((await item("c1")).name, "c1", "the rest of the turn is undone");
    assert.deepEqual([(await item("c3")).endTime, (await item("c3")).trimEnd], [19.4, 4.4], "the clash keeps the person's newer trim");
    assert.equal((await local.carton.log()).length, before + 1, "one undo change");
    // the card is the agent's, listed and resolvable as a stale save's
    const c = await cb(agent, ["conflicts", "--json"], director("t5"));
    assert.deepEqual(c.json().cards.map((x: any) => x.path), ["timelineItems/c3/#time"], c.out);
    const res = await cb(agent, ["resolve", "1", "--keep", "mine"], director("t5"));
    assert.equal(res.code, 0, res.out + res.err);
    assert.deepEqual([(await item("c3")).endTime, (await item("c3")).trimEnd], [20, 5], "keeping the undo's side puts c3 back as before the turn");
    assert.deepEqual((await cb(agent, ["conflicts", "--json"], director("t5"))).json().cards, []);
    await agent.close();
  } finally {
    await local.close();
  }
});
