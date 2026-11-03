// The review of the UX data (feat/ux-0-data, Codex GPT-6.1 Sol): each finding reproduced, then held fixed. Real Carton
// on store-memory, no mocks.
import { test } from "node:test";
import assert from "node:assert/strict";
import { Carton, changeList, defineSchema, type Actor, type Doc, type Op, type Rec } from "@carton/core";
import type { HostAdapter } from "@carton/core/plugins";
import { createMemoryStore } from "@carton/store-memory";
import { fromCarton } from "../src/from-carton.ts";

const alice: Actor = { kind: "human", id: "alice", group: "alice", name: "Alice" };
const agent: Actor = { kind: "agent", id: "director/chat/turn", turn: "turn", chat: "chat", group: "alice", name: "Director" };
const schema = defineSchema({ collections: { items: { labels: { color: "color", name: "name" } } }, label: (_c, r) => String((r as Rec | undefined)?.name ?? (r as Rec | undefined)?.id ?? "clip") });
const adapter: HostAdapter<Doc> = { schema, name: "test", schemaVersion: 1, fromHost: (d) => d, toHost: (d) => d };
const doc: Doc = { name: "Film", items: [{ id: "a", name: "A", color: "red" }, { id: "b", name: "B", color: "red" }, { id: "c", name: "C", color: "red" }] };
const set = (id: string, color: string): Op => ({ op: "set", path: ["items", id, "color"], value: color });
const open = (o: Record<string, unknown> = {}) => Carton.open({ adapter, store: createMemoryStore(), init: { doc }, actor: alice, ...o } as never);
const settle = async (ui: ReturnType<typeof fromCarton>) => {
  await ui.refresh();
  await ui.settled();
};
const describeAll = async (ui: ReturnType<typeof fromCarton>) => {
  for (let i = 0; i < ui.history().count("all"); i++) ui.history().at("all", i);
  await ui.settled();
};
const color = async (c: Awaited<ReturnType<typeof open>>, id: string, cut?: string) => ((await c.head(cut)).doc.items as Rec[]).find((x) => x.id === id)!.color;

test("#1: undoing a turn inherited from the cut this one was made from changes this cut, never that one", async () => {
  const c = await open();
  const main = c.cut;
  await c.commit({ ops: [set("a", "blue")], author: agent });
  const id = (await c.log())[0]!.change!;
  const fork = await c.fork("child");
  await c.switchTo(fork.id);
  const ui = fromCarton(c, { me: alice });
  await ui.ready;
  assert.equal((await ui.undoTurnOf(id)).ok, true);
  assert.deepEqual([await color(c, "a", main), await color(c, "a", fork.id)], ["blue", "red"]);
  ui.dispose();
  await c.close();
});

test("#2: a turn undone already is never inverted again: an edit made since to the same value stays", async () => {
  const c = await open();
  const ui = fromCarton(c, { me: alice });
  await ui.ready;
  await c.commit({ ops: [set("a", "blue")], author: agent });
  await settle(ui);
  const id = ui.history().at("all", 0)!.id;
  assert.equal((await ui.undoTurnOf(id)).ok, true);
  await settle(ui);
  await c.commit({ ops: [set("a", "blue")], author: alice });
  await settle(ui);
  const r = await ui.undoTurnOf(id);
  assert.deepEqual([r.ok, await color(c, "a")], [false, "blue"], r.error);
  // a redo puts it back in: then it can be taken out again
  ui.dispose();
  await c.close();
});

test("#4: an agent turn's undo takes the whole turn, however another edit interleaves it", async () => {
  const c = await open();
  const ui = fromCarton(c, { me: alice });
  await ui.ready;
  await c.commit({ ops: [set("a", "blue")], author: agent });
  await c.commit({ ops: [set("b", "blue")], author: alice });
  await c.commit({ ops: [set("c", "blue")], author: agent });
  await settle(ui);
  assert.equal((await ui.undoTurnOf(ui.history().at("all", 0)!.id)).ok, true);
  assert.deepEqual([await color(c, "a"), await color(c, "b"), await color(c, "c")], ["red", "blue", "red"]);
  ui.dispose();
  await c.close();
});

test("#5: a turn that starts with a fold-some says what the whole turn did, its fold included", async () => {
  const c = await open();
  const cut = c.cut;
  const fork = await c.fork("other");
  await c.commit({ cut: fork.id, ops: [set("a", "blue"), set("b", "blue")] });
  await c.foldSome(fork.id, { into: cut, author: agent, reject: ["items/b"] });
  const ui = fromCarton(c, { me: alice });
  await ui.ready;
  await c.commit({ cut, ops: [set("c", "blue")], author: agent });
  await settle(ui);
  await describeAll(ui);
  const v = ui.history().at("all", 0)!;
  const changes = (await ui.changesIn(v.id)).map((x) => x.key).sort();
  assert.deepEqual(changes, ["items/a", "items/c"], "A folded in, C changed; B left out is no change");
  assert.equal(v.changes, 2);
  ui.dispose();
  await c.close();
});

test("#6: a compacted agent run reads from where its versions start; its undo needs no squashed state", async () => {
  let at = Date.now() - 100_000;
  const c = await open({ keyframeEvery: 2, clock: () => at++ });
  for (let i = 0; i < 5; i++) await c.commit({ ops: [set(i % 2 ? "b" : "a", String(i))], author: agent });
  assert.ok((await c.compact({ olderThanDays: 0 })).squashed > 0);
  const ui = fromCarton(c, { me: alice });
  await ui.ready;
  await describeAll(ui);
  const rows = ui.history().all!();
  for (const v of rows) assert.notEqual(v.summary, "", `seq ${v.seq} described`);
  const top = rows.at(-1)!;
  assert.equal((await ui.undoTurnOf(top.id)).ok, true);
  assert.deepEqual([await color(c, "a"), await color(c, "b")], ["red", "red"]);
  ui.dispose();
  await c.close();
});

test("#7: an agent run cut in two by a name: each turn row says what its own turn did", async () => {
  const c = await open();
  const ui = fromCarton(c, { me: alice });
  await ui.ready;
  const a: Actor = { kind: "agent", id: "claude/session", name: "Claude Code", group: "alice" };
  await c.commit({ ops: [set("a", "blue")], author: a });
  await c.commit({ ops: [set("b", "blue")], author: a });
  await c.commit({ ops: [set("c", "blue")], author: a });
  await settle(ui);
  await describeAll(ui);
  await ui.nameVersion(ui.history().all!().find((v) => v.seq === 1)!.id, "first turn");
  await settle(ui);
  await describeAll(ui);
  await describeAll(ui);
  const top = ui.history().at("all", 0)!;
  assert.deepEqual([top.kind, top.changes, top.summary], ["turn", 2, "Changed the color of “B” and “C”"]);
  ui.dispose();
  await c.close();
});

test("#8: the clip filter reads the index again only when versions arrive, and then only the new ones", async () => {
  const c = await open();
  for (let i = 0; i < 12; i++) await c.commit({ ops: [set("a", String(i))], author: alice });
  const ui = fromCarton(c, { me: alice });
  await ui.ready;
  const asks: unknown[] = [];
  const touched = c.touched.bind(c);
  (c as { touched: typeof c.touched }).touched = (o) => (asks.push(o), touched(o));
  const h = ui.history();
  const filter = { item: "a" };
  const off = ui.subscribe("history", () => h.count(filter));
  h.count(filter);
  await ui.settled();
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(asks.length, 1);
  // describing the filtered rows asks nothing more
  for (let i = 0; i < 4; i++) h.at(filter, i);
  await ui.settled();
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(asks.length, 1, "described rows ask nothing");
  // a new version: only what came after the newest one it holds
  await c.commit({ ops: [set("a", "x")], author: alice });
  await ui.settled();
  h.count(filter);
  await new Promise((r) => setTimeout(r, 10));
  await ui.settled();
  assert.equal(asks.length, 2);
  assert.equal((asks[1] as { after?: number }).after, 12, "the index's tail only");
  assert.equal(h.count(filter), 13);
  off();
  ui.dispose();
  await c.close();
});

test("#9: a panel opened during a turn shows what the turn changed so far; told the same turn again, it keeps it", async () => {
  const c = await open();
  const ui = fromCarton(c, { me: alice });
  await ui.ready;
  const since = Date.now();
  ui.setWorking({ actor: agent, label: "Do it", since });
  await c.commit({ ops: [set("a", "blue")], author: agent });
  await settle(ui);
  assert.equal(ui.working()!.edits, 1);
  ui.setWorking({ actor: agent, label: "Do it", since });
  assert.equal(ui.working()!.edits, 1, "the same turn again keeps its count");
  const late = fromCarton(c, { me: alice });
  await late.ready;
  late.setWorking({ actor: agent, label: "Do it", since });
  await late.settled();
  assert.equal(late.working()!.edits, 1, "a panel opened later reads it back");
  late.dispose();
  ui.dispose();
  await c.close();
});

test("#10: an older openPreview that fails after a newer view never clears it", async () => {
  const c = await open();
  let rejectFirst!: (e: Error) => void;
  const preview = c.preview.bind(c);
  let n = 0;
  (c as { preview: typeof c.preview }).preview = (ref) => (++n === 1 ? new Promise((_r, reject) => (rejectFirst = reject)) : preview(ref));
  const shown: (string | null)[] = [];
  const ui = fromCarton(c, { me: alice, onPreview: (p) => shown.push(p ? p.label : null) });
  await ui.ready;
  const ref = `${c.cut}@0`;
  ui.openPreview(ref, "old request");
  await ui.view({ kind: "version", ref, label: "new request" });
  const before = ui.viewing();
  rejectFirst(new Error("old failure"));
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(ui.viewing(), before);
  assert.notEqual(shown.at(-1), null);
  ui.dispose();
  await c.close();
});

test("#11, #12: no record is named by its own id; a root field's key is escaped as the index's", async () => {
  const s = defineSchema({ collections: { items: {} } });
  const base: Doc = { items: [{ id: "0123456789abcdef01234567", x: 1 }] };
  const rows = changeList([{ op: "set", path: ["items", "0123456789abcdef01234567", "x"], value: 2 }], base, s);
  assert.equal(rows[0]!.text, "Changed the x of an item to 2");
  assert.doesNotMatch(rows[0]!.text, /[0-9a-f]{12,}/);
  const s2 = defineSchema({ collections: {} });
  const b: Doc = { "a/b": 1 };
  const c = await Carton.open({ adapter: { ...adapter, schema: s2 }, store: createMemoryStore(), init: { doc: b }, actor: alice });
  await c.commit({ ops: [{ op: "set", path: ["a/b"], value: 2 }] });
  assert.equal(changeList([{ op: "set", path: ["a/b"], value: 2 }], b, s2)[0]!.key, (await c.touched())[0]!.records[0]);
  await c.close();
});
