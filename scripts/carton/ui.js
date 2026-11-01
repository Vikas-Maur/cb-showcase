// carton-ui.js: Carton in Cardboard's editor (scripts/carton/build.js bundles it with @carton/react), as one layer over
// the stage (the preview's column, above the timeline and left of the agent's chat; editor-panel.js mounts it there):
// - History and Share buttons at the stage's top-right;
// - the History or Share panel on the stage's right side when one is open (closing gives the stage back);
// - conflict cards as a floating stack in the stage's bottom-right corner, with "See it" (a side previewed read-only,
//   or its clip selected on the timeline);
// - the preview banner ("Return to current") at the top while an earlier version or a card's side is shown.
// The layer lets clicks through everywhere but its own controls, takes no keys but its own (Esc closes the panel), so
// the stage, the timeline's keyboard, Ctrl+Z and the agent's chat work as before.
// Carton runs in the library worker. There @carton/react's view model is served to each page (serveUi over the
// worker's carton namespace, scripts/carton/carton-node.js); here remoteUi mirrors it. Messages go out through the
// bridge's carton:call "ui" and come back as carton:event for this page's client id. A preview is the editor's own
// read-only one (the bridge's preview).
import { createElement as h, memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button, CartonProvider, ConflictStack, HistoryPanel, Icon, PreviewBanner, WatchTheChanges, remoteUi, useCuts, words } from "@carton/react";
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

const PANELS = { history: { label: "History", icon: "history" }, share: { label: "Share", icon: "users" } };

function ToolButton({ id, open, onToggle }) {
  return h("button", { type: "button", className: "carton-stage-btn", "data-panel": id, "aria-pressed": open, "aria-expanded": open, onClick: () => onToggle(id) },
    h(Icon, { name: PANELS[id].icon, size: 15 }), PANELS[id].label);
}

/** History in the side panel: the versions, Compare with current, and "Watch the changes" in place of the list. */
function HistorySide() {
  const cuts = useCuts();
  const [watch, setWatch] = useState(null);
  const current = cuts.find((c) => c.current)?.head;
  if (watch) {
    return h("div", { className: "carton-side-watch" },
      h(Button, { variant: "ghost", icon: "arrowLeft", onClick: () => setWatch(null) }, words.history),
      h(WatchTheChanges, { a: watch.a, b: watch.b }));
  }
  return h(HistoryPanel, { currentRef: current, onWatch: (a, b) => setWatch({ a, b }) });
}

function SidePanel({ panel, setPanel, projectId, bridge, share }) {
  const ref = useRef(null);
  // Esc closes it, and only while focus is in it: the editor's own keys are never taken.
  const onKeyDown = (e) => {
    if (e.key !== "Escape") return;
    e.stopPropagation();
    setPanel(null);
  };
  useEffect(() => { ref.current?.focus({ preventScroll: true }); }, [panel]);
  const tabs = share ? ["history", "share"] : ["history"];
  return h("aside", { ref, tabIndex: -1, className: "carton-side", "aria-label": PANELS[panel].label, onKeyDown },
    h("header", { className: "carton-side-head" },
      h("div", { className: "carton-side-tabs", role: "tablist" },
        ...tabs.map((id) => h("button", { key: id, type: "button", role: "tab", className: "carton-side-tab", "aria-selected": panel === id, onClick: () => setPanel(id) },
          h(Icon, { name: PANELS[id].icon, size: 14 }), PANELS[id].label))),
      h(Button, { variant: "ghost", icon: "x", label: "Close", title: "Close (Esc)", onClick: () => setPanel(null) })),
    h("div", { className: "carton-side-body" },
      panel === "share" && share ? h(share, { projectId, active: true, bridge }) : h(HistorySide, null)));
}

export const CartonStage = memo(function CartonStage({ projectId, bridge }) {
  const conn = useMemo(() => connect(projectId, bridge), [projectId, bridge]);
  const [ready, setReady] = useState(false);
  const [panel, setPanelState] = useState(null);
  useEffect(() => { injectCardboardSkin(document); conn.ready.then(() => setReady(true)); return () => conn.close(); }, [conn]);
  const setPanel = useCallback((p) => setPanelState(p), []);
  const toggle = useCallback((id) => setPanelState((p) => (p === id ? null : id)), []);
  // Share is the live-sync half's (sync/ui.js, bundled in when present).
  const share = window.__cartonSyncUi?.SharePanel ?? null;
  const onPreview = useCallback(async (conflict, side, label) => {
    const ref = await conn.ui.conflictRef?.(conflict.id, side).catch(() => null);
    if (!ref) return;
    // the side's timeline, read-only, with the card's clip in view, so the difference is on screen
    await conn.ui.openPreview(ref, label);
    if (conflict.item) bridge.reveal(conflict.item);
  }, [conn, bridge]);
  const onReveal = useCallback((conflict) => { if (conflict.item) bridge.reveal(conflict.item); }, [bridge]);
  const layer = h("div", { className: "carton-stage", "data-carton-skin": "cardboard", "data-panel": panel ?? undefined },
    ready ? h("div", { className: "carton-stage-banner" }, h(PreviewBanner, null)) : null,
    panel
      ? h(SidePanel, { panel, setPanel, projectId, bridge, share })
      : h("div", { className: "carton-stage-tools" },
          h(ToolButton, { id: "history", open: false, onToggle: toggle }),
          share ? h(ToolButton, { id: "share", open: false, onToggle: toggle }) : null),
    // with a panel open the stack folds to its pill, so the two never take the whole stage
    ready ? h("div", { className: "carton-stage-stack" }, h(ConflictStack, { onPreview, onReveal, collapsed: !!panel })) : null);
  return h(CartonProvider, { ui: conn.ui }, layer);
});
