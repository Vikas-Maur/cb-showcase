// The detached headless-sync helper (§6.2, R4-04): started by the first `cb` call that finds no live lease holder
// for a shared cut. It takes the lease, keeps the sync connection, serves later `cb` calls on its own socket, and exits
// 60 s after its last use, or at once when the app starts and asks it to hand over.
//
// It is spawned with `detached: true`, `stdio: "ignore"`, `windowsHide: true` and `unref()`, so it never holds the
// agent's Bash call open and gets its own process group. If a tool runner's kill (a process tree or a job object)
// takes it down anyway, the next `cb` call takes over.
//
// What engine it runs comes from a factory module (`--factory`): an ES module whose `createHolderEngine(opts)` opens
// carton.db with the same adapter, store and transport the `cb` process uses. The default factory is Cardboard's;
// tests pass their own.
import { spawn } from "node:child_process";
import { appendFileSync, statSync, truncateSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export interface SpawnHelperOptions {
  dbPath: string;
  /** The lease nonce the caller saw dead (null: no holder at all). */
  seen: string | null;
  /** Absolute path or file URL of the engine factory module. */
  factory: string;
  /** Extra JSON config for the factory (server URL, project dir…); never secrets on the command line. */
  config?: object;
  env?: NodeJS.ProcessEnv;
  idleMs?: number;
}

/** The helper's entry file, next to this one (`.ts` when run from source, `.js` from dist). */
export const helperEntry = (): string => {
  const self = fileURLToPath(import.meta.url);
  return join(dirname(self), `helper-main${self.endsWith(".ts") ? ".ts" : ".js"}`);
};

/**
 * The helper's environment. Under Electron `process.execPath` is the app's own binary: `cb`'s shims run it as Node
 * (`ELECTRON_RUN_AS_NODE=1`, inherited), but the app's library worker (a utility process) doesn't have it set, and
 * without it the spawn would start a second copy of the app instead of the helper. So under Electron it is set here.
 */
export function helperEnv(base: NodeJS.ProcessEnv, electron: string | undefined = process.versions.electron): NodeJS.ProcessEnv {
  return electron ? { ...base, ELECTRON_RUN_AS_NODE: "1" } : base;
}

export function spawnHelper(o: SpawnHelperOptions): number | undefined {
  const args = [helperEntry(), "--db", o.dbPath, "--seen", o.seen ?? "-", "--factory", o.factory];
  if (o.config) args.push("--config", JSON.stringify(o.config));
  if (o.idleMs !== undefined) args.push("--idle-ms", String(o.idleMs));
  const child = spawn(process.execPath, args, { detached: true, stdio: "ignore", windowsHide: true, env: helperEnv(o.env ?? process.env) });
  child.unref();
  return child.pid;
}

/** The factory module's shape. */
export interface HelperFactoryOptions {
  dbPath: string;
  config: Record<string, unknown>;
  log: (event: Record<string, unknown>) => void;
}

/**
 * The helper's activity log, `helper.log` next to carton.db: how and when it started, took over, handed over, failed.
 * Never anything a user or agent typed. Kept under 1 MB.
 */
export function helperLog(dbPath: string): (event: Record<string, unknown>) => void {
  const file = join(dirname(dbPath), "helper.log");
  return (event) => {
    try {
      try { if (statSync(file).size > 1 << 20) truncateSync(file, 0); } catch { /* not there yet */ }
      appendFileSync(file, JSON.stringify({ t: Date.now(), pid: process.pid, ...event }) + "\n");
    } catch { /* logging never breaks the helper */ }
  };
}

export const factoryUrl = (factory: string): string => (factory.startsWith("file:") ? factory : pathToFileURL(factory).href);
