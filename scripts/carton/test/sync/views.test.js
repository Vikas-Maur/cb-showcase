// Which files in a bundle's .scratch/views/ are Carton's (H11; the store bridge's cartonView and skipInArchive): the
// view files Carton writes there, a print and its status sidecar, made here by Carton's own materializer
// (carton/packages/cardboard). Only those leave a .cbproj on Save As and a staged bundle on Open Project, with Carton
// on or off. A person's or an agent's own files there (stock Cardboard tells agents to keep their working files in
// .scratch/) are not Carton's: Save As carries them and Open Project keeps them, as Cardboard 1.4.0 does. The patched
// Save As and Open Project themselves: ../patches.test.js and cbproj.test.js.
//   node --test scripts/carton/test/sync/views.test.js
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs"), os = require("os"), path = require("path");
const S = require("./support.js");
// An ES module by path (on Windows an absolute path must be a file:// URL for import())
const load = (file) => import(require("url").pathToFileURL(file).href);

const CARDBOARD = path.join(__dirname, "..", "..", "..", "..", "carton", "packages", "cardboard");
const skip = !fs.existsSync(path.join(CARDBOARD, "..", "..", "node_modules", "@carton", "core")) && "run `npm ci` in carton/ for Carton's materializer";
const ROOT = path.join(process.env.CARTON_TEST_DIR ?? path.join(os.homedir(), "gfv-scratch", "carton", "windows-sync"), "views-" + process.pid);
test.after(() => fs.rmSync(ROOT, { recursive: true, force: true }));

// The store bridge as both copies of Cardboard run it, with Carton on and off.
const bridge = (on) => {
  const saved = process.env.CARDBOARD_CARTON;
  process.env.CARDBOARD_CARTON = on ? "1" : "";
  try { return new Function("require", require("../../store-bridge.js")({ dir: '"unused"', slice: "((d) => d)", who: "cli" }) + "return __carton;")(require); }
  finally { if (saved === undefined) delete process.env.CARDBOARD_CARTON; else process.env.CARDBOARD_CARTON = saved; }
};

/** A bundle in which Carton's materializer printed an agent's view and applied a save of it (so it wrote its status). */
async function printed() {
  const { Materializer, PROJECT_FILE, viewPath, statusPath } = await load(path.join(CARDBOARD, "src", "node", "materializer.ts"));
  const { jsonTimelineCodec } = await load(path.join(CARDBOARD, "src", "codec.ts"));
  const { findRev } = await load(path.join(CARDBOARD, "src", "header.ts"));
  const { FakeClock, FakeEngine, plainHost } = await load(path.join(CARDBOARD, "test", "helpers", "fake-engine.ts"));
  fs.mkdirSync(ROOT, { recursive: true });
  const bundle = fs.mkdtempSync(path.join(ROOT, "b-"));
  const items = [{ id: "a", trackId: "V1", type: "video", name: "a", startTime: 0, endTime: 5, trimStart: 0, trimEnd: 5 }];
  fs.writeFileSync(path.join(bundle, PROJECT_FILE), JSON.stringify({ format: "cardboard-project", version: 1, project: { id: "p1", name: "Demo", stateUpdatedAt: 1, timelineItems: items }, media: [] }));
  const engine = new FakeEngine({ name: "Demo", timelineItems: items }), clock = new FakeClock();
  const mz = new Materializer({ bundle, engine, host: plainHost, codec: jsonTimelineCodec, clock });
  try {
    await engine.putMeta(["file", PROJECT_FILE, "pin"], (await engine.pin({ owner: "project-file", ttlMs: 1 })).ref);
    await mz.adoptCurrentFiles();
    await mz.start();
    const { path: rel } = await mz.printView("director_c_t1", { kind: "agent", id: "director/c/t1", turn: "t1" }, { hooked: true });
    const view = path.join(bundle, ...rel.split("/"));
    const text = fs.readFileSync(view, "utf8"), f = findRev(text);
    const doc = JSON.parse(text.slice(f.end));
    doc.timelineItems[0].name = "edited";
    fs.writeFileSync(view + ".tmp", "// edited\n" + f.line + "\n" + JSON.stringify(doc) + "\n");
    fs.renameSync(view + ".tmp", view);
    mz.onFsEvent(rel);
    await clock.advance(2, () => mz.idle());
    const status = path.join(bundle, ...statusPath("director_c_t1").split("/"));
    assert.equal(JSON.parse(fs.readFileSync(status, "utf8")).status, "confirmed", "the save was applied");
    assert.equal(rel, viewPath("director_c_t1"));
    return { bundle, views: path.dirname(view), view, status };
  } finally {
    await mz.close();
  }
}

test("Carton's own view files are told by name and content, with Carton on or off", { skip }, async () => {
  const p = await printed();
  assert.deepEqual(fs.readdirSync(p.views).sort(), ["director_c_t1.status", "director_c_t1.tsx"]);
  for (const on of [false, true]) {
    const c = bridge(on);
    assert.equal(c.on, on);
    assert.equal(c.cartonView(p.view), true, "the print");
    assert.equal(c.cartonView(p.status), true, "its status sidecar");
    // The walk: .scratch/views/ is gone into, and only Carton's files in it are left out; .carton/ at the top is.
    assert.equal(c.skipInArchive(".scratch", "views", path.join(p.bundle, ".scratch")), false);
    assert.equal(c.skipInArchive(".scratch/views", "director_c_t1.tsx", p.views), true);
    assert.equal(c.skipInArchive(".scratch/views", "director_c_t1.status", p.views), true);
    assert.equal(c.skipInArchive("", ".carton", p.bundle), true);
  }
});

test("anything else in .scratch/views/ is a person's or an agent's own, and stays, with Carton on or off", { skip }, async () => {
  const p = await printed();
  const view = fs.readFileSync(p.view, "utf8"), status = JSON.parse(fs.readFileSync(p.status, "utf8"));
  const own = {
    "notes.md": "my notes\n",
    // Cardboard 1.4.0's own print (`cb source print > .scratch/views/mine.tsx`): its rev is a bare number
    "mine.tsx": "// Cardboard timeline\n// cardboard:rev 1730000000000\nexport default (<timeline />);\n",
    "draft.tsx": "export default (<timeline />);\n",
    "plan.status": JSON.stringify({ status: "done", next: "trim the intro" }),
    "more.status": JSON.stringify({ ...status, mine: true }),
    "broken.status": "{ not json",
    "carton.txt": view, // Carton's header, but not a view's name
  };
  for (const [n, d] of Object.entries(own)) fs.writeFileSync(path.join(p.views, n), d);
  fs.mkdirSync(path.join(p.views, "folder.tsx"));
  fs.mkdirSync(path.join(p.views, "sub"));
  fs.copyFileSync(p.view, path.join(p.views, "sub", "copy.tsx"));
  fs.copyFileSync(p.view, path.join(p.bundle, ".scratch", "copy.tsx"));
  fs.mkdirSync(path.join(p.bundle, ".scratch", ".carton"));
  for (const on of [false, true]) {
    const c = bridge(on);
    for (const n of [...Object.keys(own), "folder.tsx", "sub"]) {
      assert.equal(c.cartonView(path.join(p.views, n)), false, n);
      assert.equal(c.skipInArchive(".scratch/views", n, p.views), false, n);
    }
    // Carton writes its views directly in .scratch/views/: a copy anywhere else is someone's own file
    assert.equal(c.skipInArchive(".scratch/views/sub", "copy.tsx", path.join(p.views, "sub")), false);
    assert.equal(c.skipInArchive(".scratch", "copy.tsx", path.join(p.bundle, ".scratch")), false);
    assert.equal(c.skipInArchive(".scratch", ".carton", path.join(p.bundle, ".scratch")), false, "only the top-level .carton/");
    assert.equal(c.cartonView(path.join(p.views, "gone.tsx")), false, "a file that can't be read is kept");
  }
});

test("Carton's names compare as the file system does: case-insensitively on Windows and macOS", { skip: skip || (process.platform !== "win32" && process.platform !== "darwin" && "Windows and macOS only") }, async () => {
  const p = await printed(), c = bridge(false);
  assert.equal(c.skipInArchive(".Scratch/Views", "director_c_t1.tsx", p.views), true);
  assert.equal(c.skipInArchive("", ".Carton", p.bundle), true);
});

// The fixed texts the end-to-end tests plant (support.js cartonViewFiles) are what the materializer writes.
test("the end-to-end tests' Carton view files read as Carton's", { skip }, async () => {
  const p = await printed(), c = bridge(false);
  for (const [n, d] of Object.entries(S.cartonViewFiles("agent-x"))) {
    fs.writeFileSync(path.join(p.views, n), d);
    assert.equal(c.cartonView(path.join(p.views, n)), true, n);
  }
  for (const [n, d] of Object.entries(S.ownViewFiles())) {
    fs.writeFileSync(path.join(p.views, n), d);
    assert.equal(c.cartonView(path.join(p.views, n)), false, n);
  }
});

// The app's rule is a copy (the store bridge runs in Cardboard's own bundles, with Carton off too, where Carton's code
// isn't loaded): it must tell every file as cardboard-adapter's cartonViewFile does, which its .cbproj export and
// reader use.
test("the store bridge's rule is cardboard-adapter's cartonViewFile, file for file", { skip }, async () => {
  const { cartonViewFile } = await load(path.join(CARDBOARD, "src", "node", "cbproj", "walk.ts"));
  const p = await printed();
  const view = fs.readFileSync(p.view, "utf8"), status = JSON.parse(fs.readFileSync(p.status, "utf8"));
  const files = {
    ...S.cartonViewFiles("agent-x"), ...S.ownViewFiles(),
    "crlf.tsx": view.replace(/\n/g, "\r\n"),
    "Upper.TSX": view,
    "late.tsx": "// x\n".repeat(20_000) + view, // the rev line past the first 64 KiB
    "space name.tsx": view,
    "extra.status": JSON.stringify({ ...status, mine: true }),
    "error.status": JSON.stringify({ ...status, status: "error", error: "x" }),
    "nostatus.status": JSON.stringify({ ...status, status: "done" }),
    "array.status": "[]",
    "empty.tsx": "",
  };
  for (const [n, d] of Object.entries(files)) fs.writeFileSync(path.join(p.views, n), d);
  for (const n of [...Object.keys(files), path.basename(p.view), path.basename(p.status)]) {
    const want = cartonViewFile(n, fs.readFileSync(path.join(p.views, n)));
    for (const on of [false, true]) assert.equal(bridge(on).cartonView(path.join(p.views, n)), want, `${n} (Carton ${on ? "on" : "off"})`);
  }
});

// With Carton on, the rule is the facade's (cardboard-adapter's cartonViewFile): the bridge only reads the file (a
// view's first 64 KiB, a status sidecar whole) and hands it over. A stand-in facade records what it was asked.
test("with Carton on, the store bridge asks the facade's cartonViewFile", { skip }, async () => {
  const p = await printed();
  const dir = fs.mkdtempSync(path.join(ROOT, "facade-"));
  fs.writeFileSync(path.join(dir, "carton-node.cjs"), "globalThis.__asked = []; module.exports = { cardboard14: { cartonViewFile: (name, bytes) => (globalThis.__asked.push([name, bytes.length]), name.startsWith('yes')) } };");
  fs.writeFileSync(path.join(p.views, "yes.tsx"), "x".repeat(70_000));
  fs.writeFileSync(path.join(p.views, "no.status"), "{}");
  const saved = process.env.CARTON_DIR;
  process.env.CARTON_DIR = dir;
  try {
    const c = bridge(true);
    assert.equal(c.cartonView(path.join(p.views, "yes.tsx")), true);
    assert.equal(c.cartonView(path.join(p.views, "no.status")), false);
    assert.equal(c.cartonView(path.join(p.views, "notes.md")), false, "a name that is never Carton's isn't read");
    assert.equal(c.skipInArchive(".scratch/views", "yes.tsx", p.views), true);
    assert.deepEqual(globalThis.__asked, [["yes.tsx", 64 * 1024], ["no.status", 2], ["yes.tsx", 64 * 1024]]);
  } finally {
    if (saved === undefined) delete process.env.CARTON_DIR; else process.env.CARTON_DIR = saved;
  }
});
