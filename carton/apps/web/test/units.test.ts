// The web client's pure parts: timeline edits as ops, presence rates (§12), links, the coalesced head (no re-render
// storm under a burst of rows).
import { test } from "node:test";
import assert from "node:assert/strict";
import type { Carton, CartonEvent, Doc, Rec } from "@carton/core";
import { demoDoc } from "../src/demo-doc.ts";
import { fieldOps, moveOps, trimOps, trimPlacement, MIN_LEN } from "../src/edit.ts";
import { joinHash, parseJoinHash, parseWatchHash, watchHash } from "../src/descriptor.ts";
import { LiveDoc } from "../src/live-doc.ts";
import { PresenceSender, ACTIVE_MS, DRAG_MS, IDLE_MS, type PresenceState } from "../src/presence.ts";

const media = [1, 2].map((i) => ({ id: `media-${i}`, name: `S${i}`, hash: String(i).repeat(64), size: 1, duration: 6 }));
const doc = demoDoc(media);
const item = (d: Doc, id: string) => (d.timelineItems as Rec[]).find((r) => r.id === id)!;

test("moving a clip keeps its length, snaps to 0.1 s and never goes below 0", () => {
  const c = item(doc, "clip-2"); // 4..8
  assert.deepEqual(moveOps(c, 5.234), [
    { op: "set", path: ["timelineItems", "clip-2", "startTime"], value: 5.2 },
    { op: "set", path: ["timelineItems", "clip-2", "endTime"], value: 9.2 },
  ]);
  assert.deepEqual(moveOps(c, -3)[0], { op: "set", path: ["timelineItems", "clip-2", "startTime"], value: 0 });
  assert.deepEqual(moveOps(c, 4.02), [], "no move, no ops");
});

test("trimming moves the source in step, stops at the source's ends, and keeps a minimum length", () => {
  const c = item(doc, "clip-2"); // 4..8, source 0..4 of 6 s
  assert.deepEqual(trimPlacement(c, "start", 5), { start: 5, end: 8, trimStart: 1, trimEnd: 4 });
  assert.deepEqual(trimPlacement(c, "start", 2), { start: 4, end: 8, trimStart: 0, trimEnd: 4 }, "no source before 0");
  assert.deepEqual(trimPlacement(c, "end", 20, 6), { start: 4, end: 10, trimStart: 0, trimEnd: 6 }, "no source past its end");
  assert.equal(trimPlacement(c, "end", 4.1).end, 4 + MIN_LEN);
  const ops = trimOps(c, "end", 7);
  assert.deepEqual(ops, [
    { op: "set", path: ["timelineItems", "clip-2", "endTime"], value: 7 },
    { op: "set", path: ["timelineItems", "clip-2", "trimEnd"], value: 3 },
  ]);
  const cap = item(doc, "cap-1"); // 0.5..3.5, no source
  assert.deepEqual(trimPlacement(cap, "start", 0), { start: 0, end: 3.5, trimStart: 0, trimEnd: 3.5 });
});

test("field edits clamp volume and opacity and skip unchanged values", () => {
  const c = item(doc, "clip-1");
  assert.deepEqual(fieldOps(c, "volume", 250), [{ op: "set", path: ["timelineItems", "clip-1", "volume"], value: 200 }]);
  assert.deepEqual(fieldOps(c, "volume", 100), []);
  assert.deepEqual(fieldOps(c, "opacity", 0.456), [{ op: "set", path: ["timelineItems", "clip-1", "opacity"], value: 0.46 }]);
  assert.deepEqual(fieldOps(item(doc, "cap-1"), "captionText", "Saturday, 7 am"), []);
});

test("links round-trip; an incomplete watch link is refused", () => {
  assert.deepEqual(parseJoinHash(joinHash("demo-ab12", "ct1.x.y")), { projectId: "demo-ab12", invite: "ct1.x.y" });
  assert.equal(parseJoinHash("#join=nope"), null);
  const w = { projectId: "p1", cut: "c1", source: "s1", at: 7, invite: "ct1.a.b" };
  assert.deepEqual(parseWatchHash(watchHash(w)), w);
  assert.equal(parseWatchHash("#p=p1&c=c1"), null);
});

function fakeTimers() {
  let now = 0;
  const q: { at: number; f: () => void; id: number }[] = [];
  let n = 0;
  return {
    now: () => now,
    setTimeout: (f: () => void, ms: number) => (q.push({ at: now + ms, f, id: ++n }), n),
    clearTimeout: (h: unknown) => {
      const i = q.findIndex((x) => x.id === h);
      if (i >= 0) q.splice(i, 1);
    },
    advance(ms: number) {
      const end = now + ms;
      for (;;) {
        q.sort((a, b) => a.at - b.at);
        const next = q[0];
        if (!next || next.at > end) break;
        q.shift();
        now = next.at;
        next.f();
      }
      now = end;
    },
  };
}

test("presence: a drag goes out at most every 50 ms with its newest position last; activity at most 1 Hz; idle after 30 s", () => {
  const t = fakeTimers();
  const sent: (PresenceState | null)[] = [];
  const p = new PresenceSender((s) => sent.push(s), t);
  p.active("Editing");
  assert.equal(sent.length, 1);
  for (let i = 0; i < 20; i++) {
    p.drag([{ item: "c", track: "t", start: i, end: i + 1 }]);
    t.advance(5); // 200 Hz of pointer moves for 100 ms
  }
  t.advance(DRAG_MS);
  const drags = sent.filter((s) => s?.ghosts?.length);
  assert.ok(drags.length <= 100 / DRAG_MS + 1, `${drags.length} ghost updates for 100 ms`);
  assert.equal(drags.at(-1)!.ghosts![0]!.start, 19, "the newest position is sent last");
  p.endDrag();
  assert.deepEqual(sent.at(-1), { activity: "Editing" }, "the ghost goes at once on release");
  const before = sent.length;
  for (let i = 0; i < 10; i++) {
    p.active("Editing");
    t.advance(100);
  }
  assert.ok(sent.length - before <= 2, "one heartbeat a second at most");
  t.advance(IDLE_MS + ACTIVE_MS);
  assert.equal(sent.at(-1), null, "idle: others stop showing us");
});

test("a burst of remote rows costs one head read (no re-render storm)", async () => {
  const listeners = new Set<(e: CartonEvent) => void>();
  let reads = 0;
  const fake = {
    cut: "main",
    on: (l: (e: CartonEvent) => void) => (listeners.add(l), () => listeners.delete(l)),
    head: async () => (reads++, { ref: { branchId: "main", seq: reads, pending: [] }, doc }),
  } as unknown as Carton;
  const frames: (() => void)[] = [];
  const live = await LiveDoc.open(fake, (f) => frames.push(f));
  let renders = 0;
  live.subscribe(() => renders++);
  for (let i = 0; i < 50; i++) for (const l of listeners) l({ type: "change", branchId: "main", seq: i + 1, change: {} as never, local: false });
  assert.equal(frames.length, 1, "one frame scheduled for 50 rows");
  frames.shift()!();
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(renders, 1);
  assert.equal(reads, 2, "the open plus one read for the burst");
  // rows of another cut don't touch this view
  for (const l of listeners) l({ type: "change", branchId: "other", seq: 1, change: {} as never, local: false });
  assert.equal(frames.length, 0);
});
