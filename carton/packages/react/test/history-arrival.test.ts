// feat/history-arrival: someone else's versions arriving while History is open (arrivals.ts).
// - nextArrivals: only versions that join the watched cut while it is watched, by someone other than you and your
//   agents; never what was there at the first look, nor a list loaded or swapped (a cut, a reload), in O(what arrived).
import { test } from "node:test";
import assert from "node:assert/strict";
import { ARRIVAL_BURST, ARRIVALS_KEPT, isSomeoneElse, nextArrivals, type ArrivalState } from "../src/arrivals.ts";
import type { Actor, Version } from "../src/model.ts";

// ------------------------------------------------------------------------------------------------- nextArrivals
const you: Actor = { key: "human/vikas", kind: "human", name: "Vikas", isYou: true };
const yourAgent: Actor = { key: "agent/claude", kind: "agent", name: "Claude Code", parent: "human/vikas", isYou: true };
const leo: Actor = { key: "human/leo", kind: "human", name: "Leo" };
const leosAgent: Actor = { key: "agent/claude-leo", kind: "agent", name: "Claude Code", parent: "human/leo" };
const system: Actor = { key: "system/carton", kind: "system", name: "" };
let n = 0;
const v = (author: Actor, o: Partial<Version> = {}): Version => {
  n++;
  return { id: `v${n}`, seq: n, ref: `main@${n}`, at: n * 1000, author, kind: "edit", summary: `change ${n}`, ...o };
};
const SRC = {};
const step = (s: ArrivalState | null, all: readonly Version[], rev: number, o: { cut?: string; loading?: boolean; now?: number; source?: unknown } = {}) =>
  nextArrivals(s, all, { source: o.source ?? SRC, cut: o.cut ?? "main", rev, ...(o.loading ? { loading: true } : {}), now: o.now ?? 5 });

test("someone else is a teammate or a teammate's agent: never you, your agents or the system", () => {
  assert.deepEqual([you, yourAgent, leo, leosAgent, system].map(isSomeoneElse), [false, false, true, true, false]);
});

test("the first look is what was there: nothing arrived; a teammate's version after it did, yours and your agent's never", () => {
  const all = [v(system, { start: "created" }), v(leo), v(you), v(leosAgent)];
  let s = step(null, all, 1);
  assert.equal(s.at.size, 0, "rows there when History opened");
  assert.equal(s.last, all[3]!.id);
  all.push(v(yourAgent), v(you));
  s = step(s, all, 2);
  assert.equal(s.at.size, 0, "yours and your agent's");
  const t = v(leo), a = v(leosAgent);
  all.push(t, a);
  s = step(s, all, 3, { now: 42 });
  assert.deepEqual([...s.at], [[t.id, 42], [a.id, 42]]);
  assert.deepEqual(s.added.map((x) => x.id), [a.id, t.id], "newest first");
  const same = step(s, all, 3);
  assert.equal(same, s, "the same revision: the same state (memoizable)");
  const quiet = step(s, all, 4);
  assert.equal(quiet.at, s.at, "nothing new: the same marks");
  assert.deepEqual(quiet.added, []);
});

test("a version arriving among provisional rows (before them, as the engine places it, or after, as the mock does) is found", () => {
  const all = [v(you), v(you)];
  let s = step(null, all, 1);
  const p1 = v(you, { provisional: true, seq: null }), p2 = v(yourAgent, { provisional: true, seq: null });
  all.push(p1, p2);
  s = step(s, all, 2);
  assert.equal(s.at.size, 0);
  const before = v(leo);
  all.splice(2, 0, before); // from-carton: a confirmed version goes in before the provisional ones still waiting
  s = step(s, all, 3);
  assert.deepEqual([...s.at.keys()], [before.id]);
  const after = v(leosAgent);
  all.push(after); // the mock appends
  s = step(s, all, 4);
  assert.deepEqual([...s.at.keys()], [before.id, after.id]);
  // your provisional ones confirmed (same ids, now confirmed): yours, never arrivals
  all.splice(2, 2, before, { ...p1, provisional: undefined, seq: 9 });
  s = step(s, all, 5);
  assert.deepEqual([...s.at.keys()], [before.id, after.id]);
});

test("History loading, empty or loaded in one go is never an arrival; another cut starts over; a reload is watched as it is", () => {
  const list = [v(you), v(leo), v(leosAgent)];
  // the renderer's History before the worker's first `init` (remote.ts: loading), then the whole list at once
  let s = step(null, [], 1, { loading: true });
  assert.equal(s.last, null, "not watching yet");
  s = step(s, list, 2);
  assert.equal(s.at.size, 0, "loaded: what was there");
  // a version that came by event while the worker's load waited, then the load around it (older ones under it)
  s = step(null, [list[2]!], 1);
  s = step(s, list, 2);
  assert.equal(s.at.size, 0, "the load's older versions");
  // an arrival, then a cut switched to: the worker empties History, then loads the other cut's
  const t = v(leo);
  s = step(s, [...list, t], 3);
  assert.equal(s.at.size, 1);
  s = step(s, [], 4);
  assert.equal(s.last, null);
  assert.equal(s.at.size, 1, "the same cut, emptied: its marks are kept (a reload of it)");
  const other = [v(you), v(leo), v(leosAgent), v(leo)];
  s = step(s, other, 5, { cut: "30s" });
  assert.equal(s.at.size, 0, "another cut: its own arrivals, from its first look");
  // both in one render (no empty step), on the same cut id: the one seen last is gone, so it starts watching this one
  const swapped = [v(leo), v(leosAgent), v(leo)];
  const s2 = step(s, swapped, 6, { cut: "30s" });
  assert.equal(s2.at.size, 0);
  assert.equal(s2.last, swapped[2]!.id);
  // another source (a new view model) starts over too
  assert.equal(step(s2, [...swapped, v(leo)], 7, { cut: "30s", source: {} }).at.size, 0);
});

test(`more than ${ARRIVAL_BURST} new confirmed versions at once is another list, not arrivals; marks are kept for the newest ${ARRIVALS_KEPT}`, () => {
  const all = [v(you)];
  let s = step(null, all, 1);
  for (let i = 0; i <= ARRIVAL_BURST; i++) all.push(v(leo));
  s = step(s, all, 2);
  assert.equal(s.at.size, 0, "a burst past the bound");
  assert.equal(s.last, all[all.length - 1]!.id);
  let rev = 3;
  for (let i = 0; i < ARRIVALS_KEPT + 10; i++) {
    all.push(v(leo));
    s = step(s, all, rev++);
  }
  assert.equal(s.at.size, ARRIVALS_KEPT);
  assert.ok(s.at.has(all[all.length - 1]!.id) && !s.at.has(all[all.length - ARRIVALS_KEPT - 1]!.id), "the oldest marks go first");
});

test("a step reads only what arrived: the newest confirmed version back to the one seen last", () => {
  const all: Version[] = [];
  for (let i = 0; i < 50_000; i++) all.push(v(i % 3 ? you : leo));
  let s = step(null, all, 1);
  let reads = 0;
  const counted = new Proxy(all, { get: (t, k, r) => ((typeof k === "string" && /^\d+$/.test(k) && reads++), Reflect.get(t, k, r)) });
  all.push(v(leo));
  s = step(s, counted, 2);
  assert.equal(s.at.size, 1);
  assert.ok(reads <= 4, `${reads} reads of History for one arrival in 50,001 versions`);
});
