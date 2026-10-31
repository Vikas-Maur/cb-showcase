// Regression tests for the GPT 6.1 Sol review round 4 findings (carton-build/reviews/foundation-core.md).
import { test } from "node:test";
import assert from "node:assert/strict";
import { Carton, type Actor } from "@carton/core";
import type { Store, StoreRange } from "@carton/core/plugins";
import { createMemoryData, createMemoryStore } from "../src/index.ts";
import { adapter, doc0, set, item } from "./fixture.ts";

const alice: Actor = { kind: "human", id: "alice", group: "alice@laptop" };

test("R4-1 a real confirmation can't land under an id another process just recorded as a no-op", async () => {
  const data = createMemoryData();
  const inner = createMemoryStore({ shared: data });
  // b's store: on its first write of a change, the original's no-op record for the same id lands just before it
  // (the original ran between b's refresh and b's write)
  let injected = false;
  const racy: Store = {
    ...inner,
    info: inner.info,
    get: inner.get,
    range: inner.range,
    close: inner.close,
    write: async (w, c) => {
      if (!injected && w.some((x) => x.table === "changes")) {
        injected = true;
        await inner.write([{ table: "meta", key: ["noop", "cb.undo.1"], value: [cutId, 0] }]);
      }
      return inner.write(w, c);
    },
  };
  const a = await Carton.open({ adapter, store: createMemoryStore({ shared: data }), init: { doc: doc0() }, actor: alice });
  const cutId = a.cut;
  await a.commit({ ops: [set("a", "name", "later edit")] });
  const b = await Carton.open({ adapter, store: racy, actor: alice });
  const r = await b.undo(undefined, { id: "cb.undo.1" });
  assert.ok(r.status === "confirmed" && r.empty, "the retry sees the no-op and does nothing");
  assert.equal(item((await a.head()).doc, "a")!.name, "later edit", "the later edit is not undone");
  assert.equal((await a.log()).length, 2);
});

test("R4-2 publish a variant another process made, by id or by header; its source is the variant's full id", async () => {
  const data = createMemoryData();
  const a = await Carton.open({ adapter, store: createMemoryStore({ shared: data }), init: { doc: doc0() }, actor: alice });
  const b = await Carton.open({ adapter, store: createMemoryStore({ shared: data }), actor: alice });
  const v = await a.fork("variant");
  const byId = await b.publish({ from: v.id });
  assert.equal(byId.source, v.id);
  await a.commit({ cut: v.id, ops: [set("a", "name", "v1")] });
  const p = await a.pin({ owner: "x", cut: v.id });
  const c = await Carton.open({ adapter, store: createMemoryStore({ shared: data }), actor: alice });
  const byHeader = await c.publish({ from: p.header });
  assert.equal(byHeader.source, v.id);
  await a.commit({ cut: v.id, ops: [set("a", "name", "v2")] });
  assert.equal((await c.publications()).find((x) => x.cut.id === byHeader.id)!.newer, true);
});

test("R4-3 a rebuild keeps a Published cut's source", async () => {
  const data = createMemoryData();
  const a = await Carton.open({ adapter, store: createMemoryStore({ shared: data }), init: { doc: doc0() }, actor: alice });
  const b = await Carton.open({ adapter, store: createMemoryStore({ shared: data }), actor: alice });
  const v = await a.fork("variant");
  const pub = await a.publish({ from: v.id });
  await b.fork("another"); // a's next refresh sees a new cut and rebuilds
  const list = await a.publications();
  assert.equal(list.find((x) => x.cut.id === pub.id)!.source, v.id);
});

test("R4-4 a refresh doesn't reread the no-op ids", async () => {
  const inner = createMemoryStore();
  let noopScans = 0;
  const counting: Store = {
    ...inner,
    info: inner.info,
    get: inner.get,
    write: inner.write,
    close: inner.close,
    range: (t: string, r?: StoreRange) => {
      if (t === "meta" && r?.prefix?.[0] === "noop") noopScans++;
      return inner.range(t, r);
    },
  };
  const c = await Carton.open({ adapter, store: counting, init: { doc: doc0() }, actor: alice });
  for (let i = 0; i < 5; i++) await c.commit({ doc: (await c.head()).doc, id: `cb.same.${i}` });
  const before = noopScans;
  for (let i = 0; i < 10; i++) await c.head();
  assert.equal(noopScans, before, "head() reads no no-op table");
});
