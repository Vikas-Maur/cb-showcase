// Store keys as SQLite TEXT whose order under SQLite's BINARY collation (memcmp of the UTF-8 bytes, which is code point
// order) is the Store contract's key order: element by element; numbers before strings; numbers numerically; strings
// by UTF-16 code units (JS `<`); a key before its extensions. So every range the contract asks for is one primary-key
// range read.
//
// TEXT rather than a BLOB because node:sqlite returns a BLOB as a fresh Uint8Array (its own ArrayBuffer) per row,
// which costs a log read about as much as fetching the values; a string is cheap, and a plain string element decodes
// as a slice of the key.
//
//   number: "\u0003", then the IEEE-754 double's 8 bytes big-endian (sign bit flipped when positive, every bit flipped
//           when negative), each byte b as the character U+0080 + b
//   string: "\u0004", then the string itself, then the terminator "\u0001". Three kinds of code unit are escaped so
//           that order survives and the text stays valid UTF-8 (a lone surrogate can't be stored as UTF-8):
//             U+0000–U+0002 -> "\u0002" + (c + 3)                  (below every unescaped unit, above the terminator)
//             U+D7FE–U+FFFF -> (U+E000 + d >> 7) + (U+0080 + d & 0x7f), d = c − 0xD7FE   (above every unescaped unit)
//           Every other code unit (U+0003–U+D7FD) is itself.
//
// Every element starts with a character below U+FFFF, so `prefix + "￿"` is above every key extending `prefix`.

const NUM = "\u0003";
const STR = "\u0004";
const END = "\u0001";
const HIGH = 0xd7fe;
const ESCAPED = /[\u0000-\u0002퟾-￿]/;
const ENCODED_ESCAPE = /[\u0002-￿]/;

const f64 = new Float64Array(1);
const f64b = new Uint8Array(f64.buffer);
const littleEndian = new Uint8Array(new Uint16Array([1]).buffer)[0] === 1;

export function encodeKey(key: readonly (string | number)[]): string {
  let out = "";
  for (const el of key) {
    if (typeof el === "number") out += NUM + num(el);
    else if (typeof el === "string") out += STR + (ESCAPED.test(el) ? escape(el) : el) + END;
    else throw new TypeError(`store key: elements are strings or numbers, got ${typeof el}`);
  }
  return out;
}

/** The smallest text above every key that extends `prefix` (and above `prefix` itself). */
export function prefixEnd(prefix: readonly (string | number)[]): string {
  return encodeKey(prefix) + "￿";
}

export function decodeKey(k: string): (string | number)[] {
  const out: (string | number)[] = [];
  let at = 0;
  while (at < k.length) {
    const tag = k[at++];
    if (tag === NUM) {
      const neg = k.charCodeAt(at) < 0x80 + 0x80;
      for (let i = 0; i < 8; i++) {
        const b = k.charCodeAt(at + i) - 0x80;
        f64b[littleEndian ? 7 - i : i] = neg ? ~b & 0xff : i === 0 ? b ^ 0x80 : b;
      }
      at += 8;
      out.push(f64[0]);
    } else if (tag === STR) {
      const end = k.indexOf(END, at);
      if (end < 0) throw new Error("store key: bad encoding (unterminated string)");
      const seg = k.slice(at, end);
      out.push(ENCODED_ESCAPE.test(seg) ? unescape(seg) : seg);
      at = end + 1;
    } else throw new Error(`store key: bad encoding (tag ${k.charCodeAt(at - 1)} at ${at - 1})`);
  }
  return out;
}

function num(n: number): string {
  if (!Number.isFinite(n)) throw new TypeError(`store key: ${n} is not a finite number`);
  f64[0] = n === 0 ? 0 : n; // -0 and 0 are one key, as for JS `<`
  const neg = (f64b[littleEndian ? 7 : 0] & 0x80) !== 0;
  let s = "";
  for (let i = 0; i < 8; i++) {
    const b = f64b[littleEndian ? 7 - i : i];
    s += String.fromCharCode(0x80 + (neg ? ~b & 0xff : i === 0 ? b ^ 0x80 : b));
  }
  return s;
}

function escape(s: string): string {
  let out = "";
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c <= 2) out += "\u0002" + String.fromCharCode(c + 3);
    else if (c >= HIGH) {
      const d = c - HIGH;
      out += String.fromCharCode(0xe000 + (d >> 7), 0x80 + (d & 0x7f));
    } else out += s[i];
  }
  return out;
}

function unescape(s: string): string {
  let out = "";
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 2) out += String.fromCharCode(s.charCodeAt(++i) - 3);
    else if (c >= 0xe000) out += String.fromCharCode(HIGH + ((c - 0xe000) << 7) + (s.charCodeAt(++i) - 0x80));
    else out += s[i];
  }
  return out;
}
