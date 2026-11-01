// Shared pieces of the web demo's end-to-end runs: a host of either kind serving the built client (server-node, or
// the Worker under `wrangler dev`: local only, never deployed), the seed, Chromium through Playwright (required by
// path: no runner, node:test drives it), and a person joining from an invite link.

import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createRequire } from "node:module";
import { mkdirSync, rmSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import { createServer } from "node:net";
import { serveDemo } from "../../apps/web/scripts/serve-node.ts";

const here = dirname(fileURLToPath(import.meta.url));
export const carton = resolve(here, "..", "..");
export const webDir = join(carton, "apps", "web");
export const distDir = join(webDir, "dist");
export const scratch = process.env.CARTON_E2E_SCRATCH ?? join(process.env.HOME ?? ".", "gfv-scratch", "carton", "web-demo", "e2e");
const PLAYWRIGHT = process.env.CARTON_PLAYWRIGHT ?? "/home/ubuntu/.npm/_npx/e41f203b7505f1fb/node_modules/playwright";
const CHROMIUM = process.env.CARTON_CHROMIUM ?? "/home/ubuntu/.cache/ms-playwright/chromium-1248/chrome-linux-arm64/chrome";

// Playwright's types aren't a dependency of the workspace: the few calls used here are typed loosely.
/* eslint-disable @typescript-eslint/no-explicit-any */
export type Browser = any;
export type Page = any;
export type Context = any;

export interface TestHost {
  kind: "node" | "cloudflare";
  url: string;
  adminToken: string;
  close(): Promise<void>;
}

async function freePort(): Promise<number> {
  return new Promise((res, rej) => {
    const s = createServer();
    s.listen(0, "127.0.0.1", () => {
      const port = (s.address() as { port: number }).port;
      s.close(() => res(port));
    });
    s.on("error", rej);
  });
}

async function waitHealthy(url: string, ms: number, proc?: ChildProcess): Promise<void> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (proc && proc.exitCode !== null) throw new Error(`the host exited with ${proc.exitCode}`);
    try {
      const r = await fetch(`${url}/api/health`);
      if (r.ok) return;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`${url} didn't come up within ${ms} ms`);
}

/** Build the client once per run (unless CARTON_E2E_NO_BUILD). */
export async function buildClient(): Promise<void> {
  if (process.env.CARTON_E2E_NO_BUILD) return;
  await new Promise<void>((res, rej) => {
    const p = spawn(process.execPath, [join(webDir, "build.mjs")], { stdio: ["ignore", "inherit", "inherit"] });
    p.on("exit", (code) => (code === 0 ? res() : rej(new Error(`build failed: ${code}`))));
  });
}

export async function startHost(kind: "node" | "cloudflare", name: string): Promise<TestHost> {
  const dir = join(scratch, `${kind}-${name}`);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  if (kind === "node") {
    const d = await serveDemo({ dataDir: dir, staticDir: distDir, port: 0 });
    return { kind, url: d.url, adminToken: d.adminToken, close: () => d.close() };
  }
  // the Worker and its Durable Objects in workerd, with R2 simulated locally; the client as its static assets.
  // Secrets are passed as vars for this local run only (never written to the package).
  const port = await freePort();
  const inspector = await freePort();
  const adminToken = randomBytes(24).toString("base64url");
  const secret = randomBytes(32).toString("base64url");
  const proc = spawn(
    process.execPath,
    [wranglerEntry(), "dev", "--port", String(port), "--ip", "127.0.0.1", "--inspector-port", String(inspector), "--persist-to", join(dir, "state"), "--assets", distDir, "--var", `AUTH_SECRET:${secret}`, "--var", `ADMIN_TOKEN:${adminToken}`, "--log-level", process.env.CARTON_E2E_HOSTLOG ? "debug" : "warn", "--show-interactive-dev-session=false"],
    {
      cwd: join(carton, "packages", "server-cloudflare"),
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, WRANGLER_SEND_METRICS: "false", CI: "1", XDG_CONFIG_HOME: join(dir, "xdg") },
      // POSIX: its own process group, so the whole tree can be signalled (killTree); Windows needs no group (taskkill /T)
      detached: process.platform !== "win32",
      windowsHide: true,
    },
  );
  // a run that ends without close() (a crash, Ctrl-C) still takes the tree down
  const unhook = onEnd(() => killTreeNow(proc));
  let log = "";
  proc.stdout!.on("data", (b: Buffer) => (log += b.toString()));
  proc.stderr!.on("data", (b: Buffer) => (log += b.toString()));
  const url = `http://127.0.0.1:${port}`;
  try {
    await waitHealthy(url, 120_000, proc);
  } catch (e) {
    await killTree(proc, 0);
    unhook();
    throw new Error(`${(e as Error).message}\n${log.slice(-3000)}`);
  }
  return {
    kind,
    url,
    adminToken,
    close: async () => {
      // the host's own log, for a failed run (CARTON_E2E_HOSTLOG=<file>)
      if (process.env.CARTON_E2E_HOSTLOG) (await import("node:fs")).writeFileSync(process.env.CARTON_E2E_HOSTLOG, log);
      await killTree(proc, 500);
      unhook();
    },
  };
}

/**
 * wrangler's own JS entry point (its package's `bin`), to run with this Node: the same command on every OS. On Windows
 * `node_modules/.bin/wrangler` is a `.cmd`, which spawn can't run without a shell (ENOENT), and a shell brings quoting.
 */
function wranglerEntry(): string {
  const req = createRequire(join(carton, "packages", "server-cloudflare", "package.json"));
  const pkg = req.resolve("wrangler/package.json");
  const { bin } = req(pkg) as { bin?: string | Record<string, string> };
  const rel = typeof bin === "string" ? bin : bin?.wrangler;
  if (!rel) throw new Error(`${pkg} names no wrangler bin`);
  return join(dirname(pkg), rel);
}

/**
 * Run `f` when this process ends without closing the host: a normal exit, or Ctrl-C / a kill (SIGINT, SIGTERM, and
 * SIGHUP off Windows), which end Node without its `exit` event. After `f`, the signal is raised again so the process
 * ends as it would have. Returns the unhook.
 */
function onEnd(f: () => void): () => void {
  let done = false;
  const once = () => {
    if (!done) (done = true), f();
  };
  const signals: NodeJS.Signals[] = process.platform === "win32" ? ["SIGINT", "SIGTERM"] : ["SIGINT", "SIGTERM", "SIGHUP"];
  const onSignal = (sig: NodeJS.Signals) => {
    once();
    unhook();
    // the default action, unless someone else handles it
    if (process.listenerCount(sig) === 0) process.kill(process.pid, sig);
  };
  const unhook = () => {
    process.off("exit", once);
    for (const s of signals) process.off(s, onSignal);
  };
  process.once("exit", once);
  for (const s of signals) process.on(s, onSignal);
  return unhook;
}

const gone = (p: ChildProcess) => p.exitCode !== null || p.signalCode !== null || p.pid === undefined;

/** Kill `proc` and everything it started at once, synchronously (for process exit). */
function killTreeNow(proc: ChildProcess): void {
  if (gone(proc)) return;
  if (process.platform === "win32") spawnSync("taskkill", ["/pid", String(proc.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
  else signalGroup(proc, "SIGKILL");
}

function signalGroup(proc: ChildProcess, sig: NodeJS.Signals): void {
  try {
    process.kill(-proc.pid!, sig); // the group spawn's `detached` made, led by proc
  } catch {
    // the group is gone
  }
}

/**
 * Stop `proc` and the processes it started: wrangler's launcher runs its CLI in a second Node, which runs workerd, and
 * killing only the first leaves the others holding the port and the state folder. POSIX: SIGTERM to the process
 * group, then SIGKILL to whatever is left after `graceMs`. Windows has no signals: `taskkill /T /F` ends the tree.
 */
async function killTree(proc: ChildProcess, graceMs: number): Promise<void> {
  const exited = gone(proc) ? Promise.resolve() : new Promise<void>((r) => proc.once("exit", () => r()));
  const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
  if (process.platform === "win32") {
    if (!gone(proc))
      await new Promise<void>((r) => {
        const k = spawn("taskkill", ["/pid", String(proc.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
        k.on("exit", () => r());
        k.on("error", () => r());
      });
  } else {
    // even when proc has exited, its children may not have: the group outlives its leader
    signalGroup(proc, "SIGTERM");
    if (graceMs > 0) await Promise.race([exited, wait(graceMs)]);
    await wait(graceMs > 0 ? 200 : 0); // a moment for workerd to follow wrangler down
    signalGroup(proc, "SIGKILL");
  }
  await Promise.race([exited, wait(5000)]);
}

export async function launchChromium(): Promise<Browser> {
  const require = createRequire(import.meta.url);
  const { chromium } = require(PLAYWRIGHT);
  return chromium.launch({ executablePath: CHROMIUM, headless: true, args: ["--autoplay-policy=no-user-gesture-required"] });
}

/** A person's own browser profile: a fresh context, optionally recording video (CARTON_E2E_VIDEO=<dir>). */
export async function newPerson(browser: Browser, video?: string): Promise<Context> {
  return browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1, colorScheme: "dark", ...(video ? { recordVideo: { dir: video, size: { width: 1440, height: 900 } } } : {}) });
}

/** Open an invite link, give a name, join, and wait for the editor. */
export async function joinAs(ctx: Context, link: string, name: string): Promise<Page> {
  const page = await ctx.newPage();
  page.on("pageerror", (e: Error) => console.error(`[${name}] page error: ${e.message}`));
  await page.goto(link);
  await page.getByTestId("join-name").fill(name);
  await page.getByTestId("join").click();
  await page.getByTestId("timeline").waitFor({ timeout: 20_000 });
  return page;
}
