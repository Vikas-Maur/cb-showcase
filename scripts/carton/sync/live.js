// One shared project, live in the library worker (H8, PLAN §6.2, §12): the worker's own Carton handle is the sync
// lease holder's engine, so the History panel (fromCarton on the same handle) shows the status words, presence and
// absorbed cards with no plumbing of its own, and the worker's own saves are the holder's.
// - The holder is @carton/local's: `keepLease` runs a Holder of kind "worker" around `CartonHolderEngine(lc.carton)`.
//   It takes the lease (asking a headless helper to hand over first, §6.2), serves `cb` writes on its control socket,
//   connects sync under its nonce, and takes the lease back 2 s after being fenced.
// - Not on an engine thread (documented deviation from §6.2): the facade's handle lives on the worker's main loop,
//   so the holder's pings are answered there. A `cb` call that finds the main loop stalled past 100 ms takes over with
//   a helper; fencing stops this holder, and keepLease takes the lease back by handover. With the cut shared, cb hands
//   its writes to the holder, so the worker is carton.db's one writer and a stall is CPU, never a SQLite lock wait.
// - What other replicas confirm (and what cb writes through this holder) goes into project.json at once, and the
//   pages adopt it (H5's Carton path: no undo entry, the pending save goes first).
// - Status and presence also go to the pages as `{kind: "carton", id, topic: "live"}` events for the Share panel.
// - `onChange` (the worker shares clips added since) runs 2 s after the last change on the current cut.
import path from "node:path";
import { keepLease, holderSocketPath, CartonHolderEngine } from "@carton/local";

const MATERIALIZE_MS = 40;
const PEER_IDLE_MS = 30_000;
const ON_CHANGE_MS = 2000;

export class Live {
  constructor({ api, bundlePath, projectId, lc, log, onChange }) {
    this.onChange = onChange ?? null;
    this.changeTimer = null;
    this.api = api;
    this.bundlePath = bundlePath;
    this.projectId = projectId;
    this.lc = lc;
    this.log = log ?? (() => {});
    this.lease = null;
    this.off = null;
    this.timer = null;
    this.peers = new Map(); // actor key → {actor, cut, activity, at}
    this.status = lc.carton.sync?.state() ?? { status: "offline", pending: 0, label: "Offline" };
    this.stopped = false;
  }

  async start() {
    const { lc } = this;
    // Events first, so nothing the first connection brings is missed.
    this.off = lc.carton.on((e) => this.#event(e));
    const engine = new CartonHolderEngine(lc.carton);
    // A cb write this holder serves changes head: project.json follows, pending or confirmed (core says nothing until
    // the server answers, and offline that is never).
    const serve = engine.serve.bind(engine);
    engine.serve = async (req, ctx) => {
      try { return await serve(req, ctx); } finally { this.#materializeSoon(); }
    };
    this.lease = keepLease(() => ({
      lease: lc.lease,
      engine,
      kind: "worker",
      socketPath: holderSocketPath(path.dirname(lc.dbPath), "worker"),
      log: (e) => this.log({ project: this.projectId, ...e }),
    }));
    await this.lease.start();
    // What the first connection caught up on (and anything this handle had pending) into project.json; a no-op when
    // the file already shows head.
    this.#materializeSoon();
    this.#publish();
  }

  #event(e) {
    switch (e.type) {
      case "change":
        // A change confirmed on the cut the app shows (another replica's, one cb made through this holder, or this
        // handle's own once the host answers): head into the file. When the file shows head already, the facade
        // writes nothing.
        if (e.branchId === this.lc.carton.cut) {
          this.#materializeSoon();
          if (this.onChange && !this.stopped) {
            clearTimeout(this.changeTimer);
            this.changeTimer = setTimeout(() => {
              this.changeTimer = null;
              Promise.resolve().then(this.onChange).catch((err) => this.log({ type: "on-change-failed", error: String(err?.message ?? err) }));
            }, ON_CHANGE_MS);
            this.changeTimer.unref?.();
          }
        }
        break;
      case "sync":
        this.status = this.lc.carton.sync?.state() ?? this.status;
        this.#publish();
        break;
      case "presence": {
        // `who` is the person behind it, as the sender knows them (their account on the host): the handle's own actor
        // is fixed when it opens, which for the sharer was before the share.
        // Peers are kept by the sender's handle actor, which a `null` (stopped) also carries.
        const key = actorKey(e.actor);
        if (e.state) this.peers.set(key, { actor: e.state.who?.id ? { kind: "human", ...e.state.who } : e.actor, cut: e.branchId, activity: e.state.activity ?? null, at: Date.now() });
        else this.peers.delete(key);
        this.#publish();
        break;
      }
    }
  }

  #materializeSoon() {
    if (this.timer || this.stopped) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.api.materialize(this.projectId).catch((e) => this.log({ type: "materialize-failed", error: String(e?.message ?? e) }));
    }, MATERIALIZE_MS);
  }

  /** This handle is the lease holder right now (not fenced, not stopped): its own writes are the pusher's. */
  holds() {
    const h = this.lease?.current;
    return !this.stopped && !!h && !h.stopped && !!h.nonce;
  }

  /** The state the Share panel shows. */
  view() {
    const now = Date.now();
    const peers = [...this.peers.values()].map((p) => ({ actor: p.actor, cut: p.cut, activity: p.activity, idle: now - p.at > PEER_IDLE_MS }));
    return { shared: true, status: this.status.status, pending: this.status.pending, label: this.status.label, holder: this.holds(), peers };
  }
  #publish() {
    this.api.emit({ kind: "carton", id: this.projectId, topic: "live", live: this.view() });
  }

  /** The person's presence (the pages send it at most once a second while they edit, null when idle). */
  presence(state, who) {
    this.lc.carton.sync?.presence(state ? { ...state, ...(who ? { who } : {}) } : null);
  }

  async stop() {
    this.stopped = true;
    clearTimeout(this.timer);
    clearTimeout(this.changeTimer);
    this.off?.();
    await this.lease?.stop().catch(() => {});
  }
}

export const actorKey = (a) => [a?.kind, a?.id, a?.agentId].filter(Boolean).join("/");
