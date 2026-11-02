// .cbproj Save As on a cut shared live with edits still waiting to sync (round 2 #4; PLAN §13, §6.2): core exports
// confirmed versions only, so a file saved offline carries no Carton history (a 1.4.0 file that still holds everything
// the person sees) rather than a history that lacks edits its project.json shows; the log says why. The same for cb's
// Save As with the app open. Back online, once the edits have synced, the next Save As carries the history again.
// Cardboard 1.4.0's real library worker, patched, sharing through a real Carton host (server-node on 127.0.0.1).
// Cardboard's bundles are not in git: CARDBOARD_PRISTINE names them (see ../patches.test.js); without them the tests
// skip.
//   CARDBOARD_PRISTINE=… node --test --test-concurrency=1 scripts/carton/test/sync/cbproj-offline.test.js
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs"), path = require("path");
const S = require("./support.js");

const t = { skip: S.noBuild, timeout: S.TEST_MS };
let b, host, alice, id;
const SHALLOW = ".carton-export/shallow.json", FULL = ".carton-export/history.db";

test.before(async () => {
  if (S.noBuild) return;
  b = await S.build();
  host = await S.startHost(path.join(S.TMP, "host-cbproj"));
  alice = await S.computer("cbproj-offline-alice", b);
  S.seed(alice, b);
  await alice.startWorker({ CARTON_CBPROJ_HISTORY: "1" });
  id = (await alice.call("projects.list"))[0].id;
  const r = await alice.call("carton.liveShare", { projectId: id, host: host.origin, adminToken: S.ADMIN, name: "Alice" });
  assert.equal(r.status, "shared", JSON.stringify(r));
  await S.until(async () => (await alice.call("carton.liveStatus", { projectId: id })).status === "up-to-date", 20_000, "alice up to date");
}, { timeout: S.SETUP_MS });
test.after(async () => {
  if (alice?.worker()) fs.writeFileSync(path.join(S.TMP, alice.name + "-worker.log"), alice.worker().stderr());
  alice?.kill();
  S.killHelpers();
  await host?.stop().catch(() => {});
}, { timeout: S.STOP_MS });

test("Save As offline with an edit waiting to sync: the file has the edit and no Carton history, and the log says why; online again, the history is back", t, async () => {
  const port = host.port;
  await host.stop();
  await S.until(async () => (await alice.call("carton.liveStatus", { projectId: id })).status === "offline", 20_000, "alice offline");
  await S.guiSave(alice, id, (it) => (it.type === "text" ? { ...it, textContent: "Written offline" } : null));
  assert.equal((await alice.call("carton.liveStatus", { projectId: id })).pending, 1);
  const off = path.join(alice.home, "offline.cbproj");
  await alice.call("projects.saveArchive", id, off);
  const z = S.zipOf(off);
  assert.ok(!z.names.includes(SHALLOW) && !z.names.includes(FULL), "no history while an edit waits: " + JSON.stringify(z.names));
  assert.ok(!z.names.some((n) => n.startsWith(".carton")), JSON.stringify(z.names));
  const project = JSON.parse(z.read("project.json").toString("utf8")).project;
  assert.equal(S.textOf(project).textContent, "Written offline", "the file still holds what Alice sees");
  assert.match(alice.worker().stderr(), /saved without its history: 1 edit is still waiting to sync/);
  // The same from cb, with the app open (round 4 #1, #2). cb's handle has no sync: the edit waiting in the app's worker
  // is counted from the store, so the file has no history either; and cb's save before the export, which changes
  // nothing, gets the holder's head with its answer, so Alice's file keeps the edit (it went back to "Hello" before).
  const cliOff = path.join(alice.home, "offline-cli.cbproj");
  const cli = alice.cb(["project", "save-as", "Demo", cliOff], { CARTON_CBPROJ_HISTORY: "1" });
  assert.equal(cli.code, 0, cli.out + cli.err);
  const zc = S.zipOf(cliOff);
  assert.ok(!zc.names.some((n) => n.startsWith(".carton")), "cb's file has no history while an edit waits: " + JSON.stringify(zc.names));
  assert.equal(S.textOf(JSON.parse(zc.read("project.json").toString("utf8")).project).textContent, "Written offline");
  assert.match(cli.err + cli.out, /saved without its history: 1 edit is still waiting to sync/);
  assert.equal(S.textOf(S.fileOf(alice)).textContent, "Written offline", "Alice's file keeps the edit");
  assert.equal(S.textOf(await S.projectOf(alice, id)).textContent, "Written offline", "and so does the app");
  assert.equal((await alice.call("carton.liveStatus", { projectId: id })).pending, 1, "still the one edit waiting");

  host = await S.startHost(path.join(S.TMP, "host-cbproj"), port);
  await S.until(async () => { const s = await alice.call("carton.liveStatus", { projectId: id }); return s.status === "up-to-date" && !s.pending; }, 60_000, "alice synced");
  const on = path.join(alice.home, "online.cbproj");
  await alice.call("projects.saveArchive", id, on);
  const z2 = S.zipOf(on);
  assert.ok(z2.names.includes(SHALLOW) && z2.names.includes(FULL), JSON.stringify(z2.names));
  // the export's head is the synced edit
  const pkg = JSON.parse(z2.read(SHALLOW).toString("utf8"));
  assert.match(JSON.stringify(pkg.states[pkg.headHash]), /Written offline/);
});

test("Save As takes the files Carton rewrites as they were when Cardboard listed them: a rewrite before their turn in the zip can't fail it", t, async () => {
  // CI Linux (cbproj.test step 6): an agent's cb edit reached timeline.tsx during Bob's Save As; Cardboard's zip writer
  // (yazl's addFile: the size when listed, the bytes at the file's turn) threw on an emitter nothing listens to, and the
  // library worker went down. The Save As hook (cbproj.js exportEntries) now hands those files over read whole.
  S.facade(b);
  const api = globalThis.__cartonCbproj;
  const dir = path.join(S.TMP, "saveas-as-listed.cardboard");
  fs.rmSync(dir, { recursive: true, force: true });
  const files = {
    "timeline.tsx": "export default <timeline />;\n",
    "project.json": JSON.stringify({ format: "cardboard-project", version: 1, project: { id: "p" } }),
    ".scratch/views/turn.tsx": "// cardboard:rev x\nexport default <timeline />;\n",
    ".scratch/views/turn.status": '{"status":"applied"}',
    ".scratch/views/gone.status": '{"status":"pending"}',
    "media/clip.mp4": "0123456789",
    "notes.md": "the person's notes",
  };
  for (const [rel, text] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true }); fs.writeFileSync(path.join(dir, rel), text); }
  const listed = Object.keys(files).map((rel) => ({ archivePath: rel, sourcePath: path.join(dir, rel), size: fs.statSync(path.join(dir, rel)).size }));
  fs.rmSync(path.join(dir, ".scratch/views/gone.status")); // removed by Carton after the walk listed it
  const out = await api.exportEntries(dir, listed);
  // then Carton rewrites them (another size each) before the zip reaches them
  for (const rel of ["timeline.tsx", "project.json", ".scratch/views/turn.tsx", ".scratch/views/turn.status"]) fs.writeFileSync(path.join(dir, rel), files[rel] + "// rewritten, longer\n");
  const by = new Map(out.map((e) => [e.archivePath, e]));
  for (const rel of ["timeline.tsx", "project.json", ".scratch/views/turn.tsx", ".scratch/views/turn.status"]) {
    const e = by.get(rel);
    assert.ok(e?.bytes, rel + " goes in as a buffer: " + JSON.stringify(e && { ...e, bytes: undefined }));
    assert.equal(Buffer.from(e.bytes).toString("utf8"), files[rel], rel + " as it was when listed");
    assert.equal(e.size, Buffer.byteLength(files[rel]), rel + "'s size is its bytes'");
  }
  assert.ok(!by.has(".scratch/views/gone.status"), "a file gone since the walk is left out");
  for (const rel of ["media/clip.mp4", "notes.md"]) assert.deepEqual(by.get(rel), listed.find((e) => e.archivePath === rel), rel + " stays Cardboard's entry");
});
