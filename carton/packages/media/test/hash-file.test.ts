import assert from "node:assert/strict";
import { appendFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";
import { bytesSource, hashSource } from "../src/hash.ts";
import { LEAF_SIZE } from "../src/manifest.ts";
import { fileSource } from "../src/node/file-source.ts";
import { closeHashWorkers, hashFile, warmHashWorkers } from "../src/node/hash-file.ts";
import { nodeHasher } from "../src/node/node-hasher.ts";
import { SourceChangedError } from "../src/upload.ts";
import { scratchDir, xorshiftBytes } from "./helpers.ts";

const MiB = LEAF_SIZE;
const s = scratchDir("hash-file");
after(() => {
  closeHashWorkers();
  s.cleanup();
});

test("hashFile gives the same ids as hashSource, in the calling thread and in 1 or 3 workers", async () => {
  for (const [size, seed] of [[0, 1], [5, 2], [MiB, 3], [8 * MiB + 1, 4], [32 * MiB, 5], [41 * MiB + 99, 6]] as const) {
    const data = xorshiftBytes(size, seed);
    const path = join(s.dir, `f${size}`);
    writeFileSync(path, data);
    const want = (await hashSource(bytesSource(data), nodeHasher)).hash;
    for (const workers of [1, 3]) {
      let last = -1;
      const m = await hashFile(path, { workers, onProgress: (b) => (last = b) });
      assert.equal(m.hash, want, `${size} bytes, ${workers} workers`);
      assert.equal(last, size);
    }
  }
});

test("a file that changes while it is hashed is refused", async () => {
  for (const size of [3 * MiB, 40 * MiB]) {
    const path = join(s.dir, `changing${size}`);
    writeFileSync(path, xorshiftBytes(size, 7));
    await assert.rejects(hashFile(path, { onProgress: (b) => b === size && appendFileSync(path, "x") }), SourceChangedError);
  }
});

test("abort stops hashing", async () => {
  const path = join(s.dir, "abort");
  writeFileSync(path, xorshiftBytes(40 * MiB, 8));
  const ac = new AbortController();
  ac.abort();
  await assert.rejects(hashFile(path, { signal: ac.signal }), { name: "AbortError" });
  const ac2 = new AbortController();
  const p = hashFile(path, { signal: ac2.signal });
  ac2.abort();
  await assert.rejects(p, { name: "AbortError" });
  // The pool still works afterwards.
  assert.equal((await hashFile(path)).size, 40 * MiB);
});

test("fileSource reads ranges and reports short reads at the end", async () => {
  const data = xorshiftBytes(3 * MiB + 3, 9);
  const path = join(s.dir, "src");
  writeFileSync(path, data);
  const src = await fileSource(path);
  try {
    assert.equal(src.size, data.length);
    assert.deepEqual(await src.read(MiB - 1, 4), data.subarray(MiB - 1, MiB + 3));
    assert.equal((await src.read(data.length - 2, 10)).length, 2);
  } finally {
    await src.close();
  }
});

test("closing the workers fails a running hash instead of leaving it pending (review round 1, finding 7)", async (t) => {
  const path = join(s.dir, "closing");
  writeFileSync(path, xorshiftBytes(160 * MiB, 11));
  // Close while the job is in a worker: the pool's progress timer reporting less than the whole file proves that. On a
  // starved box the timer can come late, after the hash finished; then try again rather than accept a success.
  for (let attempt = 0; attempt < 5; attempt++) {
    let ticks = 0;
    let running!: () => void;
    const started = new Promise<"running">((r) => (running = () => r("running")));
    const p = hashFile(path, { workers: 1, onProgress: (b) => (ticks++, b < 160 * MiB && running()) });
    const first = await Promise.race([started, p.then(() => "finished" as const)]);
    if (first === "finished") continue;
    closeHashWorkers();
    const settled = await Promise.race([p.then(() => "resolved", () => "rejected"), new Promise((r) => setTimeout(() => r("pending"), 5000))]);
    assert.equal(settled, "rejected", "a hash running when its workers close fails");
    const before = ticks;
    await new Promise((r) => setTimeout(r, 250));
    assert.equal(ticks, before, "its progress timer stopped too");
    assert.equal((await hashFile(path)).size, 160 * MiB, "a new pool starts on the next hash");
    return;
  }
  t.skip("the hash always finished before the progress timer fired; the box is too starved to catch it running");
});

test("an old worker's exit doesn't fail a job started after the pool went idle (review round 2, finding 3)", async () => {
  const path = join(s.dir, "after-idle");
  writeFileSync(path, xorshiftBytes(40 * MiB, 12));
  // The pool closes its idle workers after 5 ms; their exit events land a little later, maybe after the next job
  // started on fresh workers of the same pool. Start that job at several moments around the close.
  for (const wait of [3, 5, 6, 7, 8, 10, 12, 15]) {
    warmHashWorkers(2, 5);
    await new Promise((r) => setTimeout(r, wait));
    const r = await Promise.allSettled([hashFile(path, { workers: 2 })]);
    assert.equal(r[0].status, "fulfilled", `job started ${wait} ms after warming: ${(r[0] as PromiseRejectedResult).reason}`);
  }
  warmHashWorkers(1, 30_000);
});
