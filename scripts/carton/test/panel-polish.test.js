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

// The Dashboard patch (sync/patches/ui.js), on its own text: its two anchors, and its tile.
function dashboard(ready, on = false) {
  const part = require(path.join(ROOT, "scripts", "carton", "sync", "patches", "ui.js"));
  const edits = [], pre = [];
  const file = (k) => ({ replace: (from, to, n = 1) => k === "index" && edits.push([from, to, n]), prepend: (t) => k === "index" && pre.push(t) });
  part.app({ editor: file("editor"), index: file("index") });
  const win = { __carton: ready === undefined ? undefined : { on, ready } };
  const api = new Function("r", "i", "Au", "window", "document", pre.join("\n") + "\nreturn { Tile: __cbCartonJoinTile, Button: __cbCartonJoinButton, useOn: __cbCartonUseOn };")(React, require(path.join(CARTON, "node_modules", "react", "jsx-runtime")), { createPortal: (x) => x }, win, {});
  return { edits, ...api };
}

test("P2-9: the Dashboard gets a Join tile beside New project, only once Carton says it is on", opt, async () => {
  const d = dashboard(Promise.resolve(true));
  assert.equal(d.edits.length, 3);
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
