// Pins are read again only when they changed (windows-sync R1): every pin row write carries a new token (meta
// ["pinsGen"]) conditioned on the one the writer holds, and a refresh reads that one key instead of the whole pins
// table, which gains a row per print of a shared file. A compaction reads the pins whatever the token says.
import { test } from "node:test";
import assert from "node:assert/strict";
import { Carton, StateUnknown, type Actor, type Doc, type Rec, type Store } from "@carton/core";
import type { StoreRange } from "@carton/core/plugins";
import { createMemoryData, createMemoryStore } from "../src/index.ts";
import { adapter, doc0, item, set } from "./fixture.ts";

const alice: Actor = { kind: "human", id: "alice" },
  bob: Actor = { kind: "human", id: "bob" };
const edit = (d: Doc, id: string, v: string): Doc => ({ ...d, items: (d.items as Rec[]).map((i) => (i.id === id ? { ...i, name: v } : i)) });

/** `store` with a count of whole reads of the pins table and of point reads of the pins token. */
function counted(store: Store) {
  const n = { pins: 0, token: 0 };
  const s = new Proxy(store, {
    get(t, p, rcv) {
      const v = Reflect.get(t, p, rcv);
      if (p === "range")
        return (table: string, r?: StoreRange) => {
          if (table === "pins") n.pins++;
          return (v as Store["range"]).call(t, table as never, r);
        };
      if (p === "get")
        return (table: string, key: unknown[]) => {
          if (table === "meta" && key[0] === "pinsGen") n.token++;
          return (v as Store["get"]).call(t, table as never, key as never);
        };
      return typeof v === "function" ? v.bind(t) : v;
    },
  }) as Store;
  return { store: s, n };
}

test("1,000 pins: head() reads the pins token, one key, and never the pins table while no pin changes", async () => {
  const k = counted(createMemoryStore());
  const c = await Carton.open({ adapter, store: k.store, init: { doc: doc0() }, actor: alice });
  const d = (await c.head()).doc;
  for (let i = 0; i < 1000; i++) await c.pin({ owner: `print-${i}`, doc: edit(d, "a", `draft ${i}`) });
  assert.equal(k.n.pins, 1, "the pins table was read once, at open: each pin of this handle's own kept its snapshot");
  k.n.pins = k.n.token = 0;
  for (let i = 0; i < 10; i++) await c.head();
  assert.deepEqual(k.n, { pins: 0, token: 10 });
  await c.close();
});

test("another process's pin and release are seen at the next call, which reads the pins table once", async () => {
  const data = createMemoryData();
  const a = await Carton.open({ adapter, store: createMemoryStore({ shared: data }), init: { doc: doc0() }, actor: alice });
  const kb = counted(createMemoryStore({ shared: data }));
  const b = await Carton.open({ adapter, store: kb.store, actor: bob });
  await b.head();
  kb.n.pins = 0;
  const pa = await a.pin({ owner: "turn-a", doc: edit((await a.head()).doc, "a", "draft") });
  assert.equal(item(await b.checkout(pa.header), "a")!.name, "draft", "B sees A's pin");
  assert.equal(kb.n.pins, 1);
  await b.head();
  assert.equal(kb.n.pins, 1, "not again while nothing changed");
  await a.release(pa.ref, "turn-a");
  await assert.rejects(b.checkout(pa.header), (e: unknown) => e instanceof StateUnknown, "B sees the release");
  assert.equal(kb.n.pins, 2);
  for (const x of [a, b]) await x.close();
});

test("a pin another process wrote after this handle read the pins: this handle's pin write fails on the token, reads them again, and both pins stay", async () => {
  const data = createMemoryData();
  const ka = counted(createMemoryStore({ shared: data }));
  const a = await Carton.open({ adapter, store: ka.store, init: { doc: doc0() }, actor: alice });
  const b = await Carton.open({ adapter, store: createMemoryStore({ shared: data }), actor: bob });
  const d = (await a.head()).doc;
  const pb = await b.pin({ owner: "view-b", doc: edit(d, "a", "B's draft") });
  ka.n.pins = 0;
  const pa = await a.pin({ owner: "turn-a", doc: edit(d, "b", "A's draft") });
  assert.ok(ka.n.pins >= 1, "A read the pins again");
  assert.equal((await createMemoryStore({ shared: data }).range("pins")).length, 2, "both pin rows are stored");
  assert.equal(item(await a.checkout(pb.header), "a")!.name, "B's draft", "A holds B's pin");
  assert.equal(item(await b.checkout(pa.header), "b")!.name, "A's draft", "B holds A's pin");
  for (const x of [a, b]) await x.close();
});

test("a compaction reads the pins whatever the token says: a version pinned by a writer that left the token as it was is kept", async () => {
  const data = createMemoryData();
  const raw = createMemoryStore({ shared: data });
  const a = await Carton.open({ adapter, store: createMemoryStore({ shared: data }), init: { doc: doc0() }, actor: alice });
  for (let i = 1; i <= 120; i++) await a.commit({ ops: [set("b", "name", `b ${i}`)] }); // the newest 64 are never squashed
  await a.head(); // A has read the pins (none) and the token
  const token = await raw.get<string>("meta", ["pinsGen"]);
  const b = await Carton.open({ adapter, store: createMemoryStore({ shared: data }), actor: bob });
  const pb = await b.pin({ owner: "view-b", seq: 5 });
  // a core from before the token writes the pin row alone: put the token back as A last read it
  await raw.write([{ table: "meta", key: ["pinsGen"], value: token }]);
  await a.head();
  const { squashed } = await a.compact({ olderThanDays: 0 });
  assert.ok(squashed > 0, "the compaction squashed versions");
  const row = await raw.get<{ squashedInto?: number }>("changes", [a.cut, 5]);
  assert.equal(row?.squashedInto, undefined, "the pinned version is not squashed");
  assert.equal(item(await b.checkout(pb.header), "b")!.name, "b 5");
  for (const x of [a, b]) await x.close();
});

test("a release right after this handle's own pin needs no read of the pins: the pin's write left the snapshot and the token current", async () => {
  const k = counted(createMemoryStore());
  const c = await Carton.open({ adapter, store: k.store, init: { doc: doc0() }, actor: alice });
  const p = await c.pin({ owner: "turn", doc: edit((await c.head()).doc, "a", "draft") });
  k.n.pins = 0;
  await c.release(p.ref, "turn");
  assert.equal(k.n.pins, 0);
  await assert.rejects(c.checkout(p.header), (e: unknown) => e instanceof StateUnknown);
  assert.equal((await k.store.range("pins")).length, 0, "the row is gone from the store");
  await c.close();
});
