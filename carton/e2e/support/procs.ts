// Real processes for the scenarios: each script prints one JSON object per line on stdout and may read commands on
// stdin. A `Procs` registry per scenario kills everything it started, plus the detached headless helpers `cb` calls
// spawned (found by the pids in each carton.db's `helper.log`), so no test leaves a process behind on a shared box.
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { scratchRoot } from "./env.ts";
import { createInterface } from "node:readline";

export interface ProcOptions {
  env?: Record<string, string | undefined>;
  cwd?: string;
  /** Text written to stdin, then stdin is closed (one-shot commands such as `cb`). */
  input?: string;
}

export class Proc {
  readonly p: ChildProcess;
  readonly lines: any[] = [];
  stderr = "";
  stdout = "";
  private waiters: { pred: (x: any) => boolean; resolve: (x: any) => void; reject: (e: Error) => void }[] = [];
  readonly exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;

  readonly name: string;

  constructor(name: string, args: string[], o: ProcOptions = {}) {
    this.name = name;
    this.p = spawn(process.execPath, args, { stdio: ["pipe", "pipe", "pipe"], cwd: o.cwd, env: cleanEnv(o.env), windowsHide: true });
    this.p.stderr!.setEncoding("utf8").on("data", (d: string) => { this.stderr = (this.stderr + d).slice(-20_000); });
    createInterface({ input: this.p.stdout! }).on("line", (l) => {
      this.stdout = (this.stdout + l + "\n").slice(-200_000);
      let x: any;
      try { x = JSON.parse(l); } catch { return; }
      this.lines.push(x);
      for (const w of [...this.waiters]) if (w.pred(x)) { this.waiters.splice(this.waiters.indexOf(w), 1); w.resolve(x); }
    });
    this.exited = new Promise((r) => this.p.on("exit", (code, signal) => {
      for (const w of this.waiters.splice(0)) w.reject(new Error(`${this.name} exited (${code ?? signal}) before the line it waited for\n${this.stderr}`));
      r({ code, signal });
    }));
    if (o.input !== undefined) this.p.stdin!.end(o.input);
  }

  get pid(): number { return this.p.pid!; }
  get alive(): boolean { return this.p.exitCode === null && this.p.signalCode === null; }

  /** The first line (already seen or still to come) that matches. */
  next(pred: (x: any) => boolean = () => true, ms = 60_000): Promise<any> {
    const hit = this.lines.find(pred);
    if (hit) return Promise.resolve(hit);
    if (!this.alive) return Promise.reject(new Error(`${this.name} is not running\n${this.stderr}`));
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`${this.name}: no matching line within ${ms} ms\n${this.stderr}`)), ms);
      this.waiters.push({ pred, resolve: (x) => { clearTimeout(t); resolve(x); }, reject: (e) => { clearTimeout(t); reject(e); } });
    });
  }

  /** Sends one command line and waits for the reply line that carries the same `seq`. */
  async ask(cmd: Record<string, unknown>, ms = 60_000): Promise<any> {
    const seq = ++Proc.seq;
    const reply = this.next((x) => x.seq === seq, ms);
    this.p.stdin!.write(JSON.stringify({ ...cmd, seq }) + "\n");
    const r = await reply;
    if (r.error) throw new Error(`${this.name} ${String(cmd.cmd)}: ${r.error}`);
    return r;
  }
  private static seq = 0;

  kill(signal: NodeJS.Signals = "SIGKILL"): Promise<unknown> {
    if (this.alive) this.p.kill(signal);
    return this.exited;
  }
}

/**
 * A short temp folder inside the scratch root for the processes a scenario starts: a lease holder whose bundle path is
 * too deep for a Unix socket puts its control socket in the temp folder (`holderSocketPath`), and a process killed
 * with SIGKILL leaves it there; inside scratch it goes with the scenario. Only when the path stays short (a socket
 * path must fit 104 bytes on macOS); Windows uses named pipes.
 */
function shortTmp(): string | null {
  if (process.platform === "win32") return null;
  const t = join(scratchRoot(), "t");
  if (t.length > 50) return null;
  mkdirSync(t, { recursive: true });
  return t;
}

/** The tests' own CARDBOARD_* / Claude Code variables must never leak into the processes they start. */
function cleanEnv(extra: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) if (!/^(CARDBOARD_|CARTON_AGENT|CLAUDECODE|CLAUDE_CODE|GEMINI_CLI|CODEX_|CURSOR_TRACE_ID)/.test(k)) env[k] = v;
  const t = shortTmp();
  if (t) env.TMPDIR = t;
  for (const [k, v] of Object.entries(extra)) if (v === undefined) delete env[k]; else env[k] = v;
  return env;
}

export class Procs {
  private all: Proc[] = [];
  private helperLogs = new Set<string>();

  start(name: string, args: string[], o: ProcOptions = {}): Proc {
    const p = new Proc(name, args, o);
    this.all.push(p);
    return p;
  }

  /** Remember a carton.db folder: helpers started for it are killed at the end. */
  watchHelpers(dbDir: string): void {
    this.helperLogs.add(dbDir);
  }

  helperPids(): number[] {
    const pids = new Set<number>();
    for (const dir of this.helperLogs) {
      const f = `${dir}/helper.log`;
      if (!existsSync(f)) continue;
      for (const l of readFileSync(f, "utf8").split("\n")) {
        try { const e = JSON.parse(l); if (typeof e.pid === "number") pids.add(e.pid); } catch { /* partial line */ }
      }
    }
    return [...pids];
  }

  async close(): Promise<void> {
    await Promise.all(this.all.map((p) => p.kill()));
    for (const pid of this.helperPids()) killIfOurs(pid, [...this.helperLogs]);
  }
}

/** Kill a detached helper only while it is still one of ours (pids get reused on a shared box). */
export function killIfOurs(pid: number, dirs: string[]): void {
  try {
    if (existsSync(`/proc/${pid}/cmdline`)) {
      const cmd = readFileSync(`/proc/${pid}/cmdline`, "utf8");
      if (!dirs.some((d) => cmd.includes(d)) || !/helper-main/.test(cmd)) return;
    }
    process.kill(pid, "SIGKILL");
  } catch { /* already gone */ }
}

/** Runs a one-shot process to its end: its JSON lines, exit code and output. */
export async function runOnce(name: string, args: string[], o: ProcOptions & { timeoutMs?: number } = {}): Promise<{ code: number | null; lines: any[]; stdout: string; stderr: string }> {
  const p = new Proc(name, args, { ...o, input: o.input ?? "" });
  const t = setTimeout(() => p.kill(), o.timeoutMs ?? 120_000);
  const { code } = await p.exited;
  clearTimeout(t);
  return { code, lines: p.lines, stdout: p.stdout, stderr: p.stderr };
}
