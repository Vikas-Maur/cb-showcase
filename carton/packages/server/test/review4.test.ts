// Regression tests for review rounds 4 and 5 on the sequencer: a store without getStream is read in bounded ranges, and
// a welcome's confirmed-id list counts against its page and is paged (inside one base too) when it doesn't fit.
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

/** Follow a hello's continuations as a client does (claims from `uncheckedFrom`, after `checkedThrough`) to the end. */
async function helloPages(seq: Awaited<ReturnType<typeof world>>["seq"], j: ReturnType<typeof fakeConn>, claims: sync.PendingClaim[]) {
  const pages: sync.WelcomeMsg[] = [];
  let from = -1, after: number | undefined;
  for (let i = 0; i < 200; i++) {
    j.inbox.length = 0;
    const pending = claims.map((c) => ({ id: c.id, bases: c.bases.filter((b) => b >= from) })).filter((c) => c.bases.length);
    await seq.handle(j, hello(0, { pending, ...(after !== undefined ? { claimsAfter: after } : {}) }));
    const p = j.last("hello")!;
    pages.push(p);
    if (p.uncheckedFrom === undefined) return pages;
    from = p.uncheckedFrom;
    after = p.checkedThrough;
  }
  throw new Error("no end");
}

test("a welcome's confirmed-id list counts against its page, and pages on when it doesn't fit (round 4, outside its range)", async () => {
  const { seq } = await world(d0, { catchupBytes: 8 * KiB });
  const x = fakeConn("x/1");
  const ids: string[] = [];
  for (let i = 1; i <= 120; i++) {
    const id = `${"x".repeat(40)}.${i}`;
    ids.push(id);
    assert.equal(verdict(await push(seq, x, d0, [set(`c${i % 2}`, "name", `n${i}`)], { id })), "ack");
  }
  // a replica that holds nothing and claims every id, each pushed on its own base
  const pages = await helloPages(seq, fakeConn("x/1"), ids.map((id, i) => ({ id, bases: [i] })));
  assert.ok(pages.length > 1, `${pages.length} pages`);
  for (const p of pages) assert.ok(utf8(p) <= 8 * KiB + Math.max(0, ...p.rows.map(utf8)), `${utf8(p)} bytes with ${p.rows.length} rows and ${p.confirmed.length} ids`);
  assert.deepEqual(pages.flatMap((p) => p.confirmed.map((e) => e.id)), ids, "every id once, in order");
  assert.ok(pages.slice(0, -1).every((p) => !p.rows.length), "rows only once the list is complete");
});

test("round 5 finding 2: 101 ids confirmed on one base, a list over the page alone, are paged inside the base", async () => {
  const budget = 4096;
  const { seq } = await world(d0, { catchupBytes: budget });
  const w = fakeConn("w/3");
  const ids: string[] = [];
  for (let i = 0; i < 101; i++) {
    const id = `0123456789abcdef01234567.${i}`;
    ids.push(id);
    assert.equal(verdict(await push(seq, w, d0, [set("c0", "name", String(i))], { id, base: { seq: 0, pending: ids.slice(0, -1) } })), "ack");
  }
  const pages = await helloPages(seq, fakeConn("w/3"), ids.map((id) => ({ id, bases: [0] })));
  assert.ok(pages.length > 2, `${pages.length} pages`);
  for (const p of pages) assert.ok(utf8(p) <= budget + Math.max(0, ...p.rows.map(utf8)), `${utf8(p)} bytes`);
  assert.deepEqual(pages.flatMap((p) => p.confirmed.map((e) => e.id)), ids, "every id once, in order");
  assert.ok(pages.slice(0, -1).every((p) => p.checkedThrough !== undefined && p.uncheckedFrom === 0));
});
