// Sealed collection arrays (engine/doc.ts): Carton freezes a state's records once before handing the state out, and
// apply keeps a sealed array sealed by freezing only what it writes into it, so a repeat head() costs one fork.
import test from "node:test";
import assert from "node:assert/strict";
import { defineSchema } from "../src/schema.ts";
import { apply, fork } from "../src/engine/index.ts";
import { forkSealed, isSealed, seal } from "../src/engine/doc.ts";
import type { Doc, Rec } from "../src/types.ts";

const schema = defineSchema({ collections: { items: { key: "id" } } });
const docOf = (): Doc => ({ items: [{ id: "a", name: "a", style: { color: "red" } }, { id: "b", name: "b" }], title: { text: "t" } }) as unknown as Doc;
const items = (d: Doc) => d.items as Rec[];

test("seal: every record frozen deep, once; apply into a sealed array freezes what it writes and nothing else changes", () => {
  const d = docOf();
  seal(items(d));
  assert.ok(isSealed(items(d)));
  assert.ok(items(d).every((r) => Object.isFrozen(r)));
  assert.ok(Object.isFrozen((items(d)[0] as Rec & { style: object }).style));
  // an insert, a whole-record set and a nested field edit: the array stays sealed, the new records are frozen
  const value = { id: "c", name: "c", meta: { n: 1 } };
  apply(d, [{ op: "insert", path: ["items", "c"], value }, { op: "set", path: ["items", "b"], value: { id: "b", name: "b2" } }, { op: "set", path: ["items", "a", "style", "color"], value: "blue" }], schema);
  assert.ok(isSealed(items(d)));
  assert.ok(items(d).every((r) => Object.isFrozen(r) && Object.values(r).every((v) => v === null || typeof v !== "object" || Object.isFrozen(v))));
  assert.equal((items(d).find((r) => r.id === "a") as Rec & { style: { color: string } }).style.color, "blue");
  assert.ok(Object.isFrozen(value), "the inserted value is the record itself: frozen with it");
  // apply is still a total function on a sealed doc: a remove works (swap-remove of the array, not the records)
  apply(d, [{ op: "remove", path: ["items", "b"] }], schema);
  assert.deepEqual(items(d).map((r) => r.id).sort(), ["a", "c"]);
});

test("seal: a fork isn't sealed and apply never freezes a caller's own doc", () => {
  const d = docOf();
  seal(items(d));
  const f = fork(d, schema);
  assert.equal(isSealed(items(f)), false, "fork doesn't pass the seal on");
  const value = { id: "c", name: "c" };
  apply(f, [{ op: "insert", path: ["items", "c"], value }, { op: "set", path: ["items", "b", "name"], value: "b2" }], schema);
  assert.equal(Object.isFrozen(value), false);
  assert.equal(Object.isFrozen(items(f).find((r) => r.id === "b")), false, "the path copy of b in the fork");
  assert.ok(Object.isFrozen(items(d).find((r) => r.id === "b")), "the sealed original's b is untouched and frozen");
  assert.equal(items(d).find((r) => r.id === "b")!.name, "b");
  // a doc nobody sealed: apply as before
  const plain = docOf();
  apply(plain, [{ op: "set", path: ["items", "a", "name"], value: "x" }], schema);
  assert.equal(Object.isFrozen(items(plain)[0]), false);
});

test("forkSealed: core's own rebuild of a sealed state stays sealed (apply freezes what it writes); a plain doc's doesn't", () => {
  const d = docOf();
  seal(items(d));
  const next = apply(forkSealed(d, schema), [{ op: "insert", path: ["items", "c"], value: { id: "c", tags: ["x"] } }], schema);
  assert.ok(isSealed(items(next)));
  assert.ok(items(next).every((r) => Object.isFrozen(r)));
  assert.ok(Object.isFrozen((items(next).find((r) => r.id === "c") as Rec & { tags: string[] }).tags));
  const plain = forkSealed(docOf(), schema);
  assert.equal(isSealed(items(plain)), false);
});
