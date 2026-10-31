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
  /**
   * Who this connection shows on each branch's other screens: actors whose latest presence there wasn't `null`. When
   * it disconnects (closed, crashed, timed out), each is sent to the branch's others with `state: null`, since a client
   * that crashed or lost its network never sends its own. Kept here so a host that keeps this state across
   * hibernation (the Durable Object's socket attachment) keeps these too; so it stays small: at most
   * PRESENCE_SHOWN_MAX actors, of ids no longer than PRESENCE_ID_MAX (an actor beyond either is relayed, not kept).
   */
  shown?: ShownPresence[];
  /**
   * The connection's identity changes left (`tokens`, IDENTITY_BURST at most, one back every IDENTITY_EVERY_MS) as of
   * `at`. Kept here, not beside the connection, so a socket restored after hibernation has no fresh burst.
   */
  identity?: { tokens: number; at: number };
}

/** An actor a connection shows on a branch: only what names it (`actorKey`: kind, id, agentId). */
export interface ShownPresence {
  branchId: string;
  actor: { kind: sync.PresenceFanoutMsg["actor"]["kind"]; id: string; agentId?: string };
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
  /** Claim windows (one per claimed base, merged or not) read per message (default 256): lowered by a test of the cap. */
  claimWindows?: number;
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
  const maxEnvelope = opts.maxEnvelopeBytes ?? 64 << 20;
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
    // too big to read: dropped unread (resending it can't help, so no reconnect)
    if (Number(m.ref?.size) > maxEnvelope) {
      if (sync.envelopeKeyOk(m.ref, "client")) await opts.blobs.delete(m.ref.key).catch(() => {});
      return lost(`${m.ref.size} bytes (the limit is ${maxEnvelope})`, false);
    }
    let inner: unknown;
    try {
      inner = await sync.unseal(m.ref, opts.blobs, { from: "client", maxBytes: maxEnvelope });
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
  const MAX_CLAIM_WINDOWS = 256;
  /**
   * The ids of `claims` confirmed or withdrawn. At most MAX_CLAIM_WINDOWS claim windows are read per message (a
   * hostile hello can't ask for more); bases past that are reported in `uncheckedFrom`, never treated as unconfirmed:
   * the client asks again for those before acting on the list (review finding 10).
   */
  function confirmedOf(
    branchId: string,
    claims: readonly PendingClaim[] | undefined,
    { after = -1, budget = Infinity }: { after?: number; budget?: number } = {},
  ): { list: ConfirmedId[]; uncheckedFrom: number | null; checkedThrough: number | null } {
    if (controls.confirmedList === false || !claims?.length) return { list: [], uncheckedFrom: null, checkedThrough: null };
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
    if (!want.size || !bases.size) return { list: [], uncheckedFrom: null, checkedThrough: null };
    // merge the windows so overlapping claims never read a row twice; every base's window counts against the cap,
    // merged or not, so a message reads at most cap × (K + 1) seqs (round 2 finding 6: adjacent windows merged into one
    // range used to bypass it)
    //
    // The list is in seq order and stops at `budget` bytes (at least one id): it then says where to go on, the base its
    // range began at and the seq checked through, and a continuation (`after`) reads only past it. One window can list
    // up to K + 1 ids, so a page can end inside one (round 5 finding 2).
    const sorted = [...bases].sort((a, b) => a - b);
    const cap = controls.claimWindows ?? MAX_CLAIM_WINDOWS;
    const out: ConfirmedId[] = [];
    let lo = -1, hi = -1, windows = 0, used = 0;
    let cut: number | null = null;
    /** Read the current range past `after`; false (and `cut`) when the budget runs out inside it. */
    const flush = (): boolean => {
      const from = Math.max(lo, after);
      if (hi > from)
        for (const e of tables.idsIn(branchId, from, hi)) {
          if (!want.has(e.id)) continue;
          const n = sync.jsonBytesBound(e, Infinity) + 1;
          if (out.length && used + n > budget) {
            cut = lo;
            return false;
          }
          used += n;
          out.push(e);
        }
      return true;
    };
    const stopped = (): { list: ConfirmedId[]; uncheckedFrom: number; checkedThrough: number } => ({ list: out, uncheckedFrom: cut!, checkedThrough: out[out.length - 1]!.seq });
    for (const b of sorted) {
      if (++windows > cap) {
        if (!flush()) return stopped();
        return { list: out, uncheckedFrom: b, checkedThrough: null };
      }
      const top = Math.min(b + K + 1, head);
      if (b <= hi) hi = Math.max(hi, top);
      else {
        if (!flush()) return stopped();
        lo = b;
        hi = top;
      }
    }
    if (!flush()) return stopped();
    return { list: out, uncheckedFrom: null, checkedThrough: null };
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
   * progress; a big single row then goes as an envelope); the client asks again while `more` (§6.3). What the page
   * loads stays within the budget plus one row: live rows are sized from their stored lengths before any is loaded,
   * archived segments are read as a stream one row at a time, and a body in the blob store is fetched only while the
   * page still has room (round 3 findings 3 and 4).
   */
  async function readRows(branchId: string, after: number, limit: number, budget: number, atLeastOne: boolean): Promise<Row[]> {
    const out: Row[] = [];
    let used = 0;
    let full = false;
    const bounded = () => out.length > 0 || !atLeastOne;
    /** Take a row of `meta` bytes (without a body in the blob store) if the page has room for it, body included. */
    const take = async (r: { row: Row; blob: string | null }, meta: number): Promise<boolean> => {
      if (out.length >= limit || (bounded() && used + meta > budget)) return !(full = true);
      const { row, bytes } = await fillBody(r);
      // its body wasn't in the size: if it doesn't fit after all, it opens the next page
      if (bounded() && used + meta + bytes > budget) return !(full = true);
      used += meta + bytes;
      out.push(row);
      return true;
    };
    const firstLive = tables.firstLive(branchId) ?? tables.head(branchId) + 1;
    if (after + 1 < firstLive && opts.blobs) {
      for (const seg of tables.segmentsAfter(branchId, after)) {
        if (seg.lo >= firstLive - 1 || full) break;
        for await (const r of segmentRows(opts.blobs, seg.blob)) {
          if (Number(r.seq) <= after) continue;
          const ops = r.ops === null || r.ops === undefined ? null : enc.encode(String(r.ops));
          const rr = { ...r, ops } as Record<string, string | number | null | Uint8Array>;
          if (!(await take(Tables.toRow(rr, branchId), segmentRowBytes(r, ops, branchId)))) break;
        }
      }
    }
    if (full) return out;
    // live rows: sized from their stored lengths first (no body read), then only those that fit are loaded
    const from = out.length ? out[out.length - 1]!.seq : after;
    const sizes = tables.rowSizes(branchId, from, limit - out.length);
    let n = 0;
    for (let est = used; n < sizes.length; n++) {
      if ((out.length + n > 0 || !atLeastOne) && est + sizes[n]! > budget) break;
      est += sizes[n]!;
    }
    if (!n) return out;
    const rows = tables.rows(branchId, from, n);
    for (let i = 0; i < rows.length; i++) if (!(await take(rows[i]!, sizes[i]!))) break;
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
    /**
     * An adoption's ancestry closure: shallow read-only tracking branches (§5.3, R4-07). A tracking branch another
     * adoption made gains the new nodes and authors (lineage is immutable, so a union is safe); a real branch is kept.
     */
    closure?: readonly sync.ClosureEntry[];
  }
  /**
   * Create a branch atomically: the branch row, its root keyframe, its records, its rows and an adoption's ancestry
   * closure commit together or not at all, and the caches are dropped if the transaction fails (review finding 5;
   * the closure joined it after round 2: written apart, a failure there left an adoption whose retry, a repeat, never
   * wrote it). An existing branch is never replaced.
   * `rids`: the credential that uploaded the rows, bound to their replica ids (review finding 11).
   */
  function createBranch(rec: CutRecord, init: BranchInit, rows: readonly Row[] = [], adoptKey: string | null = null, rids?: string): void | Promise<void> {
    const root = init.rootSeq ?? 0;
    let seq = root;
    for (const row of rows) if (row?.seq !== ++seq) throw new Error(`rows must be ${root + 1}..${root + rows.length} in order (got ${row?.seq} for ${seq})`);
    const where = init.doc0 !== null ? placeKeyframe(rec.id, root, init.doc0) : null;
    // the closure's carried states are keyframes of their tracking branches, placed (uploaded) before the transaction
    const placed = (init.closure ?? []).flatMap((t) => (t.states ?? []).map((st) => ({ branch: t.branchId, seq: st.seq, hash: st.hash, where: placeKeyframe(t.branchId, st.seq, st.doc) })));
    if (where instanceof Promise || placed.some((p) => p.where instanceof Promise))
      return Promise.all([where, ...placed.map((p) => p.where)]).then(([w, ...ws]) => writeBranch(rec, init, rows, adoptKey, w ?? null, rids, placed.map((p, i) => ({ ...p, where: ws[i]! }))));
    writeBranch(rec, init, rows, adoptKey, where, rids, placed as ClosureKeyframe[]);
  }
  type ClosureKeyframe = { branch: string; seq: number; hash: string; where: { blob: string } | { inline: string } };
  function writeBranch(rec: CutRecord, init: BranchInit, rows: readonly Row[], adoptKey: string | null, kf: { blob: string } | { inline: string } | null, rids?: string, closureKfs: readonly ClosureKeyframe[] = []): void {
    const root = init.rootSeq ?? 0;
    const handed: string[] = []; // the uploaded rows' rids this hand-off bound to the uploader
    try {
      tables.transaction(() => {
        handed.length = 0;
        tables.insertBranch({ id: rec.id, rec, forkOf: init.forkOf ?? null, root, since: root + rows.length, adoptKey, ...(init.closure?.length ? { closure: init.closure.map((t) => t.branchId) } : {}) });
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
          if (rids !== undefined && controls.bindRid !== false && typeof row.id === "string" && tables.ridOwner(ridOf(row.id)) === undefined) {
            tables.bindRid(ridOf(row.id), rids);
            handed.push(ridOf(row.id));
          }
        }
        for (const t of init.closure ?? []) {
          const had = tables.branch(t.branchId);
          if (had && !had.tracking) continue;
          const nodes = new Map((had?.nodes ?? []).map((n) => [n.id, n]));
          for (const n of t.nodes) if (!nodes.has(n.id)) nodes.set(n.id, n);
          const authors = new Map(had?.authors ?? []);
          for (const [n, a] of t.authors ?? []) if (!authors.has(n)) authors.set(n, a);
          const b: StoredBranch = { id: t.branchId, rec: had?.rec ?? t.rec, forkOf: null, root: 0, since: 0, adoptKey: null, tracking: true, nodes: [...nodes.values()], ...(authors.size ? { authors: [...authors] } : {}) };
          if (had) tables.putBranch(b);
          else tables.insertBranch(b);
        }
        for (const k of closureKfs) tables.putKeyframe(k.branch, k.seq, k.hash, k.where);
      });
    } catch (e) {
      tables.forget(rec.id);
      throw e;
    }
    // committed: the uploader's earlier edits are told by person (a rolled-back hand-off told nothing)
    if (rids !== undefined) announce(rids, handed);
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
      announce(who, [rid]); // before the row it binds fans out
      return true;
    }
    return bound === who;
  }

  // ---------------------------------------------------------------- people (windows-sync R3)
  // A device credential's person: who a generic "person" author is, resolved by the change's rid (bound to the
  // credential, §6.3). Kept beside the rows, never in them. A replica sets only its own credential's entry, under its
  // session's account; the name is its own choice. A reader scoped to some cuts (a Published cut's watch link) learns
  // none of it: its welcome says `people: []` and no `people` message reaches it, so a link never tells a stranger
  // the team's accounts and names.
  const seesPeople = (c: HostConnection) => WRITE_ROLES.has(c.auth.role) || !c.auth.branches;
  /** A change to the people, to every connection of the project that may see them, once per cut it follows (the sync
   * client is per cut); a connection still paging its welcome gets the whole list on its last page. */
  function toPeople(people: sync.PersonRids[]): void {
    // a hello's claim binds up to 4096 rids: over the threshold, each cut's message goes as one envelope, for everyone
    const sent = new Map<string, { msg: ServerMessage; env?: Promise<sync.EnvelopeMsg> | null }>();
    for (const c of conns.values()) {
      if (!seesPeople(c)) continue;
      for (const b of stateOf(c).subs) {
        let m = sent.get(b);
        if (!m) sent.set(b, (m = { msg: { type: "people", branchId: b, people } }));
        if (stateOf(c).envelopes && m.env === undefined) m.env = sealed(m.msg);
        send(c, m.msg, m.env ?? null);
      }
    }
  }
  /** rids newly bound to `credential`, told when it has a person. */
  function announce(credential: string, rids: string[]): void {
    if (!rids.length) return;
    const p = tables.person(credential);
    if (p) toPeople([{ ...p, rids }]);
  }
  function identityAllowed(c: HostConnection): boolean {
    const now = clock(),
      st = stateOf(c),
      was = st.identity;
    const tokens = was ? Math.min(IDENTITY_BURST, was.tokens + Math.max(0, now - was.at) / IDENTITY_EVERY_MS) : IDENTITY_BURST;
    if (tokens < 1) return false;
    // a new object: a host comparing the state before and after a message sees the change (the attachment)
    st.identity = { tokens: tokens - 1, at: now };
    return true;
  }
  /** `hello.identity` or an `identity` message: refused with an error (the connection stays), or recorded and told. */
  function identify(c: HostConnection, who: unknown): void {
    const p = (who && typeof who === "object" ? who : {}) as { id?: unknown; name?: unknown };
    if (p.id !== c.auth.account) return send(c, { type: "error", code: "forbidden", reason: `identity: ${JSON.stringify(typeof p.id === "string" ? p.id.slice(0, 100) : p.id ?? null)} isn't this session's account` });
    const name = typeof p.name === "string" ? p.name.trim() : "";
    const chars = [...name].length;
    if (chars < 1 || chars > PERSON_NAME_MAX || CONTROL_CHARS.test(name)) return send(c, { type: "error", code: "bad-request", reason: `identity: the name must be 1-${PERSON_NAME_MAX} characters, none of them control characters` });
    const cred = credentialOf(c);
    const was = tables.person(cred);
    if (was?.id === p.id && was.name === name) return;
    if (!identityAllowed(c)) return send(c, { type: "error", code: "bad-request", reason: "identity: changed too often; try again in a minute" });
    tables.setPerson(cred, p.id, name);
    toPeople([{ id: p.id, name, rids: tables.ridsOfPerson(cred) }]); // the sender's copy confirms it
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

  /** A Published cut's source cut and the version published (its record's `source` and fork point). */
  function publishedSource(rec: CutRecord | undefined): { branchId: string; at: number } | null {
    if (rec?.kind !== "published" || typeof rec.forkOf !== "string") return null;
    const i = rec.forkOf.lastIndexOf("@");
    const at = Number(rec.forkOf.slice(i + 1));
    if (i < 1 || !Number.isInteger(at)) return null;
    const forkCut = rec.forkOf.slice(0, i);
    const source = typeof rec.source === "string" ? rec.source : forkCut;
    // core names a version by the cut it was made on, so a source with no edits of its own when published has its
    // parent's version as the fork point, the same one the source forked from: the publication is then the source's
    // version 0 (SF1-9). Not the source's storage root, which a later shallow share moves (stage review round 3).
    if (source !== forkCut && tables.branch(source)?.rec.forkOf === rec.forkOf) return { branchId: source, at: 0 };
    return { branchId: source, at };
  }
  async function onHello(c: HostConnection, m: sync.HelloMsg) {
    // (a reader scoped to some cuts never gets here for another: process() refuses it first)
    const b = tables.branch(m.branchId);
    if (!b) return send(c, { type: "unknownBranch", branchId: m.branchId });
    if (opts.schemaVersion !== undefined && m.schemaVersion > opts.schemaVersion) return send(c, { type: "error", code: "schema-too-new", reason: `this client's documents are schema version ${m.schemaVersion}, newer than this server accepts (up to ${opts.schemaVersion}): update the server` });
    const st = stateOf(c);
    if (m.envelopes === true && opts.blobs) st.envelopes = true;
    // R10-02: the replica claims every rid it has used; each unbound one is bound to this device credential
    if (controls.helloRidClaim !== false && controls.bindRid !== false && WRITE_ROLES.has(c.auth.role)) {
      const who = credentialOf(c);
      const fresh: string[] = [];
      for (const rid of (m.rids ?? []).slice(0, 4096)) {
        if (typeof rid !== "string") continue;
        const bound = tables.ridOwner(rid);
        if (bound === undefined) {
          tables.bindRid(rid, who);
          fresh.push(rid);
        } else if (bound !== who) {
          stats.ridClaimConflicts++;
          emit({ type: "ridClaimConflict", rid });
        }
      }
      announce(who, fresh);
    }
    // the sender's person before its welcome is built, so the welcome holds it (an old client sends none)
    if (m.identity !== undefined) identify(c, m.identity);
    const head = tables.head(m.branchId);
    const claimsAfter = Number.isInteger(m.claimsAfter) ? (m.claimsAfter as number) : -1;
    const { list: confirmed, uncheckedFrom, checkedThrough } = confirmedOf(m.branchId, m.pending, { after: claimsAfter, budget: catchupBytes });
    // the list isn't complete: the client acts on nothing until it is, so this page is the list alone (no rows, no
    // keyframe, no subscription yet), within the page's budget
    if (uncheckedFrom !== null) {
      const partial: sync.WelcomeMsg = { type: "hello", branchId: m.branchId, head, rows: [], confirmed, uncheckedFrom };
      if (checkedThrough !== null) partial.checkedThrough = checkedThrough;
      return send(c, partial);
    }
    let from = Math.max(-1, Math.min(m.have, head));
    let keyframe: sync.KeyframeData | undefined;
    let budget = catchupBytes;
    // below the root (a fresh joiner sends have: -1), or more than K behind: the latest keyframe, then its tail. A
    // client that found a keyframe's hash wrong asks for rows only (noKeyframe).
    // a client that refused a keyframe and holds nothing at or after the root can't be served: say so, never loop
    if (m.noKeyframe && from < b.root) return send(c, { type: "error", reason: `no state at or after ${b.root} for ${m.branchId} that the client can check` });
    if (from < b.root || (head - from > K && !m.noKeyframe)) {
      const k = tables.latestKeyframe(m.branchId, head);
      if (k && k.seq > from) {
        const loaded = await loadKeyframe(m.branchId, k);
        keyframe = loaded.keyframe;
        budget -= loaded.bytes; // the keyframe is part of the page
        from = k.seq;
      } else if (from < b.root) return send(c, { type: "error", reason: `no state at or after ${b.root} for ${m.branchId}` });
    }
    budget -= sync.jsonBytesBound(confirmed, Infinity); // the confirmed-id list is part of the page too
    // every page that subscribes or may (rows, a keyframe) holds the people, [] too: it says this server keeps them
    budget -= sync.jsonBytesBound(seesPeople(c) ? tables.people() : [], Infinity);
    // by rows and by bytes: the client asks again while `more`. With a keyframe the page may hold no row (the keyframe
    // is its progress); without one it holds at least one (a big single row then goes as an envelope).
    const rows = await readRows(m.branchId, from, catchup, budget, !keyframe);
    const last = rows.length ? rows[rows.length - 1]!.seq : from;
    // taken after the rows' read, so no change to them can fall between this list and the subscription below
    const msg: sync.WelcomeMsg = { type: "hello", branchId: m.branchId, head, rows, confirmed, people: seesPeople(c) ? tables.people() : [] };
    if (keyframe) msg.keyframe = keyframe;
    // a Published cut says how far the cut it came from has moved since (a count: its rows stay out of a watcher's reach)
    const src = publishedSource(b.rec);
    if (src && tables.branch(src.branchId)) msg.source = { ...src, head: tables.head(src.branchId) };
    // the client then never sends what would be refused unread (round 2 finding 2)
    if (st.envelopes) msg.maxMessageBytes = maxEnvelope;
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
        const r = controls.listOnBehind === false ? undefined : confirmedOf(m.branchId, m.changes.map((x) => ({ id: x.id, bases: [x.base?.seq ?? 0] })), { budget: catchupBytes });
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
    if (closure.some((t) => !Array.isArray(t.nodes) || (t.states !== undefined && (!Array.isArray(t.states) || t.states.some((st) => !Number.isInteger(st?.seq) || st.seq < 0 || typeof st.hash !== "string" || !SHA256.test(st.hash)))) || (t.authors !== undefined && !Array.isArray(t.authors))))
      return fail("closure: bad nodes, states or authors");
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
      // the root keyframe's digest, so a joiner from nothing can check it (round 2 finding 8): the state at n when the
      // upload has no rows, else the root's own (`rootHash`); kept only when it is one
      const rootHash = rootSeq === m.n ? m.stateHash : m.rootHash;
      await createBranch(m.rec, { doc0: m.doc0, rootSeq, stateHash: typeof rootHash === "string" && SHA256.test(rootHash) ? rootHash : "", closure }, rows, key, credentialOf(c));
    } catch (e) {
      return fail(e instanceof Error ? e.message : String(e));
    }
    stats.adopts++;
    emit({ type: "adopt", branchId: m.branchId, n: m.n, repeat: false });
    send(c, { type: "adopted", branchId: m.branchId, since: m.n });
  }

  /**
   * History a replica doesn't hold (Stage F): rows `(after, upTo]` paged like catch-up, and with `lineage` the
   * branch's ancestry closure (its tracking branches with their carried states), for a joiner's log and credits.
   */
  async function onHistory(c: HostConnection, m: sync.HistoryMsg) {
    const reply = (r: Pick<sync.HistoryReplyMsg, "rows" | "more" | "lineage" | "lineageNext" | "error">) => send(c, { type: "history", branchId: m.branchId, req: m.req, ...r });
    const b = typeof m.branchId === "string" ? tables.branch(m.branchId) : null;
    if (!b) return reply({ rows: [], error: "unknown branch" });
    if (c.auth.branches && !c.auth.branches.includes(m.branchId)) return reply({ rows: [], error: "forbidden" });
    const after = Math.max(b.root, Number.isInteger(m.after) ? m.after : 0);
    const upTo = Math.min(tables.head(m.branchId), Number.isInteger(m.upTo) ? m.upTo : 0);
    const rows = after < upTo ? (await readRows(m.branchId, after, catchup, catchupBytes, true)).filter((r) => r.seq <= upTo) : [];
    const last = rows.length ? rows[rows.length - 1]!.seq : after;
    // The lineage: whole, or with `lineageFrom` paged like catch-up (SF1-8): entries in closure order within the
    // catch-up byte budget, at least one state (or one entry with none) per page, `lineageNext` where the next starts.
    const lineage: sync.ClosureEntry[] = [];
    let lineageNext: sync.LineageCursor | undefined;
    if (m.lineage) {
      const ids = b.closure ?? [];
      const from = m.lineageFrom;
      const paged = from !== undefined && from !== null;
      const index = (x: unknown) => (Number.isSafeInteger(x) && (x as number) >= 0 ? (x as number) : 0);
      let budget = paged ? catchupBytes : Infinity;
      let taken = 0; // states in this page
      let s = paged ? index(from.state) : 0;
      page: for (let e = paged ? index(from.entry) : 0; e < ids.length; e++, s = 0) {
        const id = ids[e]!;
        // a reader scoped to some cuts (a Published cut's watch link) reads no ancestor outside them: a private variant
        // partly folded into the cut carries states that were never published (web-demo review R3-1). A scoped writer
        // reads every cut (hello), and a join needs its cut's ancestry.
        if (!WRITE_ROLES.has(c.auth.role) && c.auth.branches && !c.auth.branches.includes(id)) continue;
        const t = tables.branch(id);
        if (!t?.tracking) continue;
        const nodes = t.nodes ?? [];
        const entry: sync.ClosureEntry = { branchId: id, rec: t.rec, nodes: s === 0 ? nodes : [], states: [] };
        if (s === 0 && t.authors?.length) entry.authors = t.authors;
        // every page an entry is on carries its record (and the first, its nodes and authors): charged each time
        // (stage review round 3); a page's first entry goes whatever its size, so every page makes progress
        const head = sync.jsonBytesBound({ branchId: id, rec: t.rec, nodes: entry.nodes, authors: entry.authors ?? null }, Infinity);
        if (lineage.length && head > budget) {
          lineageNext = { entry: e, state: s };
          break;
        }
        budget -= head;
        for (let i = s; i < nodes.length; i++) {
          const k = tables.keyframeAt(id, nodes[i]!.seq);
          if (!k) continue;
          const { keyframe, bytes } = await loadKeyframe(id, k);
          if (taken > 0 && bytes > budget) {
            lineageNext = { entry: e, state: i };
            if (s === 0 || entry.states!.length) lineage.push(entry);
            break page;
          }
          entry.states!.push({ seq: nodes[i]!.seq, hash: keyframe.stateHash, doc: keyframe.doc });
          taken++;
          budget -= bytes;
        }
        lineage.push(entry);
      }
    }
    reply({ rows, ...(last < upTo && rows.length ? { more: true } : {}), ...(m.lineage ? { lineage } : {}), ...(lineageNext ? { lineageNext } : {}) });
  }

  function onBranchStatus(c: HostConnection, m: sync.BranchStatusMsg) {
    const b = tables.branch(m.branchId);
    const msg: sync.StatusMsg = { type: "status", branchId: m.branchId, adopted: !!b, adoptKey: b?.adoptKey ?? null, since: b?.since ?? null, head: b ? tables.head(m.branchId) : 0 };
    // a hand-off uploads right after this answer: it must know the largest message read before it (round 3 finding 6)
    if (opts.blobs) msg.maxMessageBytes = maxEnvelope;
    send(c, msg);
  }

  async function onFork(c: HostConnection, m: sync.ForkMsg) {
    if (!m.rec || m.rec.id !== m.branchId) return send(c, { type: "error", reason: "rec.id must be the branchId" }); // finding 1
    if (!mayWrite(c, m.branchId)) return send(c, { type: "error", code: "forbidden", reason: "forbidden" }); // finding 4
    const parent = tables.branch(m.from);
    if (!parent) return send(c, { type: "unknownBranch", branchId: m.from });
    if (!(Number.isInteger(m.seq) && m.seq >= parent.root && m.seq <= tables.head(m.from))) return send(c, { type: "error", reason: `fork point ${m.seq} is outside ${m.from}` });
    if (!tables.branch(m.branchId)) {
      // the state at the fork point, when the forking client sends it, is the fork's root keyframe: a fresh joiner
      // (have: -1) starts from it; without it a joiner must hold the parent (review finding 12)
      if (m.root && !SHA256.test(String(m.root.stateHash))) return send(c, { type: "error", reason: "the fork's root needs its state hash (sha256)" });
      const root = m.root ?? null;
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
    // replicas check a keyframe's digest before installing it: one without a real digest is never stored (round 2
    // finding 8)
    if (typeof k.stateHash !== "string" || !SHA256.test(k.stateHash)) return;
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

  // Who a connection shows (ConnectionState.shown), noted as each presence is accepted, so a leave is owed for every
  // actor whose last word wasn't `null`, whether or not the rate cap has relayed that word yet.
  const sameActor = (a: ShownPresence["actor"], b: sync.PresenceFanoutMsg["actor"]) => a.kind === b.kind && a.id === b.id && a.agentId === (b.agentId ?? undefined);
  function noteShown(c: HostConnection, branchId: string, actor: sync.PresenceFanoutMsg["actor"], showing: boolean): void {
    const st = stateOf(c);
    const i = st.shown?.findIndex((s) => s.branchId === branchId && sameActor(s.actor, actor)) ?? -1;
    if (!showing) {
      if (i < 0) return;
      st.shown!.splice(i, 1);
      if (st.shown!.length === 0) delete st.shown;
      return;
    }
    if (i >= 0 || (st.shown?.length ?? 0) >= PRESENCE_SHOWN_MAX) return;
    const { kind, id, agentId } = actor;
    if (typeof kind !== "string" || typeof id !== "string" || id.length > PRESENCE_ID_MAX || branchId.length > PRESENCE_ID_MAX) return;
    if (agentId !== undefined && (typeof agentId !== "string" || agentId.length > PRESENCE_ID_MAX)) return;
    (st.shown ??= []).push({ branchId, actor: { kind, id, ...(agentId !== undefined ? { agentId } : {}) } });
  }

  function onPresence(c: HostConnection, m: sync.PresenceMsg) {
    // a connection gone while its presence waited in the queue (behind another client's envelope read, say) said
    // its last: relayed now, nothing would ever take it back
    // (or replaced: a socket that reconnected under the same id is another connection, with its own state)
    if (conns.get(c.id) !== c || !stateOf(c).subs.includes(m.branchId)) return;
    // relayed, never stored; the actor is stamped from the connection, not trusted from the client
    const actor = { ...(m.actor ?? {}), kind: m.actor?.kind ?? "human", id: m.actor?.id ?? c.auth.account } as sync.PresenceFanoutMsg["actor"];
    const msg: sync.PresenceFanoutMsg = { type: "presence", branchId: m.branchId, actor, state: m.state ?? null };
    // a playhead, a selection, drag ghosts: over 64 KiB is dropped, so a client can't make the relay (10–20 Hz) costly
    if (sync.oversized(msg, sync.PRESENCE_BYTES)) return;
    noteShown(c, m.branchId, actor, msg.state !== null);
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
          if (conns.get(c.id) !== c || !stateOf(c).subs.includes(branchId)) return clearTrailing(c.id, branchId);
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
    if (opts.projectId !== undefined && c.auth.projectId !== opts.projectId) return send(c, { type: "error", code: "unauthorized", reason: "this token is for another project" });
    if (c.auth.expires < clock()) return send(c, { type: "error", code: "unauthorized", reason: "token expired" });
    if (msg?.type === "blob") {
      const inner = await openEnvelope(c, msg);
      if (!inner) return;
      msg = inner;
    }
    // A reader scoped to some cuts (a Published cut's watch link) learns nothing of any other: every message naming
    // one is refused alike, before any lookup, so not its rows, head, adoption key, or even whether it exists. A
    // scoped writer's scope limits its writes (mayWrite).
    // Every message names its cut as a string (and a fork its parent): anything else is refused before it can reach a
    // lookup, where SQLite would match the number 1.5 to the cut id "1.5" past the guard (stage review round 2).
    const named = (msg as { branchId?: unknown } | null)?.branchId;
    const from = (msg as { type?: unknown; from?: unknown } | null)?.type === "fork" ? (msg as { from?: unknown }).from : "";
    if (typeof named !== "string" || typeof from !== "string") return send(c, { type: "error", code: "bad-request", reason: "a message must name its cut by a string id" });
    if (!WRITE_ROLES.has(c.auth.role) && c.auth.branches && !c.auth.branches.includes(named)) return send(c, { type: "error", code: "forbidden", reason: `this token can't read ${named}` });
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
      case "identity":
        return identify(c, msg.identity);
      case "presence":
        return onPresence(c, msg);
      case "history":
        return onHistory(c, msg);
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
      // the error answer is sent in turn, and everything sent (an envelope still uploading too) is delivered before the
      // promise resolves, on failure as on success: a host may hibernate once it resolves (round 2 finding 5)
      const run = queue
        .then(() => process(c, msg))
        .catch((e: unknown) => send(c, { type: "error", reason: `internal: ${e instanceof Error ? e.message : String(e)}` }))
        .then(flushed);
      queue = run.then(() => void busy--);
      return run;
    },
    attach,
    disconnect(conn) {
      // once per connection; not one already replaced under its id (its replacement is another connection)
      if (conns.get(conn.id) !== conn) return;
      conns.delete(conn.id);
      outboxes.delete(conn.id);
      presenceBuckets.delete(conn.id);
      // Its peers stop showing it. A client that crashed, lost its network or timed out never sends its own
      // `state: null`: a leave waiting behind its rate cap goes out now, then one for every actor it still showed.
      // Not while another connection shows the same actor there: the same person reconnected (the old socket timed out
      // after the new one began) or has a second tab, and the leave would wipe the cursor it still shows.
      const shownElsewhere = (branchId: string, actor: ShownPresence["actor"] | sync.PresenceFanoutMsg["actor"]) => {
        for (const o of conns.values()) if (stateOf(o).shown?.some((s) => s.branchId === branchId && sameActor(s.actor, actor as sync.PresenceFanoutMsg["actor"]))) return true;
        return false;
      };
      for (const [, t] of presenceTrailing.get(conn.id) ?? []) if (t.msg.state === null && !shownElsewhere(t.msg.branchId, t.msg.actor)) fanout(t.msg.branchId, t.msg, conn.id);
      clearTrailing(conn.id);
      const st = stateOf(conn);
      for (const s of st.shown ?? []) if (!shownElsewhere(s.branchId, s.actor)) fanout(s.branchId, { type: "presence", branchId: s.branchId, actor: s.actor, state: null }, conn.id);
      delete st.shown;
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
/** A state digest (`hashDoc`: SHA-256, hex). */
const SHA256 = /^[0-9a-f]{64}$/;
/** Server messages that can be over the envelope threshold; the rest (acks, statuses, errors…) are never sized. */
const MAYBE_BIG: ReadonlySet<string> = new Set(["hello", "changes", "reject", "history", "people"]);

/** History fields a change may carry into its row (fold-ins, undo, partial accept, names): stored in the body. */
const HISTORY_FIELDS = ["kind", "supersedes", "mergeOf", "mergeEdges", "mergeBase", "reverts", "rejected", "lastAuthors", "name", "structural"] as const;

/** As `Tables.rowSizes`, for a row of an archived segment (its columns are strings, `body` its inline body's bytes). */
function segmentRowBytes(r: Record<string, string | number | null>, body: Uint8Array | null, branchId: string): number {
  const bytes = (k: string) => (r[k] === null || r[k] === undefined ? 0 : enc.encode(String(r[k])).byteLength);
  return ROW_FIXED + 6 * enc.encode(branchId).byteLength + (body?.byteLength ?? 0) + bytes("author") + bytes("base") + bytes("paths") + bytes("reads") + 3 * bytes("spans") + 6 * (bytes("id") + bytes("hash") + bytes("policy"));
}
/** A blob read as a stream of ranged gets, `chunk` bytes at a time, fetched only as the reader pulls. */
function rangedStream(blobs: BlobStore, key: string, chunk: number): ReadableStream<Uint8Array> {
  let offset = 0;
  return new ReadableStream<Uint8Array>({
    async pull(ctl) {
      const part = await blobs.get(key, { offset, length: chunk });
      if (!part) return ctl.error(new Error(`segment ${key} is missing from the blob store`));
      if (part.byteLength) ctl.enqueue(part);
      offset += part.byteLength;
      if (part.byteLength < chunk) ctl.close();
    },
  });
}
/** A reply row's keys, numbers and the defaults `Tables.toRow` adds (the rest is sized from its columns). */
const ROW_FIXED = 256;

/**
 * The rows of an archived segment (a gzip-compressed JSON array of row objects), one at a time, read as a stream: only
 * one row's text is held at once, so a page that stops early never decompresses or parses the rest (round 3 finding
 * 3). Uses the store's `getStream` when it has one, else ranged gets of 64 KiB (round 4 finding 3: a whole-object get
 * loads the segment before the page can stop it).
 */
async function* segmentRows(blobs: BlobStore, key: string): AsyncGenerator<Record<string, string | number | null>> {
  let stream: ReadableStream<Uint8Array> | null = blobs.getStream ? await blobs.getStream(key) : null;
  if (!stream) stream = rangedStream(blobs, key, 64 * 1024);
  // (the lib types give these transforms a BufferSource writable side: a Uint8Array stream is one)
  if (key.endsWith(".gz")) stream = stream.pipeThrough(new DecompressionStream("gzip") as unknown as TransformStream<Uint8Array, Uint8Array>);
  const reader = stream.pipeThrough(new TextDecoderStream() as unknown as TransformStream<Uint8Array, string>).getReader();
  // a scan of the array's text: depth 1 inside the array, 2 inside a row; strings (and their escapes) skipped
  let depth = 0, inString = false, escaped = false;
  let parts: string[] = [];
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return;
      let start = depth >= 2 ? 0 : -1;
      for (let i = 0; i < value.length; i++) {
        const ch = value.charCodeAt(i);
        if (inString) {
          if (escaped) escaped = false;
          else if (ch === 92) escaped = true;
          else if (ch === 34) inString = false;
        } else if (ch === 34) inString = true;
        else if (ch === 123 || ch === 91) {
          if (++depth === 2) start = i;
        } else if (ch === 125 || ch === 93) {
          if (--depth === 1) {
            parts.push(value.slice(start, i + 1));
            const text = parts.join("");
            parts = [];
            start = -1;
            yield JSON.parse(text) as Record<string, string | number | null>;
          }
        }
      }
      if (depth >= 2 && start >= 0) parts.push(value.slice(start));
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
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
/** At most this many actors per connection are kept for the leave on disconnect (ConnectionState.shown). */
const PRESENCE_SHOWN_MAX = 4;
/** Longest actor id, agent id or branch id kept for it (an attachment of a Durable Object's socket stays small). */
const PRESENCE_ID_MAX = 200;
/** Presence per connection: a burst of 20, then 20 a second (twice what the sync client sends); the rest is dropped. */
const PRESENCE_BURST = 20;
const PRESENCE_PER_SEC = 20;
/** A person's name (windows-sync R3): 1–200 characters after trimming, no control characters. */
const PERSON_NAME_MAX = 200;
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f]/;
/** Changes to a person per connection: a burst of 5, then one every 12 s; each one is a row and a fan-out to everyone. */
const IDENTITY_BURST = 5;
const IDENTITY_EVERY_MS = 12_000;
/** §18: changes older than the newest 10,000 move to R2, one segment per 10,000. */
const ARCHIVE_KEEP = 10_000;
const ARCHIVE_SEGMENT = 10_000;

// gzip with the platform's CompressionStream (Workers, browsers and Node all have it)
async function gzip(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([bytes as Uint8Array<ArrayBuffer>]).stream().pipeThrough(new CompressionStream("gzip"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

export type { AuthContext, Change, StoredBranch };
