// carton-ui.js: Carton in Cardboard's editor (scripts/carton/build.js bundles it with @carton/react), in two places
// editor-panel.js mounts:
// - CartonSide: the History or Share panel, a full-height column beside the agent's chat sidebar, in its look (width,
//   rule, resize handle, header). The title bar's History and Share icons open it (patch-carton.js routes them as
//   carton:command to this page) and show which one is open (this page reports it back: bridge.reportPanel).
// - CartonStage: a layer over the stage (the preview's column, above the timeline, left of the chat): the conflict
//   cards' floating stack in its bottom-right corner, with "See it", and the preview banner ("Return to current").
// Neither takes keys but its own (Esc closes the panel while focus is in it), so the stage, the timeline's keyboard,
// Ctrl+Z and the chat work as before.
// Carton runs in the library worker. There @carton/react's view model is served to each page (serveUi over the
// worker's carton namespace, scripts/carton/carton-node.js); here remoteUi mirrors it, one connection per project shared
// by both parts. Messages go out through the bridge's carton:call "ui" and come back as carton:event for this page's
// client id. A preview is the editor's own read-only one (the bridge's preview).
import { Component, createElement as h, memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Button, CartonProvider, Dialog, actorColor, actorLabel, initials, CommentsPanel, ConflictStack, CutsMenu, FoldInDialog, HistoryPanel, Icon, PreviewBanner, WatchTheChanges, injectCommentsSkin, keptText, remoteComments, remoteUi, useCartonUi, useCuts, words } from "@carton/react";
import { injectCardboardSkin } from "@carton/react/skin/cardboard";

// Short confirmations over the stage (UI audit P2-4): Restore, Fold in and a conflict card's pick said nothing, so a
// person couldn't tell they had worked. One at a time, gone after 6 s; Fold in offers to switch to the cut it went into.
// `tone` "warning": a failure or a refusal the bridge tells (a save that failed, an undo refused), with the warning
// look Carton's other failures have (the conflict stack, footage still on its way, Offline), not the ✓ of a
// confirmation (laptop, merge/prod-2 N-3), and said at once to a screen reader (role alert).
const toasts = { value: null, seq: 0, subs: new Set(), show(text, action, tone) { this.set({ id: ++this.seq, text, action, ...(tone ? { tone } : {}) }); }, set(v) { this.value = v; for (const f of this.subs) f(v); } };
// what the bridge tells (scripts/carton/renderer-bridge.js notice: a save that failed, an undo refused)
const tellFailure = (text) => toasts.show(text, null, "warning");
const clockTime = (at) => new Date(at).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
function confirmations(ui) {
  const versionByRef = (ref) => (ui.history().all?.() ?? []).find((v) => v.ref === ref);
  const restore = ui.restore.bind(ui);
  ui.restore = async (ref) => {
    const v = versionByRef(ref);
    await restore(ref);
    toasts.show(v?.name ? `Restored “${v.name}”. It's saved as a new version.` : v ? `Restored the version from ${clockTime(v.at)}. It's saved as a new version.` : "Restored. It's saved as a new version.");
  };
  const fold = ui.fold.bind(ui);
  ui.fold = async (from, into, opts) => {
    const r = await fold(from, into, opts);
    if (r?.ok) {
      const cuts = ui.cuts(), a = cuts.find((c) => c.id === from), b = cuts.find((c) => c.id === into);
      const left = opts?.leaveOut?.length ? " Some changes were left out." : "";
      toasts.show(`Folded “${a?.label ?? "the cut"}” into ${b?.label ?? "the cut"}.${left}`, b && !b.current ? { label: `Switch to ${b.label}`, run: () => ui.switchCut(into) } : null);
    }
    return r;
  };
  // A conflict card's pick names what was kept, as the card named it (docs/carton-ux DESIGN §6.7): "Kept Claude Code's
  // move of “Interview B”." No Undo on it yet (PLAN 5.3): a pick of the side already shown commits nothing, so the
  // editor's undo would take back an earlier change instead.
  const resolve = ui.resolve.bind(ui);
  ui.resolve = async (id, choice) => {
    const c = ui.conflicts().find((x) => x.id === id);
    await resolve(id, choice);
    if (c) toasts.show(keptText(c, choice, ui.actor.bind(ui)));
  };
}

function connect(projectId, bridge) {
  const client = projectId + ":" + Math.random().toString(36).slice(2);
  const r = remoteUi((message) => bridge.call("ui", [{ projectId, client, message }]).catch((e) => console.warn("[carton] the History panel lost the worker:", e?.message ?? e)));
  const off = bridge.onEvent((ev) => { if (ev?.client === client && ev.message) r.receive(ev.message); });
  // Opening a version: the editor shows it read-only; null returns to current.
  const openPreview = r.ui.openPreview.bind(r.ui);
  r.ui.openPreview = (ref, label) => { openPreview(ref, label); return bridge.preview(projectId, ref ?? null); };
  confirmations(r.ui);
  return { ...r, close: off };
}

/** The confirmation over the stage: Cardboard's toast look, a polite status, its action as a button, ✕ to close. */
function Toast() {
  const [t, setT] = useState(toasts.value);
  useEffect(() => { toasts.subs.add(setT); return () => { toasts.subs.delete(setT); }; }, []);
  useEffect(() => {
    if (!t) return undefined;
    const id = t.id, timer = setTimeout(() => { if (toasts.value?.id === id) toasts.set(null); }, 6000);
    return () => clearTimeout(timer);
  }, [t]);
  if (!t) return null;
  const warn = t.tone === "warning";
  return h("div", { className: "carton-toast", "data-tone": warn ? "warning" : undefined, role: warn ? "alert" : "status", "aria-live": warn ? "assertive" : "polite" },
    h(Icon, { name: warn ? "warning" : "check", size: 14 }),
    h("span", { className: "carton-toast-text" }, t.text),
    t.action ? h(Button, { onClick: () => { toasts.set(null); void t.action.run(); } }, t.action.label) : null,
    h(Button, { variant: "ghost", icon: "x", label: words.close, onClick: () => toasts.set(null) }));
}

// One connection per project, shared by the side panel and the stage layer; closed when neither uses it.
const conns = new Map();
function useConn(projectId, bridge) {
  const conn = useMemo(() => {
    let e = conns.get(projectId);
    if (!e) conns.set(projectId, (e = { conn: connect(projectId, bridge), users: 0, closing: null }));
    return e.conn;
  }, [projectId, bridge]);
  const [ready, setReady] = useState(false);
  useEffect(() => {
    injectCardboardSkin(document);
    const e = conns.get(projectId);
    if (e?.conn === conn) { e.users++; clearTimeout(e.closing); }
    let live = true;
    conn.ready.then(() => live && setReady(true));
    return () => {
      live = false;
      if (e?.conn !== conn || --e.users > 0) return;
      e.closing = setTimeout(() => { if (e.users === 0 && conns.get(projectId) === e) { conns.delete(projectId); conn.close(); } }, 0);
    };
  }, [projectId, conn]);
  return [conn, ready];
}

const HISTORY_KEY = /Mac|iPhone|iPad/.test(globalThis.navigator?.platform ?? "") ? "⌘⇧H" : "Ctrl+Shift+H";
const PANELS = { history: { label: "History", icon: "versions", key: HISTORY_KEY }, comments: { label: "Comments", icon: "comment" }, share: { label: "Share", icon: "users" } };
// Which side panel is open, for the stage layer of this page (both parts live in this module, so it stays in it): the
// card stack folds to its pill while a panel takes the room beside the chat.
const sidePanel = { value: null, subs: new Set(), set(v) { this.value = v; for (const f of this.subs) f(v); } };
// The stage's live chip asks the side panel to open Share (both parts live in this module).
const panelRequests = new Set();
const WIDTH = { key: "carton.sidePanelWidth", min: 300, max: 640, initial: 384 };
// The preview keeps at least this much width beside the panel (UI audit P2-13: at a narrow window the panel took it all).
const MIN_STAGE = 320;

/**
 * Where the side panel goes, from the room the preview would have without it (`room`: the stage's width plus the
 * panel's own width while it is in the row). Its chosen width when that leaves the preview MIN_STAGE; narrower, down
 * to its minimum, when that is enough; else it floats over the chat as a drawer (overlay), and the preview keeps the
 * room Cardboard alone gives it. `room` doesn't change with the choice, so the choice never oscillates.
 * The drawer covers the chat column (`chat`: its width, 0 when it is collapsed) and no more when that is at least the
 * minimum; narrower than that, the drawer keeps its minimum and says it reaches past the chat (`over`), so it ends
 * where the stage ends and leaves the timeline and its toolbar clear (baseline P3-7: at 960 px it covered Fullscreen and
 * Hide timeline). It ends there too when the timeline's toolbar reaches under it (`tools`: the toolbar's right edge,
 * its last button's): at 960 px with the chat open the toolbar runs on under the chat column, and the drawer as wide as
 * that column covered Fullscreen and Hide timeline from top to bottom (regress prod3 P3-A).
 */
export function fitPanel({ room, preferred, viewport, chat, tools, min = WIDTH.min, minStage = MIN_STAGE }) {
  if (!(room > 0)) return { mode: "inline", width: preferred };
  if (room - preferred >= minStage) return { mode: "inline", width: preferred };
  if (room - min >= minStage) return { mode: "inline", width: Math.floor(room - minStage) };
  const width = Math.max(Math.min(preferred, viewport - 64), Math.min(min, viewport));
  // not measured: as before; a chat collapsed to nothing is measured (review #2), and all of the drawer is past it
  if (!(chat >= 0)) return { mode: "overlay", width };
  const fits = Math.max(min, Math.min(width, Math.floor(chat)));
  return { mode: "overlay", width: fits, over: fits > chat || tools > viewport - fits };
}

/** The panel's place in the row (fitPanel), kept up to date as the window, the Library or the chat change size. */
function useFit(ref, preferred) {
  const [fit, setFit] = useState({ mode: "inline", width: preferred });
  const fitRef = useRef(fit);
  fitRef.current = fit;
  useLayoutEffect(() => {
    const stage = document.querySelector("[data-carton-stage-host]");
    if (!stage) { setFit({ mode: "inline", width: preferred }); return undefined; }
    const measure = () => {
      const aside = ref.current;
      if (!aside) return;
      const inflow = fitRef.current.mode === "inline" ? aside.getBoundingClientRect().width : 0;
      const box = stage.getBoundingClientRect(), room = box.width + inflow;
      const row = aside.parentElement?.getBoundingClientRect();
      // the chat column: the row's right of the stage, less the panel while it is in the row
      const chat = row ? Math.max(0, row.right - box.right - inflow) : undefined;
      // the timeline toolbar's right end: its last button (Cardboard's own, "Hide timeline" or "Show timeline")
      const tools = document.querySelector('[aria-label="Hide timeline"],[aria-label="Show timeline"]')?.getBoundingClientRect().right;
      const fit = fitPanel({ room, preferred, viewport: window.innerWidth, chat, tools });
      // reaching past the chat, the drawer ends where the stage does: the timeline below stays clear
      const next = { ...fit, ...(row ? { top: row.top, height: fit.over ? Math.max(0, box.bottom - row.top) : row.height } : {}) };
      const was = fitRef.current;
      if (was.mode !== next.mode || was.width !== next.width || (next.mode === "overlay" && (was.top !== next.top || was.height !== next.height))) setFit(next);
    };
    measure();
    const ro = typeof ResizeObserver === "function" ? new ResizeObserver(measure) : null;
    ro?.observe(stage);
    window.addEventListener("resize", measure);
    return () => { ro?.disconnect(); window.removeEventListener("resize", measure); };
  }, [ref, preferred]);
  return fit;
}

/**
 * History in the side panel: the cut it shows, with its switcher (switch, New cut, rename, Fold into…, which opens
 * Fold in: all, some or none of it), then the versions, Compare with current, and "Watch the changes" in their place.
 */
function HistorySide({ bridge }) {
  const cuts = useCuts();
  const [watch, setWatch] = useState(null);
  const [fold, setFold] = useState(null);
  const current = cuts.find((c) => c.current)?.head;
  const box = useRef(null);
  // Back from Watch the changes: focus goes to the version list, not to <body>.
  const back = useCallback(() => {
    setWatch(null);
    requestAnimationFrame(() => box.current?.querySelector(".carton-history-list")?.focus({ preventScroll: true }));
  }, []);
  // The editor's own player shows the side being watched (the read-only preview Watch opens), so its playhead follows
  // Watch's: real frames there, at most 10 seeks a second while it plays, and always the last one.
  const seeker = useMemo(() => {
    let last = 0, timer = null, at = 0;
    const go = () => { timer = null; last = performance.now(); bridge.seek?.(at); };
    return {
      onFrame: (_side, t) => {
        at = t;
        if (performance.now() - last >= 100) go();
        else timer ??= setTimeout(go, 100);
      },
      stop: () => { clearTimeout(timer); timer = null; },
    };
  }, [bridge]);
  const onFrame = seeker.onFrame;
  useEffect(() => (watch ? seeker.stop : undefined), [watch, seeker]);
  if (watch) {
    // Esc leaves Watch (the innermost layer) and goes no further: the panel stays open.
    return h("div", { className: "carton-sidebar-watch", onKeyDown: (e) => { if (e.key === "Escape") { e.stopPropagation(); back(); } } },
      h(Button, { variant: "ghost", icon: "arrowLeft", onClick: back, title: "Back to History (Esc)" }, words.history),
      h(WatchTheChanges, { a: watch.a, b: watch.b, inPlayer: true, onFrame }));
  }
  return h("div", { ref: box, className: "carton-sidebar-history" },
    h("div", { className: "carton-sidebar-cuts" }, h(CutsMenu, { onFoldIn: (from, into) => setFold({ from: from.id, into: into.id }) })),
    h(HistoryPanel, { currentRef: current, onWatch: (a, b) => setWatch({ a, b }) }),
    fold ? h(FoldInDialog, { fromCutId: fold.from, intoCutId: fold.into, onClose: () => setFold(null) }) : null);
}

/** The project's timecoded comments (@carton/comments, served by the worker): pinned at the playhead, a timecode seeks. */
function useComments(projectId, bridge) {
  const conn = useMemo(() => {
    const client = projectId + ":c:" + Math.random().toString(36).slice(2);
    const r = remoteComments((message) => bridge.call("comments", [{ projectId, client, message }]).catch((e) => console.warn("[carton] comments lost the worker:", e?.message ?? e)));
    const off = bridge.onEvent((ev) => { if (ev?.client === client && ev.message) r.receive(ev.message); });
    return { ...r, close: off };
  }, [projectId, bridge]);
  useEffect(() => { injectCommentsSkin(document); return () => { if (typeof conn.close === "function") conn.close(); }; }, [conn]);
  return conn;
}
function CommentsSide({ projectId, bridge }) {
  const conn = useComments(projectId, bridge);
  const [selected, setSelected] = useState(null);
  return h(CommentsPanel, { className: "carton-sidebar-comments", comments: conn.ui, at: () => bridge.playhead?.() ?? null, onSeek: (t) => bridge.seek?.(t), selected, onSelect: setSelected });
}

/** The chat sidebar's resize handle: drag its left edge. The width is kept for next time. */
function useWidth() {
  const [width, setWidth] = useState(() => {
    const w = Number(globalThis.localStorage?.getItem(WIDTH.key));
    return Number.isFinite(w) && w >= WIDTH.min && w <= WIDTH.max ? w : WIDTH.initial;
  });
  const onPointerDown = (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const x0 = e.clientX, w0 = width, el = e.currentTarget;
    el.setPointerCapture(e.pointerId);
    let last = w0;
    const move = (m) => { last = Math.min(WIDTH.max, Math.max(WIDTH.min, w0 + (x0 - m.clientX))); setWidth(last); };
    const up = () => {
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerup", up);
      el.removeEventListener("pointercancel", up);
      try { globalThis.localStorage?.setItem(WIDTH.key, String(Math.round(last))); } catch {}
    };
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", up);
    el.addEventListener("pointercancel", up);
  };
  return [width, onPointerDown];
}

// A throw in Carton's part of the editor stays in it (UI audit P1-1): where nothing caught it before, Cardboard replaced
// the editor's whole tab ("This tab hit a snag"). The side panel says so, with Try again; the layer over the stage
// (preview banner, conflict cards, the footage notice) shows a small Try again in its corner, over nothing else.
// Logged as an `error` with the surface; another panel, or Try again, renders it anew. Cardboard's own preview has
// the same kind of boundary.
export class CartonBoundary extends Component {
  constructor(p) { super(p); this.state = { error: null }; }
  static getDerivedStateFromError(error) { return { error }; }
  componentDidCatch(error) { window.__cbLog?.("error", { msg: String(error?.message ?? error).slice(0, 300), src: "carton-ui.js", panel: this.props.panel }); }
  render() {
    if (!this.state.error) return this.props.children;
    const again = h(Button, { onClick: () => this.setState({ error: null }) }, "Try again");
    if (this.props.panel === "stage")
      return h("div", { className: "carton-stage-snag", role: "alert" }, h("span", null, "Conflict cards and the preview banner hit a snag."), again);
    return h("div", { className: "flex flex-col items-start gap-2 p-4 text-sm text-muted-foreground", role: "alert" },
      h("p", null, "This panel hit a snag. Nothing you’ve made is lost."),
      again);
  }
}

function Sidebar({ panel, setPanel, projectId, bridge }) {
  const ref = useRef(null);
  const [preferred, onResize] = useWidth();
  const fit = useFit(ref, preferred);
  const width = fit.width;
  // A drawer over the chat when the window is too narrow for the preview, the panel and the chat side by side.
  const overlay = fit.mode === "overlay" ? { position: "fixed", right: 0, top: fit.top ?? 0, height: fit.height ?? "100%", zIndex: 40, boxShadow: "-16px 0 40px -12px #000000b3" } : null;
  const share = window.__cartonSyncUi?.SharePanel ?? null;
  // Esc closes it, and only while focus is in it: the editor's own keys are never taken. A preview is the layer inside
  // it (UI audit P2-1: "… → preview → panel"): Esc returns from the preview first, as its banner's button does, and
  // the next Esc closes the panel (regress 2026-11-02 #4: it closed the panel and left the preview open).
  const ui = useCartonUi();
  const onKeyDown = (e) => {
    // an Esc a handler nearer the page took (a Radix layer's, in the capture phase) is theirs: nothing here
    if (e.key !== "Escape" || e.defaultPrevented || e.nativeEvent?.defaultPrevented) return;
    e.stopPropagation();
    if (ui.preview?.()) { void ui.openPreview(null); return; }
    setPanel(null);
  };
  useEffect(() => { ref.current?.focus({ preventScroll: true }); }, [panel]);
  const tabs = share ? ["history", "comments", "share"] : ["history", "comments"];
  // Below 340 px three labelled tabs run under the close ✕ ("Share✕" at the 300 px minimum: regress 2026-11-02 P3-3):
  // the tabs not open show their icon only, named for screen readers and on hover; the open one keeps its label.
  const compact = tabs.length > 2 && width < 340;
  // Cardboard's own classes, as its chat sidebar uses them: same width, rule, handle, header and buttons.
  return h("aside", { ref, tabIndex: -1, className: "carton-sidebar relative shrink-0 overflow-hidden bg-[var(--desktop-panel)] outline-none", style: { width, ...overlay }, "data-carton-skin": "cardboard", "data-fit": fit.mode, "aria-label": PANELS[panel].label, onKeyDown },
    h("div", { className: "pointer-events-none absolute inset-y-0 left-0 z-10 w-px bg-white/[0.06]" }),
    h("div", { className: "relative flex h-full flex-col", style: { width } },
      h("div", { className: "group absolute top-0 bottom-0 left-0 z-10 w-1", style: { cursor: "col-resize" }, onPointerDown: onResize, role: "separator", "aria-orientation": "vertical", "aria-label": "Resize" },
        h("div", { className: "pointer-events-none absolute inset-y-0 left-1/2 w-1 -translate-x-1/2 bg-accent/80 opacity-0 transition-opacity group-hover:opacity-100" })),
      h("div", { className: "flex h-[40px] shrink-0 items-center gap-[2px] pr-[16px] pl-[12px]" },
        h("div", { className: "flex min-w-0 flex-1 items-center gap-[2px]", role: "tablist" },
          ...tabs.map((id) => h("button", {
            key: id, type: "button", role: "tab", "aria-selected": panel === id, "aria-label": PANELS[id].label, onClick: () => setPanel(id), title: PANELS[id].key ? `${PANELS[id].label} (${PANELS[id].key})` : compact ? PANELS[id].label : undefined, "aria-keyshortcuts": PANELS[id].key ? "Control+Shift+H" : undefined,
            className: "relative flex h-[26px] shrink-0 cursor-pointer items-center gap-[6px] rounded-ui-md px-[8px] text-ui-sm font-medium outline-none transition-colors focus-visible:ring-2 focus-visible:ring-white/30 " +
              (panel === id ? "bg-white/[0.07] text-foreground" : "text-muted-foreground hover:bg-foreground/[0.06] hover:text-foreground"),
          }, h(Icon, { name: PANELS[id].icon, size: 14 }), compact && panel !== id ? null : PANELS[id].label))),
        h("button", { type: "button", "aria-label": "Close", title: "Close (Esc)", onClick: () => setPanel(null),
          className: "flex size-control-sm shrink-0 cursor-pointer items-center justify-center rounded-ui-md text-muted-foreground outline-none transition-colors hover:bg-foreground/[0.06] hover:text-foreground focus-visible:ring-2 focus-visible:ring-white/30" },
          h(Icon, { name: "x", size: 16 }))),
      h("div", { className: "carton-sidebar-body relative flex min-h-0 flex-1 flex-col overflow-x-hidden overflow-y-auto" },
        h(CartonBoundary, { key: panel, panel }, panel === "share" && share ? h(share, { projectId, active: true, bridge }) : panel === "comments" ? h(CommentsSide, { projectId, bridge }) : h(HistorySide, { bridge })))));
}

/** The side panel, beside the chat: opened and closed from the title bar's icons, which show the one open. */
export const CartonSide = memo(function CartonSide({ projectId, bridge }) {
  const [conn] = useConn(projectId, bridge);
  const [panel, setPanelState] = useState(null);
  const setPanel = useCallback((p) => setPanelState(p), []);
  // Ctrl+Shift+H (Cmd+Shift+H on a Mac) opens and closes History (UI audit P3-7): H is free in Cardboard's keymap,
  // and Shift with Ctrl/Cmd pairs it with Cardboard's own Ctrl+Shift+B ("Report an issue"). Only the editor's page
  // listens (this panel lives there), and only for that exact chord.
  useEffect(() => {
    const onKey = (e) => {
      if (!(e.ctrlKey || e.metaKey) || !e.shiftKey || e.altKey || (e.code !== "KeyH" && e.key !== "H" && e.key !== "h")) return;
      e.preventDefault();
      e.stopPropagation();
      setPanelState((p) => (p === "history" ? null : "history"));
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);
  // The title bar's icons: the same icon again closes it.
  useEffect(() => bridge.onCommand?.((ev) => {
    const which = ev?.action === "carton-history" ? "history" : ev?.action === "carton-share" ? "share" : null;
    if (which) setPanelState((p) => (p === which ? null : which));
  }), [bridge]);
  useEffect(() => { panelRequests.add(setPanelState); return () => { panelRequests.delete(setPanelState); }; }, []);
  // Tell the title bar which is open (null: none, which also says the icons apply to this tab), and the stage layer.
  // With a shared project's live summary for the strip's status dot and avatars (P2-11); sent again only when what it
  // shows changes.
  const summary = liveSummary(useLiveStatus(projectId, bridge));
  const summaryKey = summary ? JSON.stringify(summary) : "";
  useEffect(() => { bridge.reportPanel?.(panel, summaryKey ? JSON.parse(summaryKey) : undefined); sidePanel.set(panel); }, [bridge, panel, summaryKey]);
  useEffect(() => () => sidePanel.set(null), []);
  if (!panel) return null;
  return h(CartonProvider, { ui: conn.ui }, h(Sidebar, { panel, setPanel, projectId, bridge }));
});

/**
 * Opening a shared project whose footage is a teammate's (UI audit P1-9; the editor patch in sync/patches/media.js
 * keeps Cardboard's "Missing Media Files" and its "Remove and Open" away from those clips): what happened, in words.
 * Clips not sent yet show as Offline; it checks every 15 s and says when they have arrived. Closed with its ✕ or Esc.
 */
function MediaNotice({ projectId, bridge }) {
  const [here, setHere] = useState(() => (window.__cartonMediaHere?.projectId === projectId ? window.__cartonMediaHere : null));
  const [closed, setClosed] = useState(false);
  const [arrived, setArrived] = useState(false);
  useEffect(() => {
    const f = (e) => { if (e.detail?.projectId === projectId) { setHere(e.detail); setClosed(false); setArrived(false); } };
    window.addEventListener("carton:media-here", f);
    return () => window.removeEventListener("carton:media-here", f);
  }, [projectId]);
  const waiting = here?.waiting ?? [];
  useEffect(() => {
    if (closed || arrived || !waiting.length || here?.unchecked) return undefined;
    const t = setInterval(() => {
      bridge.call("liveMediaHere", [{ projectId, mediaIds: waiting.map((w) => w.mediaId) }]).then((r) => {
        if (r?.clips && waiting.every((w) => r.clips[w.mediaId] === "playable")) setArrived(true);
      }, () => {});
    }, 15000);
    return () => clearInterval(t);
  }, [bridge, projectId, waiting, closed, arrived]);
  if (closed || !here || (!waiting.length && !here.playable)) return null;
  const names = waiting.slice(0, 2).map((w) => w.fileName).join(", ") + (waiting.length > 2 ? ` and ${waiting.length - 2} more` : "");
  const text = here.unchecked
    ? `${waiting.length === 1 ? `${names} couldn't be checked, so it shows` : `${waiting.length} clips couldn't be checked (${names}), so they show`} as Offline. Nothing was removed. Close and reopen the project to check again.`
    : arrived
    ? "Your teammate's footage has arrived. Close and reopen the project to play it."
    : waiting.length === 1
      ? `${names} hasn't arrived yet. It shows as Offline until your teammate's computer sends it. Nothing was removed.`
      : waiting.length
        ? `${waiting.length} clips haven't arrived yet (${names}). They show as Offline until your teammate's computer sends them. Nothing was removed.`
        : "This video plays from preview copies. Its originals stay on your teammate's computer.";
  return h("div", { className: "carton-media-notice", role: "status", "data-waiting": waiting.length && !arrived ? "" : undefined, onKeyDown: (e) => { if (e.key === "Escape") { e.stopPropagation(); setClosed(true); } } },
    h(Icon, { name: waiting.length && !arrived ? "cloudSlash" : "cloudCheck", size: 14 }),
    h("span", { className: "carton-media-notice-text" }, text),
    h(Button, { variant: "ghost", icon: "x", label: words.close, onClick: () => setClosed(true) }));
}

/**
 * A shared project's status where it is always seen (UI audit P2-11: it was only inside the Share tab): who else is
 * here, and Offline or Syncing while edits wait, in the preview's bottom-left corner. Up to date with nobody else here,
 * nothing. A click opens Share. Status words only (§0.1).
 */
/** A shared project's live status (the worker's liveStatus, then its live events), or null. */
function useLiveStatus(projectId, bridge) {
  const [st, setSt] = useState(null);
  useEffect(() => {
    let live = true;
    bridge.call("liveStatus", [{ projectId }]).then((s) => live && setSt(s), () => {});
    const off = bridge.onEvent((ev) => { if (live && ev?.id === projectId && ev.topic === "live") setSt((s) => ({ ...s, ...ev.live })); });
    return () => { live = false; if (typeof off === "function") off(); };
  }, [projectId, bridge]);
  return st;
}
const livePeers = (st) => (Array.isArray(st?.peers) ? st.peers : []).filter((p) => typeof p?.actor?.key === "string" && typeof p.actor.name === "string");
const hereWords = (peers) => (peers.length ? `${peers.map((p) => p.actor.name).slice(0, 3).join(", ")}${peers.length > 3 ? ` and ${peers.length - 3} more` : ""} ${peers.length === 1 ? "is" : "are"} here` : "");
/**
 * The title bar's summary of a shared project (UI audit P2-11): its sync state and words, and up to three of the
 * people here, as the strip draws them (scripts/carton/strip-buttons.js). Null for a project that isn't shared.
 */
export function liveSummary(st) {
  if (!st?.shared) return null;
  const peers = livePeers(st);
  const offline = st.status === "offline" || st.status === "stopped", waiting = st.pending ?? 0;
  const state = offline ? "offline" : st.status !== "up-to-date" || waiting ? "syncing" : "ok";
  return {
    state,
    words: offline ? words.offline(waiting) : state === "syncing" ? words.syncing : words.upToDate,
    here: hereWords(peers),
    people: peers.slice(0, 3).map((p) => ({ name: p.actor.name, initials: initials(p.actor.name), color: actorColor(p.actor), idle: !!p.idle })),
    more: Math.max(0, peers.length - 3),
  };
}
function LiveChip({ projectId, bridge }) {
  const st = useLiveStatus(projectId, bridge);
  return h(LiveChipView, { st, onOpen: () => { for (const f of panelRequests) f("share"); } });
}
// Over the preview, only while edits wait (offline or sending): who is here shows in the title bar (P2-11).
function LiveChipView({ st, onOpen, peersToo = false }) {
  if (!st?.shared) return null;
  const peers = peersToo ? livePeers(st) : [];
  const offline = st.status === "offline" || st.status === "stopped";
  const waiting = st.pending ?? 0;
  const status = offline ? words.offline(waiting) : st.status !== "up-to-date" && waiting ? words.syncing : null;
  if (!status && !peers.length) return null;
  const here = hereWords(peers);
  return h("button", { type: "button", className: "carton-live-chip", "data-state": offline ? "offline" : status ? "syncing" : "ok", title: [status, here].filter(Boolean).join(" · ") + ". Open Share", "aria-label": [status, here].filter(Boolean).join(". ") + ". Open Share", onClick: onOpen },
    status ? h(Icon, { name: offline ? "cloudSlash" : "syncing", size: 14 }) : null,
    status ? h("span", null, status) : null,
    peers.length ? h("span", { className: "carton-live-peers", "aria-hidden": true }, ...peers.slice(0, 3).map((p) => h("span", { key: p.actor.key, className: "carton-avatar", "data-idle": p.idle ? "" : undefined, style: { ["--carton-actor"]: actorColor(p.actor), width: 20, height: 20, fontSize: 8 } }, h("span", { className: "carton-avatar-initials" }, initials(p.actor.name)))),
      peers.length > 3 ? h("span", { className: "carton-live-more" }, `+${peers.length - 3}`) : null) : null);
}

/**
 * Join a shared project from the Dashboard (UI audit P2-9): its tile (sync/patches/ui.js) opens this dialog, which holds
 * the Share panel's Join form; once joined, Open opens the project in its tab and the dialog closes.
 */
export function JoinDialog({ bridge, onClose }) {
  useEffect(() => { injectCardboardSkin(document); }, []);
  const Join = window.__cartonSyncUi?.Join;
  return h("div", { "data-carton-skin": "cardboard" },
    h(Dialog, { title: "Join a shared project", onClose, className: "carton-join-dialog" },
      h("p", { className: "carton-join-lead" }, "Paste the invite link a teammate sent you. The project comes with its history; its footage arrives as their computer sends it."),
      Join ? h(Join, { bridge, startOpen: true, onOpened: onClose, onCancel: onClose }) : h("p", { className: "carton-error", role: "alert" }, words.failed)));
}

/** The layer over the stage: the conflict cards' floating stack, the preview banner, and the shared-footage notice. */
export const CartonStage = memo(function CartonStage({ projectId, bridge }) {
  const [conn, ready] = useConn(projectId, bridge);
  // what the bridge tells the person (a save that failed, an undo refused), as a toast over the stage
  useEffect(() => bridge.onNotice?.(tellFailure), [bridge]);
  // A conflict card's "See it" (docs/carton-ux PLAN 7.1): the side's timeline, read-only, with the card's clip in view,
  // so the difference is on screen, under the card's label for that side ("Claude Code's move of “Interview B”"). It
  // still goes through the deprecated openPreview (conflictRef's state, the bridge's preview) until ui.view({kind:
  // "conflict"}) reaches the editor: the worker's view() (Workstream 0, PLAN 0.5) and the stage frame that shows its
  // label (Workstream 1). Then this goes, and the card calls ui.view itself.
  const onPreview = useCallback(async (conflict, side, label) => {
    const ref = await conn.ui.conflictRef?.(conflict.id, side).catch(() => null);
    if (!ref) throw new Error(words.loadFailed);
    await conn.ui.openPreview(ref, label);
    if (conflict.item) bridge.reveal(conflict.item);
  }, [conn, bridge]);
  const onReveal = useCallback((conflict) => { if (conflict.item) bridge.reveal(conflict.item); }, [bridge]);
  const [panelOpen, setPanelOpen] = useState(sidePanel.value != null);
  useEffect(() => {
    const f = (v) => setPanelOpen(v != null);
    sidePanel.subs.add(f);
    return () => { sidePanel.subs.delete(f); };
  }, []);
  if (!ready) return null;
  return h(CartonProvider, { ui: conn.ui },
    h("div", { className: "carton-stage", "data-carton-skin": "cardboard" }, h(CartonBoundary, { panel: "stage" },
      h("div", { className: "carton-stage-banner" }, h(PreviewBanner, { escapeState: bridge.selection }), h(MediaNotice, { projectId, bridge })),
      h("div", { className: "carton-stage-stack" }, h(ConflictStack, { onPreview, onReveal, collapsed: panelOpen })),
      h("div", { className: "carton-stage-toast" }, h(Toast)),
      h("div", { className: "carton-stage-live" }, h(LiveChip, { projectId, bridge })))));
});
export const __forTests = { confirmations, toasts, tellFailure, Toast, LiveChipView, MediaNotice, Sidebar, CartonProvider };
