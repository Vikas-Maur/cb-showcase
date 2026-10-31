// The demo's media path end to end on a real host: generate the sample clips with ffmpeg, upload them over HTTP as
// the seed script does, read them back through MediaReader over httpBlobStore and through serveMedia (what the
// Service Worker answers a <video> with), and check what a corrupted leaf does on the way.

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { LEAF_SIZE, LeafMismatchError, MediaReader, MemoryLeafCache, mediaHash, mediaKey, manifestKey, serveMedia, webCryptoHasher, type ReaderEvent } from "@carton/media";
import { nodeHasher } from "@carton/media/node";
import { FaultyStore } from "@carton/media/testing";
import { httpBlobStore } from "../src/http-blobs.ts";
import { FILMSTRIP_FRAMES, FILMSTRIP_HEIGHT, makeSampleClips, type SampleClip } from "../scripts/clips.ts";
import { uploadSampleMedia, type UploadedClip } from "../scripts/upload-media.ts";
import { SCRATCH, startTestHost, type TestHost } from "./host.ts";
import { collect, recordingFetch, sameBytes } from "./util.ts";

const CLIPS_DIR = join(SCRATCH, "clips");
let th: TestHost;
let token: string;
let clips: SampleClip[];
let uploaded: UploadedClip[];

before(async () => {
  th = await startTestHost();
  token = await th.session("demo");
  clips = await makeSampleClips(CLIPS_DIR);
});
after(() => th.close());

const store = (projectId = "demo", fetchImpl?: typeof fetch) =>
  httpBlobStore({ baseUrl: th.url, projectId, token: () => token, ...(fetchImpl ? { fetch: fetchImpl } : {}) });

function probe(file: string): Promise<{ width: number; height: number }> {
  return new Promise((resolve, reject) =>
    execFile(process.env.FFPROBE ?? "ffprobe", ["-v", "error", "-show_entries", "stream=width,height", "-of", "json", file], { windowsHide: true }, (err, out) => {
      if (err) return reject(err);
      const s = (JSON.parse(out) as { streams: { width: number; height: number }[] }).streams[0]!;
      resolve({ width: s.width, height: s.height });
    }),
  );
}

/** The biggest clip: it spans several 1 MiB leaves, so reads cross leaf boundaries. */
const biggest = () => uploaded.reduce((a, b) => (b.size > a.size ? b : a));
const fileOf = (u: UploadedClip) => clips.find((c) => c.id === u.clipId)!.file;

test("four distinct sample clips, each with a poster and a filmstrip; a second run reuses them", async () => {
  assert.equal(clips.length, 4);
  assert.equal(new Set(clips.map((c) => c.id)).size, 4);
  const digests = new Set<string>();
  for (const c of clips) {
    assert.ok(c.duration >= 5 && c.duration <= 8.2, `${c.id} lasts ${c.duration} s`);
    assert.deepEqual([c.width, c.height], [640, 360]);
    const bytes = await readFile(c.file);
    assert.equal(bytes.subarray(4, 8).toString("latin1"), "ftyp", `${c.id} is an MP4`);
    // faststart: the moov box comes before the media data, so a player starts after the first range
    assert.ok(bytes.indexOf("moov") < bytes.indexOf("mdat"), `${c.id} has its moov first`);
    digests.add((await mediaHash(bytes, nodeHasher)).hash);
    for (const jpg of [c.poster, c.filmstrip]) assert.deepEqual([...(await readFile(jpg)).subarray(0, 3)], [0xff, 0xd8, 0xff], `${jpg} is a JPEG`);
    assert.equal((await probe(c.poster)).width, 320);
    const strip = await probe(c.filmstrip);
    assert.equal(strip.height, FILMSTRIP_HEIGHT);
    assert.equal(strip.width, FILMSTRIP_FRAMES * Math.round((640 / 360) * FILMSTRIP_HEIGHT / 2) * 2, "eight frames side by side");
  }
  assert.equal(digests.size, 4, "four different files");
  const mtimes = await Promise.all(clips.map(async (c) => (await stat(c.file)).mtimeMs));
  const again = await makeSampleClips(CLIPS_DIR);
  assert.deepEqual(again.map((c) => c.file), clips.map((c) => c.file));
  assert.deepEqual(await Promise.all(again.map(async (c) => (await stat(c.file)).mtimeMs)), mtimes, "not generated again");
});

test("the clips upload over HTTP with their T1 files, and a second upload sends nothing", async () => {
  uploaded = await uploadSampleMedia({ store: store(), clips });
  assert.equal(uploaded.length, 4);
  const backend = th.mediaScope("demo");
  for (const u of uploaded) {
    const file = await readFile(fileOf(u));
    assert.equal(u.hash, (await mediaHash(file, nodeHasher)).hash);
    assert.equal(u.size, file.length);
    assert.equal(u.deduped, false);
    assert.equal((await backend.head(mediaKey(u.hash)))?.size, file.length);
    assert.ok(await backend.head(manifestKey(u.hash)), "the manifest went up too");
    assert.equal(u.poster, `t1/${u.hash}/poster.jpg`);
    assert.equal(u.filmstrip, `t1/${u.hash}/filmstrip.jpg`);
    for (const key of [u.poster, u.filmstrip]) assert.equal((await store().head(key))?.contentType, "image/jpeg", key);
  }
  assert.ok(biggest().size > 2 * LEAF_SIZE, "one clip spans several leaves");
  const rec = recordingFetch();
  const again = await uploadSampleMedia({ store: store("demo", rec.fetch), clips });
  assert.ok(again.every((u) => u.deduped));
  assert.deepEqual(rec.calls.filter((c) => c.method === "PUT" || c.url.pathname.includes("/uploads")), [], "no bytes sent");
});

test("a clip uploads in parts when the part size is smaller than the clip", async () => {
  const other = await th.session("parts");
  const big = clips.find((c) => c.id === biggest().clipId)!;
  const s = httpBlobStore({ baseUrl: th.url, projectId: "parts", token: () => other });
  const rec = recordingFetch();
  const [u] = await uploadSampleMedia({ store: httpBlobStore({ baseUrl: th.url, projectId: "parts", token: () => other, fetch: rec.fetch }), clips: [big], partSize: LEAF_SIZE });
  const parts = rec.calls.filter((c) => c.method === "PUT" && /\/uploads\/[^/]+\/\d+$/.test(c.url.pathname));
  assert.equal(parts.length, Math.ceil(u!.size / LEAF_SIZE));
  assert.ok(sameBytes((await s.get(mediaKey(u!.hash)))!, await readFile(big.file)));
});

test("MediaReader over HTTP and serveMedia give back the file's bytes, whole and by range", async () => {
  const u = biggest();
  const file = new Uint8Array(await readFile(fileOf(u)));
  // a fresh client, as a browser that just joined: nothing cached
  const reader = new MediaReader({ store: store(), hasher: webCryptoHasher(), cache: new MemoryLeafCache(), contentType: () => "video/mp4" });
  assert.ok(sameBytes(await collect(reader.read(u.hash, 0, u.size)), file), "whole, through MediaReader");

  const fresh = new MediaReader({ store: store(), hasher: webCryptoHasher(), cache: new MemoryLeafCache(), contentType: () => "video/mp4" });
  const from = LEAF_SIZE - 1000, to = 2 * LEAF_SIZE + 5000;
  const res = await serveMedia(fresh, u.hash, new Request(`http://app.test/media/${u.hash}`, { headers: { range: `bytes=${from}-${to}` } }));
  assert.equal(res.status, 206);
  assert.equal(res.headers.get("content-range"), `bytes ${from}-${to}/${u.size}`);
  assert.equal(res.headers.get("content-type"), "video/mp4");
  assert.ok(sameBytes(new Uint8Array(await res.arrayBuffer()), file.subarray(from, to + 1)), "a range across leaves, through serveMedia");

  const head = await serveMedia(fresh, u.hash, new Request(`http://app.test/media/${u.hash}`, { method: "HEAD" }));
  assert.equal(head.status, 200);
  assert.equal(head.headers.get("content-length"), String(u.size));
  const whole = await serveMedia(fresh, u.hash, new Request(`http://app.test/media/${u.hash}`));
  assert.ok(sameBytes(new Uint8Array(await whole.arrayBuffer()), file), "the whole file, through serveMedia");
  const missing = await serveMedia(fresh, "0".repeat(64), new Request(`http://app.test/media/${"0".repeat(64)}`));
  assert.equal(missing.status, 404);
});

test("a leaf corrupted on the way: the read stops after play-first bytes (served-bad), and the retry is repaired", async () => {
  const u = biggest();
  const file = new Uint8Array(await readFile(fileOf(u)));
  const events: ReaderEvent[] = [];
  const flaky = new FaultyStore(store(), { streamChunk: 64 * 1024, corruptAt: { key: mediaKey(u.hash), offset: LEAF_SIZE + 10, times: 1 } });
  const reader = new MediaReader({ store: flaky, hasher: webCryptoHasher(), cache: new MemoryLeafCache(), onEvent: (e) => events.push(e) });
  const req = () => new Request(`http://app.test/media/${u.hash}`);
  const res = await serveMedia(reader, u.hash, req());
  assert.equal(res.status, 200);
  await assert.rejects(res.arrayBuffer(), "the body errors, so the player stops");
  assert.deepEqual(events.map((e) => [e.type, e.leaf]), [["mismatch", 1], ["repaired", 1], ["served-bad", 1]]);
  assert.equal(events[0]!.handedOut, true, "bytes of the bad leaf had gone out: play first");
  const again = await serveMedia(reader, u.hash, req());
  assert.ok(sameBytes(new Uint8Array(await again.arrayBuffer()), file), "the retry is whole and right");
});

test("a copy damaged on the host fails its check over the real HTTP stream, and plays again once fixed", async () => {
  const u = uploaded.find((x) => x.size > LEAF_SIZE && x !== biggest()) ?? biggest();
  const file = new Uint8Array(await readFile(fileOf(u)));
  const backend = th.mediaScope("demo");
  const bad = file.slice();
  bad[300_000] ^= 0xff;
  await backend.put(mediaKey(u.hash), bad, { contentType: "video/mp4" });
  try {
    const events: ReaderEvent[] = [];
    const reader = new MediaReader({ store: store(), hasher: webCryptoHasher(), cache: new MemoryLeafCache(), retryDelayMs: 1, onEvent: (e) => events.push(e) });
    await assert.rejects(collect(reader.read(u.hash, 0, u.size)), LeafMismatchError);
    const types = events.map((e) => e.type);
    assert.equal(types[0], "mismatch");
    assert.ok(types.includes("repair-failed"), types.join());
    assert.equal(types.at(-1), "served-bad", "the player is told to drop what it got");
    await backend.put(mediaKey(u.hash), file, { contentType: "video/mp4" });
    assert.ok(sameBytes(await collect(reader.read(u.hash, 0, u.size)), file), "fixed on the host: the same reader plays it");
  } finally {
    await backend.put(mediaKey(u.hash), file, { contentType: "video/mp4" });
  }
});
