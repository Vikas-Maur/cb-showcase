// History's words and Play on the laptop (2026-11-05), over the real engine: a code graphic's code changed by an agent
// is a row naming the graphic, with no code, at the graphic's place with its clip kind, so Play all plays it (it was a
// 700 ms flash with no place); a list with nothing to play says so; a turn named from Cardboard's composed prompt reads
// in its default words while it still ends its run of versions; a titled turn carries what it was asked.
import { test } from "node:test";
import assert from "node:assert/strict";
import { Carton } from "@carton/core";
import { createMemoryStore } from "@carton/store-memory";
import { fromCarton } from "../src/from-carton.ts";
import { hasPlace, nothingToPlay, playSteps } from "../src/player.ts";
import type { Change } from "../src/model.ts";
import { adapter, alice, claude, codeEdit, doc0 } from "./history-words.fixture.ts";

async function open() {
  const carton = await Carton.open({ adapter, store: createMemoryStore(), init: { doc: doc0(), cutName: "Main cut" }, actor: alice });
  const ui = fromCarton(carton, { me: alice });
  await ui.ready;
  return { carton, ui };
}
const at = (carton: Carton, seq: number) => ({ branchId: carton.cut, seq, pending: [] as never[] });

test("a code graphic's code changed by an agent: the graphic, no code, its place and kind; Play all plays it", async () => {
  const { carton, ui } = await open();
  try {
    await carton.commit({ ops: [codeEdit("a3 = 3", "a3 = 33")], author: claude });
    await ui.refresh();
    const v = ui.history().all!().at(-1)!;
    const changes = await ui.changesIn(v.id);
    assert.equal(changes.length, 1);
    const c = changes[0]!;
    assert.equal(c.text, "Changed the code of code graphic “Cardboard on Windows” (1 line)");
    assert.doesNotMatch(c.text, /export|function|Graphic\(/);
    assert.equal(c.at, 4, "the time column says where the graphic is (it said “—”)");
    assert.equal(c.end, 9);
    assert.equal(c.clip, "code", "the code graphic's mark, not the project's");
    assert.equal(c.itemId, undefined, "still the entry's change: no clip to bring back or select by it");
    assert.ok(hasPlace(c));
    const steps = playSteps(changes);
    assert.deepEqual(steps.map((s) => [s.start, s.end, s.rows]), [[3, 10, [0]]], "one spot over the graphic, a second either side: never the 700 ms flash");
  } finally { ui.dispose?.(); await carton.close(); }
});

test("nothing with a place (a frame rate's change alone): nothing to play; one change with a place is enough", () => {
  const c = (key: string, a?: number): Change => ({ key, text: key, kind: "change", clip: "project", ...(a !== undefined ? { at: a } : {}) });
  assert.equal(nothingToPlay([c("fps")]), true);
  assert.equal(nothingToPlay([c("fps"), c("ratio")]), true);
  assert.equal(nothingToPlay([c("fps"), c("clip", 3)]), false);
  assert.equal(nothingToPlay([]), false, "an empty list is no list to play (Play all is off for it already)");
  assert.equal(nothingToPlay(null), false);
  assert.equal(hasPlace(c("nan", Number.NaN)), false);
});

test("a turn named from Cardboard's composed prompt reads in its default words, and still ends its run of versions", async () => {
  const { carton, ui } = await open();
  try {
    await carton.commit({ ops: [codeEdit("a1 = 1", "a1 = 11")], author: claude });
    await carton.name(at(carton, 1), "[Earlier messages in this conversation did…");
    await carton.commit({ ops: [codeEdit("a2 = 2", "a2 = 22")], author: claude });
    await carton.name(at(carton, 2), "Make the second line bigger");
    await ui.refresh();
    const turns = ui.history().all!().filter((v) => v.kind === "turn");
    assert.equal(turns.length, 2, "two turns: the hidden name still ends the first (run boundaries read the stored name)");
    assert.equal(turns[0]!.name, undefined);
    assert.equal(turns[0]!.turn?.label, "", "no label: the row reads in its default words");
    assert.equal(turns[1]!.turn?.label, "Make the second line bigger");
    for (const v of ui.history().all!()) assert.doesNotMatch(JSON.stringify(v), /Earlier messages/);
  } finally { ui.dispose?.(); await carton.close(); }
});

test("a titled turn carries what it was asked; the panel's own rename keeps it", async () => {
  const { carton, ui } = await open();
  try {
    await carton.commit({ ops: [codeEdit("a4 = 4", "a4 = 44")], author: claude });
    await carton.name(at(carton, 1), "Okay in this edit, I have…");
    await ui.refresh();
    let v = ui.history().all!().at(-1)!;
    assert.equal(v.asked, undefined, "the person's own words are the title: nothing beside it");
    // main's titleTurn, through the worker's retitleTurn: the panel names it with the request
    await ui.nameVersion(v.id, "Bigger fourth line", { asked: "Okay in this edit, I have the fourth line too small, make it bigger" });
    v = ui.history().all!().at(-1)!;
    assert.equal(v.name, "Bigger fourth line");
    assert.equal(v.turn?.label, "Bigger fourth line");
    assert.equal(v.asked, "Okay in this edit, I have the fourth line too small, make it bigger");
    await ui.nameVersion(v.id, "Fourth line, bigger");
    await ui.refresh();
    v = ui.history().all!().at(-1)!;
    assert.equal(v.name, "Fourth line, bigger");
    assert.equal(v.asked, "Okay in this edit, I have the fourth line too small, make it bigger", "a rename keeps it");
  } finally { ui.dispose?.(); await carton.close(); }
});
