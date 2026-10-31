import { test } from "node:test";
import assert from "node:assert/strict";
import * as core from "../src/index.ts";
import type { Store } from "../src/plugins.ts";

test("the core entry point loads under type stripping", () => {
  assert.equal(typeof core.Carton.open, "function");
  assert.equal(core.POS, "#pos");
});

test("canonical JSON sorts keys and drops undefined members", () => {
  assert.equal(core.canonical({ b: 1, a: [undefined, "x"], c: undefined }), '{"a":[null,"x"],"b":1}');
});

test("defineSchema indexes field groups", () => {
  const s = core.defineSchema({ collections: { items: { groups: [{ name: "time", fields: ["start", "end"] }] } } });
  assert.equal(s.collections.items!.groupOf.get("end")?.name, "time");
  assert.equal(s.collections.items!.key, "id");
});

test("plug-in types are importable", () => {
  const s: Partial<Store> = { info: { kind: "x", persistent: false, multiProcess: false } };
  assert.equal(s.info?.kind, "x");
});

test("the portable SHA-256 (computed constants) matches node:crypto, including multi-block and non-ASCII input", async () => {
  const { createHash } = await import("node:crypto");
  for (const s of ["", "abc", "a".repeat(55), "a".repeat(56), "a".repeat(64), "x".repeat(1000), "clip ✂ 'Intro' — 日本語 🎬"]) assert.equal(core.portableSha256Hex(s), createHash("sha256").update(s).digest("hex"), JSON.stringify(s).slice(0, 20));
});

test("describe() uses the schema's field labels and collection nouns, and words unlabelled fields as before", () => {
  const fields = { colorGrade: core.object(), effects: core.keyed("id", { amount: core.scalar }) };
  const plain = core.defineSchema({ collections: { items: { fields } } });
  const worded = core.defineSchema({
    labels: { aspectRatio: "aspect ratio" },
    collections: { items: { fields, noun: "clip", labels: { "colorGrade.saturation": "saturation", effects: "effect", "effects.amount": "effect amount" } } },
  });
  const base = { aspectRatio: "16:9", items: [{ id: "a", name: "Intro", colorGrade: { saturation: 0.8 }, effects: [{ id: "e1", amount: 1 }] }] };
  const ops: core.Op[] = [
    { op: "set", path: ["aspectRatio"], value: "9:16" },
    { op: "set", path: ["items", "a", "colorGrade", "saturation"], value: 1 },
    { op: "set", path: ["items", "a", "effects", "e1", "amount"], value: 2 },
    { op: "insert", path: ["items", "b"], value: { id: "b", name: "Outro" } },
  ];
  assert.deepEqual(core.describe(ops, base, worded), [
    'Changed the aspect ratio "16:9" → "9:16"',
    "Changed 'Intro' saturation 0.8 → 1, effect amount 1 → 2",
    "Added clip 'Outro'",
  ]);
  assert.deepEqual(core.describe(ops, base, plain), [
    'Changed aspectRatio "16:9" → "9:16"',
    "Changed 'Intro' colorGrade.saturation 0.8 → 1, effects.e1.amount 1 → 2",
    "Added item 'Outro'",
  ]);
});
