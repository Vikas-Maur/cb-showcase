// Merge properties shared by the fuzz tests (port of core-v5 `props.mjs`: core-proto's, extended for v5).
import assert from "node:assert/strict";
import * as E from "@carton/core";
import type { Choice, Doc, MergeOptions, Schema } from "@carton/core";
import { pick } from "./gen.ts";
import type { Rng } from "./gen.ts";

type Item = Record<string, any>;
const TIME = new Set(["startTime", "endTime", "trimStart", "trimEnd", "playbackSpeed"]);

/** Every record passes the host's hard validators (times, trims, type, track exists); the first problem otherwise. */
export function valid(doc: Doc, S: Schema): string | null {
  const hard = S.hard!;
  for (const it of (doc.timelineItems as Item[] | undefined) ?? []) if (hard("timelineItems", it, doc).length) return `${it.id}: ${hard("timelineItems", it, doc).join("; ")}`;
  return null;
}

export interface MergeTally {
  conflicts?: number;
  remaps?: number;
  composed?: number;
  mapped?: number;
  text?: number;
}

/**
 * merge3(b, x, y) against merge3(b, y, x): symmetric up to side naming, the provisional doc is resolve(all ours), m.ops
 * turn ours into the merge, no change of either side is lost without a card, and every all-ours / all-theirs / random
 * resolution is valid.
 */
export function checkMerge(S: Schema, b: Doc, x: Doc, y: Doc, r: Rng, label: string, tally: MergeTally = {}, opts: MergeOptions = {}) {
  const snap = (d: Doc) => E.snapshot(d, S);
  const same = (a: Doc, c: Doc, msg: string) => assert.equal(snap(a), snap(c), msg);
  const m1 = E.merge3(b, x, y, S, opts),
    m2 = E.merge3(b, y, x, S, opts);
  tally.conflicts = (tally.conflicts ?? 0) + m1.conflicts.length;
  tally.remaps = (tally.remaps ?? 0) + (Object.keys(m1.remaps.ours).length || Object.keys(m1.remaps.theirs).length ? 1 : 0);
  tally.composed = (tally.composed ?? 0) + m1.stats.composed.length;
  tally.mapped = (tally.mapped ?? 0) + m1.stats.mapped.length;
  const key = (cs: E.ConflictCard[], flip: boolean) => cs.map((k) => JSON.stringify([k.kind, k.path, k.base, flip ? k.theirs : k.ours, flip ? k.ours : k.theirs])).sort();
  assert.deepEqual(key(m1.conflicts, false), key(m2.conflicts, true), `${label} conflicts not symmetric`);
  const n = m1.conflicts.length;
  const all = (v: Choice): Choice[] => Array(n).fill(v);
  same(E.resolve(m1, all("ours")), m1.doc, `${label} provisional == resolve(ours)`);
  same(E.resolve(m1, all("ours")), E.resolve(m2, all("theirs")), `${label} sym ours`);
  same(E.resolve(m1, all("theirs")), E.resolve(m2, all("ours")), `${label} sym theirs`);
  same(E.apply(E.fork(x, S), m1.ops, S), m1.doc, `${label} ops`);
  // no silent loss
  const covered = m1.conflicts.flatMap((k) => [k.path, ...(k.related ?? [])]);
  const isCovered = (k: string) => covered.some((p) => k === p || k.startsWith(p + "/") || p.startsWith(k + "/"));
  const exempt = new Set([...m1.stats.composed, ...m1.stats.mapped]);
  for (const side of [x, y])
    for (const op of E.diff(b, side, S)) {
      const k = E.pathKey(op.path);
      if (isCovered(k) || op.path.at(-1) === E.POS) continue;
      const rec = op.path[0] === "timelineItems" ? E.pathKey(op.path.slice(0, 2)) : null;
      if (rec && TIME.has(op.path[2] as string) && (exempt.has(rec) || !E.getIn(m1.doc, op.path.slice(0, 2), S))) continue;
      const spec = E.specAt(S, op.path);
      if (spec?.kind === "leaf" && spec.text) {
        tally.text = (tally.text ?? 0) + 1;
        continue; // merged line by line (checked in the text tests)
      }
      const v = E.getIn(m1.doc, op.path, S);
      if (op.op === "set") {
        if (op.path.length === 2) assert.ok(v !== undefined, `${label} lost ${k}`);
        else assert.deepEqual(v, op.value, `${label} lost ${k}`);
      } else if (op.op === "insert") assert.ok(v !== undefined, `${label} lost insert ${k}`);
      else assert.equal(v, undefined, `${label} lost removal ${k}`);
    }
  for (const choice of ["ours", "theirs"] as const) assert.equal(valid(E.resolve(m1, all(choice)), S), null, `${label} valid ${choice}`);
  for (let k = 0; k < 3 && n > 1; k++) assert.equal(valid(E.resolve(m1, Array.from({ length: n }, () => pick(r, ["ours", "theirs"] as const))), S), null, `${label} valid mixed`);
  return m1;
}
