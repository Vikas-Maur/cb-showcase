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
  const project = (rev, items) => ({ id: "p1", stateUpdatedAt: rev, tracks: [{ id: "t1" }], timelineItems: items, aspectRatio: "16:9" });
  const disk = { doc: project(200, [{ id: "a", endTime: 4 }]) };
  const store = {
    state: () => state,
    raw: (p) => { log.push(["raw", p]); state = { ...state, ...p }; },
    adopt: (p) => { log.push(["adopt", p]); state = { ...state, ...p }; },
    armed: () => armed,
    flush: async () => { log.push(["flush", armed]); armed = false; },
    invoke: async (channel, { method, args }) => { calls.push([channel, method, ...args]); if (method === "enabled") return enabled; if (method === "head") return disk.doc; if (method === "checkout") return project(150, [{ id: "old", endTime: 2 }]); return { status: "confirmed" }; },
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
  return { c: window.__carton, calls, log, host, disk, project, store, setArmed: (a) => (armed = a), state: () => state };
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
  assert.deepEqual(t.log, [["raw", { cartonBase: 101 }]]);
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

test("a preview is read-only: changes wait, undo doesn't take it, and Return to current takes head", async () => {
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
