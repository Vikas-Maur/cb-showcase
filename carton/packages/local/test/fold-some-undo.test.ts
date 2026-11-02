// Laptop P2-1 (merge/prod-2 @ 3b2407c3) through the write path `cb` and the app use: after `cb fold --leave-out` and
// `cb fold` (the rest), the second `cb undo` brought the rest back in instead of undoing the partial fold, and a third
// undid the fold. `cb undo --turn` of a turn that folded in some of a cut had the same fault: it inverted the partial
// revert alone, from the fold's own state, so the turn's undo brought in what the fold had left out.
import { test } from "node:test";
import assert from "node:assert/strict";
import { Carton } from "@carton/core";
import type { Actor, Doc } from "@carton/core";
import { createMemoryStore } from "@carton/store-memory";
import { localGroup } from "../src/identity.ts";
import { runWrite } from "../src/writes.ts";
import { adapter, doc0 } from "./support/real.ts";

const set = (id: string, f: string, v: unknown) => ({ op: "set" as const, path: ["timelineItems", id, f], value: v });
const names = (d: Doc) => ((d.timelineItems as { id: string; name: string }[]).filter((i) => ["c1", "c2", "c3"].includes(i.id))).map((i) => i.name);
const BEFORE = ["c1", "c2", "c3"], SOME = ["Alt c1", "c2", "c3"], ALL = ["Alt c1", "Alt c2", "c3"];

async function withAlt(author: Actor) {
  const c = await Carton.open({ adapter, store: createMemoryStore(), init: { doc: doc0() }, actor: author });
  const main = c.cut;
  const alt = await c.fork("Alt");
  await c.commit({ cut: alt.id, ops: [set("c1", "name", "Alt c1"), set("c2", "name", "Alt c2")], author });
  return { c, main, alt: alt.id };
}

test("`cb fold --leave-out`, `cb fold` (the rest), then `cb undo` twice: the rest, then the whole partial fold, each once", async () => {
  const me: Actor = { kind: "human", id: "me", group: localGroup() };
  const { c, main, alt } = await withAlt(me);
  try {
    const w = (id: string, op: Parameters<typeof runWrite>[1]["op"]) => runWrite(c, { id, actor: me, op });
    assert.equal((await w("f.1", { kind: "fold", from: alt, into: main, reject: ["timelineItems/c2"] })).status, "confirmed");
    assert.deepEqual(names((await c.head(main)).doc), SOME);
    assert.equal((await w("f.2", { kind: "fold", from: alt, into: main })).status, "confirmed", "the rest");
    assert.deepEqual(names((await c.head(main)).doc), ALL);
    const u1 = await w("u.1", { kind: "undo", cut: main });
    assert.deepEqual(names((await c.head(main)).doc), SOME, "① the rest");
    const u2 = await w("u.2", { kind: "undo", cut: main });
    assert.deepEqual(names((await c.head(main)).doc), BEFORE, "② the partial fold, entirely");
    assert.equal((u2 as { undid?: { label: string } }).undid?.label, "Undo merge", "named as a whole fold's undo is, never by the partial revert's kind");
    assert.equal((u1 as { undid?: { label: string } }).undid?.label, "Undo revert");
    assert.equal((await w("u.3", { kind: "undo", cut: main })).empty, true, "nothing left to undo");
    // redo walks forward the same way
    await w("r.1", { kind: "redo", cut: main });
    assert.deepEqual(names((await c.head(main)).doc), SOME);
    await w("r.2", { kind: "redo", cut: main });
    assert.deepEqual(names((await c.head(main)).doc), ALL);
  } finally {
    await c.close();
  }
});

test("`cb undo --turn` of a turn that folded in some of a cut puts Main back as it was before the turn", async () => {
  const director: Actor = { kind: "agent", id: "director/chat/t1", name: "Director", group: localGroup(), turn: "t1" };
  const { c, main, alt } = await withAlt(director);
  try {
    await c.commit({ cut: main, ops: [set("c3", "name", "Director c3")], author: director });
    assert.equal((await c.foldSome(alt, { into: main, reject: ["timelineItems/c2"], author: director })).status, "confirmed");
    assert.deepEqual(names((await c.head(main)).doc), ["Alt c1", "c2", "Director c3"]);
    const r = await runWrite(c, { id: "t.1", actor: director, op: { kind: "undoTurn", turn: "t1", cut: main } });
    assert.equal(r.status, "confirmed", JSON.stringify(r));
    assert.deepEqual(names((await c.head(main)).doc), BEFORE, "the turn undone: nothing of Alt came in");
    // the undo names the fold and its partial revert, so the turn has nothing left to undo
    const again = await runWrite(c, { id: "t.2", actor: director, op: { kind: "undoTurn", turn: "t1", cut: main } });
    assert.equal(again.status, "confirmed");
    assert.deepEqual(names((await c.head(main)).doc), BEFORE);
    assert.deepEqual(await c.undoStack(localGroup(), { cut: main }), [], "and ⌘Z finds no fold of the turn left either");
  } finally {
    await c.close();
  }
});
