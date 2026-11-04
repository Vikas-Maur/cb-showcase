// Opening a project on this machine (§6.2): carton.db where §6.4 says it lives (store-sqlite's `openProjectStore`),
// Carton on it with the Cardboard adapter, and the routing of every write through the sync lease:
//   - a live lease holder (the app's engine thread, or a helper) → hand the write to it over its control socket;
//   - none, and the cut is shared or handing off → start a helper (headless sync), then hand it over;
//   - none, and the cut is local → commit here: the local sequencer is carton.db itself (CAS), nothing to push.
import { randomBytes } from "node:crypto";
import { hostname, userInfo } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Carton } from "@carton/core";
import type { Actor, CartonEvent, HostAdapter, OpenOptions } from "@carton/core";
import type { IdentitySource, Store } from "@carton/core/plugins";
import { openProjectStore } from "@carton/store-sqlite";
import type { SqliteStore } from "@carton/store-sqlite";
import { NO_HELPER, submit } from "./client.ts";
import { HOOK_NO_HELPER, hookUndelivered } from "./hook-send.ts";
import { readProjectId } from "./project-id.ts";
import { spawnHelper } from "./helper.ts";
import { Lease, LEASE_EXPIRY_MS, fence as leaseFence, readHelperRecipe } from "./lease.ts";
import { identify } from "./identity.ts";
import { nodeHasher } from "./hasher.ts";
import { destCut, IDEMPOTENT, runWrite, tellBusy, WAIT_MS, withRaceRetry } from "./writes.ts";
import type { CbResult, ViewPrinter, WriteOp, WriteRequest } from "./writes.ts";
import type { ShowTarget, Showing } from "@carton/cardboard/node";
import { viewNameFor } from "@carton/cardboard/node";
import { hookDelivered } from "./identity.ts";
import type { HolderEngine } from "./holder.ts";
import { followStore, noteGuiWrite } from "./follow.ts";
import { forwardSettles } from "./sidecars.ts";
import type { Follower } from "./follow.ts";
import { nudgeHolder } from "./client.ts";

/**
 * How long `cb compare --show` asks again when the app holds the project but its holder didn't answer, or a helper
 * holds it for a moment (open.ts `write`): the app's patient pings, then a lease taken back, fit in it.
 */
export const SHOW_ASK_MS = 4000;

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
  /**
   * A new project's first state. By default it is `main@1`, one insert-all change in history (§16 Migration: the
   * project's state when Carton started keeping its history, credited to core's import actor), so `cb history` and
   * credits show where it came from. `asChange: false` makes it the root state at `main@0` instead, with no change.
   */
  init?: { doc: unknown; cutName?: string; asChange?: boolean };
  /**
   * The engine factory a helper should run. A helper opens carton.db with its factory's adapter, which must be this
   * process's (the same rows hash differently under another schema; core refuses it at open). Default: the factory the
   * app recorded (`lease ["helper"]`), else this package's `factory.ts` (Cardboard's adapter) when this process uses
   * Cardboard's adapter too. A process with another adapter and no recorded factory must pass one.
   */
  helperFactory?: string;
  /** Extra factory config for helpers (server URL, token file…; never secrets). */
  helperConfig?: Record<string, unknown>;
  /**
   * This machine's display name in lineage, cut owners and a `.cbproj`'s sender ("Bob's main cut", §5.3, §13): the
   * app passes the person's name. Default: a person's own name when one opens it, else the OS user name (S3-1).
   */
  name?: string;
  /**
   * Sync for this process's own handle (Carton.open's `sync`): the app's library worker, whose handle is the lease
   * holder's engine, opens with `autoConnect: false` and connects under its nonce. Absent: the handle can read shared
   * cuts but hands every write on them to the lease holder.
   */
  sync?: OpenOptions["sync"];
}

export interface LocalCarton {
  readonly carton: Carton;
  readonly store: SqliteStore;
  readonly dbPath: string;
  /** The project (bundle) folder: per-agent views and their status files are inside it. */
  readonly projectDir: string;
  readonly lease: Lease;
  readonly actor: Actor;
  /**
   * Hand a write to the lease holder (or commit it here for a local-only cut). The cb result contract. `gui`: the
   * person's own action in the app (⌘Z), not a `cb` call: it doesn't freeze the shared timeline.tsx (WriteRequest).
   */
  write(op: WriteOp, opts?: { actor?: Actor; waitMs?: number; id?: string; gui?: boolean }): Promise<CbResult>;
  close(): Promise<void>;
}

// A `cb` process's change ids: one random 96-bit rid per process, `<rid>.<n>` (§5.1)
const RID = randomBytes(12).toString("hex");
let n = 0;
export const nextChangeId = (): string => `${RID}.${++n}`;

export { readProjectId };

async function defaultAdapter(): Promise<HostAdapter> {
  const m = await import("@carton/cardboard");
  return m.cardboardAdapter as HostAdapter;
}

/** The replica's display name (S3-1): the one given, a person's own name, or the OS user name; never "replica". */
export function replicaName(given: string | undefined, actor?: Actor): string {
  if (given) return given;
  if (actor?.kind === "human" && actor.name) return actor.name;
  try { return userInfo().username || hostname(); } catch { return hostname(); }
}

/** The adapter local's default factory opens carton.db with. */
const DEFAULT_ADAPTER = "cardboard";

export const defaultFactory = (): string => {
  const self = fileURLToPath(import.meta.url);
  return join(dirname(self), `factory${self.endsWith(".ts") ? ".ts" : ".js"}`);
};

export async function openLocal(opts: LocalOptions): Promise<LocalCarton> {
  const projectId = opts.projectId ?? readProjectId(opts.projectDir);
  const { store, location } = await openProjectStore({ bundleDir: opts.projectDir, projectId, appDataDir: opts.dataDir });
  const actor = !opts.actor ? identify() : "current" in opts.actor ? (opts.actor.current(process.env) ?? identify()) : opts.actor;
  const adapter = opts.adapter ?? (await defaultAdapter());
  const name = replicaName(opts.name, actor);
  let carton: Carton;
  try {
    carton = await Carton.open({ adapter, store, hasher: nodeHasher, actor, name, init: opts.init ? { doc: opts.init.doc as any, projectId, cutName: opts.init.cutName, asChange: opts.init.asChange ?? true } : undefined, ...(opts.sync ? { sync: opts.sync } : {}) });
  } catch (e) {
    await store.close();
    throw e;
  }
  // a project an older build left at its empty root gets its import in Carton.open (core, request 7: `d7b1f56`); the
  // import is a lineage point every copy of the project shares, carried by its `.cbproj`s (core, request 8: `1423f0d`)
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
    projectDir: opts.projectDir,
    lease,
    actor,
    async write(op, o = {}) {
      const req: WriteRequest = { id: o.id ?? nextChangeId(), actor: o.actor ?? actor, op, waitMs: o.waitMs ?? WAIT_MS, ...(o.gui === true ? { gui: true } : {}) };
      // whichever holder serves it, this process's follower knows its change as the person's own (no freeze)
      if (o.gui === true) noteGuiWrite(req.id);
      // a caller with no factory of its own starts what the app recorded (its materializer, its sync server: B3, B7);
      // its own helperConfig (`carton --server`) goes over the recipe's config
      const recipe = opts.helperFactory ? null : await readHelperRecipe(store).catch(() => null);
      // a helper runs this process's factory, never one with another adapter (R2-03): without a factory of its own or a
      // recorded one, only a process on Cardboard's adapter may start local's default
      const helperOk = !!(opts.helperFactory || recipe) || adapter.name === DEFAULT_ADAPTER;
      // a hook event is for a running holder's materializer: it never starts a helper (one would have nothing to freeze
      // or credit, and a hook runs before every tool call); with no holder answering, nobody is told
      const hook = op.kind === "hook";
      // opening a view in the editor needs the app's holder: never a helper (it has no pages to tell), and with no
      // holder answering, no window has the project open (Carton UX v2, `cb compare --show`)
      const show = op.kind === "open";
      const send = () => submit("carton.commit", req, {
        lease,
        // route by the cut the write changes (a fold's is `into`): a shared one needs the pusher
        // sharing starts the pusher, so it always runs on a lease holder (a helper when the app is closed)
        needsHelper: async () => !hook && (op.kind === "share" || (await needsHelper(destCut(op)))),
        ...(hook || show ? { noHelper: HOOK_NO_HELPER } : helperOk ? {} : { noHelper: `a helper would open this project with Cardboard's adapter, not "${adapter.name}": pass helperFactory` }),
        idempotent: IDEMPOTENT.has(op.kind),
        spawnHelper: (seen) => void spawnHelper({ dbPath, seen, factory: recipe?.factory ?? factory, config: { name, ...recipe?.config, projectDir: opts.projectDir, projectId, dataDir: opts.dataDir, ...opts.helperConfig } }),
      });
      let r = await send();
      if (hook && r.via === "error" && r.code === NO_HELPER) return hookUndelivered(op.event);
      if (show) {
        // Only the app's holder (the library worker, whose pages show the project) can open a view. While the lease says
        // the app holds this project but it didn't answer (busy a moment), or a helper holds it for the moment (the app
        // takes it back within ~2 s; a helper has no pages), it is asked again for a while: never "no editor window"
        // for an editor that has the project open (laptop: one ask in three said so)
        const appHolds = async () => {
          const row = (await lease.snapshot()).row;
          return !!row && row.kind === "worker" && Date.now() - row.heartbeat <= LEASE_EXPIRY_MS;
        };
        let busy = false;
        for (const end = Date.now() + SHOW_ASK_MS; !(r.via === "holder" && r.holder.kind === "worker") && Date.now() < end; ) {
          busy = r.via !== "holder" && (await appHolds());
          if (!busy && r.via !== "holder") break;
          await new Promise((ok) => setTimeout(ok, 200));
          r = await send();
        }
        if (r.via !== "holder") return { status: "confirmed", seq: 0, ref: null, notices: [], opened: 0, ...(busy ? { unanswered: true } : {}) };
      }
      if (r.via === "error") return { status: "error", error: r.error, notices: [], ...(r.code ? { code: r.code } : {}) };
      const out = r.via === "holder" ? (r.result as CbResult) : await withRaceRetry(IDEMPOTENT.has(op.kind), () => runWrite(carton, req));
      // written without the holder the probe found (it didn't answer, or its lease had expired): if it is alive after
      // all (the app's engine thread, busy for a moment), tell it to look at carton.db now (B11). Best effort, not
      // awaited: the app follows carton.db by itself within a poll
      const passed = r.passedOver;
      if (passed && !hook && ((out.status === "confirmed" && !out.empty) || out.status === "pending") && !(r.via === "holder" && r.holder.socketPath === passed.socketPath)) void nudgeHolder(passed.socketPath);
      return out;
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
export interface HolderEngineOptions {
  /** The app's materializer (project.json, the shared timeline.tsx, per-agent views). */
  materializer?: ViewPrinter | null;
  /**
   * Follow carton.db's current cut and head whoever writes it (B11): on by default when there is a materializer or an
   * `onExternal` listener. `intervalMs`: the poll (default FOLLOW_MS; 0: only on a nudge).
   */
  follow?: false | { intervalMs?: number };
  /** Another process moved this machine's head or switched its current cut (the app tells its pages). */
  onExternal?: (e: { type: "head" | "cut"; cut: string }) => void;
}

export class CartonHolderEngine implements HolderEngine {
  readonly carton: Carton;
  readonly materializer: ViewPrinter | null;
  private off: (() => void) | null = null;
  private follower: Follower | null = null;
  private unforward: (() => Promise<void>) | null = null;
  private cutQueue: Promise<unknown> = Promise.resolve();
  /** Cut switches one at a time: the ones this holder serves and the follower's adoption of another process's. */
  private cutLock<T>(f: () => Promise<T>): Promise<T> {
    const run = this.cutQueue.then(f, f);
    this.cutQueue = run.catch(() => {});
    return run;
  }
  constructor(carton: Carton, opts: HolderEngineOptions = {}) {
    this.carton = carton;
    this.materializer = opts.materializer ?? null;
    const mz = this.materializer;
    if (opts.follow !== false && (mz || opts.onExternal)) {
      // what the holder's own runWrite tells the materializer, for a write some other process made: a `cb` call
      // happened (its authors are active: a hooked agent until its Stop, anyone else for a while; tellBusy), and head
      // moved (or the current cut changed)
      this.follower = followStore(carton, (carton as unknown as { store: Store }).store, {
        intervalMs: opts.follow ? opts.follow.intervalMs : undefined,
        exclusive: (f) => this.cutLock(f),
        onHead: async (cut, authors) => {
          // no authors: only the person's own actions in the app, served by another holder (nobody at work); unknown
          // authors (undefined) count as someone at work
          if (!authors || authors.length) await tellBusy(mz, authors ?? []);
          if (mz?.onExternalHeadChange) await mz.onExternalHeadChange();
          else mz?.onHeadChange?.("local");
          opts.onExternal?.({ type: "head", cut });
        },
        // cardboard's materializer reads head itself (one read; nothing when it already shows it): told on every
        // other write too, so a pending change another process queued on a shared cut shows as well
        ...(mz?.onExternalHeadChange ? { onMoved: async () => void (await mz.onExternalHeadChange!()) } : {}),
        onCut: async (cut) => {
          if (mz?.onCutSwitch) await mz.onCutSwitch(cut);
          else mz?.onHeadChange?.("local");
          opts.onExternal?.({ type: "cut", cut });
        },
      });
    }
    // the server's answers to the views' `.status` sidecars on shared cuts (R5-04, B10; sidecars.ts)
    if (mz?.onChangeUpdate) this.unforward = forwardSettles(carton, (carton as unknown as { store: Store }).store, (v, id, u) => mz.onChangeUpdate!(v, id, u));
  }

  serve(req: unknown): Promise<unknown> {
    const r = req as WriteRequest;
    if (!r?.id || !r.actor || !r.op) return Promise.reject(Object.assign(new Error("bad carton.commit request"), { code: -32602 }));
    // the written cut connected (catching up or up to date): wait up to 5 s for the ack; not: pending at once (L14)
    const online = (cut?: string) => { const st = this.carton.sync?.state(cut).status; return st === "up-to-date" || st === "syncing"; };
    const run = () => withRaceRetry(IDEMPOTENT.has(r.op.kind), () => runWrite(this.carton, r, { online, materializer: this.materializer, viewName: (a, wanted) => this.viewName(a, wanted) }));
    if (r.op.kind !== "switch") return run();
    // told (the materializer printed it): the follower has nothing to tell about it. Switched but not told (it failed):
    // the follower finds the handle on a cut never announced and tells it at its next look
    return this.cutLock(async () => {
      const out = await run();
      if ((out as CbResult).status === "confirmed") this.follower?.served(this.carton.cut);
      return out;
    });
  }

  /** Hooked agents' views are named after their actor id; others get a fresh `agent-xxxx` (or the name they asked for). */
  private async viewName(actor: Actor, wanted?: string): Promise<string> {
    const store = (this.carton as unknown as { store: Store }).store;
    const taken = new Set((await store.range("views", { prefix: ["view"] })).map((r) => String(r.key[1])));
    return viewNameFor(actor, { hooked: hookDelivered(actor), wanted, taken: (n) => taken.has(n), random: () => randomBytes(2).toString("hex") });
  }

  async startSync(nonce: string, onFenced: () => void, fence: (nonce: string) => boolean): Promise<void> {
    const sync = this.carton.sync;
    if (!sync) return;
    this.off?.();
    this.off = this.carton.on((e: CartonEvent) => {
      if (e.type === "sync" && e.status === "stopped") onFenced();
    });
    // don't hold up the lease while the server is out of reach: cb writes answer `pending` until it is back. Settling
    // the server's answers is conditional on the lease in the store (the fence above is this holder's own knowledge,
    // refreshed by heartbeats): a holder replaced in between records nothing and stops
    void sync.connect({ nonce, fence, conditions: [leaseFence(nonce)] }).catch(() => {});
  }

  async quiesce(): Promise<void> {
    await this.carton.sync?.disconnect({ drain: true });
  }

  /** Look at carton.db now (a `cb` wrote without this holder). */
  async nudge(): Promise<void> {
    await this.follower?.check();
  }

  /**
   * `carton.shown` (apply-ryw): the shared timeline.tsx shows `target` (a `cb` write), answered once it does or within
   * `waitMs`. A write another process committed is looked for first, as a nudge would (the follower tells the
   * materializer who is at work, then that head moved), so the freeze takes in the writer's own change; then the
   * materializer's rewrite is made at once and the answer comes with the print that shows it. Null: no materializer.
   */
  async show(target: ShowTarget, waitMs: number): Promise<Showing | null> {
    const mz = this.materializer;
    if (!mz?.showChange) return null;
    // one deadline: the look at carton.db comes out of the wait, not on top of it (review #4)
    const t0 = Date.now(), end = t0 + waitMs;
    if (this.follower) {
      let timer: NodeJS.Timeout | null = null;
      await Promise.race([this.follower.check(), new Promise<void>((r) => { timer = setTimeout(r, waitMs); timer.unref?.(); })]);
      if (timer) clearTimeout(timer);
    }
    // (how long that look took goes with a slow answer's report: perf/apply-tail)
    return mz.showChange(target, Math.max(0, end - Date.now()), { beforeMs: Date.now() - t0 });
  }

  /** Stop following carton.db and forwarding answers (the engine is closing; the lease's stop() leaves both running: a
   * fenced app still shows the files). */
  async close(): Promise<void> {
    const f = this.follower, u = this.unforward;
    this.follower = null;
    this.unforward = null;
    // what is in progress finishes (bounded): nothing is switched, told or forwarded after close
    await Promise.race([Promise.all([f?.stop(), u?.()]), new Promise((r) => setTimeout(r, 5000).unref())]);
  }

  async stop(): Promise<void> {
    this.off?.();
    this.off = null;
    await (this.carton.sync as (null | { disconnect(o?: object): Promise<void> }))?.disconnect().catch(() => {});
  }
}

export type { Store };
