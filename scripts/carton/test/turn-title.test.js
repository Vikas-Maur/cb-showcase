// Item 4 (laptop, 2026-11-05): an agent turn's short title comes from Cardboard 1.4.0's own naming call, the one that
// names its chats (hke), handed to main-bridge by patch-carton.js at UKt. These tests run that call as the build ships
// it (1.4.0's hke, HWt, qWt and zWt, read out of a staged, patched dist/main.js) through the namer our patch hands over,
// against fake agent binaries: one that answers, one that fails, one that never answers in time, one whose answer is
// too long for a title, and one the locator found that has since gone (review of a2725f9c #1: an uncaught spawn error
// in main). Needs CARDBOARD_PRISTINE (Cardboard's unpacked app); the fakes are shell scripts, so not on Windows.
//   CARDBOARD_PRISTINE=… node --test scripts/carton/test/turn-title.test.js
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs"), os = require("os"), path = require("path"), cp = require("child_process");
const { stage } = require("./stage.js");

const PRISTINE = process.env.CARDBOARD_PRISTINE;
const skip = process.platform === "win32" ? "the fake binaries are shell scripts" : !PRISTINE || !fs.existsSync(path.join(PRISTINE ?? "", "app-asar")) ? "set CARDBOARD_PRISTINE to Cardboard 1.4.0's unpacked app" : false;
const TMP = fs.mkdtempSync(path.join(process.env.CARTON_TEST_DIR ?? os.tmpdir(), "turn-title-"));
test.after(() => fs.rmSync(TMP, { recursive: true, force: true }));

// the staged, patched main.js (staged once)
let staged = null;
const stagedMain = () => (staged ??= fs.readFileSync(stage(PRISTINE, path.join(TMP, "stage"), { carton: true }).main, "utf8"));
// Cardboard's naming code as the build ships it, whole, from its declaration list (1.5.0: rKt=6 … lSe=…; 1.4.0's
// OWt … hke; the object below keeps 1.4.0's names for them)
const namingSource = () => {
  const src = stagedMain();
  const a = src.indexOf("rKt=6,nKt=40"), b = src.indexOf("});var gKt,l3,uSe");
  assert.ok(a > 0 && b > a, "1.4.0's naming code where 1.4.0 has it");
  return "var rKt,nKt,nSe,iKt,sKt,iSe,oKt,aKt,cKt,lKt,dKt,sSe,oSe,uKt,aSe,cSe,fKt,pKt,mKt,hKt,lSe;" + src.slice(a, b);
};
// (its codex stream parser stubbed)
const naming = () => new Function("$1", namingSource() + ";return {hke:lSe,HWt:mKt,zWt:fKt,$Wt:cKt,uke:sSe};")(class { parse() { return []; } });
// the namer our patch hands to main-bridge, as the staged build has it
const patchedNamer = (n, LEe) => {
  const main = stagedMain();
  const from = main.indexOf("fJt=(__cartonMain.namer(") + "fJt=(__cartonMain.namer(".length, to = main.indexOf("),async e=>{let t=await Axe();return t?Pxe(t,aSe(e),sSe):null})", from);
  assert.ok(from > 30 && to > from, "the namer handed over where 1.4.0 defines its chat namer");
  const oe = { app: { getPath: () => TMP } };
  return new Function("Axe", "lSe", "kq", "oe", "_q", "return " + main.slice(from, to))(LEe, n.hke, () => ({ ...process.env, FAKE_ARGS: path.join(TMP, "args.txt") }), oe, cp);
};
const fake = (name, body) => {
  const file = path.join(TMP, name);
  fs.writeFileSync(file, "#!/bin/sh\nprintf '%s\\n' \"$@\" > \"$FAKE_ARGS\"\necho \"thinking=$MAX_THINKING_TOKENS traffic=$CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC\" >> \"$FAKE_ARGS\"\n" + body + "\n", { mode: 0o755 });
  return { path: file, provider: "claude", signedIn: true };
};
const PROMPT = "The editor asked: Okay in this edit, I have the J and L cuts wrong\n\nWhat changed in the edit:\n- Added “1.mp4 audio”\n- Muted “1.mp4”";
const INSTRUCTION = "Title this change to a video edit in 2 to 6 words, sentence case.";

test("Cardboard's own naming call through our namer: the person's signed-in Claude Code, haiku, no tools or hooks, a cleaned answer", { skip, timeout: 300_000 }, async () => {
  const n = naming();
  let bin = fake("claude-answers", 'echo "\\"Split audio for J/L cuts.\\""');
  const namer = patchedNamer(n, async () => bin);
  assert.equal(await namer(PROMPT, INSTRUCTION, 5000), "Split audio for J/L cuts", "its first line, quotes and the end's punctuation gone");
  const got = fs.readFileSync(path.join(TMP, "args.txt"), "utf8");
  assert.ok(got.startsWith("-p\n" + PROMPT + "\n--model\nhaiku\n"), "the whole prompt as -p's one argument, then the cheap model: " + got.slice(0, 80));
  const flat = got.split("\n").join(" ");
  for (const flag of ["--model haiku", "--system-prompt " + INSTRUCTION, '--settings {"disableAllHooks":true}', "--strict-mcp-config", "--disallowed-tools *", "--disable-slash-commands", "--no-session-persistence"]) assert.ok(flat.includes(flag), flag);
  assert.match(flat, /thinking=0 traffic=1/, "1.4.0's environment for it");
  // no signed-in binary (LEe answers null): no call at all, null
  bin = null;
  assert.equal(await namer(PROMPT, INSTRUCTION, 5000), null);
});

test("a binary that fails, one that never answers in time, one whose answer is no title: null, and the person's words stay", { skip, timeout: 300_000 }, async () => {
  const n = naming();
  let bin;
  const namer = patchedNamer(n, async () => bin);
  bin = fake("claude-fails", 'echo "Not logged in" >&2\nexit 1');
  assert.equal(await namer(PROMPT, INSTRUCTION, 5000), null, "fails");
  bin = fake("claude-hangs", "exec sleep 30");
  const t0 = Date.now();
  assert.equal(await namer(PROMPT, INSTRUCTION, 400), null, "times out");
  assert.ok(Date.now() - t0 < 5000, "at its timeout, not the binary's end");
  bin = fake("claude-rambles", 'echo "Here is a title for your edit that is far too long to be one"');
  assert.equal(await namer(PROMPT, INSTRUCTION, 5000), null, "over 6 words: no title");
  bin = fake("claude-silent", "exit 0");
  assert.equal(await namer(PROMPT, INSTRUCTION, 5000), null, "empty");
});

test("a binary the locator found but that has since gone: null, nothing thrown in main, nothing of the prompt said (review #1)", { skip, timeout: 300_000 }, async () => {
  // In a child process, as main runs it: an 'error' event with no listener (Node's ChildProcess, ENOENT) is thrown
  // there, past every Promise.catch, and in Electron's main process brings up an error dialog. Its spawnargs hold the
  // prompt. Cardboard's own chat and project names go through the same call.
  const gone = path.join(TMP, "claude-gone");
  const code = namingSource() + `;
    const cp = require("node:child_process");
    lSe({ binary: { path: ${JSON.stringify(gone)}, provider: "claude" }, prompt: "SECRET-REQUEST", instruction: "x", env: process.env, cwd: process.cwd(), spawn: cp.spawn, timeoutMs: 20000, warn: (m) => console.error("warn:" + m) })
      .then((r) => { console.log(JSON.stringify({ r, ms: Math.round(performance.now()) })); }, (e) => console.log(JSON.stringify({ rejected: String(e && e.code) })));`;
  const r = cp.spawnSync(process.execPath, ["-e", code], { encoding: "utf8", timeout: 60_000 });
  assert.equal(r.status, 0, "no uncaught error: " + r.stderr.slice(0, 400));
  assert.doesNotMatch(r.stderr, /Unhandled 'error' event|SECRET-REQUEST/, "nothing thrown, the prompt never written out");
  assert.doesNotMatch(r.stdout, /SECRET-REQUEST/);
  const out = JSON.parse(r.stdout.trim().split("\n").at(-1));
  assert.equal(out.r, null, "no title: the person's words stay");
  assert.ok(out.ms < 15_000, "at once, not at its 20 s timeout");
});
