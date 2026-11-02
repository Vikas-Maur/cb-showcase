// Laptop re-check of merge/prod-2 (P3) in Cardboard's real (patched) library worker under Node, the History panel
// driven as a page drives it (remoteUi's protocol over the worker's `carton.ui`):
// #1 A cut `cb cut new` makes while the app runs (no edit on it yet) never showed in the panel's cut menu, even after
//    reopening the panel, until you switched to it: the panel's view model re-read the cuts only on `change` events,
//    and a new cut moves no head. Core now tells `cuts` when the cuts change, here at the panel's poll of the head.
// #2 A split (the editor's Split at playhead, saved as the editor saves) reads as a split in History, not as two clips
//    added and one deleted.
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
  return { cuts, history, want, reopen: hello };
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

test("#2: a split saved by the editor reads as a split in History", t, async () => {
  const pc = await S.computer("cuts-split", b);
  try {
    S.seed(pc, b);
    await pc.startWorker();
    const id = (await pc.call("projects.list"))[0]?.id;
    const panel = await openPanel(pc, id, "page-1");
    const before = panel.history().length;
    const doc = await S.projectOf(pc, id);
    const clip = doc.timelineItems.find((it) => it.type === "video");
    assert.ok(clip, "the seeded clip");
    // Cardboard 1.4.0's split at 1.0 s (`cl` in the renderer): two new clips over the old one's range
    const at = clip.startTime + 1, cut = clip.trimStart + 1 * (clip.playbackSpeed ?? 1);
    const left = { ...clip, id: "split-left-0001", endTime: at, trimEnd: cut };
    const right = { ...clip, id: "split-right-0001", startTime: at, trimStart: cut };
    delete left.transitionOut, delete right.transitionIn;
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
