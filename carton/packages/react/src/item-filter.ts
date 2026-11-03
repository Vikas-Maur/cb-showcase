// History's "Only “clip”" filter (PLAN 0.8) over any HistorySource: the versions that touched one clip, read from
// the view model's per-version index (`clipVersions`, async) and kept as positions in History's oldest-first rows. A
// filter read before its answer counts 0 and says it's loading; the answer fires History's topic. After History
// changes, the next read asks again in the background (a new version may touch the clip) and keeps the last answer
// meanwhile, its ids placed again at the rows' current positions. A few clips are kept.

import type { ClipVersions, FilterStatus } from "./model.ts";

interface Entry {
  /** Positions (oldest first, ascending) at `placedAt`; null until the first answer. */
  idx: number[] | null;
  ids: readonly string[];
  since?: number;
  placedAt: number;
  askedAt: number;
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
  ask: (item: string) => Promise<ClipVersions>;
  /** A version's position in the oldest-first rows, or undefined. */
  pos: (id: string) => number | undefined;
  revision: () => number;
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
    e.placedAt = o.revision();
  };
  const ask = (item: string, e: Entry) => {
    if (e.asking) return;
    e.asking = true;
    e.askedAt = o.revision();
    const g = gen;
    o.ask(item).then(
      (r) => {
        if (g !== gen || entries.get(item) !== e) return;
        e.asking = false;
        e.ids = r.ids;
        if (r.since !== undefined) e.since = r.since;
        else delete e.since;
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
      e = { idx: null, ids: [], placedAt: -1, askedAt: -1, asking: false };
      entries.set(item, e);
      if (entries.size > KEEP) entries.delete(entries.keys().next().value!);
      ask(item, e);
    } else {
      // most recently used last
      entries.delete(item);
      entries.set(item, e);
      const rev = o.revision();
      if (e.askedAt !== rev) ask(item, e);
      if (e.idx && e.placedAt !== rev) place(e);
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
