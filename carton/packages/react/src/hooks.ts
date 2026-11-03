// Headless hooks. Each one subscribes to a single topic of the view model and returns a value that keeps its
// identity until that value really changes, so a component re-renders only when what it shows changed.
// Only the public hooks API is used (useSyncExternalStore and friends), so the same code runs on React 18/19 and on
// preact/compat.

import {
  createContext,
  createElement,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import type {
  CartonUi,
  Conflict,
  Cut,
  Ghost,
  HistoryFilter,
  Peer,
  Preview,
  Published,
  SyncStatus,
  Topic,
  UndoTurn,
  Version,
  Viewing,
  Working,
} from "./model.ts";
import { words as defaultWords, type Words } from "./words.ts";

interface Settings {
  words: Words;
  locale: string | undefined;
}

const UiContext = createContext<CartonUi | null>(null);
const SettingsContext = createContext<Settings>({ words: defaultWords, locale: undefined });

export interface CartonProviderProps {
  ui: CartonUi;
  /** Replace the words (another language). Missing keys fall back to the English ones. */
  words?: Partial<Words>;
  locale?: string;
  children?: ReactNode;
}

export function CartonProvider({ ui, words, locale, children }: CartonProviderProps) {
  const settings = useMemo<Settings>(() => ({ words: words ? { ...defaultWords, ...words } : defaultWords, locale }), [words, locale]);
  return createElement(UiContext.Provider, { value: ui }, createElement(SettingsContext.Provider, { value: settings }, children));
}

export function useCartonUi(): CartonUi {
  const ui = useContext(UiContext);
  if (!ui) throw new Error("@carton/react: wrap the components in <CartonProvider ui={…}>");
  return ui;
}

export function useWords(): Words {
  return useContext(SettingsContext).words;
}

export function useLocale(): string | undefined {
  return useContext(SettingsContext).locale;
}

/** Subscribe to one topic and read one value from it. `read` must return the same value while nothing changed. */
export function useTopic<T>(topic: Topic, read: (ui: CartonUi) => T): T {
  const ui = useCartonUi();
  const readRef = useRef(read);
  readRef.current = read;
  const subscribe = useCallback((fn: () => void) => ui.subscribe(topic, fn), [ui, topic]);
  const get = useCallback(() => readRef.current(ui), [ui]);
  return useSyncExternalStore(subscribe, get, get);
}

/**
 * Subscribe to a topic but re-render only when a derived value changes (by `equal`). For example the avatar stack's
 * "+3" chip reads only the number of peers.
 */
export function useTopicSelector<T>(topic: Topic, select: (ui: CartonUi) => T, equal: (a: T, b: T) => boolean = Object.is): T {
  const ui = useCartonUi();
  const cache = useRef<{ value: T } | null>(null);
  const selectRef = useRef(select);
  selectRef.current = select;
  const subscribe = useCallback((fn: () => void) => ui.subscribe(topic, fn), [ui, topic]);
  const get = useCallback(() => {
    const next = selectRef.current(ui);
    if (cache.current && equal(cache.current.value, next)) return cache.current.value;
    cache.current = { value: next };
    return next;
  }, [ui, equal]);
  return useSyncExternalStore(subscribe, get, get);
}

export const useSyncStatus = (): SyncStatus => useTopic("sync", (ui) => ui.sync());
export const useCuts = (): readonly Cut[] => useTopic("cuts", (ui) => ui.cuts());
export const usePeers = (): readonly Peer[] => useTopic("peers", (ui) => ui.peers());
export const useGhosts = (): readonly Ghost[] => useTopic("ghosts", (ui) => ui.ghosts());
export const useConflicts = (): readonly Conflict[] => useTopic("conflicts", (ui) => ui.conflicts());
export const useUndoTurn = (): UndoTurn | null => useTopic("undo", (ui) => ui.undoTurn());
export const usePublished = (): Published | null => useTopic("published", (ui) => ui.published());
export const usePreview = (): Preview | null => useTopic("preview", (ui) => ui.preview());
/** What the editor shows when it isn't your edit (PLAN 0.5): one label for the chip, the frame and the row. */
export const useViewing = (): Viewing | null => useTopic("viewing", (ui) => ui.viewing());
/** An agent working on the timeline (PLAN 0.7), or null. */
export const useWorking = (): Working | null => useTopic("working", (ui) => ui.working());

/** The current cut, whole: re-renders whenever it changes, its head included (every commit moves the head). */
export function useCurrentCut(): Cut | undefined {
  const cuts = useCuts();
  return useMemo(() => cuts.find((c) => c.current), [cuts]);
}

/** The current cut's id only: re-renders on a switch, never when a commit moves the head (U6). */
export const useCurrentCutId = (): string | undefined => useTopicSelector("cuts", (ui) => ui.cuts().find((c) => c.current)?.id);

// What a list of cuts shows (names, which is current, read-only, shared): a commit that only moves a head or its
// time changes none of it, so components that list cuts don't re-render for it.
const sameShownCuts = (a: readonly Cut[], b: readonly Cut[]) =>
  a === b ||
  (a.length === b.length &&
    a.every((x, i) => {
      const y = b[i]!;
      return x.id === y.id && x.label === y.label && x.name === y.name && x.current === y.current && x.readOnly === y.readOnly && x.kind === y.kind && x.shared === y.shared && x.color === y.color;
    }));

/** The cuts as a menu shows them; re-renders only when what it shows changes (not when a head moves). */
export const useShownCuts = (): readonly Cut[] => useTopicSelector("cuts", (ui) => ui.cuts(), sameShownCuts);

const samePublishedShown = (a: Published | null, b: Published | null) =>
  a === b ||
  (!!a && !!b && a.cutId === b.cutId && a.cutName === b.cutName && a.ref === b.ref && a.versionName === b.versionName && a.at === b.at && a.url === b.url && a.newerEdits > 0 === b.newerEdits > 0);

/** The published cut as its status shows it: whether newer edits exist, not how many (U7). */
export const usePublishedShown = (): Published | null => useTopicSelector("published", (ui) => ui.published(), samePublishedShown);

/** How many versions a filter shows. Re-renders only when the number changes. */
export const useHistoryCount = (filter: HistoryFilter): number => useTopic("history", (ui) => ui.history().count(filter));

/** One version by index (0 = newest). */
export const useVersionAt = (filter: HistoryFilter, index: number): Version | undefined =>
  useTopic("history", (ui) => ui.history().at(filter, index));

// One shared minute ticker for relative times ("4 min ago"): every visible row reads the same `now`, and the rows
// re-render once a minute, not on every tick of their own timer.
const tick = { now: Date.now(), subs: new Set<() => void>(), timer: null as ReturnType<typeof setInterval> | null };
function subscribeNow(fn: () => void) {
  tick.subs.add(fn);
  if (!tick.timer) {
    tick.now = Date.now();
    tick.timer = setInterval(() => {
      tick.now = Date.now();
      for (const s of [...tick.subs]) s();
    }, 60_000);
    // In Node (tests, server rendering) a UI clock must never keep the process alive.
    (tick.timer as { unref?: () => void }).unref?.();
  }
  return () => {
    tick.subs.delete(fn);
    if (!tick.subs.size && tick.timer) {
      clearInterval(tick.timer);
      tick.timer = null;
    }
  };
}
const getNow = () => tick.now;

/** The current time, updated once a minute. */
export function useNow(): number {
  return useSyncExternalStore(subscribeNow, getNow, getNow);
}

export type AsyncState<T> =
  | { readonly status: "loading"; readonly value?: undefined; readonly error?: undefined }
  | { readonly status: "ready"; readonly value: T; readonly error?: undefined }
  | { readonly status: "error"; readonly value?: undefined; readonly error: unknown };

/** Run an async read (compare, credits, shot diff, fold plan) and re-run it when `deps` change. */
export function useAsync<T>(run: () => Promise<T>, deps: readonly unknown[]): AsyncState<T> & { reload: () => void } {
  const [state, setState] = useState<AsyncState<T>>({ status: "loading" });
  const [nonce, setNonce] = useState(0);
  useEffect(() => {
    let live = true;
    setState({ status: "loading" });
    run().then(
      (value) => live && setState({ status: "ready", value }),
      (error) => live && setState({ status: "error", error }),
    );
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, nonce]);
  const reload = useCallback(() => setNonce((n) => n + 1), []);
  return { ...state, reload };
}

/** Wrap an action so the caller can show it is running and disable a second click. */
export function useAction<A extends unknown[], R>(fn: (...args: A) => Promise<R>): [(...args: A) => Promise<R | undefined>, boolean, unknown] {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const live = useRef(true);
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);
  const run = useCallback(
    async (...args: A) => {
      setBusy(true);
      setError(null);
      try {
        return await fn(...args);
      } catch (e) {
        if (live.current) setError(e);
        return undefined;
      } finally {
        if (live.current) setBusy(false);
      }
    },
    [fn],
  );
  return [run, busy, error];
}
