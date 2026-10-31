// Argument rules every BlobStore applies the same way (`@carton/blob-memory/rules`). The memory store is the
// reference; blob-fs, blob-s3 and blob-r2 import these checks so a bad key, range or part list fails identically on
// every backend, before any I/O.

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

export function checkKey(key: string): void {
  if (typeof key !== "string" || key.length === 0) throw new BlobError("InvalidKey", "blob key must be a non-empty string");
  // UTF-16 length ≥ bytes/3, so only long keys pay for the encode
  if (key.length * 3 > MAX_KEY_BYTES && enc.encode(key).byteLength > MAX_KEY_BYTES)
    throw new BlobError("InvalidKey", `blob key longer than ${MAX_KEY_BYTES} bytes`);
}

export function checkRange(range: { offset: number; length?: number }): void {
  if (!Number.isSafeInteger(range.offset) || range.offset < 0) throw new BlobError("InvalidRange", `bad range offset ${range.offset}`);
  if (range.length !== undefined && (!Number.isSafeInteger(range.length) || range.length < 0))
    throw new BlobError("InvalidRange", `bad range length ${range.length}`);
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

export function randomId(): string {
  const b = crypto.getRandomValues(new Uint8Array(16));
  let s = "";
  for (let i = 0; i < b.length; i++) s += b[i]!.toString(16).padStart(2, "0");
  return s;
}
