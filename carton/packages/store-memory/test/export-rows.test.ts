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

test("request 9: export rows are read at load and before an export, not by head() or a commit", async () => {
  const mem = createMemoryStore();
  let reads = 0;
  const s = new Proxy(mem, {
    get(t, p, r) {
      const v = Reflect.get(t, p, r);
      if (p !== "range") return typeof v === "function" ? v.bind(t) : v;
      return (table: string, o?: { prefix?: unknown[] }) => {
        if (o?.prefix?.[0] === "export") reads++;
        return (v as Store["range"]).call(t, table as never, o as never);
      };
    },
  }) as Store;
  const c = await Carton.open({ adapter, store: s, init: { doc: doc0() }, actor: alice });
  const atLoad = reads;
  assert.ok(atLoad >= 1, "read at load");
  for (let i = 0; i < 3; i++) {
    await c.commit({ ops: [set("a", "name", `n${i}`)] });
    await c.head();
  }
  assert.equal(reads, atLoad, "no export-row read on commit or head()");
  await c.exportShallow({ to: "bob" });
  assert.equal(reads, atLoad + 1, "one read before the export");
  await c.close();
});
