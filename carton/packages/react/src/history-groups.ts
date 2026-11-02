// History grouped by day (UI audit P2-17: 150+ versions were a flat wall of rows that all said "18 min ago"). Each day
// gets a header with its count; a folded day still shows its named versions, so they work as anchors through a long
// History (turn checkpoints come every few minutes while agents work: the "turns" filter lists them). Pure, and linear in the number of versions: the day of a version is worked out once
// per version object (versions never change once shown), so a new version arriving costs one more, not 10k more.

import type { Version } from "./model.ts";

export type HistoryRow =
  | { readonly kind: "day"; readonly key: string; readonly day: number; readonly count: number; readonly collapsed: boolean; readonly hidden: number }
  | { readonly kind: "version"; readonly key: string; readonly id: string; /** Its index under the "all" filter, newest first. */ readonly index: number };

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
 * says whether a day is collapsed.
 */
export function groupHistory(versions: readonly Version[], collapsed: (day: number, newest: boolean) => boolean): HistoryRow[] {
  const rows: HistoryRow[] = [];
  const n = versions.length;
  let i = n - 1;
  while (i >= 0) {
    const day = dayOf(versions[i]!);
    let j = i;
    while (j >= 0 && dayOf(versions[j]!) === day) j--;
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
      rows.push({ kind: "version", key: v.id, id: v.id, index: n - 1 - k });
    }
    if (hidden) rows[at] = { ...(rows[at] as Extract<HistoryRow, { kind: "day" }>), hidden };
    i = j;
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
