// local-cli request 8 (e2e-qa S3-4, cardboard-adapter's core-only repro): a project made with `init.asChange` (§16)
// is the empty root plus the import change (main@1). A shallow `.cbproj` compresses a cut's lineage to its root, forks,
// merges and exports, so a copy's file named only the empty root as shared, and the fold started from nothing: a
// record both copies hold, changed by one, came back as a card with no base. The import is a lineage point now: the
// export carries it (its state too), and two copies fold from it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { Carton, type ShallowExport } from "@carton/core";
import { createMemoryStore } from "../src/index.ts";
import { adapter, doc0, item, set } from "./fixture.ts";
import { copyStore } from "./world.ts";

const alice = { kind: "human" as const, id: "alice" },
  bob = { kind: "human" as const, id: "bob" };
const importNode = (pkg: ShallowExport) => pkg.nodes.find((n) => n.kinds.includes("import"));

test("a copy of an asChange project folds its edit of an imported record in cleanly: the export carries the import", async () => {
  const sa = createMemoryStore();
  const a = await Carton.open({ adapter, store: sa, init: { doc: doc0(), asChange: true }, actor: alice });
  const main = a.cut;
  // bob's folder is a copy of alice's, carton.db included
  const b = await Carton.open({ adapter, store: await copyStore(sa), actor: bob });
  await b.commit({ ops: [set("a", "name", "Bob's a")] });
  await a.commit({ ops: [set("b", "name", "Alice's b")] });
  const pkg = await b.exportShallow({ to: "alice" });
  const imp = importNode(pkg);
  assert.equal(imp?.id, `${main}@1`, `the import is in the file: ${JSON.stringify(pkg.nodes.map((n) => [n.seq, n.kinds]))}`);
  assert.ok(pkg.states[imp!.hash], "with its state");
  assert.ok(pkg.nodes.find((n) => n.kinds.includes("head"))!.parents.some((p) => p.id === imp!.id), "the head's edge goes to the import, not the empty root");
  const r = await a.importShallow(pkg);
  assert.equal(r.status, "imported");
  const f = await a.fold(r.status === "imported" ? r.head : "", { into: main });
  assert.equal(f.status, "confirmed", JSON.stringify(f).slice(0, 400));
  const d = (await a.head()).doc;
  assert.deepEqual([item(d, "a")!.name, item(d, "b")!.name], ["Bob's a", "Alice's b"]);
  for (const c of [a, b]) await c.close();
});

test("the import is a lineage point in every project made with asChange, old ones too (judged by the change's kind)", async () => {
  const s = createMemoryStore();
  const a = await Carton.open({ adapter, store: s, init: { doc: doc0(), asChange: true } });
  await a.close();
  const again = await Carton.open({ adapter, store: s });
  for (let i = 0; i < 3; i++) await again.commit({ ops: [set("c", "name", `c${i}`)] });
  const pkg = await again.exportShallow({ to: "x" });
  assert.deepEqual(pkg.nodes.map((n) => [n.seq, n.kinds.sort()]).sort((x, y) => (x[0] as number) - (y[0] as number)), [[0, ["root"]], [1, ["import"]], [4, ["export", "head"]]]);
  await again.close();
});

test("a project made without asChange exports as before (no import node)", async () => {
  const a = await Carton.open({ adapter, store: createMemoryStore(), init: { doc: doc0() } });
  await a.commit({ ops: [set("a", "name", "x")] });
  const pkg = await a.exportShallow({ to: "x" });
  assert.equal(importNode(pkg), undefined);
  assert.deepEqual(pkg.nodes.map((n) => n.seq).sort(), [0, 1]);
  await a.close();
});
