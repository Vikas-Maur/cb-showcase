// History grouped by day (UI audit P2-17: 150+ versions were a flat wall of rows that all said "18 min ago"). Each day
// gets a header with its count; a folded day still shows its named versions, so they work as anchors through a long
// History (turn checkpoints come every few minutes while agents work: the "turns" filter lists them). Pure, and linear in the number of versions: the day of a version is worked out once
// per version object (versions never change once shown), so a new version arriving costs one more, not 10k more.

//
// With `group` (PLAN 0.4, DESIGN §6.1), a person's run of plain edits becomes one row ("You · 6 changes ›"), and the
// start of History (the cut's start, the project's history start, the import) one "Project created" row at the
// bottom. The newest row is flagged `now`.

import type { Actor, Version } from "./model.ts";

export type HistoryRow =
  | { readonly kind: "day"; readonly key: string; readonly day: number; readonly count: number; readonly collapsed: boolean; readonly hidden: number }
  | {
      readonly kind: "version";
      readonly key: string;
      readonly id: string;
      /** Its index under the "all" filter, newest first. */
      readonly index: number;
      /** The newest row: its time reads "Now". */
      readonly now?: true;
      /** One of an open group's versions, listed under it (32 px, indented). */
      readonly child?: true;
      /** An agent turn's row: the turn's earlier versions (newest first), shown as this one row (`Version.run`). */
      readonly turn?: readonly string[];
    }
  | {
      /** Consecutive plain edits by one person, at most GROUP_GAP_MS apart, nothing named or an agent's between them. */
      readonly kind: "group";
      /**
       * `group:<oldest id>`: stable while the group grows at its newer end, as it does while the person goes on editing
       * (review of feat/ux-3-history #7: keyed by its newest, each new edit made a new row, and the list scrolled back
       * to it as the row the keyboard was on).
       */
      readonly key: string;
      /** The newest version's id and index: the row shows its sentence. */
      readonly id: string;
      readonly index: number;
      /** Every version in it, newest first. */
      readonly ids: readonly string[];
      readonly author: Actor;
      /** How many changes: the sum of its versions' `changes` once all are known, else how many versions. */
      readonly count: number;
      /** Its versions are listed under it (`child` rows). */
      readonly open: boolean;
      readonly now?: true;
    }
  | {
      /** The start of History, one row: "Project created", or "History starts here" for an imported project. No menu. */
      readonly kind: "start";
      readonly key: "start";
      /** The oldest start version's id and index. */
      readonly id: string;
      readonly index: number;
      readonly ids: readonly string[];
      readonly at: number;
      readonly imported: boolean;
    };

/** Two edits further apart than this start a new group (DESIGN §6.1). */
export const GROUP_GAP_MS = 10 * 60_000;

export interface GroupOptions {
  /** Group a person's runs of edits and merge the start rows (PLAN 0.4). Default: off (the day groups alone). */
  readonly group?: boolean;
  /** Whether a group (by its key) is open. Default: closed. */
  readonly open?: (key: string) => boolean;
}

/** A version a group can hold: a person's plain edit, not named, not History's start. */
const groupable = (v: Version) => v.kind === "edit" && v.author.kind === "human" && !v.name && !v.start;

/** A day header's height: a compact divider between the 52 px version rows. */
export const DAY_ROW_HEIGHT = 32;
/** With more versions than this, every day but the newest starts collapsed. */
export const COLLAPSE_OVER = 150;

const MS_DAY = 86_400_000;
const days = new WeakMap<Version, number>();
/** The local calendar day of a time, as a day number (consecutive days differ by 1). */
export function dayNumber(at: number): number {
  return Math.floor((at - new Date(at).getTimezoneOffset() * 60_000) / MS_DAY);
}
function dayOf(v: Version): number {
  let d = days.get(v);
  if (d === undefined) days.set(v, (d = dayNumber(v.at)));
  return d;
}
/** A version that stays visible in a folded day: a named one. */
export const isAnchor = (v: Version) => !!v.name;

/** Whether a History is worth grouping: it spans more than one day (one day's versions read best as they are). */
export function spansDays(versions: readonly Version[]): boolean {
  return versions.length > 1 && dayOf(versions[0]!) !== dayOf(versions[versions.length - 1]!);
}

/**
 * The rows of a grouped History, newest first. `versions` is oldest first (HistorySource.all()). `collapsed(day, isNewest)`
 * says whether a day is collapsed. Linear in the number of versions.
 */
export function groupHistory(versions: readonly Version[], collapsed: (day: number, newest: boolean) => boolean, opts: GroupOptions = {}): HistoryRow[] {
  const rows: HistoryRow[] = [];
  const n = versions.length;
  // The start rows: the oldest versions marked `start`, merged into one row at the very bottom
  let starts = 0;
  if (opts.group) while (starts < n && versions[starts]!.start) starts++;
  let i = n - 1;
  let first = true;
  const flag = <R extends HistoryRow>(r: R): R => {
    if (!first || r.kind === "day" || r.kind === "start") return r;
    first = false;
    return { ...r, now: true };
  };
  while (i >= starts) {
    const day = dayOf(versions[i]!);
    let j = i;
    while (j >= starts && dayOf(versions[j]!) === day) j--;
    const shut = collapsed(day, rows.length === 0);
    const at = rows.length;
    rows.push({ kind: "day", key: `day:${day}`, day, count: i - j, collapsed: shut, hidden: 0 });
    let hidden = 0;
    for (let k = i; k > j; k--) {
      const v = versions[k]!;
      if (shut && !isAnchor(v)) {
        hidden++;
        continue;
      }
      // an agent turn's versions (they share `run`): one row, its newest (PLAN 0.4)
      if (opts.group && !shut && v.run) {
        let m = k;
        while (m - 1 > j && versions[m - 1]!.run === v.run) m--;
        const turn: string[] = [];
        for (let q = k - 1; q >= m; q--) turn.push(versions[q]!.id);
        rows.push(flag({ kind: "version", key: v.id, id: v.id, index: n - 1 - k, ...(turn.length ? { turn } : {}) }));
        k = m;
        continue;
      }
      // a person's run: newest first, back while the next older one is theirs, close enough, on this day
      let m = k;
      if (opts.group && !shut && groupable(v))
        while (m - 1 > j && groupable(versions[m - 1]!) && versions[m - 1]!.author.key === v.author.key && versions[m]!.at - versions[m - 1]!.at <= GROUP_GAP_MS) m--;
      if (m === k) {
        rows.push(flag({ kind: "version", key: v.id, id: v.id, index: n - 1 - k }));
        continue;
      }
      const ids: string[] = [];
      let sum = 0, known = true;
      for (let q = k; q >= m; q--) {
        const x = versions[q]!;
        ids.push(x.id);
        if (x.changes === undefined) known = false;
        else sum += x.changes;
      }
      const key = `group:${versions[m]!.id}`;
      const open = !!opts.open?.(key);
      rows.push(flag({ kind: "group", key, id: v.id, index: n - 1 - k, ids, author: v.author, count: known ? sum : ids.length, open }));
      if (open) for (let q = k; q >= m; q--) rows.push({ kind: "version", key: versions[q]!.id, id: versions[q]!.id, index: n - 1 - q, child: true });
      k = m;
    }
    if (hidden) rows[at] = { ...(rows[at] as Extract<HistoryRow, { kind: "day" }>), hidden };
    i = j;
  }
  if (starts) {
    // one row, in its own day (the oldest day's, or a header of its own); a folded day counts it as hidden
    const s0 = versions[0]!, d0 = dayOf(s0);
    let h = rows.length - 1;
    while (h >= 0 && rows[h]!.kind !== "day") h--;
    if (h < 0 || (rows[h] as Extract<HistoryRow, { kind: "day" }>).day !== d0) {
      rows.push({ kind: "day", key: `day:${d0}`, day: d0, count: 0, collapsed: collapsed(d0, rows.length === 0), hidden: 0 });
      h = rows.length - 1;
    }
    const d = rows[h] as Extract<HistoryRow, { kind: "day" }>;
    if (d.collapsed) rows[h] = { ...d, count: d.count + 1, hidden: d.hidden + 1 };
    else {
      rows[h] = { ...d, count: d.count + 1 };
      const ids: string[] = [];
      for (let q = starts - 1; q >= 0; q--) ids.push(versions[q]!.id);
      rows.push({ kind: "start", key: "start", id: s0.id, index: n - 1, ids, at: s0.at, imported: versions.slice(0, starts).some((v) => v.start === "imported") });
    }
  }
  return rows;
}

/** "Today", "Yesterday", else the weekday and date in the person's locale ("Mon, Oct 30"; the year when it isn't this one). */
export function dayLabel(day: number, today: number, locale: string | undefined, words: { today: string; yesterday: string }): string {
  if (day === today) return words.today;
  if (day === today - 1) return words.yesterday;
  const d = new Date(day * MS_DAY + 12 * 3_600_000);
  const sameYear = d.getUTCFullYear() === new Date(today * MS_DAY).getUTCFullYear();
  return new Intl.DateTimeFormat(locale, { weekday: "short", month: "short", day: "numeric", ...(sameYear ? {} : { year: "numeric" }), timeZone: "UTC" }).format(d);
}
