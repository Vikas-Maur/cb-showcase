// Carton's layer over the editor's stage (EditorRoute-*.js), prepended by patch-carton.js: History and Share at the
// stage's top-right, their panel on its right side, and the conflict cards' floating stack (scripts/carton/ui.js).
// - The editor waits (at most 2 s, once) for main to say whether Carton is on. With it off, patch-carton.js's stage
//   patch renders Cardboard's own div, unchanged, and nothing here runs.
// - The stage (the preview's column, above the timeline and left of the agent's chat) renders through
//   __cbCartonStageHost with Carton on: Cardboard's div and children as they are, made `relative`, plus the layer. So
//   the layer covers exactly the stage, never the timeline's controls or the chat.
// - The layer loads carton-ui.js (@carton/react with Cardboard's skin) at the editor's first render, on the editor's
//   own React (`o` in this bundle), so Carton's components run in the editor's tree, theme and portals.
// - The live-sync half (sync/patches/ui.js) adds __cbCartonPresence: the person's presence while the editor is open.
module.exports = String.raw`await Promise.race([window.__carton?.ready, new Promise((r) => setTimeout(r, 2000))]);
const __cbCartonUi = { mod: null, load: null };
function __cbCartonStageHost({ className, children }) {
  const [m, setM] = o.useState(__cbCartonUi.mod);
  const projectId = window.__carton?.projectId ?? null;
  o.useEffect(() => (typeof __cbCartonPresence === "function" ? __cbCartonPresence(projectId) : undefined), [projectId]);
  o.useEffect(() => {
    if (m) return undefined;
    let live = true;
    window.__cartonReact = o;
    (__cbCartonUi.load ??= import("./carton-ui.js")).then((x) => { __cbCartonUi.mod = x; if (live) setM(x); }, (e) => console.warn("[carton] the History panel did not load:", e?.message ?? e));
    return () => { live = false; };
  }, [m]);
  return c.jsxs("div", { className: className + " relative", children: [children, m && projectId ? c.jsx(m.CartonStage, { projectId, bridge: window.__carton }, projectId) : null] });
}
`;
