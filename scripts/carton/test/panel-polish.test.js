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
    cuts: () => [{ id: "main", label: "Main cut", kind: "main", readOnly: false, current: false }, { id: "ig", label: "Client review", kind: "cut", readOnly: false, current: true }],
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
  // the one label for a version (UX redesign 0.9), always with am/pm; DESIGN §6.7's restore toast
  assert.match(T.toasts.value.text, /^Restored Claude Code's edit from (12:41 pm|Nov 2 at 12:41 pm|yesterday at 12:41 pm)\. Later changes are in History\.$/);
  await ui.restore("main@4");
  assert.equal(T.toasts.value.text, "Restored “Sent to client”. Later changes are in History.");
});

test("P2-4: Fold in says what went where, and offers to switch to the cut it went into", opt, async () => {
  const ui = fakeUi();
  T.confirmations(ui);
  const r = await ui.fold("ig", "main", { leaveOut: ["items/w4"], choices: {} });
  assert.deepEqual(r, { ok: true });
  // PLAN 5.3: the Fold dialog's count, when it gives one ("Fold in 3 changes"); the cuts as cutRef() names them
  assert.equal(T.toasts.value.text, "Folded “Client review” into Main cut.");
  await ui.fold("ig", "main", { leaveOut: [], choices: {}, count: 3 });
  assert.equal(T.toasts.value.text, "Folded 3 changes from “Client review” into Main cut.");
  assert.deepEqual(T.toasts.value.actions.map((a) => a.label), ["Switch to Main cut"], "made nothing it says: no Undo");
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

test("P2-4: a conflict card's pick says whose change was kept, as the card named it (docs/carton-ux DESIGN §6.7)", opt, async () => {
  const ui = fakeUi();
  T.confirmations(ui);
  const [plain] = ui.conflicts();
  ui.conflicts = () => [{ ...plain, clip: "W6", mine: { ...plain.mine, what: "move" }, theirs: { ...plain.theirs, what: "move" } }];
  await ui.resolve("c1", "theirs");
  assert.equal(T.toasts.value.text, "Kept Claude Code's move of “W6”.");
  await ui.resolve("c1", "mine");
  assert.equal(T.toasts.value.text, "Kept your move of “W6”.");
  await ui.resolve("c1", "both");
  assert.equal(T.toasts.value.text, "Kept both changes to “W6”.");
  // a host that gives the card no sentences: who, still
  ui.conflicts = () => [plain];
  await ui.resolve("c1", "theirs");
  assert.equal(T.toasts.value.text, "Kept Claude Code's edit.");
  assert.ok(!T.toasts.value.action, "PLAN 5.3: a pick that made nothing (the side shown) has no Undo");
});

// UX redesign PLAN 5.3: the toasts' Undo is the bridge's, Ctrl+Z's path, for exactly what the action made (`made`); the
// toast after it says what was undone, with Redo, and so on. Something on top since: nothing done, and the toast says so.
function stepBridge() {
  const calls = [];
  const answers = { undo: [], redo: [] };
  const step = (which) => async (made) => {
    calls.push([which, made]);
    const a = answers[which].shift();
    return (typeof a === "function" ? a() : a) ?? { status: "confirmed", made: { cut: made.cut, changes: [which + calls.length] } };
  };
  return { calls, answers, undoMade: step("undo"), redoMade: step("redo") };
}
const madeOf = (...changes) => ({ cut: "ig", changes });

test("PLAN 5.3: the restore toast's Undo takes back exactly the restore; then Redo, then Undo again", opt, async () => {
  const ui = fakeUi(), bridge = stepBridge();
  ui.restore = async () => ({ made: madeOf("c-restore") });
  T.confirmations(ui, bridge);
  await ui.restore("main@4");
  assert.equal(T.toasts.value.text, "Restored “Sent to client”. Later changes are in History.");
  assert.deepEqual(T.toasts.value.actions.map((a) => a.label), ["Undo"]);
  bridge.answers.undo.push({ status: "confirmed", told: "undo-restore", made: madeOf("u1") });
  await T.toasts.value.action.run();
  assert.deepEqual(bridge.calls, [["undo", madeOf("c-restore")]], "the bridge's undo, for the restore's own version");
  assert.deepEqual([T.toasts.value.text, T.toasts.value.icon, T.toasts.value.actions.map((a) => a.label)], ["Restore undone.", "undo", ["Redo"]]);
  await T.toasts.value.action.run();
  assert.deepEqual(bridge.calls.at(-1), ["redo", madeOf("u1")], "Redo takes back that undo, by its own version");
  assert.deepEqual([T.toasts.value.text, T.toasts.value.actions.map((a) => a.label)], ["Restore redone.", ["Undo"]]);
  // something landed on top meanwhile: the worker did nothing, and the toast says so
  bridge.answers.undo.push({ status: "moved" });
  await T.toasts.value.action.run();
  assert.deepEqual([T.toasts.value.text, T.toasts.value.tone, T.toasts.value.action], ["Not undone: something changed since. History has every version.", "warning", undefined]);
  // something landed between two of its steps: what was taken back can be put back
  bridge.answers.undo.push({ status: "moved", made: madeOf("u-part") });
  ui.restore = async () => ({ made: madeOf("c1", "c2") });
  T.confirmations(ui, bridge);
  await ui.restore("main@4");
  await T.toasts.value.action.run();
  assert.deepEqual([T.toasts.value.text, T.toasts.value.actions.map((a) => a.label)], ["Only part of it was undone: something changed since. History has every version.", ["Redo"]]);
  await T.toasts.value.action.run();
  assert.deepEqual(bridge.calls.at(-1), ["redo", madeOf("u-part")]);
  // a clash (the conflict stack shows the cards): no toast of its own; the Toast closes this one (nothing took its place)
  ui.restore = async () => ({ made: madeOf("c2") });
  T.confirmations(ui, bridge);
  await ui.restore("main@4");
  const restoredToast = T.toasts.value;
  bridge.answers.undo.push({ status: "conflicts", conflicts: [{}] });
  await restoredToast.action.run();
  assert.equal(T.toasts.value, restoredToast, "nothing shown over it");
  // refused: the bridge says why before it answers (its notice, a warning toast): that warning stays (review of WS5 #2)
  bridge.answers.undo.push(() => { T.tellFailure("Can't undo that: the project would be left empty"); return { status: "refused", error: "Can't undo that: the project would be left empty" }; });
  await restoredToast.action.run();
  assert.deepEqual([T.toasts.value.text, T.toasts.value.tone], ["Can't undo that: the project would be left empty", "warning"]);
  // a restore that made nothing it can name, or a host with no such undo (the gallery): no Undo
  ui.restore = async () => undefined;
  T.confirmations(ui, bridge);
  await ui.restore("main@4");
  assert.equal(T.toasts.value.action, undefined);
  ui.restore = async () => ({ made: madeOf("c3") });
  T.confirmations(ui, {});
  await ui.restore("main@4");
  assert.equal(T.toasts.value.action, undefined, "no bridge undo: no Undo");
});

test("PLAN 5.3: a fold's toast: Undo (all it made), and the cut it went into; Fold in the rest too", opt, async () => {
  const ui = fakeUi(), bridge = stepBridge();
  ui.fold = async () => ({ ok: true, made: madeOf("c-fold", "c-rest") });
  ui.foldRest = async () => ({ ok: true, made: madeOf("c-rest2") });
  ui.history = () => ({ all: () => [{ id: "v9", ref: "main@9", at: Date.now(), author: you, kind: "fold", leftOut: 2 }] });
  T.confirmations(ui, bridge);
  await ui.fold("ig", "main", { leaveOut: [], choices: {}, count: 2 });
  assert.deepEqual([T.toasts.value.text, T.toasts.value.actions.map((a) => a.label)], ["Folded 2 changes from “Client review” into Main cut.", ["Undo", "Switch to Main cut"]]);
  bridge.answers.undo.push({ status: "confirmed", told: "undo-fold", made: madeOf("u2", "u1") });
  await T.toasts.value.action.run();
  assert.deepEqual(bridge.calls, [["undo", madeOf("c-fold", "c-rest")]], "both versions the fold made, in one Undo");
  assert.deepEqual([T.toasts.value.text, T.toasts.value.actions.map((a) => a.label)], ["Fold undone.", ["Redo"]]);
  await ui.foldRest("v9");
  assert.deepEqual([T.toasts.value.text, T.toasts.value.actions.map((a) => a.label)], ["Folded in the rest: 2 changes.", ["Undo"]]);
});

test("PLAN 5.3: a conflict pick's Undo only when the pick made a version; after it, the side that is back", opt, async () => {
  const ui = fakeUi(), bridge = stepBridge();
  const [plain] = ui.conflicts();
  ui.conflicts = () => [{ ...plain, clip: "W6", provisional: "theirs", mine: { ...plain.mine, what: "move" }, theirs: { ...plain.theirs, what: "move" } }];
  ui.resolve = async (id, choice) => (choice === "theirs" ? {} : { made: madeOf("c-pick") });
  T.confirmations(ui, bridge);
  await ui.resolve("c1", "theirs");
  assert.deepEqual([T.toasts.value.text, T.toasts.value.action], ["Kept Claude Code's move of “W6”.", undefined], "the side already shown: nothing to undo");
  await ui.resolve("c1", "mine");
  assert.deepEqual([T.toasts.value.text, T.toasts.value.actions.map((a) => a.label)], ["Kept your move of “W6”.", ["Undo"]]);
  await T.toasts.value.action.run();
  assert.deepEqual(bridge.calls, [["undo", madeOf("c-pick")]]);
  assert.equal(T.toasts.value.text, "Pick undone. Claude Code's move of “W6” is back.");
  await T.toasts.value.action.run();
  assert.equal(T.toasts.value.text, "Pick redone.");
});

test("PLAN 5.3, 5.4: Undo this turn's toast, and its Undo puts the turn back", opt, async () => {
  const ui = fakeUi(), bridge = stepBridge();
  const turn = { id: "t1", ref: "main@7", at: Date.now(), author: claude, kind: "turn", turn: { label: "Tighten the intro and add a lower third", edits: 4 }, changes: 4 };
  ui.history = () => ({ all: () => [turn] });
  // taking a turn out is an undo itself (off the undo stack): redo puts it back (`by`, the view model's)
  ui.undoTurnOf = async () => ({ ok: true, made: { ...madeOf("c-out"), by: "redo" } });
  T.confirmations(ui, bridge);
  await ui.undoTurnOf("t1");
  assert.deepEqual([T.toasts.value.text, T.toasts.value.actions.map((a) => a.label)], ["Took out Claude Code's “Tighten the intro…” (4 changes).", ["Undo"]]);
  await T.toasts.value.action.run();
  assert.deepEqual(bridge.calls.map((c) => c[0]), ["redo"], "its Undo is the editor's redo, for the take-out's own version");
  assert.deepEqual(bridge.calls[0][1].changes, ["c-out"]);
  assert.equal(T.toasts.value.text, "Claude Code's “Tighten the intro…” is back.");
  await T.toasts.value.action.run();
  assert.deepEqual(bridge.calls.map((c) => c[0]), ["redo", "undo"], "and its Redo the editor's undo, for what that redo made");
  assert.equal(T.toasts.value.text, "Took out Claude Code's “Tighten the intro…” again.");
  // it failed: the card says so, no toast
  T.toasts.set(null);
  ui.undoTurnOf = async () => ({ ok: false, error: "This turn is undone already" });
  T.confirmations(ui, bridge);
  await ui.undoTurnOf("t1");
  assert.equal(T.toasts.value, null);
});

test("PLAN 5.2, DESIGN §6.3: a new cut and a switch say where you are now, with the way back", opt, async () => {
  const at = new Date(2026, 10, 2, 12, 20).getTime();
  let current = "main";
  const cut = (id, label, o = {}) => ({ id, label, name: label, kind: id === "main" ? "main" : "cut", readOnly: false, current: current === id, head: id + "@5", ...o });
  const calls = [];
  const ui = {
    history: () => ({ all: () => [{ id: "d1", ref: "main@3", at, author: { key: "agent/director", kind: "agent", name: "Director" }, kind: "turn", turn: { label: "Add captions to the interview", edits: 12 } }] }),
    cuts: () => [cut("main", "Main cut"), cut("ig", "30s Instagram cut"), cut("leo", "Leo's Main cut", { kind: "main", readOnly: true }), ...(calls.some((c) => c[0] === "newCut") ? [cut("new", "30s Instagram cut v2")] : [])],
    conflicts: () => [],
    actor: () => undefined,
    newCut: async (name, from) => { calls.push(["newCut", name, from]); current = "new"; return cut("new", name); },
    switchCut: async (id, o) => { calls.push(["switch", id, o]); if (!o?.onlyFrom || o.onlyFrom === current) current = id; },
  };
  T.confirmations(ui, stepBridge());
  await ui.newCut("30s Instagram cut v2", "main@3");
  assert.equal(T.toasts.value.text, "You're on “30s Instagram cut v2”, made from Director's “Add captions…”. Main cut is unchanged.");
  assert.deepEqual(T.toasts.value.actions.map((a) => a.label), ["Switch back to Main cut"]);
  await T.toasts.value.action.run();
  assert.deepEqual(calls.at(-1), ["switch", "main", undefined]);
  assert.deepEqual([T.toasts.value.text, T.toasts.value.action.label], ["You're on Main cut now.", "Switch back to 30s Instagram cut v2"], "the way back is a switch too");
  // from your edit as it is (the cut's head): no "made from"
  current = "main";
  await ui.newCut("Trailer", "main@5");
  assert.equal(T.toasts.value.text, "You're on “Trailer” now. Main cut is unchanged.");
  // a switch: the cuts menu's
  current = "main";
  await ui.switchCut("ig");
  assert.deepEqual([T.toasts.value.text, T.toasts.value.action.label], ["You're on “30s Instagram cut” now.", "Switch back to Main cut"]);
  // a teammate's cut is viewing, and the way back from it isn't news: no toast
  T.toasts.set(null);
  await ui.switchCut("leo");
  assert.equal(T.toasts.value, null);
  await ui.switchCut("main");
  assert.equal(T.toasts.value, null);
  // a queued switch passes its onlyFrom on; one a switch by hand overtook (the worker didn't switch) says nothing
  await ui.switchCut("ig", { onlyFrom: "elsewhere" });
  assert.deepEqual(calls.at(-1), ["switch", "ig", { onlyFrom: "elsewhere" }]);
  assert.equal(T.toasts.value, null);
  await ui.switchCut("ig", { onlyFrom: "main" });
  assert.equal(T.toasts.value.text, "You're on “30s Instagram cut” now.");
  // a copy of a teammate's cut (PLAN 6.2: New cut from it): yours now, and theirs was only viewed: no way back to offer
  current = "leo";
  await ui.newCut("Leo's copy", "leo@5");
  assert.deepEqual([T.toasts.value.text, T.toasts.value.action], ["You're on “Leo's copy” now.", undefined]);
});

test("PLAN 5.3: Ctrl+Z of a restore or a fold (the bridge's onStep): \"Restore undone.\" with Redo, \"Fold redone.\" with Undo", opt, async () => {
  const bridge = stepBridge();
  T.tellStep(bridge, { which: "undo", told: "undo-restore", made: madeOf("u1") });
  assert.deepEqual([T.toasts.value.text, T.toasts.value.actions.map((a) => a.label)], ["Restore undone.", ["Redo"]]);
  await T.toasts.value.action.run();
  assert.deepEqual(bridge.calls, [["redo", madeOf("u1")]]);
  assert.equal(T.toasts.value.text, "Restore redone.");
  T.tellStep(bridge, { which: "redo", told: "redo-fold", made: madeOf("r1") });
  assert.deepEqual([T.toasts.value.text, T.toasts.value.actions.map((a) => a.label)], ["Fold redone.", ["Undo"]]);
  T.toasts.set(null);
});

test("PLAN 5.3: a hovered toast stays; it goes once the pointer leaves; an action shows it is running", opt, async () => {
  const { Window } = require(path.join(CARTON, "node_modules", "happy-dom"));
  const w = new Window({ url: "http://localhost/" });
  const keep = globalThis.document;
  globalThis.document = w.document;
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  const client = require(path.join(CARTON, "node_modules", "react-dom", "client"));
  const el = w.document.createElement("div");
  w.document.body.appendChild(el);
  const root = client.createRoot(el);
  const was = T.toasts.ms;
  const wait = (ms) => React.act(() => new Promise((r) => setTimeout(r, ms)));
  try {
    T.toasts.ms = 60;
    T.toasts.set(null);
    await React.act(async () => root.render(React.createElement(T.Toast)));
    let release;
    await React.act(async () => T.toasts.show("Restored “Sent to client”. Later changes are in History.", { label: "Undo", run: () => new Promise((r) => (release = r)) }));
    const box = () => el.querySelector(".carton-toast");
    await React.act(async () => box().dispatchEvent(new w.MouseEvent("mouseover", { bubbles: true, relatedTarget: w.document.body })));
    await wait(150);
    assert.ok(box(), "hovered: still there after its time");
    await React.act(async () => box().dispatchEvent(new w.MouseEvent("mouseout", { bubbles: true, relatedTarget: w.document.body })));
    await wait(150);
    assert.equal(box(), null, "left: it goes");
    // an action running holds it, and shows it is busy; the toast goes when it is done and nothing took its place
    await React.act(async () => T.toasts.show("Folded 2 changes from “30s cut” into Main cut.", { label: "Undo", run: () => new Promise((r) => (release = r)) }));
    await React.act(async () => box().querySelector("button").click());
    await wait(150);
    assert.ok(box(), "running: still there");
    assert.equal(box().querySelector("button").getAttribute("aria-busy"), "true");
    await React.act(async () => release());
    await wait(20);
    assert.equal(box(), null, "done, with nothing after it: gone");
    // the keyboard on Undo (Enter): the busy button is disabled, which takes the focus from it (Chromium blurs it); the
    // toast that takes its place gets the keyboard, on its first button, and holds while it has it (review of WS5 #3)
    const realMatches = w.HTMLElement.prototype.matches;
    w.HTMLElement.prototype.matches = function (sel) { return sel === ":focus-visible" ? true : realMatches.call(this, sel); };
    try {
      await React.act(async () => T.toasts.show("Restored “Sent to client”. Later changes are in History.", { label: "Undo", run: () => new Promise((r) => (release = r)).then(() => T.toasts.show("Restore undone.", { label: "Redo", run: () => {} }, null, "undo")) }));
      const undo = box().querySelector("button");
      await React.act(async () => undo.focus());
      await React.act(async () => undo.click());
      await React.act(async () => undo.blur());
      await React.act(async () => release());
      await wait(20);
      const redo = box()?.querySelector("button");
      assert.equal(redo?.textContent, "Redo");
      assert.equal(w.document.activeElement, redo, "the keyboard is on Redo");
      assert.equal(redo.disabled, false);
      await wait(150);
      assert.ok(box(), "and the toast it is in stays");
    } finally {
      w.HTMLElement.prototype.matches = realMatches;
    }
  } finally {
    T.toasts.ms = was;
    T.toasts.set(null);
    await React.act(async () => root.unmount());
    globalThis.document = keep;
    delete globalThis.IS_REACT_ACT_ENVIRONMENT;
    await w.happyDOM.close();
  }
});

// A teammate as Live.view() sends one (sync/live.js peerActor).
const leo = (idle = false) => ({ actor: { key: "human/leo", kind: "human", id: "leo", name: "Leo" }, cut: "main", activity: idle ? null : "Editing", idle });
const chip = (st) => render(React.createElement(T.LiveChipView, { st, onOpen() {} }));

test("N-3 (laptop, merge/prod-2): a save that failed (or an undo refused) has the warning look, not a confirmation's ✓", opt, () => {
  const html = () => render(React.createElement(T.Toast));
  T.tellFailure("Your last change wasn't saved. Do it again, or reopen the project.");
  const failed = html();
  assert.match(failed, /class="carton-toast" data-tone="warning" role="alert" aria-live="assertive"/);
  assert.match(failed, /Your last change wasn&#x27;t saved\. Do it again, or reopen the project\./);
  // the warning icon (its triangle's path), not the check
  assert.match(failed, /M10\.6 4\.5L3 18/);
  // a confirmation keeps its look: a polite status with the ✓
  T.toasts.show("Restored. It's saved as a new version.");
  const ok = html();
  assert.match(ok, /class="carton-toast" role="status" aria-live="polite"/);
  assert.doesNotMatch(ok, /data-tone|M10\.6 4\.5L3 18/);
  T.toasts.set(null);
  // the skin colours it as Carton's other warnings
  const skin = require("fs").readFileSync(path.join(CARTON, "packages", "react", "src", "skin", "cardboard.ts"), "utf8");
  assert.match(skin, /\.carton-toast\[data-tone=warning\] > \.carton-icon\)\{color:var\(--cb-warn\)\}/);
});

test("P2-11: a shared project's status shows over the preview, not only in the Share tab", opt, () => {
  assert.equal(chip({ shared: false }), "", "not shared: nothing");
  assert.equal(chip({ shared: true, status: "up-to-date", pending: 0, peers: [] }), "", "up to date, nobody else: nothing");
  const off = chip({ shared: true, status: "offline", pending: 3, peers: [] });
  assert.match(off, /data-state="offline"/);
  assert.match(off, />Offline · 3 changes not sent yet</, "PLAN 8.3's words");
  // who is here shows in the title bar now (round 2): over the preview only while edits wait
  assert.equal(chip({ shared: true, status: "up-to-date", pending: 0, peers: [leo()] }), "");
  const both = render(React.createElement(T.LiveChipView, { st: { shared: true, status: "up-to-date", pending: 0, peers: [leo(), { actor: null }] }, onOpen() {}, peersToo: true }));
  assert.match(both, /aria-label="Leo is here\. Open Share"/, "one bad entry skipped, the rest shown");
});

test("PLAN 8.3: footage still on its way: a title line, then which clips by name, and that nothing was removed", opt, () => {
  const notice = (waiting, extra = {}) => {
    globalThis.window.__cartonMediaHere = { projectId: "p1", waiting, playable: 1, ...extra };
    try { return render(React.createElement(T.MediaNotice, { projectId: "p1", bridge: { call: async () => ({}) } })); } finally { delete globalThis.window.__cartonMediaHere; }
  };
  const two = notice([{ mediaId: "m1", fileName: "interview-b.mp4" }, { mediaId: "m2", fileName: "broll-03.mp4" }], { from: "Leo" });
  assert.match(two, /<strong class="carton-media-notice-title">2 clips are still on their way from Leo<\/strong>“interview-b\.mp4” and “broll-03\.mp4” show as Offline until they arrive\. Nothing was removed\./);
  assert.match(notice([{ mediaId: "m1", fileName: "a.mov" }]), />1 clip is still on its way from your teammate<\/strong>“a\.mov” shows as Offline until it arrives\. Nothing was removed\./);
  assert.match(notice(["a", "b", "c", "d"].map((n, i) => ({ mediaId: "m" + i, fileName: n + ".mp4" }))), /“a\.mp4”, “b\.mp4” and 2 more show as Offline/);
  // the other states keep their one line
  assert.doesNotMatch(notice([{ mediaId: "m1", fileName: "a.mov" }], { unchecked: true }), /carton-media-notice-title/);
  assert.match(notice([]), /plays from preview copies/);
});

test("P2-11 (title bar): the strip's summary of a shared project: its state, its words, who is here", opt, () => {
  assert.equal(U.liveSummary({ shared: false }), null);
  const mia = { actor: { key: "human/mia", kind: "human", id: "mia", name: "Mia Chen" }, idle: true };
  const s = U.liveSummary({ shared: true, status: "offline", pending: 2, peers: [leo(), mia, { actor: { id: "x" } }] });
  assert.deepEqual([s.state, s.words, s.here, s.more], ["offline", "Offline: 2 changes not sent yet", "Leo, Mia Chen are here", 0]);
  assert.deepEqual(s.people.map((p) => [p.name, p.initials, p.idle, /^#[0-9a-f]{6}$/.test(p.color)]), [["Leo", "L", false, true], ["Mia Chen", "MC", true, true]]);
  assert.equal(U.liveSummary({ shared: true, status: "up-to-date", pending: 0, peers: [] }).state, "ok");
  assert.equal(U.liveSummary({ shared: true, status: "syncing", pending: 1, peers: [] }).state, "syncing");
  const many = U.liveSummary({ shared: true, status: "up-to-date", pending: 0, peers: ["a", "b", "c", "d", "e"].map((n) => ({ actor: { key: "human/" + n, kind: "human", id: n, name: n.toUpperCase() } })) });
  assert.deepEqual([many.people.length, many.more, many.here], [3, 2, "A, B, C and 2 more are here"]);
});

// The title bar's strip (scripts/carton/strip-buttons.js), in its own bundle's scope: `n` the JSX runtime, `c` React,
// `w` joins class names, `I` sends a strip command, `C` the strip's button class.
function strip({ narrow = false, width = narrow ? 1100 : 1522 } = {}) {
  const src = require(path.join(ROOT, "scripts", "carton", "strip-buttons.js"));
  const sent = [];
  // the window's width, as each of the strip's queries asks it ("(max-width: 1180px)", "(max-width: 1000px)")
  const matchMedia = (q) => ({ matches: width <= Number(/max-width:\s*(\d+)px/.exec(q)?.[1] ?? Infinity), addEventListener() {}, removeEventListener() {} });
  const [Strip, Chip] = new Function("n", "c", "w", "I", "C", "matchMedia", src + "\nreturn [__cbCartonStrip, __cbCartonCutChip];")(require(path.join(CARTON, "node_modules", "react", "jsx-runtime")), React, (...a) => a.filter(Boolean).join(" "), (x) => sent.push(x), "btn", matchMedia);
  return { html: (panel) => render(React.createElement(Strip, { panel })), chip: (panel) => render(React.createElement(Chip, { panel })), Chip, sent };
}

test("P2-11, P3-6: the title bar shows the sync dot and who is here; a narrow window keeps History only", opt, () => {
  const live = U.liveSummary({ shared: true, status: "offline", pending: 3, peers: [leo()] });
  const wide = strip().html({ panel: null, live });
  assert.match(wide, /data-carton-strip="history"/);
  assert.match(wide, /aria-label="Share · Offline: 3 changes not sent yet · Leo is here"/);
  assert.match(wide, /data-carton-sync="offline"/);
  assert.match(wide, />L<\/span>/, "Leo's avatar");
  // as before for a project that isn't shared: the panel's name alone, no dot, no avatars
  const plain = strip().html("history");
  assert.match(plain, /aria-pressed="true"[^>]*data-carton-strip="history"|data-carton-strip="history"[^>]*aria-pressed="true"/);
  assert.doesNotMatch(plain, /data-carton-sync|>L</);
  // narrow: History only, with the dot; Share opens from the History panel's head (PLAN 2.3)
  const narrow = strip({ narrow: true }).html({ panel: "history", live });
  assert.doesNotMatch(narrow, /data-carton-strip="share"/);
  assert.match(narrow, /data-carton-sync="offline"/);
  assert.match(narrow, /aria-pressed="true"/, "History shows the panel is open");
  // Share is a dialog (PLAN 8.1): its icon is pressed while the dialog is open, History's isn't
  const sharing = strip().html({ panel: null, live, share: true });
  assert.match(sharing, /aria-pressed="true"[^>]*data-carton-strip="share"/);
  assert.match(sharing, /aria-pressed="false"[^>]*data-carton-strip="history"/);
});

// Carton UX redesign PLAN 2.1, 2.3: the cut chip in the title bar, before Cardboard's own "16:9 ⌄".
test("PLAN 2.1: the cut chip says the cut you're on: scissors for Main, a colour dot for any other, the name whole in its tooltip", opt, () => {
  const s = strip();
  assert.equal(s.chip({ panel: null, live: null }), "", "no cut known yet: no chip");
  assert.equal(s.chip("history"), "", "an older page's report (a bare panel name): no chip");
  const main = s.chip({ panel: null, cut: { name: "Main cut", dot: null }, viewing: null });
  assert.match(main, /data-carton-cut-chip=""/);
  assert.match(main, /data-no-drag="true"/, "the title bar doesn't drag the window from it");
  assert.match(main, /<button type="button" aria-haspopup="menu" aria-label="Cut: Main cut\. Switch cuts" title="Main cut" data-carton-cut="main"/);
  assert.match(main, />Main cut<\/span>/);
  assert.doesNotMatch(main, /data-carton-cut-dot|data-carton-viewing/);
  const other = s.chip({ panel: "history", cut: { name: "30s Instagram cut", dot: "#f59e0b" }, viewing: null });
  assert.match(other, /data-carton-cut="other"/);
  assert.match(other, /data-carton-cut-dot=""[^>]*style="[^"]*background:#f59e0b/);
  // a long name: cut off at 220 px (150 px in a narrow window), whole in the tooltip
  const long = "Client review: the long version with the drone shot and the new music";
  assert.match(s.chip({ cut: { name: long, dot: "#22d3ee" } }), new RegExp(`title="${long}"[\\s\\S]*max-width:220px`));
  assert.match(strip({ narrow: true }).chip({ cut: { name: long, dot: "#22d3ee" } }), /max-width:150px/);
});

test("PLAN 2.1: while viewing, the chip grows its second part, the label and a ✕ back to your edit", opt, () => {
  const s = strip();
  const html = s.chip({ panel: "history", cut: { name: "Main cut", dot: null }, viewing: { label: "Director's “Add captions…”" } });
  assert.match(html, /data-viewing=""/);
  assert.match(html, /data-carton-viewing="" title="Director&#x27;s “Add captions…”"/);
  assert.match(html, /<span class="sr-only">Looking at <\/span>Director&#x27;s “Add captions…”/);
  assert.match(html, /<button type="button" aria-label="Back to my edit \(Esc\)" title="Back to my edit \(Esc\)" aria-keyshortcuts="Escape" data-carton-back=""/);
  assert.doesNotMatch(html, /role="status"|aria-live/, "the editor's page announces viewing, not the title bar too");
});

test("QA G4: the chip is what gives way in a narrow window; below 1000 px while viewing the cut is its mark only, its name in the tooltip", opt, () => {
  const report = (dot) => ({ panel: "history", cut: { name: "Client review: the long version", dot }, viewing: { label: "Director's “Add captions to the interview”" } });
  const spans = (html) => [...html.matchAll(/<span style="([^"]*)">([^<]*)<\/span>/g)].map((m) => [m[2], /max-width:(\d+)px/.exec(m[1])?.[1]]);
  // the chip may shrink; its marks and its ✕ never do
  const wide = strip().chip(report(null));
  assert.match(wide, /data-carton-cut-chip=""[^>]*class="flex min-w-0 shrink items-center overflow-hidden rounded-ui-sm"/);
  assert.match(wide, /data-carton-cut="main"[^>]*class="btn min-w-0 /);
  assert.match(wide, /data-carton-viewing=""[^>]*class="flex h-7 min-w-0 items-center/);
  assert.match(wide, /data-carton-back=""[^>]*class="btn size-\[22px\] shrink-0 /);
  assert.deepEqual(spans(wide), [["Client review: the long version", "220"]]);
  // 1100 px: the name at 120 px beside the label, the label at 100 px
  const narrow = strip({ width: 1100 }).chip(report("#22d3ee"));
  assert.deepEqual(spans(narrow), [["Client review: the long version", "120"]]);
  assert.match(narrow, /<span class="text-ui-sm font-medium" style="[^"]*max-width:100px/);
  // 960 px, viewing: the dot alone (scissors for Main), no name or caret; the name in the tooltip and to screen readers
  for (const dot of ["#22d3ee", null]) {
    const tight = strip({ width: 960 }).chip(report(dot));
    assert.match(tight, /aria-label="Cut: Client review: the long version\. Switch cuts" title="Client review: the long version"[^>]*data-mark-only=""/);
    assert.deepEqual(spans(tight), [], "no name");
    assert.doesNotMatch(tight, /M7 10l5 5 5-5/, "no caret");
    assert.match(tight, dot ? /data-carton-cut-dot=""/ : /M8\.2 7\.4 20 17/, dot ? "the dot" : "the scissors");
    assert.match(tight, /<span class="text-ui-sm font-medium" style="[^"]*max-width:100px[^"]*"><span class="sr-only">Looking at <\/span>Director&#x27;s/, "the label at 100 px");
  }
  // 960 px, not viewing: the name stays (at 150 px)
  const idle = strip({ width: 960 }).chip({ cut: { name: "30s Instagram cut", dot: "#f59e0b" } });
  assert.deepEqual(spans(idle), [["30s Instagram cut", "150"]]);
  assert.doesNotMatch(idle, /data-mark-only/);
});

test("PLAN 2.1, 2.2: the chip's click asks for the cuts menu, its ✕ for your edit", opt, async () => {
  const { Window } = require(path.join(CARTON, "node_modules", "happy-dom"));
  const w = new Window({ url: "http://localhost/" });
  const keep = globalThis.document;
  globalThis.document = w.document;
  const client = require(path.join(CARTON, "node_modules", "react-dom", "client"));
  const el = w.document.createElement("div");
  w.document.body.appendChild(el);
  const root = client.createRoot(el);
  try {
    const s = strip();
    await React.act(async () => root.render(React.createElement(s.Chip, { panel: { cut: { name: "Main cut", dot: null }, viewing: { label: "Leo's Main cut" } } })));
    await React.act(async () => el.querySelector("[data-carton-cut]").click());
    await React.act(async () => el.querySelector("[data-carton-back]").click());
    assert.deepEqual(s.sent, [{ action: "carton-cuts" }, { action: "carton-back" }]);
  } finally {
    await React.act(async () => root.unmount());
    globalThis.document = keep;
    await w.happyDOM.close();
  }
});

test("PLAN 2.1: the chip's part of the report: your cut and what you're viewing, from today's view model or ui.viewing()", opt, () => {
  const cuts = (current, o = {}) => [
    { id: "cut-main", name: "Main cut", label: "Main cut", kind: "main", current: current === "cut-main", readOnly: false, head: "main@9" },
    { id: "cut-ig", name: "30s Instagram cut", label: "30s Instagram cut", kind: "cut", current: current === "cut-ig", readOnly: false, head: "ig@3", ...o },
    { id: "cut-leo", name: "Main cut", label: "Leo's Main cut", kind: "main", current: current === "cut-leo", readOnly: true, head: "leo@2" },
  ];
  const ui = (current, preview = null, extra = {}) => ({ cuts: () => cuts(current, extra.ig), preview: () => preview, calls: [], ...extra });
  assert.equal(T.chipOf({ cuts: () => [], preview: () => null }), null, "no cuts yet: nothing");
  assert.deepEqual(T.chipOf(ui("cut-main")), { cut: { name: "Main cut", dot: null }, viewing: null });
  const ig = T.chipOf(ui("cut-ig"));
  assert.equal(ig.cut.name, "30s Instagram cut");
  assert.match(ig.cut.dot, /^#[0-9a-f]{6}$/);
  assert.equal(T.chipOf(ui("cut-ig")).cut.dot, ig.cut.dot, "a cut keeps its colour");
  assert.equal(T.chipOf(ui("cut-ig", null, { ig: { color: "#123abc" } })).cut.dot, "#123abc", "the view model's own colour first (PLAN 6.1)");
  // a version opened read-only (today's preview): its label, capitalised for the chip
  assert.deepEqual(T.chipOf(ui("cut-main", { ref: "main@3", label: "the version from 2:14 PM (Codex)" })).viewing, { label: "The version from 2:14 PM (Codex)" });
  // a teammate's cut: your Main cut in the chip, theirs viewed
  assert.deepEqual(T.chipOf(ui("cut-leo")), { cut: { name: "Main cut", dot: null }, viewing: { label: "Leo's Main cut" } });
  // the view model's viewing() (PLAN 0.5) first; a preview the model keeps only in preview() still shows (review #1)
  assert.deepEqual(T.chipOf(ui("cut-main", { ref: "x", label: "ignored" }, { viewing: () => ({ ref: "main@3", kind: "version", label: "Director's “Add captions…”", short: "12:20 · Director" }) })).viewing, { label: "Director's “Add captions…”" });
  assert.deepEqual(T.chipOf(ui("cut-main", { ref: "main@3", label: "the version from 12:41 pm" }, { viewing: () => null })).viewing, { label: "The version from 12:41 pm" });
  assert.equal(T.chipOf(ui("cut-main", null, { viewing: () => null })).viewing, null);
  // a teammate's cut switched to (today's cuts menu) is viewing with viewing() too
  assert.deepEqual(T.chipOf(ui("cut-leo", null, { viewing: () => null })), { cut: { name: "Main cut", dot: null }, viewing: { label: "Leo's Main cut" } });
});

test("PLAN 2.1: the chip's ✕ goes back to your edit: the view closed (the editor swapped back with it), or your own cut again", opt, async () => {
  const calls = [];
  const base = (current, preview, o = {}) => ({ cuts: () => [{ id: "cut-main", label: "Main cut", kind: "main", current: current === "cut-main", readOnly: false }, { id: "cut-leo", label: "Leo's Main cut", kind: "main", current: current === "cut-leo", readOnly: true }], preview: () => preview, openPreview: (r) => calls.push(["openPreview", r]), switchCut: async (id) => calls.push(["switchCut", id]), view: (v) => calls.push(["view", v]), ...o });
  await T.backToEdit(base("cut-main", null, { viewing: () => ({ ref: "main@3", kind: "before", label: "Before x", short: "x" }) }));
  await T.backToEdit(base("cut-main", { ref: "main@3", label: "x" }, { viewing: undefined }));
  await T.backToEdit(base("cut-leo", null));
  await T.backToEdit(base("cut-main", null, { viewing: () => null }));
  assert.deepEqual(calls, [["openPreview", null], ["openPreview", null], ["switchCut", "cut-main"]], "through openPreview(null), which connect() wraps with the editor's swap; nothing when there is nothing to go back from");
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
  // PLAN 8.2: one button, Join and open, at the dialog's foot; no separate Open after joining
  assert.match(html, /class="carton-dialog-foot"[\s\S]*>Cancel<[\s\S]*>Join and open</);
  assert.doesNotMatch(html, />Join</, "no bare Join");
  // a name already known: "You'll join as Leo. Change"
  globalThis.localStorage = { getItem: (k) => (k === "carton.name" ? "Leo" : null), setItem() {} };
  const known = render(React.createElement(U.JoinDialog, { bridge: { call: async () => ({}), onEvent: () => () => {} }, onClose() {} }));
  assert.match(known, /You&#x27;ll join as <span class="carton-known-value">Leo<\/span>\. <button type="button" class="carton-link">Change<\/button>/);
  assert.doesNotMatch(known, /Your name/);
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
// library gets the project while the join is answered, before the answer and after it. PLAN 8.2: Join and open is one
// button now, so the dialog must live through the swap until the project is open; then it closes.
for (const when of ["before", "after"])
  test(`final N1, PLAN 8.2: Join and open from an empty library opens the project (it arrives in the library ${when} the answer)`, opt, async () => {
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
      const go = [...body.querySelectorAll("[role=dialog] button")].find((b) => b.textContent === "Join and open");
      assert.ok(go, "one button: Join and open");
      await React.act(async () => { go.click(); await new Promise((r) => setTimeout(r, 20)); });
      await React.act(async () => { await new Promise((r) => setTimeout(r, 20)); });
      assert.ok(el.querySelector('[data-view="grid"]'), "the library shows the joined project: Cardboard swapped the empty view for the grid");
      assert.deepEqual(opened, ["p-fx"], "the joined project opens in its tab, through the swap");
      assert.equal(body.querySelector(".carton-join-dialog"), null, "and the dialog closes");
    } finally {
      if (root) await React.act(async () => root.unmount());
      delete globalThis.IS_REACT_ACT_ENVIRONMENT;
      Object.assign(globalThis, { document: keep.document, localStorage: keep.localStorage, requestAnimationFrame: keep.rAF });
      await w.happyDOM.close();
    }
  });

// PLAN 8.2: a project that joined but couldn't open (its tab couldn't be made) isn't lost: the dialog says it is in the
// library, with Open to try again.
test("PLAN 8.2: joined but not opened: the dialog says it's in the library, and Open tries again", opt, async () => {
  const { Window } = require(path.join(CARTON, "node_modules", "happy-dom"));
  const w = new Window({ url: "http://localhost/" });
  const keep = { document: globalThis.document, localStorage: globalThis.localStorage };
  globalThis.document = w.document;
  globalThis.localStorage = { getItem: (k) => (k === "carton.name" ? "Bea" : null), setItem() {} };
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  let root = null;
  try {
    const client = require(path.join(CARTON, "node_modules", "react-dom", "client"));
    let fail = true;
    const opened = [], closed = [];
    const bridge = { onEvent: () => () => {}, call: async () => ({ projectId: "p-fx", name: "FX ui" }), openProject: async (id) => { if (fail) throw new Error("Error invoking remote method 'tabs:open': Error: no window"); opened.push(id); } };
    const el = w.document.createElement("div");
    w.document.body.appendChild(el);
    root = client.createRoot(el);
    await React.act(async () => { root.render(React.createElement(U.JoinDialog, { bridge, onClose: () => closed.push(1) })); });
    const link = el.querySelector("#carton-join-link");
    await React.act(async () => {
      link.focus();
      Object.getOwnPropertyDescriptor(Object.getPrototypeOf(link), "value").set.call(link, "https://share.example.com/#join=ct1.abc");
      for (const type of ["input", "keyup"]) link.dispatchEvent(new w.Event(type, { bubbles: true }));
    });
    // Enter in the field joins, as the button does
    await React.act(async () => { link.dispatchEvent(new w.KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true })); await new Promise((r) => setTimeout(r, 20)); });
    assert.match(el.textContent, /“FX ui” is in your library now\./);
    assert.match(el.querySelector("[role=alert]")?.textContent ?? "", /Something went wrong|Try again/);
    assert.deepEqual(closed, [], "the dialog stays");
    fail = false;
    const open = [...el.querySelectorAll("button")].find((b) => b.textContent === "Open");
    await React.act(async () => { open.click(); await new Promise((r) => setTimeout(r, 20)); });
    assert.deepEqual([opened, closed], [["p-fx"], [1]], "Open opened it, and the dialog closed");
  } finally {
    if (root) await React.act(async () => root.unmount());
    delete globalThis.IS_REACT_ACT_ENVIRONMENT;
    Object.assign(globalThis, { document: keep.document, localStorage: keep.localStorage });
    await w.happyDOM.close();
  }
});

// Review of feat/ux-2-8 #4, #5: Enter again while Join and open is busy starts no second join; Cancel while it is
// answered leaves the project in the library and opens nothing.
test("PLAN 8.2: one join at a time from every way in, and a Join cancelled meanwhile opens nothing", opt, async () => {
  const { Window } = require(path.join(CARTON, "node_modules", "happy-dom"));
  const w = new Window({ url: "http://localhost/" });
  const keep = { document: globalThis.document, localStorage: globalThis.localStorage };
  globalThis.document = w.document;
  globalThis.localStorage = { getItem: (k) => (k === "carton.name" ? "Bea" : null), setItem() {} };
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  let root = null;
  try {
    const client = require(path.join(CARTON, "node_modules", "react-dom", "client"));
    let answer = null;
    const joins = [], opened = [], closed = [];
    const bridge = { onEvent: () => () => {}, call: (m, a) => { joins.push(a[0].link); return new Promise((r) => { answer = r; }); }, openProject: async (id) => { opened.push(id); } };
    const el = w.document.createElement("div");
    w.document.body.appendChild(el);
    root = client.createRoot(el);
    await React.act(async () => { root.render(React.createElement(U.JoinDialog, { bridge, onClose: () => closed.push(1) })); });
    const link = el.querySelector("#carton-join-link");
    await React.act(async () => {
      link.focus();
      Object.getOwnPropertyDescriptor(Object.getPrototypeOf(link), "value").set.call(link, "https://share.example.com/#join=ct1.abc");
      for (const type of ["input", "keyup"]) link.dispatchEvent(new w.Event(type, { bubbles: true }));
    });
    const enter = () => React.act(async () => { link.dispatchEvent(new w.KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true })); await new Promise((r) => setTimeout(r, 5)); });
    await enter();
    await enter();
    const go = [...el.querySelectorAll("button")].find((b) => /Join and open|Joining/.test(b.textContent));
    await React.act(async () => { go.click(); link.closest("form").dispatchEvent(new w.Event("submit", { bubbles: true, cancelable: true })); await new Promise((r) => setTimeout(r, 5)); });
    assert.equal(joins.length, 1, "Enter, Enter, the button and the form: one join");
    // Cancel while it is answered
    const cancel = [...el.querySelectorAll("button")].find((b) => b.textContent === "Cancel");
    await React.act(async () => { cancel.click(); });
    await React.act(async () => { answer({ projectId: "p-fx", name: "FX ui" }); await new Promise((r) => setTimeout(r, 20)); });
    assert.deepEqual(closed, [1], "the dialog closed");
    assert.deepEqual(opened, [], "and the late answer opened nothing");
  } finally {
    if (root) await React.act(async () => root.unmount());
    delete globalThis.IS_REACT_ACT_ENVIRONMENT;
    Object.assign(globalThis, { document: keep.document, localStorage: keep.localStorage });
    await w.happyDOM.close();
  }
});

// Regress prod3 P3-E: joining from an empty library, the page jumped back to the Dashboard's top as the join landed
// (Home swaps the empty view for the grid, and its scroller lost its place while the grid measured itself): the
// sidebar's Projects lit Dashboard, and after Done the new tile was below the fold. Here Home's scroller is scrolled
// down to the projects, and the grid, as it mounts, throws the scroller back to the top as Cardboard's did. The page
// keeps its place, then shows the new tile; a person who scrolls meanwhile, or goes elsewhere (the sidebar's Dashboard,
// outside the scroller: review of P3-E), keeps their own place. A click in the dialog (Done) isn't going elsewhere.
for (const moves of [null, "scrolls", "sidebar"])
  test(`prod3 P3-E: joining from an empty library keeps the page where it was${moves ? `, unless the person ${moves === "scrolls" ? "scrolls" : "goes to the Dashboard"}` : ", and shows the new tile"}`, opt, async () => {
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
      const bridge = { on: true, ready: Promise.resolve(true), onEvent: () => () => {}, call: async () => { setTimeout(addToLibrary, 0); return { projectId: "p-fx", name: "FX ui" }; }, openProject: () => new Promise((r) => setTimeout(r, 30)) };
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
          React.createElement("nav", null, React.createElement("button", { id: "to-dashboard", onClick: () => scroller.scrollTo({ top: 0 }) }, "Dashboard")),
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
      await React.act(async () => { link.closest("form").dispatchEvent(new w.Event("submit", { bubbles: true, cancelable: true })); await new Promise((r) => setTimeout(r, 10)); });
      assert.ok(el.querySelector('[data-view="grid"]'), "the join landed: the grid replaced the empty view");
      if (moves === "scrolls") {
        // the person scrolls up meanwhile: theirs, not put back
        await React.act(async () => { scroller.dispatchEvent(new w.Event("wheel")); scroller.scrollTop = 120; await new Promise((r) => setTimeout(r, 50)); });
        assert.equal(scroller.scrollTop, 120);
      } else if (moves === "sidebar") {
        // the project opened and the dialog closed (Join and open: PLAN 8.2); then the sidebar's Dashboard, which
        // scrolls Home to its top: Home's, not put back, no tile revealed
        await React.act(async () => { await new Promise((r) => setTimeout(r, 40)); });
        assert.equal(body.querySelector('[role="dialog"]'), null);
        const nav = body.querySelector("#to-dashboard");
        await React.act(async () => { nav.dispatchEvent(new w.Event("pointerdown", { bubbles: true })); nav.click(); await new Promise((r) => setTimeout(r, 1700)); });
        assert.equal(scroller.scrollTop, 0);
        assert.deepEqual(revealed, []);
      } else {
        // a click in the dialog isn't going elsewhere (it is up while the project opens)
        const inDialog = body.querySelector('[role="dialog"]');
        assert.match(inDialog?.textContent ?? "", /“FX ui” is in your library now\./, "with the dialog up while it opens");
        await React.act(async () => { inDialog.dispatchEvent(new w.Event("pointerdown", { bubbles: true })); await new Promise((r) => setTimeout(r, 50)); });
        assert.equal(scroller.scrollTop, 700, "still at the projects, not the Dashboard's top");
        assert.equal(body.querySelector('[role="dialog"]'), null, "the project opened: the dialog closed");
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

// Regress 2026-11-02 P3-3: at the panel's 300 px minimum the three tabs' labels ran under the close ✕ ("Share✕"). Share
// is a dialog now (PLAN 8.1): two tabs, both labelled at every width, as the mockups show them.
test("regress P3-3, PLAN 8.1: the panel's tabs are History and Comments, labelled at 300 px too", opt, async () => {
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
    assert.deepEqual(await tabs(300), [{ name: "History", text: "History" }, { name: "Comments", text: "Comments" }]);
    assert.deepEqual(await tabs(384), [{ name: "History", text: "History" }, { name: "Comments", text: "Comments" }]);
  } finally {
    if (root) await React.act(async () => root.unmount());
    delete globalThis.IS_REACT_ACT_ENVIRONMENT;
    Object.assign(globalThis, { document: keep.document, localStorage: keep.localStorage, requestAnimationFrame: keep.rAF });
    await w.happyDOM.close();
  }
});

// Review of Workstream 4 (#7): Before's flip waited a worker round trip (view() labels the view first) before the
// editor swapped. connect's view() now swaps the stage at once for a target that names its state, and for your edit,
// while the worker labels it; a failure puts the stage back on what viewing() says; a state the worker settled on
// otherwise (a newer view since) is shown.
test("UX 4.3: view() swaps the stage at once for a named state or your edit; a failed load goes back; the worker's state wins", opt, async () => {
  const calls = [];
  let viewing = null, answer = null;
  const view = (t) => new Promise((ok, no) => { calls.push(["view", t ? t.ref ?? t.kind : null]); answer = { ok: () => { viewing = t ? { ref: t.settle ?? t.ref } : null; ok(); }, no }; });
  const preview = (ref) => (calls.push(["preview", ref]), Promise.resolve());
  const v = T.viewAndSwap(view, () => viewing, preview);
  // Before: the stage swaps before the worker answers
  let done = v({ kind: "before", versionId: "v1", ref: "main@7" });
  await Promise.resolve();
  assert.deepEqual(calls, [["preview", "main@7"], ["view", "main@7"]], "swapped first");
  answer.ok();
  await done;
  assert.deepEqual(calls.length, 2, "and once: the worker settled on it");
  // back to your edit: at once too
  calls.length = 0;
  done = v(null);
  await Promise.resolve();
  assert.deepEqual(calls, [["preview", null], ["view", null]]);
  answer.ok();
  await done;
  // the worker can't load it: the stage goes back to what viewing() says (your edit)
  calls.length = 0;
  done = v({ kind: "version", versionId: "v2", ref: "main@3" });
  answer.no(new Error("Couldn't load this version. Try again."));
  await assert.rejects(done);
  assert.deepEqual(calls, [["preview", "main@3"], ["view", "main@3"], ["preview", null]]);
  // the worker settled on another state: that one is shown
  calls.length = 0;
  done = v({ kind: "version", versionId: "v3", ref: "main@4", settle: "main@5" });
  answer.ok();
  await done;
  assert.deepEqual(calls, [["preview", "main@4"], ["view", "main@4"], ["preview", "main@5"]]);
  // a target with no state of its own (a conflict's side): as before, after the worker
  calls.length = 0;
  done = v({ kind: "conflict", conflictId: "c1", side: "theirs", settle: "pin:abc" });
  answer.ok();
  await done;
  assert.deepEqual(calls, [["view", "conflict"], ["preview", "pin:abc"]]);
});
