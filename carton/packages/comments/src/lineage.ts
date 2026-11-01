// Split lineage between two versions, for following a commented clip through a split whose second piece got a new id
// (`{c: ["c", "c-b"]}`, recorded on the split's change as `intent.lineage`).
//
// A Carton that offers `lineage(from, to)` (requested from foundation-core: History holds every row in memory) is
// asked directly. Otherwise the changes along the path are read from the project's store (core's `changes` table,
// `[cutId, seq] -> ConfirmedChange`): the cut's own rows, and up its fork chain for a cut forked after the comment was
// made. Each cut's rows are scanned once, in pages, and only rows that carry lineage are kept, so the next call (the
// head moved) reads only the new rows. A path this can't walk (the comment's cut is not an ancestor of the target:
// a fold, a teammate's cut) answers null, and the anchor falls back to ids and media.

import { composeLineage, STORE_TABLES, type CutRecord, type Lineage, type Store } from "@carton/core";

export interface VersionAt {
  cut: string;
  seq: number;
}

export interface LineageSource {
  /** The split lineage from `from` to `to` (each item id to the ids it became), or null when there is no known path. */
  lineage(from: VersionAt, to: VersionAt): Promise<Lineage | null>;
}

/** What `cartonLineage` needs of a Carton (and a Carton that has the requested `lineage` method). */
export interface LineageCarton {
  readonly store: Store;
  cuts(): Promise<CutRecord[]>;
  lineage?(from: VersionAt, to: VersionAt): Promise<Lineage | null>;
}

interface CutScan {
  /** Rows read through this seq. */
  through: number;
  /** Rows that carry lineage, by seq (ascending). */
  rows: { seq: number; lineage: Lineage }[];
  reading?: Promise<void>;
}

const PAGE = 256;
const MAX_FORK_DEPTH = 32;

/** Lineage from a Carton (its own method when it has one, else its store's change rows). */
export function cartonLineage(carton: LineageCarton): LineageSource {
  if (typeof carton.lineage === "function") return { lineage: (from, to) => carton.lineage!(from, to) };
  const scans = new Map<string, CutScan>();

  async function scanTo(cut: string, seq: number): Promise<CutScan> {
    let sc = scans.get(cut);
    if (!sc) scans.set(cut, (sc = { through: 0, rows: [] }));
    while (sc.through < seq) {
      if (sc.reading) {
        await sc.reading;
        continue;
      }
      const s = sc;
      s.reading = (async () => {
        const page = await carton.store.range<{ seq?: number; intent?: { lineage?: Lineage } | null }>(STORE_TABLES.changes, { prefix: [cut], gt: [cut, s.through], limit: PAGE });
        for (const { key, value } of page) {
          const n = key[1] as number;
          const l = value?.intent?.lineage;
          if (l && Object.keys(l).length) s.rows.push({ seq: n, lineage: l });
        }
        // past the stored rows (a joiner's keyframe gap, or the head itself): nothing more to read for now
        s.through = page.length < PAGE ? Math.max(s.through, seq) : (page[page.length - 1]!.key[1] as number);
      })().finally(() => (s.reading = undefined));
      await s.reading;
    }
    return sc;
  }

  return {
    async lineage(from, to) {
      // the path from `to` back up its fork chain to `from`'s cut: (cut, after, through] segments, newest first
      const cuts = new Map((await carton.cuts()).map((c) => [c.id, c]));
      const segs: { cut: string; lo: number; hi: number }[] = [];
      let cur = to.cut,
        hi = to.seq;
      for (let depth = 0; ; depth++) {
        if (depth > MAX_FORK_DEPTH) return null;
        if (cur === from.cut) {
          if (from.seq > hi) return null;
          segs.push({ cut: cur, lo: from.seq, hi });
          break;
        }
        segs.push({ cut: cur, lo: 0, hi });
        const fork = cuts.get(cur)?.forkOf;
        if (!fork) return null;
        const at = fork.lastIndexOf("@");
        const n = Number(fork.slice(at + 1));
        if (at <= 0 || !Number.isInteger(n)) return null;
        cur = fork.slice(0, at);
        hi = n;
      }
      const parts: Lineage[] = [];
      for (const sg of segs.reverse()) {
        if (sg.hi <= sg.lo) continue;
        const sc = await scanTo(sg.cut, sg.hi);
        for (const r of sc.rows) if (r.seq > sg.lo && r.seq <= sg.hi) parts.push(r.lineage);
      }
      return parts.length ? composeLineage(...parts) : {};
    },
  };
}
