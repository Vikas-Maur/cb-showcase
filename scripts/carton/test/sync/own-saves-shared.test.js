// ui-words item 3 on a shared cut: a person's GUI save merged with someone else's change (an agent's edit that landed
// under it), then a quick second save sent before the first one's echo. The second save holds the first's edit; made on
// the version before both (its base), it clashed with the first save at head: a conflict card of the person against
// themself ("You vs You"; the edit stayed in the card, nothing lost). On a local cut the worker held the merged save's
// document as the next save's base (own-saves.test.js); on a shared cut it didn't (the queued edit's id never reached
// it), so the quick second save fell back to its base. Now it builds on the person's merged save there too.
// Through Cardboard 1.4.0's real (patched) library worker, sharing through a real Carton host, with each save's meta
// from the real renderer bridge (scripts/carton/renderer-bridge.js saveMeta).
//   CARDBOARD_PRISTINE=<Cardboard 1.4.0 unpacked> node --test --test-concurrency=1 scripts/carton/test/sync/own-saves-shared.test.js
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs"), path = require("path");
const S = require("./support.js");

const t = { skip: S.skip || S.noBuild, timeout: S.TEST_MS };
const SCOPE = { ownedFields: ["tracks", "timelineItems"] };
let b, host, pc, id;

test.before(async () => {
  if (t.skip) return;
  b = await S.build();
  host = await S.startHost(path.join(S.TMP, "own-saves-shared-host"));
  pc = await S.computer("own-saves-shared", b);
  S.seed(pc, b);
  await pc.startWorker();
  [{ id }] = await pc.call("projects.list");
  const r = await pc.call("carton.liveShare", { projectId: id, host: host.origin, adminToken: S.ADMIN, name: "Alice" });
  assert.equal(r.status, "shared", JSON.stringify(r));
  await S.until(async () => { const s = await pc.call("carton.liveStatus", { projectId: id }); return s.status === "up-to-date" && s.holder && s; }, 20_000, "shared, up to date, the worker holding the lease");
}, { timeout: S.SETUP_MS });
test.after(async () => {
  if (pc?.worker()) fs.writeFileSync(path.join(S.TMP, "own-saves-shared-worker.log"), pc.worker().stderr());
  await pc?.stopWorker();
  S.killHelpers();
  await host?.stop().catch(() => {});
}, { timeout: S.STOP_MS });

/** The editor's Carton half (renderer-bridge.js) on a stand-in store showing `doc`, Carton on. */
async function editorOn(doc) {
  const window = {};
  new Function("window", require("../../renderer-bridge.js"))(window);
  let state = { projectId: doc.id, cartonBase: doc.stateUpdatedAt, cartonPreview: null };
  window.__carton.store({
    state: () => state,
    raw: (p) => (state = { ...state, ...p }),
    invoke: async (_c, { method }) => (method === "enabled" ? true : null),
    on: () => () => {},
  });
  assert.equal(await window.__carton.ready, true);
  return window.__carton;
}
/** A GUI save of `doc` as the editor sends it: the document, with the bridge's meta (its base) for the write. */
let clock = Date.now();
const save = async (editor, doc) => {
  const next = { ...doc, stateUpdatedAt: (clock = Math.max(clock + 1, Date.now())) };
  const meta = editor.saveMeta(next, SCOPE);
  await pc.call("projects.updateScoped", next, { ...SCOPE, carton: meta });
  return next;
};
const cardsForPerson = async () => {
  const bundlePath = (await pc.call("projects.bundleInfo", id)).bundlePath;
  return (await pc.call("carton.notices", { bundlePath, actor: "person" })).flatMap((n) => n.cards ?? []);
};
const items = (d, f) => ({ ...d, timelineItems: d.timelineItems.map((it) => f(it) ?? it) });
/**
 * Every edit confirmed by the host (a late conflict would be a card by then), and project.json showing `ok`: on a shared
 * cut a GUI save's write of project.json lands a moment after the save's call returns (about 0.1 s here, a lone save
 * with no other change too), so the file is waited for, not read at once.
 */
async function settled(ok, what) {
  await S.until(async () => (await pc.call("carton.liveStatus", { projectId: id })).pending === 0, 20_000, "every edit confirmed");
  await S.until(async () => ok(await S.projectOf(pc, id)), 10_000, what);
  return S.projectOf(pc, id);
}
/** An agent's edit of the text's size through cb (the worker holds the lease: it commits it), after the editor read. */
function agentFontSize(size, turn) {
  assert.equal(pc.cb(["source", "print", "Demo"]).code, 0);
  const tsx = path.join(pc.root, "Demo.cardboard", "timeline.tsx");
  const edit = path.join(pc.home, `agent-edit-${turn}.tsx`);
  fs.writeFileSync(edit, fs.readFileSync(tsx, "utf8").replace(/fontSize=\{\d+\}/, `fontSize={${size}}`));
  const applied = pc.cb(["source", "apply", "Demo", edit], { CARDBOARD_ACTOR: `director/chatS/${turn}` });
  assert.equal(applied.code, 0, applied.out + applied.err);
}

test("shared cut: an agent's edit lands under the editor's first save (merged), then a quick second save: no card, both moves and the agent's edit kept", t, async () => {
  const before = (await cardsForPerson()).length;
  const doc = await S.projectOf(pc, id);
  const editor = await editorOn(doc);
  agentFontSize(177, "turnS1");
  // the person, on the version from before the agent's edit, moves the video twice, the second before the first's echo
  const v = S.videoOf(doc);
  const once = await save(editor, items(doc, (it) => (it.id === v.id ? { ...it, startTime: it.startTime + 1, endTime: it.endTime + 1 } : null)));
  await save(editor, items(once, (it) => (it.id === v.id ? { ...it, startTime: it.startTime + 1, endTime: it.endTime + 1 } : null)));
  const now = await settled((d) => S.videoOf(d).startTime === v.startTime + 2, "the person's second move in project.json");
  assert.deepEqual((await cardsForPerson()).slice(before), [], "no card between the person's own saves");
  assert.equal(S.textOf(now).fontSize, 177, "the agent's edit is kept, never reverted by the person's stale document");
});

test("shared cut: a clip added under an agent's edit (merged), then moved before the first save's echo: no card, the clip where it was moved to", t, async () => {
  const before = (await cardsForPerson()).length;
  const doc = await S.projectOf(pc, id);
  const editor = await editorOn(doc);
  agentFontSize(155, "turnS2");
  const text = S.textOf(doc);
  const added = await save(editor, { ...doc, timelineItems: [...doc.timelineItems, { ...text, id: "shared-added-then-moved", startTime: 3, endTime: 4 }] });
  await save(editor, items(added, (it) => (it.id === "shared-added-then-moved" ? { ...it, startTime: 3.5, endTime: 4.5 } : null)));
  const now = await settled((d) => d.timelineItems.some((i) => i.id === "shared-added-then-moved" && i.startTime === 3.5), "the moved clip in project.json");
  assert.deepEqual((await cardsForPerson()).slice(before), [], "no card between the person's own saves");
  assert.deepEqual(now.timelineItems.filter((i) => i.id === "shared-added-then-moved").map((i) => [i.startTime, i.endTime]), [[3.5, 4.5]]);
  assert.equal(S.textOf(now).fontSize, 155, "the agent's edit is kept");
});

// Review of this fix (GPT 6.1 Sol, finding 1), on the reviewer's repro: the first save, a ripple (every clip shifted)
// merged over an agent's edit, is confirmed before the second save arrives. Its change is in the held base, so the
// second save's merge must not compose that ripple again: the clip moved once more would land 5 s too late, with no card.
test("shared cut: a merged ripple confirmed before the next quick save isn't applied to it again", t, async () => {
  const initial = await S.projectOf(pc, id);
  const video = S.videoOf(initial);
  // a second clip on the video's track, so the shift of every clip reads as a ripple
  await pc.call("projects.updateScoped", { ...initial, stateUpdatedAt: (clock = Math.max(clock + 1, Date.now())), timelineItems: [...initial.timelineItems, { ...video, id: "another-video", startTime: 3, endTime: 5 }] }, { ...SCOPE, carton: { base: initial.stateUpdatedAt, actor: "person" } });
  await settled((d) => d.timelineItems.some((i) => i.id === "another-video"), "the second clip in project.json");
  const before = (await cardsForPerson()).length;
  const doc = await S.projectOf(pc, id);
  const editor = await editorOn(doc);
  agentFontSize(144, "turnS3");
  const once = await save(editor, items(doc, (it) => ({ ...it, startTime: it.startTime + 5, endTime: it.endTime + 5 })));
  await S.until(async () => (await pc.call("carton.liveStatus", { projectId: id })).pending === 0, 20_000, "the ripple confirmed");
  const v = S.videoOf(once);
  await save(editor, items(once, (it) => (it.id === v.id ? { ...it, startTime: it.startTime + 1, endTime: it.endTime + 1 } : null)));
  // settled on either outcome, so a wrong one is reported as the head it made
  const now = await settled((d) => [v.startTime + 1, v.startTime + 6].includes(S.videoOf(d).startTime), "the second save in project.json");
  assert.deepEqual((await cardsForPerson()).slice(before), [], "no card between the person's own saves");
  assert.equal(S.textOf(now).fontSize, 144, "the agent's edit is kept");
  assert.equal(S.videoOf(now).startTime, v.startTime + 1, "the ripple is applied once: it is in the held base");
});
