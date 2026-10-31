// The holder's materializer engine (`CartonMaterializerEngine`) wraps cardboard-adapter's `cartonMaterializerEngine`.
// cardboard's materializer uses an optional engine method only when the engine has it, so one the wrapper leaves out is
// silently not used: without `changesSince`, the freeze can't tell a save that repeated an edit it hid (cardboard-adapter
// review rounds 13-15), and in the app such a save is merged as before (round 13's double ripple).
import { test } from "node:test";
import assert from "node:assert/strict";
import { Carton } from "@carton/core";
import type { Actor, Rec } from "@carton/core";
import { cartonMaterializerEngine } from "@carton/cardboard/node";
import { createMemoryStore } from "@carton/store-memory";
import { CartonMaterializerEngine } from "../src/materializer-engine.ts";
import { adapter, doc0 } from "./support/real.ts";

const me: Actor = { kind: "human", id: "human:me" };
const agent: Actor = { kind: "agent", id: "director/me/t1", name: "Director" };
const set = (id: string, f: string, value: unknown) => ({ op: "set" as const, path: ["timelineItems", id, f], value });

async function opened() {
  const c = await Carton.open({ adapter, store: createMemoryStore(), init: { doc: doc0() }, actor: { kind: "system", id: "engine" } });
  return { c, eng: new CartonMaterializerEngine(c) };
}

test("the wrapper passes changesSince through: the confirmed changes after a seq, newest first, before and after", async () => {
  const { c, eng } = await opened();
  try {
    const from = (await c.head()).ref.seq;
    for (const v of [0.1, 0.2, 0.3]) assert.equal((await c.commit({ author: me, ops: [set("c1", "opacity", v)] })).status, "confirmed");
    const seen: { seq: number; before: number; after: number }[] = [];
    const op = (d: { timelineItems?: unknown }) => (d.timelineItems as Rec[]).find((i) => i.id === "c1")!.opacity as number;
    for await (const ch of eng.changesSince(from, { cut: c.cut })) seen.push({ seq: ch.seq, before: op(ch.before), after: op(ch.after) });
    assert.deepEqual(seen, [
      { seq: from + 3, before: 0.2, after: 0.3 },
      { seq: from + 2, before: 0.1, after: 0.2 },
      { seq: from + 1, before: 1, after: 0.1 },
    ]);
    // what the adapter's own engine gives
    const inner = cartonMaterializerEngine(c);
    const theirs: number[] = [];
    for await (const ch of inner.changesSince!(from, { cut: c.cut, until: from + 3 })) theirs.push(ch.seq);
    const mine: number[] = [];
    for await (const ch of eng.changesSince(from, { cut: c.cut, until: from + 3 })) mine.push(ch.seq);
    assert.deepEqual(mine, theirs);
    assert.deepEqual(mine, [from + 2, from + 1], "until is exclusive");
  } finally {
    await c.close();
  }
});

test("every method cardboard-adapter's engine has, the wrapper has too (an optional one left out is silently unused)", async () => {
  const { c, eng } = await opened();
  try {
    const inner = cartonMaterializerEngine(c) as unknown as Record<string, unknown>;
    const missing = Object.keys(inner).filter((k) => typeof inner[k] === "function" && typeof (eng as unknown as Record<string, unknown>)[k] !== "function");
    assert.deepEqual(missing, []);
  } finally {
    await c.close();
  }
});

test("a save whose only edit is an invalid record: answered with its card, nothing committed, on the engine's cut", async () => {
  const { c, eng } = await opened();
  try {
    await eng.head();
    const at = await c.head();
    const doc = structuredClone(at.doc) as { timelineItems: Rec[] };
    const c1 = doc.timelineItems.find((i) => i.id === "c1")!;
    c1.endTime = c1.startTime; // ends where it starts: a hard validator refuses it
    const r = await eng.commit({ doc: doc as never, base: { baseDoc: structuredClone(at.doc), baseSeq: at.ref.seq, causal: [] }, author: agent, meta: { file: ".scratch/views/a.tsx", view: "a" }, id: c.newChangeId() });
    assert.equal(r.status, "conflicts", JSON.stringify(r));
    assert.deepEqual(r.cards?.map((x) => [x.kind, x.path]), [["invalid", "timelineItems/c1"]]);
    assert.equal(r.cut, c.cut, "the cut it was answered on");
    assert.equal(r.seq, at.ref.seq, "nothing committed");
  } finally {
    await c.close();
  }
});
