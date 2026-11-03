// What every place that shows cuts shares (UX redesign PLAN 6.1, 2.2; DESIGN §4.1, §6.3):
// - one colour dot per cut but Main, the same in the title bar's chip, the cuts menu and the History cut bar;
// - how a sentence names a cut (Main cut bare, any other in curly quotes);
// - the cut you came from while you look at a teammate's cut (where ✕ and "New cut from your edit" go);
// - the switch that waits for an agent's turn to end ("Switch when it finishes"), queued per view model, so it outlives
//   the menu that asked for it;
// - openCutsMenu(): the call that opens the cuts menu from elsewhere (the title bar's cut chip, PLAN 2.2 version 1).
//
// None of it renders: the components read it, and a host can call it.

import { actorColor } from "./actors.ts";
import { clockOfDay, shortDate } from "./format.ts";
import type { Actor, CartonUi, Cut } from "./model.ts";

const MIN = 60_000, HOUR = 60 * MIN;

/**
 * A moment in a short list (the cuts menu's "Director · 2 h ago", the Fold dialog's rows): "now", "4 min ago", "2 h
 * ago", then the clock today ("11:02 am"), "yesterday", or the day ("Oct 30"). Never a bare H:MM.
 */
export function briefWhen(at: number, now: number, w: { now: string; yesterdayShort: string }, locale?: string): string {
  const d = now - at;
  if (d < MIN) return w.now;
  if (d < HOUR) return `${Math.floor(d / MIN)} min ago`;
  const day = (t: number) => new Date(t).setHours(0, 0, 0, 0);
  const today = day(now), then = day(at);
  if (then === today) return d < 6 * HOUR ? `${Math.floor(d / HOUR)} h ago` : clockOfDay(at, locale);
  if (then === day(today - 1)) return w.yesterdayShort;
  return shortDate(at, locale);
}

/** The cut dots, in the order cuts are given them: amber and cyan first, as the mockups; none reads as a clip colour. */
export const CUT_COLORS: readonly string[] = ["#f59e0b", "#22d3ee", "#a78bfa", "#f472b6", "#a3e635", "#fb923c", "#38bdf8", "#34d399"];

/** Main cut: the one cut with no dot (a teammate's Main cut is theirs, and has one). */
export const isMainCut = (c: Pick<Cut, "kind" | "readOnly">): boolean => c.kind === "main" && !c.readOnly;

function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

/**
 * A cut's colour dot, or undefined for Main cut: the view model's (`Cut.color`), else a teammate's cut its owner's
 * colour, else one from its id (stable across pages and computers).
 */
export function cutColor(c: Cut): string | undefined {
  if (isMainCut(c)) return undefined;
  if (c.color) return c.color;
  if (c.readOnly && c.owner) return actorColor(c.owner);
  return CUT_COLORS[hash(c.id) % CUT_COLORS.length];
}

/**
 * Colours for a project's cuts, for a view model to put on `Cut.color`: your own cuts but Main take the palette in the
 * order given (creation order), so the first eight never share one; a teammate's cut takes its owner's colour.
 * `owner(c)`: the owner as an actor, when the cut is a teammate's.
 */
export function cutColors(cuts: readonly Pick<Cut, "id" | "kind" | "readOnly">[], owner?: (id: string) => Actor | undefined): Map<string, string> {
  const out = new Map<string, string>();
  let n = 0;
  for (const c of cuts) {
    if (isMainCut(c)) continue;
    const who = c.readOnly ? owner?.(c.id) : undefined;
    out.set(c.id, who ? actorColor(who) : CUT_COLORS[n++ % CUT_COLORS.length]!);
  }
  return out;
}

/** A cut as a sentence names it (DESIGN §8): "Main cut" bare, any other in curly quotes ("“30s Instagram cut”"). */
export const cutRef = (c: Pick<Cut, "kind" | "readOnly" | "label">): string => (isMainCut(c) ? c.label : `“${c.label}”`);

// ------------------------------------------------------------------ the cut you came from

const homes = new WeakMap<CartonUi, string>();

/** Remember the cut the person is leaving to look at a teammate's (read-only) cut. */
export function rememberHome(ui: CartonUi, cutId: string): void {
  homes.set(ui, cutId);
}

/**
 * Your own cut: the current one, or while a teammate's (read-only) cut is shown, the one you came from (else Main
 * cut). "New cut from your edit", Fold's "into" and ✕ go there.
 */
export function homeCut(ui: CartonUi, cuts: readonly Cut[] = ui.cuts()): Cut | undefined {
  const current = cuts.find((c) => c.current);
  if (current && !current.readOnly) return current;
  const id = homes.get(ui);
  return cuts.find((c) => c.id === id && !c.readOnly) ?? cuts.find((c) => isMainCut(c)) ?? cuts.find((c) => !c.readOnly);
}

// ------------------------------------------------------------------ the switch that waits for a turn (PLAN 6.1)

/** A switch waiting for an agent's turn to end. */
export interface QueuedSwitch {
  readonly cutId: string;
  /** The agent whose turn it waits for. */
  readonly agent: Actor;
}

interface Queue {
  pending: QueuedSwitch | null;
  /** Why the last queued switch didn't happen, in the words the app gave ("" for none); cleared by the next queue or cancel. */
  error: string | null;
  subs: Set<() => void>;
  off: (() => void) | null;
}
const queues = new WeakMap<CartonUi, Queue>();
const queueOf = (ui: CartonUi): Queue => {
  let q = queues.get(ui);
  if (!q) queues.set(ui, (q = { pending: null, error: null, subs: new Set(), off: null }));
  return q;
};
const tell = (q: Queue) => {
  for (const f of [...q.subs]) f();
};
const currentId = (ui: CartonUi) => ui.cuts().find((c) => c.current)?.id;

/** The switch waiting for a turn, or null. The same object until it changes (useSyncExternalStore). */
export const queuedSwitch = (ui: CartonUi): QueuedSwitch | null => queues.get(ui)?.pending ?? null;
/** Why the last queued switch failed, or null. */
export const queuedSwitchError = (ui: CartonUi): string | null => queues.get(ui)?.error ?? null;

/** Be told when the queued switch changes (queued, run, dropped, failed). */
export function subscribeQueuedSwitch(ui: CartonUi, fn: () => void): () => void {
  const q = queueOf(ui);
  q.subs.add(fn);
  return () => void q.subs.delete(fn);
}

/** Forget why the last queued switch failed (the menu's next action says its own). */
export function dismissQueuedSwitchError(ui: CartonUi): void {
  const q = queues.get(ui);
  if (!q || q.error === null) return;
  q.error = null;
  tell(q);
}

/** Drop the queued switch, if any. Every switch this page makes by hand calls it first. */
export function cancelQueuedSwitch(ui: CartonUi): void {
  const q = queues.get(ui);
  if (!q || (!q.pending && !q.error)) return;
  q.off?.();
  q.off = null;
  q.pending = null;
  q.error = null;
  tell(q);
}

/**
 * "Switch when it finishes" (DESIGN §6.3): switch to `cutId` once the agent's turn that holds the timeline now ends, so
 * its next edits stay on the cut it works on. It runs once. It is dropped if the person (or `cb cut switch`) changes the
 * cut first, or queues another. With no agent working, it switches now. Resolves when queued (or switched).
 */
export async function switchWhenDone(ui: CartonUi, cutId: string): Promise<void> {
  const turn = ui.working();
  if (!turn) return ui.switchCut(cutId);
  const q = queueOf(ui);
  q.off?.();
  const from = currentId(ui);
  const run = () => {
    if (q.pending?.cutId !== cutId) return;
    q.off?.();
    q.off = null;
    q.pending = null;
    tell(q);
    // the cut may have changed where this page hasn't heard yet: the view model checks it where it's known (onlyFrom)
    if (currentId(ui) !== from) return;
    ui.switchCut(cutId, from !== undefined ? { onlyFrom: from } : undefined).catch((e: unknown) => {
      // "" when the app gave no words: the menu says its own
      q.error = e instanceof Error ? e.message : "";
      tell(q);
    });
  };
  // the turn ends when nothing works any more, or another turn holds the timeline in its place
  const offWorking = ui.subscribe("working", () => {
    const w = ui.working();
    if (!w || w.actor.key !== turn.actor.key || w.since !== turn.since) run();
  });
  // a switch by hand first wins: the queued one is dropped (a commit moving the head changes no current cut)
  const offCuts = ui.subscribe("cuts", () => {
    if (q.pending && currentId(ui) !== from) cancelQueuedSwitch(ui);
  });
  q.off = () => {
    offWorking();
    offCuts();
  };
  q.pending = { cutId, agent: turn.actor };
  q.error = null;
  tell(q);
}

// ------------------------------------------------------------------ opening the menu from elsewhere (PLAN 2.2)

interface Opener {
  open: () => void;
}
const openers = new WeakMap<CartonUi, Opener[]>();
const waiting = new WeakMap<CartonUi, { resolve: (opened: boolean) => void; timer: ReturnType<typeof setTimeout> }>();

/**
 * Open the cuts menu of this view model and put focus in it (the title bar's cut chip, PLAN 2.2 version 1: the host
 * opens History, then calls this). The newest mounted CutsMenu opens; if none is mounted yet (History is still
 * opening), the next one to mount within `within` ms (2000) opens itself. Resolves true once a menu opened, false if
 * none did in time.
 */
export function openCutsMenu(ui: CartonUi, opts: { within?: number } = {}): Promise<boolean> {
  const list = openers.get(ui);
  const newest = list?.[list.length - 1];
  if (newest) {
    newest.open();
    return Promise.resolve(true);
  }
  waiting.get(ui)?.resolve(false);
  return new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => {
      if (waiting.get(ui)?.timer === timer) waiting.delete(ui);
      resolve(false);
    }, opts.within ?? 2000);
    (timer as { unref?: () => void }).unref?.();
    waiting.set(ui, {
      resolve: (opened) => {
        clearTimeout(timer);
        waiting.delete(ui);
        resolve(opened);
      },
      timer,
    });
  });
}

/** A CutsMenu says it can be opened (internal: CutsMenu calls it once mounted). A request waiting for one opens it. */
export function registerCutsMenu(ui: CartonUi, open: () => void): () => void {
  const o: Opener = { open };
  const list = openers.get(ui) ?? [];
  list.push(o);
  openers.set(ui, list);
  const w = waiting.get(ui);
  if (w) {
    open();
    w.resolve(true);
  }
  return () => {
    const l = openers.get(ui);
    const i = l?.indexOf(o) ?? -1;
    if (l && i >= 0) l.splice(i, 1);
  };
}
