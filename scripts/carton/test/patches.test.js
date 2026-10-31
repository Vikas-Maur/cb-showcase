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
  // cb history gets WHO and CUT; cb undo --turn and the Carton commands go to Carton.
  const hist = cb(carton.cli, root, ["history", "Demo"], extra);
  assert.match(spawnSync(process.execPath, [path.join(carton.cli, "cardboard.mjs"), "--root", root, "history", "Demo"], { env: env(extra), encoding: "utf8" }).stdout, /WHO\s+CUT/);
  assert.equal(hist.code, 0);
  const undo = cb(carton.cli, root, ["undo", "Demo", "--turn", "t-42"], { ...extra, CARDBOARD_ACTOR: "director/chat1/t-42" });
  assert.equal(JSON.parse(undo.out).status, "confirmed");
  assert.deepEqual(log.read().filter((l) => l.what === "undoTurn").map((l) => [l.turn, l.actor]), [["t-42", "director/chat1/t-42"]]);
  assert.equal(cb(carton.cli, root, ["branch", "Demo", "new", "30s cut"], extra).code, 0);
  assert.deepEqual(log.read().filter((l) => l.what === "run").map((l) => [l.argv, l.bundle]), [[["cut", "new", "30s cut"], "Demo.cardboard"]]);
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
