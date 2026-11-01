// Live sync between two computers (H8, Invite to edit, Join; PLAN §5.3, §6.2, §12, §13): Cardboard 1.4.0's real
// library worker, patched, on each of two library roots with their own app data, syncing through a real Carton host
// (server-node over WebSocket on 127.0.0.1). Cardboard's bundles are not in git: CARDBOARD_PRISTINE names them (see
// ../patches.test.js); without them the tests skip.
//   CARDBOARD_PRISTINE=… node --test --test-concurrency=1 scripts/carton/test/sync/live.test.js
// One scenario, in order (each step needs the one before): share with history, invite, join in the other library,
// concurrent edits, presence, media, media shared again (one host client per project), offline and rejoin, cb on the
// shared project with the app open, then with the app closed in cb's cloud mode (a headless helper syncs; H13), another
// program's save and an offline restore with the app closed, and a host too old for the app (the panel says why).
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs"), path = require("path");
const S = require("./support.js");

const t = { skip: S.noBuild };
let b, host, alice, bob, id, link, beforeShare;
// An agent's own copy of the timeline at head (cb source print --view: the lease holder prints it).
const printView = (pc, name) => {
  const r = pc.cb(["source", "print", "Demo", "--view", name], { CARDBOARD_ACTOR: "codex/" + name });
  assert.equal(r.code, 0, "print --view: " + r.out + r.err);
  return fs.readFileSync(path.join(pc.root, "Demo.cardboard", ".scratch", "views", name + ".tsx"), "utf8");
};

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
  // Alice edits in the app before she shares (R3: the people test below finds it credited to her at Bob's)
  await S.guiSave(alice, id, (it) => (it.type === "text" ? { ...it, endTime: 2.4 } : null));
  beforeShare = alice.cb(["history", "Demo"]).json().versions[0];
  assert.equal(beforeShare.by?.id, "person", "before the share, a GUI save is the person's, with no account behind it");
  const r = await alice.call("carton.liveShare", { projectId: id, host: host.origin, adminToken: S.ADMIN, name: "Alice" });
  assert.equal(r.status, "shared", JSON.stringify(r));
  const st = await S.until(async () => { const s = await alice.call("carton.liveStatus", { projectId: id }); return s.status === "up-to-date" && s; }, 20_000, "alice up to date");
  assert.equal(st.shared, true);
  assert.equal(st.account, "Alice");
  assert.equal(st.holder, true, "the worker holds the sync lease");
  if (process.env.CARTON_TEST_FREEZE === "1") assert.equal(await alice.call("carton.testFrozen", { projectId: id }), true, "frozen mode: the facade's handle returns frozen docs");
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

test("people: Alice's GUI edits read as Alice at Bob's and Bob's as Bob at Alice's, made before the share and after; each one's own are You", t, async () => {
  // Every GUI save is recorded as the generic "person" (hashes and history untouched): each computer tells it as the
  // person behind the replica that made it, its own at once (the identity set at share and join), a teammate's as the
  // host says. Each computer's own GUI saves, by change id, as it tells them:
  const told = (pc) => new Map(pc.cb(["history", "Demo"]).json().versions.filter((v) => v.by?.kind === "human" && v.change).map((v) => [v.change, v.by]));
  const own = (pc, who) => [...told(pc)].filter(([, by]) => by.id === who).map(([c]) => c);
  const mine = { Alice: own(alice, "Alice"), Bob: own(bob, "Bob") };
  assert.ok(mine.Alice.includes(beforeShare.change), "Alice's edit from before the share is hers on her computer: " + JSON.stringify([...told(alice)]));
  assert.ok(mine.Alice.length >= 2 && mine.Bob.length >= 1, "edits after the share too: " + JSON.stringify(mine));
  for (const [pc, who, other] of [[bob, "Alice", alice], [alice, "Bob", bob]]) {
    await S.until(() => { const t2 = told(pc); return mine[who].every((c) => t2.get(c)?.id === who && t2.get(c)?.name === who); }, 20_000, `${who}'s GUI edits as ${who} at ${pc.name}'s: ` + JSON.stringify([...told(pc)].filter(([c]) => mine[who].includes(c))));
    assert.ok(![...told(pc)].some(([, by]) => by.id === "person"), `no GUI edit reads as the generic person at ${pc.name}'s (${other.name}'s view)`);
  }
  // The History panel: your own edits are You, the teammate's under their name.
  for (const [pc, me, them] of [[alice, "Alice", "Bob"], [bob, "Bob", "Alice"]]) {
    const client = "people-" + pc.name;
    const msgs = () => pc.events().filter((e) => e.change?.kind === "carton" && e.change.client === client).map((e) => e.change.message);
    assert.equal((await pc.call("carton.ui", { projectId: id, client, message: { t: "hello" } }))?.status, "ok");
    const init = await S.until(() => msgs().find((x) => x.t === "init"), 20_000, pc.name + "'s panel");
    assert.equal(init.me.key, "human/" + me, "You: " + JSON.stringify(init.me));
    const actors = new Map([init.me, ...init.actors].map((a) => [a.key, a]));
    const by = (change) => { const v = init.history.find((x) => x.id === change); const a = v && (typeof v.author === "string" ? actors.get(v.author) : v.author); return a && { key: a.key, name: a.name, isYou: !!a.isYou }; };
    for (const c of mine[me]) assert.deepEqual(by(c), { key: "human/" + me, name: me, isYou: true }, `${pc.name}'s own edit ${c} is You`);
    for (const c of mine[them]) assert.deepEqual(by(c), { key: "human/" + them, name: them, isYou: false }, `${them}'s edit ${c} at ${pc.name}'s`);
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
  // Alice's GUI edits from the tests above read as Alice at Bob's too (the identity work, R3), and the background share
  // that began with the project's share can land before or after them: the share's version is whichever of her
  // versions there brings the clip's content id, not necessarily her newest.
  let cmp = null, seen = [];
  await S.until(() => {
    seen = [];
    for (const v of bob.cb(["history", "Demo"]).json().versions.filter((x) => x.by?.id === "Alice").slice(0, 6)) {
      cmp = bob.cb(["compare", "Demo", `${v.version.split("@")[0]}@${Number(v.version.split("@")[1]) - 1}`, v.version]);
      seen.push(v.version + ": " + cmp.out.trim().replace(/\s+/g, " ").slice(0, 160));
      if (/content|shared media/.test(cmp.out)) return true;
    }
    return false;
  }, 20_000, "alice's share version at bob").catch((e) => { throw new Error(e.message + "; her versions there: " + JSON.stringify(seen)); });
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

test("media shared again: the first re-share checks every part of the stream it reuses; the next, through the same host client, asks about none", t, async () => {
  // Media remembers a stream it found whole per host client object for 10 minutes (media fd87449); the worker keeps one
  // client per project (sync/media.js storeFor), so the memory carries from one share to the next.
  const first = (await alice.call("carton.liveShareMedia", { projectId: id })).find((x) => x.proxy?.stream && x.proxy.size > 0);
  const { mediaId, proxy: { stream } } = first;
  const endFile = path.join(S.TMP, "host", "blobs", "objects", "projects", id, "media", "ps", stream, "end~b");
  const end = JSON.parse(fs.readFileSync(endFile, "utf8"));
  const parts = new Set(end.parts ?? []);
  assert.ok(parts.size >= 2, "the stream's end lists its parts: " + JSON.stringify(end).slice(0, 300));
  // The stream's parts the host was asked about (HEAD) since the last call.
  const asked = async (tag) => {
    host.send({ heads: tag });
    const { heads } = await host.next((x) => x.tag === tag);
    return [...new Set(heads.map((k) => /(?:^|\/)m\/([0-9a-f]{64})$/.exec(k)?.[1]).filter((h) => h && parts.has(h)))].sort();
  };
  await asked("before");
  const again = async () => (await alice.call("carton.liveShareMedia", { projectId: id, mediaIds: [mediaId], force: true }))[0];
  const second = await again();
  assert.equal(second.proxy?.stream, stream, "the clip keeps its stream: " + JSON.stringify(second));
  assert.deepEqual(await asked("second"), [...parts].sort(), "the first re-share checks every part");
  const third = await again();
  assert.equal(third.proxy?.stream, stream, "the clip keeps its stream: " + JSON.stringify(third));
  assert.deepEqual(await asked("third"), [], "the next re-share asks the host about none of its parts");
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
    // for all three, and spoil the last (Bob's player above read only the first). The host as shipped: its repair path
    // removes the spoilt object, and the range server's retry, finding it gone, still reports the stream (media
    // d9f9a5f). The object (bytes and sidecar) is put back afterwards for the rest of the step.
    const segUrls = await S.until(async () => {
      // (the init segment's URL is in #EXT-X-MAP, so these lines are the media segments)
      const urls = (await (await fetch(live.url)).text()).split("\n").filter((l) => /^http:\/\/127\.0\.0\.1:\d+\/m\/[0-9a-f]{64}/.test(l));
      return urls.length >= 3 && urls;
    }, 30_000, "all three segments in the playlist");
    const segUrl = segUrls.at(-1), segHash = segUrl.match(/\/m\/([0-9a-f]{64})/)[1];
    assert.match(segUrl, new RegExp(`[?&]s=${src.stream}(&|$)`), "the segment's URL names its stream");
    const media = path.join(S.TMP, "host", "blobs", "objects", "projects", id, "media");
    const obj = path.join(media, "m", segHash + "~b");
    const side = path.join(media, "m", segHash + "~m");
    const orig = fs.readFileSync(obj), origSide = fs.existsSync(side) ? fs.readFileSync(side) : null, spoilt = Buffer.from(orig);
    spoilt[spoilt.length >> 1] ^= 0xff;
    fs.writeFileSync(obj, spoilt);
    try {
      const r = await fetch(segUrl).then(async (res) => ({ status: res.status, bytes: (await res.arrayBuffer().catch(() => new ArrayBuffer(0))).byteLength }), (e) => ({ error: String(e) }));
      assert.ok(r.error || r.status !== 200 || r.bytes < orig.length, `bytes that don't verify never reach the tool whole: ${JSON.stringify(r)}`);
      const reports = await S.until(async () => { const d = path.join(media, "bad"); const f = fs.existsSync(d) ? fs.readdirSync(d).filter((n) => n.startsWith(src.stream)) : []; return f.length && f; }, 10_000, "bad/<stream> at the host");
      assert.ok(reports.length >= 1);
    } finally {
      fs.writeFileSync(obj, orig);
      if (origSide) fs.writeFileSync(side, origSide);
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
  // The agent prints the timeline as it is now, in its own view (H8: the shared timeline.tsx stays frozen a minute
  // after a cb call, such as the media add above, so an agent working beside others prints its own).
  await S.until(async () => S.textOf(await S.projectOf(alice, id)).fontSize === 90, 10_000, "bob's 90 at alice");
  const printed = printView(alice, "c9");
  assert.match(printed, /fontSize=\{90\}/, "the view is at head");
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
  const printed = printView(alice, "c11");
  assert.match(printed, /fontSize=\{77\}/, "the view is at head");
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

test("app closed: another program's save, and the agent's edit on it, go through the helper to Bob; an offline restore shows in Alice's file at once", t, async () => {
  // Alice's app is still closed. Another program saves her project.json: a version Carton didn't write. cb imports it
  // through the lease holder (a headless helper), as it does its own saves (review round 3 #3: the import went straight
  // into cb's own handle, which can't commit on a shared cut, so that save and the cb saves on it had no history).
  const file = path.join(alice.root, "Demo.cardboard", "project.json");
  const env = JSON.parse(fs.readFileSync(file, "utf8"));
  S.textOf(env.project).textContent = "From an editor";
  env.project.stateUpdatedAt = Date.now();
  fs.writeFileSync(file, JSON.stringify(env));
  const m = await alice.mcp({ CARDBOARD_ACTOR: "codex/c12" });
  try {
    const p = await m.tool("print_timeline", { project: "Demo" });
    assert.ok(!p.isError, p.text);
    assert.match(p.text, /From an editor/);
    const rev = Number(p.text.match(/cardboard:rev[^\d]*(\d+)/)?.[1]);
    const a = await m.tool("apply_timeline", { project: "Demo", edits: [{ oldText: "fontSize={66}", newText: "fontSize={44}" }], ...(rev ? { rev } : {}) });
    assert.ok(!a.isError, a.text);
  } catch (e) {
    throw new Error(e.message + "\n--- cb mcp stderr (tail):\n" + m.stderr().slice(-3000));
  } finally {
    await m.close();
  }
  await S.until(async () => { const y = S.textOf(await S.projectOf(bob, id)); return y.fontSize === 44 && y.textContent === "From an editor"; }, 30_000, "the outside save and the agent's edit at bob");
  const by = bob.cb(["history", "Demo"]).json().versions.slice(0, 2).map((v) => v.by?.id);
  assert.equal(by[0], "codex/c12", "the agent's edit, credited: " + JSON.stringify(by));
  assert.match(by[1] ?? "", /^external:project\.json/, "the outside save, as one: " + JSON.stringify(by));

  // Offline, the app still closed: cb restores the version from before the outside save. It stays pending in the helper,
  // and Alice's project.json shows it at once (round 3 #5: cb wrote head from its own handle, which holds the confirmed
  // rows only, so the file kept the old state until a confirmation that nothing would write in).
  const v = alice.cb(["history", "Demo"]).json().versions.find((x) => x.by?.id === "codex/c10");
  assert.ok(v, "the agent's version from the step before");
  const port = host.port;
  await host.stop();
  const r = alice.cb(["restore", "Demo", v.version]);
  assert.equal(r.code, 0, r.out + r.err);
  assert.equal(r.json().status, "pending", r.out);
  assert.ok(!("head" in r.json()), "the holder's state isn't printed");
  const x = S.textOf(S.fileOf(alice));
  assert.deepEqual([x.fontSize, x.textContent], [66, "Bob again"], "Alice's project.json shows the restore while offline");
  host = await S.startHost(path.join(S.TMP, "host"), port);
  await S.until(async () => { const y = S.textOf(await S.projectOf(bob, id)); return y.fontSize === 66 && y.textContent === "Bob again"; }, 60_000, "the restore at bob");
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
  // (the harness's worker passes events on every 10 ms, answers at once: the event can come a moment after the answer)
  const lastProblem = () => bob.events().filter((e) => e.change?.topic === "live" && e.change.id === id).map((e) => e.change.live.problem).reverse()[0];
  await S.until(() => lastProblem()?.code === "update-server", 5_000, "the Share panel told too");
  // A host that takes the app's schema again: the problem goes.
  await host.stop();
  host = await S.startHost(path.join(S.TMP, "host"), port);
  await S.until(async () => { const s = await bob.call("carton.liveStatus", { projectId: id }); return !s.problem && s.status === "up-to-date"; }, 30_000, "bob back to up to date");
});
