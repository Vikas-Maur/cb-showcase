// Cardboard's background writes on a shared cut (demo rehearsal, scripts/demo/FINDINGS.md §6.1): a sound imported the way
// the editor imports a dropped file (the worker's `ingest`, whose derive then writes the waveform and album art into
// project.json in the background), or a media file relinked (a new date on every project that uses it, then the derive),
// changes only what Carton doesn't version: an empty commit, whose rev history never recorded. The next change a
// teammate made then reached this computer's head, its materialization read the file, took it for an outside save, and
// imported it over head: the teammate's change was deleted for everyone by "external:project.json" (11 of 12 runs).
// Now every write's rev is recorded, an empty one's too: the teammate's change stays, the derive's fields stay, and a real
// outside save (another program writing project.json) is still taken as one.
// Through Cardboard 1.4.0's real (patched) library workers, two computers sharing through a real Carton host.
//   CARDBOARD_PRISTINE=<Cardboard 1.4.0 unpacked> node --test --test-concurrency=1 scripts/carton/test/sync/derive-race.test.js
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs"), path = require("path");
const { execFileSync } = require("child_process");
const { randomUUID } = require("crypto");
const S = require("./support.js");

const t = { skip: S.skip || S.noBuild, timeout: S.TEST_MS };
const SCOPE = { ownedFields: ["tracks", "timelineItems"] };
let b, host, alice, bob, id, wav;

test.before(async () => {
  if (t.skip) return;
  b = await S.build();
  host = await S.startHost(path.join(S.TMP, "derive-race-host"));
  alice = await S.computer("derive-race-alice", b);
  bob = await S.computer("derive-race-bob", b);
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
  wav = path.join(S.TMP, "derive-race-line.wav");
  if (!fs.existsSync(wav)) execFileSync(process.env.CARDBOARD_FFMPEG ?? "ffmpeg", ["-loglevel", "error", "-f", "lavfi", "-i", "sine=frequency=330:duration=4", "-ac", "1", "-ar", "44100", wav]);
}, { timeout: S.SETUP_MS });
test.after(async () => {
  for (const pc of [alice, bob]) if (pc?.worker()) fs.writeFileSync(path.join(S.TMP, pc.name + "-worker.log"), pc.worker().stderr());
  for (const pc of [alice, bob]) pc?.kill();
  S.killHelpers();
  await host?.stop().catch(() => {});
}, { timeout: S.STOP_MS });

// Alice's project.json read off her disk, never through her worker or a cb: a read through the store is what imports
// an unknown file, and would hide the bug (an import while head still equals the file changes nothing).
const aliceFile = () => S.fileOf(alice);
const readyAt = (pc) => S.until(async () => { const s = await pc.call("carton.liveStatus", { projectId: id }); return s.status === "up-to-date" && s.pending === 0; }, 20_000, pc.name + " up to date");
/** A title added by a GUI save, as the editor saves one: its item and its text entry (Cardboard's shape for a <text>). */
async function addTitle(pc, words) {
  const doc = await S.projectOf(pc, id);
  const track = doc.tracks.find((x) => x.name === "Titles") ?? doc.tracks[0];
  const mediaId = randomUUID(), now = new Date().toISOString();
  const entry = { id: mediaId, createdAt: now, addedAt: now, data: { type: "text", presetId: "custom", content: words, fileName: "Text: " + words, format: "text", size: 0 } };
  const item = { id: randomUUID(), trackId: track.id, type: "text", startTime: 3, endTime: 4, trimStart: 0, trimEnd: 1, name: words, textContent: words, mediaItemId: mediaId, fontSize: 60 };
  await pc.call("projects.updateScoped", { ...doc, timelineItems: [...doc.timelineItems, item], media: [...(doc.media ?? []), entry], stateUpdatedAt: Math.max(Date.now(), doc.stateUpdatedAt + 1) }, { ...SCOPE, ownedMediaIds: [mediaId], carton: { base: doc.stateUpdatedAt, actor: "person" } });
  return item.id;
}
/**
 * Bob's change reaches history, and stays: no outside save took it out since `since`, and it is in Alice's project.json
 * and at Bob's a few seconds later (the deletion came with the materialization of Bob's change at Alice's, within a few
 * hundred ms: FINDINGS §6.1).
 */
async function teammateKept(title, since) {
  const fresh = () => bob.cb(["history", "Demo", "--limit", "12"]).json().versions.filter((v) => Number(v.version.split("@")[1]) > since);
  await S.until(() => fresh().some((v) => v.by?.id === "Bob"), 20_000, "bob's change in history");
  await S.sleep(2500);
  await readyAt(alice);
  await readyAt(bob);
  const h = fresh();
  assert.deepEqual(h.filter((v) => /^external:/.test(v.by?.id ?? "")).map((v) => v.version), [], "no outside save since: " + JSON.stringify(h.map((v) => [v.version, v.by?.id])));
  assert.ok(aliceFile().timelineItems.some((i) => i.name === title), "bob's title in alice's project.json");
  assert.ok((await S.projectOf(bob, id)).timelineItems.some((i) => i.name === title), "bob's title at bob's");
}
const headSeq = () => Number(bob.cb(["history", "Demo", "--limit", "1"]).json().versions[0].version.split("@")[1]);

test("an import's background derive (waveform, album art) never deletes the change a teammate makes next", t, async () => {
  await readyAt(alice);
  const since = headSeq();
  // the editor's import of a dropped file (main's `ingest`: the derive runs in the background), and its clip at once
  const callId = (alice.events().filter((e) => e.kind === "ingest").length);
  const { items: [media] } = await alice.call("ingest", id, [wav]);
  assert.ok(media?.id, "imported");
  const doc = await S.projectOf(alice, id);
  const track = { id: randomUUID(), name: "Voice", order: doc.tracks.length, locked: false, visible: true, muted: false, type: "audio" };
  const clip = { id: randomUUID(), trackId: track.id, type: "audio", startTime: 5, endTime: 9, trimStart: 0, trimEnd: 4, mediaItemId: media.id, name: "A line" };
  await alice.call("projects.updateScoped", { ...doc, tracks: [...doc.tracks, track], timelineItems: [...doc.timelineItems, clip], stateUpdatedAt: Math.max(Date.now(), doc.stateUpdatedAt + 1) }, { ...SCOPE, carton: { base: doc.stateUpdatedAt, actor: "person" } });
  // the derive done: its waveform in Alice's file, and nothing written after it
  await S.until(() => alice.events().filter((e) => e.kind === "ingest").slice(callId).some((e) => e.event?.phase === "done"), 30_000, "the import's background work done");
  await S.until(() => aliceFile().media.find((m) => m.id === media.id)?.data?.waveformGenerationStatus === "complete", 20_000, "the derive's waveform in alice's project.json");
  await S.sleep(500);
  const title = "From Bob after the import";
  await addTitle(bob, title);
  await teammateKept(title, since);
  // and the derive's own result stays: its fields aren't versioned, so only Alice's file holds them
  const entry = aliceFile().media.find((m) => m.id === media.id);
  assert.equal(entry?.data?.waveformGenerationStatus, "complete", JSON.stringify(entry?.data));
  assert.ok(entry?.data?.waveformId, "the waveform kept");
  assert.ok(aliceFile().timelineItems.some((i) => i.id === clip.id), "alice's clip of the sound kept");
});

// The derive main asks for at a session's first save (ensureDerived), and the one Carton runs after a teammate's media
// lands (deriveMedia): an entry without its waveform gets it, in a write that changes nothing Carton versions. (Stood
// for here by an entry whose artefacts a whole-project write took out; main's call made as main makes it.) A relink's own write is one
// too, but the derive that follows it reads the file at once, which recorded it before a teammate's change could come.
test("the derive main asks for (an entry without its waveform) never deletes the change a teammate makes next", t, async () => {
  await readyAt(alice);
  const doc = await S.projectOf(alice, id);
  const entry = doc.media.find((m) => m.data?.waveformId);
  assert.ok(entry, "a media entry with a waveform (the test before imported one)");
  const bare = { ...entry, data: Object.fromEntries(Object.entries(entry.data).filter(([k]) => !/^(waveform|albumArt)/.test(k))) };
  // (a whole-project write: a GUI save keeps what the editor drops, these fields too)
  await alice.call("projects.write", { ...doc, media: doc.media.map((m) => (m.id === entry.id ? bare : m)), stateUpdatedAt: Math.max(Date.now(), doc.stateUpdatedAt + 1) });
  await S.until(() => !aliceFile().media.find((m) => m.id === entry.id)?.data?.waveformId, 10_000, "the entry without its waveform in alice's file");
  await readyAt(alice);
  const since = headSeq();
  assert.equal((await alice.call("ensureDerived", id))?.documentUpdated, true, "the derive wrote the project");
  await S.until(() => aliceFile().media.find((m) => m.id === entry.id)?.data?.waveformGenerationStatus === "complete", 10_000, "the derive's waveform in alice's project.json");
  await S.sleep(500);
  const title = "From Bob after the derive";
  await addTitle(bob, title);
  await teammateKept(title, since);
  assert.ok(aliceFile().media.find((m) => m.id === entry.id)?.data?.waveformId, "the derive's waveform kept");
});

test("a real outside save (another program writes project.json) is still taken as one, and reaches the teammate", t, async () => {
  await readyAt(alice);
  const file = path.join(alice.root, "Demo.cardboard", "project.json");
  const env = JSON.parse(fs.readFileSync(file, "utf8"));
  const text = env.project.timelineItems.find((i) => i.name === "Hello");
  text.textContent = "From another program";
  env.project.stateUpdatedAt = Date.now();
  env.project.updatedAt = new Date().toISOString();
  fs.writeFileSync(file + ".other.tmp", JSON.stringify(env));
  fs.renameSync(file + ".other.tmp", file);
  // the editor reads it (as on a watcher event), and the worker finds a file Carton didn't write
  await alice.call("projects.read", id);
  await S.until(async () => (await S.projectOf(bob, id)).timelineItems.find((i) => i.id === text.id)?.textContent === "From another program", 20_000, "the outside save at bob's");
  const top = bob.cb(["history", "Demo", "--limit", "1"]).json().versions[0];
  assert.match(top.by?.id ?? "", /^external:project\.json/, JSON.stringify(top));
});
