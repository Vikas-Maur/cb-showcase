// A fold that keeps a track out, raced by a teammate (laptop rehearsal, 2026-11-07): the agent made its reject list
// (the chat's track, its title, the title's text entry), then the teammate added another title on that track, then
// `cb fold "Main cut" --into "<cut>" --reject tracks/<Talk> …` kept Talk out but brought the newer title in, pointing at
// no track: Cardboard's print put it on a made-up "Missing track". It stays out with its track now, with its own text
// entry, cb says so, and History counts it as left out. Real work on a track that comes in still comes.
// Through Cardboard 1.4.0's real (patched) library workers, two computers sharing through a real Carton host, and
// Cardboard's real cb, as the rehearsal's agent ran it.
//   CARDBOARD_PRISTINE=<Cardboard 1.4.0 unpacked> node --test --test-concurrency=1 scripts/carton/test/sync/fold-kept-out.test.js
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs"), path = require("path");
const { spawnSync } = require("child_process");
const { randomUUID } = require("crypto");
const S = require("./support.js");

const t = { skip: S.skip || S.noBuild, timeout: S.TEST_MS };
const SCOPE = { ownedFields: ["tracks", "timelineItems"] };
let b, host, alice, bob, id;

test.before(async () => {
  if (t.skip) return;
  b = await S.build();
  host = await S.startHost(path.join(S.TMP, "fold-kept-out-host"));
  alice = await S.computer("fold-kept-out-alice", b);
  bob = await S.computer("fold-kept-out-bob", b);
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

const must = (r, what) => { assert.equal(r.code, 0, what + ": " + r.out + r.err); return r; };
const latest = (pc, cut = "Main cut") => pc.cb(["history", "Demo", "--cut", cut, "--limit", "1"]).json().versions[0].version;
/** A title on a track (made when missing, as the rig's `say` does), by a GUI save: its item and its own text entry. */
async function say(pc, words, trackName) {
  const doc = await S.projectOf(pc, id);
  let track = doc.tracks.find((x) => x.name === trackName);
  const tracks = track ? doc.tracks : [...doc.tracks, (track = { id: randomUUID(), name: trackName, order: doc.tracks.length, locked: false, visible: true, muted: false })];
  const mediaId = randomUUID(), now = new Date().toISOString();
  const entry = { id: mediaId, createdAt: now, addedAt: now, data: { type: "text", presetId: "custom", content: words, fileName: "Text: " + words, format: "text", size: 0 } };
  const item = { id: randomUUID(), trackId: track.id, type: "text", startTime: 4, endTime: 6, trimStart: 0, trimEnd: 2, name: words, textContent: words, mediaItemId: mediaId, fontSize: 52 };
  await pc.call("projects.updateScoped", { ...doc, tracks, timelineItems: [...doc.timelineItems, item], media: [...doc.media, entry], stateUpdatedAt: Math.max(Date.now(), doc.stateUpdatedAt + 1) }, { ...SCOPE, ownedMediaIds: [mediaId], carton: { base: doc.stateUpdatedAt, actor: "person" } });
  return { track: track.id, item: item.id, media: mediaId };
}
const settled = (pc) => S.until(async () => { const s = await pc.call("carton.liveStatus", { projectId: id }); return s.status === "up-to-date" && s.pending === 0; }, 20_000, pc.name + " up to date");

test("cb fold --reject of a track keeps out a title added on it after the list was made, with its entry; cb and History say so", t, async () => {
  // Alice's own cut, from before the chat
  const before = latest(alice);
  must(alice.cb(["cut", "new", "Demo", "Alice's cut", "--from", before]), "cut new");
  // the chat begins on Main: Bob's title on a new "Talk" track
  const chat = await say(bob, "Psst. Anyone here?", "Talk");
  await settled(bob);
  await S.until(() => latest(alice) !== before, 20_000, "the chat at alice's");
  // the agent's reject list, from what it can see now (the rehearsal's agent_hide)
  const reject = [`tracks/${chat.track}`, `timelineItems/${chat.item}`, `media/${chat.media}`];
  // the race: Bob says more on Talk, and does real work on the footage track, before the fold runs
  const more = await say(bob, "Hello again?", "Talk");
  await S.guiSave(bob, id, (it) => (it.type === "video" ? { ...it, opacity: 0.8 } : null));
  await settled(bob);
  await S.until(() => alice.cb(["history", "Demo", "--cut", "Main cut", "--limit", "3"]).json().versions.filter((v) => v.by?.id === "Bob").length >= 2, 20_000, "bob's newer edits at alice's");
  // as the rehearsal's agent ran it (text, not --json)
  const r = spawnSync(process.execPath, [path.join(b.cli, "cardboard.mjs"), "--root", alice.root, "fold", "Demo", "Main cut", "--into", "Alice's cut", ...reject.flatMap((p) => ["--reject", p])], { env: { ...alice.env, CARDBOARD_ACTOR: "director/chat1/hide" }, encoding: "utf8", timeout: 120_000 });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  must(alice.cb(["cut", "switch", "Demo", "Alice's cut"]), "switch");
  await S.until(() => { const f = S.fileOf(alice); return !f.timelineItems.some((i) => i.name === "Psst. Anyone here?") && f.timelineItems.find((i) => i.type === "video")?.opacity === 0.8; }, 20_000, "alice's cut in her project.json");
  await S.sleep(500);
  const f = S.fileOf(alice);
  const tracks = new Set(f.tracks.map((x) => x.id));
  assert.deepEqual(f.timelineItems.filter((i) => !tracks.has(i.trackId)).map((i) => i.name), [], "no clip on a track the cut doesn't have");
  assert.ok(!f.tracks.some((x) => x.name === "Talk"), "no Talk track");
  assert.ok(!f.timelineItems.some((i) => i.name === "Hello again?"), "the newer title stayed out");
  assert.ok(!f.media.some((m) => m.id === chat.media || m.id === more.media), "no chat text in the media bin");
  assert.equal(f.timelineItems.find((i) => i.type === "video")?.opacity, 0.8, "Bob's real work came in");
  const tsx = must(alice.cb(["source", "print", "Demo"]), "print").out;
  assert.doesNotMatch(tsx, /Missing track/, "Cardboard's print has no made-up track");
  assert.match(r.stdout, new RegExp(`and with them, since they can't come in without them: .*timelineItems/${more.item}`), "cb says what it kept out with them: " + r.stdout);
  // History's row: the fold, with what it left out
  const row = alice.cb(["history", "Demo", "--cut", "Alice's cut", "--limit", "1"]).json().versions[0];
  assert.ok(row.leftOut?.includes(`timelineItems/${more.item}`) && row.leftOut?.includes(`media/${more.media}`), JSON.stringify(row));
});
