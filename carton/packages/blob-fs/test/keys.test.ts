import { test } from "node:test";
import assert from "node:assert/strict";
import { keyToSegments, encodeSegment, decodeSegment, BadKeyError, OBJECT_SUFFIX } from "../src/keys.ts";

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

test("long segments hash to ≤255-byte names without colliding", () => {
  const long1 = "x".repeat(400), long2 = "x".repeat(399) + "y";
  const [n1] = keyToSegments(long1), [n2] = keyToSegments(long2);
  assert.ok(Buffer.byteLength(n1!) <= 255 && Buffer.byteLength(n2!) <= 255);
  assert.notEqual(n1, n2);
  // a short key can never produce a hashed-looking name: `~` is always escaped
  assert.equal(encodeSegment("a~b"), "a%7eb");
});

test("an object and a folder of the same name coexist (`a` and `a/b`)", () => {
  const file = keyToSegments("a"), nested = keyToSegments("a/b");
  assert.notEqual(file[0], nested[0]);
});

test("decodeSegment inverts encodeSegment for short segments", () => {
  for (const s of ["Hello World.mp4", "ünïcødé", "CON", "a~b", "trailing.", "%41"]) assert.equal(decodeSegment(encodeSegment(s)), s);
  assert.equal(decodeSegment(encodeSegment("z".repeat(300))), null);
});
