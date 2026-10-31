// The clip time group through the system on the real engine and history (port of system-v11 `time-group.test.mjs`, in
// its single-sequencer form until the sync client lands: the second writer commits on the state before the first's
// change, so the local sequencer checks the overlap and rebases exactly as the server would).
// - Finding 6: a GUI move that clashes with a remote end trim composes: moved and shortened, never half-applied.
// - Same clip, different fields: a trim-in and a speed change share no leaf path; the group path
//   `timelineItems/<id>/#time` makes them overlap, so they meet in merge3, where the §4.1 table makes that pair a card.
// - Neighbours: two plain trims of neighbouring clips that end up overlapping are accepted without a merge, with a
//   warning, not a card.
// - R11-01: crossing trims both sent as lww never confirm an invalid clip.
import test from "node:test";
import assert from "node:assert/strict";
import { declare, diff } from "@carton/core";
import type { CommitResult, StateRef, Doc } from "@carton/core";
import { cardboardSchema, fromHost, toHost } from "@carton/cardboard";
import { openWorld, clip, clips, find, BOB, HUMAN, type Item, type World } from "./world.ts";

/** A commit by `who` made on `base` (an older state), editing items as `fn` does. */
async function commitOn(w: World, base: { ref: StateRef; doc: Doc }, who: typeof HUMAN, fn: (its: Item[]) => void, policy?: "lww"): Promise<CommitResult> {
  const h = toHost(base.doc);
  const items = structuredClone(h.timelineItems as Item[]);
  fn(items);
  return w.carton.commit({ doc: fromHost({ ...h, timelineItems: items }, base.doc), base: base.ref, author: who, ...(policy ? { policy } : {}) });
}

test(`Finding 6: a GUI move crossing a remote end trim composes (moved and shortened), never half-applied [real engine]`, async (t) => {
  const w = await openWorld(t, { items: clips(4), tracks: ["V1"] }); // c1 is [5, 10], trims [0, 5]
  const r0 = await w.carton.head();
  const a = await commitOn(w, r0, HUMAN, (its) => void Object.assign(find(its, "c1"), { startTime: 5.3, endTime: 10.3 }));
  const b = await commitOn(w, r0, BOB, (its) => void Object.assign(find(its, "c1"), { endTime: 9.6, trimEnd: 4.6 }));
  assert.equal(a.status, "confirmed");
  assert.equal(b.status, "confirmed", "the second was rebased through merge3 and confirmed");
  assert.ok(b.status === "confirmed" && b.rebased >= 1, "it overlapped (group path) and was rebased");
  const c1 = find(await w.head(), "c1");
  assert.deepEqual([c1.startTime, c1.endTime, c1.trimStart, c1.trimEnd], [5.3, 9.9, 0, 4.6], "move ∘ trim-out composed");
});

test(`group path: a trim-in and a speed change on one clip overlap through timelineItems/<id>/#time, meet in merge3 and become a card [real engine]`, async (t) => {
  const w = await openWorld(t, { items: [{ ...clip("c0", 10, 15), playbackSpeed: 1 }], tracks: ["V1"] });
  const r0 = await w.carton.head();
  const set = (its: Item[], patch: object) => void Object.assign(find(its, "c0"), patch);
  const trimIn = (its: Item[]) => set(its, { startTime: 10.5, trimStart: 0.5 });
  const speed = (its: Item[]) => set(its, { playbackSpeed: 2, endTime: 12.5 });
  const mk = (fn: (its: Item[]) => void) => {
    const h = toHost(r0.doc);
    const items = structuredClone(h.timelineItems as Item[]);
    fn(items);
    return diff(r0.doc, fromHost({ ...h, timelineItems: items }, r0.doc), cardboardSchema);
  };
  const d1 = declare(cardboardSchema, r0.doc, mk(trimIn)), d2 = declare(cardboardSchema, r0.doc, mk(speed));
  assert.deepEqual(d1.paths.filter((p) => d2.paths.includes(p)), ["timelineItems/c0/#time"], "the only shared path is the time group");
  assert.equal(await commitOn(w, r0, HUMAN, trimIn).then((r) => r.status), "confirmed");
  const r = await commitOn(w, r0, BOB, speed);
  assert.equal(r.status, "conflicts", "rejected for the group path, rebased, and the §4.1 table makes it a card");
  assert.ok(r.status === "conflicts" && r.cards.some((c) => c.path === "timelineItems/c0/#time"));
});

async function neighbourTrims(t: test.TestContext) {
  const w = await openWorld(t, { items: clips(3).map((c) => ({ ...c, trimEnd: 6 })), tracks: ["V1"] }); // 1 s of spare source
  const warnings: { kind: string }[] = [];
  w.carton.on((e) => void (e.type === "warning" && warnings.push(...(e.warnings as { kind: string }[]))));
  const r0 = await w.carton.head();
  const a = await commitOn(w, r0, HUMAN, (its) => void Object.assign(find(its, "c0"), { endTime: 5.4, trimEnd: 5.4 }));
  const b = await commitOn(w, r0, BOB, (its) => void Object.assign(find(its, "c1"), { startTime: 5.2, trimStart: 0.2 }));
  return { w, a, b, warnings };
}

test(`neighbours: two plain trims that make neighbouring clips overlap are both accepted without a merge, no card [real engine]`, async (t) => {
  const { w, a, b } = await neighbourTrims(t);
  assert.equal(a.status, "confirmed");
  assert.equal(b.status, "confirmed");
  assert.ok(b.status === "confirmed" && b.rebased === 0, "no overlap by the v11 rule: no reject, no merge");
  const head = await w.head();
  assert.deepEqual([find(head, "c0").endTime, find(head, "c1").startTime], [5.4, 5.2], "both trims landed");
});

// §4.1: every replica runs the soft validators on the tracks a confirmed change touched. Core doesn't emit that warning
// yet (asked of foundation-core in the notes); this passes once it does.
test(`neighbours: the resulting overlap is a soft warning on the replica [real engine]`, { todo: "core emits no incremental soft-validator warning after a confirmed change yet" }, async (t) => {
  const { b, warnings } = await neighbourTrims(t);
  const all = [...warnings, ...(((b.status === "confirmed" && b.warnings) || []) as { kind: string }[])];
  assert.ok(all.some((x) => x.kind === "overlap"), "a soft overlap warning");
});

test(`R11-01: crossing trims both sent as lww never confirm an invalid clip; the clash is a card [real engine]`, async (t) => {
  const w = await openWorld(t, { items: [{ ...clip("c0", 3, 5), trimStart: 0, trimEnd: 2 }], tracks: ["V1"] });
  const r0 = await w.carton.head();
  const a = await commitOn(w, r0, HUMAN, (its) => void Object.assign(find(its, "c0"), { startTime: 4.5, trimStart: 1.5 }), "lww");
  const b = await commitOn(w, r0, BOB, (its) => void Object.assign(find(its, "c0"), { endTime: 4, trimEnd: 1 }), "lww");
  const c0 = find(await w.head(), "c0");
  assert.ok((c0.endTime as number) > (c0.startTime as number) && (c0.trimEnd as number) > (c0.trimStart as number), "the confirmed clip is valid");
  assert.ok([a, b].some((r) => r.status === "conflicts" || r.status === "rejected"), "the clash didn't confirm silently");
});
