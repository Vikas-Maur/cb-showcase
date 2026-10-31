// The Share panel (Invite to edit, Join, who is here, the status words): a "Share" tab beside patch-carton.js's
// "History" in the editor's left rail (EditorRoute-*.js), shown only with Carton on. Like History, it loads
// carton-ui.js the first time it shows (scripts/carton/sync/ui.js is bundled into it and sets
// window.__cartonSyncUi), on the editor's own React (`o` and `c` in this bundle; RY() says the panel is showing).
// Idle panels stay mounted, so the panel also sends the person's presence while the editor is open: at most once a
// second while they click or type, nothing after 30 s idle (§12), and only for a shared project.
const PREAMBLE = String.raw`function __cbCartonPresence(projectId) {
  const bridge = window.__carton;
  if (!bridge?.on || !projectId) return undefined;
  let shared = false, last = 0, stopped = false, timer = null;
  const send = (state) => bridge.call("livePresence", [{ projectId, state }]).catch(() => {});
  bridge.call("liveStatus", [{ projectId }]).then((s) => { shared = !!s?.shared; }, () => {});
  const off = bridge.onEvent((ev) => { if (ev?.id === projectId && ev.topic === "live") shared = !!ev.live?.shared; });
  const act = () => {
    if (!shared || stopped) return;
    clearTimeout(timer);
    timer = setTimeout(() => { last = 0; send(null); }, 30000);
    const now = Date.now();
    if (now - last < 1000) return;
    last = now;
    send({ activity: "Editing" });
  };
  const kinds = ["pointerdown", "keydown", "wheel"];
  for (const k of kinds) window.addEventListener(k, act, { passive: true, capture: true });
  return () => {
    stopped = true;
    clearTimeout(timer);
    if (typeof off === "function") off();
    for (const k of kinds) window.removeEventListener(k, act, { capture: true });
    if (last) send(null);
  };
}
function __cbCartonSharePanel({ projectId }) {
  const [m, setM] = o.useState(__cbCartonUi.mod);
  const active = RY();
  o.useEffect(() => __cbCartonPresence(projectId), [projectId]);
  o.useEffect(() => {
    if (m || !active) return;
    let live = true;
    window.__cartonReact = o;
    (__cbCartonUi.load ??= import("./carton-ui.js")).then((x) => { __cbCartonUi.mod = x; if (live) setM(x); }, (e) => console.warn("[carton] the Share panel did not load:", e?.message ?? e));
    return () => { live = false; };
  }, [m, active]);
  const P = m && window.__cartonSyncUi?.SharePanel;
  return P ? c.jsx(P, { projectId, active, bridge: window.__carton }) : null;
}
function __cbCartonShareIcon(p) {
  return c.jsxs("svg", { ...p, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 1.75, strokeLinecap: "round", strokeLinejoin: "round", children: [
    c.jsx("circle", { cx: 9, cy: 8, r: 3.5 }), c.jsx("path", { d: "M2.5 20a6.5 6.5 0 0 1 13 0" }), c.jsx("path", { d: "M16 4.6a3.5 3.5 0 0 1 0 6.8" }), c.jsx("path", { d: "M18.5 14.2A6.5 6.5 0 0 1 21.5 20" }),
  ] });
}
`;

module.exports = {
  app({ editor }) {
    editor.replace('label:"History",event:"carton_panel_opened"}]]:[]]', 'label:"History",event:"carton_panel_opened"},{id:"cartonShare",icon:__cbCartonShareIcon,label:"Share",event:"carton_share_panel_opened"}]]:[]]');
    editor.replace('"effects",...window.__carton?.on?["carton"]:[]].filter(', '"effects",...window.__carton?.on?["carton","cartonShare"]:[]].filter(');
    editor.replace('case"carton":return c.jsx(__cbCartonPanel,{projectId:t});', 'case"carton":return c.jsx(__cbCartonPanel,{projectId:t});case"cartonShare":return c.jsx(__cbCartonSharePanel,{projectId:t});');
    editor.prepend(PREAMBLE);
  },
};
