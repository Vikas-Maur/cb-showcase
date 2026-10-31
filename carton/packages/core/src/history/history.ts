// History: one replica's cuts, changes, versions, pins and DAG, in memory and synchronous (PLAN §5, §8, §13).
// Port of the verified core-v5 prototype `Replica` (`proofs/core-v5/history.mjs`), with §0.1 names (cut, fold in,
// credits, restore) and what the prototype left out: pins with owner sets (system proof Finding 4), print nonces in
// headers (Finding 3), undo by actor group (§8), restore, named versions and the log. Each writable cut has a local
// sequencer running the shared §6.1 rule (`../sequencer`); `Carton` persists all of it through a Store.

import type { Schema } from "../schema.ts";
import type {
  Actor,
  Change,
  ChangeId,
  ChangeKind,
  Choices,
  CommitResult,
  ConfirmedChange,
  CutKind,
  CutRecord,
  DagNode,
  Doc,
  FullExport,
  Intent,
  LineageKind,
  MergeResult,
  NodeId,
  NodeRef,
  Notice,
  Op,
  PathKey,
  PinRow,
  Rec,
  RemapMaps,
  RemapOp,
  ShallowExport,
  StateRef,
  UndoEntry,
  Version,
} from "../types.ts";
import * as E from "../engine/index.ts";
import { isEmptyMap } from "../engine/remap.ts";
import { createLocalSequencer, type LocalSequencer } from "../sequencer/index.ts";
import { StateUnknown, type FoldOptions, type FoldResult, type HeldBase, type HistoryCommit, type HistoryOptions } from "./common.ts";

// ------------------------------------------------------------------ ids and keys

/** `n` random bytes as hex (crypto.getRandomValues: Node, browsers, Workers). */
export function randomHex(n: number): string {
  const b = new Uint8Array(n);
  crypto.getRandomValues(b);
  let s = "";
  for (let i = 0; i < n; i++) s += b[i]!.toString(16).padStart(2, "0");
  return s;
}
const newCutId = (): string => (typeof crypto.randomUUID === "function" ? crypto.randomUUID() : randomHex(16));
export const nodeId = (b: string, s: number): NodeId => `${b}@${s}`;
export const parseNode = (id: NodeId): NodeRef => {
  const i = id.lastIndexOf("@");
  return { branchId: id.slice(0, i), seq: Number(id.slice(i + 1)) };
};
const refNode = (r: NodeRef | StateRef): NodeId => nodeId(r.branchId, r.seq);
/** Stable key of an actor: `kind/id[/agentId]`. */
export const actorKey = (a: Actor | string | null | undefined): string => (a == null ? "?" : typeof a === "string" ? a : [a.kind, a.id, a.agentId].filter(Boolean).join("/"));
/** An actor's undo group (§8): its declared group, else itself. */
export const groupOf = (a: Actor | null | undefined): string => a?.group ?? actorKey(a);

const SYSTEM: Actor = { kind: "system", id: "carton" };
const REF_RE = /^(.+)@(\d+)~([0-9a-f]{8}) b:([0-9a-f]{8})(?: p:(\S+))?(?: by (.+))?$/;

interface Cut {
  rec: CutRecord;
  root: Doc | null;
  kf: Map<number, Doc>;
  sq: LocalSequencer | null;
  /** The confirmed log (the sequencer's own array for writable cuts). */
  log: readonly ConfirmedChange[];
}
interface Lineage extends DagNode {
  branchName?: string;
}
interface Pin {
  seq: number;
  hash: string;
  pending: ChangeId[];
  delta: Op[];
  owners: Map<string, number>;
}
interface View {
  header: string;
  cutId: string;
  seq: number;
  applied: { state: Doc; hash: string } | null;
  own: ChangeId[];
}

/** One replica's history, in memory and synchronous. */
export class History {
  readonly schema: Schema;
  readonly name: string;
  readonly K: number;
  #rid: string;
  #n = 0;
  #clock: () => number;
  #nextId: () => string;
  #projectId: string | null;
  #current = "";
  readonly #cuts = new Map<string, Cut>();
  readonly #lineage = new Map<NodeId, Lineage>(); // imported lineage nodes
  readonly #states = new Map<string, Doc>(); // carried states by full hash
  readonly #importedAuthors = new Map<NodeId, Record<PathKey, Actor>>();
  readonly #exportsMade = new Map<NodeId, { to: string; at: number }[]>();
  readonly #pins = new Map<string, Pin>(); // `${cut}|${seq}|${hash8}`
  readonly #views = new Map<string, View>();
  readonly #creators = new Map<PathKey, string>(); // sequence element path -> author key (M4 nesting)
  readonly #names = new Map<NodeId, { name: string; at: number; by?: Actor }>();
  readonly #local = { pathMap: {} as Record<string, string>, notices: [] as Notice[], ephemeral: {} as Record<string, unknown>, lease: null as unknown };
  readonly #anc = new Map<NodeId, Map<string, number>>();
  readonly #hash = new Map<NodeId, string>();
  /** Called after a change is confirmed on a cut this replica sequences (Carton persists it). */
  onConfirmed: ((cutId: string, change: ConfirmedChange) => void) | null = null;

  constructor(schema: Schema, { name = "replica", rid = randomHex(12), clock = () => Date.now(), projectId = null, keyframeEvery = 64, nextId }: HistoryOptions = {}) {
    this.schema = schema;
    this.name = name;
    this.#rid = rid;
    this.#nextId = nextId ?? (() => `${this.#rid}.${++this.#n}`);
    this.#clock = clock;
    this.#projectId = projectId;
    this.K = keyframeEvery;
  }

  // ------------------------------------------------------------ cuts and states
  static create(schema: Schema, doc: Doc, opts: HistoryOptions & { cut?: string; cutId?: string } = {}): History {
    const r = new History(schema, opts);
    r.#projectId ??= randomHex(8);
    const b = r.addCut({ name: opts.cut ?? "main", forkOf: null, root: doc, kind: "main", id: opts.cutId });
    r.#current = b.id;
    return r;
  }
  get current(): string {
    return this.#current;
  }
  set current(cutId: string) {
    if (!this.#cuts.has(cutId)) throw new Error(`no cut ${cutId}`);
    this.#current = cutId;
  }
  get projectId(): string | null {
    return this.#projectId;
  }
  set projectId(id: string | null) {
    this.#projectId = id;
  }
  get rid(): string {
    return this.#rid;
  }
  get local() {
    return this.#local;
  }
  /**
   * Add a cut. A root cut starts at `root`; a fork starts at its fork node's state. Tracking cuts are read-only here;
   * shallow ones hold only lineage nodes. Low level: `fork` is the usual way.
   */
  addCut(o: { name: string; forkOf: NodeId | null; root?: Doc | null; tracking?: boolean; shallow?: boolean; id?: string; owner?: string; kind?: CutKind; at?: number }): CutRecord {
    const id = o.id ?? newCutId();
    const shallow = !!o.shallow,
      tracking = !!o.tracking;
    const root = o.root ? E.fork(o.root, this.schema) : null;
    const doc0 = root ?? (o.forkOf && !shallow ? this.stateOf(o.forkOf) : null);
    const rec: CutRecord = {
      id,
      name: o.name,
      forkOf: o.forkOf,
      owner: o.owner ?? this.name,
      kind: o.kind ?? (o.forkOf ? "variant" : "main"),
      ...(tracking ? { tracking } : {}),
      ...(shallow ? { shallow } : {}),
      sequencer: { kind: "local" },
      at: o.at ?? this.#clock(),
    };
    const cut: Cut = { rec, root, kf: new Map(), sq: null, log: [] };
    if (!shallow) {
      if (!doc0) throw new StateUnknown(o.forkOf, "fork node state not held");
      cut.kf.set(0, doc0);
      if (!tracking) {
        cut.sq = createLocalSequencer(doc0, this.schema);
        cut.log = cut.sq.log;
      }
    }
    this.#cuts.set(id, cut);
    return rec;
  }
  /** New cut forked from a node (default: a cut's head). Returns its id. */
  fork(from: NodeId | StateRef, name: string, opts: { kind?: CutKind; owner?: string } = {}): string {
    const node = typeof from === "string" ? (from.includes("@") ? from : this.head(from)) : refNode(from);
    return this.addCut({ name, forkOf: this.canon(node), kind: opts.kind ?? "variant", owner: opts.owner }).id;
  }
  cuts(): CutRecord[] {
    return [...this.#cuts.values()].map((c) => c.rec);
  }
  cut(cutId: string): CutRecord | undefined {
    return this.#cuts.get(cutId)?.rec;
  }
  /** Rename or re-kind a cut (only labels; its id never changes). */
  updateCut(cutId: string, patch: Partial<Pick<CutRecord, "name" | "kind" | "protected" | "sequencer">>): CutRecord {
    const c = this.#mustCut(cutId);
    c.rec = { ...c.rec, ...patch };
    return c.rec;
  }
  changes(cutId: string): readonly ConfirmedChange[] {
    return this.#cuts.get(cutId)?.log ?? [];
  }
  headSeq(cutId: string): number {
    return this.#mustCut(cutId).log.length;
  }
  head(cutId: string): NodeId {
    return this.canon(nodeId(cutId, this.headSeq(cutId)));
  }
  /** `(b, 0)` of a forked cut canonicalizes to its fork node. */
  canon(id: NodeId): NodeId {
    const { branchId: b, seq: s } = parseNode(id);
    const br = this.#cuts.get(b);
    if (s === 0 && br?.rec.forkOf) return this.canon(br.rec.forkOf);
    return id;
  }
  /** The state at a node; null when it isn't held (a shallow node whose state wasn't carried). Never the live head. */
  stateOf(id: NodeId): Doc | null {
    id = this.canon(id);
    const { branchId: b, seq: s } = parseNode(id);
    const br = this.#cuts.get(b);
    if (!br || br.rec.shallow) {
      const ln = this.#lineage.get(id);
      return ln ? this.#states.get(ln.hash) ?? null : null;
    }
    if (s > br.log.length || s < 0) return null;
    if (br.sq && s === br.log.length) return E.fork(br.sq.head, this.schema); // never hand out the live head
    let k = s;
    while (!br.kf.has(k)) k--;
    let doc = br.kf.get(k)!;
    if (k < s) {
      doc = E.fork(doc, this.schema);
      for (let i = k; i < s; i++) E.apply(doc, br.log[i]!.ops, this.schema);
      if (s % this.K === 0) br.kf.set(s, doc);
    }
    return doc;
  }
  hashOf(id: NodeId): string | null {
    id = this.canon(id);
    const ln = this.#lineage.get(id);
    if (ln) return ln.hash;
    let h = this.#hash.get(id);
    if (!h) {
      const d = this.stateOf(id);
      if (!d) return null;
      this.#hash.set(id, (h = E.hashDoc(d, this.schema)));
    }
    return h;
  }
  changeAt(id: NodeId): ConfirmedChange | null {
    const { branchId: b, seq: s } = parseNode(id);
    const br = this.#cuts.get(b);
    return br && !br.rec.shallow && s > 0 ? br.log[s - 1] ?? null : null;
  }
  /** Where a change id was confirmed, on any cut this replica holds. */
  findChange(id: ChangeId): ConfirmedChange | null {
    for (const c of this.#cuts.values()) for (let i = c.log.length - 1; i >= 0; i--) if (c.log[i]!.id === id) return c.log[i]!;
    return null;
  }
  #mustCut(cutId: string): Cut {
    const c = this.#cuts.get(cutId);
    if (!c) throw new Error(`no cut ${cutId}`);
    return c;
  }
  /** Confirmed rows from elsewhere (another process on the same carton.db, or an import), appended in order. */
  load(cutId: string, rows: readonly ConfirmedChange[]): void {
    const c = this.#mustCut(cutId);
    const fresh = rows.filter((r) => r.seq > c.log.length);
    if (!fresh.length) return;
    if (c.sq) c.sq.load(fresh);
    else (c.log as ConfirmedChange[]).push(...fresh);
    for (const r of fresh) this.#confirmed(c, r);
  }

  /** What an import taught this replica (lineage nodes, carried states, last authors, exports made), to persist. */
  knowledge(): { lineage: DagNode[]; states: [string, Doc][]; authors: [NodeId, Record<PathKey, Actor>][]; exports: [NodeId, { to: string; at: number }[]][] } {
    return { lineage: [...this.#lineage.values()], states: [...this.#states], authors: [...this.#importedAuthors], exports: [...this.#exportsMade] };
  }
  /** Restore persisted knowledge (before the cuts that fork from lineage nodes). */
  loadKnowledge(k: Partial<ReturnType<History["knowledge"]>>): void {
    for (const n of k.lineage ?? []) this.#lineage.set(n.id, n);
    for (const [h, d] of k.states ?? []) this.#states.set(h, d);
    for (const [n, a] of k.authors ?? []) this.#importedAuthors.set(n, a);
    for (const [n, e] of k.exports ?? []) this.#exportsMade.set(n, e);
    this.#anc.clear();
  }

  // ------------------------------------------------------------ refs and pins (§5.2)
  refString(cutId: string, seq: number, hash: string, extra: { printNonce?: string; by?: string } = {}): string {
    const br = this.#mustCut(cutId);
    let s = `${br.rec.name}@${seq}~${hash.slice(0, 8)} b:${cutId.slice(0, 8)}`;
    if (extra.printNonce) s += ` p:${extra.printNonce}`;
    if (extra.by) s += ` by ${extra.by}`;
    return s;
  }
  ref(cutId: string): StateRef {
    const seq = this.headSeq(cutId);
    const hash = this.hashOf(nodeId(cutId, seq))!;
    return { branchId: cutId, seq, hash, hash8: hash.slice(0, 8), pending: [] };
  }
  /** A pin row for an out-of-process reader of a local optimistic or held state; `owner` joins its owner set. */
  pin(o: { cutId: string; seq?: number; pending?: readonly Pick<Change, "id" | "ops">[]; doc?: Doc; owner: string; expires?: number }): StateRef {
    const seq = o.seq ?? this.headSeq(o.cutId);
    const confirmed = this.stateOf(nodeId(o.cutId, seq));
    if (!confirmed) throw new StateUnknown(nodeId(o.cutId, seq), "pin of a state not held");
    let doc = E.fork(confirmed, this.schema);
    const delta: Op[] = [];
    for (const c of o.pending ?? []) {
      E.apply(doc, c.ops, this.schema);
      delta.push(...c.ops);
    }
    if (o.doc) {
      const d = E.diff(doc, o.doc, this.schema);
      E.apply(doc, d, this.schema);
      delta.push(...d);
    }
    const hash = E.hashDoc(doc, this.schema);
    const key = `${o.cutId}|${seq}|${hash.slice(0, 8)}`;
    let p = this.#pins.get(key);
    if (!p) this.#pins.set(key, (p = { seq, hash, pending: (o.pending ?? []).map((c) => c.id), delta, owners: new Map() }));
    p.owners.set(o.owner, Math.max(p.owners.get(o.owner) ?? -Infinity, o.expires ?? Infinity));
    return { branchId: o.cutId, seq, hash8: hash.slice(0, 8), hash, pending: p.pending.slice() };
  }
  /** `owner` releases the pin; the row goes when its last owner does (one turn ending never breaks another's ref). */
  release(ref: StateRef, owner?: string): void {
    const key = `${ref.branchId}|${ref.seq}|${ref.hash8 ?? ref.hash?.slice(0, 8)}`;
    const p = this.#pins.get(key);
    if (!p) return;
    if (owner === undefined) p.owners.clear();
    else p.owners.delete(owner);
    if (!p.owners.size) this.#pins.delete(key);
  }
  expirePins(now: number): void {
    for (const [k, p] of this.#pins) {
      for (const [o, exp] of p.owners) if (exp <= now) p.owners.delete(o);
      if (!p.owners.size) this.#pins.delete(k);
    }
  }
  pinRow(cutId: string, seq: number, hash8: string): PinRow | undefined {
    const p = this.#pins.get(`${cutId}|${seq}|${hash8}`);
    return p && { branchId: cutId, seq, hash8, hash: p.hash, pending: p.pending.slice(), delta: p.delta, owners: [...p.owners].map(([owner, expires]) => ({ owner, expires })) };
  }
  pinRows(): PinRow[] {
    return [...this.#pins.keys()].map((k) => {
      const [b, s, h] = k.split("|");
      return this.pinRow(b!, Number(s), h!)!;
    });
  }
  /** Restore a persisted pin row (Carton reopening a store). */
  loadPin(row: PinRow): void {
    this.#pins.set(`${row.branchId}|${row.seq}|${row.hash8}`, { seq: row.seq, hash: row.hash, pending: row.pending.slice(), delta: row.delta, owners: new Map(row.owners.map((o) => [o.owner, o.expires ?? Infinity])) });
  }
  parseRef(ref: string | StateRef): (StateRef & { printNonce?: string; by?: string }) | { legacy: number } {
    if (typeof ref !== "string") return ref;
    if (/^\d{13}$/.test(ref)) return { legacy: Number(ref) }; // a 1.4.0 timestamp rev
    const m = REF_RE.exec(ref.trim());
    if (!m) throw new StateUnknown(ref, "unparseable ref");
    const br = [...this.#cuts.values()].find((b) => b.rec.id.startsWith(m[4]!));
    const out: StateRef & { printNonce?: string; by?: string } = { branchId: br?.rec.id ?? m[4]!, seq: Number(m[2]), hash8: m[3]! };
    if (m[5]) out.printNonce = m[5];
    if (m[6]) out.by = m[6];
    return out;
  }
  /** -> {doc, seq, causal}; never a guess: an unknown, released, expired or mismatching ref throws StateUnknown. */
  resolve(refIn: string | StateRef, now: number = this.#clock()): { doc: Doc; seq: number; causal: ChangeId[]; cutId: string } {
    const ref = this.parseRef(refIn);
    if ("legacy" in ref) throw new StateUnknown(refIn, "a 1.4.0 timestamp rev has no Carton state");
    const br = this.#cuts.get(ref.branchId);
    if (!br || br.rec.shallow) throw new StateUnknown(refIn, "unknown branch");
    if (ref.seq > br.log.length) throw new StateUnknown(refIn, "seq beyond head");
    const confirmed = this.stateOf(nodeId(ref.branchId, ref.seq))!;
    const h8 = ref.hash8 ?? ref.hash?.slice(0, 8);
    if (!h8 || this.hashOf(nodeId(ref.branchId, ref.seq))!.startsWith(h8)) return { doc: confirmed, seq: ref.seq, causal: [], cutId: ref.branchId };
    const pin = this.#pins.get(`${ref.branchId}|${ref.seq}|${h8}`);
    if (!pin) throw new StateUnknown(refIn, "pin released or never made");
    if (![...pin.owners.values()].some((exp) => exp > now)) throw new StateUnknown(refIn, "pin expired");
    const doc = E.apply(E.fork(confirmed, this.schema), pin.delta, this.schema);
    if (E.hashDoc(doc, this.schema) !== pin.hash) throw new StateUnknown(refIn, "rebuilt state does not match the full stateHash");
    return { doc, seq: ref.seq, causal: pin.pending.slice(), cutId: ref.branchId };
  }

  // ------------------------------------------------------------ commits (local sequencer, rebase on reject)
  /**
   * M4: did `author` create element `id` of the sequence at `seqKey`? `seqKey` is the sequence's path key (`tracks`,
   * `timelineItems/X/effects`); one whose first segment isn't a collection is a timeline item's keyed array in short
   * form (`X/effects`, the prototype's form).
   */
  own(author: Actor | string | null | undefined): (seqKey: string, id: string) => boolean {
    const a = actorKey(author);
    const tl = this.schema.timeline;
    return (seqKey, id) => {
      const full = this.schema.collections[seqKey.split("/")[0]!] || !tl ? seqKey : `${tl.collection}/${seqKey}`;
      return this.#creators.get(`${full}/${E.pathKey([id])}`) === a;
    };
  }
  /**
   * Commit a new state (or ops) made on `base` (a ref, a held state, or the head). Confirmed at once on a cut this
   * replica sequences; a reject is rebased with merge3 (recorded remaps and edit kinds of the concurrent changes, the
   * change's own remap re-expressed in head coordinates) and resubmitted. Cards come back as `conflicts` unless
   * `choices` decides them. A commit whose `id` is already confirmed returns that confirmation (idempotent).
   */
  commit(cutId: string, o: HistoryCommit & { kind?: ChangeKind; extra?: Partial<Change> }): CommitResult & { retry?: (choices: Choices) => CommitResult } {
    const br = this.#mustCut(cutId);
    if (!br.sq) throw new Error(`cut ${br.rec.name} is read-only here (tracking cut)`);
    if (o.id) {
      const done = br.log.find((c) => c.id === o.id);
      if (done) return { status: "confirmed", seq: done.seq, ref: this.#refAt(cutId, done.seq), change: done, rebased: 0, notices: [] };
    }
    let baseDoc: Doc, baseSeq: number, causal: ChangeId[];
    const base = o.base;
    if (base && typeof base === "object" && "baseDoc" in base) [baseDoc, baseSeq, causal] = [(base as HeldBase).baseDoc, (base as HeldBase).baseSeq, (base as HeldBase).causal ?? []];
    else if (base) ({ doc: baseDoc, seq: baseSeq, causal } = this.resolve(base as string | StateRef));
    else [baseDoc, baseSeq, causal] = [br.sq.head, br.log.length, []];
    let mine = o.doc ?? E.apply(E.fork(baseDoc, this.schema), o.ops ?? [], this.schema);
    let ops: Op[] = o.ops ?? E.diff(baseDoc, mine, this.schema);
    const extra = o.extra ?? {};
    let intent: Intent | null = o.intent ?? null;
    if (!intent && !extra.mergeOf) {
      // an unrecorded edit (an agent's file save) that is unambiguously a ripple: record the inferred remap on the
      // change, so its [t0, ∞) span is declared and later merges use it as an intent
      const maps = E.inferRemaps(this.schema, baseDoc, ops.flatMap((op) => (op.op === "remap" ? [] : [{ path: op.path, op }])));
      if (!isEmptyMap(maps)) intent = { maps, inferred: true };
    }
    const change = {
      id: o.id ?? this.#nextId(),
      author: o.author,
      branchId: cutId,
      intent,
      kinds: o.kinds ?? null,
      policy: o.policy ?? "merge",
      at: this.#clock(),
      ...(o.kind ? { kind: o.kind } : {}),
      ...(o.name ? { name: o.name } : {}),
      ...extra,
    };
    // nothing to record: a commit that changes nothing is confirmed empty at the head (system-v11 `store.commit`);
    // a fold or an undo with no ops is still pushed: its merge edge, or the change it undoes, is history
    if (!ops.length && !extra.mergeOf && !extra.reverts) return { status: "confirmed", seq: br.log.length, ref: this.#refAt(cutId, br.log.length), change: null, empty: true, rebased: 0, notices: [] };
    for (let rebase = 0; ; rebase++) {
      if (rebase > 8) throw new Error("rebase loop");
      const stored = remapAsOneOp(this.schema, baseDoc, ops, change.intent);
      const ch: Change = { ...change, ops: stored, base: { seq: baseSeq, pending: causal }, ...E.declare(this.schema, baseDoc, stored, change.intent), hash: "" };
      if (rebase) Object.assign(ch, { rebase, supersedes: [change.id] });
      ch.hash = E.sha256Hex(E.canonical({ author: ch.author, base: ch.base, ops: ch.ops, intent: ch.intent, mergeOf: ch.mergeOf ?? null }));
      const res = br.sq.push(ch);
      if (res.ok) {
        this.#confirmed(br, res.change);
        this.onConfirmed?.(cutId, res.change);
        return { status: "confirmed", seq: res.seq, ref: this.#refAt(cutId, res.seq), change: res.change, notices: res.notices, rebased: rebase };
      }
      if (res.reason === "lww on structure" && change.policy === "lww") {
        // H2: lww is only for plain leaf edits; anything structural goes through merge3 as a normal change
        change.policy = "merge";
        continue;
      }
      if (res.reason !== "overlap" && res.reason !== "behind") {
        const invalid = res.invalid ?? { error: res.reason };
        return { status: "rejected", reason: res.reason, invalid };
      }
      // rebase: merge3(base, head, mine) with the concurrent changes' recorded remaps and kinds
      const head = br.sq.head;
      const conc = res.missing.filter((c) => !causal.includes(c.id));
      const rec = conc.filter((c) => !isEmptyMap(c.intent?.maps));
      const concMaps = rec.length ? { maps: E.composeMaps(...rec.map((c) => c.intent!.maps)) } : undefined;
      const concKinds: Record<string, NonNullable<Change["kinds"]>[string]> = {};
      for (const c of conc) for (const [id, k] of Object.entries(c.kinds ?? {})) concKinds[id] = k;
      const m = E.merge3(baseDoc, head, mine, this.schema, {
        remaps: { ours: concMaps, theirs: isEmptyMap(change.intent?.maps) ? undefined : (change.intent as { maps: RemapMaps }) },
        kinds: { ours: concKinds, theirs: change.kinds ?? {} },
        rekeys: "ours",
      });
      let merged = m.doc;
      if (m.conflicts.length) {
        if (!o.choices) return { status: "conflicts", cards: m.conflicts, ref: this.#refAt(cutId, br.log.length), merge: m, retry: (choices: Choices) => this.commit(cutId, { ...o, choices }) };
        merged = E.resolve(m, o.choices);
      }
      if (!isEmptyMap(change.intent?.maps)) change.intent = { ...change.intent, maps: m.edges.ours };
      ops = E.diff(head, merged, this.schema);
      baseDoc = head;
      baseSeq = br.log.length;
      causal = [];
      mine = merged;
      if (!ops.length && !extra.mergeOf && !extra.reverts) return { status: "confirmed", seq: baseSeq, ref: this.#refAt(cutId, baseSeq), change: null, empty: true, rebased: rebase + 1, notices: [] };
    }
  }
  #refAt(cutId: string, seq: number): StateRef {
    const ref: StateRef = { branchId: cutId, seq, pending: [] };
    const h = this.#hash.get(nodeId(cutId, seq));
    if (h) (ref.hash = h), (ref.hash8 = h.slice(0, 8));
    return ref;
  }
  #confirmed(br: Cut, c: ConfirmedChange): void {
    const a = actorKey(c.author);
    for (const op of c.ops) if (op.op === "insert" && op.nb) this.#creators.set(E.pathKey(op.path), a);
    if (c.seq % this.K === 0) br.kf.set(c.seq, br.sq ? E.fork(br.sq.head, this.schema) : this.stateOf(nodeId(br.rec.id, c.seq))!);
    if (c.name) this.#names.set(nodeId(br.rec.id, c.seq), { name: c.name, at: c.at, by: c.author });
    if (c.mergeOf) this.#anc.clear();
  }

  // ------------------------------------------------------------ versions (the log)
  /** History: versions of a cut, newest first (`before`: only seqs below it). */
  log(cutId: string, { limit = Infinity, before }: { limit?: number; before?: number } = {}): Version[] {
    const br = this.#mustCut(cutId);
    const out: Version[] = [];
    for (let s = Math.min(before === undefined ? br.log.length : before - 1, br.log.length); s >= 0 && out.length < limit; s--) {
      const c = s > 0 ? br.log[s - 1]! : null;
      const id = nodeId(cutId, s);
      const named = this.#names.get(id);
      const v: Version = {
        ref: { branchId: cutId, seq: s, pending: [] },
        change: c?.id ?? null,
        author: c?.author ?? null,
        at: c?.at ?? br.rec.at ?? 0,
        kind: c ? c.kind ?? (c.mergeOf ? "merge" : "edit") : br.rec.forkOf ? "fork" : "root",
      };
      const h = this.#hash.get(id);
      if (h) v.hash = h;
      if (named) v.name = named.name;
      out.push(v);
    }
    return out;
  }
  /** Name a version ("Sent to client, Monday"). */
  nameVersion(node: NodeId, name: string, by?: Actor): void {
    this.#names.set(this.canon(node), { name, at: this.#clock(), ...(by ? { by } : {}) });
  }
  names(): [NodeId, { name: string; at: number; by?: Actor }][] {
    return [...this.#names];
  }

  // ------------------------------------------------------------ DAG: ancestors, LCA, merge base
  parents(id: NodeId): NodeId[] {
    id = this.canon(id);
    const ln = this.#lineage.get(id);
    if (ln) return ln.parents.map((p) => this.canon(p.id));
    const { branchId: b, seq: s } = parseNode(id);
    const br = this.#cuts.get(b);
    if (!br || br.rec.shallow) return [];
    if (s === 0) return br.rec.forkOf ? [this.canon(br.rec.forkOf)] : [];
    const out = [this.canon(nodeId(b, s - 1))];
    const c = br.log[s - 1];
    if (c?.mergeOf) out.push(this.canon(refNode(c.mergeOf)));
    return out;
  }
  // ancestor frontier: cutId -> highest seq that is an ancestor (all lower seqs of a cut are too)
  #ancOf(id: NodeId): Map<string, number> {
    id = this.canon(id);
    let f = this.#anc.get(id);
    if (f) return f;
    const { branchId: b, seq: s } = parseNode(id);
    f = new Map([[b, s]]);
    const add = (g: Map<string, number>) => {
      for (const [k, v] of g) if ((f!.get(k) ?? -1) < v) f!.set(k, v);
    };
    const ln = this.#lineage.get(id);
    const br = this.#cuts.get(b);
    if (ln) for (const p of ln.parents) add(this.#ancOf(p.id));
    else if (br && !br.rec.shallow) {
      // merges and the fork on this cut up to s (memoized per merge node)
      if (br.rec.forkOf) add(this.#ancOf(br.rec.forkOf));
      for (let i = 0; i < s; i++) {
        const m = br.log[i]!.mergeOf;
        if (m) add(this.#ancOf(refNode(m)));
      }
    }
    this.#anc.set(id, f);
    return f;
  }
  isAncestor(a: NodeId, d: NodeId): boolean {
    a = this.canon(a);
    const { branchId: b, seq: s } = parseNode(a);
    return (this.#ancOf(d).get(b) ?? -1) >= s;
  }
  #lcaOfFrontiers(fx: Map<string, number>, fy: Map<string, number>): NodeId[] {
    const cands: NodeId[] = [];
    for (const [b, sx] of fx) {
      const sy = fy.get(b);
      if (sy === undefined) continue;
      const s = Math.min(sx, sy);
      const br = this.#cuts.get(b);
      if (s === 0 && br?.rec.forkOf) continue; // the fork node is covered by the parent cut's entry
      const id = nodeId(b, s);
      if (br?.rec.shallow && !this.#lineage.has(id)) continue;
      cands.push(this.canon(id));
    }
    const uniq = [...new Set(cands)];
    return uniq.filter((c) => !uniq.some((d) => d !== c && this.isAncestor(c, d))).sort();
  }
  lca(x: NodeId, y: NodeId): NodeId[] {
    return this.#lcaOfFrontiers(this.#ancOf(x), this.#ancOf(y));
  }
  /**
   * Merge base over the DAG -> {node?, nodes, doc} | {missing}. Criss-cross: the LCAs are merged into a virtual base
   * (git's recursive strategy); a field the LCAs disagree on keeps its value from their own merge base, so the
   * disagreement resurfaces as a card in the real merge instead of being decided silently.
   */
  mergeBase(x: NodeId, y: NodeId): { node?: NodeId | null; nodes?: NodeId[]; doc?: Doc; virtual?: boolean; missing?: NodeId | null; noCommon?: boolean } {
    return this.#mb(this.#ancOf(x), this.#ancOf(y));
  }
  #mb(fx: Map<string, number>, fy: Map<string, number>): { node?: NodeId | null; nodes?: NodeId[]; doc?: Doc; virtual?: boolean; missing?: NodeId | null; noCommon?: boolean } {
    const L = this.#lcaOfFrontiers(fx, fy);
    if (!L.length) return { missing: null, noCommon: true };
    const st = L.map((n) => this.stateOf(n));
    const miss = L.findIndex((_, i) => !st[i]);
    if (miss >= 0) return { missing: L[miss]! };
    if (L.length === 1) return { node: L[0]!, nodes: L, doc: st[0]! };
    let acc = { f: this.#ancOf(L[0]!), doc: st[0]! };
    for (let i = 1; i < L.length; i++) {
      const fi = this.#ancOf(L[i]!);
      const inner = this.#mb(acc.f, fi);
      if (inner.missing !== undefined) return inner;
      const m = E.merge3(inner.doc!, acc.doc, st[i]!, this.schema, { infer: false });
      const f = new Map(acc.f);
      for (const [k, v] of fi) if ((f.get(k) ?? -1) < v) f.set(k, v);
      acc = { f, doc: E.resolve(m, m.conflicts.map(() => "base" as const)) };
    }
    return { node: null, nodes: L, doc: acc.doc, virtual: true };
  }
  /** Recorded remaps along one DAG path from ancestor `from` to `to` (first parent preferred), composed. */
  pathRemap(from: NodeId, to: NodeId, { prefer = "first" }: { prefer?: "first" | "second" } = {}): RemapMaps {
    from = this.canon(from);
    const steps: RemapMaps[] = [];
    let cur = this.canon(to);
    while (cur !== from) {
      const ps = this.parents(cur);
      const order = prefer === "second" && ps.length > 1 ? [ps[1]!, ps[0]!] : ps;
      const p = order.find((q) => q === from || this.isAncestor(from, q));
      if (p === undefined) throw new Error(`no path ${from} -> ${to}`);
      steps.push(this.edgeMap(p, cur));
      cur = p;
    }
    return E.composeMaps(...steps.reverse());
  }
  /** Edge maps: a change's intent maps; a fold's per-parent edge maps; an imported lineage edge's map. */
  edgeMap(parent: NodeId, child: NodeId): RemapMaps {
    const ln = this.#lineage.get(child);
    if (ln) return ln.parents.find((p) => this.canon(p.id) === parent)?.remap ?? {};
    const c = this.changeAt(child);
    if (!c) return {};
    if (c.mergeOf) return this.canon(refNode(c.mergeOf)) === parent && this.canon(nodeId(c.branchId, c.seq - 1)) !== parent ? c.mergeEdges?.second ?? {} : c.mergeEdges?.first ?? {};
    return c.intent?.maps ?? {};
  }

  // ------------------------------------------------------------ fold in, partial accept, revert, restore
  /** "Fold into …": a DAG merge of node `from` into cut `into`. */
  fold(into: string, from: NodeId, opts: FoldOptions & { remapPath?: "first" | "second" } = {}): FoldResult & { merge?: MergeResult; base?: ReturnType<History["mergeBase"]>; retry?: (choices: Choices) => FoldResult } {
    const { author = { kind: "human", id: this.name } as Actor, choices, prefer = "ours", missingBase = "dialog", remapPath = "first" } = opts;
    const x = this.head(into),
      y = this.canon(from);
    if (this.isAncestor(y, x)) return { status: "up-to-date" };
    const base = this.mergeBase(x, y);
    if (base.missing !== undefined) {
      const who = base.missing ? this.#cuts.get(parseNode(base.missing).branchId)?.rec.owner ?? this.#lineage.get(base.missing)?.owner ?? "the sender" : "the sender";
      const dialog = {
        text: `This copy builds on a version from ${who} that you don't have. Ask ${who} for their copy, or bring it in with every difference shown as a card.`,
        options: ["ask", "all-cards"] as ["ask", "all-cards"],
        lca: base.missing,
      };
      if (missingBase !== "all-cards") return { status: "missing-base", dialog };
      const cmp = E.compare2(this.stateOf(x)!, this.stateOf(y)!, this.schema);
      return { status: "compare", dialog, cards: cmp.conflicts };
    }
    const baseNode = base.node ?? base.nodes![0]!;
    const Mo = this.pathRemap(baseNode, x, { prefer: remapPath }),
      Mt = this.pathRemap(baseNode, y, { prefer: remapPath });
    const ours = this.stateOf(x)!,
      theirs = this.stateOf(y);
    if (!theirs) return { status: "missing-base", dialog: { text: "The version to fold in isn't held here.", options: ["ask", "all-cards"], lca: y } };
    const m = E.merge3(base.doc!, ours, theirs, this.schema, {
      prefer,
      remaps: { ours: isEmptyMap(Mo) ? undefined : { maps: Mo }, theirs: isEmptyMap(Mt) ? undefined : { maps: Mt } },
    });
    if (m.conflicts.length && !choices)
      return { status: "conflicts", cards: m.conflicts, ref: this.#refAt(into, this.headSeq(into)), merge: m, base, retry: (ch: Choices) => this.fold(into, from, { ...opts, choices: ch }) };
    if (opts.check) return { status: "confirmed", seq: this.headSeq(into), ref: this.#refAt(into, this.headSeq(into)), change: null, rebased: 0, notices: [], empty: true, merge: m };
    const doc = m.conflicts.length ? E.resolve(m, choices!) : m.doc;
    const r = this.commit(into, {
      doc,
      author,
      allowEmpty: true,
      kind: "merge",
      extra: { mergeOf: parseNode(y), mergeEdges: { first: m.edges.ours, second: m.edges.theirs }, mergeBase: base.node ? [base.node] : base.nodes! },
    });
    this.#anc.clear();
    if (r.status === "confirmed" && r.change) this.#mergeAuthors(r.change, y);
    return { ...r, base, merge: m };
  }
  /** "Fold in some of it" (R2-14): a full fold, then an inverse change for the rejected records, which lists them. */
  foldSome(into: string, from: NodeId, opts: FoldOptions & { reject: PathKey[] | readonly (readonly string[])[] }): FoldResult & { fold?: FoldResult; inverse?: CommitResult } {
    const r = this.fold(into, from, opts);
    if (r.status !== "confirmed" || !("change" in r) || !r.change) return r;
    const pre = this.stateOf(nodeId(into, r.seq - 1))!,
      post = this.stateOf(nodeId(into, r.seq))!;
    const ops: Op[] = [];
    for (const p of opts.reject) {
      const path = typeof p === "string" ? p.split("/") : [...p];
      const a = E.getIn(post, path, this.schema),
        b = E.getIn(pre, path, this.schema);
      if (a === undefined && b !== undefined) ops.push({ op: "insert", path, value: b });
      else if (b === undefined && a !== undefined) ops.push({ op: "remove", path });
      else if (a !== b) ops.push(...E.diff({ [path[0]!]: [a] }, { [path[0]!]: [b] }, this.schema));
    }
    const inv = this.commit(into, { ops, author: opts.author ?? { kind: "human", id: this.name }, allowEmpty: true, kind: "partial-revert", extra: { rejected: opts.reject.map((p) => (typeof p === "string" ? p : E.pathKey(p))), reverts: r.change.id } });
    const { merge: _m, ...invOnly } = inv as CommitResult & { merge?: unknown };
    return { ...invOnly, fold: r, inverse: inv } as FoldResult & { fold: FoldResult; inverse: CommitResult };
  }
  /** Undo one change: its inverse at the head, as a 3-way merge (git revert). Intents invert as intents. */
  revert(cutId: string, changeId: ChangeId, { author, kind = "revert" }: { author?: Actor; kind?: ChangeKind } = {}): CommitResult {
    const br = this.#mustCut(cutId);
    const c = br.log.find((x) => x.id === changeId);
    if (!c) throw new Error(`no change ${changeId}`);
    const doc = this.#inverted(cutId, [c]);
    if ("cards" in doc) return { status: "conflicts", cards: doc.cards, ref: this.#refAt(cutId, br.log.length), merge: doc.merge };
    return this.commit(cutId, { doc: doc.doc, author: author ?? c.author, kind, extra: { reverts: changeId } });
  }
  // The head with `changes` (newest last) inverted one by one, newest first. A card in any step stops it.
  #inverted(cutId: string, changes: readonly ConfirmedChange[]): { doc: Doc } | { cards: MergeResult["conflicts"]; merge: MergeResult } {
    const br = this.#mustCut(cutId);
    let cur: Doc = br.sq!.head;
    for (let i = changes.length - 1; i >= 0; i--) {
      const c = changes[i]!;
      const before = this.stateOf(nodeId(cutId, c.seq - 1))!,
        after = this.stateOf(nodeId(cutId, c.seq))!;
      const m = E.merge3(after, cur, before, this.schema, { infer: false });
      if (m.conflicts.length) return { cards: m.conflicts, merge: m };
      cur = m.doc;
    }
    return { doc: cur };
  }
  acceptRest(cutId: string, inverseId: ChangeId, opts: { author?: Actor } = {}): CommitResult {
    return this.revert(cutId, inverseId, opts);
  }
  /** Restore: the state at `ref`, saved as a new version on the cut (nothing in between is lost: it stays in history). */
  restore(cutId: string, ref: NodeId | StateRef | string, { author = SYSTEM }: { author?: Actor } = {}): CommitResult {
    const target = typeof ref === "string" && ref.includes("@") && !ref.includes("~") ? this.stateOf(ref) : this.resolve(ref as StateRef | string).doc;
    if (!target) throw new StateUnknown(ref, "restore target not held");
    return this.commit(cutId, { doc: target, author, kind: "restore", allowEmpty: true });
  }

  // ------------------------------------------------------------ undo by actor group (§8)
  /**
   * The undo stack of an actor group on a cut, newest first: the group's own changes that a later undo hasn't
   * reverted. A change belongs to the group in its author's `group` (else the author itself). Undo changes are not
   * in the stack (they are undone by redo, not by ⌘Z). Remote teammates are never in your group.
   */
  undoStack(cutId: string, group: string): UndoEntry[] {
    const br = this.#mustCut(cutId);
    const undone = new Set<ChangeId>();
    for (const c of br.log) if (c.kind === "undo") for (const id of Array.isArray(c.reverts) ? c.reverts : c.reverts ? [c.reverts] : []) undone.add(id);
    const out: UndoEntry[] = [];
    for (let i = br.log.length - 1; i >= 0; i--) {
      const c = br.log[i]!;
      if (c.kind === "undo" || undone.has(c.id) || groupOf(c.author) !== group) continue;
      out.push({ changeId: c.id, seq: c.seq, branchId: cutId, label: this.#undoLabel(c), author: c.author, at: c.at });
    }
    return out;
  }
  #undoLabel(c: ConfirmedChange): string {
    const who = c.author.kind === "human" ? "" : `${c.author.name ?? c.author.agentType ?? c.author.id}${c.author.kind === "external" ? " (terminal)" : ""}: `;
    const what = c.name ?? E.describe(c.ops, this.stateOf(nodeId(c.branchId, c.seq - 1)) ?? {}, this.schema, c.intent)[0] ?? "change";
    return `Undo ${who}${what}`;
  }
  /**
   * ⌘Z for an actor group: invert the newest entry of its stack at the head. An agent turn (entries sharing
   * `author.turn` with the newest) is undone as one. A path an outsider has since changed that would make the result
   * invalid comes back as conflicts, never silently.
   */
  undo(cutId: string, group: string, { author, turn = true }: { author?: Actor; turn?: boolean } = {}): CommitResult & { entry?: UndoEntry } {
    const stack = this.undoStack(cutId, group);
    const top = stack[0];
    if (!top) return { status: "confirmed", seq: this.headSeq(cutId), ref: this.#refAt(cutId, this.headSeq(cutId)), change: null, empty: true, rebased: 0, notices: [] };
    const br = this.#mustCut(cutId);
    let entries = [top];
    const t = top.author.turn;
    if (turn && t) {
      entries = [];
      for (const e of stack) {
        if (e.author.turn !== t) break;
        entries.push(e);
      }
    }
    const changes = entries.map((e) => br.log[e.seq - 1]!).reverse();
    const inv = this.#inverted(cutId, changes);
    if ("cards" in inv) return { status: "conflicts", cards: inv.cards, ref: this.#refAt(cutId, br.log.length), merge: inv.merge };
    const ids = changes.map((c) => c.id);
    const r = this.commit(cutId, { doc: inv.doc, author: author ?? top.author, kind: "undo", allowEmpty: true, extra: { reverts: ids.length === 1 ? ids[0]! : ids } });
    return { ...r, entry: top };
  }

  // ------------------------------------------------------------ credits (blame)
  /** Who last changed a record, down to the subagent (`[coll, id]` or its path key). */
  credits(cutId: string, record: PathKey | readonly string[], at: number = this.headSeq(cutId)): Actor | null {
    const key = typeof record === "string" ? record : E.pathKey(record);
    const br = this.#mustCut(cutId);
    const id = key.split("/")[1];
    for (let s = at; s > 0; s--) {
      const c = br.log[s - 1]!;
      if (!touches(c, key, id)) continue;
      if (c.kind === "merge" && c.lastAuthors?.[key]) return c.lastAuthors[key]!;
      return c.author;
    }
    return br.rec.forkOf ? this.#creditsAt(br.rec.forkOf, key) : null;
  }
  #creditsAt(node: NodeId, key: PathKey): Actor | null {
    node = this.canon(node);
    const imp = this.#importedAuthors.get(node);
    if (imp) return imp[key] ?? null;
    const { branchId: b, seq: s } = parseNode(node);
    return this.#cuts.get(b)?.rec.shallow ? null : this.#cuts.has(b) ? this.credits(b, key, s) : null;
  }
  #mergeAuthors(change: ConfirmedChange, from: NodeId): void {
    const out: Record<PathKey, Actor> = {};
    for (const op of change.ops) {
      if (op.op === "remap") {
        for (const id of op.ids ?? []) {
          const key = E.pathKey([this.schema.timeline!.collection, id]);
          if (!(key in out)) out[key] = this.#creditsAt(from, key) ?? change.author;
        }
        continue;
      }
      const key = E.pathKey(op.path.slice(0, 2));
      if (key in out) continue;
      out[key] = this.#creditsAt(from, key) ?? change.author;
    }
    change.lastAuthors = out;
  }
  /** record key -> last author, in one backward pass over each cut on the first-parent line. */
  lastAuthorMap(id: NodeId): Record<PathKey, Actor> {
    const doc = this.stateOf(id);
    const want = new Set<PathKey>();
    if (doc) for (const cname in this.schema.collections) for (const r of (doc[cname] as Rec[] | undefined) ?? []) want.add(E.pathKey([cname, r[this.schema.collections[cname]!.key] as string]));
    const out: Record<PathKey, Actor> = {};
    let cur: NodeId | null = this.canon(id);
    while (cur && want.size) {
      const imp = this.#importedAuthors.get(cur);
      if (imp) {
        for (const k of [...want]) if (imp[k]) (out[k] = imp[k]), want.delete(k);
        break;
      }
      const { branchId: b, seq: s } = parseNode(cur);
      const br = this.#cuts.get(b);
      if (!br || br.rec.shallow) break;
      for (let i = s; i > 0 && want.size; i--) {
        const c = br.log[i - 1]!;
        for (const k of keysTouched(c, this.schema)) {
          if (!want.has(k)) continue;
          out[k] = (c.kind === "merge" && c.lastAuthors?.[k]) || c.author;
          want.delete(k);
        }
      }
      cur = br.rec.forkOf ? this.canon(br.rec.forkOf) : null;
    }
    return out;
  }

  // ------------------------------------------------------------ view files (§6.4, R4-02)
  /** Print a per-agent view: its header ref, with a new print nonce, and its state. */
  printView(cutId: string, name: string, { by }: { owner?: string; expires?: number; by?: string } = {}): { header: string; doc: Doc } {
    const seq = this.headSeq(cutId);
    const header = this.refString(cutId, seq, this.hashOf(nodeId(cutId, seq))!, { printNonce: randomHex(4), ...(by ? { by } : {}) });
    this.#views.set(name, { header, cutId, seq, applied: null, own: [] });
    return { header, doc: this.stateOf(nodeId(cutId, seq))! };
  }
  /**
   * A save of a view file: while its header is the one Carton last wrote (same print nonce), the base is the pinned
   * parsed state of the last applied save of this file, so earlier edits are never re-merged; after a re-print the
   * header ref is the base.
   */
  saveView(name: string, header: string, doc: Doc, { author, intent, kinds, choices }: { author: Actor; intent?: Intent | null; kinds?: Change["kinds"]; choices?: Choices }): CommitResult {
    const v = this.#views.get(name);
    let base: HeldBase;
    if (v && v.header === header && v.applied) base = { baseDoc: v.applied.state, baseSeq: v.seq, causal: [...v.own] };
    else {
      const r = this.resolve(header);
      base = { baseDoc: r.doc, baseSeq: r.seq, causal: r.causal };
    }
    const parsed = this.parseRef(header);
    const cutId = v?.cutId ?? ("branchId" in parsed ? parsed.branchId : this.#current);
    const res = this.commit(cutId, { doc, author, intent: intent ?? null, kinds: kinds ?? null, ...(choices ? { choices } : {}), base });
    if (res.status === "confirmed") {
      const nv = v && v.header === header ? v : { header, cutId, seq: base.baseSeq, applied: null, own: [] as ChangeId[] };
      nv.applied = { state: doc, hash: E.hashDoc(doc, this.schema) };
      if (res.change) nv.own.push(res.change.id);
      this.#views.set(name, nv);
    }
    return res;
  }

  // ------------------------------------------------------------ shallow .cbproj export / import (§13)
  /**
   * The lineage graph: the head, roots, fork, merge and export nodes, and imported lineage nodes. Each lineage edge
   * carries the composition of the recorded remaps along it (merge edges use the merge's per-parent edge map). States
   * of fork, merge and export nodes are carried (R5-02), delta-encoded against the head.
   */
  exportShallow(cutId: string, { to = "someone", carry = "fork-merge-export", encoding = "delta" }: { to?: string; carry?: "fork-merge-export" | "export-only" | "head-only"; encoding?: "delta" | "full" } = {}): ShallowExport {
    const head = this.head(cutId);
    const list = this.#exportsMade.get(head) ?? [];
    list.push({ to, at: this.#clock() });
    this.#exportsMade.set(head, list);
    const forkNodes = new Set<NodeId>();
    for (const b of this.#cuts.values()) if (b.rec.forkOf) forkNodes.add(this.canon(b.rec.forkOf));
    const nodes = new Map<NodeId, DagNode>();
    const kindsOf = (id: NodeId): LineageKind[] => {
      const k: LineageKind[] = [];
      if (id === head) k.push("head");
      const ln = this.#lineage.get(id);
      if (ln) k.push(...ln.kinds.filter((x) => x !== "head"));
      if (this.#exportsMade.has(id)) k.push("export");
      if (this.changeAt(id)?.mergeOf) k.push("merge");
      if (forkNodes.has(id)) k.push("fork");
      if (!this.parents(id).length) k.push("root");
      return [...new Set(k)];
    };
    const isStop = (id: NodeId) => this.#lineage.has(id) || this.#exportsMade.has(id) || this.parents(id).length !== 1 || forkNodes.has(id);
    const queue = [head];
    while (queue.length) {
      const id = queue.pop()!;
      if (nodes.has(id)) continue;
      const { branchId: b, seq: s } = parseNode(id);
      const owner = this.#lineage.get(id)?.owner ?? this.#cuts.get(b)?.rec.owner;
      const rec: DagNode = { id, branchId: b, seq: s, hash: this.hashOf(id)!, kinds: kindsOf(id), parents: [], ...(owner ? { owner } : {}) };
      nodes.set(id, rec);
      for (const p0 of this.parents(id)) {
        const maps = [this.edgeMap(p0, id)];
        let p = p0;
        while (!isStop(p)) {
          const pp = this.parents(p)[0]!;
          maps.push(this.edgeMap(pp, p));
          p = pp;
        }
        rec.parents.push({ id: p, remap: E.composeMaps(...maps.reverse()) });
        queue.push(p);
      }
    }
    // carry: "fork-merge-export" (v6+), "export-only" (v5, for the R5-02 ablation), "head-only" (v4)
    const carried = (n: DagNode) =>
      n.kinds.includes("head") || (carry !== "head-only" && (n.kinds.includes("export") || (carry !== "export-only" && (n.kinds.includes("fork") || n.kinds.includes("merge")))));
    const headDoc = this.stateOf(head)!;
    const states: ShallowExport["states"] = {};
    for (const n of nodes.values()) {
      if (!carried(n) || states[n.hash]) continue;
      const d = this.stateOf(n.id);
      if (!d) continue;
      states[n.hash] = encoding === "delta" && n.id !== head ? { delta: E.diff(headDoc, d, this.schema) } : { doc: JSON.parse(E.snapshot(d, this.schema)) };
    }
    const branches: ShallowExport["branches"] = {};
    for (const n of nodes.values()) {
      const br = this.#cuts.get(n.branchId);
      const owner = n.owner;
      branches[n.branchId] ??= { name: br?.rec.name ?? this.#lineage.get(n.id)?.branchName ?? "?", ...(owner ? { owner } : {}) };
    }
    return {
      format: "carton-shallow/1",
      projectId: this.#projectId ?? "",
      sender: this.name,
      head,
      headHash: this.hashOf(head)!,
      branches,
      nodes: [...nodes.values()],
      states,
      lastAuthor: this.lastAuthorMap(head),
    };
  }
  /**
   * Import: lineage nodes become read-only tracking knowledge; carried states are checked against their hash. A
   * project you don't have forks a writable cut from the sender's head (§5.3).
   */
  importShallow(pkg: ShallowExport): { status: "forked"; cut: string; head: NodeId } | { status: "imported"; head: NodeId } | { status: "other-project" } | { status: "no-shared-lineage"; newProjectId: string } {
    if (pkg.format !== "carton-shallow/1") throw new Error("not a shallow export");
    let fresh = false;
    if (!this.#projectId || this.#cuts.size === 0) {
      this.#projectId = pkg.projectId;
      fresh = true;
    } else if (this.#projectId !== pkg.projectId) return { status: "other-project" };
    else {
      const known = pkg.nodes.some((n) => this.#cuts.has(n.branchId) && !this.#cuts.get(n.branchId)!.rec.shallow) || pkg.nodes.some((n) => this.#lineage.has(n.id));
      if (!known) return { status: "no-shared-lineage", newProjectId: randomHex(8) };
    }
    const headState = (pkg.states[pkg.headHash] as { doc?: Doc } | undefined)?.doc;
    for (const n of pkg.nodes) {
      const br = this.#cuts.get(n.branchId);
      if (br && !br.rec.shallow) continue; // our own cut: we hold its full log
      if (!br) this.addCut({ id: n.branchId, name: pkg.branches[n.branchId]?.name ?? "?", owner: pkg.branches[n.branchId]?.owner ?? "?", shallow: true, tracking: true, forkOf: null });
      const prev = this.#lineage.get(n.id);
      const bn = pkg.branches[n.branchId]?.name;
      this.#lineage.set(n.id, { ...n, kinds: [...new Set([...(prev?.kinds ?? []), ...n.kinds])], ...(bn ? { branchName: bn } : {}) });
    }
    for (const [hash, st] of Object.entries(pkg.states)) {
      if (this.#states.has(hash)) continue;
      const doc = "doc" in st ? st.doc : headState && E.apply(E.fork(headState, this.schema), st.delta, this.schema);
      if (!doc) continue;
      if (E.hashDoc(doc, this.schema) !== hash) throw new Error(`carried state ${hash.slice(0, 8)} does not match its hash`);
      this.#states.set(hash, doc);
    }
    this.#importedAuthors.set(pkg.head, pkg.lastAuthor ?? {});
    this.#anc.clear();
    if (fresh) {
      const b = this.fork(pkg.head, pkg.branches[parseNode(pkg.head).branchId]?.name ?? "main", { kind: "main" });
      this.#current = b;
      return { status: "forked", cut: b, head: pkg.head };
    }
    return { status: "imported", head: pkg.head };
  }
  /** Full history ("Include history so they can see every version"): every cut's log, local tables dropped. */
  exportFull(): FullExport {
    return {
      format: "carton-full/1",
      projectId: this.#projectId ?? "",
      branches: [...this.#cuts.values()]
        .filter((b) => !b.rec.shallow)
        .map((b) => ({ id: b.rec.id, name: b.rec.name, forkOf: b.rec.forkOf, owner: b.rec.owner, root: b.root ? JSON.parse(E.snapshot(b.root, this.schema)) : null, log: b.log.map((c) => ({ ...c })) })),
    };
  }
  importFull(pkg: FullExport): void {
    if (pkg.format !== "carton-full/1") throw new Error("not a full export");
    this.#projectId ??= pkg.projectId;
    // parents first: a fork needs its fork node's state
    const pending = pkg.branches.filter((b) => !(this.#cuts.has(b.id) && !this.#cuts.get(b.id)!.rec.shallow));
    for (let guard = 0; pending.length && guard < 1000; guard++) {
      const i = pending.findIndex((b) => !b.forkOf || (this.#cuts.has(parseNode(b.forkOf).branchId) && !this.#cuts.get(parseNode(b.forkOf).branchId)!.rec.shallow));
      if (i < 0) throw new Error("full export: a cut forks from a cut that isn't in it");
      const b = pending.splice(i, 1)[0]!;
      this.#cuts.delete(b.id);
      const br = this.#mustCut(this.addCut({ id: b.id, name: b.name, forkOf: b.forkOf, owner: b.owner, root: b.root, tracking: true }).id);
      (br.log as ConfirmedChange[]).push(...b.log.map((c) => ({ ...c })));
    }
    this.#anc.clear();
  }
}

// ------------------------------------------------------------------ helpers

/** Does change `c` touch the record with path key `key` (id `id`)? A remap op touches the items it moved. */
function touches(c: ConfirmedChange, key: PathKey, id: string | undefined): boolean {
  for (const op of c.ops) {
    if (op.op === "remap") {
      if (id !== undefined && op.ids?.includes(id)) return true;
      continue;
    }
    if (E.pathKey(op.path.slice(0, 2)) === key) return true;
  }
  return false;
}
function keysTouched(c: ConfirmedChange, schema: Schema): PathKey[] {
  const out: PathKey[] = [];
  for (const op of c.ops) {
    if (op.op === "remap") {
      if (schema.timeline) for (const id of op.ids ?? []) out.push(E.pathKey([schema.timeline.collection, id]));
    } else out.push(E.pathKey(op.path.slice(0, 2)));
  }
  return out;
}

/**
 * Store a recorded remap as one op (§6.1, P5): when the change's per-item time sets on the remapped lanes are exactly
 * what the remap does on `base`, they are replaced by one `remap` op (which lists the ids it moves). Checked by
 * applying both forms to `base` and comparing state hashes, so a change is never stored in a form that applies
 * differently.
 */
function remapAsOneOp(schema: Schema, base: Doc, ops: Op[], intent: Intent | null): Op[] {
  const tl = schema.timeline;
  if (!tl || !intent?.maps || isEmptyMap(intent.maps) || ops.some((op) => op.op === "remap")) return ops;
  const expanded = E.expandRemap(schema, base, { maps: intent.maps });
  if (expanded.length < 4) return ops; // a remap that moves one item is no smaller as an op
  const want = new Map<string, unknown>(expanded.map((op) => [E.pathKey(op.path), op.value]));
  const rest: Op[] = [];
  let hit = 0;
  for (const op of ops) {
    if (op.op === "set" && want.has(E.pathKey(op.path)) && E.deepEqual(want.get(E.pathKey(op.path)), op.value)) hit++;
    else rest.push(op);
  }
  if (hit !== want.size) return ops;
  const ids = [...new Set(expanded.map((op) => op.path[1] as string))];
  const one: RemapOp = { op: "remap", path: ["#remap"], maps: intent.maps, ...(intent.lineage ? { lineage: intent.lineage } : {}), ids };
  // the remap goes first: it expands against the base, as the per-item sets were computed
  const candidate: Op[] = [one, ...rest];
  const a = E.apply(E.fork(base, schema), ops, schema),
    b = E.apply(E.fork(base, schema), candidate, schema);
  return E.hashDoc(a, schema) === E.hashDoc(b, schema) ? candidate : ops;
}
