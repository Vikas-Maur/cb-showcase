// Media conformance (PLAN §3.1, §11). Each suite registers node:test tests:
// - hasherSuite: a Hasher plug-in gives standard SHA-256, the media id vectors, and agrees with its sync form.
// - mediaStoreSuite: @carton/media works over a BlobStore plug-in: manifests, dedup, resume after a cut link, exact
//   ranges, refetch of a bad leaf.
// - proxyEncoderSuite: a ProxyEncoder's probe never throws, and its proxies are seekable H.264/AAC MP4 (moov first) at
//   the profile, with sane progress and a clean abort.
// - browserParitySuite (./browser.ts): headless Chromium computes the same media ids as Node (P6).
// Owner: media.

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { closeSync, existsSync, mkdtempSync, openSync, readdirSync, readSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { BlobStore, Hasher, ProxyEncoder, ProxyProfile } from "@carton/core/plugins";
import {
  bytesSource,
  decodeManifest,
  hashSource,
  LeafMismatchError,
  LEAF_SIZE,
  manifestKey,
  MediaReader,
  MemoryLeafCache,
  MemoryUploadStateStore,
  mediaKey,
  toHex,
  uploadMedia,
  type ReaderEvent,
} from "@carton/media";
import { FaultyStore, LinkDroppedError } from "@carton/media/testing";
import { MEDIA_ID_VECTORS, SHA256_VECTORS, xorshiftBytes } from "./vectors.ts";

export { MEDIA_ID_VECTORS, SHA256_VECTORS, xorshiftBytes } from "./vectors.ts";
export { browserParitySuite, type BrowserParityOptions } from "./browser.ts";

const utf8 = new TextEncoder();

export function hasherSuite(name: string, hasher: Hasher): void {
  test(`[media/hasher ${name}] standard SHA-256 vectors`, async () => {
    for (const v of SHA256_VECTORS) {
      assert.equal(toHex(await hasher.sha256(utf8.encode(v.input))), v.hex, JSON.stringify(v.input));
      if (hasher.sha256HexSync) assert.equal(hasher.sha256HexSync(v.input), v.hex, `sync ${JSON.stringify(v.input)}`);
    }
  });

  test(`[media/hasher ${name}] media ids match the independent vectors`, async () => {
    for (const v of MEDIA_ID_VECTORS) {
      const data = xorshiftBytes(v.size, v.seed);
      assert.equal(toHex(await hasher.sha256(data)).slice(0, 16), v.sha256Prefix, `generator, ${v.size} bytes`);
      assert.equal((await hashSource(bytesSource(data), hasher)).hash, v.mediaHash, `media id, ${v.size} bytes`);
    }
  });

  test(`[media/hasher ${name}] does not mutate its input, and digests views at any offset`, async () => {
    const data = xorshiftBytes(LEAF_SIZE + 17, 42);
    const copy = data.slice();
    const view = data.subarray(17);
    const a = await hasher.sha256(view);
    assert.deepEqual(data, copy);
    assert.equal(toHex(a), toHex(await hasher.sha256(copy.slice(17))));
  });
}

export interface MediaStoreSuiteOptions {
  /** Part size for the multipart tests. 5 MiB by default: S3 and R2 refuse smaller parts (except the last). */
  partSize?: number;
}

export function mediaStoreSuite(name: string, make: () => Promise<BlobStore>, hasher: Hasher, opts: MediaStoreSuiteOptions = {}): void {
  const partSize = opts.partSize ?? 5 * LEAF_SIZE;
  // Three whole parts and a short last one, so resume and part-size rules are exercised on any backend.
  const size = 3 * partSize + 4321;
  const fixture = async (seed: number) => {
    const data = xorshiftBytes(size, seed);
    return { data, manifest: await hashSource(bytesSource(data), hasher), source: bytesSource(data) };
  };

  test(`[media/store ${name}] upload stores the bytes and a manifest that verifies; a second upload is deduped`, async () => {
    const store = await make();
    const { data, manifest, source } = await fixture(101);
    const r = await uploadMedia({ store, hasher, source, manifest, partSize });
    assert.equal(r.deduped, false);
    assert.equal((await store.head(mediaKey(manifest.hash)))?.size, data.length);
    const mf = await store.get(manifestKey(manifest.hash));
    assert.ok(mf);
    assert.equal((await decodeManifest(mf, hasher, manifest.hash)).size, data.length);
    const again = await uploadMedia({ store, hasher, source, manifest, partSize });
    assert.equal(again.deduped, true);
    assert.equal(again.bytesSent, 0);
  });

  test(`[media/store ${name}] a cut link resumes from the completed parts`, async () => {
    const inner = await make();
    const { data, manifest, source } = await fixture(102);
    const state = new MemoryUploadStateStore();
    const store = new FaultyStore(inner, { dropUploadAfterBytes: 2 * partSize + LEAF_SIZE });
    const o = { store, hasher, source, manifest, partSize, state, concurrency: 1, retries: 0 };
    await assert.rejects(uploadMedia(o), LinkDroppedError);
    const r = await uploadMedia(o);
    assert.equal(r.resumedParts, 2);
    assert.equal(r.bytesSent, data.length - 2 * partSize, "only the missing parts are sent again");
    const back = await inner.get(mediaKey(manifest.hash));
    assert.ok(back && back.length === data.length && toHex(await hasher.sha256(back)) === toHex(await hasher.sha256(data)));
  });

  test(`[media/store ${name}] reads return exact ranges, and a corrupted leaf is fetched again`, async () => {
    const inner = await make();
    const { data, manifest, source } = await fixture(103);
    await uploadMedia({ store: inner, hasher, source, manifest, partSize });
    const events: ReaderEvent[] = [];
    for (const streamChunk of [undefined, 48 * 1024]) {
      const store = new FaultyStore(inner, { streamChunk, corruptAt: { key: mediaKey(manifest.hash), offset: 3 * LEAF_SIZE + 5, times: 1 } });
      const reader = new MediaReader({ store, hasher, cache: new MemoryLeafCache(), onEvent: (e) => events.push(e) });
      const got = await reader.readVerified(manifest.hash, LEAF_SIZE - 7, 3 * LEAF_SIZE);
      assert.deepEqual(got, data.subarray(LEAF_SIZE - 7, 4 * LEAF_SIZE - 7));
      for (const [o, l] of [[0, 1], [size - 3, 10], [2 * LEAF_SIZE, LEAF_SIZE]]) {
        const parts: Uint8Array[] = [];
        for await (const p of reader.read(manifest.hash, o, l)) parts.push(p.slice());
        assert.deepEqual(Buffer.concat(parts), Buffer.from(data.subarray(o, Math.min(size, o + l))), `range ${o}+${l}`);
      }
    }
    assert.ok(events.some((e) => e.type === "repaired" && e.leaf === 3));
  });

  test(`[media/store ${name}] a play-first read stops on a bad leaf, and the retry is good`, async () => {
    const inner = await make();
    const { data, manifest, source } = await fixture(104);
    await uploadMedia({ store: inner, hasher, source, manifest, partSize });
    const store = new FaultyStore(inner, { streamChunk: 32 * 1024, corruptAt: { key: mediaKey(manifest.hash), offset: 10, times: 1 } });
    const reader = new MediaReader({ store, hasher, cache: new MemoryLeafCache() });
    await assert.rejects(async () => {
      for await (const _ of reader.read(manifest.hash, 0, size));
    }, LeafMismatchError);
    const parts: Uint8Array[] = [];
    for await (const p of reader.read(manifest.hash, 0, size)) parts.push(p.slice());
    assert.deepEqual(Buffer.concat(parts), Buffer.from(data));
  });
}

export interface ProxyEncoderSuiteOptions {
  /** A short source clip with video and audio, larger than the profile. */
  sample: string;
  profile?: ProxyProfile;
  ffprobe?: string;
  /** Where outputs go (a scratch folder on disk, not a small tmpfs). */
  scratch?: string;
}

/** Top-level MP4 boxes, to check moov comes before mdat (seekable over HTTP ranges). */
export function mp4Boxes(path: string): { type: string; offset: number; size: number }[] {
  const fd = openSync(path, "r");
  const out: { type: string; offset: number; size: number }[] = [];
  try {
    const size = statSync(path).size;
    const h = Buffer.alloc(16);
    for (let off = 0; off + 8 <= size; ) {
      readSync(fd, h, 0, 16, off);
      let len = h.readUInt32BE(0);
      const type = h.toString("latin1", 4, 8);
      if (len === 1) len = Number(h.readBigUInt64BE(8));
      else if (len === 0) len = size - off;
      if (len < 8) break;
      out.push({ type, offset: off, size: len });
      off += len;
    }
  } finally {
    closeSync(fd);
  }
  return out;
}

function probe(ffprobe: string, path: string): Promise<{ streams: { codec_type: string; codec_name: string; width?: number; height?: number }[]; format: { duration: string; bit_rate?: string } }> {
  return new Promise((resolve, reject) =>
    execFile(ffprobe, ["-v", "error", "-show_streams", "-show_format", "-of", "json", path], { windowsHide: true }, (e, out) =>
      e ? reject(e) : resolve(JSON.parse(String(out))),
    ),
  );
}

export function proxyEncoderSuite(name: string, encoder: ProxyEncoder, opts: ProxyEncoderSuiteOptions): void {
  const profile: ProxyProfile = opts.profile ?? { height: 720, bitrate: 2_000_000, codec: "h264", audio: "aac" };
  const ffprobe = opts.ffprobe ?? "ffprobe";
  const scratch = () => mkdtempSync(join(opts.scratch ?? tmpdir(), "proxy-suite-"));

  test(`[media/encoder ${name}] probe answers without throwing`, async () => {
    const a = await encoder.probe();
    assert.equal(typeof a, "boolean");
    assert.equal(await encoder.probe(), a, "the answer is stable");
    assert.equal(typeof encoder.hardware, "boolean");
  });

  test(`[media/encoder ${name}] encodes a seekable H.264/AAC MP4 at the profile, with sane progress`, async (t) => {
    if (!(await encoder.probe())) return t.skip(`${name} can't run on this machine`);
    const dir = scratch();
    try {
      const out = join(dir, "out.mp4");
      const progress: number[] = [];
      const r = await encoder.encode({ path: opts.sample }, { path: out }, profile, { onProgress: (f) => progress.push(f) });
      assert.equal(r.bytes, statSync(out).size);
      const boxes = mp4Boxes(out).map((b) => b.type);
      assert.ok(boxes.indexOf("moov") >= 0 && boxes.indexOf("moov") < boxes.indexOf("mdat"), `moov before mdat: ${boxes.join(",")}`);
      const p = await probe(ffprobe, out);
      const v = p.streams.find((s) => s.codec_type === "video");
      const a = p.streams.find((s) => s.codec_type === "audio");
      assert.equal(v?.codec_name, "h264");
      assert.equal(a?.codec_name, "aac");
      assert.ok(Math.min(v!.width!, v!.height!) <= profile.height, `short side ${Math.min(v!.width!, v!.height!)} ≤ ${profile.height}`);
      for (let i = 0; i < progress.length; i++) {
        assert.ok(progress[i] >= 0 && progress[i] <= 1, `progress ${progress[i]} in [0, 1]`);
        if (i > 0) assert.ok(progress[i] >= progress[i - 1], "progress never goes back");
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test(`[media/encoder ${name}] abort stops the encode and leaves no output`, async (t) => {
    if (!(await encoder.probe())) return t.skip(`${name} can't run on this machine`);
    const dir = scratch();
    try {
      const out = join(dir, "aborted.mp4");
      const ac = new AbortController();
      const p = encoder.encode({ path: opts.sample }, { path: out }, profile, { signal: ac.signal, onProgress: () => ac.abort() });
      setTimeout(() => ac.abort(), 50);
      await assert.rejects(p);
      assert.equal(existsSync(out), false);
      assert.deepEqual(readdirSync(dir), [], "no partial files left behind");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
}
