// Restore and "New cut from here" on "Started the cut" (laptop, build 915eb36, reproduced twice): the History panel's
// oldest row is main@0, the empty root an imported project's history starts from. Restoring it wrote a project.json
// with no name and empty tracks and media; Cardboard's library dropped the project, and `cb history` and `cb cut list`
// found nothing. Here, through Cardboard's real library worker, cb and bundles (support.js):
//   1. the root is offered nothing, and asking anyway (the panel, cb, MCP) changes nothing;
//   2. no writer puts a project.json Cardboard can't read on disk: the old file stays, the refusal is logged;
//   3. a project already broken this way is found through its history (the library, cb history, cb cut list, the
//      panel), and Restore of a good version brings it back, its clip playable at once (3f);
//   4. Restore of main@1, then of the newest version, brings every media entry back with the details Cardboard gave it
//      (laptop, merge/prod-2 P2-1: clip.mp4 came back without its duration, size and thumbnail);
//   5-7. the final candidate's re-check (0cc587f1): a recovered project's media entries can be saved by the editor
//      (P1-1), an undo never leaves it empty and an emptied version is refused as what it is (P2-1, P3-2), and a cb
//      restore round trip lists the clip's file again (P3-1).
// Run alone or through slot.sh:
//   CARDBOARD_PRISTINE=<Cardboard 1.4.0 unpacked> CARTON_TEST_DIR=<scratch> node --test --test-concurrency=1 scripts/carton/test/sync/restore-root.test.js
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs"), path = require("path");
const { spawnSync } = require("child_process");
const S = require("./support.js");

const t = { skip: S.skip || S.noBuild, timeout: S.TEST_MS };
const bundleOf = (pc) => path.join(pc.root, "Demo.cardboard");
const envOf = (pc) => JSON.parse(fs.readFileSync(path.join(bundleOf(pc), "project.json"), "utf8"));
const must = (r, what) => { assert.equal(r.code, 0, what + ": " + r.out + r.err); return r; };
const names = (list) => list.map((p) => p.name);
const refusedLog = (pc) => { try { return fs.readFileSync(path.join(bundleOf(pc), ".carton", "refused.log"), "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };
// What the person sees of a project: its name, its tracks and clips, its media library (ids, file names, kinds).
const shape = (p) => ({
  name: p.name,
  aspectRatio: p.aspectRatio,
  tracks: (p.tracks ?? []).map((x) => x.id),
  items: (p.timelineItems ?? []).map((x) => [x.id, x.type, x.startTime, x.endTime, x.fontSize ?? null]),
  media: (p.media ?? []).map((m) => [m.id, m.data?.type, m.data?.fileName]),
});

/**
 * Runs `body` (an async function's source, given `f`, the built facade, and `args`) in a process of its own with the
 * computer's environment, as one of its processes would (a facade loaded in the test process keeps the first
 * computer's identity, and would take another computer's carton.db for a copied one). Answers what body returns.
 */
function asProcess(pc, b, body, args) {
  const code = `const f = require(${JSON.stringify(path.join(b.carton, "carton-node.cjs"))});
    (async (f, args) => { ${body} })(f, JSON.parse(process.argv[1])).then((r) => { process.stdout.write("\\n@@" + JSON.stringify(r ?? null)); process.exit(0); }, (e) => { process.stdout.write("\\n@@" + JSON.stringify({ error: String(e?.stack ?? e) })); process.exit(0); });`;
  const r = spawnSync(process.execPath, ["-e", code, JSON.stringify(args)], { env: pc.env, encoding: "utf8", timeout: 120_000 });
  const out = (r.stdout ?? "").split("\n@@").pop();
  let v;
  try { v = JSON.parse(out); } catch { throw new Error("facade process: " + r.stdout + r.stderr); }
  if (v?.error) throw new Error("facade process: " + v.error);
  return v;
}

/** The History panel as the editor opens it (carton.ui), with its calls answered. */
async function panel(pc, projectId, client) {
  const msgs = () => pc.events().filter((e) => e.change?.kind === "carton" && e.change.client === client).map((e) => e.change.message);
  assert.equal((await pc.call("carton.ui", { projectId, client, message: { t: "hello" } }))?.status, "ok");
  const init = await S.until(() => msgs().find((x) => x.t === "init"), 20_000, "the panel");
  let n = 0;
  const call = async (method, ...args) => {
    const id = ++n;
    await pc.call("carton.ui", { projectId, client, message: { t: "call", id, method, args } });
    return S.until(() => msgs().find((x) => x.t === "ret" && x.id === id), 20_000, "the panel's answer to " + method);
  };
  // the rows the panel shows now (init's, updated by later history messages)
  const rows = () => {
    const all = [...init.history];
    for (const m of msgs()) if (m.t === "history") for (const [i, v] of m.rows) all[i] = v;
    return all;
  };
  return { init, call, rows };
}

/** A computer with the seeded project (made, a clip added, two agent edits), its worker started. */
async function seeded(b, name) {
  const pc = await S.computer(name, b);
  S.seed(pc, b);
  await pc.startWorker();
  const id = (await pc.call("projects.list"))[0].id;
  return { pc, id };
}

test("1. Restore and New cut from here on \"Started the cut\": not offered, refused if asked, the project unchanged", t, async () => {
  const b = await S.build();
  const { pc, id } = await seeded(b, "root-restore");
  try {
    const before = shape(envOf(pc).project);
    assert.equal(before.name, "Demo");
    assert.ok(before.tracks.length && before.items.length && before.media.length, "the seeded project has tracks, clips and media");
    const p = await panel(pc, id, "root-panel");
    const root = p.rows().find((v) => v.seq === 0);
    assert.equal(root.summary, "Project created"); // History's start, in the redesign's words (PLAN 0.4)
    assert.equal(root.empty, true, "the panel's row says it holds nothing (no Preview, New cut from here or Restore)");
    assert.ok(p.rows().filter((v) => v.seq > 0).every((v) => !v.empty), "only the root");
    // asked anyway (an older page, a script): refused in plain words, nothing written
    const r = await p.call("restore", root.ref);
    assert.equal(r.ok, false);
    assert.match(r.error, /^Nothing to restore: that version is empty/);
    const c = await p.call("newCut", "From the start", root.ref);
    assert.equal(c.ok, false);
    assert.match(c.error, /^Nothing to make a cut from: that version is empty/);
    assert.deepEqual(shape(envOf(pc).project), before, "project.json as it was");
    assert.deepEqual(names(await pc.call("projects.list")), ["Demo"], "still in the library");
    // cb, while the app runs: the same, in cb history's words. `cb undo Demo 0` too: 1.4.0's `[rev]` reads "0" as the
    // number 0, which Carton's undo took for no version at all and undid the newest change (laptop, merge/prod-2 P3)
    for (const argv of [["restore", "Demo", "main@0"], ["revert", "Demo", "main@0"], ["cut", "new", "Demo", "From the start", "--from", "main@0"], ["publish", "Demo", "main@0"], ["undo", "Demo", "0"]]) {
      const x = pc.cb(argv);
      assert.equal(x.code, 1, argv.join(" ") + ": " + x.out + x.err);
      assert.match(x.out + x.err, /main@0 is where the history starts, before the project was added: there is nothing in it to (restore|make a cut from|publish)\. The project as it was first saved is main@1\./);
    }
    const h = must(pc.cb(["history", "Demo"]), "history").json();
    assert.equal(h.versions.at(-1).version, "main@0");
    assert.equal(h.versions.at(-1).empty, true);
    assert.equal((await S.projectOf(pc, id)).name, "Demo");
    assert.deepEqual(shape(envOf(pc).project), before);
    assert.deepEqual(must(pc.cb(["cut", "list", "Demo"]), "cut list").json().cuts.map((x) => x.name), ["Main cut"], "no cut was made");
    // the project as it came in (main@1: made, nothing in it yet) restores as any version does, with its name
    const ok = await p.call("restore", root.ref.replace(/@0$/, "@1"));
    assert.equal(ok.ok, true, ok.error);
    await S.until(() => (envOf(pc).project.timelineItems ?? []).length === 0, 20_000, "the restore in project.json");
    assert.equal(envOf(pc).project.name, "Demo");
    assert.deepEqual(names(await pc.call("projects.list")), ["Demo"]);
  } finally {
    await pc.stopWorker();
    S.killHelpers();
  }
});

test("2. no writer puts a project.json Cardboard can't read on disk: the old file stays, the refusal is logged", t, async () => {
  const b = await S.build();
  const { pc, id } = await seeded(b, "root-guard");
  try {
    const file = path.join(bundleOf(pc), "project.json");
    const before = fs.readFileSync(file, "utf8");
    // the worker's store, as an editor page that lost the name would save (the whole project, its name owned)
    const doc = await S.projectOf(pc, id);
    const { name: _gone, ...nameless } = doc;
    await pc.call("projects.updateScoped", { ...nameless, timelineItems: [], tracks: [], stateUpdatedAt: Date.now() }, { ownedFields: ["name", "tracks", "timelineItems"], carton: { base: doc.stateUpdatedAt, actor: "person" } }).catch(() => null);
    assert.equal(fs.readFileSync(file, "utf8"), before, "project.json byte for byte");
    assert.deepEqual(names(await pc.call("projects.list")), ["Demo"], "still in the library");
    assert.equal((await S.projectOf(pc, id)).name, "Demo", "the store reads the file again");
    const log = refusedLog(pc);
    assert.ok(log.some((l) => l.where === "change" && l.problems.includes("no name") && l.projectId === id), "not a version: " + JSON.stringify(log));
    assert.ok(log.some((l) => l.where === "save" && l.problems.includes("no name") && l.projectId === id), "not written: " + JSON.stringify(log));
    const h = must(pc.cb(["history", "Demo"]), "history").json();
    assert.ok(!h.versions.some((v) => v.kind === "edit" && v.by?.id === "person"), "history holds no version of it");
    assert.ok(!JSON.stringify(log).includes("Demo"), "the log holds no text of the project's");
    // the facade's install itself (both copies of the store install through it), fed broken documents
    const env = JSON.parse(before);
    const brokens = [
      { ...env, project: { ...env.project, name: undefined, tracks: [], timelineItems: [], media: [] } },
      { ...env, project: { ...env.project, name: "   " } },
      { ...env, project: { ...env.project, id: undefined } },
      { ...env, project: { ...env.project, media: [{ data: { type: "video" } }] } },
      { ...env, media: "nope" },
    ];
    const installed = asProcess(pc, b, `
      const fs = require("fs"), path = require("path"), out = [];
      for (const broken of args.brokens) {
        const tmp = path.join(args.bundle, ".project.json." + Math.random().toString(16).slice(2) + ".tmp");
        fs.writeFileSync(tmp, JSON.stringify(broken));
        out.push([await f.cardboard14.install(tmp, args.file, undefined, broken.project.stateUpdatedAt, broken), fs.existsSync(tmp)]);
      }
      // and one without the envelope (read from the temp file)
      const tmp = path.join(args.bundle, ".project.json.noenv.tmp");
      fs.writeFileSync(tmp, JSON.stringify(args.brokens[0]));
      out.push([await f.cardboard14.install(tmp, args.file), fs.existsSync(tmp)]);
      return out;`, { brokens, bundle: bundleOf(pc), file });
    assert.deepEqual(installed, Array(brokens.length + 1).fill([false, false]), "each refused, its temp file gone");
    assert.equal(fs.readFileSync(file, "utf8"), before);
    // Cardboard's own reader can't take what was refused: the library drops a project with no name
    const probe = path.join(pc.root, "Probe.cardboard");
    fs.mkdirSync(probe);
    fs.writeFileSync(path.join(probe, "project.json"), JSON.stringify({ ...env, project: { ...env.project, id: env.project.id + "-probe", name: undefined, media: [] }, media: [] }));
    assert.deepEqual(names(await pc.call("projects.list")), ["Demo"], "a nameless project.json is not a project to Cardboard");
    // and Carton never starts a history from one (its first version would be a project with no name)
    assert.equal(asProcess(pc, b, "return await f.cardboard14.hasHistory(args.probe);", { probe }), false);
    assert.equal(fs.existsSync(path.join(probe, ".carton", "carton.db")), false, "no history made");
    fs.rmSync(probe, { recursive: true, force: true });
    // a good save after all that lands as usual
    await S.guiSave(pc, id, (it) => (it.type === "text" ? { ...it, fontSize: 155 } : undefined));
    await S.until(() => envOf(pc).project.timelineItems.some((i) => i.fontSize === 155), 20_000, "the save in project.json");
    assert.equal(envOf(pc).project.name, "Demo");
  } finally {
    await pc.stopWorker();
    S.killHelpers();
  }
});

/**
 * A project broken as build 915eb36 broke it: its history gains a version with nothing in it (what restoring main@0
 * made), and project.json is written from that version over the old file (no name; empty tracks, clips and media;
 * the media manifest empty too), under a rev Carton knows. Made with the worker stopped, through the facade.
 */
async function breakLikeTheBug(pc, b) {
  const bundle = bundleOf(pc);
  const env = envOf(pc);
  const { name: _n, description: _d, aspectRatio: _a, ...rest } = env.project;
  const broken = { ...rest, tracks: [], timelineItems: [], media: [], stateUpdatedAt: Date.now() + 1000 };
  // the empty root's state, committed as the person's restore was (core refuses that restore now), and the file
  const r = asProcess(pc, b, `
    const lc = await f.internals.open(args.bundle);
    const r = await lc.carton.commit({ doc: { tracks: [], timelineItems: [], media: [] }, author: { kind: "human", id: "person" } });
    if (r.status !== "confirmed") throw new Error("not committed: " + r.status);
    require("fs").writeFileSync(require("path").join(args.bundle, "project.json"), JSON.stringify(args.file, null, 2));
    await f.internals.setRevFor(args.bundle, args.rev, r.ref);
    return r.ref;`, { bundle, file: { ...env, project: broken, media: [] }, rev: broken.stateUpdatedAt });
  assert.equal(typeof r.seq, "number");
  return { env, broken };
}

test("3. a project broken this way is found through its history, and Restore of a good version brings it back", t, async (tc) => {
  const b = await S.build();
  const pc = await S.computer("root-recover", b);
  S.seed(pc, b);
  try {
    const good = shape(envOf(pc).project);
    const goodMedia = envOf(pc).project.media;
    const files = envOf(pc).media.map((x) => x.mediaId);
    assert.ok(files.length, "the seeded clip has a file in the bundle");
    const { broken } = await breakLikeTheBug(pc, b);
    assert.equal(envOf(pc).project.name, undefined, "broken as the bug left it");
    // cb, the app closed: the project is found, its history and cuts listed
    const h = must(pc.cb(["history", "Demo"]), "cb history").json();
    assert.equal(h.versions[0].version, "main@5", "the broken version is head");
    assert.equal(h.versions.at(-1).version, "main@0");
    const cuts = must(pc.cb(["cut", "list", "Demo"]), "cb cut list").json();
    assert.deepEqual(cuts.cuts.map((c) => c.name), ["Main cut"]);
    assert.ok(must(pc.cb(["project", "list"]), "cb project list").out.includes("Demo"), "cb's library lists it");
    // nothing was written to find it
    assert.equal(envOf(pc).project.name, undefined);
    assert.equal(envOf(pc).project.stateUpdatedAt, broken.stateUpdatedAt);
    // the app: the library lists it under its name, the editor's History shows its versions
    await pc.startWorker();
    const list = await pc.call("projects.list");
    assert.deepEqual(names(list), ["Demo"]);
    const id = list[0].id;
    const p = await panel(pc, id, "recover-panel");
    const rows = p.rows();
    assert.deepEqual(rows.map((v) => v.seq), [0, 1, 2, 3, 4, 5], "every version, oldest first");
    // Restore the version before the break
    const r = await p.call("restore", rows.find((v) => v.seq === 4).ref);
    assert.equal(r.ok, true, r.error);
    await S.until(() => envOf(pc).project.name === "Demo", 20_000, "project.json with its name");
    const back = envOf(pc).project;
    assert.deepEqual(shape(back), good, "its name, tracks, clips and media library are back");
    // What Carton doesn't version about a media entry (the manifest of where its file is, the probe: size, duration,
    // thumbnails) went with the old file when the bug wrote over it. Cardboard's own reader finds a file in the bundle
    // again by its media id (its recovery of unlisted media), and the next save lists it.
    assert.deepEqual(back.media.map((m) => m.id), goodMedia.map((m) => m.id));
    const fields = (m) => Object.keys(m.data ?? {}).sort().join(",");
    tc.diagnostic(`media fields before the break: ${goodMedia.map(fields).join(" | ")}; after the restore: ${back.media.map(fields).join(" | ")}`);
    await S.projectOf(pc, id); // the editor reads it
    await S.guiSave(pc, id, (it) => (it.type === "text" ? { ...it, fontSize: 161 } : undefined));
    await S.until(() => envOf(pc).project.timelineItems.some((i) => i.fontSize === 161), 20_000, "the save in project.json");
    const manifest = envOf(pc).media;
    tc.diagnostic(`the manifest after a save: ${JSON.stringify(manifest.map((x) => ({ id: x.mediaId, own: x.ownedByBundle, file: path.basename(x.nativePath) })))}`);
    assert.ok(files.every((m) => manifest.some((x) => x.mediaId === m && x.ownedByBundle)), "every clip's file is listed again: " + JSON.stringify(manifest));
    // and the library, cb and the panel go on as for any project
    assert.equal((await S.projectOf(pc, id)).name, "Demo");
    const after = must(pc.cb(["history", "Demo"]), "cb history after").json();
    assert.deepEqual(after.versions.slice(0, 2).map((v) => v.kind), ["edit", "restore"], "the restore, then the save");
  } finally {
    await pc.stopWorker();
    S.killHelpers();
  }
});

test("3b. through cb alone: a broken project is found, and cb restore brings it back", t, async () => {
  const b = await S.build();
  const pc = await S.computer("root-recover-cb", b);
  S.seed(pc, b);
  try {
    const good = shape(envOf(pc).project);
    await breakLikeTheBug(pc, b);
    const h = must(pc.cb(["history", "Demo"]), "cb history").json();
    assert.deepEqual(h.versions.map((v) => v.version), ["main@5", "main@4", "main@3", "main@2", "main@1", "main@0"]);
    must(pc.cb(["restore", "Demo", "main@4"]), "cb restore");
    assert.deepEqual(shape(envOf(pc).project), good);
    assert.ok(must(pc.cb(["project", "list"]), "cb project list").out.includes("Demo"));
    // the clip's details, which the broken file had lost, come from Cardboard's own probe of its file (3f)
    const clip = envOf(pc).project.media.find((m) => m.data?.type === "video");
    assert.equal(clip.data.src, "cardboard-media://media/" + encodeURIComponent(clip.id));
    assert.equal(clip.data.duration, 3);
    const listed = must(pc.cb(["media", "list", "Demo"]), "cb media list").json().find((m) => m.id === clip.id);
    assert.equal(listed.duration, 3, "cb media list shows its duration: " + JSON.stringify(listed));
  } finally {
    S.killHelpers();
  }
});

/** The media entries of a project by id. */
const mediaById = (p) => Object.fromEntries((p.media ?? []).map((m) => [m.id, m]));
const videoIn = (p) => (p.media ?? []).find((m) => m.data?.type === "video");

test("3f. a recovered project's clip plays without a restart: Restore of a good version gives it what Cardboard's import gives it, from Cardboard's own probe", t, async () => {
  const b = await S.build();
  const pc = await S.computer("root-recover-play", b);
  S.seed(pc, b);
  try {
    const was = videoIn(envOf(pc).project);
    assert.ok(was.data.src && was.data.duration > 0 && was.data.size > 0 && was.data.thumbnailIds?.length, "Cardboard's import gave the clip its details: " + JSON.stringify(was));
    await breakLikeTheBug(pc, b);
    await pc.startWorker();
    const id = (await pc.call("projects.list"))[0].id;
    const p = await panel(pc, id, "play-panel");
    const changes = () => pc.events().filter((e) => e.kind === "change" && e.change?.id === id && e.change.kind === "changed").length;
    const n0 = changes();
    const r = await p.call("restore", p.rows().find((v) => v.seq === 4).ref);
    assert.equal(r.ok, true, r.error);
    await S.until(() => envOf(pc).project.name === "Demo", 20_000, "project.json with its name");
    // Where it plays from and the probe's facts, as the import gave them: Cardboard's probe of the file, which the
    // broken file no longer named (its recovery of unlisted media finds it by id). When it was added, which nothing
    // recorded, is the project's own date: Cardboard's editor can't save an entry without one (final candidate P1-1).
    const clip = videoIn(envOf(pc).project);
    assert.equal(clip.id, was.id);
    for (const k of ["src", "format", "size", "duration", "width", "height", "frameRate", "hasAudio", "codec", "metadataStatus"]) assert.deepEqual(clip.data[k], was.data[k], k);
    assert.deepEqual([clip.createdAt, clip.addedAt], [envOf(pc).project.createdAt, envOf(pc).project.createdAt]);
    // Thumbnails and the waveform: Cardboard's own derive (ensureDerived), from what its cache holds for the clip
    await S.until(() => videoIn(envOf(pc).project).data.thumbnailIds?.length, 30_000, "the clip's thumbnails");
    const derived = videoIn(envOf(pc).project);
    assert.deepEqual(derived.data.thumbnailIds, was.data.thumbnailIds);
    assert.equal(derived.data.waveformId, was.data.waveformId);
    // the app serves its file now: main's media map (the worker's mirror, refreshed as main reads the project on the
    // change) has it, in this bundle
    // (worker-proc.js passes the worker's posts on every 10 ms, its answers at once)
    await pc.call("projects.read", id);
    const mirror = () => pc.events().filter((e) => e.kind === "mirror").at(-1)?.entries ?? [];
    const served = await S.until(() => mirror().find((e) => e.mediaId === clip.id && e.bundlePath), 5_000, "the clip in main's media map").catch(() => null);
    assert.ok(served && fs.existsSync(served.nativePath) && path.resolve(served.bundlePath) === path.resolve(bundleOf(pc)), "main's media map: " + JSON.stringify(mirror()));
    assert.deepEqual(await pc.call("media.locate", [clip.id]).then((x) => !!x[clip.id]), true);
    // and the editor heard of both: the restore, then the derived details (the worker's own write isn't announced)
    await S.until(() => changes() >= n0 + 2, 20_000, "a change for the thumbnails");
    // bringing them back made no version
    const h = must(pc.cb(["history", "Demo"]), "cb history").json();
    assert.deepEqual(h.versions.slice(0, 2).map((v) => v.kind), ["restore", "edit"], "the restore, then the break");
  } finally {
    await pc.stopWorker();
    S.killHelpers();
  }
});

test("3h. a recovered clip whose file is missing at the restore gets its details once the file is back, from the file as it is then (review of fix/media-meta #2, #4)", t, async () => {
  const b = await S.build();
  const pc = await S.computer("root-recover-later", b);
  S.seed(pc, b);
  try {
    const id0 = videoIn(envOf(pc).project).id;
    const file = fs.readdirSync(path.join(bundleOf(pc), "media")).find((n) => n.startsWith(id0));
    const at = path.join(bundleOf(pc), "media", file), aside = path.join(pc.home, "aside.mp4");
    await breakLikeTheBug(pc, b);
    fs.renameSync(at, aside); // (an unplugged drive, a sync client still downloading)
    await pc.startWorker();
    const id = (await pc.call("projects.list"))[0].id;
    const p = await panel(pc, id, "later-panel");
    assert.equal((await p.call("restore", p.rows().find((v) => v.seq === 4).ref)).ok, true);
    await S.until(() => envOf(pc).project.name === "Demo", 20_000, "the restore");
    assert.equal(videoIn(envOf(pc).project).data.src, undefined, "no file, nothing to say about it");
    // the file comes back, and it is another one (6 s, not the 3 s clip Cardboard probed and cached for the id)
    fs.copyFileSync(b.clip2, at);
    fs.rmSync(aside);
    assert.equal((await p.call("restore", p.rows().find((v) => v.seq === 3).ref)).ok, true);
    await S.until(() => videoIn(envOf(pc).project).data.src, 20_000, "the clip's details");
    const clip = videoIn(envOf(pc).project);
    assert.equal(clip.data.size, fs.statSync(at).size);
    assert.equal(Math.round(clip.data.duration), 6, "the file as it is now, not the probe cached for the id: " + clip.data.duration);
  } finally {
    await pc.stopWorker();
    S.killHelpers();
  }
});

test("4b. an entry the file holds with its src but not its details (an older writer's) gets them: what was kept of that media, else Cardboard's probe (review of fix/media-meta #3)", t, async () => {
  const b = await S.build();
  const pc = await S.computer("restore-partial", b);
  S.seed(pc, b);
  try {
    const full = videoIn(envOf(pc).project);
    must(pc.cb(["restore", "Demo", "main@1"]), "cb restore main@1"); // keeps the clip's details as it drops it
    must(pc.cb(["restore", "Demo", "main@4"]), "cb restore main@4");
    // project.json written by another writer with the clip's src only, under head's rev (Carton takes it as head)
    const partial = (cut) => {
      const env = envOf(pc);
      const media = env.project.media.map((m) => (m.id === full.id ? { id: m.id, data: { type: m.data.type, fileName: m.data.fileName, ...cut(m.data) } } : m));
      const project = { ...env.project, media, stateUpdatedAt: env.project.stateUpdatedAt + 1 };
      asProcess(pc, b, `
        const lc = await f.internals.open(args.bundle);
        require("fs").writeFileSync(require("path").join(args.bundle, "project.json"), JSON.stringify(args.file, null, 2));
        await f.internals.setRevFor(args.bundle, args.rev, (await lc.carton.head()).ref);`, { bundle: bundleOf(pc), file: { ...env, project }, rev: project.stateUpdatedAt });
    };
    partial((d) => ({ src: d.src }));
    must(pc.cb(["restore", "Demo", "main@3"]), "cb restore main@3");
    assert.deepEqual(videoIn(envOf(pc).project), full, "what was kept of it, in full");
    // nothing kept: Cardboard's probe of its file fills in what the import gives
    fs.rmSync(path.join(bundleOf(pc), ".carton", "media.json"));
    partial((d) => ({ src: d.src }));
    must(pc.cb(["restore", "Demo", "main@4"]), "cb restore main@4");
    const clip = videoIn(envOf(pc).project);
    for (const k of ["src", "format", "size", "duration", "width", "height", "frameRate", "hasAudio", "codec", "metadataStatus"]) assert.deepEqual(clip.data[k], full.data[k], k);
  } finally {
    S.killHelpers();
  }
});

test("3g. the \"can't be read\" warning is for the project a cb command names, not every command on the library", t, async () => {
  const b = await S.build();
  const pc = await S.computer("root-recover-quiet", b);
  S.seed(pc, b);
  must(pc.cb(["project", "create", "Other"]), "create Other");
  try {
    await breakLikeTheBug(pc, b);
    const warns = (x) => (x.out + x.err).split("\n").filter((l) => /can't be read/.test(l));
    assert.deepEqual(warns(must(pc.cb(["history", "Other"]), "history Other")), [], "a command on another project");
    assert.deepEqual(warns(must(pc.cb(["project", "list"]), "project list")), [], "the library's list");
    const own = warns(must(pc.cb(["history", "Demo"]), "history Demo"));
    assert.equal(own.length, 1, "a command on the broken project says so, once: " + JSON.stringify(own));
    assert.doesNotMatch(own[0], /Demo/, "in words with no project text");
  } finally {
    S.killHelpers();
  }
});

test("4. Restore of main@1, then of the newest version: each media entry comes back as Cardboard had it (duration, size, thumbnails, where it plays from); the library's Updated time moves", t, async () => {
  const b = await S.build();
  const { pc, id } = await seeded(b, "restore-details");
  try {
    const before = mediaById(envOf(pc).project);
    const clip = videoIn(envOf(pc).project);
    assert.ok(clip.data.src && clip.data.duration > 0 && clip.data.size > 0 && clip.data.thumbnailIds?.length, "Cardboard's import gave the clip its details");
    const p = await panel(pc, id, "details-panel");
    const newest = p.rows().at(-1);
    const updated0 = envOf(pc).project.updatedAt;
    let r = await p.call("restore", p.rows().find((v) => v.seq === 1).ref);
    assert.equal(r.ok, true, r.error);
    await S.until(() => (envOf(pc).project.media ?? []).length === 0, 20_000, "main@1 in project.json");
    // a restore is an edit: the library's Updated time moves (the list shows the file's)
    assert.ok(Date.parse(envOf(pc).project.updatedAt) > Date.parse(updated0), `updatedAt ${updated0} → ${envOf(pc).project.updatedAt}`);
    assert.equal((await pc.call("projects.list")).find((x) => x.id === id).updatedAt, envOf(pc).project.updatedAt);
    r = await p.call("restore", newest.ref);
    assert.equal(r.ok, true, r.error);
    await S.until(() => (envOf(pc).project.media ?? []).length === Object.keys(before).length, 20_000, "the newest version in project.json");
    assert.deepEqual(mediaById(envOf(pc).project), before, "every entry as it was, details and all");
    const listed = must(pc.cb(["media", "list", "Demo"]), "cb media list").json().find((m) => m.id === clip.id);
    assert.deepEqual([listed.duration, listed.size], [clip.data.duration, clip.data.size]);
    const h = must(pc.cb(["history", "Demo"]), "cb history").json();
    assert.deepEqual(h.versions.slice(0, 3).map((v) => v.kind), ["restore", "restore", "edit"], "the two restores, nothing else");
    // and through cb alone, the app closed
    await pc.stopWorker();
    must(pc.cb(["restore", "Demo", "main@1"]), "cb restore main@1");
    assert.deepEqual(envOf(pc).project.media ?? [], []);
    must(pc.cb(["restore", "Demo", h.versions[0].version]), "cb restore the newest");
    assert.deepEqual(mediaById(envOf(pc).project), before, "every entry as it was, through cb");
  } finally {
    await pc.stopWorker();
    S.killHelpers();
  }
});

test("3c. a history kept in app data (the library in a synced folder) is found too", t, async () => {
  const b = await S.build();
  const pc = await S.computer("root-recover-away", b);
  fs.mkdirSync(path.join(pc.home, ".dropbox"), { recursive: true }); // Dropbox's marker: history goes to app data (L15)
  S.seed(pc, b);
  try {
    assert.equal(fs.existsSync(path.join(bundleOf(pc), ".carton", "carton.db")), false, "no history in the bundle");
    const good = shape(envOf(pc).project);
    await breakLikeTheBug(pc, b);
    const h = must(pc.cb(["history", "Demo"]), "cb history").json();
    assert.equal(h.versions[0].version, "main@5");
    must(pc.cb(["restore", "Demo", "main@4"]), "cb restore");
    assert.deepEqual(shape(envOf(pc).project), good);
  } finally {
    S.killHelpers();
  }
});

/**
 * The history files, as bytes: what a check that must change nothing compares. (SQLite's own -wal and -shm, which a
 * read-only open of a WAL database makes, aren't the history.)
 */
const historyFiles = (bundle) => {
  const dir = path.join(bundle, ".carton");
  return Object.fromEntries(fs.readdirSync(dir).filter((n) => n.startsWith("carton.") && !/-(wal|shm)$/.test(n)).map((n) => [n, require("crypto").createHash("sha256").update(fs.readFileSync(path.join(dir, n))).digest("hex")]));
};

test("3d. another project's history, or another computer's, is never used to find a damaged project, and nothing of it changes", t, async () => {
  const b = await S.build();
  const pc = await S.computer("root-recover-foreign", b);
  S.seed(pc, b);
  const pc2 = await S.computer("root-recover-foreign-2", b);
  try {
    const env = envOf(pc);
    const nameless = (id) => JSON.stringify({ ...env, project: { ...env.project, id, name: undefined, tracks: [], timelineItems: [], media: [] }, media: [] });
    // a damaged project B whose .carton is project A's (a folder copied, or a stale .carton left behind)
    const other = path.join(pc.root, "Other.cardboard");
    fs.cpSync(bundleOf(pc), other, { recursive: true });
    fs.writeFileSync(path.join(other, "project.json"), nameless("project-B"));
    const before = historyFiles(other);
    const list = must(pc.cb(["project", "list"]), "cb project list").out;
    assert.ok(list.includes("Demo") && !list.includes("Other"), "B isn't listed under A's history: " + list);
    assert.notEqual(pc.cb(["history", "Other"]).code, 0);
    assert.deepEqual(historyFiles(other), before, "A's history in B's folder is as it was");
    // A's folder, damaged, on another computer (its history was made here, not there)
    const away = path.join(pc2.root, "Demo.cardboard");
    fs.cpSync(bundleOf(pc), away, { recursive: true });
    fs.writeFileSync(path.join(away, "project.json"), nameless(env.project.id));
    const there = historyFiles(away);
    const list2 = must(pc2.cb(["project", "list"]), "cb project list there").out;
    assert.ok(!list2.includes("Demo"), "not listed through another computer's history: " + list2);
    assert.deepEqual(historyFiles(away), there, "nothing set aside or written");
    assert.ok(!fs.readdirSync(path.join(away, ".carton")).some((n) => n.startsWith("carton.from-")));
  } finally {
    S.killHelpers();
  }
});

/** Cardboard's own project.json reader (`ui` in 1.5.0's library-worker.js, 1.4.0's `ti`), out of the pristine bundle: null when it refuses. */
function cardboardReader() {
  const Module = require("module");
  const file = path.join(process.env.CARDBOARD_PRISTINE, "app-asar", "dist", "library-worker.js");
  const src = fs.readFileSync(file, "utf8");
  const m = new Module(file, module);
  m.filename = file;
  m.paths = Module._nodeModulePaths(path.dirname(file));
  m._compile(src.slice(0, src.lastIndexOf("Fie().catch(")) + "module.exports={parse:ui};", file);
  return m.exports.parse;
}

test("3e. code graphics: restored with their size (from the clip that shows them); one no clip shows is never written, and History and cb say so", t, async () => {
  const b = await S.build();
  const pc = await S.computer("root-recover-code", b);
  const read = cardboardReader();
  const graphic = (id) => ({ id, createdAt: "2026-11-02T00:00:00.000Z", addedAt: "2026-11-02T00:00:00.000Z", data: { type: "code", fileName: "Graphic " + id, format: "code", size: 0, code: { source: "export default () => null;", width: 1920, height: 1080 } } });
  // (each project its own media ids: the library drops two bundles that share one)
  const make = (name, id, gid, items) => {
    const dir = path.join(pc.root, name + ".cardboard");
    fs.mkdirSync(dir, { recursive: true });
    const project = { id, name, createdAt: "2026-11-02T00:00:00.000Z", updatedAt: "2026-11-02T00:00:00.000Z", stateUpdatedAt: 1, aspectRatio: "16:9", tracks: [{ id: "v1", name: "V1", order: 0, locked: false, visible: true, muted: false }], timelineItems: items, media: [graphic(gid)] };
    fs.writeFileSync(path.join(dir, "project.json"), JSON.stringify({ format: "cardboard-project", version: 1, project, media: [] }));
    return dir;
  };
  const shown = make("Shown", "code-shown", "g-shown", [{ id: "c1", trackId: "v1", type: "code", mediaItemId: "g-shown", startTime: 0, endTime: 5, trimStart: 0, trimEnd: 5, codeComposition: { source: "export default () => null;", width: 1920, height: 1080 } }]);
  const unused = make("Unused", "code-unused", "g-unused", []);
  try {
    for (const dir of [shown, unused]) {
      assert.ok(read(fs.readFileSync(path.join(dir, "project.json"), "utf8")), "Cardboard reads it");
      // history starts (cb reads it), then the file is broken as build 915eb36 broke it
      must(pc.cb(["history", path.basename(dir, ".cardboard")]), "history");
      const env = JSON.parse(fs.readFileSync(path.join(dir, "project.json"), "utf8"));
      const { name: _n, aspectRatio: _a, ...rest } = env.project;
      const broken = { ...rest, tracks: [], timelineItems: [], media: [], stateUpdatedAt: Date.now() };
      asProcess(pc, b, `
        const lc = await f.internals.open(args.dir);
        const r = await lc.carton.commit({ doc: { tracks: [], timelineItems: [], media: [] }, author: { kind: "human", id: "person" } });
        require("fs").writeFileSync(require("path").join(args.dir, "project.json"), JSON.stringify(args.file));
        await f.internals.setRevFor(args.dir, args.rev, r.ref);`, { dir, file: { ...env, project: broken, media: [] }, rev: broken.stateUpdatedAt });
      assert.equal(read(fs.readFileSync(path.join(dir, "project.json"), "utf8")), null, "broken: Cardboard can't read it");
    }
    // the graphic a clip shows: restored, with its size, and Cardboard reads the file
    must(pc.cb(["restore", "Shown", "main@1"]), "cb restore Shown");
    const text = fs.readFileSync(path.join(shown, "project.json"), "utf8");
    assert.ok(read(text), "Cardboard reads the restored file");
    assert.deepEqual(JSON.parse(text).project.media[0].data.code, graphic("g-shown").data.code);
    // the graphic no clip shows: its size is nowhere in the history; cb says the file wasn't changed
    const before = fs.readFileSync(path.join(unused, "project.json"), "utf8");
    const r = pc.cb(["restore", "Unused", "main@1"]);
    assert.equal(r.code, 1, r.out + r.err);
    assert.match(r.out + r.err, /Saved in history, but project.json wasn't changed: Cardboard couldn't have read it \(media\[0\]\.data\.code needs its source, width and height\)\. Restore another version\./);
    assert.equal(fs.readFileSync(path.join(unused, "project.json"), "utf8"), before);
    // and the History panel, in the app
    await pc.startWorker();
    const id = (await pc.call("projects.list")).find((p) => p.name === "Unused").id;
    const p = await panel(pc, id, "code-panel");
    const back = await p.call("restore", p.rows().find((v) => v.seq === 1).ref);
    assert.equal(back.ok, false);
    assert.equal(back.error, "This is saved in History, but the project file wasn't changed: Cardboard couldn't have opened it that way. Restore another version.");
    assert.equal(fs.readFileSync(path.join(unused, "project.json"), "utf8"), before);
  } finally {
    await pc.stopWorker();
    S.killHelpers();
  }
});

test("2b. the write check and Cardboard's own reader agree on a real project and its broken variants (only the intended extra rules differ)", t, async () => {
  const b = await S.build();
  const pc = await S.computer("root-guard-reader", b);
  S.seed(pc, b);
  const read = cardboardReader();
  const { projectProblems } = await import(require("url").pathToFileURL(path.join(__dirname, "../../../../carton/packages/cardboard/src/valid.ts")).href);
  const env = envOf(pc);
  const p = env.project;
  const it0 = p.timelineItems[0], m0 = p.media[0];
  const v = (project, rest = {}) => ({ ...env, ...rest, project: { ...p, ...project } });
  const cases = {
    "as Cardboard wrote it": env,
    "new project (no tracks or clips yet)": v({ tracks: undefined, timelineItems: undefined, media: [] }),
    "no manifest": { format: env.format, version: env.version, project: p },
    "no name": v({ name: undefined }),
    "name not text": v({ name: 7 }),
    "no id": v({ id: undefined }),
    "no updatedAt": v({ updatedAt: undefined }),
    "aspectRatio null": v({ aspectRatio: null }),
    "stateUpdatedAt text": v({ stateUpdatedAt: "1" }),
    "temp not boolean": v({ temp: "yes" }),
    "media not a list": v({ media: {} }),
    "a media entry without id": v({ media: [{ ...m0, id: undefined }] }),
    "a media entry's data without type": v({ media: [{ ...m0, data: { ...m0.data, type: undefined } }] }),
    "a code graphic without its size": v({ media: [...p.media, { id: "g", data: { type: "code", code: { source: "x" } } }] }),
    "a clip's endTime null": v({ timelineItems: [{ ...it0, endTime: null }, ...p.timelineItems.slice(1)] }),
    "a clip's codeComposition without size": v({ timelineItems: [{ ...it0, codeComposition: { source: "x" } }, ...p.timelineItems.slice(1)] }),
    "items not a list": v({ timelineItems: {} }),
    "cast not a list": v({ cast: {} }),
    "manifest not a list": v({}, { media: {} }),
    "another format": v({}, { format: "x" }),
  };
  // what the check refuses on purpose though the reader takes it: a project losing its name (with the file it replaces),
  // and records without ids (Carton keys tracks and clips by id)
  const extra = {
    "a blank name over a named project": [v({ name: " " }), () => p],
    "a clip without id": [v({ timelineItems: [{ ...it0, id: undefined }] })],
    "a track without id": [v({ tracks: [{ ...p.tracks[0], id: undefined }] })],
  };
  for (const [what, doc] of Object.entries(cases)) {
    const reader = !!read(JSON.stringify(doc)), check = projectProblems(JSON.parse(JSON.stringify(doc)));
    assert.equal(check.length === 0, reader, `${what}: Cardboard ${reader ? "reads" : "refuses"} it, the check says ${JSON.stringify(check)}`);
  }
  for (const [what, [doc, before]] of Object.entries(extra)) {
    assert.ok(read(JSON.stringify(doc)), `${what}: Cardboard reads it`);
    assert.ok(projectProblems(JSON.parse(JSON.stringify(doc)), before).length > 0, `${what}: refused on purpose`);
  }
});

// ---------------------------------------------------------------- laptop, final candidate (0cc587f1): P1-1, P2-1, P3-1, P3-2
// What Cardboard's editor does with a media entry's dates at every save (installErrorTelemetry `p9`, after its load's
// `P2`: `new Date(x)`, then `.toISOString()`). The renderer can't run here: this is what it needs of every entry.
const editorSaves = (m) => { new Date(m.createdAt).toISOString(); new Date(m.addedAt).toISOString(); return true; };
const undated = (p) => (p.media ?? []).filter((m) => { try { return !editorSaves(m); } catch { return true; } }).map((m) => m.id);
/**
 * The laptop's broken projects as the app left them on its first start: broken as build 915eb36 broke them, then named
 * again ("Named the project", main@6): a name, and no aspect ratio, tracks, clips or media.
 */
async function brokenAndNamed(pc, b) {
  const { broken } = await breakLikeTheBug(pc, b);
  const named = { ...broken, name: "Demo", stateUpdatedAt: broken.stateUpdatedAt + 1000 };
  asProcess(pc, b, `
    const lc = await f.internals.open(args.bundle);
    const r = await lc.carton.commit({ doc: { name: "Demo", tracks: [], timelineItems: [], media: [] }, author: { kind: "human", id: "person" } });
    if (r.status !== "confirmed") throw new Error("not committed: " + r.status);
    require("fs").writeFileSync(require("path").join(args.bundle, "project.json"), JSON.stringify(args.file, null, 2));
    await f.internals.setRevFor(args.bundle, args.rev, r.ref);`, { bundle: bundleOf(pc), file: { ...envOf(pc), project: named, media: [] }, rev: named.stateUpdatedAt });
  return named;
}

test("5. P1-1: a project recovered through History is written with every media entry Cardboard's editor can save, and its GUI edits land", t, async () => {
  const b = await S.build();
  const pc = await S.computer("recover-save", b);
  S.seed(pc, b);
  try {
    const created = envOf(pc).project.createdAt;
    await brokenAndNamed(pc, b);
    await pc.startWorker();
    const id = (await pc.call("projects.list"))[0].id;
    const p = await panel(pc, id, "save-panel");
    // the laptop's steps: ⋯ on the version before the break → Restore
    assert.equal((await p.call("restore", p.rows().find((v) => v.seq === 4).ref)).ok, true);
    await S.until(() => (envOf(pc).project.media ?? []).length > 0, 20_000, "the restore in project.json");
    const back = envOf(pc).project;
    assert.deepEqual(undated(back), [], "every entry has dates the editor's save takes: " + JSON.stringify(back.media));
    // nothing kept those dates (the bug came before .carton/media.json): the project's own date, as no media is older
    for (const m of back.media) assert.deepEqual([m.createdAt, m.addedAt], [created, created], m.id);
    for (const m of back.media.filter((x) => x.data?.type === "text")) assert.deepEqual([m.data.format, m.data.size, m.data.presetId], ["text", 0, "custom"], "a title as Cardboard makes one");
    // what the editor loads (the worker's store) is the same
    assert.deepEqual(undated(await S.projectOf(pc, id)), []);
    // a GUI edit (the laptop's: a title deleted) is a version, and in project.json
    const before = must(pc.cb(["history", "Demo"]), "history").json().versions[0].version;
    const doc = await S.projectOf(pc, id);
    const gone = doc.timelineItems.find((i) => i.type === "text");
    await pc.call("projects.updateScoped", { ...doc, timelineItems: doc.timelineItems.filter((i) => i.id !== gone.id), stateUpdatedAt: Date.now() }, { ownedFields: ["tracks", "timelineItems"], carton: { base: doc.stateUpdatedAt, actor: "person" } });
    await S.until(() => !envOf(pc).project.timelineItems.some((i) => i.id === gone.id), 20_000, "the delete in project.json");
    const h = must(pc.cb(["history", "Demo"]), "history after").json();
    assert.notEqual(h.versions[0].version, before);
    assert.equal(h.versions[0].kind, "edit");
    assert.deepEqual(undated(envOf(pc).project), []);
    // through cb alone too (the app closed): cb restore writes complete entries
    await pc.stopWorker();
    must(pc.cb(["restore", "Demo", "main@1"]), "cb restore main@1");
    fs.rmSync(path.join(bundleOf(pc), ".carton", "media.json"), { force: true }); // nothing kept, as on the laptop
    must(pc.cb(["restore", "Demo", "main@4"]), "cb restore main@4");
    assert.ok(envOf(pc).project.media.length > 0);
    assert.deepEqual(undated(envOf(pc).project), []);
  } finally {
    await pc.stopWorker();
    S.killHelpers();
  }
});

test("5b. P1-1: a project already on disk with date-less media (recovered by the earlier candidate) is read with the dates, and its next save writes them", t, async () => {
  const b = await S.build();
  const pc = await S.computer("recover-save-disk", b);
  S.seed(pc, b);
  try {
    const env = envOf(pc);
    const created = env.project.createdAt;
    // the earlier candidate's recovered file (docs/regress/final/restore/project-json): {id, data} only, under head's rev
    const project = { ...env.project, media: env.project.media.map((m) => ({ id: m.id, data: m.data })), stateUpdatedAt: env.project.stateUpdatedAt + 1 };
    asProcess(pc, b, `
      const lc = await f.internals.open(args.bundle);
      require("fs").writeFileSync(require("path").join(args.bundle, "project.json"), JSON.stringify(args.file, null, 2));
      await f.internals.setRevFor(args.bundle, args.rev, (await lc.carton.head()).ref);`, { bundle: bundleOf(pc), file: { ...env, project }, rev: project.stateUpdatedAt });
    assert.equal(undated(envOf(pc).project).length, env.project.media.length, "date-less on disk, as on the laptop");
    await pc.startWorker();
    const id = (await pc.call("projects.list"))[0].id;
    // what the editor loads has them: the project's own date (nothing kept theirs)
    const doc = await S.projectOf(pc, id);
    assert.deepEqual(undated(doc), []);
    assert.ok(doc.media.every((m) => m.createdAt === created));
    // nothing was written to read it so
    assert.equal(undated(envOf(pc).project).length, env.project.media.length);
    // the editor's next save lands, and writes them
    await S.guiSave(pc, id, (it) => (it.type === "text" ? { ...it, fontSize: 171 } : undefined));
    await S.until(() => envOf(pc).project.timelineItems.some((i) => i.fontSize === 171), 20_000, "the save in project.json");
    assert.deepEqual(undated(envOf(pc).project), [], "the save wrote the dates");
    assert.equal(must(pc.cb(["history", "Demo"]), "history").json().versions[0].kind, "edit");
    // cb reads it the same way (its own copy of the store)
    await pc.stopWorker();
    const again = { ...envOf(pc).project, media: envOf(pc).project.media.map((m) => ({ id: m.id, data: m.data })), stateUpdatedAt: envOf(pc).project.stateUpdatedAt + 1 };
    asProcess(pc, b, `
      const lc = await f.internals.open(args.bundle);
      require("fs").writeFileSync(require("path").join(args.bundle, "project.json"), JSON.stringify(args.file, null, 2));
      await f.internals.setRevFor(args.bundle, args.rev, (await lc.carton.head()).ref);`, { bundle: bundleOf(pc), file: { ...envOf(pc), project: again }, rev: again.stateUpdatedAt });
    const edit = path.join(pc.home, "edit5b.tsx");
    must(pc.cb(["source", "print", "Demo"]), "print");
    fs.writeFileSync(edit, fs.readFileSync(path.join(bundleOf(pc), "timeline.tsx"), "utf8").replace(/fontSize=\{171\}/, "fontSize={172}"));
    must(pc.cb(["source", "apply", "Demo", edit]), "cb source apply");
    assert.ok(envOf(pc).project.timelineItems.some((i) => i.fontSize === 172));
    assert.deepEqual(undated(envOf(pc).project), [], "cb's write wrote them too");
  } finally {
    await pc.stopWorker();
    S.killHelpers();
  }
});

test("6. P2-1: Ctrl+Z or cb undo right after the recovery would leave the project empty: refused in plain words, nothing changes; P3-2: the emptied versions are refused as what they are", t, async () => {
  const b = await S.build();
  const pc = await S.computer("recover-undo", b);
  S.seed(pc, b);
  try {
    await brokenAndNamed(pc, b);
    await pc.startWorker();
    const id = (await pc.call("projects.list"))[0].id;
    const since = Date.now();
    const p = await panel(pc, id, "undo-panel");
    // P3-2: the old bug's empty version (main@5) and the named one (main@6): not where the history starts
    for (const seq of [5, 6]) {
      const r = await p.call("restore", p.rows().find((v) => v.seq === seq).ref);
      assert.equal(r.ok, false, "@" + seq);
      assert.equal(r.error, "Nothing to restore: that version is empty (nothing of the project is in it)");
    }
    assert.match((await p.call("restore", p.rows().find((v) => v.seq === 0).ref)).error, /the history starts there/);
    for (const seq of [5, 6]) {
      const x = pc.cb(["restore", "Demo", "main@" + seq]);
      assert.equal(x.code, 1);
      assert.match(x.out + x.err, new RegExp(`main@${seq} holds nothing of the project: there is nothing in it to restore\\. Pick another version \\(see \`cb history\`\\)\\.`));
    }
    assert.equal((await p.call("restore", p.rows().find((v) => v.seq === 4).ref)).ok, true);
    await S.until(() => envOf(pc).project.aspectRatio === "16:9", 20_000, "the restore in project.json");
    const file = fs.readFileSync(path.join(bundleOf(pc), "project.json"), "utf8");
    const head = must(pc.cb(["history", "Demo"]), "history").json().versions[0];
    assert.equal(head.kind, "restore");
    // Ctrl+Z (the GUI's session undo): refused, said, nothing written
    const u = await pc.call("carton.undo", { projectId: id, since });
    assert.equal(u.status, "refused");
    assert.equal(u.error, "Can't undo that: the project would be left empty");
    assert.equal(u.project, undefined, "nothing for the editor to adopt");
    // cb undo, the app open (its holder serves it)
    const c = pc.cb(["undo", "Demo"]);
    assert.equal(c.code, 1, c.out + c.err);
    assert.match(c.out + c.err, /Can't undo that: the project would be left empty/);
    await S.sleep(1500); // anything that would follow (a materialization, a save) has had its time
    assert.equal(must(pc.cb(["history", "Demo"]), "history after").json().versions[0].version, head.version, "no version made");
    assert.equal(fs.readFileSync(path.join(bundleOf(pc), "project.json"), "utf8"), file, "project.json as it was");
    // the person's own edit after it is undone as ever
    await S.guiSave(pc, id, (it) => (it.type === "text" ? { ...it, fontSize: 181 } : undefined));
    await S.until(() => envOf(pc).project.timelineItems.some((i) => i.fontSize === 181), 20_000, "the save");
    const ok = await pc.call("carton.undo", { projectId: id, since });
    assert.equal(ok.status, "confirmed", JSON.stringify(ok));
    await S.until(() => !envOf(pc).project.timelineItems.some((i) => i.fontSize === 181), 20_000, "the undo in project.json");
    // and it stays undone: nothing writes the restored state back over it (the laptop's main@8 after its main@7)
    await S.sleep(3000);
    const h = must(pc.cb(["history", "Demo"]), "history at the end").json().versions;
    assert.equal(h[0].kind, "undo", "the undo is head: " + JSON.stringify(h.slice(0, 3).map((v) => [v.version, v.kind, v.by?.id])));
    assert.ok(!envOf(pc).project.timelineItems.some((i) => i.fontSize === 181));
  } finally {
    await pc.stopWorker();
    S.killHelpers();
  }
});

test("7. P3-1: after a cb restore round trip the media manifest lists the clip's file again, and cb says nothing about unlisted media", t, async () => {
  const b = await S.build();
  const pc = await S.computer("restore-manifest", b);
  S.seed(pc, b);
  try {
    const listed = (e) => (e.media ?? []).map((x) => x.mediaId);
    const clip = videoIn(envOf(pc).project).id;
    assert.deepEqual(listed(envOf(pc)), [clip]);
    must(pc.cb(["restore", "Demo", "main@1"]), "cb restore main@1");
    assert.deepEqual(listed(envOf(pc)), []);
    const r = must(pc.cb(["restore", "Demo", "main@4"]), "cb restore main@4");
    assert.deepEqual(listed(envOf(pc)), [clip], "the file is listed again: " + JSON.stringify(envOf(pc).media));
    assert.ok(envOf(pc).media[0].ownedByBundle);
    for (const x of [r, must(pc.cb(["project", "list"]), "project list"), must(pc.cb(["media", "list", "Demo"]), "media list")]) assert.doesNotMatch(x.err, /unlisted media/, x.err);
    // the GUI round trip lists it too
    await pc.startWorker();
    const id = (await pc.call("projects.list"))[0].id;
    const p = await panel(pc, id, "manifest-panel");
    assert.equal((await p.call("restore", p.rows().find((v) => v.seq === 1).ref)).ok, true);
    await S.until(() => (envOf(pc).project.media ?? []).length === 0, 20_000, "main@1");
    assert.equal((await p.call("restore", p.rows().find((v) => v.seq === 4).ref)).ok, true);
    await S.until(() => listed(envOf(pc)).length === 1, 20_000, "the clip's file listed");
    assert.doesNotMatch(must(pc.cb(["project", "list"]), "project list").err, /unlisted media/);
  } finally {
    await pc.stopWorker();
    S.killHelpers();
  }
});

test("6b. P2-1 (review): a late copy of an earlier version that lost its seen.json entry is no outside edit: displaced by the next write, it doesn't put that version back", t, async () => {
  const b = await S.build();
  const pc = await S.computer("late-copy", b);
  S.seed(pc, b);
  try {
    const file = path.join(bundleOf(pc), "project.json");
    const early = fs.readFileSync(file); // main@4, its rev recorded
    // an edit after it (as an undo would be), main@5
    must(pc.cb(["source", "print", "Demo"]), "print");
    const edit = path.join(pc.home, "edit6b.tsx");
    fs.writeFileSync(edit, fs.readFileSync(path.join(bundleOf(pc), "timeline.tsx"), "utf8").replace("fontSize={140}", "fontSize={191}"));
    must(pc.cb(["source", "apply", "Demo", edit]), "apply");
    const head = must(pc.cb(["history", "Demo"]), "history").json().versions[0].version;
    const now = fs.readFileSync(file);
    // the earlier file back on disk, its entry in seen.json lost (two processes writing it at once can lose one)
    fs.writeFileSync(file, early);
    fs.rmSync(path.join(bundleOf(pc), ".carton", "seen.json"), { force: true });
    // the next write displaces it (the facade's install, as both copies of the store install), and its review runs
    const r = asProcess(pc, b, `
      const fs = require("fs"), path = require("path");
      const tmp = path.join(args.bundle, ".project.json.late.tmp");
      fs.writeFileSync(tmp, args.now);
      const env = JSON.parse(args.now);
      const ok = await f.cardboard14.install(tmp, args.file, undefined, env.project.stateUpdatedAt, env);
      await new Promise((r) => setTimeout(r, 2000)); // the review of what it displaced (300 ms after the install)
      return ok;`, { bundle: bundleOf(pc), file, now: now.toString("utf8") });
    assert.notEqual(r, false, "installed");
    const h = must(pc.cb(["history", "Demo"]), "history after").json().versions;
    assert.equal(h[0].version, head, "no version put the earlier one back: " + JSON.stringify(h.slice(0, 2).map((v) => [v.version, v.kind, v.by?.id])));
    assert.ok(envOf(pc).project.timelineItems.some((i) => i.fontSize === 191), "the edit stays in project.json");
  } finally {
    S.killHelpers();
  }
});
