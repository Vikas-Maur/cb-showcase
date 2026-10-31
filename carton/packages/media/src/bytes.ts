// Small byte helpers shared by the browser and Node builds. No Buffer: this file also runs in browsers and Workers.

const HEX = "0123456789abcdef";
const HEX_PAIRS: string[] = [];
for (let i = 0; i < 256; i++) HEX_PAIRS.push(HEX[i >> 4] + HEX[i & 15]);

export function toHex(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += HEX_PAIRS[bytes[i]];
  return s;
}

export function fromHex(hex: string): Uint8Array {
  if (hex.length % 2 !== 0 || !/^[0-9a-f]*$/.test(hex)) throw new TypeError("not a lowercase hex string");
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

export function concatBytes(parts: readonly Uint8Array[]): Uint8Array {
  let n = 0;
  for (const p of parts) n += p.length;
  const out = new Uint8Array(n);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

/** Writes `n` (a non-negative safe integer) as an 8-byte big-endian unsigned integer at `out[at]`. */
export function writeU64BE(out: Uint8Array, at: number, n: number): void {
  if (!Number.isSafeInteger(n) || n < 0) throw new RangeError(`size out of range: ${n}`);
  const hi = Math.floor(n / 0x1_0000_0000);
  const lo = n >>> 0;
  const v = new DataView(out.buffer, out.byteOffset + at, 8);
  v.setUint32(0, hi);
  v.setUint32(4, lo);
}

export function readU64BE(src: Uint8Array, at: number): number {
  const v = new DataView(src.buffer, src.byteOffset + at, 8);
  const n = v.getUint32(0) * 0x1_0000_0000 + v.getUint32(4);
  if (!Number.isSafeInteger(n)) throw new RangeError("size out of range");
  return n;
}

const HASH_RE = /^[0-9a-f]{64}$/;
/** True for a media hash as Carton writes it: 64 lowercase hex characters. */
export function isMediaHash(s: unknown): s is string {
  return typeof s === "string" && HASH_RE.test(s);
}
