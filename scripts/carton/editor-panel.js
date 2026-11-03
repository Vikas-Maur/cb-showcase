// Carton in the editor bundle (EditorRoute-*.js), prepended by patch-carton.js (scripts/carton/ui.js has the parts):
// - __cbCartonSide: the History or Share panel, a full-height column beside the agent's chat sidebar, opened from the
//   title bar's icons.
// - __cbCartonStageHost: the stage (the preview's column, above the timeline, left of the chat), as Cardboard renders
//   it but `relative`, plus a layer with the conflict cards' floating stack and the preview banner. It covers exactly
//   the stage, never the timeline's controls or the chat.
// - __cbCartonTimeline: the timeline's wrapper (Carton UX redesign PLAN 1.5), Cardboard's own display:contents div, with
//   data-carton-viewing while viewing (the timeline's frame, its clips muted) and data-carton-cut with the cut's name
//   and dot on a cut other than Main, as the stage's Carton layer publishes them (scripts/carton/ui.js StageViewing,
//   through window.__cartonTimelineMark). Rendered with Carton on or off; off, nothing publishes, and it is
//   Cardboard's div exactly, with nothing loaded.
// - The editor waits (at most 2 s, once) for main to say whether Carton is on. With it off, patch-carton.js renders
//   Cardboard's own stage div and no side column, and nothing here runs but the timeline's plain div.
// - Both load carton-ui.js (@carton/react with Cardboard's skin) at the editor's first render, on the editor's own
//   React (`o` in this bundle), so Carton's components run in the editor's tree, theme and portals.
// - The live-sync half (sync/patches/ui.js) adds __cbCartonPresence: the person's presence while the editor is open.
module.exports = String.raw`await Promise.race([window.__carton?.ready, new Promise((r) => setTimeout(r, 2000))]);
const __cbCartonUi = { mod: null, load: null };
function __cbCartonModule() {
  const [m, setM] = o.useState(__cbCartonUi.mod);
  o.useEffect(() => {
    if (m) return undefined;
    let live = true;
    window.__cartonReact = o;
    (__cbCartonUi.load ??= import("./carton-ui.js")).then((x) => { __cbCartonUi.mod = x; if (live) setM(x); }, (e) => console.warn("[carton] the History panel did not load:", e?.message ?? e));
    return () => { live = false; };
  }, [m]);
  return m;
}
function __cbCartonStageHost({ className, children }) {
  const m = __cbCartonModule();
  const projectId = window.__carton?.projectId ?? null;
  o.useEffect(() => (typeof __cbCartonPresence === "function" ? __cbCartonPresence(projectId) : undefined), [projectId]);
  // data-carton-stage-host: the side panel measures the preview's room by it (scripts/carton/ui.js, fitPanel).
  return c.jsxs("div", { className: className + " relative", "data-carton-stage-host": "", children: [children, m && projectId ? c.jsx(m.CartonStage, { projectId, bridge: window.__carton }, projectId) : null] });
}
// What the timeline shows besides Cardboard's own: { projectId, viewing, cut, dot }, or null. One value for the page;
// the wrapper re-renders only when it changes, and its child (the timeline) is the same element, so it doesn't.
const __cbCartonMark = { value: null, subs: new Set() };
window.__cartonTimelineMark = (v) => {
  __cbCartonMark.value = v ?? null;
  for (const f of [...__cbCartonMark.subs]) f(__cbCartonMark.value);
};
function __cbCartonTimeline(props) {
  const [mark, setMark] = o.useState(__cbCartonMark.value);
  o.useEffect(() => {
    __cbCartonMark.subs.add(setMark);
    setMark(__cbCartonMark.value);
    return () => { __cbCartonMark.subs.delete(setMark); };
  }, []);
  const m = window.__carton?.on && mark && mark.projectId === (window.__carton?.projectId ?? null) ? mark : null;
  if (!m || (!m.viewing && !m.cut)) return c.jsx("div", props);
  return c.jsx("div", { ...props, "data-carton-viewing": m.viewing ? "" : void 0, "data-carton-cut": m.cut || void 0, style: m.cut ? { "--carton-cut-label": JSON.stringify(String(m.cut)), "--carton-cut-dot": m.dot || "#f59e0b" } : void 0 });
}
function __cbCartonSide() {
  const m = __cbCartonModule();
  const projectId = window.__carton?.projectId ?? null;
  return m && projectId ? c.jsx(m.CartonSide, { projectId, bridge: window.__carton }, projectId) : null;
}
`;
