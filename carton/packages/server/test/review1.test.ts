// Regression tests for review round 1's server findings (GPT 6.1 Sol, f50da49); each name carries its number.
import test from "node:test";
import assert from "node:assert/strict";
import { BRANCH, clip, doc, fakeConn, ins, memoryBlobs, push, set, sqliteStorage, staticAuth, verdict, world, type Doc } from "./helpers.ts";
import { createSequencer } from "../src/index.ts";
import type { Change, sync } from "@carton/core";

const clips = (n: number, track = "V1") => Array.from({ length: n }, (_, i) => clip(`c${i}`, i * 5, (i + 1) * 5, track));
const hello = (have: number, pending: sync.PendingClaim[] = [], branchId = BRANCH): sync.HelloMsg => ({ type: "hello", branchId, have, pending, rids: [], schemaVersion: 1 });
const rec = (id: string) => ({ id, name: id, forkOf: null, owner: "x", kind: "main" as const, sequencer: { kind: "server" as const, since: 0 } });
const row = (id: string, seq: number, name: string): Change & { seq: number } => ({
  id, seq, hash: "h", author: { kind: "human", id: "a" }, branchId: "B2", base: { seq: seq - 1, pending: [] },
  ops: [set("c0", "name", name)], intent: null, kinds: null, policy: "merge", at: 0,
  paths: ["timelineItems/c0/name"], reads: ["timelineItems/c0"], spans: [], trackOrder: [],
});
const adopt = (branchId: string, rows: (Change & { seq: number })[], d0: Doc, o: Partial<sync.AdoptMsg> = {}): sync.AdoptMsg => ({
  type: "adopt", branchId, n: rows.length, stateHash: "s", rows, rec: rec(branchId), doc0: d0 as never, closure: [], ...o,
});

test("finding 1: adopt and fork refuse a record whose id isn't the branch id (no overwrite of another branch)", async () => {
  const { seq, d0 } = await world(doc(clips(2)));
  const c = fakeConn("x/k");
  await seq.handle(c, adopt("fresh", [], d0, { rec: rec(BRANCH) }));
  assert.match(c.last("adoptError")!.reason, /rec\.id/);
  assert.equal(seq.tables.branch(BRANCH)!.rec.name, "main", "the existing branch's record is untouched");
  assert.equal(seq.tables.branch("fresh"), null);
  await seq.handle(c, { type: "fork", branchId: "f2", from: BRANCH, seq: 0, rec: rec(BRANCH) });
  assert.match(c.last("error")!.reason, /rec\.id/);
});

test("finding 2: a body in the blob store is keyed by its own digest, not the client's hash", async () => {
  const blobs = memoryBlobs();
  const { seq, d0 } = await world(doc(clips(2)), { blobs, maxInlineBytes: 1000 });
  const a = fakeConn("alice/k1");
  const one = "x".repeat(5000), two = "y".repeat(5000);
  assert.equal(verdict(await push(seq, a, d0, [set("c0", "name", one)])), "ack");
  assert.equal(verdict(await push(seq, a, d0, [set("c1", "name", two)])), "ack");
  assert.equal([...blobs.map.keys()].filter((k) => k.startsWith("changes/")).length, 2, "two bodies, two keys (both pushes carried hash 'h')");
  const b = fakeConn("bob/k2");
  await seq.handle(b, hello(0));
  const vals = b.last("hello")!.rows.map((r) => (r.ops[0] as { value: string }).value[0]);
  assert.deepEqual(vals, ["x", "y"], "each row comes back with its own body");
});

test("finding 3: a subscriber still paging through catch-up gets no live rows until its last page, so rows stay contiguous", async () => {
  const { seq, d0 } = await world(doc(clips(4)), { catchupLimit: 5 });
  const a = fakeConn("alice/k1"), b = fakeConn("bob/k2");
  for (let i = 0; i < 12; i++) await push(seq, a, d0, [set(`c${i % 4}`, "name", `n${i}`)]);
  await seq.handle(b, hello(0));
  assert.equal(b.last("hello")!.more, true);
  await push(seq, a, d0, [set("c0", "name", "live")]); // seq 13, while b is between pages
  assert.equal(b.inbox.filter((m) => m.type === "changes").length, 0, "no live row ahead of the backlog");
  const seqs = b.last("hello")!.rows.map((r) => r.seq);
  for (;;) {
    const last = b.last("hello")!;
    if (!last.more) break;
    await seq.handle(b, hello(last.rows.at(-1)!.seq));
    seqs.push(...b.last("hello")!.rows.map((r) => r.seq));
  }
  assert.deepEqual(seqs, Array.from({ length: 13 }, (_, i) => i + 1));
  await push(seq, a, d0, [set("c1", "name", "after")]);
  assert.equal(b.last("changes")!.rows[0]!.seq, 14, "subscribed once caught up");
});

test("finding 4: a token scoped to other cuts can't upload keyframes, adopt or fork into a cut outside its scope", async () => {
  const { seq, d0 } = await world(doc(clips(2)), { keyframeEvery: 1 });
  const scoped = fakeConn("agent/k", "editor", { branches: ["private"] });
  await seq.handle(scoped, hello(0));
  await seq.handle(scoped, { type: "keyframe", branchId: BRANCH, keyframe: { seq: 0, stateHash: "e".repeat(64), doc: { tracks: [], timelineItems: [] } } });
  assert.equal(seq.tables.keyframeAt(BRANCH, 0)!.hash, "h0", "main's root keyframe untouched");
  await seq.handle(scoped, adopt("elsewhere", [], d0));
  assert.equal(scoped.last("adoptError")?.reason, "forbidden");
  await seq.handle(scoped, { type: "fork", branchId: "elsewhere", from: BRANCH, seq: 0, rec: rec("elsewhere") });
  assert.equal(scoped.last("error")?.reason, "forbidden");
  await seq.handle(scoped, { type: "fork", branchId: "private", from: BRANCH, seq: 0, rec: rec("private") });
  assert.equal(scoped.last("forked")?.branchId, "private", "its own cut is fine");
});

test("finding 5: a failed adoption leaves nothing behind (no branch, no keyframe, no cached head); a correct retry adopts", async () => {
  const { seq, d0 } = await world(doc(clips(2)));
  const c = fakeConn("x/k");
  await seq.handle(c, adopt("B2", [row("lo.1", 1, "a"), row("lo.2", 3, "b")], d0)); // a gap at seq 2
  assert.match(c.last("adoptError")!.reason, /in order/);
  await seq.handle(c, { type: "branchStatus", branchId: "B2" });
  assert.equal(c.last("status")!.adopted, false);
  assert.equal(seq.tables.keyframeAt("B2", 0), null, "the root keyframe went with it");
  await seq.handle(c, adopt("B2", [row("lo.1", 1, "a"), row("lo.2", 2, "b")], d0));
  assert.equal(c.last("adopted")!.since, 2);
  assert.equal(seq.tables.head("B2"), 2);
});

test("finding 6: a client can't mark its change as a withdraw row (which the overlap test skips)", async () => {
  const { seq, d0 } = await world(doc(clips(2)));
  const a = fakeConn("alice/k1"), b = fakeConn("bob/k2");
  await push(seq, a, d0, []).catch(() => null);
  const forged: Change & { withdrawn?: boolean } = {
    id: "alicek1.900", hash: "h", author: { kind: "human", id: "alice" }, branchId: BRANCH, base: { seq: seq.tables.head(BRANCH), pending: [] },
    ops: [set("c0", "name", "forged")], intent: null, kinds: null, policy: "merge", at: 0, paths: ["timelineItems/c0/name"], reads: ["timelineItems/c0"], spans: [], trackOrder: [], withdrawn: true,
  };
  await seq.handle(a, { type: "push", branchId: BRANCH, epoch: 50, changes: [forged] });
  const stored = seq.tables.tail(BRANCH, seq.tables.head(BRANCH) - 1)[0]!;
  assert.equal(stored.withdrawn, false, "stored as an ordinary row");
  assert.equal(verdict(await push(seq, b, d0, [set("c0", "name", "bob")], { base: { seq: 0, pending: [] } })), "overlap", "and it still blocks a concurrent write");
});

test("finding 7: the existence reads are required: placing or moving an item without reading its track is refused", async () => {
  const { seq, d0 } = await world(doc(clips(2)));
  const c = fakeConn("x/k");
  const r1 = await push(seq, c, d0, [ins("timelineItems", "z", clip("z", 30, 35, "NOPE"))]);
  assert.equal(verdict(r1), "read of a missing record", "declared honestly: the missing track is caught");
  const insert = { op: "insert" as const, path: ["timelineItems", "z"], value: clip("z", 30, 35, "NOPE") };
  const hidden: Change = { id: "xk.77", hash: "h", author: { kind: "human", id: "x" }, branchId: BRANCH, base: { seq: seq.tables.head(BRANCH), pending: [] }, ops: [insert], intent: null, kinds: null, policy: "merge", at: 0, paths: ["timelineItems/z"], reads: [], spans: [{ track: "NOPE", lo: 30, hi: 35 }], trackOrder: [] };
  c.inbox.length = 0;
  await seq.handle(c, { type: "push", branchId: BRANCH, epoch: 900, changes: [hidden] });
  assert.equal(c.last("reject")!.reason, "undeclared path", "omitting the read is refused");
  const move: Change = { ...hidden, id: "xk.78", ops: [set("c0", "trackId", "NOPE")], paths: ["timelineItems/c0/trackId"], reads: ["timelineItems/c0"], spans: [{ track: "V1", lo: 0, hi: 5 }, { track: "NOPE", lo: 0, hi: 5 }] };
  await seq.handle(c, { type: "push", branchId: BRANCH, epoch: 901, changes: [move] });
  assert.equal(c.last("reject")!.reason, "undeclared path");
});

test("findings 8 and 9: a record-level set is refused; inserted clips and edits that set both edges must be valid", async () => {
  const { seq, d0 } = await world(doc(clips(2)));
  const c = fakeConn("x/k");
  const replace: Change = { id: "xk.80", hash: "h", author: { kind: "human", id: "x" }, branchId: BRANCH, base: { seq: 0, pending: [] }, ops: [{ op: "set", path: ["timelineItems", "c0"], value: clip("c0", 0, 5, "T2") }], intent: null, kinds: null, policy: "merge", at: 0, paths: ["timelineItems/c0"], reads: ["timelineItems/c0"], spans: [], trackOrder: [] };
  await seq.handle(c, hello(0));
  await seq.handle(c, { type: "push", branchId: BRANCH, epoch: 1, changes: [replace] });
  assert.equal(c.last("reject")!.reason, "invalid");
  assert.ok(["invalid", "bad change"].includes(verdict(await push(seq, c, d0, [ins("timelineItems", "bad", clip("bad", 10, 5))]))), "an insert ending before it starts (its declared span is inverted too)");
  assert.equal(verdict(await push(seq, c, d0, [set("c1", "startTime", 9), set("c1", "endTime", 6)])), "invalid", "both edges set, inverted");
  assert.equal(verdict(await push(seq, c, d0, [set("c1", "startTime", 6), set("c1", "endTime", 9)])), "ack");
});

test("finding 10: claims beyond the per-message cap are reported unchecked, never treated as unconfirmed", async () => {
  const { seq, d0 } = await world(doc(clips(40)), { controls: { claimWindows: 3 } });
  const x = fakeConn("x/kx"), bob = fakeConn("bob/kb");
  for (let i = 0; i < 600; i++) await push(seq, bob, d0, [set(`c${i % 40}`, "name", `b${i}`)]);
  // x's change was confirmed at seq 601, pushed on base 600 after retries on bases far below (each its own range)
  assert.equal(verdict(await push(seq, x, d0, [set("c0", "opacity", 0.5)], { id: "xrid.1", base: { seq: 600, pending: [] } })), "ack");
  const bases = [0, 150, 300, 450, 600];
  const x2 = fakeConn("x/kx");
  await seq.handle(x2, hello(601, [{ id: "xrid.1", bases }]));
  const w = x2.last("hello")!;
  assert.deepEqual(w.confirmed, [], "not found in the ranges checked");
  assert.equal(w.uncheckedFrom, 450, "three ranges read; the rest reported unchecked");
  await seq.handle(x2, hello(601, [{ id: "xrid.1", bases: bases.filter((b) => b >= w.uncheckedFrom!) }]));
  assert.deepEqual(x2.last("hello")!.confirmed.map((e) => e.seq), [601], "asked again, it is found");
});

test("finding 11: adoption binds the uploaded rows' replica ids to the adopter's credential", async () => {
  const { seq, d0 } = await world(doc(clips(2)));
  const owner = fakeConn("alice/k1"), mallory = fakeConn("mallory/k9");
  await seq.handle(owner, adopt("B2", [row("arid.1", 1, "a")], d0));
  assert.equal(owner.last("adopted")!.since, 1);
  assert.equal(verdict(await push(seq, mallory, d0, [set("c1", "name", "m")], { branch: "B2", id: "arid.2" })), "foreign id");
  assert.equal(verdict(await push(seq, owner, d0, [set("c1", "name", "a2")], { branch: "B2", id: "arid.3" })), "ack");
});

test("finding 12: a fork made with its root state can be joined from nothing", async () => {
  const { seq, d0 } = await world(doc(clips(2)));
  const c = fakeConn("x/k");
  await seq.handle(c, { type: "fork", branchId: "V", from: BRANCH, seq: 0, rec: rec("V"), root: { stateHash: "f".repeat(64), doc: d0 as never } });
  assert.equal(c.last("forked")!.branchId, "V");
  const j = fakeConn("j/k");
  await seq.handle(j, hello(-1, [], "V"));
  assert.equal(j.last("hello")!.keyframe?.stateHash, "f".repeat(64), "a joiner with no state gets the fork's root");
});

test("finding 17: the inline limit counts UTF-8 bytes, so multibyte text over it goes to the blob store", async () => {
  const blobs = memoryBlobs();
  const { seq, d0 } = await world(doc(clips(2)), { blobs, maxInlineBytes: 1500 });
  const a = fakeConn("alice/k1");
  const euro = "€".repeat(700); // 700 UTF-16 units, 2,100 UTF-8 bytes
  assert.equal(verdict(await push(seq, a, d0, [set("c0", "name", euro)])), "ack");
  assert.ok([...blobs.map.keys()].some((k) => k.startsWith("changes/")), "stored as a blob");
  const b = fakeConn("bob/k2");
  await seq.handle(b, hello(0));
  assert.equal((b.last("hello")!.rows[0]!.ops[0] as { value: string }).value, euro);
});

test("finding 15: batched record lookups read one row per record however long its history", async () => {
  const storage = sqliteStorage();
  const { seq, d0 } = await world(doc(clips(3)), { storage });
  const c = fakeConn("x/k");
  let d: Doc = d0;
  // c0 changes track 20 times: 20 history rows
  for (let i = 0; i < 20; i++) {
    const to = i % 2 ? "V1" : "T2";
    assert.equal(verdict(await push(seq, c, d, [set("c0", "trackId", to)])), "ack");
    d = { ...d, timelineItems: d.timelineItems.map((it) => (it.id === "c0" ? { ...it, trackId: to } : it)) };
  }
  const r0 = seq.tables.meter.rowsRead;
  const m = seq.tables.records(BRANCH, "timelineItems", ["c0", "c1", "c2"]);
  assert.equal(seq.tables.meter.rowsRead - r0, 3, "three rows read for three records");
  assert.equal(m.get("c0")!.lane, "V1");
  void createSequencer;
  void staticAuth;
});
