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
// an upload's last touch is the latest of its own `touched` (set when it is made, and by a listing at most once an
// hour) and its parts' `at`, a column of the row each part writes anyway. The alarm is set only when none is pending
// (setAlarm is a row written too), for the oldest upload's expiry, and a vault with no upload has none: an idle vault
// never wakes.

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
const DDL = [
  `CREATE TABLE IF NOT EXISTS blobs (key TEXT PRIMARY KEY, size INTEGER, etag TEXT, ctype TEXT, sha256 TEXT) WITHOUT ROWID`,
  `CREATE TABLE IF NOT EXISTS chunks (key TEXT, n INTEGER, off INTEGER, data BLOB, PRIMARY KEY (key, n)) WITHOUT ROWID`,
  `CREATE TABLE IF NOT EXISTS uploads (id TEXT PRIMARY KEY, key TEXT, ctype TEXT, touched INTEGER NOT NULL DEFAULT 0) WITHOUT ROWID`,
  `CREATE TABLE IF NOT EXISTS parts (id TEXT, n INTEGER, etag TEXT, size INTEGER, at INTEGER, PRIMARY KEY (id, n)) WITHOUT ROWID`,
  `CREATE TABLE IF NOT EXISTS part_chunks (id TEXT, n INTEGER, c INTEGER, data BLOB, PRIMARY KEY (id, n, c)) WITHOUT ROWID`,
];

// When upload `u` was last touched: made or listed (its `touched`), or a part written (the newest part's `at`).
const LAST_TOUCH = "max(u.touched, coalesce((SELECT max(p.at) FROM parts p WHERE p.id = u.id), 0))";

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
  #ready = false;
  // What this instance knows of the sweep's alarm: undefined = not checked yet, null = none (no upload), or the time
  // it is due. Once it is known, a request costs no storage call for it.
  #alarmAt: number | null | undefined;

  constructor(state: DurableObjectState, env?: VaultEnv) {
    this.#state = state;
    this.#sql = state.storage.sql;
    this.#ttl = positive(env?.VAULT_UPLOAD_TTL_MS, UPLOAD_TTL_MS);
    this.#sweepRows = Math.floor(positive(env?.VAULT_SWEEP_ROWS, SWEEP_ROWS));
  }

  #all(q: string, ...p: unknown[]): Row[] {
    return this.#sql.exec<Row>(q, ...p).toArray();
  }

  #init(): void {
    if (this.#ready) return;
    for (const q of DDL) this.#sql.exec(q);
    // A vault made before the sweep has neither time column. Its uploads' age is unknown, so they count as touched now
    // (the new column's default for the rows already there, which rewrites no row): swept a full TTL after this code
    // first runs, unless their uploader comes back. Their parts get no time; the upload's covers them.
    if (!this.#hasColumn("uploads", "touched")) this.#sql.exec(`ALTER TABLE uploads ADD COLUMN touched INTEGER NOT NULL DEFAULT ${Date.now()}`);
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
          const data = new Uint8Array(await req.arrayBuffer());
          const etag = this.#state.storage.transactionSync(() => {
            if (!this.#upload(id, key)) return null;
            this.#sql.exec("DELETE FROM part_chunks WHERE id = ? AND n = ?", id, n);
            this.#sql.exec("DELETE FROM parts WHERE id = ? AND n = ?", id, n);
            const etag = `"p${randomId().slice(0, 16)}"`;
            // `at` is the upload's touch: a column of a row written anyway, so a part costs no extra row
            this.#sql.exec("INSERT INTO parts (id, n, etag, size, at) VALUES (?, ?, ?, ?, ?)", id, n, etag, data.byteLength, Date.now());
            for (let off = 0, c = 0; off < data.byteLength; off += CHUNK, c++)
              this.#sql.exec("INSERT INTO part_chunks (id, n, c, data) VALUES (?, ?, ?, ?)", id, n, c, data.subarray(off, Math.min(off + CHUNK, data.byteLength)));
            return etag;
          });
          return etag ? json({ partNumber: n, etag }) : fail("NoSuchUpload", `no multipart upload ${id} for ${key}`, 404);
        }
        case "GET /mp/parts": {
          const id = q.get("id") ?? "";
          const up = this.#upload(id, key);
          if (!up) return fail("NoSuchUpload", `no multipart upload ${id} for ${key}`, 404);
          const rows = this.#all("SELECT n, etag, size, at FROM parts WHERE id = ? ORDER BY n", id);
          // a listing (a resume) touches the upload, at most once an hour (an eighth of a shorter TTL): a client that
          // lists in a loop costs no row each time
          const now = Date.now(), last = Math.max(Number(up.touched), ...rows.map((r) => Number(r.at ?? 0)));
          if (now - last >= Math.min(3600_000, this.#ttl / 8)) this.#sql.exec("UPDATE uploads SET touched = ? WHERE id = ?", now, id);
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

  // Makes sure the sweep's alarm is pending while any upload is. Checked once per instance (one getAlarm, then a read
  // of the uploads if none is pending) and known after that. The check runs on any request, not only on uploads: that
  // is what reaches a vault from before the sweep, whose uploads have no alarm. `created`: an upload was just made, so
  // a vault known to need no alarm needs one now. A pending alarm is never moved: it is due by the oldest upload's
  // expiry, since a newer upload or a touch only expires later.
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

  // When the sweep must next run: now if a swept upload's data is left, else the oldest upload's expiry, or null when
  // there is no upload at all.
  #nextSweep(): number | null {
    if (this.#all("SELECT 1 FROM parts WHERE id NOT IN (SELECT id FROM uploads) LIMIT 1").length) return Date.now();
    const t = this.#all(`SELECT min(${LAST_TOUCH}) AS t FROM uploads u`)[0]?.t;
    return t === null || t === undefined ? null : Number(t) + this.#ttl;
  }

  // The sweep: deletes unfinished uploads untouched for the TTL, at most #sweepRows rows per alarm (one 5 GB upload is
  // about 5000 rows), and comes back a second later while more remain. Then the alarm is set for the oldest remaining
  // upload's expiry, or not at all when none is left.
  async alarm(): Promise<void> {
    this.#alarmAt = undefined; // until it is re-armed below: if this throws, the next request checks again
    this.#init();
    const now = Date.now();
    const more = this.#state.storage.transactionSync(() => this.#sweep(now - this.#ttl, this.#sweepRows));
    const next = more ? now + SWEEP_AGAIN_MS : this.#nextSweep();
    const at = next === null ? null : Math.max(next, now + SWEEP_AGAIN_MS);
    // set outright: the alarm now running may still read as pending
    if (at !== null) await this.#state.storage.setAlarm(at);
    this.#alarmAt = at;
  }

  /** One pass of the sweep, deleting at most `budget` rows; true if rows may be left for another. */
  #sweep(before: number, budget: number): boolean {
    // The expired uploads' own rows go first, so a late part, listing or completion finds no upload, never one with
    // half its data gone (a completion would make a truncated object).
    const expired = this.#all(`SELECT id FROM uploads u WHERE ${LAST_TOUCH} <= ? LIMIT ?`, before, budget);
    for (const r of expired) this.#sql.exec("DELETE FROM uploads WHERE id = ?", r.id);
    if ((budget -= expired.length) <= 0) return true;
    // Then the data of uploads that are gone, chunks before parts, both in key order: an upload's parts rows stay
    // while any of its chunks do, which is how the next pass finds what this one left.
    for (const { id } of this.#all("SELECT DISTINCT id FROM parts WHERE id NOT IN (SELECT id FROM uploads)")) {
      const chunks = this.#all("SELECT n, c FROM part_chunks WHERE id = ? ORDER BY n, c LIMIT ?", id, budget);
      const lc = chunks[chunks.length - 1];
      if (lc) this.#sql.exec("DELETE FROM part_chunks WHERE id = ? AND (n, c) <= (?, ?)", id, lc.n, lc.c);
      if ((budget -= chunks.length) <= 0) return true;
      const parts = this.#all("SELECT n FROM parts WHERE id = ? ORDER BY n LIMIT ?", id, budget);
      const lp = parts[parts.length - 1];
      if (lp) this.#sql.exec("DELETE FROM parts WHERE id = ? AND n <= ?", id, lp.n);
      if ((budget -= parts.length) <= 0) return true;
    }
    return false;
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
    const init: RequestInit = { method };
    if (body !== undefined) init.body = body;
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
