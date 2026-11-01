import { test } from "node:test";
import assert from "node:assert/strict";
import { keyToSegments, encodeSegment, decodeSegment, BadKeyError, OBJECT_SUFFIX, HASHED_DIR, READABLE_MAX } from "../src/keys.ts";

test("content-hash keys stay readable", () => {
  const h = "ab".repeat(32);
  assert.deepEqual(keyToSegments(`media/${h}`), ["media", h + OBJECT_SUFFIX]);
  assert.deepEqual(keyToSegments("segments/main/000001.seg.gz"), ["segments", "main", "000001.seg.gz" + OBJECT_SUFFIX]);
});

test("keys differing only in case map to different names (case-insensitive volumes)", () => {
  const a = keyToSegments("Clip/A.mp4").join("/"), b = keyToSegments("clip/a.mp4").join("/");
  assert.notEqual(a.toLowerCase(), b.toLowerCase());
});

test("names Windows can't create are escaped", () => {
  for (const s of ["CON", "con", "nul.txt", "Com1", "lpt9.log", "aux", "conin$"]) {
    const e = encodeSegment(s);
    assert.doesNotMatch(e, /^(con|prn|aux|nul|com\d|lpt\d|conin\$)(\.|$)/i, s);
  }
  for (const s of ['a<b', 'a>b', 'a:b', 'a"b', "a\\b", "a|b", "a?b", "a*b", "a\x01b", "trailing.", "sp ace"]) {
    assert.match(encodeSegment(s), /^[a-z0-9._%-]+$/, s);
    assert.doesNotMatch(encodeSegment(s), /\.$/, s);
  }
});

test("`.`, `..`, empty segments and NUL are refused", () => {
  for (const k of ["", "a/../b", "..", ".", "/a", "a/", "a//b", "a\0b", "x".repeat(1025)])
    assert.throws(() => keyToSegments(k), BadKeyError, JSON.stringify(k.slice(0, 20)));
  assert.deepEqual(keyToSegments("a/.../b"), ["a", "..%2e", "b" + OBJECT_SUFFIX]); // "..." is a legal name
});

test("a key too long to keep readable is stored flat, hashed, and two such keys never collide", () => {
  const long1 = "x".repeat(400), long2 = "x".repeat(399) + "y";
  const p1 = keyToSegments(long1), p2 = keyToSegments(long2);
  assert.equal(p1[0], HASHED_DIR);
  assert.notDeepEqual(p1, p2);
  for (const n of [...p1, ...p2]) assert.ok(Buffer.byteLength(n) <= 255);
  // a short key can never produce a hashed-looking name: `~` is always escaped
  assert.equal(encodeSegment("a~b"), "a%7eb");
});

test("every legal key's relative path is bounded (macOS limits a whole path to 1024 bytes)", () => {
  const worst = [
    "A".repeat(1024), // every byte escaped as %41
    Array.from({ length: 5 }, () => "B".repeat(199)).join("/") + "/" + "C".repeat(24), // the suite's 1024-byte shape, capitals
    Array.from({ length: 340 }, () => "Ω").join("/").slice(0, 1024), // short unicode segments
    "é".repeat(512), // 1024 bytes of 2-byte characters
  ];
  for (const k of worst) {
    const rel = keyToSegments(k).join("/");
    assert.ok(Buffer.byteLength(rel) <= READABLE_MAX, `${Buffer.byteLength(rel)} bytes for a ${Buffer.byteLength(k)}-byte key`);
  }
  // and keys that fit stay readable
  assert.equal(keyToSegments("projects/p/seq/segments/main/10000.json.gz").join("/"), "projects/p/seq/segments/main/10000.json.gz~b");
});

test("an object and a folder of the same name coexist (`a` and `a/b`)", () => {
  const file = keyToSegments("a"), nested = keyToSegments("a/b");
  assert.notEqual(file[0], nested[0]);
});

test("decodeSegment inverts encodeSegment for short segments", () => {
  for (const s of ["Hello World.mp4", "ünïcødé", "CON", "a~b", "trailing.", "%41"]) assert.equal(decodeSegment(encodeSegment(s)), s);
  assert.equal(decodeSegment(encodeSegment("z".repeat(300))), null);
});
