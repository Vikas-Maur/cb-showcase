// Laptop re-check of merge/prod-2 (P3) in Cardboard's real (patched) library worker under Node, the History panel
// driven as a page drives it (remoteUi's protocol over the worker's `carton.ui`):
// #1 A cut `cb cut new` makes while the app runs (no edit on it yet) never showed in the panel's cut menu, even after
//    reopening the panel, until you switched to it: the panel's view model re-read the cuts only on `change` events,
//    and a new cut moves no head. Core now tells `cuts` when the cuts change, here at the panel's poll of the head.
// #2 A split (the editor's Split at playhead, saved as the editor saves) reads as a split in History, not as two clips
//    added and one deleted. Of a clip with auto reframe on, it read "…, cleared auto reframe on its left part, cleared
//    auto reframe on its right part" (fold-count P3): the editor's save writes the new parts without it.
// #3 Fold counts (fold-count P3): a cut with a split and one other edit, folded into Main with the split left out, read
//    "2 changes" in the Fold dialog, "1 of 4 changes" in History and "merge (3 left out)" in `cb history`. A split is
//    one change in all three.
//   CARDBOARD_PRISTINE=<Cardboard 1.4.0 unpacked> node --test --test-concurrency=1 scripts/carton/test/sync/cuts-menu.test.js
const test = require("node:test");
const assert = require("node:assert/strict");
const S = require("./support.js");

const t = { skip: S.skip || S.noBuild, timeout: S.TEST_MS * 2 };
let b;
test.before(async () => { if (!t.skip) b = await S.build(); }, { timeout: S.SETUP_MS });
test.after(() => S.killHelpers(), { timeout: S.STOP_MS });

/** The History panel on a computer, as a page reads it: the state from the newest `init` on (a reopen starts over). */
async function openPanel(pc, id, client) {
  const msgs = () => pc.events().filter((e) => e.change?.kind === "carton" && e.change.client === client).map((e) => e.change.message);
  const send = (message) => pc.call("carton.ui", { projectId: id, client, message });
  const hello = async () => {
    const inits = msgs().filter((x) => x.t === "init").length;
    assert.equal((await send({ t: "hello" }))?.status, "ok", "the History panel opens");
    await S.until(() => msgs().filter((x) => x.t === "init").length > inits, 20_000, "the panel's init");
  };
  await hello();
  const cuts = () => {
    let c = [];
    for (const x of msgs()) {
      if (x.t === "init") c = x.topics.cuts ?? [];
      if (x.t === "topic" && x.topic === "cuts") c = x.value;
    }
    return c;
  };
  // History's rows, oldest first; a row's summary comes once the page asks for it (`want`), as a list on screen does
  const history = () => {
    let h = [];
    for (const x of msgs()) {
      if (x.t === "init") h = x.history.slice();
      if (x.t === "history") { for (const [i, v] of x.rows) h[i] = v; h.length = x.length; }
    }
    return h;
  };
  const want = (ids) => send({ t: "want", ids });
  let calls = 0;
  const call = async (method, ...args) => {
    const n = ++calls;
    await send({ t: "call", id: n, method, args });
    const ret = await S.until(() => msgs().find((x) => x.t === "ret" && x.id === n), 30_000, "the panel's " + method);
    if (!ret.ok) throw new Error(`panel ${method}: ${ret.error}`);
    return ret.value;
  };
  return { cuts, history, want, call, reopen: hello };
}

const must = (r, what) => { if (r.code !== 0) throw new Error(what + ": " + r.out + r.err); return r; };

test("#1: a cut cb makes while the app runs shows in the History panel's cut menu", t, async () => {
  const pc = await S.computer("cuts-menu", b);
  try {
    S.seed(pc, b);
    await pc.startWorker();
    const id = (await pc.call("projects.list"))[0]?.id;
    assert.ok(id, "the library lists the project");
    const panel = await openPanel(pc, id, "page-1");
    const names = () => panel.cuts().map((c) => c.name).sort();
    assert.deepEqual(names(), ["Main cut"], "one cut to start with: " + JSON.stringify(panel.cuts()));

    // cb cut new while the app runs: a cut with no edit on it, not switched to
    const made = must(pc.cb(["cut", "new", "Demo", "30s Instagram cut"]), "cb cut new").json();
    const altId = made.cut?.id;
    assert.ok(altId, "cb made the cut: " + JSON.stringify(made));
    await S.until(() => panel.cuts().some((c) => c.id === altId), 10_000, "the new cut in the panel's cut menu (" + JSON.stringify(names()) + ")");
    assert.equal(panel.cuts().find((c) => c.current)?.name, "Main cut", "the panel stays on the cut it shows");

    // reopening the panel shows it too
    await panel.reopen();
    assert.ok(panel.cuts().some((c) => c.id === altId), "after reopening: " + JSON.stringify(names()));
  } finally {
    await pc.stopWorker();
  }
});

// Carton UX redesign PLAN 2.1: the title bar's cut chip names the cut the editor is on, and follows a switch made
// anywhere: the cuts menu, or `cb cut switch` from a terminal while the app runs. The page hears it as the worker's
// `cuts` topic (from there to the title bar: scripts/carton/test/cut-chip.test.js, which sends it within the message's
// own microtasks).
test("#4 (PLAN 2.1): cb cut switch while the app runs reaches the page as its cuts, the switched-to cut current", t, async () => {
  const pc = await S.computer("cuts-switch", b);
  try {
    S.seed(pc, b);
    await pc.startWorker();
    const id = (await pc.call("projects.list"))[0]?.id;
    const panel = await openPanel(pc, id, "page-1");
    const made = must(pc.cb(["cut", "new", "Demo", "30s Instagram cut"]), "cb cut new").json();
    const altId = made.cut?.id;
    await S.until(() => panel.cuts().some((c) => c.id === altId), 10_000, "the new cut in the page's cuts");
    must(pc.cb(["cut", "switch", "Demo", "30s Instagram cut"]), "cb cut switch");
    const cur = await S.until(() => { const c = panel.cuts().find((x) => x.current); return c?.id === altId && c; }, 10_000, "the page on the switched-to cut (" + JSON.stringify(panel.cuts().map((c) => [c.name, c.current])) + ")");
    assert.equal(cur.name, "30s Instagram cut");
    assert.equal(panel.cuts().filter((c) => c.current).length, 1, "one current cut");
    must(pc.cb(["cut", "switch", "Demo", "Main cut"]), "cb cut switch back");
    await S.until(() => panel.cuts().find((x) => x.current)?.kind === "main", 10_000, "back on Main cut");
  } finally {
    await pc.stopWorker();
  }
});

test("#2: a split saved by the editor reads as a split in History", t, async () => {
  const pc = await S.computer("cuts-split", b);
  try {
    S.seed(pc, b);
    await pc.startWorker();
    const id = (await pc.call("projects.list"))[0]?.id;
    const panel = await openPanel(pc, id, "page-1");
    const before = panel.history().length;
    // the seeded clip has auto reframe on (cb fitted it to the frame), which the editor's save can't write: Carton
    // keeps it (B10)
    const doc = await S.projectOf(pc, id);
    const clip = doc.timelineItems.find((it) => it.type === "video");
    assert.equal(clip?.autoReframe, true, "the seeded clip, auto reframe on: " + JSON.stringify(clip));
    // Cardboard 1.4.0's split at 1.0 s (`cl` in the renderer): two new clips over the old one's range
    const at = clip.startTime + 1, cut = clip.trimStart + 1 * (clip.playbackSpeed ?? 1);
    const left = { ...clip, id: "split-left-0001", endTime: at, trimEnd: cut };
    const right = { ...clip, id: "split-right-0001", startTime: at, trimStart: cut };
    delete left.transitionOut, delete right.transitionIn;
    // saved through the editor's serializer (`fm`), which has no autoReframe
    delete left.autoReframe, delete right.autoReframe;
    const items = doc.timelineItems.flatMap((it) => (it.id === clip.id ? [left, right] : [it]));
    await pc.call("projects.updateScoped", { ...doc, timelineItems: items, stateUpdatedAt: Date.now() }, { ownedFields: ["tracks", "timelineItems"], carton: { base: doc.stateUpdatedAt, actor: "person" } });
    const row = await S.until(() => panel.history().length > before && panel.history().at(-1), 20_000, "the split's version in the panel");
    await panel.want([row.id]);
    const said = await S.until(() => panel.history().find((v) => v.id === row.id)?.summary, 20_000, "the split's version in words");
    assert.equal(said, "Split 'clip.mp4' at 1.0 s", "History says it was split: " + JSON.stringify(panel.history().at(-1)));
  } finally {
    await pc.stopWorker();
  }
});

test("#3: a fold with its split left out counts the split as one change in the Fold dialog, History and cb history", t, async () => {
  const pc = await S.computer("cuts-fold-count", b);
  try {
    S.seed(pc, b);
    await pc.startWorker();
    const id = (await pc.call("projects.list"))[0]?.id;
    const panel = await openPanel(pc, id, "page-1");
    const main = panel.cuts().find((c) => c.current);
    // New cut from here, then on it: the editor's split of the clip, and a title's font size
    const alt = await panel.call("newCut", "Alt cut", panel.history().at(-1).ref);
    await S.until(() => panel.cuts().find((c) => c.current)?.id === alt.id, 20_000, "the panel on the new cut");
    const doc = await S.projectOf(pc, id);
    const clip = doc.timelineItems.find((it) => it.type === "video");
    const at = clip.startTime + 1, cut = clip.trimStart + 1 * (clip.playbackSpeed ?? 1);
    const left = { ...clip, id: "split-left-0003", endTime: at, trimEnd: cut }, right = { ...clip, id: "split-right-0003", startTime: at, trimStart: cut };
    delete left.transitionOut, delete right.transitionIn;
    const n0 = panel.history().length;
    await pc.call("projects.updateScoped", { ...doc, timelineItems: doc.timelineItems.flatMap((it) => (it.id === clip.id ? [left, right] : [it])), stateUpdatedAt: Date.now() }, { ownedFields: ["tracks", "timelineItems"], carton: { base: doc.stateUpdatedAt, actor: "person" } });
    await S.until(() => panel.history().length > n0, 20_000, "the split on the new cut");
    await S.guiSave(pc, id, (it) => (it.type === "text" ? { ...it, fontSize: 150 } : undefined));
    await S.until(() => panel.history().length > n0 + 1, 20_000, "the title's edit on the new cut");

    // the Fold dialog: two changes, the split one of them
    const plan = await panel.call("planFold", alt.id, main.id);
    assert.equal(plan.changes.length, 2, "two rows: " + JSON.stringify(plan.changes.map((c) => c.summary)));
    const split = plan.changes.find((c) => /^Split 'clip\.mp4'/.test(c.summary));
    assert.ok(split, "the split is one row: " + JSON.stringify(plan.changes.map((c) => c.summary)));
    assert.deepEqual(await panel.call("fold", alt.id, main.id, { choices: {}, leaveOut: [split.id] }), { ok: true });

    // History on Main: the fold's row
    await panel.call("switchCut", main.id);
    const row = await S.until(() => panel.cuts().find((c) => c.current)?.id === main.id && panel.history().at(-1)?.kind === "fold" && panel.history().at(-1), 20_000, "the fold's row on Main");
    await panel.want([row.id]);
    const said = await S.until(() => panel.history().find((v) => v.id === row.id)?.summary, 20_000, "the fold's row in words");
    assert.equal(said, "Folded 'Alt cut' into 'Main cut': 1 of 2 changes");
    // cb history: one change left out
    const h = pc.cb(["history", "Demo", "--cut", main.id, "--limit", "1"]);
    assert.equal(h.code, 0, h.out + h.err);
    const v = h.json().versions[0];
    assert.deepEqual([v.kind, v.leftOutChanges], ["merge", 1], JSON.stringify(v));
  } finally {
    await pc.stopWorker();
  }
});
