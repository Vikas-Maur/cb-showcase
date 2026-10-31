// fromCarton() over the real engine: Carton.open on store-memory, no mocks.
import { test } from "node:test";
import assert from "node:assert/strict";
import { Carton, POS, defineSchema, object, timeAlgebra, type Actor, type CartonEvent, type Doc, type Rec } from "@carton/core";
import type { HostAdapter } from "@carton/core/plugins";
import { createMemoryStore } from "@carton/store-memory";
import { cardOps, fromCarton, splitPathKey, toUiActor } from "../src/from-carton.ts";

const TL = { collection: "items", lanes: "tracks", lane: "trackId", start: "startTime", end: "endTime", source: "trimStart", sourceEnd: "trimEnd", speed: "playbackSpeed" };
const schema = defineSchema({
  collections: {
    tracks: { seq: true },
    items: { parent: { field: "trackId", collection: "tracks" }, groups: [{ name: "time", fields: ["startTime", "endTime", "trimStart", "trimEnd", "playbackSpeed"], algebra: timeAlgebra(TL) }], fields: { style: object() } },
  },
  timeline: TL,
  label: (coll, r) => String((r as Rec | undefined)?.name ?? (r as Rec | undefined)?.id ?? coll),
  hard: (coll, r) => (coll === "items" && !((r.endTime as number) > (r.startTime as number)) ? ["endTime must be greater than startTime"] : []),
});
const adapter: HostAdapter<Doc> = { name: "test", schema, schemaVersion: 1, fromHost: (h) => h, toHost: (d) => d };
const clip = (id: string, s: number, e: number, color = "red"): Rec => ({ id, trackId: "t1", startTime: s, endTime: e, trimStart: 0, trimEnd: e - s, name: id.toUpperCase(), color });
const doc0 = (): Doc => ({ name: "Film", tracks: [{ id: "t1", [POS]: "V" }], items: [clip("a", 0, 5), clip("b", 5, 10), clip("c", 10, 15), clip("d", 15, 20)] });
const alice: Actor = { kind: "human", id: "alice", name: "Alice", group: "alice@laptop" };
const director = (turn: string): Actor => ({ kind: "agent", id: "director", name: "Director", turn, chat: "c1", group: "alice@laptop" });
const explore = (turn: string): Actor => ({ kind: "subagent", id: "director", agentId: "ab12", agentType: "Explore", turn, chat: "c1", group: "alice@laptop" });
const bob: Actor = { kind: "human", id: "bob", name: "Bob" };
const set = (id: string, f: string, v: unknown) => ({ op: "set" as const, path: ["items", id, f], value: v });
const settle = () => new Promise((r) => setTimeout(r, 80));

async function open() {
  const carton = await Carton.open({ adapter, store: createMemoryStore(), init: { doc: doc0(), cutName: "Main cut" }, actor: alice });
  // A tap on the handle's events, so the test can play sync and presence events the way the sync client would.
  const taps: ((e: CartonEvent) => void)[] = [];
  const realOn = carton.on.bind(carton);
  (carton as { on: typeof carton.on }).on = (l) => {
    taps.push(l);
    return realOn(l);
  };
  const ui = fromCarton(carton, { me: alice, clipName: (id) => id.toUpperCase() });
  await ui.ready;
  return { carton, ui, emit: (e: CartonEvent) => taps.forEach((l) => l(e)) };
}

test("History follows commits: newest first, lazy summaries, a Director turn as one checkpoint", async () => {
  const { carton, ui } = await open();
  const h = ui.history();
  assert.equal(h.count("all"), 1, "the root version");
  await carton.commit({ ops: [set("a", "name", "Intro")] });
  await carton.commit({ ops: [set("b", "color", "blue")], author: director("t1") });
  await carton.commit({ ops: [set("c", "color", "green")], author: explore("t1") });
  await settle();
  assert.equal(h.count("all"), 4);
  const top = h.at("all", 0)!;
  assert.equal(top.kind, "turn", "the newest version of the turn is the checkpoint");
  assert.equal(top.turn?.edits, 2);
  assert.equal(h.at("all", 1)!.kind, "edit", "the turn's earlier version is a plain row");
  assert.equal(h.count("turns"), 1);
  assert.equal(top.author.name, "Explore");
  assert.equal(ui.actor(top.author.parent!)?.name, "Director", "a subagent is named with its agent");
  assert.equal(top.author.isYou, true, "your agents are in your group");
  // Summaries come from describe(), only for rows someone reads.
  assert.equal(h.at("all", 2)!.summary, "");
  await settle();
  assert.match(h.at("all", 2)!.summary, /Intro/);
  assert.match(h.at("all", 0)!.summary, /C/);
  ui.dispose();
});

test("subagents named as the identity sources write them (director/<chat>/<turn>/sub-<type>-<id>): agent, turn, undo label", async () => {
  const { carton, ui } = await open();
  const agent: Actor = { kind: "agent", id: "director/c9/t7", name: "Director", chat: "c9", turn: "t7", group: "alice@laptop" };
  const sub: Actor = { kind: "subagent", id: "director/c9/t7/sub-captions-ab12", name: "Director › captions", agentId: "ab12", agentType: "captions", chat: "c9", turn: "t7", group: "alice@laptop" };
  await carton.commit({ ops: [set("a", "name", "by the agent")], author: agent });
  await carton.commit({ ops: [set("b", "name", "by its subagent")], author: sub, name: "tighter intro" });
  await settle();
  const top = ui.history().at("all", 0)!;
  assert.equal(top.kind, "turn");
  assert.equal(top.turn?.edits, 2, "the agent's and its subagent's edits are one turn");
  assert.equal(top.author.parent, "agent/director/c9/t7", "the subagent's agent is found from its id");
  assert.equal(ui.actor(top.author.parent!)?.name, "Director");
  await settle();
  const turn = ui.undoTurn()!;
  assert.equal(turn.author.name, "Director", "the turn is undone as the agent's");
  assert.equal(turn.label, "tighter intro");
  assert.equal(turn.edits, 2);
  ui.dispose();
});

test("a rebase's card names the other side from Credits (who last changed that record), not \"Someone\"", async () => {
  const { carton, ui, emit } = await open();
  await carton.commit({ ops: [set("b", "name", "Bob's name")], author: bob });
  await settle();
  emit({ type: "absorbed", branchId: carton.cut, id: "x.1", cards: [{ kind: "same-field", path: "items/b/name", base: "b", ours: "Bob's name", theirs: "Alice's name" }] });
  await settle();
  const card = ui.conflicts()[0]!;
  assert.equal(card.theirs.author.name, "Bob");
  assert.equal(card.mine.author.isYou, true);
  ui.dispose();
});

test("name a version; it shows under Named and in the engine's log", async () => {
  const { carton, ui } = await open();
  await carton.commit({ ops: [set("a", "name", "Intro")] });
  await settle();
  const v = ui.history().at("all", 0)!;
  await ui.nameVersion(v.id, "Sent to client, Monday");
  assert.equal(ui.history().count("named"), 1);
  assert.equal(ui.history().at("named", 0)!.name, "Sent to client, Monday");
  assert.equal((await carton.log())[0]!.name, "Sent to client, Monday");
  ui.dispose();
});

test("cuts: new cut from here switches to it; two cuts with one name are told apart by owner", async () => {
  const { carton, ui } = await open();
  await carton.commit({ ops: [set("a", "name", "Intro")] });
  await settle();
  const head = ui.cuts().find((c) => c.current)!;
  assert.equal(head.label, "Main cut");
  const cut = await ui.newCut("30s cut", head.head);
  assert.equal(ui.cuts().find((c) => c.current)?.id, cut.id);
  assert.equal(ui.history().count("all"), 3, "the new cut's history includes how it got there");
  assert.equal(ui.history().at("all", 0)!.summary, "Made this cut");
  assert.equal(ui.history().at("all", 1)!.ref, `${head.id}@1`, "then the versions of the cut it was made from");
  await ui.switchCut(head.id);
  assert.equal(ui.cuts().find((c) => c.current)?.label, "Main cut");
  assert.equal(carton.cut, head.id);
  ui.dispose();
});

test("fold in: the plan lists changes by record, leaving one out folds the rest", async () => {
  const { carton, ui } = await open();
  const main = carton.cut;
  const v = await carton.fork("30s cut");
  await carton.commit({ cut: v.id, ops: [set("b", "name", "Shorter")], author: bob });
  await carton.commit({ cut: v.id, ops: [set("d", "color", "black")], author: bob });
  await ui.refresh();
  const plan = await ui.planFold(v.id, main);
  assert.deepEqual(plan.changes.map((c) => c.id).sort(), ["items/b", "items/d"]);
  assert.ok(plan.changes.every((c) => c.author.name === "Bob"), "credits name who made each change");
  assert.match(plan.changes.find((c) => c.id === "items/b")!.summary, /Shorter/);
  assert.equal(plan.conflicts.length, 0);
  const r = await ui.fold(v.id, main, { leaveOut: ["items/d"], choices: {} });
  assert.equal(r.ok, true);
  const doc = (await carton.head(main)).doc;
  const item = (id: string) => (doc.items as Rec[]).find((i) => i.id === id)!;
  assert.equal(item("b").name, "Shorter");
  assert.equal(item("d").color, "red", "the change left out is not folded in");
  ui.dispose();
});

test("fold in with a conflict card: the pick decides, nothing is lost", async () => {
  const { carton, ui } = await open();
  const main = carton.cut;
  const v = await carton.fork("alt");
  await carton.commit({ cut: v.id, ops: [set("a", "name", "Theirs")], author: bob });
  await carton.commit({ ops: [set("a", "name", "Mine")] });
  await ui.refresh();
  const plan = await ui.planFold(v.id, main);
  assert.equal(plan.conflicts.length, 1);
  const card = plan.conflicts[0]!;
  assert.equal(card.id, "items/a/name");
  assert.equal(card.mine.summary, "“Mine”");
  assert.equal(card.theirs.summary, "“Theirs”");
  assert.equal(card.mine.where, "Main cut", "your side names the cut you fold into");
  assert.equal(card.theirs.where, "alt", "their side names the cut you fold in");
  const r = await ui.fold(v.id, main, { leaveOut: [], choices: { [card.id]: "theirs" } });
  assert.equal(r.ok, true);
  assert.equal(((await carton.head(main)).doc.items as Rec[]).find((i) => i.id === "a")!.name, "Theirs");
  ui.dispose();
});

test("undo turn undoes the whole Director turn and says so", async () => {
  const { carton, ui } = await open();
  await carton.commit({ ops: [set("a", "color", "blue")], author: director("t9") });
  await carton.commit({ ops: [set("b", "color", "blue")], author: director("t9") });
  await settle();
  const turn = ui.undoTurn()!;
  assert.equal(turn.author.name, "Director");
  assert.equal(turn.edits, 2);
  assert.ok(turn.label.length > 0 && !turn.label.startsWith("Undo"));
  const r = await ui.undo(turn.id);
  assert.equal(r.ok, true);
  const doc = (await carton.head()).doc;
  assert.equal((doc.items as Rec[]).find((i) => i.id === "a")!.color, "red");
  assert.equal((doc.items as Rec[]).find((i) => i.id === "b")!.color, "red");
  ui.dispose();
});

test("compare and watch the changes: real shots, aligned, and the N shots / X s of Y s summary", async () => {
  const { carton, ui } = await open();
  const first = `${carton.cut}@0`;
  await carton.commit({ ops: [set("b", "color", "blue")] });
  await settle();
  const head = ui.cuts().find((c) => c.current)!.head;
  const c = await ui.compare(first, head);
  assert.equal(c.a.clipCount, 4);
  assert.equal(c.b.length, 20);
  assert.equal(c.diff.shots, 1, "one clip's look changed: one shot differs");
  assert.equal(c.diff.seconds, 5);
  const d = await ui.shotDiff(first, head);
  assert.equal(d.a.length, 4);
  assert.equal(d.matches.length, 3);
  assert.equal(d.b[1]!.label, "B");
  ui.dispose();
});

test("credits and the published cut", async () => {
  const { carton, ui } = await open();
  await carton.commit({ ops: [set("c", "color", "blue")], author: explore("t2") });
  await settle();
  const cr = await ui.credits("c");
  assert.equal(cr.clip, "C");
  assert.equal(cr.lines[0]!.author.name, "Explore");
  const main = ui.cuts().find((c) => c.current)!;
  await ui.publish(main.id);
  assert.equal(ui.published()?.newerEdits, 0);
  assert.ok(!ui.cuts().some((c) => c.name.includes("(published)")), "published records aren't cuts you switch to");
  await carton.commit({ ops: [set("a", "color", "blue")] });
  await settle();
  await settle();
  assert.equal(ui.published()?.newerEdits, 1, "newer edits exist");
  ui.dispose();
});

test("sync words and presence from the sync client's events", async () => {
  const { carton, ui, emit } = await open();
  const branchId = carton.cut;
  assert.equal(ui.sync().kind, "local");
  emit({ type: "sync", status: "offline", waiting: 3 });
  assert.deepEqual(ui.sync(), { kind: "offline", waiting: 3 });
  emit({ type: "sync", status: "up-to-date", waiting: 0 });
  assert.deepEqual(ui.sync(), { kind: "upToDate" });
  emit({ type: "presence", branchId, actor: bob, state: { ghosts: [{ item: "a", track: "t1", start: 1, end: 6 }] } });
  assert.equal(ui.peers().length, 1);
  assert.equal(ui.ghosts()[0]!.itemId, "a");
  const peersBefore = ui.peers();
  emit({ type: "presence", branchId, actor: bob, state: { ghosts: [{ item: "a", track: "t1", start: 2, end: 7 }] } });
  assert.equal(ui.peers(), peersBefore, "a ghost moving doesn't change the peers list");
  assert.equal(ui.ghosts()[0]!.start, 2);
  emit({ type: "presence", branchId: "elsewhere", actor: bob, state: { ghosts: [{ item: "a", track: "t1", start: 2, end: 7 }] } });
  assert.equal(ui.ghosts().length, 0, "drags on another cut aren't ghosts over this timeline");
  assert.equal(ui.peers()[0]!.cutId, "elsewhere");
  emit({ type: "presence", branchId, actor: bob, state: null });
  assert.equal(ui.peers().length, 0);
  assert.equal(ui.ghosts().length, 0);
  ui.dispose();
});

test("late conflicts addressed to you become cards; picking your side commits it", async () => {
  const { carton, ui, emit } = await open();
  await carton.commit({ ops: [set("a", "name", "Head")], author: bob });
  // Core's convention (merge3(base, head, mine)): ours is the head on screen, theirs is your edit that lost.
  emit({ type: "notice", notice: { to: "human/alice", kind: "late-conflict", text: "", by: bob, cards: [{ kind: "field", path: "items/a/name", base: "A", ours: "Head", theirs: "Mine" }] } });
  assert.equal(ui.conflicts().length, 1);
  const card = ui.conflicts()[0]!;
  assert.equal(card.provisional, "theirs");
  assert.equal(card.mine.summary, "“Mine”");
  assert.equal(card.theirs.summary, "“Head”");
  assert.equal(card.theirs.author.name, "Bob");
  await ui.resolve(card.id, "mine");
  assert.equal(ui.conflicts().length, 0);
  assert.equal(((await carton.head()).doc.items as Rec[]).find((i) => i.id === "a")!.name, "Mine");
  ui.dispose();
});

test("helpers: path keys, actors and card ops", () => {
  assert.deepEqual(splitPathKey("items/a~1b/#time"), ["items", "a/b", "#time"]);
  const ui = toUiActor({ kind: "external", id: "claude-code", name: "Claude Code", group: "alice@laptop" }, alice, "alice@laptop");
  assert.equal(ui.name, "Claude Code (terminal)");
  assert.equal(ui.kind, "agent");
  assert.equal(ui.isYou, true);
  assert.equal(ui.parent, "human/alice");
  assert.deepEqual(cardOps({ kind: "group", path: "items/a/#time", base: null, ours: null, theirs: null }, { startTime: 1, endTime: 4 }), [
    { op: "set", path: ["items", "a", "startTime"], value: 1 },
    { op: "set", path: ["items", "a", "endTime"], value: 4 },
  ]);
  assert.deepEqual(cardOps({ kind: "record", path: "items/a", base: null, ours: null, theirs: null }, null), [{ op: "remove", path: ["items", "a"] }]);
});

test("over the bridge: the renderer's rows ask for their summaries, the worker describes only those", async () => {
  const { remoteUi, serveUi } = await import("../src/remote.ts");
  const { carton, ui } = await open();
  for (let i = 0; i < 30; i++) await carton.commit({ ops: [set("a", "color", `c${i}`)] });
  await settle();
  let client!: ReturnType<typeof remoteUi>;
  const server = serveUi(ui, (m) => setTimeout(() => client.receive(structuredClone(m)), 0));
  client = remoteUi((m) => setTimeout(() => server.receive(structuredClone(m)), 0));
  await client.ready;
  const h = client.ui.history();
  assert.equal(h.count("all"), 31);
  assert.equal(h.at("all", 0)!.summary, "", "not described yet");
  for (let i = 0; i < 3; i++) h.at("all", i);
  await settle();
  await settle();
  assert.match(client.ui.history().at("all", 0)!.summary, /c29/);
  assert.equal(client.ui.history().at("all", 20)!.summary, "", "rows nobody looked at stay undescribed");
  server.close();
  ui.dispose();
});
