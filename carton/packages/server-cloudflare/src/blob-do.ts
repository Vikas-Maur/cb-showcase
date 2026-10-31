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

import type { BlobInfo, BlobStore, ByteRange, MultipartUpload } from "@carton/core/plugins";
import { checkKey, checkRange, checkPartNumber, checkCompleteParts, randomId, BlobError, type BlobErrorCode } from "@carton/blob-memory/rules";
import type { BlobUrlSigner } from "@carton/blob-memory/signed";
import type { DurableObjectNamespace, DurableObjectState, SqlStorage } from "./cf.ts";

const CHUNK = 1 << 20;
const WINDOW = 16 << 20;
const DDL = [
  `CREATE TABLE IF NOT EXISTS blobs (key TEXT PRIMARY KEY, size INTEGER, etag TEXT, ctype TEXT, sha256 TEXT) WITHOUT ROWID`,
  `CREATE TABLE IF NOT EXISTS chunks (key TEXT, n INTEGER, off INTEGER, data BLOB, PRIMARY KEY (key, n)) WITHOUT ROWID`,
  `CREATE TABLE IF NOT EXISTS uploads (id TEXT PRIMARY KEY, key TEXT, ctype TEXT) WITHOUT ROWID`,
  `CREATE TABLE IF NOT EXISTS parts (id TEXT, n INTEGER, etag TEXT, size INTEGER, PRIMARY KEY (id, n)) WITHOUT ROWID`,
  `CREATE TABLE IF NOT EXISTS part_chunks (id TEXT, n INTEGER, c INTEGER, data BLOB, PRIMARY KEY (id, n, c)) WITHOUT ROWID`,
];

type Row = Record<string, unknown>;
const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { "content-type": "application/json" } });
const fail = (code: BlobErrorCode, message: string, status = 400) => json({ code, message }, status);
const bytesOf = (v: unknown): Uint8Array => (v instanceof ArrayBuffer ? new Uint8Array(v) : (v as Uint8Array));

// ---------------------------------------------------------------- the Durable Object

export class BlobVault {
  readonly #sql: SqlStorage;
  readonly #state: DurableObjectState;
  #ready = false;

  constructor(state: DurableObjectState, _env: unknown) {
    this.#state = state;
    this.#sql = state.storage.sql;
  }

  #all(q: string, ...p: unknown[]): Row[] {
    return this.#sql.exec<Row>(q, ...p).toArray();
  }

  #init(): void {
    if (this.#ready) return;
    for (const q of DDL) this.#sql.exec(q);
    this.#ready = true;
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
    const url = new URL(req.url);
    const q = url.searchParams;
    const key = q.get("k") ?? "";
    try {
      if (url.pathname !== "/list" && url.pathname !== "/mp/abort") checkKey(key);
      switch (`${req.method} ${url.pathname}`) {
        case "PUT /o": {
          const data = new Uint8Array(await req.arrayBuffer());
          const sha = q.get("sha256");
          if (sha) {
            const got = [...new Uint8Array(await crypto.subtle.digest("SHA-256", data))].map((b) => b.toString(16).padStart(2, "0")).join("");
            if (got !== sha) return fail("InvalidPart", `SHA-256 mismatch: expected ${sha}, got ${got}`);
          }
          const r = this.#state.storage.transactionSync(() => {
            const old = this.#head(key);
            if (old && q.get("ifAbsent") === "1") return old;
            if (old) this.#deleteObject(key);
            const row = { key, size: data.byteLength, etag: `"v${randomId().slice(0, 16)}"`, ctype: q.get("ct") || null, sha256: sha || null };
            this.#sql.exec("INSERT INTO blobs (key, size, etag, ctype, sha256) VALUES (?, ?, ?, ?, ?)", row.key, row.size, row.etag, row.ctype, row.sha256);
            this.#writeChunks(key, data);
            return row;
          });
          return json(this.#info(r));
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
          this.#sql.exec("INSERT INTO uploads (id, key, ctype) VALUES (?, ?, ?)", id, key, q.get("ct") || null);
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
            this.#sql.exec("INSERT INTO parts (id, n, etag, size) VALUES (?, ?, ?, ?)", id, n, etag, data.byteLength);
            for (let off = 0, c = 0; off < data.byteLength; off += CHUNK, c++)
              this.#sql.exec("INSERT INTO part_chunks (id, n, c, data) VALUES (?, ?, ?, ?)", id, n, c, data.subarray(off, Math.min(off + CHUNK, data.byteLength)));
            return etag;
          });
          return etag ? json({ partNumber: n, etag }) : fail("NoSuchUpload", `no multipart upload ${id} for ${key}`, 404);
        }
        case "GET /mp/parts": {
          const id = q.get("id") ?? "";
          if (!this.#upload(id, key)) return fail("NoSuchUpload", `no multipart upload ${id} for ${key}`, 404);
          return json(this.#all("SELECT n, etag, size FROM parts WHERE id = ? ORDER BY n", id).map((r) => ({ partNumber: Number(r.n), etag: r.etag, size: Number(r.size) })));
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
          const id = q.get("id") ?? "";
          this.#state.storage.transactionSync(() => this.#dropUpload(id));
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
    const r = this.#all("SELECT key, ctype FROM uploads WHERE id = ?", id)[0];
    return r && r.key === key ? r : undefined;
  }

  #dropUpload(id: string): void {
    this.#sql.exec("DELETE FROM part_chunks WHERE id = ?", id);
    this.#sql.exec("DELETE FROM parts WHERE id = ?", id);
    this.#sql.exec("DELETE FROM uploads WHERE id = ?", id);
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
    return this.#json(await this.#call("PUT", "/o", { k: key, ct: opts.contentType, sha256: opts.sha256, ifAbsent: opts.ifAbsent ? 1 : undefined }, data as Uint8Array<ArrayBuffer>));
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
