// UX redesign PLAN 5.3 over the real engine (Carton.open on store-memory, no mocks): each action says which versions it
// made (`made`), and those are exactly what the person's Ctrl+Z takes back next, newest first: a restore, a fold (one
// version, a fold-some's pair as one, a fold with what an earlier partial fold left out as two), a conflict pick (none
// for the side already in the timeline: an Undo there would take back an earlier change), Undo this turn, Fold in the
// rest. A toast's Undo is offered on exactly these, and the host checks them against the undo stack before it steps.
import { test } from "node:test";
import assert from "node:assert/strict";
import { Carton, POS, defineSchema, timeAlgebra, type Actor, type Doc, type Rec } from "@carton/core";
import type { HostAdapter } from "@carton/core/plugins";
import { createMemoryStore } from "@carton/store-memory";
import { fromCarton } from "../src/from-carton.ts";
import type { Made } from "../src/model.ts";

const TL = { collection: "items", lanes: "tracks", lane: "trackId", start: "startTime", end: "endTime", source: "trimStart", sourceEnd: "trimEnd", speed: "playbackSpeed" };
const schema = defineSchema({
  collections: {
    tracks: { seq: true },
    items: { parent: { field: "trackId", collection: "tracks" }, groups: [{ name: "time", fields: ["startTime", "endTime", "trimStart", "trimEnd", "playbackSpeed"], algebra: timeAlgebra(TL) }] },
  },
  timeline: TL,
  label: (coll, r) => String((r as Rec | undefined)?.name ?? coll),
});
const adapter: HostAdapter<Doc> = { name: "test", schema, schemaVersion: 1, fromHost: (h) => h, toHost: (d) => d };
const clip = (id: string, s: number, e: number): Rec => ({ id, trackId: "t1", startTime: s, endTime: e, trimStart: 0, trimEnd: e - s, name: id.toUpperCase(), color: "red" });
const doc0 = (): Doc => ({ name: "Film", tracks: [{ id: "t1", [POS]: "V" }], items: [clip("a", 0, 5), clip("b", 5, 10), clip("c", 10, 15)] });
const alice: Actor = { kind: "human", id: "alice", name: "Alice", group: "alice@laptop" };
const director = (turn: string): Actor => ({ kind: "agent", id: `director/c1/${turn}`, name: "Director", turn, chat: "c1", group: "alice@laptop" });
const set = (id: string, f: string, v: unknown) => ({ op: "set" as const, path: ["items", id, f], value: v });

async function open() {
  const carton = await Carton.open({ adapter, store: createMemoryStore(), init: { doc: doc0(), cutName: "Main cut" }, actor: alice });
  const ui = fromCarton(carton, { me: alice });
  await ui.ready;
  return { carton, ui };
}
/**
 * What Ctrl+Z (or, for `by: "redo"`, redo) would take back next on `cut`, newest first, as many as `made` holds: they
 * must be its versions, reversed.
 */
async function onTop(carton: Carton, made: Made | undefined) {
  assert.ok(made && made.changes.length, "the action says what it made: " + JSON.stringify(made));
  const opts = { cut: made.cut, limit: made.changes.length };
  const top = await (made.by === "redo" ? carton.redoStack(alice.group, opts) : carton.undoStack(alice.group, opts));
  assert.deepEqual(top.map((e) => e.changeId), [...made.changes].reverse(), `exactly what ${made.by ?? "undo"} takes back next`);
}

test("PLAN 5.3: a restore, Undo this turn and a conflict pick say what they made: Ctrl+Z's next; the side shown makes none", async () => {
  const { carton, ui } = await open();
  try {
    await carton.commit({ ops: [set("a", "color", "blue")], author: alice });
    await carton.commit({ ops: [set("b", "color", "blue")], author: director("t1"), name: "Make it blue" });
    await ui.refresh();
    await ui.settled();
    const first = ui.history().all!().find((v) => v.seq === 1)!;
    const restored = await ui.restore(first.ref);
    await onTop(carton, restored?.made);
    assert.equal(restored!.made!.cut, carton.cut);
    await ui.refresh();
    await ui.settled();
    const turn = ui.history().all!().find((v) => v.kind === "turn")!;
    const out = await ui.undoTurnOf(turn.id);
    assert.equal(out.ok, true);
    // it is an undo itself: Ctrl+Z never takes it back (the restore is still Ctrl+Z's next), redo does
    assert.equal(out.made?.by, "redo");
    await onTop(carton, out.made);
    await onTop(carton, restored?.made);
    // a card: the person's own side commits, and that is what Ctrl+Z takes back; the side on screen commits nothing
    // (two clips: identical cards show once)
    const card = (cid: string, id: string) => ({ kind: "field" as const, path: `items/${id}/color`, base: "red", ours: "green", theirs: "pink", cid });
    ui.reportConflicts([card("k1", "c"), card("k2", "a")]);
    const [k1, k2] = ui.conflicts();
    const before = (await carton.log()).length;
    const none = await ui.resolve(k1!.id, "theirs");
    assert.equal(none && "made" in none ? none.made : undefined, undefined, "keeping what shows made nothing");
    assert.equal((await carton.log()).length, before, "and committed nothing");
    const mine = await ui.resolve(k2!.id, "mine");
    await onTop(carton, mine && "made" in mine ? mine.made : undefined);
  } finally {
    ui.dispose();
    await carton.close();
  }
});

test("PLAN 5.3: a fold says what it made: one version, a fold-some's pair as one, and with an earlier fold's rest, both", async () => {
  const { carton, ui } = await open();
  try {
    const main = carton.cut;
    const alt = await carton.fork("Alt cut");
    await carton.commit({ cut: alt.id, ops: [set("a", "color", "blue")], author: alice });
    await carton.commit({ cut: alt.id, ops: [set("b", "color", "blue")], author: alice });
    await ui.settled();
    // some of it: b left out (a fold and its partial revert, one version, one Ctrl+Z)
    const plan = await ui.planFold(alt.id, main);
    const b = plan.changes.find((c) => c.id.includes("/b"))!;
    assert.ok(b, JSON.stringify(plan.changes.map((c) => c.id)));
    const some = await ui.fold(alt.id, main, { choices: {}, leaveOut: [b.id] });
    assert.equal(some.ok, true);
    assert.equal(some.made?.changes.length, 1, "one version: " + JSON.stringify(some.made));
    await onTop(carton, some.made);
    // then something new on Alt, and Fold in again: the new change and what was left out, two versions
    await carton.commit({ cut: alt.id, ops: [set("c", "color", "blue")], author: alice });
    await ui.settled();
    await ui.planFold(alt.id, main);
    const both = await ui.fold(alt.id, main, { choices: {}, leaveOut: [] });
    assert.equal(both.ok, true);
    assert.equal(both.made?.changes.length, 2, "the fold and the rest: " + JSON.stringify(both.made));
    await onTop(carton, both.made);
    const head = ((await carton.head(main)).doc.items as Rec[]).map((i) => i.color);
    assert.deepEqual(head, ["blue", "blue", "blue"]);
    // nothing new to fold: no version, nothing to undo
    await ui.planFold(alt.id, main);
    const nothing = await ui.fold(alt.id, main, { choices: {}, leaveOut: [] });
    assert.equal(nothing.made, undefined, "made nothing: " + JSON.stringify(nothing));
  } finally {
    ui.dispose();
    await carton.close();
  }
});

test("PLAN 5.3: Fold in the rest (a partial fold's row) says what it made", async () => {
  const { carton, ui } = await open();
  try {
    const main = carton.cut;
    const alt = await carton.fork("Alt cut");
    await carton.commit({ cut: alt.id, ops: [set("a", "color", "blue")], author: alice });
    await carton.commit({ cut: alt.id, ops: [set("b", "color", "blue")], author: alice });
    await ui.settled();
    const plan = await ui.planFold(alt.id, main);
    const b = plan.changes.find((c) => c.id.includes("/b"))!;
    assert.equal((await ui.fold(alt.id, main, { choices: {}, leaveOut: [b.id] })).ok, true);
    await ui.refresh();
    await ui.settled();
    const row = await (async () => {
      for (let i = 0; i < 20; i++) {
        const r = ui.history().all!().find((v) => v.foldRest);
        if (r) return r;
        await new Promise((ok) => setTimeout(ok, 25));
        await ui.settled();
      }
      return undefined;
    })();
    assert.ok(row, "the partial fold's row offers the rest");
    const rest = await ui.foldRest(row!.id);
    assert.equal(rest.ok, true, JSON.stringify(rest));
    await onTop(carton, rest.made);
  } finally {
    ui.dispose();
    await carton.close();
  }
});
