// Sending a hook event to the lease holder from a hook process (`carton hook …`, Cardboard's `cb carton-hook`; H8).
// A hook runs before every tool call, so this opens no engine: carton.db read-only for the lease row, then the holder's
// control socket. Never a helper (a helper's materializer would have nothing to freeze or credit), never a write to
// carton.db, never a carton.db made where a project has none. With no holder answering, nobody is told:
// `hook: {event, delivered: false}`. The holder runs it as any write (`runWrite`, WriteOp `hook`): once per request id.
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import type { Actor } from "@carton/core";
import { locateCartonDb, openSqliteStore } from "@carton/store-sqlite";
import { NO_HELPER, submit } from "./client.ts";
import type { HookEventKind, HookOp } from "./hooks.ts";
import { Lease } from "./lease.ts";
import { readProjectId } from "./project-id.ts";
import type { CbResult } from "./writes.ts";

/** Why a hook event starts no helper (submit's `noHelper`): it is answered as not delivered. */
export const HOOK_NO_HELPER = "a hook event never starts a helper: no holder is running to tell";

/** The answer for a hook event no materializer heard (no holder, or a holder without one). */
export const hookUndelivered = (event: HookEventKind): CbResult => ({ status: "confirmed", seq: 0, ref: null, notices: [], hook: { event, delivered: false } });

export interface SendHookOptions {
  /** The project (bundle) folder. */
  projectDir: string;
  /** Default: project.json's id. */
  projectId?: string;
  /** Cardboard's userData, where a carton.db kept off the bundle lives. */
  dataDir?: string;
  actor: Actor;
  op: HookOp;
  /** The request id (default: a fresh one); a retry with the same id is told once. */
  id?: string;
  /** How long to wait for the holder's answer (default 5 s: the agent's tool call waits on its hook). */
  callTimeoutMs?: number;
}

export async function sendHookEvent(o: SendHookOptions): Promise<CbResult> {
  const where = locateCartonDb({ bundleDir: o.projectDir, projectId: o.projectId ?? readProjectId(o.projectDir), appDataDir: o.dataDir, skipLinkProbe: true });
  // no carton.db: Carton isn't on for this project, so no holder is either
  if (!existsSync(where.dbPath)) return hookUndelivered(o.op.event);
  let store;
  try {
    store = await openSqliteStore(where.dbPath, { readOnly: true });
  } catch {
    return hookUndelivered(o.op.event); // nothing has it open (a WAL file can't be read without its -shm): no holder
  }
  try {
    const req = { id: o.id ?? `hook.${randomBytes(12).toString("hex")}`, actor: o.actor, op: o.op };
    const r = await submit("carton.commit", req, {
      lease: new Lease(store),
      needsHelper: async () => false,
      noHelper: HOOK_NO_HELPER,
      spawnHelper: () => {},
      idempotent: true,
      callTimeoutMs: o.callTimeoutMs ?? 5000,
    });
    if (r.via === "holder") return r.result as CbResult;
    if (r.via === "in-process" || r.code === NO_HELPER) return hookUndelivered(o.op.event);
    return { status: "error", error: r.error, notices: [], ...(r.code ? { code: r.code } : {}) };
  } finally {
    await store.close();
  }
}
