// What host Claude Code's file-tool hooks cost per tool call (H8: `cb carton-hook pre-tool-use` on Read/Write/Edit),
// measured in real Claude Code against a stand-in for the Messages API (mock-claude.js: no model, nothing leaves the
// machine), on a real library with Carton on and Cardboard's library worker running, cb being this build's.
// Each round runs one `claude -p` per setting, the model asking for the same tool calls, in turn:
//   none: the Bash hook only (before H8);
//   all:  plus the file-tool matcher, every call starting cb;
//   if:   plus the file-tool hooks behind `if` conditions (timeline.tsx, project.json): other files start nothing.
// A tool call's time is from the request that asked for it to the next request (the tool, its hooks, Claude Code's own
// work). Reads of a file that isn't timeline.tsx (what agents mostly do) are timed; a Read of timeline.tsx and an Edit of
// project.json check that the hooks still run where they matter. Prints every call as a JSON line, then medians.
// Numbers from here are UNVERIFIED until a separate check confirms them (AGENTS.md rule 6). Run it alone (slot.sh):
//   CARDBOARD_PRISTINE=<Cardboard 1.4.0 unpacked> CARTON_TEST_DIR=<scratch> \
//     node scripts/carton/test/sync/hook-bench.js --claude <claude binary> [--rounds 5] [--reads 15]
const fs = require("fs"), path = require("path"), { spawn } = require("child_process");
const S = require("./support.js");
const mock = require("./mock-claude.js");

const arg = (name, d) => { const i = process.argv.indexOf("--" + name); return i > 0 ? process.argv[i + 1] : d; };
const CLAUDE = arg("claude", process.env.CARTON_TEST_CLAUDE), ROUNDS = Number(arg("rounds", 5)), READS = Number(arg("reads", 15));
const SETTINGS = String(arg("settings", "none,all,if")).split(",");
const median = (a) => { const s = [...a].sort((x, y) => x - y); return s.length ? (s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2) : NaN; };
if (!CLAUDE) throw new Error("--claude <path to Claude Code> (or CARTON_TEST_CLAUDE)");

/** --settings for each setting; `if` is the app's own (main-bridge.js hostSettings). */
function settingsFor(kind, hostSettings) {
  const hook = (event) => [{ type: "command", command: "cb carton-hook " + event }];
  const base = { PreToolUse: [{ matcher: "Bash", hooks: hook("pre-tool-use") }], Stop: [{ hooks: hook("stop") }] };
  if (kind === "none") return { hooks: base };
  if (kind === "all") return { hooks: { ...base, PreToolUse: [...base.PreToolUse, { matcher: "Read|Write|Edit|MultiEdit", hooks: hook("pre-tool-use") }] } };
  if (kind === "if") return JSON.parse(hostSettings[1]);
  throw new Error("setting " + kind);
}

async function run(pc, bin, kind, settings, plan) {
  const m = await mock.start(plan);
  const bundle = path.join(pc.root, "Demo.cardboard");
  const cfg = path.join(pc.home, "claude-config");
  fs.mkdirSync(cfg, { recursive: true });
  const dead = "http://127.0.0.1:9";
  // nothing of this process's own Claude Code or API settings: only the stand-in's
  const inherited = Object.fromEntries(Object.entries(pc.env).filter(([k]) => !/^(ANTHROPIC_|CLAUDE)/.test(k)));
  const env = {
    ...inherited, PATH: bin + path.delimiter + process.env.PATH, CLAUDE_CONFIG_DIR: cfg, CARDBOARD_ACTOR: "claude/bench",
    ANTHROPIC_BASE_URL: `http://127.0.0.1:${m.port}`, ANTHROPIC_API_KEY: "sk-mock", CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    DISABLE_AUTOUPDATER: "1", DISABLE_TELEMETRY: "1", NODE_USE_ENV_PROXY: "1", HTTPS_PROXY: dead, HTTP_PROXY: dead, NO_PROXY: "127.0.0.1,localhost",
  };
  const p = spawn(CLAUDE, ["-p", "go", "--model", "claude-sonnet-5-5", "--settings", JSON.stringify(settings), "--permission-mode", "bypassPermissions", "--output-format", "json"], { cwd: bundle, env, stdio: ["ignore", "pipe", "pipe"] });
  let out = "", err = "";
  p.stdout.on("data", (c) => (out += c));
  p.stderr.on("data", (c) => (err += c));
  const code = await new Promise((ok) => p.on("exit", ok));
  await m.close();
  if (code !== 0) throw new Error(`claude -p (${kind}) exited ${code}: ${out.slice(-800)} ${err.slice(-800)}`);
  return m.log;
}

(async () => {
  const b = await S.build();
  const pc = await S.computer("hook-bench", b);
  const must = (x, what) => { if (x.code !== 0) throw new Error(what + ": " + x.out + x.err); };
  must(pc.cb(["project", "create", "Demo"]), "create");
  must(pc.cb(["media", "add", "Demo", b.clip]), "media add");
  const bundle = path.join(pc.root, "Demo.cardboard");
  fs.writeFileSync(path.join(bundle, "notes.md"), "# notes\n" + "a line of notes\n".repeat(40));
  const bin = path.join(pc.home, "bin");
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(path.join(bin, "cb"), `#!/bin/sh\nexec "${process.execPath}" "${path.join(b.cli, "cardboard.mjs")}" --root "${pc.root}" "$@"\n`, { mode: 0o755 });
  // the app's own --settings, as main passes them to host Claude Code with Carton on (main-bridge.js hostSettings)
  const saved = { ...process.env };
  process.env.CARDBOARD_CARTON = "1";
  let hostSettings;
  try { hostSettings = new Function("require", require("../../main-bridge.js") + "return __cartonMain;")(require).hostSettings(); } finally { process.env = saved; }
  const rows = [];
  await pc.startWorker();
  try {
    // An Edit of project.json that the hook refuses (Claude Code checks an Edit's strings before its hooks run: they
    // must differ, and the old one be in the file once). Without the file hooks nothing refuses it, so it isn't asked.
    const planFor = (kind) => [
      ...Array.from({ length: READS }, () => ({ tool: "Read", input: { file_path: path.join(bundle, "notes.md") } })),
      { tool: "Read", input: { file_path: path.join(bundle, "timeline.tsx") } },
      ...(kind === "none" ? [] : [{ tool: "Edit", input: { file_path: path.join(bundle, "project.json"), old_string: "cardboard-project", new_string: "cardboard-projectX" } }]),
    ];
    for (let r = 0; r < ROUNDS; r++) {
      const order = r % 2 ? [...SETTINGS].reverse() : SETTINGS;
      for (const kind of order) {
        const plan = planFor(kind);
        const log = await run(pc, bin, kind, settingsFor(kind, hostSettings), plan);
        // log[i] is the request after tool call i-1 (log[0]: the prompt)
        // the box's load with each run (it is shared): numbers from a busy box read differently
        const load = +require("os").loadavg()[0].toFixed(2);
        for (let i = 1; i < log.length; i++) {
          const call = plan[i - 1];
          if (!call) continue;
          // the stand-in's i-th request answers plan step i-1: a retried request would shift every row without a word
          if (log[i].step !== i) throw new Error(`the stand-in's request ${i} was for step ${log[i].step}: a retried request; this run's rows can't be trusted`);
          const row = { kind, round: r, i: i - 1, tool: call.tool, file: path.basename(call.input.file_path), ms: +(log[i].at - log[i - 1].at).toFixed(2), denied: /project\.json is Cardboard's project file/.test(log[i].toolResult), load };
          rows.push(row);
          console.log(JSON.stringify(row));
        }
      }
    }
  } finally {
    await pc.stopWorker();
    S.killHelpers();
  }
  console.log("--- medians, Reads of notes.md (first 2 calls of each run left out: warm-up)");
  for (const kind of SETTINGS) {
    const ms = rows.filter((x) => x.kind === kind && x.file === "notes.md" && x.i >= 2).map((x) => x.ms);
    console.log(kind.padEnd(5), "median", median(ms).toFixed(1), "ms over", ms.length, "calls; per round:", [...new Set(rows.map((x) => x.round))].map((r) => median(rows.filter((x) => x.kind === kind && x.round === r && x.file === "notes.md" && x.i >= 2).map((x) => x.ms)).toFixed(1)).join(" "));
  }
  for (const kind of SETTINGS) {
    const d = rows.filter((x) => x.kind === kind && x.file === "project.json");
    console.log(kind.padEnd(5), "Edit of project.json denied:", d.map((x) => x.denied).join(" "));
  }
})().catch((e) => { console.error(e); process.exit(1); });
