// carton-ui.js: the History panel in Cardboard's editor (scripts/carton/build.js bundles it with @carton/react).
// Carton runs in the library worker, so the panel's view model (@carton/react's CartonUi) is a proxy: each topic is
// read from the worker (carton:call "ui") and kept until a Carton event for this project says it changed; History is
// read in pages as the list scrolls; actions go to the worker. Opening a version previews it read-only in the editor
// itself (the bridge's preview), which "Return to current" ends.
import { createElement as h, useEffect, useMemo } from "react";
import { CartonProvider, HistoryPanel, PreviewBanner, ConflictList } from "@carton/react";

const TOPICS = ["sync", "cuts", "history", "peers", "ghosts", "conflicts", "undo", "published", "preview"];
const PAGE = 100;

function remoteUi(projectId, bridge) {
  const call = (op, args) => bridge.call("ui", { projectId, ...op, args });
  const cache = new Map(), listeners = new Map(), loading = new Set();
  const pages = new Map();
  let historyRev = 0, counts = {};
  const notify = (topic) => listeners.get(topic)?.forEach((f) => f());
  const load = (topic) => {
    if (loading.has(topic)) return;
    loading.add(topic);
    call({ read: topic }).then((v) => {
      if (topic === "history") { counts = v?.counts ?? {}; pages.clear(); historyRev++; }
      else cache.set(topic, v);
      notify(topic);
    }, (e) => console.warn("[carton] " + topic + ":", e?.message ?? e)).finally(() => loading.delete(topic));
  };
  const off = bridge.onEvent((ev) => { if (ev.id === projectId) for (const t of ev.topics ?? TOPICS) if (listeners.get(t)?.size) load(t); });
  const page = (filter, n) => {
    const key = filter + ":" + n;
    if (!pages.has(key)) {
      pages.set(key, null);
      call({ read: "historyPage", filter, from: n * PAGE, count: PAGE }).then((rows) => { pages.set(key, rows ?? []); historyRev++; notify("history"); });
    }
    return pages.get(key);
  };
  const history = {
    revision: () => historyRev,
    count: (filter) => counts[filter] ?? 0,
    at: (filter, i) => page(filter, Math.floor(i / PAGE))?.[i % PAGE],
    indexOf: (filter, id) => { for (const [k, rows] of pages) if (k.startsWith(filter + ":") && rows) { const j = rows.findIndex((v) => v.id === id); if (j >= 0) return Number(k.split(":")[1]) * PAGE + j; } return -1; },
  };
  const act = (name) => (...args) => call({ act: name }, args);
  return {
    close: off,
    subscribe(topic, f) {
      if (!listeners.has(topic)) listeners.set(topic, new Set());
      listeners.get(topic).add(f);
      if (!cache.has(topic) && topic !== "history") load(topic);
      if (topic === "history" && historyRev === 0) load("history");
      return () => listeners.get(topic).delete(f);
    },
    sync: () => cache.get("sync") ?? "local",
    cuts: () => cache.get("cuts") ?? [],
    history: () => history,
    peers: () => cache.get("peers") ?? [],
    ghosts: () => cache.get("ghosts") ?? [],
    conflicts: () => cache.get("conflicts") ?? [],
    undoTurn: () => cache.get("undo") ?? null,
    published: () => cache.get("published") ?? null,
    preview: () => cache.get("preview") ?? null,
    me: () => cache.get("me") ?? { key: "person", kind: "human", name: "You" },
    actor: (key) => cache.get("actors")?.[key],
    compare: act("compare"),
    credits: act("credits"),
    shotDiff: act("shotDiff"),
    planFold: act("planFold"),
    switchCut: act("switchCut"),
    newCut: act("newCut"),
    renameCut: act("renameCut"),
    fold: act("fold"),
    resolve: act("resolve"),
    restore: act("restore"),
    nameVersion: act("nameVersion"),
    undo: act("undo"),
    publish: act("publish"),
    openPreview: (ref, label) => {
      cache.set("preview", ref == null ? null : { ref, label });
      notify("preview");
      bridge.preview(projectId, ref ?? null);
    },
  };
}

export function CartonPanel({ projectId, active, bridge }) {
  const ui = useMemo(() => remoteUi(projectId, bridge), [projectId, bridge]);
  useEffect(() => () => ui.close(), [ui]);
  if (!active) return null;
  return h(CartonProvider, { ui }, h("div", { className: "carton-panel flex h-full flex-col overflow-hidden" }, h(PreviewBanner, {}), h(ConflictList, {}), h(HistoryPanel, { onOpen: (v) => ui.openPreview(v.ref ?? v.id, v.name ?? v.summary) })));
}
