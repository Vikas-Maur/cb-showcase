// Read-your-writes for timeline.tsx (fix/apply-ryw). In a real in-app Claude Code turn (merge/prod-2 @ 12826273) the
// agent ran `cb source apply` and read timeline.tsx at once: the file still showed the old value, and the agent told the
// user, wrongly, that the file "keeps showing the timeline as it was when my turn started". The file caught up a moment
// later (a poller saw it mid-turn). With the app open, the library worker's Materializer prints timeline.tsx, and it
// heard of a `cb` commit made in cb's own process only at its next poll of carton.db (250 ms), then rewrote the file
// 20 ms later: cb had answered by then. Now cb's write asks the worker's lease holder to show it and answers once
// timeline.tsx does (at most 2 s; past that the result says so: `carton.timeline`, and a line in its text).
// Each case runs the agent's apply and reads timeline.tsx as soon as cb returns, several times over, on Cardboard 1.4.0's
// real (patched) library worker and cb, with the app open and closed, on a local cut and a shared cut, and with the file
// frozen for an agent's turn (the person's GUI edit held back, the agent's own write shown).
//   CARDBOARD_PRISTINE=<Cardboard 1.4.0 unpacked> node --test --test-concurrency=1 scripts/carton/test/sync/apply-ryw.test.js
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs"), path = require("path");
const S = require("./support.js");

const t = { skip: S.skip || S.noBuild, timeout: S.TEST_MS };
// how many applies each case reads back (the laptop's lag missed 7 of 15)
const TRIES = Number(process.env.CARTON_RYW_TRIES) || 8;
let b, pc, id, tsxFile, host, size = 200;
const AGENT = "claude-code/sessR";

test.before(async () => {
  if (t.skip) return;
  b = await S.build();
  pc = await S.computer("ryw", b);
  S.seed(pc, b);
  tsxFile = path.join(pc.root, "Demo.cardboard", "timeline.tsx");
}, { timeout: S.SETUP_MS });
test.after(async () => {
  if (pc?.worker()) fs.writeFileSync(path.join(S.TMP, "ryw-worker.log"), pc.worker().stderr());
  await pc?.stopWorker();
  S.killHelpers();
  await host?.stop().catch(() => {});
}, { timeout: S.STOP_MS });

const tsxNow = () => fs.readFileSync(tsxFile, "utf8");
/**
 * An agent's `cb source apply` of a new font size, made on timeline.tsx as the agent last read it, and timeline.tsx read
 * the moment cb returns. `actor`: CARDBOARD_ACTOR (an agent the app started), or "" for a terminal's cb.
 */
function applyAndRead(actor, what) {
  const n = ++size;
  const edit = path.join(pc.home, "ryw-edit.tsx");
  fs.writeFileSync(edit, tsxNow().replace(/fontSize=\{\d+\}/, `fontSize={${n}}`));
  const r = pc.cb(["source", "apply", "Demo", edit], { CARDBOARD_ACTOR: actor, ...(actor ? {} : asTerminal()) });
  const read = tsxNow();
  assert.equal(r.code, 0, `${what}: ${r.out}${r.err}`);
  return { n, read, shown: read.includes(`fontSize={${n}}`), result: r.json() };
}
/**
 * A terminal's cb: no agent named, and none of the environment variables an agent CLI sets (CLAUDECODE, CODEX_*,
 * GEMINI_CLI, CURSOR_TRACE_ID, CARTON_AGENT), which would name one (review #5: under Codex the case ran as `codex@…`).
 */
const asTerminal = () => Object.fromEntries(Object.keys(pc.env).filter((k) => /^(CLAUDECODE|CLAUDE_CODE_ENTRYPOINT|CODEX_.*|GEMINI_CLI|CURSOR_TRACE_ID|CARTON_AGENT)$/.test(k)).map((k) => [k, undefined]));
/** TRIES applies, each read back at once: the ones whose read missed the agent's own write. */
function missesOf(actor, what) {
  const misses = [], results = [];
  for (let i = 0; i < TRIES; i++) {
    const x = applyAndRead(actor, what);
    results.push(x.result);
    if (!x.shown) misses.push(x.n);
  }
  return { misses, results };
}

test("app open, the file frozen for an agent's turn: the agent's own write shows at once, the person's GUI edit stays held", t, async () => {
  await pc.startWorker();
  [{ id }] = await pc.call("projects.list");
  const actor = "director/chatR/turnR1";
  // the turn's Read of timeline.tsx (the Director's file hook) freezes the shared file
  const bundlePath = path.join(pc.root, "Demo.cardboard");
  // (the project's View starts once the worker opens its history: the first read opens it)
  await S.projectOf(pc, id);
  await S.until(async () => (await pc.call("carton.agentHook", { bundlePath, actor, event: "pre-tool-use", input: { hook_event_name: "PreToolUse", tool_name: "Read", tool_input: { file_path: tsxFile } } })).delivered, 20_000, "the turn's Read reaching the worker's Materializer");
  await S.guiSave(pc, id, (it) => (it.type === "text" ? { ...it, textContent: "GUI held" } : null));
  assert.equal(S.textOf(await S.projectOf(pc, id)).textContent, "GUI held", "the person's edit is head");
  const { misses, results } = missesOf(actor, "apply in a turn");
  assert.deepEqual(misses, [], `timeline.tsx missed the agent's own write on ${misses.length} of ${TRIES} immediate reads during its turn`);
  for (const r of results) assert.equal(r.carton?.timeline, "shown", JSON.stringify(r.carton));
  assert.ok(!tsxNow().includes("GUI held"), "the person's edit is held back during the turn");
  await pc.call("carton.agentHook", { bundlePath, actor, event: "endTurn" });
  await S.until(() => tsxNow().includes("GUI held"), 20_000, "timeline.tsx at head once the turn ended");
});

// The app's own Claude Code (its Bash hook names it claude-code/<session>): a hooked agent, as on the laptop.
test("app open, local cut: timeline.tsx shows the agent's cb source apply as soon as cb returns", t, async () => {
  const { misses, results } = missesOf(AGENT, "apply");
  assert.deepEqual(misses, [], `timeline.tsx missed the agent's own write on ${misses.length} of ${TRIES} immediate reads`);
  for (const r of results) assert.equal(r.carton?.timeline, "shown", "the result says timeline.tsx shows it: " + JSON.stringify(r.carton));
});

test("app open, local cut: a Carton command (cb undo) by the agent shows at once too", t, async () => {
  const before = applyAndRead(AGENT, "apply before undo");
  assert.ok(before.shown, "the apply shows");
  const r = pc.cb(["undo", "Demo"], { CARDBOARD_ACTOR: AGENT });
  const read = tsxNow();
  assert.equal(r.code, 0, r.out + r.err);
  assert.ok(!read.includes(`fontSize={${before.n}}`), "timeline.tsx shows the undo as soon as cb returns: " + (read.match(/fontSize=\{\d+\}/) ?? [])[0]);
  assert.equal(r.json().timeline, "shown", JSON.stringify(r.json()));
});

// A terminal's cb (no agent named): its call holds the file for a while as a windowless agent's does; its own write
// shows in it.
test("app open, local cut: a terminal's cb source apply shows at once too", t, async () => {
  const { misses, results } = missesOf("", "apply from a terminal");
  const by = pc.cb(["history", "Demo", "--limit", "1"], asTerminal()).json().versions[0]?.by;
  assert.match(String(by?.id), /^terminal:/, "the case runs as a terminal's cb, not an agent's: " + JSON.stringify(by));
  assert.deepEqual(misses, [], `timeline.tsx missed the terminal's own write on ${misses.length} of ${TRIES} immediate reads`);
  for (const r of results) assert.equal(r.carton?.timeline, "shown", JSON.stringify(r.carton));
  await pc.call("carton.agentHook", { bundlePath: path.join(pc.root, "Demo.cardboard"), actor: AGENT, event: "stop" });
});

test("app closed, local cut: timeline.tsx shows the agent's write as soon as cb returns", t, async () => {
  await pc.stopWorker();
  const { misses, results } = missesOf(AGENT, "apply, app closed");
  assert.deepEqual(misses, [], `timeline.tsx missed the agent's own write on ${misses.length} of ${TRIES} immediate reads`);
  for (const r of results) assert.ok(r.carton?.timeline === undefined || r.carton.timeline === "shown", JSON.stringify(r.carton));
});

test("app open, shared cut: timeline.tsx shows the agent's write as soon as cb returns", t, async () => {
  host = await S.startHost(path.join(S.TMP, "ryw-host"));
  await pc.startWorker();
  await pc.call("projects.list");
  const r = await pc.call("carton.liveShare", { projectId: id, host: host.origin, adminToken: S.ADMIN, name: "Alice" });
  assert.equal(r.status, "shared", JSON.stringify(r));
  await S.until(async () => { const s = await pc.call("carton.liveStatus", { projectId: id }); return s.status === "up-to-date" && s.holder && s; }, 20_000, "shared, up to date, the worker holding the lease");
  const { misses, results } = missesOf(AGENT, "apply, shared");
  assert.deepEqual(misses, [], `timeline.tsx missed the agent's own write on ${misses.length} of ${TRIES} immediate reads`);
  for (const x of results) assert.equal(x.carton?.timeline, "shown", JSON.stringify(x.carton));
});

test("app closed, shared cut (a headless helper holds the sync): timeline.tsx shows the agent's write as soon as cb returns", t, async () => {
  await pc.stopWorker();
  const { misses, results } = missesOf(AGENT, "apply, shared, app closed");
  assert.deepEqual(misses, [], `timeline.tsx missed the agent's own write on ${misses.length} of ${TRIES} immediate reads`);
  for (const r of results) assert.ok(r.carton?.timeline === undefined || r.carton.timeline === "shown", JSON.stringify(r.carton));
});
