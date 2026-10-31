// @carton/server driven directly, with stand-in connections (as system-v11's server-level cases did). Each test name
// says which rule it pins. The ported prototype tests keep their names; the new ones cover PLAN v14's fixes (H1, H3,
// H4) and the four v12 rules no prototype test pinned (system-v11/verify/RESULTS.md §2.2).
import test from "node:test";
import assert from "node:assert/strict";
import { BRANCH, clip, doc, fakeConn, ins, memoryBlobs, push, rm, set, sqliteStorage, staticAuth, verdict, world, type Doc } from "./helpers.ts";
import { createSequencer } from "../src/index.ts";
import type { sync } from "@carton/core";

const clips = (n: number, track = "V1") => Array.from({ length: n }, (_, i) => clip(`c${i}`, i * 5, (i + 1) * 5, track));
const hello = (have: number, pending: sync.PendingClaim[] = [], rids: string[] = []): sync.HelloMsg => ({ type: "hello", branchId: BRANCH, have, pending, rids, schemaVersion: 1 });

test("v11 K cap: a push 100 behind is evaluated; 101 behind is rejected \"behind\" without the overlap check, listing its already-confirmed ids", async () => {
  const { seq, d0 } = await world(doc(clips(40)));
  const other = fakeConn("other/k1"), me = fakeConn("me/k2");
  for (let i = 0; i < 101; i++) assert.equal(verdict(await push(seq, other, d0, [set(`c${10 + (i % 30)}`, "name", `n${i}`)])), "ack");
  const r0 = seq.tables.meter.rowsRead;
  const r100 = await push(seq, me, d0, [set("c0", "name", "late-100")], { base: { seq: 1, pending: [] } });
  const read100 = seq.tables.meter.rowsRead - r0;
  const r101 = await push(seq, me, d0, [set("c1", "name", "late-101")], { base: { seq: 1, pending: [] } });
  assert.equal(verdict(r100), "ack", "exactly 100 behind: scanned and accepted (no overlap)");
  assert.ok(read100 >= 100, "it read the 100-row tail");
  assert.equal(r101.type, "reject");
  assert.equal(r101.type === "reject" && r101.reason, "behind", "101 behind (head 102, base 1)");
  assert.deepEqual(r101.type === "reject" && r101.concurrent, [], "no rows named, no overlap check");
  assert.deepEqual(r101.type === "reject" && r101.confirmed, [], "R10-01: this push's ids already confirmed (none)");
});

test("v11 span check: a timing op without a span containing its new edge is rejected; with one it is accepted", async () => {
  const { seq, d0 } = await world(doc(clips(4)));
  const c = fakeConn("x/k");
  const move = [set("c1", "startTime", 6), set("c1", "endTime", 11)];
  assert.equal(verdict(await push(seq, c, d0, move, { spans: [] })), "span missing", "no span");
  assert.equal(verdict(await push(seq, c, d0, move, { spans: [{ track: "V1", lo: 5, hi: 10 }] })), "span missing", "doesn't reach the new end (11)");
  assert.equal(verdict(await push(seq, c, d0, move)), "ack", "the engine's declaration covers it");
  assert.equal(verdict(await push(seq, c, d0, [set("c2", "opacity", 0.5)], { spans: [] })), "ack", "a style edit needs no span");
});

test("v11 span check is per track: a move on V1 with a span only on T2, a slip with a span elsewhere, a track change spanning only one track, an unset with no span are all rejected", async () => {
  const { seq, d0 } = await world(doc(clips(4)));
  const c = fakeConn("x/k");
  const out = {
    moveSpanOnT2: verdict(await push(seq, c, d0, [set("c1", "startTime", 6), set("c1", "endTime", 11)], { spans: [{ track: "T2", lo: 5, hi: 11 }] })),
    slipSpanElsewhere: verdict(await push(seq, c, d0, [set("c1", "trimStart", 0.5), set("c1", "trimEnd", 5.5)], { spans: [{ track: "T2", lo: 0, hi: 100 }] })),
    trackChangeOneSpan: verdict(await push(seq, c, d0, [set("c1", "trackId", "T2")], { spans: [{ track: "V1", lo: 5, hi: 10 }] })),
    unsetNoSpan: verdict(await push(seq, c, d0, [{ op: "unset", path: ["timelineItems", "c1", "playbackSpeed"] }], { spans: [] })),
    removeNoSpan: verdict(await push(seq, c, d0, [rm("timelineItems", "c2")], { spans: [] })),
  };
  for (const [k, v] of Object.entries(out)) assert.equal(v, "span missing", k);
  assert.equal(verdict(await push(seq, c, d0, [set("c1", "trackId", "T2")])), "ack", "the engine's own declaration (both tracks) is accepted");
  const d1: Doc = { ...d0, timelineItems: d0.timelineItems.map((i) => (i.id === "c1" ? { ...i, trackId: "T2" } : i)) };
  assert.equal(verdict(await push(seq, c, d1, [set("c1", "startTime", 6), set("c1", "endTime", 11)], { spans: [{ track: "V1", lo: 5, hi: 11 }] })), "span missing", "after the move, c1's track is T2");
  assert.equal(verdict(await push(seq, c, d1, [set("c1", "startTime", 6), set("c1", "endTime", 11)])), "ack");
});

// Existence per branch with history (v11 §6.3). Main has tracks V1 and T2. Main removes T2 (seq 2) and re-inserts it
// (seq 3); later it inserts Z (seq 4). Variants fork at seq 1 (T2 alive, Z unborn), 2 (T2 removed), 3 (T2 back).
async function forkScenario(records: "history" | "latest-only") {
  const { seq, d0 } = await world(doc(clips(3)), { controls: { records } });
  const c = fakeConn("x/k");
  const fork = async (id: string, at: number) => {
    await seq.handle(c, { type: "fork", branchId: id, from: BRANCH, seq: at, rec: { id, name: id, forkOf: `${BRANCH}@${at}`, owner: "x", kind: "variant", sequencer: { kind: "server", since: 0 } } });
  };
  assert.equal(verdict(await push(seq, c, d0, [set("c0", "name", "m1")])), "ack"); // seq 1
  await fork("V1", 1);
  assert.equal(verdict(await push(seq, c, d0, [rm("tracks", "T2")])), "ack"); // seq 2
  await fork("V2", 2);
  assert.equal(verdict(await push(seq, c, d0, [ins("tracks", "T2", { id: "T2" })])), "ack", "re-inserted (undo)"); // seq 3
  await fork("V3", 3);
  const Z = clip("Z", 20, 25);
  assert.equal(verdict(await push(seq, c, d0, [ins("timelineItems", "Z", Z)])), "ack"); // seq 4
  const place = async (v: string) => verdict(await push(seq, c, d0, [ins("timelineItems", `t-${v}`, clip(`t-${v}`, 0, 3, "T2"))], { branch: v, base: { seq: 0, pending: [] } }));
  return {
    V1: await place("V1"),
    V2: await place("V2"),
    V3: await place("V3"),
    zOnV1: verdict(await push(seq, c, d0, [ins("timelineItems", "Z", Z)], { branch: "V1", base: { seq: 1, pending: [] } })),
    mainT2: seq.tables.record(BRANCH, "tracks", "T2")?.alive,
    mainZ: seq.tables.record(BRANCH, "timelineItems", "Z")?.alive,
  };
}
test("v11 per-branch existence: remove and re-insert on the parent after the fork; each variant sees the record as it was at its own fork point", async () => {
  const r = await forkScenario("history");
  assert.equal(r.V1, "ack", "V1 (forked before the remove) still has T2");
  assert.equal(r.V2, "read of a missing record", "V2 (forked between remove and re-insert) has no T2");
  assert.equal(r.V3, "ack", "V3 (forked after the re-insert) has T2");
  assert.equal(r.zOnV1, "ack", "Z was born on main after V1's fork point");
  assert.equal(r.mainT2, true);
  assert.equal(r.mainZ, true);
});
test("v11 control: one row per record (v10's PRIMARY KEY) answers V1 wrongly once the parent has touched T2 after the fork", async () => {
  const r = await forkScenario("latest-only");
  assert.equal(r.V1, "read of a missing record", "V1's valid placement is rejected");
});

test("H3: nested forks two levels deep resolve existence with each hop's bound in that parent's own numbering", async () => {
  // Z is inserted on main at seq 3; V forks main@5; G forks V@1. On G, Z exists: a trim of Z is accepted and a second
  // insert of Z is rejected. The prototype's min(limit, forkOf.seq) bounded main by 1 and got both wrong.
  const { seq, d0 } = await world(doc(clips(2)));
  const c = fakeConn("x/k");
  for (const name of ["a", "b"]) await push(seq, c, d0, [set("c0", "name", name)]);
  const Z = clip("Z", 20, 25);
  assert.equal(verdict(await push(seq, c, d0, [ins("timelineItems", "Z", Z)])), "ack"); // seq 3
  for (const name of ["d", "e"]) await push(seq, c, d0, [set("c1", "name", name)]); // seqs 4, 5
  const rec = (id: string) => ({ id, name: id, forkOf: null, owner: "x", kind: "variant" as const, sequencer: { kind: "server" as const, since: 0 } });
  await seq.handle(c, { type: "fork", branchId: "V", from: BRANCH, seq: 5, rec: rec("V") });
  const withZ: Doc = { ...d0, timelineItems: [...d0.timelineItems, Z] };
  assert.equal(verdict(await push(seq, c, withZ, [set("c0", "name", "v1")], { branch: "V", base: { seq: 0, pending: [] } })), "ack"); // V@1
  await seq.handle(c, { type: "fork", branchId: "G", from: "V", seq: 1, rec: rec("G") });
  assert.equal(verdict(await push(seq, c, withZ, [set("Z", "endTime", 24), set("Z", "trimEnd", 4)], { branch: "G", base: { seq: 0, pending: [] } })), "ack", "G sees Z (inserted on main before both forks)");
  assert.equal(verdict(await push(seq, c, withZ, [ins("timelineItems", "Z", Z)], { branch: "G", base: { seq: 1, pending: [] } })), "exists", "and refuses a duplicate insert of it");
});

test("H4: a concurrent track move or remove of the clip makes the span check an overlap (rebased), never \"span missing\" (dropped)", async () => {
  for (const alice of ["move", "remove"] as const) {
    const { seq, d0 } = await world(doc(clips(4)));
    const a = fakeConn("alice/k1"), b = fakeConn("bob/k2");
    const aliceOps = alice === "move" ? [set("c1", "trackId", "T2")] : [rm("timelineItems", "c1")];
    assert.equal(verdict(await push(seq, a, d0, aliceOps)), "ack");
    // Bob's edits were made on d0, where c1 is on V1
    const base = { seq: 0, pending: [] };
    assert.equal(verdict(await push(seq, b, d0, [set("c1", "endTime", 9.5), set("c1", "trimEnd", 4.5)], { base })), "overlap", `Bob's trim after Alice's ${alice}`);
    assert.equal(verdict(await push(seq, b, d0, [rm("timelineItems", "c1")], { base })), "overlap", `Bob's remove after Alice's ${alice}`);
  }
});

test("H1: a withdraw row spends the id: a late push of it is acked as withdrawn and never confirmed; a withdraw after the id was confirmed answers with that seq", async () => {
  const { seq, d0 } = await world(doc(clips(4)));
  const taker = fakeConn("agent/k1"), dead = fakeConn("agent/k1"), bob = fakeConn("bob/k2");
  await seq.handle(taker, hello(0));
  await seq.handle(bob, hello(0));
  assert.equal(verdict(await push(seq, bob, d0, [set("c1", "opacity", 0.9)], { policy: "lww" })), "ack");
  taker.inbox.length = bob.inbox.length = 0;
  await seq.handle(taker, { type: "withdraw", branchId: BRANCH, id: "h1rid.1", base: 1, epoch: 1 });
  const ack = taker.last("ack")!;
  assert.deepEqual([ack.seq, ack.withdrawn], [2, true], "1 row: the id is spent at seq 2");
  assert.ok((bob.last("changes")?.rows[0] as { withdrawn?: boolean } | undefined)?.withdrawn, "every replica gets the withdraw row (logs stay identical)");
  const late = await push(seq, dead, d0, [set("c1", "opacity", 0.3)], { id: "h1rid.1", policy: "lww", base: { seq: 0, pending: [] } });
  assert.equal(verdict(late), "withdrawn", "the dead helper's late push: acked withdrawn");
  assert.equal(seq.tables.head(BRANCH), 2, "nothing confirmed");
  await seq.handle(taker, { type: "withdraw", branchId: BRANCH, id: "h1rid.1", base: 1, epoch: 2 });
  assert.equal(taker.last("ack")?.seq, 2, "a repeated withdraw is idempotent");
  // the other order: the late push wins, then the withdraw learns the id is confirmed
  const won = await push(seq, dead, d0, [set("c2", "opacity", 0.3)], { id: "h1rid.2", policy: "lww", base: { seq: 0, pending: [] } });
  assert.equal(verdict(won), "ack");
  await seq.handle(taker, { type: "withdraw", branchId: BRANCH, id: "h1rid.2", base: 2, epoch: 3 });
  const a2 = taker.last("ack")!;
  assert.deepEqual([a2.seq, a2.duplicate, a2.withdrawn], [3, true, undefined], "confirmed, not withdrawn: the client keeps it as confirmed");
});

test("a withdrawn id counts as part of a later change's base (its causal past changed nothing)", async () => {
  const { seq, d0 } = await world(doc(clips(2)));
  const c = fakeConn("x/k");
  await seq.handle(c, hello(0));
  await seq.handle(c, { type: "withdraw", branchId: BRANCH, id: "xk.1", base: 0, epoch: 1 });
  assert.equal(verdict(await push(seq, c, d0, [set("c0", "name", "n")], { id: "xk.2", base: { seq: 0, pending: ["xk.1"] } })), "ack");
});

test("the confirmed-id list scans (b, b + K + 1] for every base a claim was pushed on, live or archived: at most K + 1 rows per base", async () => {
  for (const archived of [false, true]) {
    const blobs = memoryBlobs();
    const { seq, d0 } = await world(doc(clips(40)), { blobs });
    const x = fakeConn("x/kx"), bob = fakeConn("bob/kb");
    // X's change is confirmed at seq 1 but its ack is lost; X goes offline while Bob makes 2,000 changes
    assert.equal(verdict(await push(seq, x, d0, [set("c0", "name", "x")], { id: "xrid.1" })), "ack");
    for (let i = 0; i < 2000; i++) await push(seq, bob, d0, [set(`c${1 + (i % 39)}`, "name", `b${i}`)]);
    if (archived) assert.ok((await seq.archive(BRANCH, { keep: 400, segmentRows: 256 })) > 0, "the old range went to blob segments");
    const r0 = seq.tables.meter.rowsRead;
    const x2 = fakeConn("x/kx");
    await seq.handle(x2, hello(2001, [{ id: "xrid.1", bases: [0] }]));
    const w = x2.last("hello")!;
    assert.deepEqual(w.confirmed, [{ id: "xrid.1", seq: 1, rebase: 0 }], `found (${archived ? "archived" : "live"})`);
    // the scan itself: one range of K + 1 = 101 seqs (plus the head lookup and any segment index row)
    const scanned = seq.tables.meter.rowsRead - r0;
    assert.ok(scanned <= 101 + 4, `rows read for the list: ${scanned}`);
    if (archived) assert.equal(blobs.gets, 0, "the list never reads an archived blob (the segment index has the ids)");
  }
});

test("unpinned v12 rule, now pinned: the list scans from each claim's own oldest base, so an id pushed long before the others is still found", async () => {
  for (const claimScan of ["every-base", "newest"] as const) {
    const { seq, d0 } = await world(doc(clips(40)), { controls: { claimScan } });
    const x = fakeConn("x/kx"), bob = fakeConn("bob/kb");
    assert.equal(verdict(await push(seq, x, d0, [set("c0", "name", "x1")], { id: "xrid.1", base: { seq: 0, pending: [] } })), "ack"); // seq 1, ack lost
    for (let i = 0; i < 150; i++) await push(seq, bob, d0, [set(`c${1 + (i % 39)}`, "name", `b${i}`)]);
    // the same change, rebased after a reconnect, was also pushed on base 140 and its fate is unknown
    const x2 = fakeConn("x/kx");
    await seq.handle(x2, hello(151, [{ id: "xrid.1", bases: [0, 140] }]));
    const found = x2.last("hello")!.confirmed.map((e) => e.id);
    if (claimScan === "every-base") assert.deepEqual(found, ["xrid.1"], "found through its oldest base");
    else assert.deepEqual(found, [], "control: scanning from the newest base misses it");
  }
});

test("unpinned v12 rule, now pinned: the \"behind\" reject carries the list of the push's ids already confirmed", async () => {
  for (const listOnBehind of [true, false]) {
    const { seq, d0 } = await world(doc(clips(40)), { controls: { listOnBehind } });
    const x = fakeConn("x/kx"), bob = fakeConn("bob/kb");
    assert.equal(verdict(await push(seq, x, d0, [set("c0", "name", "x1")], { id: "xrid.1" })), "ack");
    for (let i = 0; i < 120; i++) await push(seq, bob, d0, [set(`c${1 + (i % 39)}`, "name", `b${i}`)]);
    // a stalled retransmit of the whole pipelined queue arrives: xrid.1 (confirmed) and xrid.2 (not), both on base 0
    x.inbox.length = 0;
    const mk = (id: string, name: string) => ({ id, hash: "h", author: { kind: "human" as const, id: "x" }, branchId: BRANCH, base: { seq: 0, pending: [] }, ops: [set("c0", "name", name)], intent: null, kinds: null, policy: "merge" as const, at: 0, paths: ["timelineItems/c0/name"], reads: ["timelineItems/c0"], spans: [], trackOrder: [] });
    await seq.handle(x, { type: "push", branchId: BRANCH, epoch: 999, changes: [mk("xrid.2", "x2"), mk("xrid.1", "x1")] });
    const r = x.last("reject")!;
    assert.equal(r.reason, "behind");
    if (listOnBehind) assert.deepEqual(r.confirmed, [{ id: "xrid.1", seq: 1, rebase: 0 }]);
    else assert.equal(r.confirmed, undefined, "control: no list");
  }
});

test("unpinned v12 rule, now pinned: hello claims the replica's rids, so another credential can't take a rid that was claimed but never pushed", async () => {
  for (const helloRidClaim of [true, false]) {
    const { seq, d0 } = await world(doc(clips(4)), { controls: { helloRidClaim } });
    const alice = fakeConn("alice/install-1"), mallory = fakeConn("mallory/install-9");
    // Alice's replica used rid "arid" offline (never pushed it) and says hello claiming it
    await seq.handle(alice, hello(0, [], ["arid"]));
    const forged = await push(seq, mallory, d0, [set("c1", "name", "forged")], { id: "arid.1" });
    const own = await push(seq, alice, d0, [set("c2", "name", "mine")], { id: "arid.2" });
    if (helloRidClaim) {
      assert.equal(verdict(forged), "foreign id", "the claimed rid is Alice's");
      assert.equal(verdict(own), "ack");
    } else {
      assert.equal(verdict(forged), "ack", "control: the forger binds the rid first");
      assert.equal(verdict(own), "foreign id", "and Alice's own offline change is refused");
    }
  }
});

test("v11 rid bound to the device credential: another install of the same account can't push this install's ids; a new connection with the same credential can", async () => {
  const { seq, d0 } = await world(doc(clips(4)));
  const laptop = fakeConn("alice/laptop"), desktop = fakeConn("alice/desktop"), laptop2 = fakeConn("alice/laptop");
  assert.equal(verdict(await push(seq, laptop, d0, [set("c1", "name", "a")], { id: "lap.1" })), "ack");
  assert.equal(verdict(await push(seq, desktop, d0, [set("c2", "name", "b")], { id: "lap.2" })), "foreign id");
  assert.equal(verdict(await push(seq, laptop2, d0, [set("c2", "name", "c")], { id: "lap.3" })), "ack", "a reconnect reclaims the rid");
  const control = await world(doc(clips(4)), { controls: { bindRid: "connection" } });
  const l1 = fakeConn("alice/laptop"), l2 = fakeConn("alice/laptop");
  assert.equal(verdict(await push(control.seq, l1, d0, [set("c1", "name", "a")], { id: "lap.1" })), "ack");
  assert.equal(verdict(await push(control.seq, l2, d0, [set("c2", "name", "b")], { id: "lap.2" })), "foreign id", "control: bound to one connection");
});

test("P5 rows written: a style edit, a trim, an lww edit and a 1-op remap write 1 row; an insert, a remove and a track change write 2; rejects and duplicates write 0", async () => {
  const storage = sqliteStorage();
  const { seq, d0 } = await world(doc(clips(10)), { storage });
  const c = fakeConn("x/k");
  await seq.handle(c, hello(0, [], ["xk"])); // the replica's one rids row is written here, once per replica id
  const cost = async (f: () => Promise<unknown>) => {
    const w0 = storage.stats!().rowsWritten;
    await f();
    return storage.stats!().rowsWritten - w0;
  };
  const remapOp = { op: "remap" as const, path: ["#remap"] as const, maps: { V1: [{ d: [[10, 12]] as [number, number][], i: [] }] } };
  const out = {
    style: await cost(() => push(seq, c, d0, [set("c0", "name", "s")], { id: "xk.style" })),
    trim: await cost(() => push(seq, c, d0, [set("c3", "endTime", 19), set("c3", "trimEnd", 4)])),
    lww: await cost(() => push(seq, c, d0, [set("c5", "opacity", 0.4)], { policy: "lww" })),
    remap: await cost(() => push(seq, c, d0, [remapOp], { spans: [{ track: "V1", lo: 10, hi: null }], intent: null })),
    insert: await cost(() => push(seq, c, d0, [ins("timelineItems", "n1", clip("n1", 60, 65))])),
    remove: await cost(() => push(seq, c, d0, [rm("timelineItems", "c9")])),
    trackChange: await cost(() => push(seq, c, d0, [set("c8", "trackId", "T2")])),
    reject: await cost(() => push(seq, c, d0, [set("c0", "name", "r")], { base: { seq: 0, pending: [] } })),
    duplicate: await cost(() => push(seq, c, d0, [set("c0", "name", "s")], { id: "xk.style", base: { seq: 0, pending: [] } })),
  };
  assert.deepEqual(out, { style: 1, trim: 1, lww: 1, remap: 1, insert: 2, remove: 2, trackChange: 2, reject: 0, duplicate: 0 });
});

test("lww: a concurrent style edit is overwritten and its author toasted; lww with a span or group path is refused as structure", async () => {
  const { seq, d0 } = await world(doc(clips(4)));
  const a = fakeConn("alice/k1"), b = fakeConn("bob/k2");
  await seq.handle(a, hello(0));
  await seq.handle(b, hello(0));
  assert.equal(verdict(await push(seq, a, d0, [set("c1", "opacity", 0.9)], { policy: "lww" })), "ack");
  b.inbox.length = 0;
  const r = await push(seq, b, d0, [set("c1", "opacity", 0.3)], { policy: "lww", base: { seq: 0, pending: [] } });
  assert.equal(verdict(r), "ack");
  assert.ok(a.inbox.some((m) => m.type === "overwritten" && m.id.startsWith("alicek1")), "Alice is told who overwrote her edit");
  assert.equal(verdict(await push(seq, b, d0, [set("c2", "endTime", 14), set("c2", "trimEnd", 4)], { policy: "lww" })), "lww on structure");
});

test("a reject kills the rest of its epoch: later messages of that epoch are ignored until the client resubmits in a new one", async () => {
  const { seq, d0 } = await world(doc(clips(4)));
  const a = fakeConn("alice/k1"), b = fakeConn("bob/k2");
  await push(seq, a, d0, [set("c1", "name", "a")]);
  const rejected = await push(seq, b, d0, [set("c1", "name", "b")], { base: { seq: 0, pending: [] }, epoch: 7 });
  assert.equal(verdict(rejected), "overlap");
  assert.deepEqual(rejected.type === "reject" && rejected.concurrent.map((x) => x.seq), [1], "names the clashing row");
  b.inbox.length = 0;
  await seq.handle(b, { type: "push", branchId: BRANCH, epoch: 7, changes: [] });
  await push(seq, b, d0, [set("c2", "name", "b2")], { epoch: 7 }).catch(() => null);
  assert.equal(b.inbox.length, 0, "ignored");
  assert.equal(verdict(await push(seq, b, d0, [set("c2", "name", "b2")], { epoch: 8 })), "ack", "a new epoch is heard");
});

test("roles and scope: viewers and commenters can't push; a token scoped to other cuts can't push here; tracking branches are read-only", async () => {
  const { seq, d0 } = await world(doc(clips(2)));
  for (const role of ["viewer", "commenter"] as const) assert.equal(verdict(await push(seq, fakeConn(`v/${role}`, role), d0, [set("c0", "name", "v")])), "forbidden");
  assert.equal(verdict(await push(seq, fakeConn("agent/k", "editor", { branches: ["other"] }), d0, [set("c0", "name", "v")])), "forbidden");
  const c = fakeConn("alice/k");
  await seq.handle(c, {
    type: "adopt",
    branchId: "shared-2",
    n: 0,
    stateHash: "s",
    rows: [],
    rec: { id: "shared-2", name: "main", forkOf: null, owner: "alice", kind: "main", sequencer: { kind: "server", since: 0 } },
    doc0: d0 as never,
    closure: [{ branchId: "private-v", rec: { id: "private-v", name: "variant", forkOf: null, owner: "alice", kind: "variant", sequencer: { kind: "local" } }, nodes: [] }],
  });
  assert.equal(c.last("adopted")?.since, 0);
  assert.equal(verdict(await push(seq, c, d0, [set("c0", "name", "t")], { branch: "private-v" })), "read-only branch");
});

test("R3-03 adoption is idempotent by (branchId, n, stateHash@n); another log under the same id is refused; branchStatus answers a lost ack", async () => {
  const { seq, d0 } = await world(doc(clips(2)));
  const c = fakeConn("alice/k");
  const rows = [1, 2].map((s) => ({
    seq: s,
    id: `local.${s}`,
    hash: `h${s}`,
    author: { kind: "human" as const, id: "alice" },
    branchId: "B2",
    base: { seq: s - 1, pending: [] },
    ops: [set("c0", "name", `n${s}`)],
    intent: null,
    kinds: null,
    policy: "merge" as const,
    at: 0,
    paths: ["timelineItems/c0/name"],
    reads: ["timelineItems/c0"],
    spans: [],
    trackOrder: [],
  }));
  const adopt = (stateHash: string): sync.AdoptMsg => ({
    type: "adopt",
    branchId: "B2",
    n: 2,
    stateHash,
    rows,
    rec: { id: "B2", name: "main", forkOf: null, owner: "alice", kind: "main", sequencer: { kind: "server", since: 2 } },
    doc0: d0 as never,
    closure: [],
  });
  await seq.handle(c, adopt("s2"));
  assert.deepEqual(c.last("adopted"), { type: "adopted", branchId: "B2", since: 2 });
  await seq.handle(c, adopt("s2"));
  assert.equal(c.last("adopted")?.repeat, true, "the same upload gets the same answer");
  await seq.handle(c, adopt("other"));
  assert.equal(c.last("adoptError")?.reason, "branch exists with another log");
  await seq.handle(c, { type: "branchStatus", branchId: "B2" });
  assert.deepEqual(c.last("status"), { type: "status", branchId: "B2", adopted: true, adoptKey: "B2|2|s2", since: 2, head: 2 });
  assert.equal(seq.stats.adopts, 1);
  assert.equal(verdict(await push(seq, c, d0, [set("c0", "name", "n2")], { branch: "B2", id: "local.1", base: { seq: 0, pending: [] } })), "duplicate", "adopted rows dedup like any other");
});

test("keyframes: an ack asks for one every K changes; a hello more than K behind gets it plus the tail; a fresh joiner gets the root state", async () => {
  const { seq, d0 } = await world(doc(clips(10)), { keyframeEvery: 8 });
  const a = fakeConn("alice/k");
  let wanted = 0;
  for (let i = 0; i < 120; i++) {
    const r = await push(seq, a, d0, [set(`c${i % 10}`, "name", `n${i}`)]);
    if (r.type === "ack" && r.keyframeWanted) {
      wanted++;
      if (r.keyframeWanted === 112) await seq.handle(a, { type: "keyframe", branchId: BRANCH, keyframe: { seq: 112, stateHash: "kf112", doc: { tracks: [], timelineItems: [] } } });
    }
  }
  assert.equal(wanted, 15, "seqs 8, 16, …, 120");
  const late = fakeConn("bob/k");
  await seq.handle(late, hello(3));
  const w = late.last("hello")!;
  assert.deepEqual([w.keyframe?.seq, w.keyframe?.stateHash, w.rows[0]?.seq, w.rows.length, w.head], [112, "kf112", 113, 8, 120]);
  const near = fakeConn("carol/k");
  await seq.handle(near, hello(30));
  assert.equal(near.last("hello")?.keyframe, undefined, "the keyframe is behind `have`: rows only");
  const fresh = fakeConn("dave/k");
  await seq.handle(fresh, hello(-1));
  assert.equal(fresh.last("hello")?.keyframe?.seq, 112, "a joiner with no state gets the latest keyframe");
});

test("presence is relayed to the branch's other subscribers and never stored", async () => {
  const { seq } = await world(doc(clips(2)));
  const a = fakeConn("alice/k1"), b = fakeConn("bob/k2"), outsider = fakeConn("eve/k3");
  await seq.handle(a, hello(0));
  await seq.handle(b, hello(0));
  const w0 = seq.stats.rowsWritten;
  await seq.handle(a, { type: "presence", branchId: BRANCH, actor: { kind: "human", id: "alice" }, state: { at: 3, dragging: true } });
  assert.deepEqual(b.last("presence")?.state, { at: 3, dragging: true });
  assert.equal(a.last("presence"), undefined, "not echoed to the sender");
  assert.equal(outsider.inbox.length, 0, "not sent to connections that never said hello on the branch");
  assert.equal(seq.stats.rowsWritten, w0, "nothing written");
});

test("restart-safe: a new sequencer on the same storage dedups, keeps rid bindings and answers the same", async () => {
  const storage = sqliteStorage();
  const { seq, d0 } = await world(doc(clips(4)), { storage });
  const a = fakeConn("alice/k1");
  assert.equal(verdict(await push(seq, a, d0, [set("c1", "name", "a")], { id: "arid.1" })), "ack");
  const again = createSequencer({ storage, auth: staticAuth });
  const a2 = fakeConn("alice/k1"), m = fakeConn("mallory/k9");
  assert.equal(verdict(await push(again, a2, d0, [set("c1", "name", "a")], { id: "arid.1", base: { seq: 0, pending: [] } })), "duplicate");
  assert.equal(verdict(await push(again, m, d0, [set("c2", "name", "m")], { id: "arid.2" })), "foreign id");
  assert.equal(again.tables.head(BRANCH), 1);
});

test("a body over the inline limit goes to the blob store and comes back whole in catch-up", async () => {
  const blobs = memoryBlobs();
  const { seq, d0 } = await world(doc(clips(2)), { blobs, maxInlineBytes: 1000 });
  const a = fakeConn("alice/k1");
  const big = "x".repeat(5000);
  assert.equal(verdict(await push(seq, a, d0, [set("c0", "name", big)])), "ack");
  assert.ok([...blobs.map.keys()].some((k) => k.startsWith("changes/")), "stored as a blob");
  const b = fakeConn("bob/k2");
  await seq.handle(b, hello(0));
  const op = b.last("hello")!.rows[0]!.ops[0]!;
  assert.equal(op.op === "set" && op.value, big);
  const tiny = await world(doc(clips(2)), { maxInlineBytes: 1000 });
  assert.equal(verdict(await push(tiny.seq, fakeConn("alice/k1"), d0, [set("c0", "name", big)])), "too large", "without a blob store it is refused");
});

test("catch-up pages through archived segments and the live table in order", async () => {
  const blobs = memoryBlobs();
  const { seq, d0 } = await world(doc(clips(4)), { blobs, catchupLimit: 300 });
  const a = fakeConn("alice/k1");
  for (let i = 0; i < 700; i++) await push(seq, a, d0, [set(`c${i % 4}`, "name", `n${i}`)]);
  assert.equal(await seq.archive(BRANCH, { keep: 200, segmentRows: 128 }), 384);
  const b = fakeConn("bob/k2");
  const seqs: number[] = [];
  let have = 0;
  for (;;) {
    await seq.handle(b, hello(have));
    const w = b.last("hello")!;
    seqs.push(...w.rows.map((r) => r.seq));
    have = w.rows.at(-1)?.seq ?? have;
    if (!w.more) break;
  }
  assert.deepEqual(seqs, Array.from({ length: 700 }, (_, i) => i + 1));
});
