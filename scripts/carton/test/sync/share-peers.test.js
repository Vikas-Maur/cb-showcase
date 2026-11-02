// The Share panel with a teammate here (UI audit P1-1). The real carton-ui code (scripts/carton/ui.js with sync/ui.js,
// bundled as scripts/carton/build.js bundles carton-ui.js) on React 19's client renderer in a DOM (happy-dom), inside a
// stand-in for Cardboard's own tab boundary ("This tab hit a snag"), fed what the library worker really sends: the
// Share panel's status from Live.view() (scripts/carton/sync/live.js) after a teammate's presence arrives, as the sync
// client delivers it. Before the fix, every teammate entry threw in the panel (actorColor hashed the actor's `key`,
// which the entry didn't have) and nothing below Cardboard's boundary caught it: the whole editor tab was replaced.
//   node --test scripts/carton/test/sync/share-peers.test.js
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs"), os = require("os"), path = require("path");

const ROOT = path.resolve(__dirname, "../../../..");
const CARTON = path.join(ROOT, "carton");
const skip = !fs.existsSync(path.join(CARTON, "node_modules", "esbuild")) && "run `npm ci` in carton/";
// Never /tmp (a small shared tmpfs on the build box).
const OUT = path.join(process.env.CARTON_TEST_DIR ?? path.join(os.homedir(), "gfv-scratch", "carton", "windows-sync"), "share-peers");
const opt = { skip, timeout: 60_000 };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let React, client, act, Live, CartonSide, CartonBoundary, win;
const logged = []; // the pages' activity log (window.__cbLog, patch-renderer.js)
test.before(async () => {
  if (skip) return;
  const esbuild = require(path.join(CARTON, "node_modules", "esbuild"));
  fs.rmSync(OUT, { recursive: true, force: true });
  fs.mkdirSync(OUT, { recursive: true });
  const common = { bundle: true, format: "cjs", logLevel: "warning", absWorkingDir: CARTON, nodePaths: [path.join(CARTON, "node_modules")] };
  // The worker's half: Live, as the library worker runs it.
  await esbuild.build({
    ...common, platform: "node", target: "node24", outfile: path.join(OUT, "live.cjs"),
    stdin: { contents: 'export { Live } from "./sync/live.js";', resolveDir: path.join(ROOT, "scripts", "carton"), loader: "js" },
    banner: { js: 'const __cartonUrl = require("node:url").pathToFileURL(__filename).href;' }, define: { "import.meta.url": "__cartonUrl" },
  });
  // The pages' half: carton-ui.js's own entry (build.js), on the editor's React (react-shim.js: window.__cartonReact).
  await esbuild.build({
    ...common, platform: "browser", target: "chrome140", outfile: path.join(OUT, "carton-ui.cjs"),
    stdin: { contents: 'export * from "./ui.js";\nimport "./sync/ui.js";\n', resolveDir: path.join(ROOT, "scripts", "carton"), loader: "js" },
    alias: { react: path.join(ROOT, "scripts", "carton", "react-shim.js") },
  });
  ({ Live } = require(path.join(OUT, "live.cjs")));

  const { Window } = require(path.join(CARTON, "node_modules", "happy-dom"));
  win = new Window({ url: "http://localhost/", width: 1280, height: 800 });
  for (const k of ["window", "document", "navigator", "localStorage", "Node", "Element", "HTMLElement", "HTMLInputElement", "HTMLButtonElement", "HTMLDivElement", "SVGElement", "Text", "Event", "KeyboardEvent", "MouseEvent", "PointerEvent", "FocusEvent", "InputEvent", "CustomEvent", "MutationObserver", "ResizeObserver", "getComputedStyle", "requestAnimationFrame", "cancelAnimationFrame", "DocumentFragment"])
    Object.defineProperty(globalThis, k, { value: win[k], configurable: true, writable: true });
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  React = require(path.join(CARTON, "node_modules", "react"));
  client = require(path.join(CARTON, "node_modules", "react-dom", "client"));
  act = React.act;
  window.__cartonReact = React;
  window.__cbLog = (ev, f) => logged.push({ ev, ...f });
  ({ CartonSide, CartonBoundary } = require(path.join(OUT, "carton-ui.cjs")));
}, { timeout: 300_000 });
test.after(async () => { await win?.happyDOM.close(); });

const h = (...a) => React.createElement(...a);
const PROJECT = "p-share";

// A Live as the worker runs one for a shared project with a View (views.js): the sync client's events in, the Share
// panel's status out.
async function live({ log } = {}) {
  let on = null;
  const events = [];
  const lc = { carton: { cut: "main", on: (f) => ((on = f), () => (on = null)), sync: { state: () => ({ status: "up-to-date", pending: 0, label: "Up to date" }), error: () => null, presence() {} } } };
  const view = { connectSync: async () => {}, materializeSoon() {}, holds: () => true };
  const l = new Live({ api: { emit: (e) => events.push(e) }, bundlePath: "C:\\p.cardboard", projectId: PROJECT, lc, view, log });
  await l.start();
  return { live: l, events, presence: (actor, state, branchId = "main") => on({ type: "presence", branchId, actor, state }) };
}
// What the worker's liveStatus answers (worker.js): the share's config, then Live.view().
const status = (l) => ({ host: "http://127.0.0.1:8791", account: "bob", name: "Bob", role: "editor", ...JSON.parse(JSON.stringify(l.view())) });

// Alice's presence at Bob's, as it arrives (core's carton.ts sends the handle's actor told as the person, R3; the
// worker's livePresence adds `who`; the host relays both as they are).
const ALICE = { kind: "human", id: "alice", name: "Alice", group: "alice-pc/alice", app: true };
const editing = { activity: "Editing", who: { id: "alice", name: "Alice" } };

function bridgeFor(st) {
  const cmds = new Set(), evs = new Set();
  return {
    projectId: PROJECT,
    call: async (method) => (method === "liveStatus" ? structuredClone(st) : method === "liveHostInfo" ? { openCreate: true } : undefined),
    onEvent: (f) => (evs.add(f), () => evs.delete(f)),
    onCommand: (f) => (cmds.add(f), () => cmds.delete(f)),
    command: (ev) => { for (const f of [...cmds]) f(ev); },
    reportPanel() {},
    preview: async () => {},
  };
}

// The editor tab: Cardboard's route boundary around the editor and Carton's side column (editor-panel.js mounts
// CartonSide in the editor's tree). Its fallback is what the audit saw.
let TabBoundary;
const tabBoundary = () => (TabBoundary ??= class extends React.Component {
  constructor(p) { super(p); this.state = { error: null }; }
  static getDerivedStateFromError(error) { return { error }; }
  render() { return this.state.error ? h("p", { id: "snag" }, "This tab hit a snag") : this.props.children; }
});

async function openShare(st) {
  const bridge = bridgeFor(st);
  const container = document.createElement("div");
  document.body.appendChild(container);
  const caught = [];
  const root = client.createRoot(container, { onCaughtError: (e) => caught.push(e), onUncaughtError: (e) => caught.push(e) });
  await act(() => root.render(h(tabBoundary(), null, h("div", null, h("main", { id: "editor" }, "the timeline"), h(CartonSide, { projectId: PROJECT, bridge })))));
  await act(async () => { bridge.command({ action: "carton-share" }); await sleep(20); });
  await act(async () => { await sleep(20); });
  return { container, caught, root, bridge, done: async () => { await act(() => root.unmount()); container.remove(); } };
}

test("Share open with a teammate here, as the worker sends them: the editor stays, and the panel names them", opt, async () => {
  const { live: l, presence } = await live();
  presence(ALICE, editing);
  const st = status(l);
  assert.equal(st.peers.length, 1, "Live shows Alice: " + JSON.stringify(st.peers));
  const m = await openShare(st);
  try {
    assert.ok(!m.container.querySelector("#snag"), "the editor tab hit a snag: " + m.caught.map((e) => e?.message).join("; "));
    assert.ok(!!m.container.querySelector("#editor"), "the editor is still there");
    const share = m.container.querySelector(".carton-share");
    assert.ok(!!share, "the Share panel is open");
    const row = [...share.querySelectorAll("li")].find((li) => li.textContent.includes("Alice"));
    assert.ok(!!row, "Alice is listed: " + share.textContent);
    assert.match(row.textContent, /Editing/);
    assert.match(row.querySelector(".carton-avatar")?.getAttribute("style") ?? "", /--carton-actor:\s*#[0-9a-f]{6}/i, "her avatar has her colour");
    assert.equal(row.querySelector(".carton-avatar-initials")?.textContent, "A");
  } finally { await m.done(); }
});

test("a teammate with no `who` (a replica that sent none): listed by the actor the host relayed", opt, async () => {
  const { live: l, presence } = await live();
  presence({ kind: "human", id: "leo", name: "Leo" }, { activity: "Editing" });
  const m = await openShare(status(l));
  try {
    assert.ok(!m.container.querySelector("#snag"), m.caught.map((e) => e?.message).join("; "));
    assert.match(m.container.querySelector(".carton-share li")?.textContent ?? "", /Leo/);
  } finally { await m.done(); }
});

test("guard, worker: a teammate's malformed presence is skipped (said once, with none of its text) or made safe", opt, async () => {
  const lines = [];
  const { live: l, presence } = await live({ log: (e) => lines.push(e) });
  presence(null, { activity: "Editing" });
  presence({ kind: "human" }, { activity: "Editing", who: { name: "Nobody" } });
  presence({ kind: "human", id: 7 }, { activity: "Editing" });
  presence("alice", { activity: "Editing" });
  // usable id, the rest not text: kept, with words of its own
  presence({ kind: "human", id: "mia", name: { first: "Mia" } }, { activity: { what: "drag" }, who: { id: "mia", name: 42 } });
  presence(ALICE, editing);
  const peers = l.view().peers;
  assert.deepEqual(peers.map((p) => p.actor), [{ key: "human/mia", kind: "human", id: "mia", name: "mia" }, { key: "human/alice", kind: "human", id: "alice", name: "Alice" }]);
  assert.deepEqual(peers.map((p) => p.activity), [null, "Editing"]);
  const skipped = lines.filter((e) => e.type === "presence-skipped");
  assert.equal(skipped.length, 1, "said once: " + JSON.stringify(lines));
  assert.doesNotMatch(JSON.stringify(skipped), /Nobody|Editing|alice/, "never the entry's own text");
  // a leave still removes a teammate
  presence(ALICE, null);
  assert.deepEqual(l.view().peers.map((p) => p.actor.id), ["mia"]);
});

test("a stale leave keeps a teammate: one from a cut they have left for another, as that cut's connection closing says (presence P2)", opt, async () => {
  const { live: l, events, presence } = await live();
  presence(ALICE, editing, "variant");
  presence(ALICE, editing, "main"); // she moved to main
  const published = events.length;
  presence(ALICE, null, "variant"); // the variant's connection closed: everyone it showed is told gone
  assert.deepEqual(l.view().peers.map((p) => [p.actor.id, p.cut]), [["alice", "main"]]);
  assert.equal(events.length, published, "nothing changed, nothing published");
  presence({ kind: "human", id: "nobody" }, null); // a leave for someone never shown
  assert.equal(events.length, published);
  presence(ALICE, null, "main"); // her own leave, on the cut she is on
  assert.deepEqual(l.view().peers, []);
});

test("guard, panel: an entry it can't show is skipped and logged once; the rest are listed and the editor stays", opt, async () => {
  const { live: l, presence } = await live();
  presence(ALICE, editing);
  const good = status(l);
  const bad = [null, {}, { actor: null }, { actor: { id: "x" } }, { actor: { key: 5, id: "y" } }, { actor: { key: "human/z", id: "z", name: { a: 1 } } }, { actor: { key: "human/w", id: "w", name: "W" }, activity: { a: 1 } }];
  logged.length = 0;
  const m = await openShare({ ...good, peers: [...bad, ...good.peers] });
  try {
    assert.ok(!m.container.querySelector("#snag"), m.caught.map((e) => e?.message).join("; "));
    assert.deepEqual([...m.container.querySelectorAll(".carton-share li")].map((li) => li.textContent), ["AAliceEditing"]);
    const skips = logged.filter((e) => /skipped/.test(e.msg ?? ""));
    assert.equal(skips.length, 1, "logged once: " + JSON.stringify(logged));
    assert.doesNotMatch(JSON.stringify(skips), /Alice|"W"|human\/z/, "never an entry's own text");
  } finally { await m.done(); }
  // only "Nobody else is here" when none can be shown
  const m2 = await openShare({ ...good, peers: bad });
  try {
    assert.match(m2.container.querySelector(".carton-share")?.textContent ?? "", /Nobody else is here right now\./);
  } finally { await m2.done(); }
});

test("boundary: any throw in the side panel shows a message in the panel, never takes the editor tab down", opt, async () => {
  const sync = window.__cartonSyncUi;
  let boom = true;
  window.__cartonSyncUi = { ...sync, SharePanel: (p) => { if (boom) throw new TypeError("Cannot read properties of undefined (reading 'length')"); return h(sync.SharePanel, p); } };
  logged.length = 0;
  const { live: l, presence } = await live();
  presence(ALICE, editing);
  const m = await openShare(status(l));
  try {
    assert.ok(!m.container.querySelector("#snag"), "the editor tab hit a snag");
    assert.ok(!!m.container.querySelector("#editor"), "the editor is still there");
    const alert = m.container.querySelector(".carton-sidebar [role=alert]");
    assert.ok(!!alert, "the panel says so: " + m.container.textContent);
    assert.ok(!!m.container.querySelector(".carton-sidebar [role=tablist]"), "its tabs and Close still work");
    const errs = logged.filter((e) => e.ev === "error");
    assert.equal(errs.length, 1, "logged once: " + JSON.stringify(logged));
    assert.equal(errs[0].panel, "share");
    // Try again renders the panel anew
    boom = false;
    const again = [...alert.querySelectorAll("button")].find((b) => /Try again/.test(b.textContent));
    assert.ok(!!again, "Try again");
    await act(async () => { again.click(); await sleep(20); });
    await act(async () => { await sleep(20); });
    assert.ok(!m.container.querySelector(".carton-sidebar [role=alert]"), "the message went");
    assert.match(m.container.querySelector(".carton-share li")?.textContent ?? "", /Alice/);
  } finally { window.__cartonSyncUi = sync; await m.done(); }
});

test("two agents of one teammate (same id, their own agentId) are two rows, each with its own key", opt, async () => {
  const { live: l, presence } = await live();
  presence({ kind: "agent", id: "claude-code", agentId: "a1", name: "Claude Code" }, { activity: "Editing captions" });
  presence({ kind: "agent", id: "claude-code", agentId: "a2", name: "Claude Code" }, { activity: "Trimming" });
  const errors = [];
  const was = console.error;
  console.error = (...a) => { errors.push(a.join(" ")); };
  const m = await openShare(status(l));
  try {
    assert.deepEqual([...m.container.querySelectorAll(".carton-share li")].map((li) => li.textContent), ["CCClaude CodeEditing captions", "CCClaude CodeTrimming"]);
    assert.ok(!errors.some((e) => /same key/.test(e)), "no duplicate React keys: " + errors.join("\n"));
  } finally { console.error = was; await m.done(); }
});

test("boundary, stage layer: a throw over the stage shows a small Try again there, never takes the editor tab down", opt, async () => {
  let boom = true;
  const Bad = () => { if (boom) throw new TypeError("Cannot read properties of undefined (reading 'length')"); return h("p", { id: "banner" }, "the preview banner"); };
  logged.length = 0;
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = client.createRoot(container, { onCaughtError() {}, onUncaughtError() {} });
  try {
    await act(() => root.render(h(tabBoundary(), null, h("main", { id: "editor" }, "the timeline"), h("div", { className: "carton-stage" }, h(CartonBoundary, { panel: "stage" }, h(Bad))))));
    assert.ok(!container.querySelector("#snag"), "the editor tab hit a snag");
    assert.ok(!!container.querySelector("#editor"), "the editor is still there");
    const alert = container.querySelector(".carton-stage-snag[role=alert]");
    assert.ok(!!alert, "the layer says so: " + container.textContent);
    const errs = logged.filter((e) => e.ev === "error");
    assert.deepEqual(errs.map((e) => e.panel), ["stage"]);
    boom = false;
    await act(async () => { alert.querySelector("button").click(); await sleep(20); });
    assert.equal(container.querySelector("#banner")?.textContent, "the preview banner");
  } finally { await act(() => root.unmount()); container.remove(); }
});

test("P2-11: a teammate who is here without input says idle instead of leaving: still listed, faded", opt, async () => {
  const { live: l, presence } = await live();
  presence(ALICE, { activity: null, idle: true, who: { id: "alice", name: "Alice" } });
  const st = status(l);
  assert.deepEqual(st.peers.map((p) => [p.actor.name, p.idle]), [["Alice", true]]);
  const m = await openShare(st);
  try {
    const row = [...m.container.querySelectorAll(".carton-share li")].find((li) => li.textContent.includes("Alice"));
    assert.ok(!!row, "listed: " + m.container.querySelector(".carton-share")?.textContent);
    assert.match(row.getAttribute("style") ?? "", /opacity:\s*0\.55/);
  } finally { await m.done(); }
  presence(ALICE, { activity: "Editing", who: { id: "alice", name: "Alice" } });
  assert.equal(l.view().peers[0].idle, false);
});

test("P3-7: Ctrl+Shift+H opens History and closes it again; other chords and plain H do nothing", opt, async () => {
  const { live: l } = await live();
  const bridge = bridgeFor(status(l));
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = client.createRoot(container);
  await act(() => root.render(h(CartonSide, { projectId: PROJECT, bridge })));
  const press = async (init) => { await act(async () => { window.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init })); await sleep(10); }); };
  await press({ key: "h", code: "KeyH" });
  await press({ key: "H", code: "KeyH", shiftKey: true });
  await press({ key: "h", code: "KeyH", ctrlKey: true });
  assert.equal(container.querySelector(".carton-sidebar"), null, "only the exact chord");
  await press({ key: "H", code: "KeyH", ctrlKey: true, shiftKey: true });
  const tab = container.querySelector(".carton-sidebar [role=tab][aria-selected=true]");
  assert.match(tab?.textContent ?? "", /History/);
  assert.match(tab?.getAttribute("title") ?? "", /^History \((Ctrl\+Shift\+H|⌘⇧H)\)$/);
  await press({ key: "H", code: "KeyH", metaKey: true, shiftKey: true });
  assert.equal(container.querySelector(".carton-sidebar"), null, "the same chord closes it (Cmd on a Mac)");
  await act(() => root.unmount());
  container.remove();
});
