// Viewing without banners (Carton UX redesign, Workstream 1: PLAN 1.1–1.6), from the editor's page: the real carton-ui
// code (scripts/carton/ui.js, bundled as scripts/carton/build.js bundles it) on React 19's client renderer in a DOM
// (happy-dom), its side panel and its stage layer mounted as editor-panel.js mounts them, over a bridge that serves
// @carton/react's mock through the real serveUi (carton:call "ui" out, carton:event back), as the library worker
// serves the page. The bridge's blocked() and beforeExport() are the renderer bridge's own logic (renderer-bridge.js:
// the newest Carton part answers); editor-panel.js's timeline wrapper is its real source, run on this React.
//   node --test scripts/carton/test/viewing.test.js
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs"), os = require("os"), path = require("path"), { pathToFileURL } = require("url");

const ROOT = path.resolve(__dirname, "../../..");
const CARTON = path.join(ROOT, "carton");
const skip = !fs.existsSync(path.join(CARTON, "node_modules", "esbuild")) && "run `npm ci` in carton/";
// Never /tmp (a small shared tmpfs on the build box).
const OUT = path.join(process.env.CARTON_TEST_DIR ?? path.join(os.homedir(), "gfv-scratch", "carton", "windows-sync"), "viewing");
const opt = { skip, timeout: 60_000 };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let React, client, act, U, win, createMockUi, serveUi, jsx;
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
  win = new Window({ url: "http://localhost/", width: 1440, height: 900 });
  for (const k of ["window", "document", "navigator", "localStorage", "Node", "Element", "HTMLElement", "HTMLInputElement", "HTMLButtonElement", "HTMLDivElement", "SVGElement", "Text", "Event", "KeyboardEvent", "MouseEvent", "PointerEvent", "FocusEvent", "InputEvent", "CustomEvent", "MutationObserver", "ResizeObserver", "getComputedStyle", "requestAnimationFrame", "cancelAnimationFrame", "DocumentFragment"])
    Object.defineProperty(globalThis, k, { value: win[k], configurable: true, writable: true });
  globalThis.matchMedia = win.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  React = require(path.join(CARTON, "node_modules", "react"));
  jsx = require(path.join(CARTON, "node_modules", "react", "jsx-runtime"));
  client = require(path.join(CARTON, "node_modules", "react-dom", "client"));
  act = React.act;
  window.__cartonReact = React;
  U = require(path.join(OUT, "carton-ui.cjs"));
  ({ createMockUi } = await import(pathToFileURL(path.join(CARTON, "packages", "react", "src", "mock.ts")).href));
  ({ serveUi } = await import(pathToFileURL(path.join(CARTON, "packages", "react", "src", "remote.ts")).href));
}, { timeout: 300_000 });
test.after(async () => { await win?.happyDOM.close(); });

const h = (...a) => React.createElement(...a);
let seq = 0;

/**
 * The editor's page with Carton's side panel and stage layer, over a bridge that serves `ui` as the worker does. The
 * bridge records the editor's swaps (preview), seeks and selections; `selected` is the editor's clip selection.
 */
async function mount(ui = createMockUi({ versions: 8 })) {
  const PROJECT = "p-view-" + ++seq;
  const cmds = new Set(), evs = new Set(), servers = new Map(), blocked = new Set(), backs = new Set(), notices = new Set();
  const did = { previews: [], seeks: [], selects: [], marks: [] };
  let selected = [];
  window.__cartonTimelineMark = (m) => did.marks.push(m);
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
      return undefined;
    },
    onEvent: (f) => (evs.add(f), () => evs.delete(f)),
    onCommand: (f) => (cmds.add(f), () => cmds.delete(f)),
    onNotice: (f) => (notices.add(f), () => notices.delete(f)),
    command: (action) => { for (const f of [...cmds]) f({ action }); },
    reportPanel: () => {},
    preview: async (_p, ref) => { did.previews.push(ref); },
    seek: (t) => did.seeks.push(t),
    reveal: (item, o) => { if (o?.select !== false) { did.selects.push(item); selected = [item]; } did.seeks.push(item); return true; },
    selection: () => selected,
    selectedClip: () => null,
    // renderer-bridge.js's own: the newest Carton part answers
    onBlocked: (f) => (blocked.add(f), () => blocked.delete(f)),
    blocked: () => { for (const f of [...blocked].reverse()) if (f() === true) return true; return false; },
    onBack: (f) => (backs.add(f), () => backs.delete(f)),
    beforeExport: () => { for (const f of [...backs].reverse()) { const r = f("export"); if (r) return Promise.resolve(r); } return null; },
  };
  const side = document.createElement("div"), stage = document.createElement("div");
  stage.setAttribute("data-carton-stage-host", "");
  document.body.append(stage, side);
  const roots = [client.createRoot(stage), client.createRoot(side)];
  await act(async () => {
    roots[0].render(h(U.CartonStage, { projectId: PROJECT, bridge }));
    roots[1].render(h(U.CartonSide, { projectId: PROJECT, bridge }));
    await sleep(30);
  });
  await act(async () => { await sleep(20); });
  const settle = async (ms = 30) => { await act(async () => { await sleep(ms); }); await act(async () => { await sleep(5); }); };
  const cmd = async (action) => { await act(async () => { bridge.command(action); await sleep(30); }); await settle(); };
  const click = async (el) => { await act(async () => { el.dispatchEvent(new window.MouseEvent("click", { bubbles: true, cancelable: true })); await sleep(30); }); await settle(); };
  const frame = () => stage.querySelector(".carton-frame");
  const tab = () => stage.querySelector(".carton-frame-label");
  const toast = () => stage.querySelector(".carton-toast");
  return {
    ui, bridge, did, stage, side, cmd, click, settle, frame, tab, toast,
    // the page's own view model (connect()'s: its view() swaps the editor), as History, a card or Comments call it
    page: () => U.__forTests.conns.get(PROJECT).conn.ui,
    setSelected: (s) => { selected = s; },
    // a version that isn't the newest, confirmed
    older: () => ui.history().all().filter((v) => !v.provisional).at(-3),
    done: async () => { await act(async () => { for (const r of roots) r.unmount(); }); stage.remove(); side.remove(); },
  };
}

test("PLAN 1.1: viewing is a frame round the stage, no banner; its label tab only when History's list isn't on screen", opt, async () => {
  const m = await mount();
  try {
    assert.ok(!m.frame(), "your edit: no frame");
    const v = m.older();
    // History closed (a version viewed from elsewhere): the frame carries the label, the chip's words
    await act(async () => { await m.page().view({ kind: "version", versionId: v.id }); });
    await m.settle();
    assert.ok(m.frame(), "the frame");
    assert.ok(!m.stage.querySelector(".carton-preview-banner"), "no banner over the picture");
    const label = m.ui.viewing().label;
    assert.equal(m.tab()?.querySelector(".carton-frame-text")?.textContent, label[0].toUpperCase() + label.slice(1), "the label tab: the chip's label");
    assert.equal(m.tab().querySelector("button").getAttribute("aria-label"), "Back to my edit (Esc)");
    assert.equal(m.tab().querySelector("button").getAttribute("aria-keyshortcuts"), "Escape");
    // History open: its row says it ("👁 Viewing ✕"), so the frame has nothing else
    await m.cmd("carton-history");
    assert.ok(m.side.querySelector(".carton-version[data-viewing]"), "the row's mark");
    assert.equal(m.side.querySelectorAll(".carton-version[data-viewing] .carton-version-back").length, 1, "with its ✕");
    assert.ok(m.frame(), "the frame stays");
    assert.ok(!m.tab(), "and has no label");
    assert.ok(!m.side.querySelector(".carton-preview-banner, .carton-history-viewing"), "no bar across the panel");
    // a conflict's side, with History open (its pill opens the card, then See it): no row for it, so the frame labels it
    m.ui.setConflicts([{ id: "c1", title: "'Interview B' timing", clip: "Interview B", item: "item-b", canKeepBoth: false, provisional: "mine", mine: { author: m.ui.me(), summary: "starts at 0:18", at: Date.now() - 60_000, what: "move" }, theirs: { author: { key: "agent/claude-code", kind: "agent", name: "Claude Code" }, summary: "starts at 0:20", at: Date.now(), what: "move" } }]);
    await m.settle();
    await m.click(m.stage.querySelector(".carton-stack-pill"));
    assert.equal(m.ui.viewing(), null, "the pill brought your edit back first");
    await m.click([...m.stage.querySelectorAll(".carton-stack button")].filter((b) => /See it/.test(b.textContent))[1]);
    await m.settle(40);
    assert.equal(m.ui.viewing()?.kind, "conflict");
    assert.equal(m.tab()?.querySelector(".carton-frame-text")?.textContent, "Claude Code's move of “Interview B”", "the side's label");
    // its ✕ comes back (the editor swaps back with it)
    await m.click(m.tab().querySelector("button"));
    assert.equal(m.ui.viewing(), null);
    assert.equal(m.did.previews.at(-1), null, "the editor swapped back");
    assert.ok(!m.frame());
    // the return, and the viewing before it, each said once to a screen reader
    assert.equal(m.stage.querySelector(".carton-sr[role=status]").textContent, "Back to your edit");
  } finally { await m.done(); }
});

test("PLAN 1.1: the label rule: History's list marks a version or how it was before one, and a teammate's cut; never a conflict side or a version without a row", opt, () => {
  const L = U.__forTests.listMarks;
  assert.equal(L("history", { kind: "version", versionId: "v1" }), true);
  assert.equal(L("history", { kind: "before", versionId: "v1" }), true);
  assert.equal(L("history", { kind: "cut", cutId: "leo" }), true);
  assert.equal(L("history", { kind: "conflict", conflictId: "c1" }), false);
  assert.equal(L("history", { kind: "version" }), false, "Comments' See it as it was: no row");
  assert.equal(L("comments", { kind: "version", versionId: "v1" }), false, "Comments open: History's list isn't on screen");
  assert.equal(L(null, { kind: "version", versionId: "v1" }), false);
  assert.equal(L("history", null), false);
});

test("PLAN 1.4: an edit tried while viewing: one line and one pulse, Back to my edit, no Restore; nothing when not viewing", opt, async () => {
  const m = await mount();
  try {
    assert.equal(m.bridge.blocked(), false, "your edit: Cardboard's own refusal (an agent's lock) is left to it");
    await act(async () => { await m.page().view({ kind: "version", versionId: m.older().id }); });
    await m.settle();
    let told;
    await act(async () => { told = m.bridge.blocked(); await sleep(10); });
    assert.equal(told, true, "told here: Cardboard's note stays away");
    const t = m.toast();
    assert.equal(t?.getAttribute("data-tone"), "viewing");
    const label = m.ui.viewing().label.replace(/^Your\b/, "your");
    assert.equal(t.querySelector(".carton-toast-text").textContent, `You're looking at ${label}.`);
    assert.deepEqual([...t.querySelectorAll("button")].map((b) => b.textContent), ["Back to my edit"], "one button, no Restore");
    assert.equal(t.querySelector(".carton-toast-key").textContent, "Esc");
    assert.equal(m.frame().getAttribute("data-pulse"), "a", "the frame pulses");
    // a drag refused at every move: one pulse, the same line
    await act(async () => { for (let i = 0; i < 20; i++) m.bridge.blocked(); await sleep(10); });
    assert.equal(m.frame().getAttribute("data-pulse"), "a", "not again within the moment");
    await m.click(t.querySelector("button"));
    assert.equal(m.ui.viewing(), null, "Back to my edit");
    assert.equal(m.did.previews.at(-1), null);
    assert.ok(!m.toast(), "the line goes with viewing");
    assert.equal(m.bridge.blocked(), false, "your edit again");
  } finally { await m.done(); }
});

test("PLAN 1.6: Export while viewing comes back to your edit first, says so, and then opens; nothing viewed, at once", opt, async () => {
  const m = await mount();
  try {
    assert.equal(m.bridge.beforeExport(), null, "nothing viewed: Export opens at once");
    await act(async () => { await m.page().view({ kind: "version", versionId: m.older().id }); });
    await m.settle();
    let p;
    await act(async () => { p = m.bridge.beforeExport(); await p; await sleep(20); });
    assert.ok(p, "Export waits for your edit");
    await m.settle();
    assert.equal(m.ui.viewing(), null, "your edit");
    assert.equal(m.did.previews.at(-1), null, "the editor shows it (the cut's newest version), so that is what Export exports");
    assert.equal(m.toast()?.querySelector(".carton-toast-text")?.textContent, "Back to your edit to export it.");
    assert.equal(m.bridge.beforeExport(), null, "asked again: nothing viewed");
  } finally { await m.done(); }
});

test("PLAN 1.5: the timeline's marks: viewing while viewing; a cut other than Main by its name and dot; nothing else", opt, async () => {
  const m = await mount();
  try {
    const mark = () => m.did.marks.at(-1);
    assert.deepEqual(mark(), { projectId: m.bridge.projectId, viewing: false, cut: null, dot: null }, "Main cut, your edit");
    await act(async () => { await m.page().view({ kind: "version", versionId: m.older().id }); });
    await m.settle();
    assert.equal(mark().viewing, true);
    const n = m.did.marks.length;
    await act(async () => { m.ui.addVersion({ summary: "Trimmed 'Intro'" }); await sleep(20); });
    await m.settle();
    assert.equal(m.did.marks.length, n, "a new version changes nothing on the timeline");
    await act(async () => { await m.page().view(null); });
    await m.settle();
    await act(async () => { await m.ui.switchCut("cut-ig"); });
    await m.settle();
    assert.equal(mark().viewing, false);
    assert.equal(typeof mark().cut, "string");
    assert.match(mark().dot, /^#[0-9a-f]{3,8}$/i);
    const css = document.getElementById("carton-timeline-css")?.textContent ?? "";
    assert.match(css, /\[data-analytics-region="editor-timeline"\]\[data-carton-viewing\]>\*::after\{[^}]*box-shadow:inset 0 0 0 2px/, "the timeline's frame");
    assert.match(css, /\[data-analytics-region="editor-timeline"\]\[data-carton-cut\][^{]*::before\{content:var\(--carton-cut-label\)/, "the cut's label");
    assert.ok(css.split("\n").filter((l) => l.includes("{")).every((l) => l.startsWith('[data-analytics-region="editor-timeline"]')), "every rule on the timeline's region only (the title bar's chip has the same attributes)");
  } finally { await m.done(); }
});

// editor-panel.js's wrapper, run as the editor bundle runs it (its React as `o`, its JSX runtime as `c`): with Carton
// off it is Cardboard's div exactly, whatever was published; on, the marks of this project only.
test("PLAN 1.5: the timeline's wrapper: Cardboard's div with Carton off; the marks with it on, for this project only", opt, async () => {
  const src = require(path.join(ROOT, "scripts", "carton", "editor-panel.js"));
  const AsyncFunction = (async () => {}).constructor;
  const keep = { carton: window.__carton, mark: window.__cartonTimelineMark };
  window.__carton = { on: false, projectId: "p1", ready: Promise.resolve(false) };
  const Timeline = await new AsyncFunction("o", "c", "window", src + "\nreturn __cbCartonTimeline;")(React, jsx, window);
  const el = document.createElement("div");
  document.body.appendChild(el);
  const root = client.createRoot(el);
  const props = { className: "contents", "data-analytics-region": "editor-timeline", children: h("div", { id: "aZ" }) };
  const attrs = () => { const d = el.firstElementChild; return Object.fromEntries([...d.attributes].map((a) => [a.name, a.value])); };
  try {
    await act(async () => { root.render(h(Timeline, props)); });
    await act(async () => { window.__cartonTimelineMark({ projectId: "p1", viewing: true, cut: "30s cut", dot: "#f59e0b" }); });
    assert.deepEqual(attrs(), { class: "contents", "data-analytics-region": "editor-timeline" }, "Carton off: neither attribute");
    window.__carton.on = true;
    await act(async () => { window.__cartonTimelineMark({ projectId: "p1", viewing: true, cut: null, dot: null }); });
    assert.deepEqual(attrs(), { class: "contents", "data-analytics-region": "editor-timeline", "data-carton-viewing": "" });
    await act(async () => { window.__cartonTimelineMark({ projectId: "p1", viewing: false, cut: "30s “Insta” cut", dot: "#22d3ee" }); });
    const a = attrs();
    assert.equal(a["data-carton-cut"], "30s “Insta” cut");
    assert.equal(a["data-carton-viewing"], undefined);
    assert.match(a.style, /--carton-cut-label: "30s “Insta” cut"/);
    assert.match(a.style, /--carton-cut-dot: #22d3ee/);
    await act(async () => { window.__cartonTimelineMark({ projectId: "p2", viewing: true, cut: null, dot: null }); });
    assert.deepEqual(attrs(), { class: "contents", "data-analytics-region": "editor-timeline" }, "another project's marks aren't this one's");
    assert.ok(el.querySelector("#aZ"), "the timeline inside, as given");
  } finally {
    await act(async () => root.unmount());
    el.remove();
    window.__carton = keep.carton;
    window.__cartonTimelineMark = keep.mark;
  }
});

test("PLAN 1.3: closing the panel or switching its tab brings your edit back; a conflict's side stays; Play never selects a clip", opt, async () => {
  const m = await mount();
  const open = () => !!m.side.querySelector(".carton-sidebar");
  try {
    // History closed with its icon while viewing
    await m.cmd("carton-history");
    await act(async () => { await m.page().view({ kind: "version", versionId: m.older().id }); });
    await m.settle();
    await m.cmd("carton-history");
    assert.ok(!open(), "closed");
    assert.equal(m.ui.viewing(), null, "your edit back");
    assert.equal(m.did.previews.at(-1), null, "the editor swapped back");
    // History → Comments while viewing
    await m.cmd("carton-history");
    await act(async () => { await m.page().view({ kind: "version", versionId: m.older().id }); });
    await m.settle();
    await m.click(m.side.querySelector('[role=tab][aria-label="Comments"]'));
    assert.equal(m.ui.viewing(), null, "switching tab too");
    // a viewing Comments showed ("See it as it was": a version without a row) goes when the panel closes (its ✕)
    await act(async () => { await m.page().view({ kind: "version", ref: "main@2", label: "the version this comment was made on" }); });
    await m.settle();
    assert.ok(m.tab(), "Comments open: the frame carries the label");
    await m.click(m.side.querySelector('button[aria-label="Close"]'));
    assert.ok(!open());
    assert.equal(m.ui.viewing(), null, "closing the panel");
    // a conflict's side, seen from its card on the stage, stays when the panel closes
    m.ui.setConflicts([{ id: "c2", title: "'W6' timing", clip: "W6", item: "item-w6", canKeepBoth: false, provisional: "theirs", mine: { author: m.ui.me(), summary: "7 s", at: Date.now() - 1000, what: "move" }, theirs: { author: { key: "agent/claude-code", kind: "agent", name: "Claude Code" }, summary: "9 s", at: Date.now(), what: "move" } }]);
    await m.cmd("carton-history");
    await m.click(m.stage.querySelector(".carton-stack-pill"));
    await m.click([...m.stage.querySelectorAll(".carton-stack button")].filter((b) => /See it/.test(b.textContent))[0]);
    await m.settle(40);
    assert.equal(m.ui.viewing()?.kind, "conflict");
    await m.cmd("carton-history");
    assert.ok(!open());
    assert.equal(m.ui.viewing()?.kind, "conflict", "the side stays");
    await act(async () => { await m.page().view(null); });
    await m.settle();
    m.ui.setConflicts([]);
    // Play on an older version's card: viewing it, and no clip selected (Cardboard's Esc would take the first Esc)
    await m.cmd("carton-history");
    m.setSelected([]);
    const before = m.bridge.selection();
    const rows = [...m.side.querySelectorAll(".carton-version")].filter((r) => !r.hasAttribute("data-now") && !r.hasAttribute("data-provisional") && r.getAttribute("data-kind") !== "start");
    await m.click(rows[1]);
    assert.equal(m.ui.viewing(), null, "a click opens the card, nothing else");
    const play = [...m.side.querySelectorAll(".carton-card-version .carton-btn")].find((b) => /Play all/.test(b.textContent));
    assert.ok(play, "Play all on the card");
    await m.click(play);
    await m.settle(60);
    assert.ok(m.ui.viewing(), "Play on a version that isn't the newest views it");
    assert.deepEqual(m.did.selects, [], "no clip selected");
    assert.ok(m.bridge.selection() === before, "the selection as it was");
  } finally { await m.done(); }
});

// Review of feat/ux-1-viewing #3: Play on an older version, then the panel closed before the version has loaded. The
// return found nothing viewed yet and did nothing; the load then finished and swapped the editor, with the panel gone.
// Now leaving cancels what is still loading: once the panel has closed it never takes the stage. (Workstream 4's Play
// swaps the stage at once, before the worker answers: that swap is marked, below, and taken back by the close.) The
// worker drops a view superseded by a newer one itself (from-carton.ts viewGen); the mock's view is wrapped here to
// load late and do the same.
test("review #3: closing the panel while a Play still loads: the version never takes the stage after", opt, async () => {
  const ui = createMockUi({ versions: 8 });
  const real = ui.view.bind(ui);
  let gen = 0, release = null;
  ui.view = async (t) => {
    const g = ++gen;
    if (t?.kind === "version") await new Promise((r) => (release = r));
    if (g !== gen) return;
    return real(t);
  };
  const m = await mount(ui);
  try {
    await m.cmd("carton-history");
    const rows = [...m.side.querySelectorAll(".carton-version")].filter((r) => !r.hasAttribute("data-now") && !r.hasAttribute("data-provisional") && r.getAttribute("data-kind") !== "start");
    await m.click(rows[1]);
    const play = [...m.side.querySelectorAll(".carton-card-version .carton-btn")].find((b) => /Play all/.test(b.textContent));
    await m.click(play);
    assert.ok(release, "the version is loading");
    assert.equal(m.ui.viewing(), null, "not shown yet");
    // swapped at once (Workstream 4), and marked at once: the frame doesn't wait for the worker's label
    assert.ok(m.did.previews.at(-1), "the stage swapped at once");
    assert.ok(m.frame(), "and the frame with it, before the worker has labelled it");
    assert.equal(m.did.marks.at(-1)?.viewing, true, "the timeline's too");
    await m.cmd("carton-history");
    assert.ok(!m.side.querySelector(".carton-sidebar"), "the panel closed meanwhile");
    assert.equal(m.did.previews.at(-1), null, "your edit back");
    assert.ok(!m.frame(), "unmarked at once");
    const after = m.did.previews.length;
    await act(async () => { release(); await sleep(30); });
    await m.settle(40);
    assert.equal(m.ui.viewing(), null, "nothing viewed");
    assert.deepEqual(m.did.previews.slice(after).filter((r) => r !== null), [], "the late load never swapped the editor again: " + JSON.stringify(m.did.previews));
    assert.ok(!m.frame(), "no frame");
  } finally { await m.done(); }
});

// With Workstream 4's Play and Before (feat/carton-ux @ ed5b9d1c): Play on the cut's newest version plays on your edit,
// so nothing is marked; Before (latched here: a keyboard click; held is the same view) views how it was before, and is
// marked; Play on an older version views it, marked on its row, and its Before keeps the mark on that row. The marks:
// the stage's frame, the row's "Viewing ✕", the timeline's frame, one label in the chip's report.
test("PLAN 1.1, 1.2, 1.5 with WS4: the frame and the row mark for Play on an older version and for Before, never for Play on the newest", opt, async () => {
  const ui = createMockUi({ versions: 8 });
  ui.confirmAll();
  const m = await mount(ui);
  const marked = () => [...m.side.querySelectorAll(".carton-version[data-viewing]")];
  const timeline = () => m.did.marks.at(-1)?.viewing;
  const button = (re) => [...m.side.querySelectorAll(".carton-card-version button")].find((b) => re.test(b.textContent));
  const keyClick = async (el) => { await act(async () => { el.dispatchEvent(new window.MouseEvent("click", { bubbles: true, cancelable: true, detail: 0 })); await sleep(30); }); await m.settle(40); };
  try {
    await m.cmd("carton-history");
    // the newest: Play all plays on your edit
    const newest = m.side.querySelector(".carton-version[data-now]");
    await m.click(newest);
    await m.click(button(/Play all/));
    await m.settle(60);
    assert.equal(m.ui.viewing(), null, "Play on the newest: your edit");
    assert.ok(!m.frame(), "no frame");
    assert.equal(marked().length, 0, "no row mark");
    assert.equal(timeline(), false, "no timeline frame");
    // its Before: how it was before the newest's changes, viewed and marked
    const before = button(/^Before$/);
    assert.ok(before, "Before while it plays");
    await keyClick(before);
    assert.equal(m.ui.viewing()?.kind, "before");
    assert.ok(m.frame(), "Before: the frame");
    assert.ok(!m.tab(), "History's row says it: no label tab");
    assert.equal(marked().length, 1, "the row marked");
    assert.ok(marked()[0].hasAttribute("data-now"), "on the newest's row");
    assert.equal(timeline(), true, "the timeline's frame");
    await keyClick(button(/^Before$/));
    assert.equal(m.ui.viewing(), null, "Before let go: your edit");
    assert.ok(!m.frame());
    assert.equal(marked().length, 0);
    // an older version: Play all views it
    const older = [...m.side.querySelectorAll(".carton-version")].filter((r) => !r.hasAttribute("data-now") && r.getAttribute("data-kind") !== "start")[1];
    const olderId = older.id;
    await m.click(older);
    await m.click(button(/Play all/));
    await m.settle(60);
    assert.equal(m.ui.viewing()?.kind, "version", "Play on an older version views it");
    assert.ok(m.frame(), "the frame");
    assert.deepEqual(marked().map((r) => r.id), [olderId], "its row marked");
    assert.equal(timeline(), true);
    assert.ok(m.did.previews.at(-1), "the editor shows it");
    // and its Before: the mark stays on its row
    await keyClick(button(/^Before$/));
    assert.equal(m.ui.viewing()?.kind, "before");
    assert.ok(m.frame());
    assert.deepEqual(marked().map((r) => r.id), [olderId], "Before of it: the same row");
    await keyClick(button(/^Before$/));
    assert.equal(m.ui.viewing()?.kind, "version", "back to the version played");
    assert.deepEqual(marked().map((r) => r.id), [olderId]);
  } finally { await m.done(); }
});

test("PLAN 1.3, 7.1: a conflict's See it views its side through ui.view, the clip in view and not selected", opt, async () => {
  const m = await mount();
  try {
    m.ui.setConflicts([{ id: "c3", title: "'Interview B' timing", clip: "Interview B", item: "item-b", canKeepBoth: false, provisional: "mine", mine: { author: m.ui.me(), summary: "starts at 0:18", at: Date.now() - 60_000, what: "move" }, theirs: { author: { key: "agent/claude-code", kind: "agent", name: "Claude Code" }, summary: "starts at 0:20", at: Date.now(), what: "move" } }]);
    await m.settle(40);
    const see = [...m.stage.querySelectorAll(".carton-stack button")].filter((b) => /See it/.test(b.textContent));
    assert.equal(see.length, 2, "See it on each side");
    await m.click(see[1]);
    await m.settle(60);
    assert.equal(m.ui.viewing()?.kind, "conflict", "viewing the side (kind conflict)");
    assert.equal(m.ui.viewing().side, "theirs");
    assert.ok(m.did.previews.at(-1), "the editor shows it");
    assert.deepEqual(m.did.seeks.at(-1), "item-b", "its clip in view");
    assert.deepEqual(m.did.selects, [], "not selected: viewing's Esc stays the first");
    assert.equal(m.tab()?.querySelector(".carton-frame-text")?.textContent, "Claude Code's move of “Interview B”");
  } finally { await m.done(); }
});

// Design QA G1: the marks follow what the stage shows, never what it was asked. A version that can't be shown takes
// everything back to your edit (the view model's viewing too), and Play says so in its card; one slow to come is
// "Loading …" in the chip after 300 ms, with no frame and no row mark until it is on screen.
test("design QA G1: a version the editor can't show: back to your edit, no mark anywhere, Play's error in its card", opt, async () => {
  const ui = createMockUi({ versions: 8 });
  ui.confirmAll();
  const m = await mount(ui);
  const reports = [];
  m.bridge.reportPanel = (_panel, _live, extra) => reports.push(extra);
  m.bridge.preview = async (_p, ref) => { m.did.previews.push(ref); if (ref != null) throw new Error("checkout failed"); };
  try {
    await m.cmd("carton-history");
    const older = [...m.side.querySelectorAll(".carton-version")].filter((r) => !r.hasAttribute("data-now") && r.getAttribute("data-kind") !== "start")[1];
    await m.click(older);
    await m.click([...m.side.querySelectorAll(".carton-card-version .carton-btn")].find((b) => /Play all/.test(b.textContent)));
    await m.settle(80);
    assert.ok(m.did.previews.some((r) => r != null), "the editor was asked to show it");
    assert.equal(m.did.previews.at(-1), null, "and then your edit");
    assert.equal(m.ui.viewing(), null, "the view model's viewing went too");
    assert.equal(m.page().stageRef(), null, "the stage: your edit");
    assert.equal(m.page().stageLoading(), null, "nothing loading");
    assert.ok(!m.frame(), "no frame");
    assert.equal(m.did.marks.at(-1)?.viewing, false, "no timeline frame (data-carton-viewing)");
    assert.equal(m.side.querySelectorAll(".carton-version[data-viewing]").length, 0, "no row says Viewing");
    assert.equal(reports.at(-1)?.viewing ?? null, null, "the chip has no viewing part");
    // G20: Play's error is in its card, not at the panel's top
    assert.equal(m.side.querySelector(".carton-card-version .carton-card-error")?.textContent, "Couldn't load this version. Try again.");
    assert.ok(!m.side.querySelector(".carton-history-error"), "nothing at the panel's top");
  } finally { await m.done(); }
});

test("design QA G1: a version slow to come: nothing marked at first, 'Loading …' in the chip after 300 ms, the marks once it shows", opt, async () => {
  const ui = createMockUi({ versions: 8 });
  ui.confirmAll();
  const m = await mount(ui);
  const reports = [];
  m.bridge.reportPanel = (_panel, _live, extra) => reports.push(extra);
  let release = null;
  m.bridge.preview = async (_p, ref) => { m.did.previews.push(ref); if (ref != null) await new Promise((r) => (release = r)); };
  try {
    await m.cmd("carton-history");
    const older = [...m.side.querySelectorAll(".carton-version")].filter((r) => !r.hasAttribute("data-now") && r.getAttribute("data-kind") !== "start")[1];
    const olderId = older.id;
    await m.click(older);
    await m.click([...m.side.querySelectorAll(".carton-card-version .carton-btn")].find((b) => /Play all/.test(b.textContent)));
    await m.settle(60);
    assert.ok(release, "the version is loading");
    assert.ok(m.ui.viewing(), "the view model has labelled it");
    assert.equal(m.page().stageRef(), null, "the stage still shows your edit");
    assert.ok(!m.frame(), "so no frame");
    assert.equal(m.side.querySelectorAll(".carton-version[data-viewing]").length, 0, "no row says Viewing yet");
    assert.equal(reports.at(-1)?.viewing ?? null, null, "under 300 ms: nothing in the chip");
    await m.settle(320);
    const label = m.ui.viewing().label;
    assert.deepEqual(reports.at(-1)?.viewing, { label: "Loading " + label.replace(/^Your\b/, "your"), loading: true }, "past 300 ms: Loading, with the spinner");
    assert.ok(!m.frame(), "still no frame");
    await act(async () => { release(); await sleep(30); });
    await m.settle(40);
    assert.ok(m.page().stageRef(), "on screen now");
    assert.equal(m.page().stageLoading(), null);
    assert.ok(m.frame(), "the frame");
    assert.deepEqual([...m.side.querySelectorAll(".carton-version[data-viewing]")].map((r) => r.id), [olderId], "its row");
    assert.deepEqual(reports.at(-1)?.viewing, { label: label[0].toUpperCase() + label.slice(1) }, "the chip names it");
    // Esc from its open card: stops viewing first, and the card stays (G2); the next Esc closes the card
    const card = m.side.querySelector(".carton-card-version");
    await act(async () => { card.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })); await sleep(30); });
    await m.settle(40);
    assert.equal(m.ui.viewing(), null, "Esc: back to your edit");
    assert.ok(!m.frame());
    assert.ok(m.side.querySelector(".carton-card-version"), "the card stays open");
    await act(async () => { m.side.querySelector(".carton-card-version").dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })); await sleep(30); });
    await m.settle(40);
    assert.ok(!m.side.querySelector(".carton-card-version"), "the next Esc closes the card");
    assert.ok(m.side.querySelector(".carton-sidebar"), "and leaves the panel open");
  } finally { await m.done(); }
});

test("design QA G1: viewAndSwap's last swap failing takes the view back to your edit, unless a newer view was asked", opt, async () => {
  const run = async (latest) => {
    let viewing = null;
    const calls = [];
    const view = async (t) => { calls.push(["view", t?.kind ?? null]); viewing = t ? { ref: "r-old", kind: t.kind } : null; };
    const preview = async (ref) => { calls.push(["preview", ref]); if (ref === "r-old") throw new Error("checkout failed"); };
    await assert.rejects(U.__forTests.viewAndSwap(view, () => viewing, preview, () => latest)({ kind: "version", versionId: "v1" }), /checkout failed/);
    return { calls, viewing };
  };
  const mine = await run(true);
  assert.deepEqual(mine.calls, [["view", "version"], ["preview", "r-old"], ["view", null], ["preview", null]], "back to your edit, then the failure");
  assert.equal(mine.viewing, null);
  const superseded = await run(false);
  assert.deepEqual(superseded.calls, [["view", "version"], ["preview", "r-old"]], "a newer view: left alone");
});

// Review of fix/ux2-a: the marks name what is on screen when loads overlap. #1: a newer version still loading over an
// older one never takes the row's mark (nor the chip's label); #2: a swap from the cache that lands before the view
// model has labelled it never wears the label of the version before it; #3: a Play given up with Esc while it loads
// doesn't start once the load lands.
test("review of fix/ux2-a #1, #2: overlapping loads: the row's mark and the chip's label stay with what is on screen", opt, async () => {
  const ui = createMockUi({ versions: 8 });
  ui.confirmAll();
  const m = await mount(ui);
  const reports = [];
  m.bridge.reportPanel = (_panel, _live, extra) => reports.push(extra);
  const marked = () => [...m.side.querySelectorAll(".carton-version[data-viewing]")].map((r) => r.id);
  try {
    await m.cmd("carton-history");
    // three versions with rows of their own (not the newest, a group's, or the start)
    const all = ui.history().all();
    const own = [...m.side.querySelectorAll(".carton-version")].filter((r) => !r.hasAttribute("data-now") && !r.hasAttribute("data-group") && !r.hasAttribute("data-child") && r.getAttribute("data-kind") !== "start");
    const older = own.map((r) => all.find((v) => v.id === r.id.slice(r.id.indexOf("-") + 1))).filter((v) => v && !v.provisional);
    assert.ok(older.length >= 3, "three rows to view");
    const [a, b] = [older[0], older[1]];
    const rowOf = (v) => own.find((r) => r.id.slice(r.id.indexOf("-") + 1) === v.id)?.id;
    await act(async () => { await m.page().view({ kind: "version", versionId: a.id, ref: a.ref }); });
    await m.settle(40);
    const aLabel = ui.viewing().label;
    assert.deepEqual(marked(), [rowOf(a)], "A on screen, its row marked");
    // #1: B slow to come
    let release = null;
    m.bridge.preview = async (_p, ref) => { m.did.previews.push(ref); if (ref === b.ref) await new Promise((r) => (release = r)); };
    let done = null;
    await act(async () => { done = m.page().view({ kind: "version", versionId: b.id, ref: b.ref }); await sleep(40); });
    await m.settle(40);
    assert.equal(ui.viewing().ref, b.ref, "the view model has moved on to B");
    assert.deepEqual(marked(), [rowOf(a)], "the row's mark stays on A, still on screen");
    assert.deepEqual(reports.at(-1)?.viewing, { label: aLabel[0].toUpperCase() + aLabel.slice(1) }, "the chip names A");
    await act(async () => { release(); await done; });
    await m.settle(40);
    assert.deepEqual(marked(), [rowOf(b)], "B on screen: its row");
    // #2: back to A, the stage swapping from the cache before the view model has labelled it
    let answer = null;
    const real = ui.view.bind(ui);
    ui.view = async (t) => { if (t?.ref === a.ref) await new Promise((r) => (answer = r)); return real(t); };
    m.bridge.preview = async (_p, ref) => { m.did.previews.push(ref); };
    await act(async () => { done = m.page().view({ kind: "version", versionId: a.id, ref: a.ref }); await sleep(40); });
    await m.settle(40);
    assert.equal(m.page().stageRef(), a.ref, "A on screen at once");
    assert.equal(ui.viewing().ref, b.ref, "the view model still says B");
    // (A was labelled before: what was said for that very ref is its name)
    assert.deepEqual(reports.at(-1)?.viewing, { label: aLabel[0].toUpperCase() + aLabel.slice(1) }, "the chip names A, never B");
    assert.deepEqual(marked(), [rowOf(a)], "and A's row");
    await act(async () => { answer(); await done; });
    // a ref never labelled: a neutral label until the view model says, never the one before
    const c = older[2];
    ui.view = async (t) => { if (t?.ref === c.ref) await new Promise((r) => (answer = r)); return real(t); };
    await act(async () => { done = m.page().view({ kind: "version", versionId: c.id, ref: c.ref }); await sleep(40); });
    await m.settle(40);
    assert.equal(m.page().stageRef(), c.ref);
    assert.deepEqual(reports.at(-1)?.viewing, { label: "Another version" }, "not A's label");
    assert.deepEqual(marked(), [rowOf(c)], "the row asked for, on screen");
    await act(async () => { answer(); await done; });
    await m.settle(40);
    const cLabel = ui.viewing().label;
    assert.deepEqual(reports.at(-1)?.viewing, { label: cLabel[0].toUpperCase() + cLabel.slice(1) }, "then its own label");
  } finally { await m.done(); }
});

test("review of fix/ux2-a #3: Esc while Play's version loads: back to your edit, and Play doesn't start when it lands", opt, async () => {
  const ui = createMockUi({ versions: 8 });
  ui.confirmAll();
  const m = await mount(ui);
  let release = null;
  m.bridge.preview = async (_p, ref) => { m.did.previews.push(ref); if (ref != null) await new Promise((r) => (release = r)); };
  try {
    await m.cmd("carton-history");
    const older = [...m.side.querySelectorAll(".carton-version")].filter((r) => !r.hasAttribute("data-now") && r.getAttribute("data-kind") !== "start")[1];
    await m.click(older);
    await m.click([...m.side.querySelectorAll(".carton-card-version .carton-btn")].find((b) => /Play all/.test(b.textContent)));
    await m.settle(40);
    assert.ok(release, "loading");
    const card = m.side.querySelector(".carton-card-version");
    await act(async () => { card.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })); await sleep(30); });
    await m.settle(40);
    assert.equal(m.ui.viewing(), null, "back to your edit");
    await act(async () => { release(); await sleep(30); });
    await m.settle(80);
    assert.equal(m.ui.viewing(), null, "still your edit");
    assert.equal(m.page().stageRef(), null);
    assert.ok(m.side.querySelector(".carton-card-version"), "the card stays");
    assert.equal(m.side.querySelector(".carton-card-version .carton-change[data-playing]"), null, "no change playing");
    assert.ok([...m.side.querySelectorAll(".carton-card-version .carton-btn")].some((b) => /Play all/.test(b.textContent)), "Play all, not Pause");
  } finally { await m.done(); }
});
