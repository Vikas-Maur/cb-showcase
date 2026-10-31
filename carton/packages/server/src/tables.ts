// The sequencer's tables over a SequencerStorage (a Durable Object's `ctx.storage.sql`, or node:sqlite). The DDL is
// §6.3's, from the P5 proof (proofs/do-seq): WITHOUT ROWID tables, no secondary indexes, 1 row written per change plus
// 1 per record insert, remove or track change. Everything the sequencer reads is a primary-key range or lookup.
//
// Additions to the §6.3 tables, none of which adds a row per change:
// - `changes.flags` (structural, withdrawn) and `changes.k` (the confirmed version), so the overlap test and the
//   confirmed-id list never read the body;
// - `records.lane`: a timeline item's track as of that row, for the span check (system proof, M5);
// - `rids` (one row per replica id: its device credential, §6.3), `keyframes`, and `segments` (archived ranges with
//   their id lists, so the confirmed-id list never reads an archived blob, §6.3).

import type { SequencerStorage, SqlValue } from "@carton/core/plugins";
import type { ConfirmedChange, CutRecord, DagNode, Span } from "@carton/core";
import type { sequencer, sync } from "@carton/core";

type TailRow = sequencer.TailRow;
type RecordState = sequencer.RecordState;
type ConfirmedId = sync.ConfirmedId;
/** A confirmed row as replicas receive it; a withdraw row (H1) spends an id and changes nothing. */
export type Row = ConfirmedChange & { withdrawn?: boolean };

export const DDL: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS changes (branch TEXT, seq INTEGER, id TEXT, hash BLOB, author TEXT, base TEXT,
    paths TEXT, reads TEXT, spans TEXT, policy TEXT, ops BLOB, blob TEXT, flags INTEGER, k INTEGER,
    PRIMARY KEY (branch, seq)) WITHOUT ROWID`,
  `CREATE TABLE IF NOT EXISTS records (branch TEXT, coll TEXT, id TEXT, seq INTEGER, alive INTEGER, lane TEXT,
    PRIMARY KEY (branch, coll, id, seq)) WITHOUT ROWID`,
  `CREATE TABLE IF NOT EXISTS branches (branch TEXT PRIMARY KEY, rec TEXT) WITHOUT ROWID`,
  `CREATE TABLE IF NOT EXISTS rids (rid TEXT PRIMARY KEY, credential TEXT) WITHOUT ROWID`,
  `CREATE TABLE IF NOT EXISTS keyframes (branch TEXT, seq INTEGER, hash TEXT, blob TEXT, doc TEXT,
    PRIMARY KEY (branch, seq)) WITHOUT ROWID`,
  `CREATE TABLE IF NOT EXISTS segments (branch TEXT, hi INTEGER, lo INTEGER, blob TEXT, ids TEXT,
    PRIMARY KEY (branch, hi)) WITHOUT ROWID`,
];

export const FLAG_STRUCTURAL = 1;
export const FLAG_WITHDRAWN = 2;

/** The stored branch record: the cut record plus what the sequencer keeps about it. */
export interface StoredBranch {
  id: string;
  rec: CutRecord;
  /** The parent and seq a server-side fork reads through (§6.3); each hop's bound is in the parent's numbering (H3). */
  forkOf: { branchId: string; seq: number } | null;
  /** The lowest seq this host holds a state for: 0, or the shallow root's seq ("Share without history"). */
  root: number;
  /** The seq the branch was adopted at (its hand-off point, §5.3). */
  since: number;
  adoptKey: string | null;
  /** A read-only tracking branch from a hand-off's ancestry closure: lineage nodes, no log (§5.3). */
  tracking?: boolean;
  nodes?: DagNode[];
}

// The columns the rule reads are their own; everything else of a change goes in the body.
const COLUMNS = new Set(["seq", "id", "hash", "author", "base", "paths", "reads", "spans", "policy", "rebase", "withdrawn"]);

const dec = new TextDecoder();
const enc = new TextEncoder();
const text = (v: SqlValue | undefined): string => (typeof v === "string" ? v : v instanceof Uint8Array ? dec.decode(v) : String(v));
const num = (v: SqlValue | undefined): number => Number(v ?? 0);

// spans as stored: [[track, lo, hi | null], ...]; null is a remap's open end
const encodeSpans = (spans: readonly Span[]): string => JSON.stringify(spans.map((s) => [s.track, s.lo, s.hi]));
const decodeSpans = (t: string): Span[] => (JSON.parse(t) as [string, number, number | null][]).map(([track, lo, hi]) => ({ track, lo, hi }));

export interface Meter {
  rowsRead: number;
  rowsWritten: number;
}

/**
 * The sequencer's tables. Holds small caches (heads, branch records, the parsed declarations of recent rows) that are
 * only ever rebuilt from the tables, so a Durable Object that hibernates loses nothing.
 */
export class Tables {
  readonly sql: SequencerStorage;
  /** Rows the sequencer read and wrote (P5 accounting). `storage.stats()` is the driver's own count, when it has one. */
  readonly meter: Meter = { rowsRead: 0, rowsWritten: 0 };
  private heads = new Map<string, number>();
  private branches = new Map<string, StoredBranch | null>();
  private decl = new Map<string, Map<number, TailRow>>();
  private readonly declLimit: number;
  private readonly latestOnly: boolean;

  /**
   * `records: "latest-only"` is a control for the conformance suite: it reads a record's newest row whatever its
   * seq, as v10's one-row-per-record table did, which answers forks wrongly.
   */
  constructor(sql: SequencerStorage, { declCache = 512, records = "history" }: { declCache?: number; records?: "history" | "latest-only" } = {}) {
    this.sql = sql;
    this.declLimit = declCache;
    this.latestOnly = records === "latest-only";
    for (const q of DDL) sql.exec(q);
  }

  private all<R extends Record<string, SqlValue>>(q: string, ...p: SqlValue[]): R[] {
    const rows = this.sql.exec<R>(q, ...p);
    this.meter.rowsRead += rows.length;
    return rows;
  }
  private write(q: string, ...p: SqlValue[]): void {
    this.sql.exec(q, ...p);
    this.meter.rowsWritten++;
  }
  /**
   * Run `fn` in one SQL transaction. If it throws, the rows roll back and so does every cache: anything read inside it
   * may have been uncommitted (a rid bound by a rolled-back adoption, round 2 finding 3), so all are rebuilt from the
   * tables on demand.
   */
  transaction<T>(fn: () => T): T {
    try {
      return this.sql.transaction(fn);
    } catch (e) {
      this.heads.clear();
      this.branches.clear();
      this.decl.clear();
      this.ridCache.clear();
      throw e;
    }
  }

  // ---------------------------------------------------------------- branches
  branch(id: string): StoredBranch | null {
    if (this.branches.has(id)) return this.branches.get(id)!;
    const r = this.all<{ rec: SqlValue }>("SELECT rec FROM branches WHERE branch = ?", id);
    const b = r.length ? (JSON.parse(text(r[0]!.rec)) as StoredBranch) : null;
    this.branches.set(id, b);
    return b;
  }
  /** Create a branch row; throws (rolling the transaction back) if the branch exists: never a silent replace. */
  insertBranch(b: StoredBranch): void {
    this.write("INSERT INTO branches (branch, rec) VALUES (?, ?)", b.id, JSON.stringify(b));
    this.branches.set(b.id, b);
  }
  /** Drop every cache about a branch (after a rolled-back transaction: they are rebuilt from the tables). */
  forget(branch: string): void {
    this.branches.delete(branch);
    this.heads.delete(branch);
    this.decl.delete(branch);
  }
  putBranch(b: StoredBranch): void {
    this.write("INSERT OR REPLACE INTO branches (branch, rec) VALUES (?, ?)", b.id, JSON.stringify(b));
    this.branches.set(b.id, b);
  }
  /**
   * Benchmark harness only (the P5-style CPU bench): undo a confirmed row so the next measured push sees the same
   * tail, as the P5 proof's `benchRevert` did. Never called by the sequencer.
   */
  benchRevert(branch: string, seq: number): void {
    this.sql.exec("DELETE FROM changes WHERE branch = ? AND seq = ?", branch, seq);
    this.sql.exec("DELETE FROM records WHERE branch = ? AND seq = ?", branch, seq);
    this.heads.set(branch, seq - 1);
    this.decl.get(branch)?.delete(seq);
  }
  /** Every branch this storage holds (for periodic maintenance). */
  branchIds(): string[] {
    return this.all<{ branch: string }>("SELECT branch FROM branches").map((r) => text(r.branch));
  }
  /** Remove a branch and everything stored for it (cancelling a share). */
  dropBranch(id: string): void {
    for (const t of ["changes", "records", "keyframes", "segments", "branches"]) this.sql.exec(`DELETE FROM ${t} WHERE branch = ?`, id);
    this.branches.delete(id);
    this.heads.delete(id);
    this.decl.delete(id);
  }

  head(branch: string): number {
    let h = this.heads.get(branch);
    if (h === undefined) {
      const r = this.all<{ seq: number }>("SELECT seq FROM changes WHERE branch = ? ORDER BY seq DESC LIMIT 1", branch);
      h = r.length ? num(r[0]!.seq) : (this.branch(branch)?.root ?? 0);
      this.heads.set(branch, h);
    }
    return h;
  }

  // ---------------------------------------------------------------- changes
  /** The overlap test's view of rows `(after, head]`: declarations only, never the body. */
  tail(branch: string, after: number): TailRow[] {
    const head = this.head(branch);
    if (after >= head) return [];
    let cache = this.decl.get(branch);
    if (!cache) this.decl.set(branch, (cache = new Map()));
    const out: TailRow[] = [];
    let from = after + 1;
    while (from <= head && cache.has(from)) out.push(cache.get(from)!), from++;
    if (from > head) return out;
    let expect = from;
    for (const r of this.all<{ seq: number; id: string; paths: SqlValue; reads: SqlValue; spans: SqlValue; flags: number }>(
      "SELECT seq, id, paths, reads, spans, flags FROM changes WHERE branch = ? AND seq >= ? ORDER BY seq",
      branch,
      from,
    )) {
      const flags = num(r.flags);
      const row: TailRow = {
        seq: num(r.seq),
        id: text(r.id),
        withdrawn: (flags & FLAG_WITHDRAWN) !== 0,
        paths: JSON.parse(text(r.paths)) as string[],
        reads: JSON.parse(text(r.reads)) as string[],
        spans: decodeSpans(text(r.spans)),
        structural: (flags & FLAG_STRUCTURAL) !== 0,
      };
      if (row.seq !== expect) break;
      out.push(row);
      this.remember(cache, row);
      expect++;
    }
    if (expect <= head) throw new Error(`changes ${branch}: rows from ${expect} aren't live; a tail never reaches archived rows`);
    return out;
  }
  private remember(cache: Map<number, TailRow>, row: TailRow): void {
    cache.set(row.seq, row);
    if (cache.size <= this.declLimit) return;
    let drop = cache.size - this.declLimit;
    for (const k of cache.keys()) {
      if (drop-- <= 0) break;
      cache.delete(k);
    }
  }

  /** The body of a row: everything but the columns. Large ones go to a blob (§5.1). */
  static body(row: Row): string {
    const b: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(row)) if (!COLUMNS.has(k) && v !== undefined) b[k] = v;
    return JSON.stringify(b);
  }

  /** Append a confirmed row: 1 row written, plus 1 per record write. */
  append(
    branch: string,
    row: Row,
    stored: { paths: readonly string[]; structural: boolean },
    records: readonly { coll: string; id: string; alive: boolean; lane?: string }[],
    body: { inline: string } | { blob: string },
  ): void {
    const flags = (stored.structural ? FLAG_STRUCTURAL : 0) | (row.withdrawn ? FLAG_WITHDRAWN : 0);
    this.write(
      "INSERT INTO changes (branch, seq, id, hash, author, base, paths, reads, spans, policy, ops, blob, flags, k) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      branch,
      row.seq,
      row.id,
      row.hash,
      JSON.stringify(row.author ?? null),
      JSON.stringify(row.base),
      JSON.stringify(stored.paths),
      JSON.stringify(row.reads),
      encodeSpans(row.spans),
      row.policy,
      "inline" in body ? enc.encode(body.inline) : null,
      "blob" in body ? body.blob : null,
      flags,
      row.rebase ?? 0,
    );
    for (const r of records) this.putRecord(branch, r.coll, r.id, row.seq, r.alive, r.lane);
    this.heads.set(branch, row.seq);
    const cache = this.decl.get(branch);
    if (cache) this.remember(cache, { seq: row.seq, id: row.id, withdrawn: !!row.withdrawn, paths: stored.paths, reads: row.reads, spans: row.spans, structural: stored.structural });
  }

  /** Full rows `(after, …]` from the live table, at most `limit`. A row whose body is in a blob comes with its key. */
  rows(branch: string, after: number, limit: number): { row: Row; blob: string | null }[] {
    return this.all<Record<string, SqlValue>>(
      "SELECT seq, id, hash, author, base, paths, reads, spans, policy, ops, blob, flags, k FROM changes WHERE branch = ? AND seq > ? ORDER BY seq LIMIT ?",
      branch,
      after,
      limit,
    ).map((r) => Tables.toRow(r, branch));
  }
  /**
   * At most how many bytes of reply JSON each of the next `limit` rows after `after` takes, without reading their
   * bodies (SQLite keeps a BLOB's length in its record header): a catch-up page stops at its byte budget before it
   * loads a row (§6.3). Text columns count 3 bytes a character (UTF-8, and spans grow from `[t, lo, hi]` to objects); a
   * body in the blob store isn't counted here (the caller measures it once fetched).
   */
  rowSizes(branch: string, after: number, limit: number): number[] {
    const fixed = 256 + 3 * branch.length; // the keys, the defaults toRow adds, branchId
    return this.all<{ n: number }>(
      "SELECT coalesce(length(ops), 0) + 3 * (length(id) + coalesce(length(hash), 0) + length(author) + length(base) + length(paths) + length(reads) + coalesce(length(spans), 0) + coalesce(length(policy), 0)) AS n FROM changes WHERE branch = ? AND seq > ? ORDER BY seq LIMIT ?",
      branch,
      after,
      limit,
    ).map((r) => num(r.n) + fixed);
  }
  /** Raw rows `(lo, hi]`, for archiving. */
  rawRange(branch: string, lo: number, hi: number): Record<string, SqlValue>[] {
    return this.all<Record<string, SqlValue>>(
      "SELECT seq, id, hash, author, base, paths, reads, spans, policy, ops, blob, flags, k FROM changes WHERE branch = ? AND seq > ? AND seq <= ? ORDER BY seq",
      branch,
      lo,
      hi,
    );
  }
  static toRow(r: Record<string, SqlValue>, branchId: string): { row: Row; blob: string | null } {
    const flags = num(r.flags);
    const body = r.ops === null || r.ops === undefined ? {} : (JSON.parse(text(r.ops)) as Partial<Row>);
    const row = {
      intent: null,
      kinds: null,
      trackOrder: [],
      at: 0,
      branchId,
      ...body,
      seq: num(r.seq),
      id: text(r.id),
      hash: text(r.hash ?? ""),
      author: JSON.parse(text(r.author)),
      base: JSON.parse(text(r.base)),
      // the stored paths carry the folded #trackOrder entries; replicas get the declaration as it was pushed
      paths: (JSON.parse(text(r.paths)) as string[]).filter((p) => !p.startsWith("#trackOrder/")),
      reads: JSON.parse(text(r.reads)) as string[],
      spans: decodeSpans(text(r.spans)),
      policy: text(r.policy) as Row["policy"],
      rebase: num(r.k),
      ops: (body.ops ?? []) as Row["ops"],
    } as Row;
    if (flags & FLAG_WITHDRAWN) row.withdrawn = true;
    return { row, blob: r.blob === null || r.blob === undefined ? null : text(r.blob) };
  }
  /** The lowest live seq of a branch (rows below it are archived, or before its root). */
  firstLive(branch: string): number | null {
    const r = this.all<{ seq: number }>("SELECT seq FROM changes WHERE branch = ? ORDER BY seq LIMIT 1", branch);
    return r.length ? num(r[0]!.seq) : null;
  }
  deleteRange(branch: string, lo: number, hi: number): void {
    this.sql.exec("DELETE FROM changes WHERE branch = ? AND seq > ? AND seq <= ?", branch, lo, hi);
    const cache = this.decl.get(branch);
    if (cache) for (const k of [...cache.keys()]) if (k > lo && k <= hi) cache.delete(k);
  }

  /** The id column of rows in `(lo, hi]`: live rows by primary-key range, archived ones from the segment index. */
  idsIn(branch: string, lo: number, hi: number): ConfirmedId[] {
    const out: ConfirmedId[] = [];
    const live = this.all<{ seq: number; id: string; flags: number; k: number }>(
      "SELECT seq, id, flags, k FROM changes WHERE branch = ? AND seq > ? AND seq <= ? ORDER BY seq",
      branch,
      lo,
      hi,
    );
    const firstLive = live.length ? num(live[0]!.seq) : hi + 1;
    if (firstLive > lo + 1) {
      // only the segments that overlap (lo, min(hi, firstLive - 1)]: the query itself is bounded (finding 16)
      const top = Math.min(hi, firstLive - 1);
      for (const s of this.all<{ lo: number; ids: SqlValue }>("SELECT lo, ids FROM segments WHERE branch = ? AND hi > ? AND lo < ? ORDER BY hi", branch, lo, top)) {
        for (const [seq, id, flags, k] of JSON.parse(text(s.ids)) as [number, string, number, number][])
          if (seq > lo && seq <= hi && seq < firstLive) out.push(confirmedId(seq, id, flags, k));
      }
    }
    for (const r of live) out.push(confirmedId(num(r.seq), text(r.id), num(r.flags), num(r.k)));
    return out;
  }

  // ---------------------------------------------------------------- records (existence with history, §6.3)
  putRecord(branch: string, coll: string, id: string, seq: number, alive: boolean, lane?: string): void {
    this.write("INSERT OR REPLACE INTO records (branch, coll, id, seq, alive, lane) VALUES (?, ?, ?, ?, ?, ?)", branch, coll, id, seq, alive ? 1 : 0, lane ?? null);
  }
  /**
   * The newest records row with seq ≤ `bound` on `branch`; if none, the parent's newest row at or before the fork
   * point, and so on up the chain. Each hop's bound is the fork point in that parent's own seq numbering (H3), never
   * mixed with the child's, so a fork of a fork sees what its grandparent held when the forks were made.
   */
  record(branch: string, coll: string, id: string, bound = Infinity): RecordState | undefined {
    let b: string | null = branch;
    let limit = bound;
    for (let hops = 0; b !== null && hops < 64; hops++) {
      let r: { alive: number; seq: number; lane: SqlValue }[] =
        limit === Infinity || this.latestOnly
          ? this.all("SELECT alive, seq, lane FROM records WHERE branch = ? AND coll = ? AND id = ? ORDER BY seq DESC LIMIT 1", b, coll, id)
          : this.all("SELECT alive, seq, lane FROM records WHERE branch = ? AND coll = ? AND id = ? AND seq <= ? ORDER BY seq DESC LIMIT 1", b, coll, id, limit);
      if (this.latestOnly && r.length && num(r[0]!.seq) > limit) r = [];
      if (r.length) {
        const x = r[0]!;
        const state: RecordState = { alive: num(x.alive) === 1, seq: num(x.seq) };
        if (x.lane !== null && x.lane !== undefined) state.lane = text(x.lane);
        return state;
      }
      const rec = this.branch(b);
      if (!rec?.forkOf) return undefined;
      limit = rec.forkOf.seq;
      b = rec.forkOf.branchId;
    }
    return undefined;
  }

  /**
   * `record` for many ids of one collection at the head of `branch`: one statement per 5 ids (padded, so the statement
   * shape and its cached plan stay the same). Ids with no row on the branch itself go up the fork chain one by one, as
   * `record` does.
   */
  records(branch: string, coll: string, ids: readonly string[]): Map<string, RecordState | undefined> {
    const out = new Map<string, RecordState | undefined>();
    if (this.latestOnly) {
      for (const id of ids) out.set(id, this.record(branch, coll, id));
      return out;
    }
    // one bounded seek per id (newest row ≤ head, LIMIT 1), 5 to a statement: a record's long history is never read
    // (review finding 15). 5 is a Durable Object's SQLite limit on compound SELECT terms (measured in workerd: 6 fail
    // "too many terms in compound SELECT"; test/do-limits.test.ts), and 15 bound parameters stay far under its 100.
    const CHUNK = 5;
    const one = "SELECT * FROM (SELECT id, alive, seq, lane FROM records WHERE branch = ? AND coll = ? AND id = ? ORDER BY seq DESC LIMIT 1)";
    const q = Array(CHUNK).fill(one).join(" UNION ALL ");
    for (let i = 0; i < ids.length; i += CHUNK) {
      const part = ids.slice(i, i + CHUNK);
      const params: SqlValue[] = [];
      // padding seeks an id no record has (a NUL byte), so it reads nothing
      for (let j = 0; j < CHUNK; j++) params.push(branch, coll, j < part.length ? part[j]! : "\u0000");
      for (const r of this.all<{ id: SqlValue; alive: number; seq: number; lane: SqlValue }>(q, ...params)) {
        const id = text(r.id);
        if (out.has(id)) continue;
        const state: RecordState = { alive: num(r.alive) === 1, seq: num(r.seq) };
        if (r.lane !== null && r.lane !== undefined) state.lane = text(r.lane);
        out.set(id, state);
      }
    }
    for (const id of ids) if (!out.has(id)) out.set(id, this.record(branch, coll, id));
    return out;
  }

  // bindings never change once written, and only this sequencer writes them: cache what was read
  private ridCache = new Map<string, string>();
  ridOwner(rid: string): string | undefined {
    const hit = this.ridCache.get(rid);
    if (hit !== undefined) return hit;
    const r = this.all<{ credential: string }>("SELECT credential FROM rids WHERE rid = ?", rid);
    if (!r.length) return undefined;
    const c = text(r[0]!.credential);
    this.ridCache.set(rid, c);
    return c;
  }
  bindRid(rid: string, credential: string): void {
    this.write("INSERT OR IGNORE INTO rids (rid, credential) VALUES (?, ?)", rid, credential);
    this.ridCache.delete(rid); // re-read: OR IGNORE keeps an existing binding
  }

  // ---------------------------------------------------------------- keyframes
  putKeyframe(branch: string, seq: number, hash: string, where: { blob: string } | { inline: string }): void {
    this.write("INSERT OR IGNORE INTO keyframes (branch, seq, hash, blob, doc) VALUES (?, ?, ?, ?, ?)", branch, seq, hash, "blob" in where ? where.blob : null, "inline" in where ? where.inline : null);
  }
  keyframeAt(branch: string, seq: number): StoredKeyframe | null {
    const r = this.all<{ seq: number; hash: string; blob: SqlValue; doc: SqlValue }>("SELECT seq, hash, blob, doc FROM keyframes WHERE branch = ? AND seq = ?", branch, seq);
    return r.length ? kf(r[0]!) : null;
  }
  /** The newest keyframe at or before `seq`. */
  latestKeyframe(branch: string, seq: number): StoredKeyframe | null {
    const r = this.all<{ seq: number; hash: string; blob: SqlValue; doc: SqlValue }>("SELECT seq, hash, blob, doc FROM keyframes WHERE branch = ? AND seq <= ? ORDER BY seq DESC LIMIT 1", branch, seq);
    return r.length ? kf(r[0]!) : null;
  }

  // ---------------------------------------------------------------- archived segments
  putSegment(branch: string, lo: number, hi: number, blob: string, ids: [number, string, number, number][]): void {
    this.write("INSERT INTO segments (branch, hi, lo, blob, ids) VALUES (?, ?, ?, ?, ?)", branch, hi, lo, blob, JSON.stringify(ids));
  }
  segmentsAfter(branch: string, after: number): { lo: number; hi: number; blob: string }[] {
    return this.all<{ lo: number; hi: number; blob: string }>("SELECT lo, hi, blob FROM segments WHERE branch = ? AND hi > ? ORDER BY hi", branch, after).map((s) => ({
      lo: num(s.lo),
      hi: num(s.hi),
      blob: text(s.blob),
    }));
  }
}

export interface StoredKeyframe {
  seq: number;
  hash: string;
  blob: string | null;
  doc: string | null;
}
const kf = (r: { seq: number; hash: string; blob: SqlValue; doc: SqlValue }): StoredKeyframe => ({
  seq: num(r.seq),
  hash: text(r.hash),
  blob: r.blob === null || r.blob === undefined ? null : text(r.blob),
  doc: r.doc === null || r.doc === undefined ? null : text(r.doc),
});
const confirmedId = (seq: number, id: string, flags: number, k: number): ConfirmedId =>
  flags & FLAG_WITHDRAWN ? { id, seq, rebase: k, withdrawn: true } : { id, seq, rebase: k };
