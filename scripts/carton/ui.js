// carton-ui.js: Carton in Cardboard's editor (scripts/carton/build.js bundles it with @carton/react), in two places
// editor-panel.js mounts:
// - CartonSide: the History or Comments panel, a full-height column beside the agent's chat sidebar, in its look
//   (width, rule, resize handle, header), and the Share dialog (scripts/carton/sync/ui.js ShareDialog: Carton UX
//   redesign PLAN 8.1, in place of the panel's Share tab). The title bar's History and Share icons and its cut chip
//   (scripts/carton/strip-buttons.js) send their commands here (patch-carton.js routes them as carton:command to this
//   page), and this page reports back what is open, the cut it is on and what it is viewing (bridge.reportPanel).
// - CartonStage: a layer over the stage (the preview's column, above the timeline, left of the chat): the conflict
//   cards' floating stack in its bottom-right corner, with "See it", and the viewing banner ("Back to my edit").
// Neither takes keys but its own (Esc closes the panel while focus is in it), so the stage, the timeline's keyboard,
// Ctrl+Z and the chat work as before.
// Carton runs in the library worker. There @carton/react's view model is served to each page (serveUi over the
// worker's carton namespace, scripts/carton/carton-node.js); here remoteUi mirrors it, one connection per project shared
// by both parts. Messages go out through the bridge's carton:call "ui" and come back as carton:event for this page's
// client id. A preview is the editor's own read-only one (the bridge's preview).
import { Component, createElement as h, memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Button, CartonProvider, Dialog, actorColor, actorLabel, initials, CommentsPanel, ConflictStack, CutsMenu, FoldInDialog, HistoryPanel, Icon, PreviewBanner, injectCommentsSkin, keptText, remoteComments, remoteUi, useCartonUi, useCuts, versionLabel, words, TeammateCutActions } from "@carton/react";
import { injectCardboardSkin } from "@carton/react/skin/cardboard";

// Short confirmations over the stage (UI audit P2-4): Restore, Fold in and a conflict card's pick said nothing, so a
// person couldn't tell they had worked. One at a time, gone after 6 s; Fold in offers to switch to the cut it went into.
// `tone` "warning": a failure or a refusal the bridge tells (a save that failed, an undo refused), with the warning
// look Carton's other failures have (the conflict stack, footage still on its way, Offline), not the ✓ of a
// confirmation (laptop, merge/prod-2 N-3), and said at once to a screen reader (role alert).
const toasts = { value: null, seq: 0, subs: new Set(), show(text, action, tone) { this.set({ id: ++this.seq, text, action, ...(tone ? { tone } : {}) }); }, set(v) { this.value = v; for (const f of this.subs) f(v); } };
// what the bridge tells (scripts/carton/renderer-bridge.js notice: a save that failed, an undo refused)
const tellFailure = (text) => toasts.show(text, null, "warning");
function confirmations(ui) {
  const versionByRef = (ref) => (ui.history().all?.() ?? []).find((v) => v.ref === ref);
  const restore = ui.restore.bind(ui);
  ui.restore = async (ref) => {
    const v = versionByRef(ref);
    await restore(ref);
    // a version named one way everywhere (UX redesign 0.9: its name, an agent's prompt, or "your edit from 12:41 pm")
    toasts.show(words.restoredToast(v ? versionLabel(v, { actor: ui.actor.bind(ui) }) : "an earlier version"));
  };
  const fold = ui.fold.bind(ui);
  ui.fold = async (from, into, opts) => {
    const r = await fold(from, into, opts);
    if (r?.ok) {
      const cuts = ui.cuts(), a = cuts.find((c) => c.id === from), b = cuts.find((c) => c.id === into);
      const left = opts?.leaveOut?.length ? " Some changes were left out." : "";
      toasts.show(`Folded “${a?.label ?? "the cut"}” into ${b?.label ?? "the cut"}.${left}`, b && !b.current ? { label: `Switch to ${b.label}`, run: () => ui.switchCut(into) } : null);
    }
    return r;
  };
  // A conflict card's pick names what was kept, as the card named it (docs/carton-ux DESIGN §6.7): "Kept Claude Code's
  // move of “Interview B”." No Undo on it yet (PLAN 5.3): a pick of the side already shown commits nothing, so the
  // editor's undo would take back an earlier change instead.
  const resolve = ui.resolve.bind(ui);
  ui.resolve = async (id, choice) => {
    const c = ui.conflicts().find((x) => x.id === id);
    await resolve(id, choice);
    if (c) toasts.show(keptText(c, choice, ui.actor.bind(ui)));
  };
}

function connect(projectId, bridge) {
  const client = projectId + ":" + Math.random().toString(36).slice(2);
  const r = remoteUi((message) => bridge.call("ui", [{ projectId, client, message }]).catch((e) => console.warn("[carton] the History panel lost the worker:", e?.message ?? e)));
  const off = bridge.onEvent((ev) => { if (ev?.client === client && ev.message) r.receive(ev.message); });
  // Opening a version: the editor shows it read-only; null returns to current.
  const openPreview = r.ui.openPreview.bind(r.ui);
  r.ui.openPreview = (ref, label) => { openPreview(ref, label); return bridge.preview(projectId, ref ?? null); };
  // Viewing (UX redesign 0.5): the worker labels it and checks it loads; the bridge's preview is still the one way the
  // editor swaps. Its viewing topic arrives before its answer, so the ref shown is the one the worker settled on.
  const view = r.ui.view.bind(r.ui);
  r.ui.view = async (target) => {
    await view(target);
    return bridge.preview(projectId, target ? (r.ui.viewing()?.ref ?? null) : null);
  };
  confirmations(r.ui);
  return { ...r, close: off };
}

/** The confirmation over the stage: Cardboard's toast look, a polite status, its action as a button, ✕ to close. */
function Toast() {
  const [t, setT] = useState(toasts.value);
  useEffect(() => { toasts.subs.add(setT); return () => { toasts.subs.delete(setT); }; }, []);
  useEffect(() => {
    if (!t) return undefined;
    const id = t.id, timer = setTimeout(() => { if (toasts.value?.id === id) toasts.set(null); }, 6000);
    return () => clearTimeout(timer);
  }, [t]);
  if (!t) return null;
  const warn = t.tone === "warning";
  return h("div", { className: "carton-toast", "data-tone": warn ? "warning" : undefined, role: warn ? "alert" : "status", "aria-live": warn ? "assertive" : "polite" },
    h(Icon, { name: warn ? "warning" : "check", size: 14 }),
    h("span", { className: "carton-toast-text" }, t.text),
    t.action ? h(Button, { onClick: () => { toasts.set(null); void t.action.run(); } }, t.action.label) : null,
    h(Button, { variant: "ghost", icon: "x", label: words.close, onClick: () => toasts.set(null) }));
}

// One connection per project, shared by the side panel and the stage layer; closed when neither uses it.
const conns = new Map();
function useConn(projectId, bridge) {
  const conn = useMemo(() => {
    let e = conns.get(projectId);
    if (!e) conns.set(projectId, (e = { conn: connect(projectId, bridge), users: 0, closing: null }));
    return e.conn;
  }, [projectId, bridge]);
  const [ready, setReady] = useState(false);
  useEffect(() => {
    injectCardboardSkin(document);
    const e = conns.get(projectId);
    if (e?.conn === conn) { e.users++; clearTimeout(e.closing); }
    let live = true;
    conn.ready.then(() => live && setReady(true));
    return () => {
      live = false;
      if (e?.conn !== conn || --e.users > 0) return;
      e.closing = setTimeout(() => { if (e.users === 0 && conns.get(projectId) === e) { conns.delete(projectId); conn.close(); } }, 0);
    };
  }, [projectId, conn]);
  return [conn, ready];
}

const HISTORY_KEY = /Mac|iPhone|iPad/.test(globalThis.navigator?.platform ?? "") ? "⌘⇧H" : "Ctrl+Shift+H";
// Share is a dialog now (PLAN 8.1), not one of the panel's tabs.
const PANELS = { history: { label: "History", icon: "versions", key: HISTORY_KEY }, comments: { label: "Comments", icon: "comment" } };
const TABS = ["history", "comments"];
// Which side panel is open, for the stage layer of this page (both parts live in this module, so it stays in it): the
// card stack folds to its pill while a panel takes the room beside the chat.
const sidePanel = { value: null, subs: new Set(), set(v) { this.value = v; for (const f of this.subs) f(v); } };
// The stage's live chip asks the side panel's part to open Share (both parts live in this module).
const panelRequests = new Set();
// Below this window width the title bar keeps History only, and Share opens from the panel's head (PLAN 2.3; the same
// query as scripts/carton/strip-buttons.js: both pages are the window's width).
const NARROW = "(max-width: 1180px)";
function useNarrowWindow() {
  const [narrow, setNarrow] = useState(() => typeof matchMedia === "function" && matchMedia(NARROW).matches);
  useEffect(() => {
    if (typeof matchMedia !== "function") return undefined;
    const q = matchMedia(NARROW), f = () => setNarrow(q.matches);
    q.addEventListener?.("change", f);
    return () => q.removeEventListener?.("change", f);
  }, []);
  return narrow;
}

// ---------------------------------------------------------------- the title bar's cut chip (PLAN 2.1, 2.2)
// Each cut but Main has a colour: its dot in the chip (and in the cuts menu and History's cut bar, PLAN 6.1). A cut's
// own colour when the view model gives one (Cut.color), else one picked from its id, so it never changes.
const CUT_COLORS = ["#f59e0b", "#22d3ee", "#a78bfa", "#f472b6", "#4ade80", "#fb7185", "#60a5fa", "#facc15"];
export function cutColor(cut) {
  if (typeof cut?.color === "string" && /^#[0-9a-f]{3,8}$/i.test(cut.color)) return cut.color;
  let x = 0x811c9dc5;
  for (const ch of String(cut?.id ?? "")) x = Math.imul(x ^ ch.charCodeAt(0), 0x01000193) >>> 0;
  return CUT_COLORS[x % CUT_COLORS.length];
}
const upFirst = (s) => (typeof s === "string" && s ? s[0].toUpperCase() + s.slice(1) : s);
/**
 * What the editor shows when it isn't your edit (PLAN 0.5's ui.viewing(): {ref, kind, label, short}, or null), and
 * what the view model doesn't say there yet: a teammate's cut switched to (read-only: today's cuts menu switches to
 * it), and a version opened read-only through openPreview(), which the real view model (from-carton.ts) still keeps in
 * preview() only (review of feat/ux-2-8 #1: with viewing() there but null, the chip lost its label and its ✕).
 */
export function viewingOf(ui) {
  const v = typeof ui.viewing === "function" ? ui.viewing() : null;
  if (v) return v;
  const current = ui.cuts().find((c) => c.current);
  if (current?.readOnly) return { ref: current.head, kind: "cut", cutId: current.id, label: current.label, short: current.label };
  const p = ui.preview?.();
  return p ? { ref: p.ref, kind: "version", label: p.label, short: p.label } : null;
}
// Your own cut: the current one, or while a teammate's cut is viewed, your Main cut (the one Back goes to).
const homeCut = (cuts) => {
  const current = cuts.find((c) => c.current);
  return current && !current.readOnly ? current : cuts.find((c) => !c.readOnly && c.kind === "main") ?? cuts.find((c) => !c.readOnly) ?? null;
};
/** The chip's part of the title bar's report: {cut: {name, dot}, viewing: {label}}; null until the cuts are known. */
export function chipOf(ui) {
  const cuts = ui.cuts();
  const cut = homeCut(cuts);
  if (!cut) return null;
  const v = viewingOf(ui);
  // a label from today's callers can start in lower case ("the version from 2:14 PM (Codex)"): the chip starts a phrase
  return { cut: { name: cut.label || cut.name, dot: cut.kind === "main" ? null : cutColor(cut) }, viewing: v?.label ? { label: upFirst(v.label) } : null };
}
/**
 * Back to your edit (the chip's ✕). A teammate's cut switched to: your own cut again. Anything else viewed: through
 * openPreview(null), the path connect() wraps so the editor swaps back too (bridge.preview); PLAN 0.5 keeps it as
 * view(null)'s alias, and it clears whatever is viewed.
 */
export function backToEdit(ui) {
  const cuts = ui.cuts(), current = cuts.find((c) => c.current), home = homeCut(cuts);
  if (current?.readOnly && home) return ui.switchCut(home.id);
  if (viewingOf(ui)) return ui.openPreview(null);
  return undefined;
}
const WIDTH = { key: "carton.sidePanelWidth", min: 300, max: 640, initial: 384 };
// The preview keeps at least this much width beside the panel (UI audit P2-13: at a narrow window the panel took it all).
const MIN_STAGE = 320;

/**
 * Where the side panel goes, from the room the preview would have without it (`room`: the stage's width plus the
 * panel's own width while it is in the row). Its chosen width when that leaves the preview MIN_STAGE; narrower, down
 * to its minimum, when that is enough; else it floats over the chat as a drawer (overlay), and the preview keeps the
 * room Cardboard alone gives it. `room` doesn't change with the choice, so the choice never oscillates.
 * The drawer covers the chat column (`chat`: its width, 0 when it is collapsed) and no more when that is at least the
 * minimum; narrower than that, the drawer keeps its minimum and says it reaches past the chat (`over`), so it ends
 * where the stage ends and leaves the timeline and its toolbar clear (baseline P3-7: at 960 px it covered Fullscreen and
 * Hide timeline). It ends there too when the timeline's toolbar reaches under it (`tools`: the toolbar's right edge,
 * its last button's): at 960 px with the chat open the toolbar runs on under the chat column, and the drawer as wide as
 * that column covered Fullscreen and Hide timeline from top to bottom (regress prod3 P3-A).
 */
export function fitPanel({ room, preferred, viewport, chat, tools, min = WIDTH.min, minStage = MIN_STAGE }) {
  if (!(room > 0)) return { mode: "inline", width: preferred };
  if (room - preferred >= minStage) return { mode: "inline", width: preferred };
  if (room - min >= minStage) return { mode: "inline", width: Math.floor(room - minStage) };
  const width = Math.max(Math.min(preferred, viewport - 64), Math.min(min, viewport));
  // not measured: as before; a chat collapsed to nothing is measured (review #2), and all of the drawer is past it
  if (!(chat >= 0)) return { mode: "overlay", width };
  const fits = Math.max(min, Math.min(width, Math.floor(chat)));
  return { mode: "overlay", width: fits, over: fits > chat || tools > viewport - fits };
}

/** The panel's place in the row (fitPanel), kept up to date as the window, the Library or the chat change size. */
function useFit(ref, preferred) {
  const [fit, setFit] = useState({ mode: "inline", width: preferred });
  const fitRef = useRef(fit);
  fitRef.current = fit;
  useLayoutEffect(() => {
    const stage = document.querySelector("[data-carton-stage-host]");
    if (!stage) { setFit({ mode: "inline", width: preferred }); return undefined; }
    const measure = () => {
      const aside = ref.current;
      if (!aside) return;
      const inflow = fitRef.current.mode === "inline" ? aside.getBoundingClientRect().width : 0;
      const box = stage.getBoundingClientRect(), room = box.width + inflow;
      const row = aside.parentElement?.getBoundingClientRect();
      // the chat column: the row's right of the stage, less the panel while it is in the row
      const chat = row ? Math.max(0, row.right - box.right - inflow) : undefined;
      // the timeline toolbar's right end: its last button (Cardboard's own, "Hide timeline" or "Show timeline")
      const tools = document.querySelector('[aria-label="Hide timeline"],[aria-label="Show timeline"]')?.getBoundingClientRect().right;
      const fit = fitPanel({ room, preferred, viewport: window.innerWidth, chat, tools });
      // reaching past the chat, the drawer ends where the stage does: the timeline below stays clear
      const next = { ...fit, ...(row ? { top: row.top, height: fit.over ? Math.max(0, box.bottom - row.top) : row.height } : {}) };
      const was = fitRef.current;
      if (was.mode !== next.mode || was.width !== next.width || (next.mode === "overlay" && (was.top !== next.top || was.height !== next.height))) setFit(next);
    };
    measure();
    const ro = typeof ResizeObserver === "function" ? new ResizeObserver(measure) : null;
    ro?.observe(stage);
    window.addEventListener("resize", measure);
    return () => { ro?.disconnect(); window.removeEventListener("resize", measure); };
  }, [ref, preferred]);
  return fit;
}

/**
 * History in the side panel: the cut it shows, with the cuts menu (switch, a switch that waits for an agent's turn, New
 * cut, Rename, "Fold in changes from a cut…", which opens Fold in: from a cut into a cut, all, some or none of it); on a
 * teammate's cut, what you can do with it (fold it into yours, or copy it as a new cut: UX redesign PLAN 6.2); then
 * the versions, and the Changes view in their place (docs/carton-ux DESIGN §5.4: "Compare with your edit", Shift+click),
 * with Play and Before (§5.3). It replaced the old Compare card and shot strips (PLAN 4.4): this page mounts neither.
 */
function HistorySide({ projectId, bridge, cutsAsk = 0, onCutsAsked }) {
  const cuts = useCuts();
  const [fold, setFold] = useState(null);
  const openFold = useCallback((from, into) => setFold({ from: from.id, into: into.id }), []);
  const current = cuts.find((c) => c.current)?.head;
  const box = useRef(null);
  // The title bar's cut chip (PLAN 2.2, version 1): History opens with its cuts menu open, focus on its first item
  // (MenuList's own focus), from the list. The menu is the cuts button's own (the one with the class
  // carton-cuts-trigger, CutsMenu's), opened as a click opens it, so the chip's menu and History's are one menu. The
  // request is the side panel's (CartonSide's), consumed there once the menu opens (review of feat/ux-2-8 #3: kept
  // here, it outlived History closing, and reopening History opened the menu again). With the Changes view open in
  // place of the list (its cut bar hidden), it goes back to the list first (its ← History), then the menu opens.
  useEffect(() => {
    if (!cutsAsk) return undefined;
    const open = () => {
      const t = box.current?.querySelector(".carton-cuts-trigger, .carton-sidebar-cuts [aria-haspopup=menu]");
      if (t && t.getAttribute("aria-expanded") !== "true") t.click();
      onCutsAsked?.();
    };
    let id = requestAnimationFrame(() => {
      const back = box.current?.querySelector(".carton-history[data-changes] .carton-changes-nav button");
      if (!back) return open();
      back.click();
      id = requestAnimationFrame(open);
    });
    return () => cancelAnimationFrame(id);
  }, [cutsAsk, onCutsAsked]);
  // Play runs on your edit (the newest version) or on the version it views, in the editor's own player: its playhead
  // follows Play's, real frames there, at most 10 seeks a second while it plays, and always the last one.
  const seeker = useMemo(() => {
    let last = 0, timer = null, at = 0;
    const go = () => { timer = null; last = performance.now(); bridge.seek?.(at); };
    return {
      onFrame: (t) => {
        at = t;
        if (performance.now() - last >= 100) go();
        else timer ??= setTimeout(go, 100);
      },
      stop: () => { clearTimeout(timer); timer = null; },
    };
  }, [bridge]);
  useEffect(() => seeker.stop, [seeker]);
  // What Play needs of the editor (@carton/react's PlayHost): the playhead (followed while playing, set by a click on a
  // change), Before's side checked out ahead so the flip doesn't wait (the bridge keeps it), and your edit's length.
  // Play never selects a clip: Cardboard's own Esc clears a selection first and would swallow the person's Esc.
  const play = useMemo(() => ({
    onFrame: seeker.onFrame,
    seek: (t) => { seeker.stop(); bridge.seek?.(t); },
    prefetch: (ref) => bridge.prefetch?.(projectId, ref),
    length: () => bridge.editLength?.(),
  }), [seeker, bridge, projectId]);
  return h("div", { ref: box, className: "carton-sidebar-history" },
    h("div", { className: "carton-sidebar-cuts" }, h(CutsMenu, { onFoldIn: openFold })),
    h(TeammateCutActions, { onFoldIn: openFold }),
    h(HistoryPanel, { currentRef: current, play }),
    fold ? h(FoldInDialog, { fromCutId: fold.from, intoCutId: fold.into, onClose: () => setFold(null) }) : null);
}

/** The project's timecoded comments (@carton/comments, served by the worker): pinned at the playhead, a timecode seeks. */
function useComments(projectId, bridge) {
  const conn = useMemo(() => {
    const client = projectId + ":c:" + Math.random().toString(36).slice(2);
    const r = remoteComments((message) => bridge.call("comments", [{ projectId, client, message }]).catch((e) => console.warn("[carton] comments lost the worker:", e?.message ?? e)));
    const off = bridge.onEvent((ev) => { if (ev?.client === client && ev.message) r.receive(ev.message); });
    return { ...r, close: off };
  }, [projectId, bridge]);
  useEffect(() => { injectCommentsSkin(document); return () => { if (typeof conn.close === "function") conn.close(); }; }, [conn]);
  return conn;
}
function CommentsSide({ projectId, bridge }) {
  const conn = useComments(projectId, bridge);
  const [selected, setSelected] = useState(null);
  return h(CommentsPanel, { className: "carton-sidebar-comments", comments: conn.ui, at: () => bridge.playhead?.() ?? null, onSeek: (t) => bridge.seek?.(t), selected, onSelect: setSelected });
}

/** The chat sidebar's resize handle: drag its left edge. The width is kept for next time. */
function useWidth() {
  const [width, setWidth] = useState(() => {
    const w = Number(globalThis.localStorage?.getItem(WIDTH.key));
    return Number.isFinite(w) && w >= WIDTH.min && w <= WIDTH.max ? w : WIDTH.initial;
  });
  const onPointerDown = (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const x0 = e.clientX, w0 = width, el = e.currentTarget;
    el.setPointerCapture(e.pointerId);
    let last = w0;
    const move = (m) => { last = Math.min(WIDTH.max, Math.max(WIDTH.min, w0 + (x0 - m.clientX))); setWidth(last); };
    const up = () => {
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerup", up);
      el.removeEventListener("pointercancel", up);
      try { globalThis.localStorage?.setItem(WIDTH.key, String(Math.round(last))); } catch {}
    };
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", up);
    el.addEventListener("pointercancel", up);
  };
  return [width, onPointerDown];
}

// A throw in Carton's part of the editor stays in it (UI audit P1-1): where nothing caught it before, Cardboard replaced
// the editor's whole tab ("This tab hit a snag"). The side panel says so, with Try again; the layer over the stage
// (preview banner, conflict cards, the footage notice) shows a small Try again in its corner, over nothing else.
// Logged as an `error` with the surface; another panel, or Try again, renders it anew. Cardboard's own preview has
// the same kind of boundary.
export class CartonBoundary extends Component {
  constructor(p) { super(p); this.state = { error: null }; }
  static getDerivedStateFromError(error) { return { error }; }
  componentDidCatch(error) { window.__cbLog?.("error", { msg: String(error?.message ?? error).slice(0, 300), src: "carton-ui.js", panel: this.props.panel }); }
  render() {
    if (!this.state.error) return this.props.children;
    const again = h(Button, { onClick: () => this.setState({ error: null }) }, "Try again");
    if (this.props.panel === "stage")
      return h("div", { className: "carton-stage-snag", role: "alert" }, h("span", null, "Conflict cards and the preview banner hit a snag."), again);
    // a dialog (Share) keeps its frame, so Esc and its ✕ still close it
    if (this.props.onClose)
      return h(Dialog, { title: this.props.title ?? words.share, onClose: this.props.onClose }, h("div", { role: "alert", className: "carton-share-snag" }, h("p", null, "This hit a snag. Nothing you’ve made is lost."), again));
    return h("div", { className: "flex flex-col items-start gap-2 p-4 text-sm text-muted-foreground", role: "alert" },
      h("p", null, "This panel hit a snag. Nothing you’ve made is lost."),
      again);
  }
}

function Sidebar({ panel, setPanel, projectId, bridge, onShare, cutsAsk, onCutsAsked }) {
  const ref = useRef(null);
  const [preferred, onResize] = useWidth();
  const fit = useFit(ref, preferred);
  const width = fit.width;
  // A drawer over the chat when the window is too narrow for the preview, the panel and the chat side by side.
  const overlay = fit.mode === "overlay" ? { position: "fixed", right: 0, top: fit.top ?? 0, height: fit.height ?? "100%", zIndex: 40, boxShadow: "-16px 0 40px -12px #000000b3" } : null;
  // Esc closes it, and only while focus is in it: the editor's own keys are never taken. A preview is the layer inside
  // it (UI audit P2-1: "… → preview → panel"): Esc returns from the preview first, as its banner's button does, and
  // the next Esc closes the panel (regress 2026-11-02 #4: it closed the panel and left the preview open).
  const ui = useCartonUi();
  const onKeyDown = (e) => {
    // an Esc a handler nearer the page took (a Radix layer's, in the capture phase) is theirs: nothing here
    if (e.key !== "Escape" || e.defaultPrevented || e.nativeEvent?.defaultPrevented) return;
    e.stopPropagation();
    if (ui.preview?.()) { void ui.openPreview(null); return; }
    setPanel(null);
  };
  useEffect(() => { ref.current?.focus({ preventScroll: true }); }, [panel]);
  // Below 1180 px the title bar has no Share icon: it joins this head, beside Close (PLAN 2.3). Two labelled tabs, it and
  // Close fit at the panel's 300 px minimum (regress 2026-11-02 P3-3 was three tabs there).
  const narrowWindow = useNarrowWindow();
  const headButton = "flex size-control-sm shrink-0 cursor-pointer items-center justify-center rounded-ui-md text-muted-foreground outline-none transition-colors hover:bg-foreground/[0.06] hover:text-foreground focus-visible:ring-2 focus-visible:ring-white/30";
  // Cardboard's own classes, as its chat sidebar uses them: same width, rule, handle, header and buttons.
  return h("aside", { ref, tabIndex: -1, className: "carton-sidebar relative shrink-0 overflow-hidden bg-[var(--desktop-panel)] outline-none", style: { width, ...overlay }, "data-carton-skin": "cardboard", "data-fit": fit.mode, "aria-label": PANELS[panel].label, onKeyDown },
    h("div", { className: "pointer-events-none absolute inset-y-0 left-0 z-10 w-px bg-white/[0.06]" }),
    h("div", { className: "relative flex h-full flex-col", style: { width } },
      h("div", { className: "group absolute top-0 bottom-0 left-0 z-10 w-1", style: { cursor: "col-resize" }, onPointerDown: onResize, role: "separator", "aria-orientation": "vertical", "aria-label": "Resize" },
        h("div", { className: "pointer-events-none absolute inset-y-0 left-1/2 w-1 -translate-x-1/2 bg-accent/80 opacity-0 transition-opacity group-hover:opacity-100" })),
      h("div", { className: "flex h-[40px] shrink-0 items-center gap-[2px] pr-[16px] pl-[12px]" },
        h("div", { className: "flex min-w-0 flex-1 items-center gap-[2px]", role: "tablist" },
          ...TABS.map((id) => h("button", {
            key: id, type: "button", role: "tab", "aria-selected": panel === id, "aria-label": PANELS[id].label, onClick: () => setPanel(id), title: PANELS[id].key ? `${PANELS[id].label} (${PANELS[id].key})` : undefined, "aria-keyshortcuts": PANELS[id].key ? "Control+Shift+H" : undefined,
            className: "relative flex h-[26px] shrink-0 cursor-pointer items-center gap-[6px] rounded-ui-md px-[8px] text-ui-sm font-medium outline-none transition-colors focus-visible:ring-2 focus-visible:ring-white/30 " +
              (panel === id ? "bg-white/[0.07] text-foreground" : "text-muted-foreground hover:bg-foreground/[0.06] hover:text-foreground"),
          }, h(Icon, { name: PANELS[id].icon, size: 14 }), PANELS[id].label))),
        narrowWindow && onShare ? h("button", { type: "button", "aria-label": words.share, title: words.share, "data-carton-share": "", onClick: onShare, className: headButton }, h(Icon, { name: "users", size: 16 })) : null,
        h("button", { type: "button", "aria-label": "Close", title: "Close (Esc)", onClick: () => setPanel(null), className: headButton },
          h(Icon, { name: "x", size: 16 }))),
      h("div", { className: "carton-sidebar-body relative flex min-h-0 flex-1 flex-col overflow-x-hidden overflow-y-auto" },
        h(CartonBoundary, { key: panel, panel }, panel === "comments" ? h(CommentsSide, { projectId, bridge }) : h(HistorySide, { projectId, bridge, cutsAsk, onCutsAsked })))));
}

/** The Share dialog over the editor (PLAN 8.1), inside its own boundary: a throw keeps the dialog's frame. */
function ShareHost({ projectId, bridge, onClose }) {
  const Share = window.__cartonSyncUi?.ShareDialog;
  if (!Share) return null;
  const name = bridge.projectName ?? null;
  return h("div", { "data-carton-skin": "cardboard" },
    h(CartonBoundary, { panel: "share", onClose, title: (name ? words.shareTitle(name) : words.shareThisProject) }, h(Share, { projectId, bridge, name, onClose })));
}

/**
 * The side panel, beside the chat, and the Share dialog: opened and closed from the title bar's icons, which show the
 * one open; the cut chip's click opens History with its cuts menu (PLAN 2.2, version 1), its ✕ goes back to your edit.
 */
export const CartonSide = memo(function CartonSide({ projectId, bridge }) {
  const [conn, ready] = useConn(projectId, bridge);
  const [panel, setPanelState] = useState(null);
  const [share, setShare] = useState(false);
  // the chip asked for the cuts menu: a count, so each click asks again; History sets it back to 0 once the menu opens
  const [cutsAsk, setCutsAsk] = useState(0);
  const cutsAsked = useCallback(() => setCutsAsk(0), []);
  const setPanel = useCallback((p) => setPanelState(p), []);
  // Share is a modal dialog: while it is open the editor's shortcut for History is its, not the page's behind it
  // (review of feat/ux-2-8 #2: History opened behind it and took the focus, and Esc then closed History, not Share).
  const shareOpen = useRef(false);
  shareOpen.current = share;
  // Ctrl+Shift+H (Cmd+Shift+H on a Mac) opens and closes History (UI audit P3-7): H is free in Cardboard's keymap,
  // and Shift with Ctrl/Cmd pairs it with Cardboard's own Ctrl+Shift+B ("Report an issue"). Only the editor's page
  // listens (this panel lives there), and only for that exact chord.
  useEffect(() => {
    const onKey = (e) => {
      if (!(e.ctrlKey || e.metaKey) || !e.shiftKey || e.altKey || (e.code !== "KeyH" && e.key !== "H" && e.key !== "h")) return;
      if (shareOpen.current) return;
      e.preventDefault();
      e.stopPropagation();
      setPanelState((p) => (p === "history" ? null : "history"));
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);
  // The title bar: its icons (the same icon again closes what it opened), the cut chip and its ✕.
  useEffect(() => bridge.onCommand?.((ev) => {
    const a = ev?.action;
    // the title bar is outside the Share dialog: its History icon closes Share and opens History
    if (a === "carton-history") { setShare(false); setPanelState((p) => (p === "history" ? null : "history")); }
    else if (a === "carton-share") setShare((o) => !o);
    else if (a === "carton-cuts") { setShare(false); setPanelState("history"); setCutsAsk((n) => n + 1); }
    else if (a === "carton-back") void Promise.resolve(backToEdit(conn.ui)).catch(() => {});
  }), [bridge, conn]);
  useEffect(() => {
    const f = (p) => (p === "share" ? setShare(true) : setPanelState(p));
    panelRequests.add(f);
    return () => { panelRequests.delete(f); };
  }, []);
  // Tell the title bar what it shows (bridge.reportPanel; main hands it to the strip): the panel open (null: none,
  // which also says the strip's Carton parts apply to this tab), a shared project's live summary for the status dot and
  // avatars (P2-11), whether Share is open, and the cut chip's cut and viewing label. Sent again only when what the
  // strip shows changes: the cuts topic changes at every version (a head moves), the chip only when a name, a dot or
  // the viewing label does. The chip's part is sent straight from the topic's notice, without waiting for a render, so a
  // switch (the cuts menu's, or cb cut switch from a terminal) reaches the title bar within the frame it lands in.
  const summary = liveSummary(useLiveStatus(projectId, bridge));
  const summaryKey = summary ? JSON.stringify(summary) : "";
  const report = useRef({ panel: null, live: null, share: false, chip: null, sent: null });
  const send = useCallback(() => {
    const r = report.current;
    const key = JSON.stringify([r.panel, r.live, r.share, r.chip]);
    if (key === r.sent) return;
    r.sent = key;
    bridge.reportPanel?.(r.panel, r.live ?? undefined, { share: r.share, cut: r.chip?.cut ?? null, viewing: r.chip?.viewing ?? null });
  }, [bridge]);
  useEffect(() => {
    Object.assign(report.current, { panel, live: summaryKey ? JSON.parse(summaryKey) : null, share });
    send();
    sidePanel.set(panel);
  }, [panel, summaryKey, share, send]);
  useEffect(() => {
    if (!ready) return undefined;
    const ui = conn.ui;
    const update = () => { report.current.chip = chipOf(ui); send(); };
    update();
    // "viewing": PLAN 0.5's topic, once the view model has it; "preview" and "cuts" until then
    const offs = ["cuts", "preview", "viewing"].map((t) => ui.subscribe(t, update));
    return () => { for (const off of offs) off(); };
  }, [conn, ready, send]);
  useEffect(() => () => sidePanel.set(null), []);
  // History closed before the menu opened: the request goes with it
  useEffect(() => { if (!panel) setCutsAsk(0); }, [panel]);
  const closeShare = useCallback(() => setShare(false), []);
  if (!panel && !share) return null;
  return h(CartonProvider, { ui: conn.ui },
    panel ? h(Sidebar, { panel, setPanel, projectId, bridge, onShare: () => setShare(true), cutsAsk, onCutsAsked: cutsAsked }) : null,
    share ? h(ShareHost, { projectId, bridge, onClose: closeShare }) : null);
});

/**
 * Opening a shared project whose footage is a teammate's (UI audit P1-9; the editor patch in sync/patches/media.js
 * keeps Cardboard's "Missing Media Files" and its "Remove and Open" away from those clips): what happened, in words.
 * Clips not sent yet show as Offline; it checks every 15 s and says when they have arrived. Closed with its ✕ or Esc.
 * Carton UX redesign PLAN 8.3: clips on their way say so in a title line, "2 clips are still on their way from Leo",
 * then which ones, by name in quotes, and that nothing was removed (`from`: the teammate, when the notice is told).
 */
function MediaNotice({ projectId, bridge }) {
  const [here, setHere] = useState(() => (window.__cartonMediaHere?.projectId === projectId ? window.__cartonMediaHere : null));
  const [closed, setClosed] = useState(false);
  const [arrived, setArrived] = useState(false);
  useEffect(() => {
    const f = (e) => { if (e.detail?.projectId === projectId) { setHere(e.detail); setClosed(false); setArrived(false); } };
    window.addEventListener("carton:media-here", f);
    return () => window.removeEventListener("carton:media-here", f);
  }, [projectId]);
  const waiting = here?.waiting ?? [];
  useEffect(() => {
    if (closed || arrived || !waiting.length || here?.unchecked) return undefined;
    const t = setInterval(() => {
      bridge.call("liveMediaHere", [{ projectId, mediaIds: waiting.map((w) => w.mediaId) }]).then((r) => {
        if (r?.clips && waiting.every((w) => r.clips[w.mediaId] === "playable")) setArrived(true);
      }, () => {});
    }, 15000);
    return () => clearInterval(t);
  }, [bridge, projectId, waiting, closed, arrived]);
  if (closed || !here || (!waiting.length && !here.playable)) return null;
  const names = waiting.slice(0, 2).map((w) => w.fileName).join(", ") + (waiting.length > 2 ? ` and ${waiting.length - 2} more` : "");
  const quoted = waiting.length > 2 ? `${waiting.slice(0, 2).map((w) => `“${w.fileName}”`).join(", ")} and ${waiting.length - 2} more` : waiting.map((w) => `“${w.fileName}”`).join(" and ");
  const onTheirWay = !here.unchecked && !arrived && waiting.length > 0;
  const title = onTheirWay ? words.clipsOnTheirWay(waiting.length, typeof here.from === "string" && here.from ? here.from : "your teammate") : null;
  const text = here.unchecked
    ? `${waiting.length === 1 ? `${names} couldn't be checked, so it shows` : `${waiting.length} clips couldn't be checked (${names}), so they show`} as Offline. Nothing was removed. Close and reopen the project to check again.`
    : arrived
    ? "Your teammate's footage has arrived. Close and reopen the project to play it."
    : waiting.length === 1
      ? words.clipOfflineUntil(quoted)
      : waiting.length
        ? words.clipsOfflineUntil(quoted)
        : "This video plays from preview copies. Its originals stay on your teammate's computer.";
  return h("div", { className: "carton-media-notice", role: "status", "data-waiting": waiting.length && !arrived ? "" : undefined, onKeyDown: (e) => { if (e.key === "Escape") { e.stopPropagation(); setClosed(true); } } },
    h(Icon, { name: waiting.length && !arrived ? "cloudSlash" : "cloudCheck", size: 14 }),
    h("span", { className: "carton-media-notice-text" }, title ? h("strong", { className: "carton-media-notice-title" }, title) : null, text),
    h(Button, { variant: "ghost", icon: "x", label: words.close, onClick: () => setClosed(true) }));
}

/**
 * A shared project's status where it is always seen (UI audit P2-11: it was only inside the Share tab): who else is
 * here, and Offline or Syncing while edits wait, in the preview's bottom-left corner. Up to date with nobody else here,
 * nothing. A click opens Share. Status words only (§0.1).
 */
/** A shared project's live status (the worker's liveStatus, then its live events), or null. */
function useLiveStatus(projectId, bridge) {
  const [st, setSt] = useState(null);
  useEffect(() => {
    let live = true;
    bridge.call("liveStatus", [{ projectId }]).then((s) => live && setSt(s), () => {});
    const off = bridge.onEvent((ev) => { if (live && ev?.id === projectId && ev.topic === "live") setSt((s) => ({ ...s, ...ev.live })); });
    return () => { live = false; if (typeof off === "function") off(); };
  }, [projectId, bridge]);
  return st;
}
const livePeers = (st) => (Array.isArray(st?.peers) ? st.peers : []).filter((p) => typeof p?.actor?.key === "string" && typeof p.actor.name === "string");
const hereWords = (peers) => (peers.length ? `${peers.map((p) => p.actor.name).slice(0, 3).join(", ")}${peers.length > 3 ? ` and ${peers.length - 3} more` : ""} ${peers.length === 1 ? "is" : "are"} here` : "");
/**
 * The title bar's summary of a shared project (UI audit P2-11): its sync state and words, and up to three of the
 * people here, as the strip draws them (scripts/carton/strip-buttons.js). Null for a project that isn't shared.
 */
export function liveSummary(st) {
  if (!st?.shared) return null;
  const peers = livePeers(st);
  const offline = st.status === "offline" || st.status === "stopped", waiting = st.pending ?? 0;
  const state = offline ? "offline" : st.status !== "up-to-date" || waiting ? "syncing" : "ok";
  return {
    state,
    // DESIGN §8: "Offline: 3 changes not sent yet", "Sending 2 changes" (PLAN 8.3)
    words: offline ? words.offlineNotSent(waiting) : state === "syncing" ? (waiting ? words.sending(waiting) : words.syncing) : words.upToDate,
    here: hereWords(peers),
    people: peers.slice(0, 3).map((p) => ({ name: p.actor.name, initials: initials(p.actor.name), color: actorColor(p.actor), idle: !!p.idle })),
    more: Math.max(0, peers.length - 3),
  };
}
function LiveChip({ projectId, bridge }) {
  const st = useLiveStatus(projectId, bridge);
  return h(LiveChipView, { st, onOpen: () => { for (const f of panelRequests) f("share"); } });
}
// Over the preview, only while edits wait (offline or sending): who is here shows in the title bar (P2-11).
function LiveChipView({ st, onOpen, peersToo = false }) {
  if (!st?.shared) return null;
  const peers = peersToo ? livePeers(st) : [];
  const offline = st.status === "offline" || st.status === "stopped";
  const waiting = st.pending ?? 0;
  // PLAN 8.3: "Offline · 3 changes not sent yet", "Sending 2 changes"
  const status = offline ? (waiting ? words.offlineChip(waiting) : words.offline(0)) : st.status !== "up-to-date" && waiting ? words.sending(waiting) : null;
  if (!status && !peers.length) return null;
  const here = hereWords(peers);
  return h("button", { type: "button", className: "carton-live-chip", "data-state": offline ? "offline" : status ? "syncing" : "ok", title: [status, here].filter(Boolean).join(" · ") + ". Open Share", "aria-label": [status, here].filter(Boolean).join(". ") + ". Open Share", onClick: onOpen },
    status ? h(Icon, { name: offline ? "cloudSlash" : "syncing", size: 14 }) : null,
    status ? h("span", null, status) : null,
    peers.length ? h("span", { className: "carton-live-peers", "aria-hidden": true }, ...peers.slice(0, 3).map((p) => h("span", { key: p.actor.key, className: "carton-avatar", "data-idle": p.idle ? "" : undefined, style: { ["--carton-actor"]: actorColor(p.actor), width: 20, height: 20, fontSize: 8 } }, h("span", { className: "carton-avatar-initials" }, initials(p.actor.name)))),
      peers.length > 3 ? h("span", { className: "carton-live-more" }, `+${peers.length - 3}`) : null) : null);
}

/**
 * Join a shared project from the Dashboard (UI audit P2-9): its tile (sync/patches/ui.js) opens this dialog
 * (scripts/carton/sync/ui.js Join: the invite link, who you join as, and Join and open, PLAN 8.2), which opens the
 * project in its tab and closes.
 */
export function JoinDialog({ bridge, onClose }) {
  useEffect(() => { injectCardboardSkin(document); }, []);
  const Join = window.__cartonSyncUi?.Join;
  return h("div", { "data-carton-skin": "cardboard" },
    Join ? h(Join, { bridge, onOpened: onClose, onCancel: onClose })
      : h(Dialog, { title: words.joinTitle, onClose, className: "carton-join-dialog" }, h("p", { className: "carton-error", role: "alert" }, words.failed)));
}

/** The layer over the stage: the conflict cards' floating stack, the preview banner, and the shared-footage notice. */
export const CartonStage = memo(function CartonStage({ projectId, bridge }) {
  const [conn, ready] = useConn(projectId, bridge);
  // what the bridge tells the person (a save that failed, an undo refused), as a toast over the stage
  useEffect(() => bridge.onNotice?.(tellFailure), [bridge]);
  // A conflict card's "See it" (docs/carton-ux PLAN 7.1): the side's timeline, read-only, with the card's clip in view,
  // so the difference is on screen, under the card's label for that side ("Claude Code's move of “Interview B”"). It
  // still goes through the deprecated openPreview (conflictRef's state, the bridge's preview) until ui.view({kind:
  // "conflict"}) reaches the editor: the worker's view() (Workstream 0, PLAN 0.5) and the stage frame that shows its
  // label (Workstream 1). Then this goes, and the card calls ui.view itself. `live()`: still wanted once loaded (the
  // card wasn't left, decided or set aside meanwhile), else nothing is shown.
  const onPreview = useCallback(async (conflict, side, label, live = () => true) => {
    const ref = await conn.ui.conflictRef?.(conflict.id, side).catch(() => null);
    if (!live()) return;
    if (!ref) throw new Error(words.loadFailed);
    await conn.ui.openPreview(ref, label);
    if (live() && conflict.item) bridge.reveal(conflict.item);
  }, [conn, bridge]);
  const onReveal = useCallback((conflict) => { if (conflict.item) bridge.reveal(conflict.item); }, [bridge]);
  const [panelOpen, setPanelOpen] = useState(sidePanel.value != null);
  useEffect(() => {
    const f = (v) => setPanelOpen(v != null);
    sidePanel.subs.add(f);
    return () => { sidePanel.subs.delete(f); };
  }, []);
  if (!ready) return null;
  return h(CartonProvider, { ui: conn.ui },
    h("div", { className: "carton-stage", "data-carton-skin": "cardboard" }, h(CartonBoundary, { panel: "stage" },
      h("div", { className: "carton-stage-banner" }, h(PreviewBanner, { escapeState: bridge.selection }), h(MediaNotice, { projectId, bridge })),
      h("div", { className: "carton-stage-stack" }, h(ConflictStack, { onPreview, onReveal, collapsed: panelOpen })),
      h("div", { className: "carton-stage-toast" }, h(Toast)),
      h("div", { className: "carton-stage-live" }, h(LiveChip, { projectId, bridge })))));
});
export const __forTests = { confirmations, toasts, tellFailure, Toast, LiveChipView, MediaNotice, Sidebar, CartonProvider, chipOf, viewingOf, backToEdit, cutColor };
