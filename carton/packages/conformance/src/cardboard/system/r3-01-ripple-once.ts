// R3-01: a pending ripple (a recorded remap intent) meets a concurrent insert, and is pushed more than once: it applies
// exactly once. On the real engine and history (port of system-v11 `r3-01-ripple-once.test.mjs`, in its
// single-sequencer form until the sync client lands: the two pushers become the same stable id committed twice, and
// the engine check is kept as it was).
// V1: a [0,10], gap [10,15], c [15,25], d [25,35]. The agent closes the gap: a ripple at 15 by −5. Bob inserts h at
// [40,45] meanwhile, so the ripple (span [10, ∞)) is rejected and rebased: h maps through it once, to [35, 40].
import test from "node:test";
import assert from "node:assert/strict";
import { rippleDelete, remapSpan } from "@carton/core";
import type { Doc, Op, Intent, StateRef } from "@carton/core";
import { fromHost, toHost } from "@carton/cardboard";
import { openWorld, clip, find, BOB, type Item, type World } from "./world.ts";

const AGENT = { kind: "agent" as const, id: "claude-code/s1", name: "Claude Code" };

/** The named ripple action (`cb` ripple, the renderer's rippleDeleteGap): its ops and its recorded remap. */
function rippleAction(doc: Doc, track: string, at: number, delta: number): { ops: Op[]; intent: Intent } {
  const maps = { [track]: rippleDelete(at + delta, -delta) };
  const ops: Op[] = [];
  for (const rec of (doc.timelineItems ?? []) as Item[]) {
    if (rec.trackId !== track) continue;
    const m = remapSpan(maps[track], rec.startTime as number, rec.endTime as number);
    if (!m || (m[0] === rec.startTime && m[1] === rec.endTime)) continue;
    ops.push({ op: "set", path: ["timelineItems", rec.id, "startTime"], value: m[0] }, { op: "set", path: ["timelineItems", rec.id, "endTime"], value: m[1] });
  }
  return { ops, intent: { kind: "ripple-delete", maps } };
}

async function scenario(t: test.TestContext): Promise<{ w: World; r0: { ref: StateRef; doc: Doc }; R: string; ripple: { ops: Op[]; intent: Intent } }> {
  const w = await openWorld(t, { items: [clip("a", 0, 10), clip("c", 15, 25), clip("d", 25, 35)], tracks: ["V1"] });
  const r0 = await w.carton.head();
  const ripple = rippleAction(r0.doc, "V1", 15, -5);
  // Bob's insert lands first
  const h0 = toHost(r0.doc);
  const ins = await w.carton.commit({ doc: fromHost({ ...h0, timelineItems: [...(h0.timelineItems as Item[]), clip("h", 40, 45)] }, r0.doc), base: r0.ref, author: BOB });
  assert.equal(ins.status, "confirmed");
  // the ripple, made on the state before it, with a stable id
  const R = `${"f".repeat(24)}.1`;
  const res = await w.carton.commit({ ops: ripple.ops, intent: ripple.intent, base: r0.ref, author: AGENT, id: R });
  assert.equal(res.status, "confirmed");
  assert.ok(res.status === "confirmed" && res.rebased >= 1, "the ripple's span [10, ∞) met the insert: rejected and rebased");
  return { w, r0, R, ripple };
}

const times = async (w: World) => {
  const h = await w.head();
  return ["a", "c", "d", "h"].map((x) => [find(h, x).startTime, find(h, x).endTime]);
};

test(`R3-01 ripple-once: forced reject, rebased and confirmed; shifted once and h mapped through the ripple once [real engine]`, async (t) => {
  const { w, R } = await scenario(t);
  assert.deepEqual(await times(w), [[0, 10], [10, 20], [20, 30], [35, 40]], "shifted once; h mapped through the ripple once");
  const log = await w.carton.log();
  assert.equal(log.filter((v) => v.change === R).length, 1, "the ripple's id is confirmed exactly once");
});

test(`R3-01 ripple-once, pushed twice: the same stable id committed again is a duplicate, never a second shift [real engine]`, async (t) => {
  const { w, r0, R, ripple } = await scenario(t);
  const again = await w.carton.commit({ ops: ripple.ops, intent: ripple.intent, base: r0.ref, author: AGENT, id: R });
  assert.notEqual(again.status, "conflicts");
  assert.deepEqual(await times(w), [[0, 10], [10, 20], [20, 30], [35, 40]], "shifted once");
  assert.equal((await w.carton.log()).filter((v) => v.change === R).length, 1);
});

// A second copy of the ripple under a new id (the bug stable ids prevent), rebased over the confirmed head: the engine's
// remap transform counts identical deletions once, so it is a second line of defence.
test(`R3-01 engine check: a second copy of the ripple under a new id, rebased over the head, shifts nothing a second time [real engine]`, async (t) => {
  const { w, r0, ripple } = await scenario(t);
  const copy = await w.carton.commit({ ops: ripple.ops, intent: ripple.intent, base: r0.ref, author: AGENT });
  assert.ok(copy.status === "confirmed", `copy ${copy.status}`);
  assert.deepEqual(await times(w), [[0, 10], [10, 20], [20, 30], [35, 40]], "h stays at 35, d at 20");
  assert.ok(copy.status === "confirmed" && (copy.empty || copy.change === null || copy.change.ops.length === 0), "the copy adds nothing");
});
