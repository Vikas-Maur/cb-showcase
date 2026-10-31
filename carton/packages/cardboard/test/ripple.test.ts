// Ripple inference from agents' file edits, only when unambiguous (§6.1, L9).
import test from "node:test";
import assert from "node:assert/strict";
import { merge3, remapSpan } from "@carton/core";
import type { Doc, Rec } from "@carton/core";
import { fromHost, toHost, itemOf, cardboardSchema as S } from "../src/index.ts";
import { inferRipple } from "../src/ripple.ts";

const clip = (id: string, s: number, e: number, track = "V1", extra: Rec = {}): Rec => ({ id, trackId: track, type: "video", name: id, startTime: s, endTime: e, trimStart: 0, trimEnd: e - s, ...extra });
const tracks = [{ id: "V1", name: "V1", order: 0 }, { id: "V2", name: "V2", order: 1 }];
const doc = (items: Rec[]): Doc => fromHost({ name: "P", tracks, timelineItems: items }, null);
const edit = (d: Doc, patch: Record<string, Rec>): Doc => {
  const h = toHost(d);
  return fromHost({ ...h, timelineItems: h.timelineItems!.map((i) => (patch[i.id as string] ? { ...i, ...patch[i.id as string] } : i)) }, d);
};
const base = doc([clip("a", 0, 10), clip("c", 15, 25), clip("d", 25, 35), clip("t", 30, 33, "V2")]);

test("closing a gap (every later clip on the track shifted by the same amount) is a ripple: the remap is inferred for that track only", () => {
  const saved = edit(base, { c: { startTime: 10, endTime: 20 }, d: { startTime: 20, endTime: 30 } });
  const intent = inferRipple(base, saved);
  assert.ok(intent?.inferred);
  assert.deepEqual(Object.keys(intent!.maps!), ["V1"]);
  assert.deepEqual(remapSpan(intent!.maps!.V1, 40, 45), [35, 40], "a clip at 40 on V1 maps to 35");
});

test("the inferred remap maps the other side's concurrent insert once (R4-02 case 2)", () => {
  const saved = edit(base, { c: { startTime: 10, endTime: 20 }, d: { startTime: 20, endTime: 30 } });
  const withH = fromHost({ ...toHost(base), timelineItems: [...toHost(base).timelineItems!, clip("h", 40, 45)] }, base);
  const m = merge3(base, withH, saved, S, { remaps: { theirs: inferRipple(base, saved)! } });
  assert.equal(m.conflicts.length, 0);
  assert.deepEqual([itemOf(m.doc, "h")!.startTime, itemOf(m.doc, "h")!.endTime], [35, 40]);
});

test("not a ripple: later clips shifted by different amounts, a lone trim, or a shift with another field changed", () => {
  assert.equal(inferRipple(base, edit(base, { c: { startTime: 10, endTime: 20 }, d: { startTime: 22, endTime: 32 } })), null, "different shifts");
  assert.equal(inferRipple(base, edit(base, { d: { endTime: 34, trimEnd: 9 } })), null, "the last clip trimmed");
  assert.equal(inferRipple(base, edit(base, { c: { name: "renamed" } })), null, "no timing change");
  assert.equal(inferRipple(base, base), null);
});
