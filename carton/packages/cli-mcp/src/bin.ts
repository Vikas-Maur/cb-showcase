#!/usr/bin/env node
// `carton`: the Carton commands outside Cardboard (tests, other hosts, and agents on a machine without the app).
//   carton [--project <dir>] [--data-dir <dir>] <command> [args] [--json] [--as <agent>]
//   carton hook pre-tool-use                     Claude Code PreToolUse hook (stdin → stdout)
//   carton hook stop [--project <dir>]           Claude Code Stop/SubagentStop hook
//   carton hook-settings [--project <dir>]       prints the `--settings` JSON for host Claude Code
//   carton mcp [--project <dir>]                 MCP server on stdio (the tools of mcp.ts)
// The project is --project, else CARDBOARD_PROJECT, else the nearest folder up from here with a project.json.
//
// Imports are loaded per subcommand: `hook pre-tool-use` runs before every Bash call of a host Claude Code session, so
// it loads only the prefixer (no engine, no SQLite).
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import type { HookInput, LocalCarton } from "@carton/local";
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
const projectDir = () => {
  const p = projectArg ?? process.env.CARDBOARD_PROJECT ?? findProject(process.cwd());
  if (!p) throw new Error("no project: pass --project <dir>, or run inside a project folder");
  return resolve(p);
};
const open = async (): Promise<LocalCarton> => (await import("@carton/local")).openLocal({ projectDir: projectDir(), dataDir });

async function main(): Promise<number> {
  if (argv[0] === "hook" && argv[1] === "pre-tool-use") {
    let out: object = {};
    try {
      const { prefixCommand, preToolUseOutput } = await import("@carton/local/hooks");
      const input = JSON.parse((await readStdin()) || "{}") as HookInput;
      const m = /^director\/([^/]+)\/([^/]+)/.exec(process.env.CARDBOARD_ACTOR ?? "");
      out = preToolUseOutput(input, prefixCommand(input, m ? { chat: m[1], turn: m[2] } : null));
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
      out = await runHook(event, input, {
        openStore: async () => {
          const dir = projectArg ?? process.env.CARDBOARD_PROJECT ?? (input.cwd ? findProject(input.cwd) : null);
          if (!dir) return null;
          return (await openProjectStore({ bundleDir: dir, projectId: readProjectId(dir), appDataDir: dataDir, skipLinkProbe: true })).store;
        },
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
