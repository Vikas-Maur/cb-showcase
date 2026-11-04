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
// Compare in the editor (UX v2, N1): while comparing, the stage's Carton layer publishes (window.__cartonStageMode) the
// mode and the hole it leaves for the editor's own picture (the right side: Side by side's right half, or Wipe's and
// Flip's one picture), as insets in px from the stage's edges. The host carries them (data-carton-compare and
// --carton-hole-*), and Compare's sheet lays Cardboard's picture into that box (scripts/carton/compare.js STAGE_CSS):
// Cardboard measures the box itself and sizes its picture to it. Null: not comparing, and the host is Cardboard's
// stage exactly.
const __cbCartonStage = { value: null, subs: new Set() };
window.__cartonStageMode = (v) => {
  __cbCartonStage.value = v ?? null;
  for (const f of [...__cbCartonStage.subs]) f(__cbCartonStage.value);
};
function __cbCartonStageHost({ className, children }) {
  const m = __cbCartonModule();
  const projectId = window.__carton?.projectId ?? null;
  const [mode, setMode] = o.useState(__cbCartonStage.value);
  o.useEffect(() => {
    __cbCartonStage.subs.add(setMode);
    setMode(__cbCartonStage.value);
    return () => { __cbCartonStage.subs.delete(setMode); };
  }, []);
  o.useEffect(() => (typeof __cbCartonPresence === "function" ? __cbCartonPresence(projectId) : undefined), [projectId]);
  const hole = mode?.hole;
  const style = hole ? { "--carton-hole-t": hole.top + "px", "--carton-hole-r": hole.right + "px", "--carton-hole-b": hole.bottom + "px", "--carton-hole-l": hole.left + "px" } : void 0;
  // data-carton-stage-host: the side panel measures the preview's room by it (scripts/carton/ui.js, fitPanel).
  return c.jsxs("div", { className: className + " relative", "data-carton-stage-host": "", "data-carton-compare": mode?.mode || void 0, style, children: [children, m && projectId ? c.jsx(m.CartonStage, { projectId, bridge: window.__carton, player: __cbCartonPlayerOk ? __cbCartonPlayer : null, portal: __cbCartonPortal }, projectId) : null] });
}
// The editor's own createPortal (its ReactDOM, Na here): Compare's marks go into Cardboard's timeline, inside its scroll
// areas, so they scroll with the clips with no work of ours. Null outside the editor's bundle.
const __cbCartonPortal = typeof Na === "object" && Na && typeof Na.createPortal === "function" ? Na.createPortal : null;
// Compare's second player (UX v2, N1): another version on Cardboard's own preview engine (YD, the stage's
// "webcodecs-renderer-hook"), on a canvas of its own, for Side by side and Wipe. Mounted only while one of those shows;
// unmounted (Flip, Compare closed) its engine is destroyed: WebGL context, video sources, audio graph. Silent: its clips
// are muted and audio-only items left out, so its audio graph decodes nothing (the editor's own player is heard). Its
// time follows the editor's: the playhead while paused (one frame per seek), the playback clock (hn) while playing,
// mapped onto the other version by follow(t) (in step by shot, @carton/react followTime). doc: the bridge's
// compareDoc. onReady(true) once its engine runs. The names are Cardboard 1.4.0's; patch-carton.js checks each.
// (typeof only: run outside the editor's bundle, as the capture page and the tests run this file, none of them exist)
const __cbCartonPlayerOk = typeof YD === "function" && typeof L2 === "function" && typeof U === "function" && typeof hn === "object" && !!hn && typeof hn.get === "function" && typeof hn.subscribe === "function";
// clock: Compare's story while Play both runs (in step by shot, either side may wait: DESIGN-V2 §1.4): {active, get,
// playing, subscribe}; otherwise the editor's own playhead and playback clock, mapped by follow(t).
function __cbCartonPlayer({ doc, follow, onReady, clock }) {
  const storePlaying = U((s) => !!s.isPlaying);
  const paused = U((s) => s.playheadTime ?? s.currentTime ?? 0);
  const [, tick] = o.useState(0);
  const both = !!clock && clock.active();
  o.useEffect(() => (clock ? clock.subscribe(() => tick((n) => (n + 1) | 0)) : undefined), [clock]);
  o.useEffect(() => (!both && storePlaying ? hn.subscribe(() => tick((n) => (n + 1) | 0)) : undefined), [both, storePlaying]);
  const playing = both ? clock.playing() : storePlaying;
  const at = both ? clock.get() : typeof follow === "function" ? follow(storePlaying ? hn.get() : paused) : (storePlaying ? hn.get() : paused);
  const size = o.useMemo(() => L2(doc.aspectRatio), [doc.aspectRatio]);
  const items = o.useMemo(() => doc.timelineItems.filter((i) => i.type !== "audio").map((i) => (i.muted ? i : { ...i, muted: true })), [doc.timelineItems]);
  const r = YD({ width: size.width, height: size.height, timelineItems: items, tracks: doc.tracks, mediaItems: doc.media, currentTime: Number.isFinite(at) ? Math.max(0, at) : 0, isPlaying: playing, masterVolume: 0, enabled: true, drivenByExternalClock: false });
  // ready: the engine runs and has sized its canvas (initializeRenderer: a WebGL or 2D context made). Not proof of a
  // painted frame: YD logs a failed frame itself and goes on (a check for the laptop, FEASIBILITY §5).
  o.useEffect(() => {
    if (!r.isReady) return undefined;
    let n = 0, id = 0;
    const look = () => {
      const cv = r.canvasRef.current;
      if (cv && cv.width > 0 && cv.height > 0) return onReady?.(true);
      if (++n < 90) id = requestAnimationFrame(look);
    };
    look();
    return () => cancelAnimationFrame(id);
  }, [r.isReady, r.canvasRef, onReady]);
  return c.jsx("canvas", { ref: r.canvasRef, "data-carton-player": "", style: { display: "block", width: "100%", height: "100%" } });
}
// What the timeline shows besides Cardboard's own: { projectId, viewing, cut, dot, compare }, or null (compare: Compare
// in the editor, data-carton-compare, which mutes only Cardboard's clip canvases so Compare's marks stay bright). One value for the page;
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
  if (!m || (!m.viewing && !m.cut && !m.compare)) return c.jsx("div", props);
  return c.jsx("div", { ...props, "data-carton-viewing": m.viewing ? "" : void 0, "data-carton-compare": m.compare ? "" : void 0, "data-carton-cut": m.cut || void 0, style: m.cut ? { "--carton-cut-label": JSON.stringify(String(m.cut)), "--carton-cut-dot": m.dot || "#f59e0b" } : void 0 });
}
function __cbCartonSide() {
  const m = __cbCartonModule();
  const projectId = window.__carton?.projectId ?? null;
  return m && projectId ? c.jsx(m.CartonSide, { projectId, bridge: window.__carton }, projectId) : null;
}
`;
