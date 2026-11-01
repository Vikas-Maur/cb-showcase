// The History panel's mount in the editor bundle (EditorRoute-*.js), prepended by patch-carton.js.
// - The editor waits (at most 2 s, once) for main to say whether Carton is on, so the rail shows the History tab
//   only when it is. With Carton off nothing else here runs.
// - The panel loads carton-ui.js (@carton/react with Cardboard's skin) the first time it renders, and hands it the
//   editor's own React (`o` in this bundle), so Carton's components run in the editor's tree, theme and portals.
// - Idle panels stay mounted (the rail pre-mounts them); RY() is the editor's "this panel is showing" context, so the
//   panel subscribes to Carton only while it shows.
module.exports = String.raw`await Promise.race([window.__carton?.ready, new Promise((r) => setTimeout(r, 2000))]);
const __cbCartonUi = { mod: null, load: null };
function __cbCartonPanel({ projectId }) {
  const [m, setM] = o.useState(__cbCartonUi.mod);
  const active = RY();
  o.useEffect(() => {
    if (m || !active) return;
    let live = true;
    window.__cartonReact = o;
    (__cbCartonUi.load ??= import("./carton-ui.js")).then((x) => { __cbCartonUi.mod = x; if (live) setM(x); }, (e) => console.warn("[carton] the History panel did not load:", e?.message ?? e));
    return () => { live = false; };
  }, [m, active]);
  return m ? c.jsx(m.CartonPanel, { projectId, active, bridge: window.__carton }) : null;
}
function __cbCartonIcon(p) {
  return c.jsxs("svg", { ...p, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 1.75, strokeLinecap: "round", strokeLinejoin: "round", children: [
    c.jsx("path", { d: "M3 12a9 9 0 1 0 2.6-6.4L3 8" }), c.jsx("path", { d: "M3 3v5h5" }), c.jsx("path", { d: "M12 7.5V12l3 2" }),
  ] });
}
`;
