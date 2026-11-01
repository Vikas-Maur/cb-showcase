// server-cloudflare's Worker + ProjectRoom under `wrangler dev`, locally only (never deployed):
//   - the package's wrangler.toml copied into the scenario's scratch folder with absolute paths, and its secrets in a
//     `.dev.vars` beside it (mode 0600), never on a command line where `ps` would show them;
//   - workerd's state persisted under scratch; a free port and inspector port (other runs share the machine);
//   - the whole process tree killed when the start fails or the scenario ends; `restart()` brings it back on the same
//     port and state (every Durable Object rebuilt from storage, as after an eviction or a deploy).
import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import { pkg } from "./env.ts";

// wrangler's own JS entry, run with this Node (no .cmd shim, no shell: paths with spaces or `&` pass as they are)
export const WRANGLER = pkg("..", "node_modules", "wrangler", "bin", "wrangler.js");

function freePort(): Promise<number> {
  return new Promise((ok, fail) => {
    const s = createServer();
    s.once("error", fail);
    s.listen(0, "127.0.0.1", () => {
      const p = (s.address() as { port: number }).port;
      s.close(() => ok(p));
    });
  });
}

export interface Wrangler {
  readonly port: number;
  restart(): Promise<void>;
  stop(): Promise<void>;
}

export async function startWrangler(o: { dir: string; vars: Record<string, string>; timeoutMs?: number }): Promise<Wrangler> {
  const src = pkg("server-cloudflare");
  mkdirSync(o.dir, { recursive: true });
  const abs = (rel: string) => JSON.stringify(join(src, rel).replace(/\\/g, "/"));
  const toml = readFileSync(join(src, "wrangler.toml"), "utf8")
    .replace(/^main\s*=\s*"[^"]*"/m, `main = ${abs("src/worker.ts")}`)
    .replace(/^directory\s*=\s*"[^"]*"/m, `directory = ${abs("public")}`);
  const config = join(o.dir, "wrangler.toml");
  writeFileSync(config, toml);
  writeFileSync(join(o.dir, ".dev.vars"), Object.entries(o.vars).map(([k, v]) => `${k}=${JSON.stringify(v)}`).join("\n") + "\n", { mode: 0o600 });
  const tmp = join(o.dir, "tmp");
  mkdirSync(tmp, { recursive: true });
  const port = await freePort();
  let child: ChildProcess | null = null;

  // POSIX: the whole process group (wrangler and the workerd it starts) goes, even when wrangler itself already exited;
  // SIGTERM, then SIGKILL for whatever is still in the group after 5 s. Windows: taskkill of the tree.
  const groupAlive = (pgid: number) => { try { process.kill(-pgid, 0); return true; } catch { return false; } };
  async function down(): Promise<void> {
    const c = child;
    child = null;
    if (!c?.pid) return;
    if (process.platform === "win32") {
      if (c.exitCode !== null || c.signalCode !== null) return;
      const gone = new Promise<void>((ok) => c.once("exit", () => ok()));
      spawn("taskkill", ["/pid", String(c.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
      await gone;
      return;
    }
    const pgid = c.pid;
    try { process.kill(-pgid, "SIGTERM"); } catch { /* the group is gone */ }
    const end = Date.now() + 5000;
    while (groupAlive(pgid) && Date.now() < end) await new Promise((r) => setTimeout(r, 100));
    if (groupAlive(pgid)) try { process.kill(-pgid, "SIGKILL"); } catch { /* gone meanwhile */ }
  }

  async function up(): Promise<void> {
    const inspector = await freePort();
    const args = ["dev", "--config", config, "--ip", "127.0.0.1", "--port", String(port), "--inspector-port", String(inspector), "--persist-to", join(o.dir, "state"), "--log-level", "warn", "--show-interactive-dev-session=false"];
    let log = "";
    child = spawn(process.execPath, [WRANGLER, ...args], {
      cwd: o.dir,
      env: { ...process.env, TMPDIR: tmp, TMP: tmp, TEMP: tmp, WRANGLER_SEND_METRICS: "false", CI: "1", NO_COLOR: "1" },
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32",
      windowsHide: true,
    });
    child.stdout!.on("data", (d) => (log = (log + d).slice(-20_000)));
    child.stderr!.on("data", (d) => (log = (log + d).slice(-20_000)));
    const deadline = Date.now() + (o.timeoutMs ?? 180_000);
    try {
      for (;;) {
        if (!child || child.exitCode !== null) throw new Error(`wrangler dev exited ${child?.exitCode}:\n${log}`);
        try {
          const r = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(2000) });
          if (r.ok) return;
        } catch { /* not up yet */ }
        if (Date.now() > deadline) throw new Error(`wrangler dev did not come up:\n${log}`);
        await new Promise((r) => setTimeout(r, 300));
      }
    } catch (e) {
      await down();
      throw e;
    }
  }

  await up();
  return { port, restart: async () => { await down(); await up(); }, stop: down };
}
