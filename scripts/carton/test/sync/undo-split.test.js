// Ctrl+Z of a split after a later edit of its pieces, with Carton on, through Cardboard's real library worker and
// bundles (support.js), as the editor saves and the renderer bridge steps (laptop report #2, bug 6): one 3 s clip on
// a track, split at 1.5 s, one piece then dragged, muted, trimmed or moved to another track; Ctrl+Z twice gives the
// one clip back, Ctrl+Shift+Z gives the split back, and Ctrl+Y the later edit, as Cardboard's own undo does.
// Run alone:
//   CARDBOARD_PRISTINE=<Cardboard 1.4.0 unpacked> node --test --test-concurrency=1 scripts/carton/test/sync/undo-split.test.js
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs"), path = require("path");
const S = require("./support.js");

const t = { skip: S.skip || S.noBuild, timeout: S.TEST_MS };
const TSX = 'export default (\n  <timeline aspect="16:9">\n    <track name="Mine">\n      <clip src="clip.mp4" start={0} end={3} />\n    </track>\n    <track name="Other">\n      <text name="T" start={5} end={6} fontSize={100} textContent="T" />\n    </track>\n  </timeline>\n);\n';

// one project per case, made by a terminal's cb before the editor's session
const CASES = ["drag", "left", "track", "mute", "trim"];
let b = null, pc = null, ids = null, n = 0;
test.before(async () => {
  b = await S.build();
  pc = await S.computer("split-then-edit", b);
  const must = (x, what) => assert.equal(x.code, 0, what + ": " + x.out + x.err);
  const file = path.join(pc.home, "t.tsx");
  fs.writeFileSync(file, TSX);
  for (const name of CASES) {
    must(pc.cb(["project", "create", name]), "create " + name);
    must(pc.cb(["media", "add", name, b.clip]), "media add " + name);
    must(pc.cb(["source", "apply", name, file]), "apply " + name);
  }
  await pc.startWorker();
  ids = Object.fromEntries((await pc.call("projects.list")).map((p) => [p.name, p.id]));
}, { timeout: S.SETUP_MS });
test.after(async () => {
  await pc?.stopWorker();
  S.killHelpers();
}, { timeout: S.STOP_MS });

const videos = (doc) => doc.timelineItems.filter((i) => i.type === "video");
// the video clips as [start, end, track, muted], in time order
const shape = (doc) => {
  const mine = doc.tracks.find((tr) => tr.name === "Mine")?.id;
  return videos(doc).sort((x, y) => x.startTime - y.startTime).map((i) => [i.startTime, i.endTime, i.trackId === mine ? "Mine" : "Other", !!i.muted]);
};
// a save as the editor makes it: whole arrays, the version it shows as its base, the person, its intents (H4, H7)
const save = (doc, items, intents) =>
  pc.call("projects.updateScoped", { ...doc, timelineItems: items, stateUpdatedAt: Date.now() + ++n }, { ownedFields: ["tracks", "timelineItems"], carton: { base: doc.stateUpdatedAt, actor: "person", ...(intents ? { intents } : {}) } });

/**
 * One 3 s clip on "Mine", split at 1.5 s as the editor splits it (two new ids: Cardboard's splitTimelineItem replaces
 * the clip), `edit` applied to the pieces, then Ctrl+Z ×2, Ctrl+Shift+Z, Ctrl+Y, as the renderer bridge sends them for
 * the editor's session. The editor's stage layer (a panel client) is open throughout: no card comes up.
 */
async function splitThen(name, edit) {
  const id = ids[name];
  const read = () => S.projectOf(pc, id);
  const client = `undo-split-${name}`;
  const msgs = () => pc.events().filter((e) => e.change?.kind === "carton" && e.change.client === client).map((e) => e.change.message);
  assert.equal((await pc.call("carton.ui", { projectId: id, client, message: { t: "hello" } }))?.status, "ok");
  const init = await S.until(() => msgs().find((x) => x.t === "init"), 20_000, "the panel");
  const cards = () => { const last = msgs().filter((x) => x.t === "topic" && x.topic === "conflicts").pop(); return (last ? last.value : init.topics.conflicts) ?? []; };
  const doc0 = await read();
  assert.deepEqual(shape(doc0), [[0, 3, "Mine", false]], "one clip to split");
  const x = videos(doc0)[0];
  const since = Date.now(); // the editor opened the project (the bridge's cartonSince)
  const a = { ...x, id: `${name}-a`, endTime: 1.5, trimEnd: x.trimStart + 1.5 }, b2 = { ...x, id: `${name}-b`, startTime: 1.5, trimStart: x.trimStart + 1.5 };
  await save(doc0, [...doc0.timelineItems.filter((i) => i.id !== x.id), a, b2], [{ kind: "split", id: x.id, at: 1.5, into: [a.id, b2.id] }]);
  const doc1 = await read();
  const split = shape(doc1);
  assert.deepEqual(split, [[0, 1.5, "Mine", false], [1.5, 3, "Mine", false]]);
  await save(doc1, doc1.timelineItems.map((i) => edit(i, doc1) ?? i));
  const edited = shape(await read());
  assert.notDeepEqual(edited, split, "the edit changed the pieces");
  const step = (which) => pc.call(`carton.${which}`, { projectId: id, since });
  const z1 = await step("undo");
  assert.equal(z1.status, "confirmed", "Ctrl+Z #1 undoes the edit");
  assert.deepEqual(shape(await read()), split, "Ctrl+Z #1: the split pieces as they were");
  const z2 = await step("undo");
  assert.equal(z2.status, "confirmed", `Ctrl+Z #2 undoes the split (${z2.status}: ${JSON.stringify(z2.conflicts ?? z2.reason ?? "")}; cards in the panel: ${JSON.stringify(cards().map((c) => c.reason ?? c.title))})`);
  assert.deepEqual(shape(await read()), [[0, 3, "Mine", false]], "Ctrl+Z #2: the one clip back");
  assert.deepEqual(z2.can, { undo: false, redo: true }, "nothing left to undo in this session");
  const r1 = await step("redo");
  assert.equal(r1.status, "confirmed", "Ctrl+Shift+Z redoes the split");
  assert.deepEqual(shape(await read()), split, "redo #1: the split");
  const r2 = await step("redo");
  assert.equal(r2.status, "confirmed", "Ctrl+Y redoes the edit");
  assert.deepEqual(shape(await read()), edited, "redo #2: the edit");
  assert.deepEqual(r2.can, { undo: true, redo: false }, "nothing left to redo");
  assert.deepEqual(cards(), [], "no card came up");
}

test("a split, then a drag of the right piece: Ctrl+Z ×2 gives the clip back, redo ×2 the split and the drag", t, () =>
  splitThen("drag", (i) => (i.id === "drag-b" ? { ...i, startTime: 4.5, endTime: 6 } : undefined)));
test("a split, then a drag of the left piece past the right one", t, () =>
  splitThen("left", (i) => (i.id === "left-a" ? { ...i, startTime: 3, endTime: 4.5 } : undefined)));
test("a split, then the right piece dragged to another track and later", t, () =>
  splitThen("track", (i, doc) => (i.id === "track-b" ? { ...i, trackId: doc.tracks.find((tr) => tr.name === "Other").id, startTime: 3.5, endTime: 5 } : undefined)));
test("a split, then a mute of the right piece", t, () =>
  splitThen("mute", (i) => (i.id === "mute-b" ? { ...i, muted: true } : undefined)));
test("a split, then a trim of the right piece's right edge", t, () =>
  splitThen("trim", (i) => (i.id === "trim-b" ? { ...i, endTime: 2.5, trimEnd: i.trimEnd - 0.5 } : undefined)));
