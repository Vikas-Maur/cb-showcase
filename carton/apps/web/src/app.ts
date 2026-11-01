// The editor page: Cardboard's layout in miniature. Top bar (project, Cuts, sync status words, presence, offline,
// Undo turn, Publish, Invite to edit); the preview with the selected clip's inspector; the timeline; the History panel
// on the right; conflict cards over the timeline. Everything Carton-specific is @carton/react's (History, Cuts, Fold
// in, conflict cards, Credits, Undo turn, Published cut, Watch the changes, presence, sync words) on its `cardboard`
// skin; this file only lays them out and connects the timeline's edits to Carton.

import { shownProblem, syncProblemWords } from "./sync-problem.ts";
import { createElement as h, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { Actor, Carton, Doc, HeldBase, Op, Rec, SyncError } from "@carton/core";
import {
  ConflictList,
  CreditsPopover,
  CommentMarkers,
  CommentsPanel,
  CutsMenu,
  Dialog,
  FoldInDialog,
  HistoryPanel,
  PresenceAvatars,
  PreviewBanner,
  PublishedStatus,
  SyncStatusWords,
  UndoTurnButton,
  WatchTheChanges,
  useCartonUi,
  useConflicts,
  useCurrentCut,
  usePreview,
  useSyncStatus,
  type CartonUiHandle,
  type CommentsUiHandle,
  type Cut,
  type Side,
} from "@carton/react";
import { ITEMS, type SampleMedia } from "./demo-doc.ts";
import { clipOf, fieldOps } from "./edit.ts";
import type { ImageCache } from "./images.ts";
import type { LiveDoc } from "./live-doc.ts";
import { Player, captionAt, videoAt } from "./player.ts";
import type { PresenceSender } from "./presence.ts";
import type { Session } from "./session.ts";
import { Timeline, formatTime } from "./timeline.ts";
import { Btn } from "./ui.ts";

export interface AppProps {
  carton: Carton;
  ui: CartonUiHandle;
  /** Timecoded comments on this project (the panel beside History, the markers over the ruler). */
  comments: CommentsUiHandle;
  live: LiveDoc;
  session: Session;
  me: Actor;
  name: string;
  media: Record<string, SampleMedia>;
  presence: PresenceSender;
  images: ImageCache;
  mediaUrl: (hash: string) => string;
  /** The media Service Worker controls the page: until then the player shows posters, never a /media/ URL. */
  mediaReady: { subscribe: (l: () => void) => () => void; get: () => boolean };
  /** What the host refused (shown in place of the sync words while it stands). */
  syncProblem: { subscribe: (l: () => void) => () => void; get: () => SyncError | null };
  /** Read-only preview doc (§9 R2-16), set by fromCarton's onPreview. */
  previewDoc: { subscribe: (l: () => void) => () => void; get: () => Doc | null };
  /** Another tab of this person holds the push lock. */
  waiting: { subscribe: (l: () => void) => () => void; get: () => boolean };
  setOffline: (off: boolean) => Promise<void>;
  isOffline: () => boolean;
}

const useStore = <T,>(s: { subscribe: (l: () => void) => () => void; get: () => T }) => useSyncExternalStore(s.subscribe, s.get, s.get);

export function App(p: AppProps) {
  const ui = useCartonUi();
  const current = useCurrentCut();
  const head = useSyncExternalStore(
    useCallback((l: () => void) => p.live.subscribe(l), [p.live]),
    () => p.live.doc,
  );
  const previewDoc = useStore(p.previewDoc);
  const mediaReady = useStore(p.mediaReady);
  const mediaUrl = useCallback((hash: string) => (mediaReady ? p.mediaUrl(hash) : ""), [mediaReady, p.mediaUrl]);
  const preview = usePreview();
  const waiting = useStore(p.waiting);
  useSyncExternalStore(
    useCallback((l: () => void) => p.images.subscribe(l), [p.images]),
    () => p.images.version,
  );
  const doc = previewDoc ?? head;
  // a preview is read-only (§9 R2-16), and so is a tab that doesn't hold this person's push lock
  const readOnly = !!previewDoc || waiting;
  const [time, setTime] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [watch, setWatch] = useState<{ a: string; b: string } | null>(null);
  const [fold, setFold] = useState<{ from: Cut; into: Cut } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [side, setSide] = useState<"history" | "comments">("history");
  const [thread, setThread] = useState<string | null>(null);
  // where a new comment goes: the playhead; on a selected clip the playhead isn't on, the whole clip
  const timeRef = useRef(time);
  timeRef.current = time;
  const docRef = useRef<Doc>(head);
  docRef.current = previewDoc ?? head;
  const selectedRef = useRef(selected);
  selectedRef.current = selected;
  const commentAt = useCallback((): number | readonly [number, number] => {
    const t = timeRef.current;
    const c = selectedRef.current ? clipOf(docRef.current, selectedRef.current) : undefined;
    if (!c) return t;
    const s = c.startTime as number, e = c.endTime as number;
    return t >= s && t <= e ? t : [s, e];
  }, []);
  const seekTo = useCallback((t: number) => (setPlaying(false), setTime(t)), []);
  const selectThread = useCallback((id: string | null) => (setThread(id), id && setSide("comments")), []);

  const onEdit = useCallback(
    async (ops: Op[], base?: HeldBase) => {
      if (!ops.length) return;
      p.presence.active("Editing");
      try {
        const r = await p.carton.commit({ ops, author: p.me, ...(base ? { base } : {}) });
        if (r.status === "conflicts") p.ui.reportConflicts(r.cards);
        else if (r.status === "rejected") setError(`The server refused that edit: ${r.reason}`);
      } catch (e) {
        setError((e as Error).message);
      }
      await p.live.refresh();
    },
    [p.carton, p.me, p.ui, p.live, p.presence],
  );
  const onBlocked = useCallback(() => (waiting ? setError("This project is open in another tab. Edit it there, or close that tab: this one takes over.") : ui.blockEdit()), [ui, waiting]);

  const clip = selected ? clipOf(doc, selected) : undefined;
  const length = useMemo(() => Math.max(0, ...((doc[ITEMS] ?? []) as Rec[]).map((r) => r.endTime as number)), [doc]);

  return h(
    "div",
    { className: "cb-app", "data-carton-skin": "cardboard" },
    h(TopBar, { ...p, onFoldIn: (from: Cut, into: Cut) => setFold({ from, into }) }),
    waiting ? h("div", { className: "cb-banner", role: "status" }, "This project is open in another tab. Edit it there; this tab is read-only and takes over once that one closes.") : null,
    h(
      "div",
      { className: "cb-main" },
      h(
        "div",
        { className: "cb-stage" },
        h(
          "div",
          { className: "cb-viewer" },
          h(PreviewBanner, { className: "cb-preview-banner" }),
          h(Player, { doc, media: p.media, time, playing, onTime: setTime, onPause: () => setPlaying(false), mediaUrl, poster: (k: string) => p.images.get(k) }),
          h(
            "div",
            { className: "cb-transport" },
            h(Btn, { onClick: () => (playing ? setPlaying(false) : (time >= length - 0.05 && setTime(0), setPlaying(true), p.presence.active("Watching"))), "aria-label": playing ? "Pause" : "Play", "data-testid": "play" }, playing ? "❚❚ Pause" : "▶ Play"),
            h("span", { className: "cb-time" }, `${formatTime(time)} / ${formatTime(length)}`),
            preview ? h("span", { className: "cb-dim" }, `Previewing ${preview.label}: read-only`) : null,
          ),
        ),
        h(Inspector, { clip, readOnly, onEdit, base: () => p.live.base(), onBlocked, media: p.media }),
      ),
      h(
        "aside",
        { className: "cb-side" },
        h(Conflicts),
        h(SideTabs, { side, setSide, comments: p.comments }),
        // both stay mounted: switching tabs keeps a comment or reply being written, and History's scroll
        h("div", { className: "cb-side-pane", hidden: side !== "history" }, h(HistoryPanel, { className: "cb-history", currentRef: current?.head ?? p.live.cut, onWatch: (a: string, b: string) => setWatch({ a, b }) })),
        h("div", { className: "cb-side-pane", hidden: side !== "comments", "data-testid": "comments-pane" }, h(CommentsPanel, { className: "cb-comments", comments: p.comments, at: commentAt, onSeek: seekTo, selected: thread, onSelect: setThread })),
      ),
    ),
    h(
      "div",
      { className: "cb-bottom" },
      h(Timeline, { doc, media: p.media, time, onSeek: (t: number) => (setPlaying(false), setTime(t)), selected, onSelect: setSelected, onEdit, base: () => p.live.base(), presence: p.presence, readOnly, onBlocked, image: (k: string) => p.images.get(k),
        rulerOverlay: (timeToX: (t: number) => number, layoutKey: unknown) => h(CommentMarkers, { comments: p.comments, timeToX, layoutKey, selected: thread, onSelect: selectThread, className: "cb-tl-comments" }),
      }),
    ),
    watch ? h(WatchDialog, { ...watch, carton: p.carton, media: p.media, images: p.images, onClose: () => setWatch(null) }) : null,
    fold ? h(FoldInDialog, { fromCutId: fold.from.id, intoCutId: fold.into.id, onClose: () => setFold(null) }) : null,
    error ? h(Toast, { text: error, onClose: () => setError(null) }) : null,
  );
}

/** History and Comments share the side panel, as in Cardboard's right panel. */
function SideTabs({ side, setSide, comments }: { side: "history" | "comments"; setSide: (s: "history" | "comments") => void; comments: CommentsUiHandle }) {
  const open = useSyncExternalStore(comments.subscribe, () => comments.threads().filter((t) => !t.resolved).length);
  const tab = (id: "history" | "comments", label: string) =>
    h("button", { type: "button", role: "tab", className: "cb-side-tab", "aria-selected": side === id, "data-testid": `side-${id}`, onClick: () => setSide(id) }, label);
  return h("div", { role: "tablist", className: "cb-side-tabs" }, tab("history", "History"), tab("comments", open ? `Comments (${open})` : "Comments"));
}

function TopBar(p: AppProps & { onFoldIn: (from: Cut, into: Cut) => void }) {
  const status = useSyncStatus();
  const problem = shownProblem(useStore(p.syncProblem));
  const [offline, setOffline] = useState(p.isOffline());
  const [invite, setInvite] = useState<string | null>(null);
  const shared = status.kind !== "local";
  return h(
    "header",
    { className: "cb-topbar" },
    h("span", { className: "cb-tab cb-tab-dim" }, "▦  Dashboard"),
    h("span", { className: "cb-tab", "data-testid": "project-name" }, h("span", { className: "cb-tab-thumb", "aria-hidden": true }), String(p.live.doc.name ?? "Untitled")),
    h("span", { className: "cb-sep" }),
    h(CutsMenu, { onFoldIn: p.onFoldIn }),
    problem
      ? h("span", { className: "carton-sync cb-sync-problem", "data-state": "error", role: "alert", "data-testid": "sync-problem", "data-code": problem.code, title: problem.message }, syncProblemWords(problem))
      : h(SyncStatusWords),
    h("span", { className: "cb-flex" }),
    h(PresenceAvatars),
    shared
      ? h(
          Btn,
          {
            className: "cb-offline",
            "data-testid": "offline-toggle",
            "aria-pressed": offline,
            onClick: async () => {
              await p.setOffline(!offline);
              setOffline(!offline);
            },
          },
          offline ? "Go online" : "Go offline",
        )
      : null,
    h(UndoTurnButton),
    h(PublishedStatus, { onOpen: (url: string) => window.open(url, "_blank") }),
    h(PublishButton),
    p.session.role === "owner"
      ? h(Btn, { "data-testid": "invite", onClick: async () => setInvite(`${location.origin}${location.pathname}#join=${p.session.projectId}.${await p.session.invite("editor")}`) }, "Invite to edit")
      : null,
    h("span", { className: "cb-me", title: `You: ${p.name} (${p.session.account})` }, p.name),
    invite ? h(InviteDialog, { link: invite, onClose: () => setInvite(null) }) : null,
  );
}

/** Publish the current cut (what the share link shows). Shown until it has a publication: PublishedStatus takes over. */
function PublishButton() {
  const ui = useCartonUi();
  const pub = useSyncExternalStore((l) => ui.subscribe("published", l), () => ui.published());
  const cut = useSyncExternalStore((l) => ui.subscribe("cuts", l), () => ui.cuts().find((c) => c.current));
  const [busy, setBusy] = useState(false);
  if (pub || !cut) return null;
  return h(
    Btn,
    {
      "data-testid": "publish",
      disabled: busy,
      onClick: async () => {
        setBusy(true);
        try {
          await ui.publish(cut.id);
        } finally {
          setBusy(false);
        }
      },
    },
    busy ? "Publishing…" : "Publish",
  );
}

function InviteDialog({ link, onClose }: { link: string; onClose: () => void }) {
  const [copied, setCopied] = useState(false);
  return h(Dialog, {
    title: "Invite to edit",
    onClose,
    children: [
      h("p", { key: "p", className: "cb-dim" }, "Anyone with this link can edit this cut with you, live. The watch-only share link is what Publish gives."),
      h("input", { key: "i", className: "cb-input cb-link", readOnly: true, value: link, "data-testid": "invite-link", onFocus: (e: FocusEvent) => (e.target as HTMLInputElement).select() }),
      h("div", { key: "a", className: "cb-dialog-actions" }, h(Btn, { onClick: async () => (await navigator.clipboard?.writeText(link).catch(() => {}), setCopied(true)) }, copied ? "Copied" : "Copy link"), h(Btn, { onClick: onClose }, "Done")),
    ],
  });
}

/** The selected clip: caption text, volume, opacity, and Credits (who changed it, down to the subagent). */
function Inspector(p: { clip: Rec | undefined; readOnly: boolean; onEdit: (ops: Op[], base?: HeldBase) => Promise<void>; base: () => HeldBase | undefined; onBlocked: () => void; media: Record<string, SampleMedia> }) {
  const c = p.clip;
  const [credits, setCredits] = useState(false);
  const [text, setText] = useState("");
  const editing = useRef(false);
  // the state the person started editing from: what they saw is the edit's base (a teammate's change since is merged)
  const from = useRef<HeldBase | undefined>(undefined);
  const begin = () => (from.current ??= p.base());
  useEffect(() => {
    // a teammate's edit to the caption shows here unless this person is typing in it
    if (!editing.current) setText(String(c?.captionText ?? ""));
  }, [c?.id, c?.captionText]);
  useEffect(() => ((from.current = undefined), setCredits(false)), [c?.id]);
  if (!c) return h("div", { className: "cb-inspector cb-inspector-empty" }, h("p", { className: "cb-dim" }, "Select a clip or caption to edit it. Drag a clip to move it, drag its edges to trim."));
  const edit = (ops: Op[]) => {
    const base = from.current ?? p.base();
    from.current = undefined;
    return p.readOnly ? p.onBlocked() : void p.onEdit(ops, base);
  };
  const isCaption = c.type === "caption";
  return h(
    "div",
    { className: "cb-inspector", "data-testid": "inspector" },
    h("div", { className: "cb-inspector-head" }, h("strong", null, isCaption ? "Caption" : String(c.name ?? c.id)), h("span", { className: "cb-dim" }, `${formatTime(c.startTime as number)} – ${formatTime(c.endTime as number)}`), h("span", { className: "cb-flex" }), h(Btn, { onClick: () => setCredits(!credits), "data-testid": "credits", "aria-expanded": credits }, "Credits")),
    credits ? h(CreditsPopover, { itemId: String(c.id), onClose: () => setCredits(false), className: "cb-credits" }) : null,
    isCaption
      ? h(
          "label",
          { className: "cb-field" },
          h("span", null, "Caption text"),
          h("input", {
            className: "cb-input",
            value: text,
            "data-testid": "caption-text",
            readOnly: p.readOnly,
            onFocus: () => ((editing.current = true), begin()),
            onInput: (e: Event) => setText((e.target as HTMLInputElement).value),
            onKeyDown: (e: KeyboardEvent) => e.key === "Enter" && (e.target as HTMLInputElement).blur(),
            onBlur: () => {
              editing.current = false;
              edit(fieldOps(c, "captionText", text));
            },
          }),
        )
      : h(
          "div",
          { className: "cb-fields" },
          h(Slider, { label: "Volume", value: (c.volume as number) ?? 100, min: 0, max: 200, step: 1, unit: "%", testid: "volume", onBegin: begin, onCommit: (v: number) => edit(fieldOps(c, "volume", v)) }),
          h(Slider, { label: "Opacity", value: Math.round(((c.opacity as number) ?? 1) * 100), min: 0, max: 100, step: 1, unit: "%", testid: "opacity", onBegin: begin, onCommit: (v: number) => edit(fieldOps(c, "opacity", v / 100)) }),
        ),
  );
}

/** A slider that commits once, on release (a version per gesture, not per pixel), and follows remote edits otherwise. */
function Slider(p: { label: string; value: number; min: number; max: number; step: number; unit: string; testid: string; onBegin: () => void; onCommit: (v: number) => void }) {
  const [v, setV] = useState(p.value);
  const held = useRef(false);
  useEffect(() => {
    if (!held.current) setV(p.value);
  }, [p.value]);
  const commit = () => {
    held.current = false;
    if (v !== p.value) p.onCommit(v);
  };
  return h(
    "label",
    { className: "cb-field" },
    h("span", null, p.label),
    h("input", {
      type: "range",
      min: p.min,
      max: p.max,
      step: p.step,
      value: v,
      "data-testid": p.testid,
      onPointerDown: () => ((held.current = true), p.onBegin()),
      onKeyDown: () => p.onBegin(),
      onInput: (e: Event) => setV(Number((e.target as HTMLInputElement).value)),
      onChange: commit,
      onKeyUp: commit,
    }),
    h("span", { className: "cb-field-value" }, `${v}${p.unit}`),
  );
}

function Conflicts() {
  const cards = useConflicts();
  if (!cards.length) return null;
  return h("div", { className: "cb-conflicts", "data-testid": "conflicts" }, h(ConflictList));
}

/** Watch the changes (§9): the shot diff with Play changes and the aligned A/B toggle; the preview draws each frame. */
function WatchDialog(p: { a: string; b: string; carton: Carton; media: Record<string, SampleMedia>; images: ImageCache; onClose: () => void }) {
  const [docs, setDocs] = useState<{ a: Doc; b: Doc } | null>(null);
  useEffect(() => {
    let live = true;
    void Promise.all([p.carton.checkout(p.a), p.carton.checkout(p.b)]).then(([a, b]) => live && setDocs({ a, b }));
    return () => {
      live = false;
    };
  }, [p.a, p.b]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && p.onClose();
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  }, [p.onClose]);
  const img = useRef<HTMLImageElement>(null);
  const label = useRef<HTMLDivElement>(null);
  const side = useRef<HTMLSpanElement>(null);
  // called every animation frame while playing: DOM writes only, no render
  const onFrame = useCallback(
    (s: Side, t: number) => {
      if (!docs) return;
      const d = s === "a" ? docs.a : docs.b;
      const c = videoAt(d, t);
      const m = c ? p.media[String(c.mediaItemId)] : undefined;
      const url = m?.poster ? p.images.get(m.poster) : undefined;
      if (img.current) {
        if (url && img.current.src !== url) img.current.src = url;
        img.current.style.visibility = url ? "visible" : "hidden";
        img.current.style.opacity = String((c?.opacity as number) ?? 1);
      }
      if (label.current) label.current.textContent = String(captionAt(d, t)?.captionText ?? "");
      if (side.current) side.current.textContent = `${s === "a" ? "Before" : "After"} · ${c ? String(c.name ?? c.id) : "—"} · ${formatTime(t)}`;
    },
    [docs, p.media, p.images],
  );
  return h(
    "div",
    { className: "carton-overlay cb-watch-overlay", "data-carton-skin": "cardboard" },
    h(
      "div",
      { className: "cb-watch", "data-testid": "watch" },
      docs
        ? h(WatchTheChanges, {
            a: p.a,
            b: p.b,
            onFrame,
            onClose: p.onClose,
            preview: h("div", { className: "cb-watch-preview" }, h("img", { ref: img, alt: "" }), h("div", { ref: label, className: "cb-player-caption" }), h("span", { ref: side, className: "cb-watch-side" })),
          })
        : h("p", { className: "cb-dim" }, "Loading both versions…"),
    ),
  );
}

function Toast({ text, onClose }: { text: string; onClose: () => void }) {
  useEffect(() => {
    const t = setTimeout(onClose, 6000);
    return () => clearTimeout(t);
  }, [text]);
  return h("div", { className: "cb-toast", role: "alert" }, text, h("button", { className: "cb-toast-x", onClick: onClose, "aria-label": "Dismiss" }, "×"));
}
