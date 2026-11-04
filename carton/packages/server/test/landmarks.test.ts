// Carton UX v2 for teammates: shared landmarks (Exported, Sent) and a bring-back's fields, through the sequencer core
// every host runs. A landmark is never a change (no row, no seq, no version); it is kept beside the rows, so archiving
// them never touches it; a bring-back's restoreOf, clip and name are kept in its row, through a welcome, a history
// request and an archived segment. Older clients are never sent anything new; an older server never gets a landmark
// (the client waits for the welcome's `landmarks`).
import test from "node:test";
import assert from "node:assert/strict";
import type { Change, sync } from "@carton/core";
import { createSequencer } from "../src/index.ts";
import { MAX_PER_CUT, PAGE } from "../src/landmarks.ts";
import { BRANCH, clip, declare, doc, fakeConn, memoryBlobs, push, set, sqliteStorage, staticAuth, verdict, world, type FakeConn } from "./helpers.ts";

const d0 = () => doc([clip("c0", 0, 5), clip("c1", 5, 10)]);
const hello = (o: Partial<sync.HelloMsg> = {}): sync.HelloMsg => ({ type: "hello", branchId: BRANCH, have: 0, pending: [], rids: [], schemaVersion: 1, ...o });
const RID_A = "a1a1a1a1a1a1a1a1a1a1a1a1", RID_B = "b2b2b2b2b2b2b2b2b2b2b2b2";
let n = 0;
const mark = (rid: string, o: Partial<sync.SharedLandmark> = {}): sync.SharedLandmark => ({ id: `${rid}.L${(++n).toString(36)}x`, kind: "exported", seq: 0, at: 1_700_000_000_000 + n, by: { kind: "human", id: "alice", name: "Alice" }, label: "1080p for the client", ...o });
const send = (seq: ReturnType<typeof createSequencer>, c: FakeConn, m: sync.SharedLandmark, branchId = BRANCH) => seq.handle(c, { type: "landmark", branchId, mark: m });
const ask = (seq: ReturnType<typeof createSequencer>, c: FakeConn, since = 0, branchId = BRANCH) => seq.handle(c, { type: "landmarks", branchId, since });
const replies = (c: FakeConn) => c.inbox.filter((m) => m.type === "landmarks") as sync.LandmarksReplyMsg[];
const told = (c: FakeConn) => replies(c).filter((m) => !m.reply && !m.refused).flatMap((m) => m.rows);
const page = (c: FakeConn) => replies(c).filter((m) => m.reply).at(-1)!;
const errors = (c: FakeConn) => c.inbox.filter((m) => m.type === "error");

test("the welcome says the server keeps landmarks (a watch link's doesn't); a connection that never asks gets none", async () => {
  const { seq } = await world(d0());
  const a = fakeConn("alice/dev1"), old = fakeConn("carol/dev1"), watch = fakeConn("w/1", "viewer", { branches: [BRANCH] });
  for (const c of [a, old, watch]) await seq.handle(c, hello());
  assert.equal(a.last("hello")!.landmarks, true);
  assert.equal(watch.last("hello")!.landmarks, undefined, "a watch link is never offered them");
  await ask(seq, a);
  await send(seq, a, mark(RID_A));
  // an older client (subscribed to the cut, never asked for landmarks) is sent nothing it doesn't know
  assert.deepEqual(old.inbox.filter((m) => m.type !== "hello" && m.type !== "people").map((m) => m.type), []);
});

test("a landmark reaches every connection that asked for the cut's, the writer's own answer too; it is no change: no row, no seq", async () => {
  const storage = sqliteStorage();
  const { seq } = await world(d0(), { storage });
  const a = fakeConn("alice/dev1"), b = fakeConn("bob/dev1"), other = fakeConn("dan/dev1");
  for (const c of [a, b, other]) await seq.handle(c, hello());
  await ask(seq, b);
  await seq.handle(other, hello({ branchId: "elsewhere" })); // asked for another cut's (unknown here): nothing of this one
  const head = seq.tables.head(BRANCH);
  const rowsBefore = Number(storage.db.prepare("SELECT COUNT(*) AS n FROM changes").get()!.n);
  const m = mark(RID_A);
  await send(seq, a, m);
  const mine = replies(a).at(-1)!;
  assert.deepEqual([mine.rows[0]!.id, mine.rows[0]!.n, mine.head, mine.reply], [m.id, 1, 1, undefined], "the writer is told it is kept, as it is told everyone");
  assert.deepEqual(told(b).map((r) => [r.id, r.kind, r.seq, r.label, r.by.name, r.n]), [[m.id, "exported", 0, "1080p for the client", "Alice", 1]]);
  assert.deepEqual(told(other), []);
  assert.equal(seq.tables.head(BRANCH), head, "no seq");
  assert.equal(Number(storage.db.prepare("SELECT COUNT(*) AS n FROM changes").get()!.n), rowsBefore, "no row in changes");
  assert.deepEqual(errors(a), []);
  // a retry (its answer lost) is kept once: answered with the one kept, to the writer alone
  b.inbox.length = 0;
  await send(seq, a, { ...m, label: "changed in the retry" });
  assert.deepEqual([replies(a).at(-1)!.rows[0]!.n, replies(a).at(-1)!.rows[0]!.label], [1, "1080p for the client"]);
  assert.deepEqual(told(b), [], "a retry tells no one again");
  // a catch-up from 0 has it; from its place, nothing
  await ask(seq, b, 0);
  assert.deepEqual(page(b).rows.map((r) => r.id), [m.id]);
  await ask(seq, b, 1);
  assert.deepEqual([page(b).rows.length, page(b).head], [0, 1]);
});

test("what the server won't keep is told to its writer as `refused`, never as an error, and nothing is stored", async () => {
  const { seq, d0: before } = await world(d0());
  const a = fakeConn("alice/dev1"), viewer = fakeConn("vic/dev1", "viewer"), thief = fakeConn("mallory/dev1"), b = fakeConn("bob/dev1");
  for (const c of [a, viewer, thief, b]) await seq.handle(c, hello());
  assert.equal(verdict(await push(seq, a, before, [set("c0", "name", "x")], { id: `${RID_A}.1` })), "ack"); // binds RID_A to alice's device
  await ask(seq, b);
  const bad: [FakeConn, sync.SharedLandmark, string][] = [
    [viewer, mark("c3c3c3c3c3c3c3c3c3c3c3c3"), "a viewer"],
    [thief, mark(RID_A), "another device's replica id"],
    [a, mark(RID_A, { seq: 99 }), "a version the cut doesn't have"],
    [a, mark(RID_A, { kind: "start" as never }), "a Start (personal)"],
    [a, mark(RID_A, { kind: "before" as never }), "a Before (personal)"],
    [a, mark(RID_A, { label: "x".repeat(121) }), "a label over 120 characters"],
    [a, mark(RID_A, { by: { kind: "human", id: "alice", name: "x".repeat(2000) } }), "an author over 1 KB"],
    [a, { ...mark(RID_A), id: "no-rid-here" }, "an id without its rid"],
    [a, { ...mark(RID_A), at: Number.NaN }, "no time"],
  ];
  for (const [c, m, what] of bad) {
    c.inbox.length = 0;
    await send(seq, c, m);
    assert.deepEqual(c.inbox.map((x) => [x.type, (x as sync.LandmarksReplyMsg).refused]), [["landmarks", [m.id]]], what);
  }
  await send(seq, a, mark(RID_A), "no-such-cut");
  assert.deepEqual(replies(a).at(-1)!.refused?.length, 1, "an unknown cut");
  assert.deepEqual(told(b), [], "nothing reached a teammate");
  await ask(seq, b);
  assert.deepEqual(page(b).rows, [], "nothing stored");
});

test("a watch link (a reader scoped to its cut) gets no landmarks: an empty answer, never a fan-out", async () => {
  const { seq } = await world(d0());
  const a = fakeConn("alice/dev1"), watch = fakeConn("w/1", "viewer", { branches: [BRANCH] });
  await seq.handle(a, hello());
  await seq.handle(watch, hello());
  await send(seq, a, mark(RID_A));
  await ask(seq, watch);
  assert.deepEqual([page(watch).rows, page(watch).head], [[], 0]);
  await send(seq, a, mark(RID_A, { kind: "sent", label: "Shared with Leo" }));
  assert.deepEqual(told(watch), []);
  assert.equal(watch.state?.landmarks, undefined);
});

test("catch-up comes a page at a time, oldest first; a cut keeps its newest MAX_PER_CUT", async () => {
  const { seq } = await world(d0());
  const a = fakeConn("alice/dev1"), b = fakeConn("bob/dev1");
  for (const c of [a, b]) await seq.handle(c, hello());
  const total = MAX_PER_CUT + 5;
  for (let i = 0; i < total; i++) await send(seq, a, mark(RID_A, { label: `export ${i + 1}` }));
  const got: sync.SharedLandmark[] = [];
  let since = 0, pages = 0;
  for (;;) {
    b.inbox.length = 0;
    await ask(seq, b, since);
    const p = page(b);
    pages++;
    got.push(...p.rows);
    assert.ok(p.rows.length <= PAGE);
    if (!p.more) {
      assert.equal(p.head, total);
      break;
    }
    since = p.rows.at(-1)!.n!;
  }
  assert.equal(pages, Math.ceil(MAX_PER_CUT / PAGE));
  assert.equal(got.length, MAX_PER_CUT, "the oldest 5 went");
  assert.deepEqual([got[0]!.label, got.at(-1)!.label, got[0]!.n], ["export 6", `export ${total}`, 6]);
});

test("landmarks outlive archiving and a restart: a joiner after both reads them, and a share cancelled takes them", async () => {
  const storage = sqliteStorage(), blobs = memoryBlobs();
  const { seq, d0: before } = await world(d0(), { storage, blobs });
  const a = fakeConn("alice/dev1");
  await seq.handle(a, hello());
  for (let i = 0; i < 30; i++) assert.equal(verdict(await push(seq, a, before, [set("c0", "name", `v${i}`)], { id: `${RID_A}.${i + 1}` })), "ack");
  const early = mark(RID_A, { seq: 3 }), late = mark(RID_A, { kind: "sent", seq: 30, label: "Shared with Leo" });
  await send(seq, a, early);
  await send(seq, a, late);
  assert.equal(await seq.archive(BRANCH, { keep: 0, segmentRows: 10 }), 30, "every row archived");
  // the same storage, a new sequencer (a Durable Object's restart): a teammate joins
  const again = createSequencer({ storage, auth: staticAuth, blobs });
  const b = fakeConn("bob/dev1");
  await again.handle(b, hello({ have: -1 }));
  assert.equal(b.last("hello")!.landmarks, true);
  await ask(again, b);
  assert.deepEqual(page(b).rows.map((r) => [r.id, r.kind, r.seq, r.label ?? null]), [[early.id, "exported", 3, "1080p for the client"], [late.id, "sent", 30, "Shared with Leo"]]);
  again.cancelShare(BRANCH);
  assert.equal(Number(storage.db.prepare("SELECT COUNT(*) AS n FROM landmarks").get()!.n), 0, "gone with the cut");
});

test("a landmark costs one row written", async () => {
  const { seq, storage } = await world(d0());
  const a = fakeConn("alice/dev1");
  await seq.handle(a, hello({ rids: [RID_A] }));
  await send(seq, a, mark(RID_A)); // the table exists after this
  const before = storage.stats!().rowsWritten;
  await send(seq, a, mark(RID_A));
  assert.equal(storage.stats!().rowsWritten - before, 1);
});

/** A bring-back as a replica pushes it (Carton.restoreClip on a shared cut): its fields beside the ops. */
function bringBack(head: number, extra: Record<string, unknown>): Change {
  const before = d0();
  const ops = [set("c1", "endTime", 9)];
  return { id: `${RID_A}.${head + 100}`, hash: "h", author: { kind: "human", id: "person" }, branchId: BRANCH, base: { seq: head, pending: [] }, ops, intent: null, kinds: null, policy: "merge", at: 1, kind: "restore", ...extra, ...declare(before, ops, null) } as Change;
}

test("a bring-back's restoreOf, clip and name stay in its row: fanned out, in a welcome, a history page and after archiving; anything but a string is dropped", async () => {
  const storage = sqliteStorage(), blobs = memoryBlobs();
  const { seq } = await world(d0(), { storage, blobs });
  const a = fakeConn("alice/dev1"), b = fakeConn("bob/dev1");
  for (const c of [a, b]) await seq.handle(c, hello());
  const fields = { restoreOf: `${BRANCH}@0`, restoreRecord: "timelineItems/c1", restoreName: "B-roll pier" };
  await seq.handle(a, { type: "push", branchId: BRANCH, epoch: 1, changes: [bringBack(0, fields)] });
  assert.equal(verdict(a.last("ack")!), "ack");
  const pick = (r: Record<string, unknown> | undefined) => r && { restoreOf: r.restoreOf, restoreRecord: r.restoreRecord, restoreName: r.restoreName, kind: r.kind };
  assert.deepEqual(pick((b.last("changes") as sync.ChangesMsg).rows[0] as never), { ...fields, kind: "restore" }, "fanned out to the teammate");
  // not strings: dropped (the row is still kept)
  await seq.handle(a, { type: "push", branchId: BRANCH, epoch: 2, changes: [bringBack(1, { restoreOf: 7, restoreRecord: { x: 1 }, restoreName: "x".repeat(2000) })] });
  assert.equal(verdict(a.last("ack")!), "ack");
  assert.deepEqual(pick((b.last("changes") as sync.ChangesMsg).rows[0] as never), { restoreOf: undefined, restoreRecord: undefined, restoreName: undefined, kind: "restore" });
  const joiner = fakeConn("carol/dev1");
  await seq.handle(joiner, hello({ have: 0 }));
  assert.deepEqual(pick(joiner.last("hello")!.rows[0] as never), { ...fields, kind: "restore" }, "in a later welcome");
  assert.equal(await seq.archive(BRANCH, { keep: 0, segmentRows: 1 }), 2);
  const h = fakeConn("dan/dev1");
  await seq.handle(h, { type: "history", branchId: BRANCH, req: 1, after: 0, upTo: 2 });
  const r = h.last("history") as sync.HistoryReplyMsg;
  assert.deepEqual(pick(r.rows[0] as never), { ...fields, kind: "restore" }, "read back from its archived segment");
});
