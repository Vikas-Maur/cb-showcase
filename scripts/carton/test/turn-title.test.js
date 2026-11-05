// Item 4 (laptop, 2026-11-05): an agent turn's short title comes from Cardboard 1.4.0's own naming call, the one that
// names its chats (hke), handed to main-bridge by patch-carton.js at UKt. These tests run that call as 1.4.0 has it
// (its hke, HWt, qWt and zWt, read out of the pristine dist/main.js) through the namer our patch hands over (read out of
// a staged, patched main.js), against fake agent binaries: one that answers, one that fails, one that never answers
// in time, one whose answer is too long for a title. Needs CARDBOARD_PRISTINE (Cardboard's unpacked app); the fakes are
// shell scripts, so not on Windows.
//   CARDBOARD_PRISTINE=… node --test scripts/carton/test/turn-title.test.js
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs"), os = require("os"), path = require("path"), cp = require("child_process");
const { stage } = require("./stage.js");

const PRISTINE = process.env.CARDBOARD_PRISTINE;
const skip = process.platform === "win32" ? "the fake binaries are shell scripts" : !PRISTINE || !fs.existsSync(path.join(PRISTINE ?? "", "app-asar")) ? "set CARDBOARD_PRISTINE to Cardboard 1.4.0's unpacked app" : false;
const TMP = fs.mkdtempSync(path.join(process.env.CARTON_TEST_DIR ?? os.tmpdir(), "turn-title-"));
test.after(() => fs.rmSync(TMP, { recursive: true, force: true }));

// 1.4.0's naming code, whole, from its declaration list (OWt=6 … hke=…), with its codex stream parser stubbed
const naming = () => {
  const src = fs.readFileSync(path.join(PRISTINE, "app-asar", "dist", "main.js"), "utf8");
  const a = src.indexOf("OWt=6,RWt=40"), b = src.indexOf("});var VWt,QA,bke");
  assert.ok(a > 0 && b > a, "1.4.0's naming code where 1.4.0 has it");
  return new Function("Dg", "var OWt,RWt,lke,DWt,MWt,dke,LWt,NWt,$Wt,jWt,UWt,uke,fke,FWt,pke,mke,zWt,BWt,HWt,qWt,hke;" + src.slice(a, b) + ";return {hke,HWt,zWt,$Wt,uke};")(class { parse() { return []; } });
};
// the namer our patch hands to main-bridge, as the staged build has it
const patchedNamer = (n, LEe) => {
  const out = stage(PRISTINE, path.join(TMP, "stage"), { carton: true });
  const main = fs.readFileSync(out.main, "utf8");
  const from = main.indexOf("UKt=(__cartonMain.namer(") + "UKt=(__cartonMain.namer(".length, to = main.indexOf("),async e=>{let t=await LEe();return t?NEe(t,pke(e),uke):null})", from);
  assert.ok(from > 30 && to > from, "the namer handed over where 1.4.0 defines its chat namer");
  const oe = { app: { getPath: () => TMP } };
  return new Function("LEe", "hke", "lV", "oe", "aV", "return " + main.slice(from, to))(LEe, n.hke, () => ({ ...process.env, FAKE_ARGS: path.join(TMP, "args.txt") }), oe, cp);
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
