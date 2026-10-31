import assert from "node:assert/strict";
import { test } from "node:test";
import { concatBytes, equalBytes } from "../src/bytes.ts";
import { MemoryLeafCache } from "../src/cache.ts";
import { damagedKey, mediaKey, proxyPointerKey, streamSegmentKey } from "../src/keys.ts";
import { nodeHasher } from "../src/node/node-hasher.ts";
import { LeafMismatchError } from "../src/range-source.ts";
import { MediaReader } from "../src/read.ts";
import { claimProxyStream, findProxy, ProxyStreamReader, ProxyStreamWriter, streamRangeSource, type PlayedPart } from "../src/stream.ts";
import { CountingMemoryStore, FaultyStore } from "../src/testing.ts";
import { xorshiftBytes } from "./helpers.ts";

const KiB = 1024;
const seg = (i: number) => xorshiftBytes(300 * KiB + i * 7, 100 + i);
const INIT = xorshiftBytes(900, 99);

function setup() {
  const store = new CountingMemoryStore();
  const writer = new ProxyStreamWriter({ store, hasher: nodeHasher });
  const reader = new ProxyStreamReader({ store, media: new MediaReader({ store, hasher: nodeHasher, cache: new MemoryLeafCache() }), id: writer.id, pollMs: 5, maxPollMs: 20 });
  return { store, writer, reader };
}

test("a teammate plays the first segments while the rest are still being uploaded, then the rest as they land (S5-1)", async () => {
  const { writer, reader } = setup();
  await writer.init(INIT);
  await writer.segment(seg(0), 2);
  await writer.segment(seg(1), 2);
  const got: PlayedPart[] = [];
  let ended = false;
  const playing = (async () => {
    for await (const p of reader.play()) {
      got.push(p);
      if (p.part === "segment" && p.segment.index === 1) {
        // The teammate has played two segments; the uploader is still at it.
        assert.equal(ended, false);
        setTimeout(async () => {
          await writer.segment(seg(2), 1.5);
          ended = true;
          await writer.end();
        }, 30);
      }
    }
  })();
  await playing;
  assert.equal(got.length, 4, "init + 3 segments");
  assert.ok(got[0].part === "init" && equalBytes(got[0].bytes, INIT));
  for (let i = 0; i < 3; i++) {
    const p = got[i + 1];
    assert.ok(p.part === "segment" && p.segment.index === i && equalBytes(p.bytes, seg(i)), `segment ${i}`);
  }
});

test("the HLS playlist grows with the stream and ends with it", async () => {
  const { writer, reader } = setup();
  assert.equal(await reader.playlist((h) => `/m/${h}`), null, "nothing before the init segment");
  const init = await writer.init(INIT);
  const s0 = await writer.segment(seg(0), 2);
  const live = (await reader.playlist((h) => `/m/${h}`))!;
  assert.match(live, /#EXT-X-PLAYLIST-TYPE:EVENT/);
  assert.ok(live.includes(`#EXT-X-MAP:URI="/m/${init.hash}"`));
  assert.ok(live.includes(`#EXTINF:2.000,\n/m/${s0.hash}\n`));
  assert.equal(live.includes("#EXT-X-ENDLIST"), false, "still live");
  const s1 = await writer.segment(seg(1), 1.25);
  await writer.end();
  const done = (await reader.playlist((h) => `/m/${h}`))!;
  assert.ok(done.includes(`#EXTINF:1.250,\n/m/${s1.hash}\n`));
  assert.ok(done.trimEnd().endsWith("#EXT-X-ENDLIST"));
});

test("a complete stream reads as one file by range; an unfinished one has no size yet", async () => {
  const { store, writer, reader } = setup();
  const media = new MediaReader({ store, hasher: nodeHasher, cache: new MemoryLeafCache() });
  const src = streamRangeSource({ streams: (id) => (id === writer.id ? reader : null), media });
  await writer.init(INIT);
  await writer.segment(seg(0), 2);
  assert.equal(await src.stat(writer.id), null);
  await writer.segment(seg(1), 2);
  const end = await writer.end();
  const whole = concatBytes([INIT, seg(0), seg(1)]);
  assert.deepEqual(await src.stat(writer.id), { size: whole.length, contentType: "video/mp4" });
  assert.equal(end.size, whole.length);
  for (const [o, l] of [[0, whole.length], [0, 10], [INIT.length - 3, 10], [INIT.length + seg(0).length - 1, 2], [whole.length - 5, 50]]) {
    const parts: Uint8Array[] = [];
    for await (const p of src.read(writer.id, o, l)) parts.push(p.slice());
    assert.ok(equalBytes(concatBytes(parts), whole.subarray(o, Math.min(whole.length, o + l))), `range ${o}+${l}`);
  }
});

test("entries are written once: a second writer can't rewrite what a reader may already have", async () => {
  const { store, writer, reader } = setup();
  await writer.init(INIT);
  await writer.segment(seg(0), 2);
  const other = new ProxyStreamWriter({ store, hasher: nodeHasher, id: writer.id });
  await other.init(xorshiftBytes(900, 1));
  await other.segment(seg(5), 9);
  const s0 = (await reader.segment(0))!;
  assert.equal(s0.durationSec, 2);
  assert.equal(s0.size, seg(0).length);
});

test("claiming a source's proxy: the first claims, others reuse a live or finished one, an abandoned or damaged one is taken over", async () => {
  const store = new CountingMemoryStore();
  const src = "ab".repeat(32);
  let now = 1_000_000;
  const clock = { now: () => now, staleMs: 60_000 };
  const a = await claimProxyStream(store, src, "p1", "libx264", clock);
  assert.equal(a.claimed, true);
  const b = await claimProxyStream(store, src, "p1", "h264_nvenc", clock);
  assert.equal(b.claimed, false, "a fresh claim is live: reuse it");
  assert.deepEqual(b.pointer, a.pointer);
  const streamId = (a.pointer as { stream: string }).stream;

  // It grows: still live a while later.
  const w = new ProxyStreamWriter({ store, hasher: nodeHasher, id: streamId });
  await w.init(INIT);
  now += 50_000;
  const seg0 = await w.segment(seg(0), 2);
  store.objects.set(streamSegmentKey(streamId, 0), new TextEncoder().encode(JSON.stringify({ ...seg0, at: now })));
  now += 50_000;
  assert.equal((await claimProxyStream(store, src, "p1", "x", clock)).claimed, false, "a segment 50 s ago: live");
  // Its uploader died: nothing for longer than staleMs and no end.
  now += 61_000;
  const taken = await claimProxyStream(store, src, "p1", "x", clock);
  assert.equal(taken.claimed, true, "abandoned: taken over");
  assert.notEqual((taken.pointer as { stream: string }).stream, streamId);
  assert.deepEqual(await findProxy(store, src, "p1"), taken.pointer);

  // A finished stream is reused for good; a damaged one is replaced.
  const w2 = new ProxyStreamWriter({ store, hasher: nodeHasher, id: (taken.pointer as { stream: string }).stream });
  await w2.init(INIT);
  await w2.segment(seg(1), 2);
  await w2.end();
  now += 10 * 60 * 60_000;
  assert.equal((await claimProxyStream(store, src, "p1", "x", clock)).claimed, false, "finished: reused, however old");
  await store.put(damagedKey(w2.id), new TextEncoder().encode("{}"));
  assert.equal((await claimProxyStream(store, src, "p1", "x", clock)).claimed, true, "reported damaged: replaced");

  // A whole-object proxy (the older layout) is reused while its object is there.
  const src2 = "cd".repeat(32);
  const h = "ef".repeat(32);
  await store.put(proxyPointerKey(src2, "p1"), new TextEncoder().encode(JSON.stringify({ hash: h, size: 3, encoder: "libx264" })));
  assert.equal((await claimProxyStream(store, src2, "p1", "x", clock)).claimed, true, "its object is gone: replaced");
  await store.put(proxyPointerKey(src2, "p1"), new TextEncoder().encode(JSON.stringify({ hash: h, size: 3, encoder: "libx264" })));
  await store.put(mediaKey(h), new Uint8Array(3));
  assert.equal((await claimProxyStream(store, src2, "p1", "x", clock)).claimed, false);
});

test("a segment that never verifies fails the play and reports the stream damaged (S5-5)", async () => {
  const { store, writer } = setup();
  await writer.init(INIT);
  const s0 = await writer.segment(seg(0), 2);
  await writer.end();
  const bad = new FaultyStore(store, { corruptAt: { key: mediaKey(s0.hash), offset: 10, times: 1000 } });
  const reader = new ProxyStreamReader({ store: bad, media: new MediaReader({ store: bad, hasher: nodeHasher, repairAttempts: 2 }), id: writer.id, pollMs: 5 });
  await assert.rejects(async () => {
    for await (const _ of reader.play());
  }, LeafMismatchError);
  assert.ok(store.objects.has(damagedKey(writer.id)), "bad/<stream> marks it for the owner's next share");
});

test("waiting for a segment that isn't up yet ends with an abort", async () => {
  const { writer, reader } = setup();
  await writer.init(INIT);
  const ac = new AbortController();
  const p = reader.waitFor(0, ac.signal);
  setTimeout(() => ac.abort(), 30);
  await assert.rejects(p, { name: "AbortError" });
});
