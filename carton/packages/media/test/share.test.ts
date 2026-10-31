import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { truncateSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, test } from "node:test";
import type { ProxyEncoder } from "../src/contracts.ts";
import { mediaKey, proxyPointerKey } from "../src/keys.ts";
import { COLLAB_PROXY_720P } from "../src/proxy.ts";
import { MediaReader } from "../src/read.ts";
import { HashScheduler } from "../src/scheduler.ts";
import { toMediaRecord } from "../src/tiers.ts";
import { CountingMemoryStore } from "../src/testing.ts";
import { ffmpegEncoder } from "../src/node/ffmpeg-encoder.ts";
import { closeHashWorkers, hashFile } from "../src/node/hash-file.ts";
import { hostProxyEncoder } from "../src/node/host-proxy.ts";
import { nodeHasher } from "../src/node/node-hasher.ts";
import { startRangeServer } from "../src/node/range-server.ts";
import { shareMedia, type ShareEvent } from "../src/node/share.ts";
import { FFMPEG, FFPROBE, haveFfmpeg, makeClip, scratchDir, xorshiftBytes } from "./helpers.ts";

const s = scratchDir("share");
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
  const r = await shareMedia({
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
  assert.ok(store.objects.has(mediaKey(r.record.proxy!.hash)));
  assert.equal(store.objects.has(mediaKey(orig.hash)), false, "the original stays on this machine (C8)");
  assert.ok(store.objects.has(proxyPointerKey(orig.hash, COLLAB_PROXY_720P.id)));
  assert.ok(events.some((e) => e.type === "proxy" && e.how === "encoded"));

  // A teammate with the same footage: the proxy is found through its pointer, nothing is encoded or uploaded again.
  const up = store.counters.bytesUp;
  const events2: ShareEvent[] = [];
  const r2 = await shareMedia({
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
    const { stdout: out } = await promisify(execFile)(FFPROBE, ["-v", "error", "-show_entries", "stream=codec_name,height", "-of", "csv=p=0", server.url(r.record.proxy!.hash)], { timeout: 30_000 });
    assert.match(out, /h264,540/);
  } finally {
    await server.close();
  }
});

test("the host's own proxy is shared as it is when it qualifies; originals go up only when opted in", { skip: !haveFfmpeg() && "no ffmpeg" }, async () => {
  const store = new CountingMemoryStore();
  const events: ShareEvent[] = [];
  const r = await shareMedia({
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
  const first = await shareMedia({
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
  const second = await shareMedia({
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
