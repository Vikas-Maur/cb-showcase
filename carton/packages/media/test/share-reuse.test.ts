// Reusing, taking over and repairing shared proxies (S5 review round, findings 4–8). No ffmpeg: a fake segmenter.
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { after, test } from "node:test";
import type { ProxyEncoder } from "../src/contracts.ts";
import { bytesSource, hashSource } from "../src/hash.ts";
import { damagedKey, mediaKey, proxyPointerKey, streamEndKey } from "../src/keys.ts";
import { COLLAB_PROXY_720P } from "../src/proxy.ts";
import { MediaReader } from "../src/read.ts";
import { claimProxyStream, ProxyStreamReader, ProxyStreamWriter } from "../src/stream.ts";
import { CountingMemoryStore } from "../src/testing.ts";
import { uploadMedia } from "../src/upload.ts";
import { closeHashWorkers } from "../src/node/hash-file.ts";
import { nodeHasher } from "../src/node/node-hasher.ts";
import { startRangeServer } from "../src/node/range-server.ts";
import { shareMedia, type Segmenter, type ShareMediaOptions } from "../src/node/share.ts";
import { scratchDir } from "./helpers.ts";

const s = scratchDir("share-reuse");
after(() => {
  closeHashWorkers();
  s.cleanup();
});
const ORIGINAL = new Uint8Array([10, 11, 12]);
const encoder: ProxyEncoder = { name: "libx264", hardware: false, probe: async () => true, encode: async () => assert.fail("whole-object encode") };
let runs = 0;
const segmenter: Segmenter = async (o) => {
  runs++;
  await mkdir(o.dir, { recursive: true });
  const init = join(o.dir, "init.mp4");
  const seg = join(o.dir, "seg.m4s");
  await writeFile(init, new Uint8Array([1, 2]));
  await writeFile(seg, new Uint8Array([3, 4, runs]));
  await o.onInit!(init);
  await o.onSegment!({ index: 0, path: seg, durationSec: 2 });
  return { segments: 1, durationSec: 2 };
};
const failing: Segmenter = async () => {
  throw new Error("encoder failed");
};
async function options(store: CountingMemoryStore): Promise<ShareMediaOptions> {
  const original = join(s.dir, "original.bin");
  await writeFile(original, ORIGINAL);
  return { store, record: { id: "clip", kind: "video", fileName: "original.bin", size: 3 }, local: { original }, policy: { originals: false }, encoders: [encoder], workDir: s.dir, segmenter };
}
const originalHash = async () => (await hashSource(bytesSource(ORIGINAL), nodeHasher)).hash;

test("a healthy shared proxy is reused on a machine that has no encoder (finding 4)", async () => {
  const store = new CountingMemoryStore();
  const o = await options(store);
  const first = await shareMedia(o);
  const again = await shareMedia({ ...o, encoders: [], segmenter: failing });
  assert.equal(again.record.proxy?.stream, first.record.proxy?.stream);
});

test("a share whose every encoder failed leaves no claim the next share would reuse (finding 5)", async () => {
  const store = new CountingMemoryStore();
  const o = await options(store);
  await assert.rejects(shareMedia({ ...o, segmenter: failing }), { name: "ProxyChainError" });
  const before = runs;
  const r = await shareMedia(o);
  assert.equal(runs, before + 1, "encoded this time");
  assert.ok(store.objects.has(streamEndKey(r.record.proxy!.stream!)));
});

test("re-sharing a record whose stream was abandoned takes it over (finding 6)", async () => {
  const store = new CountingMemoryStore();
  const o = await options(store);
  const src = await originalHash();
  const dead = "ab".repeat(32);
  await store.put(proxyPointerKey(src, COLLAB_PROXY_720P.id), new TextEncoder().encode(JSON.stringify({ stream: dead, encoder: "libx264", at: 0 })));
  const before = runs;
  const r = await shareMedia({ ...o, record: { ...o.record, hash: src, proxy: { stream: dead, profile: COLLAB_PROXY_720P.id, encoder: "libx264" } } });
  assert.equal(runs, before + 1);
  assert.notEqual(r.record.proxy?.stream, dead);
  assert.ok(store.objects.has(streamEndKey(r.record.proxy!.stream!)));
});

test("a whole-object proxy reported damaged is made and uploaded again (finding 7)", async () => {
  const store = new CountingMemoryStore();
  const o = await options(store);
  const bytes = new Uint8Array([99, 98]);
  const m = await hashSource(bytesSource(bytes), nodeHasher);
  await uploadMedia({ store, hasher: nodeHasher, manifest: m, source: bytesSource(bytes) });
  await store.put(proxyPointerKey(await originalHash(), COLLAB_PROXY_720P.id), new TextEncoder().encode(JSON.stringify({ hash: m.hash, size: m.size, encoder: "libx264" })));
  store.objects.get(mediaKey(m.hash))![0] ^= 255;
  await store.put(damagedKey(m.hash), new Uint8Array([1]));
  let encoded = false;
  const enc: ProxyEncoder = {
    name: "libx264",
    hardware: false,
    probe: async () => true,
    encode: async (_i, out) => {
      encoded = true;
      await writeFile((out as { path: string }).path, bytes);
      return { bytes: 2, durationMs: 1 };
    },
  };
  const r = await shareMedia({ ...o, proxyStreams: false, encoders: [enc] });
  assert.equal(encoded, true);
  assert.equal(r.record.proxy?.hash, m.hash);
  assert.equal(store.objects.has(damagedKey(m.hash)), false, "repaired");
  const ok = await new MediaReader({ store, hasher: nodeHasher }).readVerified(m.hash, 0, m.size);
  assert.deepEqual([...ok], [...bytes]);
});

test("a segment a tool found damaged gets the stream made again, by a fresh share and a re-share (finding 8; S5-7)", async () => {
  const store = new CountingMemoryStore();
  const o = await options(store);
  const first = await shareMedia(o);
  const id = first.record.proxy!.stream!;
  const media = new MediaReader({ store, hasher: nodeHasher, repairAttempts: 1 });
  const reader = new ProxyStreamReader({ store, media, id });
  const seg0 = (await reader.segment(0))!;
  store.objects.get(mediaKey(seg0.hash))![0] ^= 255;
  // A tool following the stream's playlist on the range server.
  const server = await startRangeServer({
    source: media.toolSource(),
    playlist: (_id, urlFor) => reader.playlist(urlFor),
    reportDamage: (_stream, hash) => reader.reportPartDamage(hash),
  });
  try {
    const list = await (await fetch(server.playlistUrl(id))).text();
    assert.equal((await fetch(list.split("\n").find((l) => l.includes(seg0.hash))!)).status, 502);
  } finally {
    await server.close();
  }
  assert.ok(store.objects.has(damagedKey(id)), "the stream is reported");
  const before = runs;
  const again = await shareMedia({ ...o, record: first.record });
  assert.equal(runs, before + 1);
  assert.notEqual(again.record.proxy?.stream, id);
  // And a teammate sharing the same footage now finds the new stream, not the damaged one.
  const c = await claimProxyStream(store, await originalHash(), COLLAB_PROXY_720P.id, "x");
  assert.equal(c.claimed, false);
  assert.equal((c.pointer as { stream: string }).stream, again.record.proxy?.stream);
});

test("a record whose proxy was replaced takes the replacement, in its own profile, with no encoder here (round 2, finding 1)", async () => {
  const store = new CountingMemoryStore();
  const o = await options(store);
  const src = await originalHash();
  const claim = await claimProxyStream(store, src, "other-profile", "libx264");
  const w = new ProxyStreamWriter({ store, hasher: nodeHasher, id: (claim.pointer as { stream: string }).stream });
  await w.init(new Uint8Array([1]));
  await w.end();
  const old = { stream: "ef".repeat(32), profile: "other-profile", encoder: "libx264" };
  const r = await shareMedia({ ...o, record: { ...o.record, hash: src, proxy: old }, encoders: [], segmenter: failing });
  assert.equal(r.record.proxy?.stream, w.id);
  assert.equal(r.record.proxy?.profile, "other-profile");
});

test("a teammate without the original also moves a record off a replaced stream (round 2, finding 2)", async () => {
  const store = new CountingMemoryStore();
  const o = await options(store);
  const src = "ab".repeat(32);
  const old = await claimProxyStream(store, src, COLLAB_PROXY_720P.id, "libx264", { now: () => 0 });
  const replacement = await claimProxyStream(store, src, COLLAB_PROXY_720P.id, "libx264");
  assert.equal(replacement.claimed, true);
  const w = new ProxyStreamWriter({ store, hasher: nodeHasher, id: (replacement.pointer as { stream: string }).stream });
  await w.init(new Uint8Array([1]));
  await w.end();
  const proxy = { stream: (old.pointer as { stream: string }).stream, profile: COLLAB_PROXY_720P.id, encoder: "libx264" };
  const r = await shareMedia({ ...o, record: { ...o.record, hash: src, proxy }, local: {}, encoders: [] });
  assert.equal(r.record.proxy?.stream, w.id);
});

test("a store that can't answer the proxy check doesn't block the rest of the share (round 2, finding 3)", async () => {
  const store = new CountingMemoryStore();
  const o = await options(store);
  const poster = join(s.dir, "poster.bin");
  await writeFile(poster, new Uint8Array([9]));
  const proxy = { hash: "ef".repeat(32), size: 1, profile: COLLAB_PROXY_720P.id, encoder: "libx264" };
  const get = store.get.bind(store);
  store.get = async (k, r) => {
    if (k.startsWith("px/")) throw new Error("proxy pointer GET failed");
    return get(k, r);
  };
  const r = await shareMedia({ ...o, record: { ...o.record, hash: await originalHash(), proxy }, local: { ...o.local, t1: { poster } }, policy: { originals: false, proxies: false } });
  assert.ok(r.record.t1?.poster, "the poster went up");
  assert.deepEqual(r.record.proxy, proxy, "the record's proxy is left as it was");
});

test("sharing the same clip again works through a store with no list (e2e S5-7)", async () => {
  const store = new CountingMemoryStore();
  store.list = async () => {
    throw new Error("the host HTTP API has no list");
  };
  const o = await options(store);
  const first = await shareMedia(o);
  const before = runs;
  const again = await shareMedia({ ...o, record: first.record });
  const teammate = await shareMedia(o);
  assert.equal(runs, before, "reused, not encoded again");
  assert.equal(again.record.proxy?.stream, first.record.proxy?.stream);
  assert.equal(teammate.record.proxy?.stream, first.record.proxy?.stream);
  assert.deepEqual(Object.keys(teammate.record.proxy!).sort(), ["encoder", "profile", "size", "stream"]);
});
