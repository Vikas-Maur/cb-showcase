// BlobStore on the local file system (PLAN §3.1): server-node's store when there is no S3, and a local cache.
//
// Layout under `root`:
//   objects/<encoded key>~b   the bytes, a plain file (keys.ts explains the encoding)
//   objects/<encoded key>~m   optional sidecar: content type, SHA-256, and the key when a segment had to be hashed
//   uploads/<uploadId>/       a multipart upload: meta.json and <n>.part
//   tmp/                      files being written; leftovers from a crash are swept on open
//
// Writes go to tmp/, are fsynced (archived change segments must survive a crash once the sequencer drops their
// rows), then renamed into place, so readers see the old bytes or the new, never a mix. `ifAbsent` uses a hard link,
// which fails atomically if the key exists. On Windows a rename or delete fails with EPERM/EBUSY/EACCES while
// another handle has the target open, so those retry with backoff for about 1.3 s, as scripts/rename-retry.js does.

import { open, mkdir, rename, link, unlink, readdir, stat, rm, readFile, writeFile, type FileHandle } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { Readable } from "node:stream";
import { join, dirname, sep } from "node:path";
import type { BlobInfo, BlobStore, ByteRange, MultipartUpload } from "@carton/core/plugins";
import { checkKey, checkRange, checkPartNumber, checkCompleteParts, randomId, BlobError } from "@carton/blob-memory/rules";
import { keyToSegments, decodeSegment, encodeSegment, OBJECT_SUFFIX } from "./keys.ts";

export { BadKeyError } from "./keys.ts";

const META_SUFFIX = "~m";
const UPLOAD_ID = /^[0-9a-f]{32}$/;
const COPY_CHUNK = 1 << 20;
const TMP_MAX_AGE_MS = 3600_000;
const WIN = process.platform === "win32";
const RETRY_CODES = new Set(["EPERM", "EBUSY", "EACCES"]);

export interface FsBlobStoreOptions {
  root: string;
  // fsync files (and, outside Windows, their directory) before a write resolves. Default true.
  durable?: boolean;
  // Refuse multipart parts (but the last) under this size, to match S3/R2 (5 MiB). Default 0.
  minPartSize?: number;
}

interface Meta {
  // fingerprint of the object version this sidecar describes; a sidecar for another version is ignored
  fp: string;
  key?: string;
  contentType?: string;
  sha256?: string;
}

const isCode = (e: unknown, ...codes: string[]) => codes.includes((e as NodeJS.ErrnoException)?.code ?? "");

// Windows refuses to replace or delete a file another handle has open; retry briefly (see the header).
async function retrying<T>(fn: () => Promise<T>): Promise<T> {
  for (let i = 0; ; i++) {
    try {
      return await fn();
    } catch (e) {
      if (!WIN || i >= 8 || !RETRY_CODES.has((e as NodeJS.ErrnoException)?.code ?? "")) throw e;
      await new Promise((r) => setTimeout(r, 10 * 2 ** Math.min(i, 5)));
    }
  }
}

function fingerprint(s: { ino: bigint; mtimeNs: bigint; size: bigint }): string {
  return `${s.ino.toString(36)}-${s.mtimeNs.toString(36)}-${s.size.toString(36)}`;
}

export class FsBlobStore implements BlobStore {
  readonly kind = "fs";
  readonly root: string;
  readonly #objects: string;
  readonly #uploads: string;
  readonly #tmp: string;
  readonly #durable: boolean;
  readonly #minPart: number;
  readonly #dirs = new Set<string>();
  readonly #ready: Promise<void>;

  constructor(opts: FsBlobStoreOptions) {
    const root = opts.root;
    this.root = root;
    this.#objects = join(root, "objects");
    this.#uploads = join(root, "uploads");
    this.#tmp = join(root, "tmp");
    this.#durable = opts.durable ?? true;
    this.#minPart = opts.minPartSize ?? 0;
    this.#ready = this.#init();
    this.#ready.catch(() => {}); // surfaced by the first operation instead
  }

  async #init(): Promise<void> {
    for (const d of [this.#objects, this.#uploads, this.#tmp]) await this.#mkdirp(d);
    const now = Date.now();
    for (const name of await readdir(this.#tmp)) {
      const p = join(this.#tmp, name);
      try {
        if (now - (await stat(p)).mtimeMs > TMP_MAX_AGE_MS) await unlink(p);
      } catch {}
    }
  }

  async #mkdirp(dir: string): Promise<void> {
    if (this.#dirs.has(dir)) return;
    await mkdir(dir, { recursive: true });
    this.#dirs.add(dir);
  }

  #file(key: string): string {
    checkKey(key);
    return join(this.#objects, ...keyToSegments(key));
  }

  #tmpName(): string {
    return join(this.#tmp, randomId());
  }

  async #syncDir(dir: string): Promise<void> {
    // Windows can't open a directory for fsync; NTFS journals the rename itself.
    if (!this.#durable || WIN) return;
    const fh = await open(dir, "r");
    try {
      await fh.sync();
    } finally {
      await fh.close();
    }
  }

  // Writes `data` (or the parts) to a fresh temp file and returns its path and fingerprint.
  async #writeTmp(fill: (fh: FileHandle) => Promise<void>): Promise<{ tmp: string; fp: string }> {
    const tmp = this.#tmpName();
    const fh = await open(tmp, "wx");
    try {
      await fill(fh);
      if (this.#durable) await fh.sync();
      return { tmp, fp: fingerprint(await fh.stat({ bigint: true })) };
    } catch (e) {
      await fh.close().catch(() => {});
      await unlink(tmp).catch(() => {});
      throw e;
    } finally {
      await fh.close().catch(() => {});
    }
  }

  // A sidecar is written only when there is metadata to keep, or when the key can't be read back from the path.
  #needsMeta(file: string, contentType?: string, sha256?: string): boolean {
    return !!(contentType || sha256) || !this.#decodable(file);
  }

  #decodable(file: string): boolean {
    const rel = file.slice(this.#objects.length + 1, -OBJECT_SUFFIX.length);
    return !rel.split(sep).some((s) => s.includes("~"));
  }

  async #writeMeta(file: string, meta: Meta): Promise<void> {
    const { tmp } = await this.#writeTmp((fh) => fh.writeFile(JSON.stringify(meta)));
    await retrying(() => rename(tmp, metaOf(file)));
  }

  async #readMeta(file: string, fp: string): Promise<Meta | null> {
    try {
      const m = JSON.parse(await readFile(metaOf(file), "utf8")) as Meta;
      return m.fp === fp ? m : null;
    } catch {
      return null;
    }
  }

  async put(key: string, data: Uint8Array, opts: { contentType?: string; sha256?: string; ifAbsent?: boolean } = {}): Promise<BlobInfo> {
    const file = this.#file(key);
    await this.#ready;
    if (opts.ifAbsent) {
      const existing = await this.head(key);
      if (existing) return existing;
    }
    await this.#mkdirp(dirname(file));
    const { tmp, fp } = await this.#writeTmp(async (fh) => {
      await fh.writeFile(data);
    });
    const meta: Meta | null = this.#needsMeta(file, opts.contentType, opts.sha256)
      ? { fp, key, ...(opts.contentType ? { contentType: opts.contentType } : {}), ...(opts.sha256 ? { sha256: opts.sha256 } : {}) }
      : null;
    if (opts.ifAbsent) {
      if (!(await this.#linkIfAbsent(tmp, file))) {
        await unlink(tmp).catch(() => {});
        return (await this.head(key))!;
      }
      if (meta) await this.#writeMeta(file, meta);
    } else {
      // the sidecar goes first and names this version's fingerprint, so a reader never pairs new bytes with old
      // metadata (it may briefly see none)
      if (meta) await this.#writeMeta(file, meta);
      else await retrying(() => unlink(metaOf(file))).catch(() => {});
      await retrying(() => rename(tmp, file));
    }
    await this.#syncDir(dirname(file));
    const info: BlobInfo = { key, size: data.byteLength, etag: `"${fp}"` };
    if (opts.contentType) info.contentType = opts.contentType;
    if (opts.sha256) info.sha256 = opts.sha256;
    return info;
  }

  // Atomic create-if-absent: a hard link fails with EEXIST if the key exists. FAT and exFAT have no hard links
  // (L13); there it falls back to check-then-rename, which can lose a race between two first writers of the same key
  // (for content-addressed keys both wrote the same bytes).
  async #linkIfAbsent(tmp: string, file: string): Promise<boolean> {
    try {
      await link(tmp, file);
      await unlink(tmp);
      return true;
    } catch (e) {
      if (isCode(e, "EEXIST")) return false;
      if (!isCode(e, "EPERM", "ENOTSUP", "EOPNOTSUPP", "ENOSYS", "EISDIR", "EINVAL")) throw e;
    }
    try {
      await stat(file);
      return false;
    } catch {}
    await retrying(() => rename(tmp, file));
    return true;
  }

  async get(key: string, range?: ByteRange): Promise<Uint8Array | null> {
    const file = this.#file(key);
    if (range) checkRange(range);
    await this.#ready;
    let fh: FileHandle;
    try {
      fh = await open(file, "r");
    } catch (e) {
      if (isCode(e, "ENOENT", "ENOTDIR")) return null;
      throw e;
    }
    try {
      const size = (await fh.stat()).size;
      const start = Math.min(range?.offset ?? 0, size);
      const end = range?.length === undefined ? size : Math.min(size, start + range.length);
      // a plain Uint8Array, not a Buffer: Buffer#slice doesn't copy, which would surprise a caller
      const out = new Uint8Array(end - start);
      let at = 0;
      while (at < out.byteLength) {
        const { bytesRead } = await fh.read(out, at, out.byteLength - at, start + at);
        if (bytesRead === 0) break; // truncated under us; can't happen with rename-only writers
        at += bytesRead;
      }
      return at === out.byteLength ? out : out.subarray(0, at);
    } finally {
      await fh.close();
    }
  }

  async getStream(key: string, range?: ByteRange): Promise<ReadableStream<Uint8Array> | null> {
    const file = this.#file(key);
    if (range) checkRange(range);
    await this.#ready;
    let fh: FileHandle;
    try {
      fh = await open(file, "r");
    } catch (e) {
      if (isCode(e, "ENOENT", "ENOTDIR")) return null;
      throw e;
    }
    const size = (await fh.stat()).size;
    const start = Math.min(range?.offset ?? 0, size);
    const end = range?.length === undefined ? size : Math.min(size, start + range.length);
    if (end <= start) {
      await fh.close();
      return new ReadableStream({ start: (c) => c.close() });
    }
    // the stream owns the handle from here and closes it at the end, on error, or when the reader cancels
    const rs = createReadStream("", { fd: fh, start, end: end - 1, autoClose: true, highWaterMark: 1 << 20 });
    return Readable.toWeb(rs) as ReadableStream<Uint8Array>;
  }

  async head(key: string): Promise<BlobInfo | null> {
    const file = this.#file(key);
    await this.#ready;
    let s;
    try {
      s = await stat(file, { bigint: true });
    } catch (e) {
      if (isCode(e, "ENOENT", "ENOTDIR")) return null;
      throw e;
    }
    const fp = fingerprint(s);
    const info: BlobInfo = { key, size: Number(s.size), etag: `"${fp}"` };
    const meta = await this.#readMeta(file, fp);
    if (meta?.contentType) info.contentType = meta.contentType;
    if (meta?.sha256) info.sha256 = meta.sha256;
    return info;
  }

  async delete(key: string): Promise<void> {
    const file = this.#file(key);
    await this.#ready;
    for (const p of [file, metaOf(file)]) {
      try {
        await retrying(() => unlink(p));
      } catch (e) {
        if (!isCode(e, "ENOENT", "ENOTDIR")) throw e;
      }
    }
  }

  // Walks the directories under the prefix's complete segments, then sorts. O(objects under the prefix) per page:
  // fine for a local store, whose lists are rare (GC, the conformance suite).
  async list(prefix: string, opts: { cursor?: string; limit?: number } = {}): Promise<{ blobs: BlobInfo[]; cursor?: string }> {
    await this.#ready;
    const limit = Math.max(1, Math.min(opts.limit ?? 1000, 1000));
    const segs = prefix.split("/");
    segs.pop(); // the last (possibly partial) segment is matched by filtering
    let dir = this.#objects;
    for (const s of segs) {
      if (s === "" || s === "." || s === "..") return { blobs: [] };
      dir = join(dir, encodeSegment(s));
    }
    const found: { key: string; file: string }[] = [];
    await this.#walk(dir, segs.length ? segs.join("/") + "/" : "", segs.length === 0 ? false : segs.some((s) => encodeSegment(s).includes("~")), found);
    const keys = found
      .filter((f) => f.key.startsWith(prefix) && (opts.cursor === undefined || f.key > opts.cursor))
      .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
    const page = keys.slice(0, limit);
    const blobs: BlobInfo[] = [];
    for (const f of page) {
      try {
        const s = await stat(f.file, { bigint: true });
        blobs.push({ key: f.key, size: Number(s.size), etag: `"${fingerprint(s)}"` });
      } catch {} // deleted while listing
    }
    const out: { blobs: BlobInfo[]; cursor?: string } = { blobs };
    if (keys.length > limit) out.cursor = page[page.length - 1]!.key;
    return out;
  }

  async #walk(dir: string, keyPrefix: string, hashedAbove: boolean, out: { key: string; file: string }[]): Promise<void> {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch (e) {
      if (isCode(e, "ENOENT", "ENOTDIR")) return;
      throw e;
    }
    for (const e of entries) {
      const p = join(dir, e.name);
      if (e.isDirectory()) {
        const d = decodeSegment(e.name);
        await this.#walk(p, d === null ? keyPrefix : keyPrefix + d + "/", hashedAbove || d === null, out);
      } else if (e.name.endsWith(OBJECT_SUFFIX)) {
        const d = decodeSegment(e.name.slice(0, -OBJECT_SUFFIX.length));
        if (!hashedAbove && d !== null) out.push({ key: keyPrefix + d, file: p });
        else {
          // a hashed segment: the sidecar holds the key (any version's sidecar will do for the key)
          try {
            const m = JSON.parse(await readFile(metaOf(p), "utf8")) as Meta;
            if (typeof m.key === "string") out.push({ key: m.key, file: p });
          } catch {}
        }
      }
    }
  }

  // ---------------------------------------------------------------- multipart

  #uploadDir(uploadId: string): string {
    if (!UPLOAD_ID.test(uploadId)) throw new BlobError("NoSuchUpload", `no multipart upload ${JSON.stringify(uploadId)}`);
    return join(this.#uploads, uploadId);
  }

  async createMultipart(key: string, opts: { contentType?: string } = {}): Promise<MultipartUpload> {
    checkKey(key);
    await this.#ready;
    const id = randomId();
    const dir = join(this.#uploads, id);
    await mkdir(dir);
    await writeFile(join(dir, "meta.json"), JSON.stringify({ key, ...(opts.contentType ? { contentType: opts.contentType } : {}) }));
    return this.#handle(key, id);
  }

  async resumeMultipart(key: string, uploadId: string): Promise<MultipartUpload> {
    checkKey(key);
    await this.#ready;
    return this.#handle(key, uploadId);
  }

  async #uploadMeta(key: string, uploadId: string): Promise<{ dir: string; contentType?: string }> {
    const dir = this.#uploadDir(uploadId);
    let m: { key: string; contentType?: string };
    try {
      m = JSON.parse(await readFile(join(dir, "meta.json"), "utf8"));
    } catch {
      throw new BlobError("NoSuchUpload", `no multipart upload ${uploadId}`);
    }
    if (m.key !== key) throw new BlobError("NoSuchUpload", `upload ${uploadId} is for another key`);
    return m.contentType ? { dir, contentType: m.contentType } : { dir };
  }

  async #parts(dir: string): Promise<Map<number, { etag: string; size: number; file: string }>> {
    const parts = new Map<number, { etag: string; size: number; file: string }>();
    for (const name of await readdir(dir)) {
      const m = /^(\d+)\.part$/.exec(name);
      if (!m) continue;
      const file = join(dir, name);
      try {
        const s = await stat(file, { bigint: true });
        parts.set(Number(m[1]), { etag: `"${fingerprint(s)}"`, size: Number(s.size), file });
      } catch {}
    }
    return parts;
  }

  #handle(key: string, uploadId: string): MultipartUpload {
    const store = this;
    return {
      key,
      uploadId,
      async uploadPart(partNumber, data) {
        checkPartNumber(partNumber);
        const { dir } = await store.#uploadMeta(key, uploadId);
        // through tmp/ and a rename, so a part cut off mid-write never shows up in listParts
        const { tmp, fp } = await store.#writeTmp(async (fh) => {
          await fh.writeFile(data);
        });
        await retrying(() => rename(tmp, join(dir, `${partNumber}.part`)));
        return { partNumber, etag: `"${fp}"` };
      },
      async listParts() {
        const { dir } = await store.#uploadMeta(key, uploadId);
        return [...(await store.#parts(dir))].sort((a, b) => a[0] - b[0]).map(([partNumber, p]) => ({ partNumber, etag: p.etag, size: p.size }));
      },
      async complete(parts) {
        const { dir, contentType } = await store.#uploadMeta(key, uploadId);
        const stored = await store.#parts(dir);
        const order = checkCompleteParts(parts, (n) => stored.get(n), store.#minPart);
        const file = store.#file(key);
        await store.#mkdirp(dirname(file));
        const buf = new Uint8Array(COPY_CHUNK);
        let size = 0;
        // One part open at a time (an upload may have 10,000), and each is re-checked through the handle it is
        // copied from: a part renamed over since the check above has another fingerprint, and the whole complete
        // fails before anything is published.
        const { tmp, fp } = await store.#writeTmp(async (out) => {
          for (const n of order) {
            const want = stored.get(n)!;
            const fh = await open(want.file, "r").catch((e) => {
              if (isCode(e, "ENOENT")) throw new BlobError("InvalidPart", `part ${n} is gone`);
              throw e;
            });
            try {
              if (`"${fingerprint(await fh.stat({ bigint: true }))}"` !== want.etag) throw new BlobError("InvalidPart", `part ${n} was replaced during complete`);
              for (let at = 0; at < want.size; ) {
                const { bytesRead } = await fh.read(buf, 0, Math.min(buf.byteLength, want.size - at), at);
                if (bytesRead === 0) throw new Error(`part ${n} ended early: ${at} of ${want.size} bytes`);
                await writeAll(out, buf, bytesRead);
                at += bytesRead;
                size += bytesRead;
              }
            } finally {
              await fh.close();
            }
          }
        });
        if (contentType) await store.#writeMeta(file, { fp, key, contentType });
        else if (store.#needsMeta(file)) await store.#writeMeta(file, { fp, key });
        else await retrying(() => unlink(metaOf(file))).catch(() => {});
        await retrying(() => rename(tmp, file));
        await store.#syncDir(dirname(file));
        await rm(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 50 });
        const info: BlobInfo = { key, size, etag: `"${fp}"` };
        if (contentType) info.contentType = contentType;
        return info;
      },
      // Idempotent for a gone upload, but bound to the key (an id alone must not reach another project's upload).
      async abort() {
        const dir = store.#uploadDir(uploadId); // a malformed id is refused, never resolved to a path
        try {
          await store.#uploadMeta(key, uploadId);
        } catch (e) {
          if (e instanceof BlobError && /another key/.test(e.message)) throw e;
          return;
        }
        await rm(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 50 });
      },
    };
  }
}

// FileHandle.write may write fewer bytes than asked; loop until all are written, and fail rather than spin.
export async function writeAll(fh: Pick<FileHandle, "write">, buf: Uint8Array, length: number): Promise<void> {
  for (let off = 0; off < length; ) {
    const { bytesWritten } = await fh.write(buf, off, length - off);
    if (!(bytesWritten > 0)) throw new Error(`write made no progress at ${off} of ${length} bytes`);
    off += bytesWritten;
  }
}

export function createFsBlobStore(opts: FsBlobStoreOptions): FsBlobStore {
  return new FsBlobStore(opts);
}

function metaOf(file: string): string {
  return file.slice(0, -OBJECT_SUFFIX.length) + META_SUFFIX;
}
