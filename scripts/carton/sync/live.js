// One shared project, live in the library worker (H8, PLAN §6.2, §12): the worker's own Carton handle is the sync
// lease holder's engine, so the History panel (fromCarton on the same handle) shows the status words, presence and
// absorbed cards with no plumbing of its own, and the worker's own saves are the holder's.
// - The holder is @carton/local's: `keepLease` runs a Holder of kind "worker" around `CartonHolderEngine(lc.carton)`.
//   It takes the lease (asking a headless helper to hand over first, §6.2), serves `cb` writes on its control socket,
//   connects sync under its nonce, and takes the lease back 2 s after being fenced. It is the project's View's
//   (views.js: the one holder per project, with the Materializer as its printer), and Live's own only when the project
//   has no View (its Materializer didn't start); then project.json follows here too.
// - Not on an engine thread (documented deviation from §6.2): the facade's handle lives on the worker's main loop,
//   so the holder's pings are answered there. A `cb` call that finds the main loop stalled past 100 ms takes over with
//   a helper; fencing stops this holder, and keepLease takes the lease back by handover. With the cut shared, cb hands
//   its writes to the holder, so the worker is carton.db's one writer and a stall is CPU, never a SQLite lock wait.
// - What other replicas confirm (and what cb writes through this holder) goes into project.json at once, and the
//   pages adopt it (H5's Carton path: no undo entry, the pending save goes first).
// - Status and presence also go to the pages as `{kind: "carton", id, topic: "live"}` events for the Share panel, with
//   why sync is failing when it is (core's `sync-error`, foundation's REQ-8: a host too old for this app, a refused
//   token, an unreachable host), in plain words, instead of "Syncing" for ever.
// - `onChange` (the worker shares clips added since) runs 2 s after the last change on the current cut.
import path from "node:path";
import { keepLease, holderSocketPath, CartonHolderEngine } from "@carton/local";

const MATERIALIZE_MS = 40;
const PEER_IDLE_MS = 30_000;
const ON_CHANGE_MS = 2000;

export class Live {
  constructor({ api, bundlePath, projectId, lc, log, onChange, view }) {
    this.onChange = onChange ?? null;
    this.view = view ?? null; // the project's View (views.js): its holder, and project.json follows there
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
    this.error = lc.carton.sync?.error?.() ?? null;
    this.stopped = false;
  }

  async start() {
    const { lc } = this;
    // Events first, so nothing the first connection brings is missed.
    this.off = lc.carton.on((e) => this.#event(e));
    if (this.view) {
      this.#publish();
      return;
    }
    const engine = new CartonHolderEngine(lc.carton);
    // A cb write this holder serves changes head: project.json follows, pending or confirmed (core says nothing until
    // the server answers, and offline that is never).
    const serve = engine.serve.bind(engine);
    engine.serve = async (req, ctx) => {
      await caughtUp(lc.carton);
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
      case "absorbed":
      case "notice":
        // A pending edit the server refused, or one a rebase emptied: head no longer has it, and project.json (and the
        // editor) must stop showing it. When the file already shows head, the facade writes nothing.
        if (e.type === "notice" || e.branchId === this.lc.carton.cut) this.#materializeSoon();
        this.status = this.lc.carton.sync?.state() ?? this.status;
        this.#publish();
        break;
      case "sync":
        this.status = this.lc.carton.sync?.state() ?? this.status;
        this.#publish();
        break;
      case "sync-error":
        if (e.branchId !== this.lc.carton.cut) break;
        this.error = e.error ?? null;
        if (this.error) this.log({ type: "sync-error", code: this.error.code, message: this.error.message });
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
    if (this.view) return this.view.materializeSoon();
    if (this.timer || this.stopped) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.api.materialize(this.projectId).catch((e) => this.log({ type: "materialize-failed", error: String(e?.message ?? e) }));
    }, MATERIALIZE_MS);
  }

  /** This handle is the lease holder right now (not fenced, not stopped): its own writes are the pusher's. */
  holds() {
    if (this.view) return !this.stopped && this.view.holds();
    const h = this.lease?.current;
    return !this.stopped && !!h && !h.stopped && !!h.nonce;
  }

  /** The state the Share panel shows. */
  view() {
    const now = Date.now();
    const peers = [...this.peers.values()].map((p) => ({ actor: p.actor, cut: p.cut, activity: p.activity, idle: now - p.at > PEER_IDLE_MS }));
    return { shared: true, status: this.status.status, pending: this.status.pending, label: this.status.label, holder: this.holds(), peers, problem: problemOf(this.error) };
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
    // the View's holder is the View's to stop
    await this.lease?.stop().catch(() => {});
  }
}

// Why sync is failing, in the words the Share panel shows (null when it isn't).
const PROBLEM = {
  "update-server": "The host is older than this app: it needs an update before this project can sync.",
  unauthorized: "The host refused this computer's access: ask for a new invite.",
  unreachable: "The host can't be reached. Edits wait here and go out when it can.",
  "unknown-cut": "The host doesn't have this project's cut.",
  "too-large": "A change is too big for this host.",
  server: "The host had a problem.",
};
export const problemOf = (err) => (err ? { code: err.code, words: PROBLEM[err.code] ?? PROBLEM.server, detail: err.message ?? null } : null);

export const actorKey = (a) => [a?.kind, a?.id, a?.agentId].filter(Boolean).join("/");

/**
 * "Before any print, the lease holder pulls" (§6.2): while the connection is (re)connecting or catching up, a holder
 * waits for it, up to `ms`, before it serves a call, so an agent never prints or edits a state older than the host's.
 * Up to date, offline or stopped: at once (offline it answers `pending`, as it should).
 */
export async function caughtUp(carton, ms = 3000) {
  const end = Date.now() + ms;
  for (;;) {
    const s = carton.sync?.state().status;
    if (!s || s === "up-to-date" || s === "offline" || s === "stopped" || Date.now() >= end) return s;
    await new Promise((r) => setTimeout(r, 25));
  }
}
