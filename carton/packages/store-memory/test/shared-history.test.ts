// History writes on shared cuts (Stage F1): undo, revert, restore and fold-some go through the cut's SharedCut as
// ordinary changes with their intent, kind and stable id: pending, then confirmed, rebased when the server has moved
// on, kept across a restart, and credited to who made them. Against the in-process host of @carton/server.
import { test } from "node:test";
import assert from "node:assert/strict";
import { Carton, type Actor, type CommitResult, type ConfirmedChange, type FoldResult, type Rec } from "@carton/core";
import type { Store } from "@carton/core/plugins";
import { createMemoryStore } from "../src/index.ts";
import { adapter, doc0, set, item } from "./fixture.ts";
import { copyStore, until, world } from "./world.ts";

const alice: Actor = { kind: "human", id: "alice", group: "alice@laptop" };
const bob: Actor = { kind: "human", id: "bob", group: "bob@desk" };
const DIRECTOR = "alice@laptop/director";
const director = (turn: string): Actor => ({ kind: "agent", id: "director", name: "Director", group: DIRECTOR, turn });
const pendingId = (r: CommitResult | FoldResult): string => (r.status === "pending" ? r.id : assert.fail(`expected pending, got ${r.status}`));
const row = async (store: Store, cut: string, id: string): Promise<ConfirmedChange | undefined> => (await store.range<ConfirmedChange>("changes", { prefix: [cut] })).map((r) => r.value).find((c) => c.id === id);
const time = (r: Rec | undefined) => r && { startTime: r.startTime, endTime: r.endTime, trimStart: r.trimStart, trimEnd: r.trimEnd };

/** alice's shared cut, handed off, and bob on a copy of her store. */
async function twoOnAShared() {
  const w = world();
  const sa = createMemoryStore();
  const a = await Carton.open({ adapter, store: sa, init: { doc: doc0() }, actor: alice, sync: w.sync("alice") });
  await a.share();
  await until(async () => (await a.cuts())[0]!.sequencer.kind === "server", 5000, "the hand-off");
  const sb = await copyStore(sa);
  const b = await Carton.open({ adapter, store: sb, actor: bob, sync: w.sync("bob") });
  await until(() => b.sync!.status === "up-to-date", 5000, "bob connected");
  const done = async () => {
    await a.close();
    await b.close();
    w.host.close();
  };
  return { w, a, b, sa, sb, cut: a.cut, done };
}

test("§17: undo the agent's turn on a live shared cut: one undo change, confirmed on both replicas, credited to who undid", async () => {
  const { a, b, sa, sb, cut, done } = await twoOnAShared();
  await a.commit({ ops: [set("c", "name", "Earlier turn")], author: director("t0"), wait: 5000 });
  const t1 = [
    await a.commit({ ops: [set("a", "name", "Intro (tight)")], author: director("t1"), wait: 5000 }),
    await a.commit({ ops: [set("b", "endTime", 9), set("b", "trimEnd", 4)], author: director("t1"), wait: 5000 }),
  ];
  await b.commit({ ops: [set("d", "name", "Bob's edit")], wait: 5000 });
  await until(async () => item((await a.head()).doc, "d")!.name === "Bob's edit", 5000, "bob's edit at alice");
  const stack = await a.undoStack(DIRECTOR);
  assert.deepEqual(stack.map((e) => e.author.turn), ["t1", "t1", "t0"]);
  assert.ok(stack.every((e) => e.label.startsWith("Undo Director: ")), stack.map((e) => e.label).join(" | "));
  const r = await a.undo(DIRECTOR, { author: alice, id: "cli1.1" });
  const id = pendingId(r);
  assert.equal(id, "cli1.1");
  assert.equal(r.entry?.changeId, t1[1]!.status === "confirmed" ? t1[1]!.change!.id : "", "the newest entry of the turn");
  assert.equal(item((await a.head()).doc, "a")!.name, "a", "the head shows the undo at once");
  assert.equal((await a.sync!.waitFor(id, 5000)).status, "confirmed");
  for (const c of [a, b])
    await until(async () => {
      const d = (await c.head()).doc;
      return item(d, "a")!.name === "a" && item(d, "b")!.endTime === 10 && item(d, "c")!.name === "Earlier turn" && item(d, "d")!.name === "Bob's edit";
    }, 5000, "the undo on both replicas, the earlier turn and bob's edit kept");
  for (const s of [sa, sb]) {
    await until(async () => !!(await row(s, cut, id)), 5000, "the undo row in both stores");
    const u: ConfirmedChange = (await row(s, cut, id))!;
    assert.equal(u.kind, "undo");
    assert.deepEqual(u.reverts, t1.map((x) => (x.status === "confirmed" ? x.change!.id : "")));
    assert.equal(u.author.id, "alice");
  }
  // the turn left the stack; the earlier turn is next
  assert.deepEqual((await a.undoStack(DIRECTOR)).map((e) => e.author.turn), ["t0"]);
  assert.deepEqual((await b.undoStack(DIRECTOR)).map((e) => e.author.turn), ["t0"]);
  // credits name who undid, on both
  assert.equal((await a.credits("items/a", { detail: true }))?.change, id);
  assert.equal((await b.credits("items/a"))?.id, "alice");
  // a retry with the same id is that undo, never a second one
  const n = (await a.log()).length;
  const again = await a.undo(DIRECTOR, { author: alice, id: "cli1.1" });
  assert.equal(again.status, "confirmed");
  assert.equal((await a.log()).length, n);
  assert.equal(item((await a.head()).doc, "c")!.name, "Earlier turn");
  await done();
});

test("⌘Z right after an edit undoes it while it is still pending, and an undo waiting to sync leaves the stack", async () => {
  const { a, b, cut, sa, done } = await twoOnAShared();
  await a.sync!.disconnect();
  const e1 = pendingId(await a.commit({ ops: [set("e", "name", "first try")] }));
  const e2 = pendingId(await a.commit({ ops: [set("f", "name", "second try")] }));
  assert.deepEqual((await a.undoStack()).map((e) => e.changeId), [e2, e1], "pending edits are the newest entries");
  const u = pendingId(await a.undo());
  assert.equal(item((await a.head()).doc, "f")!.name, "f");
  assert.equal(item((await a.head()).doc, "e")!.name, "first try");
  assert.deepEqual((await a.undoStack()).map((e) => e.changeId), [e1], "the waiting undo hides its change");
  await a.sync!.connect({ nonce: "lease-2" });
  await until(async () => item((await b.head()).doc, "e")!.name === "first try" && (await b.log()).length === 4, 5000, "all three at bob");
  assert.equal(item((await b.head()).doc, "f")!.name, "f");
  const ur = (await row(sa, cut, u))!;
  assert.equal(ur.kind, "undo");
  assert.equal(ur.reverts, e2);
  await done();
});

test("an undo queued offline is rebased onto a teammate's concurrent move and confirmed with both", async () => {
  const { a, b, sa, cut, done } = await twoOnAShared();
  // the Director trims the end of a (0–5 → 0–4); bob, later, moves a by 100 s while alice is offline
  await a.commit({ ops: [set("a", "endTime", 4), set("a", "trimEnd", 4)], author: director("t1"), wait: 5000 });
  await until(async () => item((await b.head()).doc, "a")!.endTime === 4, 5000, "the trim at bob");
  await a.sync!.disconnect();
  const u = pendingId(await a.undo(DIRECTOR, { author: alice }));
  assert.deepEqual(time(item((await a.head()).doc, "a")), { startTime: 0, endTime: 5, trimStart: 0, trimEnd: 5 });
  await b.commit({ ops: [set("a", "startTime", 100), set("a", "endTime", 104)], wait: 5000 });
  await a.sync!.connect({ nonce: "lease-2" });
  assert.equal((await a.sync!.waitFor(u, 5000)).status, "confirmed");
  // the time group composes the move with the undone trim: a sits at 100 and is 5 s long again, on both
  for (const c of [a, b]) await until(async () => item((await c.head()).doc, "a")!.endTime === 105, 5000, "the rebased undo");
  assert.deepEqual(time(item((await b.head()).doc, "a")), { startTime: 100, endTime: 105, trimStart: 0, trimEnd: 5 });
  await until(async () => !!(await row(sa, cut, u)), 5000, "the undo row");
  const ur = (await row(sa, cut, u))!;
  assert.equal(ur.kind, "undo");
  assert.ok((ur.rebase ?? 0) >= 1, "it was rebased onto bob's move");
  await done();
});

test("an edit and its undo made offline survive a restart: both re-queued with the undo's kind and reverts", async () => {
  const { a, b, sa, cut, w, done } = await twoOnAShared();
  await a.sync!.disconnect();
  const e = pendingId(await a.commit({ ops: [set("e", "name", "regret")] }));
  const u = pendingId(await a.undo(undefined, { id: "cli2.1" }));
  assert.equal(u, "cli2.1");
  await a.close();
  const again = await Carton.open({ adapter, store: sa, actor: alice, sync: w.sync("alice") });
  assert.deepEqual((await again.undoStack()).map((x) => x.changeId), [], "the restarted queue still knows the edit is undone");
  assert.equal(item((await again.head()).doc, "e")!.name, "e");
  await until(async () => (await again.log()).length === 3, 5000, "both confirmed after the restart");
  const ur = (await row(sa, cut, u))!;
  assert.equal(ur.kind, "undo");
  assert.equal(ur.reverts, e);
  await until(async () => (await b.log()).length === 3, 5000, "both at bob");
  assert.equal(item((await b.head()).doc, "e")!.name, "e");
  // retried after the restart: the confirmed undo
  assert.equal((await again.undo(undefined, { id: "cli2.1" })).status, "confirmed");
  assert.equal((await again.log()).length, 3);
  await again.close();
  await done();
});

test("revert and restore on a shared cut: pending then confirmed, with stable ids", async () => {
  const { a, b, sa, cut, done } = await twoOnAShared();
  const v1 = (await a.log())[0]!.ref;
  const rb = await b.commit({ ops: [set("b", "name", "Bob's b")], wait: 5000 });
  await a.commit({ ops: [set("c", "name", "Alice's c")], wait: 5000 });
  await until(async () => item((await a.head()).doc, "b")!.name === "Bob's b", 5000, "bob's edit at alice");
  const bobsId = rb.status === "confirmed" ? rb.change!.id : assert.fail("bob's commit");
  const rv = await a.revert(bobsId, { id: "cli3.1" });
  assert.equal(pendingId(rv), "cli3.1");
  assert.equal((await a.sync!.waitFor("cli3.1", 5000)).status, "confirmed");
  assert.equal(item((await a.head()).doc, "b")!.name, "b");
  assert.equal(item((await a.head()).doc, "c")!.name, "Alice's c");
  await until(async () => !!(await row(sa, cut, "cli3.1")), 5000, "the revert row");
  const rr = (await row(sa, cut, "cli3.1"))!;
  assert.equal(rr.kind, "revert");
  assert.equal(rr.reverts, bobsId);
  assert.equal(rr.author.id, "alice");
  assert.equal((await a.revert(bobsId, { id: "cli3.1" })).status, "confirmed", "retried: the same revert");
  // restore the first version: one change back to it, nothing in between lost from history
  const rs = await a.restore(v1, { id: "cli3.2" });
  assert.equal(pendingId(rs), "cli3.2");
  assert.equal((await a.sync!.waitFor("cli3.2", 5000)).status, "confirmed");
  await until(async () => item((await b.head()).doc, "c")!.name === "c", 5000, "the restore at bob");
  assert.deepEqual((await b.diff(v1, (await b.head()).ref)).ops, [], "bob's head is the first version again");
  assert.equal((await row(sa, cut, "cli3.2"))?.kind, "restore");
  const n = (await a.log()).length;
  assert.equal((await a.restore(v1, { id: "cli3.2" })).status, "confirmed");
  assert.equal((await a.log()).length, n, "retried: no second restore");
  await done();
});

test("fold-some into a shared cut: the fold and its inverse queue together; credits name the variant's author", async () => {
  const { a, b, sa, cut, done } = await twoOnAShared();
  const v = await a.fork("variant");
  await a.commit({ cut: v.id, ops: [set("a", "name", "Director's a")], author: director("t1") });
  await a.commit({ cut: v.id, ops: [set("b", "name", "Director's b")], author: director("t1") });
  const r = await a.foldSome(v.id, { into: cut, reject: ["items/b"], id: "cli4.1" });
  assert.equal(pendingId(r), "cli4.1.inverse");
  assert.equal((await sa.range("pending", { prefix: [cut] })).length, 2, "both in the store");
  assert.equal(item((await a.head(cut)).doc, "a")!.name, "Director's a");
  assert.equal(item((await a.head(cut)).doc, "b")!.name, "b");
  assert.equal((await a.sync!.waitFor("cli4.1.inverse", 5000)).status, "confirmed");
  await until(async () => item((await b.head()).doc, "a")!.name === "Director's a", 5000, "the fold at bob");
  assert.equal(item((await b.head()).doc, "b")!.name, "b");
  const fold = (await row(sa, cut, "cli4.1"))!;
  const inv = (await row(sa, cut, "cli4.1.inverse"))!;
  assert.equal(fold.kind, "merge");
  assert.equal(inv.kind, "partial-revert");
  assert.deepEqual(inv.rejected, ["items/b"]);
  assert.equal(inv.reverts, "cli4.1");
  // credits: the record the fold brought in is the Director's, on both replicas
  assert.equal((await a.credits("items/a", { cut }))?.id, "director");
  await until(async () => (await b.credits("items/a"))?.id === "director", 5000, "credits at bob");
  // retried: the same fold-some
  const n = (await a.log({ cut })).length;
  assert.equal((await a.foldSome(v.id, { into: cut, reject: ["items/b"], id: "cli4.1" })).status, "confirmed");
  assert.equal((await a.log({ cut })).length, n);
  await done();
});

test("an id the shared cut's sequencer would refuse is refused before the edit shows as pending", async () => {
  const { a, done } = await twoOnAShared();
  await assert.rejects(a.commit({ ops: [set("a", "name", "x")], id: "no-dot" }), /isn't `<rid>.<n>`/);
  await assert.rejects(a.undo(undefined, { id: "undo" }), /isn't `<rid>.<n>`/);
  assert.equal(a.sync!.state().pending, 0);
  assert.equal(item((await a.head()).doc, "a")!.name, "a");
  await done();
});

test("a save that undoes changes (commit undoOf, cb undo --turn) on a shared cut is recorded as their undo", async () => {
  const { a, sa, cut, done } = await twoOnAShared();
  const e = await a.commit({ ops: [set("e", "name", "agent's")], author: director("t5"), wait: 5000 });
  const eid = e.status === "confirmed" ? e.change!.id : assert.fail("the agent's edit");
  const u = await a.commit({ ops: [set("e", "name", "e")], undoOf: [eid], wait: 5000 });
  assert.equal(u.status, "confirmed");
  const ur = (await row(sa, cut, u.status === "confirmed" ? u.change!.id : ""))!;
  assert.equal(ur.kind, "undo");
  assert.deepEqual(ur.reverts, [eid]);
  assert.deepEqual(await a.undoStack(DIRECTOR), [], "the undone change left the stack");
  await done();
});
