// Live sync between two computers (H8, Invite to edit, Join; PLAN §5.3, §6.2, §12, §13): Cardboard 1.4.0's real
// library worker, patched, on each of two library roots with their own app data, syncing through a real Carton host
// (server-node over WebSocket on 127.0.0.1). Cardboard's bundles are not in git: CARDBOARD_PRISTINE names them (see
// ../patches.test.js); without them the tests skip.
//   CARDBOARD_PRISTINE=… node --test --test-concurrency=1 scripts/carton/test/sync/live.test.js
// One scenario, in order (each step needs the one before): share with history, invite, join in the other library,
// concurrent edits, presence, offline and rejoin, cb on the shared project with the app open.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs"), path = require("path");
const S = require("./support.js");

const t = { skip: S.noBuild };
let b, host, alice, bob, id, link;

test.before(async () => {
  if (S.noBuild) return;
  b = await S.build();
  host = await S.startHost(path.join(S.TMP, "host"));
  alice = await S.computer("alice", b);
  bob = await S.computer("bob", b);
  S.seed(alice, b);
  await alice.startWorker();
  await bob.startWorker();
  id = (await alice.call("projects.list"))[0].id;
});
test.after(async () => {
  // Each computer's worker log, for a failure's post-mortem.
  for (const pc of [alice, bob]) if (pc?.worker()) {
    fs.writeFileSync(path.join(S.TMP, pc.name + "-worker.log"), pc.worker().stderr());
    fs.writeFileSync(path.join(S.TMP, pc.name + "-events.jsonl"), pc.events().map((e) => JSON.stringify(e)).join("\n"));
  }
  for (const pc of [alice, bob]) pc?.kill();
  await host?.stop().catch(() => {});
});

test("share with history: the cut goes to the host with its versions, and the project says it is shared", t, async () => {
  assert.deepEqual(await alice.call("carton.liveStatus", { projectId: id }), { shared: false });
  const r = await alice.call("carton.liveShare", { projectId: id, host: host.origin, adminToken: S.ADMIN, name: "Alice" });
  assert.equal(r.status, "shared", JSON.stringify(r));
  const st = await S.until(async () => { const s = await alice.call("carton.liveStatus", { projectId: id }); return s.status === "up-to-date" && s; }, 20_000, "alice up to date");
  assert.equal(st.shared, true);
  assert.equal(st.account, "Alice");
  assert.equal(st.holder, true, "the worker holds the sync lease");
});

test("invite and join: Bob joins from the link in his own library and gets the project with its history", t, async () => {
  ({ link } = await alice.call("carton.liveInvite", { projectId: id, role: "editor" }));
  assert.match(link, /^http:\/\/127\.0\.0\.1:\d+\/#join=/);
  const j = await bob.call("carton.liveJoin", { link, name: "Bob" });
  assert.equal(j.projectId, id);
  const want = S.textOf(await S.projectOf(alice, id)).fontSize;
  await S.until(async () => S.textOf(await S.projectOf(bob, id).catch(() => ({ timelineItems: [] })))?.fontSize === want, 30_000, "bob's project.json at alice's head");
  // History with its authors, down to the subagent, on Bob's computer.
  const h = bob.cb(["history", "Demo"]);
  assert.equal(h.code, 0, h.out + h.err);
  const by = h.json().versions.map((v) => v.by?.id ?? null);
  assert.ok(by.includes("director/chat1/turn2/sub-Explore-a1") && by.includes("director/chat1/turn1"), JSON.stringify(by));
});

test("concurrent edits: both computers save the same clip's different fields at once; both keep both", t, async () => {
  await Promise.all([
    S.guiSave(alice, id, (it) => (it.type === "text" ? { ...it, fontSize: 150 } : null)),
    S.guiSave(bob, id, (it) => (it.type === "text" ? { ...it, textContent: "Hello from Bob" } : null)),
  ]);
  for (const pc of [alice, bob]) {
    await S.until(async () => { const x = S.textOf(await S.projectOf(pc, id)); return x.fontSize === 150 && x.textContent === "Hello from Bob"; }, 20_000, pc.name + " has both edits");
  }
});

test("presence: what Alice is doing shows on Bob's computer, and goes when she stops", t, async () => {
  await alice.call("carton.livePresence", { projectId: id, state: { activity: "Editing captions" } });
  const peer = await S.until(() => bob.events().filter((e) => e.change?.kind === "carton" && e.change.topic === "live" && e.change.id === id).map((e) => e.change.live.peers).reverse()[0]?.find((p) => p.activity === "Editing captions"), 10_000, "alice's presence at bob");
  assert.equal(peer.actor.id, "Alice");
  await alice.call("carton.livePresence", { projectId: id, state: null });
  await S.until(() => { const last = bob.events().filter((e) => e.change?.topic === "live" && e.change.id === id).map((e) => e.change.live.peers).reverse()[0]; return last && !last.some((p) => p.actor.id === "Alice"); }, 10_000, "alice gone at bob");
});

test("media: Alice's clips are shared (content id, collab proxy); Bob streams one by range and a tool reads it by URL", t, async () => {
  // Sharing the project started sharing its clips in the background; this waits for that, and skips what is done.
  const results = await alice.call("carton.liveShareMedia", { projectId: id });
  const r = results.find((x) => x.proxy?.hash);
  assert.ok(r, "a collab proxy went up: " + JSON.stringify(results));
  assert.match(r.hash, /^[0-9a-f]{64}$/);
  const mediaId = r.mediaId;
  assert.ok((await S.projectOf(bob, id)).media.some((m) => m.id === mediaId), "Bob's copy lists the clip");
  // Bob has no file for it: main asks his worker where it lives, then answers cardboard-media:// from the range cache.
  const src = await bob.call("carton.liveMediaSource", { mediaId });
  assert.equal(src.hash, r.proxy.hash);
  const body = await S.asComputer(bob, async () => {
    const res = await S.facade(b).media.serve(new Request(`cardboard-media://media/${mediaId}`, { headers: { range: "bytes=0-1023" } }), src);
    assert.equal(res.status, 206);
    assert.equal(res.headers.get("content-range"), `bytes 0-1023/${src.size}`);
    const part = new Uint8Array(await res.arrayBuffer());
    const all = new Uint8Array(await (await S.facade(b).media.serve(new Request(`cardboard-media://media/${mediaId}`), src)).arrayBuffer());
    assert.deepEqual(part, all.subarray(0, 1024));
    return all;
  });
  assert.equal(body.length, src.size);
  assert.equal(Buffer.from(body.subarray(4, 8)).toString("latin1"), "ftyp", "an MP4");
  // ffmpeg-based tools read it through the loopback range server (verified bytes, seeks by Range).
  const { url } = await bob.call("carton.liveMediaUrl", { mediaId });
  assert.match(url, /^http:\/\/127\.0\.0\.1:\d+\/m\/[0-9a-f]{64}\?t=/);
  assert.ok(Math.abs(S.probeDuration(url) - 3) < 0.2, "ffprobe reads the shared proxy by URL");
});

test("offline and rejoin: Bob edits while the host is down; his edit waits, then reaches Alice when it is back", t, async () => {
  const port = host.port;
  await host.stop();
  await S.until(async () => (await bob.call("carton.liveStatus", { projectId: id })).status === "offline", 20_000, "bob offline");
  await S.guiSave(bob, id, (it) => (it.type === "text" ? { ...it, fontSize: 90 } : null));
  const st = await bob.call("carton.liveStatus", { projectId: id });
  assert.equal(st.pending, 1, JSON.stringify(st));
  assert.equal(S.textOf(await S.projectOf(bob, id)).fontSize, 90, "Bob's own file shows his edit at once");
  host = await S.startHost(path.join(S.TMP, "host"), port);
  await S.until(async () => S.textOf(await S.projectOf(alice, id)).fontSize === 90, 60_000, "bob's offline edit at alice");
  await S.until(async () => (await bob.call("carton.liveStatus", { projectId: id })).status === "up-to-date", 20_000, "bob up to date");
});

test("cb on the shared project with the app open: the agent's edit goes through the worker's lease and reaches Bob", t, async () => {
  const edit = path.join(alice.home, "edit3.tsx");
  fs.writeFileSync(edit, fs.readFileSync(path.join(alice.root, "Demo.cardboard", "timeline.tsx"), "utf8").replace(/fontSize=\{\d+\}/, "fontSize={77}"));
  const r = alice.cb(["source", "apply", "Demo", edit], { CARDBOARD_ACTOR: "codex/c9" });
  assert.equal(r.code, 0, r.out + r.err);
  await S.until(async () => S.textOf(await S.projectOf(bob, id)).fontSize === 77, 30_000, "the agent's edit at bob");
  const h = bob.cb(["history", "Demo"]);
  assert.equal(h.json().versions[0].by?.id, "codex/c9", "credited to the agent on Bob's computer");
});
