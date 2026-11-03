// Compare in the editor (Carton UX v2, docs/carton-ux/v2/DESIGN-V2.md §1; N1), the app's half. ui.js wires three
// things in, each a small hook there:
// - attachCompare(ui, …), in connect(): the comparison itself, on the page's view model (@carton/react model.ts's
//   openCompare / closeCompare / comparing / onCompare: the contract N2 calls), with what it loads (the change rows,
//   the shot alignment, both sides' timelines) and the editor's stage for it: the right side is the editor's own
//   preview, held read-only (the bridge's hold() for your edit, else the viewing swap); Flip swaps it to the left side
//   and back, as Before does.
// - CompareStage, in the stage layer: the compare bar, the players (Side by side, Wipe, Flip), Play both, the edit
//   attempt's toast, Esc, B, Export, the agent's request (§1.13), the timeline's marks and strip (§1.6).
// - CompareSide, in the side panel: the change list in place of History's list while comparing.
// The second player is editor-panel.js's (Cardboard's own preview engine on a canvas of its own), handed in as
// `player`; without one (an older bundle, a failure) Compare is Flip only (§1.10).
import { createElement as h, Component, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import {
  Button, CompareList, CompareMarks, CompareStageView, CompareStrip, CompareStripLabel, CompareLegend, COMPARE_CSS, alignRows,
  actorLabel, clock, compareMarks, compareModeShown, compareModesFor, cutColor, cutRef, followTime, isMainCut, leadTime, rowRange, stepAt, stripOf, timecode,
  playLength, playSchedule, sidesAt, storyAt, CompareRowDetail, fromBringBack, bringBackLine,
  useCartonUi, versionLabel, words,
} from "@carton/react";
import { injectStyles } from "@carton/react/skin/cardboard";

const MODE_KEY = "carton.compareMode";
const READY_MS = 2000;
const pickedMode = () => {
  try {
    const m = globalThis.localStorage?.getItem(MODE_KEY);
    return m === "side" || m === "wipe" || m === "flip" ? m : "side";
  } catch {
    return "side";
  }
};
const branchOf = (ref) => (typeof ref === "string" && ref.includes("@") ? ref.slice(0, ref.indexOf("@")) : null);
const upFirst = (s) => (s ? s[0].toUpperCase() + s.slice(1) : s);
const unquote = (s) => s.replace(/^“(.*)”$/, "$1");

// ---------------------------------------------------------------- the two sides, named once (§1.7)

/**
 * One side of a comparison from a ref (any cut's; a cut id is its head; null is your edit now): its CompareEnd, with
 * what the ordering needs (`seq`, `at`). Labels as DESIGN-V2 §1.7 and §1.12 give them.
 */
export function endOf(ui, ref, now = Date.now()) {
  const cuts = ui.cuts?.() ?? [];
  const current = cuts.find((c) => c.current) ?? null;
  if (ref == null) ref = current?.head ?? null;
  if (ref == null) return null;
  let cut = cuts.find((c) => c.id === ref) ?? null;
  if (cut) ref = cut.head;
  cut ??= cuts.find((c) => c.head === ref) ?? cuts.find((c) => branchOf(c.head) && branchOf(c.head) === branchOf(ref)) ?? null;
  const head = !!cut && cut.head === ref;
  const all = ui.history?.().all?.() ?? [];
  let v = null;
  for (let k = all.length - 1; k >= 0; k--) if (all[k].ref === ref) { v = all[k]; break; }
  const actor = (k) => ui.actor?.(k);
  const seq = Number(String(ref).split("@")[1]);
  const base = { ref, ...(cut ? { cutId: cut.id } : {}), ...(v ? { versionId: v.id } : {}), seq: Number.isFinite(seq) ? seq : null, at: v?.at ?? null, cut };
  if (head && cut.current && !cut.readOnly) return { ...base, you: true, label: words.yourEditSaid, title: words.yourEditNowLabel };
  if (v && (!cut || cut.current)) {
    const label = versionLabel(v, { actor, now });
    return { ...base, label, title: upFirst(unquote(label)), detail: clock(v.at, { now }) };
  }
  if (cut) {
    // a teammate's cut by its owner's first name ("now · Leo"), as names go everywhere (actorLabel)
    const owner = cut.readOnly && cut.owner ? actorLabel(cut.owner, actor, words.you) || null : null;
    if (head) return { ...base, label: cutRef(cut), title: cut.label, detail: [words.now, owner].filter(Boolean).join(" · ") };
    return { ...base, label: `${cutRef(cut)} (${words.anEarlierVersion})`, title: cut.label, detail: words.anEarlierVersion };
  }
  return { ...base, label: words.anEarlierVersion, title: upFirst(words.anEarlierVersion) };
}

/**
 * The two sides, the right way round (§1.1): your edit, or the cut you're on, is the right side whenever it is one of
 * the two; of two versions of one cut the older is left; two other cuts: the first picked is left. Across cuts, both
 * sides are named by their cut ("“30s Instagram cut”" with "Main cut", the latter's player "Main cut · your edit now").
 */
export function sidesOf(ui, from, to, now = Date.now()) {
  let a = endOf(ui, from, now), b = endOf(ui, to ?? null, now);
  if (!a || !b) return null;
  const current = (ui.cuts?.() ?? []).find((c) => c.current);
  const onCurrent = (e) => !!current && e.cutId === current.id;
  if (a.you || (onCurrent(a) && !onCurrent(b))) [a, b] = [b, a];
  else if (!b.you && a.cutId && a.cutId === b.cutId) {
    const older = (x, y) => (x.seq != null && y.seq != null ? x.seq < y.seq : (x.at ?? 0) <= (y.at ?? 0));
    if (!older(a, b)) [a, b] = [b, a];
  }
  const acrossCuts = !!a.cutId && !!b.cutId && a.cutId !== b.cutId;
  if (acrossCuts && b.you && b.cut) b = { ...b, label: cutRef(b.cut), title: b.cut.label, detail: words.yourEditNowLabel.toLowerCase() };
  // each side's cut mark, as the cuts menu and the chip draw it: scissors for Main cut, else its colour dot
  const clean = ({ seq, at, cut, ...e }) => ({ ...e, ...(cut ? { cutMark: { main: isMainCut(cut), dot: cutColor(cut) ?? null } } : {}) });
  return { left: clean(a), right: clean(b), acrossCuts };
}

/** The chip's and the stage region's words: "Comparing “Sent to client” with your edit". */
export const comparingLabel = (c) => (c ? words.comparing(c.left.label, c.right.label) : "");

// ---------------------------------------------------------------- the comparison, on the page's view model

/**
 * Compare on the page's view model (connect() calls it once per connection). o: { bridge, projectId, swap (connect's:
 * the stage, marked), cancelView (no pending view swaps the editor any more), view (the worker's view, without a
 * swap), seek }. Adds ui.openCompare / closeCompare / comparing / onCompare (model.ts), ui.compareMode(m), and
 * ui.compareData() / ui.compareSelect(change) for this page's parts.
 */
export function attachCompare(ui, o) {
  const subs = new Set();
  let value = null, data = null, seq = 0, back = null, selected = null, flipped = false, version = 0;
  const notify = () => { version++; for (const f of [...subs]) try { f(); } catch (e) { console.warn("[carton] compare:", e?.message ?? e); } };
  const projectId = o.projectId;
  const bridge = o.bridge;
  // the right side's stage: your edit held read-only as it is (no checkout), else that version, read-only
  const showRight = (right) => (right.you && typeof bridge.hold === "function" ? (o.unmark?.(), bridge.hold(projectId)) : o.swap(right.ref));
  const load = (c) => {
    const key = `${c.left.ref}|${c.right.ref}`;
    if (data?.key === key) return;
    const d = { key, status: "loading", changes: null, diff: null, rows: null, leftDoc: null, rightDoc: null, error: null };
    data = d;
    const mine = () => data === d;
    const doc = (ref) => (typeof bridge.compareDoc === "function" ? bridge.compareDoc(projectId, ref).catch(() => null) : Promise.resolve(null));
    Promise.all([
      // across cuts, the rows say where a clip is ("Only in Main cut: …"), not what someone did (§1.12; N0's words)
      ui.changes(c.left.ref, c.right.ref, { between: c.acrossCuts ? "cuts" : "versions" }),
      typeof ui.shotDiff === "function" ? ui.shotDiff(c.left.ref, c.right.ref).catch(() => null) : null,
    ]).then(([changes, diff]) => {
      if (!mine()) return;
      Object.assign(d, { status: "ready", changes, diff, rows: diff ? alignRows(diff) : null });
      notify();
    }, (e) => {
      if (!mine()) return;
      Object.assign(d, { status: "error", error: e });
      notify();
    });
    // both by their exact refs (your edit too: the head the cuts say, which the list's rows are against; the editor's
    // held copy may not have caught up with a head that just moved: review #4)
    Promise.all([doc(c.left.ref), doc(c.right.ref)]).then(([l, r]) => {
      if (!mine()) return;
      Object.assign(d, { leftDoc: l, rightDoc: r });
      notify();
    });
  };
  const set = (v) => {
    value = v;
    if (v) load(v);
    else { data = null; selected = null; flipped = false; }
    notify();
  };

  ui.comparing = () => value;
  // goes up at every change (the comparison, what it loaded, the row picked, Flip): useComparing re-reads on it
  ui.compareVersion = () => version;
  ui.onCompare = (f) => { subs.add(f); return () => { subs.delete(f); }; };
  ui.compareData = () => data;
  ui.compareSelected = () => selected;
  ui.compareFlipped = () => flipped;
  ui.openCompare = async (from, to, opts = {}) => {
    const mine = ++seq;
    const sides = sidesOf(ui, from, to ?? null);
    if (!sides) throw new Error(words.compareFailed);
    // never stacked on viewing (§1.11): what loads for a view never swaps the editor now; the worker forgets it
    const viewing = (typeof ui.viewing === "function" && ui.viewing()) || ui.pendingView?.();
    o.cancelView?.();
    if (viewing) Promise.resolve(o.view?.(null)).catch(() => {});
    if (!value) back = { at: bridge.clock?.() ?? null };
    const mode = opts.mode === "side" || opts.mode === "wipe" || opts.mode === "flip" ? opts.mode : pickedMode();
    selected = null;
    flipped = false;
    set({ ...sides, mode, ...(opts.by ? { by: opts.by } : {}) });
    bridge.libraryAside?.(true);
    try {
      await showRight(sides.right);
      // a newer open or a close since: theirs to place the playhead (review #5)
      if (mine !== seq) return;
      bridge.prefetch?.(projectId, sides.left.ref);
      if (Number.isFinite(opts.at)) bridge.seek?.(opts.at);
    } catch (e) {
      if (mine === seq) {
        set(null);
        bridge.libraryAside?.(false);
        await Promise.resolve(o.swap(null)).catch(() => {});
      }
      throw e;
    }
  };
  ui.closeCompare = async () => {
    if (!value) return;
    const was = value, mine = ++seq, at = back?.at;
    back = null;
    clearTimeout(spot);
    stopBoth();
    bridge.pause?.();
    set(null);
    // your edit again, on the cut you were on: the playhead stays at the change when the right side was your edit,
    // else it goes back where it was before comparing (§1.7); not if a new comparison opened meanwhile (review #5)
    bridge.libraryAside?.(false);
    await o.swap(null);
    if (mine === seq && !was.right.you && Number.isFinite(at)) bridge.seek?.(at);
  };
  ui.compareMode = (m) => {
    if (!value || value.mode === m) return;
    try { globalThis.localStorage?.setItem(MODE_KEY, m); } catch {}
    const leaving = value.mode === "flip" && flipped;
    flipped = false;
    set({ ...value, mode: m });
    // Flip's left side shown: the right side back on the stage
    if (leaving) void Promise.resolve(showRight(value.right)).catch(() => {});
  };
  // Flip (hold B, or the pill): the editor's one preview shows the left side, then the right again, as Before swaps
  // at the same moment (review #2): the left side at the right side's moment mapped in step by shot, and the right
  // side's own moment back on release
  let flipAt = null;
  ui.compareFlip = (show) => {
    if (!value) return undefined;
    const left = show === "left";
    if (left === flipped) return undefined;
    flipped = left;
    notify();
    const c = value, d = data;
    if (left) {
      flipAt = bridge.clock?.() ?? null;
      const to = Number.isFinite(flipAt) && d?.diff && d.rows ? followTime(d.diff, d.rows, flipAt) : flipAt;
      return Promise.resolve(o.swap(c.left.ref)).then(() => { if (flipped && value === c && Number.isFinite(to)) bridge.seek?.(to); }, () => {});
    }
    const at = flipAt;
    flipAt = null;
    return Promise.resolve(showRight(c.right)).then(() => { if (!flipped && value === c && Number.isFinite(at)) bridge.seek?.(at); }, () => {});
  };
  // A change picked (the list, the timeline): both players there, paused (§1.5). The right side's place; a removal's
  // is where it was, mapped from the left. The left player follows the right's time (in step by shot).
  ui.compareSelect = (change) => {
    if (!value) return;
    if (both.on) stopBoth();
    selected = change?.key ?? null;
    notify();
    if (!change || !Number.isFinite(change.at)) return;
    bridge.pause?.();
    const d = data;
    const t = change.kind === "remove" && d?.diff && d.rows ? leadTime(d.diff, d.rows, change.at) : change.at;
    bridge.seek?.(Math.max(0, t));
  };
  // Play both (§1.4), in step by shot, on a clock of Compare's own (the story: the aligned stretches end to end, each as
  // long as its longer side). The right side is the editor's own player: it plays while its shot runs, and waits paused
  // on its shot's last frame (or at the join, under a slate, where it has no shot) while the other side's runs on. The
  // left player takes its time from the story (compareLeftClock). One rAF loop, only while Play both runs; stopped,
  // nothing runs. `until`: a story time to stop at (a row's ▶).
  const both = { on: false, T: 0, until: null, raf: 0, last: 0, at: null, sched: null, subs: new Set() };
  const tellBoth = () => { for (const f of [...both.subs]) try { f(); } catch {} };
  const stopBoth = () => {
    if (!both.on) return;
    both.on = false;
    cancelAnimationFrame(both.raf);
    if (bridge.playing) bridge.pause?.();
    // the editor stays where the right side is: its own moment, or where it waits
    if (both.at && Number.isFinite(both.at.b.t)) bridge.seek?.(both.at.b.t);
    tellBoth();
    notify();
  };
  const stepBoth = (now) => {
    if (!both.on) return;
    const dt = Math.min(0.25, Math.max(0, (now - both.last) / 1000));
    both.last = now;
    both.T += dt;
    const end = Math.min(playLength(both.sched), both.until ?? Infinity);
    if (both.T >= end) { both.T = end; both.at = sidesAt(both.sched, Math.max(0, end - 1e-3)); stopBoth(); return; }
    const at = sidesAt(both.sched, both.T), was = both.at;
    both.at = at;
    // the right side: playing while its shot runs; else waiting, paused, at its last frame (or at the join)
    const waits = at.b.hold || at.b.slate;
    if (waits) {
      if (bridge.playing) bridge.pause?.();
      if (!was || was.stretch !== at.stretch || !(was.b.hold || was.b.slate)) bridge.seek?.(at.b.t);
    } else if (!bridge.playing) {
      bridge.seek?.(at.b.t);
      bridge.togglePlay?.();
    } else if (Math.abs((bridge.clock?.() ?? at.b.t) - at.b.t) > 0.3) bridge.seek?.(at.b.t);
    if (!was || was.stretch !== at.stretch || was.a.hold !== at.a.hold || was.b.hold !== at.b.hold || was.a.slate !== at.a.slate || was.b.slate !== at.b.slate) notify();
    tellBoth();
    both.raf = requestAnimationFrame(stepBoth);
  };
  ui.comparePlayBoth = (o = {}) => {
    if (!value) return;
    if (both.on && o.from === undefined) return stopBoth();
    const d = data;
    // (the alignment not loaded yet: the editor's own play, the left player following it)
    if (!d?.diff || !d.rows) { bridge.togglePlay?.(); return; }
    clearTimeout(spot);
    cancelAnimationFrame(both.raf);
    both.sched = playSchedule(d.diff, d.rows);
    const from = Number.isFinite(o.from) ? o.from : (bridge.clock?.() ?? 0);
    both.T = storyAt(both.sched, "b", from);
    if (both.T >= playLength(both.sched) - 1e-3) both.T = 0;
    both.until = Number.isFinite(o.until) ? o.until : null;
    both.at = null;
    both.on = true;
    both.last = performance.now();
    notify();
    both.raf = requestAnimationFrame(stepBoth);
  };
  ui.compareBoth = () => (both.on ? { T: both.T, length: playLength(both.sched), at: both.at } : null);
  // The left player's time (editor-panel.js's second player): the story's while Play both runs
  ui.compareLeftClock = {
    active: () => both.on,
    get: () => both.at?.a.t ?? 0,
    playing: () => both.on && !!both.at && !both.at.a.hold && !both.at.a.slate,
    subscribe: (f) => { both.subs.add(f); return () => { both.subs.delete(f); }; },
  };
  // ▶ on a row, Enter (§1.5): that spot on both sides, a second either side, in step; then paused
  let spot = null;
  ui.comparePlay = (change) => {
    if (!value || !change || !Number.isFinite(change.at)) return;
    ui.compareSelect(change);
    const d = data;
    const t = change.kind === "remove" && d?.diff && d.rows ? leadTime(d.diff, d.rows, change.at) : change.at;
    const end = Number.isFinite(change.end) ? Math.max(t, change.kind === "remove" ? t : change.end) : t;
    if (d?.diff && d.rows) {
      const sched = playSchedule(d.diff, d.rows), from = Math.max(0, t - 1);
      const T0 = storyAt(sched, "b", from), T1 = storyAt(sched, "b", end) + 1;
      return ui.comparePlayBoth({ from, until: Math.min(T0 + 10, Math.max(T1, T0 + 2)) });
    }
    bridge.seek?.(Math.max(0, t - 1));
    clearTimeout(spot);
    if (!bridge.playing) bridge.togglePlay?.();
    spot = setTimeout(() => { if (value) bridge.pause?.(); }, Math.min(10, end - t + 2) * 1000);
  };
  // "Your edit now" follows your edit (§1.8): a version saved on the cut you're on (an agent's, a teammate's, a Bring
  // back) moves the right side to it, the list and the marks with it, and the stage reads it (hold, which re-reads a
  // head that moved). The selected row stays while it exists.
  const offCuts = ui.subscribe?.("cuts", () => {
    if (!value?.right.you) return;
    const head = ui.cuts().find((c) => c.current)?.head;
    if (!head || head === value.right.ref) return;
    set({ ...value, right: { ...value.right, ref: head } });
    if (!flipped) void Promise.resolve(showRight(value.right)).catch(() => {});
  });
  return () => { offCuts?.(); };
}

// ---------------------------------------------------------------- hooks

/**
 * The comparison, re-read at every change (what it loaded, the row picked too). An external store: a change between a
 * render and its effect (Preact runs effects after paint) is never missed.
 */
export function useComparing(ui) {
  const subscribe = useCallback((f) => (typeof ui.onCompare === "function" ? ui.onCompare(f) : () => {}), [ui]);
  const version = useCallback(() => (typeof ui.compareVersion === "function" ? ui.compareVersion() : 0), [ui]);
  useSyncExternalStore(subscribe, version, version);
  return typeof ui.comparing === "function" ? ui.comparing() : null;
}

/** The editor's playhead, read while it plays (4 a second: labels, progress) and on each of its moves. */
function usePlayhead(bridge, on) {
  const [t, setT] = useState(() => bridge.clock?.() ?? 0);
  const [playing, setPlaying] = useState(() => !!bridge.playing);
  useEffect(() => {
    if (!on) return undefined;
    const read = () => { setT(bridge.clock?.() ?? 0); setPlaying(!!bridge.playing); };
    read();
    const off = bridge.onTimeline?.(read);
    return () => { if (typeof off === "function") off(); };
  }, [bridge, on]);
  useEffect(() => {
    if (!on || !playing) return undefined;
    const id = setInterval(() => setT(bridge.clock?.() ?? 0), 250);
    return () => clearInterval(id);
  }, [bridge, on, playing]);
  return [t, playing];
}

/** An element's box, kept up to date (ResizeObserver), relative to `host`. */
function useBox(host) {
  const [el, setEl] = useState(null);
  const [box, setBox] = useState(null);
  useLayoutEffect(() => {
    if (!el) { setBox(null); return undefined; }
    const measure = () => {
      const a = el.getBoundingClientRect(), b = (host?.() ?? el.offsetParent ?? document.body).getBoundingClientRect();
      const next = { top: Math.round(a.top - b.top), left: Math.round(a.left - b.left), right: Math.round(b.right - a.right), bottom: Math.round(b.bottom - a.bottom), width: Math.round(a.width), height: Math.round(a.height) };
      // (its size too: a box whose insets stay the same as the stage narrows has a new width)
      setBox((was) => (was && was.top === next.top && was.left === next.left && was.right === next.right && was.bottom === next.bottom && was.width === next.width && was.height === next.height ? was : next));
    };
    measure();
    const ro = typeof ResizeObserver === "function" ? new ResizeObserver(measure) : null;
    ro?.observe(el);
    const hostEl = host?.();
    if (hostEl) ro?.observe(hostEl);
    window.addEventListener("resize", measure);
    return () => { ro?.disconnect(); window.removeEventListener("resize", measure); };
  }, [el, host]);
  return [setEl, box];
}

/** A failure in the second player stays in it: Compare then falls back to Flip (§1.10). */
class PlayerBoundary extends Component {
  constructor(p) { super(p); this.state = { failed: false }; }
  static getDerivedStateFromError() { return { failed: true }; }
  componentDidCatch(e) { window.__cbLog?.("error", { msg: String(e?.message ?? e).slice(0, 300), src: "carton-compare", part: "player" }); this.props.onFail?.(); }
  render() { return this.state.failed ? null : this.props.children; }
}

// Cardboard's picture laid into the hole the stage view leaves (editor-panel.js publishes the insets on the stage's
// host): its stage div's padding is the hole, which its own ResizeObserver measures to size the picture, and its pan and
// zoom wrapper covers the hole, with no pan or zoom while comparing (the left player matches it exactly). The timeline:
// only Cardboard's clip canvases muted (the marks stay bright), and room for the left side's strip above the tracks.
const HOST = "[data-carton-stage-host][data-carton-compare]";
const TL = '[data-analytics-region="editor-timeline"][data-carton-compare]';
export const STAGE_CSS = `
${HOST}>:first-child{padding:var(--carton-hole-t,0) var(--carton-hole-r,0) var(--carton-hole-b,0) var(--carton-hole-l,0)!important}
${HOST}>:first-child>:first-child{inset:var(--carton-hole-t,0) var(--carton-hole-r,0) var(--carton-hole-b,0) var(--carton-hole-l,0)!important;width:auto!important;height:auto!important;transform:none!important}
${TL}>*{position:relative}
${TL}>*::after{content:"";position:absolute;inset:0;z-index:40;box-shadow:inset 0 0 0 2px #8ab4ff66;pointer-events:none}
${TL} canvas[data-timeline-canvas-layer]{filter:saturate(.35) brightness(.7)}
${TL} [data-tracks-content]{padding-top:26px}
${TL} [data-vertical-scroll-region].no-scrollbar>:first-child{margin-top:26px}
`;

// ---------------------------------------------------------------- the stage

/**
 * The stage while comparing (§1.3–1.5, 1.8–1.10, 1.13): CompareStageView over the stage, the hole for Cardboard's own
 * picture, the second player, Play both, Flip, keys, the edit-attempt toast, Export, and the timeline's marks and strip.
 * `toast(text, actions, tone, icon)`: ui.js's toasts. `panel`: the side panel open (the list is on screen).
 */
export function CompareStage({ projectId, bridge, player: Player, portal, panel, toast, openPanel }) {
  const ui = useCartonUi();
  const c = useComparing(ui);
  useEffect(() => { injectStyles(document, COMPARE_CSS, "carton-compare-css"); injectStyles(document, STAGE_CSS, "carton-compare-stage-css"); }, []);
  // the agent's request (§1.13) is listened for whether or not a comparison is open
  useCompareAsks({ ui, bridge, projectId, toast, openPanel, panel });
  useEffect(() => () => window.__cartonStageMode?.(null), []);
  if (!c) return h(StageOff, null);
  return h(CompareOn, { key: `${c.left.ref}|${c.right.ref}`, ui, c, projectId, bridge, Player, portal, panel, toast });
}
function StageOff() {
  useEffect(() => { window.__cartonStageMode?.(null); }, []);
  return null;
}

function CompareOn({ ui, c, projectId, bridge, Player, portal, panel, toast }) {
  const data = ui.compareData?.() ?? null;
  const selected = ui.compareSelected?.() ?? null;
  const flipped = !!ui.compareFlipped?.();
  const stageEl = useCallback(() => document.querySelector("[data-carton-stage-host]"), []);
  const [rootRef, rootBox] = useBox(stageEl);
  const [holeRef, hole] = useBox(stageEl);
  const width = rootBox?.width ?? 0;
  // the second player: none in this bundle, it failed, or it didn't start within 2 s → Flip only (§1.10)
  const [failed, setFailed] = useState(false);
  const told = useRef(false);
  const avail = compareModesFor(width, !!Player && !failed);
  const mode = compareModeShown(c.mode, avail);
  const needsPlayer = mode === "side" || mode === "wipe";
  const [ready, setReady] = useState(false);
  const onReady = useCallback((r) => { if (r) setReady(true); }, []);
  // the edit-attempt line goes with Compare
  useEffect(() => () => toast?.clearViewing?.(), [toast]);
  useEffect(() => {
    if (!needsPlayer || ready || failed || !Player) return undefined;
    const t = setTimeout(() => setFailed(true), READY_MS);
    return () => clearTimeout(t);
  }, [needsPlayer, ready, failed, Player]);
  useEffect(() => {
    if (!failed || told.current || c.mode === "flip") return;
    told.current = true;
    toast?.(words.sideBySideFailed(c.left.label), null, "warning");
  }, [failed, c.mode, c.left.label, toast]);
  // Flip left showing the left side and the mode shown is no longer Flip (the stage widened, a mode picked): the
  // right side back on the stage (review #3)
  useEffect(() => { if (mode !== "flip" && ui.compareFlipped?.()) ui.compareFlip?.("right"); }, [mode, ui]);
  // Cardboard's picture into the hole (the right side): the insets on the stage's host
  useLayoutEffect(() => {
    window.__cartonStageMode?.(hole ? { mode, hole: { top: hole.top, right: hole.right, bottom: hole.bottom, left: hole.left } } : { mode });
  }, [mode, hole?.top, hole?.right, hole?.bottom, hole?.left]);

  const [t0, editorPlaying] = usePlayhead(bridge, true);
  // Play both (its own clock: either side may wait, or show a slate): its sides, read four times a second while it runs
  const bothNow = ui.compareBoth?.() ?? null;
  const [, tickBoth] = useState(0);
  useEffect(() => {
    if (!bothNow) return undefined;
    const id = setInterval(() => tickBoth((n) => (n + 1) | 0), 250);
    return () => clearInterval(id);
  }, [!!bothNow]);
  const at = bothNow?.at ?? null;
  const playing = editorPlaying || !!bothNow;
  const t = at ? at.b.t : t0;
  const diff = data?.diff ?? null, rows = data?.rows ?? null;
  const follow = useCallback((x) => (diff && rows ? followTime(diff, rows, x) : x), [diff, rows]);
  const leftAt = at ? at.a.t : follow(t);
  // in step (§1.4): "same shot" in a matched run; "waiting" on the side whose shot is shorter; a slate on a side with no
  // shot there ("“Drone shot” isn't in “Sent to client”"), the right side's too while Play both runs
  let leftStep = null, rightStep = null, slate = null, rightSlate = null;
  const slateOf = (shot, side) => ({ title: words.notInSide(shot ? `“${shot}”` : words.thisShot, side), body: words.itsShotPlays });
  if (at) {
    const same = at.stretch?.kind === "same";
    leftStep = at.a.hold ? "waiting" : same ? "same" : null;
    rightStep = at.b.hold ? "waiting" : same ? "same" : null;
    if (at.a.slate) slate = slateOf(at.a.missing, c.left.label);
    if (at.b.slate) rightSlate = slateOf(at.b.missing, c.right.label);
  } else if (diff && rows) {
    const kind = stepAt(diff, rows, t);
    if (kind === "same") rightStep = leftStep = "same";
    else {
      const row = rows.find((r) => { const [s, e] = rowRange(diff, r, "b"); return t < e || (t <= e && s === e); }) ?? rows[rows.length - 1];
      if (row && row.a1 === row.a0) {
        const shot = diff.b[row.b0]?.label;
        slate = { title: words.notInSide(shot ? `“${shot}”` : words.thisShot, c.left.label), body: words.itsShotPlays };
      } else if (row) {
        const [as, ae] = rowRange(diff, row, "a");
        if (ae > as && leftAt >= ae - 0.001) leftStep = "waiting";
      }
    }
  }
  const length = bridge.editLength?.() ?? 0;
  const n = data?.changes?.length ?? null;
  const count = n == null ? null : c.acrossCuts ? words.differences(n) : words.changes(n);
  const label = comparingLabel(c);
  // the frame's own label when the list isn't on screen (the panel closed, or the drawer hidden: §1.9)
  const frameLabel = panel === "history" ? null : `${label}${count ? ` · ${count}` : ""}`;

  // an edit tried while comparing (§1.8): Cardboard's refusal path asks here first; one line, one pulse
  const [pulse, setPulse] = useState(0);
  const lastTry = useRef(0);
  useEffect(() => bridge.onBlocked?.(() => {
    if (!ui.comparing?.()) return false;
    const now = Date.now();
    if (now - lastTry.current < 1200) return true;
    lastTry.current = now;
    const cc = ui.comparing();
    const two = !cc.right.you && !cc.acrossCuts;
    toast?.(two ? words.youreComparingTwo : words.youreComparing(cc.left.label, cc.right.label), { label: two ? words.backToMyEdit : words.doneComparing, run: () => ui.closeCompare() }, "viewing", "compare");
    setPulse((k) => k + 1);
    return true;
  }), [bridge, ui, toast]);
  // Export while comparing: back to your edit first, as with viewing (§1.7)
  useEffect(() => bridge.onBack?.((why) => {
    if (!ui.comparing?.()) return null;
    if (why === "export") toast?.(words.backToExport);
    return Promise.resolve(ui.closeCompare());
  }), [bridge, ui, toast]);
  // Esc (after a menu, a latched flip or a drag), B held in Flip
  const live = useRef({ mode, flipped });
  live.current = { mode, flipped };
  useEffect(() => {
    const typing = (el) => !!el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName ?? ""));
    let bHeld = false;
    const down = (e) => {
      if (e.key === "Escape") {
        if (e.defaultPrevented || e.isComposing) return;
        const target = e.target;
        // Cardboard's own Esc clears a clip selection first, without saying so: that Esc was its (as viewing's)
        const before = bridge.selection?.();
        setTimeout(() => {
          if (e.defaultPrevented || !ui.comparing?.()) return;
          if (!Object.is(bridge.selection?.(), before)) return;
          if (target && target !== document.body && target !== document.documentElement && !target.closest?.("[data-carton-skin], .carton-compare, [data-carton-stage-host], [data-analytics-region='editor-timeline']")) return;
          if (live.current.flipped) { ui.compareFlip?.("right"); return; }
          void ui.closeCompare?.();
        }, 0);
        return;
      }
      // Space: Play both / pause (§1.14), in place of the editor's own play, while comparing
      if ((e.key === " " || e.code === "Space") && !e.ctrlKey && !e.metaKey && !e.altKey && !e.repeat && !typing(e.target) && !(e.target?.closest?.("button, [role=slider], [role=radio]"))) {
        e.preventDefault();
        e.stopPropagation();
        ui.comparePlayBoth?.();
        return;
      }
      if ((e.key === "b" || e.key === "B") && !e.ctrlKey && !e.metaKey && !e.altKey && live.current.mode === "flip" && !typing(e.target)) {
        e.preventDefault();
        e.stopPropagation();
        if (!e.repeat && !bHeld) { bHeld = true; ui.compareFlip?.("left"); }
      }
    };
    const up = (e) => {
      if ((e.key === "b" || e.key === "B") && bHeld) {
        bHeld = false;
        e.preventDefault();
        e.stopPropagation();
        ui.compareFlip?.("right");
      }
    };
    window.addEventListener("keydown", down, true);
    window.addEventListener("keyup", up, true);
    return () => { window.removeEventListener("keydown", down, true); window.removeEventListener("keyup", up, true); };
  }, [ui, bridge]);

  // announced once on entering (§1.14); "Back to your edit" on leaving is ui.js's (the chip's report)
  const [said, setSaid] = useState("");
  useEffect(() => { if (count) setSaid(words.comparingAnnounce(c.left.label, c.right.label, count)); }, [count != null]);

  const [wipe, setWipe] = useState(50);
  const leftSide = { title: c.left.title, detail: c.left.detail, cut: c.acrossCuts ? c.left.cutMark : undefined, at: leftAt, step: leftStep, slate };
  const rightSide = { title: c.right.title, detail: c.right.detail, cut: c.acrossCuts ? c.right.cutMark : undefined, at: t, step: rightStep, slate: rightSlate };
  const ratio = aspectOf(data?.rightDoc?.aspectRatio ?? data?.leftDoc?.aspectRatio);
  // the same element while nothing it shows changed: Play both's 4 Hz label ticks re-render this stage, not the player
  const leftDoc = data?.leftDoc ?? null;
  const onFail = useCallback(() => setFailed(true), []);
  const playerEl = useMemo(() => (needsPlayer && Player && !failed && leftDoc
    ? h(PlayerBoundary, { onFail }, h(Player, { doc: leftDoc, follow, onReady, clock: ui.compareLeftClock }))
    : null), [needsPlayer, Player, failed, leftDoc, follow, onReady, onFail]);
  return h("div", { ref: rootRef, className: "carton-compare-root" },
    h("span", { className: "carton-sr", role: "status", "aria-live": "polite" }, said),
    h(CompareStageView, {
      left: leftSide, right: rightSide, label, mode, modes: avail.modes, sideOff: avail.sideOff, compact: avail.compact,
      onMode: (m) => ui.compareMode?.(m), count, onDone: () => void ui.closeCompare?.(),
      player: playerEl, ratio, holeRef, flipped, onFlip: (show) => ui.compareFlip?.(show),
      wipe, onWipe: setWipe, playing, onPlayBoth: () => ui.comparePlayBoth?.(), progress: bothNow ? (bothNow.length > 0 ? bothNow.T / bothNow.length : 0) : length > 0 ? t / length : 0,
      frameLabel, pulse,
    }),
    // (while Flip shows the left side the timeline shows it too: the marks, which are the right side's, wait)
    portal && !flipped ? h(CompareTimeline, { ui, c, data, bridge, portal, selected, leftAt, playing }) : null);
}

const aspectOf = (ar) => {
  const m = typeof ar === "string" ? /^(\d+(?:\.\d+)?):(\d+(?:\.\d+)?)$/.exec(ar) : null;
  return m && Number(m[2]) > 0 ? Number(m[1]) / Number(m[2]) : 16 / 9;
};

// ---------------------------------------------------------------- the timeline (§1.6)

/**
 * The marks over Cardboard's own clips and the left side's strip, portalled into its timeline (the tracks surface and
 * the tracks' scroll area: they scroll with the clips, with no listener of ours). Laid out from the timeline's own
 * geometry: each clip at start × pixels-per-second on its track's row (the surface's [data-track-id] rows). Re-laid on
 * zoom, on the tracks changing and on the surface's size; nothing per frame. If Cardboard's structure isn't there, they
 * don't draw, and the list, the players and the jumps still work.
 */
function CompareTimeline({ ui, c, data, bridge, portal, selected, leftAt }) {
  const [geo, setGeo] = useState(null);
  useEffect(() => {
    // the timeline's wrapper says "comparing": the clip canvases muted, room for the strip
    let frame = 0;
    const read = () => {
      frame = 0;
      const root = document.querySelector('[data-analytics-region="editor-timeline"]') ?? document;
      const surface = root.querySelector("[data-timeline-canvas-surface]");
      const content = root.querySelector("[data-tracks-content]");
      const names = root.querySelector("[data-vertical-scroll-region].no-scrollbar");
      const toolbar = root.querySelector(".justify-between>.flex-1.justify-end");
      const pps = bridge.timelineScale?.()?.pps;
      if (!surface || !(pps > 0)) { setGeo(null); return; }
      const rows = new Map();
      for (const el of surface.querySelectorAll(":scope > [data-track-id]")) rows.set(el.getAttribute("data-track-id"), { top: el.offsetTop, height: el.offsetHeight });
      setGeo((was) => {
        const same = was && was.surface === surface && was.content === content && was.names === names && was.toolbar === toolbar && was.pps === pps && was.rows.size === rows.size && [...rows].every(([k, r]) => was.rows.get(k)?.top === r.top && was.rows.get(k)?.height === r.height);
        return same ? was : { surface, content, names, toolbar, pps, rows };
      });
    };
    const soon = () => { if (!frame) frame = requestAnimationFrame(read); };
    read();
    const off = bridge.onTimeline?.(soon);
    const ro = typeof ResizeObserver === "function" ? new ResizeObserver(soon) : null;
    const surface = document.querySelector("[data-timeline-canvas-surface]");
    if (surface) ro?.observe(surface);
    const mo = typeof MutationObserver === "function" && surface ? new MutationObserver(soon) : null;
    mo?.observe(surface, { childList: true });
    return () => { if (typeof off === "function") off(); ro?.disconnect(); mo?.disconnect(); if (frame) cancelAnimationFrame(frame); };
  }, [bridge]);
  const marks = useMemo(() => (data?.changes ? compareMarks(data.changes, data.leftDoc, data.rightDoc, data.diff) : []), [data?.changes, data?.leftDoc, data?.rightDoc, data?.diff]);
  const counts = useMemo(() => {
    const m = new Map();
    for (const ch of data?.changes ?? []) if (ch.itemId) m.set(ch.itemId, (m.get(ch.itemId) ?? 0) + 1);
    return m;
  }, [data?.changes]);
  const strip = useMemo(() => (data?.diff && data.rows ? stripOf(data.diff, data.rows) : []), [data?.diff, data?.rows]);
  const onPick = useCallback((key) => {
    const ch = (ui.compareData?.()?.changes ?? []).find((x) => x.key === key);
    if (ch) ui.compareSelect?.(ch);
  }, [ui]);
  if (!geo) return null;
  const parts = [portal(h(CompareMarks, { marks, pps: geo.pps, rows: geo.rows, selected, counts, onPick }), geo.surface)];
  if (geo.content) parts.push(portal(h(CompareStrip, { bars: strip, pps: geo.pps, label: c.left.title, playhead: leftAt }), geo.content));
  if (geo.names) parts.push(portal(h(CompareStripLabel, { label: c.left.title }), geo.names));
  if (geo.toolbar) parts.push(portal(h(CompareLegend, null), geo.toolbar));
  return h("div", { hidden: true, "data-carton-compare-timeline": "" }, ...parts);
}

// ---------------------------------------------------------------- the side panel (§1.2)

/** The History panel while comparing: the range, the count, every change; ← History ends Compare. */
/**
 * The picked row's detail (§1.5): Then / Now and Bring back, from the engine's "Choose a clip…" (N0's bringBackChoices
 * for the left side, N0b's token, place and ripple). Read once per comparison, on the first pick, and again after a
 * Bring back or a refusal. Only where Bring back means something: the left side a version of your cut, your edit on
 * the right.
 */
function useClipChoices(ui, c, selected) {
  const [st, setSt] = useState({ key: null, map: null, raw: null });
  const can = !!c && c.right.you && !c.acrossCuts && typeof ui.bringBackChoices === "function";
  const key = can ? `${c.left.ref}|${c.right.ref}` : null;
  const load = useCallback(() => {
    if (!key) return;
    const k = key;
    ui.bringBackChoices(c.left.ref).then((r) => {
      const raw = new Map([...r.changed, ...r.deleted, ...r.added].map((x) => [x.itemId, x]));
      setSt({ key: k, map: new Map(fromBringBack(r).map((x) => [x.itemId, x])), raw });
    }, () => setSt({ key: k, map: new Map(), raw: new Map() }));
  }, [ui, key]);
  useEffect(() => { if (key && selected && st.key !== key) load(); }, [key, selected, st.key, load]);
  return { choices: st.key === key ? st.map : null, raw: st.key === key ? st.raw : null, reload: load, can };
}

export function CompareSide({ bridge, onFoldIn }) {
  const ui = useCartonUi();
  const c = useComparing(ui);
  const data = ui.compareData?.() ?? null;
  const selectedKey = ui.compareSelected?.() ?? null;
  const clips = useClipChoices(ui, c, selectedKey);
  const [act, setAct] = useState({ busy: null, note: null });
  // Restore asks first, with its consequence (as the Changes view did), and Compare stays open with your edit updated
  // (§1.8): the right side follows your edit
  const [confirm, setConfirm] = useState(null);
  const key = c ? `${c.left.ref}|${c.right.ref}` : "";
  useEffect(() => setConfirm(null), [key]);
  if (!c) return null;
  const selected = ui.compareSelected?.() ?? null;
  const n = data?.changes?.length ?? null;
  const len = bridge?.editLength?.();
  const countWord = n == null ? null : c.acrossCuts ? words.differences(n) : words.changes(n);
  const count = countWord ? (len > 0 ? words.compareCountLength(countWord, timecode(len)) : countWord) : null;
  const strong = (s) => h("b", null, s);
  const range = c.acrossCuts
    ? [h("span", null, strong(c.left.label), c.left.detail ? ` · ${c.left.detail}` : ""), h("span", null, `${words.compareWithWord} `, strong(c.right.label), c.right.detail ? ` · ${c.right.detail}` : "")]
    : [h("span", null, `${words.compareFrom} `, strong(c.left.label), c.left.detail ? ` · ${c.left.detail}` : ""), h("span", null, `${words.compareTo} `, strong(c.right.you ? words.yourEditNow : c.right.label), !c.right.you && c.right.detail ? ` · ${c.right.detail}` : "")];
  // The footer (§1.2, §1.12): one cut, your edit on the right: Restore your edit to the left side…; across cuts, your
  // cut on the right: Fold in changes from the left cut…; between two others: nothing, only Done comparing
  const canRestore = c.right.you && !c.acrossCuts && !!c.left.versionId;
  const canFold = c.acrossCuts && c.right.you && !!c.left.cutId && typeof onFoldIn === "function";
  // the picked row's Then / Now and its one-clip action (Bring back, Take out), as Choose a clip… words them
  const span = (x) => (x ? (x[1] > x[0] ? `${timecode(x[0])}–${timecode(x[1])}` : timecode(x[0])) : "—");
  const rowDetail = (ch) => {
    if (!clips.can || !ch.itemId) return null;
    if (!clips.choices) return h(CompareRowDetail, { then: "…", now: "…" });
    const x = clips.choices.get(ch.itemId), raw = clips.raw?.get(ch.itemId);
    if (!x) return null;
    const then = x.how === "added" ? "—" : x.thenText !== undefined ? `“${x.thenText}”` : span(x.then);
    const now = x.how === "deleted" ? "—" : raw?.now?.text !== undefined && x.thenText !== undefined ? `“${raw.now.text}”` : span(x.now);
    const when = c.left.detail || words.anEarlierVersion;
    const run = () => {
      setAct({ busy: ch.itemId, note: null });
      ui.restoreClip(c.left.ref, x.itemId, { ...(x.how === "added" ? { remove: true } : {}), ...(x.token !== undefined ? { expect: x.token } : {}) }).then(
        () => { setAct({ busy: null, note: null }); clips.reload(); },
        (e) => {
          // changed again since (N0b refuses it, nothing written): its words, and the clip read again
          const changed = e?.code === "CHANGED_SINCE";
          setAct({ busy: null, item: x.itemId, note: changed ? (e?.message || words.clipChangedNothing(x.name)) : words.bringBackFailed });
          clips.reload();
        },
      );
    };
    return h(CompareRowDetail, {
      then, now,
      action: x.how === "added" ? words.takeOutNamed(x.name) : words.bringBackNamed(x.name),
      line: bringBackLine(x, when, words),
      busy: act.busy === x.itemId,
      note: act.busy === null && act.item === x.itemId && act.note ? act.note : null,
      onAction: run,
    });
  };
  const restore = async () => {
    setConfirm({ busy: true, failed: false });
    try {
      await ui.restore(c.left.ref);
      setConfirm(null);
    } catch {
      setConfirm({ busy: false, failed: true });
    }
  };
  const footer = confirm
    ? h("div", { className: "carton-changes-confirm", role: "group", "aria-label": words.restoreQuestion(c.left.label) },
        h("p", { className: "carton-changes-confirm-title" }, words.restoreQuestion(c.left.label)),
        h("p", { className: "carton-changes-confirm-body" }, words.restoreBody(n ?? 0)),
        confirm.failed ? h("p", { className: "carton-error", role: "alert" }, words.restoreFailed) : null,
        h("div", { className: "carton-changes-confirm-acts" },
          h(Button, { variant: "primary", icon: "restore", busy: confirm.busy, onClick: () => void restore() }, words.restore),
          h(Button, { variant: "ghost", onClick: () => setConfirm(null) }, words.cancel)))
    : canRestore
      ? h(Button, { variant: "ghost", icon: "restore", onClick: () => setConfirm({ busy: false, failed: false }) }, words.restoreEditTo(c.left.label))
      : canFold
        ? h(Button, { variant: "ghost", icon: "foldIn", onClick: () => onFoldIn(c.left.cutId, c.right.cutId) }, words.foldInFrom(c.left.label))
        : null;
  return h(CompareList, {
    className: "carton-sidebar-compare",
    range,
    count,
    changes: data?.changes ?? null,
    status: data?.status ?? "loading",
    selected,
    onSelect: (ch) => ui.compareSelect?.(ch),
    onPlay: (ch) => ui.comparePlay?.(ch),
    onBack: () => void ui.closeCompare?.(),
    detail: (ch) => rowDetail(ch),
    footer,
    empty: c.right.you ? words.sameAs(c.left.label) : words.sameVersions,
  });
}

// ---------------------------------------------------------------- the agent's request (§1.13)

const IDLE_KEYS_MS = 2000, WAIT_MS = 8000;
/**
 * `cb compare … --show` (N0's OpenCompare, on the worker's carton:event, topic "compare"): opened at once when the
 * person is idle (no button held, no key in the last 2 s outside the chat box, no dialog or menu open, nothing
 * playing, not viewing or comparing); else it waits up to 8 s for idle, then offers a toast with Open instead. Already
 * viewing or comparing, playing, or Export open: the offer at once. Each request once.
 */
function useCompareAsks({ ui, bridge, projectId, toast, openPanel, panel }) {
  const panelRef = useRef(panel);
  panelRef.current = panel;
  useEffect(() => {
    if (typeof bridge.onEvent !== "function") return undefined;
    const seen = new Set();
    let pressed = 0, lastKey = 0, waiting = null;
    const onDown = () => { pressed++; };
    const onUp = () => { pressed = Math.max(0, pressed - 1); if (!pressed) tryWaiting(); };
    const chat = (el) => !!el?.closest?.('[data-analytics-region="editor-chat"]');
    const onKey = (e) => { if (!chat(e.target)) lastKey = Date.now(); };
    window.addEventListener("pointerdown", onDown, true);
    window.addEventListener("pointerup", onUp, true);
    window.addEventListener("pointercancel", onUp, true);
    window.addEventListener("keydown", onKey, true);
    const modal = () => !!document.querySelector('[role="dialog"][aria-modal="true"], [role="menu"], [data-radix-popper-content-wrapper]');
    const elsewhere = () => !!((typeof ui.viewing === "function" && ui.viewing()) || ui.pendingView?.() || ui.comparing?.());
    // what the page did, told to the worker for cb's line (N0's compareAnswer: within 10 s; DESIGN-V2 §5.3)
    const answer = (ask, status, why) => {
      if (!ask.request) return;
      Promise.resolve(bridge.call?.("compareAnswer", [{ projectId, request: ask.request, status, ...(why ? { why } : {}) }])).catch(() => {});
    };
    const idle = () => !pressed && Date.now() - lastKey >= IDLE_KEYS_MS && !modal() && !bridge.playing && !elsewhere();
    const open = (ask) => {
      const by = ask.byName || ask.by?.name || "An agent";
      const wasClosed = panelRef.current !== "history";
      ui.openCompare?.(ask.from, ask.to, { by, request: ask.request }).then(() => {
        answer(ask, "opened");
        // History opens to the change list if it was closed, and closes again on exit if the agent opened it (§1.13)
        if (wasClosed) {
          openPanel?.("history");
          const mine = ui.comparing?.();
          const off = ui.onCompare?.(() => {
            const now = ui.comparing?.();
            if (now === mine) return;
            off?.();
            if (!now) openPanel?.(null);
          });
        }
        toast?.(`${words.openedComparison(by)} ${words.escToGoBack}.`, null, null, "compare");
      }, () => { answer(ask, "refused", "not-here"); toast?.(words.compareFailed, null, "warning"); });
    };
    const offer = (ask, why) => {
      const by = ask.byName || ask.by?.name || "An agent";
      const sides = sidesOf(ui, ask.from, ask.to);
      if (!sides) return answer(ask, "refused", "not-here");
      answer(ask, "offered", why);
      toast?.(words.comparisonReady(by, sides.left.label, sides.right.label), { label: words.openIt, run: () => open(ask) }, null, "compare", { sticky: true });
    };
    function tryWaiting() {
      if (!waiting || !idle()) return;
      const w = waiting;
      waiting = null;
      clearTimeout(w.timer);
      open(w.ask);
    }
    const off = bridge.onEvent((ev) => {
      if (ev?.id !== projectId || ev.topic !== "compare" || !ev.compare) return;
      const ask = ev.compare;
      const key = ask.request ?? `${ask.from}|${ask.to}|${ask.at}`;
      if (seen.has(key)) return;
      seen.add(key);
      if (waiting) { clearTimeout(waiting.timer); waiting = null; }
      // a side this computer doesn't have (a teammate's version not here yet): cb says so
      if (!sidesOf(ui, ask.from, ask.to)) return answer(ask, "refused", "not-here");
      if (elsewhere()) return offer(ask, "viewing");
      if (bridge.playing) return offer(ask, "playing");
      if (modal()) return offer(ask, "busy");
      if (idle()) return open(ask);
      // mid-edit: wait for idle up to 8 s, then offer
      waiting = { ask, timer: setTimeout(() => { const w = waiting; waiting = null; if (w) offer(w.ask, "busy"); }, WAIT_MS) };
      const poll = setInterval(() => { if (!waiting) clearInterval(poll); else tryWaiting(); }, 250);
    });
    return () => {
      if (typeof off === "function") off();
      if (waiting) clearTimeout(waiting.timer);
      waiting = null;
      window.removeEventListener("pointerdown", onDown, true);
      window.removeEventListener("pointerup", onUp, true);
      window.removeEventListener("pointercancel", onUp, true);
      window.removeEventListener("keydown", onKey, true);
    };
  }, [ui, bridge, projectId, toast, openPanel]);
}
