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
    assert.deepEqual(v.map((x: any) => x.version), ["main@2", "main@1", "main@0"]);
    assert.equal(v[0].by.agentType, "editor");
    assert.deepEqual([v[0].tracks, v[0].items, v[0].duration], [2, 5, 30]);
    assert.match((await cb(local, ["credits", "c2"])).out, /^c2: last changed by Director › editor \(turn t1\) \(subagent editor a1, chat c1\)$/);
    assert.match((await cb(local, ["blame", "Cold open"])).out, /^c1: last changed by Director \(turn t1\)/);
    const cmp = await cb(local, ["compare", "main@0", "--json"]);
    assert.ok(cmp.json().changes.length >= 2, cmp.out);
    const act = await cb(local, ["activity", "--json"]);
    assert.deepEqual(act.json().activity.map((g: any) => [g.by.id, g.changes]), [["director/c1/t1/sub-editor-a1", 1], ["director/c1/t1", 1]]);
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
    assert.equal((await local.carton.head()).ref.seq, 1, "the dry run saved nothing");
    const f = await cb(local, ["merge", "Short", "--reject", "timelineItems/c3", "--json"]);
    assert.equal(f.json().status, "confirmed", f.out);
    const head = (await local.carton.head()).doc.timelineItems as Rec[];
    const name = (id: string) => head.find((i) => i.id === id)!.name;
    assert.deepEqual([name("c0"), name("c1"), name("c3")], ["main-0", "short-1", "c3"], "c3 was kept out (partial accept)");
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
    const r = await cb(local, ["restore", "main@5"]);
    assert.equal(r.code, 0, r.err);
    assert.deepEqual(await items(), { c0: "c0", c1: "A", c2: "B", c3: "c3", m1: "Song" });
    assert.equal((await local.carton.log())[0].author?.id, "human:me", "the restore is credited to the caller");
  } finally {
    await local.close();
  }
});

test("real Carton: the cb result contract for a stale base: conflicts with the card, nothing else lost; exit 1", async () => {
  const { local, reopen } = await realProject("cli-real-4", human);
  try {
    const agent = await reopen(director("t2"));
    const pin = await agent.carton.pin({ owner: "turn:t2" });
    await local.write({ kind: "commit", ops: [set("c3", "endTime", 19), set("c3", "trimEnd", 4)] });
    // the agent applies a different trim of the same edge from the version it printed, plus an unrelated rename
    const mine = structuredClone((await agent.carton.checkout(pin.ref)) as any);
    Object.assign(mine.timelineItems.find((i: Rec) => i.id === "c3"), { endTime: 18.5, trimEnd: 3.5 });
    mine.timelineItems.find((i: Rec) => i.id === "c1").name = "kept";
    const r = await agent.write({ kind: "commit", base: pin.header, doc: mine });
    assert.equal(r.status, "conflicts");
    assert.ok(r.status === "conflicts" && r.conflicts.some((c) => c.path === "timelineItems/c3/#time"), JSON.stringify(r));
    await agent.close();
  } finally {
    await local.close();
  }
});
