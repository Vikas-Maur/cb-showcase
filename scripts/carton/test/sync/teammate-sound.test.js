// A teammate's new sound in a shared project (demo rehearsal, scripts/demo/FINDINGS.md §6.2). Its clip can reach this
// computer before the teammate's app has sent the file: the first ask for it (main's, when the editor loads the clip)
// was answered "none", which main gives the editor as 1.4.0's "Source file missing", and that "none" was kept for 2 s;
// a sound (no proxy) was only ever looked for on the host, never in the project's own record of its share; and the
// sharer sent a new clip only once its editing had paused for 2 s. Now the first ask waits for the sound and is answered
// as soon as it is shared, the project's record counts, and a new sound or still is sent at once. A clip whose file was
// on this computer and is gone is still answered at once (Cardboard's own missing-file path).
// Through Cardboard 1.4.0's real (patched) library workers, two computers sharing through a real Carton host.
//   CARDBOARD_PRISTINE=<Cardboard 1.4.0 unpacked> node --test --test-concurrency=1 scripts/carton/test/sync/teammate-sound.test.js
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs"), path = require("path");
const { execFileSync } = require("child_process");
const { createHash, randomUUID } = require("crypto");
const S = require("./support.js");

const t = { skip: S.skip || S.noBuild, timeout: S.TEST_MS };
const SCOPE = { ownedFields: ["tracks", "timelineItems"] };
let b, host, alice, bob, id;
const stall = path.join(S.TMP, "teammate-sound-stall");

test.before(async () => {
  if (t.skip) return;
  b = await S.build();
  host = await S.startHost(path.join(S.TMP, "teammate-sound-host"));
  alice = await S.computer("teammate-sound-alice", b);
  bob = await S.computer("teammate-sound-bob", b);
  S.seed(alice, b);
  await alice.startWorker();
  // review P2's fault injection, off until a test makes the file: Bob's host reads of a clip's record never answer
  bob.env.NODE_OPTIONS = `${bob.env.NODE_OPTIONS ?? ""} --require ${path.join(__dirname, "stall-fetch.cjs")}`.trim();
  bob.env.CARTON_TEST_STALL = stall;
  for (const f of [stall, stall + ".hit"]) fs.rmSync(f, { force: true });
  await bob.startWorker();
  [{ id }] = await alice.call("projects.list");
  const r = await alice.call("carton.liveShare", { projectId: id, host: host.origin, adminToken: S.ADMIN, name: "Alice" });
  assert.equal(r.status, "shared", JSON.stringify(r));
  await S.until(async () => (await alice.call("carton.liveStatus", { projectId: id })).status === "up-to-date", 20_000, "alice shared and up to date");
  const { link } = await alice.call("carton.liveInvite", { projectId: id, role: "editor" });
  await bob.call("carton.liveJoin", { link, name: "Bob" });
  await S.until(async () => S.textOf(await S.projectOf(bob, id).catch(() => ({ timelineItems: [] }))), 30_000, "bob has the project");
  // Alice's clips shared before the tests start (the share's first run), so each test's sound is the only new one
  await S.sleep(3000);
}, { timeout: S.SETUP_MS });
test.after(async () => {
  for (const pc of [alice, bob]) if (pc?.worker()) fs.writeFileSync(path.join(S.TMP, pc.name + "-worker.log"), pc.worker().stderr());
  for (const pc of [alice, bob]) pc?.kill();
  S.killHelpers();
  await host?.stop().catch(() => {});
}, { timeout: S.STOP_MS });

const sha = (b) => createHash("sha256").update(b).digest("hex");
/** A short sound of its own (each test a new file, so nothing of it is on the host yet). */
function sound(name, hz) {
  const f = path.join(S.TMP, name + ".wav");
  if (!fs.existsSync(f)) execFileSync(process.env.CARDBOARD_FFMPEG ?? "ffmpeg", ["-loglevel", "error", "-f", "lavfi", "-i", `sine=frequency=${hz}:duration=3`, "-ac", "1", "-ar", "44100", f]);
  return f;
}
/** Cardboard's own `cb media add` (handed to Alice's worker, the lease holder), then its clip on the timeline at once. */
async function soundOnTimeline(file) {
  const had = new Set(S.fileOf(alice).media.map((m) => m.id));
  const r = alice.cb(["media", "add", "Demo", file]);
  assert.equal(r.code, 0, r.out + r.err);
  const mediaId = await S.until(() => S.fileOf(alice).media.find((m) => !had.has(m.id) && m.data?.type === "audio")?.id, 10_000, "the sound in alice's project");
  const doc = await S.projectOf(alice, id);
  const track = doc.tracks.find((x) => x.type === "audio") ?? { id: randomUUID(), name: "Voice", order: doc.tracks.length, locked: false, visible: true, muted: false, type: "audio" };
  const clip = { id: randomUUID(), trackId: track.id, type: "audio", startTime: 6, endTime: 9, trimStart: 0, trimEnd: 3, mediaItemId: mediaId, name: path.basename(file) };
  const tracks = doc.tracks.some((x) => x.id === track.id) ? doc.tracks : [...doc.tracks, track];
  await alice.call("projects.updateScoped", { ...doc, tracks, timelineItems: [...doc.timelineItems, clip], stateUpdatedAt: Math.max(Date.now(), doc.stateUpdatedAt + 1) }, { ...SCOPE, carton: { base: doc.stateUpdatedAt, actor: "person" } });
  return { mediaId, clip };
}
/** The bytes a tool reads of a teammate's clip, through Bob's worker (verified against its content id). */
async function bytesAtBob(mediaId) {
  const u = await bob.call("carton.liveMediaUrl", { mediaId });
  assert.ok(u?.url, "a loopback URL for the sound: " + JSON.stringify(u));
  return Buffer.from(await (await fetch(u.url)).arrayBuffer());
}

test("a teammate's new sound: the first ask for its clip, the moment the clip arrives, is answered with the sound once it is shared, never \"none\"", t, async (tc) => {
  const file = sound("teammate-sound-1", 523);
  const { mediaId, clip } = await soundOnTimeline(file);
  // the clip at Bob's: the editor would load it now (main asks the worker where it plays from)
  await S.until(() => S.fileOf(bob).timelineItems.some((i) => i.id === clip.id), 20_000, "the clip at bob's");
  const t0 = Date.now();
  const src = await bob.call("carton.liveMediaSource", { mediaId });
  const waited = Date.now() - t0;
  tc.diagnostic(`the first ask waited ${waited} ms for the sound`);
  assert.ok(src && src.size > 0, `the first ask is answered with the sound (after ${waited} ms): ` + JSON.stringify(src));
  assert.equal(sha(await bytesAtBob(mediaId)), sha(fs.readFileSync(file)), "the sound's own bytes");
});

test("the sharer sends a new sound at once, while the person goes on editing (not after the editing pauses)", t, async (tc) => {
  const file = sound("teammate-sound-2", 659);
  const t0 = Date.now();
  const { mediaId, clip } = await soundOnTimeline(file);
  // Alice keeps editing: a save every 400 ms for 4 s (each change put the share off by 2 s more)
  let editing = true;
  const edits = (async () => {
    for (let n = 0; editing && n < 10; n++) {
      await S.sleep(400);
      await S.guiSave(alice, id, (it) => (it.id === clip.id ? { ...it, volume: 50 + n } : null));
    }
  })();
  try {
    await S.until(() => S.fileOf(bob).timelineItems.some((i) => i.id === clip.id), 20_000, "the clip at bob's");
    const src = await bob.call("carton.liveMediaSource", { mediaId });
    const at = Date.now() - t0;
    tc.diagnostic(`at bob's ${at} ms after the import`);
    assert.ok(src && src.size > 0, "the sound, while alice is still editing: " + JSON.stringify(src));
    assert.ok(editing && at < 3500, `answered ${at} ms after the import, alice still editing`);
  } finally {
    editing = false;
    await edits;
  }
});

test("a clip whose file was on this computer and is gone is still answered at once (Cardboard's own missing-file path)", t, async () => {
  // Alice's own new clip, its file gone before it could be shared: nothing of it on the host, and never a teammate's
  const had = new Set(S.fileOf(alice).media.map((m) => m.id));
  const r = alice.cb(["media", "add", "Demo", b.clip2]);
  assert.equal(r.code, 0, r.out + r.err);
  const mediaId = await S.until(() => S.fileOf(alice).media.find((m) => !had.has(m.id))?.id, 10_000, "the clip in alice's project");
  const env = JSON.parse(fs.readFileSync(path.join(alice.root, "Demo.cardboard", "project.json"), "utf8"));
  const file = path.resolve(alice.root, "Demo.cardboard", env.media.find((m) => m.mediaId === mediaId).nativePath);
  const moved = file + ".moved";
  fs.renameSync(file, moved);
  try {
    const t0 = Date.now();
    const src = await alice.call("carton.liveMediaSource", { mediaId });
    assert.equal(src, null, "nothing to stream: " + JSON.stringify(src));
    assert.ok(Date.now() - t0 < 1500, `answered in ${Date.now() - t0} ms, not waited for`);
  } finally {
    fs.renameSync(moved, file);
  }
});

test("a teammate's clip that never comes is waited for only while it is new (12 s after it arrived); after that, answered at once", t, async (tc) => {
  // a sound entry with no file anywhere (its app can never send it): what an app closed before sharing leaves
  const doc = await S.projectOf(alice, id);
  const ghost = randomUUID(), now = new Date().toISOString();
  const entry = { id: ghost, createdAt: now, addedAt: now, data: { type: "audio", fileName: "never-sent.wav", duration: 3, size: 1000, format: "wav" } };
  await alice.call("projects.updateScoped", { ...doc, media: [...doc.media, entry], stateUpdatedAt: Math.max(Date.now(), doc.stateUpdatedAt + 1) }, { ...SCOPE, ownedMediaIds: [ghost], carton: { base: doc.stateUpdatedAt, actor: "person" } });
  await S.until(() => S.fileOf(bob).media.some((m) => m.id === ghost), 20_000, "the entry at bob's");
  const arrived = Date.now();
  const first = await bob.call("carton.liveMediaSource", { mediaId: ghost });
  const waited = Date.now() - arrived;
  tc.diagnostic(`the first ask waited ${waited} ms`);
  assert.equal(first, null);
  assert.ok(waited >= 9_000 && waited < 14_000, `waited while it was new, not longer: ${waited} ms`);
  const t1 = Date.now();
  assert.equal(await bob.call("carton.liveMediaSource", { mediaId: ghost }), null);
  assert.ok(Date.now() - t1 < 1500, `then answered at once: ${Date.now() - t1} ms`);
});

// Review of fix/demo-sync-bugs, P2 (the reviewer's fault injection): a host read that never answers, made while the
// first ask waits, held that ask past its deadline (the wait looked at its deadline only between reads). The deadline
// is a timer of its own now: the ask is answered by it, and the stuck read is let go.
test("a host read that stalls while the first ask waits can't hold it past its deadline", t, async (tc) => {
  const doc = await S.projectOf(alice, id);
  const ghost = randomUUID(), now = new Date().toISOString();
  const entry = { id: ghost, createdAt: now, addedAt: now, data: { type: "audio", fileName: "stuck.wav", duration: 3, size: 1000, format: "wav" } };
  await alice.call("projects.updateScoped", { ...doc, media: [...doc.media, entry], stateUpdatedAt: Math.max(Date.now(), doc.stateUpdatedAt + 1) }, { ...SCOPE, ownedMediaIds: [ghost], carton: { base: doc.stateUpdatedAt, actor: "person" } });
  await S.until(() => S.fileOf(bob).media.some((m) => m.id === ghost), 20_000, "the entry at bob's");
  const arrived = Date.now();
  let settled = null;
  const ask = bob.call("carton.liveMediaSource", { mediaId: ghost }).then((x) => (settled = { at: Date.now() - arrived, x }), (e) => (settled = { at: Date.now() - arrived, e: String(e) }));
  try {
    await S.sleep(200);
    fs.writeFileSync(stall, "stall");
    await S.until(() => settled, 16_000, "the first ask answered");
    tc.diagnostic(`answered ${settled.at} ms after the entry arrived; a read stalled: ${fs.existsSync(stall + ".hit")}`);
    assert.deepEqual([settled.x, settled.e], [null, undefined]);
    assert.ok(settled.at < 13_500, `by its deadline: ${settled.at} ms`);
  } finally {
    for (const f of [stall, stall + ".hit"]) fs.rmSync(f, { force: true });
    await Promise.race([ask, S.sleep(1000)]);
  }
});

// The other way a wait ends: the project says the clip is shared (its share's change) while every host read is stuck.
// Asked the moment the sound's entry reaches Bob, before Alice's app has sent it.
test("the project's record answers the first ask while a host read is stuck", t, async (tc) => {
  fs.writeFileSync(stall, "stall");
  try {
    const file = sound("teammate-sound-3", 784);
    const had = new Set(S.fileOf(bob).media.map((m) => m.id));
    const r = alice.cb(["media", "add", "Demo", file]);
    assert.equal(r.code, 0, r.out + r.err);
    const mediaId = await S.until(() => S.fileOf(bob).media.find((m) => !had.has(m.id) && m.data?.type === "audio")?.id, 20_000, "the sound's entry at bob's");
    const shared = () => !!S.fileOf(bob).media.find((m) => m.id === mediaId)?.contentHash;
    const before = shared();
    const t0 = Date.now();
    const src = await Promise.race([bob.call("carton.liveMediaSource", { mediaId }), S.sleep(15_000).then(() => "no answer in 15 s")]);
    tc.diagnostic(`answered in ${Date.now() - t0} ms; shared when asked: ${before}; a host read stalled: ${fs.existsSync(stall + ".hit")}`);
    assert.ok(src && src.size > 0, "the sound, from the project's own record of its share: " + JSON.stringify(src));
    assert.ok(Date.now() - t0 < 10_000);
  } finally {
    for (const f of [stall, stall + ".hit"]) fs.rmSync(f, { force: true });
  }
});
