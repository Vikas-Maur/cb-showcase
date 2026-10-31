// Where the end-to-end tests keep their files, and where the workspace's packages are.
// Scratch: CARTON_E2E_TMP, else ~/gfv-scratch/carton/e2e-qa when that folder exists (the shared build box, whose /tmp
// is a small tmpfs), else the OS temp folder (CI runners on Linux, Windows and macOS).
import { existsSync, mkdirSync, mkdtempSync, renameSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

export const E2E = fileURLToPath(new URL("..", import.meta.url));
export const WORKSPACE = join(E2E, "..");
export const pkg = (name: string, ...rest: string[]): string => join(WORKSPACE, "packages", name, ...rest);
export const support = (file: string): string => join(E2E, "support", file);

export function scratchRoot(): string {
  const box = join(homedir(), "gfv-scratch");
  const dir = process.env.CARTON_E2E_TMP ?? (existsSync(box) ? join(box, "carton", "e2e-qa", "run") : join(tmpdir(), "carton-e2e"));
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** The real home folder of the test run (children get a scratch HOME, see procs.ts). */
export const REAL_HOME = homedir();

/**
 * A machine's app-data folder (`<machine home>/appdata`), from its bundle `<machine home>/lib/<Name>.cardboard`: where
 * carton.db goes when the bundle is in a synced folder, on a network share or on FAT/exFAT (§6.4, L15). Passed to every
 * Carton open, so no placement ever reaches the real user profile, and two machines on one box never share one.
 */
export const dataDirFor = (bundle: string): string => join(dirname(dirname(resolve(bundle))), "appdata");

/** Refuse to touch a file outside the scratch root (the user's real data is never opened). */
export function assertInScratch(path: string, what: string): void {
  const root = resolve(scratchRoot()) + sep;
  if (!resolve(path).startsWith(root)) throw new Error(`${what} is outside the scratch folder (${path}); refusing to open it`);
}

/** A fresh folder for one scenario. */
export const scratch = (name: string): string => mkdtempSync(join(scratchRoot(), `${name}-`));

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Polls `f` until it returns something truthy; throws with `what` after `ms`. */
export async function until<T>(f: () => T | null | undefined | false | Promise<T | null | undefined | false>, ms = 30_000, what = "condition", every = 25): Promise<T> {
  const end = Date.now() + ms;
  let last: unknown = null;
  for (;;) {
    try {
      const v = await f();
      if (v) return v;
    } catch (e) {
      last = e;
    }
    if (Date.now() > end) throw new Error(`timed out after ${ms} ms waiting for ${what}${last ? ` (last error: ${(last as Error)?.message ?? last})` : ""}`);
    await sleep(every);
  }
}

/**
 * Replace `to` with `from` as an editor's or agent's atomic save does. On Windows a rename over a file another process
 * has open (Carton's materializer reading it) fails with EPERM/EBUSY for a moment; editors retry, so do we.
 */
export function renameRetry(from: string, to: string): void {
  for (let i = 0; ; i++) {
    try {
      return renameSync(from, to);
    } catch (e: any) {
      if (i >= 50 || !["EPERM", "EBUSY", "EACCES"].includes(e?.code)) throw e;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
    }
  }
}
