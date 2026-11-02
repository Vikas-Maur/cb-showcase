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

// Claude Code's Bash tool on Windows runs Git Bash (CLAUDE_CODE_GIT_BASH_PATH, else Git's own), as director-turn.test.js.
const BASH = process.platform !== "win32" ? "bash" : process.env.CLAUDE_CODE_GIT_BASH_PATH
  ?? [path.join(process.env.ProgramFiles ?? "C:\\Program Files", "Git", "bin", "bash.exe")].find((f) => fs.existsSync(f)) ?? "bash";

test("#8 an in-app turn on the person's own Claude Code (not the Director), as Cardboard 1.4.0 runs it, is a turn too: credited to Claude Code, the freeze ends with it, its last version takes the prompt's name", t, async () => {
  const b = await S.build();
  const pc = await S.computer("laptop-8", b);
  const must = (x, what) => assert.equal(x.code, 0, what + ": " + x.out + x.err);
  // (before the worker runs: a terminal's cb write while it runs freezes timeline.tsx for a minute, by design)
  must(pc.cb(["project", "create", "Demo"]), "create");
  fs.writeFileSync(path.join(pc.home, "titles.tsx"), TITLES);
  must(pc.cb(["source", "apply", "Demo", path.join(pc.home, "titles.tsx")]), "apply");
  const bundle = pc.cb(["project", "list"]).json().find((p) => p.name === "Demo").bundlePath;
  const id = JSON.parse(fs.readFileSync(path.join(bundle, "project.json"), "utf8")).project.id;
  const tsxFile = path.join(bundle, "timeline.tsx"), tsx = () => fs.readFileSync(tsxFile, "utf8");
  // `cb` on PATH for the agent's shell (the app's agent-bin shim), on this computer's library
  const bin = path.join(pc.home, "bin"), slash = (p) => p.replace(/\\/g, "/");
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(path.join(bin, "cb"), `#!/bin/sh\nexec "${slash(process.execPath)}" "${slash(path.join(b.cli, "cardboard.mjs"))}" --root "${slash(pc.root)}" "$@"\n`, { mode: 0o755 });
  // main's bridge, with the worker as its library (as dist/main.js holds them)
  const saved = { ...process.env };
  Object.assign(process.env, { CARDBOARD_CARTON: "1", CARDBOARD_CARTON_TIMING: "" });
  let m;
  try { m = new Function("require", require("../../main-bridge.js") + "return __cartonMain;")(require); } finally { process.env = saved; }
  // Cardboard 1.4.0 runs the composer's own Claude Code (provider "claude") through its Agent SDK transport (v_e → oH),
  // as it runs the Director (RVt → oH): deps.spawn never starts it (no agentEnv) and its args never run (no --settings,
  // no `cb carton-hook`). Its hooks are main's, in process (the ones patch-carton.js extends), with main's launch
  // context; its environment is the binary's (no CARDBOARD_ACTOR), and Claude Code's Bash tool adds CLAUDECODE. Ids as
  // on the laptop (chat 7a09…, session 787d66ff…).
  const chatId = "7a09b6cc-8553-4fe8-9942-0cf44eec39e2", session = "787d66ff-b5c3-4f50-a5cd-4a497e39021a", ME = "claude-code/787d66ff";
  const ctx = { project: { id, name: "Demo", bundlePath: bundle }, chatId, binary: { path: "claude", environment: {} }, launch: { provider: "claude", model: "default" }, sessionId: null };
  const env = { ...pc.env, CLAUDECODE: "1", PATH: bin + path.delimiter + process.env.PATH };
  delete env.CARDBOARD_ACTOR;
  /** One Bash tool call: the transport's PreToolUse hook (the credit gate allows) decides, then bash runs it. */
  const bash = async (command) => {
    const r = await m.directorHook(ctx, async () => ({}))({ hook_event_name: "PreToolUse", session_id: session, tool_name: "Bash", tool_input: { command }, cwd: bundle });
    const run = r?.hookSpecificOutput?.updatedInput?.command ?? command;
    const x = spawnSync(BASH, ["-c", run], { env, cwd: bundle, encoding: "utf8", timeout: 120_000 });
    return { code: x.status, out: x.stdout ?? "", err: x.stderr ?? "", ran: run };
  };
  /** The agent's edit of W1, through cb (`cb source apply` of an edited print), as its own Bash call. */
  const agentEdit = async (size) => {
    const file = path.join(pc.home, `w1-${size}.tsx`);
    fs.writeFileSync(file, setSize(raw(pc, b, ["source", "print", "Demo"]).out, "W1", size));
    const r = await bash(`cb source apply Demo '${slash(file)}'`);
    must(r, "the agent's apply");
    assert.match(r.ran, new RegExp(`^export CARDBOARD_ACTOR='${ME}'; `), "its cb call is Claude Code's, never director/<chat>");
  };
  const versionNamed = (label) => S.until(() => pc.cb(["history", "Demo", "--limit", "20"]).json().versions.find((v) => v.name === label), 20_000, `the version named "${label}"`);
  const ends = [];
  try {
    await pc.startWorker();
    m.library({ call: (method, arg) => pc.call(method, arg) });
    await pc.call("projects.list");
    // the project open in the app: a GUI save opens its Carton, and the worker's Materializer prints timeline.tsx
    await S.guiSave(pc, id, (it) => (it.name === "W2" ? { ...it, textContent: "W2 title" } : null));
    await S.until(() => / p:\S+ by carton$/m.test(tsx()) && tsx().includes('textContent="W2 title"'), 20_000, "the Materializer's timeline.tsx");

    // Turn 1, ended without a Stop (an interrupt: Cardboard's end() → closeTurn): the turn's end alone lets go.
    const chat = { chatId, sessionIds: { claude: session }, turn: { id: "t1", state: "running", text: "Make the first title bigger. Then stop." } };
    m.turnStarted(chat, id, bundle, chat.turn, "claude");
    // its first command runs cb and reads timeline.tsx, as on the laptop: the shared file freezes for the turn
    const first = await bash('cb history Demo --limit 1 >/dev/null; grep -n "W2" timeline.tsx');
    must(first, "the first command");
    assert.match(first.ran, new RegExp(`^export CARDBOARD_ACTOR='${ME}'; `));
    // the person's GUI edit stays out of the frozen file; the agent's own cb edit shows
    await S.guiSave(pc, id, (it) => (it.name === "W2" ? { ...it, fontSize: 180 } : null));
    await agentEdit(160);
    await S.until(() => sizeOf(tsx(), "W1") === 160, 20_000, "the agent's own edit in the frozen file");
    await S.sleep(1500);
    assert.equal(sizeOf(tsx(), "W2"), 100, "the person's edit stays out while the turn runs");
    let ended = Date.now();
    m.turnEnded(chat, "stopped");
    chat.turn = { state: "idle" };
    await S.until(() => sizeOf(tsx(), "W2") === 180, 10_000, "timeline.tsx back to head after the turn");
    ends.push(Date.now() - ended);
    const named = await versionNamed("Make the first title bigger");
    assert.equal(named.by?.id ?? named.by, ME, JSON.stringify(named));
    // credits and History say Claude Code, not the Director
    const credits = raw(pc, b, ["credits", "Demo", "W1"]);
    must(credits, "credits");
    assert.match(credits.out, /last changed by Claude Code/, credits.out);
    assert.doesNotMatch(credits.out, /Director/, credits.out);
    assert.equal(named.by?.name, "Claude Code", JSON.stringify(named.by));

    // Turn 2, ended as the stream's result ends it: its Stop hook (main's, for this agent), then closeTurn.
    chat.turn = { id: "t2", state: "running", text: "Bigger first title again. Then stop." };
    m.turnStarted(chat, id, bundle, chat.turn, "claude");
    must(await bash("grep -n 'W1' timeline.tsx"), "the read");
    await S.guiSave(pc, id, (it) => (it.name === "W2" ? { ...it, fontSize: 190 } : null));
    await agentEdit(170);
    await S.until(() => sizeOf(tsx(), "W1") === 170, 20_000, "the agent's own edit in the frozen file (turn 2)");
    await S.sleep(1500);
    assert.equal(sizeOf(tsx(), "W2"), 180, "the person's second edit stays out while turn 2 runs");
    ended = Date.now();
    assert.deepEqual(await m.stopHooks(ctx).Stop[0].hooks[0]({ hook_event_name: "Stop", session_id: session, stop_hook_active: false }), {}, "nothing to hand back: the turn stops");
    m.turnEnded(chat, "result");
    chat.turn = { state: "idle" };
    await S.until(() => sizeOf(tsx(), "W2") === 190, 10_000, "timeline.tsx back to head after turn 2");
    ends.push(Date.now() - ended);
    const named2 = await versionNamed("Bigger first title again");
    assert.equal(named2.by?.id ?? named2.by, ME, JSON.stringify(named2));
    assert.ok(await versionNamed("Make the first title bigger"), "turn 1's version keeps its name");
    console.log(`# laptop #8: timeline.tsx back to head ${ends.join(" ms, ")} ms after each turn's end`);
    for (const ms of ends) assert.ok(ms < 5_000, "promptly after the turn's end: " + ends);
  } finally { await pc.stopWorker(); }
});

test("#2 (review P1) a print of an edit still waiting to sync (shared, offline) is exactly that edit's state: unchanged, check finds nothing; edited back, the edit lands", t, async () => {
  const b = await S.build();
  const host = await S.startHost(path.join(S.TMP, "laptop-p1-host"));
  const pc = await S.computer("laptop-p1", b);
  S.seed(pc, b);
  try {
    await pc.startWorker();
    const id = (await pc.call("projects.list"))[0].id;
    const r = await pc.call("carton.liveShare", { projectId: id, host: host.origin, adminToken: S.ADMIN, name: "Alice" });
    assert.equal(r.status, "shared", JSON.stringify(r));
    await S.until(async () => (await pc.call("carton.liveStatus", { projectId: id })).status === "up-to-date", 20_000, "shared");
    await host.stop();
    await S.until(async () => (await pc.call("carton.liveStatus", { projectId: id })).status === "offline", 20_000, "offline");
    // the app's edit, waiting to sync: 140 → 199
    await S.guiSave(pc, id, (it) => (it.type === "text" ? { ...it, fontSize: 199 } : null));
    await S.until(() => S.textOf(S.fileOf(pc)).fontSize === 199, 10_000, "the pending edit in project.json");
    const printed = raw(pc, b, ["source", "print", "Demo"]);
    assert.equal(printed.code, 0, printed.out + printed.err);
    assert.match(printed.out, /fontSize=\{199\}/);
    const file = (name, text) => (fs.writeFileSync(path.join(pc.home, name), text), path.join(pc.home, name));
    // unchanged: nothing to apply
    const c = pc.cb(["source", "check", "Demo", file("p1-same.tsx", printed.out)]);
    assert.equal(c.code, 0, c.out + c.err);
    assert.deepEqual(c.json().ops, [], "check of the unchanged print: " + JSON.stringify(c.json().ops));
    // edited back to 140: that is the edit, made on 199
    const a = pc.cb(["source", "apply", "Demo", file("p1-back.tsx", printed.out.replace("fontSize={199}", "fontSize={140}"))]);
    assert.equal(a.code, 0, a.out + a.err);
    assert.ok(a.json().ops.length > 0, "the apply changes the size: " + a.out);
    await S.until(async () => S.textOf(await S.projectOf(pc, id)).fontSize === 140, 20_000, "140 again");
  } finally {
    await pc.stopWorker();
    S.killHelpers();
    await host.stop().catch(() => {});
  }
});
