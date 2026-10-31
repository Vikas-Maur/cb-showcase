// Process-test harness: a scratch dir per scenario with carton.db, the stand-in server, `cb` processes, the worker,
// and cleanup that kills every process a scenario started (helpers are detached, so they are found by pid).
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { createConnection } from "node:net";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline";
import { scratch } from "./scratch.ts";

const here = (f: string) => fileURLToPath(new URL(f, import.meta.url));
export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface Ev { t: number; pid: number; nonce: string | null; type: string; [k: string]: any }

export class World {
  dir: string;
  db: string;
  port = 0;
  procs: ChildProcess[] = [];
  constructor(name: string) {
    this.dir = mkdtempSync(join(scratch(), `${name}-`));
    this.db = join(this.dir, "carton.db");
  }
  async server(args: string[] = []): Promise<number> {
    const portFile = join(this.dir, "port");
    this.procs.push(spawn(process.execPath, [here("./mini-server.ts"), portFile, ...args], { stdio: "inherit" }));
    while (!existsSync(portFile) || !readFileSync(portFile, "utf8")) await sleep(10);
    return (this.port = Number(readFileSync(portFile, "utf8")));
  }
  stats(): Promise<any> {
    return new Promise((resolve, reject) => {
      const s = createConnection(this.port, "127.0.0.1");
      let buf = "";
      s.setEncoding("utf8");
      s.on("connect", () => s.write(JSON.stringify({ type: "stats" }) + "\n"));
      s.on("data", (d: string) => { buf += d; const nl = buf.indexOf("\n"); if (nl >= 0) { s.destroy(); resolve(JSON.parse(buf.slice(0, nl))); } });
      s.on("error", reject);
    });
  }
  /** Start a `cb` call; resolves with its JSON result. */
  cb(arg: Record<string, unknown>): Promise<any> {
    const p = spawn(process.execPath, [here("./cb.ts"), this.db, JSON.stringify({ config: { port: this.port }, ...arg })], { stdio: ["ignore", "pipe", "inherit"] });
    this.procs.push(p);
    return new Promise((resolve, reject) => {
      let out = "";
      p.stdout!.on("data", (d) => (out += d));
      p.on("exit", (code) => (out.trim() ? resolve(JSON.parse(out.trim().split("\n").at(-1)!)) : reject(new Error(`cb exited ${code} with no output`))));
    });
  }
  async worker(config: Record<string, unknown> = {}): Promise<{ proc: ChildProcess; lines: any[]; ready: any; send: (l: string) => void; next: (pred: (x: any) => boolean) => Promise<any> }> {
    const p = spawn(process.execPath, [here("./worker.ts"), this.db, JSON.stringify({ port: this.port, ...config })], { stdio: ["pipe", "pipe", "inherit"] });
    this.procs.push(p);
    const lines: any[] = [];
    const waiters: [(x: any) => boolean, (x: any) => void][] = [];
    createInterface({ input: p.stdout! }).on("line", (l) => {
      const x = JSON.parse(l);
      lines.push(x);
      for (const w of [...waiters]) if (w[0](x)) { waiters.splice(waiters.indexOf(w), 1); w[1](x); }
    });
    const next = (pred: (x: any) => boolean) => new Promise<any>((r) => { const hit = lines.find(pred); if (hit) r(hit); else waiters.push([pred, r]); });
    const ready = await next((x) => x.ready);
    return { proc: p, lines, ready, send: (l) => p.stdin!.write(l + "\n"), next };
  }
  events(): Ev[] {
    const f = join(this.dir, "events.jsonl");
    return existsSync(f) ? readFileSync(f, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
  }
  async until(pred: (ev: Ev[]) => boolean, ms = 10000): Promise<Ev[]> {
    const end = Date.now() + ms;
    for (;;) {
      const ev = this.events();
      if (pred(ev)) return ev;
      if (Date.now() > end) throw new Error(`timed out waiting; events: ${JSON.stringify(ev.slice(-5))}`);
      await sleep(5);
    }
  }
  async close(): Promise<void> {
    for (const p of this.procs) if (p.exitCode === null && p.signalCode === null) p.kill("SIGKILL");
    // detached helpers: kill a recorded pid only while it is still one of ours (the box is shared; pids get reused)
    for (const pid of new Set(this.events().map((e) => e.pid))) {
      try {
        const cmd = readFileSync(`/proc/${pid}/cmdline`, "utf8");
        if (cmd.includes(this.dir) && /helper-main|worker\.ts/.test(cmd)) process.kill(pid, "SIGKILL");
      } catch { /* gone, or not Linux */ }
    }
  }
}
