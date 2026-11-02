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
