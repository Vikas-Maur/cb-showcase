// Someone else's versions arriving while History is open (a teammate's, or a teammate's agent's): History outlines
// their rows in that person's colour, so another presence doing something reads at a glance (HistoryPanel's
// ArrivalRing). Yours and your agents' (`isYou`) never count, nor what was there when History opened, nor a list that
// was loaded or swapped (another cut, a reload): only versions that join the cut you watch while you watch it.
//
// Linear in what arrived, never in History: each step walks back from the newest confirmed version to the one it saw
// last. Versions arrive at the newer end of the confirmed ones (remote.ts and from-carton.ts insert a confirmed version
// before the provisional rows still waiting; the mock appends): a step that doesn't find the one it saw last within
// ARRIVAL_BURST confirmed versions was another list, and starts watching that one as it is.

import type { Actor, Version } from "./model.ts";

/** More confirmed versions than this new in one step: another list (a cut switched to, a reload), not arrivals. */
export const ARRIVAL_BURST = 40;
/** How many arrivals History keeps marks for (the newest): the faint edge of older ones goes. */
export const ARRIVALS_KEPT = 400;
/**
 * An arrival this soon after the one before is part of a burst (a teammate's agent at work, a catch-up): its ring shows
 * and settles without motion, so a busy project costs no animation (the bench's live cell: 50 a second). One that comes
 * after a quiet moment, as the demo's title does, fades in and settles softly.
 */
export const ARRIVAL_CALM_MS = 2000;

/** Someone other than you and your own agents: a teammate, or a teammate's agent. The system is no one. */
export const isSomeoneElse = (a: Actor): boolean => a.kind !== "system" && !a.isYou;

export interface ArrivalState {
  /** What it watches: the history source and the cut. */
  readonly source: unknown;
  readonly cut: string | undefined;
  /** The newest confirmed version it saw, or null while there is none (History loading, empty). */
  readonly last: string | null;
  /** The History revision it last read. */
  readonly rev: number;
  /** Someone else's versions that arrived while it watched, by id: when they did (ms since the epoch), oldest first. */
  readonly at: ReadonlyMap<string, number>;
  /** The ones this step added, newest first. */
  readonly added: readonly Version[];
  /** Of `at`, the ones that came in a burst (ARRIVAL_CALM_MS after the arrival before): drawn without motion. */
  readonly busy: ReadonlySet<string>;
  /** When the last arrival was (ms since the epoch), or null. */
  readonly lastAt: number | null;
}

const NONE: ReadonlyMap<string, number> = new Map();
const NO_IDS: ReadonlySet<string> = new Set();
const NO_VERSIONS: readonly Version[] = [];

/**
 * The next state, from History's versions now (oldest first, as HistorySource.all() gives them). Returns `s` itself
 * when nothing moved (the same revision of the same source and cut), so a caller can memoize on it.
 */
export function nextArrivals(
  s: ArrivalState | null,
  all: readonly Version[],
  o: { readonly source: unknown; readonly cut: string | undefined; readonly rev: number; readonly loading?: boolean; readonly now: number },
): ArrivalState {
  if (s && s.rev === o.rev && s.source === o.source && s.cut === o.cut) return s;
  const same = !!s && s.source === o.source && s.cut === o.cut;
  // another cut or source: its own arrivals only, from when it is seen
  const at = same ? s!.at : NONE, busy = same ? s!.busy : NO_IDS, lastAt = same ? s!.lastAt : null;
  let top = all.length - 1;
  while (top >= 0 && all[top]!.provisional) top--;
  const newest = !o.loading && top >= 0 ? all[top]!.id : null;
  const state = (last: string | null, map = at, added = NO_VERSIONS, b = busy, when = lastAt): ArrivalState => ({ source: o.source, cut: o.cut, last, rev: o.rev, at: map, added, busy: b, lastAt: when });
  // not watching yet (History still loading, or nothing confirmed), or the first look: what is there now was there
  if (!newest || !same || s!.last === null) return state(newest);
  if (newest === s!.last) return state(newest);
  const added: Version[] = [];
  let found = false;
  for (let i = top, seen = 0; i >= 0; i--) {
    const v = all[i]!;
    if (v.provisional) continue;
    if (v.id === s!.last) {
      found = true;
      break;
    }
    if (++seen > ARRIVAL_BURST) break;
    if (isSomeoneElse(v.author) && !at.has(v.id)) added.push(v);
  }
  // (the one seen last is gone: another list, watched from now on as it is)
  if (!found || !added.length) return state(newest);
  const next = new Map(at);
  for (let i = added.length - 1; i >= 0; i--) next.set(added[i]!.id, o.now);
  // (a burst: soon after the arrival before; its marks are kept as long as theirs)
  const burst = lastAt !== null && o.now - lastAt < ARRIVAL_CALM_MS;
  const nextBusy = new Set(busy);
  if (burst) for (const v of added) nextBusy.add(v.id);
  for (const id of next.keys()) {
    if (next.size <= ARRIVALS_KEPT) break;
    next.delete(id);
    nextBusy.delete(id);
  }
  return state(newest, next, added, nextBusy, o.now);
}
