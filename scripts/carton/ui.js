// carton-ui.js: the History panel in Cardboard's editor (scripts/carton/build.js bundles it with @carton/react).
// Carton runs in the library worker. There @carton/react's view model is served to each page (serveUi over the
// worker's carton namespace, scripts/carton/carton-node.js); here remoteUi mirrors it. Messages go out through the
// bridge's carton:call "ui" and come back as carton:event for this page's client id. Opening a version previews it
// read-only in the editor itself (the bridge's preview), which "Return to current" ends.
import { createElement as h, useEffect, useMemo, useState } from "react";
import { CartonProvider, HistoryPanel, PreviewBanner, ConflictList, remoteUi } from "@carton/react";
import { injectCardboardSkin } from "@carton/react/skin/cardboard";

function connect(projectId, bridge) {
  const client = projectId + ":" + Math.random().toString(36).slice(2);
  const r = remoteUi((message) => bridge.call("ui", [{ projectId, client, message }]).catch((e) => console.warn("[carton] the History panel lost the worker:", e?.message ?? e)));
  const off = bridge.onEvent((ev) => { if (ev?.client === client && ev.message) r.receive(ev.message); });
  // Opening a version: the editor shows it read-only; null returns to current.
  const openPreview = r.ui.openPreview.bind(r.ui);
  r.ui.openPreview = (ref, label) => { openPreview(ref, label); bridge.preview(projectId, ref ?? null); };
  return { ...r, close: off };
}

export function CartonPanel({ projectId, active, bridge }) {
  const conn = useMemo(() => connect(projectId, bridge), [projectId, bridge]);
  const [ready, setReady] = useState(false);
  useEffect(() => { injectCardboardSkin(document); conn.ready.then(() => setReady(true)); return () => conn.close(); }, [conn]);
  if (!active || !ready) return null;
  return h(CartonProvider, { ui: conn.ui }, h("div", { className: "carton-panel flex h-full flex-col overflow-hidden", "data-carton-skin": "cardboard" }, h(PreviewBanner, {}), h(ConflictList, {}), h(HistoryPanel, {})));
}
