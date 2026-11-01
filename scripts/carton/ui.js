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
import { createElement as h, memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button, CartonProvider, CommentsPanel, ConflictStack, CutsMenu, FoldInDialog, HistoryPanel, Icon, PreviewBanner, WatchTheChanges, injectCommentsSkin, remoteComments, remoteUi, useCuts, words } from "@carton/react";
import { injectCardboardSkin } from "@carton/react/skin/cardboard";

function connect(projectId, bridge) {
  const client = projectId + ":" + Math.random().toString(36).slice(2);
  const r = remoteUi((message) => bridge.call("ui", [{ projectId, client, message }]).catch((e) => console.warn("[carton] the History panel lost the worker:", e?.message ?? e)));
  const off = bridge.onEvent((ev) => { if (ev?.client === client && ev.message) r.receive(ev.message); });
  // Opening a version: the editor shows it read-only; null returns to current.
  const openPreview = r.ui.openPreview.bind(r.ui);
  r.ui.openPreview = (ref, label) => { openPreview(ref, label); return bridge.preview(projectId, ref ?? null); };
  return { ...r, close: off };
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

const PANELS = { history: { label: "History", icon: "history" }, comments: { label: "Comments", icon: "comment" }, share: { label: "Share", icon: "users" } };
// Which side panel is open, for the stage layer of this page (both parts live in this module, so it stays in it): the
// card stack folds to its pill while a panel takes the room beside the chat.
const sidePanel = { value: null, subs: new Set(), set(v) { this.value = v; for (const f of this.subs) f(v); } };
const WIDTH = { key: "carton.sidePanelWidth", min: 300, max: 640, initial: 384 };

/**
 * History in the side panel: the cut it shows, with its switcher (switch, New cut, rename, Fold into…, which opens
 * Fold in: all, some or none of it), then the versions, Compare with current, and "Watch the changes" in their place.
 */
function HistorySide() {
  const cuts = useCuts();
  const [watch, setWatch] = useState(null);
  const [fold, setFold] = useState(null);
  const current = cuts.find((c) => c.current)?.head;
  if (watch) {
    return h("div", { className: "carton-sidebar-watch" },
      h(Button, { variant: "ghost", icon: "arrowLeft", onClick: () => setWatch(null) }, words.history),
      h(WatchTheChanges, { a: watch.a, b: watch.b }));
  }
  return h("div", { className: "carton-sidebar-history" },
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

function Sidebar({ panel, setPanel, projectId, bridge }) {
  const ref = useRef(null);
  const [width, onResize] = useWidth();
  const share = window.__cartonSyncUi?.SharePanel ?? null;
  // Esc closes it, and only while focus is in it: the editor's own keys are never taken.
  const onKeyDown = (e) => {
    if (e.key !== "Escape") return;
    e.stopPropagation();
    setPanel(null);
  };
  useEffect(() => { ref.current?.focus({ preventScroll: true }); }, [panel]);
  const tabs = share ? ["history", "comments", "share"] : ["history", "comments"];
  // Cardboard's own classes, as its chat sidebar uses them: same width, rule, handle, header and buttons.
  return h("aside", { ref, tabIndex: -1, className: "carton-sidebar relative shrink-0 overflow-hidden bg-[var(--desktop-panel)] outline-none", style: { width }, "data-carton-skin": "cardboard", "aria-label": PANELS[panel].label, onKeyDown },
    h("div", { className: "pointer-events-none absolute inset-y-0 left-0 z-10 w-px bg-white/[0.06]" }),
    h("div", { className: "relative flex h-full flex-col", style: { width } },
      h("div", { className: "group absolute top-0 bottom-0 left-0 z-10 w-1", style: { cursor: "col-resize" }, onPointerDown: onResize, role: "separator", "aria-orientation": "vertical", "aria-label": "Resize" },
        h("div", { className: "pointer-events-none absolute inset-y-0 left-1/2 w-1 -translate-x-1/2 bg-accent/80 opacity-0 transition-opacity group-hover:opacity-100" })),
      h("div", { className: "flex h-[40px] shrink-0 items-center gap-[2px] pr-[16px] pl-[12px]" },
        h("div", { className: "flex min-w-0 flex-1 items-center gap-[2px]", role: "tablist" },
          ...tabs.map((id) => h("button", {
            key: id, type: "button", role: "tab", "aria-selected": panel === id, onClick: () => setPanel(id),
            className: "relative flex h-[26px] shrink-0 cursor-pointer items-center gap-[6px] rounded-ui-md px-[8px] text-ui-sm font-medium outline-none transition-colors focus-visible:ring-2 focus-visible:ring-white/30 " +
              (panel === id ? "bg-white/[0.07] text-foreground" : "text-muted-foreground hover:bg-foreground/[0.06] hover:text-foreground"),
          }, h(Icon, { name: PANELS[id].icon, size: 14 }), PANELS[id].label))),
        h("button", { type: "button", "aria-label": "Close", title: "Close (Esc)", onClick: () => setPanel(null),
          className: "flex size-control-sm shrink-0 cursor-pointer items-center justify-center rounded-ui-md text-muted-foreground outline-none transition-colors hover:bg-foreground/[0.06] hover:text-foreground focus-visible:ring-2 focus-visible:ring-white/30" },
          h(Icon, { name: "x", size: 16 }))),
      h("div", { className: "carton-sidebar-body relative flex min-h-0 flex-1 flex-col overflow-x-hidden overflow-y-auto" },
        panel === "share" && share ? h(share, { projectId, active: true, bridge }) : panel === "comments" ? h(CommentsSide, { projectId, bridge }) : h(HistorySide, null))));
}

/** The side panel, beside the chat: opened and closed from the title bar's icons, which show the one open. */
export const CartonSide = memo(function CartonSide({ projectId, bridge }) {
  const [conn] = useConn(projectId, bridge);
  const [panel, setPanelState] = useState(null);
  const setPanel = useCallback((p) => setPanelState(p), []);
  // The title bar's icons: the same icon again closes it.
  useEffect(() => bridge.onCommand?.((ev) => {
    const which = ev?.action === "carton-history" ? "history" : ev?.action === "carton-share" ? "share" : null;
    if (which) setPanelState((p) => (p === which ? null : which));
  }), [bridge]);
  // Tell the title bar which is open (null: none, which also says the icons apply to this tab), and the stage layer.
  useEffect(() => { bridge.reportPanel?.(panel); sidePanel.set(panel); }, [bridge, panel]);
  useEffect(() => () => sidePanel.set(null), []);
  if (!panel) return null;
  return h(CartonProvider, { ui: conn.ui }, h(Sidebar, { panel, setPanel, projectId, bridge }));
});

/** The layer over the stage: the conflict cards' floating stack and the preview banner. */
export const CartonStage = memo(function CartonStage({ projectId, bridge }) {
  const [conn, ready] = useConn(projectId, bridge);
  const onPreview = useCallback(async (conflict, side, label) => {
    const ref = await conn.ui.conflictRef?.(conflict.id, side).catch(() => null);
    if (!ref) return;
    // the side's timeline, read-only, with the card's clip in view, so the difference is on screen
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
    h("div", { className: "carton-stage", "data-carton-skin": "cardboard" },
      h("div", { className: "carton-stage-banner" }, h(PreviewBanner, null)),
      h("div", { className: "carton-stage-stack" }, h(ConflictStack, { onPreview, onReveal, collapsed: panelOpen }))));
});
