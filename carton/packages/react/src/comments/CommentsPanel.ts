// The Comments panel (PLAN §9, C6): threads pinned to moments of the edit, each saying where it sits on the version
// shown ("Moved", "May be outdated", "Clip removed"), with replies, resolve and reopen, and edit and delete for one's
// own. Unstyled; the look comes from the skin (comments/skin.ts). Works under preact/compat: public hooks only.
//
// A thread re-renders only when its own view object changes (memo by identity; the view model keeps identities), so a
// project with 1,000 threads costs one thread's render per change. Typing in the panel never reaches the editor's
// shortcuts: key events stop at the panel's text fields.

import { createElement as h, memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type KeyboardEvent, type ReactNode } from "react";
import { actorColor, initials } from "../actors.ts";
import { exactTime, when } from "../format.ts";
import { useLocale, useNow } from "../hooks.ts";
import { Button, HoverMore, cx } from "../components/ui.ts";
import { Icon } from "../icons.ts";
import type { Actor } from "../model.ts";
import type { CommentPerson, CommentView, CommentsUi, ThreadView } from "./model.ts";
import { commentWords, type CommentWords } from "./words.ts";

export type CommentsFilter = "open" | "resolved" | "all";

export interface CommentsPanelProps {
  comments: CommentsUi;
  /**
   * Where a new comment goes, read when it is posted: a range (the selection), a moment (the playhead), or null (the
   * whole version). Default: the whole version.
   */
  at?: () => readonly [number, number] | number | null;
  /** A timecode was clicked: move the playhead there. */
  onSeek?: (t: number) => void;
  /**
   * "See it as it was" (DESIGN §6.8, PLAN 9.1): a thread whose moment changed since shows the version it was made on
   * (the host views it: `ui.view`). Rejects when it can't be shown; the thread says so. Absent: the line has no link.
   */
  onSeeAsItWas?: (thread: ThreadView) => Promise<void> | void;
  /** The selected thread (also shown on the timeline markers). */
  selected?: string | null;
  onSelect?: (threadId: string | null) => void;
  initialFilter?: CommentsFilter;
  words?: Partial<CommentWords>;
  className?: string;
}

/** The comments view model's threads, re-rendering only when they change. */
export function useCommentThreads(ui: CommentsUi): readonly ThreadView[] {
  return useSyncExternalStore(ui.subscribe, ui.threads, ui.threads);
}

function useCommentsValue<T>(ui: CommentsUi, read: () => T): T {
  const ref = useRef(read);
  ref.current = read;
  const get = useCallback(() => ref.current(), []);
  return useSyncExternalStore(ui.subscribe, get, get);
}

const asActor = (p: CommentPerson, you: boolean): Actor => ({ key: `human/${p.id}`, kind: "human", name: p.name, ...(you ? { isYou: true } : {}) });

/** A person's avatar in the presence colours, without needing a CartonProvider. */
export function PersonAvatar({ person, size = 20 }: { person: CommentPerson; size?: number }) {
  const color = actorColor(asActor(person, false));
  const letters = initials(person.name);
  return h(
    "span",
    { className: "carton-avatar", "data-kind": "human", role: "img", "aria-label": person.name, style: { width: size, height: size, fontSize: Math.max(7, Math.round(size * 0.4)), ["--carton-actor" as string]: color } },
    h("span", { className: "carton-avatar-initials" }, size < 20 ? (Array.from(letters)[0] ?? "?") : letters),
  );
}

/** Stop key events in a text field from reaching the editor's shortcuts (space plays, Delete removes a clip…). */
const keepKeys = (e: KeyboardEvent) => e.stopPropagation();

function TextBox(p: { initial?: string; placeholder: string; submitLabel: string; cancelLabel?: string; onSubmit: (text: string) => Promise<unknown>; onCancel?: () => void; onFocus?: () => void; autoFocus?: boolean; label: string; className?: string; escAgain?: string; hint?: ReactNode }) {
  const [text, setText] = useState(p.initial ?? "");
  const [busy, setBusy] = useState(false);
  // Esc with new text in the box asks once before it goes: a second Esc discards it (UI audit P2-1).
  const [armed, setArmed] = useState(false);
  const ref = useRef<HTMLTextAreaElement>(null);
  // The box grows with its text, up to about eight lines, instead of showing a resize grip (P2-20).
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    if (el.scrollHeight > 0) el.style.height = `${Math.min(160, el.scrollHeight + 2)}px`;
  }, [text]);
  useEffect(() => {
    if (p.autoFocus) ref.current?.focus();
  }, []);
  const submit = async () => {
    const t = text.trim();
    if (!t || busy) return;
    setBusy(true);
    try {
      await p.onSubmit(text);
      setText("");
    } finally {
      setBusy(false);
    }
  };
  return h(
    "form",
    {
      className: cx("carton-comment-box", p.className),
      onSubmit: (e: { preventDefault(): void }) => {
        e.preventDefault();
        void submit();
      },
    },
    h("textarea", {
      ref,
      className: "carton-input carton-comment-text",
      value: text,
      rows: 2,
      placeholder: p.placeholder,
      "aria-label": p.label,
      maxLength: 10_000,
      disabled: busy,
      onFocus: p.onFocus,
      // React fires onChange on every keystroke; preact/compat maps it to the input event, so both behave the same.
      onChange: (e: { currentTarget: HTMLTextAreaElement }) => {
        setText(e.currentTarget.value);
        setArmed(false);
      },
      onKeyDown: (e: KeyboardEvent<HTMLTextAreaElement>) => {
        keepKeys(e);
        if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
          e.preventDefault();
          void submit();
        } else if (e.key === "Escape" && p.onCancel) {
          e.preventDefault();
          e.stopPropagation();
          if (text.trim() && text !== (p.initial ?? "") && !armed && p.escAgain) setArmed(true);
          else p.onCancel();
        }
      },
    }),
    armed ? h("p", { className: "carton-comment-esc", role: "status" }, p.escAgain) : null,
    h(
      "div",
      { className: "carton-comment-box-actions" },
      // where it will be pinned, beside the button that posts it (after/comments-384.png)
      p.hint ? h("span", { className: "carton-comment-where" }, p.hint) : null,
      p.onCancel ? h(Button, { variant: "ghost", onClick: p.onCancel }, p.cancelLabel) : null,
      h(Button, { type: "submit", variant: "primary", disabled: !text.trim(), busy }, p.submitLabel),
    ),
  );
}

interface RowProps {
  c: CommentView;
  thread: ThreadView;
  isRoot: boolean;
  w: CommentWords;
  now: number;
  locale: string | undefined;
  ui: CommentsUi;
  onSeek: ((t: number) => void) | undefined;
  /** This session may write (edit and delete its own too); a viewer's own old comments are read only. */
  can: boolean;
}

function CommentRow({ c, thread, isRoot, w, now, locale, ui, onSeek, can }: RowProps) {
  const [editing, setEditing] = useState(false);
  const who = c.mine ? w.you : c.author.name;
  const name = c.author.agent ? w.forAgent(who, c.author.agent) : who;
  const p = thread.placement;
  const statusKey = p ? (p.status === "outdated" && p.why === "trimmed" ? "trimmed" : p.status) : "exact";
  // a moment that changed since says so in its own line under the note (Thread: "That moment changed since. See it as
  // it was"); a note that followed its clip keeps the "Moved" badge
  const status = isRoot && p && statusKey === "moved" ? w.status.moved : "";
  const hint = statusKey === "moved" ? w.statusHint.moved : undefined;
  // who, where in the edit, then when on the right (DESIGN §6.8: after/comments-384.png)
  const head: ReactNode[] = [
    h(PersonAvatar, { key: "a", person: c.author, size: 18 }),
    h("span", { key: "n", className: "carton-comment-name" }, name),
  ];
  if (isRoot) {
    const range = p?.range ?? null;
    if (range && p?.status !== "general")
      head.push(
        h(
          "button",
          { key: "at", type: "button", className: "carton-comment-at", "data-status": p?.status, onClick: onSeek ? () => onSeek(range[0]) : undefined, disabled: !onSeek, "aria-label": w.seekTo(w.at(range)) },
          w.at(range),
        ),
      );
    else if (p?.status === "general") head.push(h("span", { key: "at", className: "carton-comment-at", "data-status": "general" }, w.wholeVideo));
    if (status) head.push(h("span", { key: "s", className: "carton-badge", "data-tone": "info", "aria-description": hint }, status));
  }
  if (c.pending) head.push(h("span", { key: "p", className: "carton-badge", "data-tone": "muted", "aria-description": w.pendingHint }, w.pending));
  head.push(h(HoverMore, { key: "t", as: "time", className: "carton-comment-when", dateTime: new Date(c.at).toISOString(), short: when(c.at, now, locale, w.justNow), more: exactTime(c.at, locale) }));
  if (can && c.mine && !c.deleted && !editing)
    head.push(
      h(
        "span",
        { key: "m", className: "carton-comment-mine", role: "group", "aria-label": w.actions },
        h(Button, { variant: "ghost", size: "sm", icon: "pencil", label: w.edit, onClick: () => setEditing(true) }),
        h(Button, { variant: "ghost", size: "sm", icon: "x", label: w.delete, onClick: () => void ui.remove(c.id) }),
      ),
    );
  return h(
    "div",
    { className: "carton-comment", "data-pending": c.pending ? "" : undefined, "data-deleted": c.deleted ? "" : undefined },
    h("div", { className: "carton-comment-head" }, ...head),
    editing && can
      ? h(TextBox, {
          initial: c.body,
          placeholder: w.placeholder,
          label: w.edit,
          submitLabel: w.save,
          cancelLabel: w.cancel,
          autoFocus: true,
          onCancel: () => setEditing(false),
            escAgain: w.escAgain,
          onSubmit: async (text) => {
            await ui.edit(c.id, text);
            setEditing(false);
          },
        })
      : h(
          "p",
          { className: "carton-comment-body" },
          c.deleted ? h("span", { className: "carton-comment-gone" }, w.deleted) : c.body,
          c.editedAt !== undefined && !c.deleted ? h("span", { className: "carton-comment-edited" }, ` (${w.edited})`) : null,
        ),
  );
}

interface ThreadProps {
  t: ThreadView;
  selected: boolean;
  w: CommentWords;
  ui: CommentsUi;
  onSeek: ((t: number) => void) | undefined;
  onSelect: ((id: string | null) => void) | undefined;
  onSeeAsItWas: ((t: ThreadView) => Promise<void> | void) | undefined;
  can: boolean;
}

/** The moment a note was on changed since it was written: its picture, a trim, or its clip removed (PLAN 9.1). */
const changedSince = (t: ThreadView) => t.placement?.status === "outdated" || t.placement?.status === "removed";

/** "That moment changed since. See it as it was": the version the note was made on, viewed (the host's ui.view). */
function ChangedLine({ t, w, onSee }: { t: ThreadView; w: CommentWords; onSee: ((t: ThreadView) => Promise<void> | void) | undefined }) {
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const p = t.placement!;
  const why = p.status === "removed" ? w.statusHint.removed : p.why === "trimmed" ? w.statusHint.trimmed : w.statusHint.outdated;
  const see = () => {
    if (busy || !onSee) return;
    setBusy(true);
    setFailed(false);
    Promise.resolve()
      .then(() => onSee(t))
      .then(
        () => setBusy(false),
        () => (setBusy(false), setFailed(true)),
      );
  };
  return h(
    "p",
    { className: "carton-comment-changed", title: why },
    h(Icon, { name: "info", size: 13 }),
    h("span", { className: "carton-comment-changed-text" }, w.changedSince),
    onSee && t.made ? h("button", { type: "button", className: "carton-link", "aria-describedby": undefined, "aria-busy": busy || undefined, disabled: busy, onClick: see }, w.seeAsItWas) : null,
    failed ? h("span", { className: "carton-error", role: "alert" }, w.seeFailed) : null,
  );
}

const Thread = memo(function Thread({ t, selected, w, ui, onSeek, onSelect, onSeeAsItWas, can }: ThreadProps) {
  const now = useNow();
  const locale = useLocale();
  const [replying, setReplying] = useState(false);
  const at = t.placement?.range && t.placement.status !== "general" ? w.at(t.placement.range) : w.wholeVideo;
  const ref = useRef<HTMLElement>(null);
  useEffect(() => {
    if (selected) ref.current?.scrollIntoView?.({ block: "nearest" });
  }, [selected]);
  const row = (c: CommentView, isRoot: boolean) => h(CommentRow, { key: c.id, c, thread: t, isRoot, w, now, locale, ui, onSeek, can });
  return h(
    "article",
    {
      ref,
      role: "listitem",
      className: "carton-thread",
      "data-selected": selected ? "" : undefined,
      "data-status": t.placement?.status,
      "data-resolved": t.resolved ? "" : undefined,
      "aria-label": w.threadLabel(t.root.mine ? w.you : t.root.author.name, at),
      onClick: onSelect ? (e: { target: EventTarget | null }) => !(e.target as HTMLElement | null)?.closest?.("button, textarea, a") && onSelect(t.id) : undefined,
    },
    row(t.root, true),
    changedSince(t) ? h(ChangedLine, { t, w, onSee: onSeeAsItWas }) : null,
    t.replies.length ? h("div", { className: "carton-thread-replies" }, t.replies.map((r) => row(r, false))) : null,
    t.resolved ? h("p", { className: "carton-thread-resolved" }, w.resolvedBy(t.resolved.by.id === ui.me().id ? w.you : t.resolved.by.name)) : null,
    replying
      ? h(TextBox, {
          placeholder: w.replyPlaceholder,
          label: w.reply,
          submitLabel: w.reply,
          cancelLabel: w.cancel,
          autoFocus: true,
          onCancel: () => setReplying(false),
          escAgain: w.escAgain,
          onSubmit: async (text) => {
            await ui.reply(t.id, text);
            setReplying(false);
          },
        })
      : can
        ? h(
            "div",
            { className: "carton-thread-actions" },
            h(Button, { variant: "ghost", size: "sm", onClick: () => setReplying(true) }, w.reply),
            h(Button, { variant: "ghost", size: "sm", icon: t.resolved ? undefined : "check", onClick: () => void ui.resolve(t.id, !t.resolved) }, t.resolved ? w.reopen : w.resolve),
          )
        : null,
  );
});

/** A place in words ("0:13", "0:13–0:16"), or null for the whole video. */
function placeWords(at: readonly [number, number] | null, w: CommentWords): string | null {
  return at ? w.at(at) : null;
}

/** Threads in timeline order: placed ones by where they sit now, then whole-version ones, by when they were made. */
function ordered(threads: readonly ThreadView[], filter: CommentsFilter): ThreadView[] {
  const list = threads.filter((t) => (filter === "all" ? true : filter === "open" ? !t.resolved : !!t.resolved));
  const key = (t: ThreadView) => (t.placement?.range && t.placement.status !== "general" ? t.placement.range[0] : Infinity);
  return list.sort((a, b) => key(a) - key(b) || a.root.at - b.root.at || (a.id < b.id ? -1 : 1));
}

export function CommentsPanel(p: CommentsPanelProps) {
  const w = useMemo(() => (p.words ? { ...commentWords, ...p.words } : commentWords), [p.words]);
  const ui = p.comments;
  const threads = useCommentThreads(ui);
  const status = useCommentsValue(ui, ui.status);
  const notice = useCommentsValue(ui, ui.notice);
  const [filter, setFilter] = useState<CommentsFilter>(p.initialFilter ?? "open");
  const shown = useMemo(() => ordered(threads, filter), [threads, filter]);
  const counts = useMemo(() => {
    let open = 0;
    for (const t of threads) if (!t.resolved) open++;
    return { open, resolved: threads.length - open, all: threads.length };
  }, [threads]);
  const can = ui.canComment();
  // a new comment is pinned where the playhead (or selection) was when writing began, as in a review tool: read when
  // the box gets focus, kept until it is posted
  const read = (): readonly [number, number] | null => {
    const v = p.at?.() ?? null;
    return v === null ? null : typeof v === "number" ? [v, v] : v;
  };
  const [pin, setPin] = useState<{ at: readonly [number, number] | null } | null>(null);
  // Where a note would go, said before writing begins (DESIGN §6.8: "Add a note at 0:13…", "At the playhead · 0:13"):
  // the host's place, read twice a second while nothing is pinned, kept as its words (a render only when they change)
  const readRef = useRef(read);
  readRef.current = read;
  const [here, setHere] = useState<string | null>(() => placeWords(read(), w));
  useEffect(() => {
    if (pin || !p.at) return undefined;
    const tick = () => setHere(placeWords(readRef.current(), w));
    tick();
    const timer = setInterval(tick, 500);
    return () => clearInterval(timer);
  }, [pin, p.at, w]);
  const where = pin ? placeWords(pin.at, w) : here;
  const range = pin ? pin.at : null;
  const whereLine = where === null ? w.wholeVideo : range && range[1] - range[0] >= 0.5 ? w.atSelection(where) : w.atPlayhead(where);
  // Open, Resolved and All: only once a note is resolved (until then all three list the same notes)
  const tabs = (["open", "resolved", "all"] as const).map((f) =>
    h(
      "button",
      { key: f, type: "button", role: "tab", className: "carton-comments-tab", "aria-selected": filter === f, onClick: () => setFilter(f) },
      w.filterCount(w.filters[f], counts[f]),
    ),
  );
  const line =
    status.state === "unsupported"
      ? w.unsupported
      : status.waiting > 0 && status.state !== "local"
        ? w.syncWaiting(status.waiting)
        : null;
  return h(
    "section",
    { className: cx("carton-comments", p.className), "aria-label": w.comments },
    // (no heading of its own: the panel's tab says "Comments", and the section is labelled: PLAN 9.1)
    counts.resolved > 0 || filter !== "open" ? h("header", { className: "carton-comments-head" }, h("div", { role: "tablist", className: "carton-comments-tabs", "aria-label": w.comments }, ...tabs)) : null,
    notice
      ? h(
          "div",
          { role: "alert", className: "carton-comments-notice" },
          h("span", null, notice),
          h(Button, { variant: "ghost", size: "sm", icon: "x", label: w.dismiss, onClick: () => ui.dismissNotice() }),
        )
      : null,
    line ? h("p", { role: "status", className: "carton-comments-status", "data-state": status.state }, line) : null,
    can
      ? h(TextBox, {
          className: "carton-comments-compose",
          placeholder: where === null ? w.placeholderWhole : w.placeholderAtPlayhead(where),
          label: w.comment,
          submitLabel: w.comment,
          hint: whereLine,
          onFocus: () => setPin((x) => x ?? { at: read() }),
          onSubmit: async (text) => {
            await ui.add(text, pin ? pin.at : read());
            setPin(null);
          },
        })
      : h("p", { className: "carton-muted carton-comments-readonly" }, w.readOnly),
    shown.length
      ? h(
          "div",
          { role: "list", className: "carton-comments-list" },
          shown.map((t) => h(Thread, { key: t.id, t, selected: p.selected === t.id, w, ui, onSeek: p.onSeek, onSelect: p.onSelect, onSeeAsItWas: p.onSeeAsItWas, can })),
        )
      : h("p", { className: "carton-empty" }, filter === "resolved" ? w.emptyResolved : w.empty),
  );
}
