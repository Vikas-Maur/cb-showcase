// History's "Only “clip”" filter (PLAN 0.8) over any HistorySource: the versions that touched one clip, read from
// the view model's per-version index (`clipVersions`, async) and kept as positions in History's oldest-first rows. A
// filter read before its answer counts 0 and says it's loading; the answer fires History's topic.
//
// Asked again only when History's versions change (`structure`: a version confirmed, added or gone), never when a row
// is only described (review of the UX data #8: every summary re-read the whole index). After versions were added on
// top, it asks only for the ones after the newest it was answered for (`after`), and keeps the rest; any other change
// asks again whole. The last answer stays meanwhile, its ids placed at the rows' current positions. A few clips are
// kept.

import type { ClipVersions, FilterStatus } from "./model.ts";

interface Entry {
  /** Positions (oldest first, ascending) at `placedAt`; null until the first answer. */
  idx: number[] | null;
  /** Newest first. */
  ids: readonly string[];
  since?: number;
  placedAt: string;
  askedAt: string;
  /** The newest confirmed version when last answered: the next ask after an append starts after it. */
  newest?: string;
  asking: boolean;
}

const KEEP = 4;

export interface ItemFilter {
  /** The clip's versions as ascending positions in the rows; empty while loading. */
  view(item: string): number[];
  status(item: string): FilterStatus;
  /** Forget everything (a cut switch). */
  clear(): void;
}

export function itemFilter(o: {
  ask: (item: string, opts?: { after?: string }) => Promise<ClipVersions>;
  /** A version's position in the oldest-first rows, or undefined. */
  pos: (id: string) => number | undefined;
  /** Changes when History's versions do (added, confirmed, removed), not when a row is only described. */
  structure: () => string;
  /** The newest confirmed version's id, and whether only versions were added above `id` since (an append). */
  newest: () => string | undefined;
  /** An answer arrived: History's topic fires. */
  changed: () => void;
}): ItemFilter {
  const entries = new Map<string, Entry>();
  let gen = 0;
  const place = (e: Entry) => {
    const idx: number[] = [];
    for (const id of e.ids) {
      const p = o.pos(id);
      if (p !== undefined) idx.push(p);
    }
    e.idx = idx.sort((a, b) => a - b);
    e.placedAt = o.structure();
  };
  const ask = (item: string, e: Entry) => {
    if (e.asking) return;
    e.asking = true;
    e.askedAt = o.structure();
    const newest = o.newest();
    // after an append, only what came after the newest one answered for (when it is still there)
    const after = e.idx && e.newest && o.pos(e.newest) !== undefined && e.since === undefined ? e.newest : undefined;
    const g = gen;
    o.ask(item, after ? { after } : undefined).then(
      (r) => {
        if (g !== gen || entries.get(item) !== e) return;
        e.asking = false;
        e.ids = after ? [...r.ids.filter((id) => !e.ids.includes(id)), ...e.ids] : r.ids;
        if (!after) {
          if (r.since !== undefined) e.since = r.since;
          else delete e.since;
        }
        e.newest = newest;
        place(e);
        o.changed();
      },
      () => {
        if (g !== gen || entries.get(item) !== e) return;
        e.asking = false;
        if (!e.idx) e.idx = [];
        o.changed();
      },
    );
  };
  const entry = (item: string): Entry => {
    let e = entries.get(item);
    if (!e) {
      e = { idx: null, ids: [], placedAt: "", askedAt: "", asking: false };
      entries.set(item, e);
      if (entries.size > KEEP) entries.delete(entries.keys().next().value!);
      ask(item, e);
    } else {
      // most recently used last
      entries.delete(item);
      entries.set(item, e);
      const now = o.structure();
      if (e.askedAt !== now) ask(item, e);
      if (e.idx && e.placedAt !== now) place(e);
    }
    return e;
  };
  return {
    view: (item) => entry(item).idx ?? [],
    status: (item) => {
      const e = entry(item);
      return { loading: e.idx === null, ...(e.since !== undefined ? { since: e.since } : {}) };
    },
    clear: () => {
      gen++;
      entries.clear();
    },
  };
}
