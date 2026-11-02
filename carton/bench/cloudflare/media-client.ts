// The media side of a client, in its own process (and network namespace when shaped): @carton/media's uploadMedia
// through the host's media API (hostMediaBlobs), exactly as the app shares a file, with the upload state kept on disk
// (FsUploadStateStore) so a killed or cut-off upload resumes. The file is synthetic: an AES-CTR keystream from a seed
// (incompressible, random access, no disk), so the same seed is the same content (dedup) at any size.
//
// Reads go the way the app reads (scripts/carton/sync/media.js): `download` through MediaReader (play first, each 1 MiB
// leaf verified, a dropped response refetched leaf by leaf with retries), `download-raw` as plain ranged GETs (the
// harness's old way, kept to compare). `proxy-share` shares a local video as the app does (shareMedia: the encoder
// chain cutting 2 s segments, each uploaded as it is made); `proxy-play` plays that stream as a teammate's player does
// (ProxyStreamReader over MediaReader with the on-disk leaf cache). Every HTTP request is counted by kind.
//
//   node media-client.ts '<json>'   ops: upload | download | download-raw | put | head | proxy-share | proxy-play
import { createCipheriv, createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mediaHash, uploadMedia, MediaReader, ProxyStreamReader, COLLAB_PROXY_720P, toMediaRecord, type ByteSource, type UploadStateStore } from "@carton/media";
import { nodeHasher, FsUploadStateStore, FsLeafCache, shareMedia, defaultEncoderChain } from "@carton/media/node";
import { hostMediaBlobs } from "@carton/host-http/client";
import { HOSTS, now, type HostName } from "./common.ts";

/** Seeded incompressible bytes, readable at any offset. */
export function syntheticSource(seed: string, size: number): ByteSource {
  const key = createHash("sha256").update(`cf-lab:${seed}`).digest().subarray(0, 16);
  return {
    size,
    async read(offset, length) {
      const end = Math.min(size, offset + length);
      if (end <= offset) return new Uint8Array(0);
      const block = Math.floor(offset / 16), skip = offset - block * 16;
      const iv = Buffer.alloc(16);
      iv.writeBigUInt64BE(BigInt(block), 8);
      const c = createCipheriv("aes-128-ctr", key, iv);
      const out = c.update(Buffer.alloc(end - offset + skip));
      return new Uint8Array(out.buffer, out.byteOffset + skip, end - offset);
    },
  };
}

interface Cfg {
  op: "upload" | "download" | "put" | "head";
  host: HostName;
  projectId: string;
  token: string;
  seed?: string;
  size?: number;
  stateDir?: string;
  concurrency?: number;
  partSize?: number;
  bytesPerSecond?: number;
  retries?: number;
  key?: string;
  /** download: bytes to read, in ranged reads of `chunk` */
  bytes?: number;
  chunk?: number;
  /** proxy-share: the local video; proxy-play: the stream id */
  file?: string;
  stream?: string;
  workDir?: string;
}
const cfg = JSON.parse(process.argv[2]!) as Cfg;
const out = (o: Record<string, unknown>) => process.stdout.write(JSON.stringify({ t: now(), ...o }) + "\n");
// every request this client makes, by kind: the sign call, the signed GET/PUT, and the rest by route
const requests: Record<string, number> = {};
const countingFetch: typeof fetch = (input, init) => {
  const u = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
  const m = (init?.method ?? "GET").toUpperCase();
  const route = u.pathname.replace(/^\/api\/projects\/[^/]+/, "").replace(/\/uploads\/[^/]+/, "/uploads/:id").replace(/\/uploads\/:id\/\d+$/, "/uploads/:id/:n");
  const kind = route.startsWith("/blobs/sign") ? "sign" : u.searchParams.has("sig") || u.searchParams.has("signature") || u.searchParams.has("exp") ? `signed-${m}` : `${m} ${route}`;
  requests[kind] = (requests[kind] ?? 0) + 1;
  return fetch(input, init);
};
const store = hostMediaBlobs({ origin: HOSTS[cfg.host], projectId: cfg.projectId, token: cfg.token, fetch: countingFetch });
/** The upload state store, logging each upload id it saves (R2's upload records are named by it). */
function loggingState(inner: UploadStateStore): UploadStateStore {
  const seen = new Set<string>();
  return {
    load: (k) => inner.load(k),
    delete: (k) => inner.delete(k),
    async save(st) {
      if (!seen.has(st.uploadId)) (seen.add(st.uploadId), out({ ev: "upload-id", id: st.uploadId }));
      return inner.save(st);
    },
  };
}

try {
  if (cfg.op === "upload") {
    const source = syntheticSource(cfg.seed!, cfg.size!);
    const t0 = now();
    const manifest = await mediaHash(source, nodeHasher);
    out({ ev: "hashed", hash: manifest.hash, ms: now() - t0 });
    const state = loggingState(new FsUploadStateStore(cfg.stateDir!));
    let lastPct = -1;
    const t1 = now();
    const r = await uploadMedia({
      store, hasher: nodeHasher, source, manifest, state,
      ...(cfg.concurrency ? { concurrency: cfg.concurrency } : {}),
      ...(cfg.partSize ? { partSize: cfg.partSize } : {}),
      ...(cfg.bytesPerSecond ? { bytesPerSecond: cfg.bytesPerSecond } : {}),
      ...(cfg.retries !== undefined ? { retries: cfg.retries } : {}),
      onProgress: (p) => {
        const pct = Math.floor((100 * p.done) / p.total);
        if (pct !== lastPct) (lastPct = pct), out({ ev: "progress", done: p.done, total: p.total, sent: p.sent });
      },
    });
    out({ ev: "uploaded", ms: now() - t1, result: r, hash: manifest.hash, requests });
  } else if (cfg.op === "put") {
    const data = new Uint8Array(await syntheticSource(cfg.seed!, cfg.size!).read(0, cfg.size!));
    const t0 = now();
    const info = await store.put(cfg.key!, data);
    out({ ev: "put", ms: now() - t0, size: info.size });
  } else if (cfg.op === "head") {
    const t0 = now();
    const info = await store.head(cfg.key!);
    out({ ev: "head", ms: now() - t0, info });
  } else if (cfg.op === "download") {
    // the app's read path: MediaReader.read, play first (what a player asks for)
    const hash = cfg.key!.replace(/^m\//, "");
    const events: Record<string, number> = {};
    const reader = new MediaReader({ store, hasher: nodeHasher, onEvent: (e) => void (events[e.type] = (events[e.type] ?? 0) + 1) });
    const t0 = now();
    let got = 0, first = 0, lastPct = -1;
    for await (const piece of reader.read(hash, 0, cfg.bytes!)) {
      if (!first) first = now() - t0;
      got += piece.byteLength;
      const pct = Math.floor((100 * got) / cfg.bytes!);
      if (pct !== lastPct) (lastPct = pct), out({ ev: "progress", got });
    }
    out({ ev: "downloaded", ms: now() - t0, firstMs: first, bytes: got, requests, events });
  } else if (cfg.op === "proxy-share") {
    // as scripts/carton/sync/media.js shares a clip: the encoder chain (here libx264), proxies on, originals off
    const work = cfg.workDir ?? mkdtempSync(join(tmpdir(), "cflab-proxy-"));
    const t0 = now();
    let firstSegAt = 0, segs = 0;
    const r = await shareMedia({
      store,
      record: toMediaRecord({ id: "clip-1", kind: "video", fileName: "lab.mp4", size: 0 } as any),
      local: { original: cfg.file! },
      policy: { originals: false, proxies: true },
      encoders: defaultEncoderChain({ ffmpeg: "ffmpeg", lowPriority: true, tempDir: work }),
      workDir: work,
      uploadState: loggingState(new FsUploadStateStore(join(work, "uploads"))),
      ffmpeg: "ffmpeg",
      onEvent: (e) => {
        if (e.type === "proxy" && e.how === "streaming") out({ ev: "streaming", stream: e.stream, ms: now() - t0 });
        else if (e.type === "uploaded") { segs++; if (!firstSegAt) firstSegAt = now() - t0; }
        else if (e.type !== "hashed") out({ ev: "share-event", e });
      },
    });
    const ms = now() - t0, made = { ...requests };
    // the stream's end entry says how many segments went up (read after the tally above, so it isn't counted)
    const stream = r.record.proxy?.stream;
    const end = stream ? await new ProxyStreamReader({ store, media: new MediaReader({ store, hasher: nodeHasher }), id: stream }).end() : null;
    out({ ev: "shared", ms, firstUploadMs: firstSegAt, uploads: segs, proxy: r.record.proxy, end, requests: made });
    rmSync(work, { recursive: true, force: true });
  } else if (cfg.op === "proxy-play") {
    const cacheDir = mkdtempSync(join(tmpdir(), "cflab-leaves-"));
    const media = new MediaReader({ store, hasher: nodeHasher, cache: new FsLeafCache(cacheDir) });
    const reader = new ProxyStreamReader({ store, media, id: cfg.stream! });
    const t0 = now();
    let bytes = 0, parts = 0, first = 0;
    for await (const p of reader.play()) {
      if (!first) first = now() - t0;
      bytes += p.bytes.byteLength;
      parts++;
    }
    out({ ev: "played", ms: now() - t0, firstMs: first, bytes, parts, requests });
    rmSync(cacheDir, { recursive: true, force: true });
  } else if (cfg.op === "download-raw") {
    const chunk = cfg.chunk ?? 4 << 20;
    const t0 = now();
    let got = 0, first = 0;
    while (got < cfg.bytes!) {
      const b = await store.get(cfg.key!, { offset: got, length: Math.min(chunk, cfg.bytes! - got) });
      if (!b || b.byteLength === 0) break;
      if (!first) first = now() - t0;
      got += b.byteLength;
      out({ ev: "progress", got });
    }
    out({ ev: "downloaded", ms: now() - t0, firstMs: first, bytes: got, requests });
  }
  process.exit(0);
} catch (e) {
  out({ ev: "failed", error: String((e as Error)?.message ?? e).slice(0, 400), name: (e as Error)?.name, status: (e as { status?: number }).status, code: (e as { code?: string }).code });
  process.exit(1);
}
