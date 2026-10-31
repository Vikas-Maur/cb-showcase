import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { chmodSync, mkdirSync, readdirSync, truncateSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, test } from "node:test";
import type { ProxyEncoder } from "../src/contracts.ts";
import { damagedKey, mediaKey, proxyPointerKey } from "../src/keys.ts";
import { COLLAB_PROXY_720P } from "../src/proxy.ts";
import { MediaReader } from "../src/read.ts";
import { HashScheduler, MemoryManifestCache } from "../src/scheduler.ts";
import { toMediaRecord } from "../src/tiers.ts";
import { CountingMemoryStore } from "../src/testing.ts";
import { ffmpegEncoder } from "../src/node/ffmpeg-encoder.ts";
import { closeHashWorkers, hashFile } from "../src/node/hash-file.ts";
import { hostProxyEncoder } from "../src/node/host-proxy.ts";
import { nodeHasher } from "../src/node/node-hasher.ts";
import { startRangeServer } from "../src/node/range-server.ts";
import { shareMedia, type Segmenter, type ShareEvent } from "../src/node/share.ts";
import { findProxy, ProxyStreamReader } from "../src/stream.ts";
import { FFMPEG, FFPROBE, haveFfmpeg, makeClip, scratchDir, xorshiftBytes } from "./helpers.ts";

const s = scratchDir("share");
async function until(ok: () => boolean, ms = 10_000): Promise<void> {
  for (const t0 = Date.now(); !ok(); ) {
    if (Date.now() - t0 > ms) throw new Error("timed out waiting");
    await new Promise((r) => setTimeout(r, 5));
  }
}
let original = "";
let hostProxy = "";
let poster = "";
before(() => {
  if (!haveFfmpeg()) return;
  original = makeClip(join(s.dir, "camera take.mp4"), { seconds: 2, size: "960x540" });
  hostProxy = makeClip(join(s.dir, "host-proxy.mp4"), { seconds: 2, size: "640x360", faststart: true, kbps: 600 });
  poster = join(s.dir, "poster.jpg");
  writeFileSync(poster, xorshiftBytes(40_000, 3));
});
after(() => {
  closeHashWorkers();
  s.cleanup();
});

const record = () => toMediaRecord({ id: "m1", kind: "video", fileName: "camera take.mp4", size: 0, src: original });
const never: ProxyEncoder = {
  name: "must-not-run",
  hardware: false,
  probe: async () => true,
  encode: async () => {
    throw new Error("encoded although a proxy already existed");
  },
};

test("sharing uploads T1 and an encoded proxy, keeps the original local, and a teammate reuses the proxy", { skip: !haveFfmpeg() && "no ffmpeg" }, async () => {
  const store = new CountingMemoryStore();
  const events: ShareEvent[] = [];
  const noHostProxy = hostProxyEncoder({ locate: () => null, ffprobe: FFPROBE });
  const r = await shareMedia({ proxyStreams: false,
    store,
    record: record(),
    local: { original, t1: { poster } },
    policy: { originals: false },
    encoders: [noHostProxy, ffmpegEncoder("libx264", { ffmpeg: FFMPEG })],
    workDir: s.dir,
    onEvent: (e) => events.push(e),
  });
  const orig = await hashFile(original);
  assert.equal(r.record.hash, orig.hash);
  assert.equal(r.record.t1?.poster?.hash, (await hashFile(poster)).hash);
  assert.equal(r.record.proxy?.profile, COLLAB_PROXY_720P.id);
  assert.equal(r.record.proxy?.encoder, "libx264");
  assert.equal(r.record.original, undefined);
  assert.ok(store.objects.has(mediaKey(r.record.proxy!.hash!)));
  assert.equal(store.objects.has(mediaKey(orig.hash)), false, "the original stays on this machine (C8)");
  assert.ok(store.objects.has(proxyPointerKey(orig.hash, COLLAB_PROXY_720P.id)));
  assert.ok(events.some((e) => e.type === "proxy" && e.how === "encoded"));

  // A teammate with the same footage: the proxy is found through its pointer, nothing is encoded or uploaded again.
  const up = store.counters.bytesUp;
  const events2: ShareEvent[] = [];
  const r2 = await shareMedia({ proxyStreams: false,
    store,
    record: toMediaRecord({ id: "m-bob", kind: "video", fileName: "same.mp4", size: 0 }),
    local: { original },
    policy: { originals: false },
    encoders: [never],
    workDir: s.dir,
    scheduler: new HashScheduler({ hash: (t, o) => hashFile(t.key, { signal: o.signal }), hasher: nodeHasher }),
    onEvent: (e) => events2.push(e),
  });
  assert.equal(r2.record.proxy?.hash, r.record.proxy!.hash);
  assert.ok(events2.some((e) => e.type === "proxy" && e.how === "teammate's"));
  assert.equal(store.counters.bytesUp, up, "nothing uploaded");

  // The shared proxy plays through the loopback range server: ffprobe reads it by range.
  const server = await startRangeServer({ source: new MediaReader({ store, hasher: nodeHasher }).toolSource() });
  try {
    // Async: the range server runs in this process, so a synchronous ffprobe would block it and never get an answer.
    const { stdout: out } = await promisify(execFile)(FFPROBE, ["-v", "error", "-show_entries", "stream=codec_name,height", "-of", "csv=p=0", server.url(r.record.proxy!.hash!)], { timeout: 30_000 });
    assert.match(out, /h264,540/);
  } finally {
    await server.close();
  }
});

test("the host's own proxy is shared as it is when it qualifies; originals go up only when opted in", { skip: !haveFfmpeg() && "no ffmpeg" }, async () => {
  const store = new CountingMemoryStore();
  const events: ShareEvent[] = [];
  const r = await shareMedia({ proxyStreams: false,
    store,
    record: record(),
    local: { original },
    policy: { originals: true },
    encoders: [hostProxyEncoder({ locate: () => hostProxy, ffprobe: FFPROBE }), never],
    workDir: s.dir,
    onEvent: (e) => events.push(e),
  });
  assert.equal(r.record.proxy?.hash, (await hashFile(hostProxy)).hash, "the host's file, byte for byte");
  assert.equal(r.record.proxy?.encoder, "cardboard-proxy");
  assert.ok(events.some((e) => e.type === "proxy" && e.how === "host's"));
  assert.equal(r.record.original, "shared");
  assert.ok(store.objects.has(mediaKey(r.record.hash!)));
});

test("re-sharing a clip relinked to other footage replaces its proxy and original (review round 1, finding 3)", { skip: !haveFfmpeg() && "no ffmpeg" }, async () => {
  const store = new CountingMemoryStore();
  const first = await shareMedia({ proxyStreams: false,
    store,
    record: record(),
    local: { original, t1: { poster } },
    policy: { originals: true },
    encoders: [hostProxyEncoder({ locate: () => hostProxy, ffprobe: FFPROBE })],
    workDir: s.dir,
  });
  assert.equal(first.record.original, "shared");
  // The same clip, now pointing at other footage (the host proxy is gone), and a regenerated poster.
  const other = makeClip(join(s.dir, "retake.mp4"), { seconds: 2, size: "640x360", faststart: true, kbps: 500 });
  const poster2 = join(s.dir, "poster2.jpg");
  writeFileSync(poster2, xorshiftBytes(30_000, 4));
  const second = await shareMedia({ proxyStreams: false,
    store,
    record: first.record,
    local: { original: other, t1: { poster: poster2 } },
    policy: { originals: true },
    encoders: [hostProxyEncoder({ locate: () => null, ffprobe: FFPROBE }), ffmpegEncoder("libx264", { ffmpeg: FFMPEG })],
    workDir: s.dir,
  });
  const otherHash = (await hashFile(other)).hash;
  assert.equal(second.record.hash, otherHash);
  assert.notEqual(second.record.proxy?.hash, first.record.proxy?.hash, "a new proxy for the new footage");
  assert.equal(second.record.proxy?.encoder, "libx264");
  assert.ok(store.objects.has(mediaKey(otherHash)), "the new original was uploaded");
  assert.equal(second.record.t1?.poster?.hash, (await hashFile(poster2)).hash, "the new poster replaced the old one");
});

test("files the policy leaves out are never read, and an unreadable T1 file doesn't fail the clip (review round 2, finding 6)", { skip: !haveFfmpeg() && "no ffmpeg" }, async () => {
  const store = new CountingMemoryStore();
  const big = join(s.dir, "context.tar");
  writeFileSync(big, "");
  truncateSync(big, 26_000_000); // over the 25 MB cap; sparse, so nothing is really written
  const asked: string[] = [];
  const scheduler = new HashScheduler({ hash: (t, o) => (asked.push(t.key), hashFile(t.key, { signal: o.signal })), hasher: nodeHasher });
  const events: ShareEvent[] = [];
  const r = await shareMedia({
    store,
    record: record(),
    local: { original, t1: { poster, context: big, transcript: join(s.dir, "missing.json") } },
    policy: { originals: false, proxies: false },
    encoders: [],
    workDir: s.dir,
    scheduler,
    onEvent: (e) => events.push(e),
  });
  assert.equal(asked.includes(big), false, "the oversized .context was never hashed");
  assert.ok(r.record.t1?.poster, "the poster still went up");
  const skipped = events.filter((e) => e.type === "skipped").map((e) => (e as { what: string }).what).sort();
  assert.deepEqual(skipped, [".context", "transcript"]);
});

test("T1 files: the cap applies to the size hashed, a file that can't be opened is skipped, cancellation still cancels (review round 3)", { skip: !haveFfmpeg() && "no ffmpeg" }, async () => {
  // A .context that grows past the cap between its stat and its hash is still left out.
  const growing = join(s.dir, "growing.tar");
  writeFileSync(growing, "small");
  const scheduler = new HashScheduler({
    hasher: nodeHasher,
    hash: async (t, o) => {
      if (t.key === growing) truncateSync(growing, 26_000_000);
      return hashFile(t.key, { signal: o.signal });
    },
  });
  const store = new CountingMemoryStore();
  const events: ShareEvent[] = [];
  const r = await shareMedia({ store, record: record(), local: { original, t1: { context: growing } }, policy: { originals: false, proxies: false }, encoders: [], workDir: s.dir, scheduler, onEvent: (e) => events.push(e) });
  assert.equal(r.record.t1?.context, undefined, "the grown .context stays local");
  assert.ok(events.some((e) => e.type === "skipped" && (e as { what: string }).what === ".context"));

  // A T1 file whose hash comes from the manifest cache but which can't be opened any more (EACCES on Windows when
  // another program holds it, here a permission change).
  if (process.platform !== "win32" && process.getuid?.() !== 0) {
    const locked = join(s.dir, "transcript.json");
    writeFileSync(locked, "{}");
    const cached = new HashScheduler({ hasher: nodeHasher, hash: (t, o) => hashFile(t.key, { signal: o.signal }), cache: new MemoryManifestCache() });
    await shareMedia({ store, record: record(), local: { original, t1: { transcript: locked } }, policy: { originals: false, proxies: false }, encoders: [], workDir: s.dir, scheduler: cached });
    chmodSync(locked, 0o000);
    try {
      const ev: ShareEvent[] = [];
      const again = await shareMedia({ store: new CountingMemoryStore(), record: record(), local: { original, t1: { transcript: locked, poster } }, policy: { originals: false, proxies: false }, encoders: [], workDir: s.dir, scheduler: cached, onEvent: (e) => ev.push(e) });
      assert.ok(again.record.t1?.poster, "the rest of the clip is shared");
      assert.ok(ev.some((e) => e.type === "skipped" && (e as { what: string }).what === "transcript"));
    } finally {
      chmodSync(locked, 0o644);
    }
  }

  // Cancelling with a reason that isn't named AbortError still cancels: the hash fails with that very reason (as a
  // hasher honouring the share's signal does), and the share must not take it for an unreadable file.
  const ac = new AbortController();
  const reason = new Error("cancelled by the user");
  const cancelling = new HashScheduler({
    hasher: nodeHasher,
    hash: async () => {
      ac.abort(reason);
      throw reason;
    },
  });
  await assert.rejects(
    shareMedia({ store, record: toMediaRecord({ id: "m9", kind: "video", fileName: "x.mp4", size: 0 }), local: { t1: { poster } }, policy: { originals: false }, encoders: [], workDir: s.dir, scheduler: cancelling, signal: ac.signal }),
    (e) => e === reason,
  );
});

test("a shared file a reader reported damaged is uploaded again by the next share (S5-5)", { skip: !haveFfmpeg() && "no ffmpeg" }, async () => {
  const store = new CountingMemoryStore();
  const o = { store, local: { original, t1: { poster } }, policy: { originals: true, proxies: false }, encoders: [], workDir: s.dir };
  const first = await shareMedia({ ...o, record: record() });
  const posterHash = first.record.t1!.poster!.hash;
  // Disk rot in the store, and a teammate's reader that reported it.
  store.objects.get(mediaKey(posterHash))![100] ^= 0xff;
  store.objects.get(mediaKey(first.record.hash!))![100] ^= 0xff;
  await store.put(damagedKey(posterHash), new TextEncoder().encode("{}"));
  await store.put(damagedKey(first.record.hash!), new TextEncoder().encode("{}"));
  const up = store.counters.bytesUp;
  const again = await shareMedia({ ...o, record: first.record });
  assert.equal(again.record.t1?.poster?.hash, posterHash);
  assert.equal(again.record.original, "shared");
  const reader = new MediaReader({ store, hasher: nodeHasher });
  assert.equal((await reader.readVerified(posterHash, 0, first.record.t1!.poster!.size)).length, first.record.t1!.poster!.size, "the poster verifies again");
  assert.equal((await reader.readVerified(first.record.hash!, 0, first.record.size)).length, first.record.size, "so does the original");
  assert.equal(store.objects.has(damagedKey(posterHash)), false);
  assert.ok(store.counters.bytesUp - up >= first.record.size, "both went up again");
});


// e2e S5-1: the proxy as a stream a teammate plays while it uploads. A fake segmenter stands in for ffmpeg here (the
// real one is tested in segment-encoder.test.ts and below): it hands out an init segment and 4 segments, slowly.
function fakeSegmenter(counts: { segments: number }, delayMs = 30, afterSegment?: (index: number) => Promise<void>): Segmenter {
  return async (o) => {
    mkdirSync(o.dir, { recursive: true });
    const init = join(o.dir, "init.mp4");
    writeFileSync(init, xorshiftBytes(800, 7));
    await o.onInit(init);
    for (let i = 0; i < counts.segments; i++) {
      await new Promise((r) => setTimeout(r, delayMs));
      const path = join(o.dir, `seg_${i}.m4s`);
      writeFileSync(path, xorshiftBytes(50_000 + i, 200 + i));
      await o.onSegment({ index: i, path, durationSec: 2 });
      await afterSegment?.(i);
    }
    return { segments: counts.segments, durationSec: 2 * counts.segments };
  };
}
const libx264Like: ProxyEncoder = { name: "libx264", hardware: false, probe: async () => true, encode: async () => ({ bytes: 0, durationMs: 0 }) };

test("a teammate plays the proxy's first segments while the owner's share is still uploading the rest (S5-1)", { skip: !haveFfmpeg() && "no ffmpeg" }, async () => {
  const store = new CountingMemoryStore();
  let streamId = "";
  let shareDone = false;
  // The owner's encode holds after segment 1 until the teammate has played it: "played while the share was still
  // running" then holds by construction, not by how fast this box schedules the two sides.
  let teammateHasPlayed1!: () => void;
  const played1 = new Promise<void>((r) => (teammateHasPlayed1 = r));
  const sharing = shareMedia({
    store,
    record: record(),
    local: { original },
    policy: { originals: false },
    encoders: [libx264Like],
    workDir: s.dir,
    segmenter: fakeSegmenter({ segments: 4 }, 1, (i) => (i === 1 ? played1 : Promise.resolve())),
    onEvent: (e) => {
      if (e.type === "proxy" && e.how === "streaming") streamId = e.stream!;
    },
  }).then((r) => ((shareDone = true), r));
  await until(() => streamId !== "");
  // The teammate finds the proxy the way a teammate would: from the source's id, through the pointer.
  const pointer = await findProxy(store, (await hashFile(original)).hash, COLLAB_PROXY_720P.id);
  assert.ok(pointer && "stream" in pointer && pointer.stream === streamId);
  const reader = new ProxyStreamReader({ store, media: new MediaReader({ store, hasher: nodeHasher }), id: streamId, pollMs: 10 });
  let sawBeforeDone = 0;
  let total = 0;
  for await (const part of reader.play()) {
    if (part.part === "segment") {
      total++;
      if (!shareDone) sawBeforeDone++;
      if (part.segment.index === 1) teammateHasPlayed1();
    }
  }
  const r = await sharing;
  assert.equal(total, 4);
  assert.ok(sawBeforeDone >= 2, `the teammate played ${sawBeforeDone} segments before the share finished`);
  assert.equal(r.record.proxy?.stream, streamId);
  assert.equal(r.record.proxy?.encoder, "libx264");
  assert.equal(r.record.proxy?.size, 800 + [0, 1, 2, 3].reduce((a, i) => a + 50_000 + i, 0));

  // A second owner of the same footage reuses it: nothing encoded, nothing uploaded.
  const up = store.counters.bytesUp;
  const events: ShareEvent[] = [];
  const again = await shareMedia({ store, record: record(), local: { original }, policy: { originals: false }, encoders: [libx264Like], workDir: s.dir, segmenter: async () => assert.fail("encoded again"), onEvent: (e) => events.push(e) });
  assert.equal(again.record.proxy?.stream, streamId);
  assert.ok(events.some((e) => e.type === "proxy" && e.how === "teammate's"));
  assert.ok(store.counters.bytesUp - up < 1000, "only the pointer check went over the link");
});

test("a segmenter that fails before its first segment falls back to the next encoder; one that fails later reports its stream (S5-1)", { skip: !haveFfmpeg() && "no ffmpeg" }, async () => {
  const store = new CountingMemoryStore();
  const nvenc: ProxyEncoder = { ...libx264Like, name: "h264_nvenc", hardware: true };
  const failingFirst: Segmenter = async (o) => {
    if (o.codec === "h264_nvenc") throw new Error("OpenEncodeSessionEx failed: out of memory");
    return fakeSegmenter({ segments: 2 }, 1)(o);
  };
  const r = await shareMedia({ store, record: record(), local: { original }, policy: { originals: false }, encoders: [nvenc, libx264Like], workDir: s.dir, segmenter: failingFirst });
  assert.equal(r.record.proxy?.encoder, "libx264");
  const p = await findProxy(store, (await hashFile(original)).hash, COLLAB_PROXY_720P.id);
  assert.ok(p && "stream" in p && p.stream === r.record.proxy?.stream, "the pointer names the stream that finished");

  const store2 = new CountingMemoryStore();
  const failsLate: Segmenter = async (o) => {
    await fakeSegmenter({ segments: 1 }, 1)(o);
    throw new Error("the GPU driver reset");
  };
  let stream = "";
  await assert.rejects(shareMedia({ store: store2, record: record(), local: { original }, policy: { originals: false }, encoders: [nvenc, libx264Like], workDir: s.dir, segmenter: failsLate, onEvent: (e) => { if (e.type === "proxy" && e.stream) stream = e.stream; } }), /driver reset/);
  assert.ok(store2.objects.has(damagedKey(stream)), "a half-made stream is reported, so the next share replaces it");
  const next = await shareMedia({ store: store2, record: record(), local: { original }, policy: { originals: false }, encoders: [libx264Like], workDir: s.dir, segmenter: fakeSegmenter({ segments: 2 }, 1) });
  assert.notEqual(next.record.proxy?.stream, stream, "the next share made a new stream");
});

test("with real ffmpeg: the shared proxy is a stream a teammate plays and a tool reads through the live playlist (S5-1)", { skip: !haveFfmpeg() && "no ffmpeg" }, async () => {
  const store = new CountingMemoryStore();
  const events: ShareEvent[] = [];
  const r = await shareMedia({ store, record: record(), local: { original }, policy: { originals: false }, encoders: [ffmpegEncoder("libx264", { ffmpeg: FFMPEG })], ffmpeg: FFMPEG, workDir: s.dir, onEvent: (e) => events.push(e) });
  const stream = r.record.proxy?.stream;
  assert.ok(stream, "the proxy is a stream");
  assert.equal(r.record.proxy?.encoder, "libx264");
  assert.ok(events.findIndex((e) => e.type === "proxy" && e.how === "streaming") < events.findIndex((e) => e.type === "proxy" && e.how === "encoded"), "the stream id was out before the encode ended");
  const media = new MediaReader({ store, hasher: nodeHasher });
  const reader = new ProxyStreamReader({ store, media, id: stream!, pollMs: 10 });
  let segments = 0;
  let bytes = 0;
  for await (const p of reader.play()) {
    bytes += p.bytes.length;
    if (p.part === "segment") segments++;
  }
  assert.ok(segments >= 1);
  assert.equal(bytes, r.record.proxy?.size, "init + segments add up to the recorded size");
  const server = await startRangeServer({ source: media.toolSource(), playlist: async (id, urlFor) => (id === stream ? reader.playlist(urlFor) : null) });
  try {
    const { stdout } = await promisify(execFile)(FFPROBE, ["-v", "error", "-show_entries", "stream=codec_name,height", "-of", "csv=p=0", server.playlistUrl(stream!)], { timeout: 30_000 });
    assert.match(stdout, /h264,540/);
    assert.match(stdout, /aac/);
  } finally {
    await server.close();
  }
  assert.equal(readdirSync(s.dir).some((n) => n.startsWith("stream-")), false, "the working folder is cleaned up");
});
