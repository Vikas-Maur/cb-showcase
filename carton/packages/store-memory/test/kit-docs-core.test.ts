// Core issues kit-docs found while writing the integration kit (notes/kit-docs.md, "Found while writing the kit"):
// head() handed out History's own records; commit refused a node-id base; a split's lineage-only intent was dropped
// when a commit was rebased.
import { test } from "node:test";
import assert from "node:assert/strict";
import { Carton, type Rec } from "@carton/core";
import * as E from "@carton/core";
import { createMemoryStore } from "../src/index.ts";
import { adapter, clip, doc0, item, set } from "./fixture.ts";
import { copyStore, until, world } from "./world.ts";

test("kit-docs: head() hands out its own arrays and frozen records: an in-place edit throws instead of corrupting History", async () => {
  const c = await Carton.open({ adapter, store: createMemoryStore(), init: { doc: doc0() } });
  await c.commit({ ops: [set("a", "name", "first")] });
  const { doc } = await c.head();
  // before: this changed History's head too, and the commit below diffed as empty ("confirmed", empty: true)
  assert.throws(() => (item(doc, "a")!.name = "in place"), TypeError);
  assert.throws(() => ((item(doc, "a") as Rec & { style?: unknown }).style = { color: "red" }), TypeError);
  // the arrays are the caller's: replace the record you change, add or remove freely
  const items = doc.items as Rec[];
  items[items.findIndex((r) => r.id === "a")] = { ...item(doc, "a")!, name: "replaced" };
  items.push(clip("g", 30, 35));
  assert.equal(item((await c.head()).doc, "a")!.name, "first", "History's head is untouched");
  const r = await c.commit({ doc });
  assert.equal(r.status, "confirmed");
  assert.equal(r.status === "confirmed" && r.empty, undefined, "the edit is saved, not found empty");
  const after = (await c.head()).doc;
  assert.deepEqual([item(after, "a")!.name, !!item(after, "g")], ["replaced", true]);
  // checkout and resolve hand out the same way
  const out = await c.checkout(`${c.cut}@1`),
    resolved = (await c.resolve(`${c.cut}@1`)).doc;
  assert.throws(() => (item(out, "a")!.name = "x"), TypeError);
  assert.throws(() => (item(resolved, "a")!.name = "x"), TypeError);
  assert.equal(item(await c.checkout(`${c.cut}@1`), "a")!.name, "first");
  await c.close();
});

test("kit-docs: records stay frozen across commits after the first head() (sealed once, kept by apply); the caller's copy is theirs", async () => {
  const c = await Carton.open({ adapter, store: createMemoryStore(), init: { doc: doc0() } });
  const first = (await c.head()).doc;
  // later changes write into the sealed live head: a new record, a whole record, a nested field
  await c.commit({ ops: [{ op: "insert", path: ["items", "g"], value: clip("g", 30, 35) }] });
  await c.commit({ ops: [set("a", "name", "second")] });
  await c.commit({ ops: [{ op: "set", path: ["items", "b", "style"], value: { color: "red" } }] });
  const { doc } = await c.head();
  for (const r of doc.items as Rec[]) {
    assert.ok(Object.isFrozen(r), `record ${r.id} frozen`);
    for (const v of Object.values(r)) if (v && typeof v === "object") assert.ok(Object.isFrozen(v), `record ${r.id}'s nested value frozen`);
  }
  assert.notEqual(doc.items, first.items, "each call hands out its own arrays");
  // the caller's arrays are theirs, and applying ops to their copy doesn't freeze what they write
  const mine = E.apply(doc, [{ op: "insert", path: ["items", "h"], value: clip("h", 40, 45) }], adapter.schema);
  const h = item(mine, "h")!;
  assert.equal(Object.isFrozen(h), false);
  h.name = "edited in place: my own record";
  assert.equal(item((await c.head()).doc, "h"), undefined);
  await c.close();
});

test("kit-docs: a shared cut's head is handed out the same way: the queue's optimistic state stays as it was", async () => {
  const w = world();
  const a = await Carton.open({ adapter, store: createMemoryStore(), init: { doc: doc0() }, sync: w.sync("alice") });
  await a.share();
  await until(async () => (await a.cuts())[0]!.sequencer.kind === "server", 5000, "the hand-off");
  await a.commit({ ops: [set("a", "name", "first")], wait: 5000 });
  const { doc } = await a.head();
  assert.throws(() => (item(doc, "a")!.name = "in place"), TypeError);
  assert.equal(item((await a.head()).doc, "a")!.name, "first");
  // the queue rebuilds its states as changes come (a pending edit offline, then its confirmation): still frozen
  const frozen = (d: typeof doc) => (d.items as Rec[]).every((r) => Object.isFrozen(r) && Object.values(r).every((v) => !v || typeof v !== "object" || Object.isFrozen(v)));
  await a.sync!.disconnect();
  const p = await a.commit({ ops: [{ op: "insert", path: ["items", "g"], value: clip("g", 30, 35) }, { op: "set", path: ["items", "b", "style"], value: { color: "red" } }] });
  assert.equal(p.status, "pending");
  assert.ok(frozen((await a.head()).doc), "the optimistic head, with the pending edit");
  await a.sync!.connect({ nonce: "back" });
  assert.equal((await a.sync!.waitFor(p.status === "pending" ? p.id : "", 5000)).status, "confirmed");
  assert.ok(frozen((await a.head()).doc), "after the confirmation");
  assert.ok(item((await a.head()).doc, "g"));
  await a.close();
  w.host.close();
});

test("kit-docs: commit takes a node id `<cutId>@<seq>` as its base, as checkout, diff and restore do", async () => {
  const c = await Carton.open({ adapter, store: createMemoryStore(), init: { doc: doc0() } });
  await c.commit({ ops: [set("a", "name", "newer")] });
  // made on version 0 (a stale base): merged onto the head, the newer edit kept
  const r = await c.commit({ base: `${c.cut}@0`, ops: [set("b", "name", "from v0")] });
  assert.equal(r.status, "confirmed", JSON.stringify(r));
  const d = (await c.head()).doc;
  assert.deepEqual([item(d, "a")!.name, item(d, "b")!.name], ["newer", "from v0"]);
  await c.close();
});

// c (10–15) split at 12.5 into c (10–12.5) and c-b (12.5–15): a split records lineage only, no remap
const split = [
  set("c", "endTime", 12.5),
  set("c", "trimEnd", 2.5),
  { op: "insert" as const, path: ["items", "c-b"], value: { ...clip("c-b", 12.5, 15), trimStart: 2.5, trimEnd: 5, name: "c" } },
];
const splitIntent = { kind: "split", lineage: { c: ["c", "c-b"] } };
const colors = (d: Parameters<typeof item>[0]) => [(item(d, "c") as Rec & { color?: string }).color, (item(d, "c-b") as (Rec & { color?: string }) | undefined)?.color];

for (const first of ["split", "color"] as const)
  test(`kit-docs: a concurrent edit to a split clip reaches both pieces when the ${first === "split" ? "edit" : "split"} is rebased`, async () => {
    const c = await Carton.open({ adapter, store: createMemoryStore(), init: { doc: doc0() } });
    const base = `${c.cut}@0`;
    const doSplit = () => c.commit({ base, ops: split, intent: splitIntent });
    const doColor = () => c.commit({ base, ops: [set("c", "color", "red")] });
    for (const step of first === "split" ? [doSplit, doColor] : [doColor, doSplit]) assert.equal((await step()).status, "confirmed");
    assert.deepEqual(colors((await c.head()).doc), ["red", "red"]);
    await c.close();
  });

test("kit-docs: on a shared cut too: an offline color edit rebased over a teammate's split reaches both pieces", async () => {
  const w = world();
  const sa = createMemoryStore();
  const a = await Carton.open({ adapter, store: sa, init: { doc: doc0() }, sync: w.sync("alice") });
  await a.share();
  await until(async () => (await a.cuts())[0]!.sequencer.kind === "server", 5000, "the hand-off");
  const b = await Carton.open({ adapter, store: await copyStore(sa), sync: w.sync("bob") });
  await until(() => b.sync!.status === "up-to-date", 5000, "bob connected");
  await b.sync!.disconnect();
  const color = await b.commit({ ops: [set("c", "color", "red")] });
  assert.equal(color.status, "pending");
  assert.equal((await a.commit({ ops: split, intent: splitIntent, wait: 5000 })).status, "confirmed");
  await b.sync!.connect({ nonce: "back" });
  assert.equal((await b.sync!.waitFor(color.status === "pending" ? color.id : "", 5000)).status, "confirmed");
  for (const x of [a, b]) await until(async () => colors((await x.head()).doc).join() === "red,red", 5000, "both pieces red");
  for (const x of [a, b]) await x.close();
  w.host.close();
});
