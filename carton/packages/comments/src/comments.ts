// `Comments`: a project's timecoded comments on top of an open Carton. It makes anchors on the Carton's versions,
// keeps comments in a CommentStore (default: the project's own carton.db / IndexedDB), shares them through the
// project's host when given `sync`, and places every thread on a version (`placements`).
//
// What people see is the server's rows (or, never shared, nothing) with this machine's pending patches applied on
// top, by the same rules the server applies (model.ts), so a refused patch is caught here first and the view never
// shows what the server would refuse. A pending patch stays in the store until the server answers it, so comments
// written offline, or before the project was ever shared, go up when it connects.

import { canonical, hashDoc, type Doc, type Lineage, type Person, type Schema, type StateRef } from "@carton/core";
import { makeAnchor, place, TimelineIndex, type AnchorOptions, type IndexChanges, type Placement } from "./anchor.ts";
import { cartonLineage, type LineageCarton, type LineageSource } from "./lineage.ts";
import { applyPatch, mergePatch, threadsOf, newCommentId, newOpId, patchProblem, validBody, type Thread } from "./model.ts";
import { cartonCommentStore, CommentStreamChanged, type CommentStore, type CommentWrite } from "./store.ts";
import { CommentSync, type CommentSyncOptions, type CommentSyncStatus } from "./sync.ts";
import type { Comment, CommentAuthor, CommentPatch, CommentRefusal, PendingPatch } from "./types.ts";

/** What `Comments` needs of a Carton (a `Carton` handle has all of it). */
export interface CommentsCarton extends LineageCarton {
  readonly schema: Schema;
  /** The current cut. */
  readonly cut: string;
  head(cut?: string): Promise<{ ref: StateRef; doc: Doc }>;
  checkout(ref: StateRef | string): Promise<Doc>;
  identity(): Person | null;
}

export interface CommentsOptions {
  carton: CommentsCarton;
  /** Where comments are kept (default: `cartonCommentStore(carton.store)`, beside the project's history). */
  store?: CommentStore;
  /** Share comments through the project's host: the same transport, URL and token as the project's own sync. */
  sync?: CommentSyncOptions;
  /** Who writes (default: the Carton's person, `carton.identity()`; else the generic person, "You"). */
  me?: CommentAuthor | (() => CommentAuthor);
  /** Host details for anchors (Cardboard: `{ media: "mediaItemId" }`). */
  anchor?: AnchorOptions;
  /**
   * The cut this session names to the host (default: the Carton's current cut). A watch-link or review-link session
   * names its Published cut: the host lets a scoped session name only its cuts.
   */
  cut?: () => string;
  /** Split lineage between versions (default: from the Carton). */
  lineage?: LineageSource;
  clock?: () => number;
}

export type CommentsEvent =
  | { type: "change" }
  /** The server refused a patch for good; the comment shows as the server has it. */
  | { type: "refused"; id: string; refused: CommentRefusal; reason: string }
  | { type: "sync"; status: CommentSyncStatus };

/** A patch refused here, before it was saved (the same rules the server applies). */
export class CommentError extends Error {
  readonly refused: CommentRefusal;
  constructor(refused: CommentRefusal, message: string) {
    super(message);
    this.name = "CommentError";
    this.refused = refused;
  }
}

/** A version to place comments on (its document and state hash). */
export interface CommentTarget {
  cut: string;
  seq: number;
  hash: string;
  doc: Doc;
}

const INDEXES = 3;
/** The generic person (core's PERSON): what wrote comments before the project had an identity. */
const PERSON = "person";
/** A thread with no anchor: on the whole project, the same object every time (views keep their identity). */
const GENERAL: Placement = Object.freeze({ status: "general", range: null, items: Object.freeze([]) as unknown as string[] });

function samePlacement(x: Placement, y: Placement): boolean {
  return x.status === y.status && x.why === y.why && x.guess === y.guess && x.range?.[0] === y.range?.[0] && x.range?.[1] === y.range?.[1] && x.items.length === y.items.length && x.items.every((v, i) => v === y.items[i]);
}

/** Could the changes between two versions move a thread placed on the first? */
function affected(memo: { p: Placement; deps: Set<string> }, a: { items?: { media?: string }[]; range?: [number, number] }, ch: IndexChanges): boolean {
  for (const id of ch.ids) if (memo.deps.has(id)) return true;
  for (const i of a.items ?? []) if (i.media !== undefined && ch.media.has(i.media)) return true;
  for (const r of [memo.p.range, a.range]) {
    if (!r) continue;
    for (const [s, e] of ch.spans) if (s <= r[1] + 1e-4 && e >= r[0] - 1e-4) return true;
  }
  return false;
}
const yieldNow = () => new Promise<void>((r) => setTimeout(r, 0));

export class Comments {
  readonly #carton: CommentsCarton;
  readonly #store: CommentStore;
  readonly #opts: CommentsOptions;
  readonly #clock: () => number;
  readonly #lineage: LineageSource;
  #sync: CommentSync | null = null;
  readonly #confirmed = new Map<string, Comment>();
  readonly #pending = new Map<string, PendingPatch>();
  readonly #view = new Map<string, Comment>();
  #head = 0;
  /** The stream generation the cached rows and head belong to (the store's, as last read or reset here). */
  #epoch = "";
  #rev = 0;
  #all: readonly Comment[] | null = null;
  #threads: readonly Thread[] | null = null;
  readonly #listeners = new Set<(e: CommentsEvent) => void>();
  /** Store writes and server answers, one at a time (they read-modify-write the maps). */
  #serial: Promise<unknown> = Promise.resolve();
  readonly #indexes = new Map<string, TimelineIndex>();
  /** Each thread's last placement: on which version, and the items it depends on there. */
  readonly #placed = new Map<string, { anchor: object; hash: string; p: Placement; deps: Set<string> }>();
  /** The version placed on last, so the next one compares only what changed (`TimelineIndex.changedSince`). */
  #last: { hash: string; index: TimelineIndex } | null = null;
  #closed = false;

  private constructor(opts: CommentsOptions) {
    this.#opts = opts;
    this.#carton = opts.carton;
    this.#store = opts.store ?? cartonCommentStore(opts.carton.store);
    this.#clock = opts.clock ?? (() => Date.now());
    this.#lineage = opts.lineage ?? cartonLineage(opts.carton);
  }

  static async open(opts: CommentsOptions): Promise<Comments> {
    const c = new Comments(opts);
    await c.#load();
    if (opts.sync) c.#startSync(opts.sync);
    return c;
  }

  // ------------------------------------------------------------ reading

  /** Goes up on every change people can see. */
  get revision(): number {
    return this.#rev;
  }

  /** Every comment as people see it (the server's, with this machine's pending patches on top). Same array until a change. */
  all(): readonly Comment[] {
    return (this.#all ??= [...this.#view.values()]);
  }

  get(id: string): Comment | undefined {
    return this.#view.get(id);
  }

  /** Threads, oldest first. Same array until a change. */
  threads(): readonly Thread[] {
    return (this.#threads ??= threadsOf(this.#view.values()));
  }

  /** Waiting for the server (written offline, or the project isn't shared). */
  isPending(id: string): boolean {
    return this.#pending.has(id);
  }

  /** How far comment sharing got; `null` without `sync`. */
  syncStatus(): CommentSyncStatus | null {
    return this.#sync?.status ?? null;
  }

  /** Who writes from here. */
  me(): CommentAuthor {
    const m = this.#opts.me;
    if (typeof m === "function") return m();
    if (m) return m;
    const p = this.#carton.identity();
    return p ? { id: p.id, name: p.name } : { id: "person", name: "You" };
  }

  on(listener: (e: CommentsEvent) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  // ------------------------------------------------------------ writing

  /**
   * A new thread on the current version of `cut` (default: the current cut), or on an older `version`, at `range`
   * (seconds; a moment when start equals end; absent: on the whole version).
   */
  async add(input: { body: string; range?: readonly [number, number]; cut?: string; version?: { cut: string; seq: number }; agent?: string }): Promise<Comment> {
    if (!validBody(input.body)) throw new CommentError("bad-request", "a comment needs some text, at most 10,000 characters");
    const t = input.version ? await this.#versionAt(input.version) : await this.#current(input.cut);
    const anchor = makeAnchor(t.doc, this.#carton.schema, { cut: t.cut, seq: t.seq, hash: t.hash }, input.range, { ...this.#opts.anchor, index: this.#index(t.hash, t.doc) });
    return this.#patch(newCommentId(), { add: { body: input.body, anchor, cut: t.cut, at: this.#clock() } }, input.agent);
  }

  /** A reply to a thread (`threadId`: its first comment; a reply's id answers its thread). */
  async reply(threadId: string, body: string, opts: { agent?: string } = {}): Promise<Comment> {
    const root = this.#view.get(threadId);
    const top = root?.replyTo !== undefined ? root.replyTo : threadId;
    const cut = this.#view.get(top)?.cut;
    if (cut === undefined) throw new CommentError("not-found", "the comment this replies to isn't there");
    return this.#patch(newCommentId(), { add: { replyTo: top, body, cut, at: this.#clock() } }, opts.agent);
  }

  /** Change a comment's text (its author only). */
  edit(id: string, body: string): Promise<Comment> {
    return this.#patch(id, { body });
  }

  /** Resolve a thread, or reopen it (`false`). */
  resolve(id: string, resolved = true): Promise<Comment> {
    const c = this.#view.get(id);
    return this.#patch(c?.replyTo ?? id, { resolved });
  }

  /** Delete a comment (its author only). Its replies stay. */
  async remove(id: string): Promise<void> {
    await this.#patch(id, { deleted: true });
  }

  // ------------------------------------------------------------ anchors

  /**
   * Where every thread sits on the head of `cut` (default: the current cut), by thread id. Incremental: a thread whose
   * anchor and target didn't change keeps its placement; the target's index is built once per version. With
   * `budgetMs`, it yields to the event loop whenever that much time has passed, so a big project never blocks a frame.
   */
  async placements(opts: { cut?: string; budgetMs?: number } = {}): Promise<ReadonlyMap<string, Placement>> {
    return this.placeOn(await this.#current(opts.cut), opts);
  }

  /**
   * Where every thread sits on `target` (a version the caller already has: the head it shows, a preview). Against the
   * version placed on last, only threads that a changed item could move are placed again: a changed item they follow
   * or sit on, a change overlapping where they sit, or a clip of their media.
   */
  async placeOn(target: CommentTarget, opts: { budgetMs?: number } = {}): Promise<ReadonlyMap<string, Placement>> {
    const index = this.#index(target.hash, target.doc);
    const last = this.#last;
    const changes = last && last.hash !== target.hash ? index.changedSince(last.index) : null;
    const incremental = !!changes && !changes.most && changes.spans.length <= 512;
    this.#last = { hash: target.hash, index };
    const out = new Map<string, Placement>();
    const lineages = new Map<string, Promise<Lineage | null>>();
    const budget = opts.budgetMs;
    let t0 = budget !== undefined ? performance.now() : 0;
    for (const th of this.threads()) {
      const a = th.root.anchor;
      const id = th.root.id;
      if (!a) {
        out.set(id, GENERAL);
        continue;
      }
      const memo = this.#placed.get(id);
      if (memo && memo.anchor === a) {
        if (memo.hash === target.hash || (incremental && memo.hash === last!.hash && !affected(memo, a, changes!))) {
          memo.hash = target.hash;
          out.set(id, memo.p);
          continue;
        }
      }
      let p = place(a, { index, hash: target.hash });
      const deps = new Set<string>(a.items?.map((i) => i.id));
      // only a thread that didn't land on its clips needs the lineage between its version and the target (a split
      // whose second piece got a new id): one that didn't land, or one placed by its media alone (another clip of the
      // same media may sit nearer than the piece lineage names); most never do, so most never read a change row
      if (((p.status !== "exact" && p.status !== "moved" && p.status !== "general") || p.guess) && a.items?.length) {
        const key = `${a.cut}@${a.seq}`;
        let lp = lineages.get(key);
        if (!lp) lineages.set(key, (lp = this.#lineage.lineage({ cut: a.cut, seq: a.seq }, { cut: target.cut, seq: target.seq }).catch(() => null)));
        const lineage = await lp;
        if (lineage && Object.keys(lineage).length) {
          p = place(a, { index, hash: target.hash }, lineage);
          for (const i of a.items) for (const x of lineage[i.id] ?? []) deps.add(x);
        }
      }
      for (const x of p.items) deps.add(x);
      // the same answer keeps the same object, so views built on it keep theirs
      if (memo && samePlacement(memo.p, p)) p = memo.p;
      this.#placed.set(id, { anchor: a, hash: target.hash, p, deps });
      out.set(id, p);
      if (budget !== undefined && performance.now() - t0 > budget) {
        await yieldNow();
        t0 = performance.now();
      }
    }
    return out;
  }

  // ------------------------------------------------------------ lifecycle

  /**
   * Read the store again (another process, such as `cb`, may have written comments to carton.db), and send what it
   * left pending. Comments that didn't change keep their objects.
   */
  async refresh(): Promise<void> {
    await this.#run(() => this.#load());
    this.#sync?.kick();
  }

  /** Resolves once every pending patch is answered and the stream is caught up (false after `timeoutMs`). */
  async settled(timeoutMs = 10_000): Promise<boolean> {
    if (!this.#sync) return this.#pending.size === 0;
    return this.#sync.settled(timeoutMs);
  }

  async close(): Promise<void> {
    this.#closed = true;
    await this.#sync?.stop();
    await this.#serial.catch(() => {});
    this.#listeners.clear();
  }

  // ------------------------------------------------------------ internals

  #emit(e: CommentsEvent): void {
    for (const l of [...this.#listeners]) {
      try {
        l(e);
      } catch {
        // a listener's error is its own
      }
    }
  }

  #changed(): void {
    this.#rev++;
    this.#all = null;
    this.#threads = null;
    this.#emit({ type: "change" });
  }

  #run<T>(fn: () => Promise<T>): Promise<T> {
    const r = this.#serial.then(fn, fn);
    this.#serial = r.catch(() => {});
    return r;
  }

  /** Read everything stored; on a reload, only what changed is rebuilt (the rest keep their objects). */
  async #load(): Promise<void> {
    const snap = await this.#store.load();
    // another handle reset the stream since: an id and seq may now be another comment's, so nothing cached is kept,
    // and the connection starts again from the store's position (what it would still send is the old stream's)
    const sameStream = snap.epoch === this.#epoch;
    this.#epoch = snap.epoch;
    if (!sameStream) this.#sync?.restart();
    const first = this.#view.size === 0 && this.#confirmed.size === 0 && this.#pending.size === 0;
    const changed = new Set<string>();
    const seen = new Set<string>();
    for (const c of snap.comments) {
      seen.add(c.id);
      const cur = this.#confirmed.get(c.id);
      if (sameStream && cur && cur.seq === c.seq && (cur.seq !== undefined || canonical(cur) === canonical(c))) continue;
      this.#confirmed.set(c.id, c);
      changed.add(c.id);
    }
    for (const id of [...this.#confirmed.keys()])
      if (!seen.has(id)) {
        this.#confirmed.delete(id);
        changed.add(id);
      }
    for (const id of this.#syncPending(snap.pending)) changed.add(id);
    this.#head = snap.head;
    if (first) this.#rebuild();
    else if (changed.size) this.#rebuild(changed);
  }

  /** The view of one comment: the confirmed row with its pending patch applied (if it applies). */
  #viewOf(id: string): Comment | undefined {
    const base = this.#confirmed.get(id);
    const p = this.#pending.get(id);
    if (!p) return base;
    const r = applyPatch(base, id, p.patch, p.patch.author, (x) => this.#view.get(x) ?? this.#confirmed.get(x), Number.MAX_SAFE_INTEGER);
    return r.ok ? r.row : base;
  }

  #rebuild(ids?: Iterable<string>): void {
    if (!ids) {
      this.#view.clear();
      // threads first, so a pending reply finds its pending thread
      const all = new Set([...this.#confirmed.keys(), ...this.#pending.keys()]);
      const order = [...all].sort((a, b) => Number(this.#isReply(a)) - Number(this.#isReply(b)));
      for (const id of order) {
        const v = this.#viewOf(id);
        if (v) this.#view.set(id, v);
      }
    } else
      // threads first, so a reply sees its thread as rebuilt
      for (const id of [...ids].sort((a, b) => Number(this.#isReply(a)) - Number(this.#isReply(b)))) {
        const v = this.#viewOf(id);
        if (v) this.#view.set(id, v);
        else this.#view.delete(id);
      }
    this.#changed();
  }

  #isReply(id: string): boolean {
    return (this.#confirmed.get(id)?.replyTo ?? this.#pending.get(id)?.patch.add?.replyTo) !== undefined;
  }

  #patch(id: string, change: Omit<CommentPatch, "at" | "author">, agent?: string): Promise<Comment> {
    return this.#run(async () => {
      if (this.#closed) throw new Error("comments: closed");
      const me = this.me();
      const author: CommentAuthor = agent ? { ...me, agent } : me;
      const full: CommentPatch = { ...change, at: this.#clock(), author };
      // the shape the server checks, before anything is stored: a patch it would refuse never waits here
      const bad = patchProblem(full);
      if (bad) throw new CommentError("bad-request", bad);
      for (let attempt = 0; attempt < 8; attempt++) {
        // the same rules as the server, on what people see now
        const check = applyPatch(this.#view.get(id), id, full, author, (x) => this.#view.get(x), this.#clock());
        if (!check.ok) throw new CommentError(check.refused, check.reason);
        if (!check.changed) return check.row;
        const prev = this.#pending.get(id) ?? null;
        // each version gets its own op id: the server applies an op once, so a version retried after its answer was
        // lost never undoes what came after it
        const row: PendingPatch = { id, patch: prev ? mergePatch(prev.patch, full) : full, v: (prev?.v ?? 0) + 1, op: newOpId() };
        if (await this.#store.write({ put: [{ row, prev }] })) {
          this.#pending.set(id, row);
          this.#rebuild([id]);
          this.#sync?.kick();
          return this.#view.get(id) ?? check.row;
        }
        // another process changed this comment's pending row (or sent it, and the server's row is stored now): take
        // what the store has of it and try again
        const parent = change.add?.replyTo;
        await this.#reloadPending(parent !== undefined ? [id, parent] : [id]);
      }
      throw new Error("comments: couldn't save (the comment kept changing in another process)");
    });
  }

  /** Read the pending rows again, and the stored rows of `rows` (a comment another process may have sent). */
  async #reloadPending(rows: readonly string[] = []): Promise<void> {
    const ids = new Set<string>();
    // pending first, then the rows: a comment another handle sends in between is in one or the other, never neither
    // (its row and the pending row's removal are one write)
    const pending = await this.#store.pending();
    if (rows.length) {
      const got = await this.#store.read(rows);
      rows.forEach((id, i) => {
        const r = got[i];
        const cur = this.#confirmed.get(id);
        if (r && (!cur || (cur.seq ?? -1) < (r.seq ?? -1))) {
          this.#confirmed.set(id, r);
          ids.add(id);
        }
      });
    }
    for (const id of this.#syncPending(pending)) ids.add(id);
    if (ids.size) this.#rebuild(ids);
  }

  /**
   * Write rows or the head of the stream this handle reads. If another handle reset the stream since (the store's
   * generation changed), take what the store has now and throw: the sync drops the connection and asks again from
   * the store's position.
   */
  async #writeStream(w: CommentWrite): Promise<boolean> {
    try {
      return await this.#store.write(w.reset !== undefined ? w : { ...w, epoch: this.#epoch });
    } catch (e) {
      if (e instanceof CommentStreamChanged) await this.#load();
      throw e;
    }
  }

  /** Take the stored pending rows; the ids whose row changed. */
  #syncPending(rows: readonly PendingPatch[]): string[] {
    const ids: string[] = [];
    const seen = new Set<string>();
    for (const r of rows) {
      seen.add(r.id);
      const cur = this.#pending.get(r.id);
      if (cur && cur.v === r.v && cur.op === r.op && canonical(cur.patch) === canonical(r.patch)) continue;
      this.#pending.set(r.id, r);
      ids.push(r.id);
    }
    for (const id of [...this.#pending.keys()])
      if (!seen.has(id)) {
        this.#pending.delete(id);
        ids.push(id);
      }
    return ids;
  }

  async #current(cut?: string): Promise<CommentTarget> {
    const { ref, doc } = await this.#carton.head(cut);
    return { cut: ref.branchId, seq: ref.seq, hash: ref.hash ?? hashDoc(doc, this.#carton.schema), doc };
  }

  async #versionAt(v: { cut: string; seq: number }): Promise<CommentTarget> {
    const doc = await this.#carton.checkout({ branchId: v.cut, seq: v.seq });
    return { cut: v.cut, seq: v.seq, hash: hashDoc(doc, this.#carton.schema), doc };
  }

  #index(hash: string, doc: Doc): TimelineIndex {
    let ix = this.#indexes.get(hash);
    if (ix) {
      // most recently used last
      this.#indexes.delete(hash);
      this.#indexes.set(hash, ix);
      return ix;
    }
    ix = new TimelineIndex(doc, this.#carton.schema, this.#opts.anchor);
    this.#indexes.set(hash, ix);
    while (this.#indexes.size > INDEXES) this.#indexes.delete(this.#indexes.keys().next().value!);
    return ix;
  }

  #startSync(opts: CommentSyncOptions): void {
    const self = this;
    this.#sync = new CommentSync(opts, {
      cut: () => self.#opts.cut?.() ?? self.#carton.cut,
      head: () => self.#head,
      // read fresh: `cb` (another process on the same carton.db) may have written comments meanwhile. Only this
      // person's patches go up (or the generic person's, written before an identity was set): a full-history .cbproj
      // copies the pending table, and the server would file someone else's unsent comment under this session.
      pending: () =>
        self.#run(async () => {
          await self.#reloadPending();
          const me = self.me().id;
          return [...self.#pending.values()].filter((p) => p.patch.author.id === me || p.patch.author.id === PERSON);
        }),
      // each only while its connection is still the sync's: a reload that saw another process's reset restarts it,
      // and what the old connection sent belongs to the stream before (a pending row left is sent again; its op id
      // makes that harmless)
      take: (rows, head, reset, current) => self.#run(async () => void (current() && (await self.#take(rows, head, reset)))),
      answered: (sent, row, head, current) => self.#run(async () => void (current() && (await self.#answered(sent, row, head)))),
      refused: (sent, refused, reason, current) => self.#run(async () => void (current() && (await self.#refused(sent, refused, reason)))),
      status: (s) => self.#emit({ type: "sync", status: s }),
    });
    this.#sync.start();
  }

  async #take(rows: readonly Comment[], head: number | null, reset: boolean): Promise<void> {
    const keep: Comment[] = [];
    const touched = new Set<string>();
    if (reset) {
      // the server's rows held here are another stream's: forget them (pending patches stay, and are sent again)
      for (const [id, c] of this.#confirmed) if (c.seq !== undefined) touched.add(id);
    }
    for (const r of rows) {
      const cur = reset ? undefined : this.#confirmed.get(r.id);
      if (cur?.seq !== undefined && r.seq !== undefined && cur.seq >= r.seq) continue;
      keep.push(r);
      touched.add(r.id);
    }
    const nextHead = head !== null && (reset || head > this.#head) ? head : null;
    if (!keep.length && nextHead === null && !reset) return;
    const kept = new Set(keep.map((k) => k.id));
    const forget = reset ? [...touched].filter((id) => !kept.has(id)) : [];
    // the store keeps the newer of what it has and these rows, and moves its head only forward (another handle on
    // the same carton.db may be ahead); a reset is written as one
    const epoch = reset ? newCommentId() : this.#epoch;
    await this.#writeStream({ rows: keep, ...(reset ? { reset: epoch } : {}), ...(nextHead !== null ? { head: nextHead } : {}) });
    this.#epoch = epoch;
    for (const id of forget) this.#confirmed.delete(id);
    for (const r of keep) this.#confirmed.set(r.id, r);
    if (nextHead !== null) this.#head = nextHead;
    if (touched.size) this.#rebuild(touched);
  }

  async #answered(sent: PendingPatch, row: Comment, head: number | null): Promise<void> {
    const cur = this.#confirmed.get(row.id);
    const newer = !(cur?.seq !== undefined && row.seq !== undefined && cur.seq > row.seq);
    const nextHead = head !== null && head > this.#head ? head : undefined;
    const base = { rows: newer ? [row] : [], ...(nextHead !== undefined ? { head: nextHead } : {}) };
    // the pending row goes only if nothing was added to it since it was sent; otherwise it is sent again
    if (!(await this.#writeStream({ ...base, drop: [sent] }))) {
      await this.#writeStream(base);
      await this.#reloadPending();
    } else if (this.#pending.get(sent.id)?.v === sent.v) this.#pending.delete(sent.id);
    if (newer) this.#confirmed.set(row.id, row);
    if (nextHead !== undefined) this.#head = nextHead;
    this.#rebuild([row.id]);
  }

  async #refused(sent: PendingPatch, refused: CommentRefusal, reason: string): Promise<void> {
    if (await this.#store.write({ drop: [sent] })) {
      if (this.#pending.get(sent.id)?.v === sent.v) this.#pending.delete(sent.id);
      this.#rebuild([sent.id]);
    } else await this.#reloadPending();
    this.#emit({ type: "refused", id: sent.id, refused, reason });
  }
}
