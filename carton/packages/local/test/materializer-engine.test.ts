// The holder's materializer engine is cardboard-adapter's `cartonMaterializerEngine`, as is (`b4c9b5f`: local's wrapper
// is gone, its jobs are the engine's). cardboard's materializer uses an optional engine method only when the engine has
// it, so one missing is silently not used: without `changesSince`, the freeze can't tell a save that repeated an edit it
// hid (cardboard-adapter review rounds 13-15), and in the app such a save is merged as before (round 13's double ripple).
import { test } from "node:test";
import assert from "node:assert/strict";
import { Carton } from "@carton/core";
import type { Actor, Rec } from "@carton/core";
import { cartonMaterializerEngine } from "../src/index.ts";
import { createMemoryStore } from "@carton/store-memory";
import { adapter, doc0 } from "./support/real.ts";

const me: Actor = { kind: "human", id: "human:me" };
const agent: Actor = { kind: "agent", id: "director/me/t1", name: "Director" };
const set = (id: string, f: string, value: unknown) => ({ op: "set" as const, path: ["timelineItems", id, f], value });

async function opened() {
  const c = await Carton.open({ adapter, store: createMemoryStore(), init: { doc: doc0() }, actor: { kind: "system", id: "engine" } });
  return { c, eng: cartonMaterializerEngine(c) };
}

test("the holder's engine gives changesSince: the confirmed changes after a seq, newest first, before and after", async () => {
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
    const until: number[] = [];
    for await (const ch of eng.changesSince(from, { cut: c.cut, until: from + 3 })) until.push(ch.seq);
    assert.deepEqual(until, [from + 2, from + 1], "until is exclusive");
  } finally {
    await c.close();
  }
});

test("the holder's engine has every optional method cardboard's materializer uses (one missing is silently unused)", async () => {
  const { c, eng } = await opened();
  try {
    const e = eng as unknown as Record<string, unknown>;
    const missing = ["changesSince", "newChangeId", "own", "cut", "headRef", "shared"].filter((k) => typeof e[k] !== "function");
    assert.deepEqual(missing, []);
    await eng.head();
    assert.equal(eng.shared!(), false, "a local cut: read from the cut, no option needed");
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
