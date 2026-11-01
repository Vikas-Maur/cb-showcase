// Re-anchoring cost: 1,000 comments against a 10,000-item Cardboard timeline (task: "must not block the UI
// noticeably; measure it and keep it incremental"). Versions share unchanged record objects, as History's do.
//
// Cells (median of RUNS, every run printed):
//   index-cold      TimelineIndex of the head, records never seen (first open)
//   index-warm      TimelineIndex of the next version (one record changed; attribute strings cached per record)
//   place-1000      placing all 1,000 threads on a version (index ready), anchors from 50 versions
//   head-moved      the head moved by one change: new index + place all 1,000 from scratch
//   incremental     the same through Comments.placeOn: only threads the change could move are placed again
//   first-open      Comments.placeOn on a version for the first time (index + every thread)
//   max-slice       the longest synchronous step with Comments' 8 ms budget (the index, or 8 ms of placements)
//   anchor          making one anchor (a comment being added), index ready
// Run: node bench/reanchor.ts [runs]   (inside flock /tmp/gfv-race/cpu.lock on the shared box)
import { execSync } from "node:child_process";
import { hashDoc, type Doc, type Rec } from "@carton/core";
import { cardboardSchema as S, fromHost } from "@carton/cardboard";
import { createMemoryStore } from "@carton/store-memory";
import { makeAnchor, place, TimelineIndex } from "../src/anchor.ts";
import { Comments, type CommentsCarton } from "../src/comments.ts";
import { memoryCommentStore } from "../src/store.ts";
import type { Anchor, Comment } from "../src/types.ts";

const RUNS = Number(process.argv[2] ?? 7);
const N = 10_000,
  TRACKS = 20,
  COMMENTS = 1000,
  VERSIONS = 50;
const OPTS = { media: "mediaItemId" };

function base(): Doc {
  const tracks = Array.from({ length: TRACKS }, (_, i) => ({ id: `T${i}`, name: `T${i}`, order: i }));
  const per = N / TRACKS;
  const items: Rec[] = [];
  for (let t = 0; t < TRACKS; t++)
    for (let k = 0; k < per; k++) {
      const s = k * 3;
      items.push({ id: `i${t}-${k}`, trackId: `T${t}`, type: t % 4 === 3 ? "text" : "video", name: `clip ${k}`, mediaItemId: `m${(t * per + k) % 700}`, startTime: s, endTime: s + 3, trimStart: (k % 7) * 2, trimEnd: (k % 7) * 2 + 3, opacity: 1, text: t % 4 === 3 ? `caption ${k}` : undefined });
    }
  return fromHost({ name: "Bench", tracks, timelineItems: items }, null);
}

/** The next version: one record replaced, every other record the same object (History's sharing). */
function next(d: Doc, i: number): Doc {
  const items = [...(d.timelineItems as Rec[])];
  const j = (i * 7919) % items.length;
  items[j] = { ...items[j]!, opacity: ((i % 9) + 1) / 10 };
  return { ...d, timelineItems: items };
}

const ms = (f: () => void) => {
  const t = performance.now();
  f();
  return performance.now() - t;
};
const med = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;

const cells: Record<string, number[]> = { "index-cold": [], "index-warm": [], "place-1000": [], "head-moved": [], incremental: [], "first-open": [], "max-slice": [], anchor: [] };
for (let run = 0; run < RUNS; run++) {
  let d = base();
  let ixCold!: TimelineIndex;
  cells["index-cold"]!.push(ms(() => (ixCold = new TimelineIndex(d, S, OPTS))));
  // anchors made on 50 successive versions, 20 each, spread over the timeline and the tracks
  const anchors: Anchor[] = [];
  let ix = ixCold;
  for (let v = 0; v < VERSIONS; v++) {
    const at = { cut: "main", seq: v + 1, hash: hashDoc(d, S) };
    for (let c = 0; c < COMMENTS / VERSIONS; c++) {
      const s = ((v * 37 + c * 101) % 1400) + 0.5;
      const t0 = performance.now();
      anchors.push(makeAnchor(d, S, at, [s, s + 1.5], { ...OPTS, index: ix }));
      if (v === 0 && c < 5) cells.anchor!.push(performance.now() - t0);
    }
    d = next(d, v);
    ix = new TimelineIndex(d, S, OPTS);
  }
  const head = { index: ix, hash: hashDoc(d, S) };
  cells["place-1000"]!.push(ms(() => anchors.forEach((a) => place(a, head))));
  d = next(d, 999);
  let moved!: TimelineIndex;
  cells["index-warm"]!.push(ms(() => (moved = new TimelineIndex(d, S, OPTS))));
  const hm = performance.now();
  const target = { index: new TimelineIndex(d, S, OPTS), hash: hashDoc(d, S) };
  anchors.forEach((a) => place(a, target));
  cells["head-moved"]!.push(performance.now() - hm);
  // the 8 ms budget loop of Comments.placeOn: the index is one step, then placements until 8 ms have passed
  let longest = ms(() => void new TimelineIndex(next(d, 1234), S, OPTS));
  let i = 0;
  while (i < anchors.length) {
    const t0 = performance.now();
    while (i < anchors.length && performance.now() - t0 <= 8) place(anchors[i++]!, target);
    longest = Math.max(longest, performance.now() - t0);
  }
  cells["max-slice"]!.push(longest);
  void moved;
  // through the Comments handle: a stub Carton (only what placeOn reads), the comments as the server's rows
  const store = memoryCommentStore();
  await store.write({ rows: anchors.map((a, i): Comment => ({ id: `c${i}`, author: { id: "a", name: "A" }, body: "x", cut: "main", at: i, anchor: a, seq: i + 1 })), head: COMMENTS });
  const stub = { schema: S, cut: "main", store: createMemoryStore(), identity: () => null, cuts: async () => [], head: async () => { throw new Error("unused"); }, checkout: async () => { throw new Error("unused"); } } as unknown as CommentsCarton;
  const comments = await Comments.open({ carton: stub, store, anchor: OPTS });
  let v = next(d, 4321);
  let t = performance.now();
  await comments.placeOn({ cut: "main", seq: 100, hash: hashDoc(v, S), doc: v });
  cells["first-open"]!.push(performance.now() - t);
  for (let k = 0; k < 3; k++) {
    v = next(v, 5000 + k);
    const h = hashDoc(v, S);
    t = performance.now();
    await comments.placeOn({ cut: "main", seq: 101 + k, hash: h, doc: v });
    if (k === 2) cells.incremental!.push(performance.now() - t);
  }
  await comments.close();
}
const load = execSync("uptime").toString().trim();
console.log(`node ${process.version}, ${N} items on ${TRACKS} tracks, ${COMMENTS} comments from ${VERSIONS} versions, ${RUNS} runs`);
console.log(`uptime: ${load}`);
for (const [k, xs] of Object.entries(cells)) console.log(`${k.padEnd(12)} median ${med(xs).toFixed(2)} ms   runs ${xs.map((x) => x.toFixed(2)).join(" ")}`);
