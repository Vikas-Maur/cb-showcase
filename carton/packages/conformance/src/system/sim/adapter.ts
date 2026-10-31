// What the system simulation needs from the engine, on the real `@carton/core` engine and the pinned Cardboard schema
// fixture (port of system-v11 `adapter.mjs`, which wrapped core-v5). Remaps are recorded intents (`{maps}`) with
// their set ops, as the verified prototype ran them; the queue's rebase passes recorded remaps and edit kinds to merge3.

import { apply, diff as engineDiff, fork as engineFork, getIn as engineGetIn, hashDoc as engineHashDoc, inferRemaps, isEmptyMap, merge3 as engineMerge3, pathKey, remapSpan, rippleDelete, snapshot as engineSnapshot, composeMaps } from "@carton/core";
import type { ConflictCard, Doc, Intent, MergeOptions, Op, Path, RemapMaps, SoftWarning } from "@carton/core";
import { cardboard, withKeys, type HostDoc } from "../../engine/fixtures/cardboard-schema.ts";
import { realProjection } from "../../engine/fmsv.ts";

export const S = cardboard;
export const ENGINE = "@carton/core";
export const ITEMS = "timelineItems";
export const TIME = ["startTime", "endTime", "trimStart", "trimEnd", "playbackSpeed"];
export type Item = Record<string, any>;
export type SimDoc = Doc & { timelineItems?: Item[]; tracks?: Item[] };

export const normalize = (doc: HostDoc): SimDoc => withKeys(doc) as SimDoc;
export const fork = (doc: Doc): SimDoc => engineFork(doc, S) as SimDoc;
export const diff = (a: Doc, b: Doc): Op[] => engineDiff(a, b, S);
export const snapshot = (doc: Doc): string => engineSnapshot(doc, S);
export const hashDoc = (doc: Doc): string => engineHashDoc(doc, S);
export { pathKey };
export const getIn = (doc: Doc, path: Path): unknown => engineGetIn(doc, path, S);
export const item =(doc: Doc, id: string): Item | undefined => engineGetIn(doc, [ITEMS, id], S) as Item | undefined;
export const clone = <T>(doc: T): T => JSON.parse(JSON.stringify(doc)) as T;
export const applyOps = (doc: Doc, ops: readonly Op[]): SimDoc => apply(fork(doc), ops, S) as SimDoc;

/** A named ripple: delete `[at + delta, at)` on `track` (delta < 0), optionally removing an item first (§7). */
export function rippleAction(doc: Doc, { track, at, delta, removeId = null }: { track: string; at: number; delta: number; removeId?: string | null }): { ops: Op[]; intent: Intent } {
  const maps: RemapMaps = { [track]: rippleDelete(at + delta, -delta) };
  const ops: Op[] = removeId ? [{ op: "remove", path: [ITEMS, removeId] }] : [];
  for (const rec of ((doc as SimDoc)[ITEMS] ?? []) as Item[]) {
    if (rec.trackId !== track || rec.id === removeId) continue;
    const m = remapSpan(maps[track], rec.startTime, rec.endTime);
    if (!m || (m[0] === rec.startTime && m[1] === rec.endTime)) continue;
    ops.push({ op: "set", path: [ITEMS, rec.id, "startTime"], value: m[0] }, { op: "set", path: [ITEMS, rec.id, "endTime"], value: m[1] });
  }
  return { ops, intent: { maps } };
}
export function inferIntent(base: Doc, ops: readonly Op[]): Intent | null {
  const maps = inferRemaps(S, base, ops.map((op) => ({ path: op.path, op })));
  return isEmptyMap(maps) ? null : { maps, inferred: true };
}

/**
 * A three-way merge. `oursRecorded`: the recorded remaps of the changes on the ours side since base, when known
 * (`[]`: known to have none; null/undefined: unknown, so the engine infers when unambiguous).
 */
export function merge3(base: Doc, ours: Doc, theirs: Doc, opts: MergeOptions & { oursRecorded?: RemapMaps[] | null } = {}): { doc: SimDoc; conflicts: ConflictCard[]; warnings: SoftWarning[] } {
  const { oursRecorded, ...rest } = opts;
  if (oursRecorded) rest.remaps = { ...(rest.remaps ?? {}), ours: { maps: oursRecorded.length ? composeMaps(...oursRecorded) : {} } };
  const m = engineMerge3(base, ours, theirs, S, rest);
  return { doc: m.doc as SimDoc, conflicts: m.conflicts, warnings: m.warnings };
}

/** Hard and soft diagnostics for a view's status sidecar (as 1.4.0 prints them). */
export function validate(doc: Doc): { hard: string[]; soft: string[] } {
  const hard: string[] = [], soft: string[] = [];
  const d = doc as SimDoc;
  const tracks = new Set((d.tracks ?? []).map((t) => t.id));
  const byTrack = new Map<string, Item[]>();
  for (const it of d[ITEMS] ?? []) {
    if (!(it.endTime > it.startTime)) hard.push(`${it.id} ends at or before it starts (${it.startTime} → ${it.endTime})`);
    if (it.trimEnd !== undefined && !(it.trimEnd > it.trimStart)) hard.push(`${it.id} trimEnd ≤ trimStart`);
    if (!tracks.has(it.trackId)) hard.push(`${it.id} is on a missing track ${it.trackId}`);
    const l = byTrack.get(it.trackId) ?? [];
    l.push(it);
    byTrack.set(it.trackId, l);
  }
  for (const [t, l] of byTrack) {
    l.sort((a, b) => a.startTime - b.startTime);
    for (let i = 1; i < l.length; i++) if (l[i]!.startTime < l[i - 1]!.endTime - 1e-9) soft.push(`${l[i - 1]!.id} and ${l[i]!.id} overlap on ${t}`);
  }
  return { hard, soft };
}

// ---------------------------------------------------------------- GUI projection (§4.3, B10)
const REAL_P = realProjection();
const GUI_FIELDS = new Set(["id", "trackId", "type", "name", "startTime", "endTime", "trimStart", "trimEnd", "opacity", "textContent", "volume"]);
const ho = (t: number) => Math.round(t * 10) / 10;
const standIn = (it: Item): Item => {
  const p: Item = {};
  for (const k of Object.keys(it)) if (GUI_FIELDS.has(k)) p[k] = TIME.includes(k) && k !== "playbackSpeed" ? ho(it[k]) : it[k];
  return p;
};
export const PROJECTION = REAL_P ? "Cardboard 1.4.0 fm∘sv (real, from the renderer bundle)" : "stand-in (0.1 s rounding + whitelist)";
const P = REAL_P ?? standIn;
export function project(doc: Doc): SimDoc {
  return { ...doc, [ITEMS]: (((doc as SimDoc)[ITEMS] ?? []) as Item[]).map(P) } as SimDoc;
}
/** A GUI save: diff(P(base), gui), so values the GUI can't represent never count as edits. */
export const guiOps = (baseTrue: Doc, guiDoc: Doc): Op[] => diff(project(baseTrue), guiDoc);
