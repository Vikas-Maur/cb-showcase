// Argument rules every BlobStore applies the same way (`@carton/blob-memory/rules`). The memory store is the
// reference; blob-fs, blob-s3 and blob-r2 import these checks so a bad key, range or part list fails identically on
// every backend, before any I/O.

import type { BlobInfo } from "@carton/core/plugins";

export type BlobErrorCode =
  | "InvalidKey"
  | "InvalidRange"
  | "InvalidPartNumber"
  | "InvalidPart"
  | "InvalidPartOrder"
  | "UnequalParts"
  | "EntityTooSmall"
  | "NoSuchUpload"
  | "PreconditionFailed";

export class BlobError extends Error {
  readonly code: BlobErrorCode;
  constructor(code: BlobErrorCode, message: string) {
    super(message);
    this.name = "BlobError";
    this.code = code;
  }
}

export const MAX_KEY_BYTES = 1024;
export const MAX_PARTS = 10_000;
const enc = new TextEncoder();

// Segments must be non-empty and never `.` or `..`: URLs (S3) and file systems (blob-fs) would resolve those to
// another key, so every store refuses them, and the same call fails the same way everywhere.
const BAD_SEGMENT = /(^|\/)(\.{1,2})?(\/|$)/;

export function checkKey(key: string): void {
  if (typeof key !== "string" || key.length === 0) throw new BlobError("InvalidKey", "blob key must be a non-empty string");
  if (BAD_SEGMENT.test(key)) throw new BlobError("InvalidKey", `blob key ${JSON.stringify(key.slice(0, 80))} has an empty, "." or ".." segment`);
  if (key.includes("\0")) throw new BlobError("InvalidKey", "blob key contains NUL");
  // UTF-16 length ≥ bytes/3, so only long keys pay for the encode
  if (key.length * 3 > MAX_KEY_BYTES && enc.encode(key).byteLength > MAX_KEY_BYTES)
    throw new BlobError("InvalidKey", `blob key longer than ${MAX_KEY_BYTES} bytes`);
}

/**
 * A store that says, without a call, whether it would refuse a key: a scoped store's prefix leaves less room than
 * `checkKey`'s 1,024 bytes. Not part of BlobStore; host-http checks a batch's keys with it before any call.
 */
export interface ChecksKeys {
  checkKey(key: string): void;
}
export const checksKeys = (s: object): s is ChecksKeys => typeof (s as Partial<ChecksKeys>).checkKey === "function";

export function checkRange(range: { offset: number; length?: number }): void {
  if (!Number.isSafeInteger(range.offset) || range.offset < 0) throw new BlobError("InvalidRange", `bad range offset ${range.offset}`);
  if (range.length !== undefined && (!Number.isSafeInteger(range.length) || range.length < 0))
    throw new BlobError("InvalidRange", `bad range length ${range.length}`);
}

/**
 * The bytes a read of `range` gets from an object of `size` bytes (BlobStore.getWithInfo's `range`): the whole object
 * without a range, else clipped at the end; null when the range starts at or past the end (HTTP 416).
 */
export function servedRange(size: number, range?: { offset: number; length?: number }): { offset: number; length: number } | null {
  if (!range) return { offset: 0, length: size };
  if (range.offset >= size) return null;
  return { offset: range.offset, length: Math.min(range.length ?? Infinity, size - range.offset) };
}

export function checkPartNumber(n: number): void {
  if (!Number.isInteger(n) || n < 1 || n > MAX_PARTS) throw new BlobError("InvalidPartNumber", `part number ${n} not in 1..${MAX_PARTS}`);
}

// Validates a `complete` list against the stored parts and returns the part numbers in order. All parts but the last
// have one size and the last is no larger (R2 requires it; S3 only asks ≥ 5 MiB, `minPartSize`, which every part but
// the last must meet).
export function checkCompleteParts(
  parts: readonly { partNumber: number; etag: string }[],
  stored: (partNumber: number) => { etag: string; size: number } | undefined,
  minPartSize = 0,
): number[] {
  if (!Array.isArray(parts) || parts.length === 0) throw new BlobError("InvalidPart", "complete needs at least one part");
  const nums = parts.map((p) => p.partNumber);
  for (const n of nums) checkPartNumber(n);
  const sorted = [...nums].sort((a, b) => a - b);
  for (let i = 1; i < sorted.length; i++)
    if (sorted[i] === sorted[i - 1]) throw new BlobError("InvalidPartOrder", `part ${sorted[i]} listed twice`);
  const byNum = new Map(parts.map((p) => [p.partNumber, p.etag]));
  let size = -1;
  for (let i = 0; i < sorted.length; i++) {
    const n = sorted[i]!, s = stored(n);
    if (!s || s.etag !== byNum.get(n)) throw new BlobError("InvalidPart", `part ${n} was not uploaded with that etag`);
    const last = i === sorted.length - 1;
    if (!last && s.size < minPartSize) throw new BlobError("EntityTooSmall", `part ${n} is ${s.size} bytes, under ${minPartSize}`);
    if (size < 0) size = s.size;
    else if (last ? s.size > size : s.size !== size)
      throw new BlobError("UnequalParts", `part ${n} is ${s.size} bytes; parts before the last must all be ${size}, and the last no larger`);
  }
  return sorted;
}

// Whether a `put` with `ifAbsent` created its object: true when this put wrote it, false when the key was there and
// the store kept what it held. Not part of BlobInfo: a symbol-keyed, non-enumerable property, so JSON never carries it
// and comparisons ignore it; a wrapper that copies the info carries it on (`withCreated`). A create-only signed PUT
// answers 412 by it (serveSignedBlob). Every store in this repository sets it; without it a host can prove a create
// only by the client's digest.
export const PUT_CREATED: unique symbol = Symbol.for("carton.blob.putCreated");
export function markCreated<T extends BlobInfo>(info: T, created: boolean): T {
  Object.defineProperty(info, PUT_CREATED, { value: created, enumerable: false, configurable: true });
  return info;
}
export function putCreated(info: BlobInfo): boolean | undefined {
  const v = (info as unknown as Record<symbol, unknown>)[PUT_CREATED];
  return typeof v === "boolean" ? v : undefined;
}
/** `to`, carrying `from`'s PUT_CREATED (for a wrapper that copies a put's info). */
export function withCreated<T extends BlobInfo>(to: T, from: BlobInfo): T {
  const c = putCreated(from);
  return c === undefined ? to : markCreated(to, c);
}

export function randomId(): string {
  const b = crypto.getRandomValues(new Uint8Array(16));
  let s = "";
  for (let i = 0; i < b.length; i++) s += b[i]!.toString(16).padStart(2, "0");
  return s;
}
