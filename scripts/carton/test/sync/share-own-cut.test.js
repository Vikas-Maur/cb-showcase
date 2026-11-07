// Share's status on a cut that isn't shared (demo rehearsal, scripts/demo/FINDINGS.md §4.4). After `cb cut switch` to a
// cut of the person's own, the shared cut stays connected and syncing, but Share showed the current cut's sync, which a
// local cut doesn't have: core says "Offline: 0 edits waiting", and the switch told the panel nothing, so it kept "Up to
// date" from before or turned amber "Offline" at the next event. Now Share (and the title bar's dot, from the same
// status) shows the shared cut's real state, and says the person is on a cut of their own (`ownCut`), until they switch
// back. What teammates see is unchanged.
// Through Cardboard 1.4.0's real (patched) library workers, two computers sharing through a real Carton host; the cut
// made and switched with Cardboard's own cb, as an agent does.
//   CARDBOARD_PRISTINE=<Cardboard 1.4.0 unpacked> node --test --test-concurrency=1 scripts/carton/test/sync/share-own-cut.test.js
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs"), path = require("path");
const S = require("./support.js");

const t = { skip: S.skip || S.noBuild, timeout: S.TEST_MS };
let b, host, alice, bob, id;

test.before(async () => {
  if (t.skip) return;
  b = await S.build();
  host = await S.startHost(path.join(S.TMP, "share-own-cut-host"));
  alice = await S.computer("share-own-cut-alice", b);
  bob = await S.computer("share-own-cut-bob", b);
  S.seed(alice, b);
  await alice.startWorker();
  await bob.startWorker();
  [{ id }] = await alice.call("projects.list");
  const r = await alice.call("carton.liveShare", { projectId: id, host: host.origin, adminToken: S.ADMIN, name: "Alice" });
  assert.equal(r.status, "shared", JSON.stringify(r));
  await S.until(async () => (await alice.call("carton.liveStatus", { projectId: id })).status === "up-to-date", 20_000, "alice shared and up to date");
  const { link } = await alice.call("carton.liveInvite", { projectId: id, role: "editor" });
  await bob.call("carton.liveJoin", { link, name: "Bob" });
  await S.until(async () => S.textOf(await S.projectOf(bob, id).catch(() => ({ timelineItems: [] }))), 30_000, "bob has the project");
}, { timeout: S.SETUP_MS });
test.after(async () => {
  for (const pc of [alice, bob]) if (pc?.worker()) fs.writeFileSync(path.join(S.TMP, pc.name + "-worker.log"), pc.worker().stderr());
  for (const pc of [alice, bob]) pc?.kill();
  S.killHelpers();
  await host?.stop().catch(() => {});
}, { timeout: S.STOP_MS });

/** What the Share dialog and the title bar's dot show: liveStatus when they open, then the live events they merge. */
const shown = () => alice.call("carton.liveStatus", { projectId: id });
const liveEvents = () => alice.events().filter((e) => e.change?.kind === "carton" && e.change.topic === "live" && e.change.id === id).map((e) => e.change.live);

test("on a cut of their own, Share shows the shared cut's real state (Offline only while it is) and says so; back on the shared cut, as before", t, async () => {
  const must = (r, what) => assert.equal(r.code, 0, what + ": " + r.out + r.err);
  must(alice.cb(["cut", "new", "Demo", "Alice's cut"]), "cut new");
  const from = liveEvents().length;
  must(alice.cb(["cut", "switch", "Demo", "Alice's cut"]), "cut switch");
  // the worker follows the switch (its follower, within a quarter second); the editor's project.json with it
  await S.sleep(1000);

  // Bob edits on Main: it arrives at Alice's (Main stays connected and syncing); Share says the shared cut is up to date
  await S.guiSave(bob, id, (it) => (it.type === "text" ? { ...it, textContent: "Bob on Main" } : null));
  await S.until(() => alice.cb(["history", "Demo", "--cut", "Main cut", "--limit", "1"]).json().versions[0]?.by?.id === "Bob", 20_000, "bob's edit in alice's Main cut");
  await S.sleep(1000);
  assert.ok(liveEvents().length > from, "live events since the switch");
  for (const x of liveEvents().slice(from)) assert.notEqual(x.status, "offline", "no event said Offline: " + JSON.stringify(x));
  assert.deepEqual([(await shown()).status, (await shown()).pending], ["up-to-date", 0]);

  // the shared cut's real state: the sharing server gone, Offline (it is); back, Up to date again (it said Offline on)
  const port = host.port;
  await host.stop();
  await S.until(async () => (await shown()).status === "offline", 20_000, "offline with the server gone");
  host = await S.startHost(path.join(S.TMP, "share-own-cut-host"), port);
  await S.until(async () => (await shown()).status === "up-to-date", 30_000, "up to date again with the server back, on alice's own cut");

  // and Share says she is on a cut of her own, told when it happened (an event the pages merge), not only when asked
  const st = await shown();
  assert.deepEqual(st.ownCut, { name: "Alice's cut", shared: "Main cut" }, JSON.stringify(st));
  assert.ok(liveEvents().slice(from).some((x) => x.ownCut?.name === "Alice's cut"), "a live event said so");

  // back on Main: as before, nothing about a cut of her own
  const m = liveEvents().length;
  must(alice.cb(["cut", "switch", "Demo", "Main cut"]), "switch back");
  await S.until(() => liveEvents().slice(m).some((x) => x.ownCut === null), 10_000, "a live event saying alice is back on the shared cut");
  const back = await shown();
  assert.deepEqual([back.status, back.ownCut], ["up-to-date", null], JSON.stringify(back));
});
