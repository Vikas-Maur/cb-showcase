// One agent (a Director subagent, or any `cb` caller) editing through its own per-agent view, the documented flow
// (§6.4, R4-02, R5-04):
//   1. `cb source print --view`: the write op `printView`, handed to the lease holder (the app's engine thread),
//      which prints `.scratch/views/<name>.tsx` pinned at head for this actor;
//   2. each edit: read the view file, change it, save it as Claude Code's Write tool does (temp file + rename), then
//      read the `.status` sidecar until it reports this save. The next edit starts from the agent's own file, so the
//      three edits depend on each other (R2-03), and each save's base is the previous save of the same print.
// Identity comes from CARDBOARD_ACTOR, as Cardboard's Director hook (or our PreToolUse prefixer) sets it.
//   agent <bundle> <projectId> <json: {steps, view?, statusMs?, noRetry?, waitGo?, settled?}>  (waitGo: after printing, wait for a
//   line on stdin before editing)
// A step: {op: "insert", like: <item name>, id, name, set: {...}} | {op: "set", name, set: {...}} | {op: "remove", name}
// (those three read the JSON codec's body) | {op: "text", find, replace} (any codec, Cardboard's JSX included)
// | {op: "wait"} (prints {waiting}, then waits for a line on stdin)
// Prints {actor, view, results: [status sidecar per step]}.
import { readFileSync, writeFileSync } from "node:fs";
import { dataDirFor, renameRetry } from "./env.ts";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { openLocal, identify } from "@carton/local";
import { cardboardAdapter } from "@carton/cardboard";
import type { HostAdapter } from "@carton/core";

const [bundle, projectId, json] = process.argv.slice(2);
const cfg = JSON.parse(json!) as { steps: any[]; view?: string; statusMs?: number; noRetry?: boolean; waitGo?: boolean; settled?: boolean };
const actor = identify();
const local = await openLocal({ projectDir: bundle!, projectId, dataDir: dataDirFor(bundle!), adapter: cardboardAdapter as HostAdapter, actor });
const results: any[] = [];
let view: { name: string; path: string; ref: string };
// B3 (routed to local-cli): on a loaded machine a `cb` call that misses one 100 ms ping takes the app's lease over with a
// helper that has no materializer, and `print --view` says "views need the app open" until the app takes the lease
// back (≈2 s). An agent following AGENTS.md would retry; counted here, pinned by s1-takeover-views.test.ts.
let printRetries = 0;
try {
  for (;;) {
    const printed = await local.write({ kind: "printView", ...(cfg.view ? { name: cfg.view } : {}) });
    if (printed.status === "confirmed" && (printed as any).view) { view = (printed as any).view; break; }
    if (cfg.noRetry || printRetries >= 10 || !/views need the app open/.test(String((printed as any).error))) {
      throw new Error(`print --view failed: ${JSON.stringify(printed)}; lease at ${Date.now()}: ${JSON.stringify(await local.lease.snapshot())}`);
    }
    printRetries++;
    await new Promise((r) => setTimeout(r, 500));
  }
} finally {
  await local.close();
}
const file = join(bundle!, ...view.path.split("/"));
// lines on stdin: "go" after a pause (waitGo, or a {op: "wait"} step)
const stdinLines = createInterface({ input: process.stdin })[Symbol.asyncIterator]();
const nextLine = async () => void (await stdinLines.next());
if (cfg.waitGo) {
  // printed; the test changes things before this agent saves (a stale save), then says go
  process.stdout.write(JSON.stringify({ printed: view }) + "\n");
  await nextLine();
}
const statusFile = file.replace(/\.tsx$/, ".status");
const readStatus = () => { try { return JSON.parse(readFileSync(statusFile, "utf8")); } catch { return null; } };

// the JSON timeline codec: comment header lines, then the timeline slice as JSON
const parse = (text: string) => { const i = text.indexOf("\n{"); return { head: text.slice(0, i + 1), body: JSON.parse(text.slice(i + 1)) }; };

for (const [i, step] of cfg.steps.entries()) {
  if (step.op === "wait") {
    // the test changes things between this agent's saves (a person's edit), then says go
    process.stdout.write(JSON.stringify({ waiting: i, view }) + "\n");
    await nextLine();
    continue;
  }
  if (step.op === "text") {
    // an edit of the file's text as an agent's Edit tool makes it (any codec: Cardboard's own JSX too)
    const text = readFileSync(file, "utf8");
    if (!text.includes(step.find)) throw new Error(`"${step.find}" isn't in my view`);
    await save(text.replace(step.find, step.replace));
    continue;
  }
  const { head, body } = parse(readFileSync(file, "utf8"));
  const list = body.timelineItems as any[];
  if (step.op === "insert") {
    const like = list.find((i) => i.name === step.like);
    if (!like) throw new Error(`no ${step.like} in my view`);
    list.push({ ...structuredClone(like), id: step.id, name: step.name, ...step.set });
  } else if (step.op === "set") {
    const it = list.find((i) => i.name === step.name);
    if (!it) throw new Error(`no ${step.name} in my view (my own earlier edit must be there)`);
    Object.assign(it, step.set);
  } else if (step.op === "remove") {
    body.timelineItems = list.filter((i) => i.name !== step.name);
  }
  await save(head + JSON.stringify(body, null, 1) + "\n");
}

/** Saves the view (temp file + rename) and waits for the materializer's sidecar for this save. */
async function save(text: string): Promise<void> {
  const before = readStatus();
  const savedAt = Date.now();
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, text);
  renameRetry(tmp, file);
  // a sidecar written after the save, for a change other than the last
  const end = Date.now() + (cfg.statusMs ?? 30_000);
  let st: any = null;
  for (;;) {
    st = readStatus();
    // `pending` acknowledges the save (a shared cut offline, or waiting for the server): an agent edits on from its own
    // file; with `settled` it waits for the server's answer instead
    if (st && st.at >= savedAt && (st.change !== before?.change || st.at !== before?.at) && !(cfg.settled && st.status === "pending")) break;
    if (Date.now() > end) throw new Error(`no status for my save within ${cfg.statusMs ?? 30_000} ms (last: ${JSON.stringify(st)})`);
    await new Promise((r) => setTimeout(r, 20));
  }
  results.push(st);
}
// stdin stays open for the test's lines: exit once the result is written (piped stdout is async on Windows)
process.stdout.write(JSON.stringify({ actor: actor.id, view, results, printRetries }) + "\n", () => process.exit(0));
