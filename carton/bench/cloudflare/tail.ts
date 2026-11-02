// Every request the lab Workers serve, from `wrangler tail`: its time, path, status, outcome, CPU and wall time, one
// JSON line each, so a run's Worker requests and CPU are read per project (its id is in the path) even when several
// runs share the clock. The analytics API has no per-path dimension, and its CPU numbers are sampled. Headers and query
// strings are dropped (a signed URL's query is a credential for a few minutes), except `key`, which names the object.
//
//   node bench/cloudflare/tail.ts            follows both lab Workers until killed, restarting a dropped tail
//   import { tailOf } from "./tail.ts"       a project's requests in a window
import { spawn } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { RUNS_DIR } from "./paths.ts";

export const TAIL_DIR = join(RUNS_DIR, "tail");
const SCRIPTS = ["carton-lab-r2", "carton-lab-nor2"] as const;
export const tailFile = (script: string) => join(TAIL_DIR, `${script}.jsonl`);

export interface TailLine {
  t: number;
  script: string;
  method: string;
  path: string;
  key?: string;
  status?: number;
  outcome: string;
  cpu: number;
  wall: number;
  /** "stateless" for the Worker; a Durable Object's own events show up in the tail too (absent in early lines) */
  model?: string;
}

/** Splits wrangler's stream of pretty-printed JSON objects (strings may hold braces). */
function objects(onObject: (text: string) => void) {
  let buf = "", depth = 0, inStr = false, esc = false, start = -1;
  return (chunk: string) => {
    for (let i = 0; i < chunk.length; i++) {
      const ch = chunk[i]!;
      buf += ch;
      if (inStr) {
        if (esc) esc = false;
        else if (ch === "\\") esc = true;
        else if (ch === '"') inStr = false;
        continue;
      }
      if (ch === '"') inStr = true;
      else if (ch === "{") {
        if (depth++ === 0) start = buf.length - 1;
      } else if (ch === "}" && depth > 0 && --depth === 0) {
        onObject(buf.slice(start));
        buf = "";
      }
    }
    if (depth === 0 && buf.length > 1 << 20) buf = "";
  };
}

function follow(script: string): void {
  const p = spawn("npx", ["wrangler", "tail", script, "--format", "json"], { stdio: ["ignore", "pipe", "pipe"], env: process.env });
  const feed = objects((text) => {
    let e: any;
    try { e = JSON.parse(text); } catch { return; }
    const req = e.event?.request;
    if (!req?.url) return;
    const u = new URL(req.url);
    const line: TailLine = { t: e.eventTimestamp, script, method: req.method, path: u.pathname, outcome: e.outcome, cpu: e.cpuTime ?? 0, wall: e.wallTime ?? 0, model: e.executionModel };
    const key = u.searchParams.get("key") ?? u.searchParams.get("k");
    if (key) line.key = key;
    if (e.event?.response?.status !== undefined) line.status = e.event.response.status;
    appendFileSync(tailFile(script), JSON.stringify(line) + "\n");
  });
  p.stdout.setEncoding("utf8").on("data", feed);
  p.stderr.setEncoding("utf8").on("data", (s: string) => { if (/error|sampling/i.test(s)) process.stderr.write(`[tail ${script}] ${s}`); });
  p.on("close", (code) => {
    process.stderr.write(`[tail ${script}] ended (${code}); restarting in 3 s\n`);
    setTimeout(() => follow(script), 3000);
  });
}

/** A project's requests in [start, end] (ms), or every request in it when `projectId` is "*". */
export function tailOf(script: string, projectId: string, start: number, end: number): TailLine[] {
  const f = tailFile(script);
  if (!existsSync(f)) return [];
  const out: TailLine[] = [];
  for (const s of readFileSync(f, "utf8").split("\n")) {
    if (!s) continue;
    const l = JSON.parse(s) as TailLine;
    if (l.t < start || l.t > end) continue;
    // the API's routes (/api/projects/<p>/…) and signed blob URLs (/blob/<p>/<key>)
    if (projectId !== "*" && !l.path.includes(`/projects/${projectId}/`) && !l.path.startsWith(`/blob/${projectId}/`)) continue;
    // the Worker's own requests only: not a Durable Object's events, not the lab's admin routes
    if (l.model !== undefined && l.model !== "stateless") continue;
    if (l.path.startsWith("/api/lab/")) continue;
    out.push(l);
  }
  return out;
}

/** Requests and CPU, in total and by route (the path with the project id and ids taken out). */
export function summarize(lines: TailLine[]) {
  const by: Record<string, { n: number; cpu: number; wall: number; notOk: number }> = {};
  let cpu = 0, wall = 0, notOk = 0;
  for (const l of lines) {
    const route = `${l.method} ${l.path.replace(/^\/blob\/[^/]+\/.*$/, "/blob/:p/:key").replace(/\/projects\/[^/]+/, "/projects/:p").replace(/\/uploads\/[^/]+/, "/uploads/:id").replace(/\/uploads\/:id\/\d+$/, "/uploads/:id/:n")}`;
    const r = (by[route] ??= { n: 0, cpu: 0, wall: 0, notOk: 0 });
    r.n++, (r.cpu += l.cpu), (r.wall += l.wall);
    cpu += l.cpu, wall += l.wall;
    if (l.outcome !== "ok") r.notOk++, notOk++;
  }
  return { requests: lines.length, cpuMs: cpu, wallMs: wall, notOk, byRoute: by };
}

if (import.meta.main) {
  mkdirSync(TAIL_DIR, { recursive: true });
  for (const s of SCRIPTS) follow(s);
}
