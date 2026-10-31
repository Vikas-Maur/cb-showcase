// createSequencer: the pure sequencer core (PLAN §6.1, §6.3, §5.3, §12). It validates and orders pushes, never
// merges, renders or keeps document state, and holds nothing in memory that its storage can't rebuild. A host
// (Durable Object, Node) feeds it authenticated connections and messages; it answers on those connections and fans
// confirmed rows out to every connection subscribed to the branch.
//
// Protocol, per connection:
// - `hello` subscribes the connection to a branch, claims the replica's rids for its device credential (R10-02), lists
//   which of its in-flight ids are already confirmed or withdrawn (R10-01, bounded scan), and sends the rows since
//   `have`, or the latest keyframe plus the rows after it when more than K behind (§6.3), a page at a time: at most
//   1,000 rows and 4 MiB (`catchupBytes`), with `more` until the client is caught up.
// - `push` carries pending changes in queue order, pipelined. Each is judged by the shared rule (`evaluatePush`); an
//   accepted row is fanned out to every subscriber, the pusher included, before its ack, so a later reject never
//   needs to re-send rows. A reject kills the rest of that epoch: later messages of the epoch are ignored, and the
//   client resubmits its queue in a new one.
// - `withdraw` spends an absorbed change's id with a withdraw row (H1), so a late push of it is acked as withdrawn.
// - `adopt` / `branchStatus` are the idempotent hand-off (§5.3); `fork` makes a server-side variant (O(1)).
// - `keyframe` stores a state a replica uploaded when an ack asked for one (`keyframeWanted`).
// - `presence` is relayed to the branch's other subscribers and never stored (§12).
// - Any message over 1 MiB either way travels as an envelope through the blob store (`sync/envelope.ts`): a client's is
//   opened (and its blob deleted) before the message is handled; the server's go to connections whose hello said
//   `envelopes`, one upload per message however many connections it goes to, in order with the rest.

import type { AuthContext, AuthProvider, BlobStore, SequencerConnection, SequencerStorage } from "@carton/core/plugins";
import type { Change, CutRecord, Doc, Op, Rec, TimelineConfig } from "@carton/core";
import { sequencer as rules, sha256Hex, sync } from "@carton/core";
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
  /** The client reads envelopes (its hello said so): messages over 1 MiB go to it as blob references. */
  envelopes?: boolean;
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
  /** Presence updates dropped by the per-connection cap. */
  presenceDropped: number;
  rowsRead: number;
  rowsWritten: number;
  /** Envelopes opened (from clients) and sealed (to clients: one per message, however many connections). */
  envelopesIn: number;
  envelopesOut: number;
}

/** Controls for the conformance suite's negative tests and the P9 comparisons only. Never set them in a host. */
export interface SequencerControls extends rules.RuleControls {
  /** Another overlap test (the P9 comparison keyings, the pre-v12 classifier): `@carton/conformance` rule-variants. */
  overlap?: rules.OverlapRule;
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
  /** Merged claim ranges read per message (default 256): lowered by a test of the cap. */
  claimRanges?: number;
}

export interface SequencerOptions {
  storage: SequencerStorage;
  auth: AuthProvider;
  /** Keyframes, archived change segments and bodies over 1 MB (R2 in production). Without it they stay in SQL. */
  blobs?: BlobStore;
  /** The schema's timeline (which collection holds items, their field names). Default: Cardboard's; null: none. */
  timeline?: TimelineConfig | null;
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
  /**
   * Bytes per catch-up message (default 4 MiB, keyframe included): a page stops before the row that would pass it,
   * always holding at least one, so a reply (and what the sequencer loads for it) is at most this plus one row.
   */
  catchupBytes?: number;
  /** Change bodies over this go to a blob (default 1 MB, §5.1). */
  maxInlineBytes?: number;
  /** Messages over this many bytes travel as envelopes through `blobs` (default 1 MiB). */
  envelopeBytes?: number;
  /** The largest message read from a client's envelope (default 64 MiB; a Durable Object has 128 MB of memory). */
  maxEnvelopeBytes?: number;
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
  /**
   * Move rows older than `head - keep` into gzip-compressed blob segments of `segmentRows` rows (§6.3, §18: keep
   * 10,000, one segment per 10,000). Needs `blobs`. Each archived row costs one DELETE (a row written on a DO).
   */
  archive(branchId: string, opts?: { keep?: number; segmentRows?: number }): Promise<number>;
  /**
   * Periodic work, for a DO alarm or a Node timer: archive every branch's old rows to blob segments and delete
   * envelope blobs past their keep. Resolves with the rows moved, the blobs swept and when to call again. A no-op
   * without `blobs`.
   */
  maintain(opts?: { keep?: number; segmentRows?: number }): Promise<{ archived: number; swept: number; nextAt: number | null }>;
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
  // omitted: Cardboard's timeline; null: the editor's schema has none (spans and tracks are then never checked)
  const timeline = opts.timeline === undefined ? CARDBOARD_TIMELINE : opts.timeline;
  const tl = timeline ?? rules.NO_TIMELINE;
  const K = opts.maxBehind ?? rules.DEFAULT_MAX_BEHIND;
  const KF = opts.keyframeEvery ?? 64;
  const catchup = opts.catchupLimit ?? 1000;
  const catchupBytes = opts.catchupBytes ?? 4 << 20;
  const maxInline = opts.maxInlineBytes ?? 1 << 20;
  const clock = opts.clock ?? Date.now;
  const collections = opts.collections ?? (timeline ? [tl.lanes, tl.collection] : []);
  const cfg: rules.RulesConfig = {
    timeline,
    maxBehind: K,
    ...(controls.overlap ? { overlap: controls.overlap } : {}),
    groupOf: opts.groupOf ?? rules.timeGroupOf(timeline),
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
    presenceDropped: 0,
    get rowsRead() {
      return opts.storage.stats?.().rowsRead ?? tables.meter.rowsRead;
    },
    get rowsWritten() {
      return opts.storage.stats?.().rowsWritten ?? tables.meter.rowsWritten;
    },
    envelopesIn: 0,
    envelopesOut: 0,
  };
  const emit = (e: SequencerEvent) => opts.onEvent?.(e);

  // ---------------------------------------------------------------- connections and fan-out
  const conns = new Map<string, HostConnection>();
  const stateOf = (c: HostConnection): ConnectionState => (c.state ??= { subs: [], deadEpoch: -1 });
  const attach = (c: SequencerConnection) => {
    conns.set(c.id, c as HostConnection);
    stateOf(c as HostConnection);
  };

  // ---------------------------------------------------------------- sending: in order, oversized ones as envelopes
  const envelopeBytes = opts.envelopeBytes ?? sync.ENVELOPE_BYTES;
  const outboxes = new Map<string, sync.Outbox<ServerMessage>>();
  /** The envelope for `msg` when it is over the threshold (its upload started); null: it goes inline. */
  function sealed(msg: ServerMessage): Promise<sync.EnvelopeMsg> | null {
    if (!opts.blobs || !MAYBE_BIG.has(msg.type)) return null;
    const big = sync.oversized(msg, envelopeBytes);
    if (!big) return null;
    stats.envelopesOut++;
    const now = clock();
    return sync.seal(big, opts.blobs, (sha) => sync.serverEnvelopeKey(sha, now));
  }
  /** Send on `c` after what was sent before; `env`: the envelope already made for this message (a fan-out's). */
  function send(c: HostConnection, msg: ServerMessage, env?: Promise<sync.EnvelopeMsg> | null): void {
    let out = outboxes.get(c.id);
    if (!out) outboxes.set(c.id, (out = new sync.Outbox((m) => c.send(m))));
    const e = stateOf(c).envelopes ? (env === undefined ? sealed(msg) : env) : null;
    out.push(msg, e ?? undefined);
  }
  const fanout = (branchId: string, msg: ServerMessage, except?: string) => {
    let env: Promise<sync.EnvelopeMsg> | null | undefined; // made once, for the first subscriber that reads envelopes
    for (const c of conns.values()) {
      if (c.id === except || !stateOf(c).subs.includes(branchId)) continue;
      if (stateOf(c).envelopes && env === undefined) env = sealed(msg);
      send(c, msg, env ?? null);
    }
  };
  /** A client's envelope: its message, checked; its blob deleted (read once). Null after telling the client it was lost. */
  async function openEnvelope(c: HostConnection, m: sync.EnvelopeMsg): Promise<ClientMessage | null> {
    const lost = (why: string, reconnect: boolean) => {
      send(c, { type: "error", reason: `envelope: ${why}`, ...(reconnect ? { reconnect: true } : {}) });
      return null;
    };
    if (!opts.blobs) return lost("this server has no blob store", false);
    const max = opts.maxEnvelopeBytes ?? 64 << 20;
    // too big to read: dropped unread (resending it can't help, so no reconnect)
    if (Number(m.ref?.size) > max) {
      if (sync.envelopeKeyOk(m.ref, "client")) await opts.blobs.delete(m.ref.key).catch(() => {});
      return lost(`${m.ref.size} bytes (the limit is ${max})`, false);
    }
    let inner: unknown;
    try {
      inner = await sync.unseal(m.ref, opts.blobs, { from: "client", maxBytes: max });
    } catch (e) {
      return lost(e instanceof Error ? e.message : String(e), true);
    }
    stats.envelopesIn++;
    await opts.blobs.delete(m.ref.key).catch(() => {}); // read once; the sweep gets any delete that fails
    return inner as ClientMessage;
  }
  const credentialOf = (c: HostConnection) => (controls.bindRid === "connection" ? `conn:${c.id}` : c.auth.credential);

  const view = (branchId: string): rules.SequencerView => ({
    head: () => tables.head(branchId),
    tail: (after) => tables.tail(branchId, after),
    record: (coll, id) => tables.record(branchId, coll, id),
    records: (coll, ids) => tables.records(branchId, coll, ids),
  });

  // ---------------------------------------------------------------- the confirmed-id list (R10-01, bounded: R12-01)
  // A push on base b can only have been confirmed in (b, b + K + 1]: read the id column of those ranges only.
  const MAX_CLAIM_RANGES = 256;
  /**
   * The ids of `claims` confirmed or withdrawn. At most MAX_CLAIM_RANGES merged ranges are read per message (a
   * hostile hello can't ask for more); bases past that are reported in `uncheckedFrom`, never treated as unconfirmed:
   * the client asks again for those before acting on the list (review finding 10).
   */
  function confirmedOf(branchId: string, claims: readonly PendingClaim[] | undefined): { list: ConfirmedId[]; uncheckedFrom: number | null } {
    if (controls.confirmedList === false || !claims?.length) return { list: [], uncheckedFrom: null };
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
    if (!want.size || !bases.size) return { list: [], uncheckedFrom: null };
    // merge the ranges so overlapping claims never read a row twice
    const sorted = [...bases].sort((a, b) => a - b);
    const out: ConfirmedId[] = [];
    let lo = -1, hi = -1, ranges = 0;
    const flush = () => {
      if (hi > lo) for (const e of tables.idsIn(branchId, lo, hi)) if (want.has(e.id)) out.push(e);
    };
    for (const b of sorted) {
      const top = Math.min(b + K + 1, head);
      if (b <= hi) hi = Math.max(hi, top);
      else {
        flush();
        if (++ranges > (controls.claimRanges ?? MAX_CLAIM_RANGES)) return { list: out, uncheckedFrom: b };
        lo = b;
        hi = top;
      }
    }
    flush();
    return { list: out, uncheckedFrom: null };
  }

  // ---------------------------------------------------------------- rows for catch-up (live and archived)
  /** A row with its body from the blob store when it has one; `bytes`: that body's size (0 for an inline body). */
  async function fillBody(r: { row: Row; blob: string | null }): Promise<{ row: Row; bytes: number }> {
    if (!r.blob) return { row: r.row, bytes: 0 };
    const bytes = await opts.blobs?.get(r.blob);
    if (!bytes) throw new Error(`change body ${r.blob} is missing from the blob store`);
    return { row: { ...r.row, ...(JSON.parse(dec.decode(bytes)) as Partial<Row>) } as Row, bytes: bytes.byteLength };
  }
  /**
   * A catch-up page: the rows after `after`, at most `limit` of them and `budget` bytes of reply JSON. It stops before
   * the row that would pass the budget, except that it always holds one row when `atLeastOne` (the client must make
   * progress; a big single row then goes as an envelope). Live rows are sized from their stored lengths before any is
   * loaded, so a page never loads much more than it sends; the client asks again while `more` (§6.3).
   */
  async function readRows(branchId: string, after: number, limit: number, budget: number, atLeastOne: boolean): Promise<Row[]> {
    const out: Row[] = [];
    let used = 0, count = 0, full = false;
    /** Count a row of `size` bytes in if it fits; false (the page is full) when it doesn't. */
    const fits = (size: number): boolean => {
      if (count >= limit || ((count || !atLeastOne) && used + size > budget)) return !(full = true);
      used += size;
      count++;
      return true;
    };
    const firstLive = tables.firstLive(branchId) ?? tables.head(branchId) + 1;
    if (after + 1 < firstLive && opts.blobs) {
      for (const seg of tables.segmentsAfter(branchId, after)) {
        if (seg.lo >= firstLive - 1 || full) break;
        const stored = await opts.blobs.get(seg.blob);
        if (!stored) throw new Error(`segment ${seg.blob} is missing from the blob store`);
        const bytes = seg.blob.endsWith(".gz") ? await gunzip(stored) : stored;
        const raw = JSON.parse(dec.decode(bytes)) as Record<string, string | number | null>[];
        for (const r of raw) {
          if (Number(r.seq) <= after) continue;
          const ops = r.ops === null ? null : enc.encode(String(r.ops));
          const rr = { ...r, ops } as Record<string, string | number | null | Uint8Array>;
          const { row, bytes: body } = await fillBody(Tables.toRow(rr, branchId));
          if (!fits(segmentRowBytes(r, ops, branchId) + body)) break;
          out.push(row);
        }
      }
    }
    if (full) return out;
    // live rows: sized from their stored lengths first (no body read), then only those that fit are loaded
    const from = out.length ? out[out.length - 1]!.seq : after;
    const sizes = tables.rowSizes(branchId, from, limit - count);
    let loaded = used;
    let take = 0;
    while (take < sizes.length && fits(sizes[take]!)) take++;
    if (!take) return out;
    for (const [i, r] of tables.rows(branchId, from, take).entries()) {
      const { row, bytes } = await fillBody(r);
      // a body in the blob store wasn't in the sizes: once one takes the page past the budget, the rest of the rows
      // (that one too, unless it is the page's first) open the next page
      loaded += sizes[i]! + bytes;
      if ((out.length || !atLeastOne) && loaded > budget) break;
      out.push(row);
    }
    return out;
  }
  /** A stored keyframe, with its document's size in reply bytes (at most). */
  async function loadKeyframe(branchId: string, k: { seq: number; hash: string; blob: string | null; doc: string | null }): Promise<{ keyframe: sync.KeyframeData; bytes: number }> {
    let docText = k.doc;
    let bytes = 3 * (docText?.length ?? 0);
    if (docText === null && k.blob) {
      const stored = await opts.blobs?.get(k.blob);
      if (!stored) throw new Error(`keyframe ${k.blob} is missing from the blob store`);
      docText = dec.decode(stored);
      bytes = stored.byteLength;
    }
    return { keyframe: { seq: k.seq, stateHash: k.hash, doc: JSON.parse(docText ?? "null") as Doc }, bytes: bytes + 128 };
  }
  // Where a keyframe's document goes: a blob (uploaded first, outside any transaction; an orphan blob is harmless) or
  // inline in SQL (the DO-blob fallback). Synchronous without a blob store, so set-up paths stay synchronous.
  function placeKeyframe(branchId: string, seq: number, doc: Doc | null): { blob: string } | { inline: string } | Promise<{ blob: string }> {
    const body = JSON.stringify(doc);
    if (!opts.blobs) return { inline: body };
    const key = `keyframes/${branchId}/${seq}/${sha256Hex(body)}`;
    return opts.blobs.put(key, enc.encode(body), { contentType: "application/json", ifAbsent: true }).then(() => ({ blob: key }));
  }
  function storeKeyframe(branchId: string, seq: number, stateHash: string, doc: Doc | null): void | Promise<void> {
    const where = placeKeyframe(branchId, seq, doc);
    if (where instanceof Promise) return where.then((w) => tables.putKeyframe(branchId, seq, stateHash, w));
    tables.putKeyframe(branchId, seq, stateHash, where);
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

  interface BranchInit {
    doc0: Doc | null;
    rootSeq?: number;
    stateHash?: string;
    forkOf?: { branchId: string; seq: number };
  }
  /**
   * Create a branch atomically: the branch row, its root keyframe, its records and its rows commit together or not at
   * all, and the caches are dropped if the transaction fails (review finding 5). An existing branch is never replaced.
   * `rids`: the credential that uploaded the rows, bound to their replica ids (review finding 11).
   */
  function createBranch(rec: CutRecord, init: BranchInit, rows: readonly Row[] = [], adoptKey: string | null = null, rids?: string): void | Promise<void> {
    const root = init.rootSeq ?? 0;
    let seq = root;
    for (const row of rows) if (row?.seq !== ++seq) throw new Error(`rows must be ${root + 1}..${root + rows.length} in order (got ${row?.seq} for ${seq})`);
    const where = init.doc0 !== null ? placeKeyframe(rec.id, root, init.doc0) : null;
    if (where instanceof Promise) return where.then((w) => writeBranch(rec, init, rows, adoptKey, w, rids));
    writeBranch(rec, init, rows, adoptKey, where, rids);
  }
  function writeBranch(rec: CutRecord, init: BranchInit, rows: readonly Row[], adoptKey: string | null, kf: { blob: string } | { inline: string } | null, rids?: string): void {
    const root = init.rootSeq ?? 0;
    try {
      tables.transaction(() => {
        tables.insertBranch({ id: rec.id, rec, forkOf: init.forkOf ?? null, root, since: root + rows.length, adoptKey });
        if (kf) tables.putKeyframe(rec.id, root, init.stateHash ?? "", kf);
        const doc = init.doc0 as Record<string, unknown> | null;
        if (doc) for (const coll of collections) for (const r of (doc[coll] as Rec[] | undefined) ?? []) {
          const lane = coll === tl.collection ? (r[tl.lane] as string | undefined) : undefined;
          tables.putRecord(rec.id, coll, String(r.id), root, true, lane);
        }
        for (const row of rows) {
          const clean = rowFrom(row, rec.id, row.seq);
          const stored = { paths: rules.storedPaths(clean), structural: rules.isStructural(clean.ops, clean.intent, timeline) };
          tables.append(rec.id, clean, stored, recordWritesOf(clean.ops), { inline: Tables.body(clean) });
          if (rids !== undefined && controls.bindRid !== false && typeof row.id === "string" && tables.ridOwner(ridOf(row.id)) === undefined) tables.bindRid(ridOf(row.id), rids);
        }
      });
    } catch (e) {
      tables.forget(rec.id);
      throw e;
    }
  }

  /**
   * A confirmed row from a client's change: only the fields a change may carry. The server's own fields (`seq`,
   * `withdrawn`, `blob`) are never taken from the client (review finding 6).
   */
  function rowFrom(ch: Change, branchId: string, seq: number): Row {
    const row: Row = {
      id: ch.id,
      hash: typeof ch.hash === "string" ? ch.hash : "",
      author: ch.author,
      branchId,
      base: { seq: ch.base?.seq ?? 0, pending: [...(ch.base?.pending ?? [])] },
      ops: ch.ops,
      intent: ch.intent ?? null,
      kinds: ch.kinds ?? null,
      policy: ch.policy,
      at: typeof ch.at === "number" ? ch.at : 0,
      paths: ch.paths,
      reads: ch.reads,
      spans: ch.spans,
      trackOrder: ch.trackOrder,
      rebase: Number.isInteger(ch.rebase) ? ch.rebase! : 0,
      seq,
    };
    for (const k of HISTORY_FIELDS) if (ch[k] !== undefined) (row as unknown as Record<string, unknown>)[k] = ch[k];
    return row;
  }

  // ---------------------------------------------------------------- handlers
  function reject(c: HostConnection, branchId: string, id: string | undefined, reason: RejectReason, epoch: number, extra: Partial<sync.RejectMsg> = {}) {
    stats.rejects++;
    stats.rejectReasons[reason] = (stats.rejectReasons[reason] ?? 0) + 1;
    stateOf(c).deadEpoch = Math.max(stateOf(c).deadEpoch, epoch);
    emit({ type: "reject", branchId, id, reason });
    send(c, { type: "reject", branchId, id, reason, head: tables.branch(branchId) ? tables.head(branchId) : 0, concurrent: [], epoch, ...extra });
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

  /** May this connection write to `branchId` (role and the token's cut scope, §14)? Checked by every mutation. */
  function mayWrite(c: HostConnection, branchId: string): boolean {
    return WRITE_ROLES.has(c.auth.role) && (!c.auth.branches || c.auth.branches.includes(branchId));
  }
  function writable(c: HostConnection, branchId: string): RejectReason | null {
    const b = tables.branch(branchId);
    if (!b) return "unknown branch";
    if (b.tracking) return "read-only branch";
    if (!mayWrite(c, branchId)) return "forbidden";
    return null;
  }

  async function onHello(c: HostConnection, m: sync.HelloMsg) {
    const b = tables.branch(m.branchId);
    if (!b) return send(c, { type: "unknownBranch", branchId: m.branchId });
    if (opts.schemaVersion !== undefined && m.schemaVersion > opts.schemaVersion) return send(c, { type: "error", reason: `schemaVersion ${m.schemaVersion} is newer than this server's ${opts.schemaVersion}` });
    const st = stateOf(c);
    if (m.envelopes === true && opts.blobs) st.envelopes = true;
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
    const { list: confirmed, uncheckedFrom } = confirmedOf(m.branchId, m.pending);
    let from = Math.max(-1, Math.min(m.have, head));
    let keyframe: sync.KeyframeData | undefined;
    let budget = catchupBytes;
    // below the root (a fresh joiner sends have: -1), or more than K behind: the latest keyframe, then its tail. A
    // client that found a keyframe's hash wrong asks for rows only (noKeyframe).
    if (from < b.root || (head - from > K && !m.noKeyframe)) {
      const k = tables.latestKeyframe(m.branchId, head);
      if (k && k.seq > from) {
        const loaded = await loadKeyframe(m.branchId, k);
        keyframe = loaded.keyframe;
        budget -= loaded.bytes; // the keyframe is part of the page
        from = k.seq;
      } else if (from < b.root) return send(c, { type: "error", reason: `no state at or after ${b.root} for ${m.branchId}` });
    }
    // by rows and by bytes: the client asks again while `more`. With a keyframe the page may hold no row (the keyframe
    // is its progress); without one it holds at least one (a big single row then goes as an envelope).
    const rows = await readRows(m.branchId, from, catchup, budget, !keyframe);
    const last = rows.length ? rows[rows.length - 1]!.seq : from;
    const msg: sync.WelcomeMsg = { type: "hello", branchId: m.branchId, head, rows, confirmed };
    if (keyframe) msg.keyframe = keyframe;
    if (uncheckedFrom !== null) msg.uncheckedFrom = uncheckedFrom;
    if (last < head) msg.more = true;
    // fan-out starts with the last page: a subscriber still paging would get live rows ahead of its backlog (finding 3)
    else if (!st.subs.includes(m.branchId)) st.subs.push(m.branchId);
    send(c, msg);
  }

  async function onPush(c: HostConnection, m: sync.PushMsg) {
    const st = stateOf(c);
    if (m.epoch <= st.deadEpoch) return; // a later change of a rejected chain: the client resubmits it
    const bad = writable(c, m.branchId);
    if (bad) return reject(c, m.branchId, m.changes?.[0]?.id, bad, m.epoch);
    if (!st.subs.includes(m.branchId)) return send(c, { type: "error", reason: `push before hello on ${m.branchId}` });
    for (const ch of Array.isArray(m.changes) ? m.changes : []) {
      stats.pushes++;
      if (typeof ch?.id !== "string") return reject(c, m.branchId, undefined, "bad change", m.epoch);
      if (!ridOk(c, ch.id)) return reject(c, m.branchId, ch.id, "foreign id", m.epoch);
      const head0 = tables.head(m.branchId);
      if (Number.isInteger(ch.base?.seq) && head0 - ch.base.seq > K) {
        // the K cap (§6.3): no scan of the log, only the bounded id list for this push's changes
        const r = controls.listOnBehind === false ? undefined : confirmedOf(m.branchId, m.changes.map((x) => ({ id: x.id, bases: [x.base?.seq ?? 0] })));
        return reject(c, m.branchId, ch.id, "behind", m.epoch, r ? { confirmed: r.list, ...(r.uncheckedFrom !== null ? { uncheckedFrom: r.uncheckedFrom } : {}) } : {});
      }
      if (declarationTooLarge(ch)) return reject(c, m.branchId, ch.id, "too large", m.epoch);
      const row = rowFrom(ch, m.branchId, 0);
      // judge first: a rejected push never pays for serializing its body. A body over the inline limit goes to the
      // blob store (async), and the push is judged again afterwards, since other pushes may have landed meanwhile.
      let blobKey: string | null = null;
      const judge = () =>
        tables.transaction(() => {
          const v = rules.evaluatePush(view(m.branchId), ch, cfg);
          if (v.kind !== "accept") return v;
          let body: { inline: string } | { blob: string };
          if (blobKey) body = { blob: blobKey };
          else {
            const text = Tables.body(row);
            if (utf8Over(text, maxInline)) return { kind: "large" as const, text };
            body = { inline: text };
          }
          row.seq = tables.head(m.branchId) + 1;
          tables.append(m.branchId, row, { paths: rules.storedPaths(ch), structural: v.structural }, v.records, body);
          return v;
        });
      let verdict = judge();
      if (verdict.kind === "large") {
        if (!opts.blobs) return reject(c, m.branchId, ch.id, "too large", m.epoch);
        // keyed by the digest of the exact body the server stores, never by a hash the client supplied (finding 2)
        blobKey = `changes/${m.branchId}/${sha256Hex(verdict.text)}`;
        await opts.blobs.put(blobKey, enc.encode(verdict.text), { contentType: "application/json", ifAbsent: true });
        verdict = judge();
        if (verdict.kind === "large") throw new Error("unreachable: a blob body is never inline");
      }
      if (verdict.kind === "duplicate") {
        stats.duplicates++;
        emit({ type: "duplicate", branchId: m.branchId, id: ch.id, seq: verdict.seq, withdrawn: verdict.withdrawn });
        send(c, { type: "ack", branchId: m.branchId, id: ch.id, seq: verdict.seq, epoch: m.epoch, duplicate: true, ...(verdict.withdrawn ? { withdrawn: true } : {}) });
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
      send(c, ack);
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
      const r = controls.listOnBehind === false ? undefined : confirmedOf(m.branchId, [{ id: m.id, bases: [m.base] }]);
      return reject(c, m.branchId, m.id, "behind", m.epoch, r ? { confirmed: r.list } : {});
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
      return send(c, { type: "ack", branchId: m.branchId, id: m.id, seq: dup.seq, epoch: m.epoch, duplicate: true, ...(dup.withdrawn ? { withdrawn: true } : {}) });
    }
    stats.withdraws++;
    emit({ type: "withdraw", branchId: m.branchId, id: m.id, seq: row.seq });
    fanout(m.branchId, { type: "changes", branchId: m.branchId, rows: [row] });
    send(c, { type: "ack", branchId: m.branchId, id: m.id, seq: row.seq, epoch: m.epoch, withdrawn: true });
  }

  async function onAdopt(c: HostConnection, m: sync.AdoptMsg) {
    const fail = (reason: string) => send(c, { type: "adoptError", branchId: m.branchId, reason });
    if (typeof m.branchId !== "string" || !m.rec || m.rec.id !== m.branchId) return fail("rec.id must be the branchId"); // finding 1
    const closure = Array.isArray(m.closure) ? m.closure : [];
    if (!mayWrite(c, m.branchId) || closure.some((t) => !mayWrite(c, t?.branchId))) return fail("forbidden"); // finding 4
    if (closure.some((t) => !t?.rec || t.rec.id !== t.branchId)) return fail("closure rec.id must be its branchId");
    const key = `${m.branchId}|${m.n}|${m.stateHash}`;
    const b = tables.branch(m.branchId);
    if (b) {
      if (b.adoptKey === key) {
        stats.adoptRepeats++;
        emit({ type: "adopt", branchId: m.branchId, n: m.n, repeat: true });
        return send(c, { type: "adopted", branchId: m.branchId, since: m.n, repeat: true });
      }
      return fail("branch exists with another log");
    }
    const rootSeq = m.rootSeq ?? 0;
    const rows = Array.isArray(m.rows) ? (m.rows as Row[]) : [];
    if (rootSeq + rows.length !== m.n) return fail(`rows ${rootSeq + 1}..${m.n} expected`);
    try {
      await createBranch(m.rec, { doc0: m.doc0, rootSeq, stateHash: rootSeq === m.n ? m.stateHash : "" }, rows, key, credentialOf(c));
    } catch (e) {
      return fail(e instanceof Error ? e.message : String(e));
    }
    // the ancestry closure goes up shallow, as read-only tracking branches (§5.3, R4-07); existing ones are kept
    tables.transaction(() => {
      for (const t of closure) {
        if (tables.branch(t.branchId)) continue;
        tables.insertBranch({ id: t.branchId, rec: t.rec, forkOf: null, root: 0, since: 0, adoptKey: null, tracking: true, nodes: t.nodes });
      }
    });
    stats.adopts++;
    emit({ type: "adopt", branchId: m.branchId, n: m.n, repeat: false });
    send(c, { type: "adopted", branchId: m.branchId, since: m.n });
  }

  function onBranchStatus(c: HostConnection, m: sync.BranchStatusMsg) {
    const b = tables.branch(m.branchId);
    send(c, { type: "status", branchId: m.branchId, adopted: !!b, adoptKey: b?.adoptKey ?? null, since: b?.since ?? null, head: b ? tables.head(m.branchId) : 0 });
  }

  async function onFork(c: HostConnection, m: sync.ForkMsg) {
    if (!m.rec || m.rec.id !== m.branchId) return send(c, { type: "error", reason: "rec.id must be the branchId" }); // finding 1
    if (!mayWrite(c, m.branchId)) return send(c, { type: "error", reason: "forbidden" }); // finding 4
    const parent = tables.branch(m.from);
    if (!parent) return send(c, { type: "unknownBranch", branchId: m.from });
    if (!(Number.isInteger(m.seq) && m.seq >= parent.root && m.seq <= tables.head(m.from))) return send(c, { type: "error", reason: `fork point ${m.seq} is outside ${m.from}` });
    if (!tables.branch(m.branchId)) {
      // the state at the fork point, when the forking client sends it, is the fork's root keyframe: a fresh joiner
      // (have: -1) starts from it; without it a joiner must hold the parent (review finding 12)
      const root = m.root && typeof m.root.stateHash === "string" ? m.root : null;
      try {
        await createBranch(m.rec, { doc0: root ? root.doc : null, stateHash: root?.stateHash ?? "", forkOf: { branchId: m.from, seq: m.seq } });
      } catch (e) {
        return send(c, { type: "error", reason: e instanceof Error ? e.message : String(e) });
      }
    }
    send(c, { type: "forked", branchId: m.branchId, from: m.from, seq: m.seq });
  }

  async function onKeyframe(c: HostConnection, m: sync.KeyframeMsg) {
    if (writable(c, m.branchId)) return; // role, the token's cut scope, not a tracking branch (finding 4)
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

  // Per connection, a token bucket: PRESENCE_BURST updates at once, refilled at PRESENCE_PER_SEC. Clients send at most
  // 10 a second (the sync client coalesces); anything over the cap is dropped, so a misbehaving client can't make the
  // relay, and on a Durable Object the fan-out work, grow with its sending rate.
  const presenceBuckets = new Map<string, { tokens: number; at: number }>();
  function presenceAllowed(c: HostConnection): boolean {
    const now = clock();
    const b = presenceBuckets.get(c.id) ?? { tokens: PRESENCE_BURST, at: now };
    b.tokens = Math.min(PRESENCE_BURST, b.tokens + ((now - b.at) / 1000) * PRESENCE_PER_SEC);
    b.at = now;
    presenceBuckets.set(c.id, b);
    if (b.tokens < 1) return false;
    b.tokens -= 1;
    return true;
  }

  // The latest presence a connection had dropped by its cap, per branch, relayed when its bucket refills: a burst
  // (updates that queued behind an envelope upload, say) may lose its middle, never its end, so a drag's last position
  // or its `state: null` always reaches each branch's others. The rate itself stays per connection.
  const presenceTrailing = new Map<string, Map<string, { msg: sync.PresenceFanoutMsg; timer: ReturnType<typeof setTimeout> }>>();
  function clearTrailing(id: string, branchId?: string): void {
    const byBranch = presenceTrailing.get(id);
    if (!byBranch) return;
    for (const [b, t] of byBranch) {
      if (branchId !== undefined && b !== branchId) continue;
      clearTimeout(t.timer);
      byBranch.delete(b);
    }
    if (byBranch.size === 0) presenceTrailing.delete(id);
  }

  function onPresence(c: HostConnection, m: sync.PresenceMsg) {
    if (!stateOf(c).subs.includes(m.branchId)) return;
    // relayed, never stored; the actor is stamped from the connection, not trusted from the client
    const actor = { ...(m.actor ?? {}), kind: m.actor?.kind ?? "human", id: m.actor?.id ?? c.auth.account } as sync.PresenceFanoutMsg["actor"];
    const msg: sync.PresenceFanoutMsg = { type: "presence", branchId: m.branchId, actor, state: m.state ?? null };
    // a playhead, a selection, drag ghosts: over 64 KiB is dropped, so a client can't make the relay (10–20 Hz) costly
    if (sync.oversized(msg, sync.PRESENCE_BYTES)) return;
    if (!presenceAllowed(c)) {
      stats.presenceDropped++;
      const byBranch = presenceTrailing.get(c.id) ?? new Map();
      presenceTrailing.set(c.id, byBranch);
      const waiting = byBranch.get(m.branchId);
      if (waiting) {
        waiting.msg = msg;
        return;
      }
      const b = presenceBuckets.get(c.id)!;
      const ms = Math.max(1, Math.ceil(((1 - b.tokens) / PRESENCE_PER_SEC) * 1000));
      const branchId = m.branchId;
      const entry = {
        msg,
        timer: setTimeout(function relay() {
          if (!conns.has(c.id) || !stateOf(c).subs.includes(branchId)) return clearTrailing(c.id, branchId);
          // one token per relay, as any update; a connection with several branches waiting takes its turns
          if (!presenceAllowed(c)) {
            entry.timer = setTimeout(relay, Math.max(1, Math.ceil(1000 / PRESENCE_PER_SEC)));
            (entry.timer as { unref?: () => void }).unref?.();
            return;
          }
          byBranch.delete(branchId);
          if (byBranch.size === 0) presenceTrailing.delete(c.id);
          fanout(branchId, entry.msg, c.id);
        }, ms),
      };
      (entry.timer as { unref?: () => void }).unref?.();
      byBranch.set(branchId, entry);
      return;
    }
    clearTrailing(c.id, m.branchId); // this newer state supersedes the one waiting on its branch
    fanout(m.branchId, msg, c.id);
  }

  async function process(c: HostConnection, msg: ClientMessage): Promise<void> {
    if (opts.projectId !== undefined && c.auth.projectId !== opts.projectId) return send(c, { type: "error", reason: "this token is for another project" });
    if (c.auth.expires < clock()) return send(c, { type: "error", reason: "token expired" });
    if (msg?.type === "blob") {
      const inner = await openEnvelope(c, msg);
      if (!inner) return;
      msg = inner;
    }
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
        return send(c, { type: "error", reason: `unknown message type ${(msg as { type?: unknown })?.type}` });
    }
  }

  /** Every send so far delivered (envelope uploads done): a host may hibernate once a message's handling resolves. */
  async function flushed(): Promise<void> {
    for (const o of outboxes.values()) if (o.pending) await o.flushed();
  }

  // one message at a time per project, even across awaits on the blob store
  let queue: Promise<void> = Promise.resolve();
  let busy = 0;
  return {
    handle(conn, msg) {
      const c = conn as HostConnection;
      if (!conns.has(c.id)) attach(c);
      busy++;
      const run = queue.then(() => process(c, msg)).then(flushed);
      queue = run.catch(() => {}).then(() => void busy--);
      return run.catch((e: unknown) => {
        send(c, { type: "error", reason: `internal: ${e instanceof Error ? e.message : String(e)}` });
      });
    },
    attach,
    disconnect(conn) {
      conns.delete(conn.id);
      outboxes.delete(conn.id);
      presenceBuckets.delete(conn.id);
      clearTrailing(conn.id);
    },
    cancelShare(branchId) {
      tables.dropBranch(branchId);
    },
    createBranch: (rec, init) => {
      // without a blob store this is synchronous, so a host (or a simulation) can set a branch up before any message
      if (!opts.blobs && !busy) {
        createBranch(rec, init);
        return Promise.resolve();
      }
      const run = queue.then(() => createBranch(rec, init));
      queue = run.catch(() => {});
      return run;
    },
    async archive(branchId, { keep = ARCHIVE_KEEP, segmentRows = ARCHIVE_SEGMENT } = {}) {
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
          const key = `segments/${branchId}/${hi}.json.gz`;
          await blobs.put(key, await gzip(enc.encode(JSON.stringify(json))), { contentType: "application/gzip" });
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
    async maintain(o = {}) {
      if (!opts.blobs) return { archived: 0, swept: 0, nextAt: null };
      let archived = 0;
      for (const id of tables.branchIds()) if (!tables.branch(id)?.tracking) archived += await this.archive(id, o);
      // envelope blobs past their keep (a client's the server never read, every server one after its hours)
      let swept = 0;
      const now = clock();
      let cursor: string | undefined;
      do {
        const page = await opts.blobs.list("messages/", cursor ? { cursor } : {});
        for (const b of page.blobs)
          if (sync.envelopeExpired(b.key, now)) {
            await opts.blobs.delete(b.key);
            swept++;
          }
        cursor = page.cursor;
      } while (cursor);
      return { archived, swept, nextAt: now + MAINTAIN_EVERY_MS };
    },
    stats,
    tables,
  };
}

const MAINTAIN_EVERY_MS = 60 * 60 * 1000;
/** Server messages that can be over the envelope threshold; the rest (acks, statuses, errors…) are never sized. */
const MAYBE_BIG: ReadonlySet<string> = new Set(["hello", "changes", "reject"]);

/** History fields a change may carry into its row (fold-ins, undo, partial accept, names): stored in the body. */
const HISTORY_FIELDS = ["kind", "supersedes", "mergeOf", "mergeEdges", "mergeBase", "reverts", "rejected", "lastAuthors", "name", "structural"] as const;

/** As `Tables.rowSizes`, for a row of an archived segment (its columns are strings, `body` its inline body's bytes). */
function segmentRowBytes(r: Record<string, string | number | null>, body: Uint8Array | null, branchId: string): number {
  let n = 256 + 3 * branchId.length + (body?.byteLength ?? 0);
  for (const k of ["id", "hash", "author", "base", "paths", "reads", "spans", "policy"]) n += 3 * String(r[k] ?? "").length;
  return n;
}
/** UTF-8 byte length over `limit`, without encoding short strings (each UTF-16 unit is at most 3 bytes). */
function utf8Over(text: string, limit: number): boolean {
  if (text.length * 3 <= limit) return false;
  return new TextEncoder().encode(text).length > limit;
}
/** Declarations bigger than any engine produces for a sane change (the sequencer stores them in SQL columns). */
function declarationTooLarge(ch: Change): boolean {
  return (ch.paths?.length ?? 0) + (ch.reads?.length ?? 0) > 200_000 || (ch.spans?.length ?? 0) > 50_000 || (ch.trackOrder?.length ?? 0) > 10_000 || (ch.base?.pending?.length ?? 0) > 10_000;
}
/** Presence per connection: a burst of 20, then 20 a second (twice what the sync client sends); the rest is dropped. */
const PRESENCE_BURST = 20;
const PRESENCE_PER_SEC = 20;
/** §18: changes older than the newest 10,000 move to R2, one segment per 10,000. */
const ARCHIVE_KEEP = 10_000;
const ARCHIVE_SEGMENT = 10_000;

// gzip with the platform's CompressionStream (Workers, browsers and Node all have it)
async function gzip(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([bytes as Uint8Array<ArrayBuffer>]).stream().pipeThrough(new CompressionStream("gzip"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}
async function gunzip(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([bytes as Uint8Array<ArrayBuffer>]).stream().pipeThrough(new DecompressionStream("gzip"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

export type { AuthContext, Change, StoredBranch };
