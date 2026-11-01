// One machine with a Cardboard library (port of system-v11 `replica.mjs`): carton.db (SimStore: the real ReplicaQueue
// plus pins, notices, lease and views), the bundle's files, and the processes that share them:
//  - Worker: the library worker with the engine thread. Holds the sync lease while the app is open, serves
//    `carton.commit` on cardboard.sock, runs the materializer (shared timeline.tsx, per-agent views) and the GUI bridge.
//  - Helper: the detached headless-sync process `cb` starts when the app is closed (§6.2, R4-04).
//  - cb: one short process per call. It never pushes: it hands its change to the live lease holder, or starts a
//    helper (taking over at once from a holder that doesn't answer a 100 ms ping).
//  - Gui: the renderer store: debounced saves through the projection, adopt that moves the base atomically (H5).
// The sync client is the real one (`@carton/core` SyncClient) on the simulated network; only the machine is modelled.

import { createHash } from "node:crypto";
import { sync } from "@carton/core";
import type { Actor, ConfirmedChange, ConflictCard, Doc, Op, Policy } from "@carton/core";
import * as A from "./adapter.ts";
import { Proc, type Sim } from "./kernel.ts";
import { SimConn, type Link } from "./net.ts";
import { SimStore, type ViewMeta } from "./store.ts";
import type { World } from "./world.ts";

export const TIMELINE = "timeline.tsx";
export const viewPath = (n: string) => `.scratch/views/${n}.tsx`;
export const statusPath = (n: string) => `.scratch/views/${n}.status`;
export const TAKES = "takes";
const DAY = 86400e3;

export type SimActor = Actor & { machine?: string; osUser?: string; hooked?: boolean; windowless?: boolean; window?: string; undoOf?: string };
type Writer = typeof TAKES | { name: string; hooked?: boolean; actor?: SimActor };

/** Header (§5.2): `// cardboard:rev main@57~3f9a1c0e b:<branchId8> p:<printNonce> by <actor>`. */
export function render(ref: string, by: string, doc: Doc, nonce: string | null = null): string {
  return `// cardboard:rev ${ref}${nonce ? ` p:${nonce}` : ""} by ${by}\n${A.snapshot(doc)}\n`;
}
export function parse(content: string): { header: string; ref: string | null; nonce: string | null; doc: A.SimDoc } {
  const nl = content.indexOf("\n");
  const header = content.slice(0, nl);
  const m = /^\/\/ cardboard:rev (.+?)(?: p:([0-9a-f]+))? by (.*)$/.exec(header);
  return { header, ref: m?.[1] ?? null, nonce: m?.[2] ?? null, doc: JSON.parse(content.slice(nl + 1)) };
}
const parses = (content: string) => {
  try {
    parse(content);
    return true;
  } catch {
    return false;
  }
};
export const sha = (s: string) => createHash("sha256").update(s).digest("hex").slice(0, 16);

export interface SimFile {
  content: string;
  hash: string;
  len: number;
  mtime: number;
  writer: Writer;
}
export class Fs {
  readonly files = new Map<string, SimFile>();
  readonly watchers: ((path: string, f: SimFile) => void)[] = [];
  readonly log: { t: number; path: string; writer: string; hash: string }[] = [];
  readonly sim: Sim;
  constructor(sim: Sim) {
    this.sim = sim;
  }
  write(path: string, content: string, writer: Writer): SimFile {
    const f: SimFile = { content, hash: sha(content), len: content.length, mtime: this.sim.now, writer };
    this.files.set(path, f);
    this.log.push({ t: this.sim.now, path, writer: writer === TAKES ? TAKES : (writer?.name ?? String(writer)), hash: f.hash });
    for (const w of this.watchers) w(path, f);
    return f;
  }
  read(path: string): SimFile | undefined {
    return this.files.get(path);
  }
}

// ---------------------------------------------------------------- lease helpers (§6.2, R4-04, R5-06)
function takeLease(r: Replica, proc: Proc, socket: string, seenNonce: string | null) {
  return r.store.tx((s) => {
    if ((s.lease?.nonce ?? null) !== seenNonce) return null; // CAS: someone else got there first
    s.lease = { pid: proc.pid, nonce: r.sim.hex(16), socket, beat: r.sim.now };
    r.emit({ type: "lease", pid: proc.pid, kind: proc.kind, nonce: s.lease.nonce, from: seenNonce });
    return s.lease;
  });
}
function heartbeat(r: Replica, holder: { proc: Proc; nonce: string | null }) {
  const tick = () => {
    if (!holder.proc.alive) return;
    r.store.tx((s) => {
      if (s.lease?.nonce === holder.nonce) s.lease.beat = r.sim.now;
    });
    r.sim.after(2000, tick);
  };
  r.sim.after(2000, tick);
}

export type SimSync = sync.SyncClient & { log: { t: number; kind: string; ids?: string[]; n?: number }[]; stoppedAt?: number };
type Holder = Worker | Helper;
export interface SimEvent {
  type: string;
  t?: number;
  [k: string]: any;
}
type Waiter = (st: Record<string, any>) => void;

// ---------------------------------------------------------------- Replica
export class Replica {
  readonly world: World;
  readonly sim: Sim;
  readonly name: string;
  readonly machine: string;
  readonly osUser: string;
  readonly account: string;
  readonly installKey: string;
  /** The device credential (§6.3): the account plus a per-install key, shared by every process of this install. */
  readonly credential: string;
  readonly overlaps = new Map<string, Set<string>>();
  readonly warnings: { t: number; kind: string; track: string; pair: string[]; after: string }[] = [];
  /** Pending changes whose rebase left nothing to push. */
  /** `head`: the optimistic state just after it left the queue (an absorbed change without cards must be in it). */
  readonly absorbed: { t: number; id: string; author: SimActor; cards: number; withdrawn: boolean; head: Doc }[] = [];
  /** Per path, the content hashes Carton wrote or applied: anything else at a watched path is an unseen foreign save. */
  readonly seen = new Map<string, Set<string>>();
  link: Link;
  branchId: string;
  readonly store = new SimStore();
  readonly fs: Fs;
  readonly cbStartMs: number;
  readonly helperStartMs: number;
  readonly waitMs: number;
  readonly events: SimEvent[] = [];
  readonly listeners: ((e: SimEvent) => void)[] = [];
  /** Test hook: sees every store event before the replica reacts to it (the prototype's `store.listeners.unshift`). */
  readonly storeTaps: ((e: sync.QueueEvent) => void)[] = [];
  worker: Worker | null = null;
  readonly helpers: Helper[] = [];
  readonly stats = { cbCalls: 0, takeovers: 0 };
  /** Cards for the human: {changeId, author, cards}. */
  readonly cards: { changeId: string; author: SimActor; cards: { kind: string; path: string; [k: string]: unknown }[]; late?: boolean; rejected?: string; handedToHuman?: boolean }[] = [];
  private readonly waiters = new Map<string, Waiter[]>();
  // knobs the tests and P9 set
  rebaseMs = 20;
  pipeline = true;
  fence = true;

  constructor(world: World, o: { name: string; machine?: string; osUser?: string; account?: string; installKey?: string | null; link?: Link; branchId?: string; cbStartMs?: number; helperStartMs?: number; waitMs?: number }) {
    this.world = world;
    this.sim = world.sim;
    this.name = o.name;
    this.machine = o.machine ?? o.name;
    this.osUser = o.osUser ?? "user";
    this.account = o.account ?? `acct:${o.name}`;
    this.installKey = o.installKey ?? sha(`install:${o.name}`);
    this.credential = `${this.account}/${this.installKey}`;
    this.link = o.link ?? world.net.link({ rtt: 100 });
    this.branchId = o.branchId ?? "";
    this.fs = new Fs(this.sim);
    this.fs.watchers.push((path, f) => {
      if (f.writer === TAKES) this.markSeen(path, f.hash);
    });
    this.cbStartMs = o.cbStartMs ?? 60;
    this.helperStartMs = o.helperStartMs ?? 120;
    this.waitMs = o.waitMs ?? 5000;
    this.store.on((e) => this.onStore(e));
  }
  emit(ev: SimEvent): void {
    ev.t ??= this.sim.now;
    this.events.push(ev);
    for (const l of this.listeners) l(ev);
  }
  markSeen(path: string, hash: string): void {
    (this.seen.get(path) ?? this.seen.set(path, new Set()).get(path)!).add(hash);
  }
  get b(): string {
    return this.branchId;
  }
  /** With the app closed nobody watches the files; the `cb` holder still displaces-then-installs (§6.4). */
  headless(holder: Holder): MaterializerLike {
    if (this.worker?.materializer) return this.worker.materializer;
    holder.mz ??= new Materializer({ r: this, sim: this.sim, proc: holder.proc, onLocalCommit() {} }, { watch: "none", regenerateAfterSave: false });
    return holder.mz;
  }
  holderObj(): Holder | null {
    const L = this.store.lease;
    if (!L) return null;
    if (this.worker?.nonce === L.nonce && this.worker.proc.alive) return this.worker;
    return this.helpers.find((h) => h.nonce === L.nonce && h.proc.alive) ?? null;
  }
  newActor(o: Partial<SimActor> & { kind: SimActor["kind"]; id: string }): SimActor {
    return { machine: this.machine, osUser: this.osUser, ...o };
  }
  /** Open a connection for a process of this replica (the device credential of the install). */
  async connect(proc: Proc): Promise<SimConn> {
    const c = new SimConn(this.world.net, this.link, proc, { writer: this.name, credential: this.credential, account: this.account });
    const ok = await c.connect();
    if (!ok || !proc.alive) {
      c.close();
      throw new Error("connect failed");
    }
    // the open handler runs on the process's engine thread, as the prototype's did
    await new Promise<void>((res) => proc.engine.post(res));
    return c;
  }
  /** A real SyncClient for a lease holder (or R3-01's rogue process), on the simulated network and clock. */
  syncClient(holder: { proc: Proc }, nonce: string): SimSync {
    const proc = holder.proc;
    const log: SimSync["log"] = [];
    const client = new sync.SyncClient({
      queue: this.store,
      branchId: this.b,
      connect: () => this.connect(proc),
      schemaVersion: 1,
      maxBehind: this.world.maxBehind,
      pipeline: this.pipeline,
      backoffMs: 500,
      timers: this.sim.timers(),
      defer: (fn, cost) => {
        if (cost > 0) proc.engine.post(() => {}, cost); // the rebase holds the engine thread...
        proc.engine.post(fn); // ...then the resubmission
      },
      rebaseCostMs: this.rebaseMs,
      ...(this.fence ? { fence: () => this.store.lease?.nonce === nonce } : {}),
      adoptPayload: () => this.adoptPayload(),
      afterIntegrate: (res) => this.afterIntegrate(res),
      clock: () => this.sim.now,
      onEvent: (e) => {
        if (e.type === "push") log.push({ t: this.sim.now, kind: "push", ids: e.ids });
        else if (e.type === "rebase") log.push({ t: this.sim.now, kind: "rebase", n: e.n });
        else if (e.type === "stopped") client.stoppedAt = this.sim.now; // when it noticed (R5-06)
        else if (e.type === "online" || e.type === "offline" || e.type === "keyframe" || e.type === "shared" || e.type === "overwritten" || e.type === "error") this.emit({ ...e });
      },
    }) as SimSync;
    client.log = log;
    proc.onExit.push(() => client.stop("process exited"));
    return client.start() as SimSync;
  }
  adoptPayload(): Pick<sync.AdoptMsg, "rows" | "rec" | "doc0" | "closure"> {
    const br = this.store.branch(this.b);
    const n = br.sequencer.kind === "handingOff" ? br.sequencer.n : this.store.headSeq(this.b);
    const rows = this.store.rows(this.b).slice(0, n) as ConfirmedChange[];
    return {
      rows,
      rec: { id: br.id, name: br.name, forkOf: null, owner: this.name, kind: br.kind as "main", sequencer: { kind: "server", since: n } },
      doc0: this.store.confirmedState(this.b, 0),
      closure: this.closureFor(this.b),
    };
  }

  // ---- store events: wake the pusher, resolve waiters, notify GUI/materializer, sidecars, notices
  private onStore(e: sync.QueueEvent): void {
    for (const tap of this.storeTaps) tap(e);
    if (e.branchId !== this.b) return;
    // a commit joins the queue: the holder's SyncClient pushes it by itself (it listens for "pending" and pumps on
    // its engine thread, as the prototype's replica did for it)
    if (e.type === "pending") return;
    if (e.type === "local-confirmed") {
      this.softCheck([e.row]);
      this.emit({ type: "confirmed", id: e.row.id, seq: e.row.seq, latency: 0, sends: 0, author: e.row.author });
      return;
    }
    if (e.type === "confirmed") {
      const p = e.change;
      this.emit({ type: "confirmed", id: e.row.id, seq: e.row.seq, latency: this.sim.now - p.created, sends: p.sends, author: p.author });
      if (e.lateCards.length) this.lateCards(p, e.lateCards);
      const all = [...p.cards, ...e.lateCards];
      const st = all.length ? { status: "conflicts", seq: e.row.seq, conflicts: all.map(cardOf) } : { status: "confirmed", seq: e.row.seq };
      for (const w of this.waiters.get(p.id)?.splice(0) ?? []) w(st);
      if (p.meta.view) this.worker?.materializer?.writeStatus(p.meta.view as string, { ...st, ref: `${this.store.branch(this.b).name}@${e.row.seq}` }, p.id);
      return;
    }
    if (e.type === "remote") {
      this.worker?.onRemote(e.rows);
      return;
    }
    if (e.type === "absorbed") {
      // its effect is already in head, or its cards kept head's values; its cards reach the human and the actor
      const p = e.change;
      if (e.cards.length) this.lateCards(p, e.cards);
      this.absorbed.push({ t: this.sim.now, id: p.id, author: p.author as SimActor, cards: e.cards.length, withdrawn: e.withdrawn, head: this.store.optimistic(this.b).doc });
      const st = e.cards.length || p.cards.length ? { status: "conflicts", conflicts: [...p.cards, ...e.cards].map(cardOf), absorbed: true } : { status: "confirmed", absorbed: true };
      for (const w of this.waiters.get(p.id)?.splice(0) ?? []) w(st);
      if (p.meta.view) this.worker?.materializer?.writeStatus(p.meta.view as string, { ...st, ref: null }, p.id);
      this.emit({ type: "absorbed", id: p.id, author: p.author, cards: e.cards.length, withdrawn: e.withdrawn });
      return;
    }
    if (e.type === "rejected") {
      // the server's validation refused it (§4.4): dropped, never retried, and nobody is left unaware
      const p = e.change;
      const card = { kind: "rejected", path: p.id, note: e.reason };
      this.cards.push({ changeId: p.id, author: p.author as SimActor, cards: [card], rejected: e.reason });
      if (p.author?.kind !== "human") this.store.notice(p.author.id, { kind: "conflicts", changeId: p.id, cards: [card], text: `Your change ${p.id} was rejected: ${e.reason}` });
      for (const w of this.waiters.get(p.id)?.splice(0) ?? []) w({ status: "rejected", reason: e.reason, conflicts: [card] });
      this.emit({ type: "rejected", id: p.id, reason: e.reason });
      this.worker?.onRemote([]);
    }
  }
  /** §4.1: after applying confirmed changes, run the soft validators on the tracks they touched. */
  softCheck(rows: readonly ConfirmedChange[]): void {
    if (!rows.length) return;
    const doc = this.store.confirmedState(this.b, this.store.headSeq(this.b)) as A.SimDoc;
    const tracks = new Set<string>();
    for (const r of rows)
      for (const op of r.ops) {
        if (op.path[0] !== A.ITEMS) continue;
        const it = A.item(doc, String(op.path[1]));
        if (it) tracks.add(it.trackId);
        if (op.op === "insert" && op.path.length === 2 && (op.value as A.Item)?.trackId) tracks.add((op.value as A.Item).trackId);
      }
    for (const t of tracks) {
      const items = (doc[A.ITEMS] ?? []).filter((i) => i.trackId === t).sort((x, y) => x.startTime - y.startTime);
      const now = new Set<string>();
      for (let i = 0; i < items.length; i++) for (let j = i + 1; j < items.length && items[j]!.startTime < items[i]!.endTime - 1e-9; j++) now.add(`${items[i]!.id}|${items[j]!.id}`);
      const before = this.overlaps.get(t) ?? new Set();
      for (const p of now) if (!before.has(p)) this.warnings.push({ t: this.sim.now, kind: "overlap", track: t, pair: p.split("|"), after: rows.at(-1)!.id });
      this.overlaps.set(t, now);
    }
  }
  afterIntegrate(res: { mine: ConfirmedChange[]; others: ConfirmedChange[] }): void {
    this.softCheck([...res.mine, ...res.others].sort((x, y) => x.seq - y.seq));
  }
  /** Late conflicts from a rebase of the queue (§6.2): a notice for the actor, a card for the human. */
  lateCards(p: sync.QueuedChange, cards: ConflictCard[]): void {
    this.cards.push({ changeId: p.id, author: p.author as SimActor, cards: cards.map(cardOf), late: true });
    if (p.author?.kind !== "human") this.store.notice(p.author.id, { kind: "conflicts", changeId: p.id, cards, text: `Your change ${p.id} conflicted after your turn: ${cards.map((c) => c.path).join(", ")}` });
  }
  /** Ancestry closure for a hand-off (§5.3): other local branches, shallow (lineage nodes and their states only). */
  closureFor(b: string): sync.AdoptMsg["closure"] {
    const out: sync.AdoptMsg["closure"] = [];
    for (const id of this.store.branchIds()) {
      if (id === b) continue;
      const br = this.store.branch(id);
      const nodes = (br.lineage ?? []).map((n) => ({ id: `${id}@${n.seq}`, branchId: id, seq: n.seq, hash: A.hashDoc(this.store.confirmedState(id, n.seq)), kinds: [n.kind as "fork"], parents: [], state: this.store.confirmedState(id, n.seq) }));
      out.push({ branchId: id, rec: { id, name: br.name, forkOf: br.forkOf ? `${br.forkOf.branchId}@${br.forkOf.seq}` : null, owner: this.name, kind: br.kind as "variant", sequencer: { kind: "local" } }, nodes });
    }
    return out;
  }

  async startApp(opts: WorkerOptions = {}): Promise<Worker> {
    this.worker = new Worker(this, opts);
    await this.worker.start();
    return this.worker;
  }

  // ---- the `cb` process
  async cb(actor: SimActor, req: Record<string, any>, { retryOnReset = true }: { retryOnReset?: boolean } = {}): Promise<Record<string, any>> {
    const p = new Proc(this.world, "cb", `${this.name}/cb`);
    p.rid = this.sim.hex(24);
    this.stats.cbCalls++;
    const started = this.sim.now;
    await this.sim.sleep(this.cbStartMs);
    const id = req.write ? (req.id ?? p.nextId()) : null;
    let res: Record<string, any> | null = null;
    for (let attempt = 0; attempt < 6 && !res; attempt++) {
      let L = await this.liveHolder();
      if (!L) {
        const seen = this.store.lease?.nonce ?? null;
        const t0 = this.sim.now;
        const h = await Helper.spawn(this, seen);
        if (!h) continue;
        this.stats.takeovers += seen ? 1 : 0;
        this.emit({ type: seen ? "takeover" : "helper-start", from: seen, to: h.nonce, callStarted: started, ms: this.sim.now - t0 });
        L = this.store.lease!;
      }
      try {
        res = await this.world.ipc.request(L.socket, { type: "takes", req: { ...req, id }, actor }, { timeout: 20000 });
      } catch (e) {
        this.emit({ type: "cb-error", error: (e as Error).message });
        if ((e as Error).message === "ECONNRESET" && !retryOnReset) res = { status: "error", error: (e as Error).message, id };
      }
    }
    p.kill();
    return res ?? { status: "error", error: "no lease holder" };
  }
  /** A holder is live if it answers a ping with its nonce within 100 ms (the nonce guards against pid reuse). */
  async liveHolder(): Promise<{ pid: number; nonce: string; socket: string; beat: number } | null> {
    const L = this.store.lease;
    if (!L) return null;
    if (this.sim.now - L.beat > 6000) return null;
    try {
      const r = await this.world.ipc.request(L.socket, { type: "ping" }, { timeout: 100 });
      if (r?.nonce === L.nonce && this.store.lease?.nonce === L.nonce) return L;
    } catch {
      /* dead or hung */
    }
    this.emit({ type: "ping-failed", nonce: L.nonce });
    return null;
  }
  viewName(actor: SimActor, wanted?: string): string {
    if (actor.hooked && actor.id) return actor.id.replaceAll("/", "_");
    if (wanted) return wanted;
    for (;;) {
      const n = `agent-${this.sim.hex(4)}`;
      if (!this.store.views.has(n) && !this.fs.read(viewPath(n))) return n;
    }
  }
  changeOf(id: string): { p: sync.QueuedChange } | { row: sync.QueueRow } | null {
    const p = this.store.pending(this.b).find((x) => x.id === id);
    if (p) return { p };
    const row = this.store.rows(this.b).find((r) => r.id === id);
    return row ? { row } : null;
  }
  waitStatus(p: sync.QueuedChange, ms: number): Promise<Record<string, any>> {
    return new Promise((res) => {
      (this.waiters.get(p.id) ?? this.waiters.set(p.id, []).get(p.id)!).push(res);
      this.sim.after(ms, () => res({ status: p.cards.length ? "conflicts" : "pending", conflicts: p.cards.map(cardOf) }));
    });
  }
  /** Commit a change and, on a shared branch, wait up to waitMs for the server's answer (§6.2). */
  async commitAndWait(holder: Holder, actor: SimActor, id: string, ops: Op[], { intent = null, policy = "merge", meta = {}, cards = [] }: { intent?: sync.QueueVersion["intent"]; policy?: Policy; meta?: Record<string, unknown>; cards?: ConflictCard[] } = {}): Promise<Record<string, any>> {
    const known = this.changeOf(id);
    if (known) {
      // the same stable id again (a retried call): never a second change
      if ("row" in known) return { status: "confirmed", seq: known.row.seq, id };
      return { ...(await this.waitStatus(known.p, this.waitMs)), id };
    }
    const r = this.store.commit(this.b, { id, author: actor, ops, intent, policy, at: this.sim.now, meta });
    if (cards.length) this.cards.push({ changeId: id, author: actor, cards: cards.map(cardOf) });
    this.worker?.onLocalCommit(id, actor, meta);
    if (r.status === "confirmed") return { status: cards.length ? "conflicts" : "confirmed", seq: r.seq, id, conflicts: cards.map(cardOf) };
    const p = this.store.pending(this.b).find((x) => x.id === id)!;
    if (cards.length) p.cards.push(...cards);
    if (!holder.sync?.online) return { status: cards.length ? "conflicts" : "pending", id, conflicts: cards.map(cardOf) };
    return { ...(await this.waitStatus(p, this.waitMs)), id };
  }

  /** Requests from `cb` processes, run by the lease holder (worker or helper) on its engine thread. */
  async serveCb(holder: Holder, { req, actor }: { req: Record<string, any>; actor: SimActor }): Promise<Record<string, any>> {
    holder.touch?.();
    this.worker?.materializer?.onCb();
    const st = this.store, b = this.b;
    const notices = st.takeNotices(actor.id);
    if (holder.sync && !holder.sync.online) await holder.sync.whenCaughtUp(1500); // pull before print/apply
    const base = { notices, online: !!holder.sync?.online };
    switch (req.kind) {
      case "print": {
        if (this.worker?.materializer) return { ...base, ref: this.worker.materializer.printShared() };
        this.headless(holder).importUnseen(TIMELINE); // app closed: displace an unseen foreign save first
        const { ref, doc } = st.pinOptimistic(b, `turn:${actor.turn ?? actor.id}`, this.sim.now + 7 * DAY);
        this.fs.write(TIMELINE, render(ref, TAKES, doc, this.sim.hex(8)), TAKES);
        return { ...base, ref };
      }
      case "printView": {
        const name = this.viewName(actor, req.name);
        const owner = actor.hooked ? `turn:${actor.turn ?? actor.id}` : `view:${name}`;
        const mz = this.headless(holder);
        mz.importUnseen(viewPath(name)); // an unseen save (app closed) is applied before the re-print is rendered
        const { ref, doc } = st.pinOptimistic(b, owner, this.sim.now + 7 * DAY);
        // a fresh print nonce (§5.2): a save made from an earlier print never becomes the base for saves made from
        // this one, even when both prints show the same state
        const nonce = this.sim.hex(8);
        const content = render(ref, TAKES, doc, nonce);
        mz.displace(viewPath(name)); // a re-print over an unapplied save displaces it
        this.fs.write(viewPath(name), content, TAKES);
        st.views.set(name, { owner: actor.id ?? null, header: content.slice(0, content.indexOf("\n")), nonce, lastPin: null, printedAt: this.sim.now });
        return { ...base, name, path: viewPath(name), ref };
      }
      case "apply": {
        // cb source apply: the file's header ref is the base
        const parsed = parse(req.content);
        let r0;
        try {
          r0 = st.resolve(parsed.ref, this.sim.now);
        } catch (e) {
          return { ...base, status: "error", error: (e as Error).message };
        }
        const head = st.optimistic(b).doc;
        const m = A.merge3(r0.doc, head, parsed.doc, { oursRecorded: st.recordedSince(b, r0.causal) });
        const ops = A.diff(head, m.doc);
        return { ...base, ...(await this.commitAndWait(holder, actor, req.id, ops, { cards: m.conflicts })) };
      }
      case "ripple": {
        // a named action: records its remap intent (§7)
        const head = st.optimistic(b).doc;
        const a = A.rippleAction(head, req as never);
        return { ...base, ...(await this.commitAndWait(holder, actor, req.id, a.ops, { intent: a.intent })) };
      }
      case "ops": {
        const head = st.optimistic(b).doc;
        const ops = typeof req.ops === "function" ? req.ops(head) : req.ops;
        return { ...base, ...(await this.commitAndWait(holder, actor, req.id, ops, { policy: req.policy ?? "merge" })) };
      }
      case "status":
        return { ...base, pending: st.pending(b).length, head: st.headSeq(b) };
      default:
        return { ...base, status: "error", error: `unknown ${req.kind}` };
    }
  }
}
export const cardOf = (c: { kind: string; path: string; ours?: unknown; theirs?: unknown; note?: unknown; reason?: unknown }) => ({ kind: c.kind, path: c.path, ours: c.ours, theirs: c.theirs, note: c.note ?? c.reason });

// ---------------------------------------------------------------- Worker
export interface WorkerOptions {
  pingOn?: "engine" | "main";
  gui?: boolean;
  adoptMode?: "h5" | "stock" | "no-base-move";
  materialize?: boolean;
  materializer?: Partial<MaterializerOptions>;
  /**
   * Replace the materializer model with another implementation (cardboard-adapter's real Materializer runs the
   * file-level tests this way). It gets the worker (its replica, clock, processes) and the materializer options.
   */
  materializerFactory?: (worker: Worker, opts: Partial<MaterializerOptions>) => MaterializerLike;
  guiDebounceMs?: number;
  human?: SimActor | null;
}
/** What the worker and the replica call on a materializer (§6.4). The model below implements it. */
export interface MaterializerLike {
  start(): void;
  onHeadChange(cause: string): void;
  onCb(): void;
  hookRead(actor: SimActor): void;
  hookStop(actor: SimActor): void;
  printShared(): string;
  importUnseen(path: string): void;
  displace(path?: string): void;
  writeStatus(name: string, s: Record<string, any>, changeId?: string): void;
}

export class Worker {
  readonly r: Replica;
  readonly sim: Sim;
  readonly opts: Required<Omit<WorkerOptions, "human" | "materializerFactory">> & { human: SimActor | null };
  readonly proc: Proc;
  readonly socket: string;
  nonce: string | null = null;
  sync: SimSync | null = null;
  readonly syncs: SimSync[] = [];
  readonly window: string;
  /**
   * The materializer model, or a factory's implementation cast to it: the model's own counters (rewrites, displaced,
   * superseded…) exist only on the model, and the tests that read them use the model.
   */
  materializer: Materializer | null = null;
  gui: Gui | null = null;
  mz?: Materializer;
  reacquireMs?: number;
  private blocked?: Map<string, { changeId?: string; cards?: unknown[] }[]>;
  touch?: () => void;

  private readonly makeMaterializer: WorkerOptions["materializerFactory"];
  constructor(r: Replica, { pingOn = "engine", gui = true, adoptMode = "h5", materialize = true, materializer = {}, guiDebounceMs = 300, human = null, materializerFactory }: WorkerOptions = {}) {
    this.makeMaterializer = materializerFactory;
    this.r = r;
    this.sim = r.sim;
    this.opts = { pingOn, gui, adoptMode, materialize, materializer, guiDebounceMs, human };
    this.proc = new Proc(r.world, "worker", `${r.name}/worker`);
    this.proc.rid = this.sim.hex(24);
    this.socket = `${r.name}/cardboard.sock`;
    this.window = `${r.name}/window`;
  }
  async start(): Promise<void> {
    const pingThread = this.opts.pingOn === "engine" ? this.proc.engine : this.proc.main;
    this.r.world.ipc.listen(this.proc, this.socket, (m) => (m.type === "ping" ? pingThread : this.proc.engine), (m) => this.handle(m));
    await this.acquire();
    if (this.opts.materialize) {
      this.materializer = this.makeMaterializer ? (this.makeMaterializer(this, this.opts.materializer) as Materializer) : new Materializer(this, this.opts.materializer);
      this.materializer.start();
    }
    if (this.opts.gui) {
      this.gui = new Gui(this, { adoptMode: this.opts.adoptMode, debounceMs: this.opts.guiDebounceMs, human: this.opts.human });
      this.gui.start();
    }
  }
  handle(m: Record<string, any>): unknown {
    if (m.type === "ping") return { nonce: this.nonce };
    if (m.type === "takes") return this.r.serveCb(this, m as never);
    return { error: "unknown" };
  }
  /** Take the lease: at once if free or its holder is dead; from a live helper, by handover, never by waiting. */
  async acquire(): Promise<void> {
    const t0 = this.sim.now;
    for (let i = 0; i < 20; i++) {
      const L = this.r.store.lease;
      let got = null;
      if (!L) got = takeLease(this.r, this.proc, this.socket, null);
      else if (!(await this.r.liveHolder())) got = takeLease(this.r, this.proc, this.socket, L.nonce);
      else {
        this.r.emit({ type: "handover-request", to: L.nonce });
        try {
          await this.r.world.ipc.request(L.socket, { type: "handover" }, { timeout: 15000 });
        } catch {
          /* it exited */
        }
        continue;
      }
      if (got) {
        this.nonce = got.nonce;
        this.r.emit({ type: "worker-lease", ms: this.sim.now - t0 });
        heartbeat(this.r, this);
        this.startSync();
        return;
      }
    }
    throw new Error("worker could not take the lease");
  }
  startSync(): void {
    const br = this.r.store.branch(this.r.b);
    if (br.sequencer.kind === "local") return;
    const s = this.r.syncClient(this, this.nonce!);
    this.sync = s;
    this.syncs.push(s);
    const check = () => {
      // a fenced client stops; take the lease back by handover later
      if (!this.proc.alive) return;
      if (s.stopped && s.stopReason?.startsWith("fenced") && this.sync === s) {
        this.r.emit({ type: "worker-fenced" });
        this.sync = null;
        this.sim.after(this.reacquireMs ?? 2000, () => void this.acquire());
        return;
      }
      if (!s.stopped) this.sim.after(250, check);
    };
    this.sim.after(250, check);
  }
  // ---- GUI bridge
  guiCommit(ops: Op[], version: number, human: SimActor): { id: string; ops: Op[]; version: number; state: Doc; cards: unknown[] } {
    const st = this.r.store, b = this.r.b;
    const o = st.optimistic(b);
    let final = ops;
    if (version !== o.version) {
      // the save was made on an older state: merge it (the human's edit is the newest local intent)
      const baseState = st.statesByVersion.get(version)!;
      const m = A.merge3(baseState, o.doc, A.applyOps(baseState, ops), { prefer: "theirs" });
      final = A.diff(o.doc, m.doc);
    }
    // H2's client rule: lww only for plain leaf style edits; the queue turns any structure into merge
    const timing = final.some((op) => A.TIME.includes(String(op.path[2])) || op.path.length === 2);
    const id = this.proc.nextId();
    st.commit(b, { id, author: human, ops: final, policy: timing ? "merge" : "lww", at: this.sim.now, meta: { gui: true } });
    this.onLocalCommit(id, human, { gui: true });
    const n = st.optimistic(b);
    return { id, ops: final, version: n.version, state: n.doc, cards: [] };
  }
  onLocalCommit(id: string, actor: SimActor, meta: Record<string, unknown> = {}): void {
    this.materializer?.onHeadChange(meta?.gui ? "gui" : "local");
    if (!meta?.gui) this.gui?.notify("local", actor, id);
  }
  onRemote(rows: readonly ConfirmedChange[]): void {
    this.materializer?.onHeadChange("remote");
    this.gui?.notify("remote", null, null);
  }
  // ---- hooks (Claude Code PreToolUse / Stop / SubagentStop through Cardboard's hook)
  hookRead(actor: SimActor): void {
    this.materializer?.hookRead(actor);
  }
  stopHook(actor: SimActor, stopHookActive: boolean): { decision: "allow" | "block"; reason?: string; handedToHuman?: number } {
    this.materializer?.hookStop(actor);
    this.r.store.releasePins(`turn:${actor.turn ?? actor.id}`);
    this.blocked ??= new Map();
    if (stopHookActive) {
      // block at most once per conflict set; what the agent left unresolved becomes a human card
      const set = this.blocked.get(actor.id) ?? [];
      this.blocked.delete(actor.id);
      for (const n of set) this.r.cards.push({ changeId: n.changeId ?? "", author: actor, cards: (n.cards ?? []) as never, handedToHuman: true });
      return { decision: "allow", handedToHuman: set.length };
    }
    const fresh = this.r.store.peekNotices(actor.id).filter((n) => n.kind === "conflicts");
    if (!fresh.length) return { decision: "allow" };
    for (const n of fresh) n.delivered = true;
    this.blocked.set(actor.id, fresh);
    return { decision: "block", reason: fresh.map((n) => n.text).join("\n") };
  }
}

// ---------------------------------------------------------------- Helper (headless sync, app closed)
export class Helper {
  static async spawn(r: Replica, seenNonce: string | null): Promise<Helper | null> {
    await r.sim.sleep(r.helperStartMs);
    const h = new Helper(r);
    if (!h.start(seenNonce)) {
      h.proc.kill();
      return null;
    }
    r.helpers.push(h);
    return h;
  }
  readonly r: Replica;
  readonly sim: Sim;
  readonly proc: Proc;
  readonly socket: string;
  idleMs = 60000;
  lastUse: number;
  nonce: string | null = null;
  sync: SimSync | null = null;
  mz?: Materializer;
  constructor(r: Replica) {
    this.r = r;
    this.sim = r.sim;
    this.proc = new Proc(r.world, "helper", `${r.name}/helper`);
    this.proc.rid = this.sim.hex(24);
    this.socket = `${r.name}/helper-${this.proc.pid}.sock`;
    this.lastUse = this.sim.now;
  }
  start(seenNonce: string | null): boolean {
    const L = takeLease(this.r, this.proc, this.socket, seenNonce);
    if (!L) return false;
    this.nonce = L.nonce;
    this.r.world.ipc.listen(this.proc, this.socket, this.proc.engine, (m) => this.handle(m)); // pings on the engine thread
    const br = this.r.store.branch(this.r.b);
    if (br.sequencer.kind !== "local") this.sync = this.r.syncClient(this, this.nonce);
    heartbeat(this.r, this);
    this.idle();
    return true;
  }
  touch(): void {
    this.lastUse = this.sim.now;
  }
  private idle(): void {
    const tick = () => {
      if (!this.proc.alive) return;
      if (this.sync?.stopped) return void this.proc.kill(); // fenced: exit
      if (this.sim.now - this.lastUse >= this.idleMs) return void this.retire("idle");
      this.sim.after(1000, tick);
    };
    this.sim.after(1000, tick);
  }
  async handle(m: Record<string, any>): Promise<unknown> {
    if (m.type === "ping") return { nonce: this.nonce };
    if (m.type === "handover") {
      await this.retire("handover");
      return { ok: true };
    }
    if (m.type === "takes") return this.r.serveCb(this, m as never);
    return { error: "unknown" };
  }
  async retire(why: string): Promise<void> {
    this.sync?.quiesce();
    while (this.sync && !this.sync.drained() && this.proc.alive && !this.sync.stopped) await this.sim.sleep(5);
    this.r.store.tx((s) => {
      if (s.lease?.nonce === this.nonce) s.lease = null;
    });
    this.r.emit({ type: "helper-exit", why, nonce: this.nonce });
    this.sim.after(1, () => this.proc.kill());
  }
}

// ---------------------------------------------------------------- Materializer (§6.4)
export interface MaterializerOptions {
  /** Controls for the negative tests: v7's last-save base on the shared file (R7-01), v8's literal freeze view (R8-01),
   * v4's header base for per-agent views (R4-02), v9's "every save waits 150 ms of quiet". */
  sharedBase: "header" | "lastSave";
  regenerateAfterSave: boolean;
  freezeView: "accumulate" | "literal";
  viewBase: "lastSave" | "header";
  /** "every-event" reads the file on each watch event, `watchLatencyMs` after the write; "quiesce" waits for quiet. */
  watch: "every-event" | "quiesce" | "none";
  watchLatencyMs: number;
  rateLimitMs: number;
  localRewriteMs: number;
  quiesceMs: number;
  freezeIdleMs: number;
  displace?: boolean;
  viewKey?: "nonce" | "ref";
  passRecorded?: boolean;
}
interface PendingWrite {
  t: number;
  writer: Writer;
  f: SimFile;
}
interface MzHost {
  r: Replica;
  sim: Sim;
  proc: Proc;
  onLocalCommit(id: string, actor: SimActor, meta?: Record<string, unknown>): void;
}
export class Materializer {
  readonly w: MzHost;
  readonly r: Replica;
  readonly sim: Sim;
  readonly st: SimStore;
  readonly fs: Fs;
  readonly b: string;
  readonly opts: MaterializerOptions;
  readonly freeze: { hooked: Map<string, SimActor>; lastForeign: number; lastCb: number; active: boolean; view: Doc | null; since: number | null } = {
    hooked: new Map(),
    lastForeign: -Infinity,
    lastCb: -Infinity,
    active: false,
    view: null,
    since: null,
  };
  readonly rewrites: { t: number; cause: string; ref: string; frozen: boolean }[] = [];
  lastRemoteRewrite = -Infinity;
  remoteTimer = false;
  localTimer = false;
  sharedRef: string | null = null;
  lastSave: { header: string; state: Doc } | null = null;
  readonly applyTok = new Map<string, number>();
  readonly applied: { t: number; path: string; id: string; actor: string; cards: number; ops: number; hash: string; writtenAt: number }[] = [];
  readonly pendingWrite = new Map<string, PendingWrite>();
  readonly superseded: { t: number; path: string; lost?: string; by?: string; gapMs: number }[] = [];
  readonly displaced: { t: number; path: string; writer?: string; writtenAt: number }[] = [];
  readonly unparsed: { t: number; path: string; writer?: string; displaced?: boolean }[] = [];
  readonly overwritten: { t: number; path: string; writer?: string; writtenAt: number }[] = [];
  readonly held = new Map<string, PendingWrite[]>();
  readonly imported: { t: number; path: string; writer?: string; writtenAt: number }[] = [];

  constructor(w: MzHost, opts: Partial<MaterializerOptions> = {}) {
    this.w = w;
    this.r = w.r;
    this.sim = w.sim;
    this.st = w.r.store;
    this.fs = w.r.fs;
    this.b = w.r.b;
    this.opts = { sharedBase: "header", regenerateAfterSave: true, freezeView: "accumulate", viewBase: "lastSave", watch: "every-event", watchLatencyMs: 2, rateLimitMs: 30000, localRewriteMs: 20, quiesceMs: 150, freezeIdleMs: 60000, ...opts };
    if (this.opts.watch !== "none") this.fs.watchers.push((path, f) => this.onWrite(path, f));
  }
  get shared(): boolean {
    return this.st.branch(this.b).sequencer.kind !== "local";
  }
  start(): void {
    this.writeShared("start"); // writeShared imports a save made while the app was closed first
  }
  frozenNow(): boolean {
    return this.freeze.hooked.size > 0 || this.sim.now < Math.max(this.freeze.lastForeign, this.freeze.lastCb) + this.opts.freezeIdleMs;
  }
  updateFreeze(): void {
    const f = this.frozenNow();
    if (f && !this.freeze.active) {
      this.freeze.active = true;
      this.freeze.since = this.sim.now;
      this.freeze.view = this.sharedRef ? this.st.resolve(this.sharedRef, this.sim.now).doc : this.st.optimistic(this.b).doc;
      this.r.emit({ type: "freeze-start" });
    } else if (!f && this.freeze.active) {
      this.freeze.active = false;
      this.freeze.view = null;
      this.r.emit({ type: "freeze-end" });
      this.writeShared("freeze-end");
    }
    if (this.freeze.active && this.freeze.hooked.size === 0) {
      const end = Math.max(this.freeze.lastForeign, this.freeze.lastCb) + this.opts.freezeIdleMs;
      this.sim.at(end + 1, () => this.w.proc.main.post(() => this.updateFreeze()));
    }
  }
  hookRead(actor: SimActor): void {
    this.freeze.hooked.set(actor.id, actor);
    this.updateFreeze();
  }
  hookStop(actor: SimActor): void {
    if (this.freeze.hooked.delete(actor.id)) this.updateFreeze();
  }
  onCb(): void {
    this.freeze.lastCb = this.sim.now;
    this.updateFreeze();
  }
  /** R5-05: remote changes rewrite the shared file at most every 30 s while shared; local GUI edits promptly. */
  onHeadChange(cause: string): void {
    if (this.freeze.active) return;
    if (cause === "remote" && this.shared) {
      if (this.remoteTimer) return;
      this.remoteTimer = true;
      const at = Math.max(this.sim.now, this.lastRemoteRewrite + this.opts.rateLimitMs);
      this.sim.at(at, () =>
        this.w.proc.main.post(() => {
          this.remoteTimer = false;
          if (!this.freeze.active) this.writeShared("remote");
        }),
      );
      return;
    }
    if (this.localTimer) return;
    this.localTimer = true;
    this.sim.after(this.opts.localRewriteMs, () =>
      this.w.proc.main.post(() => {
        this.localTimer = false;
        if (!this.freeze.active) this.writeShared(cause);
      }),
    );
  }
  writeShared(cause: string): void {
    this.importUnseen(TIMELINE); // a save made while nobody watched is applied before the file is rendered
    const { ref, doc } = this.freeze.active ? this.st.pinState(this.b, this.freeze.view!, "shared-view", this.sim.now + 7 * DAY) : this.st.pinOptimistic(this.b, "shared-file", this.sim.now + 7 * DAY);
    if (cause === "remote") this.lastRemoteRewrite = this.sim.now;
    const cur = this.fs.read(TIMELINE);
    if (cur && parse(cur.content).ref === ref && cur.writer === TAKES) return; // unchanged
    const content = render(ref, TAKES, doc, this.sim.hex(8));
    this.sharedRef = ref;
    this.displace();
    this.fs.write(TIMELINE, content, TAKES);
    this.rewrites.push({ t: this.sim.now, cause, ref, frozen: this.freeze.active });
  }
  /** `cb source print` while the app is open: the file shows head, and a freeze view restarts from it. */
  printShared(): string {
    this.importUnseen(TIMELINE);
    if (this.freeze.active) this.freeze.view = this.st.optimistic(this.b).doc;
    const { ref, doc } = this.freeze.active ? this.st.pinState(this.b, this.freeze.view!, "shared-view", this.sim.now + 7 * DAY) : this.st.pinOptimistic(this.b, "shared-file", this.sim.now + 7 * DAY);
    this.sharedRef = ref;
    const cur = this.fs.read(TIMELINE);
    if (!(cur && cur.writer === TAKES && parse(cur.content).ref === ref)) {
      this.displace();
      this.fs.write(TIMELINE, render(ref, TAKES, doc, this.sim.hex(8)), TAKES);
      this.rewrites.push({ t: this.sim.now, cause: "print", ref, frozen: this.freeze.active });
    }
    return ref;
  }
  /**
   * Displace, then install (§6.4): before every Carton write to a watched path, a foreign save that hasn't been
   * applied yet is held outside the path's queue, so neither Carton's write nor a later write can replace it.
   */
  displace(path = TIMELINE): void {
    const p = this.pendingWrite.get(path);
    if (!p || this.opts.displace === false) return;
    this.displaced.push({ t: this.sim.now, path, writer: writerName(p.writer), writtenAt: p.t });
    this.pendingWrite.delete(path);
    this.applyTok.set(path, (this.applyTok.get(path) ?? 0) + 1); // its watch/quiet timers no longer apply it
    (this.held.get(path) ?? this.held.set(path, []).get(path)!).push(p);
    const wait = this.opts.watch === "quiesce" || !parses(p.f.content) ? this.opts.quiesceMs : this.opts.watchLatencyMs;
    this.sim.at(Math.max(this.sim.now, p.t + wait), () => this.flushHeld(path));
  }
  /** Held saves apply in the order they were written, before any later save of the same path (hole 1). */
  flushHeld(path: string): void {
    const list = this.held.get(path);
    if (!list?.length) return;
    this.held.delete(path);
    for (const p of list.sort((x, y) => x.t - y.t)) this.w.proc.engine.post(() => this.applySave(path, p.f));
  }
  /** A foreign save at a watched path that no watcher saw (app closed): applied before Carton writes the path. */
  importUnseen(path: string): void {
    const cur = this.fs.read(path);
    if (!cur || cur.writer === TAKES || this.pendingWrite.has(path) || this.r.seen.get(path)?.has(cur.hash)) return;
    this.imported.push({ t: this.sim.now, path, writer: writerName(cur.writer), writtenAt: cur.mtime });
    this.applySave(path, cur);
  }
  onWrite(path: string, f: SimFile): void {
    if (f.writer === TAKES) return;
    const isView = path.startsWith(".scratch/views/") && path.endsWith(".tsx");
    if (path !== TIMELINE && !isView) return;
    if (path === TIMELINE) {
      this.freeze.lastForeign = this.sim.now;
      this.updateFreeze();
    }
    // a second foreign write before the first was read replaces it on disk: writer against writer (L18)
    const prev = this.pendingWrite.get(path);
    if (prev && prev.writer !== f.writer) this.superseded.push({ t: this.sim.now, path, lost: writerName(prev.writer), by: writerName(f.writer), gapMs: this.sim.now - prev.t });
    this.pendingWrite.set(path, { t: this.sim.now, writer: f.writer, f });
    const tok = (this.applyTok.get(path) ?? 0) + 1;
    this.applyTok.set(path, tok);
    if (this.opts.watch === "quiesce") {
      this.sim.after(this.opts.quiesceMs, () => {
        if (this.applyTok.get(path) !== tok) return;
        const { f: quiet } = this.pendingWrite.get(path)!;
        this.pendingWrite.delete(path);
        this.flushHeld(path);
        this.w.proc.engine.post(() => this.applySave(path, quiet));
      });
      return;
    }
    this.sim.after(this.opts.watchLatencyMs, () => this.readEvent(path));
  }
  /** The watch event reads whatever is at the path now; content that doesn't parse yet waits for 150 ms of quiet. */
  readEvent(path: string): void {
    if (!this.pendingWrite.has(path)) return;
    const f = this.fs.read(path)!;
    if (f.writer === TAKES) {
      const p = this.pendingWrite.get(path)!;
      this.pendingWrite.delete(path);
      this.overwritten.push({ t: this.sim.now, path, writer: writerName(p.writer), writtenAt: p.t });
      return;
    }
    if (parses(f.content)) {
      this.pendingWrite.delete(path);
      this.flushHeld(path);
      this.w.proc.engine.post(() => this.applySave(path, f));
      return;
    }
    const tok = this.applyTok.get(path);
    this.sim.at(f.mtime + this.opts.quiesceMs, () => {
      if (this.applyTok.get(path) !== tok || !this.pendingWrite.has(path)) return;
      const q = this.fs.read(path)!;
      this.pendingWrite.delete(path);
      this.flushHeld(path);
      if (parses(q.content)) this.w.proc.engine.post(() => this.applySave(path, q));
      else {
        this.unparsed.push({ t: this.sim.now, path, writer: writerName(q.writer) });
        this.st.notice(this.actorOf(q, path).id, { kind: "error", text: `${path} doesn't parse; kept, not applied` });
      }
    });
  }
  actorOf(f: SimFile, path: string): SimActor {
    const w = f.writer;
    if (w !== TAKES && w?.hooked) return w.actor!;
    return this.r.newActor({ kind: "external", id: `external:${path === TIMELINE ? TIMELINE : path}`, name: w === TAKES ? TAKES : (w?.name ?? "unknown"), windowless: true });
  }
  applySave(path: string, f: SimFile = this.fs.read(path)!): void {
    this.r.markSeen(path, f.hash);
    let parsed: ReturnType<typeof parse>;
    try {
      parsed = parse(f.content);
    } catch {
      // a held partial (an in-place writer displaced mid-write) is kept and reported, never dropped silently (§6.4)
      this.unparsed.push({ t: this.sim.now, path, writer: writerName(f.writer), displaced: true });
      this.st.notice(this.actorOf(f, path).id, { kind: "error", text: `${path} (your save at ${f.mtime} ms) doesn't parse; kept, not applied` });
      return;
    }
    const actor = this.actorOf(f, path);
    const isShared = path === TIMELINE;
    const name = isShared ? null : path.slice(".scratch/views/".length, -4);
    const meta: ViewMeta | null | undefined = name ? this.st.views.get(name) : null;
    if (name && !meta) return void this.r.emit({ type: "ignored-view", path }); // never applied without a print (R5-03)
    let base: Doc;
    let causal: { seq: number; ids: string[] } | null = null;
    const fromHeader = () => {
      const r = this.st.resolve(parsed.ref, this.sim.now);
      causal = r.causal;
      return r.doc;
    };
    try {
      if (isShared) {
        base = this.opts.sharedBase === "lastSave" && this.lastSave && this.lastSave.header === parsed.header ? this.lastSave.state : fromHeader();
      } else {
        // R4-02 (per-agent views, one writer): the last applied save of the current print (same print nonce) is the base
        const key = (x: { ref: string | null; nonce: string | null }) => (this.opts.viewKey === "ref" ? x.ref : x.nonce);
        const cur = { ref: parse(meta!.header + "\n{}").ref, nonce: meta!.nonce };
        const samePrint = key(parsed) === key(cur) && meta!.lastPin && key(meta!.lastPin) === key(cur);
        if (this.opts.viewBase === "lastSave" && samePrint) ({ state: base, causal } = meta!.lastPin!);
        else base = fromHeader();
      }
    } catch (e) {
      this.st.notice(actor.id, { kind: "error", text: (e as Error).message });
      if (name) this.writeStatus(name, { status: "error", error: (e as Error).message, ref: parsed.ref });
      return;
    }
    const head = this.st.optimistic(this.b).doc;
    // the changes in head since this base, with their recorded remaps, are the concurrent side (§7)
    const m = A.merge3(base, head, parsed.doc, { oursRecorded: this.opts.passRecorded === false ? null : this.st.recordedSince(this.b, causal) });
    const ops = A.diff(head, m.doc);
    const cards = m.conflicts.map(cardOf);
    const id = this.w.proc.nextId();
    const res = this.st.commit(this.b, { id, author: actor, ops, at: this.sim.now, meta: { view: name, file: path } });
    if (cards.length) this.r.cards.push({ changeId: id, author: actor, cards });
    const p = this.st.pending(this.b).find((x) => x.id === id);
    if (p && cards.length) p.cards.push(...m.conflicts);
    this.applied.push({ t: this.sim.now, path, id, actor: actor.id, cards: cards.length, ops: ops.length, hash: f.hash, writtenAt: f.mtime });
    if (isShared) {
      this.lastSave = { header: parsed.header, state: parsed.doc };
      if (this.freeze.active) {
        // R8-01: the freeze view gathers every local agent's applied saves, each merged with that save's own base
        this.freeze.view = this.opts.freezeView === "literal" ? parsed.doc : A.merge3(base, this.freeze.view!, parsed.doc).doc;
      }
      // R7-01: regenerate after every applied save, with a new header ref
      if (this.opts.regenerateAfterSave) this.w.proc.main.post(() => this.writeShared("save"));
    } else {
      const k = (x: { ref: string | null; nonce: string | null }) => (this.opts.viewKey === "ref" ? x.ref : x.nonce);
      const c0 = causal as { seq: number; ids: string[] } | null;
      if (k(parsed) === k({ ref: parse(meta!.header + "\n{}").ref, nonce: meta!.nonce }))
        meta!.lastPin = { contentHash: f.hash, nonce: parsed.nonce, ref: parsed.ref, state: parsed.doc, causal: c0 ? { seq: c0.seq, ids: [...c0.ids, id] } : null };
      meta!.lastChange = id;
      // diagnostics as 1.4.0 prints them: hard problems in the content the agent saved, plus soft problems at head
      const mine = A.validate(parsed.doc), headDiag = A.validate(this.st.optimistic(this.b).doc);
      const diag = { hard: [...new Set([...mine.hard, ...headDiag.hard])], soft: headDiag.soft };
      const st = res.status === "confirmed" ? { status: cards.length ? "conflicts" : "confirmed", seq: res.seq } : { status: cards.length ? "conflicts" : "pending" };
      this.writeStatus(name!, { ...st, conflicts: cards, diagnostics: [...diag.hard, ...diag.soft], ref: this.st.pinOptimistic(this.b, `view:${name}`).ref }, id);
    }
    this.w.onLocalCommit(id, actor, {});
  }
  /** R5-04: `.scratch/views/<name>.status`, rewritten after each apply and whenever that change's state changes. */
  writeStatus(name: string, s: Record<string, any>, changeId?: string): void {
    const meta = this.st.views.get(name);
    if (meta?.lastChange && meta.lastChange !== changeId) return;
    const cur = this.fs.read(statusPath(name));
    const prev = cur ? JSON.parse(cur.content) : null;
    const body: Record<string, unknown> = { status: s.status, ref: s.ref ?? null, seq: s.seq ?? null, conflicts: s.conflicts ?? [], diagnostics: s.diagnostics ?? prev?.diagnostics ?? [], change: changeId ?? null, at: this.sim.now };
    if (s.error) body.error = s.error;
    this.fs.write(statusPath(name), JSON.stringify(body), TAKES);
  }
}
const writerName = (w: Writer): string | undefined => (w === TAKES ? TAKES : w?.name);

// ---------------------------------------------------------------- GUI (renderer store, H4/H5/H6)
export class Gui {
  readonly w: Worker;
  readonly r: Replica;
  readonly sim: Sim;
  readonly st: SimStore;
  readonly b: string;
  readonly adoptMode: "h5" | "stock" | "no-base-move";
  readonly debounceMs: number;
  readonly human: SimActor;
  readonly intended = new Map<string, unknown>();
  tok = 0;
  readonly saves: { t: number; id: string; saved: Map<string, unknown>; ops: Op[] }[] = [];
  readonly lost: { t: number; path: string; value: unknown }[] = [];
  readonly undo: { id: string | null; label: string; actor: string }[] = [];
  adopts = 0;
  readonly cards: Record<string, unknown>[] = [];
  readonly carded = new Map<string, unknown>();
  base!: { version: number; state: Doc };
  diffBase!: { version: number; state: Doc };
  doc!: A.SimDoc;
  constructor(w: Worker, { adoptMode = "h5", debounceMs = 300, human = null }: { adoptMode?: "h5" | "stock" | "no-base-move"; debounceMs?: number; human?: SimActor | null }) {
    this.w = w;
    this.r = w.r;
    this.sim = w.sim;
    this.st = w.r.store;
    this.b = w.r.b;
    this.adoptMode = adoptMode;
    this.debounceMs = debounceMs;
    this.human = human ?? this.r.newActor({ kind: "human", id: `human:${this.r.name}`, name: this.r.name, window: w.window });
  }
  start(): void {
    const o = this.st.optimistic(this.b);
    this.base = { version: o.version, state: o.doc };
    this.diffBase = this.base;
    this.doc = A.project(o.doc);
  }
  /** A human edit in the GUI: mutate the projected doc; `touched` = [[path, value]] it set. */
  edit(mutate: (d: A.SimDoc) => void, touched: [string, unknown][]): void {
    const d = A.clone(this.doc);
    mutate(d);
    this.doc = d;
    for (const [p, v] of touched) this.intended.set(p, v);
    const tok = ++this.tok;
    this.sim.after(this.debounceMs, () => {
      if (this.tok === tok) this.w.proc.main.post(() => this.save());
    });
  }
  save(): void {
    if (!this.intended.size) return;
    const ops = A.guiOps(this.diffBase.state, this.doc);
    const saved = new Map(this.intended);
    this.intended.clear();
    const version = this.adoptMode === "no-base-move" ? this.st.optimistic(this.b).version : this.base.version;
    const t = this.sim.now;
    this.w.proc.engine.post(() => {
      const res = this.w.guiCommit(ops, version, this.human);
      this.saves.push({ t, id: res.id, saved, ops: res.ops });
      this.undo.push({ id: res.id, label: "your edit", actor: this.human.id });
      this.sim.after(0.1, () =>
        this.w.proc.main.post(() => {
          this.adopt(res.state, res.version);
          this.diffBase = this.base;
        }),
      );
    });
  }
  /**
   * H5: remote (or local agent) ops go into the store, the unsaved edit is rebased on top like a pending change, and
   * the save base moves in the same step. A clash with the unsaved edit keeps head's value and becomes a card.
   */
  adopt(state: Doc, version: number): void {
    const m = A.merge3(A.project(this.base.state), A.project(state), this.doc);
    this.doc = m.doc;
    this.base = { version, state };
    this.adopts++;
    for (const c of m.conflicts) {
      this.cards.push({ t: this.sim.now, ...c });
      for (const p of [c.path, ...(c.related ?? [])])
        if (this.intended.has(p)) {
          this.carded.set(p, this.intended.get(p));
          this.intended.delete(p);
        }
    }
  }
  notify(kind: "local" | "remote", actor: SimActor | null, id: string | null): void {
    this.sim.after(0.2, () =>
      this.w.proc.main.post(() => {
        const o = this.st.optimistic(this.b);
        if (kind === "local" && actor && this.inGroup(actor)) this.undo.push({ id, label: `Undo ${actor.name}`, actor: actor.id });
        if (this.adoptMode === "stock") {
          // 1.4.0: cancelPendingSave, pushHistory, adopt the whole timeline
          if (this.intended.size) {
            this.lost.push(...[...this.intended].map(([p, v]) => ({ t: this.sim.now, path: p, value: v })));
            this.intended.clear();
            this.tok++;
          }
          this.undo.push({ id: null, label: "Timeline updated from disk", actor: "disk" });
          this.doc = A.project(o.doc);
          this.base = { version: o.version, state: o.doc };
          this.diffBase = this.base;
          return;
        }
        this.adopt(o.doc, o.version);
        if (this.adoptMode !== "no-base-move") this.diffBase = this.base;
      }),
    );
  }
  /**
   * §8 / R2-08: the actor group is you and agent turns from this window (the app's session), as stock Cardboard: a
   * terminal agent's edit (windowless, same machine) is not ⌘Z's to undo (the user's choice after the laptop test of
   * 90c4127; it used to be in the group).
   */
  inGroup(a: SimActor): boolean {
    if (a.id === this.human.id) return true;
    return !!(a.window && a.window === this.w.window);
  }
  /** ⌘Z: an inverse change at head (a revert), for the latest entry of the actor group. */
  cmdZ(): { id: string; reverted: string; label: string; cards: ConflictCard[] } | null {
    const e = [...this.undo].reverse().find((x) => x.id);
    if (!e) return null;
    this.undo.splice(this.undo.lastIndexOf(e), 1);
    const st = this.st, b = this.b;
    const row = st.rows(b).find((r) => r.id === e.id);
    let before: Doc, after: Doc;
    if (row) {
      before = st.confirmedState(b, row.seq - 1);
      after = st.confirmedState(b, row.seq);
    } else {
      const v = sync.last(st.versions.get(e.id!)!);
      before = v.baseDoc;
      after = A.applyOps(v.baseDoc, v.ops);
    }
    const head = st.optimistic(b).doc;
    const m = A.merge3(after, head, before);
    const ops = A.diff(head, m.doc);
    const id = this.w.proc.nextId();
    st.commit(b, { id, author: { ...this.human, undoOf: e.id! } as SimActor, ops, at: this.sim.now, meta: { gui: true, undo: e.id } });
    this.w.onLocalCommit(id, this.human, { gui: true });
    const o = st.optimistic(b);
    this.adopt(o.doc, o.version);
    this.diffBase = this.base;
    return { id, reverted: e.id!, label: e.label, cards: m.conflicts };
  }
}
