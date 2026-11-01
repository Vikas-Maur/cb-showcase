// The media side of a client, in its own process (and network namespace when shaped): @carton/media's uploadMedia
// through the host's media API (hostMediaBlobs), exactly as the app shares a file, with the upload state kept on disk
// (FsUploadStateStore) so a killed or cut-off upload resumes. The file is synthetic: an AES-CTR keystream from a seed
// (incompressible, random access, no disk), so the same seed is the same content (dedup) at any size.
//
//   node media-client.ts '<json>'   ops: upload | download | put | head ; one JSON line per event on stdout
import { createCipheriv, createHash } from "node:crypto";
import { mediaHash, uploadMedia, type ByteSource } from "@carton/media";
import { nodeHasher, FsUploadStateStore } from "@carton/media/node";
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
}
const cfg = JSON.parse(process.argv[2]!) as Cfg;
const out = (o: Record<string, unknown>) => process.stdout.write(JSON.stringify({ t: now(), ...o }) + "\n");
const store = hostMediaBlobs({ origin: HOSTS[cfg.host], projectId: cfg.projectId, token: cfg.token });

try {
  if (cfg.op === "upload") {
    const source = syntheticSource(cfg.seed!, cfg.size!);
    const t0 = now();
    const manifest = await mediaHash(source, nodeHasher);
    out({ ev: "hashed", hash: manifest.hash, ms: now() - t0 });
    const state = new FsUploadStateStore(cfg.stateDir!);
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
    out({ ev: "uploaded", ms: now() - t1, result: r, hash: manifest.hash });
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
    out({ ev: "downloaded", ms: now() - t0, firstMs: first, bytes: got });
  }
  process.exit(0);
} catch (e) {
  out({ ev: "failed", error: String((e as Error)?.message ?? e).slice(0, 400), name: (e as Error)?.name, status: (e as { status?: number }).status, code: (e as { code?: string }).code });
  process.exit(1);
}
