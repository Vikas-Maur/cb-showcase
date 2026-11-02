// ui-words item 3: a person's consecutive GUI saves never raise a conflict card against each other. The user saw a card
// whose two sides were both "You": a clip added, then moved before the first save's echo came back. The editor's
// base (cartonBase) moved only on that echo, so the second save, which holds the first's edit too, was diffed against
// the version before both and clashed with the first save at head.
// Through Cardboard 1.4.0's real (patched) library worker, with each save's Carton meta from the real renderer bridge
// (scripts/carton/renderer-bridge.js saveMeta), two saves with no echo between them, as a quick second edit sends them.
//   CARDBOARD_PRISTINE=<Cardboard 1.4.0 unpacked> node --test --test-concurrency=1 scripts/carton/test/sync/own-saves.test.js
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const S = require("./support.js");

const t = { skip: S.skip || S.noBuild, timeout: S.TEST_MS };
const SCOPE = { ownedFields: ["tracks", "timelineItems"] };
let b, pc, id;

test.before(async () => {
  if (t.skip) return;
  b = await S.build();
  pc = await S.computer("own-saves", b);
  S.seed(pc, b);
  await pc.startWorker();
  [{ id }] = await pc.call("projects.list");
}, { timeout: S.SETUP_MS });
test.after(async () => {
  await pc?.stopWorker();
  S.killHelpers();
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

test("a clip moved twice, before the first save's echo: no card, the second move is head", t, async () => {
  const before = (await cardsForPerson()).length;
  const doc = await S.projectOf(pc, id);
  const editor = await editorOn(doc);
  const v = S.videoOf(doc);
  const once = await save(editor, items(doc, (it) => (it.id === v.id ? { ...it, startTime: it.startTime + 1, endTime: it.endTime + 1 } : null)));
  await save(editor, items(once, (it) => (it.id === v.id ? { ...it, startTime: it.startTime + 1, endTime: it.endTime + 1 } : null)));
  assert.equal((await cardsForPerson()).length, before, "no card between the person's own saves");
  assert.equal(S.videoOf(await S.projectOf(pc, id)).startTime, v.startTime + 2);
});

test("a clip added, then moved before the first save's echo (the user's card): no card, the clip where it was moved to", t, async () => {
  const before = (await cardsForPerson()).length;
  const doc = await S.projectOf(pc, id);
  const editor = await editorOn(doc);
  const text = S.textOf(doc);
  const added = await save(editor, { ...doc, timelineItems: [...doc.timelineItems, { ...text, id: "added-then-moved", startTime: 3, endTime: 4 }] });
  await save(editor, items(added, (it) => (it.id === "added-then-moved" ? { ...it, startTime: 3.5, endTime: 4.5 } : null)));
  assert.equal((await cardsForPerson()).length, before, "no card between the person's own saves");
  const now = (await S.projectOf(pc, id)).timelineItems.filter((i) => i.id === "added-then-moved");
  assert.deepEqual(now.map((i) => [i.startTime, i.endTime]), [[3.5, 4.5]]);
});

test("a move then a trim of one clip, quickly: no card, both land", t, async () => {
  const before = (await cardsForPerson()).length;
  const doc = await S.projectOf(pc, id);
  const editor = await editorOn(doc);
  const tx = S.textOf(doc);
  const moved = await save(editor, items(doc, (it) => (it.id === tx.id ? { ...it, startTime: it.startTime + 0.5, endTime: it.endTime + 0.5 } : null)));
  await save(editor, items(moved, (it) => (it.id === tx.id ? { ...it, endTime: it.endTime - 0.25 } : null)));
  assert.equal((await cardsForPerson()).length, before, "no card between the person's own saves");
  const now = S.textOf(await S.projectOf(pc, id));
  assert.deepEqual([now.startTime, now.endTime], [tx.startTime + 0.5, tx.endTime + 0.25]);
});

test("an agent's edit lands under the editor's first save (merged), then a quick second save: no card, the agent's edit kept", t, async () => {
  const before = (await cardsForPerson()).length;
  const doc = await S.projectOf(pc, id);
  const editor = await editorOn(doc);
  // the agent changes the text's size through cb, after the editor read the project
  const r = pc.cb(["source", "print", "Demo"]);
  assert.equal(r.code, 0, r.out + r.err);
  const tsx = path.join(pc.root, "Demo.cardboard", "timeline.tsx");
  const fs = require("fs");
  const edit = path.join(pc.home, "agent-edit.tsx");
  fs.writeFileSync(edit, fs.readFileSync(tsx, "utf8").replace(/fontSize=\{\d+\}/, "fontSize={177}"));
  const applied = pc.cb(["source", "apply", "Demo", edit], { CARDBOARD_ACTOR: "director/chatO/turnO1" });
  assert.equal(applied.code, 0, applied.out + applied.err);
  // the person, on the version from before the agent's edit, moves the video twice
  const v = S.videoOf(doc);
  const once = await save(editor, items(doc, (it) => (it.id === v.id ? { ...it, startTime: it.startTime + 1, endTime: it.endTime + 1 } : null)));
  await save(editor, items(once, (it) => (it.id === v.id ? { ...it, startTime: it.startTime + 1, endTime: it.endTime + 1 } : null)));
  assert.equal((await cardsForPerson()).length, before, "no card between the person's own saves");
  const now = await S.projectOf(pc, id);
  assert.equal(S.videoOf(now).startTime, v.startTime + 2, "the person's second move is head");
  assert.equal(S.textOf(now).fontSize, 177, "the agent's edit is kept, never reverted by the person's stale document");
});

test("a GUI save confirmed past an agent's change on another clip is written as merged: a new rev and an announcement, so the editor adopts head", t, async () => {
  const doc = await S.projectOf(pc, id);
  const editor = await editorOn(doc);
  const fs = require("fs");
  const tsx = path.join(pc.root, "Demo.cardboard", "timeline.tsx");
  const edit = path.join(pc.home, "agent-edit-2.tsx");
  assert.equal(pc.cb(["source", "print", "Demo"]).code, 0);
  fs.writeFileSync(edit, fs.readFileSync(tsx, "utf8").replace(/fontSize=\{\d+\}/, "fontSize={133}"));
  assert.equal(pc.cb(["source", "apply", "Demo", edit], { CARDBOARD_ACTOR: "director/chatO/turnO2" }).code, 0);
  const seen = pc.events().length;
  const v = S.videoOf(doc);
  const sent = await save(editor, items(doc, (it) => (it.id === v.id ? { ...it, startTime: it.startTime + 0.5, endTime: it.endTime + 0.5 } : null)));
  const now = await S.projectOf(pc, id);
  // Before: written under the save's own rev, so its echo only moved the editor's base, the agent's change never
  // reached the editor, and its next save (made on head) undid it.
  assert.notEqual(now.stateUpdatedAt, sent.stateUpdatedAt, "a new rev: the echo is not the editor's own, it adopts head");
  assert.ok(pc.events().slice(seen).some((e) => e.change?.kind === "changed"), "announced to the pages");
  assert.equal(S.textOf(now).fontSize, 133);
  assert.equal(S.videoOf(now).startTime, v.startTime + 0.5);
});
