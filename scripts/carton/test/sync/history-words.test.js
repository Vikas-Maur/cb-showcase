// History's turn titles on the laptop (2026-11-05), with Cardboard 1.4.0's real cb and library worker (support.js) and
// main's bridge on it (main-bridge.js, as patch-carton.js puts it into dist/main.js):
//   - a turn after one that never reached an agent: its text is the prompt Cardboard composed ("[Earlier messages in
//     this conversation did not reach an agent…"); its version is named from what the person typed (the chat's user
//     event), never the preamble;
//   - then from a short title (main's namer: here a stand-in for Cardboard's own naming call), with the request kept
//     beside it: `cb history` shows the title, `cb history --find` finds the turn by the person's words;
//   - a version renamed meanwhile keeps that name; a turn that changed nothing is never titled.
//   CARDBOARD_PRISTINE=<Cardboard 1.4.0 unpacked> node --test --test-concurrency=1 scripts/carton/test/sync/history-words.test.js
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs"), path = require("path"), { spawnSync } = require("child_process");
const S = require("./support.js");

const t = { skip: S.skip || S.noBuild, timeout: S.TEST_MS };
const TITLES = 'export default (\n  <timeline aspect="16:9">\n    <track name="Agents">\n      <text name="W1" start={0} end={1} fontSize={100} textContent="W1" />\n      <text name="W2" start={1} end={2} fontSize={100} textContent="W2" />\n    </track>\n  </timeline>\n);\n';
const PREAMBLE = "[Earlier messages in this conversation did not reach an agent. Continue from them; do not ask the user to repeat them.]\n\nUser: make the titles pop\n(the user stopped this turn)\n\n[End of earlier conversation. The user's next message follows.]";
const setSize = (text, name, n) => text.replace(new RegExp(`(<text[^>]*name="${name}"[^>]*fontSize=\\{)\\d+(\\})`), `$1${n}$2`);

let b, pc, id, bundle, m;
const titles = [];
let gate = null;
test.before(async () => {
  if (t.skip) return;
  b = await S.build();
  pc = await S.computer("history-words", b);
  const must = (x, what) => assert.equal(x.code, 0, what + ": " + x.out + x.err);
  must(pc.cb(["project", "create", "Demo"]), "create");
  fs.writeFileSync(path.join(pc.home, "titles.tsx"), TITLES);
  must(pc.cb(["source", "apply", "Demo", path.join(pc.home, "titles.tsx")]), "apply");
  bundle = pc.cb(["project", "list"]).json().find((p) => p.name === "Demo").bundlePath;
  id = JSON.parse(fs.readFileSync(path.join(bundle, "project.json"), "utf8")).project.id;
  const saved = { ...process.env };
  Object.assign(process.env, { CARDBOARD_CARTON: "1", CARDBOARD_CARTON_TIMING: "" });
  try { m = new Function("require", require("../../main-bridge.js") + "return __cartonMain;")(require); } finally { process.env = saved; }
  // Cardboard's naming call, stood in for: the prompt and instruction it got, and the title it answers (after `gate`)
  m.namer(async (prompt, instruction) => {
    const answer = { prompt, instruction };
    titles.push(answer);
    if (gate) await gate.wait;
    return answer.title ?? `Bigger title ${titles.length}`;
  });
  await pc.startWorker();
  m.library({ call: (method, arg) => pc.call(method, arg) });
  await pc.call("projects.list");
  await S.guiSave(pc, id, (it) => (it.name === "W2" ? { ...it, textContent: "W2 title" } : null));
}, { timeout: S.SETUP_MS });
test.after(async () => { await pc?.stopWorker(); });

/** A Director turn as Cardboard 1.4.0 launches it: the person's message recorded, the composed prompt as its text. */
const turn = (n, own, edit) => {
  const chat = { chatId: "c1", sessionIds: {}, events: [{ type: "user", id: `t${n}`, text: own }], turn: { id: `t${n}`, state: "running", text: PREAMBLE + "  " + own } };
  m.turnStarted(chat, id, bundle, chat.turn, "director");
  if (edit) {
    const file = path.join(pc.home, `w1-${n}.tsx`);
    // cb's own print, as an agent reads it (no --json)
    const printed = spawnSync(process.execPath, [path.join(b.cli, "cardboard.mjs"), "--root", pc.root, "source", "print", "Demo"], { env: { ...pc.env, CARDBOARD_ACTOR: `director/c1/t${n}` }, encoding: "utf8", timeout: 120_000 });
    assert.match(printed.stdout, /fontSize=\{\d+\}/, printed.stderr);
    fs.writeFileSync(file, setSize(printed.stdout, "W1", edit));
    const r = pc.cb(["source", "apply", "Demo", file], { CARDBOARD_ACTOR: `director/c1/t${n}` });
    assert.equal(r.code, 0, r.out + r.err);
  }
  m.turnEnded(chat, "result");
};
const history = () => pc.cb(["history", "Demo", "--limit", "20"]).json().versions;
const named = (label) => S.until(() => history().find((v) => v.name === label), 30_000, `the version named “${label}”`);

test("a turn after a preamble: named from what the person typed, then titled, with the request kept and found", t, async () => {
  const own = "Okay in this edit, I have the first title too small. Make it bigger please";
  turn(1, own, 160);
  // the person's own words first: never the preamble
  await S.until(() => history().some((v) => v.name && /^Okay in this edit/.test(v.name)) || history().some((v) => v.name === "Bigger title 1"), 30_000, "the turn named");
  const v = await named("Bigger title 1");
  for (const x of history()) assert.doesNotMatch(String(x.name ?? ""), /Earlier messages/);
  assert.equal(titles.length, 1, "one naming call for the turn");
  assert.match(titles[0].prompt, /^The editor asked: Okay in this edit, I have the first title too small/);
  assert.match(titles[0].prompt, /What changed in the edit:\n- .*“W1”/, "built from the turn's worded changes: " + titles[0].prompt);
  assert.doesNotMatch(titles[0].prompt, /Earlier messages|make the titles pop/);
  // the request stays with it: cb finds the turn by the person's words, as its prompt
  const found = pc.cb(["history", "Demo", "--find", "first title too small"]).json();
  const hit = found.matches.find((x) => x.ref.seq === v.ref.seq);
  assert.ok(hit, JSON.stringify(found.matches));
  assert.equal(hit.field, "prompt");
});

test("renamed meanwhile: the rename stays; a turn that changed nothing is never titled", t, async () => {
  let open;
  gate = { wait: new Promise((r) => (open = r)) };
  const own = "Second pass. Bigger again";
  turn(2, own, 170);
  const v = await named("Second pass");
  await S.until(() => titles.length === 2, 20_000, "the second naming call asked");
  // someone renames it while the title is on its way (the worker's own guard: its name is no longer the turn's label)
  assert.equal((await pc.call("carton.retitleTurn", { projectId: id, ref: `${v.ref.branchId}@${v.ref.seq}`, was: "Second pass", title: "Keep this name" })).status, "named");
  open();
  gate = null;
  await S.sleep(1500);
  assert.equal(history().find((x) => x.ref.seq === v.ref.seq).name, "Keep this name", "a name given meanwhile is kept");
  const kept = await pc.call("carton.retitleTurn", { projectId: id, ref: `${v.ref.branchId}@${v.ref.seq}`, was: "Second pass", title: "Too late" });
  assert.equal(kept.status, "kept");
  // a turn that changed nothing: nothing named, no call
  turn(3, "Just look at it, change nothing", null);
  await S.sleep(2000);
  assert.equal(titles.length, 2, "never asked for a turn with no changes");
});
