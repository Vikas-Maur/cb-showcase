// History's search (docs/carton-ux/v2 DESIGN-V2 §2.3): one field under the cut bar, "Find a clip, a word, a person…".
// It finds versions by clip names, title and caption text, agents' requests, version names and people (the engine's
// `find`, Carton UX v2 N0), newest first; History then lists only them, as ordinary rows, each saying why it matched.
//
// Typing never waits for a search: the field keeps its own text (a key re-renders the field alone), and the search
// runs from the second letter, 90 ms after the last key, the newest answer winning (an older one that comes back late
// is dropped). An empty field warms the engine's index when it gets focus, so the first search is quick.

import { createElement as h, Fragment, forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { useCartonUi, useWords } from "../hooks.ts";
import { Icon } from "../icons.ts";
import type { FindHit, FindHits } from "../model.ts";

/** How long after the last key a search starts (ms). */
export const FIND_DEBOUNCE_MS = 90;
/** At most this many versions are listed (the engine counts the rest: `total`). */
export const FIND_LIMIT = 200;

/** What a search found: the query it answers, its hits by row id, and how many matched in all. */
export interface Found {
  readonly q: string;
  readonly status: "idle" | "loading" | "ready" | "error";
  readonly hits: readonly FindHit[];
  readonly byId: ReadonlyMap<string, FindHit>;
  readonly total: number;
}
const IDLE: Found = { q: "", status: "idle", hits: [], byId: new Map(), total: 0 };

/** A query worth searching: from the second letter (DESIGN-V2 §2.3). */
export const searchable = (q: string) => q.trim().length >= 2;

/** Search the current cut's History for `q` (already debounced by the field), the newest answer winning. */
export function useFind(q: string, cutId: string | undefined): Found {
  const ui = useCartonUi();
  const [found, setFound] = useState<Found>(IDLE);
  const seq = useRef(0);
  useEffect(() => {
    const mine = ++seq.current;
    if (!searchable(q) || typeof ui.find !== "function") {
      setFound(IDLE);
      return;
    }
    setFound((f) => ({ ...f, q, status: "loading" }));
    ui.find(q.trim(), { limit: FIND_LIMIT }).then(
      (r: FindHits) => {
        if (mine !== seq.current) return;
        const byId = new Map<string, FindHit>();
        for (const x of r.hits) if (!byId.has(x.versionId)) byId.set(x.versionId, x);
        setFound({ q, status: "ready", hits: r.hits, byId, total: r.total });
      },
      () => mine === seq.current && setFound({ ...IDLE, q, status: "error" }),
    );
  }, [ui, q, cutId]);
  return found;
}

export interface SearchBoxHandle {
  focus(): void;
  clear(): void;
}

/**
 * The field. `onQuery` gets the text 90 ms after the last key (at once when it's cleared). Esc clears it; Esc in an
 * empty field goes on to the panel (a second Esc closes History, as before). ↓ goes to the list.
 */
export const SearchBox = forwardRef<SearchBoxHandle, { onQuery: (q: string) => void; onDown?: () => void; trailing?: ReactNode }>(function SearchBox(p, ref) {
  const ui = useCartonUi();
  const words = useWords();
  const [value, setValue] = useState("");
  const input = useRef<HTMLInputElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const onQuery = useRef(p.onQuery);
  onQuery.current = p.onQuery;
  const send = useCallback((q: string, now = false) => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    if (now) onQuery.current(q);
    else timer.current = setTimeout(() => ((timer.current = null), onQuery.current(q)), FIND_DEBOUNCE_MS);
  }, []);
  useEffect(() => () => void (timer.current && clearTimeout(timer.current)), []);
  const clear = useCallback(() => {
    setValue("");
    send("", true);
  }, [send]);
  useImperativeHandle(ref, () => ({ focus: () => input.current?.focus({ preventScroll: true }), clear }), [clear]);
  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Escape" && value) {
      e.preventDefault();
      e.stopPropagation();
      clear();
    } else if (e.key === "ArrowDown" && p.onDown) {
      e.preventDefault();
      p.onDown();
    } else if (e.key === "Enter") {
      e.preventDefault();
      send(value, true);
    }
  };
  return h(
    "div",
    { className: "carton-search", role: "search", "data-filled": value ? "" : undefined },
    h(Icon, { name: "search", size: 14, className: "carton-search-icon" }),
    h("input", {
      ref: input,
      className: "carton-search-input",
      type: "text",
      value,
      placeholder: words.findPlaceholder,
      "aria-label": words.findLabel,
      spellCheck: false,
      autoComplete: "off",
      onFocus: () => {
        // warm the index: the first search is then quick (the engine builds it once per cut)
        if (!value && typeof ui.find === "function") void ui.find("").catch(() => {});
      },
      onChange: (e: { currentTarget: HTMLInputElement }) => {
        const q = e.currentTarget.value;
        setValue(q);
        send(q, !q);
      },
      onKeyDown,
    }),
    value ? h("button", { type: "button", className: "carton-search-x", "aria-label": words.clearFind, "data-carton-tip": words.clearFind, onClick: () => (clear(), input.current?.focus({ preventScroll: true })) }, h(Icon, { name: "x", size: 11 })) : null,
    p.trailing ?? null,
  );
});

const fold = (s: string) => s.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();

/**
 * `text` with the query's words marked where a word of it starts with one (any case, accents ignored), as the search
 * matches them: "intr cap" marks "Intr" and "cap" in "Add captions to the intro".
 */
export function highlight(text: string, q: string): ReactNode {
  const tokens = fold(q).split(/\s+/).filter((t) => t.length >= 1);
  if (!tokens.length || !text) return text;
  // folding keeps one character per character for the letters people type (accents are separate marks, dropped one
  // by one): map folded positions back by folding each character on its own
  const map: number[] = [];
  let low = "";
  for (let i = 0; i < text.length; i++) {
    const f = fold(text[i]!);
    for (let k = 0; k < f.length; k++) map.push(i);
    low += f;
  }
  map.push(text.length);
  const ranges: [number, number][] = [];
  for (const t of tokens) {
    let from = 0;
    for (;;) {
      const at = low.indexOf(t, from);
      if (at < 0) break;
      const start = at === 0 || !/[\p{L}\p{N}]/u.test(low[at - 1]!);
      if (start) ranges.push([map[at]!, map[at + t.length] ?? text.length]);
      from = at + 1;
    }
  }
  if (!ranges.length) return text;
  ranges.sort((a, b) => a[0] - b[0]);
  const out: ReactNode[] = [];
  let pos = 0;
  for (const [a0, b0] of ranges) {
    const a = Math.max(a0, pos);
    if (b0 <= a) continue;
    if (a > pos) out.push(text.slice(pos, a));
    out.push(h("mark", { key: a, className: "carton-hit" }, text.slice(a, b0)));
    pos = b0;
  }
  if (pos < text.length) out.push(text.slice(pos));
  return h(Fragment, null, ...out);
}

/** A hit's own snippet with its match marked (`FindHit.hit`, [lo, hi) in UTF-16). */
export function snippetOf(x: FindHit): ReactNode {
  const [lo, hi] = x.hit;
  if (!(hi > lo) || lo < 0 || hi > x.snippet.length) return x.snippet;
  return h(Fragment, null, x.snippet.slice(0, lo), h("mark", { className: "carton-hit" }, x.snippet.slice(lo, hi)), x.snippet.slice(hi));
}
