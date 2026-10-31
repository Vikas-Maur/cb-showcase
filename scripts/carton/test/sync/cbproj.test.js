// .cbproj collaboration, H11 "Bring in their changes" (PLAN §13): Cardboard 1.4.0's real Save As and Open Project,
// patched, in both copies (cb's and the library worker's), on two library roots with their own app data that never
// share a server. Alice saves a .cbproj, Bob opens it (a project he doesn't have), edits and saves one back; Alice,
// who edited meanwhile, opens it: their changes come in, hers stay, and a clash is a conflict card. Carton off, or a
// file without Carton's entry, keeps 1.4.0's import and its error. Cardboard's bundles are not in git:
// CARDBOARD_PRISTINE names them (see ../patches.test.js); without them the tests skip.
//   CARDBOARD_PRISTINE=… node --test --test-concurrency=1 scripts/carton/test/sync/cbproj.test.js
// One scenario, in order (each step needs the one before).
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs"), path = require("path");
const { spawnSync } = require("child_process");
const { pathToFileURL } = require("url");
const S = require("./support.js");

const t = { skip: S.noBuild };
let b, alice, bob, id;
const SHALLOW = ".carton-export/shallow.json";

/** A .cbproj's members (Cardboard writes a stored zip), and a member's bytes. */
function zip(file) {
  const buf = fs.readFileSync(file);
  let e = buf.length - 22;
  while (e >= 0 && buf.readUInt32LE(e) !== 0x06054b50) e--;
  assert.ok(e >= 0, "a zip's end record");
  const entries = new Map();
  for (let i = 0, n = buf.readUInt16LE(e + 10), at = buf.readUInt32LE(e + 16); i < n; i++) {
    const len = buf.readUInt16LE(at + 28), extra = buf.readUInt16LE(at + 30), comment = buf.readUInt16LE(at + 32);
    entries.set(buf.toString("utf8", at + 46, at + 46 + len), { size: buf.readUInt32LE(at + 20), local: buf.readUInt32LE(at + 42) });
    at += 46 + len + extra + comment;
  }
  return {
    names: [...entries.keys()],
    read(name) {
      const x = entries.get(name), start = x.local + 30 + buf.readUInt16LE(x.local + 26) + buf.readUInt16LE(x.local + 28);
      return buf.subarray(start, start + x.size);
    },
  };
}

const bundleOf = (pc) => path.join(pc.root, "Demo.cardboard");
const text = async (pc) => S.textOf(await S.projectOf(pc, id));
/** An agent's edit on Alice's side, through cb (the printed timeline, one field changed). */
function applyAt(pc, re, to) {
  const edit = path.join(pc.home, "edit-" + Date.now() + ".tsx");
  fs.writeFileSync(edit, fs.readFileSync(path.join(bundleOf(pc), "timeline.tsx"), "utf8").replace(re, to));
  const r = pc.cb(["source", "apply", "Demo", edit], { CARDBOARD_ACTOR: "codex/c1" });
  assert.equal(r.code, 0, r.out + r.err);
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
  return JSON.parse(line);
}

test.before(async () => {
  if (S.noBuild) return;
  b = await S.build();
  alice = await S.computer("cbproj-alice", b);
  bob = await S.computer("cbproj-bob", b);
  S.seed(alice, b);
  id = JSON.parse(fs.readFileSync(path.join(bundleOf(alice), "project.json"), "utf8")).project.id;
});
test.after(async () => {
  for (const pc of [alice, bob]) pc?.kill();
});

test("Save As (cb) with history: the file carries the shallow export as its own entry, never Carton's database or view files", t, async () => {
  fs.mkdirSync(path.join(bundleOf(alice), ".scratch", "views"), { recursive: true });
  fs.writeFileSync(path.join(bundleOf(alice), ".scratch", "views", "director_c_t1.tsx"), "// a view file\n");
  const file = path.join(alice.home, "a1.cbproj");
  const r = alice.cb(["project", "save-as", "Demo", file]);
  assert.equal(r.code, 0, r.out + r.err);
  const z = zip(file);
  assert.ok(z.names.includes(SHALLOW), JSON.stringify(z.names));
  assert.ok(z.names.includes("project.json") && z.names.includes("timeline.tsx"), JSON.stringify(z.names));
  for (const n of z.names) assert.ok(!n.startsWith(".carton/") && !n.startsWith(".scratch/views/"), "never " + n);
  const pkg = JSON.parse(z.read(SHALLOW).toString("utf8"));
  assert.equal(pkg.format, "carton-shallow/1");
  assert.equal(pkg.projectId, id);
  assert.ok(!fs.existsSync(path.join(bundleOf(alice), ".carton-export")), "nothing of the export is left in the bundle");
});

test("Open Project (app) of a project Bob doesn't have: imported as 1.4.0 does, its history forked from Alice's", t, async () => {
  await bob.startWorker();
  const p = await bob.call("projects.openArchive", path.join(alice.home, "a1.cbproj"));
  assert.equal(p.id, id);
  assert.ok(fs.existsSync(path.join(bundleOf(bob), ".carton", "carton.db")), "Bob's copy has history");
  assert.ok(!fs.existsSync(path.join(bundleOf(bob), ".carton-export")), "the export entry isn't kept in the bundle");
  assert.equal((await text(bob)).fontSize, 140);
  const h = bob.cb(["history", "Demo"]);
  assert.equal(h.code, 0, h.out + h.err);
});

test("Bob edits and saves a .cbproj from the app (the worker's Save As): it carries his export", t, async () => {
  await S.guiSave(bob, id, (it) => (it.type === "text" ? { ...it, textContent: "Hello from Bob" } : null));
  const file = path.join(bob.home, "b1.cbproj");
  const r = await bob.call("projects.saveArchive", id, file);
  assert.equal(r.path, file);
  const z = zip(file);
  assert.ok(z.names.includes(SHALLOW), JSON.stringify(z.names));
  for (const n of z.names) assert.ok(!n.startsWith(".carton/"), "never " + n);
});

test("Alice, who edited meanwhile, opens Bob's file (app): Bring in their changes, no \"already exists\", hers kept", t, async () => {
  applyAt(alice, "fontSize={140}", "fontSize={150}");
  await alice.startWorker();
  const p = await alice.call("projects.openArchive", path.join(bob.home, "b1.cbproj"));
  assert.equal(p.id, id, "the import answers with Alice's own project");
  const x = await text(alice);
  assert.equal(x.textContent, "Hello from Bob", "Bob's edit came in");
  assert.equal(x.fontSize, 150, "Alice's own edit is kept");
  assert.equal((await alice.call("projects.list")).length, 1, "still one project in Alice's library");
  assert.deepEqual(fs.readdirSync(alice.root).filter((n) => n.endsWith(".cardboard")), ["Demo.cardboard"]);
});

test("A clash (cb's Open Project): Alice's value stays, Bob's is a conflict card in cb conflicts; the rest comes in", t, async () => {
  await S.guiSave(bob, id, (it) => (it.type === "text" ? { ...it, textContent: "Bob again" } : null));
  const file = path.join(bob.home, "b2.cbproj");
  await bob.call("projects.saveArchive", id, file);
  applyAt(alice, /textContent="[^"]*"/, 'textContent="Alice\'s words"');
  const r = cliOpen(alice, file);
  assert.deepEqual(r, { ok: true, id }, "the import answers with Alice's own project, no \"already exists\"");
  const x = await S.until(async () => { const v = await text(alice); return v.textContent === "Alice's words" && v; }, 20_000, "alice's text");
  assert.equal(x.fontSize, 150);
  const c = alice.cb(["conflicts", "Demo"]);
  assert.equal(c.code, 0, c.out + c.err);
  const cards = c.json().cards;
  assert.equal(cards.length, 1, JSON.stringify(cards));
  assert.match(JSON.stringify(cards[0]), /Bob again/, "their value is on the card");
});

test("Carton off, or a file without Carton's entry: 1.4.0's import and its error", t, async () => {
  const off = cliOpen(alice, path.join(bob.home, "b2.cbproj"), { CARDBOARD_CARTON: "" });
  assert.equal(off.ok, false);
  assert.match(off.error, /already exists in (your|this) library/);
  // Bob saves with Carton off: no export entry, and nothing of Carton's in the file.
  const plain = path.join(bob.home, "b3.cbproj");
  const s = bob.cb(["project", "save-as", "Demo", plain], { CARDBOARD_CARTON: "" });
  assert.equal(s.code, 0, s.out + s.err);
  assert.ok(!zip(plain).names.some((n) => n.startsWith(".carton")), JSON.stringify(zip(plain).names));
  const on = cliOpen(alice, plain);
  assert.equal(on.ok, false);
  assert.match(on.error, /already exists in (your|this) library/);
  // And the app's copy says the same.
  await assert.rejects(alice.call("projects.openArchive", plain), /already exists in (your|this) library/);
  assert.equal((await text(alice)).textContent, "Alice's words", "nothing changed");
});
