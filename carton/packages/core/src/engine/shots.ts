// The shot diff (PLAN §9, "Watch the changes"). Shots: maximal output intervals over which the stack of visible items
// and their source mapping is continuous. A shot's signature is its content (layers: attributes minus timing, source
// in-point, speed) and duration, never its output position. Items can declare time-varying windows (fades,
// transitions, keyframe ranges) in item-local time, anchored to the item's start or end; shots split at window edges,
// and inside a window the offset from that anchor is part of the signature.
import type { Schema, ShotWindow } from "../schema.ts";
import type { Doc, Rec, Shot, ShotDiff } from "../types.ts";
import { canonical, keyPrefix, EMPTY } from "./json.ts";
import { byPos } from "./keys.ts";
import { lcs } from "./lcs.ts";
import { EPS, r6 } from "./remap.ts";

interface Win extends ShotWindow {
  id: number;
}
interface Layer {
  s: number;
  e: number;
  rank: number;
  attr: number;
  src: number;
  speed: number;
  win: Win[];
}
interface ShotLayer {
  l: Layer;
  src: number;
  local: number;
  w: Win | undefined;
}
interface OpenShot {
  start: number;
  end: number;
  layers: ShotLayer[];
}

const CANON = new WeakMap<object, string>(),
  ATTRS = new WeakMap<object, { ignore: string; str: string }>();
function canonicalShared(v: unknown): string {
  if (v === null || typeof v !== "object") return canonical(v);
  let c = CANON.get(v);
  if (c === undefined) CANON.set(v, (c = canonical(v)));
  return c;
}

/** Shots of a doc's output timeline. `intern` shares signature numbers between two calls. */
export function shots(doc: Doc, schema: Schema, intern: Map<string, number> = new Map()): Shot[] {
  const tl = schema.timeline;
  if (!tl) return [];
  const sh = tl.shots ?? {};
  const lk = schema.collections[tl.lanes]?.key ?? "id";
  const laneList = [...((doc[tl.lanes] as Rec[] | undefined) ?? EMPTY)].sort(byPos(lk));
  const lanes = new Map(laneList.map((t, i) => [t[lk], { ...t, order: i }]));
  const ignore = new Set([...(sh.ignore ?? []), ...(sh.edgeFields ?? [])]);
  const ignoreKey = [...ignore].join(",");
  const sym = (s: string): number => {
    let v = intern.get(s);
    if (v === undefined) intern.set(s, (v = intern.size));
    return v;
  };
  const layers: Layer[] = [],
    cuts: number[] = [0];
  for (const it of (doc[tl.collection] as Rec[] | undefined) ?? EMPTY) {
    const lane = lanes.get(it[tl.lane]);
    if (sh.visible && !sh.visible(it, lane)) continue;
    const s = it[tl.start] as number,
      e = it[tl.end] as number;
    if (!(e - s > EPS)) continue;
    let attrs = ATTRS.get(it);
    if (attrs === undefined || attrs.ignore !== ignoreKey) {
      let str = "";
      for (const k of Object.keys(it).sort()) {
        if (ignore.has(k) || it[k] === undefined) continue;
        str += keyPrefix(k) + canonicalShared(it[k]) + ",";
      }
      ATTRS.set(it, (attrs = { ignore: ignoreKey, str }));
    }
    const win = (sh.windows?.(it, e - s) ?? []).filter((w) => w.b > w.a).map((w) => ({ ...w, id: sym("w:" + (w.sig ?? "")) }));
    layers.push({ s, e, rank: sh.rank ? sh.rank(it, lane) : 0, attr: sym(attrs.str), src: (it[tl.source] as number) ?? 0, speed: (it[tl.speed] as number) ?? 1, win });
    cuts.push(r6(s), r6(e));
    for (const w of win) cuts.push(r6(Math.min(e, Math.max(s, s + w.a))), r6(Math.min(e, Math.max(s, s + w.b))));
  }
  const bounds = [...new Set(cuts)].sort((a, b) => a - b);
  const byStart = [...layers].sort((a, b) => a.s - b.s),
    byEnd = [...layers].sort((a, b) => a.e - b.e);
  const active = new Set<Layer>(),
    open: OpenShot[] = [];
  let si = 0,
    ei = 0,
    cur: OpenShot | null = null;
  for (let b = 0; b < bounds.length - 1; b++) {
    const t = bounds[b]!,
      t2 = bounds[b + 1]!;
    while (ei < byEnd.length && byEnd[ei]!.e <= t + EPS) active.delete(byEnd[ei++]!);
    while (si < byStart.length && byStart[si]!.s <= t + EPS) {
      const l = byStart[si++]!;
      if (l.e > t + EPS) active.add(l);
    }
    const stack = [...active].sort((x, y) => x.rank - y.rank || x.attr - y.attr || x.s - y.s);
    const layer = (l: Layer): ShotLayer => ({ l, src: l.src + (t - l.s) * l.speed, local: t - l.s, w: l.win.find((w) => t - l.s >= w.a - EPS && t - l.s < w.b - EPS) });
    if (cur && continues(cur, stack, t)) {
      cur.end = t2;
      continue;
    }
    cur = { start: t, end: t2, layers: stack.map(layer) };
    open.push(cur);
  }
  const q = (x: number) => Math.round(x * 1e4);
  return open.map((s) => {
    const desc = s.layers.map((x) => {
      const w = x.w ? `:w${x.w.id}${x.w.from === "end" ? "e" + q(x.l.e - x.l.s - x.local) : "s" + q(x.local)}` : "";
      return `${x.l.attr}:${q(x.l.speed)}:${q(x.src)}${w}`;
    });
    return { start: s.start, end: s.end, layers: s.layers.length, sig: sym(q(s.end - s.start) + "|" + desc.join(",")) };
  });
}

function continues(cur: OpenShot, stack: Layer[], t: number): boolean {
  if (stack.length !== cur.layers.length) return false;
  const dt = t - cur.start;
  const inWin = (x: Layer, loc: number) => x.win.find((w) => loc >= w.a - EPS && loc < w.b - EPS);
  for (let i = 0; i < stack.length; i++) {
    const a = cur.layers[i]!,
      l = stack[i]!,
      local = t - l.s;
    if (inWin(l, local) !== a.w || (a.l !== l && inWin(a.l, a.local + dt) !== a.w)) return false;
    if (a.l === l) continue;
    if (a.l.attr !== l.attr || Math.abs(a.l.speed - l.speed) > EPS) return false;
    if (Math.abs(a.src + dt * a.l.speed - (l.src + local * l.speed)) > 1e-4) return false;
  }
  return true;
}

/** "Watch the changes": shots aligned like a text diff. */
export function shotDiff(a: Doc, b: Doc, schema: Schema): ShotDiff {
  const intern = new Map<string, number>();
  const A = shots(a, schema, intern),
    B = shots(b, schema, intern);
  const matches = lcs(
    A.map((s) => s.sig),
    B.map((s) => s.sig),
  );
  const changed: ShotDiff["changed"] = [];
  let i = 0,
    j = 0,
    shifted = 0;
  const range = (S: Shot[], x: number, y: number): [number, number] | null => (x < y ? [S[x]!.start, S[y - 1]!.end] : null);
  const at = (S: Shot[], x: number): number => (x < S.length ? S[x]!.start : S.length ? S[S.length - 1]!.end : 0);
  for (const [mi, mj] of [...matches, [A.length, B.length] as [number, number]]) {
    if (mi > i || mj > j) changed.push({ a: range(A, i, mi), b: range(B, j, mj), aAt: at(A, i), bAt: at(B, j) });
    if (mi < A.length && Math.abs(A[mi]!.start - B[mj]!.start) > 1e-4) shifted++;
    i = mi + 1;
    j = mj + 1;
  }
  return { shotsA: A.length, shotsB: B.length, unchanged: matches.length, shifted, changed };
}
