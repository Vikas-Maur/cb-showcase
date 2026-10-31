// createSequencer: the pure sequencer core (PLAN §6.1, §6.3, §5.3, §12). It validates and orders pushes, never
// merges, renders or keeps document state, and holds nothing in memory that its storage can't rebuild. A host
// (Durable Object, Node) feeds it authenticated connections and messages; it answers on those connections and fans
// confirmed rows out to every connection subscribed to the branch.
//
// Protocol, per connection:
// - `hello` subscribes the connection to a branch, claims the replica's rids for its device credential (R10-02), lists
//   which of its in-flight ids are already confirmed or withdrawn (R10-01, bounded scan), and sends the rows since
//   `have`, or the latest keyframe plus the rows after it when more than K behind (§6.3).
// - `push` carries pending changes in queue order, pipelined. Each is judged by the shared rule (`evaluatePush`); an
//   accepted row is fanned out to every subscriber, the pusher included, before its ack, so a later reject never
//   needs to re-send rows. A reject kills the rest of that epoch: later messages of the epoch are ignored, and the
//   client resubmits its queue in a new one.
// - `withdraw` spends an absorbed change's id with a withdraw row (H1), so a late push of it is acked as withdrawn.
// - `adopt` / `branchStatus` are the idempotent hand-off (§5.3); `fork` makes a server-side variant (O(1)).
// - `keyframe` stores a state a replica uploaded when an ack asked for one (`keyframeWanted`).
// - `presence` is relayed to the branch's other subscribers and never stored (§12).

import type { AuthContext, AuthProvider, BlobStore, SequencerConnection, SequencerStorage } from "@carton/core/plugins";
import type { Change, CutRecord, Doc, Op, Rec, TimelineConfig } from "@carton/core";
import { sequencer as rules } from "@carton/core";
import type { sync } from "@carton/core";
import { Tables, type Row, type StoredBranch, FLAG_STRUCTURAL, FLAG_WITHDRAWN } from "./tables.ts";

type ClientMessage = sync.ClientMessage;
type ServerMessage = sync.ServerMessage;
type RejectReason = sync.RejectReason;
type ConfirmedId = sync.ConfirmedId;
type PendingClaim = sync.PendingClaim;

/** Cardboard's timeline, the default when a host doesn't pass its schema's. */
export const CARDBOARD_TIMELINE: TimelineConfig = {
  collection: "timelineItems",
  lanes: "tracks",
  lane: "trackId",
  start: "startTime",
  end: "endTime",
  source: "trimStart",
  sourceEnd: "trimEnd",
  speed: "playbackSpeed",
};

/** Per-connection protocol state. A host that hibernates keeps it with the socket and hands it back (`conn.state`). */
export interface ConnectionState {
  /** Branches the connection said `hello` on: fan-out goes to these. */
  subs: string[];
  /** The newest epoch a reject killed: messages of that epoch or older are ignored (§6.2 pipelining). */
  deadEpoch: number;
}

/** A host's connection. `state`, when present, is where the sequencer keeps this connection's protocol state. */
export interface HostConnection extends SequencerConnection {
  state?: ConnectionState;
}

/** Something that happened, for metrics, logs and the load harness. Never contains document content. */
export type SequencerEvent =
  | { type: "accept"; branchId: string; id: string; seq: number; lww: boolean }
  | { type: "reject"; branchId: string; id: string | undefined; reason: RejectReason }
  | { type: "duplicate"; branchId: string; id: string; seq: number; withdrawn: boolean }
  | { type: "withdraw"; branchId: string; id: string; seq: number }
  | { type: "adopt"; branchId: string; n: number; repeat: boolean }
  | { type: "keyframe"; branchId: string; seq: number; mismatch: boolean }
  | { type: "ridClaimConflict"; rid: string };

export interface SequencerStats {
  pushes: number;
  accepts: number;
  rejects: number;
  rejectReasons: Partial<Record<RejectReason, number>>;
  duplicates: number;
  withdraws: number;
  lww: number;
  adopts: number;
  adoptRepeats: number;
  ridClaimConflicts: number;
  keyframes: number;
  rowsRead: number;
  rowsWritten: number;
}

/** Controls for the conformance suite's negative tests and the P9 comparisons only. Never set them in a host. */
export interface SequencerControls extends rules.RuleControls {
  keying?: rules.Keying;
  /** "connection": bind rids to one connection, not the device credential (the R10-02 control). false: no binding. */
  bindRid?: "credential" | "connection" | false;
  /** "latest-only": v10's one row per record (the per-branch existence control). */
  records?: "history" | "latest-only";
  /** false: no confirmed-id lists (the R10-01 control). */
  confirmedList?: boolean;
  /** false: the "behind" reject carries no list (an unpinned v12 rule, now pinned by a test). */
  listOnBehind?: boolean;
  /** "newest": scan only from each claim's newest base (an unpinned v12 rule, now pinned by a test). */
  claimScan?: "every-base" | "newest";
  /** false: ignore the rids a hello claims (an unpinned v12 rule, now pinned by a test). */
  helloRidClaim?: boolean;
}

export interface SequencerOptions {
  storage: SequencerStorage;
  auth: AuthProvider;
  /** Keyframes, archived change segments and bodies over 1 MB (R2 in production). Without it they stay in SQL. */
  blobs?: BlobStore;
  /** The schema's timeline (which collection holds items, their field names). Default: Cardboard's. */
  timeline?: TimelineConfig;
  /** The field group a field belongs to (`"time"`). Default: the timeline's time group. */
  groupOf?: (collection: string, field: string) => string | undefined;
  /** Collections whose records' existence the sequencer tracks. Default: the timeline's lanes and items. */
  collections?: readonly string[];
  /** The project this sequencer serves; connections authenticated for another project are refused. */
  projectId?: string;
  /** K: how far behind a push may be before it is rejected without a scan (default 100). */
  maxBehind?: number;
  /** Ask for a keyframe every this many confirmed changes (default 64). */
  keyframeEvery?: number;
  /** The newest schemaVersion this sequencer accepts in hello. */
  schemaVersion?: number;
  /** Rows per catch-up message (default 1000). */
  catchupLimit?: number;
  /** Change bodies over this go to a blob (default 1 MB, §5.1). */
  maxInlineBytes?: number;
  clock?: () => number;
  onEvent?: (e: SequencerEvent) => void;
  controls?: SequencerControls;
}

export interface Sequencer {
  /**
   * Handle one message from an authenticated connection. Messages are handled one at a time, in call order, even when
   * one has to wait for the blob store; the promise resolves once this message is fully handled.
   */
  handle(conn: SequencerConnection, msg: ClientMessage): Promise<void>;
  /** Register a connection without a message: a host re-attaches its sockets (and their `state`) after a wake. */
  attach(conn: SequencerConnection): void;
  /** The connection closed: drop it from fan-out (its rid bindings stay: they belong to the credential). */
  disconnect(conn: SequencerConnection): void;
  /** Cancel a share (§5.3: an explicit server-side operation): the branch and its log are removed. */
  cancelShare(branchId: string): void;
  /** Create a branch the server sequences from seq `rootSeq` (a host's admin path, and tests). */
  createBranch(rec: CutRecord, init: { doc0: Doc | null; rootSeq?: number; stateHash?: string; forkOf?: { branchId: string; seq: number } }): Promise<void>;
  /** Move rows older than `head - keep` into blob segments (§6.3 archive). Needs `blobs`. */
  archive(branchId: string, opts?: { keep?: number; segmentRows?: number }): Promise<number>;
  /**
   * Periodic work, for a DO alarm or a Node timer: archive every branch's old rows to blob segments. Resolves with
   * the rows moved and when to call again. A no-op without `blobs`.
   */
  maintain(): Promise<{ archived: number; nextAt: number | null }>;
  readonly stats: SequencerStats;
  /** The tables (read access for hosts' admin tools and tests). */
  readonly tables: Tables;
}

const WRITE_ROLES = new Set(["owner", "editor"]);
const enc = new TextEncoder();
const dec = new TextDecoder();
const ridOf = (id: string) => {
  const i = id.indexOf(".");
  return i > 0 ? id.slice(0, i) : id;
};

export function createSequencer(opts: SequencerOptions): Sequencer {
  const controls = opts.controls ?? {};
  const tl = opts.timeline ?? CARDBOARD_TIMELINE;
  const K = opts.maxBehind ?? rules.DEFAULT_MAX_BEHIND;
  const KF = opts.keyframeEvery ?? 64;
  const catchup = opts.catchupLimit ?? 1000;
  const maxInline = opts.maxInlineBytes ?? 1 << 20;
  const clock = opts.clock ?? Date.now;
  const collections = opts.collections ?? [tl.lanes, tl.collection];
  const cfg: rules.RulesConfig = {
    timeline: tl,
    maxBehind: K,
    keying: controls.keying ?? "v3-spans",
    groupOf: opts.groupOf ?? rules.timeGroupOf(tl),
    controls,
  };
  const tables = new Tables(opts.storage, { records: controls.records ?? "history" });
  const stats: SequencerStats = {
    pushes: 0,
    accepts: 0,
    rejects: 0,
    rejectReasons: {},
    duplicates: 0,
    withdraws: 0,
    lww: 0,
    adopts: 0,
    adoptRepeats: 0,
    ridClaimConflicts: 0,
    keyframes: 0,
    get rowsRead() {
      return opts.storage.stats?.().rowsRead ?? tables.meter.rowsRead;
    },
    get rowsWritten() {
      return opts.storage.stats?.().rowsWritten ?? tables.meter.rowsWritten;
    },
  };
  const emit = (e: SequencerEvent) => opts.onEvent?.(e);

  // ---------------------------------------------------------------- connections and fan-out
  const conns = new Map<string, HostConnection>();
  const stateOf = (c: HostConnection): ConnectionState => (c.state ??= { subs: [], deadEpoch: -1 });
  const attach = (c: SequencerConnection) => {
    conns.set(c.id, c as HostConnection);
    stateOf(c as HostConnection);
  };
  const fanout = (branchId: string, msg: ServerMessage, except?: string) => {
    for (const c of conns.values()) if (c.id !== except && stateOf(c).subs.includes(branchId)) c.send(msg);
  };
  const credentialOf = (c: HostConnection) => (controls.bindRid === "connection" ? `conn:${c.id}` : c.auth.credential);

  const view = (branchId: string): rules.SequencerView => ({
    head: () => tables.head(branchId),
    tail: (after) => tables.tail(branchId, after),
    record: (coll, id) => tables.record(branchId, coll, id),
  });

  // ---------------------------------------------------------------- the confirmed-id list (R10-01, bounded: R12-01)
  // A push on base b can only have been confirmed in (b, b + K + 1]: read the id column of those ranges only.
  const MAX_CLAIM_BASES = 256;
  function confirmedOf(branchId: string, claims: readonly PendingClaim[] | undefined): ConfirmedId[] {
    if (controls.confirmedList === false || !claims?.length) return [];
    const head = tables.head(branchId);
    const want = new Set<string>();
    const bases = new Set<number>();
    for (const c of claims) {
      if (typeof c?.id !== "string" || !Array.isArray(c.bases)) continue;
      want.add(c.id);
      const bs = c.bases.filter((b) => Number.isInteger(b) && b >= 0 && b < head);
      if (controls.claimScan === "newest") {
        if (bs.length) bases.add(Math.max(...bs));
      } else for (const b of bs) bases.add(b);
    }
    if (!want.size || !bases.size) return [];
    // merge the ranges so overlapping claims never read a row twice; cap the work a hostile hello can ask for
    const sorted = [...bases].sort((a, b) => a - b).slice(0, MAX_CLAIM_BASES);
    const out: ConfirmedId[] = [];
    let lo = -1, hi = -1;
    const flush = () => {
      if (hi > lo) for (const e of tables.idsIn(branchId, lo, hi)) if (want.has(e.id)) out.push(e);
    };
    for (const b of sorted) {
      const top = Math.min(b + K + 1, head);
      if (b <= hi) hi = Math.max(hi, top);
      else {
        flush();
        lo = b;
        hi = top;
      }
    }
    flush();
    return out;
  }

  // ---------------------------------------------------------------- rows for catch-up (live and archived)
  async function fillBody(r: { row: Row; blob: string | null }): Promise<Row> {
    if (!r.blob) return r.row;
    const bytes = await opts.blobs?.get(r.blob);
    if (!bytes) throw new Error(`change body ${r.blob} is missing from the blob store`);
    return { ...r.row, ...(JSON.parse(dec.decode(bytes)) as Partial<Row>) } as Row;
  }
  async function readRows(branchId: string, after: number, limit: number): Promise<Row[]> {
    const out: Row[] = [];
    const firstLive = tables.firstLive(branchId) ?? tables.head(branchId) + 1;
    if (after + 1 < firstLive && opts.blobs) {
      for (const seg of tables.segmentsAfter(branchId, after)) {
        if (seg.lo >= firstLive - 1 || out.length >= limit) break;
        const bytes = await opts.blobs.get(seg.blob);
        if (!bytes) throw new Error(`segment ${seg.blob} is missing from the blob store`);
        const raw = JSON.parse(dec.decode(bytes)) as Record<string, string | number | null>[];
        for (const r of raw) {
          if (Number(r.seq) <= after || out.length >= limit) continue;
          const rr = { ...r, ops: r.ops === null ? null : enc.encode(String(r.ops)) } as Record<string, string | number | null | Uint8Array>;
          out.push(await fillBody(Tables.toRow(rr, branchId)));
        }
      }
    }
    const from = out.length ? out[out.length - 1]!.seq : after;
    if (out.length < limit) for (const r of tables.rows(branchId, from, limit - out.length)) out.push(await fillBody(r));
    return out;
  }
  async function loadKeyframe(branchId: string, k: { seq: number; hash: string; blob: string | null; doc: string | null }): Promise<sync.KeyframeData> {
    let docText = k.doc;
    if (docText === null && k.blob) {
      const bytes = await opts.blobs?.get(k.blob);
      if (!bytes) throw new Error(`keyframe ${k.blob} is missing from the blob store`);
      docText = dec.decode(bytes);
    }
    return { seq: k.seq, stateHash: k.hash, doc: JSON.parse(docText ?? "null") as Doc };
  }
  async function storeKeyframe(branchId: string, seq: number, stateHash: string, doc: Doc | null): Promise<void> {
    const body = JSON.stringify(doc);
    if (opts.blobs) {
      const key = `keyframes/${branchId}/${seq}`;
      await opts.blobs.put(key, enc.encode(body), { contentType: "application/json" });
      tables.putKeyframe(branchId, seq, stateHash, { blob: key });
    } else tables.putKeyframe(branchId, seq, stateHash, { inline: body });
  }

  // ---------------------------------------------------------------- record writes for rows the server didn't judge
  function recordWritesOf(ops: readonly Op[]): rules.RecordWrite[] {
    const out = new Map<string, rules.RecordWrite>();
    for (const op of ops) {
      if (op.op === "remap") continue;
      const coll = String(op.path[0]), id = String(op.path[1]);
      if (op.path.length === 2 && (op.op === "insert" || op.op === "remove")) {
        const lane = op.op === "insert" && coll === tl.collection ? String((op.value as Rec)?.[tl.lane]) : undefined;
        out.set(`${coll}\u0000${id}`, lane === undefined ? { coll, id, alive: op.op === "insert" } : { coll, id, alive: true, lane });
      } else if (coll === tl.collection && op.path.length === 3 && op.path[2] === tl.lane && op.op === "set") {
        out.set(`${coll}\u0000${id}`, { coll, id, alive: true, lane: String(op.value) });
      }
    }
    return [...out.values()];
  }

  async function createBranch(rec: CutRecord, init: { doc0: Doc | null; rootSeq?: number; stateHash?: string; forkOf?: { branchId: string; seq: number } }, rows: readonly Row[] = [], adoptKey: string | null = null) {
    const root = init.rootSeq ?? 0;
    if (init.doc0 !== null) await storeKeyframe(rec.id, root, init.stateHash ?? "", init.doc0);
    tables.transaction(() => {
      tables.putBranch({ id: rec.id, rec, forkOf: init.forkOf ?? null, root, since: root + rows.length, adoptKey });
      const doc = init.doc0 as Record<string, unknown> | null;
      if (doc) for (const coll of collections) for (const r of (doc[coll] as Rec[] | undefined) ?? []) {
        const lane = coll === tl.collection ? (r[tl.lane] as string | undefined) : undefined;
        tables.putRecord(rec.id, coll, String(r.id), root, true, lane);
      }
      let seq = root;
      for (const row of rows) {
        if (row.seq !== ++seq) throw new Error(`adopt: rows must be ${root + 1}..n in order (got ${row.seq} for ${seq})`);
        const stored = { paths: rules.storedPaths(row), structural: rules.isStructural(row.ops, row.intent, tl) };
        tables.append(rec.id, row, stored, recordWritesOf(row.ops), { inline: Tables.body(row) });
      }
    });
  }

  // ---------------------------------------------------------------- handlers
  function reject(c: HostConnection, branchId: string, id: string | undefined, reason: RejectReason, epoch: number, extra: Partial<sync.RejectMsg> = {}) {
    stats.rejects++;
    stats.rejectReasons[reason] = (stats.rejectReasons[reason] ?? 0) + 1;
    stateOf(c).deadEpoch = Math.max(stateOf(c).deadEpoch, epoch);
    emit({ type: "reject", branchId, id, reason });
    c.send({ type: "reject", branchId, id, reason, head: tables.branch(branchId) ? tables.head(branchId) : 0, concurrent: [], epoch, ...extra });
  }

  /** The rid check (§6.3): a replica id belongs to the device credential that first used it. */
  function ridOk(c: HostConnection, id: string): boolean {
    if (controls.bindRid === false) return true;
    const rid = ridOf(id), who = credentialOf(c);
    const bound = tables.ridOwner(rid);
    if (bound === undefined) {
      tables.bindRid(rid, who);
      return true;
    }
    return bound === who;
  }

  function writable(c: HostConnection, branchId: string): RejectReason | null {
    const b = tables.branch(branchId);
    if (!b) return "unknown branch";
    if (b.tracking) return "read-only branch";
    if (!WRITE_ROLES.has(c.auth.role)) return "forbidden";
    if (c.auth.branches && !c.auth.branches.includes(branchId)) return "forbidden";
    return null;
  }

  async function onHello(c: HostConnection, m: sync.HelloMsg) {
    const b = tables.branch(m.branchId);
    if (!b) return c.send({ type: "unknownBranch", branchId: m.branchId });
    if (opts.schemaVersion !== undefined && m.schemaVersion > opts.schemaVersion) return c.send({ type: "error", reason: `schemaVersion ${m.schemaVersion} is newer than this server's ${opts.schemaVersion}` });
    const st = stateOf(c);
    if (!st.subs.includes(m.branchId)) st.subs.push(m.branchId);
    // R10-02: the replica claims every rid it has used; each unbound one is bound to this device credential
    if (controls.helloRidClaim !== false && controls.bindRid !== false && WRITE_ROLES.has(c.auth.role)) {
      const who = credentialOf(c);
      for (const rid of (m.rids ?? []).slice(0, 4096)) {
        if (typeof rid !== "string") continue;
        const bound = tables.ridOwner(rid);
        if (bound === undefined) tables.bindRid(rid, who);
        else if (bound !== who) {
          stats.ridClaimConflicts++;
          emit({ type: "ridClaimConflict", rid });
        }
      }
    }
    const head = tables.head(m.branchId);
    const confirmed = confirmedOf(m.branchId, m.pending);
    let from = Math.max(-1, Math.min(m.have, head));
    let keyframe: sync.KeyframeData | undefined;
    // below the root (a fresh joiner sends have: -1), or more than K behind: the latest keyframe, then its tail
    if (from < b.root || head - from > K) {
      const k = tables.latestKeyframe(m.branchId, head);
      if (k && k.seq > from) {
        keyframe = await loadKeyframe(m.branchId, k);
        from = k.seq;
      } else if (from < b.root) return c.send({ type: "error", reason: `no state at or after ${b.root} for ${m.branchId}` });
    }
    const rows = await readRows(m.branchId, from, catchup);
    const last = rows.length ? rows[rows.length - 1]!.seq : from;
    const msg: sync.WelcomeMsg = { type: "hello", branchId: m.branchId, head, rows, confirmed };
    if (keyframe) msg.keyframe = keyframe;
    if (last < head) msg.more = true;
    c.send(msg);
  }

  async function onPush(c: HostConnection, m: sync.PushMsg) {
    const st = stateOf(c);
    if (m.epoch <= st.deadEpoch) return; // a later change of a rejected chain: the client resubmits it
    const bad = writable(c, m.branchId);
    if (bad) return reject(c, m.branchId, m.changes?.[0]?.id, bad, m.epoch);
    if (!st.subs.includes(m.branchId)) return c.send({ type: "error", reason: `push before hello on ${m.branchId}` });
    for (const ch of Array.isArray(m.changes) ? m.changes : []) {
      stats.pushes++;
      if (typeof ch?.id !== "string") return reject(c, m.branchId, undefined, "bad change", m.epoch);
      if (!ridOk(c, ch.id)) return reject(c, m.branchId, ch.id, "foreign id", m.epoch);
      const head0 = tables.head(m.branchId);
      if (Number.isInteger(ch.base?.seq) && head0 - ch.base.seq > K) {
        // the K cap (§6.3): no scan of the log, only the bounded id list for this push's changes
        const list = controls.listOnBehind === false ? undefined : confirmedOf(m.branchId, m.changes.map((x) => ({ id: x.id, bases: [x.base?.seq ?? 0] })));
        return reject(c, m.branchId, ch.id, "behind", m.epoch, list ? { confirmed: list } : {});
      }
      const row: Row = { ...ch, branchId: m.branchId, rebase: ch.rebase ?? 0, seq: 0 };
      const bodyText = Tables.body(row);
      let body: { inline: string } | { blob: string } = { inline: bodyText };
      if (bodyText.length > maxInline) {
        if (!opts.blobs) return reject(c, m.branchId, ch.id, "too large", m.epoch);
        const key = `changes/${m.branchId}/${ch.hash || ch.id}`;
        await opts.blobs.put(key, enc.encode(bodyText), { contentType: "application/json", ifAbsent: true });
        body = { blob: key };
      }
      const verdict = tables.transaction(() => {
        const v = rules.evaluatePush(view(m.branchId), ch, cfg);
        if (v.kind === "accept") {
          row.seq = tables.head(m.branchId) + 1;
          tables.append(m.branchId, row, { paths: rules.storedPaths(ch), structural: v.structural }, v.records, body);
        }
        return v;
      });
      if (verdict.kind === "duplicate") {
        stats.duplicates++;
        emit({ type: "duplicate", branchId: m.branchId, id: ch.id, seq: verdict.seq, withdrawn: verdict.withdrawn });
        c.send({ type: "ack", branchId: m.branchId, id: ch.id, seq: verdict.seq, epoch: m.epoch, duplicate: true, ...(verdict.withdrawn ? { withdrawn: true } : {}) });
        continue;
      }
      if (verdict.kind === "reject") {
        const extra: Partial<sync.RejectMsg> = verdict.detail ? { detail: verdict.detail } : {};
        if (verdict.reason === "overlap" || verdict.reason === "base unknown") {
          const past = new Set(ch.base.pending);
          extra.concurrent = tables.tail(m.branchId, ch.base.seq).filter((r) => !past.has(r.id)).map((r) => ({ seq: r.seq, id: r.id }));
        }
        return reject(c, m.branchId, ch.id, verdict.reason, m.epoch, extra);
      }
      stats.accepts++;
      if (verdict.lww) stats.lww++;
      emit({ type: "accept", branchId: m.branchId, id: ch.id, seq: row.seq, lww: verdict.lww });
      fanout(m.branchId, { type: "changes", branchId: m.branchId, rows: [row] });
      if (verdict.lww) for (const o of verdict.overwrote) fanout(m.branchId, { type: "overwritten", branchId: m.branchId, id: o.id, by: row.id, author: row.author });
      const ack: sync.AckMsg = { type: "ack", branchId: m.branchId, id: ch.id, seq: row.seq, epoch: m.epoch };
      if (row.seq % KF === 0 && !tables.keyframeAt(m.branchId, row.seq)) ack.keyframeWanted = row.seq;
      c.send(ack);
    }
  }

  function onWithdraw(c: HostConnection, m: sync.WithdrawMsg) {
    const st = stateOf(c);
    if (m.epoch <= st.deadEpoch) return;
    const bad = writable(c, m.branchId);
    if (bad) return reject(c, m.branchId, m.id, bad, m.epoch);
    if (typeof m.id !== "string" || !Number.isInteger(m.base) || m.base < 0) return reject(c, m.branchId, m.id, "bad change", m.epoch);
    if (!ridOk(c, m.id)) return reject(c, m.branchId, m.id, "foreign id", m.epoch);
    const head = tables.head(m.branchId);
    if (m.base > head) return reject(c, m.branchId, m.id, "base unknown", m.epoch);
    if (head - m.base > K) {
      const list = controls.listOnBehind === false ? undefined : confirmedOf(m.branchId, [{ id: m.id, bases: [m.base] }]);
      return reject(c, m.branchId, m.id, "behind", m.epoch, list ? { confirmed: list } : {});
    }
    const row: Row = {
      id: m.id,
      hash: "",
      author: { kind: "system", id: "withdraw" },
      branchId: m.branchId,
      base: { seq: m.base, pending: [] },
      ops: [],
      intent: null,
      kinds: null,
      policy: "merge",
      at: clock(),
      paths: [],
      reads: [],
      spans: [],
      trackOrder: [],
      rebase: 0,
      seq: 0,
      withdrawn: true,
    };
    const dup = tables.transaction(() => {
      // the id may already be confirmed (a late push won the race) or withdrawn: answer with that, write nothing
      for (const r of tables.tail(m.branchId, m.base)) if (r.id === m.id) return r;
      row.seq = tables.head(m.branchId) + 1;
      tables.append(m.branchId, row, { paths: [], structural: false }, [], { inline: Tables.body(row) });
      return null;
    });
    if (dup) {
      stats.duplicates++;
      emit({ type: "duplicate", branchId: m.branchId, id: m.id, seq: dup.seq, withdrawn: dup.withdrawn });
      return c.send({ type: "ack", branchId: m.branchId, id: m.id, seq: dup.seq, epoch: m.epoch, duplicate: true, ...(dup.withdrawn ? { withdrawn: true } : {}) });
    }
    stats.withdraws++;
    emit({ type: "withdraw", branchId: m.branchId, id: m.id, seq: row.seq });
    fanout(m.branchId, { type: "changes", branchId: m.branchId, rows: [row] });
    c.send({ type: "ack", branchId: m.branchId, id: m.id, seq: row.seq, epoch: m.epoch, withdrawn: true });
  }

  async function onAdopt(c: HostConnection, m: sync.AdoptMsg) {
    if (!WRITE_ROLES.has(c.auth.role)) return c.send({ type: "adoptError", branchId: m.branchId, reason: "forbidden" });
    const key = `${m.branchId}|${m.n}|${m.stateHash}`;
    const b = tables.branch(m.branchId);
    if (b) {
      if (b.adoptKey === key) {
        stats.adoptRepeats++;
        emit({ type: "adopt", branchId: m.branchId, n: m.n, repeat: true });
        return c.send({ type: "adopted", branchId: m.branchId, since: m.n, repeat: true });
      }
      return c.send({ type: "adoptError", branchId: m.branchId, reason: "branch exists with another log" });
    }
    const rootSeq = m.rootSeq ?? 0;
    if (rootSeq + (m.rows?.length ?? 0) !== m.n) return c.send({ type: "adoptError", branchId: m.branchId, reason: `rows ${rootSeq + 1}..${m.n} expected` });
    await createBranch(m.rec, { doc0: m.doc0, rootSeq, stateHash: rootSeq === m.n ? m.stateHash : "" }, (m.rows ?? []) as Row[], key);
    // the ancestry closure goes up shallow, as read-only tracking branches (§5.3, R4-07)
    tables.transaction(() => {
      for (const t of m.closure ?? []) {
        if (tables.branch(t.branchId)) continue;
        tables.putBranch({ id: t.branchId, rec: t.rec, forkOf: null, root: 0, since: 0, adoptKey: null, tracking: true, nodes: t.nodes });
      }
    });
    stats.adopts++;
    emit({ type: "adopt", branchId: m.branchId, n: m.n, repeat: false });
    c.send({ type: "adopted", branchId: m.branchId, since: m.n });
  }

  function onBranchStatus(c: HostConnection, m: sync.BranchStatusMsg) {
    const b = tables.branch(m.branchId);
    c.send({ type: "status", branchId: m.branchId, adopted: !!b, adoptKey: b?.adoptKey ?? null, since: b?.since ?? null, head: b ? tables.head(m.branchId) : 0 });
  }

  async function onFork(c: HostConnection, m: sync.ForkMsg) {
    if (!WRITE_ROLES.has(c.auth.role)) return c.send({ type: "error", reason: "forbidden" });
    const parent = tables.branch(m.from);
    if (!parent) return c.send({ type: "unknownBranch", branchId: m.from });
    if (!(Number.isInteger(m.seq) && m.seq >= parent.root && m.seq <= tables.head(m.from))) return c.send({ type: "error", reason: `fork point ${m.seq} is outside ${m.from}` });
    if (!tables.branch(m.branchId)) await createBranch(m.rec, { doc0: null, forkOf: { branchId: m.from, seq: m.seq } });
    c.send({ type: "forked", branchId: m.branchId, from: m.from, seq: m.seq });
  }

  async function onKeyframe(c: HostConnection, m: sync.KeyframeMsg) {
    if (!WRITE_ROLES.has(c.auth.role)) return;
    const b = tables.branch(m.branchId);
    const k = m.keyframe;
    if (!b || !k || !Number.isInteger(k.seq) || k.seq < b.root || k.seq > tables.head(m.branchId)) return;
    const have = tables.keyframeAt(m.branchId, k.seq);
    if (have) {
      // first upload wins; a different hash from another replica is reported, never stored over it
      if (have.hash !== k.stateHash) emit({ type: "keyframe", branchId: m.branchId, seq: k.seq, mismatch: true });
      return;
    }
    await storeKeyframe(m.branchId, k.seq, k.stateHash, k.doc);
    stats.keyframes++;
    emit({ type: "keyframe", branchId: m.branchId, seq: k.seq, mismatch: false });
  }

  function onPresence(c: HostConnection, m: sync.PresenceMsg) {
    if (!stateOf(c).subs.includes(m.branchId)) return;
    // relayed, never stored; the actor is stamped from the connection, not trusted from the client
    const actor = { ...(m.actor ?? {}), kind: m.actor?.kind ?? "human", id: m.actor?.id ?? c.auth.account } as sync.PresenceFanoutMsg["actor"];
    fanout(m.branchId, { type: "presence", branchId: m.branchId, actor, state: m.state ?? null }, c.id);
  }

  async function process(c: HostConnection, msg: ClientMessage): Promise<void> {
    if (opts.projectId !== undefined && c.auth.projectId !== opts.projectId) return c.send({ type: "error", reason: "this token is for another project" });
    if (c.auth.expires < clock()) return c.send({ type: "error", reason: "token expired" });
    switch (msg?.type) {
      case "hello":
        return onHello(c, msg);
      case "push":
        return onPush(c, msg);
      case "withdraw":
        return onWithdraw(c, msg);
      case "adopt":
        return onAdopt(c, msg);
      case "branchStatus":
        return onBranchStatus(c, msg);
      case "fork":
        return onFork(c, msg);
      case "keyframe":
        return onKeyframe(c, msg);
      case "presence":
        return onPresence(c, msg);
      default:
        return c.send({ type: "error", reason: `unknown message type ${(msg as { type?: unknown })?.type}` });
    }
  }

  // one message at a time per project, even across awaits on the blob store
  let queue: Promise<void> = Promise.resolve();
  return {
    handle(conn, msg) {
      const c = conn as HostConnection;
      if (!conns.has(c.id)) attach(c);
      const run = queue.then(() => process(c, msg));
      queue = run.catch(() => {});
      return run.catch((e: unknown) => {
        c.send({ type: "error", reason: `internal: ${e instanceof Error ? e.message : String(e)}` });
      });
    },
    attach,
    disconnect(conn) {
      conns.delete(conn.id);
    },
    cancelShare(branchId) {
      tables.dropBranch(branchId);
    },
    createBranch: (rec, init) => {
      const run = queue.then(() => createBranch(rec, init));
      queue = run.catch(() => {});
      return run;
    },
    async archive(branchId, { keep = 4 * K, segmentRows = 1024 } = {}) {
      if (!opts.blobs) throw new Error("archive needs a blob store");
      const blobs = opts.blobs;
      const run = queue.then(async () => {
        let moved = 0;
        for (;;) {
          const head = tables.head(branchId);
          const first = tables.firstLive(branchId);
          if (first === null || first - 1 + segmentRows > head - keep) return moved;
          const lo = first - 1, hi = lo + segmentRows;
          const raw = tables.rawRange(branchId, lo, hi);
          const json = raw.map((r) => ({ ...r, ops: r.ops instanceof Uint8Array ? dec.decode(r.ops) : r.ops }));
          const key = `segments/${branchId}/${hi}`;
          await blobs.put(key, enc.encode(JSON.stringify(json)), { contentType: "application/json" });
          const ids = raw.map((r) => [Number(r.seq), String(r.id), Number(r.flags ?? 0) & (FLAG_STRUCTURAL | FLAG_WITHDRAWN), Number(r.k ?? 0)] as [number, string, number, number]);
          tables.transaction(() => {
            tables.putSegment(branchId, lo, hi, key, ids);
            tables.deleteRange(branchId, lo, hi);
          });
          moved += raw.length;
        }
      });
      queue = run.then(() => {}, () => {});
      return run;
    },
    async maintain() {
      if (!opts.blobs) return { archived: 0, nextAt: null };
      let archived = 0;
      for (const id of tables.branchIds()) if (!tables.branch(id)?.tracking) archived += await this.archive(id);
      return { archived, nextAt: clock() + MAINTAIN_EVERY_MS };
    },
    stats,
    tables,
  };
}

const MAINTAIN_EVERY_MS = 60 * 60 * 1000;

export type { AuthContext, Change, StoredBranch };
