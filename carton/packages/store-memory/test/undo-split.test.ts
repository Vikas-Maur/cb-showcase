// Ctrl+Z of a split after a drag of one of its pieces (laptop report #2, bug 6). The drag is a plain edit: no remap is
// recorded for it, and none is inferred (a single clip pushed later is no ripple). Its undo pulls the piece back over
// the gap it left, which on its own reads as a closed gap; an undo inverts what its change recorded (§8), so it must not
// be recorded as a ripple delete. If it is, undoing the split re-inserts the clip across that "deleted" range and
// comes back as a card ("inserted inside a range the other side removed"): Ctrl+Z did nothing, and redo then redid the
// drag. On a local cut (History.commit) and on a shared one (the replica queue's commit).
import { test } from "node:test";
import assert from "node:assert/strict";
import { Carton, POS, type Actor, type ConfirmedChange, type Doc, type Rec } from "@carton/core";
import type { AuthContext, AuthProvider } from "@carton/core/plugins";
import { createInProcessHost } from "@carton/server";
import { sqliteStorage } from "../../conformance/src/system/sqlite.ts";
import { createMemoryStore } from "../src/index.ts";
import { adapter, clip, schema } from "./fixture.ts";
import { copyStore, world } from "./world.ts";

const GROUP = "local:me@laptop";
const person: Actor = { kind: "human", id: "person", group: GROUP, app: true };
const doc = (): Doc => ({ name: "Film", tracks: [{ id: "t1", [POS]: "V" }, { id: "t2", [POS]: "W" }], items: [clip("x", 0, 3)] });
// the clips as [id, start, end, track], in time order
const shape = (d: Doc) => ((d.items as Rec[]) ?? []).slice().sort((p, q) => (p.startTime as number) - (q.startTime as number) || String(p.id).localeCompare(String(q.id))).map((i) => [i.id, i.startTime, i.endTime, i.trackId]);
// the split as the editor saves it: the clip replaced by two new pieces, with the split's lineage
const splitOps = [
  { op: "remove" as const, path: ["items", "x"] },
  { op: "insert" as const, path: ["items", "a"], value: clip("a", 0, 1.5) },
  { op: "insert" as const, path: ["items", "b"], value: { ...clip("b", 1.5, 3), trimStart: 1.5, trimEnd: 3 } },
];
const SPLIT = [["a", 0, 1.5, "t1"], ["b", 1.5, 3, "t1"]];
const ONE = [["x", 0, 3, "t1"]];
const moved = (id: string, s: number, e: number, track?: string) => [
  { op: "set" as const, path: ["items", id, "startTime"], value: s },
  { op: "set" as const, path: ["items", id, "endTime"], value: e },
  ...(track ? [{ op: "set" as const, path: ["items", id, "trackId"], value: track }] : []),
];

test("local cut: a split, a drag of a piece, Ctrl+Z ×2 gives the clip back; redo gives the split, then the drag", async () => {
  // the drag of the right piece later (the report's case), of the left piece past it, to another track
  for (const [what, drag, after] of [
    ["right piece +3 s", moved("b", 4.5, 6), [["a", 0, 1.5, "t1"], ["b", 4.5, 6, "t1"]]],
    ["left piece past the right one", moved("a", 3, 4.5), [["b", 1.5, 3, "t1"], ["a", 3, 4.5, "t1"]]],
    ["right piece to another track, later", moved("b", 4.5, 6, "t2"), [["a", 0, 1.5, "t1"], ["b", 4.5, 6, "t2"]]],
  ] as const) {
    let now = 1000;
    const c = await Carton.open({ adapter, store: createMemoryStore(), init: { doc: doc() }, clock: () => (now += 10) });
    const scope = { since: now, app: true, author: person };
    await c.commit({ ops: splitOps, author: person, intent: { kind: "split", lineage: { x: ["a", "b"] } } });
    const d = await c.commit({ ops: [...drag], author: person });
    assert.equal(d.status, "confirmed");
    assert.deepEqual(shape((await c.head()).doc), after, `${what}: dragged`);
    const z1 = await c.undo(GROUP, scope);
    assert.equal(z1.status, "confirmed", `${what}: Ctrl+Z #1`);
    assert.equal(z1.status === "confirmed" && z1.change?.intent, null, `${what}: the drag's undo records no remap (the drag recorded none)`);
    assert.deepEqual(shape((await c.head()).doc), SPLIT, `${what}: the drag undone`);
    const z2 = await c.undo(GROUP, scope);
    assert.equal(z2.status, "confirmed", `${what}: Ctrl+Z #2 undoes the split (${z2.status === "conflicts" ? JSON.stringify(z2.cards.map((k) => k.reason)) : ""})`);
    assert.deepEqual(shape((await c.head()).doc), ONE, `${what}: the one clip back`);
    assert.deepEqual(await c.undoStack(GROUP, scope), [], `${what}: nothing left to undo`);
    const r1 = await c.redo(GROUP, scope);
    assert.equal(r1.status, "confirmed", `${what}: redo #1`);
    assert.deepEqual(shape((await c.head()).doc), SPLIT, `${what}: the split redone`);
    const r2 = await c.redo(GROUP, scope);
    assert.equal(r2.status, "confirmed", `${what}: redo #2`);
    assert.equal(r2.status === "confirmed" && r2.change?.intent, null, `${what}: the drag's redo records no remap either`);
    assert.deepEqual(shape((await c.head()).doc), after, `${what}: the drag redone`);
    assert.deepEqual(await c.redoStack(GROUP, scope), [], `${what}: nothing left to redo`);
    // and back down again: the redone drag, then the redone split
    assert.equal((await c.undo(GROUP, scope)).status, "confirmed");
    assert.equal((await c.undo(GROUP, scope)).status, "confirmed");
    assert.deepEqual(shape((await c.head()).doc), ONE, `${what}: undone again`);
    await c.close();
  }
});

test("an undo of a recorded ripple still records its inverse; a revert of a plain drag records none", async () => {
  let now = 1000;
  const c = await Carton.open({ adapter, store: createMemoryStore(), init: { doc: { name: "Film", tracks: [{ id: "t1", [POS]: "V" }], items: [clip("p", 0, 2), clip("q", 2, 4), clip("r", 6, 8)] } }, clock: () => (now += 10) });
  const scope = { since: now, app: true, author: person };
  // a ripple delete of [4, 6) the editor recorded (H7): r pulled left over the gap
  await c.commit({ ops: moved("r", 4, 6), author: person, intent: { kind: "ripple-delete", maps: { t1: [{ d: [[4, 6]], i: [] }] } } });
  const z = await c.undo(GROUP, scope);
  assert.equal(z.status, "confirmed");
  assert.deepEqual(z.status === "confirmed" && z.change?.intent?.maps, { t1: [{ d: [], i: [[4, 2]] }] }, "the recorded ripple, inverted: the gap back");
  assert.deepEqual(shape((await c.head()).doc), [["p", 0, 2, "t1"], ["q", 2, 4, "t1"], ["r", 6, 8, "t1"]]);
  await c.close();
  // a plain drag of the last clip later, reverted from History: the revert pulls it back over exactly the gap it left,
  // which reads as a closed gap, and is no ripple
  const d = await Carton.open({ adapter, store: createMemoryStore(), init: { doc: { name: "Film", tracks: [{ id: "t1", [POS]: "V" }], items: [clip("p", 0, 2), clip("q", 2, 4)] } }, clock: () => (now += 10) });
  const drag = await d.commit({ ops: moved("q", 7, 9), author: person });
  assert.ok(drag.status === "confirmed" && drag.change && drag.change.intent === null, "a single clip pushed later is no ripple");
  const rv = await d.revert(drag.change!.id);
  assert.equal(rv.status, "confirmed");
  assert.equal(rv.status === "confirmed" && rv.change?.intent, null, "a revert records only what it inverts");
  assert.deepEqual(shape((await d.head()).doc), [["p", 0, 2, "t1"], ["q", 2, 4, "t1"]]);
  await d.close();
});

// --- a shared cut: the same through the replica queue, against a real sequencer (@carton/server in process)
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(pred: () => boolean | Promise<boolean>, ms = 5000, what = "condition"): Promise<void> {
  const end = Date.now() + ms;
  while (!(await pred())) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(10);
  }
}

test("shared cut: a split, a drag of a piece, Ctrl+Z ×2 gives the clip back; redo gives the split, then the drag", async () => {
  const tokens = new Map<string, AuthContext>();
  const auth: AuthProvider = { kind: "table", async verify(t) { return tokens.get(t) ?? null; } };
  const host = createInProcessHost({ storage: sqliteStorage(), auth, timeline: schema.timeline!, groupOf: (cl, f) => schema.collections[cl]?.groupOf.get(f)?.name });
  tokens.set("tok-alice", { account: "alice", credential: "alice/install", role: "editor", projectId: "p", expires: Date.now() + 3600_000 });
  const alice: Actor = { kind: "human", id: "alice", group: GROUP, app: true };
  const a = await Carton.open({ adapter, store: createMemoryStore(), init: { doc: doc(), projectId: "p" }, actor: alice, sync: { transport: host.transport, url: host.url, token: "tok-alice" } });
  try {
    await a.share();
    await until(async () => (await a.cuts())[0]!.sequencer.kind === "server", 5000, "the hand-off");
    const scope = { since: 0, app: true };
    // each step confirmed by the server before the next (none waits in the queue)
    const step = async (which: "undo" | "redo", what: string) => {
      const r = await a[which](undefined, { ...scope, id: a.newChangeId() });
      assert.ok(r.status === "pending" || r.status === "confirmed", `${what}: ${r.status} ${r.status === "conflicts" ? JSON.stringify(r.cards.map((k) => k.reason)) : ""}`);
      assert.ok(!("empty" in r && r.empty), `${what}: something to ${which}`);
      await until(async () => (await a.pendingCount()) === 0, 5000, `${what} confirmed`);
      return (await a.log())[0]!;
    };
    assert.equal((await a.commit({ ops: splitOps, intent: { kind: "split", lineage: { x: ["a", "b"] } }, wait: 5000 })).status, "confirmed");
    assert.equal((await a.commit({ ops: moved("b", 4.5, 6), wait: 5000 })).status, "confirmed");
    const u1 = await step("undo", "Ctrl+Z #1");
    assert.equal(u1.kind, "undo");
    assert.deepEqual(shape((await a.head()).doc), SPLIT, "the drag undone");
    await step("undo", "Ctrl+Z #2");
    assert.deepEqual(shape((await a.head()).doc), ONE, "the one clip back");
    await step("redo", "redo #1");
    assert.deepEqual(shape((await a.head()).doc), SPLIT, "the split redone");
    await step("redo", "redo #2");
    assert.deepEqual(shape((await a.head()).doc), [["a", 0, 1.5, "t1"], ["b", 4.5, 6, "t1"]], "the drag redone");
  } finally {
    await a.close();
    host.close();
  }
});

// --- two replicas (review of the fix, P1): the undo of the drag made offline is rebased when it reconnects. merge3
// infers a remap for a side that brings none, so the undo, which records none, was read as the ripple delete of the
// gap it closes ([1.5, 4.5) on t1) all over again during the rebase: a clip another replica placed later on that track
// in the meantime was silently pulled 3 s left, on both replicas, with no card. The same after a restart in between
// (the undo restored from the store, then rebased).
const alice2: Actor = { kind: "human", id: "alice", group: GROUP, app: true };
const bob2: Actor = { kind: "human", id: "bob", group: "bob@desk", app: true };
const insertY = [{ op: "insert" as const, path: ["items", "y"], value: clip("y", 7, 8) }];
/** alice's shared cut with the split and the drag confirmed, and bob on a copy of her store, both up to date. */
async function splitAndDragOnTwo() {
  const w = world();
  const sa = createMemoryStore();
  const a = await Carton.open({ adapter, store: sa, init: { doc: doc() }, actor: alice2, sync: w.sync("alice") });
  await a.share();
  await until(async () => (await a.cuts())[0]!.sequencer.kind === "server", 5000, "the hand-off");
  assert.equal((await a.commit({ ops: splitOps, intent: { kind: "split", lineage: { x: ["a", "b"] } }, wait: 5000 })).status, "confirmed");
  assert.equal((await a.commit({ ops: moved("b", 4.5, 6), wait: 5000 })).status, "confirmed");
  const sb = await copyStore(sa);
  const b = await Carton.open({ adapter, store: sb, actor: bob2, sync: w.sync("bob") });
  await until(() => b.sync!.status === "up-to-date", 5000, "bob connected");
  return { w, sa, a, b };
}
const UNDONE_WITH_Y = [["a", 0, 1.5, "t1"], ["b", 1.5, 3, "t1"], ["y", 7, 8, "t1"]];

for (const restart of [false, true])
  test(`shared cut: the drag's undo made offline${restart ? ", kept across a restart," : ""} is rebased over a clip another replica placed later: that clip stays put`, async () => {
    const { w, sa, a: a0, b } = await splitAndDragOnTwo();
    let a = a0;
    try {
      await a.sync!.disconnect();
      const u = await a.undo(undefined, { since: 0, app: true, id: a.newChangeId() });
      assert.equal(u.status, "pending", `the drag's undo waits offline (${u.status})`);
      const uid = (u as { id: string }).id;
      assert.deepEqual(shape((await a.head()).doc), SPLIT, "the drag undone locally");
      assert.equal((await b.commit({ ops: insertY, wait: 5000 })).status, "confirmed", "bob's clip at 7–8 s");
      if (restart) {
        await a.close();
        a = await Carton.open({ adapter, store: sa, actor: alice2, sync: w.sync("alice") });
      } else await a.sync!.connect({ nonce: "lease-2" });
      assert.equal((await a.sync!.waitFor(uid, 5000)).status, "confirmed", "the undo confirmed after the reconnect");
      for (const [who, c] of [["alice", a], ["bob", b]] as const) await until(async () => (await c.log()).some((x) => x.change === uid), 5000, `the undo at ${who}`);
      for (const [who, c] of [["alice", a], ["bob", b]] as const) assert.deepEqual(shape((await c.head()).doc), UNDONE_WITH_Y, `${who}: the drag undone, bob's clip still at 7–8 s`);
      const ur = (await sa.range<ConfirmedChange>("changes", { prefix: [a.cut] })).map((r) => r.value).find((c) => c.id === uid)!;
      assert.ok((ur.rebase ?? 0) >= 1, "it was rebased onto bob's clip");
      assert.equal(ur.intent, null, "the rebased undo still records no remap");
      assert.deepEqual((await a.notices(alice2)).filter((n) => n.change === uid), [], "no card for the undo");
      // and Ctrl+Z #2 still undoes the split
      const z2 = await a.undo(undefined, { since: 0, app: true, id: a.newChangeId() });
      assert.ok(z2.status === "pending" || z2.status === "confirmed", `Ctrl+Z #2: ${z2.status} ${z2.status === "conflicts" ? JSON.stringify(z2.cards.map((k) => k.reason)) : ""}`);
      await until(async () => (await a.pendingCount()) === 0, 5000, "Ctrl+Z #2 confirmed");
      for (const [who, c] of [["alice", a], ["bob", b]] as const) await until(async () => JSON.stringify(shape((await c.head()).doc)) === JSON.stringify([["x", 0, 3, "t1"], ["y", 7, 8, "t1"]]), 5000, `${who}: the one clip back, bob's clip kept`);
    } finally {
      await a.close();
      await b.close();
      w.host.close();
    }
  });

test("shared cut: a clip placed later offline is rebased over the drag's undo, confirmed meanwhile: it stays put", async () => {
  const { w, a, b } = await splitAndDragOnTwo();
  try {
    await b.sync!.disconnect();
    const y = await b.commit({ ops: insertY });
    assert.equal(y.status, "pending");
    const u = await a.undo(undefined, { since: 0, app: true, id: a.newChangeId() });
    assert.ok(u.status === "pending" || u.status === "confirmed", u.status);
    await until(async () => (await a.pendingCount()) === 0, 5000, "the undo confirmed");
    await b.sync!.connect({ nonce: "lease-2" });
    assert.equal((await b.sync!.waitFor((y as { id: string }).id, 5000)).status, "confirmed");
    for (const [who, c] of [["alice", a], ["bob", b]] as const) await until(async () => (await c.log()).some((x) => x.change === (y as { id: string }).id), 5000, `bob's clip at ${who}`);
    for (const [who, c] of [["alice", a], ["bob", b]] as const) assert.deepEqual(shape((await c.head()).doc), UNDONE_WITH_Y, `${who}: bob's clip still at 7–8 s`);
  } finally {
    await a.close();
    await b.close();
    w.host.close();
  }
});

// an edit made on a state from before the drag's undo (an agent's apply on an older base) is merged onto the head with
// the undo on the head side: the undo records no remap, so none is inferred there either
test("local cut: a clip placed later on a base from before the drag's undo stays put", async () => {
  let now = 1000;
  const c = await Carton.open({ adapter, store: createMemoryStore(), init: { doc: doc() }, clock: () => (now += 10) });
  await c.commit({ ops: splitOps, author: person, intent: { kind: "split", lineage: { x: ["a", "b"] } } });
  await c.commit({ ops: moved("b", 4.5, 6), author: person });
  const before = (await c.head()).ref;
  assert.equal((await c.undo(GROUP, { since: now, app: true, author: person })).status, "confirmed");
  const r = await c.commit({ ops: insertY, base: before, author: { kind: "agent", id: "director", name: "Director", group: "local:me@laptop/director", turn: "t1" } });
  assert.equal(r.status, "confirmed", r.status === "conflicts" ? JSON.stringify(r.cards.map((k) => k.reason)) : r.status);
  assert.deepEqual(shape((await c.head()).doc), UNDONE_WITH_Y);
  await c.close();
});

test("shared cut: a clip placed later on a base from before the drag's undo, still pending, stays put", async () => {
  const { w, a, b } = await splitAndDragOnTwo();
  try {
    const before = (await a.head()).ref;
    await a.sync!.disconnect();
    const u = await a.undo(undefined, { since: 0, app: true, id: a.newChangeId() });
    assert.equal(u.status, "pending");
    const r = await a.commit({ ops: insertY, base: before, author: { kind: "agent", id: "director", name: "Director", group: "alice@laptop/director", turn: "t1" } });
    assert.equal(r.status, "pending", r.status === "conflicts" ? JSON.stringify(r.cards.map((k) => k.reason)) : r.status);
    assert.deepEqual(shape((await a.head()).doc), UNDONE_WITH_Y, "alice's head");
    await a.sync!.connect({ nonce: "lease-2" });
    await until(async () => (await a.pendingCount()) === 0, 5000, "both confirmed");
    await until(async () => (await b.log()).some((x) => x.change === (r as { id: string }).id), 5000, "both at bob");
    for (const [who, c] of [["alice", a], ["bob", b]] as const) assert.deepEqual(shape((await c.head()).doc), UNDONE_WITH_Y, who);
  } finally {
    await a.close();
    await b.close();
    w.host.close();
  }
});
