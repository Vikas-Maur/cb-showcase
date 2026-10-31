// .cbproj collaboration, H11 "Bring in their changes" (PLAN §13): Cardboard 1.4.0's real Save As and Open Project,
// patched, in both copies (cb's and the library worker's), on library roots with their own app data that never share a
// server. Alice saves a .cbproj with history, Bob opens it (a project he doesn't have: her versions come along), adds a
// clip, edits and saves one back with history; Alice, who edited meanwhile, opens it: their changes, Bob's versions and
// his clip's file come in, hers stay, and a clash puts theirs in with hers on a conflict card `cb resolve --keep mine`
// takes back. A crafted file's `.carton/` and Carton's view files never survive Open Project (Carton on or off), and
// never go into a Save As; a person's or an agent's own files in `.scratch/views/` always do. A file whose
// history is another project's still brings its changes in; a clip's file a first copy lacked, or that this library
// lost, comes in from Bob's file when it comes again. Carton off, or a file without Carton's entry, keeps 1.4.0's
// import and its error. Cardboard's bundles are not in git: CARDBOARD_PRISTINE names them (see ../patches.test.js);
// without them the tests skip.
//   CARDBOARD_PRISTINE=… node --test --test-concurrency=1 scripts/carton/test/sync/cbproj.test.js
// One scenario, in order (each step needs the one before).
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs"), path = require("path"), zlib = require("zlib");
const { spawnSync } = require("child_process");
const { pathToFileURL } = require("url");
const S = require("./support.js");

const t = { skip: S.noBuild };
let b, alice, bob, carol, dave, erin, id, bobClip;
const SHALLOW = ".carton-export/shallow.json", FULL = ".carton-export/history.db";
const HISTORY = { CARTON_CBPROJ_HISTORY: "1" };
const PLANTED = "/planted/factory.mjs";

const zip = S.zipOf;

/**
 * What a computer's worker still holds from where Cardboard staged the file or Carton imported its history: there must
 * be nothing once Open Project returns. On Windows an open file can't be moved or removed, so Cardboard's move of the
 * staged project and its clean-up of the staging folder failed with EBUSY (CI route 35). Linux lets both go, so the
 * checks don't count on that: no Carton open for a bundle in a staging folder (the facade's own list; a Carton opened
 * there and kept would have been moved along with the project, its files then looking like the library's), and no
 * file open (/proc/<pid>/fd, where there is one) in a staging folder, an export, a history copy, or already removed.
 */
function leaks(pc) {
  const d = `/proc/${pc.worker().p.pid}/fd`;
  if (!fs.existsSync(d)) return null;
  return fs.readdirSync(d)
    .map((f) => { try { return fs.readlinkSync(path.join(d, f)); } catch { return ""; } })
    .filter((l) => l.startsWith(pc.home) && (/[\\/]\.opening-|\.carton-export|[\\/]history[^\\/]*\.db/.test(l) || l.endsWith(" (deleted)")));
}
async function closedAfter(pc, what) {
  const staged = (await pc.call("test.cartonOpen")).filter((p) => /[\\/]\.opening-/.test(p));
  assert.deepEqual(staged, [], `${what}: no Carton is left open in Cardboard's staging folder`);
  const l = leaks(pc);
  if (l) assert.deepEqual(l, [], `${what}: nothing staged or imported is left open`);
}

/** A stored zip of `members` ([name, bytes]), as a crafted .cbproj would be made. */
function writeZip(file, members) {
  const parts = [], central = [];
  let at = 0;
  for (const [name, data] of members) {
    const n = Buffer.from(name, "utf8"), crc = zlib.crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(33, 12);
    local.writeUInt32LE(crc, 14); local.writeUInt32LE(data.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(n.length, 26);
    const c = Buffer.alloc(46);
    c.writeUInt32LE(0x02014b50, 0); c.writeUInt16LE(20, 4); c.writeUInt16LE(20, 6); c.writeUInt16LE(33, 14);
    c.writeUInt32LE(crc, 16); c.writeUInt32LE(data.length, 20); c.writeUInt32LE(data.length, 24); c.writeUInt16LE(n.length, 28); c.writeUInt32LE(at, 42);
    parts.push(local, n, data);
    central.push(c, n);
    at += 30 + n.length + data.length;
  }
  const cd = Buffer.concat(central), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(members.length, 8); end.writeUInt16LE(members.length, 10);
  end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(at, 16);
  fs.writeFileSync(file, Buffer.concat([...parts, cd, end]));
}
/** A copy of a .cbproj with some members replaced or added (`more`: name → bytes) and some left out. */
function remix(from, to, more = {}, drop = []) {
  const z = zip(from);
  const members = z.names.filter((n) => !(n in more) && !drop.includes(n)).map((n) => [n, Buffer.from(z.read(n))]);
  writeZip(to, [...members, ...Object.entries(more).map(([n, d]) => [n, Buffer.from(d)])]);
}

const bundleOf = (pc) => path.join(pc.root, "Demo.cardboard");
// `.scratch/views/` (H11): Carton's view files (a print and its status sidecar) never travel in a .cbproj or survive
// Open Project; a person's or an agent's own files there do, as in Cardboard 1.4.0 (views.test.js tells them apart).
const VIEWS = ".scratch/views/";
const cartonViews = (name) => Object.keys(S.cartonViewFiles(name)).map((n) => VIEWS + n);
const ownViews = () => Object.keys(S.ownViewFiles()).map((n) => VIEWS + n);
function plantViews(bundle, files) {
  fs.mkdirSync(path.join(bundle, ...VIEWS.split("/")), { recursive: true });
  for (const [n, d] of Object.entries(files)) fs.writeFileSync(path.join(bundle, ...VIEWS.split("/"), n), d);
}
const has = (bundle, rel) => fs.existsSync(path.join(bundle, ...rel.split("/")));
/** A .cbproj's members: everything of a person's own in `.scratch/views/`, nothing of Carton's. */
function viewsTravel(names, carton) {
  for (const n of ownViews()) assert.ok(names.includes(n), "the file carries " + n + ": " + JSON.stringify(names));
  for (const n of names) assert.ok(!n.startsWith(".carton/") && !cartonViews(carton).includes(n), "never " + n);
}
/** A bundle after Open Project: a person's own view-folder files kept, Carton's gone. */
function viewsKept(bundle, carton, who) {
  for (const n of ownViews()) assert.ok(has(bundle, n), `${who}: ${n} is kept`);
  for (const n of cartonViews(carton)) assert.ok(!has(bundle, n), `${who}: ${n} is gone`);
}
const text = async (pc) => S.textOf(await S.projectOf(pc, id));
const cbOk = (pc, args, extra) => { const r = pc.cb(args, extra); assert.equal(r.code, 0, args.join(" ") + ": " + r.out + r.err); return r; };
/** An agent's edit on a computer, through cb (the printed timeline, one field changed). */
function applyAt(pc, re, to, actor = "codex/c1") {
  const edit = path.join(pc.home, "edit-" + Date.now() + ".tsx");
  fs.writeFileSync(edit, fs.readFileSync(path.join(bundleOf(pc), "timeline.tsx"), "utf8").replace(re, to));
  cbOk(pc, ["source", "apply", "Demo", edit], { CARDBOARD_ACTOR: actor });
}
/** The read-only cut holding `owner`'s versions on a computer (from a file's history), and its versions. */
function readOnlyCut(pc, pick) {
  const cuts = cbOk(pc, ["cut", "list", "Demo"]).json().cuts;
  const cut = cuts.find((c) => c.tracking && !c.shallow && pick(c));
  return { cuts, cut, versions: cut ? cbOk(pc, ["history", "Demo", "--cut", cut.id, "--limit", "50"]).json().versions : [] };
}

/**
 * Open Project in cb's copy (the CLI chunk's library, as `cb project open <file.cbproj>` calls it). cb itself can't be
 * used here: `project open` refuses --root before importing (it shows the project in the running app), and without
 * --root it needs a signed-in account. `Za` is the chunk's library opener in Cardboard 1.4.0 (cb's `H`).
 */
function cliOpen(pc, file, extra = {}) {
  const chunk = pathToFileURL(path.join(b.cli, "chunks", "chunk-LL26E55H.mjs")).href;
  const code = `const m = await import(${JSON.stringify(chunk)});
const lib = await m.Za({ root: ${JSON.stringify(pc.root)} });
try { const p = await lib.projects.openArchive(${JSON.stringify(file)}); console.log(JSON.stringify({ ok: true, id: p?.id })); }
catch (e) { console.log(JSON.stringify({ ok: false, error: String(e?.message ?? e) })); }`;
  const r = spawnSync(process.execPath, ["--input-type=module", "-e", code], { env: { ...pc.env, ...extra }, encoding: "utf8", timeout: 120_000 });
  const line = (r.stdout ?? "").split("\n").reverse().find((l) => l.startsWith('{"ok"'));
  assert.ok(line, "no answer from the CLI's library:\n" + r.stdout + r.stderr);
  return { ...JSON.parse(line), stderr: r.stderr };
}

test.before(async () => {
  if (S.noBuild) return;
  b = await S.build();
  alice = await S.computer("cbproj-alice", b);
  bob = await S.computer("cbproj-bob", b);
  carol = await S.computer("cbproj-carol", b);
  dave = await S.computer("cbproj-dave", b);
  S.seed(alice, b);
  id = JSON.parse(fs.readFileSync(path.join(bundleOf(alice), "project.json"), "utf8")).project.id;
});
test.after(async () => {
  for (const pc of [alice, bob, carol]) if (pc?.worker()) fs.writeFileSync(path.join(S.TMP, pc.name + "-worker.log"), pc.worker().stderr());
  for (const pc of [alice, bob, carol, dave, erin]) pc?.kill();
});

test("Save As (cb) with history: the file carries the shallow export and the history copy as their own entries, never Carton's database or view files", t, async () => {
  plantViews(bundleOf(alice), { ...S.cartonViewFiles("director_c_t1"), ...S.ownViewFiles() });
  const file = path.join(alice.home, "a1.cbproj");
  cbOk(alice, ["project", "save-as", "Demo", file], HISTORY);
  const z = zip(file);
  assert.ok(z.names.includes(SHALLOW) && z.names.includes(FULL), JSON.stringify(z.names));
  assert.ok(z.names.includes("project.json") && z.names.includes("timeline.tsx"), JSON.stringify(z.names));
  viewsTravel(z.names, "director_c_t1");
  const pkg = JSON.parse(z.read(SHALLOW).toString("utf8"));
  assert.equal(pkg.format, "carton-shallow/1");
  assert.equal(pkg.projectId, id);
  // the history copy has no local tables (core's LOCAL_TABLES), and is a carton.db
  assert.equal(z.read(FULL).subarray(0, 15).toString("latin1"), "SQLite format 3");
  assert.ok(!fs.existsSync(path.join(bundleOf(alice), ".carton-export")), "nothing of the export is left in the bundle");
  const tmp = path.join(bundleOf(alice), ".carton", "tmp");
  assert.deepEqual(fs.existsSync(tmp) ? fs.readdirSync(tmp).filter((n) => n.startsWith("history-")) : [], [], "the history copy is removed once the file is written");
  // without the opt-in, no history copy
  const plain = path.join(alice.home, "a0.cbproj");
  cbOk(alice, ["project", "save-as", "Demo", plain]);
  assert.ok(zip(plain).names.includes(SHALLOW) && !zip(plain).names.includes(FULL), JSON.stringify(zip(plain).names));
});

test("An Open Project that fails in Cardboard's prepare (a timeline that doesn't apply) leaves nothing staged open either", t, async () => {
  // The staged bundle is seeded and read through Cardboard's staging library (Carton opens it), then its timeline fails:
  // what Carton opened there is still closed (else Cardboard's clean-up of its staging folder fails on Windows).
  const broken = path.join(alice.home, "broken.cbproj");
  remix(path.join(alice.home, "a1.cbproj"), broken, { "timeline.tsx": "export default (<timeline aspect=\"16:9\"><track name=\"V1\"><clip src=\"nope.mp4\" start={0} end={-1} /></track></timeline>);\n" });
  erin = await S.computer("cbproj-erin", b);
  await erin.startWorker(HISTORY);
  await assert.rejects(erin.call("projects.openArchive", broken), /timeline/i);
  await closedAfter(erin, "Erin's failed Open Project");
  assert.deepEqual(fs.readdirSync(erin.root).filter((n) => n.startsWith(".opening-")), [], "Cardboard removed its staging folder");
  await erin.stopWorker();
});

test("Open Project (app) of a project Bob doesn't have: imported as 1.4.0 does, forked from Alice's, with her versions and authors on a read-only cut", t, async () => {
  await bob.startWorker(HISTORY);
  const p = await bob.call("projects.openArchive", path.join(alice.home, "a1.cbproj"));
  await closedAfter(bob, "Bob's Open Project");
  assert.equal(p.id, id);
  assert.ok(fs.existsSync(path.join(bundleOf(bob), ".carton", "carton.db")), "Bob's copy has history");
  assert.ok(!fs.existsSync(path.join(bundleOf(bob), ".carton-export")), "the export entry isn't kept in the bundle");
  viewsKept(bundleOf(bob), "director_c_t1", "Bob's Open Project");
  assert.equal((await text(bob)).fontSize, 140);
  const { cut, versions } = readOnlyCut(bob, () => true);
  assert.ok(cut, "Alice's cut is a read-only cut at Bob's");
  const by = versions.map((v) => v.by?.id ?? null);
  assert.ok(by.includes("director/chat1/turn1") && by.includes("director/chat1/turn2/sub-Explore-a1"), JSON.stringify(by));
});

test("A crafted .cbproj's .carton/ and Carton view files never survive Open Project, and a person's own files in .scratch/views/ do: the app (Carton on) seeds from the export, cb's copy (Carton off) removes them too; the app's Save As with Carton off leaves Carton's view files out", t, async () => {
  const { openSqliteStore } = S.facade(b);
  // A carton.db as a crafted file would carry it: Alice's history, plus a helper recipe naming a module of the
  // attacker's (a later cb write would import it).
  const work = path.join(alice.home, "craft");
  fs.rmSync(work, { recursive: true, force: true });
  fs.mkdirSync(work, { recursive: true });
  const src = await openSqliteStore(path.join(bundleOf(alice), ".carton", "carton.db"), { readOnly: true });
  await src.exportCopy(path.join(work, "carton.db"), []);
  await src.close();
  const planted = await openSqliteStore(path.join(work, "carton.db"));
  await planted.write([{ table: "lease", key: ["helper"], value: { factory: PLANTED, config: {}, by: "worker", at: Date.now() } }]);
  await planted.close();
  const file = path.join(alice.home, "crafted.cbproj");
  remix(path.join(alice.home, "a1.cbproj"), file, {
    ".carton/carton.db": fs.readFileSync(path.join(work, "carton.db")),
    ...Object.fromEntries(Object.entries(S.cartonViewFiles("x")).map(([n, d]) => [VIEWS + n, d])),
    "./.carton/extra.json": "{}",
  });
  assert.ok(zip(file).names.includes(".carton/carton.db"));

  await carol.startWorker();
  const p = await carol.call("projects.openArchive", file);
  await closedAfter(carol, "Carol's Open Project");
  assert.equal(p.id, id);
  const db = path.join(bundleOf(carol), ".carton", "carton.db");
  assert.ok(fs.existsSync(db), "Carol's copy has history");
  viewsKept(bundleOf(carol), "x", "Carol's Open Project");
  assert.ok(!fs.existsSync(path.join(bundleOf(carol), ".carton", "extra.json")), "nothing else of the planted .carton/ is left");
  const s = await openSqliteStore(db, { readOnly: true });
  try {
    assert.notEqual((await s.get("lease", ["helper"]))?.factory, PLANTED, "the planted helper recipe isn't in Carol's history");
  } finally { await s.close(); }
  // seeded from the export: Carol's cut is her own fork, Alice's is read-only lineage
  const cuts = cbOk(carol, ["cut", "list", "Demo"]).json().cuts;
  const mine = cuts.find((c) => c.current);
  assert.ok(mine && !mine.tracking, JSON.stringify(cuts));
  assert.ok(cuts.some((c) => c.tracking), JSON.stringify(cuts));
  await carol.stopWorker();

  // cb's copy with Carton off: Cardboard 1.4.0's import, less the planted folders
  const off = cliOpen(dave, file, { CARDBOARD_CARTON: "" });
  assert.equal(off.ok, true, off.error);
  assert.ok(fs.existsSync(path.join(bundleOf(dave), "project.json")));
  assert.ok(!fs.existsSync(path.join(bundleOf(dave), ".carton")), "no .carton/ with Carton off either");
  viewsKept(bundleOf(dave), "x", "Dave's Open Project, Carton off");

  // The app's Save As with Carton off (the worker's copy of the walk): Dave's own files go into the file, Carton's
  // view files (here as a Carton build elsewhere would have left them) don't.
  plantViews(bundleOf(dave), S.cartonViewFiles("y"));
  await dave.startWorker({ CARDBOARD_CARTON: "" });
  // the app lists its projects at start; until then the worker's Save As finds none (and answers null)
  assert.ok((await dave.call("projects.list")).some((x) => x.id === id), "Dave's library has the project");
  const daveFile = path.join(dave.home, "d1.cbproj");
  assert.equal((await dave.call("projects.saveArchive", id, daveFile))?.path, daveFile);
  await dave.stopWorker();
  const dz = zip(daveFile);
  viewsTravel(dz.names, "y");
  assert.ok(dz.names.includes("project.json"), JSON.stringify(dz.names));
});

test("Bob adds a clip, his agent and he edit, and he saves a .cbproj with history from the app (the worker's Save As)", t, async () => {
  cbOk(bob, ["media", "add", "Demo", b.clip2]);
  bobClip = JSON.parse(fs.readFileSync(path.join(bundleOf(bob), "project.json"), "utf8")).media.find((m) => !fs.readFileSync(path.join(bundleOf(alice), "project.json"), "utf8").includes(m.mediaId));
  assert.ok(bobClip, "Bob's new clip is in his project");
  applyAt(bob, "start={0.5}", "start={0.25}", "director/chatB/turnB1");
  assert.deepEqual(await bob.call("carton.nameTurn", { projectId: id, chat: "chatB", turn: "turnB1", prompt: "Start the title earlier. Then more." }), { status: "named" });
  await S.guiSave(bob, id, (it) => (it.type === "text" ? { ...it, textContent: "Hello from Bob" } : null));
  plantViews(bundleOf(bob), S.cartonViewFiles("b"));
  const file = path.join(bob.home, "b1.cbproj");
  const r = await bob.call("projects.saveArchive", id, file);
  assert.equal(r.path, file);
  const z = zip(file);
  assert.ok(z.names.includes(SHALLOW) && z.names.includes(FULL), JSON.stringify(z.names));
  assert.ok(z.names.some((n) => n.startsWith("media/" + bobClip.mediaId)), JSON.stringify(z.names));
  viewsTravel(z.names, "b");
  const tmp = path.join(bundleOf(bob), ".carton", "tmp");
  assert.deepEqual(fs.existsSync(tmp) ? fs.readdirSync(tmp).filter((n) => n.startsWith("history-")) : [], [], "the history copy is removed once the file is written");
});

test("Alice, who edited meanwhile, opens Bob's file (app): Bring in their changes, with Bob's versions, authors and names, and his clip's file", t, async () => {
  applyAt(alice, "fontSize={140}", "fontSize={150}");
  await alice.startWorker();
  const p = await alice.call("projects.openArchive", path.join(bob.home, "b1.cbproj"));
  await closedAfter(alice, "Alice's bring-in");
  assert.equal(p.id, id, "the import answers with Alice's own project");
  const x = await text(alice);
  assert.equal(x.textContent, "Hello from Bob", "Bob's edit came in");
  assert.equal(x.startTime, 0.25, "Bob's agent's edit came in");
  assert.equal(x.fontSize, 150, "Alice's own edit is kept");
  assert.equal((await alice.call("projects.list")).length, 1, "still one project in Alice's library");
  assert.deepEqual(fs.readdirSync(alice.root).filter((n) => n.endsWith(".cardboard")), ["Demo.cardboard"]);
  // Bob's versions on a read-only cut, with their authors and the name his agent's turn got
  const { versions, cuts } = readOnlyCut(alice, () => true);
  const all = cuts.filter((c) => c.tracking && !c.shallow).flatMap((c) => cbOk(alice, ["history", "Demo", "--cut", c.id, "--limit", "50"]).json().versions);
  assert.ok(versions.length, JSON.stringify(cuts));
  const named = all.find((v) => v.name === "Start the title earlier");
  assert.ok(named, "Bob's named version: " + JSON.stringify(all.map((v) => [v.version, v.name, v.by?.id])));
  assert.equal(named.by?.id, "director/chatB/turnB1");
  // Bob's clip: its record, its file in Alice's bundle, its entry in project.json, and it plays (not offline)
  const doc = await S.projectOf(alice, id);
  assert.ok(doc.media.some((m) => m.id === bobClip.mediaId), "Bob's clip record");
  const entry = JSON.parse(fs.readFileSync(path.join(bundleOf(alice), "project.json"), "utf8")).media.find((m) => m.mediaId === bobClip.mediaId);
  assert.ok(entry && entry.ownedByBundle === true, "Bob's clip is in Alice's project.json media list");
  assert.ok(entry.nativePath.startsWith(path.join(bundleOf(alice), "media") + path.sep), entry.nativePath);
  assert.deepEqual(fs.readFileSync(entry.nativePath), fs.readFileSync(b.clip2), "the clip's file came in whole");
  const where = await alice.call("media.locate", [bobClip.mediaId]);
  assert.ok(where?.[bobClip.mediaId], "the clip plays at Alice's: " + JSON.stringify(where));
});

test("A clash (cb's Open Project): their value goes in, Alice's is a conflict card; cb resolve --keep mine puts hers back", t, async () => {
  await S.guiSave(bob, id, (it) => (it.type === "text" ? { ...it, textContent: "Bob again" } : null));
  const file = path.join(bob.home, "b2.cbproj");
  await bob.call("projects.saveArchive", id, file);
  applyAt(alice, /textContent="[^"]*"/, 'textContent="Alice\'s words"');
  const r = cliOpen(alice, file);
  assert.deepEqual({ ok: r.ok, id: r.id }, { ok: true, id }, "the import answers with Alice's own project, no \"already exists\": " + r.error);
  const x = await S.until(async () => { const v = await text(alice); return v.textContent === "Bob again" && v; }, 20_000, "bob's text at alice's");
  assert.equal(x.fontSize, 150);
  const cards = cbOk(alice, ["conflicts", "Demo"]).json().cards;
  assert.equal(cards.length, 1, JSON.stringify(cards));
  // as `cb conflicts` reads any card: `theirs` is yours (not in place), `ours` what is there now
  assert.equal(cards[0].theirs, "Alice's words", JSON.stringify(cards[0]));
  assert.equal(cards[0].ours, "Bob again", JSON.stringify(cards[0]));
  cbOk(alice, ["resolve", "Demo", "1", "--keep", "mine"]);
  await S.until(async () => (await text(alice)).textContent === "Alice's words", 20_000, "alice's words back");
  assert.equal(cbOk(alice, ["conflicts", "Demo"]).json().cards.length, 0, "the card is closed");
});

test("A file whose history is another project's: refused (said once), their changes still come in", t, async () => {
  // another project's history copy, from Bob's library
  cbOk(bob, ["project", "create", "Other"]);
  const edit = path.join(bob.home, "other.tsx");
  fs.writeFileSync(edit, 'export default (\n  <timeline aspect="16:9">\n    <track name="Titles">\n      <text name="O" start={0} end={1} textContent="Other" />\n    </track>\n  </timeline>\n);\n');
  cbOk(bob, ["source", "apply", "Other", edit]);
  const other = path.join(bob.home, "other.cbproj");
  cbOk(bob, ["project", "save-as", "Other", other], HISTORY);
  assert.ok(zip(other).names.includes(FULL));
  await S.guiSave(bob, id, (it) => (it.type === "text" ? { ...it, endTime: 2.75 } : null));
  const b3 = path.join(bob.home, "b3.cbproj");
  await bob.call("projects.saveArchive", id, b3);
  const mixed = path.join(bob.home, "b3-mixed.cbproj");
  remix(b3, mixed, { [FULL]: zip(other).read(FULL) });
  const before = cbOk(alice, ["cut", "list", "Demo"]).json().cuts.filter((c) => c.tracking && !c.shallow).length;
  const p = await alice.call("projects.openArchive", mixed);
  await closedAfter(alice, "Alice's bring-in of the mixed file");
  assert.equal(p.id, id);
  assert.equal((await text(alice)).endTime, 2.75, "Bob's change came in");
  assert.equal((await text(alice)).textContent, "Alice's words");
  assert.equal(cbOk(alice, ["cut", "list", "Demo"]).json().cuts.filter((c) => c.tracking && !c.shallow).length, before, "no cut from the other project's history");
  assert.match(alice.worker().stderr(), /weren't brought in .*another project/);
});

// A clip's entry in a library's project.json (`media`, the manifest Cardboard rebuilds its registry from on every read),
// and whether its file is there. Round 5 #1: an adopted clip must be in it, or it is offline again after a restart.
const savedClip = (pc, mediaId) => {
  const bundle = path.join(pc.root, "Demo.cardboard");
  const e = JSON.parse(fs.readFileSync(path.join(bundle, "project.json"), "utf8")).media?.find((m) => m.mediaId === mediaId);
  const file = e && (path.isAbsolute(e.nativePath) ? e.nativePath : path.join(bundle, e.nativePath));
  return e ? { ...e, there: fs.existsSync(file) } : null;
};
const located = async (pc, mediaId) => (await pc.call("media.locate", [mediaId]))?.[mediaId] ?? null;
// Found now, saved in project.json, and found again by a worker started afresh.
async function clipStays(pc, mediaId, what) {
  const got = await located(pc, mediaId);
  assert.ok(got && fs.existsSync(got.nativePath), `${what}: the clip's file is found: ${JSON.stringify(got)}`);
  const saved = savedClip(pc, mediaId);
  assert.ok(saved?.there, `${what}: project.json lists it, with its file: ${JSON.stringify(saved)}`);
  await pc.stopWorker();
  await pc.startWorker();
  await pc.call("projects.list");
  const again = await located(pc, mediaId);
  assert.ok(again && fs.existsSync(again.nativePath), `${what}: found again after a restart: ${JSON.stringify(again)}`);
}

// Round 4 #3: a fold that is up to date (all their versions are in) still brings in a clip's file an earlier copy of
// the file lacked, and saves it in project.json (round 5 #1).
test("Bob's file again, now with his clip's file that a first copy lacked: the clip comes in and stays, though nothing else is new", t, async () => {
  const pc = await S.computer("cbproj-frank", b);
  try {
    await pc.startWorker();
    await pc.call("projects.openArchive", path.join(alice.home, "a1.cbproj"));
    const full = path.join(bob.home, "b1.cbproj");
    const member = zip(full).names.find((n) => n.startsWith("media/" + bobClip.mediaId));
    assert.ok(member, "Bob's file carries his clip");
    const lacking = path.join(pc.home, "b1-without-clip.cbproj");
    remix(full, lacking, {}, [member]);
    await pc.call("projects.openArchive", lacking);
    assert.equal(await located(pc, bobClip.mediaId), null, "no file came with the first copy");
    await pc.call("projects.openArchive", full);
    await clipStays(pc, bobClip.mediaId, "the full file");
    assert.ok((await S.projectOf(pc, (await pc.call("projects.list"))[0].id)).media.some((m) => m.id === bobClip.mediaId), "and the project lists it");
  } finally {
    pc.kill();
  }
});

// Round 4 #4: a clip registered here whose file is gone doesn't keep a newer file's copy of it out. Round 5 #1: its
// stale entry (here an outside path, as a clip relinked to a file since moved away) must not win at the next read, nor
// take the new file with it.
test("A clip whose file this library lost comes back from a newer file of Bob's, and stays", t, async () => {
  const pc = await S.computer("cbproj-grace", b);
  try {
    await pc.startWorker();
    await pc.call("projects.openArchive", path.join(alice.home, "a1.cbproj"));
    await pc.call("projects.openArchive", path.join(bob.home, "b1.cbproj"));
    const had = await located(pc, bobClip.mediaId);
    assert.ok(had && fs.existsSync(had.nativePath), "Bob's clip came with his first file");
    // With the app closed, the clip's file goes, and its entry names a file elsewhere that is gone too.
    await pc.stopWorker();
    fs.rmSync(had.nativePath);
    const pj = path.join(pc.root, "Demo.cardboard", "project.json"), env = JSON.parse(fs.readFileSync(pj, "utf8"));
    env.media = env.media.map((m) => (m.mediaId === bobClip.mediaId ? { ...m, nativePath: path.join(pc.home, "moved-away.mp4"), ownedByBundle: false } : m));
    fs.writeFileSync(pj, JSON.stringify(env));
    await pc.startWorker();
    await pc.call("projects.list");
    assert.equal(await located(pc, bobClip.mediaId), null, "offline before");
    await pc.call("projects.openArchive", path.join(bob.home, "b2.cbproj"));
    await clipStays(pc, bobClip.mediaId, "Bob's newer file");
  } finally {
    pc.kill();
  }
});

test("Carton off, or a file without Carton's entry: 1.4.0's import and its error", t, async () => {
  const off = cliOpen(alice, path.join(bob.home, "b2.cbproj"), { CARDBOARD_CARTON: "" });
  assert.equal(off.ok, false);
  assert.match(off.error, /already exists in (your|this) library/);
  // Bob saves with Carton off: no export entry, and nothing of Carton's in the file.
  const plain = path.join(bob.home, "b4.cbproj");
  cbOk(bob, ["project", "save-as", "Demo", plain], { CARDBOARD_CARTON: "" });
  assert.ok(!zip(plain).names.some((n) => n.startsWith(".carton")), JSON.stringify(zip(plain).names));
  const on = cliOpen(alice, plain);
  assert.equal(on.ok, false);
  assert.match(on.error, /already exists in (your|this) library/);
  // And the app's copy says the same.
  await assert.rejects(alice.call("projects.openArchive", plain), /already exists in (your|this) library/);
  assert.equal((await text(alice)).textContent, "Alice's words", "nothing changed");
});
