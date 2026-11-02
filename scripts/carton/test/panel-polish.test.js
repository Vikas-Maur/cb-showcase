// The app's own layer of the UI audit fixes (scripts/carton/ui.js), on the real carton-ui code bundled as build.js does:
// P2-4, a short confirmation after Restore, Fold in and a conflict card's pick.
//   node --test scripts/carton/test/panel-polish.test.js
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs"), os = require("os"), path = require("path");

const ROOT = path.resolve(__dirname, "../../..");
const CARTON = path.join(ROOT, "carton");
const skip = !fs.existsSync(path.join(CARTON, "node_modules", "esbuild")) && "run `npm ci` in carton/";
const OUT = path.join(process.env.CARTON_TEST_DIR ?? path.join(os.homedir(), "gfv-scratch", "carton", "windows-sync"), "panel-polish");
const opt = { skip, timeout: 60_000 };

let T, U, React, render;
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
  globalThis.window = { __cartonReact: require(path.join(CARTON, "node_modules", "react")) };
  U = require(path.join(OUT, "carton-ui.cjs"));
  T = U.__forTests;
  React = globalThis.window.__cartonReact;
  render = require(path.join(CARTON, "node_modules", "react-dom", "server")).renderToStaticMarkup;
}, { timeout: 300_000 });

const you = { key: "human/me", kind: "human", name: "Vikas", isYou: true };
const claude = { key: "agent/claude-code", kind: "agent", name: "Claude Code" };
function fakeUi() {
  const calls = [];
  const at = new Date(2026, 10, 2, 12, 41).getTime();
  return {
    calls,
    history: () => ({ all: () => [{ id: "v1", ref: "main@3", at, author: claude, summary: "Moved 'clip.mp4' 0.0 s → 2.0 s" }, { id: "v2", ref: "main@4", at, author: you, name: "Sent to client" }] }),
    cuts: () => [{ id: "main", label: "Main cut", current: false }, { id: "ig", label: "Client review", current: true }],
    conflicts: () => [{ id: "c1", title: "'W6' timing", mine: { author: you, summary: "7 s" }, theirs: { author: claude, summary: "9 s" } }],
    actor: () => undefined,
    restore: async (ref) => { calls.push(["restore", ref]); },
    fold: async (from, into, o) => { calls.push(["fold", from, into, o]); return { ok: true }; },
    resolve: async (id, choice) => { calls.push(["resolve", id, choice]); },
    switchCut: async (id) => { calls.push(["switch", id]); },
  };
}

test("P2-4: Restore says which version it restored, and that nothing is lost", opt, async () => {
  const ui = fakeUi();
  T.confirmations(ui);
  await ui.restore("main@3");
  assert.deepEqual(ui.calls, [["restore", "main@3"]]);
  assert.match(T.toasts.value.text, /^Restored the version from 12:41(\s?PM)?\. It's saved as a new version\.$/);
  await ui.restore("main@4");
  assert.equal(T.toasts.value.text, "Restored “Sent to client”. It's saved as a new version.");
});

test("P2-4: Fold in says what went where, and offers to switch to the cut it went into", opt, async () => {
  const ui = fakeUi();
  T.confirmations(ui);
  const r = await ui.fold("ig", "main", { leaveOut: ["items/w4"], choices: {} });
  assert.deepEqual(r, { ok: true });
  assert.equal(T.toasts.value.text, "Folded “Client review” into Main cut. Some changes were left out.");
  assert.equal(T.toasts.value.action.label, "Switch to Main cut");
  await T.toasts.value.action.run();
  assert.deepEqual(ui.calls.at(-1), ["switch", "main"]);
  // a fold that didn't happen says nothing (its dialog says why)
  T.toasts.set(null);
  ui.fold = async () => ({ ok: false, error: "x" });
  T.confirmations(ui);
  await ui.fold("ig", "main", { leaveOut: [] });
  assert.equal(T.toasts.value, null);
});

test("P2-4: a conflict card's pick says whose edit was kept", opt, async () => {
  const ui = fakeUi();
  T.confirmations(ui);
  await ui.resolve("c1", "theirs");
  assert.equal(T.toasts.value.text, "Kept Claude Code's · 'W6' timing");
  await ui.resolve("c1", "mine");
  assert.equal(T.toasts.value.text, "Kept yours · 'W6' timing");
  await ui.resolve("c1", "both");
  assert.equal(T.toasts.value.text, "Kept both · 'W6' timing");
});

// A teammate as Live.view() sends one (sync/live.js peerActor).
const leo = (idle = false) => ({ actor: { key: "human/leo", kind: "human", id: "leo", name: "Leo" }, cut: "main", activity: idle ? null : "Editing", idle });
const chip = (st) => render(React.createElement(T.LiveChipView, { st, onOpen() {} }));

test("P2-11: a shared project's status shows over the preview, not only in the Share tab", opt, () => {
  assert.equal(chip({ shared: false }), "", "not shared: nothing");
  assert.equal(chip({ shared: true, status: "up-to-date", pending: 0, peers: [] }), "", "up to date, nobody else: nothing");
  const off = chip({ shared: true, status: "offline", pending: 3, peers: [] });
  assert.match(off, /data-state="offline"/);
  assert.match(off, />Offline: 3 edits waiting</);
  // who is here shows in the title bar now (round 2): over the preview only while edits wait
  assert.equal(chip({ shared: true, status: "up-to-date", pending: 0, peers: [leo()] }), "");
  const both = render(React.createElement(T.LiveChipView, { st: { shared: true, status: "up-to-date", pending: 0, peers: [leo(), { actor: null }] }, onOpen() {}, peersToo: true }));
  assert.match(both, /aria-label="Leo is here\. Open Share"/, "one bad entry skipped, the rest shown");
});

test("P2-11 (title bar): the strip's summary of a shared project: its state, its words, who is here", opt, () => {
  assert.equal(U.liveSummary({ shared: false }), null);
  const mia = { actor: { key: "human/mia", kind: "human", id: "mia", name: "Mia Chen" }, idle: true };
  const s = U.liveSummary({ shared: true, status: "offline", pending: 2, peers: [leo(), mia, { actor: { id: "x" } }] });
  assert.deepEqual([s.state, s.words, s.here, s.more], ["offline", "Offline: 2 edits waiting", "Leo, Mia Chen are here", 0]);
  assert.deepEqual(s.people.map((p) => [p.name, p.initials, p.idle, /^#[0-9a-f]{6}$/.test(p.color)]), [["Leo", "L", false, true], ["Mia Chen", "MC", true, true]]);
  assert.equal(U.liveSummary({ shared: true, status: "up-to-date", pending: 0, peers: [] }).state, "ok");
  assert.equal(U.liveSummary({ shared: true, status: "syncing", pending: 1, peers: [] }).state, "syncing");
  const many = U.liveSummary({ shared: true, status: "up-to-date", pending: 0, peers: ["a", "b", "c", "d", "e"].map((n) => ({ actor: { key: "human/" + n, kind: "human", id: n, name: n.toUpperCase() } })) });
  assert.deepEqual([many.people.length, many.more, many.here], [3, 2, "A, B, C and 2 more are here"]);
});

// The title bar's strip (scripts/carton/strip-buttons.js), in its own bundle's scope: `n` the JSX runtime, `c` React,
// `w` joins class names, `I` sends a strip command, `C` the strip's button class.
function strip({ narrow = false } = {}) {
  const src = require(path.join(ROOT, "scripts", "carton", "strip-buttons.js"));
  const sent = [];
  const matchMedia = () => ({ matches: narrow, addEventListener() {}, removeEventListener() {} });
  const Strip = new Function("n", "c", "w", "I", "C", "matchMedia", src + "\nreturn __cbCartonStrip;")(require(path.join(CARTON, "node_modules", "react", "jsx-runtime")), React, (...a) => a.filter(Boolean).join(" "), (x) => sent.push(x), "btn", matchMedia);
  return { html: (panel) => render(React.createElement(Strip, { panel })), sent };
}

test("P2-11, P3-6: the title bar shows the sync dot and who is here; a narrow window keeps History only", opt, () => {
  const live = U.liveSummary({ shared: true, status: "offline", pending: 3, peers: [leo()] });
  const wide = strip().html({ panel: null, live });
  assert.match(wide, /data-carton-strip="history"/);
  assert.match(wide, /aria-label="Share · Offline: 3 edits waiting · Leo is here"/);
  assert.match(wide, /data-carton-sync="offline"/);
  assert.match(wide, />L<\/span>/, "Leo's avatar");
  // as before for a project that isn't shared: the panel's name alone, no dot, no avatars
  const plain = strip().html("history");
  assert.match(plain, /aria-pressed="true"[^>]*data-carton-strip="history"|data-carton-strip="history"[^>]*aria-pressed="true"/);
  assert.doesNotMatch(plain, /data-carton-sync|>L</);
  // narrow: History only, with the dot; Share is the side panel's own tab
  const narrow = strip({ narrow: true }).html({ panel: "share", live });
  assert.doesNotMatch(narrow, /data-carton-strip="share"/);
  assert.match(narrow, /data-carton-sync="offline"/);
  assert.match(narrow, /aria-pressed="true"/, "History shows the panel is open");
});


test("P2-13: the panel keeps the preview usable: its width, narrower, or a drawer over the chat", opt, () => {
  // a wide window: the chosen width
  assert.deepEqual(U.fitPanel({ room: 1100, preferred: 384, viewport: 1920 }), { mode: "inline", width: 384 });
  // less room: narrower, so the preview keeps 320 px
  assert.deepEqual(U.fitPanel({ room: 680, preferred: 384, viewport: 1280 }), { mode: "inline", width: 360 });
  assert.deepEqual(U.fitPanel({ room: 620, preferred: 384, viewport: 1280 }), { mode: "inline", width: 300 });
  // too little even at 300 px (the audit's 960 px window): a drawer over the chat, the preview keeps all its room
  assert.deepEqual(U.fitPanel({ room: 430, preferred: 384, viewport: 960 }), { mode: "overlay", width: 384 });
  assert.deepEqual(U.fitPanel({ room: 100, preferred: 600, viewport: 500 }), { mode: "overlay", width: 436 });
  // before anything is measured: as chosen
  assert.deepEqual(U.fitPanel({ room: 0, preferred: 384, viewport: 1280 }), { mode: "inline", width: 384 });
  // the choice depends only on room: the same room gives the same answer whatever the panel did before
  for (let room = 200; room <= 1200; room += 7) assert.deepEqual(U.fitPanel({ room, preferred: 420, viewport: 1400 }), U.fitPanel({ room, preferred: 420, viewport: 1400 }));
});

// Baseline P3-7 (final re-check): at a 960 px window the drawer (384 px, full height) covered the timeline's right end
// and its toolbar's Fullscreen and Hide timeline buttons, as it reached past the chat column (about 240 px there) into
// the editor's. It is as wide as the chat column when that is at least its 300 px minimum; when the chat is narrower,
// it keeps 300 px and ends where the stage ends, so the timeline and its toolbar stay clear.
test("baseline P3-7: the drawer covers the chat column only; past it, it stops above the timeline", opt, async () => {
  // as wide as the chat when the chat is wide enough, up to the chosen width
  assert.deepEqual(U.fitPanel({ room: 430, preferred: 384, viewport: 1100, chat: 340 }), { mode: "overlay", width: 340, over: false });
  assert.deepEqual(U.fitPanel({ room: 430, preferred: 384, viewport: 1300, chat: 520 }), { mode: "overlay", width: 384, over: false });
  // the audit's 960 px window: the chat is 240 px, so 300 px reaches past it
  assert.deepEqual(U.fitPanel({ room: 263, preferred: 384, viewport: 960, chat: 240 }), { mode: "overlay", width: 300, over: true });
  // the chat collapsed (0 px measured, not "unknown": review #2): the drawer is all past it, so it ends above the timeline
  assert.deepEqual(U.fitPanel({ room: 600, preferred: 384, viewport: 960, chat: 0 }), { mode: "overlay", width: 300, over: true });
  // inline, as before; with no chat measured, as before
  assert.deepEqual(U.fitPanel({ room: 1100, preferred: 384, viewport: 1920, chat: 400 }), { mode: "inline", width: 384 });
  assert.deepEqual(U.fitPanel({ room: 430, preferred: 384, viewport: 960 }), { mode: "overlay", width: 384 });
  // in the page: the drawer's box, from the stage's and the row's (Cardboard's layout at 960 px, as the laptop measured)
  const { Window } = require(path.join(CARTON, "node_modules", "happy-dom"));
  const w = new Window({ url: "http://localhost/", width: 960, height: 770 });
  const keep = { document: globalThis.document, localStorage: globalThis.localStorage, rAF: globalThis.requestAnimationFrame, win: { ...globalThis.window } };
  globalThis.document = w.document;
  globalThis.localStorage = { getItem: () => null, setItem() {} };
  globalThis.requestAnimationFrame = (f) => setTimeout(f, 0);
  Object.assign(globalThis.window, { innerWidth: 960, addEventListener() {}, removeEventListener() {} });
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  let root = null;
  try {
    const { createMockUi } = await import(require("url").pathToFileURL(path.join(CARTON, "packages", "react", "src", "mock.ts")).href);
    const client = require(path.join(CARTON, "node_modules", "react-dom", "client"));
    const box = (r) => () => ({ left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.right - r.left, height: r.bottom - r.top, x: r.left, y: r.top });
    // the editor's row (the aside's parent: the mount here), with the stage in it
    const row = w.document.createElement("div"), stage = w.document.createElement("div");
    stage.setAttribute("data-carton-stage-host", "");
    row.getBoundingClientRect = box({ left: 0, right: 960, top: 40, bottom: 770 });
    stage.getBoundingClientRect = box({ left: 366, right: 720, top: 40, bottom: 530 });
    w.document.body.append(stage, row);
    root = client.createRoot(row);
    await React.act(async () => { root.render(React.createElement(T.CartonProvider, { ui: createMockUi({ versions: 5 }) }, React.createElement(T.Sidebar, { panel: "history", setPanel() {}, projectId: "p1", bridge: { call: async () => ({}), onEvent: () => () => {} } }))); });
    const a = row.querySelector("aside");
    assert.equal(a.getAttribute("data-fit"), "overlay");
    assert.deepEqual([a.style.position, a.style.width, a.style.top, a.style.height], ["fixed", "300px", "40px", "490px"], "300 px wide, from the row's top to the stage's bottom: the timeline below stays clear");
    // the chat collapsed: the stage reaches the row's right edge
    await React.act(async () => root.unmount());
    root = null;
    stage.getBoundingClientRect = box({ left: 366, right: 960, top: 40, bottom: 530 });
    root = client.createRoot(row);
    await React.act(async () => { root.render(React.createElement(T.CartonProvider, { ui: createMockUi({ versions: 5 }) }, React.createElement(T.Sidebar, { panel: "history", setPanel() {}, projectId: "p1", bridge: { call: async () => ({}), onEvent: () => () => {} } }))); });
    const b = row.querySelector("aside");
    assert.deepEqual([b.getAttribute("data-fit"), b.style.width, b.style.height], ["overlay", "300px", "490px"], "no chat to cover: it ends above the timeline");
  } finally {
    if (root) await React.act(async () => root.unmount());
    delete globalThis.IS_REACT_ACT_ENVIRONMENT;
    Object.assign(globalThis, { document: keep.document, localStorage: keep.localStorage, requestAnimationFrame: keep.rAF });
    for (const k of ["innerWidth", "addEventListener", "removeEventListener"]) delete globalThis.window[k];
    Object.assign(globalThis.window, keep.win);
    await w.happyDOM.close();
  }
});

// Regress prod3 P3-A: at 960 px with the chat open the chat column is 384 px wide, the drawer as wide (not past it),
// so it stayed full height, over the timeline toolbar's Fullscreen and Hide timeline, which run on under the chat column
// at that width. Wherever the toolbar reaches under the drawer (tools: its last button's right edge), the drawer ends
// above it; where the toolbar ends left of the drawer, as before.
test("prod3 P3-A: the drawer ends above the timeline toolbar wherever the toolbar reaches under it", opt, async () => {
  // the laptop's 960 px with the chat open: chat 384, Hide timeline's right edge under it
  assert.deepEqual(U.fitPanel({ room: 380, preferred: 384, viewport: 960, chat: 384, tools: 940 }), { mode: "overlay", width: 384, over: true });
  // the wider cases (fix/ui-final): the toolbar ends left of the drawer, or isn't found: full height over the chat
  assert.deepEqual(U.fitPanel({ room: 430, preferred: 384, viewport: 1100, chat: 340, tools: 700 }), { mode: "overlay", width: 340, over: false });
  assert.deepEqual(U.fitPanel({ room: 430, preferred: 384, viewport: 1300, chat: 520, tools: undefined }), { mode: "overlay", width: 384, over: false });
  // in the page: Cardboard's layout at 960 px with the chat open, as the laptop measured it
  const { Window } = require(path.join(CARTON, "node_modules", "happy-dom"));
  const w = new Window({ url: "http://localhost/", width: 960, height: 826 });
  const keep = { document: globalThis.document, localStorage: globalThis.localStorage, rAF: globalThis.requestAnimationFrame, win: { ...globalThis.window } };
  globalThis.document = w.document;
  globalThis.localStorage = { getItem: () => null, setItem() {} };
  globalThis.requestAnimationFrame = (f) => setTimeout(f, 0);
  Object.assign(globalThis.window, { innerWidth: 960, addEventListener() {}, removeEventListener() {} });
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  let root = null;
  try {
    const { createMockUi } = await import(require("url").pathToFileURL(path.join(CARTON, "packages", "react", "src", "mock.ts")).href);
    const client = require(path.join(CARTON, "node_modules", "react-dom", "client"));
    const box = (r) => () => ({ left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.right - r.left, height: r.bottom - r.top, x: r.left, y: r.top });
    const row = w.document.createElement("div"), stage = w.document.createElement("div"), hide = w.document.createElement("button");
    stage.setAttribute("data-carton-stage-host", "");
    hide.setAttribute("aria-label", "Hide timeline");
    row.getBoundingClientRect = box({ left: 0, right: 960, top: 0, bottom: 826 });
    stage.getBoundingClientRect = box({ left: 200, right: 576, top: 0, bottom: 586 });
    hide.getBoundingClientRect = box({ left: 912, right: 940, top: 594, bottom: 622 });
    w.document.body.append(stage, hide, row);
    const mount = async () => {
      root = client.createRoot(row);
      await React.act(async () => { root.render(React.createElement(T.CartonProvider, { ui: createMockUi({ versions: 5 }) }, React.createElement(T.Sidebar, { panel: "history", setPanel() {}, projectId: "p1", bridge: { call: async () => ({}), onEvent: () => () => {} } }))); });
      const a = row.querySelector("aside");
      const out = [a.getAttribute("data-fit"), a.style.width, a.style.top, a.style.height];
      await React.act(async () => root.unmount());
      root = null;
      return out;
    };
    assert.deepEqual(await mount(), ["overlay", "384px", "0px", "586px"], "over the chat column, ending where the stage ends: the toolbar below stays clear");
    // the timeline hidden: the same button, now "Show timeline"
    hide.setAttribute("aria-label", "Show timeline");
    assert.deepEqual(await mount(), ["overlay", "384px", "0px", "586px"]);
    // a toolbar that ends left of the chat column: the drawer covers the column, top to bottom, as before
    hide.getBoundingClientRect = box({ left: 540, right: 568, top: 594, bottom: 622 });
    assert.deepEqual(await mount(), ["overlay", "384px", "0px", "826px"]);
  } finally {
    if (root) await React.act(async () => root.unmount());
    delete globalThis.IS_REACT_ACT_ENVIRONMENT;
    Object.assign(globalThis, { document: keep.document, localStorage: keep.localStorage, requestAnimationFrame: keep.rAF });
    for (const k of ["innerWidth", "addEventListener", "removeEventListener"]) delete globalThis.window[k];
    Object.assign(globalThis.window, keep.win);
    await w.happyDOM.close();
  }
});

test("P2-9: the Dashboard's Join dialog holds the Join form at once, in editors' words", opt, () => {
  globalThis.localStorage = { getItem: () => null, setItem() {} };
  globalThis.document = { getElementById: () => null, createElement: () => ({}), head: { appendChild() {} }, activeElement: null };
  const html = render(React.createElement(U.JoinDialog, { bridge: { call: async () => ({}), onEvent: () => () => {} }, onClose() {} }));
  assert.match(html, /role="dialog"/);
  assert.match(html, />Join a shared project</);
  assert.match(html, /Paste the invite link a teammate sent you/);
  assert.match(html, /id="carton-join-link"/, "the link field, with no extra button to get to it");
  assert.doesNotMatch(html, /Got an invite link/);
  assert.equal((html.match(/Join a shared project/g) ?? []).length, 1, "the title only, no second heading");
});

// The Dashboard patch (sync/patches/ui.js), on its own text: its anchors, and its tile. `win` and `portal` stand in for
// the page's; the dialog's chunk (`import("./carton-ui.js")`) is `win.__testUi()`.
function dashboard(ready, on = false, { win = {}, portal = (x) => x, doc = {} } = {}) {
  const part = require(path.join(ROOT, "scripts", "carton", "sync", "patches", "ui.js"));
  const edits = [], pre = [];
  const file = (k) => ({ replace: (from, to, n = 1) => k === "index" && edits.push([from, to, n]), prepend: (t) => k === "index" && pre.push(t) });
  part.app({ editor: file("editor"), index: file("index") });
  if (ready !== undefined) win.__carton = { ...win.__carton, on, ready };
  const src = pre.join("\n").split('import("./carton-ui.js")').join("window.__testUi()");
  const api = new Function("r", "i", "Au", "window", "document", src + "\nreturn { Tile: __cbCartonJoinTile, Button: __cbCartonJoinButton, useOn: __cbCartonUseOn, Host: typeof __cbCartonJoinHost === 'function' ? __cbCartonJoinHost : null };")(React, require(path.join(CARTON, "node_modules", "react", "jsx-runtime")), { createPortal: portal }, win, doc);
  return { edits, ...api };
}

test("P2-9: the Dashboard gets a Join tile beside New project, only once Carton says it is on", opt, async () => {
  const d = dashboard(Promise.resolve(true));
  assert.equal(d.edits.length, 4, "the grid's cells and their render, the empty library's row, the Join dialog's host");
  assert.ok(d.edits.every(([, , n]) => n === 1), "each anchor once");
  assert.match(d.edits[0][1], /\[null,\.\.\.\(__cbJ\?\[__cbCartonJoinCell\]:\[\]\),\.\.\.e\]/);
  assert.match(d.edits[0][1], /\[e,y,__cbJ\]\)$/, "the grid asks again when Carton's answer comes");
  const tile = render(React.createElement(d.Tile));
  assert.match(tile, /data-carton-join=""/);
  assert.match(tile, />Join a shared project</);
  assert.match(tile, />From an invite link</);
  // the hook: off at first, on once the bridge's ready says so (rendered through React's client renderer)
  const seen = [];
  const { Window } = require(path.join(CARTON, "node_modules", "happy-dom"));
  const w = new Window();
  globalThis.document = w.document;
  const client = require(path.join(CARTON, "node_modules", "react-dom", "client"));
  const el = w.document.createElement("div");
  const root = client.createRoot(el);
  const Probe = () => { seen.push(d.useOn()); return null; };
  await React.act(async () => { root.render(React.createElement(Probe)); await new Promise((r) => setTimeout(r, 10)); });
  assert.deepEqual([seen[0], seen.at(-1)], [false, true]);
  await React.act(async () => root.unmount());
  await w.happyDOM.close();
  // off: no tile ever
  const off = dashboard(Promise.resolve(false));
  const seenOff = [];
  const w2 = new Window(); globalThis.document = w2.document;
  const root2 = client.createRoot(w2.document.createElement("div"));
  await React.act(async () => { root2.render(React.createElement(() => { seenOff.push(off.useOn()); return null; })); await new Promise((r) => setTimeout(r, 10)); });
  assert.equal(seenOff.at(-1), false);
  await React.act(async () => root2.unmount());
  await w2.happyDOM.close();
});

// Regress 2026-11-02 #3: a new user's first screen (an empty library: "Make your first video") has no grid, so no tile.
// Join is a button there, beside "Start a blank project", in that row's own secondary look (the class Cardboard gives
// "Browse recipes", passed in at the patch site); only with Carton on.
test("regress #3: an empty library offers Join beside Start a blank project, only with Carton on", opt, async () => {
  const d = dashboard(Promise.resolve(true), true);
  const row = d.edits.find(([from]) => from.includes('"data-analytics":"projects-empty-browse-recipes"'));
  assert.ok(row, "the empty library's button row is patched: " + d.edits.map(([f]) => f.slice(0, 60)).join(" | "));
  assert.equal(row[2], 1, "its anchor once");
  assert.match(row[1], /children:\[i\.jsx\(__cbCartonJoinButton,\{className:v\(q4,"bg-white\/\[0\.06\] text-white\/85 hover:bg-white\/\[0\.10\] hover:text-white"\)\}\),a&&i\.jsxs\("button"/, "first in the row, in Browse recipes' look");
  // the anchor is the empty state's, in Cardboard 1.4.0 as shipped (when its bundles are here)
  const pristine = process.env.CARDBOARD_PRISTINE && path.join(process.env.CARDBOARD_PRISTINE, "app-asar", "dist", "renderer", "assets");
  if (pristine && fs.existsSync(pristine)) {
    const hits = fs.readdirSync(pristine).filter((f) => /^index-.*\.js$/.test(f)).map((f) => fs.readFileSync(path.join(pristine, f), "utf8").split(row[0]).length - 1);
    assert.deepEqual(hits.filter(Boolean), [1], "one match, in the Dashboard's chunk");
  }
  const html = render(React.createElement(d.Button, { className: "cb-secondary" }));
  assert.match(html, /^<button type="button" data-carton-join="" class="cb-secondary"><svg[^>]*>.*<\/svg>Join a shared project<\/button>$/, html);
  // Carton off: nothing
  assert.equal(render(React.createElement(dashboard(Promise.resolve(false)).Button, { className: "x" })), "");
  assert.equal(render(React.createElement(dashboard(undefined).Button, { className: "x" })), "");
});

// Final re-check N1 (P2): joining from an empty library, the "… is in your library now · Open / Done" dialog closed on its
// own as the joined project arrived, so Open couldn't be pressed and no tab opened (5 of 5 fresh profiles). The dialog
// lived in the empty library's view ("Make your first video"), which Cardboard's Home replaces with the grid as soon as
// the library holds a project. Here a Home as Cardboard's renders either view (its `P`), with the real Join dialog; the
// library gets the project while the join is answered, before the answer and after it.
for (const when of ["before", "after"])
  test(`final N1: joining from an empty library keeps Open / Done until pressed (the project arrives ${when} the answer)`, opt, async () => {
    const { Window } = require(path.join(CARTON, "node_modules", "happy-dom"));
    const w = new Window({ url: "http://localhost/" });
    const keep = { document: globalThis.document, localStorage: globalThis.localStorage, rAF: globalThis.requestAnimationFrame };
    globalThis.document = w.document;
    globalThis.localStorage = { getItem: (k) => (k === "carton.name" ? "Bea" : null), setItem() {} };
    globalThis.requestAnimationFrame = (f) => setTimeout(f, 0);
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
    let root = null;
    try {
      const client = require(path.join(CARTON, "node_modules", "react-dom", "client"));
      const { createPortal } = require(path.join(CARTON, "node_modules", "react-dom"));
      let addToLibrary = null;
      const opened = [];
      const bridge = {
        on: true, ready: Promise.resolve(true), onEvent: () => () => {},
        call: async (method) => {
          assert.equal(method, "liveJoin");
          // (inside the submit's act, which waits long enough for a timer)
          if (when === "before") addToLibrary();
          else setTimeout(addToLibrary, 0);
          return { projectId: "p-fx", name: "FX ui" };
        },
        openProject: async (id) => { opened.push(id); },
      };
      const win = { __carton: bridge, __testUi: async () => ({ JoinDialog: U.JoinDialog }) };
      const d = dashboard(bridge.ready, true, { win, portal: createPortal, doc: w.document });
      // the host sits in Home's root, beside Cardboard's own dialogs: one anchor, in Cardboard 1.4.0 as shipped
      const host = d.edits.find(([, to]) => to.includes("__cbCartonJoinHost"));
      assert.deepEqual(host, ["i.jsx(iG,{...I.dialog}),i.jsx(CG,{...I.referenceDialog})", "i.jsx(iG,{...I.dialog}),i.jsx(CG,{...I.referenceDialog}),i.jsx(__cbCartonJoinHost,{})", 1]);
      const pristine = process.env.CARDBOARD_PRISTINE && path.join(process.env.CARDBOARD_PRISTINE, "app-asar", "dist", "renderer", "assets");
      if (pristine && fs.existsSync(pristine)) {
        const hits = fs.readdirSync(pristine).filter((f) => /^index-.*\.js$/.test(f)).map((f) => fs.readFileSync(path.join(pristine, f), "utf8").split(host[0]).length - 1);
        assert.deepEqual(hits.filter(Boolean), [1], "one match, in the Dashboard's chunk");
      }
      // Cardboard's Home (index-*.js): `P` is the empty view (E$, with Join in its row of buttons) while the library is
      // empty, else the grid (Mq, with the Join tile); its root also holds its own dialogs, and the patch's Join host.
      function Home() {
        const [cards, setCards] = React.useState([]);
        addToLibrary = () => setCards(["p-fx"]);
        const P = cards.length === 0
          ? React.createElement("section", { "data-view": "empty" }, React.createElement(d.Button, { className: "cb" }))
          : React.createElement("div", { role: "list", "data-view": "grid" }, React.createElement(d.Tile), ...cards.map((c) => React.createElement("div", { key: c, role: "listitem" }, c)));
        return React.createElement("div", null, P, d.Host ? React.createElement(d.Host) : null);
      }
      const el = w.document.createElement("div");
      w.document.body.appendChild(el);
      root = client.createRoot(el);
      await React.act(async () => { root.render(React.createElement(Home)); await new Promise((r) => setTimeout(r, 10)); });
      const body = w.document.body;
      await React.act(async () => { body.querySelector("[data-carton-join]").click(); await new Promise((r) => setTimeout(r, 10)); });
      const link = body.querySelector("#carton-join-link");
      assert.ok(link, "the Join dialog is open");
      // typed: react-dom was loaded here while `window` had no document, so it tells a change by its fallback (focus,
      // then a key), not by the input event
      await React.act(async () => {
        link.focus();
        Object.getOwnPropertyDescriptor(Object.getPrototypeOf(link), "value").set.call(link, "https://share.example.com/#join=ct1.abc");
        for (const type of ["input", "keyup"]) link.dispatchEvent(new w.Event(type, { bubbles: true }));
      });
      await React.act(async () => { link.closest("form").dispatchEvent(new w.Event("submit", { bubbles: true, cancelable: true })); await new Promise((r) => setTimeout(r, 20)); });
      await React.act(async () => { await new Promise((r) => setTimeout(r, 20)); });
      assert.ok(el.querySelector('[data-view="grid"]'), "the library shows the joined project: Cardboard swapped the empty view for the grid");
      assert.match(body.textContent, /“FX ui” is in your library now\./, "the dialog says so, and stays");
      const open = [...body.querySelectorAll("button")].find((b) => b.textContent === "Open");
      assert.ok(open, "with its Open");
      await React.act(async () => { open.click(); await new Promise((r) => setTimeout(r, 10)); });
      assert.deepEqual(opened, ["p-fx"], "Open opens the joined project");
      assert.equal(body.querySelector(".carton-join-dialog"), null, "and the dialog closes");
    } finally {
      if (root) await React.act(async () => root.unmount());
      delete globalThis.IS_REACT_ACT_ENVIRONMENT;
      Object.assign(globalThis, { document: keep.document, localStorage: keep.localStorage, requestAnimationFrame: keep.rAF });
      await w.happyDOM.close();
    }
  });

// Regress prod3 P3-E: joining from an empty library, the page jumped back to the Dashboard's top as the join landed
// (Home swaps the empty view for the grid, and its scroller lost its place while the grid measured itself): the
// sidebar's Projects lit Dashboard, and after Done the new tile was below the fold. Here Home's scroller is scrolled
// down to the projects, and the grid, as it mounts, throws the scroller back to the top as Cardboard's did. The page
// keeps its place, then shows the new tile; a person who scrolls meanwhile keeps their own scroll.
for (const scrolls of [false, true])
  test(`prod3 P3-E: joining from an empty library keeps the page where it was${scrolls ? ", unless the person scrolls" : ", and shows the new tile"}`, opt, async () => {
    const { Window } = require(path.join(CARTON, "node_modules", "happy-dom"));
    const w = new Window({ url: "http://localhost/" });
    const keep = { document: globalThis.document, localStorage: globalThis.localStorage, rAF: globalThis.requestAnimationFrame };
    globalThis.document = w.document;
    globalThis.localStorage = { getItem: (k) => (k === "carton.name" ? "Bea" : null), setItem() {} };
    globalThis.requestAnimationFrame = (f) => setTimeout(f, 0);
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
    let root = null;
    try {
      const client = require(path.join(CARTON, "node_modules", "react-dom", "client"));
      const { createPortal } = require(path.join(CARTON, "node_modules", "react-dom"));
      let addToLibrary = null;
      const bridge = { on: true, ready: Promise.resolve(true), onEvent: () => () => {}, call: async () => { setTimeout(addToLibrary, 0); return { projectId: "p-fx", name: "FX ui" }; }, openProject: async () => {} };
      const d = dashboard(bridge.ready, true, { win: { __carton: bridge, __testUi: async () => ({ JoinDialog: U.JoinDialog }) }, portal: createPortal, doc: w.document });
      const revealed = [];
      w.HTMLElement.prototype.scrollIntoView = function (o) { revealed.push([this.textContent, o?.block]); };
      // Home: its scroller (overflow-y auto), the Dashboard's top, then the projects: the empty view or the grid, which
      // throws the scroller back to the top as it mounts (the jump the laptop saw)
      let scroller = null;
      const toScroller = (n) => { if (n) scroller = n; };
      function Grid({ cards }) {
        React.useLayoutEffect(() => { scroller.scrollTop = 0; }, []);
        return React.createElement("div", { role: "list", "data-view": "grid" },
          React.createElement("div", { role: "listitem" }, "New project"), React.createElement("div", { role: "listitem" }, React.createElement(d.Tile)),
          ...cards.map((c) => React.createElement("div", { key: c, role: "listitem" }, c)));
      }
      function Home() {
        const [cards, setCards] = React.useState([]);
        addToLibrary = () => setCards(["p-fx"]);
        const P = cards.length === 0 ? React.createElement("section", { "data-view": "empty" }, React.createElement(d.Button, { className: "cb" })) : React.createElement(Grid, { cards });
        return React.createElement("div", null,
          React.createElement("div", { ref: toScroller, style: { overflowY: "auto", height: "800px" } }, React.createElement("section", { style: { height: "700px" } }, "Dashboard"), P),
          d.Host ? React.createElement(d.Host) : null);
      }
      const el = w.document.createElement("div");
      w.document.body.appendChild(el);
      root = client.createRoot(el);
      await React.act(async () => { root.render(React.createElement(Home)); await new Promise((r) => setTimeout(r, 10)); });
      scroller.scrollTop = 700; // Projects: Home scrolls its projects section to the top
      const body = w.document.body;
      await React.act(async () => { body.querySelector("[data-carton-join]").click(); await new Promise((r) => setTimeout(r, 10)); });
      const link = body.querySelector("#carton-join-link");
      await React.act(async () => {
        link.focus();
        Object.getOwnPropertyDescriptor(Object.getPrototypeOf(link), "value").set.call(link, "https://share.example.com/#join=ct1.abc");
        for (const type of ["input", "keyup"]) link.dispatchEvent(new w.Event(type, { bubbles: true }));
      });
      await React.act(async () => { link.closest("form").dispatchEvent(new w.Event("submit", { bubbles: true, cancelable: true })); await new Promise((r) => setTimeout(r, 20)); });
      assert.ok(el.querySelector('[data-view="grid"]'), "the join landed: the grid replaced the empty view");
      if (scrolls) {
        // the person scrolls up meanwhile: theirs, not put back
        await React.act(async () => { scroller.dispatchEvent(new w.Event("wheel")); scroller.scrollTop = 120; await new Promise((r) => setTimeout(r, 50)); });
        assert.equal(scroller.scrollTop, 120);
      } else {
        await React.act(async () => { await new Promise((r) => setTimeout(r, 50)); });
        assert.equal(scroller.scrollTop, 700, "still at the projects, not the Dashboard's top");
        assert.match(body.textContent, /“FX ui” is in your library now\./, "with the dialog up");
        await React.act(async () => { await new Promise((r) => setTimeout(r, 1600)); });
        assert.equal(scroller.scrollTop, 700);
        assert.deepEqual(revealed, [["p-fx", "nearest"]], "the new tile is brought into view if it isn't");
      }
    } finally {
      if (root) await React.act(async () => root.unmount());
      delete globalThis.IS_REACT_ACT_ENVIRONMENT;
      Object.assign(globalThis, { document: keep.document, localStorage: keep.localStorage, requestAnimationFrame: keep.rAF });
      await w.happyDOM.close();
    }
  });

// Regress 2026-11-02 #4 (UI audit P2-1: Esc closes the innermost layer only, "… → preview → panel"): with focus in the
// side panel during a preview, Esc closed the whole panel and left the preview open. It returns from the preview first,
// as the banner's button does; the next Esc closes the panel. (Esc with focus on the page: @carton/react's
// PreviewBanner, test/regress.dom.test.ts.)
test("regress #4: in the side panel, Esc returns from a preview first; the next Esc closes the panel", opt, async () => {
  const { Window } = require(path.join(CARTON, "node_modules", "happy-dom"));
  const w = new Window({ url: "http://localhost/" });
  const keep = { document: globalThis.document, localStorage: globalThis.localStorage, rAF: globalThis.requestAnimationFrame };
  globalThis.document = w.document;
  globalThis.localStorage = { getItem: () => null, setItem() {} };
  globalThis.requestAnimationFrame = (f) => setTimeout(f, 0);
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  let root = null;
  try {
    const { createMockUi } = await import(require("url").pathToFileURL(path.join(CARTON, "packages", "react", "src", "mock.ts")).href);
    const ui = createMockUi({ versions: 20 });
    const client = require(path.join(CARTON, "node_modules", "react-dom", "client"));
    const el = w.document.createElement("div");
    w.document.body.appendChild(el);
    root = client.createRoot(el);
    const closed = [];
    const bridge = { call: async () => ({}), onEvent: () => () => {} };
    const { CartonProvider, Sidebar } = T;
    await React.act(async () => { root.render(React.createElement(CartonProvider, { ui }, React.createElement(Sidebar, { panel: "history", setPanel: (p) => closed.push(p), projectId: "p1", bridge }))); });
    const list = el.querySelector(".carton-history-list");
    assert.ok(list, "the History panel is open");
    const esc = () => React.act(async () => { list.dispatchEvent(new w.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })); });
    await React.act(async () => { ui.openPreview("main@3", "the version from 12:41"); });
    // a layer that took the key in the capture phase (Radix) keeps it: nothing here (review of fix/ui-regress #1)
    const capture = (e) => e.preventDefault();
    w.document.addEventListener("keydown", capture, true);
    await esc();
    w.document.removeEventListener("keydown", capture, true);
    assert.ok(ui.preview(), "a key a layer took leaves the preview");
    assert.deepEqual(closed, [], "and the panel");
    await esc();
    assert.equal(ui.preview(), null, "the first Esc returns from the preview");
    assert.deepEqual(closed, [], "and leaves the panel open");
    await esc();
    assert.deepEqual(closed, [null], "the next Esc closes the panel");
  } finally {
    // unmounted whatever happened: the panel's timers would hold the test process open
    if (root) await React.act(async () => root.unmount());
    delete globalThis.IS_REACT_ACT_ENVIRONMENT;
    Object.assign(globalThis, { document: keep.document, localStorage: keep.localStorage, requestAnimationFrame: keep.rAF });
    await w.happyDOM.close();
  }
});

// Regress 2026-11-02 P3-3: at the panel's 300 px minimum the three tabs' labels ran under the close ✕ ("Share✕"). Below
// 340 px the tabs not open show their icon only (named for screen readers and on hover); the open one keeps its label.
test("regress P3-3: a narrow panel keeps the open tab's label and shows the others as icons, clear of the close button", opt, async () => {
  const { Window } = require(path.join(CARTON, "node_modules", "happy-dom"));
  const w = new Window({ url: "http://localhost/" });
  const keep = { document: globalThis.document, localStorage: globalThis.localStorage, rAF: globalThis.requestAnimationFrame };
  globalThis.document = w.document;
  globalThis.requestAnimationFrame = (f) => setTimeout(f, 0);
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  let root = null;
  try {
    const { createMockUi } = await import(require("url").pathToFileURL(path.join(CARTON, "packages", "react", "src", "mock.ts")).href);
    const ui = createMockUi({ versions: 5 });
    const client = require(path.join(CARTON, "node_modules", "react-dom", "client"));
    const bridge = { call: async () => ({}), onEvent: () => () => {} };
    const tabs = async (width) => {
      globalThis.localStorage = { getItem: (k) => (k === "carton.sidePanelWidth" ? String(width) : null), setItem() {} };
      const el = w.document.createElement("div");
      w.document.body.appendChild(el);
      root = client.createRoot(el);
      await React.act(async () => { root.render(React.createElement(T.CartonProvider, { ui }, React.createElement(T.Sidebar, { panel: "history", setPanel() {}, projectId: "p1", bridge }))); });
      const out = [...el.querySelectorAll("[role=tab]")].map((b) => ({ name: b.getAttribute("aria-label"), text: b.textContent }));
      await React.act(async () => root.unmount());
      root = null;
      el.remove();
      return out;
    };
    assert.deepEqual(await tabs(300), [{ name: "History", text: "History" }, { name: "Comments", text: "" }, { name: "Share", text: "" }]);
    assert.deepEqual(await tabs(384), [{ name: "History", text: "History" }, { name: "Comments", text: "Comments" }, { name: "Share", text: "Share" }]);
  } finally {
    if (root) await React.act(async () => root.unmount());
    delete globalThis.IS_REACT_ACT_ENVIRONMENT;
    Object.assign(globalThis, { document: keep.document, localStorage: keep.localStorage, requestAnimationFrame: keep.rAF });
    await w.happyDOM.close();
  }
});
