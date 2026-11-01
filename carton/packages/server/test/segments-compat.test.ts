// Archived segments written before §18's compression (plain JSON, `segments/<branch>/<hi>`) still read: a store
// archived by an older build keeps serving catch-up. (Contract commit by hosts-plugins.)
import test from "node:test";
import assert from "node:assert/strict";
import { world, fakeConn, push, memoryBlobs, sqliteStorage, BRANCH, clip, doc, set } from "./helpers.ts";
import type { sync } from "@carton/core";

const hello = (have: number): sync.HelloMsg => ({ type: "hello", branchId: BRANCH, have, pending: [], rids: [], schemaVersion: 1 });

test("a plain-JSON segment from before compression still serves catch-up, beside gzip ones", async () => {
  const blobs = memoryBlobs();
  const storage = sqliteStorage();
  const { seq, d0 } = await world(doc([clip("c0", 0, 5), clip("c1", 5, 10)]), { blobs, storage, catchupLimit: 1000 });
  const a = fakeConn("alice/k1");
  for (let i = 0; i < 300; i++) await push(seq, a, d0, [set(`c${i % 2}`, "name", `n${i}`)]);
  assert.equal(await seq.archive(BRANCH, { keep: 50, segmentRows: 100 }), 200);
  // rewrite the first segment as an older build stored it: plain JSON under a key without .gz
  const [first] = storage.exec<{ blob: string }>("SELECT blob FROM segments WHERE branch = ? ORDER BY hi LIMIT 1", BRANCH);
  const gz = blobs.map.get(first!.blob)!;
  const plain = new Uint8Array(await new Response(new Blob([gz as Uint8Array<ArrayBuffer>]).stream().pipeThrough(new DecompressionStream("gzip"))).arrayBuffer());
  const oldKey = first!.blob.replace(/\.json\.gz$/, "");
  blobs.map.set(oldKey, plain);
  blobs.map.delete(first!.blob);
  storage.exec("UPDATE segments SET blob = ? WHERE branch = ? AND blob = ?", oldKey, BRANCH, first!.blob);
  const b = fakeConn("bob/k2");
  await seq.handle(b, hello(0));
  const rows = b.last("hello")!.rows;
  assert.deepEqual(rows.map((r) => r.seq), Array.from({ length: 300 }, (_, i) => i + 1));
  assert.equal((rows[0]!.ops[0] as { value: string }).value, "n0");
});
