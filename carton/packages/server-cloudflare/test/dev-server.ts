// Runs `wrangler dev` for a test: a free port and inspector port (other agents run wrangler on this machine too),
// workerd state on disk under the scratch dir (never /tmp), secrets as --var, and the whole process tree killed at
// the end. wrangler runs as node's own child, never through a shell: on Windows cmd would strip the double quotes of
// a JSON var (TEAMS) and split paths with spaces (CI #23). `restart()` stops it and starts it again on the same
// state: every Durable Object is rebuilt from storage, as after an eviction or a deploy.
import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { join } from "node:path";
import { mkdirSync } from "node:fs";

// wrangler's own entry script, run with this node: no `.cmd` shim, so no shell on Windows
const WRANGLER = join(import.meta.dirname, "..", "..", "..", "node_modules", "wrangler", "bin", "wrangler.js");

async function freePort(): Promise<number> {
  return new Promise((ok, fail) => {
    const s = createServer();
    s.once("error", fail);
    s.listen(0, "127.0.0.1", () => {
      const p = (s.address() as { port: number }).port;
      s.close(() => ok(p));
    });
  });
}

export interface DevServer {
  readonly origin: string;
  readonly port: number;
  restart(): Promise<void>;
  stop(): Promise<void>;
}

export async function startDev(o: { config: string; state: string; vars: Record<string, string>; timeoutMs?: number }): Promise<DevServer> {
  const port = await freePort();
  const tmp = join(o.state, "tmp");
  mkdirSync(tmp, { recursive: true });
  let child: ChildProcess | null = null;
  let log = "";

  async function up(): Promise<void> {
    const inspector = await freePort();
    const args = ["dev", "--config", o.config, "--ip", "127.0.0.1", "--port", String(port), "--inspector-port", String(inspector), "--persist-to", join(o.state, "wrangler"), "--log-level", "warn", "--show-interactive-dev-session=false"];
    for (const [k, v] of Object.entries(o.vars)) args.push("--var", `${k}:${v}`);
    log = "";
    child = spawn(process.execPath, [WRANGLER, ...args], {
      cwd: join(o.config, ".."),
      env: { ...process.env, TMPDIR: tmp, TMP: tmp, TEMP: tmp, WRANGLER_SEND_METRICS: "false", CI: "1", NO_COLOR: "1" },
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32",
      windowsHide: true,
    });
    child.stdout!.on("data", (d) => (log += d));
    child.stderr!.on("data", (d) => (log += d));
    const deadline = Date.now() + (o.timeoutMs ?? 90_000);
    for (;;) {
      if (child.exitCode !== null) throw new Error(`wrangler dev exited ${child.exitCode}:\n${log}`);
      try {
        const r = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(2000) });
        if (r.ok) return;
      } catch {}
      if (Date.now() > deadline) throw new Error(`wrangler dev did not come up:\n${log}`);
      await new Promise((r) => setTimeout(r, 300));
    }
  }

  async function down(): Promise<void> {
    const c = child;
    child = null;
    if (!c || c.exitCode !== null) return;
    const gone = new Promise<void>((ok) => c.once("exit", () => ok()));
    if (process.platform === "win32") spawn("taskkill", ["/pid", String(c.pid), "/T", "/F"], { stdio: "ignore" });
    else {
      try {
        process.kill(-c.pid!, "SIGTERM");
      } catch {}
    }
    const t = setTimeout(() => {
      try {
        if (process.platform !== "win32") process.kill(-c.pid!, "SIGKILL");
      } catch {}
    }, 5000);
    await gone;
    clearTimeout(t);
  }

  await up();
  return {
    origin: `http://127.0.0.1:${port}`,
    port,
    restart: async () => {
      await down();
      await up();
    },
    stop: down,
  };
}
