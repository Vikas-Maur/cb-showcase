// Carton in the editor bundle (EditorRoute-*.js), prepended by patch-carton.js (scripts/carton/ui.js has the parts):
// - __cbCartonSide: the History or Share panel, a full-height column beside the agent's chat sidebar, opened from the
//   title bar's icons.
// - __cbCartonStageHost: the stage (the preview's column, above the timeline, left of the chat), as Cardboard renders
//   it but `relative`, plus a layer with the conflict cards' floating stack and the preview banner. It covers exactly
//   the stage, never the timeline's controls or the chat.
// - The editor waits (at most 2 s, once) for main to say whether Carton is on. With it off, patch-carton.js renders
//   Cardboard's own stage div and no side column, and nothing here runs.
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
  return c.jsxs("div", { className: className + " relative", children: [children, m && projectId ? c.jsx(m.CartonStage, { projectId, bridge: window.__carton }, projectId) : null] });
}
function __cbCartonSide() {
  const m = __cbCartonModule();
  const projectId = window.__carton?.projectId ?? null;
  return m && projectId ? c.jsx(m.CartonSide, { projectId, bridge: window.__carton }, projectId) : null;
}
`;
