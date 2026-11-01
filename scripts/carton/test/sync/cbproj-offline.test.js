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
