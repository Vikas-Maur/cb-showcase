// Restore and "New cut from here" on "Started the cut" (laptop, build 915eb36, reproduced twice): the History panel's
// oldest row is main@0, the empty root an imported project's history starts from. Restoring it wrote a project.json
// with no name and empty tracks and media; Cardboard's library dropped the project, and `cb history` and `cb cut list`
// found nothing. Here, through Cardboard's real library worker, cb and bundles (support.js):
//   1. the root is offered nothing, and asking anyway (the panel, cb, MCP) changes nothing;
//   2. no writer puts a project.json Cardboard can't read on disk: the old file stays, the refusal is logged;
//   3. a project already broken this way is found through its history (the library, cb history, cb cut list, the
//      panel), and Restore of a good version brings it back.
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
    assert.equal(root.summary, "Started the cut");
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
    // cb, while the app runs: the same, in cb history's words
    for (const argv of [["restore", "Demo", "main@0"], ["revert", "Demo", "main@0"], ["cut", "new", "Demo", "From the start", "--from", "main@0"], ["publish", "Demo", "main@0"]]) {
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
  } finally {
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
