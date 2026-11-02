// The overlap rules injected for P9's comparison keyings and the R11-01 control (moved out of core so the shipped
// bundle carries only the plan's rule): each classifies as the prototype's server did.
import test from "node:test";
import assert from "node:assert/strict";
import { declare, sequencer as rules, type Change, type Doc, type Op } from "@carton/core";
import { cardboard, withKeys } from "../../src/engine/fixtures/cardboard-schema.ts";
import { groupIsLeafRule, keyingRule, type Keying } from "../../src/system/rule-variants.ts";

const clip = (id: string, s: number, e: number) => ({ id, trackId: "V1", type: "video", name: id, startTime: s, endTime: e, trimStart: 0, trimEnd: e - s, opacity: 1 });
const d0: Doc = withKeys({ name: "d", tracks: [{ id: "V1", order: 0 }, { id: "T2", order: 1 }], timelineItems: [clip("c0", 0, 5), clip("c1", 5, 10), clip("c2", 10, 15), clip("c3", 15, 20)] });
const set = (id: string, f: string, v: unknown): Op => ({ op: "set", path: ["timelineItems", id, f], value: v });
let n = 0;
function ch(ops: Op[], policy: Change["policy"] = "merge"): Change {
  return { id: `r${++n}.1`, hash: "h", author: { kind: "human", id: "x" }, branchId: "b", base: { seq: 0, pending: [] }, ops, intent: null, kinds: null, policy, at: 0, ...declare(cardboard, d0, ops) };
}
const tl = cardboard.timeline!;
const row = (c: Change): rules.TailRow => ({ seq: 1, id: c.id, withdrawn: false, paths: rules.storedPaths(c), reads: c.reads, spans: c.spans, structural: rules.isStructural(c.ops, c.intent, tl) });
const kind = (k: Keying, a: Change, b: Change) => {
  const rule = keyingRule(k);
  const s = rules.isStructural(a.ops, a.intent, tl);
  return rule ? rule.kind(rule.index(a, s), row(b)) : rules.overlapKind(rules.indexChange(a, s), row(b));
};

test("P9 comparison keyings classify as the prototype's server did", () => {
  const trimC0 = ch([set("c0", "endTime", 5.5), set("c0", "trimEnd", 5.5)]);
  const trimC1 = ch([set("c1", "startTime", 4.5), set("c1", "trimStart", 0)]);
  const moveC3 = ch([set("c3", "startTime", 16), set("c3", "endTime", 21)]);
  assert.equal(kind("v3-spans", trimC0, trimC1), rules.NONE, "v3: two plain trims of neighbours don't meet");
  assert.equal(kind("v3-spans-v10", trimC0, trimC1), rules.STRUCTURE, "v10: any intersecting spans");
  assert.equal(kind("v3-spans-v10", trimC0, moveC3), rules.NONE);
  assert.equal(kind("v2-layout", trimC0, moveC3), rules.STRUCTURE, "v2: any two span-bearing changes on one track");
  const trimIn = ch([set("c1", "startTime", 5.5), set("c1", "trimStart", 0.5)]);
  const speed = ch([set("c1", "playbackSpeed", 2)]);
  assert.equal(kind("v3-spans", trimIn, speed), rules.STRUCTURE, "v3: they meet through items/c1/#time");
  assert.equal(kind("per-item", trimIn, speed), rules.NONE, "per-item has no group path");
  assert.equal(kind("v3-spans-v10", trimIn, speed), rules.STRUCTURE, "v10 has no group path, but the spans intersect");
});

test("the pre-v12 classifier (R11-01 control) lets crossing lww trims both through; the plan's rule doesn't", () => {
  const trimIn = ch([set("c1", "startTime", 7), set("c1", "trimStart", 2)], "lww");
  const trimOut = ch([set("c1", "endTime", 6), set("c1", "trimEnd", 1)], "lww");
  const rows: rules.TailRow[] = [];
  const view: rules.SequencerView = {
    head: () => rows.length,
    tail: (after) => rows.slice(after),
    record: (coll, id) => (coll === "tracks" ? { alive: true, seq: 0 } : { alive: true, seq: 0, lane: (d0.timelineItems as { id: string; trackId: string }[]).find((i) => i.id === id)?.trackId }),
  };
  const control: rules.RulesConfig = { timeline: tl, overlap: groupIsLeafRule, controls: { lwwCheck: false, lwwWithSpans: true } };
  assert.equal(rules.evaluatePush(view, trimIn, control).kind, "accept");
  rows.push(row(trimIn));
  const second = rules.evaluatePush(view, trimOut, control);
  assert.ok(second.kind === "accept" && second.lww, "both accepted as lww: an invalid clip would be confirmed");
  const rule = rules.evaluatePush(view, trimOut, { timeline: tl, controls: { lwwCheck: false } });
  assert.ok(rule.kind === "reject" && rule.reason === "overlap", "the plan's rule alone sends it to merge3");
});
