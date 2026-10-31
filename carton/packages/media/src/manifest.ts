// Media content ids (PLAN §11, B8): mediaHash = SHA-256(size ‖ SHA-256 of each 1 MiB leaf).
//
// - size is 8 bytes, big-endian. Leaves are the file cut every 1 MiB from offset 0; the last one is shorter. An empty
//   file has no leaves, so its id is SHA-256 of 8 zero bytes.
// - The leaf digests, in order, are the manifest. A reader verifies each leaf against it as the leaf completes, so
//   playback can start before the whole file is checked (play first, verify after).
// - L = 1 MiB is fixed by P6 [V]: a WebCrypto digest call costs about 10-13 µs, so 1 MiB leaves cost 3-4% more total
//   time than 8 MiB ones, and a reader verifies (and refetches) 1 MiB at a time.
// - Browser and Node give byte-identical ids (P6 [V], and the conformance suite checks it in Chromium).
// - Fixed leaves, never CDC. If CDC is ever added, it must use stitched segments (P6), as a new manifest version.
//
// Encoded manifest (what the BlobStore keeps next to the media object):
//   "CMF1" | log2(L) = 20 | 3 zero bytes | size (u64 BE) | leaf digests (32 bytes each)
// Everything after the first 8 bytes is exactly the input of the id hash, so decoding verifies the id with one digest
// and no copy.

import { readU64BE, toHex, writeU64BE } from "./bytes.ts";
import type { Hasher } from "./contracts.ts";

export const LEAF_SHIFT = 20;
export const LEAF_SIZE = 1 << LEAF_SHIFT;
export const DIGEST_SIZE = 32;
const HEADER = 8;
const MAGIC = [0x43, 0x4d, 0x46, 0x31]; // "CMF1"

export interface Manifest {
  /** The media hash: 64 lowercase hex characters. */
  readonly hash: string;
  readonly size: number;
  readonly leafCount: number;
  /** The encoded manifest; `digests` and the id input are views into it. */
  readonly bytes: Uint8Array;
}

export class ManifestError extends Error {
  override name = "ManifestError";
}

export function leafCountOf(size: number): number {
  return Math.ceil(size / LEAF_SIZE);
}

/** Byte offset and length of leaf `i` in a file of `size` bytes. */
export function leafSpan(size: number, i: number): { offset: number; length: number } {
  const offset = i * LEAF_SIZE;
  return { offset, length: Math.min(LEAF_SIZE, size - offset) };
}

/** The leaves [first, end) that hold bytes [offset, offset + length). */
export function leavesCovering(offset: number, length: number): { first: number; end: number } {
  const first = Math.floor(offset / LEAF_SIZE);
  if (length <= 0) return { first, end: first };
  return { first, end: Math.floor((offset + length - 1) / LEAF_SIZE) + 1 };
}

/** Leaf `i`'s digest, as a view into the manifest. */
export function leafDigest(m: Manifest, i: number): Uint8Array {
  if (i < 0 || i >= m.leafCount) throw new RangeError(`leaf ${i} of ${m.leafCount}`);
  const at = HEADER + 8 + i * DIGEST_SIZE;
  return m.bytes.subarray(at, at + DIGEST_SIZE);
}

/**
 * Collects leaf digests in any order (parallel hashers finish out of order) and builds the manifest when all are in.
 * The digests go straight into the encoded manifest's buffer.
 */
export class ManifestBuilder {
  readonly size: number;
  readonly leafCount: number;
  readonly #bytes: Uint8Array;
  #filled = 0;
  readonly #have: Uint8Array;

  constructor(size: number) {
    this.size = size;
    this.leafCount = leafCountOf(size);
    this.#bytes = new Uint8Array(HEADER + 8 + this.leafCount * DIGEST_SIZE);
    this.#bytes.set(MAGIC, 0);
    this.#bytes[4] = LEAF_SHIFT;
    writeU64BE(this.#bytes, HEADER, size);
    this.#have = new Uint8Array(this.leafCount);
  }

  setLeaf(i: number, digest: Uint8Array): void {
    if (digest.length !== DIGEST_SIZE) throw new ManifestError(`leaf ${i}: digest is ${digest.length} bytes`);
    if (i < 0 || i >= this.leafCount) throw new RangeError(`leaf ${i} of ${this.leafCount}`);
    this.#bytes.set(digest, HEADER + 8 + i * DIGEST_SIZE);
    if (!this.#have[i]) {
      this.#have[i] = 1;
      this.#filled++;
    }
  }

  get complete(): boolean {
    return this.#filled === this.leafCount;
  }

  async finish(hasher: Hasher): Promise<Manifest> {
    if (!this.complete) throw new ManifestError(`${this.leafCount - this.#filled} of ${this.leafCount} leaves missing`);
    const hash = toHex(await hasher.sha256(this.#bytes.subarray(HEADER)));
    return { hash, size: this.size, leafCount: this.leafCount, bytes: this.#bytes };
  }
}

/** Builds a manifest from leaf digests given in order (32 bytes each, concatenated). */
export async function manifestFromDigests(size: number, digests: Uint8Array, hasher: Hasher): Promise<Manifest> {
  const b = new ManifestBuilder(size);
  if (digests.length !== b.leafCount * DIGEST_SIZE) throw new ManifestError(`expected ${b.leafCount} digests`);
  for (let i = 0; i < b.leafCount; i++) b.setLeaf(i, digests.subarray(i * DIGEST_SIZE, (i + 1) * DIGEST_SIZE));
  return b.finish(hasher);
}

/**
 * Checks an encoded manifest and recomputes its id. With `expectHash`, a manifest for any other media is refused, so
 * a manifest fetched from an untrusted store can only ever describe the media its key names.
 */
export async function decodeManifest(bytes: Uint8Array, hasher: Hasher, expectHash?: string): Promise<Manifest> {
  if (bytes.length < HEADER + 8) throw new ManifestError("manifest too short");
  for (let i = 0; i < 4; i++) if (bytes[i] !== MAGIC[i]) throw new ManifestError("not a Carton media manifest");
  if (bytes[4] !== LEAF_SHIFT) throw new ManifestError(`unsupported leaf size 2^${bytes[4]}`);
  if (bytes[5] !== 0 || bytes[6] !== 0 || bytes[7] !== 0) throw new ManifestError("unsupported manifest flags");
  const size = readU64BE(bytes, HEADER);
  const leafCount = leafCountOf(size);
  if (bytes.length !== HEADER + 8 + leafCount * DIGEST_SIZE) throw new ManifestError(`manifest length does not match size ${size}`);
  const hash = toHex(await hasher.sha256(bytes.subarray(HEADER)));
  if (expectHash !== undefined && hash !== expectHash) throw new ManifestError(`manifest is for ${hash}, not ${expectHash}`);
  return { hash, size, leafCount, bytes };
}
