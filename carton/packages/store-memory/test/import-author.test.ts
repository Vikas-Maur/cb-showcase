// ui-words: the project's import is recorded as the system's (`{kind: "system", id: "import"}`; its hash covers it), but
// the person whose project it was made it. log() and credits() tell it as this replica's person (the generic one, or
// setIdentity's), summarised as "Imported the project". A teammate who joined the project from an invite holds the
// sharer's import: told as recorded there (History shows no name for it), never as the teammate.
import { test } from "node:test";
import assert from "node:assert/strict";
import { Carton, PERSON, hashDoc, type Actor } from "@carton/core";
import { createMemoryStore } from "../src/index.ts";
import { adapter, doc0, schema, set } from "./fixture.ts";
import { until, world } from "./world.ts";

const person: Actor = { kind: "human", id: PERSON, group: "alice@laptop" };
const importOf = async (c: Carton) => (await c.log({ summary: true })).find((v) => v.kind === "import")!;

test("the import is told as this replica's person, as 'Imported the project'; recorded as the system's", async () => {
  const store = createMemoryStore();
  const a = await Carton.open({ adapter, store, init: { doc: doc0(), asChange: true }, actor: person });
  const v = await importOf(a);
  assert.deepEqual(v.author, { kind: "human", id: PERSON });
  assert.deepEqual(v.authoredAs, { kind: "system", id: "import", name: "Import" }, "the record stays the system's");
  assert.equal(v.summary, "Imported the project");
  assert.deepEqual(await a.credits(["items", "a"]), { kind: "human", id: PERSON }, "a record from the import is credited to the person");
  await a.setIdentity({ id: "alice", name: "Alice" });
  const named = await importOf(a);
  assert.deepEqual(named.author, { kind: "human", id: "alice", name: "Alice" });
  assert.deepEqual(named.authoredAs, v.authoredAs, "telling it differently changes no record");
  // another process on the store (a reopen) tells it the same
  const b = await Carton.open({ adapter, store, actor: person });
  assert.deepEqual((await importOf(b)).author, { kind: "human", id: "alice", name: "Alice" });
  await a.close();
  await b.close();
});

test("a teammate who joined the project holds the sharer's import: told as recorded, never as the teammate", async () => {
  const w = world();
  const alice: Actor = { kind: "human", id: "alice", group: "alice@laptop" };
  const a = await Carton.open({ adapter, store: createMemoryStore(), init: { doc: doc0(), asChange: true }, actor: alice, sync: w.sync("alice") });
  await a.commit({ ops: [set("a", "name", "Opening")] });
  await a.share();
  const main = a.cut;
  await until(async () => (await a.cuts()).find((x) => x.id === main)!.sequencer.kind === "server", 5000, "the hand-off");
  const rec = (await a.cuts()).find((c) => c.id === main)!;
  const root = await a.checkout(`${main}@0`);
  const carol: Actor = { kind: "human", id: "carol", group: "carol@studio" };
  const c = await Carton.open({ adapter, store: createMemoryStore(), init: { join: { projectId: a.projectId, cut: rec, doc0: root, rootHash: hashDoc(root, schema) } }, actor: carol, sync: w.sync("carol") });
  await c.setIdentity({ id: "carol", name: "Carol" });
  await until(async () => (await c.log()).some((v) => v.kind === "import"), 5000, "carol's log");
  assert.deepEqual((await importOf(c)).author, { kind: "system", id: "import", name: "Import" });
  assert.equal((await importOf(c)).summary, "Imported the project");
  await a.close();
  await c.close();
  w.host.close();
});
