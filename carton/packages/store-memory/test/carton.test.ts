// Carton.open on store-memory: the public handle end to end (persistence, two processes on one store, cuts and fold
// in, pins, undo by actor group, restore, .cbproj, fences, remaps stored as one op).
import { test } from "node:test";
import assert from "node:assert/strict";
import { Carton, StateUnknown, defineSchema, object, timeAlgebra, rippleDelete, remapSpan, POS, type Actor, type Doc, type Rec } from "@carton/core";
import type { HostAdapter } from "@carton/core/plugins";
import { createMemoryData, createMemoryStore } from "../src/index.ts";

const TL = { collection: "items", lanes: "tracks", lane: "trackId", start: "startTime", end: "endTime", source: "trimStart", sourceEnd: "trimEnd", speed: "playbackSpeed" };
const schema = defineSchema({
  collections: {
    tracks: { seq: true },
    items: { parent: { field: "trackId", collection: "tracks" }, groups: [{ name: "time", fields: ["startTime", "endTime", "trimStart", "trimEnd", "playbackSpeed"], algebra: timeAlgebra(TL) }], fields: { style: object() } },
  },
  timeline: TL,
  hard: (coll, r) => (coll === "items" && !((r.endTime as number) > (r.startTime as number)) ? ["endTime must be greater than startTime"] : []),
});
const adapter: HostAdapter<Doc> = { name: "test", schema, schemaVersion: 1, fromHost: (h) => h, toHost: (d) => d };
const clip = (id: string, s: number, e: number, track = "t1"): Rec => ({ id, trackId: track, startTime: s, endTime: e, trimStart: 0, trimEnd: e - s, name: id });
const doc0 = (): Doc => ({ name: "Film", tracks: [{ id: "t1", [POS]: "V" }], items: [clip("a", 0, 5), clip("b", 5, 10), clip("c", 10, 15), clip("d", 15, 20), clip("e", 20, 25), clip("f", 25, 30)] });
const human: Actor = { kind: "human", id: "alice", group: "alice@laptop" };
const director = (turn: string): Actor => ({ kind: "agent", id: "director", name: "Director", turn, group: "alice@laptop" });
const bob: Actor = { kind: "human", id: "bob" };
const set = (id: string, f: string, v: unknown) => ({ op: "set" as const, path: ["items", id, f], value: v });
const item = (d: Doc, id: string) => (d.items as Rec[]).find((i) => i.id === id);

test("open with init, commit, reopen from the same store sees the same history", async () => {
  const store = createMemoryStore();
  const c = await Carton.open({ adapter, store, init: { doc: doc0() }, actor: human });
  const r = await c.commit({ ops: [set("a", "name", "Intro")] });
  assert.equal(r.status, "confirmed");
  assert.ok(r.status === "confirmed" && r.seq === 1);
  const log = await c.log();
  assert.deepEqual(log.map((v) => v.ref.seq), [1, 0]);
  const again = await Carton.open({ adapter, store });
  assert.equal(again.projectId, c.projectId);
  assert.equal(item((await again.head()).doc, "a")!.name, "Intro");
  assert.equal((await again.log())[0]!.author?.id, "alice");
});

test("two handles on one store act like two processes: concurrent commits both land, none lost", async () => {
  const data = createMemoryData();
  const a = await Carton.open({ adapter, store: createMemoryStore({ shared: data }), init: { doc: doc0() }, actor: human });
  const b = await Carton.open({ adapter, store: createMemoryStore({ shared: data }), actor: bob });
  const [ra, rb] = await Promise.all([a.commit({ ops: [set("a", "name", "A")] }), b.commit({ ops: [set("b", "name", "B")] })]);
  assert.equal(ra.status, "confirmed");
  assert.equal(rb.status, "confirmed");
  const seqs = [ra, rb].map((r) => (r.status === "confirmed" ? r.seq : 0)).sort();
  assert.deepEqual(seqs, [1, 2]);
  const head = (await a.head()).doc;
  assert.equal(item(head, "a")!.name, "A");
  assert.equal(item(head, "b")!.name, "B");
  // a stale base from the other process: a different record lands as is; the same field is a card, never lost
  const r3 = await b.commit({ ops: [set("c", "name", "C")], base: { branchId: b.cut, seq: 0 } });
  assert.ok(r3.status === "confirmed" && r3.seq === 3);
  const r4 = await b.commit({ ops: [set("a", "name", "A2")], base: { branchId: b.cut, seq: 0 } });
  assert.ok(r4.status === "conflicts" && r4.cards[0]!.path === "items/a/name" && r4.cards[0]!.ours === "A" && r4.cards[0]!.theirs === "A2");
  const r5 = await b.commit({ ops: [set("a", "name", "A2")], base: { branchId: b.cut, seq: 0 }, choices: ["theirs"] });
  assert.ok(r5.status === "confirmed" && r5.rebased === 1);
  assert.equal(item((await a.head()).doc, "a")!.name, "A2");
  // ids stay unique after a handle rebuilt itself from the store (a lost append race): an undo is a new change
  const u = await b.undo();
  assert.ok(u.status === "confirmed" && u.change && u.seq === 5, "the undo was applied, not acked as a duplicate");
  const ids = (await a.log()).map((v) => v.change).filter(Boolean);
  assert.equal(new Set(ids).size, ids.length);
});

test("fork a cut, edit both, fold in: both edits kept; credits name the variant's author", async () => {
  const c = await Carton.open({ adapter, store: createMemoryStore(), init: { doc: doc0() }, actor: human });
  const main = c.cut;
  const v = await c.fork("30s cut");
  await c.commit({ cut: v.id, ops: [set("b", "name", "Shorter")], author: bob });
  await c.commit({ ops: [set("a", "name", "Intro")] });
  const f = await c.fold(v.id);
  assert.equal(f.status, "confirmed");
  const head = (await c.head(main)).doc;
  assert.equal(item(head, "a")!.name, "Intro");
  assert.equal(item(head, "b")!.name, "Shorter");
  assert.equal((await c.credits(["items", "b"]))?.id, "bob");
  assert.equal((await c.fold(v.id)).status, "up-to-date");
});

test("a fold sees the source cut's changes made by another process", async () => {
  const data = createMemoryData();
  const a = await Carton.open({ adapter, store: createMemoryStore({ shared: data }), init: { doc: doc0() }, actor: human });
  const v = await a.fork("variant");
  const b = await Carton.open({ adapter, store: createMemoryStore({ shared: data }), actor: bob });
  await b.commit({ cut: v.id, ops: [set("d", "name", "from b")] });
  assert.equal((await a.fold(v.id)).status, "confirmed");
  assert.equal(item((await a.head()).doc, "d")!.name, "from b");
});

test("pin for an owner: its header checks out until the last owner releases it, then 'state unknown'", async () => {
  const c = await Carton.open({ adapter, store: createMemoryStore(), init: { doc: doc0() }, actor: human });
  const edited = (await c.head()).doc;
  (edited.items as Rec[]).push(clip("g", 30, 31));
  const p = await c.pin({ owner: "turn-1", doc: edited });
  await c.pin({ owner: "view-a", doc: edited });
  assert.match(p.header, /^Main cut@0~[0-9a-f]{8} b:[0-9a-f]{8} p:[0-9a-f]{8}$/);
  assert.ok(item(await c.checkout(p.header), "g"));
  await c.release(p.ref, "turn-1");
  assert.ok(item(await c.checkout(p.header), "g"), "another owner still holds it");
  await c.release(p.ref, "view-a");
  await assert.rejects(c.checkout(p.header), (e: unknown) => e instanceof StateUnknown);
});

test("undo by actor group: the Director's turn is undone as one, a teammate's change is not in the stack", async () => {
  const c = await Carton.open({ adapter, store: createMemoryStore(), init: { doc: doc0() }, actor: human });
  await c.commit({ ops: [set("a", "name", "x1")], author: director("t1") });
  await c.commit({ ops: [set("b", "name", "x2")], author: director("t1") });
  await c.commit({ ops: [set("c", "name", "bob's")], author: bob });
  const stack = await c.undoStack();
  assert.equal(stack.length, 2);
  assert.match(stack[0]!.label, /^Undo Director: /);
  const u = await c.undo();
  assert.equal(u.status, "confirmed");
  const head = (await c.head()).doc;
  assert.equal(item(head, "a")!.name, "a");
  assert.equal(item(head, "b")!.name, "b");
  assert.equal(item(head, "c")!.name, "bob's", "a teammate's change is never undone by your ⌘Z");
  assert.equal((await c.undoStack()).length, 0);
});

test("a commit is idempotent by id; restore saves an old state as a new version", async () => {
  const c = await Carton.open({ adapter, store: createMemoryStore(), init: { doc: doc0() }, actor: human });
  const r1 = await c.commit({ ops: [set("a", "name", "once")], id: "cb-call.1" });
  const r2 = await c.commit({ ops: [set("a", "name", "once")], id: "cb-call.1" });
  assert.ok(r1.status === "confirmed" && r2.status === "confirmed" && r1.seq === r2.seq);
  assert.equal((await c.log()).length, 2);
  await c.commit({ ops: [set("b", "name", "later")] });
  const r = await c.restore(`${c.cut}@1`);
  assert.equal(r.status, "confirmed");
  const head = (await c.head()).doc;
  assert.equal(item(head, "a")!.name, "once");
  assert.equal(item(head, "b")!.name, "b");
  assert.equal((await c.log())[0]!.kind, "restore");
});

test(".cbproj shallow export to a new store forks a writable cut; bringing their changes back folds cleanly", async () => {
  const alice = await Carton.open({ adapter, store: createMemoryStore(), init: { doc: doc0() }, actor: human, name: "Alice" });
  await alice.commit({ ops: [set("a", "name", "Summer")] });
  const pkg = await alice.exportShallow({ to: "bob" });
  const bobStore = createMemoryStore();
  const b2 = await Carton.open({ adapter, store: bobStore, init: { import: pkg }, actor: bob, name: "Bob" });
  assert.equal(b2.projectId, alice.projectId);
  assert.equal(item((await b2.head()).doc, "a")!.name, "Summer");
  assert.equal((await b2.commit({ ops: [set("b", "name", "Bob's edit")] })).status, "confirmed");
  // reopened, Bob still holds the lineage; his copy goes back to Alice and folds in with no cards
  const b3 = await Carton.open({ adapter, store: bobStore, actor: bob });
  assert.ok((await b3.cuts()).some((c) => c.shallow));
  await alice.commit({ ops: [set("c", "name", "Alice later")] });
  const back = await b3.exportShallow({ to: "alice" });
  assert.equal((await alice.importShallow(back)).status, "imported");
  const f = await alice.fold(back.head);
  assert.equal(f.status, "confirmed");
  const head = (await alice.head()).doc;
  assert.deepEqual([item(head, "a")!.name, item(head, "b")!.name, item(head, "c")!.name], ["Summer", "Bob's edit", "Alice later"]);
});

test("a caller's condition (a lease fence) that fails writes nothing and throws", async () => {
  const store = createMemoryStore();
  const c = await Carton.open({ adapter, store, init: { doc: doc0() }, actor: human });
  await store.write([{ table: "lease", key: ["sync", "nonce"], value: "n2" }]);
  await assert.rejects(c.commit({ ops: [set("a", "name", "fenced")], conditions: [{ table: "lease", key: ["sync", "nonce"], expect: { equals: "n1" } }] }));
  assert.equal(item((await c.head()).doc, "a")!.name, "a");
  assert.equal((await c.log()).length, 1);
});

test("a recorded ripple is stored as one remap op and replays to the same state after a reopen", async () => {
  const store = createMemoryStore();
  const c = await Carton.open({ adapter, store, init: { doc: doc0() }, actor: human });
  const maps = { t1: rippleDelete(5, 5) };
  const ops = [{ op: "remove" as const, path: ["items", "b"] }];
  for (const it of doc0().items as Rec[]) {
    if (it.id === "b") continue;
    const m = remapSpan(maps.t1, it.startTime as number, it.endTime as number);
    if (m && m[0] !== it.startTime) ops.push(set(it.id as string, "startTime", m[0]) as never, set(it.id as string, "endTime", m[1]) as never);
  }
  const r = await c.commit({ ops, intent: { kind: "ripple-delete", maps } });
  assert.ok(r.status === "confirmed" && r.change);
  const stored = r.status === "confirmed" ? r.change!.ops : [];
  assert.equal(stored.filter((op) => op.op === "remap").length, 1, "one remap op");
  assert.equal(stored.filter((op) => op.op === "set").length, 0, "no per-item sets");
  const head = (await c.head()).doc;
  assert.equal(item(head, "c")!.startTime, 5);
  assert.equal(item(head, "f")!.endTime, 25);
  const again = await Carton.open({ adapter, store });
  assert.deepEqual((await again.head()).doc, head);
  assert.equal((await again.credits(["items", "f"]))?.id, "alice", "credits see the items a remap moved");
});
