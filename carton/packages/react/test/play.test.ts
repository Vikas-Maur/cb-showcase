// Play's steps and its player (DESIGN §5.3, PLAN 4.2): spans from the changes' own places, merged when they overlap,
// the changes with no place lit briefly and skipped, and a player that runs outside React on a clock the test steps.
import { test } from "node:test";
import assert from "node:assert/strict";
import { SpanPlayer, changeSpan, litAt, playSteps, stepFor, PLAY_FLASH_MS, type Clock, type SpanState } from "../src/player.ts";
import type { Change } from "../src/model.ts";

const c = (key: string, at?: number, end?: number): Change => ({ key, text: key, kind: "change", clip: "video", ...(at !== undefined ? { at } : {}), ...(end !== undefined ? { end } : {}) });

function fakeClock() {
  let now = 0, next: ((t: number) => void) | null = null, id = 0;
  const clock: Clock = { now: () => now, request: (fn) => ((next = fn), ++id), cancel: () => void (next = null) };
  return {
    clock,
    step(ms: number) {
      now += ms;
      const fn = next;
      next = null;
      fn?.(now);
    },
    get pending() {
      return next !== null;
    },
  };
}

test("a change plays its spot with a second either side; one with no place has none", () => {
  assert.deepEqual(changeSpan(c("a", 6, 9)), [5, 10]);
  assert.deepEqual(changeSpan(c("a", 0.4, 1)), [0, 2], "never before 0:00");
  assert.deepEqual(changeSpan(c("a", 12)), [11, 13], "a point (an add with no end): its moment");
  assert.equal(changeSpan(c("fps")), null, "the frame rate: no place");
  // as long as the edit (the music's volume): its first seconds, so it doesn't swallow every other spot
  assert.deepEqual(changeSpan(c("music", 0, 38)), [0, 9]);
  // no step past the edit's end; a removal at the very end plays its last seconds
  assert.deepEqual(changeSpan(c("outro", 36, 40), { length: 38 }), [35, 38]);
  assert.deepEqual(changeSpan(c("gone", 38.5, 40), { length: 38 }), [36, 38]);
});

test("Play all: spots in timeline order, overlapping ones as one stretch, then the changes with no place", () => {
  const list = [c("fps"), c("b", 12, 17), c("a", 2, 5), c("a2", 5, 10), c("d", 30, 31)];
  const steps = playSteps(list);
  assert.deepEqual(
    steps.map((s) => [s.start, s.end, s.rows, s.spans]),
    [
      [1, 11, [2, 3], [[1, 6], [4, 11]]], // 0:02–0:05 and 0:05–0:10 overlap: one stretch, each row its own spot
      [11, 18, [1], [[11, 18]]], // starts where the last ended: its own step
      [29, 32, [4], [[29, 32]]],
      [null, null, [0], []], // the frame rate, lit and skipped
    ],
  );
  assert.equal(steps.at(-1)!.ms, PLAY_FLASH_MS);
  assert.deepEqual(playSteps([]), []);
  // one row lit at a time: of the spots under the playhead, the one that started last
  const s0 = steps[0]!;
  assert.deepEqual([litAt(s0, 1), litAt(s0, 3.9), litAt(s0, 4), litAt(s0, 10.9)], [0, 0, 1, 1]);
  const wide = playSteps([c("long", 1, 9), c("short", 3, 4)])[0]!; // [0, 10) and [2, 5)
  assert.deepEqual([litAt(wide, 1), litAt(wide, 2.5), litAt(wide, 6)], [0, 1, 0], "back to the long one once the short spot ends");
});

test("▶ on one change: its own spot, lit alone", () => {
  const list = [c("a", 2, 5), c("b", 5, 10), c("far", 30, 31), c("fps")];
  assert.deepEqual(stepFor(list, 0), { rows: [0], spans: [[1, 6]], start: 1, end: 6 });
  assert.deepEqual(stepFor(list, 3), { rows: [3], spans: [], start: null, end: null, ms: PLAY_FLASH_MS });
  assert.equal(stepFor(list, 9), null);
});

test("the player plays each step in order, tells every frame, and stops lit nowhere after the last", () => {
  const fc = fakeClock();
  const p = new SpanPlayer({ clock: fc.clock });
  const frames: [number | null, number][] = [];
  const states: SpanState[] = [];
  p.onFrame((t, pr) => frames.push([t, pr]));
  p.onState((s) => states.push(s));
  p.start([{ rows: [0], spans: [[1, 2]], start: 1, end: 2 }, { rows: [1, 2], spans: [[5, 6], [5.5, 6]], start: 5, end: 6 }, { rows: [3], spans: [], start: null, end: null, ms: 100 }]);
  assert.deepEqual([p.state.playing, p.state.step, p.state.rows], [true, 0, [0]]);
  assert.deepEqual(frames.at(-1), [1, 0]);
  fc.step(250);
  fc.step(250);
  assert.deepEqual(frames.at(-1), [1.5, 0.5]);
  fc.step(250);
  fc.step(250); // at the first step's end: the second starts at its own start
  assert.deepEqual([p.state.step, p.state.rows, p.time], [1, [1], 5]);
  fc.step(250);
  fc.step(250);
  assert.deepEqual(p.state.rows, [2], "the spot that started last, once it has");
  fc.step(250);
  fc.step(250); // 6.0: into the step with no place
  assert.deepEqual([p.state.step, frames.at(-1)![0]], [2, null], "lit, with no time: the host's playhead stays");
  fc.step(50);
  assert.equal(frames.at(-1)![1], 0.5);
  fc.step(60);
  assert.deepEqual([p.state.playing, p.state.step, p.state.rows, p.state.done], [false, -1, [], true]);
  assert.equal(fc.pending, false, "no frame asked for after the end");
  // coarse state only: play, each step, each lit row within one, and the end, never one per frame
  assert.equal(states.length, 6, `${states.length} state changes for ${frames.length} frames`);
});

test("pause keeps the place; resume goes on; a background tab moves at most 0.25 s a frame; stop lights nothing", () => {
  const fc = fakeClock();
  const p = new SpanPlayer({ clock: fc.clock });
  p.start([{ rows: [0], spans: [[0, 10]], start: 0, end: 10 }]);
  fc.step(1000);
  assert.equal(p.time, 0.25, "a long gap counts as 0.25 s");
  p.pause();
  assert.deepEqual([p.state.playing, p.state.step], [false, 0]);
  fc.step(5000);
  assert.equal(p.time, 0.25, "nothing moves while paused");
  p.resume();
  fc.step(100);
  assert.ok(Math.abs(p.time - 0.35) < 1e-9);
  p.stop();
  assert.deepEqual(p.state, { playing: false, step: -1, rows: [], done: false });
  // after the end, Play goes again from the top
  p.start([{ rows: [0], spans: [[3, 3.1]], start: 3, end: 3.1 }]);
  fc.step(200);
  assert.equal(p.state.done, true);
  p.resume();
  assert.deepEqual([p.state.playing, p.state.step, p.time], [true, 0, 3]);
  p.dispose();
});
