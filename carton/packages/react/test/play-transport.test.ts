// Play through the host's own playback (item 5, laptop 2026-11-05: "the audio doesn't play"): History's Play moved
// Cardboard's playhead from a clock of its own and never started Cardboard's playback, so nothing was heard. With a
// `transport`, each stretch plays there and Play follows its clock; at a jump it stops the host and plays the next
// stretch two frames later; it tells the host's own stop at its timeline's end from the person's pause; it never
// pauses the person's own playback.
import { test } from "node:test";
import assert from "node:assert/strict";
import { SpanPlayer, playSteps, stepFor, PLAY_ASK_MS, PLAY_ASKS, type Clock, type Transport } from "../src/player.ts";
import type { Change } from "../src/model.ts";

const c = (key: string, at?: number, end?: number): Change => ({ key, text: key, kind: "change", clip: "video", ...(at !== undefined ? { at } : {}), ...(end !== undefined ? { end } : {}) });
function rig(o: { length?: number; startsAfter?: number } = {}) {
  let now = 0, next: ((t: number) => void) | null = null;
  const clock: Clock = { now: () => now, request: (fn) => ((next = fn), 1), cancel: () => void (next = null) };
  const calls: string[] = [];
  let playing = false, t = 0, pending = -1;
  const tr: Transport = {
    play: (x) => { calls.push(`play ${x}`); t = x; if (o.startsAfter) pending = o.startsAfter; else playing = true; },
    pause: () => { calls.push("pause"); playing = false; pending = -1; },
    playing: () => playing,
    time: () => t,
    length: () => o.length,
  };
  const frames: (number | null)[] = [];
  const player = new SpanPlayer({ clock, transport: () => tr });
  player.onFrame((x) => frames.push(x));
  /** One frame of `ms`: the host's clock moves while it plays (to its timeline's end, where it stops by itself). */
  const step = (ms = 100) => {
    now += ms;
    if (pending >= 0 && (pending -= ms) <= 0) { pending = -1; playing = true; }
    else if (playing) {
      t += ms / 1000;
      if (o.length !== undefined && t >= o.length) { t = o.length; playing = false; calls.push("ended"); }
    }
    const fn = next;
    next = null;
    fn?.(now);
  };
  const run = (ms: number, frame = 100) => { for (let i = 0; i < ms / frame; i++) step(frame); };
  return { player, tr, calls, frames, step, run, get playing() { return playing; }, set playing(v: boolean) { playing = v; }, get t() { return t; }, set t(v: number) { t = v; } };
}

test("Play all through the host: plays each stretch there, follows its clock, stops for a jump and plays the next, stops at the end", () => {
  const r = rig();
  r.player.start(playSteps([c("a", 2, 3), c("b", 10, 11)]));
  assert.deepEqual(r.calls, ["play 1"], "the host plays the first stretch from its start (a second before the change)");
  r.run(3100); // the stretch [1, 4): to 4 and one frame on
  assert.ok(r.frames.some((x) => x !== null && x > 2 && x < 4), "the frames follow the host's clock");
  assert.deepEqual(r.calls, ["play 1", "pause"], "at the stretch's end the host stops for the jump");
  r.step(); r.step();
  assert.deepEqual(r.calls.slice(-1), ["play 9"], "two frames later it plays the next stretch from its start");
  assert.deepEqual(r.player.state.rows, [1]);
  r.run(3200);
  assert.deepEqual(r.calls.slice(-1), ["pause"], "the host stops at the last stretch's end");
  assert.equal(r.player.state.done, true);
  assert.equal(r.calls.filter((x) => x.startsWith("play")).length, 2, "one play per stretch: never a seek per frame");
});

test("a stretch that starts where the host plays goes straight on, with no stop", () => {
  const r = rig();
  r.player.start(playSteps([c("a", 2, 3), c("b", 5, 6)])); // [1,4) then [4,7): back to back
  r.run(3000);
  r.run(3000);
  assert.deepEqual(r.calls, ["play 1", "pause"], "one play; the only stop is the end");
});

test("the host stops by itself at its timeline's end: that stretch is over, no pause; the person's pause pauses Play", () => {
  const r = rig({ length: 12.5 });
  r.player.start(playSteps([c("a", 2, 3), c("end", 12, 13)]));
  r.run(3000);
  r.step(); r.step();
  r.run(2000); // plays 11 → 12.5, where the host stops by itself
  assert.ok(r.calls.includes("ended"));
  r.step();
  assert.equal(r.player.state.done, true, "its own stop at the end is the end, not a pause (fix/ux2-laptop's trap)");
  // the person pauses in the editor mid-stretch (Cardboard's Space)
  const p = rig();
  p.player.start(playSteps([c("a", 5, 9)]));
  p.run(1000);
  p.playing = false;
  p.step();
  assert.equal(p.player.state.playing, false, "Play pauses with it");
  assert.equal(p.player.state.step, 0, "where it was");
  const at = p.t;
  p.player.resume();
  assert.deepEqual(p.calls.slice(-1), [`play ${at}`], "and goes on from there");
});

test("a host slow to start (its audio loading) is asked again, then given up on; a stretch past the shown end is not played", () => {
  const r = rig({ startsAfter: 99_000 });
  r.player.start([stepFor([c("a", 3, 4)], 0)!]);
  r.run(PLAY_ASK_MS * (PLAY_ASKS + 1) + 500);
  assert.equal(r.calls.filter((x) => x.startsWith("play")).length, PLAY_ASKS, "asked again a few times");
  assert.equal(r.player.state.done, true, "then the stretch is given up");
  const past = rig({ length: 20 });
  past.player.start(playSteps([c("gone", 25, 26), c("b", 5, 6)]));
  past.run(2500);
  assert.ok(!past.calls.includes("play 24"), "never asked to play past the end (Cardboard would start over at 0:00)");
  assert.ok(past.calls.includes("play 4"));
});

test("pause and stop stop the host only while Play plays it; a step with no place stops it while lit", () => {
  const r = rig();
  r.player.start(playSteps([c("a", 2, 3), c("fps")]));
  r.run(500);
  r.player.pause();
  assert.deepEqual(r.calls, ["play 1", "pause"]);
  // the person plays in the editor while Play is paused: Play's stop leaves it playing
  r.playing = true;
  r.player.stop();
  assert.deepEqual(r.calls, ["play 1", "pause"], "the person's own playback is theirs");
  const f = rig();
  f.player.start(playSteps([c("a", 2, 3), c("fps")]));
  f.run(3100);
  assert.equal(f.player.state.rows[0], 1, "the frame rate's row lit");
  assert.equal(f.playing, false, "the host stopped while it is");
  const d = rig();
  d.player.start(playSteps([c("a", 2, 6)]));
  d.run(300);
  d.player.dispose();
  assert.equal(d.playing, false, "closing the panel stops what Play started");
});

test("without a transport: Play's own clock, as before", () => {
  let now = 0, next: ((t: number) => void) | null = null;
  const clock: Clock = { now: () => now, request: (fn) => ((next = fn), 1), cancel: () => void (next = null) };
  const p = new SpanPlayer({ clock });
  const seen: number[] = [];
  p.onFrame((t) => t !== null && seen.push(t));
  p.start(playSteps([c("a", 2, 3)]));
  for (let i = 0; i < 5; i++) { now += 100; const fn = next as ((t: number) => void) | null; next = null; fn?.(now); }
  assert.ok(Math.abs(seen.at(-1)! - 1.5) < 1e-9, "its own time: 1 s + 0.5 s");
});

// Review of a2725f9c #2, #3: a start still loading its sound is Play's own: stopping Play cancels it (the host's
// playing() is still false then); and while the host says it is loading, Play neither asks again nor gives up.
test("a start still loading its sound: Pause, stop and closing cancel it; no new ask and no giving up while it loads", () => {
  for (const how of ["pause", "stop", "dispose"] as const) {
    const r = rig({ startsAfter: 99_000 });
    r.player.start(playSteps([c("a", 3, 4)]));
    r.run(500);
    r.player[how]();
    assert.deepEqual(r.calls, ["play 2", "pause"], `${how}: the pending start is called off`);
  }
  const r = rig({ startsAfter: 9_000 });
  r.tr.loading = () => !r.playing && r.calls.at(-1)!.startsWith("play");
  r.player.start(playSteps([c("a", 3, 4)]));
  r.run(8_000);
  assert.deepEqual(r.calls, ["play 2"], "asked once: never again while it loads");
  assert.equal(r.player.state.playing, true, "not given up");
  r.run(1_500);
  assert.ok(r.playing, "plays once its sound is in");
});

// Review #6: Before shows the older side, which may end sooner: Cardboard stops at its end. That is no end of the
// stretch: Play waits there, and plays on when Before lets go.
test("Before on a shorter older side: Play waits at its end and plays the rest of the stretch once Before lets go", () => {
  const r = rig({ length: 20 });
  r.player.start(playSteps([c("a", 5, 8)])); // [4, 9)
  r.run(600);
  r.player.hold(true);
  // the older side ends at 5: Cardboard stops there by itself
  r.tr.length = () => 5;
  r.t = 5;
  r.playing = false;
  r.run(2_000);
  assert.equal(r.player.state.done, false, "not over: the stretch goes to 9");
  assert.equal(r.player.state.playing, true);
  assert.equal(r.calls.filter((x) => x.startsWith("play")).length, 1, "and not asked to play the older side's end again");
  r.tr.length = () => 20;
  r.player.hold(false);
  r.run(300);
  assert.deepEqual(r.calls.slice(-1), ["play 5"], "the newer side plays on from there");
  r.run(4_200);
  assert.equal(r.player.state.done, true, "to the stretch's end");
  // a later stretch past the older side's end waits too, rather than being skipped
  const s = rig({ length: 20 });
  s.player.start(playSteps([c("a", 2, 3), c("b", 12, 13)]));
  s.player.hold(true);
  s.tr.length = () => 6;
  s.run(3_100);
  s.run(1_000);
  assert.equal(s.player.state.step, 1, "on the second stretch");
  assert.ok(!s.calls.includes("play 11"), "not played on the older side, which has nothing there");
  s.player.hold(false);
  s.tr.length = () => 20;
  s.run(300);
  assert.deepEqual(s.calls.slice(-1), ["play 11"], "played once Before lets go");
});

// Review #7: Play stops only playback it started. The person's own playback, playing when Play starts, is replaced
// (stopped, then Play plays its own from the stretch's start), never taken over as Play's; playback the person starts
// while Play is paused or over is never stopped by Play's cleanup.
test("Play owns only the playback it started: it replaces the person's at its start, and never stops theirs afterwards", () => {
  const r = rig();
  r.playing = true; // the person's own playback, near the stretch's start
  r.t = 3.95;
  r.player.start(playSteps([c("a", 5, 8)])); // [4, 9)
  assert.deepEqual(r.calls, ["pause"], "the person's playback stopped, not taken over");
  r.step(); r.step(); r.step();
  assert.deepEqual(r.calls, ["pause", "play 4"], "Play plays its own, from the stretch's start");
  // paused by the person in the editor, then their own playback: Play's stop and closing leave it alone
  r.run(500);
  r.playing = false;
  r.step();
  assert.equal(r.player.state.playing, false);
  r.playing = true;
  r.player.stop();
  r.player.dispose();
  assert.equal(r.playing, true, "theirs plays on");
  assert.deepEqual(r.calls, ["pause", "play 4"]);
});
