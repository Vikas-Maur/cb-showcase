// SHA-256 for state hashes, record hashes and sequence-key suffixes. Synchronous, because apply, merge and refs are.
// In Node and Electron it uses node:crypto through `process.getBuiltinModule` (no static import, so core stays
// platform-neutral); elsewhere a portable implementation with byte-identical output. `setSyncHash` installs another.
import type { Doc, Rec } from "../types.ts";
import type { Schema } from "../schema.ts";
import { canonical, cmp, EMPTY } from "./json.ts";

type Digest = { update(s: string): Digest; digest(enc: "hex"): string; digest(): Uint8Array };
type NodeCrypto = { createHash(alg: "sha256"): Digest };

const nodeCrypto: NodeCrypto | null = (() => {
  try {
    const p = (globalThis as { process?: { getBuiltinModule?: (id: string) => unknown } }).process;
    return (p?.getBuiltinModule?.("node:crypto") as NodeCrypto | undefined) ?? null;
  } catch {
    return null;
  }
})();

// ---- portable SHA-256 (FIPS 180-4) over UTF-8
const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe,
  0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7,
  0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b,
  0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);
const W = new Uint32Array(64);
const enc = new TextEncoder();
function sha256Bytes(msg: Uint8Array): Uint8Array {
  const n = msg.length,
    total = ((n + 9 + 63) >> 6) << 6;
  const buf = new Uint8Array(total);
  buf.set(msg);
  buf[n] = 0x80;
  const dv = new DataView(buf.buffer);
  dv.setUint32(total - 8, Math.floor(n / 0x20000000));
  dv.setUint32(total - 4, (n << 3) >>> 0);
  let h0 = 0x6a09e667,
    h1 = 0xbb67ae85,
    h2 = 0x3c6ef372,
    h3 = 0xa54ff53a,
    h4 = 0x510e527f,
    h5 = 0x9b05688c,
    h6 = 0x1f83d9ab,
    h7 = 0x5be0cd19;
  for (let off = 0; off < total; off += 64) {
    for (let i = 0; i < 16; i++) W[i] = dv.getUint32(off + i * 4);
    for (let i = 16; i < 64; i++) {
      const a = W[i - 15]!,
        b = W[i - 2]!;
      const s0 = ((a >>> 7) | (a << 25)) ^ ((a >>> 18) | (a << 14)) ^ (a >>> 3);
      const s1 = ((b >>> 17) | (b << 15)) ^ ((b >>> 19) | (b << 13)) ^ (b >>> 10);
      W[i] = (W[i - 16]! + s0 + W[i - 7]! + s1) | 0;
    }
    let a = h0,
      b = h1,
      c = h2,
      d = h3,
      e = h4,
      f = h5,
      g = h6,
      h = h7;
    for (let i = 0; i < 64; i++) {
      const S1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
      const t1 = (h + S1 + ((e & f) ^ (~e & g)) + K[i]! + W[i]!) | 0;
      const S0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
      const t2 = (S0 + ((a & b) ^ (a & c) ^ (b & c))) | 0;
      h = g;
      g = f;
      f = e;
      e = (d + t1) | 0;
      d = c;
      c = b;
      b = a;
      a = (t1 + t2) | 0;
    }
    h0 = (h0 + a) | 0;
    h1 = (h1 + b) | 0;
    h2 = (h2 + c) | 0;
    h3 = (h3 + d) | 0;
    h4 = (h4 + e) | 0;
    h5 = (h5 + f) | 0;
    h6 = (h6 + g) | 0;
    h7 = (h7 + h) | 0;
  }
  const out = new Uint8Array(32);
  const ov = new DataView(out.buffer);
  [h0, h1, h2, h3, h4, h5, h6, h7].forEach((x, i) => ov.setUint32(i * 4, x));
  return out;
}
const HEX = Array.from({ length: 256 }, (_, i) => i.toString(16).padStart(2, "0"));
const toHex = (b: Uint8Array): string => {
  let s = "";
  for (let i = 0; i < b.length; i++) s += HEX[b[i]!];
  return s;
};

let installed: ((text: string) => string) | null = null;

/** SHA-256 hex of the UTF-8 bytes of `text`. */
export function sha256Hex(text: string): string {
  if (installed) return installed(text);
  if (nodeCrypto) return nodeCrypto.createHash("sha256").update(text).digest("hex");
  return toHex(sha256Bytes(enc.encode(text)));
}
/** The first bytes of SHA-256 of `text` (sequence-key suffixes). */
export function sha256Raw(text: string): Uint8Array {
  if (!installed && nodeCrypto) return nodeCrypto.createHash("sha256").update(text).digest();
  if (!installed) return sha256Bytes(enc.encode(text));
  const hex = installed(text);
  const out = new Uint8Array(32);
  for (let i = 0; i < 32; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}
/** Install a faster synchronous SHA-256 (a Hasher's `sha256HexSync`). It must produce identical output; null restores the default. */
export function setSyncHash(fn: ((text: string) => string) | null): void {
  installed = fn;
}
/** The portable implementation, for conformance checks against an installed one. */
export const portableSha256Hex = (text: string): string => toHex(sha256Bytes(enc.encode(text)));

const HASH = new WeakMap<object, string>();
/** sha256 of a record's canonical JSON, cached per record object (records are never mutated in place). */
export function hashRecord(rec: Rec): string {
  let h = HASH.get(rec);
  if (h === undefined) HASH.set(rec, (h = sha256Hex(canonical(rec))));
  return h;
}

/** Merkle-style state hash: one sha256 over root fields and sorted (key, recordHash) pairs per collection. */
export function hashDoc(doc: Doc, schema: Schema): string {
  const root: Record<string, unknown> = {};
  for (const k in doc) if (!schema.collections[k]) root[k] = doc[k];
  let s = canonical(root);
  for (const name in schema.collections) {
    const cs = schema.collections[name]!;
    const arr = (doc[name] as Rec[] | undefined) ?? EMPTY;
    const pairs = new Array<string>(arr.length);
    for (let i = 0; i < arr.length; i++) pairs[i] = String(arr[i]![cs.key]) + ":" + hashRecord(arr[i]!);
    pairs.sort();
    s += `\n#${name}\n` + pairs.join("\n");
  }
  return sha256Hex(s);
}

/** Canonical snapshot: root fields plus collections sorted by key, as canonical JSON. */
export function snapshot(doc: Doc, schema: Schema): string {
  const out: Record<string, unknown> = {};
  for (const k in doc) {
    const cs = schema.collections[k];
    out[k] = cs ? [...(doc[k] as Rec[])].sort((a, b) => cmp(a[cs.key], b[cs.key])) : doc[k];
  }
  return canonical(out);
}
