// The title bar's cut chip and the Share dialog, from the editor's page (Carton UX redesign PLAN 2.1, 2.2, 2.3, 8.1):
// the real carton-ui code (scripts/carton/ui.js with sync/ui.js, bundled as scripts/carton/build.js bundles it) on
// React 19's client renderer in a DOM (happy-dom). Its view model is @carton/react's mock served by the real serveUi
// over the bridge's wire (carton:call "ui" out, carton:event back), as the library worker serves the page; the bridge
// records what the page reports to the title bar (bridge.reportPanel, which main hands to the strip).
//   node --test scripts/carton/test/cut-chip.test.js
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs"), os = require("os"), path = require("path"), { pathToFileURL } = require("url");

const ROOT = path.resolve(__dirname, "../../..");
const CARTON = path.join(ROOT, "carton");
// React, react-dom and happy-dom are @carton/react's (its devDependencies), so they resolve from that package.
const fromReact = require("module").createRequire(path.join(CARTON, "packages", "react", "package.json"));
const skip = !fs.existsSync(path.join(CARTON, "node_modules", "esbuild")) && "run `pnpm install` in carton/";
// Never /tmp (a small shared tmpfs on the build box).
const OUT = path.join(process.env.CARTON_TEST_DIR ?? path.join(os.homedir(), "gfv-scratch", "carton", "windows-sync"), "cut-chip");
const opt = { skip, timeout: 60_000 };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let React, client, act, CartonSide, win, createMockUi, serveUi, narrow = false;
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
  const { Window } = fromReact("happy-dom");
  win = new Window({ url: "http://localhost/", width: 1280, height: 800 });
  for (const k of ["window", "document", "navigator", "localStorage", "Node", "Element", "HTMLElement", "HTMLInputElement", "HTMLButtonElement", "HTMLDivElement", "SVGElement", "Text", "Event", "KeyboardEvent", "MouseEvent", "PointerEvent", "FocusEvent", "InputEvent", "CustomEvent", "MutationObserver", "ResizeObserver", "getComputedStyle", "requestAnimationFrame", "cancelAnimationFrame", "DocumentFragment"])
    Object.defineProperty(globalThis, k, { value: win[k], configurable: true, writable: true });
  // the window's width, as the page asks it (below 1180 px: a narrow window, PLAN 2.3)
  globalThis.matchMedia = win.matchMedia = () => ({ matches: narrow, addEventListener() {}, removeEventListener() {} });
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  React = fromReact("react");
  client = fromReact("react-dom/client");
  act = React.act;
  window.__cartonReact = React;
  ({ CartonSide } = require(path.join(OUT, "carton-ui.cjs")));
  ({ createMockUi } = await import(pathToFileURL(path.join(CARTON, "packages", "react", "src", "mock.ts")).href));
  ({ serveUi } = await import(pathToFileURL(path.join(CARTON, "packages", "react", "src", "remote.ts")).href));
}, { timeout: 300_000 });
test.after(async () => { await win?.happyDOM.close(); });

const h = (...a) => React.createElement(...a);
const PROJECT = "p-chip";

/** The editor's page with Carton's side part mounted, over a bridge that serves `ui` as the worker serves it. */
async function mount(ui = createMockUi({ versions: 6 }), { live = { shared: false } } = {}) {
  const cmds = new Set(), evs = new Set(), servers = new Map(), reports = [], previews = [];
  const bridge = {
    projectId: PROJECT,
    projectName: "Weekend reel",
    reports,
    previews,
    call: async (method, [arg] = []) => {
      if (method === "ui") {
        let s = servers.get(arg.client);
        // the worker's events reach the page in the order they are sent (carton:event), never inside the call itself
        if (!s) servers.set(arg.client, (s = serveUi(ui, (message) => queueMicrotask(() => { for (const f of [...evs]) f({ client: arg.client, message }); }))));
        s.receive(arg.message);
        return null;
      }
      if (method === "liveStatus") return structuredClone(live);
      if (method === "liveHostInfo") return { openCreate: true };
      return undefined;
    },
    onEvent: (f) => (evs.add(f), () => evs.delete(f)),
    onCommand: (f) => (cmds.add(f), () => cmds.delete(f)),
    // (the action's name, or the whole command as main passes it on: the chip's carries its box)
    command: (c) => { const ev = typeof c === "string" ? { action: c } : c; for (const f of [...cmds]) f(ev); },
    reportPanel: (panel, l, chip) => reports.push({ panel, live: l ?? null, ...chip }),
    preview: async (_p, ref) => { previews.push(ref); },
  };
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = client.createRoot(container);
  await act(async () => { root.render(h(CartonSide, { projectId: PROJECT, bridge })); await sleep(20); });
  await act(async () => { await sleep(20); });
  const cmd = async (action, ms = 40) => { await act(async () => { bridge.command(action); await sleep(ms); }); await act(async () => { await sleep(10); }); };
  return { ui, bridge, container, reports, cmd, done: async () => { await act(() => root.unmount()); container.remove(); } };
}
const last = (m) => m.reports.at(-1);

test("PLAN 2.1: the page reports the cut it is on, with nothing open: the chip shows on every project tab", opt, async () => {
  const m = await mount();
  try {
    assert.deepEqual(last(m), { panel: null, live: null, share: false, cut: { name: "Main cut", dot: null }, viewing: null });
    assert.equal(m.container.querySelector(".carton-sidebar"), null, "no panel opened for it");
  } finally { await m.done(); }
});

// "It updates within a frame of a switch, cb cut switch included": a switch made anywhere reaches the page as the
// worker's `cuts` topic (sync/cuts-menu.test.js #4: cb cut switch, in the real worker). From that message to the
// report the page sends the title bar there are only microtasks: no render, no timer, no frame.
test("PLAN 2.1: a cut switch reaches the title bar from the cuts message itself, without waiting for a render or a frame", opt, async () => {
  const m = await mount();
  try {
    const n = m.reports.length;
    // no timer may run before the report: any that did would mean waiting for one
    const timers = [];
    const keep = { setTimeout: globalThis.setTimeout, raf: globalThis.requestAnimationFrame };
    globalThis.setTimeout = (...a) => (timers.push("setTimeout"), keep.setTimeout(...a));
    globalThis.requestAnimationFrame = (...a) => (timers.push("rAF"), keep.raf(...a));
    try {
      void m.ui.switchCut("cut-ig");
      for (let i = 0; i < 12 && m.reports.length === n; i++) await null;
    } finally { Object.assign(globalThis, { setTimeout: keep.setTimeout, requestAnimationFrame: keep.raf }); }
    assert.equal(m.reports.length, n + 1, "one report, in the same task as the switch");
    assert.equal(last(m).cut.name, "30s Instagram cut");
    assert.match(last(m).cut.dot, /^#[0-9a-f]{6}$/, "a colour dot for a cut that isn't Main");
    assert.deepEqual(timers, []);
    // a new version moves the cut's head (the cuts topic again): the chip shows the same, so nothing is sent
    await act(async () => { m.ui.addVersion({ summary: "Trimmed 'Intro'" }); await sleep(20); });
    assert.equal(m.reports.length, n + 1, "a head move sends nothing to the title bar");
    // a rename does
    await act(async () => { await m.ui.renameCut("cut-ig", "30s cut"); await sleep(20); });
    assert.equal(last(m).cut.name, "30s cut");
  } finally { await m.done(); }
});

// Review of feat/ux-2-8 #1: the real view model (from-carton.ts over real Carton on store-memory) has viewing() but
// keeps a version opened through openPreview() in preview() only: the chip still shows it, and its ✕ closes it.
test("PLAN 2.1, real view model: a version opened read-only shows in the chip, and its ✕ brings your edit back", opt, async () => {
  const src = (...p) => pathToFileURL(path.join(CARTON, "packages", ...p)).href;
  const { Carton, POS, defineSchema, timeAlgebra } = await import(src("core", "src", "index.ts"));
  const { createMemoryStore } = await import(src("store-memory", "src", "index.ts"));
  const { fromCarton } = await import(src("react", "src", "from-carton.ts"));
  const T = require(path.join(OUT, "carton-ui.cjs")).__forTests;
  const TL = { collection: "items", lanes: "tracks", lane: "trackId", start: "startTime", end: "endTime", source: "trimStart", sourceEnd: "trimEnd", speed: "playbackSpeed" };
  const schema = defineSchema({ collections: { tracks: { seq: true }, items: { parent: { field: "trackId", collection: "tracks" }, groups: [{ name: "time", fields: ["startTime", "endTime", "trimStart", "trimEnd", "playbackSpeed"], algebra: timeAlgebra(TL) }] } }, timeline: TL, label: (c, r) => String(r?.name ?? r?.id ?? c) });
  const adapter = { name: "test", schema, schemaVersion: 1, fromHost: (x) => x, toHost: (x) => x };
  const me = { kind: "human", id: "alice", name: "Alice" };
  const carton = await Carton.open({ adapter, store: createMemoryStore(), init: { doc: { name: "Film", tracks: [{ id: "t1", [POS]: "V" }], items: [{ id: "a", trackId: "t1", startTime: 0, endTime: 5, trimStart: 0, trimEnd: 5, name: "A" }] }, cutName: "Main cut" }, actor: me });
  const h = fromCarton(carton, { me });
  try {
    await h.ready;
    await carton.commit({ ops: [{ op: "set", path: ["items", "a", "name"], value: "Intro" }] });
    await h.settled();
    const ui = h.ui ?? h;
    assert.deepEqual(T.chipOf(ui), { cut: { name: "Main cut", dot: null }, viewing: null });
    const ref = ui.history().all().at(0).ref;
    ui.openPreview(ref, "the version from 12:41 pm");
    assert.equal(typeof ui.viewing, "function", "the real model has viewing()");
    assert.deepEqual(T.chipOf(ui).viewing, { label: "The version from 12:41 pm" }, "the chip says what is shown");
    await T.backToEdit(ui);
    assert.equal(ui.preview(), null, "the ✕ closed it");
    assert.equal(T.chipOf(ui).viewing, null);
  } finally { h.dispose(); await carton.close?.(); }
});

test("PLAN 2.1: while a version is viewed the chip has its label, and its ✕ (carton-back) brings your edit back", opt, async () => {
  const m = await mount();
  try {
    // opened on the view model alone, the editor never told: the stage shows your edit, so the chip doesn't claim it
    // (design QA G1); opened through the page's own connection (History, Comments), the editor swaps, and the chip says so
    await act(async () => { m.ui.openPreview("main@3", "the version from 2:14 PM (Codex)"); await sleep(20); });
    assert.equal(last(m).viewing, null, "not on screen: no label");
    const page = require(path.join(OUT, "carton-ui.cjs")).__forTests.conns.get(PROJECT).conn.ui;
    await act(async () => { await page.openPreview("main@3", "the version from 2:14 PM (Codex)"); await sleep(20); });
    assert.deepEqual(m.bridge.previews.at(-1), "main@3", "the editor shows it");
    assert.deepEqual(last(m).viewing, { label: "The version from 2:14 PM (Codex)" });
    await m.cmd("carton-back");
    assert.equal(m.ui.preview(), null, "back to your edit");
    assert.deepEqual(m.bridge.previews.at(-1), null, "the editor swapped back (the bridge's preview(null))");
    assert.equal(last(m).viewing, null);
    // a teammate's cut, switched to: your Main cut in the chip, theirs viewed; ✕ switches back
    await act(async () => { await m.ui.switchCut("cut-bob-main"); await sleep(20); });
    assert.deepEqual([last(m).cut.name, last(m).viewing], ["Main cut", { label: "Bob's Main cut" }]);
    await m.cmd("carton-back");
    assert.equal(m.ui.cuts().find((c) => c.current).id, "cut-main");
    assert.equal(last(m).viewing, null);
  } finally { await m.done(); }
});

// PLAN 2.2 version 2: the chip's click drops the cuts menu down under the chip, drawn by this page (the title bar is a page
// of its own); History stays closed. The command as main passes it on (main-bridge.js command): the chip's box in the
// title bar's px with its devicePixelRatio, whether to open or close, and whether a pointer clicked it.
const CHIP = { left: 700, right: 840, bottom: 36, dpr: 1 };
const chipClick = (o = {}) => ({ action: "carton-cuts", open: true, pointer: true, at: CHIP, ...o });
const pop = (m) => m.container.querySelector("[data-carton-cuts-pop]");
const esc = (el) => act(async () => { el.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })); await sleep(10); });
const clickEl = (el) => act(async () => { el.click(); await sleep(30); });

test("PLAN 2.2 v2: the chip's click drops its cuts menu down under the chip; History stays closed; Esc closes it and focus goes back", opt, async () => {
  const m = await mount();
  // what had the focus on the page before (a button of the editor's)
  const before = document.createElement("button");
  document.body.appendChild(before);
  before.focus();
  try {
    await m.cmd(chipClick(), 60);
    assert.ok(!m.container.querySelector(".carton-sidebar"), "no History");
    const el = pop(m);
    assert.ok(el, "the menu is open");
    // under the title bar (this page starts where it ends), at the chip's left edge, the mockup's 300 px
    assert.deepEqual([el.style.position, el.style.left, el.style.top, el.style.width], ["fixed", "700px", "4px", "300px"]);
    const menu = el.querySelector("[role=menu]");
    assert.equal(menu.getAttribute("aria-label"), "Cuts");
    assert.equal(document.activeElement, menu, "a click: the menu itself has the focus, no cut shown as picked");
    assert.equal(last(m).cutsMenu, true, "the chip shows it open (aria-expanded)");
    // the documented selectors (requirement 5: a recorded demo drives it with DevTools clicks)
    for (const sel of ['[data-carton-cut-name="Main cut"][aria-checked=true]', '[data-carton-cut-name="30s Instagram cut"]', '[data-carton-item="new-cut"]', '[data-carton-item="open-history"]', '[data-carton-item="fold-in"]'])
      assert.ok(el.querySelector(sel), sel);
    assert.match(el.textContent, /Agents work on the cut you're on\./);
    await esc(menu);
    assert.ok(!pop(m), "Esc closed it");
    assert.equal(document.activeElement, before, "focus back where it was on the page");
    assert.equal(last(m).cutsMenu, undefined, "the chip shows it closed");
    assert.ok(!m.container.querySelector(".carton-sidebar"), "and nothing else opened");
  } finally { before.remove(); await m.done(); }
});

test("PLAN 2.2 v2: from the keyboard focus is on its first cut; the chip again closes it; a command without `open` toggles", opt, async () => {
  const m = await mount();
  try {
    await m.cmd(chipClick({ pointer: false }), 60);
    assert.equal(document.activeElement?.getAttribute("data-carton-cut-name"), "Main cut", "Enter on the chip: its first cut");
    await act(async () => { document.activeElement.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true })); await sleep(10); });
    assert.equal(document.activeElement?.getAttribute("data-carton-cut-name"), "30s Instagram cut", "the arrows go down the list");
    // the chip clicked again: it was open when pressed
    await m.cmd(chipClick({ open: false }), 40);
    assert.ok(!pop(m), "the chip again closed it");
    assert.equal(last(m).cutsMenu, undefined);
    // a click that came while it was open (open: true again) keeps it open, at the new place
    await m.cmd(chipClick(), 40);
    await m.cmd(chipClick({ at: { ...CHIP, left: 640 } }), 40);
    assert.equal(pop(m)?.style.left, "640px");
    // an older strip's bare command toggles
    await m.cmd("carton-cuts", 40);
    assert.ok(!pop(m));
    await m.cmd("carton-cuts", 40);
    assert.ok(pop(m), "open, in the window's middle");
    assert.equal(pop(m).style.left, `${Math.round((1280 - 300) / 2)}px`);
  } finally { await m.done(); }
});

test("PLAN 2.2 v2: picking a cut switches and closes it; Open History opens History and closes it", opt, async () => {
  const m = await mount();
  try {
    await m.cmd(chipClick(), 60);
    await clickEl(pop(m).querySelector('[data-carton-cut-name="30s Instagram cut"]'));
    assert.equal(m.ui.cuts().find((c) => c.current).id, "cut-ig", "switched");
    assert.ok(!pop(m), "closed");
    assert.equal(last(m).cut.name, "30s Instagram cut", "the chip follows");
    await m.cmd(chipClick(), 60);
    await clickEl(pop(m).querySelector('[data-carton-item="open-history"]'));
    await act(async () => { await sleep(30); });
    assert.ok(!pop(m), "closed");
    const side = m.container.querySelector(".carton-sidebar");
    assert.ok(side, "History opened");
    assert.match(side.querySelector("[role=tab][aria-selected=true]")?.textContent ?? "", /History/);
    assert.ok(side.contains(document.activeElement), "focus in History");
    assert.equal(last(m).panel, "history");
    assert.ok(!side.querySelector(".carton-menu-pop"), "History's own cuts menu stays closed");
  } finally { await m.done(); }
});

test("PLAN 2.2 v2, K4: during an agent's turn a cut opens in place; Switch now switches, Switch when it finishes waits", opt, async () => {
  const { people } = await import(pathToFileURL(path.join(CARTON, "packages", "react", "src", "mock.ts")).href);
  const m = await mount();
  try {
    await act(async () => { m.ui.setWorking({ actor: people.terminal, label: "Tighten the intro", edits: 1, since: Date.now(), cutId: "cut-main" }); await sleep(20); });
    await m.cmd(chipClick(), 60);
    await clickEl(pop(m).querySelector('[data-carton-cut-name="30s Instagram cut"]'));
    assert.equal(m.ui.cuts().find((c) => c.current).id, "cut-main", "no switch while Claude Code works");
    assert.match(pop(m).querySelector(".carton-cut-turn-text").textContent, /Claude Code is working on Main cut/);
    assert.equal(document.activeElement?.getAttribute("data-carton-cut-choice"), "wait", "focus on Switch when it finishes");
    await clickEl(pop(m).querySelector('[data-carton-cut-choice="now"]'));
    assert.equal(m.ui.cuts().find((c) => c.current).id, "cut-ig", "Switch now switched");
    assert.ok(!pop(m), "and closed it");
    // Switch when it finishes: queued, the menu closed; the turn's end switches (a turn on the cut you're on now: one on
    // another cut doesn't hold a switch, the agent's edits stay where they are)
    await act(async () => { m.ui.setWorking({ actor: people.terminal, label: "Tighten the intro", edits: 1, since: Date.now(), cutId: "cut-ig" }); await sleep(20); });
    await m.cmd(chipClick(), 60);
    await clickEl(pop(m).querySelector('[data-carton-cut-name="Director\'s cut: punchier open"]'));
    await clickEl(pop(m).querySelector('[data-carton-cut-choice="wait"]'));
    assert.ok(!pop(m));
    assert.equal(m.ui.cuts().find((c) => c.current).id, "cut-ig", "waits for the turn");
    await act(async () => { m.ui.setWorking(null); await sleep(40); });
    assert.equal(m.ui.cuts().find((c) => c.current).id, "cut-dir", "switched when it finished");
  } finally { await m.done(); }
});

test("PLAN 2.2 v2: New cut from your edit names it in the menu and makes it; Fold in… opens History with Fold in", opt, async () => {
  const m = await mount();
  try {
    await m.cmd(chipClick(), 60);
    await clickEl(pop(m).querySelector('[data-carton-item="new-cut"]'));
    const input = pop(m).querySelector("input");
    assert.ok(input, "the name field, in the menu");
    await act(async () => {
      Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), "value").set.call(input, "Teaser");
      input.dispatchEvent(new Event("input", { bubbles: true }));
      await sleep(10);
    });
    await act(async () => { input.closest("form").requestSubmit(); await sleep(40); });
    assert.equal(m.ui.cuts().find((c) => c.current)?.label, "Teaser", "made and switched to");
    assert.ok(!pop(m), "closed");
    await m.cmd(chipClick(), 60);
    await clickEl(pop(m).querySelector('[data-carton-item="fold-in"]'));
    await act(async () => { await sleep(40); });
    assert.ok(!pop(m));
    assert.ok(m.container.querySelector(".carton-sidebar"), "History opened");
    assert.ok(m.container.querySelector("[role=dialog].carton-fold, .carton-fold [role=dialog], [role=dialog] .carton-fold"), "with Fold in open");
  } finally { await m.done(); }
});

test("PLAN 2.2 v2: a click elsewhere on the page, the page losing focus (a click in the title bar) and a resize close it", opt, async () => {
  const m = await mount();
  const keep = document.hasFocus;
  try {
    await m.cmd(chipClick(), 60);
    await act(async () => { document.body.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true })); await sleep(10); });
    assert.ok(!pop(m), "a pointer down outside closed it");
    // the focus went to the title bar and didn't come back
    await m.cmd(chipClick(), 60);
    document.hasFocus = () => false;
    await act(async () => { window.dispatchEvent(new Event("blur")); await sleep(220); });
    assert.ok(!pop(m), "losing the focus closed it");
    // the focus back within 150 ms (main gave it back for the chip's own click): it stays
    document.hasFocus = () => true;
    await m.cmd(chipClick(), 60);
    await act(async () => { window.dispatchEvent(new Event("blur")); await sleep(220); });
    assert.ok(pop(m), "a blur whose focus came back leaves it open");
    await act(async () => { window.dispatchEvent(new Event("resize")); await sleep(10); });
    assert.ok(!pop(m), "a resize (the chip moves) closed it");
    // Share (modal) gives way to it
    await m.cmd("carton-share");
    assert.ok(m.container.querySelector("[role=dialog]"));
    await m.cmd(chipClick(), 60);
    assert.ok(!m.container.querySelector("[role=dialog].carton-share-dialog"), "Share closed");
    assert.ok(pop(m));
  } finally { document.hasFocus = keep; await m.done(); }
});

test("PLAN 2.2 v2: the menu hangs from the chip at any width and zoom, inside the window", opt, () => {
  const { placeChipMenu } = require(path.join(OUT, "carton-ui.cjs")).__forTests;
  const view = (width, dpr = 1, height = 800) => ({ width, height, dpr });
  assert.deepEqual(placeChipMenu({ left: 700, dpr: 1 }, view(1522)), { left: 700, top: 4, width: 300, maxHeight: 788 });
  // the title bar at 125 % and the editor zoomed in (Ctrl+=, 150 %): the chip's px times 1.25 / 1.5
  assert.equal(placeChipMenu({ left: 720, dpr: 1.25 }, view(1268, 1.5)).left, 600);
  // near the right edge (a narrow window, the chip's mark-only state): kept 8 px inside
  assert.equal(placeChipMenu({ left: 900, dpr: 1 }, view(960)).left, 960 - 300 - 8);
  assert.equal(placeChipMenu({ left: -20, dpr: 1 }, view(960)).left, 8);
  // narrower than the menu: it fits the window
  assert.deepEqual(placeChipMenu({ left: 100, dpr: 1 }, view(280)), { left: 8, top: 4, width: 264, maxHeight: 788 });
  assert.equal(placeChipMenu(null, view(1000)).left, 350, "no box: the middle");
  assert.equal(placeChipMenu({ left: 700, dpr: 1 }, view(1522, 1, 100)).maxHeight, 160, "a short window: it scrolls");
});

// Review of feat/ux-2-8 #2: Share is modal; the editor's History shortcut doesn't open History behind it.
test("PLAN 8.1: with Share open, Ctrl+Shift+H leaves it be; the title bar's History icon closes Share and opens History", opt, async () => {
  const m = await mount();
  try {
    await m.cmd("carton-share");
    const dialog = m.container.querySelector("[role=dialog]");
    await act(async () => { window.dispatchEvent(new KeyboardEvent("keydown", { key: "H", code: "KeyH", ctrlKey: true, shiftKey: true, bubbles: true, cancelable: true })); await sleep(20); });
    assert.equal(m.container.querySelector(".carton-sidebar"), null, "no History behind the dialog");
    assert.equal(document.activeElement, dialog, "focus stays in the dialog");
    await act(async () => { dialog.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })); await sleep(10); });
    assert.equal(m.container.querySelector("[role=dialog]"), null, "Esc closes Share");
    await m.cmd("carton-share");
    await m.cmd("carton-history");
    assert.equal(m.container.querySelector("[role=dialog]"), null, "the History icon closed Share");
    assert.ok(m.container.querySelector(".carton-sidebar"), "and opened History");
  } finally { await m.done(); }
});

test("PLAN 8.1: Share is a dialog over the editor, from the title bar's icon; not a tab of the side panel", opt, async () => {
  const m = await mount();
  try {
    await m.cmd("carton-share");
    const dialog = m.container.querySelector("[role=dialog].carton-share-dialog");
    assert.ok(dialog, "the Share dialog is open");
    assert.equal(dialog.querySelector(".carton-dialog-title")?.textContent, "Share “Weekend reel”");
    assert.equal(document.activeElement, dialog, "focus starts on the dialog itself (as Cardboard's Export)");
    assert.match(dialog.textContent, /Sharing server/);
    assert.equal(last(m).share, true, "the title bar's Share icon shows it open");
    assert.equal(m.container.querySelector(".carton-sidebar"), null, "no side panel for it");
    await act(async () => { dialog.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })); await sleep(10); });
    assert.equal(m.container.querySelector("[role=dialog]"), null, "Esc closes it");
    assert.equal(last(m).share, false);
    // the icon again opens it, and again closes it
    await m.cmd("carton-share");
    assert.ok(m.container.querySelector("[role=dialog]"));
    await m.cmd("carton-share");
    assert.equal(m.container.querySelector("[role=dialog]"), null);
    // History's tabs: History and Comments
    await m.cmd("carton-history");
    assert.deepEqual([...m.container.querySelectorAll(".carton-sidebar [role=tab]")].map((t) => t.getAttribute("aria-label")), ["History", "Comments"]);
    assert.equal(m.container.querySelector("[data-carton-share]"), null, "a wide window has Share in the title bar, not here");
  } finally { await m.done(); }
});

test("PLAN 2.3: in a narrow window Share joins History's head, and opens the dialog", opt, async () => {
  narrow = true;
  const m = await mount();
  try {
    await m.cmd("carton-history");
    const btn = m.container.querySelector(".carton-sidebar [data-carton-share]");
    assert.ok(btn, "a Share button in the head");
    assert.equal(btn.getAttribute("aria-label"), "Share");
    await act(async () => { btn.click(); await sleep(20); });
    assert.ok(m.container.querySelector("[role=dialog].carton-share-dialog"), "it opens the Share dialog");
  } finally { narrow = false; await m.done(); }
});

test("PLAN 8.1: a shared project's Share: its status by the title, People, and the owner's Invite with Copy link", opt, async () => {
  const live = { shared: true, host: "https://share.example.com", account: "vikas", name: "Vikas", role: "owner", status: "up-to-date", pending: 0, peers: [{ actor: { key: "human/leo", kind: "human", id: "leo", name: "Leo" }, cut: "main", activity: "Editing captions", idle: false, role: "editor" }], problem: null };
  const m = await mount(undefined, { live });
  const copied = [];
  const calls = [];
  const call = m.bridge.call;
  m.bridge.call = async (method, args) => (method === "liveInvite" ? (calls.push(args[0]), { link: "https://share.example.com/#join=p-chip.ct1.abc" }) : call(method, args));
  Object.defineProperty(navigator, "clipboard", { value: { writeText: async (t) => { copied.push(t); } }, configurable: true });
  try {
    await m.cmd("carton-share");
    const d = m.container.querySelector("[role=dialog]");
    assert.match(d.querySelector(".carton-share-status")?.textContent ?? "", /^Up to date$/);
    assert.equal(d.querySelector(".carton-share-status")?.getAttribute("data-state"), "upToDate");
    const rows = [...d.querySelectorAll(".carton-share-person")].map((r) => [r.querySelector(".carton-share-name")?.textContent, r.querySelector(".carton-share-sub")?.textContent, r.querySelector(".carton-share-role")?.textContent ?? null]);
    assert.deepEqual(rows, [["You", "Vikas · here now", "Owner"], ["Leo", "Here now · editing captions", "Can edit"]]);
    assert.match(d.textContent, /Anyone with this link can join and edit\./);
    // QA G24: the link is made as the dialog opens, and shown: never an empty field to "Copy link to make one"
    assert.deepEqual(calls, [{ projectId: PROJECT, role: "editor" }], "one link made, for the role picked");
    assert.equal(d.querySelector(".carton-share-link")?.value, "https://share.example.com/#join=p-chip.ct1.abc", "and shown");
    assert.equal(d.querySelector(".carton-share-link")?.getAttribute("placeholder"), null);
    const copy = [...d.querySelectorAll("button")].find((b) => b.textContent === "Copy link");
    assert.ok(copy, "Copy link");
    await act(async () => { copy.click(); await sleep(20); });
    assert.equal(calls.length, 1, "copied: the link made at opening");
    assert.deepEqual(copied, ["https://share.example.com/#join=p-chip.ct1.abc"]);
    assert.ok([...d.querySelectorAll("button")].some((b) => b.textContent === "Copied"));
    // copied again: no second link
    await act(async () => { [...d.querySelectorAll("button")].find((b) => /Cop/.test(b.textContent)).click(); await sleep(20); });
    assert.equal(calls.length, 1);
    assert.equal(copied.length, 2);
  } finally { delete navigator.clipboard; await m.done(); }
});
