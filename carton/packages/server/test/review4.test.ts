// Regression tests for review round 4's findings on the sequencer: a store without getStream is read in bounded ranges,
// and a welcome's confirmed-id list counts against its page.
import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import type { sync } from "@carton/core";
import { BRANCH, clip, doc, fakeConn, memoryBlobs, push, set, verdict, world } from "./helpers.ts";

const KiB = 1024;
const utf8 = (v: unknown) => Buffer.byteLength(JSON.stringify(v));
const d0 = doc([clip("c0", 0, 5), clip("c1", 5, 10)]);
const hello = (have: number, o: Partial<sync.HelloMsg> = {}): sync.HelloMsg => ({ type: "hello", branchId: BRANCH, have, pending: [], rids: [], schemaVersion: 1, ...o });

test("round 4 finding 3: a store without getStream is read in bounded ranges, never a whole segment, and pages through it all", async () => {
  const blobs = memoryBlobs();
  delete (blobs as { getStream?: unknown }).getStream;
  const { seq } = await world(d0, { blobs, catchupBytes: 64 * KiB });
  const w = fakeConn("writer/1");
  for (let i = 0; i < 900; i++) assert.equal(verdict(await push(seq, w, d0, [set(`c${i % 2}`, "name", randomBytes(1024).toString("hex"))])), "ack");
  assert.equal(await seq.archive(BRANCH, { keep: 10, segmentRows: 890 }), 890);
  const segment = [...blobs.map].find(([k]) => k.startsWith("segments/"))!;
  blobs.read = 0;
  blobs.maxGet = 0;
  const j = fakeConn("joiner/1");
  await seq.handle(j, hello(0));
  assert.ok(j.last("hello")!.more);
  assert.ok(blobs.maxGet <= 64 * KiB, `one get returned ${blobs.maxGet} bytes`);
  assert.ok(blobs.read < segment[1].length / 6, `read ${blobs.read} of the segment's ${segment[1].length} bytes`);
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

test("a welcome's confirmed-id list counts against its page (round 4, outside its range)", async () => {
  const { seq } = await world(d0, { catchupBytes: 8 * KiB });
  const x = fakeConn("x/1");
  const ids: string[] = [];
  for (let i = 1; i <= 120; i++) {
    const id = `${"x".repeat(40)}.${i}`;
    ids.push(id);
    assert.equal(verdict(await push(seq, x, d0, [set(`c${i % 2}`, "name", `n${i}`)], { id })), "ack");
  }
  // a replica that holds nothing and claims every id, each pushed on base 0
  const j = fakeConn("x/1");
  await seq.handle(j, hello(0, { pending: ids.map((id) => ({ id, bases: [0] })) }));
  const page = j.last("hello")!;
  assert.ok(page.confirmed.length > 50, `${page.confirmed.length} ids listed`);
  const biggest = Math.max(0, ...page.rows.map(utf8));
  assert.ok(utf8(page) <= 8 * KiB + biggest, `${utf8(page)} bytes with ${page.rows.length} rows and the list`);
});
