// Core fixes and APIs from agent ui's review (carton-build/notes/ui.md): root-field partial accept, unseen cards,
// renameCut, publish/publications, credits detail, log summaries. (ui's (a), escaped ids in fold-some, is R1-14 and
// (c), the all-cards fold, is in the engine conformance suite.)
import { test } from "node:test";
import assert from "node:assert/strict";
import { Carton, type Actor } from "@carton/core";
import { createMemoryStore } from "../src/index.ts";
import { adapter, doc0, set, item } from "./fixture.ts";

const alice: Actor = { kind: "human", id: "alice", group: "alice@laptop" };
const bob: Actor = { kind: "human", id: "bob" };
const open = () => Carton.open({ adapter, store: createMemoryStore(), init: { doc: doc0() }, actor: alice });

test("ui-b fold-some leaving out a root field keeps it a plain value (never wrapped in an array)", async () => {
  const c = await open();
  const v = await c.fork("variant");
  await c.commit({ cut: v.id, ops: [{ op: "set", path: ["name"], value: "Renamed" }, set("a", "name", "kept")] });
  const r = await c.foldSome(v.id, { reject: ["name"] });
  assert.equal(r.status, "confirmed");
  const head = (await c.head()).doc;
  assert.equal(head.name, "Film");
  assert.equal(item(head, "a")!.name, "kept");
});

test("ui-d choices that don't name every card return the cards (unseen), unless the caller opts into prefer", async () => {
  const c = await open();
  const v = await c.fork("variant");
  await c.commit({ cut: v.id, ops: [set("a", "name", "theirs A"), set("b", "name", "theirs B")], author: bob });
  await c.commit({ ops: [set("a", "name", "ours A"), set("b", "name", "ours B")] });
  const plan = await c.fold(v.id, { check: true });
  assert.equal(plan.status, "conflicts");
  const cards = plan.status === "conflicts" ? plan.cards : [];
  assert.equal(cards.length, 2);
  const one = await c.fold(v.id, { choices: { [cards[0]!.path]: "theirs" } });
  assert.equal(one.status, "conflicts");
  assert.deepEqual(one.status === "conflicts" && one.unseen, [cards[1]!.path]);
  assert.equal((await c.log()).length, 2, "nothing committed on Main (root + its own edit)");
  const opted = await c.fold(v.id, { choices: { [cards[0]!.path]: "theirs" }, unchosen: "prefer" });
  assert.equal(opted.status, "confirmed");
  const head = (await c.head()).doc;
  const id = (k: number) => cards[k]!.path.split("/")[1]!;
  assert.match(String(item(head, id(0))!.name), /^theirs/, "the named card took its choice");
  assert.match(String(item(head, id(1))!.name), /^ours/, "the unnamed card took prefer (ours)");
});

test("ui-d a stale commit's rebase with a list of choices missing a card returns the cards", async () => {
  const c = await open();
  await c.commit({ ops: [set("a", "name", "head A"), set("b", "name", "head B")] });
  const stale = { branchId: c.cut, seq: 0, pending: [] };
  const r = await c.commit({ ops: [set("a", "name", "mine A"), set("b", "name", "mine B")], base: stale, choices: ["theirs"] });
  assert.equal(r.status, "conflicts");
  assert.equal(r.status === "conflicts" && r.unseen?.length, 1);
  const ok = await c.commit({ ops: [set("a", "name", "mine A"), set("b", "name", "mine B")], base: stale, choices: ["theirs", "ours"] });
  assert.equal(ok.status, "confirmed");
});

test("renameCut renames a cut (its id is kept) and survives a reopen", async () => {
  const store = createMemoryStore();
  const c = await Carton.open({ adapter, store, init: { doc: doc0() }, actor: alice });
  const v = await c.fork("variant");
  const r = await c.renameCut(v.id, "30s Instagram cut");
  assert.equal(r.id, v.id);
  assert.equal(r.name, "30s Instagram cut");
  const again = await Carton.open({ adapter, store });
  assert.equal((await again.cuts()).find((x) => x.id === v.id)?.name, "30s Instagram cut");
});

test("publish makes a read-only Published cut; publications say when the source cut has newer edits", async () => {
  const c = await open();
  await c.commit({ ops: [set("a", "name", "v1")] });
  const pub = await c.publish();
  assert.equal(pub.kind, "published");
  assert.equal(item((await c.head(pub.id)).doc, "a")!.name, "v1");
  let list = await c.publications();
  assert.equal(list.length, 1);
  assert.equal(list[0]!.source, c.cut);
  assert.equal(list[0]!.newer, false);
  await c.commit({ ops: [set("a", "name", "v2")] });
  list = await c.publications();
  assert.equal(list[0]!.newer, true);
  await assert.rejects(c.commit({ cut: pub.id, ops: [set("a", "name", "x")] }), /Published cut is read-only/);
});

test("credits with detail say who, when and in which change; plain credits still return the actor", async () => {
  let now = 1000;
  const c = await Carton.open({ adapter, store: createMemoryStore(), init: { doc: doc0() }, actor: alice, clock: () => now });
  now = 2000;
  const r = await c.commit({ ops: [set("c", "name", "bob's")], author: bob });
  const d = await c.credits(["items", "c"], { detail: true });
  assert.deepEqual(d, { actor: bob, at: 2000, change: r.status === "confirmed" ? r.change!.id : "" });
  assert.equal((await c.credits(["items", "c"]))?.id, "bob");
});

test("log({summary}) words each version without the caller diffing documents", async () => {
  const c = await open();
  await c.commit({ ops: [set("a", "endTime", 4), set("a", "trimEnd", 4)] });
  await c.commit({ ops: [set("b", "name", "Middle")], name: "Renamed b" });
  const log = await c.log({ summary: true });
  assert.equal(log[0]!.summary, "Renamed b");
  assert.match(log[1]!.summary!, /^Trimmed 'a' end 5\.0 s → 4\.0 s/);
  assert.equal(log[2]!.summary, undefined, "the root has no change");
  assert.equal((await c.log())[1]!.summary, undefined, "summaries only when asked");
});
