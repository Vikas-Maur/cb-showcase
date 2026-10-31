// WriteOp `head` (windows-sync review round 4 #1, owner's tests): every answer that saved (confirmed, pending,
// conflicts) carries the holder's head of the cut it went to when the write asks, so the Windows app's cb never writes
// an older project.json over the holder's state. In process here (the holder's side of the answer); commit-head covers
// the real processes. The cost: the head is core's `head(cut)`, whose records are History's own, frozen and shared with
// every other state, so asking on every write copies no record. A write that doesn't ask gets no head at all.
import { test } from "node:test";
import assert from "node:assert/strict";
import { Carton } from "@carton/core";
import type { Actor, Doc, Rec } from "@carton/core";
import { createMemoryStore } from "@carton/store-memory";
import { runWrite } from "../src/writes.ts";
import type { CbResult, WriteHead } from "../src/writes.ts";
import { adapter, doc0 } from "./support/real.ts";

const me: Actor = { kind: "human", id: "human:me" };
const set = (id: string, f: string, v: unknown) => ({ op: "set" as const, path: ["timelineItems", id, f], value: v });
const items = (d: unknown) => (d as Doc).timelineItems as Rec[];
const rec = (d: unknown, id: string) => items(d).find((r) => r.id === id)!;
let n = 0;
const write = (c: Carton, op: object) => runWrite(c, { id: `wh.${++n}`, actor: me, op: op as never });
const headOf = (r: CbResult) => r.head as WriteHead | undefined;

async function opened() {
  return Carton.open({ adapter, store: createMemoryStore(), init: { doc: doc0() }, actor: me });
}

test("a confirmed write that asks gets the head with its edit in; one that doesn't ask gets none", async () => {
  const c = await opened();
  try {
    const plain = await write(c, { kind: "commit", ops: [set("c1", "opacity", 0.3)] });
    assert.equal(plain.status, "confirmed", JSON.stringify(plain));
    assert.ok(!("head" in plain), "no head unasked: nothing read or sent");

    const r = await write(c, { kind: "commit", ops: [set("c1", "opacity", 0.6)], head: true });
    assert.equal(r.status, "confirmed", JSON.stringify(r));
    const h = headOf(r);
    assert.ok(h, "the head came back");
    assert.equal(h.ref.branchId, c.cut);
    assert.equal(h.ref.seq, r.seq, "the head is the version this write made");
    assert.equal(rec(h.doc, "c1").opacity, 0.6);

    // a save that changes nothing (round 4 #1's case): confirmed with nothing new, and the head still comes back
    const same = await write(c, { kind: "commit", doc: h.doc, head: true });
    assert.equal(same.status, "confirmed", JSON.stringify(same));
    assert.equal(headOf(same)?.ref.seq, r.seq, "the same version");
    assert.equal(rec(headOf(same)!.doc, "c1").opacity, 0.6);
  } finally {
    await c.close();
  }
});

test("the head is the cut the write went to, not the current one (commit and restore on another cut)", async () => {
  const c = await opened();
  try {
    const main = c.cut;
    const forked = await write(c, { kind: "fork", name: "Alt" });
    const alt = (forked.cut as { id: string }).id;
    assert.ok(alt && alt !== main);
    assert.equal(c.cut, main, "forking doesn't switch");
    const altBase = (await c.head(alt)).ref;

    const r = await write(c, { kind: "commit", cut: alt, ops: [set("c2", "name", "on alt")], head: true });
    assert.equal(r.status, "confirmed", JSON.stringify(r));
    assert.equal(headOf(r)?.ref.branchId, alt);
    assert.equal(rec(headOf(r)!.doc, "c2").name, "on alt");
    assert.notEqual(rec((await c.head()).doc, "c2").name, "on alt", "the current cut doesn't have it");

    const back = await write(c, { kind: "restore", ref: `${alt}@${altBase.seq}`, cut: alt, head: true });
    assert.equal(back.status, "confirmed", JSON.stringify(back));
    assert.equal(headOf(back)?.ref.branchId, alt);
    assert.equal(rec(headOf(back)!.doc, "c2").name, "c2", "the restore is in");
  } finally {
    await c.close();
  }
});

test("a save answered with conflicts (a stale clash; the rest landed) carries the head too", async () => {
  const c = await opened();
  try {
    const root = (await c.head()).ref;
    assert.equal((await write(c, { kind: "commit", ops: [set("c1", "name", "newer")] })).status, "confirmed");
    const r = await write(c, { kind: "commit", base: root, ops: [set("c1", "name", "stale"), set("c3", "name", "mine")], head: true });
    assert.equal(r.status, "conflicts", JSON.stringify(r));
    const h = headOf(r);
    assert.ok(h, "the head came back with the cards");
    assert.equal(rec(h.doc, "c3").name, "mine", "the rest landed");
    assert.equal(rec(h.doc, "c1").name, "newer", "the card kept head's value");
  } finally {
    await c.close();
  }
});

test("the cost: the head shares the holder's frozen records, so an answer copies none, however often it is asked", async () => {
  const c = await opened();
  try {
    const before = (await c.head()).doc;
    const r = await write(c, { kind: "commit", ops: [set("c2", "opacity", 0.5)], head: true });
    const h = headOf(r)!.doc;
    for (const x of items(h)) assert.ok(Object.isFrozen(x), `${x.id} is frozen`);
    for (const x of items(h)) if (x.id !== "c2") assert.equal(x, rec(before, x.id as string), `${x.id}: the record the head had before, not a copy`);
    assert.notEqual(rec(h, "c2"), rec(before, "c2"), "the edited record is new");
    // the same records as the holder's own head now, and as the next answer's: nothing copied per answer
    const now = (await c.head()).doc;
    for (const x of items(h)) assert.equal(x, rec(now, x.id as string));
    const again = headOf(await write(c, { kind: "commit", doc: now, head: true }))!.doc;
    for (const x of items(again)) assert.equal(x, rec(h, x.id as string), `${x.id}: shared between two answers`);
    // the answer's doc is the caller's to hand on: its collection array is its own (core's head), its records refuse
    // an edit in place, so the holder's history can't be changed through it
    assert.notEqual(items(again), items(h));
    assert.throws(() => { (rec(again, "c1") as { opacity: number }).opacity = 0; }, TypeError);
  } finally {
    await c.close();
  }
});
