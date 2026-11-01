// Bugs from the laptop test of the Windows build at 90c4127 (_inspect/carton-build/LAPTOP-REPORT-90c4127.md), with
// Cardboard 1.4.0's real cb and library worker (support.js):
//   #2 agents' cb edits overwrote each other: a print carries Carton's exact header, a numeric header's base is the
//      exact version it names, and `cb source check` of an unchanged print finds nothing, with the revs of several
//      writers out of save order (the facade's half, a writer's document past others, is facade.test.js's);
//   #5 a .cbproj exported with Carton opens in another Carton-on library that hasn't the project;
//   #9 cb's first call after `project create` says nothing about history being off; a file's cut, read-only here,
//      isn't shown under the name of this copy's own.
//   CARDBOARD_PRISTINE=<Cardboard 1.4.0 unpacked> node --test --test-concurrency=1 scripts/carton/test/sync/laptop.test.js
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs"), path = require("path"), { spawnSync } = require("child_process");
const S = require("./support.js");

const t = { skip: S.skip, timeout: 300_000 };
const TITLES = 'export default (\n  <timeline aspect="16:9">\n    <track name="Agents">\n      <text name="W1" start={0} end={1} fontSize={100} textContent="W1" />\n      <text name="W2" start={1} end={2} fontSize={100} textContent="W2" />\n    </track>\n  </timeline>\n);\n';
const CARTON_HEADER = /^\/\/ cardboard:rev (.+@\d+~[0-9a-f]{8} b:[0-9a-f]{8})(?: p:\S+)?(?: by .*)?$/m;
const sizeOf = (text, name) => Number(new RegExp(`<text[^>]*name="${name}"[^>]*fontSize=\\{(\\d+)\\}`).exec(text)?.[1]);
const setSize = (text, name, n) => text.replace(new RegExp(`(<text[^>]*name="${name}"[^>]*fontSize=\\{)\\d+(\\})`), `$1${n}$2`);

/** cb's own output, as an agent reads it (no --json). */
const raw = (pc, b, args) => {
  const r = spawnSync(process.execPath, [path.join(b.cli, "cardboard.mjs"), "--root", pc.root, ...args], { env: pc.env, encoding: "utf8", timeout: 120_000 });
  return { code: r.status, out: r.stdout, err: r.stderr };
};

// In a child, as another writer whose rev was taken before the print's (each cb process's own clock; commits land in
// another order): a version of W1's title committed through the built facade with an older stateUpdatedAt, and
// installed into project.json as the store does.
const OTHER = String.raw`
const fs = require("fs"), path = require("path");
const [carton, bundle, size] = process.argv.slice(1);
const api = require(path.join(carton, "carton-node.cjs")).cardboard14;
const file = path.join(bundle, "project.json");
(async () => {
  const env = JSON.parse(fs.readFileSync(file, "utf8")), p = env.project;
  const doc = { ...p, timelineItems: p.timelineItems.map((i) => (i.name === "W1" ? { ...i, fontSize: Number(size) } : i)), stateUpdatedAt: p.stateUpdatedAt - 60_000 };
  const r = await api.commit({ bundlePath: bundle, base: p, doc, actor: "codex/other" });
  const tmp = path.join(bundle, ".project.json.other.tmp");
  fs.writeFileSync(tmp, JSON.stringify({ ...env, project: r.doc }));
  const ok = await api.install(tmp, file, undefined, r.doc.stateUpdatedAt);
  process.stdout.write(JSON.stringify({ status: r.status, ok, rev: r.doc.stateUpdatedAt, was: p.stateUpdatedAt }) + "\n");
  process.exit(0);
})().catch((e) => { process.stdout.write(JSON.stringify({ error: String(e?.stack ?? e) }) + "\n"); process.exit(1); });
`;

test("#2 a print carries Carton's exact header; its base, and an old numeric print's, is exactly the version printed, with writers' revs out of save order", t, async () => {
  const b = await S.build();
  const pc = await S.computer("laptop-2", b);
  const must = (x, what) => assert.equal(x.code, 0, what + ": " + x.out + x.err);
  must(pc.cb(["project", "create", "Demo"]), "create");
  const tsx = (name, text) => (fs.writeFileSync(path.join(pc.home, name), text), path.join(pc.home, name));
  must(pc.cb(["source", "apply", "Demo", tsx("titles.tsx", TITLES)]), "apply");
  const bundle = pc.cb(["project", "list"]).json().find((p) => p.name === "Demo").bundlePath;
  const printed = raw(pc, b, ["source", "print", "Demo"]);
  must(printed, "print");
  assert.match(printed.out, CARTON_HEADER, "the print names its version as Carton does");
  // the same print as 1.4.0 wrote it: its header the project's rev
  const rev = JSON.parse(fs.readFileSync(path.join(bundle, "project.json"), "utf8")).project.stateUpdatedAt;
  const old = printed.out.replace(CARTON_HEADER, `// cardboard:rev ${rev}`);
  assert.notEqual(old, printed.out);
  // another writer's version lands after the print, under an older rev
  const o = spawnSync(process.execPath, ["-e", OTHER, b.carton, bundle, "150"], { env: pc.env, encoding: "utf8", timeout: 120_000 });
  const other = JSON.parse(o.stdout.trim().split("\n").pop() || "{}");
  assert.ok(!other.error && other.status === "confirmed" && other.ok === true && other.rev < other.was, "the other writer: " + o.stdout + o.stderr);
  // a check of either print, unchanged, finds nothing: its base is the version it shows, not the other writer's
  for (const [name, text] of [["carton", printed.out], ["numeric", old]]) {
    const c = pc.cb(["source", "check", "Demo", tsx(`check-${name}.tsx`, text)]);
    must(c, "check " + name);
    assert.deepEqual(c.json().ops, [], `cb source check of the unchanged ${name} print: ` + JSON.stringify(c.json().ops));
  }
  // an edit of W2 from the old numeric print keeps the other writer's W1
  must(pc.cb(["source", "apply", "Demo", tsx("w2.tsx", setSize(old, "W2", 170))]), "apply W2");
  const now = raw(pc, b, ["source", "print", "Demo"]).out;
  assert.deepEqual([sizeOf(now, "W1"), sizeOf(now, "W2")], [150, 170], "W1 stays the other writer's, W2 is the edit");
  assert.match(now, CARTON_HEADER);
});

/**
 * Open Project in cb's copy (the CLI chunk's library, as `cb project open <file.cbproj>` calls it; `project open`
 * itself refuses --root, cbproj.test.js). `Za` is the chunk's library opener in Cardboard 1.4.0.
 */
function cliOpen(b, pc, file) {
  const chunk = require("url").pathToFileURL(path.join(b.cli, "chunks", "chunk-LL26E55H.mjs")).href;
  const code = `const m = await import(${JSON.stringify(chunk)});
const lib = await m.Za({ root: ${JSON.stringify(pc.root)} });
try { const p = await lib.projects.openArchive(${JSON.stringify(file)}); console.log(JSON.stringify({ ok: true, id: p?.id })); }
catch (e) { console.log(JSON.stringify({ ok: false, error: String(e?.message ?? e) })); }`;
  const r = spawnSync(process.execPath, ["--input-type=module", "-e", code], { env: pc.env, encoding: "utf8", timeout: 120_000 });
  const line = (r.stdout ?? "").split("\n").reverse().find((l) => l.startsWith('{"ok"'));
  assert.ok(line, "no answer from the CLI's library:\n" + r.stdout + r.stderr);
  return JSON.parse(line);
}

test("#5 a .cbproj saved with Carton (its timeline.tsx under Carton's header) opens in another Carton-on library that hasn't the project: cb's copy and the app", t, async () => {
  const b = await S.build();
  const alice = await S.computer("laptop-5-alice", b), bob = await S.computer("laptop-5-bob", b), carol = await S.computer("laptop-5-carol", b);
  const must = (x, what) => assert.equal(x.code, 0, what + ": " + x.out + x.err);
  must(alice.cb(["project", "create", "Demo"]), "create");
  fs.writeFileSync(path.join(alice.home, "titles.tsx"), TITLES);
  must(alice.cb(["source", "apply", "Demo", path.join(alice.home, "titles.tsx")]), "apply");
  const bundle = alice.cb(["project", "list"]).json().find((p) => p.name === "Demo").bundlePath;
  const id = JSON.parse(fs.readFileSync(path.join(bundle, "project.json"), "utf8")).project.id;
  const file = path.join(alice.home, "demo.cbproj");
  // the app's Save As, with the worker's Materializer printing timeline.tsx (Carton's header), and no history in it
  try {
    await alice.startWorker();
    await alice.call("projects.list");
    await S.until(() => CARTON_HEADER.test(fs.readFileSync(path.join(bundle, "timeline.tsx"), "utf8")), 20_000, "Carton's print of timeline.tsx");
    await alice.call("projects.saveArchive", id, file);
  } finally { await alice.stopWorker(); }
  const z = S.zipOf(file);
  assert.match(z.read("timeline.tsx").toString("utf8"), CARTON_HEADER, "the file's timeline.tsx names Alice's version as Carton does");
  // cb's copy (cb project open)
  const opened = cliOpen(b, bob, file);
  assert.deepEqual(opened, { ok: true, id }, "Bob's cb opens it");
  const at = (pc) => raw(pc, b, ["source", "print", "Demo"]).out;
  assert.deepEqual([sizeOf(at(bob), "W1"), sizeOf(at(bob), "W2")], [100, 100]);
  assert.ok(fs.existsSync(path.join(bob.root, "Demo.cardboard", ".carton", "carton.db")), "with history of its own");
  // #9: Alice's cut, read-only here, doesn't show under the name of Bob's own
  const cuts = bob.cb(["cut", "list", "Demo"]).json().cuts.map((c) => [c.name, !!c.tracking]).sort((x, y) => x[0].localeCompare(y[0]));
  assert.deepEqual(cuts, [["Main cut", false], ["Main cut (their copy)", true]], JSON.stringify(cuts));
  // the app (a double-click hands the file to the library worker's Open Project)
  try {
    await carol.startWorker();
    const p = await carol.call("projects.openArchive", file);
    assert.equal(p?.id, id, "Carol's app opens it");
  } finally { await carol.stopWorker(); }
  assert.deepEqual([sizeOf(at(carol), "W1"), sizeOf(at(carol), "W2")], [100, 100]);
});

test("#9 cb's `project create` says nothing about history being off: the project's history starts with it", t, async () => {
  const b = await S.build();
  const pc = await S.computer("laptop-9", b);
  const made = pc.cb(["project", "create", "Demo"]);
  assert.equal(made.code, 0, made.out + made.err);
  assert.doesNotMatch(made.err, /history is off/, "no warning on create: " + made.err);
  const bundle = pc.cb(["project", "list"]).json().find((p) => p.name === "Demo").bundlePath;
  assert.ok(fs.existsSync(path.join(bundle, ".carton", "carton.db")), "history began with the project");
  const h = pc.cb(["history", "Demo"]);
  assert.equal(h.code, 0, h.out + h.err);
  assert.doesNotMatch(h.err, /history is off/, h.err);
  const n0 = h.json().versions.length;
  assert.ok(n0 >= 1, "the new project is in its history: " + h.out);
  fs.writeFileSync(path.join(pc.home, "titles.tsx"), TITLES);
  const a = pc.cb(["source", "apply", "Demo", path.join(pc.home, "titles.tsx")]);
  assert.equal(a.code, 0, a.out + a.err);
  assert.doesNotMatch(a.err, /history is off/, a.err);
  assert.equal(pc.cb(["history", "Demo"]).json().versions.length, n0 + 1, "the apply is the next version");
});

test("#8 an in-app turn on the person's own Claude Code (not the Director) is a turn too: the freeze ends with it and its last version takes the prompt's name", t, async () => {
  const b = await S.build();
  const pc = await S.computer("laptop-8", b);
  const must = (x, what) => assert.equal(x.code, 0, what + ": " + x.out + x.err);
  must(pc.cb(["project", "create", "Demo"]), "create");
  fs.writeFileSync(path.join(pc.home, "titles.tsx"), TITLES);
  must(pc.cb(["source", "apply", "Demo", path.join(pc.home, "titles.tsx")]), "apply");
  const bundle = pc.cb(["project", "list"]).json().find((p) => p.name === "Demo").bundlePath;
  const id = JSON.parse(fs.readFileSync(path.join(bundle, "project.json"), "utf8")).project.id;
  const tsxFile = path.join(bundle, "timeline.tsx"), tsx = () => fs.readFileSync(tsxFile, "utf8");
  // main's bridge, with the worker as its library (as dist/main.js holds them)
  const saved = { ...process.env };
  Object.assign(process.env, { CARDBOARD_CARTON: "1", CARDBOARD_CARTON_TIMING: "" });
  let m;
  try { m = new Function("require", require("../../main-bridge.js") + "return __cartonMain;")(require); } finally { process.env = saved; }
  const session = "abcd1234-5678-4000-8000-000000000001", hookActor = "claude-code/abcd1234";
  const env = m.agentEnv({}, "claude", "c2");
  try {
    await pc.startWorker();
    m.library({ call: (method, arg) => pc.call(method, arg) });
    await pc.call("projects.list");
    // the project open in the app: a GUI save opens its Carton, and the worker's Materializer prints timeline.tsx
    await S.guiSave(pc, id, (it) => (it.name === "W2" ? { ...it, textContent: "W2 title" } : null));
    await S.until(() => / p:\S+ by carton$/m.test(tsx()) && tsx().includes('textContent="W2 title"'), 20_000, "the Materializer's timeline.tsx");
    const chat = { chatId: "c2", sessionIds: { claude: session }, turn: { id: "t1", state: "running", text: "Make the first title bigger. Then stop." } };
    m.turnStarted(chat, id, bundle, chat.turn, "claude");
    // host Claude Code reads timeline.tsx: its hook (cb carton-hook, through --settings) tells the worker's holder
    const read = spawnSync(process.execPath, [path.join(b.cli, "cardboard.mjs"), "carton-hook", "pre-tool-use", "--project", bundle], { env: { ...pc.env, ...env }, input: JSON.stringify({ hook_event_name: "PreToolUse", session_id: session, tool_name: "Read", tool_input: { file_path: tsxFile }, cwd: bundle }), encoding: "utf8", timeout: 60_000 });
    must({ code: read.status, out: read.stdout, err: read.stderr }, "the hook");
    // the person's GUI edit stays out of the frozen file; the agent's own cb edit (as its Bash hook names it) shows
    await S.guiSave(pc, id, (it) => (it.name === "W2" ? { ...it, fontSize: 180 } : null));
    const printed = raw(pc, b, ["source", "print", "Demo"]).out;
    fs.writeFileSync(path.join(pc.home, "w1.tsx"), setSize(printed, "W1", 160));
    const r = spawnSync(process.execPath, [path.join(b.cli, "cardboard.mjs"), "--root", pc.root, "source", "apply", "Demo", path.join(pc.home, "w1.tsx")], { env: { ...pc.env, CARDBOARD_ACTOR: hookActor }, encoding: "utf8", timeout: 120_000 });
    must({ code: r.status, out: r.stdout, err: r.stderr }, "the agent's apply");
    await S.until(() => sizeOf(tsx(), "W1") === 160, 20_000, "the agent's own edit in the frozen file");
    await S.sleep(1500);
    assert.equal(sizeOf(tsx(), "W2"), 100, "the person's edit stays out while the turn runs");
    // the turn ends (Cardboard's closeTurn): the freeze lets go at once, and the agent's version is named
    const ended = Date.now();
    m.turnEnded(chat, "result");
    await S.until(() => sizeOf(tsx(), "W2") === 180, 10_000, "timeline.tsx back to head after the turn");
    assert.ok(Date.now() - ended < 10_000);
    const named = await S.until(() => pc.cb(["history", "Demo", "--limit", "20"]).json().versions.find((v) => v.name === "Make the first title bigger"), 20_000, "the turn's version named");
    assert.equal(named.by?.id ?? named.by, hookActor, JSON.stringify(named));
  } finally { await pc.stopWorker(); }
});
