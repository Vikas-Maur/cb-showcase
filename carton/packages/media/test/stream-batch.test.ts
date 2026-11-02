// Batched publishing and reading of a proxy stream (cf-proxy-path), against fakes of a host's two stream routes: the
// writer's queue (batches form while one uploads, back-pressure, failures, the fallback to part by part), and the
// reader's batches (bytes that don't verify are read again the usual way; what was played replays from the cache).
// The real routes are tested in @carton/host-http (streams.test.ts).
import assert from "node:assert/strict";
import { test } from "node:test";
import { MemoryLeafCache } from "../src/cache.ts";
import { mediaKey, streamEndKey, streamInitKey, streamSegmentKey } from "../src/keys.ts";
import { nodeHasher } from "../src/node/node-hasher.ts";
import { MediaReader } from "../src/read.ts";
import {
  ProxyStreamReader,
  ProxyStreamWriter,
  StreamPartMissingError,
  StreamRouteMissingError,
  toBase64,
  type StreamAppendBatch,
  type StreamReadItem,
  type StreamReadOptions,
} from "../src/stream.ts";
import { CountingMemoryStore } from "../src/testing.ts";
import { xorshiftBytes } from "./helpers.ts";

const KiB = 1024;
const seg = (i: number) => xorshiftBytes(100 * KiB + i * 7, 200 + i);
const INIT = xorshiftBytes(700, 9);
const enc = new TextEncoder();

/** A store with a fake append route: it writes media's layout, as the host does, after `gate` lets it. */
class AppendingStore extends CountingMemoryStore {
  readonly batches: StreamAppendBatch[] = [];
  gate: () => Promise<void> = async () => {};
  fail: unknown = null;
  async appendStream(stream: string, batch: StreamAppendBatch): Promise<void> {
    this.batches.push(batch);
    await this.gate();
    if (this.fail) throw this.fail;
    for (const p of batch.parts) {
      if (p.bytes) await this.put(mediaKey(p.hash), p.bytes);
      else if (!this.objects.has(mediaKey(p.hash))) throw new StreamPartMissingError("gone");
      await this.put(`mf/${p.hash}`, p.manifest);
      const entry = p.kind === "init" ? { hash: p.hash, size: p.size, manifest: toBase64(p.manifest) } : { hash: p.hash, size: p.size, index: p.index, durationSec: p.durationSec, at: p.at, manifest: toBase64(p.manifest) };
      await this.put(p.kind === "init" ? streamInitKey(stream) : streamSegmentKey(stream, p.index!), enc.encode(JSON.stringify(entry)), { ifAbsent: true });
    }
    if (batch.end) await this.put(streamEndKey(stream), enc.encode(JSON.stringify(batch.end)), { ifAbsent: true });
  }
}

function gated() {
  const waits: (() => void)[] = [];
  return {
    gate: () => new Promise<void>((r) => waits.push(r)),
    release: () => {
      for (const w of waits.splice(0)) w();
    },
    pending: () => waits.length,
  };
}

const reader = (store: CountingMemoryStore, id: string, cache = new MemoryLeafCache()) =>
  new ProxyStreamReader({ store, media: new MediaReader({ store, hasher: nodeHasher, cache }), id, pollMs: 5, maxPollMs: 20 });

async function indexes(r: ProxyStreamReader): Promise<number[]> {
  const out: number[] = [];
  for await (const p of r.play()) if (p.part === "segment") out.push(p.segment.index);
  return out;
}

test("while one batch uploads, the next segments queue, and go in the next request together, with the end", async () => {
  const store = new AppendingStore();
  const g = gated();
  store.gate = g.gate;
  const w = new ProxyStreamWriter({ store, hasher: nodeHasher });
  await w.init(INIT); // held for the first segment: a viewer needs both
  assert.equal(store.batches.length, 0, "the init alone waits");
  for (let i = 0; i < 5; i++) await w.segment(seg(i), 2); // the first request starts with segment 0, a second with 1; the rest queue
  assert.equal(store.batches.length, 2, "two requests under way");
  assert.equal(w.segments, 0, "nothing published yet");
  const ending = w.end();
  while (store.batches.length < 2 || g.pending()) {
    g.release();
    await new Promise((r) => setTimeout(r, 1));
  }
  await ending;
  assert.deepEqual(store.batches.map((b) => b.parts.map((p) => p.kind === "init" ? "i" : p.index)), [["i", 0], [1], [2, 3, 4]]);
  assert.ok(!store.batches[0]!.end && !store.batches[1]!.end && store.batches[2]!.end, "the end rides with the last parts, once nothing else is under way");
  assert.equal(w.segments, 5);
  assert.deepEqual(await indexes(reader(store, w.id)), [0, 1, 2, 3, 4]);
});

test("batches stay under their limits; past the queue limit segment() waits for the uploads (the encoder's back-pressure)", async () => {
  const store = new AppendingStore();
  const g = gated();
  store.gate = g.gate;
  const w = new ProxyStreamWriter({ store, hasher: nodeHasher, batch: { maxParts: 2, maxBytes: 1 << 20, maxQueuedBytes: 250 * KiB } });
  await w.init(INIT);
  await w.segment(seg(0), 2);
  await w.segment(seg(1), 2);
  let third = false;
  const p = w.segment(seg(2), 2).then(() => (third = true));
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(third, false, "over the queue limit: waits");
  g.release();
  await new Promise((r) => setTimeout(r, 5));
  g.release();
  await p;
  const ending = w.end();
  for (let i = 0; i < 10; i++) {
    g.release();
    await new Promise((r) => setTimeout(r, 2));
  }
  await ending;
  for (const b of store.batches) assert.ok(b.parts.length <= 2);
  assert.deepEqual(await indexes(reader(store, w.id)), [0, 1, 2]);
});

test("a batch that fails for good fails the next call; one that fails on the network is retried", async () => {
  const store = new AppendingStore();
  let flaky = 2;
  store.gate = async () => {
    if (flaky-- > 0) throw new Error("fetch failed");
  };
  const w = new ProxyStreamWriter({ store, hasher: nodeHasher, upload: { retryDelayMs: 1 } });
  await w.init(INIT);
  await w.segment(seg(0), 2);
  await w.flush();
  assert.equal(w.segments, 1, "two network failures, then in");
  store.gate = async () => {};
  store.fail = Object.assign(new Error("read-only role"), { status: 403 });
  const before = store.batches.length;
  await w.segment(seg(1), 2);
  await assert.rejects(w.flush(), /read-only role/);
  assert.equal(store.batches.length, before + 1, "a refusal isn't retried");
  await assert.rejects(w.segment(seg(2), 2), /read-only role/);
  await assert.rejects(w.end(), /read-only role/);
});

test("a host without the route: what is queued, and the rest, go part by part; the store remembers", async () => {
  const store = new AppendingStore();
  store.fail = new StreamRouteMissingError("old host");
  const w = new ProxyStreamWriter({ store, hasher: nodeHasher });
  await w.init(INIT);
  for (let i = 0; i < 3; i++) await w.segment(seg(i), 2);
  await w.end();
  assert.equal(store.batches.length, 1, "asked once");
  assert.deepEqual(await indexes(reader(store, w.id)), [0, 1, 2]);
  const again = new ProxyStreamWriter({ store, hasher: nodeHasher });
  await again.init(INIT);
  await again.end();
  assert.equal(store.batches.length, 1, "a later writer through the same store doesn't ask again");
});

test("dedup: a stored part goes without its bytes, and with them if the host says it's gone", async () => {
  class WithHeads extends AppendingStore {
    async heads(keys: readonly string[]) {
      return Promise.all(keys.map(async (k) => {
        const h = await this.head(k);
        return h && { size: h.size };
      }));
    }
  }
  const store = new WithHeads();
  // segments 0-2 stored already (an earlier stream of the same encode, taken over), segment 3 not
  const w0 = new ProxyStreamWriter({ store, hasher: nodeHasher, batch: false });
  await w0.init(INIT);
  for (let i = 0; i < 3; i++) await w0.segment(seg(i), 2);
  const g = gated();
  store.gate = g.gate;
  const w = new ProxyStreamWriter({ store, hasher: nodeHasher });
  await w.init(INIT);
  for (let i = 0; i < 4; i++) await w.segment(seg(i), 2); // the first frame's batch goes; the rest queue behind it
  const ending = w.end();
  while (g.pending() || store.batches.length < 2) {
    g.release();
    await new Promise((r) => setTimeout(r, 1));
  }
  g.release();
  await ending;
  const sent = store.batches.map((b) => b.parts.map((p) => [p.kind === "init" ? "i" : p.index, p.bytes !== null]));
  assert.deepEqual(sent[0], [["i", true], [0, true]], "the first frame's batch isn't probed: it waits for nothing");
  assert.deepEqual(sent.slice(1).flat(), [[1, false], [2, false], [3, true]], `then stored parts go without their bytes: ${JSON.stringify(sent)}`);
  assert.deepEqual(await indexes(reader(store, w.id)), [0, 1, 2, 3]);
});

/** A fake read route over a store: entries, manifests and bytes; `mangle` changes the bytes it sends. */
class BatchReadingStore extends CountingMemoryStore {
  calls: StreamReadOptions[] = [];
  mangle: (b: Uint8Array) => Uint8Array = (b) => b;
  missing = false;
  async *readStream(stream: string, o: StreamReadOptions): AsyncGenerator<StreamReadItem> {
    this.calls.push(o);
    if (this.missing) throw new StreamRouteMissingError("old host");
    const json = (k: string) => {
      const b = this.objects.get(k);
      return b ? JSON.parse(new TextDecoder().decode(b)) : null;
    };
    const mf = (h: string) => this.objects.get(`mf/${h}`) ?? null;
    if (o.init) {
      const v = json(streamInitKey(stream));
      if (!v) return yield { kind: "status", initMissing: true };
      yield { kind: "init", part: { hash: v.hash, size: v.size }, manifest: mf(v.hash), bytes: (o.maxBytes ?? 1) > 0 ? this.mangle(this.objects.get(mediaKey(v.hash))!) : null };
    }
    for (let i = o.from; ; i++) {
      const v = json(streamSegmentKey(stream, i));
      if (!v) return yield { kind: "status", end: json(streamEndKey(stream)) };
      yield { kind: "segment", segment: v, manifest: mf(v.hash), bytes: (o.maxBytes ?? 1) > 0 ? this.mangle(this.objects.get(mediaKey(v.hash))!) : null };
    }
  }
}

async function publish(store: CountingMemoryStore, n: number): Promise<string> {
  const w = new ProxyStreamWriter({ store, hasher: nodeHasher, batch: false });
  await w.init(INIT);
  for (let i = 0; i < n; i++) await w.segment(seg(i), 2);
  await w.end();
  return w.id;
}

test("bytes a batch brings that don't verify are read again the usual way (and the play goes on)", async () => {
  const store = new BatchReadingStore();
  const id = await publish(store, 3);
  store.mangle = (b) => {
    const c = b.slice();
    c[10] ^= 1;
    return c;
  };
  const events: string[] = [];
  const r = new ProxyStreamReader({ store, media: new MediaReader({ store, hasher: nodeHasher, onEvent: (e) => events.push(e.type) }), id, pollMs: 5 });
  const got: Uint8Array[] = [];
  for await (const p of r.play()) got.push(p.bytes);
  assert.deepEqual(got[0], INIT);
  for (let i = 0; i < 3; i++) assert.deepEqual(got[i + 1], seg(i));
  assert.ok(store.reads.some((x) => x.key.startsWith("m/")), "fetched from the store");
  assert.deepEqual(events, [], "the store's copy is sound: nothing to report");
});

test("a stream played through batches replays from the cache, the store gone", async () => {
  const store = new BatchReadingStore();
  const id = await publish(store, 3);
  const cache = new MemoryLeafCache();
  assert.deepEqual(await indexes(reader(store, id, cache)), [0, 1, 2]);
  const calls = store.calls.length;
  assert.ok(calls <= 2, `${calls} batch reads`);
  store.objects.clear();
  assert.deepEqual(await indexes(reader(store, id, cache)), [0, 1, 2]);
  assert.equal(store.calls.length, calls, "no request");
});

test("a host without the read route: the play goes on entry by entry", async () => {
  const store = new BatchReadingStore();
  const id = await publish(store, 2);
  store.missing = true;
  assert.deepEqual(await indexes(reader(store, id)), [0, 1]);
  const r = reader(store, id);
  assert.equal((await r.known()).length, 2);
});

test("a batch the host drops is sent again in smaller pieces, down to one part, and the stream comes out whole", async () => {
  const store = new AppendingStore();
  const sizes: number[] = [];
  store.gate = async () => {
    const n = store.batches[store.batches.length - 1]!.parts.length;
    sizes.push(n);
    if (n > 2) throw Object.assign(new Error("Worker exceeded CPU"), { status: 503 });
  };
  const g = gated();
  const w = new ProxyStreamWriter({ store, hasher: nodeHasher, upload: { retryDelayMs: 1 }, batch: { inFlight: 1 } });
  const first = g.gate;
  store.gate = async () => {
    await first(); // hold the first batch (the init) so the segments queue behind it
    store.gate = async () => {
      const n = store.batches[store.batches.length - 1]!.parts.length;
      sizes.push(n);
      if (n > 2) throw Object.assign(new Error("Worker exceeded CPU"), { status: 503 });
    };
  };
  await w.init(INIT);
  for (let i = 0; i < 8; i++) await w.segment(seg(i), 2);
  g.release();
  await w.end();
  assert.equal(sizes[0], 7, "the queued segments went together first");
  // a failed batch goes again in halves: never again as large as one that failed, and few failures in all
  const failed = sizes.filter((n) => n > 2);
  sizes.forEach((n, i) => assert.ok(!sizes.slice(0, i).some((m) => m > 2 && m <= n), `size ${n} after a failure at or below it: ${sizes}`));
  assert.ok(failed.length <= 4, `few failures: ${sizes}`);
  assert.deepEqual(await indexes(reader(store, w.id)), [0, 1, 2, 3, 4, 5, 6, 7]);
});

test("two batches under way: the second uploads while the first is written; one in flight when asked", async () => {
  const store = new AppendingStore();
  const opened: number[] = [];
  let open = 0;
  store.gate = async () => {
    opened.push(++open);
    await new Promise((r) => setTimeout(r, 15));
    open--;
  };
  const w = new ProxyStreamWriter({ store, hasher: nodeHasher });
  await w.init(INIT);
  for (let i = 0; i < 12; i++) await w.segment(seg(i), 2);
  await w.end();
  assert.equal(Math.max(...opened), 2, "two at once, never more");
  assert.ok(store.batches.at(-1)!.end, "the end last");
  assert.equal(store.batches.filter((b) => b.end).length, 1);
  assert.deepEqual(await indexes(reader(store, w.id)), Array.from({ length: 12 }, (_, i) => i));
  const one = new AppendingStore();
  const seen: number[] = [];
  let busy = 0;
  one.gate = async () => {
    seen.push(++busy);
    await new Promise((r) => setTimeout(r, 5));
    busy--;
  };
  const w1 = new ProxyStreamWriter({ store: one, hasher: nodeHasher, batch: { inFlight: 1 } });
  await w1.init(INIT);
  for (let i = 0; i < 6; i++) await w1.segment(seg(i), 2);
  await w1.end();
  assert.equal(Math.max(...seen), 1);
});
