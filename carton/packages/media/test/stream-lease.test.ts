// A publisher's lease on its stream (cf-proxy-path): a share killed mid-way blocked a re-share for STALE_MS (10
// minutes): the re-share found the dead stream "live" and reused it, and the teammate's preview stalled (cf-verify2).
// The publisher now renews a lease while it publishes, and a share judges an unfinished stream by it, on its own clock:
// renewed is alive, three periods without a renewal is dead, and dead is taken over.
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";
import type { ProxyEncoder } from "../src/contracts.ts";
import { proxyPointerKey, streamLeaseKey } from "../src/keys.ts";
import { MediaReader } from "../src/read.ts";
import { claimProxyStream, findProxy, ProxyStreamReader, ProxyStreamWriter, type StreamAppendBatch } from "../src/stream.ts";
import { CountingMemoryStore } from "../src/testing.ts";
import { closeHashWorkers, hashFile } from "../src/node/hash-file.ts";
import { nodeHasher } from "../src/node/node-hasher.ts";
import { shareMedia, type Segmenter } from "../src/node/share.ts";
import { toMediaRecord } from "../src/tiers.ts";
import { COLLAB_PROXY_720P } from "../src/proxy.ts";
import { scratchDir, xorshiftBytes } from "./helpers.ts";

after(() => closeHashWorkers());
const lease = async (store: CountingMemoryStore, stream: string) => {
  const b = store.objects.get(streamLeaseKey(stream));
  return b ? (JSON.parse(new TextDecoder().decode(b)) as { n: number; at: number; every: number }) : null;
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const SRC = "ab".repeat(32);

test("a writer with a lease renews it while open, on its own when nothing else carries it, and stops when closed", async () => {
  const store = new CountingMemoryStore();
  const w = new ProxyStreamWriter({ store, hasher: nodeHasher, lease: { everyMs: 30 } });
  await sleep(10);
  const first = await lease(store, w.id);
  assert.ok(first && first.n >= 1 && first.every === 30, "renewed at once");
  await sleep(120);
  const later = (await lease(store, w.id))!;
  assert.ok(later.n >= first.n + 2, `renewed while open (${first.n} → ${later.n})`);
  w.close();
  await sleep(20);
  const closed = (await lease(store, w.id))!.n;
  await sleep(120);
  assert.equal((await lease(store, w.id))!.n, closed, "no renewal once closed");
});

test("through a host, the renewal rides on appends; alone, it goes as an append of no parts", async () => {
  class Appending extends CountingMemoryStore {
    readonly batches: StreamAppendBatch[] = [];
    async appendStream(stream: string, b: StreamAppendBatch) {
      this.batches.push(b);
      if (b.lease) await this.put(streamLeaseKey(stream), new TextEncoder().encode(JSON.stringify(b.lease)));
      return {};
    }
  }
  const store = new Appending();
  const w = new ProxyStreamWriter({ store, hasher: nodeHasher, lease: { everyMs: 40 } });
  await w.init(xorshiftBytes(500, 1));
  // segments a little apart, as an encoder makes them: renewals ride on the appends, none goes alone
  for (let i = 0; i < 6; i++) {
    await w.segment(xorshiftBytes(1000 + i, 2 + i), 2);
    await w.flush();
    await sleep(25);
  }
  const busy = store.batches.slice(1);
  assert.ok(busy.filter((b) => b.parts.length > 0 && b.lease).length >= 2, "appends carried renewals");
  assert.ok(busy.every((b) => b.parts.length > 0), "none alone while appends go");
  const before = store.batches.length;
  await sleep(150);
  const alone = store.batches.slice(before);
  assert.ok(alone.length >= 2 && alone.every((b) => b.parts.length === 0 && b.lease), "renewals on their own while idle");
  await w.end();
  const n = store.batches.length;
  await sleep(120);
  assert.equal(store.batches.length, n, "an ended stream needs no lease");
});

test("a claim finds a dead publisher's stream (its lease not renewed) and takes it over after three periods, not STALE_MS", async () => {
  const store = new CountingMemoryStore();
  const dead = await claimProxyStream(store, SRC, "p1", "libx264", { leaseEveryMs: 40 });
  assert.ok(dead.claimed);
  const w = new ProxyStreamWriter({ store, hasher: nodeHasher, id: (dead.pointer as { stream: string }).stream, lease: { everyMs: 40 } });
  await w.init(xorshiftBytes(500, 3));
  await w.segment(xorshiftBytes(1000, 4), 2);
  w.close(); // the publisher dies: no end, no more renewals
  const t0 = Date.now();
  const next = await claimProxyStream(store, SRC, "p1", "libx264", { leaseEveryMs: 40 }); // STALE_MS is 10 minutes
  const took = Date.now() - t0;
  assert.ok(next.claimed, "taken over");
  assert.notEqual((next.pointer as { stream: string }).stream, w.id);
  assert.ok(took >= 100 && took < 2000, `judged dead after three periods (${took} ms)`);
});

test("a claim finds a live publisher's stream (its lease renewed) and leaves it, within about a period", async () => {
  const store = new CountingMemoryStore();
  const live = await claimProxyStream(store, SRC, "p2", "libx264", { leaseEveryMs: 40 });
  const w = new ProxyStreamWriter({ store, hasher: nodeHasher, id: (live.pointer as { stream: string }).stream, lease: { everyMs: 40 } });
  await w.init(xorshiftBytes(500, 5));
  const t0 = Date.now();
  const other = await claimProxyStream(store, SRC, "p2", "libx264", { leaseEveryMs: 40 });
  assert.equal(other.claimed, false, "a teammate's live stream is reused");
  assert.equal((other.pointer as { stream: string }).stream, w.id);
  assert.ok(Date.now() - t0 < 1000);
  w.close();
});

test("a pointer from an older publisher (no lease) is judged as before: live until STALE_MS", async () => {
  const store = new CountingMemoryStore();
  const old = await claimProxyStream(store, SRC, "p3", "libx264");
  assert.equal((await findProxy(store, SRC, "p3")) && "leaseEveryMs" in (await findProxy(store, SRC, "p3"))!, false);
  const again = await claimProxyStream(store, SRC, "p3", "libx264", { leaseEveryMs: 40 });
  assert.equal(again.claimed, false, "within STALE_MS");
  assert.equal((again.pointer as { stream: string }).stream, (old.pointer as { stream: string }).stream);
  const later = await claimProxyStream(store, SRC, "p3", "libx264", { leaseEveryMs: 40, staleMs: 1, now: () => Date.now() + 5 });
  assert.ok(later.claimed, "past STALE_MS");
});

// the verifier's case, through shareMedia: a share killed mid-way, then shared again at once
const libx264Like: ProxyEncoder = { name: "libx264", hardware: false, probe: async () => true, encode: async () => ({ bytes: 0, durationMs: 0 }) };
function segmenter(segments: number, hang?: Promise<void>): Segmenter {
  return async (o) => {
    mkdirSync(o.dir, { recursive: true });
    const init = join(o.dir, "init.mp4");
    writeFileSync(init, xorshiftBytes(800, 7));
    await o.onInit(init);
    for (let i = 0; i < segments; i++) {
      const path = join(o.dir, `seg_${i}.m4s`);
      writeFileSync(path, xorshiftBytes(40_000 + i, 300 + i));
      await o.onSegment({ index: i, path, durationSec: 2 });
      if (hang && i === 1) await new Promise<void>((_, no) => o.signal?.addEventListener("abort", () => no(o.signal!.reason), { once: true }));
    }
    return { segments, durationSec: 2 * segments };
  };
}

test("a share killed mid-way, shared again at once: the dead stream is taken over in seconds and the new one comes out whole (cf-verify2)", async () => {
  const s = scratchDir("stream-lease");
  try {
    const original = join(s.dir, "take.mov");
    writeFileSync(original, xorshiftBytes(300_000, 42));
    const store = new CountingMemoryStore();
    const record = () => toMediaRecord({ id: "m1", kind: "video", fileName: "take.mov", size: 0, src: original });
    const common = { store, record: record(), local: { original }, policy: { originals: false }, encoders: [libx264Like], workDir: s.dir, leaseEveryMs: 50 } as const;
    // the first share dies after two segments (an app killed: no end, no damage report, its lease stops)
    const kill = new AbortController();
    let dead = "";
    const first = shareMedia({ ...common, signal: kill.signal, segmenter: segmenter(4, new Promise(() => {})), onEvent: (e) => { if (e.type === "proxy" && e.stream) dead = e.stream; } });
    first.catch(() => {});
    for (let i = 0; i < 100 && !(await store.get(`ps/${dead}/s/000001`).catch(() => null)); i++) await sleep(10);
    kill.abort(new Error("killed"));
    await assert.rejects(first);
    // shared again at once, with the product's STALE_MS (10 minutes)
    const t0 = Date.now();
    const again = await shareMedia({ ...common, segmenter: segmenter(3) });
    const took = Date.now() - t0;
    const stream = again.record.proxy?.stream;
    assert.ok(stream && stream !== dead, "a new stream, not the dead one");
    assert.ok(took < 5000, `taken over in ${took} ms`);
    assert.equal((await findProxy(store, (await hashFile(original)).hash, COLLAB_PROXY_720P.id) as { stream: string }).stream, stream, "the pointer names it");
    const r = new ProxyStreamReader({ store, media: new MediaReader({ store, hasher: nodeHasher }), id: stream! });
    let n = 0;
    for await (const p of r.play()) if (p.part === "segment") n++;
    assert.equal(n, 3, "the teammate's preview plays to its end");
    assert.ok(store.objects.has(proxyPointerKey((await hashFile(original)).hash, COLLAB_PROXY_720P.id)));
  } finally {
    s.cleanup();
  }
});
