// Restore and "New cut from here" on "Started the cut" (laptop, build 915eb36): the empty root an imported project's
// history starts from (main@0, `init.asChange`) holds nothing of the project. The handle refuses to restore it or make a
// cut from it (`EmptyVersion`), on local and shared cuts, and its log marks it (`blank`) so a UI doesn't offer either.
import { test } from "node:test";
import assert from "node:assert/strict";
import { Carton, EmptyVersion } from "@carton/core";
import { createMemoryStore } from "../src/index.ts";
import { adapter, doc0, set } from "./fixture.ts";

const open = async () => {
  const store = createMemoryStore();
  const c = await Carton.open({ adapter, store, init: { doc: doc0(), asChange: true } });
  await c.commit({ ops: [set("a", "name", "A")] });
  return { c, store };
};
const empty = (e: unknown) => e instanceof EmptyVersion && e.code === "EMPTY_VERSION";

test("the log marks the empty root of an imported project", async () => {
  const { c } = await open();
  assert.deepEqual((await c.log()).map((v) => [v.ref.seq, v.kind, v.blank ?? false]), [[2, "edit", false], [1, "import", false], [0, "root", true]]);
  await c.close();
});

test("restore of the empty root is refused; the head and the store don't change", async () => {
  const { c, store } = await open();
  const head = await c.head();
  const rows = (await store.range("changes", { prefix: [c.cut] })).length;
  await assert.rejects(c.restore(`${c.cut}@0`), empty);
  await assert.rejects(c.restore({ branchId: c.cut, seq: 0, pending: [] }), empty, "a StateRef too");
  assert.equal((await c.head()).ref.seq, head.ref.seq, "no version");
  assert.equal((await store.range("changes", { prefix: [c.cut] })).length, rows, "nothing stored");
  assert.equal((await c.head()).doc.name, "Film");
  // the handle still works: a real version restores
  const r = await c.restore(`${c.cut}@1`);
  assert.equal(r.status, "confirmed");
  assert.equal((await c.head()).doc.name, "Film");
  await c.close();
});

test("a cut from the empty root is refused, by ref or StateRef; a cut from a real version is made", async () => {
  const { c } = await open();
  const cuts = (await c.cuts()).length;
  await assert.rejects(c.fork("From the start", { from: `${c.cut}@0` }), (e: unknown) => empty(e) && /make a cut from/.test((e as Error).message));
  await assert.rejects(c.fork("From the start", { from: { branchId: c.cut, seq: 0, pending: [] } }), empty);
  assert.equal((await c.cuts()).length, cuts, "no cut");
  const alt = await c.fork("Alt", { from: `${c.cut}@1` });
  assert.equal((await c.checkout(`${alt.id}@0`)).name, "Film");
  await c.close();
});

test("a root that is the project (init without asChange) restores as before", async () => {
  const c = await Carton.open({ adapter, store: createMemoryStore(), init: { doc: doc0() } });
  await c.commit({ ops: [set("a", "name", "A")] });
  assert.equal((await c.log()).at(-1)!.blank, undefined);
  assert.equal((await c.restore(`${c.cut}@0`)).status, "confirmed");
  assert.equal((await c.fork("Alt", { from: `${c.cut}@0` })).name, "Alt");
  await c.close();
});

test("on a shared cut too: restore of the empty root is refused before anything is queued", async () => {
  const { world, until } = await import("./world.ts");
  const w = world();
  const c = await Carton.open({ adapter, store: createMemoryStore(), init: { doc: doc0(), asChange: true }, actor: { kind: "human", id: "person" }, sync: w.sync("alice") });
  try {
    await c.share();
    await until(async () => (await c.cuts())[0]!.sequencer.kind === "server");
    await assert.rejects(c.restore(`${c.cut}@0`), empty);
    assert.equal(await c.pendingCount(c.cut), 0, "nothing queued");
    assert.equal((await c.head()).doc.name, "Film");
  } finally {
    await c.close();
    w.host.close();
  }
});
