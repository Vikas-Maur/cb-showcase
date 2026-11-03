// The renderer bridge (scripts/carton/renderer-bridge.js) against a stand-in editor store and project host: the save's
// base, adopting a change from elsewhere (an armed save goes first, then head and its base in one step, no undo
// entry), the echo of our own save, undo routed to Carton, a read-only preview, and nothing at all with Carton off.
//   node --test scripts/carton/test/renderer-bridge.test.js
const test = require("node:test");
const assert = require("node:assert/strict");

const load = ({ enabled }) => {
  const window = {};
  new Function("window", require("../renderer-bridge.js"))(window);
  const calls = [], log = [];
  let state = { projectId: "p1", cartonBase: 100, cartonPreview: null, tracks: [], timelineItems: [] };
  let armed = false;
  const answers = {};
  const project = (rev, items) => ({ id: "p1", stateUpdatedAt: rev, tracks: [{ id: "t1" }], timelineItems: items, aspectRatio: "16:9" });
  const disk = { doc: project(200, [{ id: "a", endTime: 4 }]) };
  const store = {
    state: () => state,
    raw: (p) => { log.push(["raw", p]); state = { ...state, ...p }; },
    adopt: (p) => { log.push(["adopt", p]); state = { ...state, ...p }; },
    armed: () => armed,
    flush: async () => { log.push(["flush", armed]); armed = false; },
    invoke: async (channel, { method, args }) => { calls.push([channel, method, ...args]); if (method === "enabled") return enabled; if (method === "head" && !answers.head) return disk.doc; if (method === "checkout" && !answers.checkout) return project(150, [{ id: "old", endTime: 2 }]); if (answers[method]) return answers[method](...args); return { status: "confirmed" }; },
    on: () => () => {},
    deserialize: (d) => d,
    projects: { getState: () => ({ projects: [disk.doc] }), setState: (s) => log.push(["projects", s.projects.length]) },
  };
  const host = {
    fetch: async () => disk.doc,
    deserialize: (d) => d,
    projects: { list: () => [project(100, [])], replace: (l) => log.push(["replace", l[0].stateUpdatedAt]) },
    editor: { adopt: (p) => { log.push(["adopt", p]); state = { ...state, ...p }; } },
  };
  window.__carton.store(store);
  return { c: window.__carton, calls, log, host, disk, project, store, answers, setArmed: (a) => (armed = a), state: () => state, setState: (p) => (state = { ...state, ...p }) };
};

test("off: nothing is attached and nothing is taken", async () => {
  const t = load({ enabled: false });
  assert.equal(await t.c.ready, false);
  assert.equal(t.c.saveMeta({ id: "p1", stateUpdatedAt: 101 }, { ownedFields: ["tracks", "timelineItems"] }), undefined);
  assert.equal(t.c.undo(), false);
  t.c.intent({ kind: "split" });
  // A method the page would answer goes to main, which refuses it while Carton is off.
  t.c.handle("join", () => "page");
  await t.c.call("join", []);
  assert.deepEqual(t.calls.map((c) => c[1]), ["enabled", "join"]);
});

test("a timeline save names the version the editor shows, and carries the recorded remaps once", async () => {
  const t = load({ enabled: true });
  await t.c.ready;
  t.c.intent({ kind: "remap", tracks: ["t1"], at: 4, delta: -2 });
  assert.deepEqual(t.c.saveMeta({ id: "p1", stateUpdatedAt: 101 }, { ownedFields: ["tracks", "timelineItems"] }), { actor: "person", base: 100, intents: [{ kind: "remap", tracks: ["t1"], at: 4, delta: -2 }] });
  // ui-words #3: a save made before the previous one's echo says it holds that save too (after), so the worker makes
  // it on that save, never on base 100, where it clashed with the first save at head (a card of you against you)
  assert.deepEqual(t.c.saveMeta({ id: "p1", stateUpdatedAt: 102 }, { ownedFields: ["tracks", "timelineItems"] }), { actor: "person", base: 100, after: 101, intents: undefined });
  // A media or name save is the person's, with no timeline base.
  assert.deepEqual(t.c.saveMeta({ id: "p1", stateUpdatedAt: 103 }, { ownedMediaIds: ["m"] }), { actor: "person" });
});

test("after: only while the editor's own last save is unanswered; never after its echo or an adopt of head", async () => {
  const t = load({ enabled: true });
  await t.c.ready;
  const scope = { ownedFields: ["tracks", "timelineItems"] };
  t.c.saveMeta({ id: "p1", stateUpdatedAt: 101 }, scope);
  assert.equal(t.c.saveMeta({ id: "p1", stateUpdatedAt: 102 }, scope).after, 101);
  // the latest save's echo: the base is 102, the document is that save: no after
  await t.c.receive(t.host, { id: "p1", stateUpdatedAt: 102, carton: true });
  assert.equal(t.state().cartonBase, 102);
  const m103 = t.c.saveMeta({ id: "p1", stateUpdatedAt: 103 }, scope);
  assert.deepEqual([m103.base, m103.after], [102, undefined]);
  assert.equal(t.c.saveMeta({ id: "p1", stateUpdatedAt: 104 }, scope).after, 103, "made before 103's echo");
  // head adopted (a change from elsewhere): the editor shows head with its base, nothing of its own unanswered
  await t.c.receive(t.host, { id: "p1", stateUpdatedAt: 200, carton: true });
  assert.equal(t.state().cartonBase, 200);
  assert.equal(t.c.saveMeta({ id: "p1", stateUpdatedAt: 201 }, scope).after, undefined);
  // another project's save never chains to this one's
  assert.equal(t.c.saveMeta({ id: "p2", stateUpdatedAt: 202 }, scope).after, undefined);
});

test("our own save's echo only moves the base", async () => {
  const t = load({ enabled: true });
  await t.c.ready;
  t.c.saveMeta({ id: "p1", stateUpdatedAt: 101 }, { ownedFields: ["tracks", "timelineItems"] });
  assert.deepEqual(await t.c.receive(t.host, { id: "p1", stateUpdatedAt: 101, carton: true }), { adopted: false, timeline: undefined });
  // (the person's own edit enables undo and clears redo at once, as the editor's own stacks do)
  assert.deepEqual(t.log, [["raw", { cartonCanUndo: true, cartonCanRedo: false }], ["raw", { cartonBase: 101 }]]);
});

test("a change from elsewhere: the armed save goes first, then head and its base in one adopt, no undo entry", async () => {
  const t = load({ enabled: true });
  await t.c.ready;
  t.setArmed(true);
  const r = await t.c.receive(t.host, { id: "p1", stateUpdatedAt: 200, carton: true });
  assert.deepEqual(r, { adopted: false, timeline: undefined });
  assert.deepEqual(t.log.map((l) => l[0]), ["flush", "replace", "adopt"]);
  assert.deepEqual(t.log[2][1], { tracks: [{ id: "t1" }], timelineItems: [{ id: "a", endTime: 4 }], aspectRatio: "16:9", duration: 4, cartonBase: 200 });
  // Older than the base: ignored. Another project, or a removal: Cardboard's own path.
  assert.deepEqual(await t.c.receive(t.host, { id: "p1", stateUpdatedAt: 150, carton: true }), { adopted: false, timeline: undefined });
  assert.equal(await t.c.receive(t.host, { id: "p2", stateUpdatedAt: 300, carton: true }), null);
  assert.equal(await t.c.receive(t.host, { id: "p1", removed: true, carton: true }), null);
});

test("undo and redo go to Carton after the pending save", async () => {
  const t = load({ enabled: true });
  await t.c.ready;
  assert.equal(t.c.undo(), true);
  assert.equal(t.c.redo(), true);
  await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(t.calls.slice(1), [["carton:call", "undo", { projectId: "p1" }], ["carton:call", "redo", { projectId: "p1" }]]);
});

test("H6 (laptop bugs 3, 4): the session's start goes with each step; the project in the answer is adopted at once and the buttons follow what is left", async () => {
  const t = load({ enabled: true });
  await t.c.ready;
  t.setState({ cartonSince: 1234 });
  t.answers.redo = () => ({ status: "confirmed", project: t.project(300, [{ id: "b", endTime: 6 }]), can: { undo: true, redo: false } });
  assert.equal(t.c.redo(), true);
  await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(t.calls.at(-1), ["carton:call", "redo", { projectId: "p1", since: 1234 }]);
  assert.deepEqual(t.state().timelineItems, [{ id: "b", endTime: 6 }], "adopted from the answer, no fetch");
  assert.equal(t.state().cartonBase, 300);
  assert.deepEqual([t.state().cartonCanUndo, t.state().cartonCanRedo], [true, false], "the buttons say what is left");
  // its change event, arriving after: already shown, only the base would move
  assert.deepEqual(await t.c.receive(t.host, { id: "p1", stateUpdatedAt: 300, carton: true }), { adopted: false, timeline: undefined });
  assert.ok(!t.log.some((l) => l[0] === "replace"), "the project wasn't fetched again");
});

// UX redesign PLAN 5.3: a toast's Undo is Ctrl+Z's own path (the pending save first, the session, the project adopted,
// the buttons) for exactly what one action made; the worker answers "moved" when that isn't on top any more, and
// Cardboard's own undo never runs for it. Ctrl+Z of a restore or a fold tells the page, with the step's own versions.
test("PLAN 5.3: a toast's Undo and Redo: Ctrl+Z's path, for exactly what one action made", async () => {
  const t = load({ enabled: true });
  await t.c.ready;
  t.setState({ cartonSince: 1234 });
  t.setArmed(true);
  const made = { cut: "main", changes: ["c-restore"] };
  t.answers.undo = () => ({ status: "confirmed", id: "u1", project: t.project(300, [{ id: "b", endTime: 6 }]), can: { undo: true, redo: true }, made: { cut: "main", changes: ["u1"] }, told: "undo-restore" });
  const r = await t.c.undoMade(made);
  assert.equal(t.log[0][0], "flush", "the waiting save goes first");
  assert.deepEqual(t.calls.at(-1), ["carton:call", "undo", { projectId: "p1", since: 1234, only: { cut: "main", changes: ["c-restore"] } }]);
  assert.deepEqual([r.status, r.told, r.made], ["confirmed", "undo-restore", { cut: "main", changes: ["u1"] }], "the worker's answer, for the toast");
  assert.deepEqual(t.state().timelineItems, [{ id: "b", endTime: 6 }], "the project adopted, as Ctrl+Z's is");
  assert.deepEqual([t.state().cartonCanUndo, t.state().cartonCanRedo], [true, true]);
  // Redo: the same, the other way
  t.answers.redo = () => ({ status: "confirmed", id: "r1", can: { undo: true, redo: false } });
  await t.c.redoMade(r.made);
  assert.deepEqual(t.calls.at(-1), ["carton:call", "redo", { projectId: "p1", since: 1234, only: { cut: "main", changes: ["u1"] } }]);
  // something on top since: nothing done, and never Cardboard's own undo
  const own = [];
  t.setState({ undo: () => own.push("undo") });
  t.answers.undo = () => ({ status: "moved", can: { undo: true, redo: false } });
  assert.equal((await t.c.undoMade(made)).status, "moved");
  t.answers.undo = () => ({ status: "unavailable" });
  assert.equal((await t.c.undoMade(made)).status, "unavailable");
  t.answers.undo = () => { throw new Error("worker gone"); };
  await assert.rejects(t.c.undoMade(made), /worker gone/);
  assert.deepEqual(own, [], "Cardboard's undo never ran");
  await assert.rejects(t.c.undoMade(null), /Nothing to undo/);
  await assert.rejects(t.c.undoMade({ cut: "main", changes: [] }), /Nothing to undo/);
  // Ctrl+Z still falls back to Cardboard's own when Carton can't
  assert.equal(t.c.undo(), true);
  await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(own, ["undo"], "Ctrl+Z whose step failed: Cardboard's own undo, as before");
});

test("PLAN 5.3: Ctrl+Z or redo of a restore or a fold tells the page what it was, with the step's own versions", async () => {
  const t = load({ enabled: true });
  await t.c.ready;
  const seen = [];
  const off = t.c.onStep((s) => seen.push(s));
  t.answers.undo = () => ({ status: "confirmed", id: "u1", made: { cut: "main", changes: ["u1"] }, told: "undo-fold" });
  t.c.undo();
  await new Promise((r) => setTimeout(r, 10));
  // a plain edit's undo: nothing to tell (the editor's own undo is seen on the timeline)
  t.answers.undo = () => ({ status: "confirmed", id: "u2", made: { cut: "main", changes: ["u2"] } });
  t.c.undo();
  await new Promise((r) => setTimeout(r, 10));
  // a toast's own Undo is told by the toast, not again here
  t.answers.undo = () => ({ status: "confirmed", id: "u3", made: { cut: "main", changes: ["u3"] }, told: "undo-restore" });
  await t.c.undoMade({ cut: "main", changes: ["x"] });
  assert.deepEqual(seen, [{ which: "undo", told: "undo-fold", made: { cut: "main", changes: ["u1"] } }]);
  off();
  t.answers.redo = () => ({ status: "confirmed", id: "r1", made: { cut: "main", changes: ["r1"] }, told: "redo-fold" });
  t.c.redo();
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(seen.length, 1, "unsubscribed");
});

test("a preview is read-only: changes wait, undo doesn't take it, and Back to my edit takes head", async () => {
  const t = load({ enabled: true });
  await t.c.ready;
  await t.c.preview("p1", "main@3");
  assert.deepEqual(t.state().cartonPreview, { ref: "main@3" });
  assert.deepEqual(t.state().timelineItems, [{ id: "old", endTime: 2 }]);
  assert.equal(t.c.undo(), false);
  assert.deepEqual(await t.c.receive(t.host, { id: "p1", stateUpdatedAt: 200, carton: true }), { adopted: false, timeline: undefined });
  assert.equal(t.c.stale, true);
  assert.deepEqual(t.state().timelineItems, [{ id: "old", endTime: 2 }]);
  await t.c.preview("p1", null);
  assert.equal(t.state().cartonPreview, null);
  assert.equal(t.state().cartonBase, 200);
  assert.deepEqual(t.state().timelineItems, [{ id: "a", endTime: 4 }]);
  assert.equal(t.c.stale, false);
});

// Review of the UX data #3: a version asked for, then "Back to my edit" before its checkout answered: the editor stays
// on your edit; the late answer shows nothing.
test("a preview whose checkout answers after a newer one (back to your edit) shows nothing", async () => {
  const t = load({ enabled: true });
  await t.c.ready;
  let answer;
  t.answers.checkout = () => new Promise((r) => (answer = r));
  const slow = t.c.preview("p1", "main@3");
  await new Promise((r) => setImmediate(r));
  await t.c.preview("p1", null);
  assert.equal(t.state().cartonPreview, null);
  answer(t.project(150, [{ id: "old", endTime: 2 }]));
  await slow;
  assert.equal(t.state().cartonPreview, null, "still your edit");
  assert.deepEqual(t.state().timelineItems, [{ id: "a", endTime: 4 }]);
});

// Final re-check N5: previewing a version shorter than the playhead left it past the version's end (a black stage,
// "0:09 / 0:08"). It goes to the version's end, as Cardboard's own "jump to end" puts it, and Back to my edit puts it
// back where it was, as the editor had it before the preview, unless the person moved it meanwhile. The playhead is
// Cardboard's `playheadTime` while paused (its `currentTime` follows the pointer's hover then: review #1) and its
// playback clock while playing; any move of it the bridge didn't make (a click on the ruler, Play in History, a
// comment's timecode, play) is the person's, even one that ends where the preview put it (review #3).
function cardboardPlayhead(t, { at, hover = null }) {
  const subs = new Set();
  let clock = at;
  const set = (p) => {
    const prev = t.state();
    t.setState(p);
    for (const f of subs) f(t.state(), prev);
  };
  set({ playheadTime: at, currentTime: hover ?? at, isPlaying: false, setPlaybackPosition: (s) => set({ playheadTime: s, currentTime: s }) });
  t.store.subscribe = (f) => (subs.add(f), () => subs.delete(f));
  t.store.clock = () => clock;
  return { set, subs, play: (s) => { clock = s; set({ isPlaying: true }); }, hover: (h) => set({ currentTime: h }) };
}
test("final N5: a preview shorter than the playhead takes it to its end; Back to my edit puts it back", async () => {
  const t = load({ enabled: true });
  await t.c.ready;
  t.disk.doc = t.project(200, [{ id: "a", endTime: 10 }]);
  // the pointer hovers at 1 s: the playhead, at 9.5 s, is what moves
  const p = cardboardPlayhead(t, { at: 9.5, hover: 1 });
  await t.c.preview("p1", "main@3"); // the version ends at 2 s
  assert.equal(t.state().playheadTime, 2, "at the previewed version's end");
  // another, shorter or longer, preview after it: the place to go back to is still the editor's
  t.answers.checkout = () => t.project(150, [{ id: "old", endTime: 1.5 }]);
  await t.c.preview("p1", "main@2");
  assert.equal(t.state().playheadTime, 1.5);
  p.hover(0.3); // hovering is no move
  await t.c.preview("p1", null);
  assert.equal(t.state().playheadTime, 9.5, "back where the editor had it");
  assert.equal(p.subs.size, 0, "and nothing is left listening");
  // moved during the preview, even back to where the preview put it: the person's place stays
  await t.c.preview("p1", "main@2");
  t.c.seek(0.5); // Play in History, a comment's timecode
  t.state().setPlaybackPosition(1.5); // a click on the ruler, at the version's end
  await t.c.preview("p1", null);
  assert.equal(t.state().playheadTime, 1.5, "where the person put it");
  // played during the preview: theirs too
  t.state().setPlaybackPosition(9.5);
  await t.c.preview("p1", "main@2");
  p.play(1.5);
  await t.c.preview("p1", null);
  assert.equal(t.state().playheadTime, 1.5);
  // playing when the preview opens: the playback clock is the playhead
  p.set({ isPlaying: false, playheadTime: 1, currentTime: 1 });
  p.play(9);
  await t.c.preview("p1", "main@2");
  assert.equal(t.state().playheadTime, 1.5, "the clock was past the version's end");
  // another project opened meanwhile: its own place, not this one's
  p.set({ isPlaying: false, playheadTime: 9.5, currentTime: 9.5 });
  await t.c.preview("p1", "main@2");
  await t.c.preview("p2", null);
  assert.equal(t.state().playheadTime, 1.5, "p1's place isn't p2's");
  // a preview long enough for the playhead: it doesn't move, then or after
  p.set({ isPlaying: false });
  t.state().setPlaybackPosition(3);
  await t.c.preview("p1", null);
  let seeks = 0;
  p.subs.add(() => seeks++);
  t.answers.checkout = () => t.project(150, [{ id: "old", endTime: 12 }]);
  await t.c.preview("p1", "main@4");
  await t.c.preview("p1", null);
  assert.equal(t.state().playheadTime, 3);
  assert.equal(seeks, 0, "no seek at all");
  // Carton off: nothing (the bridge's preview isn't reached)
  const off = load({ enabled: false });
  await off.c.ready;
  await off.c.preview("p1", "main@3");
  assert.equal(off.state().cartonPreview, null);
});

// Play and Before (docs/carton-ux PLAN 4.3): holding Before flips the editor between two states at the same moment, so
// neither flip may wait on the worker. Before's side is checked out ahead (prefetch, when playing starts) and kept, as is
// every confirmed version or pin a preview shows; back to current puts the editor's own timeline back at once and only
// then reads head, adopting it if it moved meanwhile and nothing of the person's is unsaved.
test("Play and Before: a version checked out ahead shows without a round trip; back to current is at once, head read after", async () => {
  const t = load({ enabled: true });
  await t.c.ready;
  const mine = [{ id: "mine", endTime: 5 }];
  t.disk.doc = t.project(200, mine);
  t.setState({ cartonBase: 200, tracks: [{ id: "t1" }], timelineItems: mine, aspectRatio: "16:9" });
  const checkouts = () => t.calls.filter((c) => c[1] === "checkout").length;
  const heads = () => t.calls.filter((c) => c[1] === "head").length;
  t.c.prefetch("p1", "main@3");
  assert.equal(checkouts(), 1, "checked out when playing starts");
  await t.c.preview("p1", "main@3");
  assert.equal(checkouts(), 1, "the flip didn't ask the worker again");
  assert.deepEqual(t.state().timelineItems, [{ id: "old", endTime: 2 }]);
  assert.equal(t.c.editLength(), 5, "your edit's length while another version shows");
  // back: the editor's own timeline is there before any answer
  const back = t.c.preview("p1", null);
  assert.equal(t.state().cartonPreview, null);
  assert.equal(t.state().timelineItems, mine, "the same timeline, at once");
  assert.equal(t.state().cartonBase, 200);
  await back;
  assert.equal(heads(), 1, "head is still read");
  assert.equal(t.log.filter((l) => l[0] === "adopt").length, 2, "head hadn't moved: not adopted again");
  // the flip back and forth again: no checkout, no wait
  await t.c.preview("p1", "main@3");
  await t.c.preview("p1", null);
  assert.equal(checkouts(), 1);
});

test("Play and Before: a change during the preview, or head moved meanwhile, still ends on head; a save under way is kept", async () => {
  const t = load({ enabled: true });
  await t.c.ready;
  const mine = [{ id: "mine", endTime: 5 }];
  t.disk.doc = t.project(200, mine);
  t.setState({ cartonBase: 200, tracks: [{ id: "t1" }], timelineItems: mine, aspectRatio: "16:9" });
  // a change came while it showed (stale): back reads head first, as before
  await t.c.preview("p1", "main@3");
  t.disk.doc = t.project(300, [{ id: "theirs", endTime: 6 }]);
  await t.c.receive(t.host, { id: "p1", stateUpdatedAt: 300, carton: true });
  const back = t.c.preview("p1", null);
  assert.deepEqual(t.state().cartonPreview, { ref: "main@3" }, "no fast step after a change");
  await back;
  assert.deepEqual([t.state().cartonBase, t.state().timelineItems], [300, [{ id: "theirs", endTime: 6 }]]);
  // head moved with no event seen (one in flight): the fast step, then head
  t.setState({ cartonBase: 300 });
  await t.c.preview("p1", "main@3");
  t.disk.doc = t.project(400, [{ id: "newer", endTime: 7 }]);
  await t.c.preview("p1", null);
  assert.deepEqual([t.state().cartonBase, t.state().timelineItems], [400, [{ id: "newer", endTime: 7 }]]);
  // the person edited right after the fast step (a save armed when head answers): their edit stays; its save goes
  // first and its echo brings head
  await t.c.preview("p1", "main@3");
  let ran = 0;
  t.answers.head = () => (ran++, t.setArmed(true), t.project(500, [{ id: "other", endTime: 8 }]));
  await t.c.preview("p1", null);
  assert.equal(ran, 1, "the simulated edit ran while head was read");
  assert.deepEqual([t.state().cartonBase, t.state().timelineItems], [400, [{ id: "newer", endTime: 7 }]], "not overwritten under the person");
  // their save went out and was done before head answered (nothing armed or in flight by then): head was read before
  // it, so it isn't adopted over it either; the save's own events bring head
  t.setArmed(false);
  await t.c.preview("p1", "main@3");
  t.answers.head = () => (ran++, t.c.saveMeta({ id: "p1", stateUpdatedAt: 401 }, { ownedFields: ["tracks", "timelineItems"] }), t.project(500, [{ id: "other", endTime: 8 }]));
  await t.c.preview("p1", null);
  assert.equal(ran, 2, "the save ran while head was read");
  assert.deepEqual(t.state().timelineItems, [{ id: "newer", endTime: 7 }], "a save made since the fast step: head not adopted over it");
  // an undo or redo under way for the project: its answer is adopted, not this head
  // (head read before the undo, answered after it: older than what the undo adopted)
  let headDone;
  t.answers.head = () => new Promise((r) => (headDone = r));
  let stepDone;
  t.answers.undo = () => new Promise((r) => (stepDone = r));
  await t.c.preview("p1", "main@3");
  const back2 = t.c.preview("p1", null); // the fast step: back on the editor's own timeline
  assert.equal(t.c.undo(), true); // Ctrl+Z at once, before head answers
  await new Promise((r) => setTimeout(r, 5));
  stepDone({ status: "confirmed", project: t.project(700, [{ id: "undone", endTime: 3 }]) });
  await new Promise((r) => setTimeout(r, 5));
  assert.deepEqual(t.state().timelineItems, [{ id: "undone", endTime: 3 }], "the undo's answer is adopted");
  // head answers only now, older than the undo (review #1): the undo's result stays
  headDone(t.project(600, [{ id: "late", endTime: 9 }]));
  await back2;
  assert.deepEqual([t.state().cartonBase, t.state().timelineItems], [700, [{ id: "undone", endTime: 3 }]], "a late head never replaces the undo");
});

test("Play and Before: only versions that never change are kept, a few at a time; nothing with Carton off", async () => {
  const t = load({ enabled: true });
  await t.c.ready;
  const checkouts = (ref) => t.calls.filter((c) => c[1] === "checkout" && c[2].ref === ref).length;
  // a cut's head moves: never kept
  t.c.prefetch("p1", "cut-main");
  await t.c.preview("p1", "cut-main");
  await t.c.preview("p1", "cut-main");
  assert.equal(checkouts("cut-main"), 2);
  // a pin's header is kept, like a seq
  const pin = "main@57~3f9a1c0e b:3f9a1c0e p:ab by person";
  t.c.prefetch("p1", pin);
  await t.c.preview("p1", pin);
  assert.equal(checkouts(pin), 1);
  // at most four: the oldest goes
  for (const r of ["main@1", "main@2", "main@3", "main@4", "main@5"]) t.c.prefetch("p1", r);
  await t.c.preview("p1", "main@1");
  assert.equal(checkouts("main@1"), 2, "evicted, checked out again");
  await t.c.preview("p1", "main@5");
  assert.equal(checkouts("main@5"), 1, "still kept");
  // another project's version is its own
  t.c.prefetch("p2", "main@5");
  assert.equal(t.calls.filter((c) => c[1] === "checkout" && c[2].projectId === "p2").length, 1);
  // a failed checkout isn't kept
  let fail = true;
  t.answers.checkout = () => { if (fail) { fail = false; throw new Error("gone"); } return t.project(150, []); };
  t.c.prefetch("p1", "main@9");
  await new Promise((r) => setTimeout(r, 0));
  await t.c.preview("p1", "main@9");
  assert.equal(checkouts("main@9"), 2);
  // Carton off: nothing at all
  const off = load({ enabled: false });
  await off.c.ready;
  off.c.prefetch("p1", "main@3");
  assert.equal(off.c.editLength(), undefined);
  assert.deepEqual(off.calls.map((c) => c[1]), ["enabled"]);
});

// Baseline P3-9 (final re-check N3): in a read-only preview the stage's text editor opened (Enter on a selected title,
// a double-click on one) and dropped what was typed. Cardboard's own edits are refused there by its guard (`me()`:
// its refusal over the timeline); the text editor isn't a write, so
// patch-carton.js asks the bridge first. Refused only in a Carton preview, never with Carton off.
test("baseline P3-9: an edit that isn't a write is refused in a preview, with Cardboard's own note; not otherwise", async () => {
  const t = load({ enabled: true });
  await t.c.ready;
  let noted = 0;
  t.store.refuse = () => { noted++; return true; };
  assert.equal(t.c.refuse(), false, "not previewing: the editor's");
  await t.c.preview("p1", "main@3");
  assert.equal(t.c.refuse(), true, "previewing: refused");
  assert.equal(noted, 1, "with Cardboard's own note");
  await t.c.preview("p1", null);
  assert.equal(t.c.refuse(), false);
  const off = load({ enabled: false });
  await off.c.ready;
  off.store.refuse = () => { noted++; return true; };
  off.setState({ cartonPreview: { ref: "main@3" } });
  assert.equal(off.c.refuse(), false, "Carton off: Cardboard's");
  assert.equal(noted, 1);
});

test("the History panel's calls reach main with their arguments as given", async () => {
  const t = load({ enabled: true });
  await t.c.ready;
  await t.c.call("ui", [{ projectId: "p1", client: "c", message: { t: "hello" } }]);
  assert.deepEqual(t.calls.at(-1), ["carton:call", "ui", { projectId: "p1", client: "c", message: { t: "hello" } }]);
});

test("a method the page answers itself (the live-sync half) stays in the page", async () => {
  const t = load({ enabled: true });
  await t.c.ready;
  t.c.handle("join", async (a, b) => ["page", a, b]);
  assert.deepEqual(await t.c.call("join", [1, 2]), ["page", 1, 2]);
  assert.throws(() => t.c.handle("enabled", () => true), /letters only/);
  assert.deepEqual(t.calls.map((c) => c[1]), ["enabled"]);
});

test("an edit made while head is being read is saved first, and only then is head adopted", async () => {
  const t = load({ enabled: true });
  await t.c.ready;
  let reads = 0;
  const fetch = t.host.fetch;
  // The person edits while the first read is in flight.
  t.host.fetch = async (id) => { if (reads++ === 0) t.setArmed(true); return fetch(id); };
  await t.c.receive(t.host, { id: "p1", stateUpdatedAt: 200, carton: true });
  assert.equal(reads, 2);
  assert.deepEqual(t.log.map((l) => l[0]), ["flush", "replace", "adopt"]);
});

test("a save whose write is under way counts as unsaved: head is adopted only after it is done", async () => {
  const t = load({ enabled: true });
  await t.c.ready;
  let inflight = false, reads = 0;
  t.store.inflight = () => inflight;
  const flush = t.store.flush;
  t.store.flush = async () => { inflight = false; return flush(); };
  const fetch = t.host.fetch;
  // The person's save timer fires while head is read: armed no more, but its write is in flight.
  t.host.fetch = async (id) => { if (reads++ === 0) inflight = true; return fetch(id); };
  await t.c.receive(t.host, { id: "p1", stateUpdatedAt: 200, carton: true });
  assert.equal(reads, 2);
  assert.deepEqual(t.log.map((l) => l[0]), ["flush", "replace", "adopt"]);
});

test("See it, Show on timeline: the clip is selected and the playhead goes to its start; nothing with Carton off", async () => {
  const t = load({ enabled: true });
  await t.c.ready;
  const did = [];
  t.store.raw({ timelineItems: [{ id: "clip-a", startTime: 4.5, endTime: 8 }], selectTimelineItem: (id) => did.push(["select", id]), setPlaybackPosition: (s) => did.push(["seek", s]) });
  assert.equal(t.c.projectId, "p1");
  assert.equal(t.c.reveal("clip-a"), true);
  assert.deepEqual(did, [["select", "clip-a"], ["seek", 4.5]]);
  assert.equal(t.c.reveal("gone"), false, "a clip this version doesn't have");
  const off = load({ enabled: false });
  await off.c.ready;
  assert.equal(off.c.reveal("clip-a"), false);
});

// Regress 2026-11-02 #4 (review #1): the preview banner's Esc yields to the editor's own, which clears the clip
// selection without taking the key: it compares the selection before and after, by identity.
test("the editor's clip selection, as its store holds it, for the preview's Esc; nothing with Carton off", async () => {
  const t = load({ enabled: true });
  await t.c.ready;
  const picked = ["clip-a"];
  t.store.raw({ selectedTimelineItemIds: picked });
  assert.equal(t.c.selection(), picked, "the store's own array");
  t.store.raw({ selectedTimelineItemIds: [] });
  assert.notEqual(t.c.selection(), picked, "a deselect is a new value");
  const off = load({ enabled: false });
  await off.c.ready;
  assert.equal(off.c.selection(), null);
});

// History's "Only “clip”" filter (docs/carton-ux PLAN 3.2, 0.8): the one clip selected, by the name the change sentences
// give it: its own name or text, else its media's file name; nothing for none, several, or Carton off.
test("the one clip selected, by its name, for History's Only “clip”; nothing for none or several, or with Carton off", async () => {
  const t = load({ enabled: true });
  await t.c.ready;
  t.store.projects.getState = () => ({ projects: [{ id: "p1", media: [{ id: "m1", data: { fileName: "interview-b.mp4" } }] }] });
  t.store.raw({ timelineItems: [{ id: "a", name: "  Interview   B " }, { id: "b", mediaItemId: "m1" }, { id: "c", textContent: "Summer launch" }, { id: "d", type: "video" }] });
  assert.equal(t.c.selectedClip(), null, "nothing selected");
  for (const [id, name] of [["a", "Interview B"], ["b", "interview-b.mp4"], ["c", "Summer launch"], ["d", "video"]]) {
    t.store.raw({ selectedTimelineItemIds: [id] });
    assert.deepEqual(t.c.selectedClip(), { id, name });
  }
  t.store.raw({ selectedTimelineItemIds: ["a", "b"] });
  assert.equal(t.c.selectedClip(), null, "several selected");
  t.store.raw({ selectedTimelineItemIds: ["gone"] });
  assert.equal(t.c.selectedClip(), null, "a clip this version doesn't have");
  const off = load({ enabled: false });
  await off.c.ready;
  off.store.raw({ selectedTimelineItemIds: ["a"], timelineItems: [{ id: "a", name: "A" }] });
  assert.equal(off.c.selectedClip(), null);
});

test("the title bar's icons: the page hears carton:command and reports the panel open to main; nothing with Carton off", async () => {
  const t = load({ enabled: true });
  await t.c.ready;
  const heard = [], sent = [];
  t.store.on = (channel) => { heard.push(channel); return () => {}; };
  t.store.invoke = async (channel, payload) => { sent.push([channel, payload]); };
  t.c.onCommand(() => {});
  t.c.reportPanel("history");
  t.c.reportPanel(null);
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(heard, ["carton:command"]);
  assert.deepEqual(sent, [["carton:panel", { panel: "history" }], ["carton:panel", { panel: null }]]);
  const off = load({ enabled: false });
  await off.c.ready;
  const offSent = [];
  off.store.invoke = async (channel, payload) => { offSent.push([channel, payload]); };
  off.c.reportPanel("history");
  assert.deepEqual(offSent, []);
});

test("Join's Open (UI audit P2-9): the joined project opens in its own tab through main's tabs:open; refused with Carton off", async () => {
  const t = load({ enabled: true });
  await t.c.ready;
  const sent = [];
  t.store.invoke = async (channel, payload) => { sent.push([channel, payload]); return { ok: true }; };
  await t.c.openProject("joined-1");
  assert.deepEqual(sent, [["tabs:open", { projectId: "joined-1", focus: true, source: "home" }]]);
  const off = load({ enabled: false });
  await off.c.ready;
  await assert.rejects(off.c.openProject("joined-1"));
});

test("the panel report carries a shared project's live summary for the title bar (UI audit P2-11); without one, as before", async () => {
  const t = load({ enabled: true });
  await t.c.ready;
  const sent = [];
  t.store.invoke = async (channel, payload) => { sent.push([channel, payload]); };
  const live = { state: "offline", words: "Offline", here: "", people: [], more: 0 };
  t.c.reportPanel("share", live);
  t.c.reportPanel(null);
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(sent, [["carton:panel", { panel: "share", live }], ["carton:panel", { panel: null }]]);
  // Carton UX redesign PLAN 2.1: and the cut chip's part (the cut, what is viewed, Share open)
  sent.length = 0;
  t.c.reportPanel("history", undefined, { share: true, cut: { name: "30s cut", dot: "#f59e0b" }, viewing: { label: "Leo's Main cut" } });
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(sent, [["carton:panel", { panel: "history", share: true, cut: { name: "30s cut", dot: "#f59e0b" }, viewing: { label: "Leo's Main cut" } }]]);
});

test("laptop, final candidate P2-1: a state with no aspect ratio is adopted with Cardboard's default (the layouts panel splits it); a refused undo is said, and Cardboard's own undo doesn't run", async () => {
  const t = load({ enabled: true });
  await t.c.ready;
  const told = [];
  t.c.onNotice((x) => told.push(x));
  let own = 0;
  t.setState({ undo: () => own++, redo: () => own++ });
  // cb undo from a terminal: the change event's head has no aspect ratio
  t.disk.doc = { ...t.project(400, []), tracks: [], aspectRatio: undefined };
  await t.c.receive(t.host, { id: "p1", stateUpdatedAt: 400, carton: true });
  assert.equal(t.state().aspectRatio, "16:9", "as Cardboard's own load gives it");
  // Ctrl+Z whose answer has none either
  t.answers.redo = () => ({ status: "confirmed", project: { ...t.project(401, []), aspectRatio: undefined } });
  t.c.redo();
  await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual([t.state().cartonBase, t.state().aspectRatio], [401, "16:9"]);
  // refused: told in the worker's words, nothing adopted, no fallback
  t.answers.undo = () => ({ status: "refused", error: "Can't undo that: the project would be left empty", can: { undo: true, redo: false } });
  const before = t.state().cartonBase;
  assert.equal(t.c.undo(), true);
  await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(told, ["Can't undo that: the project would be left empty"]);
  assert.equal(t.state().cartonBase, before);
  assert.equal(own, 0, "Cardboard's own undo never ran");
});

test("laptop, final candidate P1-1: a save that fails in the page is told (at most every 20 s, again once a save landed); nothing with Carton off", async () => {
  const t = load({ enabled: true });
  await t.c.ready;
  const told = [];
  t.c.onNotice((x) => told.push(x));
  const err = new RangeError("Invalid time value");
  t.c.saveFailed(err);
  t.c.saveFailed(err);
  assert.deepEqual(told, ["Your last change couldn't be saved. It's on screen, but it isn't in the project yet."], "once, not on every edit");
  // a save lands (its echo): the next failure is told again
  t.c.saveMeta({ id: "p1", stateUpdatedAt: 150 }, { ownedFields: ["tracks", "timelineItems"] });
  await t.c.receive(t.host, { id: "p1", stateUpdatedAt: 150, carton: true });
  t.c.saveFailed(err);
  assert.equal(told.length, 2);
  const off = load({ enabled: false });
  await off.c.ready;
  const none = [];
  off.c.onNotice((x) => none.push(x));
  off.c.saveFailed(err);
  assert.deepEqual(none, []);
});

// H4, one action one save (laptop, merge/prod-2 N-1): the editor's delete of a title saves its timeline (debounced) and, on its own, the
// removal of the title's media entry; adding a title saves its new entry on its own. One action, one save: the entry
// rides with the action's timeline save, in either order. The stand-in runs the patched store's path: Kx/iu ride(),
// the debounce's and flush's board(), updateScoped's send().
const saving = async () => {
  const t = load({ enabled: true });
  await t.c.ready;
  const sent = [];
  let timer = null, n = 0;
  const go = (doc, scope) => () => { sent.push(scope); return Promise.resolve(++n); };
  const send = (doc, scope) => t.c.send(doc, scope, go(doc, scope));
  const timeline = () => send({ id: "p1", stateUpdatedAt: 300 + n }, t.c.board("p1", { ownedFields: ["tracks", "timelineItems"] }));
  // de(): armed until it fires; flush (cN): sends it now
  const de = () => { timer = true; t.setArmed(true); };
  t.store.flush = () => { if (!timer) return Promise.resolve(); timer = null; t.setArmed(false); return timeline(); };
  const fire = () => { timer = null; t.setArmed(false); return timeline(); };
  return { t, sent, send, de, fire };
};

test("H4, one action one save: a title's media entry saved after its timeline save rides with it: one save, the entry's own answered by it", async () => {
  const { t, sent, send, de, fire } = await saving();
  de();
  t.c.ride("p1", { removedMediaIds: ["tm6"] });
  const p = fire();
  assert.deepEqual(sent, [{ ownedFields: ["tracks", "timelineItems"], removedMediaIds: ["tm6"] }], "the timeline save carries the entry");
  const own = send({ id: "p1" }, { removedMediaIds: ["tm6"] });
  assert.equal(own, p, "the entry's own save is answered by the one that carried it");
  assert.equal(sent.length, 1, "and isn't sent");
  // taken out: a later save of the same entry goes on its own
  send({ id: "p1" }, { removedMediaIds: ["tm6"] });
  assert.equal(sent.length, 2);
});

test("H4, one action one save: a title's media entry saved first sends the waiting timeline save now, carrying it", async () => {
  const { t, sent, send, de } = await saving();
  de();
  t.c.ride("p1", { removedMediaIds: ["tm6"] });
  const own = send({ id: "p1" }, { removedMediaIds: ["tm6"] });
  assert.deepEqual(sent, [{ ownedFields: ["tracks", "timelineItems"], removedMediaIds: ["tm6"] }], "one save: the timeline, with the entry");
  assert.equal(await own, 1, "answered by it");
  assert.equal(t.store.armed(), false, "nothing left waiting");
  // a title added: its entry owned by the timeline save
  de();
  t.c.ride("p1", { ownedMediaIds: ["tm7"] });
  send({ id: "p1" }, { ownedMediaIds: ["tm7"] });
  assert.deepEqual(sent[1], { ownedFields: ["tracks", "timelineItems"], ownedMediaIds: ["tm7"] });
  assert.equal(sent.length, 2);
});

test("H4, one action one save: anything else is sent as before: no timeline save waiting, another project, a library file's media, Carton off", async () => {
  const { t, sent, send, de, fire } = await saving();
  // nothing armed: the entry's save goes alone (its action never armed a timeline save)
  t.c.ride("p1", { removedMediaIds: ["a"] });
  send({ id: "p1" }, { removedMediaIds: ["a"] });
  assert.deepEqual(sent, [{ removedMediaIds: ["a"] }]);
  // another project's action is never this editor's
  de();
  t.c.ride("p2", { removedMediaIds: ["b"] });
  fire();
  assert.deepEqual(sent[1], { ownedFields: ["tracks", "timelineItems"] });
  // a save that isn't only noted entries (a media file's details, a field) goes as it is
  de();
  t.c.ride("p1", { removedMediaIds: ["c"] });
  send({ id: "p1" }, { removedMediaIds: ["c"], ownedMediaIds: ["video"] });
  send({ id: "p1" }, { ownedMediaDataFields: { c: ["duration"] } });
  assert.deepEqual(sent.slice(2), [{ removedMediaIds: ["c"], ownedMediaIds: ["video"] }, { ownedMediaDataFields: { c: ["duration"] } }]);
  // with Carton off, none of it applies
  const off = load({ enabled: false });
  await off.c.ready;
  off.setArmed(true);
  off.c.ride("p1", { removedMediaIds: ["d"] });
  const scope = { ownedFields: ["tracks", "timelineItems"] };
  assert.equal(off.c.board("p1", scope), scope);
  let went = 0;
  off.c.send({ id: "p1" }, { removedMediaIds: ["d"] }, () => ++went);
  assert.equal(went, 1);
});

test("H4, one action one save: a timeline save that never reached main (its document failed to serialize) leaves the entry to board the next one, or to go alone", async () => {
  const { t, sent, send, de, fire } = await saving();
  de();
  t.c.ride("p1", { removedMediaIds: ["tm6"] });
  t.c.board("p1", { ownedFields: ["tracks", "timelineItems"] }); // Jt threw after board, before Ss.updateScoped
  fire();
  assert.deepEqual(sent, [{ ownedFields: ["tracks", "timelineItems"], removedMediaIds: ["tm6"] }], "the next timeline save takes it");
  de();
  t.c.ride("p1", { removedMediaIds: ["tm5"] });
  t.c.board("p1", { ownedFields: ["tracks", "timelineItems"] }); // boarded, never sent; and nothing armed now
  t.setArmed(false);
  send({ id: "p1" }, { removedMediaIds: ["tm5"] });
  assert.deepEqual(sent[1], { removedMediaIds: ["tm5"] }, "not carried: its own save goes, as before");
});

test("H4, one action one save (review #1): the same entry noted by two actions is two: each own save takes its own, oldest first", async () => {
  const { t, sent, send, de, fire } = await saving();
  de();
  t.c.ride("p1", { removedMediaIds: ["tm6"] });
  const t1 = fire();
  // undone, then deleted again before the first delete's entry save came
  de();
  t.c.ride("p1", { removedMediaIds: ["tm6"] });
  const first = send({ id: "p1" }, { removedMediaIds: ["tm6"] });
  assert.equal(first, t1, "the first delete's own save: answered by the first timeline save");
  assert.equal(t.store.armed(), true, "the second delete's timeline save isn't sent early for it");
  const t2 = fire();
  assert.deepEqual(sent.map((x) => x.removedMediaIds), [["tm6"], ["tm6"]], "each timeline save carries its own delete's entry");
  assert.equal(send({ id: "p1" }, { removedMediaIds: ["tm6"] }), t2, "the second's own save: answered by the second");
  assert.equal(sent.length, 2, "neither entry save is sent on its own");
  send({ id: "p1" }, { removedMediaIds: ["tm6"] });
  assert.equal(sent.length, 3, "a third, noted by no action, goes alone");
});

test("H4, one action one save (review #3): a Delete of 65 titles is one save; only carried entries are ever dropped", async () => {
  const { t, sent, send, de, fire } = await saving();
  const ids = Array.from({ length: 65 }, (_, i) => "tm" + i);
  de();
  for (const id of ids) t.c.ride("p1", { removedMediaIds: [id] }); // Kx: one per title, in one action
  fire();
  assert.deepEqual(sent[0].removedMediaIds, ids, "the timeline save carries all 65");
  for (const id of ids) send({ id: "p1" }, { removedMediaIds: [id] });
  assert.equal(sent.length, 1, "one save for the action");
  // entries whose own save never comes (a write that failed first): kept up to 1024 once carried, oldest dropped, but
  // never those of the save just sent, however many
  de();
  for (let i = 0; i < 1100; i++) t.c.ride("p1", { removedMediaIds: ["lost" + i] });
  fire();
  de();
  t.c.ride("p1", { removedMediaIds: ["next"] });
  fire();
  send({ id: "p1" }, { removedMediaIds: ["lost0"] });
  assert.equal(sent.length, 4, "the oldest carried one was dropped once a later save went: its late save goes alone (a no-op at the worker)");
  send({ id: "p1" }, { removedMediaIds: ["lost1099"] });
  send({ id: "p1" }, { removedMediaIds: ["next"] });
  assert.equal(sent.length, 4, "newer ones are still answered by their carriers");
});

test("laptop, merge/prod-2: Carton's views share one IPC listener per channel (no MaxListenersExceededWarning)", async () => {
  const t = load({ enabled: true });
  await t.c.ready;
  const added = new Map(), offs = [];
  t.store.on = (channel, f) => { added.set(channel, (added.get(channel) ?? 0) + 1); const set = (t.listeners ??= new Map()).get(channel) ?? new Set(); set.add(f); t.listeners.set(channel, set); return () => { set.delete(f); added.set(channel, added.get(channel) - 1); }; };
  const got = [];
  for (let i = 0; i < 12; i++) offs.push(t.c.onEvent((ev) => got.push([i, ev])));
  offs.push(t.c.onCommand(() => got.push(["cmd"])));
  assert.deepEqual([...added], [["carton:event", 1], ["carton:command", 1]], "one listener per channel");
  // one handler that throws doesn't keep the others from the event
  offs.push(t.c.onEvent(() => { throw new Error("boom"); }));
  for (const f of t.listeners.get("carton:event")) f({ id: "p1" });
  assert.equal(got.filter((g) => g[0] !== "cmd").length, 12);
  for (const off of offs) off();
  assert.deepEqual([...added], [["carton:event", 0], ["carton:command", 0]], "gone once the last view goes");
  // subscribing again attaches again
  const again = t.c.onEvent(() => {});
  assert.equal(added.get("carton:event"), 1);
  again();
  // review #5: one handler subscribed twice is two subscriptions, each with its own unsubscribe
  let calls = 0;
  const f = () => calls++;
  const a = t.c.onEvent(f), b = t.c.onEvent(f);
  for (const g of t.listeners.get("carton:event")) g({});
  assert.equal(calls, 2);
  a();
  a(); // twice: still only its own
  for (const g of t.listeners.get("carton:event")) g({});
  assert.equal(calls, 3, "the other subscription still hears it");
  b();
  assert.equal(added.get("carton:event"), 0);
});

// Carton UX redesign PLAN 1.4: Cardboard's own refusal (its xv, patch-carton.js) asks the bridge first while a Carton
// preview is shown: a Carton part of the page says it (the edit-attempt toast), or nobody does and Cardboard's note
// shows. Never with Carton off, never outside a preview; a part that throws doesn't stop the next.
test("PLAN 1.4: an edit refused while viewing is told by the page's Carton part, else by Cardboard's note; nothing with Carton off", async () => {
  const t = load({ enabled: true });
  await t.c.ready;
  assert.equal(t.c.blocked(), false, "no preview: Cardboard's own refusal (an agent's lock, say)");
  await t.c.preview("p1", "main@3");
  assert.equal(t.c.blocked(), false, "no Carton part listening: Cardboard's note, in Carton's words");
  const told = [];
  const offA = t.c.onBlocked(() => { told.push("a"); return true; });
  const offB = t.c.onBlocked(() => { throw new Error("boom"); });
  assert.equal(t.c.blocked(), true, "told");
  assert.deepEqual(told, ["a"], "the newest that throws doesn't keep the one before from telling");
  offB();
  const offC = t.c.onBlocked(() => false);
  assert.equal(t.c.blocked(), true, "a part with nothing viewed passes to the next");
  offC();
  offA();
  assert.equal(t.c.blocked(), false, "nobody left");
  await t.c.preview("p1", null);
  t.c.onBlocked(() => { told.push("x"); return true; });
  assert.equal(t.c.blocked(), false, "back to your edit: Cardboard's");
  const off = load({ enabled: false });
  await off.c.ready;
  off.setState({ cartonPreview: { ref: "main@3" } });
  off.c.onBlocked(() => true);
  assert.equal(off.c.blocked(), false, "Carton off: Cardboard's");
});

// PLAN 1.6 (DESIGN §9): Export never exports what is viewed. beforeExport is null when nothing is (Export opens at
// once); else the page's Carton part goes back its own way, the editor then takes head itself, and Export waits for it:
// it opens only on your edit. Without a Carton part the bridge leaves the preview itself. Carton off: null.
test("PLAN 1.6: Export while viewing goes back to your edit first; at once when nothing is viewed; nothing with Carton off", async () => {
  const t = load({ enabled: true });
  await t.c.ready;
  assert.equal(t.c.beforeExport(), null, "nothing viewed");
  const asked = [];
  const offPart = t.c.onBack((why) => { asked.push(why); return null; });
  assert.equal(t.c.beforeExport(), null, "the page's part has nothing viewed either");
  await t.c.preview("p1", "main@3");
  offPart();
  // the page's part goes back (its own way), and Export waits for it and for head in the editor
  let back = null;
  const offB = t.c.onBack((why) => { asked.push(why); return new Promise((r) => (back = r)); });
  const p = t.c.beforeExport();
  assert.ok(p && typeof p.then === "function", "Export waits");
  let done = false;
  p.then(() => (done = true));
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(done, false, "until your edit is back");
  back();
  await p;
  assert.equal(t.state().cartonPreview, null, "the editor shows head");
  assert.deepEqual(asked, ["export", "export"]);
  offB();
  // without a Carton part: the bridge leaves the preview itself, and Export opens on head
  await t.c.preview("p1", "main@3");
  await t.c.beforeExport();
  assert.equal(t.state().cartonPreview, null, "your edit");
  assert.equal(t.c.beforeExport(), null);
  const off = load({ enabled: false });
  await off.c.ready;
  off.setState({ cartonPreview: { ref: "main@3" } });
  assert.equal(off.c.beforeExport(), null, "Carton off: Export as Cardboard opens it");
});

// Review of feat/ux-1-viewing #1: two Exports while viewing, the second before the first is back. The page goes back
// once per ask (its viewing hasn't cleared yet), and the older return, superseded in the bridge, used to count as done:
// Export opened on the old timeline. Now both wait for one guard, which resolves only with head in the editor; a
// version viewed again meanwhile makes it fail, and Export doesn't open.
test("review #1: Exports asked while one goes back share it; a return superseded by a newer view doesn't open Export", async () => {
  const t = load({ enabled: true });
  await t.c.ready;
  await t.c.preview("p1", "main@3");
  // head answers late, when released: the returns are under way while the next is asked
  const release = [];
  let slow = true;
  const invoke = t.store.invoke;
  t.store.invoke = (ch, m) => (slow && m.method === "head" ? new Promise((r) => release.push(() => r(t.disk.doc))) : invoke(ch, m));
  const until = async (n) => { for (let i = 0; i < 50 && release.length < n; i++) await new Promise((r) => setTimeout(r, 2)); assert.equal(release.length, n); };
  let asks = 0;
  const offPart = t.c.onBack(() => { asks++; return t.c.preview("p1", null); });
  const a = t.c.beforeExport();
  await until(1);
  const b = t.c.beforeExport();
  assert.equal(a, b, "a second Export meanwhile waits for the same return");
  assert.equal(asks, 1, "the page went back once");
  let opened = 0;
  a.then(() => opened++, () => {});
  release.shift()();
  await until(1);
  assert.equal(opened, 0, "the page's return alone isn't enough: head in the editor first");
  release.shift()();
  await a;
  assert.equal(opened, 1);
  assert.equal(t.state().cartonPreview, null, "Export opens on your edit");
  // a version viewed again while the guard's own return waits for head: superseded, so not back: Export doesn't open,
  // and the person is told
  offPart();
  slow = false;
  const told = [];
  t.c.onNotice((x) => told.push(x));
  await t.c.preview("p1", "main@3");
  slow = true;
  const c = t.c.beforeExport();
  await until(1);
  slow = false;
  await t.c.preview("p1", "main@4");
  release.shift()();
  await assert.rejects(c, /still viewing/, "Export doesn't open");
  assert.deepEqual(t.state().cartonPreview, { ref: "main@4" }, "the newer view stays");
  assert.match(told.at(-1), /^Export didn't open/);
  assert.equal(t.c.beforeExport() === c, false, "the next Export asks anew");
});

// Review of feat/ux-1-viewing #2: leaving a teammate's cut is a cut switch (no preview), which the editor adopts from
// its change event a moment after the switch answers. Export waits for head in the editor, not for the switch alone.
test("review #2: Export from a teammate's cut waits until the editor shows your cut's head", async () => {
  const t = load({ enabled: true });
  await t.c.ready;
  // the editor shows the teammate's cut (not a preview: a read-only cut switched to)
  t.setState({ cartonBase: 100, timelineItems: [{ id: "theirs", endTime: 3 }] });
  let switched = false;
  t.c.onBack(() => Promise.resolve().then(() => { switched = true; t.disk.doc = t.project(300, [{ id: "mine", endTime: 5 }]); }));
  await t.c.beforeExport();
  assert.equal(switched, true);
  assert.deepEqual(t.state().timelineItems.map((i) => i.id), ["mine"], "your cut's head in the editor");
  assert.equal(t.state().cartonBase, 300);
});

// PLAN 1.3: a conflict's See it brings its clip into view without selecting it (a selection takes viewing's first Esc).
test("PLAN 1.3: See it moves the playhead to the clip without selecting it", async () => {
  const t = load({ enabled: true });
  await t.c.ready;
  const did = [];
  t.store.raw({ timelineItems: [{ id: "clip-a", startTime: 4.5, endTime: 8 }], selectTimelineItem: (id) => did.push(["select", id]), setPlaybackPosition: (s) => did.push(["seek", s]) });
  assert.equal(t.c.reveal("clip-a", { select: false }), true);
  assert.deepEqual(did, [["seek", 4.5]]);
});
