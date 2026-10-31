#!/usr/bin/env node
// `carton`: the Carton commands outside Cardboard (tests, other hosts, and agents on a machine without the app).
//   carton [--project <dir>] [--data-dir <dir>] [--server <url> --token-file <file>] <command> [args] [--json] [--as <agent>]
//     --server: the team's sync server for this call's helper (a shared cut, `share`); also CARTON_SYNC_URL. Its token
//     is read from --token-file (CARTON_TOKEN_FILE), never passed on a command line.
//   carton hook pre-tool-use [--project <dir>]   Claude Code PreToolUse hook (stdin → stdout); on Read/Write/Edit of
//                                                the project's timeline.tsx or project.json, tells the holder (H8)
//   carton hook stop [--project <dir>]           Claude Code Stop/SubagentStop hook; an allowed stop is told too
//   carton hook-settings [--project <dir>]       prints the `--settings` JSON for host Claude Code
//   carton mcp [--project <dir>]                 MCP server on stdio (the tools of mcp.ts)
// The project is --project, else CARDBOARD_PROJECT, else the nearest folder up from here with a project.json.
//
// Imports are loaded per subcommand: `hook pre-tool-use` runs before every Bash call of a host Claude Code session, so
// it loads only the prefixer (no engine, no SQLite); a hook event for the holder loads its sender only when there is
// one (carton.db read-only and the holder's socket, no engine).
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import type { HookInput, HookSend, LocalCarton } from "@carton/local";
import type { CbProject } from "./commands.ts";

function takeOpt(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(name);
  if (i < 0) return undefined;
  const v = argv[i + 1];
  argv.splice(i, 2);
  return v;
}

function findProject(start: string): string | null {
  for (let d = resolve(start); ; d = dirname(d)) {
    if (existsSync(join(d, "project.json"))) return d;
    if (dirname(d) === d) return null;
  }
}

async function readStdin(): Promise<string> {
  let s = "";
  for await (const chunk of process.stdin) s += chunk;
  return s;
}

const argv = process.argv.slice(2);
const projectArg = takeOpt(argv, "--project");
const dataDir = takeOpt(argv, "--data-dir");
/** A hook's project: --project, else CARDBOARD_PROJECT, else the nearest project folder up from the agent's cwd. */
const hookProject = (input: HookInput): string | null => {
  const d = projectArg ?? process.env.CARDBOARD_PROJECT ?? (typeof input.cwd === "string" ? findProject(input.cwd) : null);
  return d ? resolve(d) : null;
};
const projectDir = () => {
  const p = projectArg ?? process.env.CARDBOARD_PROJECT ?? findProject(process.cwd());
  if (!p) throw new Error("no project: pass --project <dir>, or run inside a project folder");
  return resolve(p);
};
const server = takeOpt(argv, "--server") ?? process.env.CARTON_SYNC_URL;
const tokenFile = takeOpt(argv, "--token-file") ?? process.env.CARTON_TOKEN_FILE;
const open = async (): Promise<LocalCarton> => {
  if (server && !tokenFile) throw new Error("--server needs --token-file <file> (or CARTON_TOKEN_FILE): the session token, read from a file");
  // the helper this call starts (a shared cut, `share`) syncs with that server, over the app's recorded factory if any
  const helperConfig = server ? { sync: { url: server, tokenFile: resolve(tokenFile!) } } : undefined;
  return (await import("@carton/local")).openLocal({ projectDir: projectDir(), dataDir, ...(helperConfig ? { helperConfig } : {}) });
};

async function main(): Promise<number> {
  if (argv[0] === "hook" && argv[1] === "pre-tool-use") {
    let out: object = {};
    try {
      const { prefixCommand, preToolUseOutput, hookEventFor } = await import("@carton/local/hooks");
      const input = JSON.parse((await readStdin()) || "{}") as HookInput;
      const m = /^director\/([^/]+)\/([^/]+)/.exec(process.env.CARDBOARD_ACTOR ?? "");
      const turn = m ? { chat: m[1], turn: m[2] } : null;
      out = preToolUseOutput(input, prefixCommand(input, turn));
      // a Read of the shared file, a Write/Edit of it or project.json: the holder's materializer hears of it (H8)
      const dir = hookProject(input);
      const e = dir ? hookEventFor("pre-tool-use", input, { projectDir: dir, turn }) : null;
      if (e && dir) await (await import("@carton/local/hook-send")).sendHookEvent({ projectDir: dir, dataDir, ...e });
    } catch { /* a hook never breaks the agent's turn */ }
    process.stdout.write(JSON.stringify(out) + "\n");
    return 0;
  }
  if (argv[0] === "hook") {
    const event = argv[1] === "stop" ? "stop" : null;
    if (!event) { process.stderr.write("usage: carton hook pre-tool-use|stop\n"); return 2; }
    let out: object = {};
    try {
      const { runHook, readProjectId } = await import("@carton/local");
      const { openProjectStore } = await import("@carton/store-sqlite");
      const input = JSON.parse((await readStdin()) || "{}") as HookInput;
      const dir = hookProject(input);
      out = await runHook(event, input, {
        openStore: async () => (dir ? (await openProjectStore({ bundleDir: dir, projectId: readProjectId(dir), appDataDir: dataDir, skipLinkProbe: true })).store : null),
        // an allowed stop ends the turn: the holder's materializer drops its freeze and pins (H8)
        ...(dir ? { send: async (e: HookSend) => (await import("@carton/local/hook-send")).sendHookEvent({ projectDir: dir, dataDir, ...e }) } : {}),
      });
    } catch { /* a hook never breaks the agent's turn */ }
    process.stdout.write(JSON.stringify(out) + "\n");
    return 0;
  }
  if (argv[0] === "hook-settings") {
    const { hookSettings, shQuote } = await import("@carton/local");
    const self = fileURLToPath(import.meta.url);
    process.stdout.write(JSON.stringify(hookSettings({ command: `${shQuote(process.execPath)} ${shQuote(self)}`, projectDir: projectDir() }), null, 2) + "\n");
    return 0;
  }
  if (argv[0] === "mcp") return serveMcp();
  const { runCb } = await import("./cb.ts");
  const { identify } = await import("@carton/local");
  let local: LocalCarton | null = null;
  try {
    return await runCb(argv, { cwd: process.cwd(), env: process.env, stdout: (t) => process.stdout.write(t), stderr: (t) => process.stderr.write(t) }, {
      open: async () => (local ??= await open()) as CbProject,
      actor: (declared) => identify({ declared }),
    });
  } finally {
    await (local as LocalCarton | null)?.close();
  }
}

/** MCP over stdio: newline-delimited JSON-RPC 2.0 (initialize, tools/list, tools/call, ping). */
async function serveMcp(): Promise<number> {
  const { mcpTools } = await import("./mcp.ts");
  const { identify } = await import("@carton/local");
  const tools = mcpTools();
  const actor = identify();
  let local: LocalCarton | null = null;
  const send = (m: object) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...m }) + "\n");
  for await (const line of createInterface({ input: process.stdin })) {
    if (!line.trim()) continue;
    let msg: any;
    try { msg = JSON.parse(line); } catch { send({ id: null, error: { code: -32700, message: "parse error" } }); continue; }
    const reply = (body: object) => (msg.id === undefined ? undefined : send({ id: msg.id, ...body }));
    try {
      switch (msg.method) {
        case "initialize":
          reply({ result: { protocolVersion: msg.params?.protocolVersion ?? "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "carton", version: "0.1.0" } } });
          break;
        case "ping": reply({ result: {} }); break;
        case "tools/list":
          reply({ result: { tools: tools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema, annotations: { readOnlyHint: t.readOnly } })) } });
          break;
        case "tools/call": {
          const t = tools.find((x) => x.name === msg.params?.name);
          if (!t) { reply({ error: { code: -32602, message: `unknown tool ${msg.params?.name}` } }); break; }
          local ??= await open();
          const r = await t.call({ project: local as CbProject, actor }, msg.params?.arguments ?? {});
          reply({ result: { content: [{ type: "text", text: r.text }], structuredContent: r.result, isError: r.isError } });
          break;
        }
        default:
          if (msg.id !== undefined && !String(msg.method).startsWith("notifications/")) reply({ error: { code: -32601, message: `unknown method ${msg.method}` } });
      }
    } catch (e: any) {
      reply({ result: { content: [{ type: "text", text: `Error: ${e?.message ?? e}` }], isError: true } });
    }
  }
  await (local as LocalCarton | null)?.close();
  return 0;
}

main().then((code) => { process.exitCode = code; }, (e) => { process.stderr.write(`Error: ${e?.message ?? e}\n`); process.exitCode = 1; });
