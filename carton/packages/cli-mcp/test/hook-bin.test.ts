// `carton hook pre-tool-use --project <dir>` as host Claude Code runs it (H8), a process per tool call: an Edit of the
// shared timeline.tsx reaches the app's materializer (cardboard-adapter's real Materializer on the engine thread), so
// the agent's save of it is credited to the agent, not to `external:timeline.tsx`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Rec } from "@carton/core";
import { EngineThread, openLocal } from "@carton/local";
import { adapter, bundle, doc0 } from "./support/real.ts";

const BIN = fileURLToPath(new URL("../src/bin.ts", import.meta.url));
const here = (f: string) => fileURLToPath(new URL(f, import.meta.url));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(f: () => unknown, ms: number, what: string) {
  for (const end = Date.now() + ms; !(await f()); await sleep(25)) if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
}
/** The bin as a hook process: input on stdin, its JSON answer. */
function hook(args: string[], input: object): Promise<{ code: number | null; out: string }> {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [BIN, "hook", ...args], { stdio: ["pipe", "pipe", "inherit"], env: { ...process.env, CARDBOARD_ACTOR: "", CARDBOARD_PROJECT: "" } });
    let out = "";
    p.stdout.on("data", (d) => (out += d));
    p.on("exit", (code) => resolve({ code, out }));
    p.stdin.end(JSON.stringify(input));
  });
}

test("carton hook pre-tool-use --project: an Edit of timeline.tsx is told to the app's materializer; the agent's save is credited to it", { timeout: 60_000 }, async (t) => {
  const { dir, projectId } = bundle("hook-bin");
  const init = await openLocal({ projectDir: dir, projectId, adapter, init: { doc: doc0() }, actor: { kind: "human", id: "human:me" } });
  const dbPath = init.dbPath;
  await init.close();
  const th = await EngineThread.start({ dbPath, factory: here("./support/mz-factory.ts"), config: { projectDir: dir } });
  const other = await openLocal({ projectDir: dir, projectId, adapter, actor: { kind: "human", id: "human:me" } });
  t.after(async () => { await other.close(); await th.stop(); });
  await until(() => existsSync(join(dir, "timeline.tsx")), 10_000, "the app's first print");

  const r = await hook(["pre-tool-use", "--project", dir], { hook_event_name: "PreToolUse", session_id: "0011223344", tool_name: "Edit", tool_input: { file_path: join(dir, "timeline.tsx") } });
  assert.equal(r.code, 0);
  assert.deepEqual(JSON.parse(r.out), {}, "nothing for Claude Code to do: the event went to the app");

  // the agent's edit of the shared file, saved
  const file = join(dir, "timeline.tsx");
  const text = readFileSync(file, "utf8");
  const at = text.indexOf("\n{") + 1;
  const body = JSON.parse(text.slice(at));
  body.timelineItems.find((i: Rec) => i.id === "c2").name = "the agent's edit";
  writeFileSync(file, text.slice(0, at) + JSON.stringify(body, null, 1) + "\n");
  await until(async () => ((await other.carton.head()).doc.timelineItems as Rec[]).find((i) => i.id === "c2")!.name === "the agent's edit", 10_000, "the save to land");
  assert.equal((await other.carton.log({ limit: 1 }))[0]?.author?.id, "claude-code/00112233", "credited to the agent the hook named");

  // the Stop hook with the app running: allowed, answered {} (the stop is told; the freeze is local's tests')
  const stop = await hook(["stop", "--project", dir], { hook_event_name: "Stop", session_id: "0011223344" });
  assert.equal(stop.code, 0);
  assert.deepEqual(JSON.parse(stop.out), {});
});

test("carton hook pre-tool-use --project: a Write/Edit/MultiEdit of the project's project.json is denied (§6.4)", async () => {
  const { dir } = bundle("hook-bin-deny");
  for (const tool of ["Write", "Edit", "MultiEdit"]) {
    const r = await hook(["pre-tool-use", "--project", dir], { hook_event_name: "PreToolUse", session_id: "0011223344", tool_name: tool, tool_input: { file_path: join(dir, "project.json") } });
    assert.equal(r.code, 0);
    const h = JSON.parse(r.out).hookSpecificOutput;
    assert.deepEqual([h?.permissionDecision, h?.hookEventName], ["deny", "PreToolUse"], `${tool}: ${r.out}`);
    assert.match(h.permissionDecisionReason, /cb source print --view/);
  }
  const read = await hook(["pre-tool-use", "--project", dir], { hook_event_name: "PreToolUse", session_id: "0011223344", tool_name: "Read", tool_input: { file_path: join(dir, "project.json") } });
  assert.deepEqual(JSON.parse(read.out), {}, "reading it is fine");
  assert.equal(existsSync(join(dir, ".carton")), false, "a project without Carton: nothing made");
});
