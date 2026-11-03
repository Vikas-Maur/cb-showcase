// Laptop P2-1 (merge/prod-2 @ 3b2407c3, 3 of 3 by two people) in Cardboard's real (patched) library worker under Node,
// the History panel driven as a page drives it and Ctrl+Z / Ctrl+Shift+Z sent as the renderer bridge sends them:
// New cut "Alt" with the clip split and the title's font size changed; on Main, Fold "Alt" in here with the split left
// out (a fold-some: "merge (1 left out)"), then Fold "Alt" in here again (the rest). Ctrl+Z ① undid the rest; Ctrl+Z ②
// read "Undid the fold of 'Alt' into 'Main cut'" but `cb compare` said "Split 'clip.mp4' at …": it brought the rest back
// in (the state after the rest again), and Ctrl+Z ③ finally undid the fold. A fold-some is one undo: ① the rest, ② the
// whole partial fold, and redo walks forward the same way. `cb undo` does the same.
//   CARDBOARD_PRISTINE=<Cardboard 1.4.0 unpacked> node --test --test-concurrency=1 scripts/carton/test/sync/fold-undo.test.js
const test = require("node:test");
const assert = require("node:assert/strict");
const S = require("./support.js");
// A fold's answer says which versions it made too (UX redesign PLAN 5.3: its toast's Undo takes back exactly those):
// the rest of the answer, as before, and that it made one or more
const folded = (r) => { const { made, ...rest } = r ?? {}; assert.ok(!rest.ok || (made && Array.isArray(made.changes) && made.changes.length > 0), "a fold says what it made: " + JSON.stringify(r)); return rest; };

const t = { skip: S.skip || S.noBuild, timeout: S.TEST_MS * 2 };
let b;
test.before(async () => { if (!t.skip) b = await S.build(); }, { timeout: S.SETUP_MS });
test.after(() => S.killHelpers(), { timeout: S.STOP_MS });

/** The History panel on a computer, as a page reads it (cuts-menu.test.js): cuts, History's rows, its calls. */
async function openPanel(pc, id, client) {
  const msgs = () => pc.events().filter((e) => e.change?.kind === "carton" && e.change.client === client).map((e) => e.change.message);
  const send = (message) => pc.call("carton.ui", { projectId: id, client, message });
  assert.equal((await send({ t: "hello" }))?.status, "ok", "the History panel opens");
  await S.until(() => msgs().some((x) => x.t === "init"), 20_000, "the panel's init");
  const cuts = () => {
    let c = [];
    for (const x of msgs()) {
      if (x.t === "init") c = x.topics.cuts ?? [];
      if (x.t === "topic" && x.topic === "cuts") c = x.value;
    }
    return c;
  };
  const history = () => {
    let h = [];
    for (const x of msgs()) {
      if (x.t === "init") h = x.history.slice();
      if (x.t === "history") { for (const [i, v] of x.rows) h[i] = v; h.length = x.length; }
    }
    return h;
  };
  let calls = 0;
  const call = async (method, ...args) => {
    const n = ++calls;
    await send({ t: "call", id: n, method, args });
    const ret = await S.until(() => msgs().find((x) => x.t === "ret" && x.id === n), 30_000, "the panel's " + method);
    if (!ret.ok) throw new Error(`panel ${method}: ${ret.error}`);
    return ret.value;
  };
  /** History's newest row on the current cut once it is the version at `seq`, in words (the whole row: `newestRow`). */
  const newestRow = async (seq) => {
    const row = await S.until(() => { const r = history().at(-1); return r?.seq === seq && r; }, 20_000, `History's row for @${seq} (newest: ${JSON.stringify(history().at(-1))})`);
    await send({ t: "want", ids: [row.id] });
    return S.until(() => { const v = history().find((x) => x.id === row.id); return v?.summary && v; }, 20_000, `@${seq} in words`);
  };
  const newest = async (seq) => (await newestRow(seq)).summary;
  return { cuts, history, call, newest, newestRow };
}

const must = (r, what) => { if (r.code !== 0) throw new Error(what + ": " + r.out + r.err); return r; };
const videos = (doc) => doc.timelineItems.filter((i) => i.type === "video").length;
const font = (doc) => S.textOf(doc).fontSize;

/**
 * The laptop's steps 1-3 on a seeded project: New cut "Alt" (the panel's), the clip split and the title 140 → 150 on
 * it as the editor saves them; on Main, the fold with the split left out, then the fold of the rest.
 */
async function foldSomeThenRest(pc, id, panel) {
  const main = panel.cuts().find((c) => c.current);
  const alt = await panel.call("newCut", "Alt", panel.history().at(-1).ref);
  await S.until(() => panel.cuts().find((c) => c.current)?.id === alt.id, 20_000, "the panel on Alt");
  const doc = await S.projectOf(pc, id);
  const clip = S.videoOf(doc);
  const at = clip.startTime + 1, cut = clip.trimStart + 1 * (clip.playbackSpeed ?? 1);
  const left = { ...clip, id: "fold-undo-left", endTime: at, trimEnd: cut }, right = { ...clip, id: "fold-undo-right", startTime: at, trimStart: cut };
  delete left.transitionOut, delete right.transitionIn;
  const n0 = panel.history().length;
  await pc.call("projects.updateScoped", { ...doc, timelineItems: doc.timelineItems.flatMap((it) => (it.id === clip.id ? [left, right] : [it])), stateUpdatedAt: Date.now() }, { ownedFields: ["tracks", "timelineItems"], carton: { base: doc.stateUpdatedAt, actor: "person" } });
  await S.until(() => panel.history().length > n0, 20_000, "the split on Alt");
  await S.guiSave(pc, id, (it) => (it.type === "text" ? { ...it, fontSize: 150 } : undefined));
  await S.until(() => panel.history().length > n0 + 1, 20_000, "the title's edit on Alt");

  await panel.call("switchCut", main.id);
  await S.until(async () => panel.cuts().find((c) => c.current)?.id === main.id && videos(await S.projectOf(pc, id)) === 1, 20_000, "Main in the panel and in project.json");
  const before = await S.projectOf(pc, id);
  assert.deepEqual([videos(before), font(before)], [1, 140], "Main before the fold");
  const plan = await panel.call("planFold", alt.id, main.id);
  const split = plan.changes.find((c) => /^Split “clip\.mp4”/.test(c.summary));
  assert.ok(split, "the split is a row: " + JSON.stringify(plan.changes.map((c) => c.summary)));
  assert.deepEqual(folded(await panel.call("fold", alt.id, main.id, { choices: {}, leaveOut: [split.id] })), { ok: true });
  // its row (the first fold on Main), one version for the fold and its partial revert
  const atSome = await S.until(() => { const r = panel.history().at(-1); return r?.kind === "fold" && r.seq; }, 20_000, "the partial fold's row");
  // the UX redesign's words (PLAN 0.2): the row says what it was; "1 of N changes" is its counts (changes, leftOut)
  const some = await panel.newestRow(atSome);
  assert.equal(some.summary, "Folded in “Alt”");
  assert.ok(some.changes === 1 && some.leftOut >= 1, "1 of N changes: " + JSON.stringify(some));
  const s1 = await S.projectOf(pc, id);
  assert.deepEqual([videos(s1), font(s1)], [1, 150], "the partial fold: the title's change, not the split");
  const again = await panel.call("planFold", alt.id, main.id);
  assert.deepEqual(again.changes.map((c) => c.summary).filter((x) => /^Split/.test(x)).length, 1, "Fold in again offers the split: " + JSON.stringify(again.changes.map((c) => c.summary)));
  assert.deepEqual(folded(await panel.call("fold", alt.id, main.id, { choices: {}, leaveOut: [] })), { ok: true });
  const rest = atSome + 1;
  const restRow = await panel.newestRow(rest);
  assert.equal(restRow.summary, "Folded in the rest of “Alt”");
  assert.equal(restRow.changes, 1, "1 change: " + JSON.stringify(restRow));
  const s2 = await S.projectOf(pc, id);
  assert.deepEqual([videos(s2), font(s2)], [2, 150], "the rest: the split too");
  return { main, alt, rest };
}

test("P2-1: fold-some, then the rest: Ctrl+Z ① undoes the rest, ② the whole partial fold; redo walks forward", t, async () => {
  const pc = await S.computer("fold-undo-app", b);
  try {
    S.seed(pc, b);
    await pc.startWorker();
    const id = (await pc.call("projects.list"))[0]?.id;
    const panel = await openPanel(pc, id, "page-1");
    const since = Date.now(); // the editor opened the project (the bridge's cartonSince)
    const { rest } = await foldSomeThenRest(pc, id, panel);
    const step = (which) => pc.call(`carton.${which}`, { projectId: id, since });
    const shape = async () => { const d = await S.projectOf(pc, id); return [videos(d), font(d)]; };
    const compare = (seq) => must(pc.cb(["compare", "Demo", `main@${seq - 1}`, `main@${seq}`]), "cb compare").json().changes;

    const z1 = await step("undo");
    assert.equal(z1.status, "confirmed", JSON.stringify(z1));
    assert.equal(await panel.newest(rest + 1), "Undid the fold of the rest of “Alt”");
    assert.deepEqual(await shape(), [1, 150], "Ctrl+Z ①: the split undone, the partial fold kept");
    const z2 = await step("undo");
    assert.equal(z2.status, "confirmed", JSON.stringify(z2));
    assert.equal(await panel.newest(rest + 2), "Undid the fold of “Alt”");
    assert.deepEqual(await shape(), [1, 140], "Ctrl+Z ②: Main as it was before the first fold");
    const c2 = compare(rest + 2);
    assert.ok(!c2.some((l) => /^Split/.test(l)), "cb compare of Ctrl+Z ② brings nothing in: " + JSON.stringify(c2));
    assert.ok(c2.some((l) => /150 → 140/.test(l)), "it takes the title's change back: " + JSON.stringify(c2));
    assert.deepEqual(z2.can, { undo: false, redo: true }, "two actions, two presses: nothing left to undo in this session");

    const r1 = await step("redo");
    assert.equal(r1.status, "confirmed");
    assert.equal(await panel.newest(rest + 3), "Redid the fold of “Alt”");
    assert.deepEqual(await shape(), [1, 150], "redo ①: the partial fold");
    const r2 = await step("redo");
    assert.equal(r2.status, "confirmed");
    assert.equal(await panel.newest(rest + 4), "Redid the fold of the rest of “Alt”");
    assert.deepEqual(await shape(), [2, 150], "redo ②: the rest");
    assert.deepEqual(r2.can, { undo: true, redo: false }, "nothing left to redo");
  } finally {
    await pc.stopWorker();
  }
});

test("P2-1: the same with `cb undo` from a terminal while the app runs", t, async () => {
  const pc = await S.computer("fold-undo-cb", b);
  try {
    S.seed(pc, b);
    await pc.startWorker();
    const id = (await pc.call("projects.list"))[0]?.id;
    const panel = await openPanel(pc, id, "page-1");
    const { main, rest } = await foldSomeThenRest(pc, id, panel);
    const shape = async () => { const d = await S.projectOf(pc, id); return [videos(d), font(d)]; };
    const u1 = must(pc.cb(["undo", "Demo", "--cut", main.id]), "cb undo ①");
    assert.equal(await panel.newest(rest + 1), "Undid the fold of the rest of “Alt”");
    assert.deepEqual(await shape(), [1, 150], "cb undo ①: the rest: " + u1.out);
    const u2 = must(pc.cb(["undo", "Demo", "--cut", main.id]), "cb undo ②");
    assert.equal(await panel.newest(rest + 2), "Undid the fold of “Alt”");
    assert.deepEqual(await shape(), [1, 140], "cb undo ②: the whole partial fold");
    assert.match(u2.out, /Undo merge/, "named as a fold's undo is");
  } finally {
    await pc.stopWorker();
  }
});
