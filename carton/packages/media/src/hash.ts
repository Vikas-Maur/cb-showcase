// Hashing a media source into its manifest, in any runtime. Node has a faster path for files (`@carton/media/node`
// hashFile: worker threads, reused buffers); this one is what browsers and Workers use, and what Node uses for bytes it
// already holds.

import type { Hasher } from "./contracts.ts";
import { LEAF_SIZE, ManifestBuilder, type Manifest } from "./manifest.ts";

/** Random-access bytes: a file, a Blob, a buffer. */
export interface ByteSource {
  readonly size: number;
  /** Reads `length` bytes at `offset` (fewer only past the end). */
  read(offset: number, length: number, signal?: AbortSignal): Promise<Uint8Array>;
  close?(): Promise<void>;
}

export function bytesSource(bytes: Uint8Array): ByteSource {
  return {
    size: bytes.length,
    read: async (offset, length) => bytes.subarray(offset, Math.min(bytes.length, offset + length)),
  };
}

/** A browser File or Blob. `slice` is lazy, so only the bytes asked for are read. */
export function blobSource(blob: Blob): ByteSource {
  return {
    size: blob.size,
    read: async (offset, length) => new Uint8Array(await blob.slice(offset, offset + length).arrayBuffer()),
  };
}

/** WebCrypto SHA-256: browsers, Workers, Deno, and Node's globalThis.crypto. */
export function webCryptoHasher(subtle: SubtleCrypto = globalThis.crypto.subtle): Hasher {
  return {
    async sha256(data) {
      return new Uint8Array(await subtle.digest("SHA-256", data as Uint8Array<ArrayBuffer>));
    },
  };
}

export interface HashOptions {
  /** Reads in flight at once. WebCrypto digests run off the calling thread, so 2-4 keeps both the disk and it busy. */
  concurrency?: number;
  /** Bytes per read, a whole number of leaves. Larger reads cost fewer calls; P6 read 64 MiB slices in browsers. */
  readSize?: number;
  signal?: AbortSignal;
  /** Bytes hashed so far. */
  onProgress?: (bytes: number) => void;
}

export async function hashSource(src: ByteSource, hasher: Hasher, opts: HashOptions = {}): Promise<Manifest> {
  const builder = new ManifestBuilder(src.size);
  const readSize = Math.max(LEAF_SIZE, Math.floor((opts.readSize ?? 8 * LEAF_SIZE) / LEAF_SIZE) * LEAF_SIZE);
  const blocks = Math.ceil(src.size / readSize);
  let next = 0;
  let done = 0;
  let failed = false;
  const loop = async (): Promise<void> => {
    try {
      await work();
    } catch (e) {
      failed = true; // stop the other loops: Promise.all has already rejected
      throw e;
    }
  };
  const work = async (): Promise<void> => {
    for (let b = next++; b < blocks && !failed; b = next++) {
      opts.signal?.throwIfAborted();
      const offset = b * readSize;
      const want = Math.min(readSize, src.size - offset);
      const block = await src.read(offset, want, opts.signal);
      if (block.length !== want) throw new Error(`short read at ${offset}: ${block.length} of ${want} bytes (did the file change?)`);
      const digests: Promise<Uint8Array>[] = [];
      for (let o = 0; o < want; o += LEAF_SIZE) digests.push(hasher.sha256(block.subarray(o, Math.min(want, o + LEAF_SIZE))));
      const first = offset / LEAF_SIZE;
      const got = await Promise.all(digests);
      for (let i = 0; i < got.length; i++) builder.setLeaf(first + i, got[i]);
      done += want;
      opts.onProgress?.(done);
    }
  };
  const n = Math.max(1, Math.min(opts.concurrency ?? 2, blocks || 1));
  await Promise.all(Array.from({ length: n }, loop));
  return builder.finish(hasher);
}
