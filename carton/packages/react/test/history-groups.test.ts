// History grouped by day (UI audit P2-17) and the virtual list's rows of their own heights: pure, no DOM.
import { test } from "node:test";
import assert from "node:assert/strict";
import { dayLabel, dayNumber, groupHistory, spansDays } from "../src/history-groups.ts";
import { rowAt, rowTops, windowRangeOf } from "../src/virtual.ts";
import { createMockUi } from "../src/mock.ts";
import type { Version } from "../src/model.ts";

const H = 3_600_000;
const base = new Date(2026, 10, 2, 15, 0).getTime(); // Mon Nov 2 2026, 3 pm local
const v = (id: string, at: number, over: Partial<Version> = {}) => ({ id, at, kind: "edit", summary: id, author: { key: "human/me", kind: "human", name: "Me" }, ref: id, seq: 0, ...over }) as unknown as Version;

test("days, newest first; a folded day keeps its named versions; indexes match History's own", () => {
  // oldest first, as HistorySource.all() gives them
  const all = [v("a1", base - 49 * H), v("a2", base - 48.5 * H, { name: "First cut" }), v("b1", base - 26 * H), v("b2", base - 25 * H, { kind: "turn" } as Partial<Version>), v("b3", base - 24.5 * H), v("c1", base - 1 * H), v("c2", base)];
  const today = dayNumber(base);
  const rows = groupHistory(all, (day, newest) => !newest);
  assert.deepEqual(rows.map((r) => r.key), [`day:${today}`, "c2", "c1", `day:${today - 1}`, `day:${today - 2}`, "a2"]);
  const days = rows.filter((r) => r.kind === "day");
  assert.deepEqual(days.map((d) => [d.count, d.collapsed, d.hidden]), [[2, false, 0], [3, true, 3], [2, true, 1]]);
  // a version row's index is its index under History's "all" filter (newest first)
  for (const r of rows) if (r.kind === "version") assert.equal(all[all.length - 1 - r.index]!.id, r.id);
  // all open
  assert.equal(groupHistory(all, () => false).filter((r) => r.kind === "version").length, all.length);
  assert.equal(spansDays(all), true);
  assert.equal(spansDays(all.slice(5)), false, "one day: no headers");
});

test("day labels: Today, Yesterday, then the weekday and date", () => {
  const today = dayNumber(base);
  const w = { today: "Today", yesterday: "Yesterday" };
  assert.equal(dayLabel(today, today, "en-US", w), "Today");
  assert.equal(dayLabel(today - 1, today, "en-US", w), "Yesterday");
  assert.equal(dayLabel(today - 3, today, "en-US", w), "Fri, Oct 30");
  assert.equal(dayLabel(today - 400, today, "en-US", w), "Sun, Sep 28, 2025");
});

test("10k versions over 11 days: grouped in one pass, and the list's window is a handful of rows", () => {
  const ui = createMockUi({ versions: 10_000 });
  const all = ui.history().all!();
  const rows = groupHistory(all, (_d, newest) => !newest);
  const days = rows.filter((r) => r.kind === "day");
  assert.ok(days.length >= 10, `${days.length} days`);
  assert.equal(days.reduce((n, d) => n + (d.kind === "day" ? d.count : 0), 0), all.length, "every version is in a day");
  const tops = rowTops(rows.length, (i) => (rows[i]!.kind === "day" ? 32 : 52));
  const [a, b] = windowRangeOf(0, 600, tops, rows.length, 6);
  assert.ok(b - a < 30, `${b - a} rows rendered`);
  // anywhere in the list
  const mid = tops[Math.floor(rows.length / 2)]!;
  const [c, d] = windowRangeOf(mid, 600, tops, rows.length, 6);
  assert.ok(d - c < 30 && rowAt(tops, rows.length, mid) === Math.floor(rows.length / 2));
});

test("rows of their own heights: tops are prefix sums; rowAt finds the row at any height", () => {
  const tops = rowTops(4, (i) => [32, 52, 52, 32][i]!);
  assert.deepEqual([...tops], [0, 32, 84, 136, 168]);
  assert.deepEqual([0, 31, 32, 83, 84, 167, 500].map((y) => rowAt(tops, 4, y)), [0, 0, 1, 1, 2, 3, 3]);
  assert.deepEqual(windowRangeOf(40, 60, tops, 4, 0), [1, 3]);
  assert.deepEqual(windowRangeOf(0, 100, rowTops(0, () => 1), 0, 2), [0, 0]);
});

// ---------------------------------------------------------------- Carton UX v2 G10: past days read as a story (DESIGN-V2 §2.5)
const leo = { key: "human/leo", kind: "human", name: "Leo Park" } as const;
const director = { key: "agent/director", kind: "agent", name: "Director" } as const;

test("G10: an open past day is its landmarks and one run row between two of them; a run opens in place; Today is as it was", () => {
  const M = 60_000, y = base - 24 * H;
  // yesterday: start (landmark), 3 edits by me, 2 by Leo, an export (landmark), 1 edit, a turn (landmark) with 2 versions; today: 3 edits
  const all = [
    v("s", y - 60 * M), v("e1", y - 50 * M), v("e2", y - 49 * M), v("e3", y - 48 * M, { changes: 4 }), v("l1", y - 30 * M, { author: leo }), v("l2", y - 29 * M, { author: leo }),
    v("x", y - 20 * M), v("e4", y - 10 * M), v("t1", y - 5 * M, { author: director, run: "turn1" }), v("t2", y - 4 * M, { author: director, run: "turn1" }),
    v("c1", base - 3 * M), v("c2", base - 2 * M), v("c3", base - M),
  ] as Version[];
  const marked = new Set(["s", "x", "t2", "c2"]);
  const today = dayNumber(base);
  const opts = (open: ReadonlySet<string> = new Set()) => ({ group: true, open: (k: string) => open.has(k), anchor: (x: Version) => marked.has(x.id), alone: (x: Version) => marked.has(x.id), runs: (day: number, newest: boolean) => !newest && day !== today });
  const rows = groupHistory(all, () => false, opts());
  const keys = rows.map((r) => r.key);
  // today: grouped as before (c3 alone? no: c3 and c1 are mine around the landmark c2, which no group crosses)
  assert.deepEqual(keys.slice(0, 4), [`day:${today}`, "c3", "c2", "c1"]);
  // yesterday: the turn's row (with its earlier version), a run of one (e4), the export, a run of five, the start
  assert.deepEqual(keys.slice(4), [`day:${today - 1}`, "t2", "run:e4", "x", "run:e1", "s"]);
  const run = rows.find((r) => r.key === "run:e1")!;
  assert.ok(run.kind === "run");
  assert.deepEqual(run.ids, ["l2", "l1", "e3", "e2", "e1"]);
  assert.deepEqual(run.authors.map((a) => a.key), ["human/leo", "human/me"], "who, each once, newest first");
  assert.equal(run.count, 5, "a version whose changes aren't known counts as one");
  // opened: its rows follow it, grouped as any day's are (Leo's two, then my three)
  const open = groupHistory(all, () => false, opts(new Set(["run:e1"]))).map((r) => r.key);
  assert.deepEqual(open.slice(4), [`day:${today - 1}`, "t2", "run:e4", "x", "run:e1", "group:l1", "group:e1", "s"]);
  // folded days, filters and search don't use runs: a folded yesterday keeps its landmarks only
  assert.deepEqual(groupHistory(all, (_d, newest) => !newest, opts()).map((r) => r.key).slice(4), [`day:${today - 1}`, "t2", "x", "s"]);
  // without `runs`, yesterday lists every row as before
  const plain = groupHistory(all, () => false, { ...opts(), runs: undefined }).map((r) => r.key);
  assert.ok(plain.includes("group:e1") && plain.includes("group:l1") && !plain.some((k) => k.startsWith("run:")));
});

test("G10: 12,000 versions, every day open, as stories: one pass, a few rows a day, and the list's window stays a handful", () => {
  const ui = createMockUi({ versions: 12_000 });
  const all = ui.history().all!();
  // a landmark every ~40 versions and each day's first (as landmarks.ts gives them)
  const marked = new Set<string>();
  let last = NaN;
  all.forEach((x, i) => {
    const d = dayNumber(x.at);
    if (d !== last || i % 40 === 0 || x.name) marked.add(x.id);
    last = d;
  });
  const today = dayNumber(all[all.length - 1]!.at);
  const t0 = performance.now();
  const rows = groupHistory(all, () => false, { group: true, open: () => false, anchor: (x) => marked.has(x.id), alone: (x) => marked.has(x.id), runs: (day, newest) => !newest && day !== today });
  const ms = performance.now() - t0;
  const runs = rows.filter((r) => r.kind === "run");
  assert.ok(runs.length > 50, `${runs.length} runs`);
  // every version is in exactly one row (a run counts its own)
  const inRows = new Set<string>();
  for (const r of rows) {
    if (r.kind === "run" || r.kind === "group" || r.kind === "start") for (const id of r.ids) inRows.add(id);
    else if (r.kind === "version") {
      inRows.add(r.id);
      for (const id of r.turn ?? []) inRows.add(id);
    }
  }
  assert.equal(inRows.size, all.length, "every version is in a row");
  const pastRows = rows.filter((r, i) => i > rows.findIndex((x, j) => j > 0 && x.kind === "day")).length;
  assert.ok(pastRows < (all.length * 2) / 3, `past days: ${pastRows} rows for their versions`);
  assert.ok(ms < 250, `${ms.toFixed(1)} ms`);
  const tops = rowTops(rows.length, (i) => (rows[i]!.kind === "day" || rows[i]!.kind === "run" ? 32 : 56));
  const mid = tops[Math.floor(rows.length * 0.8)]!;
  const [c, d] = windowRangeOf(mid, 600, tops, rows.length, 6);
  assert.ok(d - c < 40, `${d - c} rows rendered`);
});
