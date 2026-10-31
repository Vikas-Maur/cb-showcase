// Carton on one machine (PLAN §6.2, §6.4, §13): opens `.carton/carton.db` for a project bundle (or app data in synced
// folders and FAT volumes, L15), runs the engine on its own thread, holds the sync lease (pid, nonce, socket; heartbeat
// 2 s, expiry 6 s; ping-based takeover; fenced dequeue) and the headless helper, materializes project.json with
// "displace, then install", watches per-agent view files and writes their `.status` sidecars, freezes the shared
// timeline.tsx during agent turns, and exports/imports `.cbproj`. Windows: named pipes, EPERM rename retries,
// case-insensitive paths. Owner: local-cli.
import type { Actor, Carton, CommitResult, StateRef } from "@carton/core";
import type { IdentitySource } from "@carton/core/plugins";

export * from "./ipc.ts";
export * from "./lease.ts";
export * from "./holder.ts";
export * from "./client.ts";
export * from "./helper.ts";
export * from "./identity.ts";
export * from "./hooks.ts";
export * from "./writes.ts";
export * from "./engine-thread.ts";
export { nodeHasher } from "./hasher.ts";

const todo = (what: string): never => {
  throw new Error(`not implemented: ${what}`);
};

export interface LocalOptions {
  /** The Cardboard project bundle directory. */
  projectDir: string;
  /** Where carton.db goes when the bundle is in a cloud-sync folder or on FAT (default: app data). */
  dataDir?: string;
  actor?: Actor | IdentitySource;
  /** Connect to a shared cut's server when the project is shared. */
  sync?: boolean;
}

export interface LocalCarton {
  readonly carton: Carton;
  readonly dbPath: string;
  /** Print a view (`cb source print --view <name>`): its header ref, with a new print nonce. */
  printView(name: string, opts?: { owner?: string }): Promise<{ path: string; header: string; ref: StateRef }>;
  /** Apply a saved view file and write its `.status` sidecar. */
  applyView(name: string): Promise<CommitResult>;
  close(): Promise<void>;
}

export async function openLocal(opts: LocalOptions): Promise<LocalCarton> {
  return todo("openLocal");
}

/**
 * Displace, then install (§6.4): rename whatever is at `path` into `displacedDir`, link the new bytes into place
 * (retrying when a foreign write lands in between), and return every displaced file Carton hasn't seen.
 */
export async function displaceInstall(path: string, bytes: Uint8Array, displacedDir: string): Promise<{ displaced: string[] }> {
  return todo("displaceInstall");
}

/** Write a shallow `.cbproj` export (never `.carton/` or `.scratch/views/`). */
export async function exportCbproj(local: LocalCarton, outPath: string, opts?: { to?: string; fullHistory?: boolean }): Promise<void> {
  return todo("exportCbproj");
}
export async function importCbproj(local: LocalCarton, inPath: string): Promise<{ status: string; cut?: string }> {
  return todo("importCbproj");
}
