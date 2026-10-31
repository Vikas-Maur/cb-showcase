// Live sync between two computers (H8, Invite to edit, Join; PLAN §5.3, §6.2, §12, §13): Cardboard 1.4.0's real
// library worker, patched, on each of two library roots with their own app data, syncing through a real Carton host
// (server-node over WebSocket on 127.0.0.1). Cardboard's bundles are not in git: CARDBOARD_PRISTINE names them (see
// ../patches.test.js); without them the tests skip.
//   CARDBOARD_PRISTINE=… node --test --test-concurrency=1 scripts/carton/test/sync/live.test.js
// One scenario, in order (each step needs the one before): share with history, invite, join in the other library,
// concurrent edits, presence, media, offline and rejoin, cb on the shared project with the app open, then with the
// app closed in cb's cloud mode (a headless helper syncs; H13), and a host too old for the app (the panel says why).
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
  S.killHelpers();
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
  const r = results.find((x) => x.proxy?.stream && x.proxy.size > 0);
  assert.ok(r, "a collab proxy went up, as a segmented stream that has ended: " + JSON.stringify(results));
  assert.match(r.hash, /^[0-9a-f]{64}$/);
  const mediaId = r.mediaId;
  assert.ok((await S.projectOf(bob, id)).media.some((m) => m.id === mediaId), "Bob's copy lists the clip");
  // S5-G2: the share is in the project itself, as a version by Alice: on Bob's computer, history shows it, and it gives
  // the clip its content id and shared record (size, the proxy).
  const v = await S.until(() => bob.cb(["history", "Demo"]).json().versions.find((x) => x.by?.id === "Alice"), 20_000, "alice's share version at bob");
  const cmp = bob.cb(["compare", "Demo", `${v.version.split("@")[0]}@${Number(v.version.split("@")[1]) - 1}`, v.version]);
  assert.match(cmp.out, /content|shared media/, cmp.out + cmp.err);
  // Bob has no file for it: main asks his worker where it lives, then answers cardboard-media:// from the range cache.
  const src = await bob.call("carton.liveMediaSource", { mediaId });
  assert.equal(src.stream, r.proxy.stream);
  assert.equal(src.size, r.proxy.size);
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
  // And Cardboard's own tools do, through the same URL (patches/tools.js): Bob's agent grabs a frame of a clip whose file
  // is only on Alice's computer.
  const m = await bob.mcp();
  try {
    const g = await m.tool("grab_frame", { project: "Demo", media: mediaId, at: 1 });
    assert.ok(!g.isError, g.text);
    assert.ok(g.content.some((c) => c.type === "image" && c.data?.length > 100), "a frame came back: " + JSON.stringify(g.content).slice(0, 300));
  } finally {
    await m.close();
  }
});

test("media before its upload finishes: Bob plays Alice's new clip from its first segments, and a tool follows it live", t, async () => {
  // The host holds each stream's end entry, so the proxy stays "still uploading" for as long as the test needs.
  host.send("hold-ends");
  await host.next((x) => x.held);
  const before = new Set((await S.projectOf(alice, id)).media.map((m) => m.id));
  const add = alice.cb(["media", "add", "Demo", b.clip2]);
  assert.equal(add.code, 0, add.out + add.err);
  const mediaId = (await S.projectOf(alice, id)).media.find((m) => !before.has(m.id))?.id;
  assert.ok(mediaId, "the clip is in Alice's project");
  const sharing = alice.call("carton.liveShareMedia", { projectId: id, mediaIds: [mediaId] });
  try {
    // The record goes up as soon as the stream is claimed: a stream with no size yet.
    const src = await S.until(async () => { const s = await bob.call("carton.liveMediaSource", { mediaId }); return s?.stream && s; }, 60_000, "the new clip's stream at bob");
    assert.equal(src.size, null, "still uploading");
    const head = await S.asComputer(bob, async () => {
      const res = await S.facade(b).media.serve(new Request(`cardboard-media://media/${mediaId}`), src);
      assert.equal(res.status, 200);
      assert.equal(res.headers.get("content-length"), null, "a growing body");
      // The init segment, then media segments as they are up: read until the first fragment (moof) has arrived.
      const rd = res.body.getReader();
      let got = Buffer.alloc(0);
      while (!got.includes("moof")) {
        const c = await rd.read();
        if (c.done) break;
        got = Buffer.concat([got, Buffer.from(c.value)]);
      }
      await rd.cancel();
      return got;
    });
    assert.equal(head.subarray(4, 8).toString("latin1"), "ftyp", "the init segment first");
    assert.ok(head.includes("moof"), "then a media segment, while the upload hasn't finished");
    const live = await bob.call("carton.liveMediaUrl", { mediaId });
    assert.match(live.url, /^http:\/\/127\.0\.0\.1:\d+\/s\/[0-9a-f]{64}\.m3u8\?t=/);
    const m3u8 = await (await fetch(live.url)).text();
    assert.match(m3u8, /#EXT-X-MAP:URI="http:\/\/127\.0\.0\.1:\d+\/m\/[0-9a-f]{64}(\.m4s)?\?t=/);
    assert.doesNotMatch(m3u8, /#EXT-X-ENDLIST/, "a live playlist while it uploads");
    // A segment that doesn't verify, read by a tool through the playlist: Bob's loopback server reports the stream as
    // damaged on the host (bad/<stream>), so Alice's next share makes a new one. The clip is 6 s in 2 s segments: wait
    // for all three, and spoil the last (Bob's player above read only the first), then put it back. The host keeps the
    // object meanwhile: its own repair path would remove it, and then the range server's second read finds it missing
    // and reports nothing for the stream (media's to fix: notes/windows-sync.md, "Questions for other agents").
    const segUrls = await S.until(async () => {
      // (the init segment's URL is in #EXT-X-MAP, so these lines are the media segments)
      const urls = (await (await fetch(live.url)).text()).split("\n").filter((l) => /^http:\/\/127\.0\.0\.1:\d+\/m\/[0-9a-f]{64}/.test(l));
      return urls.length >= 3 && urls;
    }, 30_000, "all three segments in the playlist");
    const segUrl = segUrls.at(-1), segHash = segUrl.match(/\/m\/([0-9a-f]{64})/)[1];
    assert.match(segUrl, new RegExp(`[?&]s=${src.stream}(&|$)`), "the segment's URL names its stream");
    const media = path.join(S.TMP, "host", "blobs", "objects", "projects", id, "media");
    const obj = path.join(media, "m", segHash + "~b");
    const orig = fs.readFileSync(obj), spoilt = Buffer.from(orig);
    spoilt[spoilt.length >> 1] ^= 0xff;
    host.send("keep-objects");
    await host.next((x) => x.keep === true);
    fs.writeFileSync(obj, spoilt);
    try {
      const r = await fetch(segUrl).then(async (res) => ({ status: res.status, bytes: (await res.arrayBuffer().catch(() => new ArrayBuffer(0))).byteLength }), (e) => ({ error: String(e) }));
      assert.ok(r.error || r.status !== 200 || r.bytes < orig.length, `bytes that don't verify never reach the tool whole: ${JSON.stringify(r)}`);
      const reports = await S.until(async () => { const d = path.join(media, "bad"); const f = fs.existsSync(d) ? fs.readdirSync(d).filter((n) => n.startsWith(src.stream)) : []; return f.length && f; }, 10_000, "bad/<stream> at the host");
      assert.ok(reports.length >= 1);
    } finally {
      fs.writeFileSync(obj, orig);
      host.send("remove-objects");
      await host.next((x) => x.keep === false);
    }
  } finally {
    host.send("release-ends");
  }
  const done = (await sharing).find((x) => x.mediaId === mediaId);
  assert.ok(done?.proxy?.size > 0, JSON.stringify(done));
  const src = await S.until(async () => { const s = await bob.call("carton.liveMediaSource", { mediaId }); return s?.size && s; }, 20_000, "the finished stream at bob");
  const { url } = await bob.call("carton.liveMediaUrl", { mediaId });
  assert.match(url, /\/m\/[0-9a-f]{64}\?t=/, "once it has ended, one file by range");
  assert.ok(Math.abs(S.probeDuration(url) - 6) < 0.3, "ffprobe reads all of it");
  assert.equal(src.stream, done.proxy.stream);
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
  // The agent edits the printed timeline as it is now (timeline.tsx follows project.json a moment later).
  const tsx = path.join(alice.root, "Demo.cardboard", "timeline.tsx");
  await S.until(() => /fontSize=\{90\}/.test(fs.readFileSync(tsx, "utf8")), 10_000, "alice's timeline.tsx at head");
  const printed = fs.readFileSync(tsx, "utf8");
  // Then Bob changes the title's text, and it reaches Alice: the agent's print is now one version behind.
  await S.guiSave(bob, id, (it) => (it.type === "text" ? { ...it, textContent: "Bob was here" } : null));
  await S.until(async () => S.textOf(await S.projectOf(alice, id)).textContent === "Bob was here", 20_000, "bob's text at alice");
  const edit = path.join(alice.home, "edit3.tsx");
  fs.writeFileSync(edit, printed.replace(/fontSize=\{\d+\}/, "fontSize={77}"));
  const r = alice.cb(["source", "apply", "Demo", edit], { CARDBOARD_ACTOR: "codex/c9" });
  assert.equal(r.code, 0, r.out + r.err);
  await S.until(async () => S.textOf(await S.projectOf(bob, id)).fontSize === 77, 30_000, "the agent's edit at bob; cb said: " + r.out.replace(/\s+/g, " ").slice(-700) + " / " + r.err.slice(-300));
  const h = bob.cb(["history", "Demo"]);
  assert.equal(h.json().versions[0].by?.id, "codex/c9", "credited to the agent on Bob's computer");
  // The holder merged the agent's edit onto Bob's: what cb wrote into Alice's project.json is that merge, not the
  // agent's document from its older print (which would drop Bob's text from her file).
  await S.sleep(1000);
  for (const pc of [alice, bob]) {
    const x = S.textOf(await S.projectOf(pc, id));
    assert.deepEqual([x.fontSize, x.textContent], [77, "Bob was here"], pc.name + "'s project.json has both");
  }
});

test("offline, cb with the app open from a print one version behind: Alice's file keeps Bob's change and the agent's", t, async () => {
  const tsx = path.join(alice.root, "Demo.cardboard", "timeline.tsx");
  await S.until(() => /fontSize=\{77\}/.test(fs.readFileSync(tsx, "utf8")), 10_000, "alice's timeline.tsx at head");
  const printed = fs.readFileSync(tsx, "utf8");
  await S.guiSave(bob, id, (it) => (it.type === "text" ? { ...it, textContent: "Bob again" } : null));
  await S.until(async () => S.textOf(await S.projectOf(alice, id)).textContent === "Bob again", 20_000, "bob's text at alice");
  const port = host.port;
  await host.stop();
  await S.until(async () => (await alice.call("carton.liveStatus", { projectId: id })).status === "offline", 20_000, "alice offline");
  // The holder is offline, so the agent's edit stays pending, merged onto Bob's text in the holder. cb's own handle
  // holds the confirmed rows only: what cb writes into project.json must be the holder's state, not its document from
  // the older print (round 2 #2: that would drop Bob's text from Alice's file, with nothing to repair it offline).
  const edit = path.join(alice.home, "edit4.tsx");
  fs.writeFileSync(edit, printed.replace(/fontSize=\{\d+\}/, "fontSize={78}"));
  const r = alice.cb(["source", "apply", "Demo", edit], { CARDBOARD_ACTOR: "codex/c11" });
  assert.equal(r.code, 0, r.out + r.err);
  await S.sleep(1500);
  const disk = S.textOf(S.fileOf(alice)), store = S.textOf(await S.projectOf(alice, id));
  assert.deepEqual([disk.fontSize, disk.textContent], [78, "Bob again"], "Alice's project.json has both while offline");
  assert.deepEqual([store.fontSize, store.textContent], [78, "Bob again"], "and so does her app");
  host = await S.startHost(path.join(S.TMP, "host"), port);
  await S.until(async () => { const y = S.textOf(await S.projectOf(bob, id)); return y.fontSize === 78 && y.textContent === "Bob again" && y; }, 60_000, "the agent's offline edit at bob, with his text");
  await S.until(async () => (await alice.call("carton.liveStatus", { projectId: id })).status === "up-to-date", 20_000, "alice up to date");
});

test("app closed, agent in cb's cloud mode (H13): a headless helper syncs; the pull brings Bob's edit in, the agent's edit reaches Bob, no whole-file PUT", t, async () => {
  await alice.stopWorker();
  await S.guiSave(bob, id, (it) => (it.type === "text" ? { ...it, fontSize: 55 } : null));
  await S.sleep(1000);
  assert.notEqual(S.textOf(S.fileOf(alice)).fontSize, 55, "with Alice's app closed, nothing writes her file");
  // CARDBOARD_CLOUD_PROJECTS=1: Cardboard's own path would GET and PUT the whole project.json from its storage around
  // each tool call (support.js sends any HTTP request to a dead local proxy, and there is no account here).
  const m = await alice.mcp({ CARDBOARD_CLOUD_PROJECTS: "1", CARDBOARD_ACTOR: "codex/c10" });
  try {
    const p = await m.tool("print_timeline", { project: "Demo" });
    assert.ok(!p.isError, p.text);
    assert.match(p.text, /fontSize=\{55\}/, "the pull caught up through a helper before the tool read");
    assert.equal(S.textOf(S.fileOf(alice)).fontSize, 55, "and head went into Alice's project.json");
    const rev = Number(p.text.match(/cardboard:rev[^\d]*(\d+)/)?.[1]);
    const a = await m.tool("apply_timeline", { project: "Demo", edits: [{ oldText: "fontSize={55}", newText: "fontSize={66}" }], ...(rev ? { rev } : {}) });
    assert.ok(!a.isError, a.text);
    assert.doesNotMatch(a.text, /Not saved to Cardboard storage/, "no whole-file PUT was tried");
  } catch (e) {
    throw new Error(e.message + "\n--- cb mcp stderr (tail):\n" + m.stderr().slice(-3000));
  } finally {
    await m.close();
  }
  await S.until(async () => S.textOf(await S.projectOf(bob, id)).fontSize === 66, 30_000, "the agent's edit at bob");
  assert.equal(bob.cb(["history", "Demo"]).json().versions[0].by?.id, "codex/c10", "credited to the agent on Bob's computer");
});

test("a host older than the app: Bob's panel says the host needs an update, instead of \"Syncing\" for ever", t, async () => {
  const port = host.port;
  await host.stop();
  host = await S.startHost(path.join(S.TMP, "host"), port, { CARTON_TEST_SCHEMA_VERSION: "1" });
  // (While the host restarts the problem is "unreachable"; once it answers, its refusal.)
  const st = await S.until(async () => { const s = await bob.call("carton.liveStatus", { projectId: id }); return s.problem?.code === "update-server" && s; }, 30_000, "the host's refusal at bob");
  assert.equal(st.problem.code, "update-server", JSON.stringify(st));
  assert.match(st.problem.words, /needs an update/);
  assert.match(st.problem.detail ?? "", /update the server/, "the host's own message, shown under the words");
  const ev = bob.events().filter((e) => e.change?.topic === "live" && e.change.id === id).map((e) => e.change.live.problem).reverse()[0];
  assert.equal(ev?.code, "update-server", "the Share panel was told too");
  // A host that takes the app's schema again: the problem goes.
  await host.stop();
  host = await S.startHost(path.join(S.TMP, "host"), port);
  await S.until(async () => { const s = await bob.call("carton.liveStatus", { projectId: id }); return !s.problem && s.status === "up-to-date"; }, 30_000, "bob back to up to date");
});
