// The key encoding's order, as SQLite compares TEXT (memcmp of UTF-8), is the Store contract's key order, checked
// against a reference comparator on random keys (with the awkward cases: \u0000-\u0002, lone surrogates, astral
// characters, -0, negative and huge numbers).
import { test } from "node:test";
import assert from "node:assert/strict";
import { encodeKey, decodeKey, prefixEnd } from "../src/key.ts";

type K = (string | number)[];

function refCompare(a: K, b: K): number {
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    const x = a[i], y = b[i];
    if (typeof x !== typeof y) return typeof x === "number" ? -1 : 1;
    if (x < y) return -1;
    if (x > y) return 1;
  }
  return a.length - b.length;
}
// What SQLite's BINARY collation does with two TEXT values.
const bytesCompare = (a: string, b: string) => Buffer.compare(Buffer.from(a, "utf8"), Buffer.from(b, "utf8"));
const sign = (n: number) => (n < 0 ? -1 : n > 0 ? 1 : 0);

let seed = 12345;
const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
const pick = <T>(xs: T[]) => xs[Math.floor(rnd() * xs.length)];
const UNITS = [0x0000, 0x0001, 0x0002, 0x0003, 0xd7fd, 0xd7fe, 0xe050, 0x0041, 0x007f, 0x0080, 0x07ff, 0x0800, 0xd7ff, 0xd800, 0xdbff, 0xdc00, 0xdfff, 0xe000, 0xfffd, 0xffff, 0x0061, 0x007a];
function rstr(): string {
  const n = Math.floor(rnd() * 5);
  let s = "";
  for (let i = 0; i < n; i++) s += String.fromCharCode(rnd() < 0.5 ? pick(UNITS) : 0x61 + Math.floor(rnd() * 3));
  if (rnd() < 0.1) s += "😀";
  return s;
}
const NUMS = [0, -0, 1, -1, 0.5, -0.5, 1e-300, -1e-300, 1e300, -1e300, Number.MAX_SAFE_INTEGER, Number.MIN_SAFE_INTEGER, 2 ** 53 + 2, 5e-324, -5e-324, 57, 100000];
function rkey(): K {
  const n = Math.floor(rnd() * 4);
  return Array.from({ length: n }, () => (rnd() < 0.5 ? pick(NUMS) : rstr()));
}

test("byte order equals the contract's key order (20k random pairs)", () => {
  for (let i = 0; i < 20000; i++) {
    const a = rkey(), b = rnd() < 0.3 ? [...a, ...rkey()] : rkey();
    assert.equal(sign(bytesCompare(encodeKey(a), encodeKey(b))), sign(refCompare(a, b)), JSON.stringify([a, b]));
  }
});

test("encoded keys are valid UTF-8 (they survive SQLite's text storage unchanged)", () => {
  for (let i = 0; i < 5000; i++) {
    const e = encodeKey(rkey());
    assert.equal(Buffer.from(e, "utf8").toString("utf8"), e);
  }
});

test("plain strings encode as themselves, so decoding them is a slice", () => {
  assert.equal(encodeKey(["c0ffee00c0ffee00"]), "\u0004c0ffee00c0ffee00\u0001");
  assert.equal(encodeKey(["Vidéos プロジェクト"]), "\u0004Vidéos プロジェクト\u0001");
});

test("keys round-trip, -0 becomes 0", () => {
  for (let i = 0; i < 5000; i++) {
    const k = rkey();
    assert.deepEqual(decodeKey(encodeKey(k)), k.map((x) => (Object.is(x, -0) ? 0 : x)));
  }
  assert.deepEqual(decodeKey(encodeKey(["a".repeat(200), "\u0000\u0000", "", -0])), ["a".repeat(200), "\u0000\u0000", "", 0]);
});

test("prefixEnd is above every extension of the prefix and below the next sibling", () => {
  for (let i = 0; i < 5000; i++) {
    const p = rkey();
    const end = prefixEnd(p);
    const ext = [...p, ...rkey()];
    assert.ok(bytesCompare(encodeKey(p), end) < 0);
    assert.ok(bytesCompare(encodeKey(ext), end) < 0, JSON.stringify(ext));
    const other = rkey();
    const isExt = other.length >= p.length && p.every((x, j) => refCompare([x], [other[j]]) === 0);
    if (!isExt && refCompare(other, p) > 0) assert.ok(bytesCompare(encodeKey(other), end) > 0, JSON.stringify([p, other]));
  }
});

test("non-finite numbers and other types are refused", () => {
  assert.throws(() => encodeKey([NaN]));
  assert.throws(() => encodeKey([Infinity]));
  assert.throws(() => encodeKey([true as unknown as string]));
});

test("through a real carton.db: range order and prefix ranges of 3000 random keys match the reference", async () => {
  const { openSqliteStore } = await import("../src/index.ts");
  const { scratch } = await import("./scratch.ts");
  const path = await import("node:path");
  const s = await openSqliteStore(path.join(scratch("keys"), "carton.db"));
  const seen = new Map<string, K>();
  for (let i = 0; i < 3000; i++) {
    const k = rkey().map((x) => (Object.is(x, -0) ? 0 : x));
    seen.set(JSON.stringify(k), k);
  }
  const keys = [...seen.values()];
  await s.write(keys.map((k, i) => ({ table: "t", key: k, value: i })));
  const want = [...keys].sort(refCompare);
  assert.deepEqual((await s.range("t")).map((r) => r.key), want);
  for (let i = 0; i < 200; i++) {
    const p = keys[i].slice(0, Math.floor(rnd() * (keys[i].length + 1)));
    const ext = want.filter((k) => k.length >= p.length && p.every((x, j) => refCompare([x], [k[j]]) === 0));
    assert.deepEqual((await s.range("t", { prefix: p })).map((r) => r.key), ext, JSON.stringify(p));
  }
  await s.close();
});
