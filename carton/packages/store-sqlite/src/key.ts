// Store keys as SQLite BLOBs whose byte order (SQLite compares BLOBs with memcmp) is the Store contract's key order:
// element by element; numbers before strings; numbers numerically; strings by UTF-16 code units (JS `<`); a key
// before its extensions. So every range the contract asks for is one primary-key range read.
//
//   number: 0x01, then the IEEE-754 double big-endian, sign bit flipped (positive) or every bit flipped (negative)
//   string: 0x02, then each UTF-16 code unit as UTF-8 of that unit alone (CESU-8: a surrogate is 3 bytes, so byte
//           order is code-unit order, and lone surrogates survive), 0x00 written as 0x00 0xFF, then 0x00
//
// Every encoded element starts with a byte below 0xFF, so `prefix ‖ 0xFF` is above every key extending `prefix`.

const NUM = 0x01;
const STR = 0x02;

let buf = new Uint8Array(256);
const f64 = new Float64Array(1);
const f64b = new Uint8Array(f64.buffer);
const littleEndian = new Uint8Array(new Uint16Array([1]).buffer)[0] === 1;

function room(at: number, n: number): void {
  if (at + n <= buf.length) return;
  const next = new Uint8Array(Math.max(buf.length * 2, at + n));
  next.set(buf.subarray(0, at));
  buf = next;
}

function put(key: readonly (string | number)[]): number {
  let at = 0;
  for (const el of key) {
    if (typeof el === "number") {
      if (!Number.isFinite(el)) throw new TypeError(`store key: ${el} is not a finite number`);
      room(at, 9);
      buf[at++] = NUM;
      f64[0] = el === 0 ? 0 : el; // -0 and 0 are one key, as for JS `<`
      const neg = (f64b[littleEndian ? 7 : 0] & 0x80) !== 0;
      for (let i = 0; i < 8; i++) {
        const b = f64b[littleEndian ? 7 - i : i];
        buf[at++] = neg ? ~b & 0xff : i === 0 ? b ^ 0x80 : b;
      }
    } else if (typeof el === "string") {
      room(at, 2 + el.length * 3 + 1);
      buf[at++] = STR;
      for (let i = 0; i < el.length; i++) {
        const c = el.charCodeAt(i);
        if (c === 0) {
          buf[at++] = 0x00;
          buf[at++] = 0xff;
        } else if (c < 0x80) buf[at++] = c;
        else if (c < 0x800) {
          buf[at++] = 0xc0 | (c >> 6);
          buf[at++] = 0x80 | (c & 0x3f);
        } else {
          buf[at++] = 0xe0 | (c >> 12);
          buf[at++] = 0x80 | ((c >> 6) & 0x3f);
          buf[at++] = 0x80 | (c & 0x3f);
        }
      }
      buf[at++] = 0x00;
    } else throw new TypeError(`store key: elements are strings or numbers, got ${typeof el}`);
  }
  return at;
}

/** The BLOB for a key. A fresh array (SQLite copies it on bind, so the shared scratch buffer is never exposed). */
export function encodeKey(key: readonly (string | number)[]): Uint8Array {
  const n = put(key);
  return buf.slice(0, n);
}

/** The smallest BLOB above every key that extends `prefix` (and above `prefix` itself). */
export function prefixEnd(prefix: readonly (string | number)[]): Uint8Array {
  const n = put(prefix);
  const out = new Uint8Array(n + 1);
  out.set(buf.subarray(0, n));
  out[n] = 0xff;
  return out;
}

export function decodeKey(b: Uint8Array): (string | number)[] {
  const out: (string | number)[] = [];
  let at = 0;
  while (at < b.length) {
    const tag = b[at++];
    if (tag === NUM) {
      const neg = (b[at] & 0x80) === 0;
      for (let i = 0; i < 8; i++) {
        const v = b[at + i];
        f64b[littleEndian ? 7 - i : i] = neg ? ~v & 0xff : i === 0 ? v ^ 0x80 : v;
      }
      at += 8;
      out.push(f64[0]);
    } else if (tag === STR) {
      let s = "";
      let start = at;
      // ASCII runs decode in one call; anything else unit by unit.
      for (;;) {
        const c = b[at];
        if (c === 0x00) {
          if (b[at + 1] === 0xff) {
            s += ascii(b, start, at) + "\u0000";
            at += 2;
            start = at;
            continue;
          }
          s += ascii(b, start, at);
          at++;
          break;
        }
        if (c < 0x80) {
          at++;
          continue;
        }
        s += ascii(b, start, at);
        if (c < 0xe0) {
          s += String.fromCharCode(((c & 0x1f) << 6) | (b[at + 1] & 0x3f));
          at += 2;
        } else {
          s += String.fromCharCode(((c & 0x0f) << 12) | ((b[at + 1] & 0x3f) << 6) | (b[at + 2] & 0x3f));
          at += 3;
        }
        start = at;
      }
      out.push(s);
    } else throw new Error(`store key: bad encoding (tag ${tag} at ${at - 1})`);
  }
  return out;
}

function ascii(b: Uint8Array, from: number, to: number): string {
  if (to - from <= 0) return "";
  if (to - from < 64) {
    let s = "";
    for (let i = from; i < to; i++) s += String.fromCharCode(b[i]);
    return s;
  }
  return String.fromCharCode.apply(null, b.subarray(from, to) as unknown as number[]);
}
