// History: one replica's cuts, changes, versions, pins and DAG, in memory and synchronous (PLAN §5, §8, §13).
// Port of the verified core-v5 prototype `Replica` (`proofs/core-v5/history.mjs`), with §0.1 names (cut, fold in,
// credits, restore) and what the prototype left out: pins with owner sets (system proof Finding 4), print nonces in
// headers (Finding 3), undo by actor group (§8), restore, named versions and the log. Each writable cut has a local
// sequencer running the shared §6.1 rule (`../sequencer`); `Carton` persists all of it through a Store.

import type { Schema, SoftWarning } from "../schema.ts";
import type { ApplyNote } from "../types.ts";
import type {
  Actor,
  Change,
  ChangeId,
  ChangeKind,
  Choices,
  CommitResult,
  ConflictCard,
  ConfirmedChange,
  CutKind,
  CutRecord,
  DagNode,
  Doc,
  FullExport,
  Intent,
  Lineage as Splits,
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
import { forkSealed } from "../engine/doc.ts";
import { createLocalSequencer, type LocalSequencer } from "../sequencer/index.ts";
import type { ClosureEntry } from "../sync/messages.ts";
import { StateUnknown, type FoldOptions, type FoldResult, type HeldBase, type HistoryCommit, type HistoryOptions, type Planned, type ShallowImport, type Tail } from "./common.ts";

// ------------------------------------------------------------------ ids and keys

/** A DAG edge as a fold reads it: the remaps recorded along it, and the splits (old id -> pieces) made along it. */
type Edge = { maps?: RemapMaps; lineage?: Splits };
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
/** Changes inverted at a cut's head: the state and the remap the inversion applies there, or the cards that stop it. */
export type Inverted = { doc: Doc; maps: RemapMaps } | { cards: MergeResult["conflicts"]; merge: MergeResult };
const REF_RE = /^(.+)@(\d+)~([0-9a-f]{8}) b:([0-9a-f]{8})(?: p:(\S+))?(?: by (.+))?$/;
/**
 * A cut's `b:` token in a printed header: 8 lowercase hex characters, the only form the header's parser reads. The id's
 * first 8 characters when they are lowercase hex (every id core makes: a UUID, `cb cut new`'s 24 hex + `.n`, a renamed
 * copy's `<id>.<hash8>`), so those headers are as they always were; otherwise the first 8 of the SHA-256 of the id (an
 * id from a `.cbproj` or another host: `b6b.alt`, `ab-cdef0…`, non-ASCII), so its header still reads back. Tokens can
 * collide (a renamed copy shares its original's): `parseRef` tells the cuts apart. The one definition: the adapter's
 * header prints this.
 */
export const branchToken = (id: string): string => (/^[0-9a-f]{8}/.test(id) ? id : E.sha256Hex(id)).slice(0, 8);

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
  /** Ids whose write changed nothing: a retry with one returns the same empty confirmation, never acts again. */
  readonly #noops = new Map<ChangeId, { cutId: string; seq: number }>();
  readonly #hash = new Map<NodeId, string>();
  /** Called after a change is confirmed on a cut this replica sequences (Carton persists it). */
  onConfirmed: ((cutId: string, change: ConfirmedChange) => void) | null = null;
  /** Called when a write with an id changed nothing (Carton persists the id, so a retry stays a no-op). */
  onNoop: ((id: ChangeId, cutId: string, seq: number) => void) | null = null;
  /** Record that a write with this id changed nothing (a reload from the Store). */
  noteNoop(id: ChangeId, cutId: string, seq: number): void {
    this.#noops.set(id, { cutId, seq });
  }
  /** The confirmation a write with this id already got (a change, or an empty one), or null. */
  confirmedById(id: ChangeId | undefined): (CommitResult & { status: "confirmed" }) | null {
    return this.#done(id);
  }

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
  fork(from: NodeId | StateRef, name: string, opts: { kind?: CutKind; owner?: string; id?: string; source?: string } = {}): string {
    // a stable cut id makes a retried fork return the cut it already made
    if (opts.id && this.#cuts.has(opts.id)) return opts.id;
    const node = typeof from === "string" ? (from.includes("@") ? from : this.head(from)) : refNode(from);
    const id = this.addCut({ name, forkOf: this.canon(node), kind: opts.kind ?? "variant", owner: opts.owner, ...(opts.id ? { id: opts.id } : {}) }).id;
    if (opts.source) this.updateCut(id, { source: opts.source });
    return id;
  }
  cuts(): CutRecord[] {
    return [...this.#cuts.values()].map((c) => c.rec);
  }
  cut(cutId: string): CutRecord | undefined {
    return this.#cuts.get(cutId)?.rec;
  }
  /** Rename or re-kind a cut (only labels; its id never changes). */
  updateCut(cutId: string, patch: Partial<Pick<CutRecord, "name" | "kind" | "protected" | "sequencer" | "source">>): CutRecord {
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
    const c = this.#mustCut(cutId);
    if (c.rec.shallow) {
      // a shallow (imported) cut has no log: its head is the newest lineage node we hold for it
      let best = -1;
      for (const n of this.#lineage.values()) if (n.branchId === cutId && n.seq > best) best = n.seq;
      if (best >= 0) return nodeId(cutId, best);
    }
    return this.canon(nodeId(cutId, c.log.length));
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
    return this.#stateOf(id, false);
  }
  /**
   * The same state as History holds it, the live head itself rather than a fork: read-only, for a caller that forks
   * it anyway (Carton's head and checkout) or only reads it. Changing it changes History.
   */
  viewOf(id: NodeId): Doc | null {
    return this.#stateOf(id, true);
  }
  #stateOf(id: NodeId, live: boolean): Doc | null {
    const c = this.canon(id);
    const d = this.#stateAt(c, live);
    if (d) return d;
    // a version whose state is gone (compacted after a fork was made from it, in another process or behind a handle
    // that hadn't seen the compaction: review SF1-1) is still the state its fork keeps a copy of
    for (const cut of this.#cuts.values()) if (cut.root && cut.rec.forkOf && this.canon(cut.rec.forkOf) === c) return cut.root;
    return null;
  }
  #stateAt(id: NodeId, live = false): Doc | null {
    const { branchId: b, seq: s } = parseNode(id);
    const br = this.#cuts.get(b);
    if (!br || br.rec.shallow) {
      const ln = this.#lineage.get(id);
      return ln ? this.#states.get(ln.hash) ?? null : null;
    }
    if (s > br.log.length || s < 0) return null;
    if (s > 0 && br.log[s - 1]!.squashedInto) return null; // compacted away (§5.4)
    if (br.sq && s === br.log.length) return live ? br.sq.head : E.fork(br.sq.head, this.schema); // stateOf never hands out the live head
    let k = s;
    while (!br.kf.has(k)) k--;
    let doc = br.kf.get(k)!;
    if (k < s) {
      doc = forkSealed(doc, this.schema); // a sealed keyframe's rebuild stays sealed (engine/doc.ts)
      for (let i = k; i < s; i++) E.apply(doc, br.log[i]!.ops, this.schema);
      if (s % this.K === 0) br.kf.set(s, doc);
    }
    return doc;
  }
  hashOf(id: NodeId): string | null {
    const c = this.canon(id);
    const ln = this.#lineage.get(c);
    if (ln) return ln.hash;
    let h = this.#hash.get(c);
    if (!h) {
      const d = this.stateOf(c);
      // a squashed version's state is gone, but not its identity (SF3-5)
      if (!d) return this.changeAt(c)?.squashedHash ?? null;
      this.#hash.set(c, (h = E.hashDoc(d, this.schema)));
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
  /**
   * Confirmed rows from elsewhere (another process on the same carton.db, or an import), appended in order.
   * `keyframes`: persisted states after some of these rows (§5.4); the newest the batch reaches is where the sequencer
   * starts, instead of replaying every row before it, and each is a keyframe for `stateOf`.
   */
  load(cutId: string, rows: readonly ConfirmedChange[], keyframes: readonly (readonly [number, Doc])[] = []): void {
    const c = this.#mustCut(cutId);
    const fresh = rows.filter((r) => r.seq > c.log.length);
    if (!fresh.length) return;
    const top = fresh[fresh.length - 1]!.seq;
    let kf: readonly [number, Doc] | undefined;
    for (const k of keyframes) if (k[0] > c.log.length && k[0] <= top && (!kf || k[0] > kf[0])) kf = k;
    for (const [s, d] of keyframes) if (s > c.log.length && s <= top) c.kf.set(s, d);
    if (c.sq) c.sq.load(fresh, kf && { seq: kf[0], doc: kf[1] });
    else (c.log as ConfirmedChange[]).push(...fresh);
    // keyframes of a batch are rebuilt lazily by stateOf: the sequencer's head is already past them
    for (const r of fresh) this.#confirmed(c, r, false);
  }

  /** What an import taught this replica (lineage nodes, carried states, last authors, exports made), to persist. */
  knowledge(): { lineage: DagNode[]; states: [string, Doc][]; authors: [NodeId, Record<PathKey, Actor>][]; exports: [NodeId, { to: string; at: number }[]][] } {
    return { lineage: [...this.#lineage.values()], states: [...this.#states], authors: [...this.#importedAuthors], exports: [...this.#exportsMade] };
  }
  /** Restore persisted knowledge (before the cuts that fork from lineage nodes); exports add to those held. */
  loadKnowledge(k: Partial<ReturnType<History["knowledge"]>>): void {
    for (const n of k.lineage ?? []) this.#lineage.set(n.id, n);
    for (const [h, d] of k.states ?? []) this.#states.set(h, d);
    for (const [n, a] of k.authors ?? []) this.#importedAuthors.set(n, a);
    for (const [n, e] of k.exports ?? []) this.#exportsMade.set(n, [...(this.#exportsMade.get(n) ?? []), ...e]);
    this.#anc.clear();
  }

  // ------------------------------------------------------------ refs and pins (§5.2)
  refString(cutId: string, seq: number, hash: string, extra: { printNonce?: string; by?: string } = {}): string {
    const br = this.#mustCut(cutId);
    let s = `${br.rec.name}@${seq}~${hash.slice(0, 8)} b:${branchToken(cutId)}`;
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
    return p && { branchId: cutId, seq, hash8, hash: p.hash, pending: p.pending.slice(), delta: p.delta, owners: [...p.owners].map(([owner, expires]) => ({ owner, expires: Number.isFinite(expires) ? expires : null })) };
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
  /** Replace every pin with the rows given (a reload from the Store, where other processes pin too). */
  setPins(rows: readonly PinRow[]): void {
    this.#pins.clear();
    for (const r of rows) this.loadPin(r);
  }
  parseRef(ref: string | StateRef): (StateRef & { printNonce?: string; by?: string }) | { legacy: number } {
    if (typeof ref !== "string") return ref;
    if (/^\d{13}$/.test(ref)) return { legacy: Number(ref) }; // a 1.4.0 timestamp rev
    // a node id, `<cutId>@<seq>`, as checkout, diff and restore take it (kit-docs: commit's base refused it)
    const node = /^([^~\s]+)@(\d+)$/.exec(ref.trim());
    if (node && this.#cuts.has(node[1]!)) return { branchId: node[1]!, seq: Number(node[2]) };
    const m = REF_RE.exec(ref.trim());
    if (!m) throw new StateUnknown(ref, "unparseable ref");
    // the cut whose token `b:` is (branchToken). Two with one token (a renamed copy and its original; foreign ids whose
    // hashes meet) are told apart by which has the header's state at its seq (confirmed or pinned), then by the
    // header's cut name: a cut renamed since the print keeps its headers when another takes its old name (0760ef2)
    const seq = Number(m[2]);
    const rank = (b: Cut) => (seq <= b.log.length && (this.hashOf(nodeId(b.rec.id, seq))!.startsWith(m[3]!) || this.#pins.has(`${b.rec.id}|${seq}|${m[3]}`)) ? 2 : 0) + (b.rec.name === m[1] ? 1 : 0);
    const br = [...this.#cuts.values()].filter((b) => branchToken(b.rec.id) === m[4]).sort((x, y) => rank(y) - rank(x))[0];
    const out: StateRef & { printNonce?: string; by?: string } = { branchId: br?.rec.id ?? m[4]!, seq, hash8: m[3]! };
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
    // a shared cut is sequenced by its server: its changes go through the sync client, never confirmed here
    if (br.rec.sequencer.kind !== "local") throw new Error(`cut ${br.rec.name} is shared: its changes go through its sequencer`);
    // a Published cut takes only the change that publishes it (a held state); every other write is refused
    if (br.rec.kind === "published" && !(o.publish && br.log.length === 0)) throw new Error(`cut ${br.rec.name} is a Published cut: read-only (publish again to update it)`);
    const done = this.#done(o.id);
    if (done) return done;
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
    if (!ops.length && !extra.mergeOf && !extra.reverts) return this.#empty(o.id, cutId, br.log.length);
    // the cards `choices` decided, over every rebase pass: a pass carries head's values on its card paths forward, so
    // the union is exactly the proposals that didn't land (reported as `resolved` with the confirmation)
    const resolved: ConflictCard[] = [];
    for (let rebase = 0; ; rebase++) {
      if (rebase > 8) throw new Error("rebase loop");
      const stored = remapAsOneOp(this.schema, baseDoc, ops, change.intent);
      const ch: Change = { ...change, ops: stored, base: { seq: baseSeq, pending: causal }, ...E.declare(this.schema, baseDoc, stored, change.intent), hash: "" };
      if (rebase) Object.assign(ch, { rebase, supersedes: [change.id] });
      ch.hash = E.sha256Hex(E.canonical({ author: ch.author, base: ch.base, ops: ch.ops, intent: ch.intent, mergeOf: ch.mergeOf ?? null }));
      const prior = this.schema.soft && touchesTimeline(this.schema, stored) ? E.fork(br.sq.head, this.schema) : null;
      const res = br.sq.push(ch);
      if (res.ok) {
        this.#confirmed(br, res.change);
        this.onConfirmed?.(cutId, res.change);
        const warnings = prior && !res.duplicate ? softAfter(this.schema, br.sq.head, prior, res.change.ops) : [];
        return { status: "confirmed", seq: res.seq, ref: this.#refAt(cutId, res.seq), change: res.change, notices: res.notices, rebased: rebase, ...(warnings.length ? { warnings } : {}), ...(resolved.length ? { resolved } : {}) };
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
      // the concurrent changes' maps, lineage (a split records lineage only: kit-docs) and kinds
      const conc = E.sideOf(res.missing.filter((c) => !causal.includes(c.id)));
      const m = E.merge3(baseDoc, head, mine, this.schema, {
        remaps: { ours: conc.remap, theirs: E.intentRemap(change.intent) },
        kinds: { ours: conc.kinds, theirs: change.kinds ?? {} },
        rekeys: "ours",
      });
      let merged = m.doc;
      if (m.conflicts.length) {
        // a card the caller's choices don't name (it reviewed an earlier plan) comes back as a card, never decided
        // silently, unless the caller opted into its prefer side
        const unseen = o.unchosen === "prefer" ? [] : unseenCards(m.conflicts, o.choices);
        if (!o.choices || unseen.length)
          return { status: "conflicts", cards: m.conflicts, ref: this.#refAt(cutId, br.log.length), merge: m, ...(o.choices ? { unseen: unseen.map((c) => c.path) } : {}), retry: (choices: Choices) => this.commit(cutId, { ...o, choices }) };
        merged = E.resolve(m, o.choices);
        resolved.push(...m.conflicts);
      }
      if (!isEmptyMap(change.intent?.maps)) change.intent = { ...change.intent, maps: m.edges.ours };
      ops = E.diff(head, merged, this.schema);
      baseDoc = head;
      baseSeq = br.log.length;
      causal = [];
      mine = merged;
      if (!ops.length && !extra.mergeOf && !extra.reverts) return { ...this.#empty(o.id, cutId, baseSeq), rebased: rebase + 1, ...(resolved.length ? { resolved } : {}) };
    }
  }
  /** A version a keyframe is kept for (§5.4): named, a fold, exported, or on a Published cut. */
  milestone(id: NodeId): boolean {
    const { branchId: b } = parseNode(id);
    return this.#names.has(id) || !!this.changeAt(id)?.mergeOf || this.#exportsMade.has(id) || this.#cuts.get(b)?.rec.kind === "published";
  }
  /** A write retried with the id it already confirmed under: that confirmation, never a second change. */
  #done(id: ChangeId | undefined): (CommitResult & { status: "confirmed" }) | null {
    if (!id) return null;
    const c = this.findChange(id);
    if (c) return { status: "confirmed", seq: c.seq, ref: this.#refAt(c.branchId, c.seq), change: c, rebased: 0, notices: [] };
    const n = this.#noops.get(id);
    return n ? { status: "confirmed", seq: n.seq, ref: this.#refAt(n.cutId, n.seq), change: null, empty: true, rebased: 0, notices: [] } : null;
  }
  // an id-carrying write that changed nothing: remember it, so its retry changes nothing either
  #empty(id: ChangeId | undefined, cutId: string, seq: number): CommitResult & { status: "confirmed" } {
    if (id && !this.#noops.has(id)) {
      this.#noops.set(id, { cutId, seq });
      this.onNoop?.(id, cutId, seq);
    }
    return { status: "confirmed", seq, ref: this.#refAt(cutId, seq), change: null, empty: true, rebased: 0, notices: [] };
  }
  #refAt(cutId: string, seq: number): StateRef {
    const ref: StateRef = { branchId: cutId, seq, pending: [] };
    const h = this.#hash.get(nodeId(cutId, seq));
    if (h) (ref.hash = h), (ref.hash8 = h.slice(0, 8));
    return ref;
  }
  #confirmed(br: Cut, c: ConfirmedChange, keyframe = true): void {
    const a = actorKey(c.author);
    for (const op of c.ops) if (op.op === "insert" && op.nb) this.#creators.set(E.pathKey(op.path), a);
    if (keyframe && c.seq % this.K === 0) br.kf.set(c.seq, br.sq ? forkSealed(br.sq.head, this.schema) : this.stateOf(nodeId(br.rec.id, c.seq))!);
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
      if (c?.squashedInto) continue;
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
    return E.composeMaps(...this.#path(from, to, prefer).map((e) => e.maps));
  }
  /** The recorded edges (maps, split lineage) along one DAG path from ancestor `from` to `to`, in order. */
  #path(from: NodeId, to: NodeId, prefer: "first" | "second"): Edge[] {
    from = this.canon(from);
    const steps: Edge[] = [];
    let cur = this.canon(to);
    while (cur !== from) {
      const ps = this.parents(cur);
      const order = prefer === "second" && ps.length > 1 ? [ps[1]!, ps[0]!] : ps;
      const p = order.find((q) => q === from || this.isAncestor(from, q));
      if (p === undefined) throw new Error(`no path ${from} -> ${to}`);
      steps.push(this.#edge(p, cur));
      cur = p;
    }
    return steps.reverse();
  }
  /** An edge: a change's intent; a fold's per-parent maps and lineage; an imported lineage edge's. */
  #edge(parent: NodeId, child: NodeId): Edge {
    const ln = this.#lineage.get(child);
    if (ln) {
      const p = ln.parents.find((p) => this.canon(p.id) === parent);
      return { maps: p?.remap, lineage: p?.lineage };
    }
    const c = this.changeAt(child);
    if (!c?.mergeOf) return c?.intent ?? {};
    const second = this.canon(refNode(c.mergeOf)) === parent && this.canon(nodeId(c.branchId, c.seq - 1)) !== parent;
    return { maps: c.mergeEdges?.[second ? "second" : "first"], lineage: c.mergeEdges?.lineage?.[+second] };
  }

  // ------------------------------------------------------------ fold in, partial accept, revert, restore
  /** "Fold into …": a DAG merge of node `from` into cut `into`. */
  fold(into: string, from: NodeId, opts: FoldOptions & { remapPath?: "first" | "second" } = {}): FoldResult & { merge?: MergeResult; base?: ReturnType<History["mergeBase"]>; retry?: (choices: Choices) => FoldResult; doc?: Doc; edges?: ConfirmedChange["mergeEdges"] } {
    const { author = { kind: "human", id: this.name } as Actor, choices, prefer = "ours", missingBase = "dialog", remapPath = "first" } = opts;
    const done = opts.check ? null : this.#done(opts.id);
    if (done) return done;
    const x = this.head(into),
      y = this.canon(from);
    if (this.isAncestor(y, x)) {
      if (!opts.check && opts.id) this.#empty(opts.id, into, this.headSeq(into));
      return { status: "up-to-date" };
    }
    const base = this.mergeBase(x, y);
    if (base.missing !== undefined) {
      const who = base.missing ? this.#cuts.get(parseNode(base.missing).branchId)?.rec.owner ?? this.#lineage.get(base.missing)?.owner ?? "the sender" : "the sender";
      const dialog = {
        text: `This copy builds on a version from ${who} that you don't have. Ask ${who} for their copy, or bring it in with every difference shown as a card.`,
        options: ["ask", "all-cards"] as ["ask", "all-cards"],
        lca: base.missing,
      };
      if (missingBase !== "all-cards") return { status: "missing-base", dialog };
      const theirs = this.stateOf(y);
      if (!theirs) return { status: "missing-base", dialog };
      const cmp = E.compare2(this.stateOf(x)!, theirs, this.schema);
      const unseen = opts.unchosen === "prefer" ? [] : unseenCards(cmp.conflicts, choices);
      if (!choices || unseen.length) return { status: "compare", dialog, cards: cmp.conflicts };
      const resolved = cmp.resolve(choices, prefer);
      if (opts.check) return { status: "confirmed", seq: this.headSeq(into), ref: this.#refAt(into, this.headSeq(into)), change: null, rebased: 0, notices: [], empty: true, doc: resolved };
      // every difference decided: record it as a fold of `from`, so the next fold finds this merge as its base
      const r = this.commit(into, { doc: resolved, author, kind: "merge", ...(opts.id ? { id: opts.id } : {}), extra: { mergeOf: parseNode(y), mergeEdges: { first: {}, second: {} }, mergeBase: [] } });
      this.#anc.clear();
      if (r.status === "confirmed" && r.change) this.#mergeAuthors(r.change, y);
      return r;
    }
    const baseNode = base.node ?? base.nodes![0]!;
    // each side's recorded maps and split lineage since the base, so an edit of a clip the other side split reaches
    // every piece (kit-docs: a fold used the maps only)
    const side = (to: NodeId) => E.sideOf(this.#path(baseNode, to, remapPath).map((intent) => ({ intent }))).remap,
      Ro = side(x),
      Rt = side(y);
    const ours = this.stateOf(x)!,
      theirs = this.stateOf(y);
    if (!theirs) return { status: "missing-base", dialog: { text: "The version to fold in isn't held here.", options: ["ask", "all-cards"], lca: y } };
    const m = E.merge3(base.doc!, ours, theirs, this.schema, {
      prefer,
      remaps: { ours: Ro, theirs: Rt },
    });
    const unseen = opts.unchosen === "prefer" ? [] : unseenCards(m.conflicts, choices);
    if (m.conflicts.length && (!choices || unseen.length))
      return { status: "conflicts", cards: m.conflicts, ref: this.#refAt(into, this.headSeq(into)), merge: m, base, ...(choices ? { unseen: unseen.map((c) => c.path) } : {}), retry: (ch: Choices) => this.fold(into, from, { ...opts, choices: ch }) };
    const doc = m.conflicts.length ? E.resolve(m, choices!) : m.doc;
    // the fold's edges: each parent's maps, and the split lineage of the side it brings in (theirs onto ours, first)
    const edges = { first: m.edges.ours, second: m.edges.theirs, ...(Ro?.lineage || Rt?.lineage ? { lineage: [Rt?.lineage ?? {}, Ro?.lineage ?? {}] as [Splits, Splits] } : {}) };
    if (opts.check) return { status: "confirmed", seq: this.headSeq(into), ref: this.#refAt(into, this.headSeq(into)), change: null, rebased: 0, notices: [], empty: true, merge: m, base, doc, edges };
    const r = this.commit(into, {
      doc,
      author,
      allowEmpty: true,
      kind: "merge",
      ...(opts.id ? { id: opts.id } : {}),
      extra: { mergeOf: parseNode(y), mergeEdges: edges, mergeBase: base.node ? [base.node] : base.nodes! },
    });
    this.#anc.clear();
    if (r.status === "confirmed" && r.change) this.#mergeAuthors(r.change, y);
    return { ...r, base, merge: m };
  }
  /**
   * "Fold in some of it" (R2-14): a full fold, then an inverse change for the rejected records, which lists them. Both
   * are checked before either is committed: if restoring a rejected record would leave it invalid (say its track was
   * removed by the fold), nothing is committed and the result says why.
   */
  foldSome(into: string, from: NodeId, opts: FoldOptions & { reject: PathKey[] | readonly (readonly string[])[] }): FoldResult & { fold?: FoldResult; inverse?: CommitResult } {
    // retried with its id: the inverse (`<id>.inverse`) or, if only the fold landed, the fold
    const done = this.#done(opts.id && `${opts.id}.inverse`) ?? this.#done(opts.id);
    if (done) return done;
    const p = this.planFoldSome(into, from, opts);
    if (!("reject" in p)) return p;
    const r = this.fold(into, from, opts);
    if (r.status !== "confirmed" || !("change" in r) || !r.change) return r;
    const inv = this.commit(into, { ops: p.ops, author: opts.author ?? { kind: "human", id: this.name }, kind: "partial-revert", ...(opts.id ? { id: `${opts.id}.inverse` } : {}), extra: { rejected: p.reject, reverts: r.change.id } });
    const { merge: _m, ...invOnly } = inv as CommitResult & { merge?: unknown };
    return { ...invOnly, fold: r, inverse: inv } as FoldResult & { fold: FoldResult; inverse: CommitResult };
  }
  /**
   * Fold-some without committing (a shared cut queues it): the dry-run fold and the inverse of the rejected paths on
   * its result, checked to apply in full and to leave every record valid; or why it can't be done.
   */
  planFoldSome(into: string, from: NodeId, opts: FoldOptions & { reject: PathKey[] | readonly (readonly string[])[] }): { dry: ReturnType<History["fold"]>; ops: Op[]; reject: PathKey[] } | FoldResult {
    const dry = this.fold(into, from, { ...opts, check: true });
    if (dry.status !== "confirmed" || !dry.doc) return dry;
    const pre = this.stateOf(this.head(into))!,
      post = dry.doc;
    // one entry per path, and none under another rejected path (restoring the record restores its fields)
    const keys = [...new Set(opts.reject.map((p) => (typeof p === "string" ? p : E.pathKey(p))))];
    const reject = keys.filter((k) => !keys.some((o) => o !== k && k.startsWith(o + "/")));
    const ops = inverseOps(this.schema, pre, post, reject);
    const touched = new Map<string, Set<string>>();
    for (const op of ops) if (this.schema.collections[op.path[0] as string] && op.path.length >= 2) (touched.get(op.path[0] as string) ?? touched.set(op.path[0] as string, new Set()).get(op.path[0] as string)!).add(op.path[1] as string);
    // the inverse must apply in full (no op lost to a record the fold removed) and leave every record valid, or the
    // fold isn't committed at all
    const notes: ApplyNote[] = [];
    const after = E.apply(E.fork(post, this.schema), ops, this.schema, notes);
    if (notes.length) return { status: "rejected", reason: "invalid", invalid: { path: E.pathKey(notes[0]!.op.path), error: "that part was removed by the fold: leave out the whole record instead" } };
    const bad = E.validateHard(this.schema, after, touched);
    if (bad.length) return { status: "rejected", reason: "invalid", invalid: { path: bad[0]!.path, error: `rejecting it would leave it invalid: ${bad[0]!.errors.join("; ")}` } };
    return { dry, ops, reject };
  }
  /** Undo one change: its inverse at the head, as a 3-way merge (git revert). Intents invert as intents. */
  revert(cutId: string, changeId: ChangeId, { author, kind = "revert", id }: { author?: Actor; kind?: ChangeKind; id?: ChangeId } = {}): CommitResult {
    const done = this.#done(id);
    if (done) return done;
    const p = this.planRevert(cutId, changeId, { ...(author ? { author } : {}), kind });
    return "status" in p ? p : this.commit(cutId, { ...p, ...(id ? { id } : {}) });
  }
  /** A revert without committing (a shared cut queues it); `tail`: the cut's pending changes, which it may revert. */
  planRevert(cutId: string, changeId: ChangeId, { author, kind = "revert", tail }: { author?: Actor; kind?: ChangeKind; tail?: Tail } = {}): Planned | (CommitResult & { status: "conflicts" }) {
    const c = this.#log(cutId, tail).find((x) => x.id === changeId);
    if (!c) throw new Error(`no change ${changeId}`);
    const inv = this.#inverted(cutId, [c], tail);
    if ("cards" in inv) return { status: "conflicts", cards: inv.cards, ref: this.#refAt(cutId, this.headSeq(cutId)), merge: inv.merge };
    return { doc: inv.doc, author: author ?? c.author, kind, ...(isEmptyMap(inv.maps) ? {} : { intent: { kind: "inverse", maps: inv.maps } }), extra: { reverts: changeId } };
  }
  #log(cutId: string, tail?: Tail): readonly ConfirmedChange[] {
    const log = this.#mustCut(cutId).log;
    return tail?.rows.length ? [...log, ...tail.rows] : log;
  }
  #stateIn(cutId: string, seq: number, tail?: Tail): Doc {
    const n = this.headSeq(cutId);
    return seq > n ? tail!.states[seq - n - 1]! : this.stateOf(nodeId(cutId, seq))!;
  }
  // The head with `changes` (newest last) inverted one by one, newest first, and the remap that inversion applies at
  // the head. A change's recorded remap is inverted as a remap (§8), so what others placed since in its coordinates
  // moves back with it; the changes made since it are the other side's recorded remaps. A card in any step stops it.
  #inverted(cutId: string, changes: readonly ConfirmedChange[], tail?: Tail): Inverted {
    const log = this.#log(cutId, tail);
    let cur: Doc = tail?.states.length ? tail.states[tail.states.length - 1]! : this.#mustCut(cutId).sq!.head;
    let done: RemapMaps = {};
    for (let i = changes.length - 1; i >= 0; i--) {
      const c = changes[i]!;
      const before = this.#stateIn(cutId, (c.squashedFrom ?? c.seq) - 1, tail),
        after = this.#stateIn(cutId, c.seq, tail);
      const inv = E.invertMaps(firstParentMap(c));
      const since = E.composeMaps(...log.slice(c.seq).map(firstParentMap), done);
      const m = E.merge3(after, cur, before, this.schema, {
        infer: false,
        remaps: { ...(isEmptyMap(since) ? {} : { ours: { maps: since } }), ...(isEmptyMap(inv) ? {} : { theirs: { maps: inv } }) },
      });
      if (m.conflicts.length) return { cards: m.conflicts, merge: m };
      cur = m.doc;
      if (!isEmptyMap(inv)) done = E.composeMaps(done, m.edges.ours);
    }
    return { doc: cur, maps: done };
  }
  acceptRest(cutId: string, inverseId: ChangeId, opts: { author?: Actor } = {}): CommitResult {
    return this.revert(cutId, inverseId, opts);
  }
  /** Restore: the state at `ref`, saved as a new version on the cut (nothing in between is lost: it stays in history). */
  restore(cutId: string, ref: NodeId | StateRef | string, { author = SYSTEM, id }: { author?: Actor; id?: ChangeId } = {}): CommitResult {
    const done = this.#done(id);
    if (done) return done;
    return this.commit(cutId, { doc: this.restoreTarget(ref), author, kind: "restore", allowEmpty: true, ...(id ? { id } : {}) });
  }
  /** The state a restore writes: a node's, or a header's or StateRef's (pins included). */
  restoreTarget(ref: NodeId | StateRef | string): Doc {
    const target = typeof ref === "string" && ref.includes("@") && !ref.includes("~") ? this.stateOf(ref) : this.resolve(ref as StateRef | string).doc;
    if (!target) throw new StateUnknown(ref, "restore target not held");
    return target;
  }

  // ------------------------------------------------------------ undo by actor group (§8)
  /**
   * The undo stack of an actor group on a cut, newest first: the group's own changes that a later undo hasn't
   * reverted. A change belongs to the group in its author's `group` (else the author itself). Undo changes are not
   * in the stack (they are undone by redo, not by ⌘Z). Remote teammates are never in your group.
   */
  undoStack(cutId: string, group: string, tail?: Tail): UndoEntry[] {
    const log = this.#log(cutId, tail);
    const undone = new Set<ChangeId>();
    for (const c of log) if (c.kind === "undo") for (const id of Array.isArray(c.reverts) ? c.reverts : c.reverts ? [c.reverts] : []) undone.add(id);
    const out: UndoEntry[] = [];
    for (let i = log.length - 1; i >= 0; i--) {
      const c = log[i]!;
      if (c.kind === "undo" || c.squashedInto || undone.has(c.id) || groupOf(c.author) !== group) continue;
      out.push({ changeId: c.id, seq: c.seq, branchId: cutId, label: undoLabel(c), author: c.author, at: c.at });
    }
    return out;
  }
  /**
   * ⌘Z for an actor group: invert the newest entry of its stack at the head. An agent turn (entries sharing
   * `author.turn` with the newest) is undone as one. A path an outsider has since changed that would make the result
   * invalid comes back as conflicts, never silently.
   */
  undo(cutId: string, group: string, { author, turn = true, id }: { author?: Actor; turn?: boolean; id?: ChangeId } = {}): CommitResult & { entry?: UndoEntry } {
    const done = this.#done(id);
    if (done) return done;
    const p = this.planUndo(cutId, group, { ...(author ? { author } : {}), turn });
    if (!p) return this.#empty(id, cutId, this.headSeq(cutId));
    if ("status" in p) return p;
    const { entry, ...c } = p;
    return { ...this.commit(cutId, { ...c, ...(id ? { id } : {}) }), entry };
  }
  /**
   * What ⌘Z for an actor group would do, without doing it (a shared cut queues it): the inverse of the newest entry of
   * its stack (an agent turn as one) at the head, or the cards that stop it; null when the stack is empty.
   */
  planUndo(cutId: string, group: string, { author, turn = true, tail }: { author?: Actor; turn?: boolean; tail?: Tail } = {}): (Planned & { entry: UndoEntry }) | (CommitResult & { status: "conflicts" }) | null {
    const stack = this.undoStack(cutId, group, tail);
    const top = stack[0];
    if (!top) return null;
    const log = this.#log(cutId, tail);
    let entries = [top];
    const t = top.author.turn;
    if (turn && t) {
      entries = [];
      for (const e of stack) {
        if (e.author.turn !== t) break;
        entries.push(e);
      }
    }
    const changes = entries.map((e) => log[e.seq - 1]!).reverse();
    const inv = this.#inverted(cutId, changes, tail);
    if ("cards" in inv) return { status: "conflicts", cards: inv.cards, ref: this.#refAt(cutId, this.headSeq(cutId)), merge: inv.merge };
    const ids = changes.map((c) => c.id);
    return { doc: inv.doc, author: author ?? top.author, kind: "undo", ...(isEmptyMap(inv.maps) ? {} : { intent: { kind: "inverse", maps: inv.maps } }), extra: { reverts: ids.length === 1 ? ids[0]! : ids }, entry: top };
  }

  // ------------------------------------------------------------ credits (blame)
  /** Who last changed a record, down to the subagent (`[coll, id]` or its path key). */
  credits(cutId: string, record: PathKey | readonly string[], at: number = this.headSeq(cutId)): Actor | null {
    return this.creditsDetail(cutId, record, at)?.actor ?? null;
  }
  /**
   * Credits with when and in which change. A record a fold brought in names the fold's change and time with the
   * author the other cut recorded; a record from an imported `.cbproj` has only its author (`at`, `change` null).
   */
  creditsDetail(cutId: string, record: PathKey | readonly string[], at: number = this.headSeq(cutId)): { actor: Actor; at: number | null; change: ChangeId | null } | null {
    const key = typeof record === "string" ? record : E.pathKey(record);
    const br = this.#mustCut(cutId);
    const id = unkey(key)[1];
    for (let s = at; s > 0; s--) {
      const c = br.log[s - 1]!;
      if (!touches(c, key, id)) continue;
      return { actor: (c.kind === "merge" && c.lastAuthors?.[key]) || c.author, at: c.at, change: c.id };
    }
    return br.rec.forkOf ? this.#creditsAt(br.rec.forkOf, key) : null;
  }
  #creditsAt(node: NodeId, key: PathKey): { actor: Actor; at: number | null; change: ChangeId | null } | null {
    node = this.canon(node);
    const imp = this.#importedAuthors.get(node);
    if (imp) return imp[key] ? { actor: imp[key]!, at: null, change: null } : null;
    const { branchId: b, seq: s } = parseNode(node);
    return this.#cuts.get(b)?.rec.shallow ? null : this.#cuts.has(b) ? this.creditsDetail(b, key, s) : null;
  }
  #mergeAuthors(change: ConfirmedChange, from: NodeId): void {
    change.lastAuthors = this.authorsFrom(change.ops, from, change.author);
  }
  /** A fold's `lastAuthors`: for each record its ops touch, who last changed it on the cut folded in. */
  authorsFrom(ops: readonly Op[], from: NodeId, author: Actor): Record<PathKey, Actor> {
    const out: Record<PathKey, Actor> = {};
    for (const op of ops) {
      if (op.op === "remap") {
        for (const id of op.ids ?? []) {
          const key = E.pathKey([this.schema.timeline!.collection, id]);
          if (!(key in out)) out[key] = this.#creditsAt(from, key)?.actor ?? author;
        }
        continue;
      }
      const key = E.pathKey(op.path.slice(0, 2));
      if (key in out) continue;
      out[key] = this.#creditsAt(from, key)?.actor ?? author;
    }
    return out;
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
   * The lineage graph: the head, roots, fork, merge, export and import nodes, and imported lineage nodes. Each lineage
   * edge carries the composition of the recorded remaps along it (merge edges use the merge's per-parent edge map).
   * States of fork, merge, export and import nodes are carried (R5-02), delta-encoded against the head.
   */
  exportShallow(cutId: string, { to = "someone", carry = "fork-merge-export", encoding = "delta" }: { to?: string; carry?: "fork-merge-export" | "export-only" | "head-only"; encoding?: "delta" | "full" } = {}): ShallowExport {
    const head = this.head(cutId);
    const list = this.#exportsMade.get(head) ?? [];
    list.push({ to, at: this.#clock() });
    this.#exportsMade.set(head, list);
    const nodes = this.#walkLineage([head], head);
    // carry: "fork-merge-export" (v6+), "export-only" (v5, for the R5-02 ablation), "head-only" (v4)
    const carried = (n: DagNode) =>
      n.kinds.includes("head") || (carry !== "head-only" && (n.kinds.includes("export") || n.kinds.includes("import") || (carry !== "export-only" && (n.kinds.includes("fork") || n.kinds.includes("merge")))));
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
   * The lineage nodes reachable from `starts`, each edge compressed to the nearest fork, merge, export, import, root or
   * known lineage node (a shallow export's graph, §13, and a hand-off's closure, §5.3). Nodes of `skip` (the cut a closure
   * is for: its rows go up in full) end the walk and are left out.
   */
  #walkLineage(starts: readonly NodeId[], head?: NodeId, skip?: string): Map<NodeId, DagNode> {
    const forkNodes = new Set<NodeId>();
    for (const b of this.#cuts.values()) if (b.rec.forkOf) forkNodes.add(this.canon(b.rec.forkOf));
    const nodes = new Map<NodeId, DagNode>();
    // the §16 import (`init.asChange`: the project as it was, over the empty root) is a lineage point like an export,
    // so a shallow export carries it and two copies of the project fold from it, not from nothing (S3-4, request 8)
    const imported = (id: NodeId) => this.changeAt(id)?.kind === "import";
    const kindsOf = (id: NodeId): LineageKind[] => {
      const k: LineageKind[] = [];
      if (id === head) k.push("head");
      const ln = this.#lineage.get(id);
      if (ln) k.push(...ln.kinds.filter((x) => x !== "head"));
      if (this.#exportsMade.has(id)) k.push("export");
      if (imported(id)) k.push("import");
      if (this.changeAt(id)?.mergeOf) k.push("merge");
      if (forkNodes.has(id)) k.push("fork");
      if (!this.parents(id).length) k.push("root");
      return [...new Set(k)];
    };
    const isStop = (id: NodeId) => this.#lineage.has(id) || this.#exportsMade.has(id) || imported(id) || this.parents(id).length !== 1 || forkNodes.has(id);
    const queue = [...starts];
    while (queue.length) {
      const id = queue.pop()!;
      if (nodes.has(id)) continue;
      const { branchId: b, seq: s } = parseNode(id);
      if (b === skip) continue;
      const owner = this.#lineage.get(id)?.owner ?? this.#cuts.get(b)?.rec.owner;
      const rec: DagNode = { id, branchId: b, seq: s, hash: this.hashOf(id)!, kinds: kindsOf(id), parents: [], ...(owner ? { owner } : {}) };
      nodes.set(id, rec);
      for (const p0 of this.parents(id)) {
        const es = [this.#edge(p0, id)];
        let p = p0;
        while (!isStop(p)) {
          const pp = this.parents(p)[0]!;
          es.push(this.#edge(pp, p));
          p = pp;
        }
        const e = E.sideOf(es.reverse().map((intent) => ({ intent }))).remap;
        rec.parents.push({ id: p, remap: e?.maps ?? {}, ...(e?.lineage ? { lineage: e.lineage } : {}) });
        queue.push(p);
      }
    }
    return nodes;
  }
  /**
   * A sender whose cut has the id of one of ours but another history (the project's folder copied with its carton.db
   * before either edited: the same local cut ids). Its nodes on that cut that aren't ours (past our log, or another
   * state at the same seq) belong to the sender's own copy of the cut: they are taken as a separate cut,
   * `<cut>.<sender hash>` (a node id can't hold `~`), whose lineage still reaches the versions we share, so a fold
   * finds the real common ancestor (e2e-qa S3-4: they were dropped as "ours", and folding the sender's head read past
   * our log).
   */
  #unclash(pkg: ShallowExport): ShallowExport {
    const renamed = new Map<string, string>();
    const moved = new Set<NodeId>();
    // the sender's first version on the cut that isn't ours names its copy: the same content, the same id, across later
    // files from that sender; never the display name, which two copies share (review SF3-2)
    const first = new Map<string, DagNode>();
    for (const n of pkg.nodes) {
      const br = this.#cuts.get(n.branchId);
      if (!br || br.rec.shallow) continue;
      if (n.seq <= br.log.length) {
        const ours = this.hashOf(nodeId(n.branchId, n.seq));
        // ours, or one we can't compare (compacted before squashed versions kept their hash): taken as ours
        if (ours === n.hash || ours === null) continue;
      }
      moved.add(n.id);
      const f = first.get(n.branchId);
      if (!f || n.seq < f.seq) first.set(n.branchId, n);
    }
    for (const [b, n] of first) renamed.set(b, `${b}.${n.hash.slice(0, 8)}`);
    if (!moved.size) return pkg;
    const map = (id: NodeId): NodeId => {
      if (!moved.has(id)) return id;
      const { branchId, seq } = parseNode(id);
      return nodeId(renamed.get(branchId)!, seq);
    };
    const nodes = pkg.nodes.map((n) => ({ ...n, id: map(n.id), branchId: moved.has(n.id) ? renamed.get(n.branchId)! : n.branchId, parents: n.parents.map((p) => ({ ...p, id: map(p.id) })) }));
    const branches = { ...pkg.branches };
    for (const [ours, theirs] of renamed) branches[theirs] = { ...(pkg.branches[ours] ?? { name: "?" }), name: `${pkg.branches[ours]?.name ?? "?"} (${pkg.sender})` };
    return { ...pkg, nodes, branches, head: map(pkg.head) };
  }
  /**
   * Lineage from elsewhere (a `.cbproj`, a shared cut's closure) as read-only tracking knowledge: a node already known
   * keeps its parents (lineage is immutable; an import only adds kinds), nodes of cuts held in full are ours, the graph
   * must stay a DAG, and every carried state must match its hash. All of it is checked before anything is kept.
   */
  #takeLineage(nodes: readonly DagNode[], branches: Readonly<Record<string, { name: string; owner?: string }>>, states: readonly (readonly [string, Doc | undefined])[]): void {
    // what the lineage would be: a node already known keeps its parents (lineage is immutable; an import only adds
    // kinds), and nodes of cuts we hold in full are ours, not the sender's
    const incoming = new Map<NodeId, Lineage>();
    for (const n of nodes) {
      const at = parseNode(n.id);
      if (at.branchId !== n.branchId || at.seq !== n.seq) throw new Error(`shallow export: node ${n.id} says it is ${n.branchId}@${n.seq}`);
      const br = this.#cuts.get(n.branchId);
      if (br && !br.rec.shallow) continue;
      const prev = this.#lineage.get(n.id);
      // a node's identity never changes: one we hold under this id with another state is a different version (SF3-2)
      if (prev && prev.hash !== n.hash) throw new Error(`shallow export: node ${n.id} is another version than the one held here`);
      const bn = branches[n.branchId]?.name;
      incoming.set(n.id, { ...n, ...(prev ? { parents: prev.parents } : {}), kinds: [...new Set([...(prev?.kinds ?? []), ...n.kinds])], ...(bn ? { branchName: bn } : {}) });
    }
    // it must stay a DAG, through our own history too (a lineage edge into a local node that descends from it would
    // make every walk loop forever): iterative DFS, so a long local log can't overflow the stack
    const parentsOf = (id: NodeId): NodeId[] => {
      const ln = incoming.get(id) ?? this.#lineage.get(id);
      return ln ? ln.parents.map((p) => this.canon(p.id)) : this.parents(id);
    };
    const color = new Map<NodeId, 1 | 2>();
    for (const start of incoming.keys()) {
      if (color.has(start)) continue;
      const stack: [NodeId, NodeId[]][] = [[start, parentsOf(start)]];
      color.set(start, 1);
      while (stack.length) {
        const top = stack[stack.length - 1]!;
        const next = top[1].pop();
        if (next === undefined) {
          color.set(top[0], 2);
          stack.pop();
          continue;
        }
        const c = color.get(next);
        if (c === 1) throw new Error(`shallow export: its lineage has a cycle through ${next}`);
        if (c === 2) continue;
        color.set(next, 1);
        stack.push([next, parentsOf(next)]);
      }
    }
    const docs: [string, Doc][] = [];
    for (const [hash, doc] of states) {
      if (!doc || this.#states.has(hash)) continue;
      if (E.hashDoc(doc, this.schema) !== hash) throw new Error(`carried state ${hash.slice(0, 8)} does not match its hash`);
      docs.push([hash, doc]);
    }
    for (const n of incoming.values()) {
      if (!this.#cuts.has(n.branchId)) this.addCut({ id: n.branchId, name: branches[n.branchId]?.name ?? "?", owner: branches[n.branchId]?.owner ?? "?", shallow: true, tracking: true, forkOf: null });
      this.#lineage.set(n.id, n);
    }
    for (const [hash, doc] of docs) this.#states.set(hash, doc);
    this.#anc.clear();
  }
  /**
   * A cut's ancestry closure for its hand-off (§5.3, R4-07): the lineage of what it forked and folded from, shallow
   * (no micro-changes), with the states of its fork, merge and export nodes and the last authors at the nodes its
   * credits stop at, by cut. Its own rows 1..`upTo` go up in full beside it.
   */
  closure(cutId: string, upTo: number = this.headSeq(cutId)): ClosureEntry[] {
    const br = this.#mustCut(cutId);
    const starts = new Set(br.log.slice(0, upTo).flatMap((c) => (c.mergeOf ? [this.canon(nodeId(c.mergeOf.branchId, c.mergeOf.seq))] : [])));
    if (br.rec.forkOf) starts.add(this.canon(br.rec.forkOf));
    const out = new Map<string, ClosureEntry>();
    for (const n of this.#walkLineage([...starts], undefined, cutId).values()) {
      let e = out.get(n.branchId);
      if (!e) {
        const rec: CutRecord = this.#cuts.get(n.branchId)?.rec ?? { id: n.branchId, name: this.#lineage.get(n.id)?.branchName ?? "?", forkOf: null, owner: n.owner ?? "?", kind: "variant", tracking: true, shallow: true, sequencer: { kind: "local" } };
        out.set(n.branchId, (e = { branchId: n.branchId, rec, nodes: [], states: [] }));
      }
      e.nodes.push(n);
      // an import's state isn't carried here: a closure starts at fork points and merges, which are past it
      const d = n.kinds.some((k) => k === "fork" || k === "merge" || k === "export") ? this.stateOf(n.id) : null;
      if (d) e.states!.push({ seq: n.seq, hash: n.hash, doc: JSON.parse(E.snapshot(d, this.schema)) });
    }
    for (const s of starts) {
      const e = out.get(parseNode(s).branchId);
      if (e) (e.authors ??= []).push([s, this.lastAuthorMap(s)]);
    }
    return [...out.values()];
  }
  /**
   * A shared cut's closure from its server (Stage F): read-only shallow tracking cuts with their lineage, carried
   * states and last authors, so a teammate who joined has the credits and fold bases from before the share point.
   */
  loadClosure(entries: readonly ClosureEntry[]): void {
    const branches: Record<string, { name: string; owner?: string }> = {};
    for (const e of entries) branches[e.branchId] = { name: e.rec.name, ...(e.rec.owner ? { owner: e.rec.owner } : {}) };
    this.#takeLineage(entries.flatMap((e) => e.nodes), branches, entries.flatMap((e) => (e.states ?? []).map((st) => [st.hash, st.doc] as const)));
    for (const e of entries) for (const [n, a] of e.authors ?? []) if (!this.#importedAuthors.has(n)) this.#importedAuthors.set(n, a);
  }
  /**
   * Import: lineage nodes become read-only tracking knowledge; carried states are checked against their hash. A
   * project you don't have forks a writable cut from the sender's head (§5.3).
   */
  importShallow(pkg: ShallowExport): ShallowImport {
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
    if (!pkg.nodes.some((n) => n.id === pkg.head)) throw new Error("shallow export: its head is not one of its nodes");
    pkg = this.#unclash(pkg);
    const headState = (pkg.states[pkg.headHash] as { doc?: Doc } | undefined)?.doc;
    this.#takeLineage(pkg.nodes, pkg.branches, Object.entries(pkg.states).map(([hash, st]) => [hash, "doc" in st ? st.doc : headState && E.apply(E.fork(headState, this.schema), st.delta, this.schema)]));
    this.#importedAuthors.set(pkg.head, pkg.lastAuthor ?? {});
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

/** The remap a change applied to its cut: its intent's maps, or for a fold the edge map it applied to its first parent. */
const firstParentMap = (c: ConfirmedChange): RemapMaps | undefined => (c.mergeOf ? c.mergeEdges?.first : c.intent?.maps);

/** "Undo Director: tighter intro": who (agents only) and what (default: the change's name, intent or kind). */
export function undoLabel(c: ConfirmedChange, what: string = c.name ?? c.intent?.kind ?? c.kind ?? "edit"): string {
  const who = c.author.kind === "human" ? "" : `${c.author.name ?? c.author.agentType ?? c.author.id}${c.author.kind === "external" ? " (terminal)" : ""}: `;
  return `Undo ${who}${what}`;
}

const touchesTimeline = (schema: Schema, ops: readonly Op[]): boolean => !!schema.timeline && ops.some((op) => op.op === "remap" || op.path[0] === schema.timeline!.collection);
/**
 * §4.1: every replica runs the soft validators incrementally on what a confirmed change touched, so two plain trims
 * of neighbouring clips accepted without a merge still warn about the overlap they create. An overlap that was
 * already there before the change is not reported again.
 */
function softAfter(schema: Schema, head: Doc, prior: Doc, ops: readonly Op[]): SoftWarning[] {
  const tl = schema.timeline!;
  const touched = new Map<string, Set<string>>();
  const placed = new Set<string>();
  const add = (coll: string, id: string) => (touched.get(coll) ?? touched.set(coll, new Set()).get(coll)!).add(id);
  for (const op of ops) {
    if (op.op === "remap") {
      for (const id of op.ids ?? []) add(tl.collection, id), placed.add(id);
      continue;
    }
    if (!schema.collections[op.path[0] as string] || op.path.length < 2) continue;
    add(op.path[0] as string, op.path[1] as string);
    const f = op.path[2];
    if (op.path[0] === tl.collection && op.op !== "remove" && (op.path.length === 2 || f === tl.start || f === tl.end || f === tl.lane)) placed.add(op.path[1] as string);
  }
  // `fresh` = placed: each placed item is checked against its whole lane, not only against the other placed items
  return schema.soft!(head, touched, [prior], placed, placed);
}
/** A path key back to its segments (`~1` is `/`, `~0` is `~`). */
const unkey = (k: PathKey): string[] => k.split("/").map(E.unescapeSegment);

/** Ops that put each rejected record (or field) of `post` back to its value in `pre`. */
function inverseOps(schema: Schema, pre: Doc, post: Doc, reject: readonly (PathKey | readonly string[])[]): Op[] {
  const ops: Op[] = [];
  for (const p of reject) {
    const path = typeof p === "string" ? unkey(p) : [...p];
    const a = E.getIn(post, path, schema),
      b = E.getIn(pre, path, schema);
    if (E.deepEqual(a, b)) continue;
    // a whole record goes back as an insert, a remove, or its field ops; anything else (a root field such as the
    // project name, a nested field) is set back to its value, or unset
    const record = path.length === 2 && !!schema.collections[path[0]!];
    if (record && a === undefined) ops.push({ op: "insert", path, value: b });
    else if (record && b === undefined) ops.push({ op: "remove", path });
    else if (record) ops.push(...E.diff({ [path[0]!]: [a] }, { [path[0]!]: [b] }, schema));
    else ops.push(b === undefined ? { op: "unset", path } : { op: "set", path, value: b });
  }
  return ops;
}

/** Cards a list or map of choices doesn't decide (a function decides every card). */
export function unseenCards(cards: readonly ConflictCard[], choices: Choices | undefined): ConflictCard[] {
  if (!choices || typeof choices === "function") return [];
  if (Array.isArray(choices)) return cards.filter((_, i) => choices[i] === undefined);
  return cards.filter((c) => !(c.path in choices));
}

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
