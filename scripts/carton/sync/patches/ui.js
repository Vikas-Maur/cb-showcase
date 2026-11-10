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
// get one more entry after the New project cell. An empty library (a new user's first screen, "Make your first video")
// has no grid: there Join is a button in the row of "Browse recipes" and "Start a blank project", in that row's
// secondary look (regress 2026-11-02 #3). Nothing else in the Dashboard changes.
// The dialog is one for the whole Home (Dashboard and Projects), shown by a host in Home's own root, beside Cardboard's
// own dialogs; the tile and the button only open it. Joining from an empty library puts the project in it, and Home
// then swaps the empty view for the grid: a dialog inside the empty view went with it, before its Open could be pressed
// (final re-check N1). The host stays mounted through that swap, and through the grid scrolling the tile away.
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
// The Join dialog, loaded on first use: its state (the loaded chunk, open or not) is the page's, not a tile's.
const __cbCartonJoin = { m: null, open: false, subs: new Set() };
const __cbCartonJoinSet = (open, m = __cbCartonJoin.m) => {
  Object.assign(__cbCartonJoin, { open, m });
  for (const f of __cbCartonJoin.subs) f();
};
function __cbCartonJoinOpen() {
  window.__cartonReact = r;
  import("./carton-ui.js").then((x) => __cbCartonJoinSet(true, x), (e) => console.warn("[carton] Join didn't load:", e?.message ?? e));
}
// In Home's root: the dialog while it is open. Home going away closes it.
function __cbCartonJoinHost() {
  const [, render] = r.useReducer((n) => n + 1, 0);
  r.useEffect(() => {
    __cbCartonJoin.subs.add(render);
    render();
    return () => { __cbCartonJoin.subs.delete(render); if (!__cbCartonJoin.subs.size) __cbCartonJoin.open = false; };
  }, []);
  const { open, m } = __cbCartonJoin;
  return open && m?.JoinDialog ? Au.createPortal(i.jsx(m.JoinDialog, { bridge: window.__carton, onClose: () => __cbCartonJoinSet(false) }), document.body) : null;
}
const __cbCartonJoinIcon = (className, strokeWidth) => i.jsxs("svg", { viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth, strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": !0, className, children: [
  i.jsx("path", { d: "M10.2 13.8a3.6 3.6 0 0 0 5.1 0l3-3a3.6 3.6 0 0 0-5.1-5.1l-1 1" }), i.jsx("path", { d: "M13.8 10.2a3.6 3.6 0 0 0-5.1 0l-3 3a3.6 3.6 0 0 0 5.1 5.1l1-1" })] });
function __cbCartonJoinTile() {
  return i.jsxs("div", { className: "contents", children: [
    i.jsxs("button", { type: "button", onClick: __cbCartonJoinOpen, "data-carton-join": "", className: "group flex w-full min-w-0 cursor-pointer flex-col text-left", children: [
      i.jsx("span", { className: "flex aspect-video w-full items-center justify-center rounded-ui-md bg-white/[0.04] text-white/60 ring-1 ring-white/[0.06] ring-inset transition-colors duration-150 group-hover:bg-white/[0.07] group-hover:text-white/90", children: __cbCartonJoinIcon("size-5", 1.6) }),
      i.jsxs("span", { className: "flex min-w-0 flex-col gap-0.5 pt-2.5", children: [
        i.jsx("span", { className: "truncate text-ui-md font-medium tracking-tight text-white/90", children: "Join a shared project" }),
        i.jsx("span", { className: "truncate text-ui-xs text-white/50", children: "From an invite link" })] })] })] });
}
// Joining from an empty library (regress prod3 P3-E): Home swaps the empty view for the grid as the join lands, and the
// page jumped back to the Dashboard's top (the sidebar's Projects lit Dashboard), the new tile below the fold. The page
// keeps the place it had as the swap began, for the moment the grid takes to measure itself, unless the person moves
// meanwhile: scrolls anywhere, or clicks or presses a key outside the dialog (the sidebar's Dashboard, say, which
// scrolls Home itself; review of P3-E); then the new tile (the newest project: the cell after New project and Join) is brought into view if it
// isn't.
const __cbCartonScroller = (n) => {
  const view = n?.ownerDocument?.defaultView;
  for (let el = n?.parentElement; el && view; el = el.parentElement) if (/auto|scroll/.test(view.getComputedStyle(el).overflowY)) return el;
  return null;
};
function __cbCartonKeepPlace(el, top) {
  const doc = el.ownerDocument, view = doc.defaultView, until = Date.now() + 1500;
  let done = false;
  const on = { wheel: () => off(), touchmove: () => off(), pointerdown: (e) => outside(e) && off(), keydown: (e) => outside(e) && off() };
  const outside = (e) => !e.target?.closest?.('[role="dialog"]');
  const off = () => { done = true; for (const t in on) doc.removeEventListener(t, on[t], true); };
  for (const t in on) doc.addEventListener(t, on[t], { capture: true, passive: true });
  const tick = () => {
    if (done || !el.isConnected) return;
    if (Math.abs(el.scrollTop - top) > 1) el.scrollTo({ top, behavior: "instant" });
    if (Date.now() < until) return void view.requestAnimationFrame(tick);
    off();
    el.querySelectorAll('[role="list"] [role="listitem"]')[2]?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  };
  view.requestAnimationFrame(tick);
}
// The empty library's Join, in the look (its className) Cardboard gives the row's "Browse recipes".
function __cbCartonJoinButton({ className }) {
  const on = __cbCartonUseOn();
  const ref = r.useRef(null);
  r.useLayoutEffect(() => {
    const el = __cbCartonScroller(ref.current);
    // leaving with the dialog open: the join put the first project in the library
    return () => { if (el && __cbCartonJoin.open) __cbCartonKeepPlace(el, el.scrollTop); };
  }, [on]);
  if (!on) return null;
  return i.jsxs("button", { ref, type: "button", onClick: __cbCartonJoinOpen, "data-carton-join": "", className, children: [__cbCartonJoinIcon("size-[14px]", 2), "Join a shared project"] });
}
`;

module.exports = {
  app({ editor, index }) {
    editor.prepend(PREAMBLE);
    // The grid's cells (a memo inside its component's const list): the Join cell once Carton says it is on.
    index.replace("x=r.useMemo(()=>{const k=[null,...e],E=[];for(let T=0;T<k.length;T+=y)E.push(k.slice(T,T+y));return E},[e,y])", "__cbJ=__cbCartonUseOn(),x=r.useMemo(()=>{const k=[null,...(__cbJ?[__cbCartonJoinCell]:[]),...e],E=[];for(let T=0;T<k.length;T+=y)E.push(k.slice(T,T+y));return E},[e,y,__cbJ])");
    index.replace("children:x[k.index]?.map((E,T)=>E?i.jsx(c9,{", 'children:x[k.index]?.map((E,T)=>E===__cbCartonJoinCell?i.jsx("div",{role:"listitem",className:"min-w-0",children:i.jsx(__cbCartonJoinTile,{})},"carton-join"):E?i.jsx(c9,{');
    // The empty library's buttons (E$, "Make your first video"): Join first, so "Start a blank project" stays last.
    index.replace(
      'i.jsxs("div",{className:"flex flex-wrap gap-[8px]",children:[a&&i.jsxs("button",{type:"button",onClick:a.onBrowse,"data-analytics":"projects-empty-browse-recipes"',
      'i.jsxs("div",{className:"flex flex-wrap gap-[8px]",children:[i.jsx(__cbCartonJoinButton,{className:v(K4,"bg-white/[0.06] text-white/85 hover:bg-white/[0.10] hover:text-white")}),a&&i.jsxs("button",{type:"button",onClick:a.onBrowse,"data-analytics":"projects-empty-browse-recipes"',
    );
    // The Join dialog's host, in Home's root beside Cardboard's own dialogs (recipe, reference): it outlives the empty
    // view and the grid both, which Home swaps once the library holds a project (final re-check N1).
    index.replace("i.jsx(pG,{...I.dialog}),i.jsx(PG,{...I.referenceDialog})", "i.jsx(pG,{...I.dialog}),i.jsx(PG,{...I.referenceDialog}),i.jsx(__cbCartonJoinHost,{})");
    index.prepend(DASHBOARD);
  },
};
