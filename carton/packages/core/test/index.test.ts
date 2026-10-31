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
