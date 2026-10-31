import assert from "node:assert/strict";
import { test } from "node:test";
import { bytesSource, hashSource } from "../src/hash.ts";
import type { Manifest } from "../src/manifest.ts";
import { nodeHasher } from "../src/node/node-hasher.ts";
import { HashScheduler, MemoryManifestCache, type HashJobOptions, type HashTarget } from "../src/scheduler.ts";
import { xorshiftBytes } from "./helpers.ts";

/** A fake hasher whose jobs finish when the test says so. */
function harness() {
  const started: { t: HashTarget; o: HashJobOptions; finish: () => void }[] = [];
  const hash = (t: HashTarget, o: HashJobOptions) =>
    new Promise<Manifest>((resolve, reject) => {
      const finish = () => hashSource(bytesSource(xorshiftBytes(t.size, t.key.length)), nodeHasher).then(resolve, reject);
      o.signal.addEventListener("abort", () => reject(o.signal.reason), { once: true });
      started.push({ t, o, finish });
    });
  return { started, hash };
}
const tick = () => new Promise((r) => setTimeout(r, 5));
const T = (key: string, size = 10): HashTarget => ({ key, size, mtimeMs: 1 });

test("nothing is hashed until asked; one file at a time; shares go before background work", async () => {
  const h = harness();
  const sched = new HashScheduler({ hash: h.hash, hasher: nodeHasher });
  await tick();
  assert.equal(h.started.length, 0);
  const bg = sched.request(T("a"), "background");
  const bg2 = sched.request(T("b"), "background");
  const share = sched.request(T("c"), "share");
  await tick();
  assert.deepEqual(h.started.map((s) => s.t.key), ["a"]);
  h.started[0].finish();
  await bg;
  await tick();
  assert.deepEqual(h.started.map((s) => s.t.key), ["a", "c"], "the share jumps the queue");
  h.started[1].finish();
  await share;
  await tick();
  h.started[2].finish();
  await bg2;
});

test("the same file asked twice is hashed once, and an unchanged file is never hashed again", async () => {
  const h = harness();
  const cache = new MemoryManifestCache();
  const sched = new HashScheduler({ hash: h.hash, hasher: nodeHasher, cache });
  const p1 = sched.request(T("x"));
  const p2 = sched.request(T("x"));
  await tick();
  h.started[0].finish();
  const [m1, m2] = await Promise.all([p1, p2]);
  assert.equal(m1, m2);
  assert.equal(h.started.length, 1);
  const again = new HashScheduler({ hash: h.hash, hasher: nodeHasher, cache });
  assert.equal((await again.request(T("x"))).hash, m1.hash);
  assert.equal(h.started.length, 1, "served from the manifest cache");
  const changed = again.request({ ...T("x"), mtimeMs: 2 });
  await tick();
  assert.equal(h.started.length, 2, "a new mtime is hashed again");
  h.started[1].finish();
  await changed;
});

test("pause stops background work (it runs again on resume) but not a share", async () => {
  const h = harness();
  const sched = new HashScheduler({ hash: h.hash, hasher: nodeHasher, concurrency: 2 });
  const bg = sched.request(T("bg"), "background");
  const share = sched.request(T("share"), "share");
  await tick();
  assert.equal(h.started.length, 2);
  sched.pause();
  await tick();
  assert.equal(h.started[0].o.signal.aborted, true);
  assert.equal(h.started[1].o.signal.aborted, false);
  h.started[1].finish();
  await share;
  await tick();
  assert.equal(h.started.length, 2, "paused: background work waits");
  sched.resume();
  await tick();
  assert.equal(h.started.length, 3);
  h.started[2].finish();
  assert.equal((await bg).size, 10);
});

test("asking for a background file with share priority promotes it, even while paused", async () => {
  const h = harness();
  const sched = new HashScheduler({ hash: h.hash, hasher: nodeHasher });
  sched.pause();
  const bg = sched.request(T("p"), "background");
  await tick();
  assert.equal(h.started.length, 0);
  const share = sched.request(T("p"), "share");
  await tick();
  assert.equal(h.started.length, 1);
  h.started[0].finish();
  assert.equal(await bg, await share);
});

test("cancel drops a queued request and stops a running one once nobody waits", async () => {
  const h = harness();
  const sched = new HashScheduler({ hash: h.hash, hasher: nodeHasher });
  const running = sched.request(T("r"));
  const queued = sched.request(T("q"));
  await tick();
  sched.cancel(T("q"));
  await assert.rejects(queued, { name: "AbortError" });
  sched.cancel(T("r"));
  await assert.rejects(running, { name: "AbortError" });
  assert.equal(sched.pending, 0);
});
