// The kit's quickstart (kit/README.md), run as a reader runs it: each step a separate process, in a scratch folder.
//   cd carton && node --test kit/test/quickstart.test.ts
// Scratch: $CARTON_SCRATCH, else ~/gfv-scratch/carton/kit-docs/test. The host binds 127.0.0.1 on a free port.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { defaultAppDataDir, projectKey } from "@carton/store-sqlite";

const carton = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const qs = (f: string) => join(carton, "kit", "quickstart", f);
const bin = join(carton, "packages", "cli-mcp", "src", "bin.ts");
// as a person at a terminal: no agent variables from whoever runs the test
const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(CLAUDECODE|CLAUDE_CODE_|CODEX_|GEMINI_CLI|CURSOR_TRACE_ID|CARDBOARD_ACTOR|CARTON_AGENT)/.test(k)));

function run(file: string, args: string[], extra: Record<string, string> = {}): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    execFile(process.execPath, [file, ...args], { cwd: carton, env: { ...env, ...extra }, timeout: 60_000 }, (e, stdout, stderr) => {
      resolve({ code: e ? (typeof e.code === "number" ? e.code : 1) : 0, out: (stdout + stderr).trim() });
    });
  });
}
const cb = (bundle: string, ...args: string[]) => run(bin, ["--project", bundle, ...args]);

function scratch(): string {
  const root = process.env.CARTON_SCRATCH ?? join(homedir(), "gfv-scratch", "carton", "kit-docs", "test");
  mkdirSync(root, { recursive: true });
  return mkdtempSync(join(root, "qs-"));
}
function freshBundle(dir: string): string {
  cpSync(qs("Demo.cardboard"), join(dir, "Demo.cardboard"), { recursive: true });
  return join(dir, "Demo.cardboard");
}
const freePort = () => new Promise<number>((resolve) => {
  const s = createServer().listen(0, "127.0.0.1", () => {
    const { port } = s.address() as { port: number };
    s.close(() => resolve(port));
  });
});

test("quickstart 1: import, agents' edits, history and credits, a cut, a fold with a card, undo a turn", async () => {
  const P = freshBundle(scratch());
  assert.match((await run(qs("import.ts"), [P])).out, /^Imported as main@1/);
  assert.match((await run(qs("import.ts"), [P])).out, /^Already has a history/);
  assert.match((await run(qs("edit.ts"), [P, "Intro", "endTime=2.5", "trimEnd=2.5"], { CARDBOARD_ACTOR: "director/chat1/turn1" })).out, /^director\/chat1\/turn1: Saved: confirmed \w{8}@2$/);
  assert.match((await run(qs("edit.ts"), [P, "Outro", "color=#ffcc00"], { CARDBOARD_ACTOR: "director/chat1/turn1/sub-general-purpose-a1b2" })).out, /: Saved: confirmed \w{8}@3$/);

  const h = await cb(P, "history");
  assert.equal(h.code, 0, h.out);
  assert.match(h.out, /^VERSION\s+SAVED\s+BY\s+WHAT\nmain@3\s+just now\s+Director › general-purpose \(turn turn1\)\s+edit\nmain@2\s+just now\s+Director \(turn turn1\)\s+edit\nmain@1\s+just now\s+Import\s+import/);
  assert.equal((await cb(P, "credits", "Outro")).out, "outro: last changed by Director › general-purpose (turn turn1) (subagent general-purpose a1b2, chat chat1)");

  assert.match((await cb(P, "cut", "new", "30s cut")).out, /^New cut "30s cut" \(\w{8}\)$/);
  assert.equal((await cb(P, "cut", "switch", "30s cut")).out, `Now on "30s cut"`);
  assert.match((await run(qs("edit.ts"), [P, "Middle", "startTime=2.5", "endTime=5", "trimEnd=2.5", "--as", "codex/tighten"])).out, /^codex\/tighten: Saved: confirmed \w{8}@1$/);
  assert.equal((await cb(P, "cut", "switch", "main")).out, `Now on "Main cut"`);
  assert.match((await run(qs("edit.ts"), [P, "Middle", "endTime=7", "trimEnd=4"])).out, /: Saved: confirmed \w{8}@4$/);
  // an agent that read main@1 edits the intro: --base names that version; its edit lands on top of the others
  assert.match((await run(qs("edit.ts"), [P, "Intro", "textContent=Hello", "--base", "main@1", "--as", "codex/late"])).out, /^codex\/late: Saved: confirmed \w{8}@5$/);

  const chk = await cb(P, "fold", "30s cut", "--check");
  assert.match(chk.out, /^Would fold in with 1 card:\n  #1 timelineItems\/middle\/#time \(group[^)]*\) — Main cut: \{"startTime":3,"endTime":7,"trimStart":0,"trimEnd":4\} · 30s cut: \{"startTime":2.5,"endTime":5,"trimStart":0,"trimEnd":2.5\}\n/);
  const f = await cb(P, "fold", "30s cut");
  assert.equal(f.code, 1);
  assert.match(f.out, /^Not folded in: 1 card, nothing was saved\./);
  const k = await cb(P, "fold", "30s cut", "--keep", "theirs");
  assert.match(k.out, /^Folded in: confirmed \w{8}@6$/);
  assert.equal((await cb(P, "compare", "main@5")).out, "- Retimed 'Middle' 3.0 s–7.0 s → 2.5 s–5.0 s");

  assert.match((await cb(P, "undo", "--turn", "turn1")).out, /^Undid turn turn1: confirmed \w{8}@7$/);
  assert.equal((await cb(P, "compare", "main@6", "main@7")).out, `- Trimmed 'Intro' end 2.5 s → 3.0 s\n- Changed 'Outro' color "#ffcc00" → "#f3eee6"`);
  const j = JSON.parse((await cb(P, "history", "--json", "--limit", "1")).out);
  assert.equal(j.versions[0].name, "Undo turn turn1");
});

test("quickstart 2: .cbproj round trip, a teammate's changes brought back in with a card", async () => {
  const T = scratch();
  mkdirSync(join(T, "alice"));
  const A = freshBundle(join(T, "alice"));
  const B = join(T, "bob", "Demo.cardboard");
  await run(qs("import.ts"), [A]);
  await run(qs("edit.ts"), [A, "Intro", "endTime=2.5", "trimEnd=2.5", "--as", "alice"]);
  assert.match((await run(qs("cbproj.ts"), ["export", A, join(T, "demo.cbproj")])).out, /: 2 entries \(\.carton-export\/shallow\.json\)$/);
  // opening into a folder that already holds something is refused, and the folder is left as it was
  mkdirSync(join(T, "busy"));
  writeFileSync(join(T, "busy", "project.json"), "someone else's project");
  const refused = await run(qs("cbproj.ts"), ["open", join(T, "demo.cbproj"), join(T, "busy")]);
  assert.notEqual(refused.code, 0);
  assert.match(refused.out, /already exists and isn't empty: pick a new folder/);
  assert.equal(readFileSync(join(T, "busy", "project.json"), "utf8"), "someone else's project");
  // a project whose history this machine already keeps in app data is refused before anything is written or moved.
  // The child gets an app-data folder of its own, by the variable its platform reads (defaultAppDataDir).
  const home = join(T, "home");
  const appEnv: Record<string, string> = process.platform === "win32" ? { LOCALAPPDATA: join(T, "localappdata") } : process.platform === "darwin" ? { HOME: home } : { XDG_DATA_HOME: join(T, "xdg") };
  const appData = defaultAppDataDir({ platform: process.platform, env: { ...process.env, ...appEnv }, home: appEnv.HOME ?? homedir() });
  const knownDb = join(appData, "projects", projectKey("demo-project"), "carton.db");
  mkdirSync(dirname(knownDb), { recursive: true });
  writeFileSync(knownDb, "their history");
  const known = await run(qs("cbproj.ts"), ["open", join(T, "demo.cbproj"), join(T, "known", "Demo.cardboard")], appEnv);
  assert.match(known.out, /you already have project demo-project on this machine: use bring-in/);
  assert.ok(!existsSync(join(T, "known")), "nothing was unpacked");
  assert.equal(readFileSync(knownDb, "utf8"), "their history");
  assert.equal((await run(qs("cbproj.ts"), ["open", join(T, "demo.cbproj"), B])).out, `Opened demo-project with their history; you are on "Main cut"`);
  assert.ok(!existsSync(join(B, ".carton", "displaced")));
  assert.match((await cb(B, "cut", "list")).out, /Main cut\s+main\s+-\s+read-only[\s\S]*\*\s+Main cut\s+main\s+@0\s+local/);
  await run(qs("edit.ts"), [B, "Outro", "color=#ff0000", "--as", "bob"]);
  await run(qs("edit.ts"), [B, "Middle", "endTime=5", "trimEnd=2", "--as", "bob"]);
  await run(qs("edit.ts"), [A, "Middle", "endTime=7", "trimEnd=4", "--as", "alice"]);
  await run(qs("cbproj.ts"), ["export", B, join(T, "bob.cbproj")]);
  assert.equal((await run(qs("cbproj.ts"), ["bring-in", A, join(T, "bob.cbproj"), "--check"])).out, "Would bring in their changes: conflicts, 1 card(s): timelineItems/middle/#time");
  assert.equal((await run(qs("cbproj.ts"), ["bring-in", A, join(T, "bob.cbproj")])).out, "Brought in their changes: conflicts, 1 card(s): timelineItems/middle/#time");
  assert.equal((await run(qs("cbproj.ts"), ["bring-in", A, join(T, "bob.cbproj"), "--keep", "mine"])).out, "Brought in their changes: confirmed");
  assert.equal((await cb(A, "compare", "main@3")).out, `- Changed 'Outro' color "#f3eee6" → "#ff0000"`);
});

test("quickstart 3: a Node host on localhost, two people live on one shared cut, offline and back", async () => {
  const T = scratch();
  const P = freshBundle(T);
  await run(qs("import.ts"), [P]);
  const port = await freePort();
  const host = spawn(process.execPath, [qs("host.ts"), join(T, "host"), String(port)], { cwd: carton, env, stdio: ["ignore", "pipe", "pipe"] });
  try {
    let log = "";
    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`host did not start: ${log}`)), 30_000);
      const seen = (b: Buffer) => { log += b; if (log.includes("Carton host on")) { clearTimeout(t); resolve(); } };
      host.stdout.on("data", seen);
      host.stderr.on("data", seen);
      host.on("exit", (code) => reject(new Error(`host exited (${code}): ${log}`)));
    });
    assert.match(log, new RegExp(`^Carton host on http://127\\.0\\.0\\.1:${port} `));
    const r = await run(qs("live.ts"), [P, join(T, "host"), `http://127.0.0.1:${port}`]);
    assert.equal(r.code, 0, r.out);
    assert.equal(r.out, [
      `Alice shared "Main cut": Up to date`,
      "Bob joined: Up to date",
      "Alice's edit: confirmed, Bob's edit: confirmed",
      `Alice sees Bob's outro: "Bye"; Bob sees Alice's intro: "Hello"`,
      "Bob offline: pending (Offline: 1 edit waiting)",
      "Bob back online: Up to date; Alice sees his edit",
    ].join("\n") + "\n" + r.out.split("\n").at(-1));
    assert.match(r.out.split("\n").at(-1)!, /^History on Alice's side: @4 Bob, @3 (Alice|Bob), @2 (Alice|Bob)$/);
  } finally {
    host.kill("SIGTERM");
  }
});
