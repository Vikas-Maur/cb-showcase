// The timeline's edits as Carton ops (pure, so they are tested without a browser). Each edit sets only the fields it
// changes, so a teammate's edit to another field of the same clip merges cleanly (§7), and the clip's time fields
// travel as one group (§4.1 R3-05). Times snap to 0.1 s, as Cardboard's own timeline does.

import type { Doc, Op, Rec } from "@carton/core";
import { ITEMS } from "./demo-doc.ts";

/** The shortest clip a trim may leave, in seconds. */
export const MIN_LEN = 0.3;
const snap = (t: number) => Math.round(t * 10) / 10;
const set = (id: string, field: string, value: unknown): Op => ({ op: "set", path: [ITEMS, id, field], value });

export function clipOf(doc: Doc, id: string): Rec | undefined {
  return ((doc[ITEMS] ?? []) as Rec[]).find((r) => r.id === id);
}
const num = (r: Rec, f: string, d = 0) => (typeof r[f] === "number" ? (r[f] as number) : d);

/** Where a clip lands when dragged to `start` (and maybe another track): its length is kept, it never starts below 0. */
export function movePlacement(clip: Rec, start: number): { start: number; end: number } {
  const len = num(clip, "endTime") - num(clip, "startTime");
  const s = Math.max(0, snap(start));
  return { start: s, end: snap(s + len) };
}

export function moveOps(clip: Rec, start: number, trackId?: string): Op[] {
  const p = movePlacement(clip, start);
  const id = String(clip.id);
  const ops: Op[] = [];
  if (p.start !== clip.startTime) ops.push(set(id, "startTime", p.start), set(id, "endTime", p.end));
  if (trackId && trackId !== clip.trackId) ops.push(set(id, "trackId", trackId));
  return ops;
}

/**
 * Where a clip's edge lands when trimmed to `t`. A media clip can't reach before its source's start or past its end
 * (`sourceLength`, seconds of source); a caption has no source and only keeps its minimum length.
 */
export function trimPlacement(clip: Rec, edge: "start" | "end", t: number, sourceLength = Infinity): { start: number; end: number; trimStart: number; trimEnd: number } {
  const speed = num(clip, "playbackSpeed", 1) || 1;
  const s0 = num(clip, "startTime"), e0 = num(clip, "endTime"), ts0 = num(clip, "trimStart"), te0 = num(clip, "trimEnd", (e0 - s0) * speed);
  const media = clip.type !== "caption" && clip.type !== "text";
  if (edge === "start") {
    // the source can't go below 0, and the clip keeps MIN_LEN
    const lo = media ? s0 - ts0 / speed : 0;
    const s = Math.min(Math.max(snap(t), Math.max(0, snap(lo))), snap(e0 - MIN_LEN));
    return { start: s, end: e0, trimStart: media ? snap(ts0 + (s - s0) * speed) : 0, trimEnd: media ? te0 : snap(e0 - s) };
  }
  const hi = media && Number.isFinite(sourceLength) ? s0 + (sourceLength - ts0) / speed : Infinity;
  const e = Math.max(Math.min(snap(t), snap(hi)), snap(s0 + MIN_LEN));
  return { start: s0, end: e, trimStart: ts0, trimEnd: media ? snap(ts0 + (e - s0) * speed) : snap(e - s0) };
}

export function trimOps(clip: Rec, edge: "start" | "end", t: number, sourceLength?: number): Op[] {
  const p = trimPlacement(clip, edge, t, sourceLength);
  const id = String(clip.id);
  const ops: Op[] = [];
  if (p.start !== clip.startTime) ops.push(set(id, "startTime", p.start));
  if (p.end !== clip.endTime) ops.push(set(id, "endTime", p.end));
  if (p.trimStart !== clip.trimStart) ops.push(set(id, "trimStart", p.trimStart));
  if (p.trimEnd !== clip.trimEnd) ops.push(set(id, "trimEnd", p.trimEnd));
  return ops;
}

/** Caption text, volume (0–200 %, Cardboard's default 100) or opacity (0–1). Nothing when the value is unchanged. */
export function fieldOps(clip: Rec, field: "captionText" | "volume" | "opacity", value: string | number): Op[] {
  let v = value;
  if (field === "volume") v = Math.round(Math.min(200, Math.max(0, Number(value))));
  if (field === "opacity") v = Math.round(Math.min(1, Math.max(0, Number(value))) * 100) / 100;
  if (field === "captionText") v = String(value);
  const was = clip[field] ?? (field === "volume" ? 100 : field === "opacity" ? 1 : "");
  return was === v ? [] : [set(String(clip.id), field, v)];
}

/** The edit's end: where the last clip ends (seconds). */
export function docLength(doc: Doc): number {
  let end = 0;
  for (const r of (doc[ITEMS] ?? []) as Rec[]) end = Math.max(end, num(r, "endTime"));
  return end;
}
