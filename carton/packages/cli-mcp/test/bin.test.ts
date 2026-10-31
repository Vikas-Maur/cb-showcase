// The `carton` bin as real processes: the Claude Code hooks for host Claude Code (`--settings`), including the Stop
// hook blocking once per conflict set across separate hook processes (R2-02), and the MCP stdio handshake.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { openProjectStore } from "@carton/store-sqlite";
import { actorKey, parseActorId, humanCards } from "@carton/local";

const BIN = fileURLToPath(new URL("../src/bin.ts", import.meta.url));
const scratch = () => { const d = join(process.env.CARTON_SCRATCH ?? join(homedir(), "gfv-scratch", "carton", "local-cli", "test")); mkdirSync(d, { recursive: true }); return d; };
const run = (args: string[], input: string, env: Record<string, string> = {}) => spawnSync(process.execPath, [BIN, ...args], { input, encoding: "utf8", env: { ...process.env, CARDBOARD_ACTOR: "", ...env } });

function bundle(): string {
  const dir = mkdtempSync(join(scratch(), "bin-"));
  writeFileSync(join(dir, "project.json"), JSON.stringify({ id: `proj-${Date.now()}`, name: "Demo" }));
  return dir;
}

test("carton hook pre-tool-use: a Bash call that runs cb gets the actor exported; others pass", () => {
  const r = run(["hook", "pre-tool-use"], JSON.stringify({ hook_event_name: "PreToolUse", session_id: "0011223344", tool_name: "Bash", tool_input: { command: "cb source apply Demo" }, agent_id: "z9", agent_type: "editor" }));
  assert.equal(r.status, 0);
  const out = JSON.parse(r.stdout);
  assert.equal(out.hookSpecificOutput.permissionDecision, "allow");
  assert.equal(out.hookSpecificOutput.updatedInput.command, "export CARDBOARD_ACTOR='claude-code/00112233/sub-editor-z9'; cb source apply Demo");
  assert.deepEqual(JSON.parse(run(["hook", "pre-tool-use"], JSON.stringify({ tool_input: { command: "ls" } })).stdout), {});
  assert.deepEqual(JSON.parse(run(["hook", "pre-tool-use"], "not json").stdout), {}, "a hook never breaks the turn");
});

test("R2-02 Stop hook as separate processes: blocks once with the conflict text, then lets the agent stop; the rest becomes a card for the person", async () => {
  const dir = bundle();
  const { store } = await openProjectStore({ bundleDir: dir, projectId: JSON.parse(require_("fs").readFileSync(join(dir, "project.json"), "utf8")).id, skipLinkProbe: true });
  const actor = parseActorId("director/c2/t1")!;
  await store.write([{ table: "notices", key: [actorKey(actor), 1, 0], value: { to: actorKey(actor), kind: "late-conflict", change: "rid.7", text: "Your change rid.7 conflicted after your turn: timelineItems/c5/#time", cards: [{ kind: "group", path: "timelineItems/c5/#time", base: 1, ours: 2, theirs: 3 }] } }]);
  await store.close();
  const env = { CARDBOARD_ACTOR: "director/c2/t1" };
  const stop = (active: boolean) => JSON.parse(run(["hook", "stop", "--project", dir], JSON.stringify({ hook_event_name: "Stop", session_id: "s", stop_hook_active: active }), env).stdout);
  const s1 = stop(false);
  assert.equal(s1.decision, "block");
  assert.match(s1.reason, /rid\.7/);
  const s2 = stop(true);
  assert.deepEqual(s2, {}, "stop_hook_active: the agent couldn't resolve it; it may stop");
  const s3 = stop(false);
  assert.deepEqual(s3, {}, "never blocks twice for the same set");
  const again = await openProjectStore({ bundleDir: dir, projectId: JSON.parse(require_("fs").readFileSync(join(dir, "project.json"), "utf8")).id, skipLinkProbe: true });
  const cards = await humanCards(again.store);
  await again.store.close();
  assert.equal(cards.length, 1);
  assert.equal(cards[0].change, "rid.7", "unresolved conflict handed to the human as a card");
});

test("carton mcp: initialize and tools/list over stdio", async () => {
  const p = spawn(process.execPath, [BIN, "mcp", "--project", bundle()], { stdio: ["pipe", "pipe", "inherit"] });
  const lines: any[] = [];
  let buf = "";
  p.stdout.setEncoding("utf8");
  p.stdout.on("data", (d) => { buf += d; let i; while ((i = buf.indexOf("\n")) >= 0) { lines.push(JSON.parse(buf.slice(0, i))); buf = buf.slice(i + 1); } });
  p.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } } }) + "\n");
  p.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
  p.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }) + "\n");
  p.stdin.end();
  await new Promise((r) => p.on("exit", r));
  assert.equal(lines.length, 2, "no reply to the notification");
  assert.equal(lines[0].result.serverInfo.name, "carton");
  assert.deepEqual(lines[1].result.tools.map((t: any) => t.name), ["timeline_history", "check_timeline", "undo_timeline", "timeline_cuts", "timeline_fold", "timeline_credits", "timeline_publish"]);
  assert.equal(lines[1].result.tools.find((t: any) => t.name === "timeline_credits").annotations.readOnlyHint, true);
});

import { createRequire } from "node:module";
const require_ = createRequire(import.meta.url);
