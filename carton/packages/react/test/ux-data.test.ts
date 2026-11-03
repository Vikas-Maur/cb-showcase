// The UX redesign's data (docs/carton-ux PLAN workstream 0) over the real engine: structured changes (0.1), their
// sentences (0.2), viewing (0.5), undoing any agent turn (0.6), an agent working (0.7) and a clip's history (0.8).
// fromCarton() on Carton.open with store-memory, no mocks; and the same through the remote bridge.
import { test } from "node:test";
import assert from "node:assert/strict";
import { Carton, POS, defineSchema, object, timeAlgebra, type Actor, type Doc, type Rec } from "@carton/core";
import type { HostAdapter } from "@carton/core/plugins";
import { createMemoryStore } from "@carton/store-memory";
import { fromCarton } from "../src/from-carton.ts";
import { remoteUi, serveUi, type ClientMessage, type ServerMessage } from "../src/remote.ts";
import type { CartonUi, Topic } from "../src/model.ts";

const TL = { collection: "items", lanes: "tracks", lane: "trackId", start: "startTime", end: "endTime", source: "trimStart", sourceEnd: "trimEnd", speed: "playbackSpeed" };
const schema = defineSchema({
  labels: { name: "project name", aspectRatio: "aspect ratio" },
  collections: {
    tracks: { seq: true, noun: "track" },
    items: {
      parent: { field: "trackId", collection: "tracks" },
      noun: "clip",
      nounOf: (r) => (r.type === "text" ? "title" : undefined),
      labels: { color: "color", name: "name" },
      groups: [{ name: "time", fields: ["startTime", "endTime", "trimStart", "trimEnd", "playbackSpeed"], algebra: timeAlgebra(TL) }],
      fields: { style: object() },
    },
  },
  timeline: TL,
  label: (coll, r) => String((r as Rec | undefined)?.name ?? (r as Rec | undefined)?.id ?? coll),
  hard: (coll, r) => (coll === "items" && !((r.endTime as number) > (r.startTime as number)) ? ["endTime must be greater than startTime"] : []),
});
const adapter: HostAdapter<Doc> = { name: "test", schema, schemaVersion: 1, fromHost: (h) => h, toHost: (d) => d };
const clip = (id: string, s: number, e: number, more: Rec = {}): Rec => ({ id, type: "video", trackId: "t1", startTime: s, endTime: e, trimStart: 0, trimEnd: e - s, name: id.toUpperCase(), color: "red", ...more });
const doc0 = (): Doc => ({ name: "Film", aspectRatio: "16:9", tracks: [{ id: "t1", [POS]: "V" }], items: [clip("a", 0, 5), clip("b", 5, 10), clip("c", 10, 15), clip("d", 15, 20), clip("t", 2, 7, { type: "text", name: "Summer sale" })] });
const alice: Actor = { kind: "human", id: "alice", name: "Alice", group: "alice@laptop" };
const director = (turn: string): Actor => ({ kind: "agent", id: `director/c1/${turn}`, name: "Director", turn, chat: "c1", group: "alice@laptop" });
const bob: Actor = { kind: "human", id: "bob", name: "Bob" };
const set = (id: string, f: string, v: unknown) => ({ op: "set" as const, path: ["items", id, f], value: v });
const move = (id: string, s: number, e: number) => [set(id, "startTime", s), set(id, "endTime", e)];
const NO_IDS = /[0-9a-f]{12,}|@\d+|main@/;

const live = new Set<ReturnType<typeof fromCarton>>();
const settle = async () => {
  for (let i = 0; i < 3; i++) await Promise.all([...live].map((h) => h.settled()));
};
async function open(doc: Doc = doc0(), extra: Partial<Parameters<typeof fromCarton>[1]> = {}) {
  const carton = await Carton.open({ adapter, store: createMemoryStore(), init: { doc, cutName: "Main cut" }, actor: alice });
  const ui = fromCarton(carton, { me: alice, ...extra });
  live.add(ui);
  await ui.ready;
  return { carton, ui };
}
const until = (ui: CartonUi, topic: Topic, ok: () => boolean, what: string) =>
  new Promise<void>((done, fail) => {
    if (ok()) return done();
    const t = setTimeout(() => fail(new Error(`timed out: ${what}`)), 3000);
    const off = ui.subscribe(topic, () => {
      if (!ok()) return;
      clearTimeout(t);
      off();
      done();
    });
  });

test("0.1: changes(a, b) are the change rows, counted as Compare counts them; a removal at its start in a; a project change has no place", async () => {
  const { carton, ui } = await open();
  const cut = carton.cut;
  await carton.commit({ ops: move("b", 7, 12), author: alice });
  await carton.commit({ ops: [{ op: "remove", path: ["items", "d"] }, { op: "set", path: ["aspectRatio"], value: "9:16" }], author: bob });
  await carton.commit({ ops: [set("t", "name", "Summer launch")], author: director("t1") });
  await settle();
  const list = await ui.changes(`${cut}@0`, `${cut}@3`);
  const cmp = await ui.compare(`${cut}@0`, `${cut}@3`);
  assert.equal(list.length, cmp.changeCount, "as many as Compare counts");
  const by = (k: string) => list.find((c) => c.key === k)!;
  assert.deepEqual([by("items/b").text, by("items/b").kind, by("items/b").clip, by("items/b").at, by("items/b").end, by("items/b").itemId], ["Moved “B” 2 s later (now starts at 0:07)", "change", "video", 7, 12, "b"]);
  assert.deepEqual([by("items/d").text, by("items/d").kind, by("items/d").at], ["Removed “D”", "remove", 15], "a removal: its start in a");
  assert.deepEqual([by("aspectRatio").text, by("aspectRatio").clip, by("aspectRatio").at], ["Changed the aspect ratio to “9:16”", "project", undefined]);
  assert.deepEqual([by("items/t").text, by("items/t").clip], ["Renamed “Summer sale” to “Summer launch”", "title"]);
  // who made each, from the per-version index (one cut, a before b)
  assert.deepEqual([by("items/b").author?.name, by("items/d").author?.name, by("items/t").author?.name], ["Alice", "Bob", "Director"]);
  assert.ok(by("items/b").when! > 0);
  // timeline order, the ones with no place last
  assert.deepEqual(list.map((c) => c.key), ["items/b", "items/t", "items/d", "aspectRatio"].sort((x, y) => (by(x).at ?? Infinity) - (by(y).at ?? Infinity)));
  // kept per pair: the same answer, not a second diff
  assert.equal(await ui.changes(`${cut}@0`, `${cut}@3`), list);
  for (const c of list) assert.doesNotMatch(c.text, NO_IDS, c.text);
});

test("0.1: the view model's changes never read a shot diff (the version card and the Changes view drop shotDiff)", async () => {
  let shots = 0;
  const counting = { shots: (..._a: unknown[]) => (shots++, []), lcs: () => [], describe: () => [] };
  const { carton, ui } = await open(doc0(), { engine: counting as never });
  const cut = carton.cut;
  await carton.commit({ ops: move("a", 1, 6) });
  await settle();
  const v = ui.history().at("all", 0)!;
  assert.equal((await ui.changesIn(v.id)).length, 1);
  assert.equal((await ui.changes(`${cut}@0`, `${cut}@1`)).length, 1);
  assert.equal(shots, 0);
});

test("0.2: every row's summary is a change sentence or a version's own words, never an id, a hash or a ref", async () => {
  const { carton, ui } = await open();
  const cut = carton.cut;
  await carton.commit({ ops: move("a", 2, 7), author: alice });
  await carton.commit({ ops: [set("b", "color", "blue"), set("c", "color", "green")], author: alice });
  await carton.commit({ ops: [set("d", "name", "Outro")], author: director("t1"), name: "Tighten the outro" });
  await ui.restore(`${cut}@1`);
  await settle();
  await ui.undo(ui.undoTurn()!.id);
  const v = await carton.fork("30s cut");
  await carton.commit({ cut: v.id, ops: [set("a", "color", "black")], author: bob });
  await ui.planFold(v.id, cut);
  await ui.fold(v.id, cut, { leaveOut: [], choices: {} });
  await settle();
  const h = ui.history();
  for (let i = 0; i < h.count("all"); i++) h.at("all", i);
  await settle();
  const rows = h.all!();
  const summaries = rows.map((r) => r.summary);
  for (const s of summaries) {
    assert.ok(s, "described");
    assert.doesNotMatch(s, NO_IDS, s);
  }
  assert.ok(summaries.includes("Moved “A” 2 s later (now starts at 0:02)"), summaries.join(" | "));
  assert.ok(summaries.includes("Changed the color of “B” and “C”"), summaries.join(" | "));
  assert.ok(summaries.some((s) => /^Restored the \d{1,2}:\d{2} [ap]m version$/.test(s)), summaries.join(" | "));
  assert.ok(summaries.some((s) => /^Undid the restore of the \d{1,2}:\d{2} [ap]m version$/.test(s)), summaries.join(" | "));
  assert.ok(summaries.includes("Folded in “30s cut”"), summaries.join(" | "));
  const fold = rows.find((r) => r.kind === "fold")!;
  assert.equal(fold.changes, 1);
  const start = rows.find((r) => r.start)!;
  assert.equal(start.summary, "Project created");
});

test("0.5: viewing names what the stage shows in one label; view(null) is back; the host's onPreview is the one way it swaps", async () => {
  const shown: (string | null)[] = [];
  const { carton, ui } = await open(doc0(), { onPreview: (p) => shown.push(p ? p.label : null) });
  const cut = carton.cut;
  await carton.commit({ ops: move("a", 2, 7), author: alice });
  await carton.commit({ ops: [set("b", "color", "blue")], author: director("t1"), name: "Add captions to the interview" });
  await carton.commit({ ops: [set("c", "color", "green")], author: alice });
  await carton.name(`${cut}@3`, "Sent to client");
  await ui.refresh();
  await settle();
  const rowOf = (seq: number) => ui.history().all!().find((v) => v.seq === seq)!;
  await ui.view({ kind: "version", versionId: rowOf(2).id });
  const v1 = ui.viewing()!;
  assert.deepEqual([v1.kind, v1.label, v1.versionId, v1.ref], ["version", "Director's “Add captions…”", rowOf(2).id, `${cut}@2`]);
  assert.match(v1.short, /^\d{1,2}:\d{2} [ap]m · Director$/);
  assert.equal(ui.preview()?.label, v1.label, "the deprecated preview says the same");
  await ui.view({ kind: "before", versionId: rowOf(2).id });
  assert.deepEqual([ui.viewing()!.kind, ui.viewing()!.label, ui.viewing()!.ref], ["before", "Before Director's “Add captions…”", `${cut}@1`]);
  await ui.view({ kind: "version", versionId: rowOf(1).id });
  assert.match(ui.viewing()!.label, /^Your edit from \d{1,2}:\d{2} [ap]m$/);
  await ui.view({ kind: "version", versionId: rowOf(3).id });
  assert.equal(ui.viewing()!.label, "“Sent to client”");
  await ui.view(null);
  assert.equal(ui.viewing(), null);
  assert.equal(ui.preview(), null);
  assert.equal(shown.at(-1), null);
  assert.equal(shown.filter((x) => x !== null).length, 4, "each view went through onPreview");
  // a ref that can't be loaded: it says so, and the editor stays on your edit
  await assert.rejects(ui.view({ kind: "version", ref: `${cut}@99` }), /Couldn't load this version/);
  assert.equal(ui.viewing(), null);
  // the deprecated alias still works, with its caller's label
  ui.openPreview(`${cut}@1`, "the version from 12:41");
  assert.deepEqual([ui.viewing()?.kind, ui.viewing()?.label], ["version", "the version from 12:41"]);
  ui.blockEdit();
  assert.equal(ui.viewing()?.blockedEdit, true);
  ui.openPreview(null);
  assert.equal(ui.viewing(), null);
});

test("0.5: a conflict card's side is viewed with its own label; a teammate's cut by its owner's name", async () => {
  const { carton, ui } = await open();
  ui.reportConflicts([{ kind: "group", path: "items/b/#time", base: { startTime: 5, endTime: 10, trimStart: 0, trimEnd: 5 }, ours: { startTime: 7, endTime: 12, trimStart: 0, trimEnd: 5 }, theirs: { startTime: 6, endTime: 11, trimStart: 0, trimEnd: 5 } }], { kind: "agent", id: "claude-code/s1", name: "Claude Code", group: "alice@laptop" });
  await settle();
  const card = ui.conflicts()[0]!;
  assert.equal(card.clip, "B");
  await ui.view({ kind: "conflict", conflictId: card.id, side: "theirs" });
  assert.deepEqual([ui.viewing()!.kind, ui.viewing()!.label], ["conflict", "Claude Code's move of “B”"]);
  await ui.view({ kind: "conflict", conflictId: card.id, side: "mine" });
  assert.equal(ui.viewing()!.label, "Your move of “B”");
  await ui.view(null);
  void carton;
});

test("0.6: undoing an older agent turn takes out only that turn; a later edit on another clip stays; a clash makes a card", async () => {
  const { carton, ui } = await open();
  await carton.commit({ ops: [set("a", "color", "blue")], author: director("t1") });
  await carton.commit({ ops: [set("b", "color", "blue")], author: director("t1"), name: "Make it blue" });
  await carton.commit({ ops: [set("c", "color", "green")], author: alice }); // a later edit, another clip
  await carton.commit({ ops: [set("a", "name", "Intro")], author: director("t2"), name: "Name the intro" }); // a later turn
  await ui.refresh();
  await settle();
  const turn = ui.history().all!().find((v) => v.kind === "turn" && v.name === "Make it blue")!;
  assert.equal(turn.changes ?? (await ui.changesIn(turn.id)).length, 2, "the turn's card lists both its changes");
  assert.equal((await ui.changesIn(turn.id)).length, 2);
  const r = await ui.undoTurnOf(turn.id);
  assert.equal(r.ok, true);
  assert.equal(r.conflicts, undefined);
  const head = (await carton.head()).doc;
  const item = (id: string) => (head.items as Rec[]).find((x) => x.id === id)!;
  assert.deepEqual([item("a").color, item("b").color, item("c").color, item("a").name], ["red", "red", "green", "Intro"], "only that turn's changes are out");
  await settle();
  for (let i = 0; i < 3; i++) ui.history().at("all", i);
  await settle();
  assert.equal(ui.history().at("all", 0)!.summary, "Took out Director's “Make it blue”");
  // a clash: a later edit changed the same thing again: it stays, and a card asks
  await carton.commit({ ops: [set("d", "color", "pink")], author: director("t3"), name: "Pink outro" });
  await carton.commit({ ops: [set("d", "color", "black")], author: alice });
  await ui.refresh();
  await settle();
  const t3 = ui.history().all!().find((v) => v.kind === "turn" && v.name === "Pink outro")!;
  const c = await ui.undoTurnOf(t3.id);
  assert.equal(c.ok, true);
  assert.equal(c.conflicts?.length, 1, "a card for the clash");
  // its sides come with their sentences, on the stage's card too (design QA G30: no fallback words on a real path)
  for (const k of [c.conflicts![0]!, ...ui.conflicts()]) assert.ok(k.mine.text && k.mine.did && k.mine.what && k.theirs.text && k.theirs.did && k.theirs.what, JSON.stringify(k));
  assert.equal(((await carton.head()).doc.items as Rec[]).find((x) => x.id === "d")!.color, "black", "the later edit stays until picked");
  assert.equal((await ui.undoTurnOf(ui.history().all!().find((v) => v.kind === "edit" && v.seq === 3)!.id)).ok, false, "a person's edit is no turn");
});

test("0.7: working is set while an in-app turn holds the timeline, counts what it changed, and clears when it ends", async () => {
  const { carton, ui } = await open();
  assert.equal(ui.working(), null);
  let fired = 0;
  ui.subscribe("working", () => fired++);
  ui.setWorking({ actor: { kind: "agent", id: "director/c1/t9", name: "Director" }, label: "Add music under the interview", actors: ["director/c1/t9"] });
  await settle();
  const w = ui.working()!;
  assert.deepEqual([w.actor.name, w.label, w.edits], ["Director", "Add music under the interview", 0]);
  await carton.commit({ ops: [set("a", "color", "blue")], author: director("t9") });
  await carton.commit({ ops: [set("b", "color", "blue"), set("a", "color", "teal")], author: director("t9") });
  await carton.commit({ ops: [set("c", "color", "blue")], author: alice }); // not the turn's
  await settle();
  assert.equal(ui.working()!.edits, 2, "2 changes so far: a and b");
  ui.setWorking(null);
  await settle();
  assert.equal(ui.working(), null);
  assert.ok(fired >= 3);
});

test("0.8: a clip's history lists only the versions that touched it, from the per-version index, never a diff (12k versions)", async () => {
  const items: Rec[] = [];
  for (let i = 0; i < 40; i++) items.push(clip(`c${i}`, i * 5, i * 5 + 5));
  const { carton, ui } = await open({ name: "Long", tracks: [{ id: "t1", [POS]: "V" }], items });
  const N = 12_000;
  for (let i = 1; i <= N; i++) await carton.commit({ ops: [set(`c${i % 40}`, "volume", i)] });
  await ui.refresh();
  await settle();
  assert.equal(ui.history().count("all"), N + 1);
  // count every state read and diff the view model could make
  let reads = 0;
  for (const m of ["checkout", "diff", "preview", "head"] as const) {
    const f = (carton as unknown as Record<string, (...a: unknown[]) => unknown>)[m]!.bind(carton);
    (carton as unknown as Record<string, unknown>)[m] = (...a: unknown[]) => (reads++, f(...a));
  }
  const t0 = performance.now();
  const got = await ui.clipVersions("c7");
  const ms = performance.now() - t0;
  assert.equal(got.ids.length, N / 40, "every 40th version touched c7");
  assert.equal(got.since, undefined, "the whole history, not the last day");
  assert.equal(reads, 0, "no state read, no diff");
  const all = ui.history().all!();
  const pos = new Map(all.map((v, i) => [v.id, i]));
  assert.ok(got.ids.every((id, i) => i === 0 || pos.get(id)! < pos.get(got.ids[i - 1]!)!), "newest first");
  // the filter itself: loading, then the rows
  const h = ui.history();
  assert.equal(h.status!({ item: "c7" }).loading, true);
  await until(ui, "history", () => !h.status!({ item: "c7" }).loading, "the clip's rows");
  assert.equal(h.count({ item: "c7" }), N / 40);
  assert.equal(h.at({ item: "c7" }, 0)!.seq, N - (N % 40 === 7 ? 0 : (N - 7) % 40));
  assert.equal(reads, 0);
  console.log(`  (clip filter over ${N} versions: ${ms.toFixed(1)} ms, unverified)`);
});

function pipe(served: CartonUi) {
  let client!: ReturnType<typeof remoteUi>;
  const server = serveUi(served, (m: ServerMessage) => queueMicrotask(() => client.receive(structuredClone(m))));
  client = remoteUi((m: ClientMessage) => queueMicrotask(() => server.receive(structuredClone(m))));
  return { client, server };
}

test("remote: changes, a row's changes, viewing, working and a clip's history cross the bridge as plain data", async () => {
  const { carton, ui } = await open();
  const cut = carton.cut;
  await carton.commit({ ops: move("b", 7, 12), author: alice });
  await carton.commit({ ops: [set("c", "color", "blue")], author: director("t1"), name: "Blue" });
  await settle();
  const { client } = pipe(ui);
  await client.ready;
  const r = client.ui;
  const list = await r.changes(`${cut}@0`, `${cut}@2`);
  assert.deepEqual(list, await ui.changes(`${cut}@0`, `${cut}@2`));
  assert.equal(await r.changes(`${cut}@0`, `${cut}@2`), await r.changes(`${cut}@0`, `${cut}@2`), "kept per pair on the client too");
  const top = r.history().at("all", 0)!;
  assert.deepEqual(await r.changesIn(top.id), await ui.changesIn(top.id));
  await r.view({ kind: "version", versionId: top.id });
  await until(r, "viewing", () => !!r.viewing(), "viewing");
  assert.equal(r.viewing()!.label, "Director's “Blue”");
  await r.view(null);
  await until(r, "viewing", () => !r.viewing(), "back");
  ui.setWorking({ actor: { kind: "agent", id: "director/c1/t5", name: "Director" }, label: "Add music" });
  await until(r, "working", () => !!r.working(), "working");
  assert.equal(r.working()!.label, "Add music");
  ui.setWorking(null);
  await until(r, "working", () => !r.working(), "done");
  assert.deepEqual((await r.clipVersions("b")).ids, (await ui.clipVersions("b")).ids);
  const h = r.history();
  h.count({ item: "c" });
  await until(r, "history", () => !h.status!({ item: "c" }).loading, "the clip's rows");
  assert.deepEqual([h.count({ item: "c" }), h.at({ item: "c" }, 0)!.id], [1, top.id]);
  assert.equal((await r.undoTurnOf(top.id)).ok, true);
});

test("0.2: a turn's row says what the whole turn did; when the turn goes on, that version says only its own change again", async () => {
  const { carton, ui } = await open();
  await carton.commit({ ops: [set("a", "color", "blue")], author: director("t7") });
  await carton.commit({ ops: [set("b", "color", "blue")], author: director("t7") });
  await ui.refresh();
  await settle();
  const describe = async () => {
    for (let i = 0; i < ui.history().count("all"); i++) ui.history().at("all", i);
    await settle();
  };
  await describe();
  const row = () => ui.history().all!().find((v) => v.seq === 2)!;
  assert.deepEqual([row().kind, row().changes, row().summary], ["turn", 2, "Changed the color of “A” and “B”"]);
  await carton.commit({ ops: [set("c", "color", "blue")], author: director("t7") });
  await settle();
  await describe();
  assert.deepEqual([row().kind, row().changes, row().summary], ["edit", 1, "Changed the color of “B” to “blue”"]);
  const top = ui.history().at("all", 0)!;
  assert.deepEqual([top.kind, top.changes, top.run, row().run], ["turn", 3, row().run, top.run], "one run, its newest the turn's row");
});
