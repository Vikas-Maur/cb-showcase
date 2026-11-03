// Compare in the editor (Carton UX v2, docs/carton-ux/v2/DESIGN-V2.md §1, N1), from the editor's page: the real
// carton-ui code (scripts/carton/ui.js and compare.js, bundled as scripts/carton/build.js bundles them) on React 19 in
// a DOM (happy-dom), its side panel and stage layer mounted as editor-panel.js mounts them (with a stand-in second
// player and react-dom's portal), over a bridge that serves @carton/react's mock through the real serveUi, and records
// what the editor was told (preview, hold, seek, play). The timeline is a stand-in in Cardboard's structure (the tracks
// surface with its [data-track-id] rows), where Compare's marks go.
//   node --test scripts/carton/test/compare.test.js
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs"), os = require("os"), path = require("path"), { pathToFileURL } = require("url");

const ROOT = path.resolve(__dirname, "../../..");
const CARTON = path.join(ROOT, "carton");
const skip = !fs.existsSync(path.join(CARTON, "node_modules", "esbuild")) && "run `npm ci` in carton/";
const OUT = path.join(process.env.CARTON_TEST_DIR ?? path.join(os.homedir(), "gfv-scratch", "carton", "windows-sync"), "compare");
const opt = { skip, timeout: 60_000 };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let React, client, act, U, win, createMockUi, serveUi, createPortal;
test.before(async () => {
  if (skip) return;
  const esbuild = require(path.join(CARTON, "node_modules", "esbuild"));
  fs.mkdirSync(OUT, { recursive: true });
  await esbuild.build({
    bundle: true, format: "cjs", logLevel: "warning", absWorkingDir: CARTON, nodePaths: [path.join(CARTON, "node_modules")],
    platform: "browser", target: "chrome140", outfile: path.join(OUT, "carton-ui.cjs"),
    stdin: { contents: 'export * from "./ui.js";\nimport "./sync/ui.js";\n', resolveDir: path.join(ROOT, "scripts", "carton"), loader: "js" },
    alias: { react: path.join(ROOT, "scripts", "carton", "react-shim.js") },
  });
  const { Window } = require(path.join(CARTON, "node_modules", "happy-dom"));
  win = new Window({ url: "http://localhost/", width: 1522, height: 810 });
  for (const k of ["window", "document", "navigator", "localStorage", "Node", "Element", "HTMLElement", "HTMLInputElement", "HTMLButtonElement", "HTMLDivElement", "SVGElement", "Text", "Event", "KeyboardEvent", "MouseEvent", "PointerEvent", "FocusEvent", "InputEvent", "CustomEvent", "MutationObserver", "ResizeObserver", "getComputedStyle", "requestAnimationFrame", "cancelAnimationFrame", "DocumentFragment"])
    Object.defineProperty(globalThis, k, { value: win[k], configurable: true, writable: true });
  globalThis.matchMedia = win.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  React = require(path.join(CARTON, "node_modules", "react"));
  client = require(path.join(CARTON, "node_modules", "react-dom", "client"));
  ({ createPortal } = require(path.join(CARTON, "node_modules", "react-dom")));
  act = React.act;
  window.__cartonReact = React;
  U = require(path.join(OUT, "carton-ui.cjs"));
  ({ createMockUi } = await import(pathToFileURL(path.join(CARTON, "packages", "react", "src", "mock.ts")).href));
  ({ serveUi } = await import(pathToFileURL(path.join(CARTON, "packages", "react", "src", "remote.ts")).href));
}, { timeout: 300_000 });
test.after(async () => { await win?.happyDOM.close(); });

const h = (...a) => React.createElement(...a);
let seq = 0;
const item = (id, trackId, startTime, endTime) => ({ id, trackId, type: "video", startTime, endTime, trimStart: 0, trimEnd: 0 });
const TRACKS = [{ id: "v" }, { id: "t" }];
const DOCS = {
  left: { tracks: TRACKS, aspectRatio: "16:9", media: [], timelineItems: [item("intro", "v", 0, 6), item("pier", "v", 6, 9), item("ib", "v", 13, 20)] },
  right: { tracks: TRACKS, aspectRatio: "16:9", media: [], timelineItems: [item("intro", "v", 0, 5), item("drone", "v", 5, 9), item("ib", "v", 9, 16)] },
};
const ROWS = [
  { key: "timelineItems/intro", itemId: "intro", kind: "change", clip: "video", text: "Trimmed “Intro”, now ends at 0:05", at: 0, end: 5 },
  { key: "timelineItems/drone", itemId: "drone", kind: "add", clip: "video", text: "Added “Drone shot”", at: 5, end: 9 },
  { key: "timelineItems/pier", itemId: "pier", kind: "remove", clip: "video", text: "Removed “B-roll pier”", at: 6, end: 9 },
  { key: "timelineItems/ib", itemId: "ib", kind: "change", clip: "video", text: "Moved “Interview B” 4 s earlier", at: 9, end: 16 },
];

/** The stand-in second player: says it's ready, or throws (a failed engine). */
function Player({ onReady }) {
  React.useEffect(() => { onReady?.(true); }, [onReady]);
  return h("canvas", { "data-test-player": "" });
}
function Broken() { throw new Error("no WebGL"); }

/**
 * The editor's page: Carton's side panel and stage layer over a bridge that serves `ui` as the worker does, with
 * Compare's half of the renderer bridge (hold, compareDoc, play, the playhead, the timeline's scale), and a stand-in
 * timeline. `player`: the second player (null: none in this bundle).
 */
async function mount(o = {}) {
  const ui = o.ui ?? createMockUi({ versions: 8 });
  if (o.rows !== false) { ui.changes = async () => ROWS; ui.shotDiff = async () => ({ a: [{ start: 0, end: 6, sig: 1 }, { start: 6, end: 9, sig: 2 }, { start: 9, end: 13, sig: 9 }, { start: 13, end: 20, sig: 3 }], b: [{ start: 0, end: 5, sig: 7 }, { start: 5, end: 9, sig: 8 }, { start: 9, end: 16, sig: 3 }], matches: [[3, 2]], aLabel: "a", bLabel: "b" }); }
  const PROJECT = "p-cmp-" + ++seq;
  const cmds = new Set(), evs = new Set(), servers = new Map(), blocked = new Set(), backs = new Set(), notices = new Set(), timeline = new Set();
  const did = { previews: [], holds: 0, seeks: [], plays: 0, reports: [], aside: [], docs: [], answers: [] };
  window.__cartonTimelineMark = () => {};
  window.__cartonStageMode = (v) => { did.stage = v; };
  let playing = false, t = 2;
  const bridge = {
    projectId: PROJECT,
    projectName: "Weekend reel",
    call: async (method, [arg] = []) => {
      if (method === "ui") {
        let s = servers.get(arg.client);
        if (!s) servers.set(arg.client, (s = serveUi(ui, (message) => queueMicrotask(() => { for (const f of [...evs]) f({ client: arg.client, message }); }))));
        s.receive(arg.message);
        return null;
      }
      if (method === "liveStatus") return { shared: false };
      if (method === "compareAnswer") { did.answers.push(arg); return null; }
      return undefined;
    },
    onEvent: (f) => (evs.add(f), () => evs.delete(f)),
    fire: (ev) => { for (const f of [...evs]) f(ev); },
    onCommand: (f) => (cmds.add(f), () => cmds.delete(f)),
    onNotice: (f) => (notices.add(f), () => notices.delete(f)),
    command: (action) => { for (const f of [...cmds]) f({ action }); },
    reportPanel: (panel, live, chip) => did.reports.push({ panel, ...chip }),
    preview: async (_p, ref) => { did.previews.push(ref); },
    hold: async () => { did.holds++; },
    compareDoc: async (_p, ref) => { did.docs.push(ref); return ref == null || ref === ui.cuts().find((c) => c.current)?.head ? DOCS.right : DOCS.left; },
    prefetch: () => {},
    libraryAside: (on) => did.aside.push(on),
    togglePlay: () => { playing = !playing; did.plays++; for (const f of [...timeline]) f(); },
    pause: () => { playing = false; },
    get playing() { return playing; },
    clock: () => t,
    seek: (x) => { did.seeks.push(x); t = x; for (const f of [...timeline]) f(); },
    timelineScale: () => ({ pps: 10, tracks: TRACKS }),
    onTimeline: (f) => (timeline.add(f), () => timeline.delete(f)),
    editLength: () => 16,
    selection: () => null,
    selectedClip: () => null,
    onBlocked: (f) => (blocked.add(f), () => blocked.delete(f)),
    blocked: () => { for (const f of [...blocked].reverse()) if (f() === true) return true; return false; },
    onBack: (f) => (backs.add(f), () => backs.delete(f)),
    beforeExport: () => { for (const f of [...backs].reverse()) { const r = f("export"); if (r) return Promise.resolve(r); } return null; },
  };
  // Cardboard's timeline, in the structure Compare reads: the tracks surface and its rows, the tracks' scroll area
  const tl = document.createElement("div");
  tl.setAttribute("data-analytics-region", "editor-timeline");
  tl.innerHTML = '<div><div class="justify-between"><div class="flex-1 justify-end"></div></div><div data-tracks-content><div data-timeline-canvas-surface><div data-track-id="v"></div><div data-track-id="t"></div></div></div></div>';
  const side = document.createElement("div"), stage = document.createElement("div");
  stage.setAttribute("data-carton-stage-host", "");
  stage.appendChild(document.createElement("div"));
  document.body.append(stage, tl, side);
  const roots = [client.createRoot(stage.firstChild), client.createRoot(side)];
  const player = o.player === undefined ? Player : o.player;
  await act(async () => {
    roots[0].render(h(U.CartonStage, { projectId: PROJECT, bridge, player, portal: createPortal }));
    roots[1].render(h(U.CartonSide, { projectId: PROJECT, bridge }));
    await sleep(30);
  });
  await act(async () => { await sleep(20); });
  const settle = async (ms = 30) => { await act(async () => { await sleep(ms); }); await act(async () => { await sleep(5); }); };
  const cmd = async (action) => { await act(async () => { bridge.command(action); await sleep(30); }); await settle(); };
  const click = async (el, init = {}) => { await act(async () => { el.dispatchEvent(new window.MouseEvent("click", { bubbles: true, cancelable: true, ...init })); await sleep(30); }); await settle(); };
  const key = async (k, type = "keydown", target = document.body) => { await act(async () => { target.dispatchEvent(new window.KeyboardEvent(type, { key: k, bubbles: true, cancelable: true })); await sleep(20); }); await settle(); };
  const page = () => U.__forTests.conns.get(PROJECT).conn.ui;
  const open = async (from, to = null, opts) => { await act(async () => { await page().openCompare(from, to, opts); await sleep(20); }); await settle(60); };
  return {
    ui, bridge, did, stage, side, tl, cmd, click, key, settle, page, open,
    compare: () => stage.querySelector(".carton-compare"),
    list: () => side.querySelector(".carton-compare-list"),
    toast: () => stage.querySelector(".carton-toast"),
    chip: () => did.reports.at(-1),
    older: () => ui.history().all().filter((v) => !v.provisional).at(-4),
    done: async () => { await act(async () => { for (const r of roots) r.unmount(); }); stage.remove(); side.remove(); tl.remove(); },
  };
}

test("N1 §1.2: History's Shift+click opens Compare: the stage, the chip, the change list; your edit held on the right", opt, async () => {
  const m = await mount();
  try {
    await m.cmd("carton-history");
    const rows = [...m.side.querySelectorAll(".carton-version")];
    assert.ok(rows.length > 3, "History's list");
    await m.click(rows[3]);
    await m.click(rows[0], { shiftKey: true });
    await m.settle(80);
    const c = m.page().comparing();
    assert.ok(c, "comparing");
    assert.ok(m.compare(), "the stage view");
    assert.ok(m.list(), "History is its change list");
    assert.equal(m.list().querySelectorAll(".carton-change").length, ROWS.length);
    assert.match(m.chip().comparing?.label ?? "", /^Comparing .+ with .+$/, "the chip's second part");
    assert.equal(m.chip().viewing, null, "never viewing and comparing at once");
    assert.ok(m.did.aside.includes(true), "the Library steps aside");
  } finally { await m.done(); }
});

test("N1 §1.1: openCompare puts the sides the right way round and names them once; across cuts by cut, in differences", opt, async () => {
  const m = await mount();
  try {
    const v = m.older();
    // your edit given first: it still goes right
    await m.open(null, v.ref);
    let c = m.page().comparing();
    assert.equal(c.left.ref, v.ref);
    assert.equal(c.right.you, true);
    assert.equal(c.right.label, "your edit");
    assert.equal(m.did.holds, 1, "your edit held read-only, no checkout");
    assert.equal(m.compare().getAttribute("aria-label"), `Comparing ${c.left.label} with your edit`);
    // the cuts menu's Compare: that cut now with the cut you're on now
    await m.open("cut-ig");
    c = m.page().comparing();
    assert.equal(m.chip().comparing.label, "Comparing “30s Instagram cut” with Main cut");
    assert.equal(c.acrossCuts, true);
    assert.equal(c.right.title, "Main cut");
    assert.equal(m.compare().querySelector(".carton-compare-count").textContent, `${ROWS.length} differences`);
    // the panel's count gives each cut's length, left first (§1.12; design QA v2 G14)
    await m.cmd("carton-history");
    await m.settle(60);
    assert.equal(m.list().querySelector(".carton-compare-n")?.textContent, `${ROWS.length} differences · 0:20 and 0:16`);
  } finally { await m.done(); }
});

test("N1 §1.3: the modes: Side by side (the hole for the editor's picture, the second player), Wipe (a slider), Flip (B swaps the editor and back)", opt, async () => {
  const m = await mount();
  try {
    const v = m.older();
    await m.open(v.ref);
    assert.equal(m.compare().getAttribute("data-mode"), "side");
    assert.ok(m.stage.querySelector("[data-test-player]"), "the second player, with the left side's timeline");
    assert.ok(m.did.docs.includes(v.ref));
    assert.equal(m.did.stage?.mode, "side", "the stage host told the mode (and the hole)");
    const radios = [...m.compare().querySelectorAll("[role=radio]")];
    assert.deepEqual(radios.map((r) => r.textContent), ["Side by side", "Wipe", "Flip"]);
    await m.click(radios[1]);
    assert.equal(m.compare().getAttribute("data-mode"), "wipe");
    assert.ok(m.compare().querySelector("[role=slider]"), "the wipe line");
    assert.ok(m.stage.querySelector("[data-test-player]"));
    await m.click(m.compare().querySelector('[role=radio][data-mode="flip"]'));
    assert.equal(m.compare().getAttribute("data-mode"), "flip");
    assert.ok(!m.stage.querySelector("[data-test-player]"), "Flip: no second player (its engine is gone)");
    const before = m.did.previews.length, holds = m.did.holds;
    await act(async () => { m.bridge.seek(10); await sleep(10); });
    await m.key("b");
    assert.equal(m.did.previews.at(-1), v.ref, "B held: the editor shows the left side");
    assert.equal(m.did.seeks.at(-1), 14, "at the same moment, in step by shot (right 0:10 is left 0:14)");
    assert.equal(m.did.previews.length, before + 1);
    assert.match(m.compare().querySelector(".carton-compare-tag").textContent, /Showing/);
    assert.ok(m.compare().querySelector(".carton-compare-tag[data-left]"), "the tag turns blue on the left side");
    await m.key("b", "keyup");
    assert.equal(m.did.holds, holds + 1, "released: your edit again");
    assert.equal(m.did.seeks.at(-1), 10, "at its own moment");
    assert.equal(localStorage.getItem("carton.compareMode"), "flip", "the mode picked is kept for next time");
  } finally { localStorage.removeItem("carton.compareMode"); await m.done(); }
});

test("N1 §1.10: no second player: Flip only; one that fails: Flip, and one toast", opt, async () => {
  let m = await mount({ player: null });
  try {
    await m.cmd("carton-history");
    await m.open(m.older().ref);
    assert.equal(m.compare().getAttribute("data-mode"), "flip");
    assert.deepEqual([...m.compare().querySelectorAll("[role=radio]")].map((r) => r.textContent), ["Flip"]);
    assert.ok(m.list(), "everything else as usual");
  } finally { await m.done(); }
  m = await mount({ player: Broken });
  try {
    const err = console.error;
    console.error = () => {};
    try { await m.open(m.older().ref); await m.settle(60); } finally { console.error = err; }
    assert.equal(m.compare().getAttribute("data-mode"), "flip");
    assert.match(m.toast()?.textContent ?? "", /side by side here\. Showing it as a flip\./);
  } finally { await m.done(); }
});

test("N1 §1.7: the ways out, each to your edit: Esc, the chip's ✕, Done comparing, ← History, closing History", opt, async () => {
  const m = await mount();
  try {
    const ref = m.older().ref;
    const back = async (how) => {
      await m.open(ref);
      assert.ok(m.page().comparing(), how);
      const n = m.did.previews.length;
      if (how === "esc") await m.key("Escape");
      else if (how === "chip") await m.cmd("carton-back");
      else if (how === "done") await m.click(m.compare().querySelector(".carton-compare-done"));
      else if (how === "history") await m.click(m.list().querySelector(".carton-changes-nav button"));
      else if (how === "close") await m.cmd("carton-history");
      await m.settle(40);
      assert.equal(m.page().comparing(), null, how);
      assert.equal(m.did.previews.at(-1), null, `${how}: the editor back to your edit`);
      assert.ok(m.did.previews.length > n, how);
      assert.ok(!m.compare(), how);
      assert.equal(m.chip().comparing ?? null, null, how);
      assert.equal(m.did.aside.at(-1), false, `${how}: the Library comes back`);
      assert.equal(m.did.stage, null, `${how}: the stage is Cardboard's again`);
    };
    await m.cmd("carton-history");
    for (const how of ["esc", "chip", "done", "history"]) await back(how);
    await back("close");
  } finally { await m.done(); }
});

test("N1 §1.8: an edit tried while comparing: one line in Compare's words, Done comparing, and the stage pulses", opt, async () => {
  const m = await mount();
  try {
    assert.equal(m.bridge.blocked(), false, "not comparing: Cardboard's own refusal");
    await m.open(m.older().ref);
    let told;
    await act(async () => { told = m.bridge.blocked(); await sleep(10); });
    await m.settle();
    assert.equal(told, true);
    const t = m.toast();
    const c = m.page().comparing();
    assert.equal(t.querySelector(".carton-toast-text").textContent, `You're comparing ${c.left.label} with your edit.`);
    assert.deepEqual([...t.querySelectorAll("button")].map((b) => b.textContent), ["Done comparing"]);
    assert.equal(m.compare().getAttribute("data-pulse"), "a");
    await m.click(t.querySelector("button"));
    assert.equal(m.page().comparing(), null);
    // Export while comparing: back to your edit first
    await m.open(m.older().ref);
    let p;
    await act(async () => { p = m.bridge.beforeExport(); await p; await sleep(20); });
    assert.ok(p);
    assert.equal(m.page().comparing(), null);
  } finally { await m.done(); }
});

test("N1 §1.6: marks from the diff on the timeline's own rows, the strip and the legend; a picked change moves both players there", opt, async () => {
  const m = await mount();
  try {
    await m.cmd("carton-history");
    await m.open(m.older().ref);
    await m.settle(60);
    const marks = [...m.tl.querySelectorAll("[data-timeline-canvas-surface] .carton-tl-mark, [data-timeline-canvas-surface] .carton-tl-seam")];
    const kind = (el) => el.getAttribute("data-kind") ?? (el.classList.contains("carton-tl-seam") ? "seam" : null);
    assert.deepEqual(marks.map(kind).sort(), ["added", "moved", "seam", "trimmed"].sort());
    const drone = marks.find((e) => e.getAttribute("data-kind") === "added");
    assert.equal(drone.style.left, "50px", "5 s × 10 px/s");
    assert.equal(drone.style.width, "40px");
    assert.ok(m.tl.querySelector("[data-tracks-content] .carton-tl-strip"), "the left side's strip");
    assert.ok(m.tl.querySelector(".carton-tl-legend"), "the legend in the toolbar");
    assert.equal(m.tl.querySelector(".carton-tl-marks").getAttribute("aria-hidden"), "true");
    // a timeline under 900 px (a 1100 px window with History and the chat): no legend, the marks stay (design QA v2)
    const bar = m.tl.querySelector(".justify-between"), rect = bar.getBoundingClientRect.bind(bar);
    bar.getBoundingClientRect = () => ({ ...rect(), width: 430 });
    await act(async () => { m.bridge.seek(0); await sleep(40); });
    await m.settle(40);
    assert.equal(m.tl.querySelector(".carton-tl-legend"), null, "no legend in a 430 px timeline");
    assert.ok(m.tl.querySelector(".carton-tl-mark"), "the marks still drawn");
    bar.getBoundingClientRect = () => ({ ...rect(), width: 1000 });
    await act(async () => { m.bridge.seek(0); await sleep(40); });
    await m.settle(40);
    assert.ok(m.tl.querySelector(".carton-tl-legend"), "back once it's wide");
    // a click on a mark picks its row; a row picks the spot (a removal: the right side's moment in step with where it was)
    await m.click(marks.find((e) => e.getAttribute("data-kind") === "moved"));
    assert.equal(m.list().querySelector(".carton-change-selected")?.getAttribute("data-change-key"), "timelineItems/ib");
    assert.equal(m.did.seeks.at(-1), 9);
    await m.click([...m.list().querySelectorAll(".carton-change")].find((r) => /B-roll pier/.test(r.textContent)));
    assert.equal(m.did.seeks.at(-1), 6, "a removal: the right side's time whose left time (in step) is where it was, so the left player shows it");
    // closed: nothing of Compare's left in Cardboard's timeline
    await m.key("Escape");
    assert.ok(!m.tl.querySelector(".carton-tl-marks, .carton-tl-strip, .carton-tl-legend"));
  } finally { await m.done(); }
});

test("N1 §1.13: the agent's request opens Compare when the person is idle, with a toast naming who; busy, it offers Open", opt, async () => {
  const m = await mount();
  try {
    const ask = (request, from) => ({ id: m.bridge.projectId, topic: "compare", compare: { from, to: "cut-main", by: { kind: "agent", id: "director" }, byName: "Director", at: Date.now(), request } });
    const ref = m.older().ref;
    await act(async () => { m.bridge.fire(ask("r1", ref)); await sleep(40); });
    await m.settle(60);
    assert.ok(m.page().comparing(), "opened");
    assert.equal(m.page().comparing().by, "Director");
    assert.equal(m.toast()?.querySelector(".carton-toast-text")?.textContent, "Director opened a comparison. Esc to go back.");
    assert.ok(m.list(), "History opened to its list");
    assert.deepEqual(m.did.answers.at(-1), { projectId: m.bridge.projectId, request: "r1", status: "opened" }, "the worker told (cb's line)");
    // the same request again: shown once
    await m.key("Escape");
    await act(async () => { m.bridge.fire(ask("r1", ref)); await sleep(40); });
    await m.settle();
    assert.equal(m.page().comparing(), null, "each request once");
    // already viewing: never replaced; a toast with Open
    await act(async () => { await m.page().view({ kind: "version", versionId: m.older().id }); });
    await m.settle();
    await act(async () => { m.bridge.fire(ask("r2", ref)); await sleep(40); });
    await m.settle();
    assert.equal(m.page().comparing(), null, "what the person looks at stays");
    const t = m.toast();
    assert.match(t.querySelector(".carton-toast-text").textContent, /^Director has a comparison ready: .+ with your edit\.$/);
    assert.deepEqual(m.did.answers.at(-1), { projectId: m.bridge.projectId, request: "r2", status: "offered", why: "viewing" });
    await m.click([...t.querySelectorAll("button")].find((b) => b.textContent === "Open"));
    await m.settle(60);
    assert.ok(m.page().comparing(), "Open opens it");
    assert.equal(m.ui.viewing(), null, "viewing ended first");
    await m.key("Escape");
    assert.equal(m.page().comparing(), null);
    assert.equal(m.did.previews.at(-1), null, "Esc: back to your edit, not to the earlier view");
  } finally { await m.done(); }
});

test("N1 review: Restore asks first and Compare stays open; across cuts the footer is Fold in; a row's ▶ plays its spot on both sides", opt, async () => {
  const m = await mount();
  try {
    await m.cmd("carton-history");
    const v = m.older();
    await m.open(v.ref);
    const foot = () => m.list().querySelector(".carton-compare-foot");
    const restoreBtn = [...foot().querySelectorAll("button")].find((b) => /^Restore your edit to /.test(b.textContent));
    assert.ok(restoreBtn);
    const restored = [];
    const restore = m.ui.restore.bind(m.ui);
    m.ui.restore = async (ref) => { restored.push(ref); return restore(ref); };
    await m.click(restoreBtn);
    assert.deepEqual(restored, [], "asked first");
    assert.ok(foot().querySelector(".carton-changes-confirm"), "its consequence said");
    await m.click([...foot().querySelectorAll("button")].find((b) => b.textContent === "Restore"));
    await m.settle(80);
    assert.deepEqual(restored, [v.ref]);
    assert.ok(m.page().comparing(), "Compare stays open, your edit updated");
    // a row's ▶: its spot (a second before), both sides playing
    const plays = m.did.plays;
    await m.click([...m.list().querySelectorAll(".carton-change")].find((r) => /Interview B/.test(r.textContent)).querySelector(".carton-change-play, button"));
    assert.equal(m.did.seeks.at(-1), 8, "a second before 0:09");
    assert.equal(m.did.plays, plays + 1, "playing");
    // across cuts with your cut on the right: Fold in changes from the other cut…
    await m.open("cut-ig");
    const fold = [...foot().querySelectorAll("button")].find((b) => /^Fold in changes from /.test(b.textContent));
    assert.equal(fold?.textContent, "Fold in changes from “30s Instagram cut”…");
  } finally { await m.done(); }
});

test("N1 review: a newer comparison isn't moved by an older one's close; an agent's Compare from Comments stays; its offer stays", opt, async () => {
  const m = await mount();
  try {
    await m.cmd("carton-history");
    const older = m.ui.history().all().filter((v) => !v.provisional);
    // two older versions (the right side isn't your edit): close puts the playhead back where it was, unless a new
    // comparison opened meanwhile
    await act(async () => { m.bridge.seek(3); await sleep(5); });
    await m.open(older.at(-5).ref, older.at(-3).ref);
    await act(async () => { m.bridge.seek(7); await sleep(5); });
    const seeks = m.did.seeks.length;
    await act(async () => { const p = m.page().closeCompare(); await m.page().openCompare(older.at(-4).ref); await p; await sleep(30); });
    await m.settle();
    assert.ok(m.page().comparing(), "the newer comparison is on");
    assert.equal(m.did.seeks.slice(seeks).includes(3), false, "the older close didn't move the newer one's playhead");
    await m.key("Escape");
    // Comments open; an idle agent's request (no key for 2 s): History opens to the list, and Compare stays
    await m.click([...m.side.querySelectorAll("[role=tab]")].find((t) => t.getAttribute("aria-label") === "Comments"));
    await act(async () => { await sleep(2100); });
    await act(async () => { m.bridge.fire({ id: m.bridge.projectId, topic: "compare", compare: { from: older.at(-4).ref, to: "cut-main", by: { kind: "agent", id: "claude" }, byName: "Claude Code", at: Date.now(), request: "x1" } }); await sleep(40); });
    await m.settle(80);
    assert.ok(m.page().comparing(), "opened, and not closed by the panel's switch to History");
    assert.ok(m.list());
    await m.key("Escape");
    // viewing: the offer stays (no 6 s timeout) until Open or ✕
    await act(async () => { await m.page().view({ kind: "version", versionId: m.older().id }); });
    await act(async () => { m.bridge.fire({ id: m.bridge.projectId, topic: "compare", compare: { from: older.at(-4).ref, to: "cut-main", by: { kind: "agent", id: "claude" }, byName: "Claude Code", at: Date.now(), request: "x2" } }); await sleep(40); });
    await m.settle();
    assert.ok(m.toast()?.textContent.includes("Claude Code has a comparison ready"));
    await act(async () => { await sleep(6500); });
    assert.ok(m.toast()?.textContent.includes("Claude Code has a comparison ready"), "still there after 6 s");
  } finally { await m.done(); }
});

test("N1 with N2: History's ⇆ Compare menu (another cut), pick mode (Compare with…) and the cuts menu all open Compare in the editor", opt, async () => {
  const m = await mount();
  try {
    await m.cmd("carton-history");
    const menuItems = () => [...document.querySelectorAll(".carton-menu-item")];
    // ⇆ Compare → Another cut › → A version on “30s Instagram cut”… (N2c: that cut's History to pick from) → its first
    // row, that cut as it is now: that cut now with the cut you're on now
    const btn = m.side.querySelector(".carton-compare-btn");
    assert.ok(btn, "History's ⇆ Compare button");
    await m.click(btn);
    await m.click(menuItems().find((b) => /Another cut/.test(b.textContent)));
    await m.click(menuItems().find((b) => /A version on 30s Instagram cut/.test(b.textContent)));
    await m.settle(120);
    const now = m.side.querySelector(".carton-cut-pick-row[data-now]");
    assert.ok(now, "that cut's History, “as it is now” first");
    await m.click(now);
    await m.settle(80);
    assert.equal(m.page().comparing()?.left.cutId, "cut-ig", "Compare opened, across cuts");
    assert.ok(m.compare() && m.list(), "on the stage, and the list in the panel");
    assert.ok(!m.side.querySelector(".carton-changes-view"), "never the panel's own Changes view");
    await m.key("Escape");
    assert.equal(m.page().comparing(), null);
    // an older version of that cut (one this cut's History doesn't list): named by its time everywhere, and Fold in
    // names the cut, which it folds as it is now (design QA v2: "(an earlier version)" three times, and in Fold in)
    await m.click(btn);
    await m.click(menuItems().find((b) => /Another cut/.test(b.textContent)));
    await m.click(menuItems().find((b) => /A version on 30s Instagram cut/.test(b.textContent)));
    await m.settle(120);
    const older = m.side.querySelectorAll(".carton-cut-pick-row:not([data-now])")[1];
    assert.ok(older, "an older version of that cut");
    await m.click(older);
    await m.settle(120);
    const c = m.page().comparing();
    assert.equal(c?.left.cutId, "cut-ig");
    assert.match(c.left.label, /^“30s Instagram cut” (at \d{1,2}:\d{2} [ap]m|yesterday at .+)$/, "the cut at its moment");
    assert.equal(c.right.label, "Main cut now");
    assert.match(m.chip().comparing?.label ?? "", /^Comparing “30s Instagram cut” (at |yesterday ).+ with Main cut now$/);
    assert.doesNotMatch(m.list().textContent, /an earlier version/);
    assert.match(m.list().querySelector(".carton-compare-foot")?.textContent ?? "", /^Fold in changes from “30s Instagram cut”…$/);
    await m.key("Escape");
    assert.equal(m.page().comparing(), null);
    // a row's ⋯ → Compare with… → a click on another row (pick mode)
    const rows = () => [...m.side.querySelectorAll(".carton-version")];
    const target = rows()[3];
    target.dispatchEvent(new window.MouseEvent("mouseover", { bubbles: true }));
    await m.click(target.querySelector(".carton-version-more"));
    await m.click(menuItems().find((b) => b.textContent.trim() === "Compare with…"));
    assert.ok(m.side.querySelector(".carton-pick-line"), "pick mode");
    await m.click(rows()[1]);
    await m.settle(80);
    assert.ok(m.page().comparing(), "Compare opened from pick mode");
    assert.ok(!m.side.querySelector(".carton-changes-view"));
    await m.key("Escape");
    // the cuts menu: another cut's ⇆ Compare
    await m.click(m.side.querySelector(".carton-cuts-trigger"));
    const cmp = [...document.querySelectorAll(".carton-cut-compare")];
    assert.ok(cmp.length >= 1, "other cuts' rows offer Compare");
    await m.click(cmp[0]);
    await m.settle(80);
    assert.ok(m.page().comparing()?.acrossCuts, "Compare opened from the cuts menu");
    // N2's landmark pictures never come from a comparing stage
    assert.equal(await U.__forTests.stagePicture(), null);
  } finally { await m.done(); }
});
