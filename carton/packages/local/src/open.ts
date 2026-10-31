// Opening a project on this machine (§6.2): carton.db where §6.4 says it lives (store-sqlite's `openProjectStore`),
// Carton on it with the Cardboard adapter, and the routing of every write through the sync lease:
//   - a live lease holder (the app's engine thread, or a helper) → hand the write to it over its control socket;
//   - none, and the cut is shared or handing off → start a helper (headless sync), then hand it over;
//   - none, and the cut is local → commit here: the local sequencer is carton.db itself (CAS), nothing to push.
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Carton } from "@carton/core";
import type { Actor, CartonEvent, HostAdapter } from "@carton/core";
import type { IdentitySource, Store } from "@carton/core/plugins";
import { openProjectStore } from "@carton/store-sqlite";
import type { SqliteStore } from "@carton/store-sqlite";
import { submit } from "./client.ts";
import { spawnHelper } from "./helper.ts";
import { Lease } from "./lease.ts";
import { identify } from "./identity.ts";
import { nodeHasher } from "./hasher.ts";
import { destCut, IDEMPOTENT, runWrite, WAIT_MS, withRaceRetry } from "./writes.ts";
import type { CbResult, ViewPrinter, WriteOp, WriteRequest } from "./writes.ts";
import { viewNameFor } from "@carton/cardboard/node";
import { hookDelivered } from "./identity.ts";
import type { HolderEngine } from "./holder.ts";

export interface LocalOptions {
  /** The project bundle directory (holds project.json). */
  projectDir: string;
  /** Cardboard's project id; read from project.json when absent. Keys carton.db in app data (L15). */
  projectId?: string;
  /** Where carton.db goes when the bundle is in a cloud-sync folder, on a network share or on FAT (default: app data). */
  dataDir?: string;
  /** Who acts by default (default: `identify()` from this process's environment). */
  actor?: Actor | IdentitySource;
  /** The host adapter (default: `@carton/cardboard`'s). */
  adapter?: HostAdapter;
  /** A new project's first state (`main@1`, one insert-all change, §16 Migration). */
  init?: { doc: unknown; cutName?: string };
  /** The engine factory a helper should run (default: this package's `factory.ts`). */
  helperFactory?: string;
  /** Extra factory config for helpers (server URL, token file…; never secrets). */
  helperConfig?: Record<string, unknown>;
}

export interface LocalCarton {
  readonly carton: Carton;
  readonly store: SqliteStore;
  readonly dbPath: string;
  readonly lease: Lease;
  readonly actor: Actor;
  /** Hand a write to the lease holder (or commit it here for a local-only cut). The cb result contract. */
  write(op: WriteOp, opts?: { actor?: Actor; waitMs?: number; id?: string }): Promise<CbResult>;
  close(): Promise<void>;
}

// A `cb` process's change ids: one random 96-bit rid per process, `<rid>.<n>` (§5.1)
const RID = randomBytes(12).toString("hex");
let n = 0;
export const nextChangeId = (): string => `${RID}.${++n}`;

export function readProjectId(projectDir: string): string {
  try {
    const p = JSON.parse(readFileSync(join(projectDir, "project.json"), "utf8"));
    if (typeof p.id === "string" && p.id) return p.id;
  } catch { /* no project.json: a non-Cardboard host */ }
  throw new Error(`no project id: ${join(projectDir, "project.json")} has none; pass projectId`);
}

async function defaultAdapter(): Promise<HostAdapter> {
  const m = await import("@carton/cardboard");
  return m.cardboardAdapter as HostAdapter;
}

export const defaultFactory = (): string => {
  const self = fileURLToPath(import.meta.url);
  return join(dirname(self), `factory${self.endsWith(".ts") ? ".ts" : ".js"}`);
};

export async function openLocal(opts: LocalOptions): Promise<LocalCarton> {
  const projectId = opts.projectId ?? readProjectId(opts.projectDir);
  const { store, location } = await openProjectStore({ bundleDir: opts.projectDir, projectId, appDataDir: opts.dataDir });
  const actor = !opts.actor ? identify() : "current" in opts.actor ? (opts.actor.current(process.env) ?? identify()) : opts.actor;
  const adapter = opts.adapter ?? (await defaultAdapter());
  let carton: Carton;
  try {
    carton = await Carton.open({ adapter, store, hasher: nodeHasher, actor, init: opts.init ? { doc: opts.init.doc as any, projectId, cutName: opts.init.cutName } : undefined });
  } catch (e) {
    await store.close();
    throw e;
  }
  const lease = new Lease(store);
  const dbPath = location.dbPath;
  const factory = opts.helperFactory ?? defaultFactory();
  const needsHelper = async (cut?: string) => {
    const cuts = await carton.cuts();
    const c = cuts.find((x) => x.id === (cut ?? carton.cut));
    return !!c && c.sequencer.kind !== "local";
  };
  return {
    carton,
    store,
    dbPath,
    lease,
    actor,
    async write(op, o = {}) {
      const req: WriteRequest = { id: o.id ?? nextChangeId(), actor: o.actor ?? actor, op, waitMs: o.waitMs ?? WAIT_MS };
      const r = await submit("carton.commit", req, {
        lease,
        // route by the cut the write changes (a fold's is `into`): a shared one needs the pusher
        needsHelper: () => needsHelper(destCut(op)),
        idempotent: IDEMPOTENT.has(op.kind),
        spawnHelper: (seen) => void spawnHelper({ dbPath, seen, factory, config: { projectDir: opts.projectDir, projectId, dataDir: opts.dataDir, ...opts.helperConfig } }),
      });
      if (r.via === "holder") return r.result as CbResult;
      if (r.via === "in-process") return withRaceRetry(IDEMPOTENT.has(op.kind), () => runWrite(carton, req));
      return { status: "error", error: r.error, notices: [], ...(r.code ? { code: r.code } : {}) };
    },
    async close() {
      await carton.close();
      await store.close();
    },
  };
}

/**
 * The engine a lease holder runs (helper or engine thread): writes through `runWrite`, and, on shared cuts, the sync
 * client started under the lease nonce, quiesced on handover, stopped when fenced.
 */
export class CartonHolderEngine implements HolderEngine {
  readonly carton: Carton;
  readonly materializer: ViewPrinter | null;
  private off: (() => void) | null = null;
  constructor(carton: Carton, opts: { materializer?: ViewPrinter | null } = {}) {
    this.carton = carton;
    this.materializer = opts.materializer ?? null;
  }

  serve(req: unknown): Promise<unknown> {
    const r = req as WriteRequest;
    if (!r?.id || !r.actor || !r.op) return Promise.reject(Object.assign(new Error("bad carton.commit request"), { code: -32602 }));
    return withRaceRetry(IDEMPOTENT.has(r.op.kind), () => runWrite(this.carton, r, { online: () => this.carton.sync?.status === "up-to-date", materializer: this.materializer, viewName: (a, wanted) => this.viewName(a, wanted) }));
  }

  /** Hooked agents' views are named after their actor id; others get a fresh `agent-xxxx` (or the name they asked for). */
  private async viewName(actor: Actor, wanted?: string): Promise<string> {
    const store = (this.carton as unknown as { store: Store }).store;
    const taken = new Set((await store.range("views", { prefix: ["view"] })).map((r) => String(r.key[1])));
    return viewNameFor(actor, { hooked: hookDelivered(actor), wanted, taken: (n) => taken.has(n), random: () => randomBytes(2).toString("hex") });
  }

  async startSync(nonce: string, onFenced: () => void): Promise<void> {
    const sync = this.carton.sync as (null | { connect(o?: { nonce: string }): Promise<void> });
    if (!sync) return;
    this.off?.();
    this.off = this.carton.on((e: CartonEvent) => {
      if (e.type === "sync" && (e.status as string) === "stopped") onFenced();
    });
    await sync.connect({ nonce });
  }

  async quiesce(): Promise<void> {
    const sync = this.carton.sync as (null | { disconnect(o?: { drain?: boolean }): Promise<void> });
    await sync?.disconnect({ drain: true });
  }

  async stop(): Promise<void> {
    this.off?.();
    this.off = null;
    await (this.carton.sync as (null | { disconnect(o?: object): Promise<void> }))?.disconnect().catch(() => {});
  }
}

export type { Store };
