// Bringing in a teammate's `.cbproj` (§13), as the Cardboard adapter's bringInTheirChanges does through Carton: the
// answer carries everything the app needs (e2e-qa's S3-3: Carton.importShallow used to drop `newProjectId` and `head`).
import { test } from "node:test";
import assert from "node:assert/strict";
import { Carton, LOCAL_TABLES, type Actor } from "@carton/core";
import type { Store } from "@carton/core/plugins";
import { createMemoryStore } from "../src/index.ts";
import { adapter, doc0, set } from "./fixture.ts";
import { copyStore } from "./world.ts";

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

/** A full-history copy as `.cbproj` "Include history" carries it: the store with the local tables dropped. */
async function historyCopy(from: Store): Promise<Store> {
  const to = await copyStore(from);
  for (const t of LOCAL_TABLES) {
    const rows = await to.range(t);
    if (rows.length) await to.write(rows.map((r) => ({ table: t, key: r.key, value: undefined })));
  }
  return to;
}
const director = (turn: string): Actor => ({ kind: "agent", id: "director/chat/turn1", name: "Director", group: "alice@laptop/director", turn });

test("S3-2: a file with history shows the sender's versions: authors, names, credits and diffs on their cut", async () => {
  const sa = createMemoryStore();
  const a = await Carton.open({ adapter, store: sa, init: { doc: doc0(), projectId: "proj-3" }, actor: { kind: "human", id: "alice" } });
  const main = a.cut;
  await a.commit({ ops: [set("a", "name", "Alice's title")] });
  await a.commit({ ops: [set("b", "name", "Director's b")], author: director("t1") });
  await a.name((await a.log({ limit: 1 }))[0]!.ref, "Sent to Bob");
  await a.commit({ ops: [set("c", "name", "Director's c")], author: director("t1") });
  const file = { shallow: await a.exportShallow({ to: "bob" }), history: await historyCopy(sa) };

  const sb = createMemoryStore();
  const b = await Carton.open({ adapter, store: sb, init: { import: file.shallow }, actor: { kind: "human", id: "bob" } });
  assert.ok((await b.cuts()).find((c) => c.id === main)!.shallow, "before: Alice's cut is shallow lineage");
  assert.deepEqual(await b.importHistory(file.history), { cuts: [main] });
  const theirs = (await b.cuts()).find((c) => c.id === main)!;
  assert.equal(theirs.tracking && !theirs.shallow, true, "now a read-only tracking cut with its log");
  const log = await b.log({ cut: main });
  assert.deepEqual(log.map((v) => [v.ref.seq, v.author?.id ?? null, v.name ?? null]), [
    [3, "director/chat/turn1", null],
    [2, "director/chat/turn1", "Sent to Bob"],
    [1, "alice", null],
    [0, null, null],
  ]);
  assert.equal((await b.credits(["items", "b"], { cut: main }))?.id, "director/chat/turn1");
  assert.deepEqual((await b.diff(`${main}@1`, `${main}@2`)).ops, [{ op: "set", path: ["items", "b", "name"], value: "Director's b" }]);
  await assert.rejects(b.commit({ cut: main, ops: [set("d", "name", "x")] }), /read-only|tracking/, "it stays Alice's");
  // Bob's cut was forked from Alice's head by the shallow import: nothing new to fold yet
  assert.equal((await b.fold(main, { into: b.cut })).status, "up-to-date");
  await b.close();
  const again = await Carton.open({ adapter, store: sb, actor: { kind: "human", id: "bob" } });
  assert.equal((await again.log({ cut: main })).length, 4, "kept in the store");
  assert.deepEqual(await again.importHistory(file.history), { cuts: [] }, "a second import takes nothing");
  // a newer file grows the tracking cut by the rows it adds
  await a.commit({ ops: [set("d", "name", "later")], author: director("t2") });
  assert.deepEqual(await again.importHistory(await historyCopy(sa)), { cuts: [main] });
  assert.equal((await again.log({ cut: main })).length, 5);
  // and Bob's own cut folds the grown cut's new head in, credited to whoever made it
  assert.equal((await again.fold(main, { into: again.cut })).status, "confirmed");
  assert.equal(((await again.head()).doc.items as { id: string; name: string }[]).find((i) => i.id === "d")!.name, "later");
  assert.equal((await again.credits(["items", "d"]))?.id, "director/chat/turn1");
  for (const c of [a, again]) await c.close();
});

test("S3-2: another project's history, or one made with another schema, is refused", async () => {
  const x = await Carton.open({ adapter, store: createMemoryStore(), init: { doc: doc0(), projectId: "proj-4" } });
  const other = createMemoryStore();
  await (await Carton.open({ adapter, store: other, init: { doc: doc0(), projectId: "proj-5" } })).close();
  await assert.rejects(x.importHistory(other), /another project/);
  const mine = createMemoryStore();
  await (await Carton.open({ adapter, store: mine, init: { doc: doc0(), projectId: "proj-4" } })).close();
  const meta = (await mine.get<Record<string, unknown>>("meta", ["project"]))!;
  await mine.write([{ table: "meta", key: ["project"], value: { ...meta, schema: "0".repeat(64) } }]);
  await assert.rejects(x.importHistory(mine), /another document schema/);
  await x.close();
});

test("S3-2: a cut forked from one held only as lineage on both sides waits until its parent's history comes in", async () => {
  const sa = createMemoryStore();
  const a = await Carton.open({ adapter, store: sa, init: { doc: doc0(), projectId: "proj-6" }, actor: { kind: "human", id: "alice" } });
  const main = a.cut;
  await a.commit({ ops: [set("a", "name", "Alice's title")] });
  const shallow = await a.exportShallow({ to: "team" });
  // Bob works on his own cut, forked from Alice's head; his history holds Alice's cut as lineage only
  const sb = createMemoryStore();
  const b = await Carton.open({ adapter, store: sb, init: { import: shallow }, actor: { kind: "human", id: "bob" } });
  await b.commit({ ops: [set("b", "name", "Bob's b")] });
  const carol = await Carton.open({ adapter, store: createMemoryStore(), init: { import: shallow }, actor: { kind: "human", id: "carol" } });
  assert.deepEqual(await carol.importHistory(await historyCopy(sb)), { cuts: [] }, "Bob's cut can't be rebuilt yet: no throw, nothing taken");
  assert.deepEqual(await carol.importHistory(await historyCopy(sa)), { cuts: [main] });
  assert.deepEqual(await carol.importHistory(await historyCopy(sb)), { cuts: [b.cut] });
  assert.deepEqual((await carol.log({ cut: b.cut })).map((v) => [v.ref.seq, v.author?.id ?? null]).slice(0, 1), [[1, "bob"]]);
  assert.equal(((await carol.checkout(`${b.cut}@1`)).items as { id: string; name: string }[]).find((i) => i.id === "b")!.name, "Bob's b");
  for (const c of [a, b, carol]) await c.close();
});
