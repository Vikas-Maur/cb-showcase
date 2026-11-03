// The change map (docs/carton-ux DESIGN §5.2): the edit's length as a slim bar, a tick where each change is (green
// added, red removed, amber changed), the hovered or playing changes' ticks lit, and the playhead while playing. It is
// decoration for sighted people: the change rows beside it carry the same information, so it is aria-hidden (§7).
//
// The playhead moves outside React (PLAN 4.2): `moveMapPlayhead(mapEl, seconds)` sets its transform; nothing renders
// per frame. A list of thousands of changes draws at most one tick per kind per 1/240 of the bar.

import { createElement as h, memo, useMemo } from "react";
import type { Change, ChangeKind } from "../model.ts";
import { cx } from "./ui.ts";

/** Ticks across the bar: changes closer than 1/BUCKETS of the edit share one tick per kind. */
const BUCKETS = 240;

/** The bar's length when the host gives none: the furthest change's end, rounded up to 10 s (a 0:38 edit reads 0:40). */
export function mapLength(changes: readonly Change[]): number {
  let max = 0;
  for (const c of changes) {
    const e = c.end ?? c.at;
    if (e !== undefined && Number.isFinite(e) && e > max) max = e;
  }
  return Math.max(10, Math.ceil(max / 10) * 10);
}

export interface ChangeMapProps {
  changes: readonly Change[];
  /** The edit's length in seconds. Default: `mapLength(changes)`. */
  length?: number;
  /** The changes lit, by key: the row hovered, the rows being played. */
  lit?: ReadonlySet<string> | readonly string[] | string | null;
  className?: string;
}

interface Tick {
  readonly x: number;
  readonly kind: ChangeKind;
  readonly keys: readonly string[];
}

export const ChangeMap = memo(function ChangeMap(p: ChangeMapProps) {
  const length = p.length && p.length > 0 ? p.length : mapLength(p.changes);
  const ticks = useMemo(() => {
    const out = new Map<string, { x: number; kind: ChangeKind; keys: string[] }>();
    for (const c of p.changes) {
      if (c.at === undefined || !Number.isFinite(c.at)) continue;
      const b = Math.max(0, Math.min(BUCKETS, Math.round((c.at / length) * BUCKETS)));
      const id = `${b}:${c.kind}`;
      const t = out.get(id);
      if (t) t.keys.push(c.key);
      else out.set(id, { x: Math.round((b / BUCKETS) * 10_000) / 100, kind: c.kind, keys: [c.key] });
    }
    return [...out.values()] as Tick[];
  }, [p.changes, length]);
  const lit = p.lit == null ? null : typeof p.lit === "string" ? new Set([p.lit]) : p.lit instanceof Set ? p.lit : new Set(p.lit as readonly string[]);
  return h(
    "div",
    { className: cx("carton-map", p.className), "aria-hidden": true, "data-length": length },
    h("span", { className: "carton-map-track" }),
    ...ticks.map((t) =>
      h("span", {
        key: `${t.x}:${t.kind}`,
        className: "carton-map-tick",
        "data-kind": t.kind,
        "data-lit": lit && t.keys.some((k) => lit.has(k)) ? "" : undefined,
        style: { left: `${t.x}%` },
      }),
    ),
    h("span", { className: "carton-map-playhead", hidden: true }),
  );
});

/**
 * Move the map's playhead to `at` seconds, or hide it (null). Outside React: the player calls it every frame. `map`
 * is the `.carton-map` element (it carries its length).
 */
export function moveMapPlayhead(map: Element | null, at: number | null): void {
  const el = map?.querySelector<HTMLElement>(".carton-map-playhead");
  if (!el) return;
  if (at === null || !Number.isFinite(at)) {
    el.hidden = true;
    return;
  }
  const length = Number((map as HTMLElement).dataset.length) || 1;
  el.hidden = false;
  // the playhead spans the bar and draws its line at its left edge: a transform moves it, with no layout per frame
  el.style.transform = `translateX(${Math.max(0, Math.min(100, (at / length) * 100))}%)`;
}
