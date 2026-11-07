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
  // review 2's fault injection, off until a test makes the file: another program replaces project.json the moment
  // Carton has linked it into place
  alice.env.NODE_OPTIONS = `${alice.env.NODE_OPTIONS ?? ""} --require ${path.join(__dirname, "install-race.cjs")}`.trim();
  alice.env.CARTON_TEST_INSTALL_RACE = path.join(S.TMP, "derive-race-install-race");
  for (const f of [alice.env.CARTON_TEST_INSTALL_RACE, alice.env.CARTON_TEST_INSTALL_RACE + ".hit"]) fs.rmSync(f, { force: true });
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

// Review of fix/demo-sync-bugs, P1: an empty write's rev is recorded now, and a rev Carton knows was trusted without a
// look at the file. Another program that edits project.json and keeps its rev had its edit dropped at the next
// materialization (the reviewer's repro: it passes on 0c498b2b and failed on 58077096). The file is that version only
// while what Carton versions of it is that version's; otherwise its edit is imported against that version.
test("an outside edit that keeps the file's rev, after an empty background write, is taken as an edit and kept", t, async () => {
  await readyAt(alice);
  await S.sleep(2500);
  const doc = await S.projectOf(alice, id);
  // an empty whole-project write (as a background write is): its rev recorded
  await alice.call("projects.write", { ...doc, stateUpdatedAt: Math.max(Date.now(), doc.stateUpdatedAt + 1) });
  await S.sleep(300);
  const since = headSeq();
  const file = path.join(alice.root, "Demo.cardboard", "project.json");
  const env = JSON.parse(fs.readFileSync(file, "utf8"));
  const text = env.project.timelineItems.find((i) => i.name === "Hello");
  text.textContent = "Outside program kept the rev";
  fs.writeFileSync(file + ".other.tmp", JSON.stringify(env));
  fs.renameSync(file + ".other.tmp", file);
  await alice.call("projects.read", id);
  const title = "A teammate after the outside edit";
  await addTitle(bob, title);
  await S.until(() => aliceFile().timelineItems.some((i) => i.name === title), 20_000, "bob's title in alice's file");
  await S.sleep(2500);
  assert.equal(aliceFile().timelineItems.find((i) => i.id === text.id)?.textContent, "Outside program kept the rev", "the outside edit stays in alice's file");
  await S.until(async () => (await S.projectOf(bob, id)).timelineItems.find((i) => i.id === text.id)?.textContent === "Outside program kept the rev", 20_000, "the outside edit at bob's");
  assert.ok((await S.projectOf(bob, id)).timelineItems.some((i) => i.name === title), "bob's title kept");
  const h = bob.cb(["history", "Demo", "--limit", "8"]).json().versions.filter((v) => Number(v.version.split("@")[1]) > since);
  assert.ok(h.some((v) => /^external:project\.json/.test(v.by?.id ?? "")), "taken as an outside save: " + JSON.stringify(h.map((v) => [v.version, v.by?.id])));
});

// An outside save with a new rev, made while a teammate's change has reached this computer's head but not yet its file
// (the materialization held): imported as what it changed against the version the file showed, so the teammate's change
// stays. On head (as before), the outside program's older document took the teammate's change out.
test("an outside save made while a teammate's change is on its way into the file keeps both", t, async () => {
  await readyAt(alice);
  await readyAt(bob);
  await S.sleep(1000);
  await alice.call("test.holdMaterialize");
  const title = "A teammate while another program saves";
  await addTitle(bob, title);
  await S.until(() => alice.call("test.materializeHeld"), 20_000, "alice's materialization of bob's change held");
  // another program edits the file as it is (without bob's title), with a new rev
  const file = path.join(alice.root, "Demo.cardboard", "project.json");
  const env = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.ok(!env.project.timelineItems.some((i) => i.name === title), "the file doesn't show bob's title yet");
  const text = env.project.timelineItems.find((i) => i.name === "Hello");
  text.fontSize = 77;
  env.project.stateUpdatedAt = Date.now();
  fs.writeFileSync(file + ".other.tmp", JSON.stringify(env));
  fs.renameSync(file + ".other.tmp", file);
  await alice.call("projects.read", id);
  await alice.call("test.releaseMaterialize");
  await S.until(() => { const f = aliceFile(); return f.timelineItems.some((i) => i.name === title) && f.timelineItems.find((i) => i.id === text.id)?.fontSize === 77; }, 20_000, "both in alice's file");
  await S.sleep(2000);
  for (const d of [aliceFile(), await S.projectOf(bob, id)]) {
    assert.ok(d.timelineItems.some((i) => i.name === title), "bob's title kept");
    assert.equal(d.timelineItems.find((i) => i.id === text.id)?.fontSize, 77, "the outside edit kept");
  }
});

// Review 2 of fix/demo-sync-bugs, P1: the journal's stamp of Carton's last install vouched for the file without its bytes.
// (1) Another program replaced project.json the moment Carton linked it, before the stamp was taken: that program's
// file went into the journal as Carton's. (2) An in-place edit that kept the size and the mtime kept the stamp. After a
// restart either was taken for Carton's own file and lost at a teammate's next change (both passed on f3d1dc2b, the
// content check before the journal). Now only checked bytes are journaled, with their hash, and a stamp alone proves
// nothing. The reviewer's repros, with Alice's live sync started again and both up to date.
const restartAlice = async () => {
  await alice.stopWorker();
  await alice.startWorker();
  await alice.call("projects.read", id);
  await readyAt(alice);
  await readyAt(bob);
};
const helloAt = () => aliceFile().timelineItems.find((i) => i.name === "Hello")?.textContent;
test("another program's file put in place right after Carton's install is never taken for Carton's, also after a restart", t, async () => {
  await readyAt(alice);
  await readyAt(bob);
  await S.sleep(2500);
  const flag = alice.env.CARTON_TEST_INSTALL_RACE;
  fs.writeFileSync(flag, "go");
  const doc = await S.projectOf(alice, id);
  await alice.call("projects.write", { ...doc, stateUpdatedAt: Math.max(Date.now(), doc.stateUpdatedAt + 1) });
  assert.ok(fs.existsSync(flag + ".hit"), "the other program's file landed right after Carton's install");
  fs.rmSync(flag + ".hit", { force: true });
  await restartAlice();
  const title = "Bob after the install race";
  await addTitle(bob, title);
  await S.until(() => aliceFile().timelineItems.some((i) => i.name === title), 20_000, "bob's title in alice's file");
  await S.sleep(2500);
  assert.equal(helloAt(), "Concurrent outside edit", "the other program's edit kept");
  assert.ok(aliceFile().timelineItems.some((i) => i.name === title), "bob's title kept");
});

test("an in-place edit that keeps the file's size and mtime is still checked after a restart", t, async () => {
  await readyAt(alice);
  await readyAt(bob);
  await S.sleep(2500);
  const doc = await S.projectOf(alice, id);
  await alice.call("projects.write", { ...doc, stateUpdatedAt: Math.max(Date.now(), doc.stateUpdatedAt + 1) });
  await S.sleep(300);
  await alice.stopWorker();
  const file = path.join(alice.root, "Demo.cardboard", "project.json"), was = fs.statSync(file, { bigint: true });
  const text = fs.readFileSync(file, "utf8"), now = helloAt();
  const esc = (x) => x.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const changed = text.replace(new RegExp(`("textContent"\\s*:\\s*)${esc(JSON.stringify(now))}`), `$1${JSON.stringify("X".repeat(now.length))}`);
  assert.notEqual(changed, text);
  assert.equal(Buffer.byteLength(changed), Buffer.byteLength(text));
  fs.writeFileSync(file, changed);
  execFileSync("python3", ["-c", "import os,sys;os.utime(sys.argv[1],ns=(int(sys.argv[2]),int(sys.argv[3])))", file, String(was.atimeNs), String(was.mtimeNs)]);
  const st = fs.statSync(file, { bigint: true });
  assert.equal(`${st.ino}:${st.size}:${st.mtimeNs}`, `${was.ino}:${was.size}:${was.mtimeNs}`, "the same stamp");
  await alice.startWorker();
  await alice.call("projects.read", id);
  await readyAt(alice);
  await readyAt(bob);
  const title = "Bob after the same-stamp edit";
  await addTitle(bob, title);
  await S.until(() => aliceFile().timelineItems.some((i) => i.name === title), 20_000, "bob's title in alice's file");
  await S.sleep(2500);
  assert.equal(helloAt(), "X".repeat(now.length), "the in-place edit kept");
});

// Review 2, P1: an outside edit of a file whose rev names an older version still waiting for the sharing server (more
// edits wait after it) wasn't taken: core can't rebuild that state from its seq, the file was marked checked, and the
// next materialization wrote over it. That file's bytes are kept now (.carton/bases, by its rev), and the edit is taken
// at once against exactly them, after a restart too.
async function pendingOutside(restart) {
  await readyAt(alice);
  await readyAt(bob);
  await S.sleep(2500);
  const port = host.port;
  await host.stop();
  await S.until(async () => (await alice.call("carton.liveStatus", { projectId: id })).status === "offline", 20_000, "offline");
  const words = restart ? "Alice offline two" : "Alice offline one";
  await S.guiSave(alice, id, (it) => (it.name === "Hello" ? { ...it, textContent: words } : null));
  const doc = await S.projectOf(alice, id);
  await alice.call("projects.write", { ...doc, stateUpdatedAt: Math.max(Date.now(), doc.stateUpdatedAt + 1) });
  const file = path.join(alice.root, "Demo.cardboard", "project.json");
  const old = JSON.parse(fs.readFileSync(file, "utf8"));
  const size = restart ? 177 : 199;
  await S.guiSave(alice, id, (it) => (it.name === "Hello" ? { ...it, fontSize: size } : null));
  const outside = restart ? "Outside edit while offline, then a restart" : "Outside edit of a pending version";
  old.project.timelineItems.find((i) => i.name === "Hello").textContent = outside;
  fs.writeFileSync(file + ".other.tmp", JSON.stringify(old));
  fs.renameSync(file + ".other.tmp", file);
  if (restart) {
    await alice.stopWorker();
    await alice.startWorker();
    await S.sleep(1000);
  }
  await alice.call("projects.read", id);
  await S.sleep(500);
  if (restart) assert.equal(helloAt(), outside, "taken at once, against that file's kept bytes: nothing wrote over it");
  host = await S.startHost(path.join(S.TMP, "derive-race-host"), port);
  await readyAt(alice);
  await readyAt(bob);
  const title = restart ? "Bob after the held outside edit" : "Bob after the pending outside edit";
  await addTitle(bob, title);
  await S.until(() => aliceFile().timelineItems.some((i) => i.name === title), 30_000, "bob's title in alice's file");
  await S.sleep(2500);
  const item = aliceFile().timelineItems.find((i) => i.name === "Hello");
  assert.equal(item.textContent, outside, "the outside edit kept");
  assert.equal(item.fontSize, size, "alice's later edit kept");
  const atBob = (await S.projectOf(bob, id)).timelineItems.find((i) => i.name === "Hello");
  assert.deepEqual([atBob.textContent, atBob.fontSize], [outside, size], "both at bob's");
}
test("an outside edit of an older version still waiting for the sharing server is taken against exactly it", t, () => pendingOutside(false));
test("the same after a restart while offline: that file's bytes are kept, the edit taken against them", t, () => pendingOutside(true));

// Review 3 of fix/demo-sync-bugs (its three controls). The pending version an outside save was made on came from a cache
// that unchanged background writes evicted; a background write then took the unimported outside file as its own base and
// certified it (P1: also after an offline restart, on 0c498b2b too); and with the version gone, a file held for it never
// resolved once Bob's edit confirmed between Alice's (P2: Alice's file stayed behind while Live said up to date). The
// file's bytes are kept now (.carton/bases, by its rev), and an outside save is taken at once against them.
const unchangedWrites = async (n) => {
  for (let j = 0; j < n; j++) {
    const unchanged = await S.projectOf(alice, id);
    await alice.call("projects.write", { ...unchanged, stateUpdatedAt: Math.max(Date.now(), unchanged.stateUpdatedAt + 1) });
  }
};
async function backgroundAfterOutside({ restart, evict, interleave }) {
  await readyAt(alice);
  await readyAt(bob);
  await S.sleep(2500);
  const port = host.port;
  await host.stop();
  await S.until(async () => (await alice.call("carton.liveStatus", { projectId: id })).status === "offline", 20_000, "offline");
  const words = `Alice pending ${restart ? "R" : ""}${evict ? "E" : ""}${interleave ? "I" : ""}`;
  await S.guiSave(alice, id, (it) => (it.name === "Hello" ? { ...it, textContent: words } : null));
  await unchangedWrites(1);
  const file = path.join(alice.root, "Demo.cardboard", "project.json");
  const old = JSON.parse(fs.readFileSync(file, "utf8"));
  const size = 150 + (restart ? 1 : 0) + (evict ? 2 : 0) + (interleave ? 4 : 0);
  await S.guiSave(alice, id, (it) => (it.name === "Hello" ? { ...it, fontSize: size } : null));
  if (evict) await unchangedWrites(20);
  // Bob's own offline title reaches the server before Alice's pending edits
  if (interleave) await addTitle(bob, "Bob confirms before Alice");
  const outside = `Outside save ${words}`;
  old.project.timelineItems.find((i) => i.name === "Hello").textContent = outside;
  fs.writeFileSync(file + ".other.tmp", JSON.stringify(old));
  fs.renameSync(file + ".other.tmp", file);
  if (restart && !interleave) await restartWorker(alice);
  await alice.call("projects.read", id);
  // a background write after it (Cardboard's derive, a relink): it must not take the outside file for its base
  if (!interleave) await unchangedWrites(1);
  if (interleave) await alice.stopWorker();
  host = await S.startHost(path.join(S.TMP, "derive-race-host"), port);
  await readyAt(bob);
  if (interleave) { await alice.startWorker(); await alice.call("projects.read", id); }
  await readyAt(alice);
  const title = `Bob after ${words}`;
  await addTitle(bob, title);
  await S.until(() => aliceFile().timelineItems.some((i) => i.name === title), 30_000, "bob's title in alice's file");
  await S.sleep(2500);
  const st = await alice.call("carton.liveStatus", { projectId: id });
  for (const [who, d] of [["alice", aliceFile()], ["bob", await S.projectOf(bob, id)]]) {
    const item = d.timelineItems.find((i) => i.name === "Hello");
    assert.equal(item.textContent, outside, `${who}: the outside save kept`);
    assert.equal(item.fontSize, size, `${who}: alice's later edit kept`);
    assert.ok(d.timelineItems.some((i) => i.name === title), `${who}: bob's title`);
    if (interleave) assert.ok(d.timelineItems.some((i) => i.name === "Bob confirms before Alice"), `${who}: bob's offline title`);
  }
  assert.deepEqual([st.status, st.pending, st.problem], ["up-to-date", 0, null], "up to date, and it is");
}
const restartWorker = async (pc) => { await pc.stopWorker(); await pc.startWorker(); await S.sleep(1000); };
test("review 3, P1: a background write after an outside save of a pending version evicted by unchanged writes keeps it", t, () => backgroundAfterOutside({ evict: true }));
test("review 3, P1: the same after an offline restart", t, () => backgroundAfterOutside({ restart: true }));
test("review 3, P2: a pending version gone from memory, Bob's edit confirmed first, then a restart: nothing held, all of it shown", t, () => backgroundAfterOutside({ evict: true, interleave: true, restart: true }));

// Found in round 4 of fix/demo-sync-bugs, on 0c498b2b too: offline, the person's second GUI save of the same thing was
// made on a version still waiting for the server, which core rebuilds as its confirmed seq alone: it clashed with the
// first ("You" vs "You") and the timeline went back to the first value. It goes on the version the editor had now (the
// store's document, else that file's kept bytes). And an outside save of the earlier file is taken against that file's
// own bytes (kept by its rev), so the later save stays too, also after a restart.
async function twiceOffline(restart, between = false) {
  await readyAt(alice);
  await readyAt(bob);
  await S.sleep(2500);
  const port = host.port;
  await host.stop();
  await S.until(async () => (await alice.call("carton.liveStatus", { projectId: id })).status === "offline", 20_000, "offline");
  const first = between ? 141 : restart ? 131 : 121, later = first + 2;
  await S.guiSave(alice, id, (it) => (it.name === "Hello" ? { ...it, fontSize: first } : null));
  const file = path.join(alice.root, "Demo.cardboard", "project.json");
  const old = JSON.parse(fs.readFileSync(file, "utf8"));
  // nothing of the first save's held in memory: the second goes on what the store read back
  if (between) await restartWorker(alice);
  await S.guiSave(alice, id, (it) => (it.name === "Hello" ? { ...it, fontSize: later } : null));
  await S.sleep(500);
  assert.equal(aliceFile().timelineItems.find((i) => i.name === "Hello").fontSize, later, "the second save shows");
  assert.deepEqual(alice.cb(["conflicts", "Demo"]).json().cards, [], "no clash with the first");
  const outside = `Outside save of the first of two${restart ? ", then a restart" : ""}${between ? ", a restart between them" : ""}`;
  old.project.timelineItems.find((i) => i.name === "Hello").textContent = outside;
  fs.writeFileSync(file + ".other.tmp", JSON.stringify(old));
  fs.renameSync(file + ".other.tmp", file);
  if (restart) await restartWorker(alice);
  await alice.call("projects.read", id);
  host = await S.startHost(path.join(S.TMP, "derive-race-host"), port);
  await readyAt(alice);
  await readyAt(bob);
  const title = `Bob after ${outside}`;
  await addTitle(bob, title);
  await S.until(() => aliceFile().timelineItems.some((i) => i.name === title), 30_000, "bob's title in alice's file");
  await S.sleep(2500);
  for (const [who, d] of [["alice", aliceFile()], ["bob", await S.projectOf(bob, id)]]) {
    const item = d.timelineItems.find((i) => i.name === "Hello");
    assert.equal(item.textContent, outside, `${who}: the outside save kept`);
    assert.equal(item.fontSize, later, `${who}: alice's second save kept`);
  }
}
test("two offline saves of the same clip keep the second, and an outside save of the first file keeps both", t, () => twiceOffline(false));
test("the same with a restart after the outside save", t, () => twiceOffline(true));
test("the same with a restart between the two saves", t, () => twiceOffline(false, true));
