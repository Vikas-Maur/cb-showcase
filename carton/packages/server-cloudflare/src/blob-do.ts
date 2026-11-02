// The DO-blob fallback (PLAN §17, L11): a BlobStore kept in a Durable Object's SQLite, for an account without R2
// (R2 may need a card). One `BlobVault` per project, separate from the `ProjectRoom` sequencer, so a 64 MiB part
// upload never sits in front of a push on the sequencer's single thread.
//
// Bytes live in rows of at most 1 MiB (a DO SQLite value is capped at 2 MB). Every write is one transactionSync, so a
// reader sees an object whole or not at all. Costs, for the Free plan's 100k rows written per day: 1 row per MiB
// stored, plus 1 per MiB again when a multipart upload completes (its chunks are copied into the object) and 1 per
// MiB deleted. Fine for a demo's keyframes, segments and small proxies; R2 is the store for footage.
//
// The Worker talks to the vault over fetch (no RPC), which streams bodies of any size and keeps this module loadable
// outside workerd. Reads are served in windows of at most 16 MiB; a read across windows checks the etag, so an object
// replaced mid-read fails loudly instead of mixing versions.
//
// Abandoned uploads are swept. A multipart upload never completed or aborted (the uploader quit, the app was
// uninstalled) kept its parts in DO storage forever, against Free's 5 GB and billed by the GB-month on Paid: R2 has a
// lifecycle rule for this, the vault had nothing. Now an unfinished upload untouched for VAULT_UPLOAD_TTL_MS (24 h) is
// deleted from the vault's alarm. "Touched" is made, a part written, or its parts listed, and it costs no row per part:
// the upload's `touched` is set when it is made, and by a part or a listing at most once every TOUCH_EVERY (an hour, or
// an eighth of a shorter TTL), so an upload's last touch is less than that after its `touched`, and the sweep takes it
// once `touched` is more than the TTL plus that ago (up to an hour late), reading no part's time. The alarm is set only
// when none is pending (setAlarm is a row written too), for the oldest upload's expiry, and a vault with no upload has
// none: an idle vault never wakes.
//
// What one alarm reads is bounded, as what it deletes is (cf review, 2026-11-02: the expiry query read every upload's
// parts for their times, and finding the data of swept uploads read every part in the vault and listed every such
// upload before the budget applied, on every alarm, so a backlog cost rows read in proportion to its size again and
// again). The sweep walks the uploads in id order from a cursor kept in one row (`vault_sweep`, with the smallest live
// touch seen so far and the upload whose data is being deleted), and stops at VAULT_SWEEP_ROWS rows deleted or 8 times
// that read, whichever comes first; the next alarm, a second later, goes on from there. A full walk gives the oldest
// upload's expiry, when the next one is due.
//
// A part being received holds its upload. Its touch is the part's row, written once the whole body is in, so a resumed
// upload whose last touch was nearly a TTL ago could expire while a part's body was still arriving: the alarm deleted
// the upload and its stored parts, and the part then failed NoSuchUpload (cf review, 2026-11-02). Now each part
// request takes a lease on its upload when it starts, refreshed as its bytes arrive; the sweep skips an upload whose
// lease saw bytes within LEASE_IDLE_MS (and records a touch for it, so its expiry moves a full TTL on), and a part
// request that ends without storing its part, having received bytes, records a touch too, so an immediate retry finds
// its upload. Leases live in memory: a vault's requests and its alarm run in one instance, and a request can't outlive
// it. An upload whose uploader went away (no request, or one that stopped sending) expires as before.

import type { BlobInfo, BlobStore, ByteRange, MultipartUpload } from "@carton/core/plugins";
import { checkKey, checkRange, checkPartNumber, checkCompleteParts, randomId, BlobError, markCreated, type BlobErrorCode } from "@carton/blob-memory/rules";
import type { BlobUrlSigner } from "@carton/blob-memory/signed";
import type { DurableObjectNamespace, DurableObjectState, SqlStorage } from "./cf.ts";
import type { Env } from "./env.ts";

const CHUNK = 1 << 20;
const WINDOW = 16 << 20;
// The sweep: how long an unfinished upload lives untouched, the most rows one alarm deletes (a DO request's CPU time is
// limited; 500 rows is 500 MiB of chunks), and how soon the next alarm runs while more remain.
const UPLOAD_TTL_MS = 24 * 3600_000;
const SWEEP_ROWS = 500;
const SWEEP_AGAIN_MS = 1000;
// Rows one alarm reads, at most, per row it may delete.
const READS_PER_ROW = 8;
// An upload's `touched` is written by a part or a listing at most this often (or an eighth of a shorter TTL).
const TOUCH_EVERY_MS = 3600_000;
// How long a part request that receives no bytes still holds its upload (at most the TTL).
const LEASE_IDLE_MS = 300_000;
const DDL = [
  `CREATE TABLE IF NOT EXISTS blobs (key TEXT PRIMARY KEY, size INTEGER, etag TEXT, ctype TEXT, sha256 TEXT) WITHOUT ROWID`,
  `CREATE TABLE IF NOT EXISTS chunks (key TEXT, n INTEGER, off INTEGER, data BLOB, PRIMARY KEY (key, n)) WITHOUT ROWID`,
  `CREATE TABLE IF NOT EXISTS uploads (id TEXT PRIMARY KEY, key TEXT, ctype TEXT, touched INTEGER NOT NULL DEFAULT 0) WITHOUT ROWID`,
  `CREATE TABLE IF NOT EXISTS parts (id TEXT, n INTEGER, etag TEXT, size INTEGER, at INTEGER, PRIMARY KEY (id, n)) WITHOUT ROWID`,
  `CREATE TABLE IF NOT EXISTS part_chunks (id TEXT, n INTEGER, c INTEGER, data BLOB, PRIMARY KEY (id, n, c)) WITHOUT ROWID`,
  // the sweep's walk: the last upload id it passed ('' between walks), the smallest live touch seen on this walk, and
  // the upload it unlinked whose data it is still deleting
  `CREATE TABLE IF NOT EXISTS vault_sweep (k INTEGER PRIMARY KEY, cursor TEXT NOT NULL, low INTEGER, gone TEXT) WITHOUT ROWID`,
];

interface SweepState {
  cursor: string;
  low: number | null;
  gone: string | null;
}

type Row = Record<string, unknown>;
type VaultEnv = Pick<Env, "VAULT_UPLOAD_TTL_MS" | "VAULT_SWEEP_ROWS">;
const positive = (v: string | undefined, fallback: number) => (Number(v) > 0 && Number.isFinite(Number(v)) ? Number(v) : fallback);
/** The vault's answer to a create-only put: "1" when it created the object, "0" when it kept the one there. */
const CREATED_HEADER = "x-carton-created";
const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { "content-type": "application/json" } });
const fail = (code: BlobErrorCode, message: string, status = 400) => json({ code, message }, status);
const bytesOf = (v: unknown): Uint8Array => (v instanceof ArrayBuffer ? new Uint8Array(v) : (v as Uint8Array));

// ---------------------------------------------------------------- the Durable Object

export class BlobVault {
  readonly #sql: SqlStorage;
  readonly #state: DurableObjectState;
  readonly #ttl: number;
  readonly #sweepRows: number;
  readonly #sweepReads: number;
  readonly #touchEvery: number;
  #ready = false;
  // What this instance knows of the sweep's alarm: undefined = not checked yet, null = none (no upload), or the time
  // it is due. Once it is known, a request costs no storage call for it.
  #alarmAt: number | null | undefined;
  // Part requests in progress, by upload id: how many, and when the latest of them last received bytes (or started).
  readonly #leases = new Map<string, { n: number; at: number }>();

  constructor(state: DurableObjectState, env?: VaultEnv) {
    this.#state = state;
    this.#sql = state.storage.sql;
    this.#ttl = positive(env?.VAULT_UPLOAD_TTL_MS, UPLOAD_TTL_MS);
    this.#sweepRows = Math.floor(positive(env?.VAULT_SWEEP_ROWS, SWEEP_ROWS));
    this.#sweepReads = READS_PER_ROW * this.#sweepRows;
    this.#touchEvery = Math.min(TOUCH_EVERY_MS, this.#ttl / 8);
  }

  #all(q: string, ...p: unknown[]): Row[] {
    return this.#sql.exec<Row>(q, ...p).toArray();
  }

  #init(): void {
    if (this.#ready) return;
    const had = new Set(this.#all("SELECT name FROM sqlite_master WHERE type = 'table'").map((r) => String(r.name)));
    for (const q of DDL) this.#sql.exec(q);
    // A vault made before the sweep has neither time column. Its uploads' age is unknown, so they count as touched now
    // (the new column's default for the rows already there, which rewrites no row): swept a full TTL after this code
    // first runs, unless their uploader comes back. Their parts get no time; the upload's covers them.
    if (!this.#hasColumn("uploads", "touched")) this.#sql.exec(`ALTER TABLE uploads ADD COLUMN touched INTEGER NOT NULL DEFAULT ${Date.now()}`);
    else if (had.has("uploads") && !had.has("vault_sweep")) {
      // A vault from the sweep's first version (never released): its parts didn't write `touched`, and its sweep left
      // swept uploads' data with no row to find it by. Once: each upload's touch takes its newest part's, and that data
      // gets an expired row, which this walk deletes.
      this.#sql.exec("UPDATE uploads SET touched = max(touched, coalesce((SELECT max(p.at) FROM parts p WHERE p.id = uploads.id), touched))");
      this.#sql.exec("INSERT INTO uploads (id, key, ctype, touched) SELECT DISTINCT id, '', NULL, 0 FROM parts WHERE id NOT IN (SELECT id FROM uploads)");
    }
    if (!this.#hasColumn("parts", "at")) this.#sql.exec("ALTER TABLE parts ADD COLUMN at INTEGER");
    this.#ready = true;
  }

  #hasColumn(table: string, column: string): boolean {
    try {
      this.#sql.exec(`SELECT ${column} FROM ${table} LIMIT 0`);
      return true;
    } catch {
      return false;
    }
  }

  #info(r: Row): BlobInfo {
    const info: BlobInfo = { key: r.key as string, size: Number(r.size), etag: r.etag as string };
    if (r.ctype) info.contentType = r.ctype as string;
    if (r.sha256) info.sha256 = r.sha256 as string;
    return info;
  }

  #head(key: string): Row | undefined {
    return this.#all("SELECT key, size, etag, ctype, sha256 FROM blobs WHERE key = ?", key)[0];
  }

  #deleteObject(key: string): void {
    this.#sql.exec("DELETE FROM chunks WHERE key = ?", key);
    this.#sql.exec("DELETE FROM blobs WHERE key = ?", key);
  }

  #writeChunks(key: string, data: Uint8Array, n0 = 0, off0 = 0): void {
    for (let off = 0, n = n0; off < data.byteLength; off += CHUNK, n++)
      this.#sql.exec("INSERT INTO chunks (key, n, off, data) VALUES (?, ?, ?, ?)", key, n, off0 + off, data.subarray(off, Math.min(off + CHUNK, data.byteLength)));
  }

  async fetch(req: Request): Promise<Response> {
    this.#init();
    await this.#keepSwept();
    const url = new URL(req.url);
    const q = url.searchParams;
    const key = q.get("k") ?? "";
    try {
      if (url.pathname !== "/list") checkKey(key);
      switch (`${req.method} ${url.pathname}`) {
        case "PUT /o": {
          const data = new Uint8Array(await req.arrayBuffer());
          const sha = q.get("sha256");
          if (sha) {
            const got = [...new Uint8Array(await crypto.subtle.digest("SHA-256", data))].map((b) => b.toString(16).padStart(2, "0")).join("");
            if (got !== sha) return fail("InvalidPart", `SHA-256 mismatch: expected ${sha}, got ${got}`);
          }
          let created = false;
          const r = this.#state.storage.transactionSync(() => {
            const old = this.#head(key);
            if (old && q.get("ifAbsent") === "1") return old;
            created = true;
            if (old) this.#deleteObject(key);
            const row = { key, size: data.byteLength, etag: `"v${randomId().slice(0, 16)}"`, ctype: q.get("ct") || null, sha256: sha || null };
            this.#sql.exec("INSERT INTO blobs (key, size, etag, ctype, sha256) VALUES (?, ?, ?, ?, ?)", row.key, row.size, row.etag, row.ctype, row.sha256);
            this.#writeChunks(key, data);
            return row;
          });
          // a create-only put says whether it created (PUT_CREATED on the client's side)
          const res = json(this.#info(r));
          if (q.get("ifAbsent") === "1") res.headers.set(CREATED_HEADER, created ? "1" : "0");
          return res;
        }
        case "GET /o": {
          const h = this.#head(key);
          if (!h) return new Response(null, { status: 404 });
          const size = Number(h.size);
          const offset = Math.min(Number(q.get("off") ?? 0), size);
          const want = q.has("len") ? Number(q.get("len")) : size - offset;
          const end = Math.min(size, offset + Math.min(want, WINDOW));
          const out = new Uint8Array(Math.max(0, end - offset));
          if (out.byteLength) {
            // Chunks hold at most CHUNK bytes (a multipart object's last chunk of each part is shorter), so the
            // chunk holding byte X has n ≥ floor(X / CHUNK): start there, and stop reading rows past the window.
            for (const c of this.#sql.exec<Row>("SELECT off, data FROM chunks WHERE key = ? AND n >= ? ORDER BY n", key, Math.floor(offset / CHUNK))) {
              const off = Number(c.off), d = bytesOf(c.data);
              if (off >= end) break;
              if (off + d.byteLength <= offset) continue;
              const from = Math.max(offset, off), to = Math.min(end, off + d.byteLength);
              out.set(d.subarray(from - off, to - off), from - offset);
            }
          }
          return new Response(out, { headers: { "x-size": String(size), etag: h.etag as string } });
        }
        case "GET /meta": {
          const h = this.#head(key);
          return h ? json(this.#info(h)) : new Response(null, { status: 404 });
        }
        case "DELETE /o":
          this.#state.storage.transactionSync(() => this.#deleteObject(key));
          return json({});
        case "GET /list": {
          const prefix = q.get("prefix") ?? "", cursor = q.get("cursor") ?? "", limit = Math.max(1, Math.min(Number(q.get("limit") ?? 1000), 1000));
          // a primary-key range: keys ≥ prefix (and > cursor), stopping at the first key outside the prefix
          const rows = this.#all("SELECT key, size, etag, ctype, sha256 FROM blobs WHERE key >= ? AND key > ? ORDER BY key LIMIT ?", prefix, cursor, limit + 1);
          const inPrefix = rows.filter((r) => (r.key as string).startsWith(prefix));
          const page = inPrefix.slice(0, limit);
          return json({ blobs: page.map((r) => this.#info(r)), ...(inPrefix.length > limit ? { cursor: page[page.length - 1]!.key } : {}) });
        }
        case "POST /mp": {
          const id = randomId();
          this.#sql.exec("INSERT INTO uploads (id, key, ctype, touched) VALUES (?, ?, ?, ?)", id, key, q.get("ct") || null, Date.now());
          await this.#keepSwept(true);
          return json({ uploadId: id });
        }
        case "PUT /mp/part": {
          const id = q.get("id") ?? "", n = Number(q.get("n"));
          checkPartNumber(n);
          const lease = this.#lease(id);
          let stored = false;
          try {
            const declared = Number(q.get("len") ?? req.headers.get("content-length") ?? NaN);
            const got = await this.#receive(req, id, declared, lease);
            // declared by `len` (a streamed part) or the request's length: anything else is never stored, truncated or not
            if (got.declared && got.size !== declared) return fail("InvalidPart", `part ${n}: ${got.size} bytes arrived, ${declared} declared`);
            const data = got.data;
            const etag = this.#state.storage.transactionSync(() => {
              const up = this.#upload(id, key);
              if (!up) return null;
              // the upload's own touch, at most once every #touchEvery: the sweep reads no part's time
              const now = Date.now();
              if (now - Number(up.touched) >= this.#touchEvery) this.#sql.exec("UPDATE uploads SET touched = ? WHERE id = ?", now, id);
            this.#sql.exec("DELETE FROM part_chunks WHERE id = ? AND n = ?", id, n);
            this.#sql.exec("DELETE FROM parts WHERE id = ? AND n = ?", id, n);
            const etag = `"p${randomId().slice(0, 16)}"`;
            // `at` is the upload's touch: a column of a row written anyway, so a part costs no extra row
            this.#sql.exec("INSERT INTO parts (id, n, etag, size, at) VALUES (?, ?, ?, ?, ?)", id, n, etag, data.byteLength, Date.now());
            for (let off = 0, c = 0; off < data.byteLength; off += CHUNK, c++)
              this.#sql.exec("INSERT INTO part_chunks (id, n, c, data) VALUES (?, ?, ?, ?)", id, n, c, data.subarray(off, Math.min(off + CHUNK, data.byteLength)));
              return etag;
            });
            stored = etag !== null;
            return etag ? json({ partNumber: n, etag }) : fail("NoSuchUpload", `no multipart upload ${id} for ${key}`, 404);
          } finally {
            this.#release(id, lease, stored);
          }
        }
        case "GET /mp/parts": {
          const id = q.get("id") ?? "";
          const up = this.#upload(id, key);
          if (!up) return fail("NoSuchUpload", `no multipart upload ${id} for ${key}`, 404);
          const rows = this.#all("SELECT n, etag, size FROM parts WHERE id = ? ORDER BY n", id);
          // a listing (a resume) touches the upload, at most once every #touchEvery: a client that lists in a loop costs
          // no row each time
          const now = Date.now();
          if (now - Number(up.touched) >= this.#touchEvery) this.#sql.exec("UPDATE uploads SET touched = ? WHERE id = ?", now, id);
          return json(rows.map((r) => ({ partNumber: Number(r.n), etag: r.etag, size: Number(r.size) })));
        }
        case "POST /mp/complete": {
          const id = q.get("id") ?? "";
          const parts = (await req.json()) as { partNumber: number; etag: string }[];
          const res = this.#state.storage.transactionSync(() => {
            const up = this.#upload(id, key);
            if (!up) return null;
            const stored = new Map(this.#all("SELECT n, etag, size FROM parts WHERE id = ?", id).map((r) => [Number(r.n), { etag: r.etag as string, size: Number(r.size) }]));
            const order = checkCompleteParts(parts, (n) => stored.get(n));
            if (this.#head(key)) this.#deleteObject(key);
            let n = 0, off = 0;
            for (const p of order)
              for (const c of this.#all("SELECT data FROM part_chunks WHERE id = ? AND n = ? ORDER BY c", id, p)) {
                const d = bytesOf(c.data);
                this.#sql.exec("INSERT INTO chunks (key, n, off, data) VALUES (?, ?, ?, ?)", key, n++, off, d);
                off += d.byteLength;
              }
            const row = { key, size: off, etag: `"v${randomId().slice(0, 16)}"`, ctype: up.ctype ?? null, sha256: null };
            this.#sql.exec("INSERT INTO blobs (key, size, etag, ctype, sha256) VALUES (?, ?, ?, ?, ?)", row.key, row.size, row.etag, row.ctype, row.sha256);
            this.#dropUpload(id);
            return row;
          });
          return res ? json(this.#info(res)) : fail("NoSuchUpload", `no multipart upload ${id} for ${key}`, 404);
        }
        case "POST /mp/abort": {
          // idempotent for a gone upload, but bound to the key: an id alone must not reach another project's upload
          const id = q.get("id") ?? "";
          const up = this.#all("SELECT key FROM uploads WHERE id = ?", id)[0];
          if (up && up.key !== key) return fail("NoSuchUpload", `no multipart upload ${id} for ${key}`, 404);
          if (up) this.#state.storage.transactionSync(() => this.#dropUpload(id));
          return json({});
        }
      }
      return new Response("not found", { status: 404 });
    } catch (e) {
      if (e instanceof BlobError) return fail(e.code, e.message);
      throw e;
    }
  }

  // ---------------------------------------------------------------- a part being received holds its upload

  #lease(id: string): { at: number; got: number } {
    const l = this.#leases.get(id);
    const now = Date.now();
    if (l) (l.n++, (l.at = now));
    else this.#leases.set(id, { n: 1, at: now });
    return { at: now, got: 0 };
  }

  // The part's request ended. One that received bytes and stored nothing (cut off, refused) touches its upload, so a
  // retry right after finds it, though the sweep may have skipped it only for the lease.
  #release(id: string, mine: { at: number; got: number }, stored: boolean): void {
    const l = this.#leases.get(id);
    if (l && --l.n <= 0) this.#leases.delete(id);
    if (stored || mine.got === 0) return;
    try {
      this.#sql.exec("UPDATE uploads SET touched = max(touched, ?) WHERE id = ?", mine.at, id);
    } catch {}
  }

  #leased(id: string, now: number): boolean {
    const l = this.#leases.get(id);
    return !!l && now - l.at < Math.min(LEASE_IDLE_MS, this.#ttl);
  }

  // The part's body, read as it arrives (each read refreshes the upload's lease) into one buffer of the declared size,
  // so a part is held once in memory, as arrayBuffer() held it. Without a declared size it is read whole.
  async #receive(req: Request, id: string, declared: number, mine: { at: number; got: number }): Promise<{ data: Uint8Array; size: number; declared: boolean }> {
    if (!Number.isSafeInteger(declared) || declared < 0) {
      const data = new Uint8Array(await req.arrayBuffer());
      mine.got = data.byteLength;
      return { data, size: data.byteLength, declared: false };
    }
    if (!req.body) return { data: new Uint8Array(0), size: 0, declared: true };
    const out = new Uint8Array(declared);
    const reader = req.body.getReader();
    let size = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (size + value.byteLength <= declared) out.set(value, size);
      size += value.byteLength;
      mine.got = size;
      mine.at = Date.now();
      const l = this.#leases.get(id);
      if (l) l.at = mine.at;
    }
    return { data: out, size, declared: true };
  }

  #upload(id: string, key: string): Row | undefined {
    const r = this.#all("SELECT key, ctype, touched FROM uploads WHERE id = ?", id)[0];
    return r && r.key === key ? r : undefined;
  }

  #dropUpload(id: string): void {
    this.#sql.exec("DELETE FROM part_chunks WHERE id = ?", id);
    this.#sql.exec("DELETE FROM parts WHERE id = ?", id);
    this.#sql.exec("DELETE FROM uploads WHERE id = ?", id);
  }

  // ---------------------------------------------------------------- the sweep of abandoned uploads

  // Makes sure the sweep's alarm is pending while any upload is. Checked once per instance (one getAlarm, then a
  // bounded read if none is pending) and known after that. The check runs on any request, not only on uploads: that is
  // what reaches a vault from before the sweep, whose uploads have no alarm. `created`: an upload was just made, so a
  // vault known to need no alarm needs one now. A pending alarm is never moved: it is due by the oldest upload's expiry,
  // since a newer upload or a touch only expires later.
  async #keepSwept(created = false): Promise<void> {
    if (typeof this.#alarmAt === "number") return; // pending, or running: the alarm re-arms for what remains
    if (this.#alarmAt === null && !created) return;
    if (this.#alarmAt === undefined) {
      const cur = await this.#state.storage.getAlarm();
      if (cur !== null) return void (this.#alarmAt = cur);
    }
    const next = this.#nextSweep();
    if (next !== null) await this.#state.storage.setAlarm(next);
    this.#alarmAt = next;
  }

  // When the sweep must next run, with no alarm pending: now if a walk is under way, else the oldest upload's expiry,
  // or null when there is no upload. Reads at most what one alarm may: a vault with more uploads than that is left to
  // the alarm's walk, now.
  #nextSweep(): number | null {
    const st = this.#sweepState((q, ...p) => this.#all(q, ...p));
    if (st.cursor || st.gone) return Date.now();
    const rows = this.#all("SELECT touched FROM uploads LIMIT ?", this.#sweepReads + 1);
    if (!rows.length) return null;
    if (rows.length > this.#sweepReads) return Date.now();
    return Math.min(...rows.map((r) => Number(r.touched))) + this.#ttl + this.#touchEvery;
  }

  // The sweep, one alarm's pass: at most #sweepRows rows deleted and #sweepReads read, then the next alarm a second
  // later while the walk goes on, or at the oldest remaining upload's expiry when it is done (none when no upload is
  // left).
  async alarm(): Promise<void> {
    this.#alarmAt = undefined; // until it is re-armed below: if this throws, the next request checks again
    this.#init();
    const now = Date.now();
    const pass = this.#state.storage.transactionSync(() => this.#sweep(now));
    const next = pass.done ? pass.next : now + SWEEP_AGAIN_MS;
    const at = next === null ? null : Math.max(next, now + SWEEP_AGAIN_MS);
    // set outright: the alarm now running may still read as pending
    if (at !== null) await this.#state.storage.setAlarm(at);
    this.#alarmAt = at;
  }

  #sweepState(q: (sql: string, ...p: unknown[]) => Row[]): SweepState {
    const r = q("SELECT cursor, low, gone FROM vault_sweep WHERE k = 0")[0];
    return r ? { cursor: String(r.cursor), low: r.low === null ? null : Number(r.low), gone: r.gone === null ? null : String(r.gone) } : { cursor: "", low: null, gone: null };
  }

  /**
   * One pass of the walk. It goes on from the state row: first the rest of an unlinked upload's data, then the uploads
   * after the cursor, in id order. An expired one is unlinked (its row deleted first, so a late part, listing or
   * completion finds no upload, never one with half its data gone) and its data deleted; one with a part arriving is
   * touched now instead (its expiry a full TTL on); a live one's touch is the walk's lowest so far. `done`: the walk
   * reached the last upload, and `next` is when the oldest left expires.
   */
  #sweep(now: number): { done: boolean; next: number | null } {
    let read = 0;
    const q = (sql: string, ...p: unknown[]): Row[] => {
      const c = this.#sql.exec<Row>(sql, ...p);
      const rows = c.toArray();
      read += c.rowsRead;
      return rows;
    };
    const st0 = this.#sweepState(q), st = { ...st0 };
    const horizon = now - this.#ttl - this.#touchEvery;
    let budget = this.#sweepRows;
    let done = false, next: number | null = null;
    // Reads left, keeping a few for the state row's write and the row a ranged delete reads past its range: a pass
    // never reads more than #sweepReads.
    const room = () => this.#sweepReads - read - 4;
    walk: while (budget > 0 && room() > 0) {
      if (st.gone) {
        // a row deleted is read twice (found, then deleted)
        const n = Math.min(budget, Math.floor(room() / 2));
        if (n < 1) break;
        const left = this.#dropData(st.gone, n, q);
        budget -= left.deleted;
        if (!left.more) st.gone = null;
        continue;
      }
      // one row more than the rows it may delete: what an expired upload's data leaves of the budget is spent first
      const limit = Math.min(budget + 1, room() - 1);
      if (limit < 1) break;
      const batch = q("SELECT id, touched FROM uploads WHERE id > ? ORDER BY id LIMIT ?", st.cursor, limit);
      for (const r of batch) {
        const id = String(r.id), touched = Number(r.touched);
        st.cursor = id;
        if (touched > horizon) {
          st.low = Math.min(st.low ?? touched, touched);
          continue;
        }
        budget--;
        if (this.#leased(id, now)) {
          q("UPDATE uploads SET touched = ? WHERE id = ?", now, id);
          st.low = Math.min(st.low ?? now, now);
        } else {
          q("DELETE FROM uploads WHERE id = ?", id);
          st.gone = id;
        }
        continue walk; // its data, or the budget, before the rest of the batch
      }
      if (batch.length < limit) {
        // past the last upload: the walk is done
        done = true;
        next = st.low === null ? null : st.low + this.#ttl + this.#touchEvery;
        st.cursor = "";
        st.low = null;
        break;
      }
    }
    if (st.cursor !== st0.cursor || st.low !== st0.low || st.gone !== st0.gone) {
      if (!st.cursor && st.low === null && !st.gone) q("DELETE FROM vault_sweep WHERE k = 0");
      else q("INSERT OR REPLACE INTO vault_sweep (k, cursor, low, gone) VALUES (0, ?, ?, ?)", st.cursor, st.low, st.gone);
    }
    return { done, next };
  }

  /** Deletes up to `budget` rows of an unlinked upload's data, chunks before parts, both in key order. */
  #dropData(id: string, budget: number, q: (sql: string, ...p: unknown[]) => Row[]): { deleted: number; more: boolean } {
    const chunks = q("SELECT n, c FROM part_chunks WHERE id = ? ORDER BY n, c LIMIT ?", id, budget);
    const lc = chunks[chunks.length - 1];
    if (lc) q("DELETE FROM part_chunks WHERE id = ? AND (n, c) <= (?, ?)", id, lc.n, lc.c);
    if (chunks.length >= budget) return { deleted: chunks.length, more: true };
    const parts = q("SELECT n FROM parts WHERE id = ? ORDER BY n LIMIT ?", id, budget - chunks.length);
    const lp = parts[parts.length - 1];
    if (lp) q("DELETE FROM parts WHERE id = ? AND n <= ?", id, lp.n);
    const deleted = chunks.length + parts.length;
    return { deleted, more: deleted >= budget };
  }
}

// ---------------------------------------------------------------- the client the Worker uses

export interface DoBlobStoreOptions {
  signer?: BlobUrlSigner;
}

export class DoBlobStore implements BlobStore {
  readonly kind = "do-blob";
  readonly #ns: DurableObjectNamespace;
  readonly #name: string;
  readonly signedUrl?: (key: string, opts: { method: "GET" | "PUT"; expiresIn: number }) => Promise<string>;

  // `name` picks the vault: one per project.
  constructor(ns: DurableObjectNamespace, name: string, opts: DoBlobStoreOptions = {}) {
    this.#ns = ns;
    this.#name = name;
    const signer = opts.signer;
    if (signer)
      this.signedUrl = async (key, o) => {
        checkKey(key);
        return signer.sign(o.method, key, o.expiresIn);
      };
  }

  async #call(method: string, path: string, params: Record<string, string | number | undefined>, body?: RequestInit["body"]): Promise<Response> {
    const u = new URL(`https://vault${path}`);
    for (const [k, v] of Object.entries(params)) if (v !== undefined) u.searchParams.set(k, String(v));
    const init: RequestInit & { duplex?: "half" } = { method };
    if (body !== undefined) init.body = body;
    // a streamed body (a part passed straight through) must say so outside workerd (Node's fetch)
    if (body instanceof ReadableStream) init.duplex = "half";
    return this.#ns.get(this.#ns.idFromName(this.#name)).fetch(u.toString(), init);
  }

  async #json<T>(r: Response): Promise<T> {
    if (r.ok) return (await r.json()) as T;
    let e: { code?: BlobErrorCode; message?: string } = {};
    try {
      e = (await r.json()) as typeof e;
    } catch {}
    throw new BlobError(e.code ?? "InvalidKey", e.message ?? `blob vault answered ${r.status}`);
  }

  async put(key: string, data: Uint8Array, opts: { contentType?: string; sha256?: string; ifAbsent?: boolean } = {}): Promise<BlobInfo> {
    checkKey(key);
    const r = await this.#call("PUT", "/o", { k: key, ct: opts.contentType, sha256: opts.sha256, ifAbsent: opts.ifAbsent ? 1 : undefined }, data as Uint8Array<ArrayBuffer>);
    const info = await this.#json<BlobInfo>(r);
    const created = r.headers.get(CREATED_HEADER);
    return opts.ifAbsent && created !== null ? markCreated(info, created === "1") : info;
  }

  async get(key: string, range?: ByteRange): Promise<Uint8Array | null> {
    checkKey(key);
    if (range) checkRange(range);
    const offset = range?.offset ?? 0;
    let r = await this.#call("GET", "/o", { k: key, off: offset, len: range?.length });
    if (r.status === 404) return null;
    if (!r.ok) throw new BlobError("InvalidRange", `blob vault answered ${r.status}`);
    const size = Number(r.headers.get("x-size")), etag = r.headers.get("etag");
    const end = range?.length === undefined ? size : Math.min(size, offset + range.length);
    const first = new Uint8Array(await r.arrayBuffer());
    if (offset + first.byteLength >= end) return first;
    // more than one window: assemble, and refuse to mix versions
    const out = new Uint8Array(end - offset);
    out.set(first);
    for (let at = offset + first.byteLength; at < end; ) {
      r = await this.#call("GET", "/o", { k: key, off: at, len: end - at });
      if (r.status === 404 || r.headers.get("etag") !== etag) throw new BlobError("PreconditionFailed", `${key} changed while it was being read`);
      const part = new Uint8Array(await r.arrayBuffer());
      if (part.byteLength === 0) break;
      out.set(part, at - offset);
      at += part.byteLength;
    }
    return out;
  }

  // Streams window by window (16 MiB at most in memory), refusing to mix versions if the object is replaced.
  async getStream(key: string, range?: ByteRange): Promise<ReadableStream<Uint8Array> | null> {
    checkKey(key);
    if (range) checkRange(range);
    const offset = range?.offset ?? 0;
    const first = await this.#call("GET", "/o", { k: key, off: offset, len: range?.length });
    if (first.status === 404) return null;
    if (!first.ok) throw new BlobError("InvalidRange", `blob vault answered ${first.status}`);
    const size = Number(first.headers.get("x-size")), etag = first.headers.get("etag");
    const end = range?.length === undefined ? size : Math.min(size, offset + range.length);
    let at = offset, next: Response | null = first;
    return new ReadableStream<Uint8Array>({
      pull: async (c) => {
        if (at >= end) return c.close();
        const r = next ?? (await this.#call("GET", "/o", { k: key, off: at, len: end - at }));
        next = null;
        if (r.status === 404 || r.headers.get("etag") !== etag) return c.error(new BlobError("PreconditionFailed", `${key} changed while it was being read`));
        const part = new Uint8Array(await r.arrayBuffer());
        if (part.byteLength === 0) return c.close();
        at += part.byteLength;
        c.enqueue(part);
      },
    });
  }

  async head(key: string): Promise<BlobInfo | null> {
    checkKey(key);
    const r = await this.#call("GET", "/meta", { k: key });
    if (r.status === 404) return null;
    return this.#json(r);
  }

  async delete(key: string): Promise<void> {
    checkKey(key);
    await this.#json(await this.#call("DELETE", "/o", { k: key }));
  }

  async list(prefix: string, opts: { cursor?: string; limit?: number } = {}): Promise<{ blobs: BlobInfo[]; cursor?: string }> {
    return this.#json(await this.#call("GET", "/list", { prefix, cursor: opts.cursor, limit: opts.limit }));
  }

  async createMultipart(key: string, opts: { contentType?: string } = {}): Promise<MultipartUpload> {
    checkKey(key);
    const { uploadId } = await this.#json<{ uploadId: string }>(await this.#call("POST", "/mp", { k: key, ct: opts.contentType }));
    return this.#handle(key, uploadId);
  }

  async resumeMultipart(key: string, uploadId: string): Promise<MultipartUpload> {
    checkKey(key);
    return this.#handle(key, uploadId);
  }

  #handle(key: string, uploadId: string): MultipartUpload {
    const s = this;
    return {
      key,
      uploadId,
      async uploadPart(partNumber, data) {
        checkPartNumber(partNumber);
        return s.#json(await s.#call("PUT", "/mp/part", { k: key, id: uploadId, n: partNumber }, data as Uint8Array<ArrayBuffer>));
      },
      // the part's bytes go to the vault as they arrive: the Worker in front never reads them (its CPU and memory)
      async uploadPartStream(partNumber, body, size) {
        checkPartNumber(partNumber);
        return s.#json(await s.#call("PUT", "/mp/part", { k: key, id: uploadId, n: partNumber, len: size }, body as ReadableStream<Uint8Array>));
      },
      async listParts() {
        return s.#json(await s.#call("GET", "/mp/parts", { k: key, id: uploadId }));
      },
      async complete(parts) {
        return s.#json(await s.#call("POST", "/mp/complete", { k: key, id: uploadId }, JSON.stringify(parts)));
      },
      async abort() {
        await s.#json(await s.#call("POST", "/mp/abort", { k: key, id: uploadId }));
      },
    };
  }
}

export function doBlobStore(ns: DurableObjectNamespace, name: string, opts: DoBlobStoreOptions = {}): DoBlobStore {
  return new DoBlobStore(ns, name, opts);
}
