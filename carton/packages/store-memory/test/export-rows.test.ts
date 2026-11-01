// local-cli request 9 (Stage G round 3 #1): every exported version is a lineage point (R4-01), but a handle read the
// export rows (meta ["export", …]) only when it loaded. A long-lived handle (the app's) never learnt of a `.cbproj`
// another process sent (`cb`), so its own later `.cbproj` left that version out, and a teammate who had only it folded
// from an older shared node. The rows are read again before each export now, not on every refresh.
import { test } from "node:test";
import assert from "node:assert/strict";
import { Carton, type Store } from "@carton/core";
import { createMemoryStore } from "../src/index.ts";
import { adapter, doc0, item, set } from "./fixture.ts";

const alice = { kind: "human" as const, id: "alice" },
  bob = { kind: "human" as const, id: "bob" };

test("request 9: a handle's .cbproj carries a version another process exported after this handle loaded", async () => {
  const s = createMemoryStore();
  const app = await Carton.open({ adapter, store: s, init: { doc: doc0() }, actor: alice });
  const cb = await Carton.open({ adapter, store: s, actor: alice });
  assert.equal((await app.commit({ ops: [set("a", "name", "v1")] })).status, "confirmed");
  // a `cb` process sends a .cbproj of version 1: a lineage point from now on
  const sent = await cb.exportShallow({ to: "bob" });
  assert.equal(sent.head, `${app.cut}@1`);
  assert.equal((await app.commit({ ops: [set("b", "name", "v2")] })).status, "confirmed");
  const pkg = await app.exportShallow({ to: "carol" });
  const v1 = pkg.nodes.find((n) => n.id === sent.head);
  assert.ok(v1?.kinds.includes("export"), `the app's .cbproj carries the version cb sent: ${JSON.stringify(pkg.nodes.map((n) => [n.id, n.kinds]))}`);
  assert.ok(pkg.states[v1!.hash], "with its state");
  // bob has only what cb sent; the app's file folds into it from version 1, not from the empty root
  const b = await Carton.open({ adapter, store: createMemoryStore(), init: { import: sent }, actor: bob });
  await b.commit({ ops: [set("a", "name", "Bob's a")] });
  const r = await b.importShallow(pkg);
  assert.equal(r.status, "imported");
  const f = await b.fold(r.status === "imported" ? r.head : "", {});
  assert.equal(f.status, "confirmed", JSON.stringify(f).slice(0, 300));
  const d = (await b.head()).doc;
  assert.deepEqual([item(d, "a")!.name, item(d, "b")!.name], ["Bob's a", "v2"]);
  for (const c of [cb, app, b]) await c.close();
});

test("request 9: all export rows are read once, at load; before a write only the export index rows after the newest seen; head() reads neither", async () => {
  const mem = createMemoryStore();
  const reads = { all: 0, index: 0, indexRows: 0 };
  const s = new Proxy(mem, {
    get(t, p, r) {
      const v = Reflect.get(t, p, r);
      if (p !== "range") return typeof v === "function" ? v.bind(t) : v;
      return async (table: string, o?: { prefix?: unknown[]; gt?: unknown[] }) => {
        const out = await (v as Store["range"]).call(t, table as never, o as never);
        if (o?.prefix?.[0] === "export") reads.all++;
        if (o?.prefix?.[0] === "exported" && o.gt) (reads.index++, (reads.indexRows += out.length));
        return out;
      };
    },
  }) as Store;
  const c = await Carton.open({ adapter, store: s, init: { doc: doc0() }, actor: alice });
  const cb = await Carton.open({ adapter, store: mem, actor: alice });
  const atLoad = reads.all;
  assert.ok(atLoad >= 1, "read at load");
  for (let i = 0; i < 3; i++) {
    await c.commit({ ops: [set("a", "name", `n${i}`)] });
    await c.head();
  }
  assert.equal(reads.index, 3, "one index read per write, none for head()");
  assert.equal(reads.indexRows, 0, "nothing new");
  await cb.exportShallow({ to: "bob" });
  await c.commit({ ops: [set("b", "name", "after cb's export")] });
  assert.equal(reads.indexRows, 1, "cb's export, once");
  await c.exportShallow({ to: "carol" });
  await c.commit({ ops: [set("b", "name", "after its own export")] });
  assert.equal(reads.indexRows, 1, "its own export isn't read back");
  assert.equal(reads.all, atLoad, "no full read after load");
  for (const x of [cb, c]) await x.close();
});

test("request 9: a long-lived handle's compaction keeps a version another process exported", async () => {
  let now = Date.UTC(2026, 0, 1);
  const clock = () => now;
  const s = createMemoryStore();
  const app = await Carton.open({ adapter, store: s, init: { doc: doc0() }, actor: alice, clock, keyframeEvery: 4 });
  const cb = await Carton.open({ adapter, store: s, actor: alice, clock, keyframeEvery: 4 });
  for (let i = 1; i <= 3; i++) await app.commit({ ops: [set("a", "name", `a ${i}`)] });
  const sent = await cb.exportShallow({ to: "bob" });
  assert.equal(sent.head, `${app.cut}@3`);
  for (let i = 4; i <= 12; i++) await app.commit({ ops: [set("a", "name", `a ${i}`)] });
  now += 120 * 86_400_000;
  await app.compact({ olderThanDays: 90 });
  assert.equal(item(await app.checkout(sent.head), "a")!.name, "a 3", "the exported version is still held");
  for (const x of [cb, app]) await x.close();
});
