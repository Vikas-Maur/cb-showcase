// Blob keys -> relative file paths that mean the same thing on every file system Carton runs on.
//
// A key is `/`-separated, like an S3 key. Each segment is encoded so that:
// - two different keys never land on one file on a case-insensitive volume (NTFS, APFS by default): uppercase
//   letters are escaped, so `A` and `a` become `%41` and `a`;
// - Windows can create it: `<>:"\|?*`, control characters, a trailing dot and the device names (CON, NUL, COM1…,
//   which Windows reserves even with an extension) are escaped;
// - no segment is `.` or `..`, so a key can never climb out of the store's directory;
// - no file name is longer than 255 bytes (NTFS and ext4): long segments keep a readable prefix plus a SHA-256 of
//   the whole segment, after a `~`, a character the encoder otherwise always escapes, so the two forms can't
//   collide.
// - a key can be both an object and a "folder" of others (`a` and `a/b`), as in S3: an object's file name ends in
//   `~b`, which no directory name can end in (directory names hold no `~`, or `~` plus 64 hex digits).
// Content-hash keys (`media/<lowercase hex>`) keep their readable names (`media/<hex>~b`).

import { createHash } from "node:crypto";

const MAX_KEY_BYTES = 1024; // S3's limit; R2's too
const MAX_NAME = 255 - 2; // room for the `~b` suffix of object files
export const OBJECT_SUFFIX = "~b";
const HASHED_PREFIX = 180;
const RESERVED = /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³]|conin\$|conout\$)(\.|$)/;
const HEX = Array.from({ length: 256 }, (_, i) => "%" + i.toString(16).padStart(2, "0"));
const enc = new TextEncoder();

export class BadKeyError extends Error {
  constructor(key: string, why: string) {
    super(`bad blob key ${JSON.stringify(key.length > 80 ? key.slice(0, 80) + "…" : key)}: ${why}`);
    this.name = "BadKeyError";
  }
}

// Bytes kept as they are: lowercase letters, digits, `-`, `_` and `.` (a dot is escaped when it ends a segment).
function plain(b: number): boolean {
  return (b >= 0x61 && b <= 0x7a) || (b >= 0x30 && b <= 0x39) || b === 0x2d || b === 0x5f || b === 0x2e;
}

export function encodeSegment(seg: string): string {
  const bytes = enc.encode(seg);
  let out = "";
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i]!;
    out += plain(b) && !(b === 0x2e && i === bytes.length - 1) ? String.fromCharCode(b) : HEX[b];
  }
  if (RESERVED.test(out)) out = HEX[out.charCodeAt(0)] + out.slice(1);
  if (out.length > MAX_NAME) out = out.slice(0, HASHED_PREFIX) + "~" + createHash("sha256").update(seg).digest("hex");
  return out;
}

// Validates a key and returns its relative path as segments: directories, then the object's file name.
export function keyToSegments(key: string): string[] {
  if (typeof key !== "string" || key.length === 0) throw new BadKeyError(String(key), "empty");
  if (enc.encode(key).length > MAX_KEY_BYTES) throw new BadKeyError(key, `longer than ${MAX_KEY_BYTES} bytes`);
  if (key.includes("\0")) throw new BadKeyError(key, "contains NUL");
  const segs = key.split("/");
  for (const s of segs) {
    if (s === "") throw new BadKeyError(key, "empty segment (leading, trailing or double slash)");
    if (s === "." || s === "..") throw new BadKeyError(key, "`.` or `..` segment");
  }
  const out = segs.map(encodeSegment);
  out[out.length - 1] += OBJECT_SUFFIX;
  return out;
}

// The inverse, for listing (pass an object's file name without its suffix). Hashed (long) segments can't be
// decoded: null.
export function decodeSegment(name: string): string | null {
  if (name.includes("~")) return null;
  const bytes: number[] = [];
  for (let i = 0; i < name.length; i++) {
    if (name[i] === "%") {
      bytes.push(parseInt(name.slice(i + 1, i + 3), 16));
      i += 2;
    } else bytes.push(name.charCodeAt(i));
  }
  return new TextDecoder().decode(new Uint8Array(bytes));
}
