// Tests for patch-carton.js, run under Node on Linux or Windows against Cardboard 1.4.0's own bundles. They are not
// in git: CARDBOARD_PRISTINE names a folder with app-asar/ (as `asar extract` gives it) and cli/. Without it the
// tests skip. Media import needs ffmpeg and ffprobe (CARDBOARD_FFMPEG / CARDBOARD_FFPROBE, or on PATH).
//   CARDBOARD_PRISTINE=… node --test --test-concurrency=1 scripts/carton/test/patches.test.js
// They check that:
// - with Carton off, the patched cb behaves as our Windows build does: the same output and the same files;
// - a .cbproj never carries .carton/ or .scratch/views/, with Carton on or off;
// - with Carton on, every hook reaches the facade with the right arguments (a recording fake stands in for Carton);
// - the library worker runs patched, off and on: a GUI save, an agent's timeline.tsx, the carton RPC namespace.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs"), os = require("os"), path = require("path"), { spawnSync, execFileSync } = require("child_process");
const { stage } = require("./stage.js");

const PRISTINE = process.env.CARDBOARD_PRISTINE;
const skip = !PRISTINE || !fs.existsSync(path.join(PRISTINE ?? "", "app-asar")) ? "set CARDBOARD_PRISTINE to Cardboard 1.4.0's unpacked app and cli" : false;
const TMP = process.env.CARTON_TEST_DIR ?? path.join(os.tmpdir(), "carton-patch-tests");
const FAKE = path.join(__dirname, "fake-carton-node.cjs");

let win, carton, clip;
const env = (extra = {}) => ({ ...process.env, HOME: path.join(TMP, "home"), USERPROFILE: path.join(TMP, "home"), ...extra });
const cb = (cli, root, args, extra) => {
  const r = spawnSync(process.execPath, [path.join(cli, "cardboard.mjs"), "--root", root, "--json", ...args], { env: env(extra), encoding: "utf8", timeout: 120_000 });
  return { code: r.status, out: r.stdout + r.stderr };
};
// Ids, times and the library's path differ between two runs; nothing else may.
const norm = (s) => s
  .replace(/[\\/]lib-[a-z0-9-]+/g, "/LIB")
  .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, "UUID")
  .replace(/\b1[78]\d{11}\b/g, "REV")
  .replace(/\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d+Z/g, "TIME");

// One fixed session: create, import a clip, two applies (the second from the printed file, with its header), history,
// undo, verify. Returns every step's output.
const session = (cli, root, extra) => {
  fs.rmSync(root, { recursive: true, force: true });
  fs.mkdirSync(root, { recursive: true });
  const steps = [];
  const run = (...a) => steps.push(cb(cli, root, a, extra));
  run("project", "create", "Demo");
  run("media", "add", "Demo", clip);
  const edit1 = path.join(root, "..", path.basename(root) + "-edit1.tsx");
  fs.writeFileSync(edit1, 'export default (\n  <timeline aspect="16:9">\n    <track name="V1">\n      <clip src="clip.mp4" start={0} end={2} />\n    </track>\n    <track name="Titles">\n      <text start={0.5} end={2.5} fontSize={120} textContent="Hello" />\n    </track>\n  </timeline>\n);\n');
  run("source", "apply", "Demo", edit1);
  const tsx = path.join(root, "Demo.cardboard", "timeline.tsx"), edit2 = edit1.replace("edit1", "edit2");
  fs.writeFileSync(edit2, fs.readFileSync(tsx, "utf8").replace("fontSize={120}", "fontSize={140}"));
  run("source", "apply", "Demo", edit2);
  run("history", "Demo");
  run("undo", "Demo");
  run("verify", "Demo");
  return steps;
};
const files = (root) => Object.fromEntries(["project.json", "timeline.tsx", "AGENTS.md", "timeline.d.ts"].map((f) => [f, norm(fs.readFileSync(path.join(root, "Demo.cardboard", f), "utf8"))]));
const zipNames = (file) => {
  // A .cbproj is a stored zip: read the central directory's names.
  const b = fs.readFileSync(file), names = [];
  for (let i = b.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06])), o = b.readUInt32LE(i + 16), n = b.readUInt16LE(i + 10); n-- > 0;) {
    const len = b.readUInt16LE(o + 28), extra = b.readUInt16LE(o + 30), comment = b.readUInt16LE(o + 32);
    names.push(b.toString("utf8", o + 46, o + 46 + len));
    o += 46 + len + extra + comment;
  }
  return names.sort();
};
const fakeLog = (name) => {
  const file = path.join(TMP, name + ".log");
  fs.rmSync(file, { force: true });
  return { file, read: () => (fs.existsSync(file) ? fs.readFileSync(file, "utf8").trim().split("\n").map((l) => JSON.parse(l)) : []) };
};
const withFake = (log) => ({ CARDBOARD_CARTON: "1", CARTON_DIR: path.dirname(FAKE), FAKE_CARTON_LOG: log.file });

test.before(() => {
  if (skip) return;
  fs.mkdirSync(path.join(TMP, "home"), { recursive: true });
  win = stage(PRISTINE, path.join(TMP, "win"));
  carton = stage(PRISTINE, path.join(TMP, "carton"), { carton: true });
  // The fake is loaded as carton-node.cjs from CARTON_DIR.
  fs.copyFileSync(FAKE, path.join(path.dirname(FAKE), "carton-node.cjs"));
  clip = path.join(TMP, "clip.mp4");
  if (!fs.existsSync(clip)) execFileSync(process.env.CARDBOARD_FFMPEG ?? "ffmpeg", ["-loglevel", "error", "-f", "lavfi", "-i", "testsrc=size=320x180:rate=30", "-f", "lavfi", "-i", "sine=frequency=440", "-t", "3", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", clip]);
});
test.after(() => fs.rmSync(path.join(path.dirname(FAKE), "carton-node.cjs"), { force: true }));

test("Carton off: cb's output and files are the Windows build's", { skip }, () => {
  const a = session(win.cli, path.join(TMP, "lib-win")), b = session(carton.cli, path.join(TMP, "lib-off"), { CARDBOARD_CARTON: "0" });
  assert.deepEqual(a.map((s) => s.code), [0, 0, 0, 0, 0, 0, 0]);
  assert.deepEqual(b.map((s) => [s.code, norm(s.out)]), a.map((s) => [s.code, norm(s.out)]));
  assert.deepEqual(files(path.join(TMP, "lib-off")), files(path.join(TMP, "lib-win")));
});

test(".cbproj leaves out .carton/ and .scratch/views/, on or off", { skip }, () => {
  for (const [name, extra] of [["off", { CARDBOARD_CARTON: "0" }], ["on", withFake(fakeLog("cbproj"))]]) {
    const root = path.join(TMP, "lib-cbproj-" + name);
    session(carton.cli, root, extra);
    const b = path.join(root, "Demo.cardboard");
    for (const f of [".carton/carton.db", ".scratch/views/agent-x.tsx", ".scratch/keep.tsx"]) fs.mkdirSync(path.dirname(path.join(b, f)), { recursive: true }), fs.writeFileSync(path.join(b, f), "x");
    const out = path.join(TMP, name + ".cbproj");
    fs.rmSync(out, { force: true });
    assert.equal(cb(carton.cli, root, ["project", "save-as", "Demo", out], extra).code, 0);
    const names = zipNames(out);
    assert.ok(names.includes(".scratch/keep.tsx") && names.includes("project.json"), names.join(" "));
    assert.ok(!names.some((n) => n.startsWith(".carton/") || n.startsWith(".scratch/views/")), names.join(" "));
  }
});

test("Carton on: every cb hook reaches the facade", { skip }, () => {
  const log = fakeLog("cli"), root = path.join(TMP, "lib-on"), extra = withFake(log);
  const steps = session(carton.cli, root, extra);
  assert.deepEqual(steps.map((s) => s.code), [0, 0, 0, 0, 0, 0, 0]);
  const commits = log.read().filter((l) => l.what === "commit");
  // media add, apply, apply, undo: one change per mutation, each with the document it was applied to as its base.
  assert.equal(commits.length, 4);
  for (const c of commits) assert.ok(c.baseRev < c.docRev && c.actor === "cli" && c.bundle === "Demo.cardboard", JSON.stringify(c));
  // The second apply's file was printed at the first apply's version; the undo restores that version.
  assert.deepEqual(commits[2].meta, { source: "timeline", rev: commits[1].docRev, ownedFields: ["tracks", "timelineItems", "aspectRatio"] });
  assert.equal(commits[3].meta.source, "undo");
  assert.ok(log.read().filter((l) => l.what === "merge3").length === 2, "merge3 in place of rn for both applies");
  assert.ok(log.read().some((l) => l.what === "install" && l.file.endsWith("project.json")), "displace-then-install");
  // The Carton commands get the project as Cardboard resolves it, and head goes back into project.json after them.
  assert.deepEqual(JSON.parse(cb(carton.cli, root, ["carton-probe", "Demo"], extra).out), { probed: JSON.parse(fs.readFileSync(path.join(root, "Demo.cardboard", "project.json"), "utf8")).project.id });
  assert.deepEqual(log.read().filter((l) => l.what === "open" || l.what === "headProject").map((l) => [l.what, l.bundle]), [["open", "Demo.cardboard"], ["headProject", "Demo.cardboard"]]);
  // Off, undo --turn says it needs Carton rather than undoing something else.
  const off = cb(carton.cli, root, ["undo", "Demo", "--turn", "t-42"], { CARDBOARD_CARTON: "0" });
  assert.notEqual(off.code, 0);
  assert.match(off.out, /needs Carton/);
});

test("the library worker: Windows build, Carton off, Carton on", { skip }, () => {
  const seed = path.join(TMP, "lib-seed");
  session(win.cli, seed);
  const runWorker = (worker, name, extra) => {
    const root = path.join(TMP, "lib-worker-" + name);
    fs.rmSync(root, { recursive: true, force: true });
    fs.cpSync(seed, root, { recursive: true });
    const r = spawnSync(process.execPath, [path.join(__dirname, "worker-run.js"), worker, root], { env: env(extra), encoding: "utf8", timeout: 60_000 });
    assert.equal(r.status, 0, r.stderr);
    return JSON.parse(r.stdout.trim().split("\n").pop());
  };
  const expected = { guiSave: 150, watcher: ["timeline-applied"], after: 160 };
  assert.deepEqual(runWorker(win.worker, "win"), expected);
  assert.deepEqual(runWorker(carton.worker, "off", { CARDBOARD_CARTON: "0" }), expected);
  const log = fakeLog("worker");
  assert.deepEqual(runWorker(carton.worker, "on", withFake(log)), { ...expected, ping: "pong" });
  const commits = log.read().filter((l) => l.what === "commit");
  // The GUI save carries the editor's base and is the person's; the watched file is an outside agent's.
  assert.deepEqual([commits[0].actor, commits[0].meta.base], ["person", commits[0].baseRev]);
  assert.equal(commits[1].actor, "external:timeline.tsx");
  assert.equal(commits[1].meta.source, "timeline");
});

// The real facade, built from the carton workspace, on real Carton and carton.db: the cb commands end to end.
const WORKSPACE = path.join(__dirname, "..", "..", "..", "carton");
const noBuild = skip || (!fs.existsSync(path.join(WORKSPACE, "node_modules", "esbuild")) && "run `npm ci` in carton/ to build the facade");
test("Carton on, for real: history with authors, credits, cuts, fold, undo --turn, no lost update", { skip: noBuild }, async () => {
  const out = path.join(TMP, "bundle");
  fs.rmSync(out, { recursive: true, force: true });
  await require("../build.js").build(out, carton.assets);
  for (const f of ["carton-node.cjs", "engine-thread-main.js", "helper-main.js", "factory.js", "fmsv.cjs", "package.json"]) assert.ok(fs.existsSync(path.join(out, "carton", f)), f);
  assert.ok(fs.existsSync(path.join(carton.assets, "carton-ui.js")));
  const real = (actor) => ({ CARDBOARD_CARTON: "1", CARTON_DIR: path.join(out, "carton"), CARDBOARD_ACTOR: actor ?? "" });
  const root = path.join(TMP, "lib-real"), b = path.join(root, "Demo.cardboard");
  fs.rmSync(root, { recursive: true, force: true });
  const run = (actor, ...a) => { const r = cb(carton.cli, root, a, real(actor)); assert.equal(r.code, 0, a.join(" ") + "\n" + r.out); return r.out; };
  const json = (actor, ...a) => JSON.parse(run(actor, ...a).replace(/^\[carton\][^\n]*\n/gm, ""));
  run(null, "project", "create", "Demo");
  run(null, "media", "add", "Demo", clip);
  const edit = path.join(TMP, "real-edit.tsx");
  fs.writeFileSync(edit, 'export default (\n  <timeline aspect="16:9">\n    <track name="V1">\n      <clip src="clip.mp4" start={0} end={2} />\n    </track>\n    <track name="Titles">\n      <text name="Hello" start={0.5} end={2.5} fontSize={120} textContent="Hello" />\n    </track>\n  </timeline>\n);\n');
  assert.equal(json("director/chat1/turn1", "source", "apply", "Demo", edit).carton.status, "confirmed");
  fs.writeFileSync(edit, fs.readFileSync(path.join(b, "timeline.tsx"), "utf8").replace("fontSize={120}", "fontSize={140}"));
  json("director/chat1/turn2/sub-Explore-a1", "source", "apply", "Demo", edit);
  assert.ok(fs.existsSync(path.join(b, ".carton", "carton.db")));
  const textId = () => JSON.parse(fs.readFileSync(path.join(b, "project.json"), "utf8")).project.timelineItems.find((i) => i.type === "text");
  // A Director turn that ended takes a short name from its prompt, as History shows the chat's checkpoints.
  const named = spawnSync(process.execPath, ["-e", `
    const { cardboard14 } = require(${JSON.stringify(path.join(out, "carton", "carton-node.cjs"))});
    const w = cardboard14.worker({ library: { projects: { bundlePathFor: () => ${JSON.stringify(b)} } }, emit() {} });
    w.nameTurn({ projectId: "p", chat: "chat1", turn: "turn1", prompt: "Make the intro tighter. Then add a lower third." }).then((r) => console.log(JSON.stringify(r)));
  `], { env: env(), encoding: "utf8", timeout: 60_000 });
  assert.equal(JSON.parse(named.stdout.trim().split("\n").pop()).status, "named", named.stderr);
  assert.equal(json(null, "history", "Demo").versions.find((v) => v.by?.id === "director/chat1/turn1")?.name, "Make the intro tighter");
  // The live-sync half's seam: an extension's services join the worker's namespace beside Carton's own (never replacing
  // one), it gets each project's open Carton and hears of every Carton opened, and one that throws is left out.
  const ext = spawnSync(process.execPath, ["-e", `
    const path = require("path");
    const { cardboard14, extend } = require(${JSON.stringify(path.join(out, "carton", "carton-node.cjs"))});
    const heard = [];
    let api;
    extend({ worker: (a) => ({ hello: async () => ((await a.carton("p"))?.carton ? "open" : "none"), ping: async () => "replaced", "bad-name": async () => 1 }) });
    extend({ worker: (a) => { api = a; a.onOpen((b) => heard.push("live:" + path.basename(b))); return {}; } });
    extend({ worker: () => { throw new Error("broken"); } });
    const w = cardboard14.worker({ library: { projects: { bundlePathFor: () => ${JSON.stringify(b)} } }, emit() {} });
    (async () => {
      const r = { hello: await w.hello(), ping: await w.ping(), bad: "bad-name" in w };
      await new Promise((r) => setTimeout(r, 50));
      api.onOpen((b) => heard.push("late:" + path.basename(b)));
      await new Promise((r) => setTimeout(r, 50));
      console.log(JSON.stringify({ ...r, heard }));
    })().catch((e) => { console.error(e); process.exit(1); });
  `], { env: env(), encoding: "utf8", timeout: 60_000 });
  assert.deepEqual(JSON.parse(ext.stdout.trim().split("\n").pop()), { hello: "open", ping: "pong", bad: false, heard: ["live:Demo.cardboard", "late:Demo.cardboard"] }, ext.stderr);
  assert.match(ext.stderr, /an extension failed to start: broken/);
  // Every helper Carton starts for a project (a lease holder, for a shared cut) opens carton.db with the worker's own
  // adapter and schema: openLocal hands it this bundle's helper-main.js and factory.js; that factory opens the worker's
  // carton.db to the same schema and head; the real helper opens it and exits clean; and from the library worker (an
  // Electron utility process, where the binary is the app's) its spawn runs the binary as Node.
  const helper = spawnSync(process.execPath, ["-e", `
    const fs = require("fs"), path = require("path"), crypto = require("crypto"), cp = require("child_process"), url = require("url");
    const dir = ${JSON.stringify(path.join(out, "carton"))}, bundle = ${JSON.stringify(b)};
    const { internals: I } = require(path.join(dir, "carton-node.cjs"));
    const canon = (v) => JSON.stringify(v, (_k, x) => (x && typeof x === "object" && !Array.isArray(x) ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => (a < b ? -1 : 1))) : x));
    const sha = (t) => crypto.createHash("sha256").update(t).digest("hex");
    (async () => {
      const r = {}, w = await I.local(bundle);
      r.paths = [path.relative(dir, I.helper.entry), path.relative(dir, I.helper.factory)];
      const { createHolderEngine } = await import(url.pathToFileURL(I.helper.factory).href);
      const h = await createHolderEngine({ dbPath: w.dbPath, config: { projectDir: bundle } });
      const head = await h.engine.carton.head();
      r.same = { schema: sha(canon(h.engine.carton.schema)) === w.schema, ref: canon(head.ref) === w.ref, doc: sha(canon(head.doc)) === w.doc };
      await h.close();
      await h.store.close();
      // The real helper, as spawnHelper starts it (here not detached, with a short idle time).
      const run = cp.spawnSync(process.execPath, [I.helper.entry, "--db", w.dbPath, "--seen", "-", "--factory", I.helper.factory, "--config", JSON.stringify({ projectDir: bundle }), "--idle-ms", "300"], { timeout: 30000 });
      const log = (() => { try { return fs.readFileSync(path.join(path.dirname(w.dbPath), "helper.log"), "utf8"); } catch { return ""; } })();
      const mine = log.split("\\n").filter(Boolean).map((l) => JSON.parse(l)).filter((e) => e.pid === run.pid);
      r.helper = { status: run.status, errors: mine.filter((e) => e.type === "error").map((e) => String(e.error).split("\\n")[0]), lease: mine.some((e) => e.type === "lease") };
      // In the worker: the app's binary, without ELECTRON_RUN_AS_NODE.
      const real = cp.spawn;
      let seen = null;
      process.versions.electron = "39.0.0";
      delete process.env.ELECTRON_RUN_AS_NODE;
      cp.spawn = (cmd, args, o) => ((seen = { cmd, args, env: o.env }), { unref() {}, pid: 0 });
      I.helper.spawn({ dbPath: w.dbPath, factory: I.helper.factory });
      cp.spawn = real;
      r.worker = { asNode: seen?.env?.ELECTRON_RUN_AS_NODE === "1", entry: seen?.args?.[0] === I.helper.entry, factory: seen?.args?.[seen.args.indexOf("--factory") + 1] === I.helper.factory };
      console.log(JSON.stringify(r));
      process.exit(0);
    })().catch((e) => { console.error(e); process.exit(1); });
  `], { env: env(), encoding: "utf8", timeout: 120_000 });
  assert.deepEqual(JSON.parse(helper.stdout.trim().split("\n").pop() || "{}"), {
    paths: ["helper-main.js", "factory.js"],
    same: { schema: true, ref: true, doc: true },
    helper: { status: 0, errors: [], lease: true },
    worker: { asNode: true, entry: true, factory: true },
  }, helper.stderr);
  // History: every version, with who made it down to the subagent.
  const by = json(null, "history", "Demo").versions.map((v) => v.by?.id ?? null);
  assert.deepEqual(by.slice(0, 2), ["director/chat1/turn2/sub-Explore-a1", "director/chat1/turn1"]);
  assert.equal(json(null, "credits", "Demo", textId().id).by.id, "director/chat1/turn2/sub-Explore-a1");
  // A cut: project.json follows the switch, the cut's edit stays on it, and folds back in.
  run(null, "cut", "new", "Demo", "30s cut");
  run(null, "cut", "switch", "Demo", "30s cut");
  fs.writeFileSync(edit, fs.readFileSync(path.join(b, "timeline.tsx"), "utf8").replace("fontSize={140}", "fontSize={90}"));
  json("codex/c7", "source", "apply", "Demo", edit);
  assert.equal(textId().fontSize, 90);
  run(null, "cut", "switch", "Demo", "Main cut");
  assert.equal(textId().fontSize, 140);
  run(null, "fold", "Demo", "30s cut");
  assert.equal(textId().fontSize, 90);
  // Undoing turn2 after the fold changed the same size again: a card, nothing lost.
  // (cb says so with exit code 1: a card is waiting.)
  const u = cb(carton.cli, root, ["undo", "Demo", "--turn", "turn2"], real("director/chat1/turn3"));
  assert.equal(JSON.parse(u.out.replace(/^\[carton\][^\n]*\n/gm, "")).status, "conflicts", u.out);
  assert.equal(textId().fontSize, 90);
  // An agent's timeline.tsx save that nothing applied yet (the app isn't running) is moved aside by the next cb
  // write's regeneration of the file, then applied as the agent's (1.4.0 overwrote it).
  fs.writeFileSync(path.join(b, "timeline.tsx"), fs.readFileSync(path.join(b, "timeline.tsx"), "utf8").replace(/fontSize=\{\d+\}/, "fontSize={77}"));
  run(null, "project", "rename", "Demo", "Demo cut");
  assert.equal(textId().fontSize, 77);
  // Nothing foreign is left aside: anything still in .carton/displaced is a state Carton wrote, waiting out its hold.
  const seen = new Set(Object.values(JSON.parse(fs.readFileSync(path.join(b, ".carton", "seen.json"), "utf8"))).flat());
  const dir = path.join(b, ".carton", "displaced");
  for (const n of fs.existsSync(dir) ? fs.readdirSync(dir) : []) assert.ok(seen.has(require("crypto").createHash("sha256").update(fs.readFileSync(path.join(dir, n))).digest("hex")), "foreign file left: " + n);
  // cb undo <rev> with a 1.4.0 rev (as cb history printed before Carton, or a timeline header) reaches that version.
  const header = Number(/cardboard:rev (\d+)/.exec(fs.readFileSync(path.join(b, "timeline.tsx"), "utf8"))[1]);
  assert.ok(header > 1e12);
  const undoRev = cb(carton.cli, root, ["undo", "Demo cut", String(header)], real());
  assert.equal(undoRev.code, 0, undoRev.out);
  // A GUI save through the real worker: the editor's lossy serializer dropped the clip's autoReframe and rounded its
  // times, but only the person's edit lands; Carton off (1.4.0) loses autoReframe (B10).
  const gui = (name, extra) => {
    const r2 = path.join(TMP, "lib-real-gui-" + name);
    fs.rmSync(r2, { recursive: true, force: true });
    fs.cpSync(root, r2, { recursive: true });
    fs.rmSync(path.join(r2, "Demo.cardboard", ".carton"), { recursive: true, force: true });
    const g = spawnSync(process.execPath, [path.join(__dirname, "worker-run.js"), carton.worker, r2], { env: env({ LOSSY: "1", ...extra }), encoding: "utf8", timeout: 120_000 });
    assert.equal(g.status, 0, g.stderr);
    return JSON.parse(g.stdout.trim().split("\n").pop());
  };
  const on = gui("on", { ...real(), STALE: "1", UNDO: "1", PANEL: "1" }), off = gui("off", { CARDBOARD_CARTON: "0" });
  // The History panel shows the GUI save's card at once, and again when opened later.
  assert.ok(on.panel.live > 0 && on.panel.reopened > 0, JSON.stringify(on.panel));
  // Core's card has head as ours (160) and the person's edit as theirs (170); the panel shows the person's as mine.
  assert.deepEqual(on.sides, { mine: "170", theirs: "160" }, JSON.stringify(on));
  // Two kept cards for one field, both shown: resolving the first removes only it, and the other (180) stays shown.
  assert.equal(on.keptBefore, 2);
  assert.deepEqual(on.keptAfter, [180], JSON.stringify(on));
  assert.deepEqual(on.shownNext, ["180"], JSON.stringify(on));
  // A second panel resolving the card already resolved leaves the next one kept; an agent's card stays the agent's.
  assert.deepEqual(on.keptAfterOther, [180, 175], JSON.stringify(on));
  assert.deepEqual([on.legacyShown, on.legacyGone], [true, true], JSON.stringify(on));
  assert.deepEqual([on.agentCards > 0, on.panelHasAgent], [true, false], JSON.stringify(on));
  assert.equal(on.guiSave, 150);
  // A stale GUI save's clash keeps head (160) and a card for the person; ⌘Z then reaches project.json and the pages.
  assert.deepEqual([on.stale, on.cards > 0], [160, true], JSON.stringify(on));
  assert.deepEqual([on.undo, on.undone !== 150, on.announced], ["confirmed", true, true], JSON.stringify(on));
  assert.equal(on.video.autoReframe, true, JSON.stringify(on.video));
  assert.equal(off.video.autoReframe, undefined);
  // The install lock and the sweep, through the facade's internals.
  const locks = spawnSync(process.execPath, ["-e", `
    const fs = require("fs"), path = require("path");
    const { internals: I } = require(${JSON.stringify(path.join(out, "carton", "carton-node.cjs"))});
    const bundle = ${JSON.stringify(b)}, dir = path.join(bundle, ".carton", "install.lock"), out = {};
    (async () => {
      // A lock left by a process that is gone, silent for over 10 s: taken over.
      fs.mkdirSync(dir); fs.writeFileSync(path.join(dir, "owner"), JSON.stringify({ pid: 2 ** 22 + 7, me: "dead" }));
      const old = new Date(Date.now() - 20_000); fs.utimesSync(path.join(dir, "owner"), old, old);
      out.dead = await I.withInstallLock(bundle, async (mine) => mine());
      // A live holder (this process), even one silent for 20 s: waited for, never taken over.
      fs.mkdirSync(dir); fs.writeFileSync(path.join(dir, "owner"), JSON.stringify({ pid: process.pid, me: "live" }));
      fs.utimesSync(path.join(dir, "owner"), old, old);
      const t0 = Date.now();
      setTimeout(() => fs.rmSync(dir, { recursive: true, force: true }), 400);
      await I.withInstallLock(bundle, async () => {});
      out.waited = Date.now() - t0 >= 380;
      // A running pid silent for over a minute (Windows reuses pids): taken over.
      fs.mkdirSync(dir); fs.writeFileSync(path.join(dir, "owner"), JSON.stringify({ pid: process.pid, me: "reused" }));
      const older = new Date(Date.now() - 70_000); fs.utimesSync(path.join(dir, "owner"), older, older);
      const t1 = Date.now();
      out.reused = await I.withInstallLock(bundle, async (mine) => mine()) && Date.now() - t1 < 5000;
      // A file displaced a moment ago is not swept, even if Carton wrote it and its own mtime is old.
      const d = path.join(bundle, ".carton", "displaced"); fs.mkdirSync(d, { recursive: true });
      const f = path.join(d, "fresh-0"); fs.writeFileSync(f, "x"); fs.utimesSync(f, old, old);
      const j = I.readJournal(bundle); j["fresh-0"] = { at: Date.now(), stamp: "?" };
      await I.sweep(path.join(bundle, "project.json"), { mine: new Set() }, j);
      out.fresh = fs.existsSync(f);
      fs.rmSync(f);
      // An install of a state that is no longer head is skipped, and says so.
      const tmp = path.join(bundle, ".stale.tmp");
      fs.writeFileSync(tmp, JSON.stringify({ project: { stateUpdatedAt: 1700000000123 } }));
      await I.setRevFor(bundle, 1700000000123, { branchId: (await I.refOfRev(bundle, JSON.parse(fs.readFileSync(path.join(bundle, "project.json"), "utf8")).project.stateUpdatedAt)).branchId, seq: 0 });
      out.skipped = (await I.install(tmp, path.join(bundle, "project.json"))) === false && !fs.existsSync(tmp);
      // Taken over in the middle of an install (stalled for a minute): the successor's newer file goes back.
      const pj = path.join(bundle, "project.json"), cur = JSON.parse(fs.readFileSync(pj, "utf8"));
      const head = await I.refOfRev(bundle, cur.project.stateUpdatedAt);
      const oursRev = 1700000000201, theirsRev = 1700000000202;
      await I.setRevFor(bundle, oursRev, head);
      await I.setRevFor(bundle, theirsRev, { branchId: head.branchId, seq: head.seq + 1 });
      const ours = path.join(bundle, ".ours.tmp");
      fs.writeFileSync(ours, JSON.stringify({ ...cur, project: { ...cur.project, stateUpdatedAt: oursRev } }));
      // The successor installs (B) and frees the lock a moment later; with a third writer (C, newer still), C
      // installs before that. B goes back only if it is still the newest on disk.
      // "third": a third writer installs before the lock is freed. "slow": the successor's file is Carton's (in
      // seen.json) and the lock stays taken past the review. "external": someone else saves just before it is freed.
      const theirs = JSON.stringify({ ...cur, project: { ...cur.project, stateUpdatedAt: theirsRev } });
      const takeover = async (mode) => {
        let fired = false;
        fs.writeFileSync(ours, JSON.stringify({ ...cur, project: { ...cur.project, stateUpdatedAt: oursRev } }));
        if (mode === "slow") await I.markSeen(pj, I.sha(Buffer.from(theirs)));
        I.testHooks.between = () => {
          if (fired) return;
          fired = true;
          I.testHooks.between = null;
          fs.writeFileSync(path.join(dir, "owner"), JSON.stringify({ pid: process.pid, me: "successor" }));
          fs.writeFileSync(pj, theirs);
          setTimeout(() => {
            if (mode === "third") fs.rmSync(pj, { force: true }), fs.writeFileSync(pj, JSON.stringify({ ...cur, project: { ...cur.project, stateUpdatedAt: thirdRev } }));
            if (mode === "external") fs.rmSync(pj, { force: true }), fs.writeFileSync(pj, JSON.stringify({ ...cur, project: { ...cur.project, name: "Saved elsewhere", stateUpdatedAt: 1700000000250 } }));
            fs.rmSync(dir, { recursive: true, force: true });
          }, mode === "slow" ? 900 : 200);
        };
        const res = await I.install(ours, pj);
        return [res, JSON.parse(fs.readFileSync(pj, "utf8")).project.stateUpdatedAt];
      };
      const thirdRev = 1700000000203;
      await I.setRevFor(bundle, thirdRev, { branchId: head.branchId, seq: head.seq + 2 });
      const [r1, on1] = await takeover(), [r2, on2] = await takeover("third");
      out.putBack = r1 === false && on1 === theirsRev && r2 === false && on2 === thirdRev;
      // The file to put back survives a review that runs while the successor still holds the lock.
      const [r3, on3] = await takeover("slow");
      // A save made while the put-back waited is moved aside by it, then imported, not deleted as Carton's.
      const [r4, on4] = await takeover("external");
      let imported = false;
      for (let i = 0; i < 60 && !imported; i++) await new Promise((r) => setTimeout(r, 50)), (imported = (await I.headProject(bundle))?.name === "Saved elsewhere");
      out.putBackLater = { slow: r3 === false && on3 === theirsRev, external: r4 === false && on4 === theirsRev, imported };
      fs.rmSync(dir, { recursive: true, force: true });
      // A rename of seen.json or displaced.json that fails (a file kept busy past the retry budget on Windows; here a
      // folder in its place) fails the install: every busy-file call is awaited, so none fails unnoticed.
      // Kept cards are told apart as the panel tells them apart: a missing value isn't null; key order doesn't count.
      out.cardsApart = !I.sameCard({ path: "a", ours: undefined, theirs: 1 }, { path: "a", ours: null, theirs: 1 }) && I.sameCard({ path: "a", ours: { x: 1, y: 2 }, theirs: 1 }, { path: "a", ours: { y: 2, x: 1 }, theirs: 1 });
      out.surfaced = {};
      for (const [k, name] of ["seen.json", "displaced.json"].entries()) {
        const at = path.join(bundle, ".carton", name), saved = fs.existsSync(at) ? fs.readFileSync(at) : null;
        fs.rmSync(at, { force: true });
        fs.mkdirSync(at);
        const t = path.join(bundle, ".fail.tmp");
        fs.writeFileSync(t, JSON.stringify({ ...cur, project: { ...cur.project, stateUpdatedAt: 1700000000300 + k } }));
        out.surfaced[name] = await I.install(t, pj).then(() => "resolved", (e) => (e?.code ? "rejected" : "rejected: " + e));
        fs.rmSync(at, { recursive: true, force: true });
        if (saved) fs.writeFileSync(at, saved);
        fs.rmSync(t, { force: true });
      }
      fs.writeFileSync(pj, JSON.stringify(cur));
      console.log(JSON.stringify(out));
    })().catch((e) => { console.error(e); process.exit(1); });
  `], { env: env(), encoding: "utf8", timeout: 60_000 });
  assert.deepEqual(JSON.parse(locks.stdout.trim().split("\n").pop()), { dead: true, waited: true, reused: true, fresh: true, skipped: true, putBack: true, putBackLater: { slow: true, external: true, imported: true }, cardsApart: true, surfaced: { "seen.json": "rejected", "displaced.json": "rejected" } }, locks.stderr);
  // Four agents at once on different titles: none loses its last edit (B1).
  const wroot = path.join(TMP, "lib-real-writers");
  fs.rmSync(wroot, { recursive: true, force: true });
  const w = (...a) => spawnSync(process.execPath, [path.join(__dirname, "..", "writers.js"), ...a], { env: env(real()), encoding: "utf8", timeout: 300_000 });
  assert.equal(w("setup", path.join(carton.cli, "cardboard.mjs"), wroot).status, 0);
  const r = w("run", path.join(carton.cli, "cardboard.mjs"), wroot, "--writers", "4", "--rate", "2", "--seconds", "15");
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /no lost updates/);
});
