// The Share panel (Invite to edit, Join, who is here, the status words) opens from the "Share" button at the stage's
// top-right (patch-carton.js's layer, scripts/carton/ui.js): scripts/carton/sync/ui.js is bundled into carton-ui.js
// and sets window.__cartonSyncUi, and the layer shows the button only when it is there. This adds the person's
// presence while the editor is open (__cbCartonPresence, which the layer's stage host calls): at most once a second
// while they click or type, and only for a shared project. Opening the project says they are here (idle), and 30 s
// without input says idle again: never gone while the project is open, so a teammate doesn't read "Nobody else is
// here" about someone who is (UI audit P2-11). Gone when the editor closes.
const PREAMBLE = String.raw`function __cbCartonPresence(projectId) {
  const bridge = window.__carton;
  if (!bridge?.on || !projectId) return undefined;
  let shared = false, last = 0, stopped = false, timer = null;
  const send = (state) => bridge.call("livePresence", [{ projectId, state }]).catch(() => {});
  const here = () => { if (shared && !stopped) { last = 0; send({ activity: null, idle: true }); } };
  bridge.call("liveStatus", [{ projectId }]).then((s) => { shared = !!s?.shared; here(); }, () => {});
  const off = bridge.onEvent((ev) => { if (ev?.id === projectId && ev.topic === "live") { const was = shared; shared = !!ev.live?.shared; if (shared && !was) here(); } });
  const act = () => {
    if (!shared || stopped) return;
    clearTimeout(timer);
    timer = setTimeout(here, 30000);
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
    if (shared) send(null);
  };
}
`;

// Join from the Dashboard (UI audit P2-9: joining meant opening some other project first, then its Share tab): a
// "Join a shared project" tile beside "New project", in its look, only with Carton on. It loads carton-ui.js (the
// editor's Carton bundle, on the same React: both import it from the app's shared chunk) and shows its JoinDialog in a
// portal on <body> (the grid's rows are transformed, so a fixed dialog inside one would sit wrong). The grid's cells
// get one more entry after the New project cell; nothing else in the Dashboard changes.
const DASHBOARD = String.raw`const __cbCartonJoinCell = { carton: "join" };
// Carton on or off: the bridge learns it from main a moment after the page starts, so the grid asks again then.
function __cbCartonUseOn() {
  const [on, setOn] = r.useState(() => !!window.__carton?.on);
  r.useEffect(() => {
    let live = true;
    Promise.resolve(window.__carton?.ready).then((v) => { if (live) setOn(v === true || !!window.__carton?.on); }, () => {});
    return () => { live = false; };
  }, []);
  return on;
}
function __cbCartonJoinTile() {
  const [m, setM] = r.useState(null), [open, setOpen] = r.useState(false);
  const go = () => {
    window.__cartonReact = r;
    import("./carton-ui.js").then((x) => { setM(x); setOpen(true); }, (e) => console.warn("[carton] Join didn't load:", e?.message ?? e));
  };
  const icon = i.jsxs("svg", { viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 1.6, strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": !0, className: "size-5", children: [
    i.jsx("path", { d: "M10.2 13.8a3.6 3.6 0 0 0 5.1 0l3-3a3.6 3.6 0 0 0-5.1-5.1l-1 1" }), i.jsx("path", { d: "M13.8 10.2a3.6 3.6 0 0 0-5.1 0l-3 3a3.6 3.6 0 0 0 5.1 5.1l1-1" })] });
  return i.jsxs("div", { className: "contents", children: [
    i.jsxs("button", { type: "button", onClick: go, "data-carton-join": "", className: "group flex w-full min-w-0 cursor-pointer flex-col text-left", children: [
      i.jsx("span", { className: "flex aspect-video w-full items-center justify-center rounded-ui-md bg-white/[0.04] text-white/60 ring-1 ring-white/[0.06] ring-inset transition-colors duration-150 group-hover:bg-white/[0.07] group-hover:text-white/90", children: icon }),
      i.jsxs("span", { className: "flex min-w-0 flex-col gap-0.5 pt-2.5", children: [
        i.jsx("span", { className: "truncate text-ui-md font-medium tracking-tight text-white/90", children: "Join a shared project" }),
        i.jsx("span", { className: "truncate text-ui-xs text-white/50", children: "From an invite link" })] })] }),
    open && m?.JoinDialog ? Au.createPortal(i.jsx(m.JoinDialog, { bridge: window.__carton, onClose: () => setOpen(false) }), document.body) : null] });
}
`;

module.exports = {
  app({ editor, index }) {
    editor.prepend(PREAMBLE);
    // The grid's cells (a memo inside its component's const list): the Join cell once Carton says it is on.
    index.replace("x=r.useMemo(()=>{const k=[null,...e],E=[];for(let T=0;T<k.length;T+=y)E.push(k.slice(T,T+y));return E},[e,y])", "__cbJ=__cbCartonUseOn(),x=r.useMemo(()=>{const k=[null,...(__cbJ?[__cbCartonJoinCell]:[]),...e],E=[];for(let T=0;T<k.length;T+=y)E.push(k.slice(T,T+y));return E},[e,y,__cbJ])");
    index.replace("children:x[k.index]?.map((E,T)=>E?i.jsx(r9,{", 'children:x[k.index]?.map((E,T)=>E===__cbCartonJoinCell?i.jsx("div",{role:"listitem",className:"min-w-0",children:i.jsx(__cbCartonJoinTile,{})},"carton-join"):E?i.jsx(r9,{');
    index.prepend(DASHBOARD);
  },
};
