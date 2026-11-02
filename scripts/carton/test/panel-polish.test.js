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

let T, React, render;
test.before(async () => {
  if (skip) return;
  const esbuild = require(path.join(CARTON, "node_modules", "esbuild"));
  fs.mkdirSync(OUT, { recursive: true });
  await esbuild.build({
    bundle: true, format: "cjs", logLevel: "warning", absWorkingDir: CARTON, nodePaths: [path.join(CARTON, "node_modules")],
    platform: "browser", target: "chrome140", outfile: path.join(OUT, "carton-ui.cjs"),
    stdin: { contents: 'export * from "./ui.js";\n', resolveDir: path.join(ROOT, "scripts", "carton"), loader: "js" },
    alias: { react: path.join(ROOT, "scripts", "carton", "react-shim.js") },
  });
  globalThis.window = { __cartonReact: require(path.join(CARTON, "node_modules", "react")) };
  T = require(path.join(OUT, "carton-ui.cjs")).__forTests;
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
  const here = chip({ shared: true, status: "up-to-date", pending: 0, peers: [leo(), { actor: null }] });
  assert.match(here, /aria-label="Leo is here\. Open Share"/, "one bad entry skipped, the rest shown");
  assert.match(here, /carton-avatar-initials">L</);
  assert.match(chip({ shared: true, status: "up-to-date", pending: 0, peers: [leo(true)] }), /data-idle=""/);
});
