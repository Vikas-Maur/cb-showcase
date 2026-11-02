// A teammate who joins a shared cut sees its history from before the share point (Stage F2, F3): the hand-off uploads
// the cut's rows with the names given to its versions and its ancestry closure (shallow, PLAN §5.3); a replica that
// joins from nothing fetches the closure, and one that caught up through a keyframe fetches the rows it jumped. Against
// the in-process host of @carton/server.
import { test } from "node:test";
import assert from "node:assert/strict";
import { Carton, canonical, hashDoc, type Actor, type CutRecord, type JoinInit, type Version } from "@carton/core";
import { createMemoryStore } from "../src/index.ts";
import { adapter, doc0, schema, set } from "./fixture.ts";
import { until, world } from "./world.ts";

const alice: Actor = { kind: "human", id: "alice", group: "alice@laptop" };
const carol: Actor = { kind: "human", id: "carol", group: "carol@studio" };
const DIRECTOR = "alice@laptop/director";
const director = (turn: string): Actor => ({ kind: "agent", id: "director", name: "Director", group: DIRECTOR, turn });
const ITEMS = ["a", "b", "c", "d", "e", "f"];
const versions = (vs: Version[]) => vs.map((v) => ({ seq: v.ref.seq, cut: v.ref.branchId, change: v.change, author: v.author, name: v.name, kind: v.kind, at: v.at }));

/** Open a fresh replica on `cut` from what an invite carries (its record, root, and a fork's maker), as a browser would. */
async function join(a: Carton, w: ReturnType<typeof world>, cut: string, actor: Actor, name: string, edit: (j: JoinInit) => JoinInit = (j) => j) {
  const rec = (await a.cuts()).find((c) => c.id === cut)!;
  const root = await a.checkout(`${cut}@0`);
  const by = rec.forkOf ? await a.maker(cut) : null;
  return Carton.open({ adapter, store: createMemoryStore(), init: { join: edit({ projectId: a.projectId, cut: rec, doc0: root, rootHash: hashDoc(root, schema), ...(by ? { by } : {}) }) }, actor, sync: w.sync(name) });
}

test("F2: a cut shared with its history: a teammate who joins from nothing sees the same log, names, credits and undo stack", async () => {
  const w = world();
  const a = await Carton.open({ adapter, store: createMemoryStore(), init: { doc: doc0() }, actor: alice, sync: w.sync("alice") });
  const main = a.cut;
  await a.commit({ ops: [set("a", "name", "Opening")] });
  await a.commit({ ops: [set("b", "endTime", 9), set("b", "trimEnd", 4)], author: director("t1") });
  await a.commit({ ops: [set("c", "name", "Beat 2")], author: director("t1") });
  await a.name((await a.log())[0]!.ref, "Rough cut"); // named after the fact: only in alice's names table
  const v = await a.fork("Director's idea");
  await a.commit({ cut: v.id, ops: [set("d", "name", "Idea")], author: director("t2") });
  assert.equal((await a.fold(v.id, { into: main })).status, "confirmed");
  await a.commit({ ops: [set("e", "name", "Close")], name: "Picture lock" });
  await a.share();
  await until(async () => (await a.cuts()).find((x) => x.id === main)!.sequencer.kind === "server", 5000, "the hand-off");

  const c = await join(a, w, main, carol, "carol");
  await until(async () => (await c.log()).length === (await a.log()).length, 5000, "carol's log");
  assert.deepEqual(versions(await c.log()), versions(await a.log()));
  assert.deepEqual((await c.log()).filter((x) => x.name).map((x) => x.name), ["Picture lock", "Rough cut"]);
  for (const id of ITEMS) assert.deepEqual(await c.credits(["items", id], { detail: true }), await a.credits(["items", id], { detail: true }), `credits of ${id}`);
  assert.equal((await c.credits(["items", "d"]))?.id, "director", "the folded record is the Director's");
  assert.deepEqual((await c.undoStack(DIRECTOR)).map((e) => [e.changeId, e.label]), (await a.undoStack(DIRECTOR)).map((e) => [e.changeId, e.label]));
  // the folded variant is lineage the joiner holds (read-only, shallow): its next fold would find the right base
  await until(async () => (await c.cuts()).some((x) => x.id === v.id && x.shallow), 5000, "the closure at carol");
  await a.close();
  await c.close();
  w.host.close();
});

test("F2: a cut forked from a local cut and shared: the joiner gets its fork point and the credits from before it", async () => {
  const w = world();
  const a = await Carton.open({ adapter, store: createMemoryStore(), init: { doc: doc0() }, actor: alice, sync: w.sync("alice") });
  const draft = a.cut;
  await a.commit({ ops: [set("a", "name", "Hook")], author: director("t1") });
  await a.commit({ ops: [set("b", "name", "Setup")], author: director("t1") });
  const short = await a.fork("30s cut");
  await a.commit({ cut: short.id, ops: [set("c", "name", "Tag")] });
  await a.share(short.id);
  await until(async () => (await a.cuts()).find((x) => x.id === short.id)!.sequencer.kind === "server", 5000, "the hand-off");

  const d = await join(a, w, short.id, carol, "carol");
  await until(async () => (await d.credits(["items", "a"], { cut: short.id }))?.id === "director", 5000, "the lineage at the joiner");
  assert.equal((await d.cuts()).find((x) => x.id === short.id)!.forkOf, (await a.cuts()).find((x) => x.id === short.id)!.forkOf, "its fork point");
  assert.ok((await d.cuts()).some((x) => x.id === draft && x.shallow), "the cut it forked from, as read-only lineage");
  assert.deepEqual(versions(await d.log({ cut: short.id })), versions(await a.log({ cut: short.id })));
  for (const id of ITEMS) assert.deepEqual(await d.credits(["items", id], { cut: short.id }), await a.credits(["items", id], { cut: short.id }), `credits of ${id}`);
  // the closure is shallow (PLAN §5.3): who, but not the private change or its time
  assert.deepEqual(await d.credits(["items", "a"], { cut: short.id, detail: true }), { actor: director("t1"), at: null, change: null });
  // the joiner edits it like any shared cut
  assert.equal((await d.commit({ cut: short.id, ops: [set("f", "name", "Carol's")], wait: 5000 })).status, "confirmed");
  await a.close();
  await d.close();
  w.host.close();
});

// Who made a shared fork reaches its joiner beside the cut's record (JoinInit.by), never in it: the record is stored as
// any client rebuilds it, so the joiner's writes on the cut hold. A record that carried it inside (a build that kept it
// there, fix/lap2-fold-author 717916d) gives it up the same way.
test("F2: a joiner of a shared fork is told who made it, and the cut's record it stores is the one it rebuilds", async () => {
  for (const inRecord of [false, true]) {
    const w = world();
    const a = await Carton.open({ adapter, store: createMemoryStore(), init: { doc: doc0() }, actor: alice, sync: w.sync("alice") });
    const short = await a.fork("30s cut", { author: director("t0") });
    await a.share(short.id);
    await until(async () => (await a.cuts()).find((x) => x.id === short.id)!.sequencer.kind === "server", 5000, "the hand-off");
    assert.deepEqual(await a.maker(short.id), director("t0"));
    const rec = (await a.cuts()).find((c) => c.id === short.id)!;
    const root = await a.checkout(`${short.id}@0`);
    const j: JoinInit = { projectId: a.projectId, cut: rec, doc0: root, rootHash: hashDoc(root, schema), by: director("t0") };
    // not connected yet: what the join itself stored
    const store = createMemoryStore();
    const d = await Carton.open({ adapter, store, init: { join: inRecord ? { ...j, cut: { ...rec, by: director("t0") } as CutRecord, by: undefined } : j }, actor: carol, sync: w.sync("carol", false) });
    const stored = (await store.get<CutRecord>("cuts", [short.id]))!;
    assert.ok(!("by" in stored), "the record holds no maker: " + JSON.stringify(stored));
    assert.equal(canonical((await d.cuts()).find((c) => c.id === short.id)), canonical(stored), "the record this client holds is the stored one (its writes are conditioned on it)");
    assert.deepEqual(await store.get("meta", ["maker", short.id]), director("t0"), "the maker, beside it");
    await d.sync!.connect();
    await until(async () => (await d.cuts()).find((x) => x.id === short.id)?.forkOf != null, 5000, "the fork point at the joiner");
    const fork = (await d.log({ cut: short.id })).find((v) => v.kind === "fork");
    assert.deepEqual(fork?.author, director("t0"), inRecord ? "from the record" : "from JoinInit.by");
    assert.equal((await d.commit({ cut: short.id, ops: [set("f", "name", "Carol's")], wait: 5000 })).status, "confirmed", "the joiner edits it");
    await a.close();
    await d.close();
    w.host.close();
  }
});

test("F3: a joiner that caught up through a keyframe loads the stretch it jumped: log, credits and diff work across it", async () => {
  const w = world({ maxBehind: 4, keyframeEvery: 4 });
  const a = await Carton.open({ adapter, store: createMemoryStore(), init: { doc: doc0() }, actor: alice, sync: w.sync("alice") });
  const main = a.cut;
  await a.share();
  await until(async () => (await a.cuts())[0]!.sequencer.kind === "server", 5000, "the hand-off");
  for (let i = 1; i <= 10; i++) assert.equal((await a.commit({ ops: [set(ITEMS[i % 6]!, "name", `take ${i}`)], author: i % 2 ? director(`t${i}`) : alice, wait: 5000 })).status, "confirmed");
  const tables = (w.host.sequencer as unknown as { tables: { latestKeyframe(b: string, s: number): { seq: number } | null } }).tables;
  await until(() => tables.latestKeyframe(main, 100)?.seq === 8, 5000, "the server's keyframe at 8");

  const c = await join(a, w, main, carol, "carol");
  await until(async () => (await c.log()).length === (await a.log()).length, 5000, "the jumped stretch in carol's History");
  assert.deepEqual(versions(await c.log()), versions(await a.log()));
  for (const id of ITEMS) assert.deepEqual(await c.credits(["items", id], { detail: true }), await a.credits(["items", id], { detail: true }), `credits of ${id}`);
  assert.deepEqual((await c.diff(`${main}@2`, `${main}@5`)).ops, (await a.diff(`${main}@2`, `${main}@5`)).ops);
  // and History's head is the queue's: an undo plans on it
  assert.equal((await c.undo(DIRECTOR, { author: carol })).status, "pending");
  await a.close();
  await c.close();
  w.host.close();
});
