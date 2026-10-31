// Bringing in a teammate's `.cbproj` (§13), as the Cardboard adapter's bringInTheirChanges does through Carton: the
// answer carries everything the app needs (e2e-qa's S3-3: Carton.importShallow used to drop `newProjectId` and `head`).
import { test } from "node:test";
import assert from "node:assert/strict";
import { Carton } from "@carton/core";
import { createMemoryStore } from "../src/index.ts";
import { adapter, doc0, set } from "./fixture.ts";

test("S3-3: a same-id project with no shared lineage is offered a new project id", async () => {
  const x = await Carton.open({ adapter, store: createMemoryStore(), init: { doc: doc0(), projectId: "proj-1" } });
  const y = await Carton.open({ adapter, store: createMemoryStore(), init: { doc: doc0(), projectId: "proj-1" } });
  await y.commit({ ops: [set("a", "name", "y's")] });
  const r = await x.importShallow(await y.exportShallow({ to: "x" }));
  assert.equal(r.status, "no-shared-lineage");
  assert.match(r.status === "no-shared-lineage" ? r.newProjectId : "", /^[0-9a-f]{8,}$/, JSON.stringify(r));
  for (const c of [x, y]) await c.close();
});

test("S3-3: a related file reports the head it brought, which the fold then takes in", async () => {
  const a = await Carton.open({ adapter, store: createMemoryStore(), init: { doc: doc0(), projectId: "proj-2" } });
  const b = await Carton.open({ adapter, store: createMemoryStore(), init: { import: await a.exportShallow({ to: "b" }) } });
  await b.commit({ ops: [set("b", "name", "b's edit")] });
  const r = await a.importShallow(await b.exportShallow({ to: "a" }));
  assert.equal(r.status, "imported");
  const head = r.status === "imported" ? r.head : "";
  assert.match(head, /@\d+$/);
  assert.equal((await a.fold(head, { into: a.cut })).status, "confirmed");
  assert.equal(((await a.head()).doc.items as { id: string; name: string }[]).find((i) => i.id === "b")!.name, "b's edit");
  for (const c of [a, b]) await c.close();
});
