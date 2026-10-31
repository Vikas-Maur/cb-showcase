// Regression tests for review round 3's findings on the sequencer: catch-up loads at most the budget plus one row
// (archived segments read as a stream, blob bodies fetched only while there is room), row sizes are never below the
// reply's, and a hand-off learns the message limit before it uploads.
import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import type { sync, Op } from "@carton/core";
import { BRANCH, clip, doc, fakeConn, memoryBlobs, push, set, verdict, world } from "./helpers.ts";

const KiB = 1024;
const utf8 = (v: unknown) => Buffer.byteLength(JSON.stringify(v));
const hello = (have: number, o: Partial<sync.HelloMsg> = {}): sync.HelloMsg => ({ type: "hello", branchId: BRANCH, have, pending: [], rids: [], schemaVersion: 1, ...o });
const d0 = doc([clip("c0", 0, 5), clip("c1", 5, 10)]);
const rename = (i: number, name: string): Op[] => [set(`c${i % 2}`, "name", name)];

test("round 3 finding 3: an archived page reads its segment as a stream and stops at the budget, never the whole segment", async () => {
  const blobs = memoryBlobs();
  const { seq } = await world(d0, { blobs, catchupBytes: 64 * KiB });
  const w = fakeConn("writer/1");
  // random text barely compresses, so the segment's compressed bytes track its rows
  for (let i = 0; i < 900; i++) assert.equal(verdict(await push(seq, w, d0, rename(i, randomBytes(1024).toString("hex")))), "ack");
  assert.equal(await seq.archive(BRANCH, { keep: 10, segmentRows: 890 }), 890, "rows 1..890 in one segment");
  const segment = [...blobs.map].find(([k]) => k.startsWith("segments/"))!;
  blobs.read = 0;
  const j = fakeConn("joiner/1");
  await seq.handle(j, hello(0));
  const page = j.last("hello")!;
  assert.ok(page.more && page.rows.length > 5 && page.rows.length < 60, `${page.rows.length} rows in a 64 KiB page`);
  assert.deepEqual(page.rows.map((r) => r.seq), page.rows.map((_, i) => i + 1));
  // what the page needs plus the stream pipeline's read-ahead (a few chunks, whatever the segment's size)
  assert.ok(blobs.read < segment[1].length / 6, `read ${blobs.read} of the segment's ${segment[1].length} compressed bytes`);
  // and the whole archive still pages through, every row once, in order
  const seqs: number[] = [];
  for (let have = 0, i = 0; i < 100; i++) {
    j.inbox.length = 0;
    await seq.handle(j, hello(have));
    const p = j.last("hello")!;
    seqs.push(...p.rows.map((r) => r.seq));
    have = seqs.at(-1) ?? have;
    if (!p.more) break;
  }
  assert.deepEqual(seqs, Array.from({ length: 900 }, (_, i) => i + 1));
});

test("round 3 finding 4: a page whose first row has a big body in the blob store fetches no other big body", async () => {
  const blobs = memoryBlobs();
  const { seq } = await world(d0, { blobs, catchupBytes: 4 * KiB, maxInlineBytes: 512 });
  const w = fakeConn("writer/2");
  for (let i = 0; i < 3; i++) assert.equal(verdict(await push(seq, w, d0, rename(i, `${i}:`.padEnd(20_000, "z")))), "ack");
  const get = blobs.get.bind(blobs);
  const bodies: string[] = [];
  blobs.get = (key, range) => (key.startsWith("changes/") && bodies.push(key), get(key, range));
  const j = fakeConn("joiner/2");
  await seq.handle(j, hello(0));
  const page = j.last("hello")!;
  assert.deepEqual([page.rows.length, page.more], [1, true]);
  assert.equal(bodies.length, 1, "only the returned row's body was fetched");
});

test("round 3 finding 5: row sizes count bytes (past a NUL) and escaping, so a page of rows with control characters stays within the budget plus one row, live and archived", async () => {
  for (const archived of [false, true]) {
    for (const pad of ["\u0000" + "x".repeat(2000), "\u0001".repeat(2000)]) {
      const blobs = memoryBlobs();
      const { seq } = await world(d0, { blobs, catchupBytes: 16 * KiB });
      const w = fakeConn("writer/3");
      for (let i = 1; i <= 12; i++) assert.equal(verdict(await push(seq, w, d0, rename(i, `n${i}`), { id: `ctl.${i}${pad}` })), "ack");
      if (archived) assert.ok((await seq.archive(BRANCH, { keep: 2, segmentRows: 10 })) > 0);
      const j = fakeConn("joiner/3");
      await seq.handle(j, hello(0));
      const page = j.last("hello")!;
      const biggest = Math.max(...page.rows.map(utf8));
      assert.ok(page.rows.length >= 1 && page.more, "it pages");
      assert.ok(utf8(page) <= 16 * KiB + biggest, `${archived ? "archived" : "live"} ${JSON.stringify(pad.slice(0, 2))}: ${utf8(page)} bytes for ${page.rows.length} rows`);
    }
  }
});

test("round 3 finding 6: the branchStatus answer tells a hand-off the largest message the server reads", async () => {
  const { seq } = await world(d0, { blobs: memoryBlobs(), maxEnvelopeBytes: 4096 });
  const c = fakeConn("alice/6");
  await seq.handle(c, { type: "branchStatus", branchId: "not-yet-shared" });
  assert.deepEqual([c.last("status")!.adopted, c.last("status")!.maxMessageBytes], [false, 4096]);
  const { seq: noBlobs } = await world(d0);
  const d = fakeConn("bob/6");
  await noBlobs.handle(d, { type: "branchStatus", branchId: "not-yet-shared" });
  assert.equal(d.last("status")!.maxMessageBytes, undefined, "no envelopes, no limit to tell");
});
