// A blob the tables refer to is gone from the blob store (deleted under the sequencer: the lab's purge, an operator's
// cleanup, a bucket lifecycle rule). Keyframes only shorten a catch-up, so one whose blob is gone is passed over for an
// older one or for the rows; history that only a blob held is refused with a code (`history-missing`) in people's
// words, never an "internal" error the client waits behind in "syncing" (stuck-sync, laptop run 2026-11-03).
import test from "node:test";
import assert from "node:assert/strict";
import type { sync } from "@carton/core";
import type { SequencerEvent } from "../src/index.ts";
import { BRANCH, clip, doc, fakeConn, memoryBlobs, push, set, verdict, world, type FakeConn } from "./helpers.ts";

const HASH = (c: string) => c.repeat(64);

/** A cut with `n` confirmed rows on a sequencer with a blob store, and keyframes uploaded at 64 and 128 (as replicas do). */
async function history(n: number) {
  const d0 = doc([clip("c0", 0, 5), clip("c1", 5, 10)]);
  const blobs = memoryBlobs();
  const events: SequencerEvent[] = [];
  const { seq } = await world(d0, { blobs, onEvent: (e) => events.push(e) });
  const writer = fakeConn("writer/1");
  for (let i = 0; i < n; i++) assert.equal(verdict(await push(seq, writer, d0, [set(`c${i % 2}`, "name", `v${i}`)])), "ack");
  for (const at of [64, 128]) if (at <= n) await seq.handle(writer, { type: "keyframe", branchId: BRANCH, keyframe: { seq: at, stateHash: HASH(String(at % 10)), doc: d0 as never } });
  return { seq, blobs, events, d0 };
}
const drop = (blobs: ReturnType<typeof memoryBlobs>, prefix: string) => {
  const gone = [...blobs.map.keys()].filter((k) => k.startsWith(prefix));
  for (const k of gone) blobs.map.delete(k);
  return gone;
};

/** Hello from `have`, paging while `more`: every welcome, or the first error. */
async function catchUp(seq: Awaited<ReturnType<typeof history>>["seq"], conn: FakeConn, have: number) {
  const welcomes: sync.WelcomeMsg[] = [];
  for (let i = 0; i < 50; i++) {
    conn.inbox.length = 0;
    await seq.handle(conn, { type: "hello", branchId: BRANCH, have, pending: [], rids: [], schemaVersion: 1 });
    const err = conn.inbox.find((m) => m.type === "error") as sync.ErrorMsg | undefined;
    if (err) return { welcomes, error: err };
    const w = conn.inbox.find((m) => m.type === "hello") as sync.WelcomeMsg;
    assert.ok(w, `a welcome or an error for have ${have}`);
    welcomes.push(w);
    have = w.rows.length ? w.rows[w.rows.length - 1]!.seq : (w.keyframe?.seq ?? have);
    if (!w.more) return { welcomes, error: null, have };
  }
  throw new Error("no progress");
}

test("every keyframe's blob gone: a replica holding the cut's start catches up by rows, and the miss is counted", async () => {
  const { seq, blobs, events } = await history(130);
  assert.equal(drop(blobs, "keyframes/").length, 3, "the root keyframe and the two periodic ones");
  // 130 behind (more than K = 100): a keyframe catch-up, but none can be read
  const r = await catchUp(seq, fakeConn("joiner/1"), 0);
  assert.equal(r.error, null, `no error: ${r.error?.reason}`);
  const rows = r.welcomes.flatMap((w) => w.rows);
  assert.deepEqual(rows.map((x) => x.seq), Array.from({ length: 130 }, (_, i) => i + 1), "every row, in order");
  assert.ok(r.welcomes.every((w) => !w.keyframe), "no keyframe sent");
  assert.ok(seq.stats.missingBlobs >= 2, `the misses are counted (${seq.stats.missingBlobs})`);
  assert.ok(events.some((e) => e.type === "missingBlob" && e.key.startsWith("keyframes/")), "and told");
});

test("the newest keyframe's blob gone: a joiner from nothing gets the next older keyframe", async () => {
  const { seq, blobs } = await history(130);
  assert.equal(drop(blobs, "keyframes/main-0000-0000/128/").length, 1);
  const r = await catchUp(seq, fakeConn("joiner/1"), -1);
  assert.equal(r.error, null, `no error: ${r.error?.reason}`);
  assert.equal(r.welcomes[0]!.keyframe?.seq, 64, "the keyframe at 64");
  assert.deepEqual(r.welcomes.flatMap((w) => w.rows).map((x) => x.seq), Array.from({ length: 66 }, (_, i) => i + 65), "then rows 65..130");
});

test("a joiner from nothing and every keyframe's blob gone: refused as history-missing, in people's words", async () => {
  const { seq, blobs } = await history(130);
  drop(blobs, "keyframes/");
  const r = await catchUp(seq, fakeConn("joiner/1"), -1);
  assert.ok(r.error, "an error, not a welcome");
  assert.equal(r.error.code, "history-missing");
  assert.match(r.error.reason, /history can't be loaded/);
  assert.doesNotMatch(r.error.reason, /internal|keyframes\/|blob/, "no internal words or blob keys");
  // fewer than K behind with the root keyframe gone: the same (it has no state at all to extend)
  const { seq: s2, blobs: b2 } = await history(10);
  drop(b2, "keyframes/");
  const r2 = await catchUp(s2, fakeConn("joiner/2"), -1);
  assert.equal(r2.error?.code, "history-missing");
});

test("archived rows whose segment is gone: a catch-up that needs them is refused as history-missing; a history request is answered", async () => {
  const { seq, blobs } = await history(130);
  assert.equal(await seq.archive(BRANCH, { keep: 20, segmentRows: 50 }), 100, "rows 1..100 in two segments");
  drop(blobs, "keyframes/");
  assert.equal(drop(blobs, "segments/").length, 2);
  const r = await catchUp(seq, fakeConn("joiner/1"), 0);
  assert.equal(r.error?.code, "history-missing", `refused: ${JSON.stringify(r.error)}`);
  // a replica past the archive still catches up (live rows only)
  const r2 = await catchUp(seq, fakeConn("joiner/2"), 110);
  assert.equal(r2.error, null);
  assert.deepEqual(r2.welcomes.flatMap((w) => w.rows).map((x) => x.seq), Array.from({ length: 20 }, (_, i) => i + 111));
  // a history request for the archived rows gets its own answer (an error), so it doesn't wait
  const h = fakeConn("joiner/3");
  await seq.handle(h, { type: "hello", branchId: BRANCH, have: 130, pending: [], rids: [], schemaVersion: 1 });
  h.inbox.length = 0;
  await seq.handle(h, { type: "history", branchId: BRANCH, req: 7, after: 0, upTo: 50 } as sync.ClientMessage);
  const reply = h.inbox.find((m) => m.type === "history") as sync.HistoryReplyMsg | undefined;
  assert.ok(reply, `a history reply: ${JSON.stringify(h.inbox)}`);
  assert.equal(reply.req, 7);
  assert.match(String(reply.error), /history can't be loaded/);
});
