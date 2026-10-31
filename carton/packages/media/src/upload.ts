// Resumable uploads through any BlobStore (PLAN §11, §13 slow links).
//
// - Dedup first: if the store already holds m/<hash>, nothing is sent (whole-file dedup within the store's namespace).
// - The manifest goes up before the bytes are completed, so whoever can see m/<hash> can verify it.
// - Multipart with one part size per upload: 8 MiB when the link is slow or unknown, up to 64 MiB on fast links; every
//   part but the last has the same size (R2's rule) and there are at most 10,000 parts. Part sizes are whole leaves.
// - It resumes by completed parts. The parts are recorded in an UploadStateStore as each one lands, and the store's
//   `listParts` reconciles when it answers (R2's Workers binding has no list, so the local record has to be enough). A
//   cut link costs at most the parts that were in flight. An upload the store no longer knows (expired, aborted
//   elsewhere) is forgotten, so the next attempt starts a fresh one instead of failing forever.
// - Every leaf is checked against the manifest as it is read for upload, so bytes that changed on disk since hashing
//   are never stored under the old hash.

import type { BlobStore, Hasher, MultipartUpload } from "./contracts.ts";
import type { ByteSource } from "./hash.ts";
import { manifestKey, mediaKey } from "./keys.ts";
import { equalBytes } from "./bytes.ts";
import { LEAF_SIZE, leafDigest, type Manifest } from "./manifest.ts";

export const MIN_PART_SIZE = 8 * LEAF_SIZE;
export const FAST_PART_SIZE = 64 * LEAF_SIZE;
export const MAX_PARTS = 10_000;
/** A dropped part should cost about this much time to resend on the measured link. */
const SECONDS_PER_PART = 4;

/** Part size for an upload of `size` bytes over a link measured at `bytesPerSecond` (unknown: the slow-link size). */
export function choosePartSize(size: number, bytesPerSecond?: number): number {
  let part = MIN_PART_SIZE;
  if (bytesPerSecond && bytesPerSecond > 0) {
    while (part < FAST_PART_SIZE && part < bytesPerSecond * SECONDS_PER_PART) part *= 2;
  }
  // Huge files: grow past 64 MiB rather than break the 10,000-part limit.
  while (Math.ceil(size / part) > MAX_PARTS) part *= 2;
  return part;
}

export interface CompletedPart {
  partNumber: number;
  etag: string;
  size: number;
}

export interface UploadState {
  v: 1;
  key: string;
  hash: string;
  size: number;
  partSize: number;
  uploadId: string;
  parts: CompletedPart[];
}

/** Where open uploads are remembered between sessions. Node: a JSON file per upload; tests: memory. */
export interface UploadStateStore {
  load(key: string): Promise<UploadState | null>;
  save(state: UploadState): Promise<void>;
  delete(key: string): Promise<void>;
}

export class MemoryUploadStateStore implements UploadStateStore {
  readonly #m = new Map<string, string>();
  async load(key: string): Promise<UploadState | null> {
    const s = this.#m.get(key);
    return s === undefined ? null : (JSON.parse(s) as UploadState);
  }
  async save(state: UploadState): Promise<void> {
    this.#m.set(state.key, JSON.stringify(state));
  }
  async delete(key: string): Promise<void> {
    this.#m.delete(key);
  }
}

/** The bytes on disk no longer match the manifest: hash again before sharing. */
export class SourceChangedError extends Error {
  override name = "SourceChangedError";
}

export interface UploadProgress {
  /** Bytes the store holds for this upload, including parts from earlier sessions. */
  done: number;
  total: number;
  /** Bytes sent in this session, including parts sent again after a failure. */
  sent: number;
}

export interface UploadOptions {
  store: BlobStore;
  hasher: Hasher;
  source: ByteSource;
  manifest: Manifest;
  state?: UploadStateStore;
  /** Measured upload rate; picks the part size. */
  bytesPerSecond?: number;
  /** Overrides choosePartSize (tests). Rounded down to whole leaves. */
  partSize?: number;
  /** Parts in flight. Each holds one part in memory. */
  concurrency?: number;
  /** Attempts per part after the first, with exponential backoff, before the upload stops (resumable). */
  retries?: number;
  retryDelayMs?: number;
  signal?: AbortSignal;
  onProgress?: (p: UploadProgress) => void;
  /** Stored with the object (players read it from the range server's response). */
  contentType?: string;
}

export interface UploadResult {
  hash: string;
  size: number;
  /** The store already had it. */
  deduped: boolean;
  partSize: number;
  /** Parts found already uploaded by an earlier session. */
  resumedParts: number;
  partsSent: number;
  /** Bytes sent in this session (with resends). */
  bytesSent: number;
}

const isAbort = (e: unknown): boolean => (e as Error)?.name === "AbortError";

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const t = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(signal!.reason);
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/** Reads [offset, offset + length) and checks each whole leaf in it against the manifest. */
async function readVerified(o: UploadOptions, offset: number, length: number): Promise<Uint8Array> {
  const bytes = await o.source.read(offset, length, o.signal);
  if (bytes.length !== length) throw new SourceChangedError(`short read at ${offset}: the file changed since it was hashed`);
  const digests: Promise<Uint8Array>[] = [];
  for (let at = 0; at < length; at += LEAF_SIZE) digests.push(o.hasher.sha256(bytes.subarray(at, Math.min(length, at + LEAF_SIZE))));
  const got = await Promise.all(digests);
  const first = offset / LEAF_SIZE;
  for (let i = 0; i < got.length; i++) {
    if (!equalBytes(got[i], leafDigest(o.manifest, first + i))) {
      throw new SourceChangedError(`leaf ${first + i} changed since the file was hashed`);
    }
  }
  return bytes;
}

async function withRetries<T>(o: UploadOptions, what: () => Promise<T>): Promise<T> {
  const retries = o.retries ?? 4;
  for (let attempt = 0; ; attempt++) {
    o.signal?.throwIfAborted();
    try {
      return await what();
    } catch (e) {
      if (isAbort(e) || e instanceof SourceChangedError || attempt >= retries) throw e;
      const base = (o.retryDelayMs ?? 250) * 2 ** attempt;
      await sleep(base / 2 + Math.random() * base, o.signal);
    }
  }
}

/** Makes sure m/<hash> and mf/<hash> are in the store, sending only what is missing. */
export async function uploadMedia(o: UploadOptions): Promise<UploadResult> {
  const { store, manifest: m } = o;
  if (o.source.size !== m.size) throw new SourceChangedError(`file is ${o.source.size} bytes, manifest says ${m.size}`);
  const key = mediaKey(m.hash);
  const partSize = o.partSize ? Math.max(LEAF_SIZE, Math.floor(o.partSize / LEAF_SIZE) * LEAF_SIZE) : choosePartSize(m.size, o.bytesPerSecond);
  const result: UploadResult = { hash: m.hash, size: m.size, deduped: false, partSize, resumedParts: 0, partsSent: 0, bytesSent: 0 };

  const head = await withRetries(o, () => store.head(key));
  if (head && head.size === m.size) {
    await ensureManifest(o);
    result.deduped = true;
    o.onProgress?.({ done: m.size, total: m.size, sent: 0 });
    return result;
  }
  // A different size at a content-addressed key means a broken object; the upload below replaces it.
  await ensureManifest(o);

  if (m.size <= partSize) {
    const bytes = await readVerified(o, 0, m.size);
    await withRetries(o, () => store.put(key, bytes, { contentType: o.contentType }));
    result.partsSent = 1;
    result.bytesSent = m.size;
    o.onProgress?.({ done: m.size, total: m.size, sent: m.size });
    return result;
  }

  const states = o.state ?? new MemoryUploadStateStore();
  const partCount = Math.ceil(m.size / partSize);
  const partLength = (n: number) => Math.min(partSize, m.size - (n - 1) * partSize);
  let state = await states.load(key);
  let up: MultipartUpload | null = null;
  if (state && (state.hash !== m.hash || state.size !== m.size || state.partSize !== partSize)) {
    // Another part size or another file under the same key: start over, but don't leave the old upload open.
    await abortQuietly(store, key, state.uploadId);
    await states.delete(key);
    state = null;
  }
  if (state) {
    try {
      up = await withRetries(o, () => store.resumeMultipart(key, state!.uploadId));
    } catch (e) {
      if (isAbort(e)) throw e;
      state = null; // the store no longer knows it
    }
  }
  if (state && up) {
    try {
      const listed = await up.listParts();
      // The store is the truth when it can list; keep only whole parts.
      state.parts = listed
        .filter((p) => p.partNumber >= 1 && p.partNumber <= partCount && p.size === partLength(p.partNumber))
        .map((p) => ({ partNumber: p.partNumber, etag: p.etag, size: p.size }));
    } catch (e) {
      if (isAbort(e)) throw e;
      if (uploadGone(e)) state = null;
      // Otherwise the store can't list parts: trust the parts recorded as they landed.
    }
  }
  if (!state || !up) {
    up = await withRetries(o, () => store.createMultipart(key, { contentType: o.contentType }));
    state = { v: 1, key, hash: m.hash, size: m.size, partSize, uploadId: up.uploadId, parts: [] };
    await states.save(state);
  }
  const st = state;
  const upload = up;
  const done = new Map<number, CompletedPart>();
  for (const p of st.parts) done.set(p.partNumber, p);
  result.resumedParts = done.size;
  let doneBytes = 0;
  for (const n of done.keys()) doneBytes += partLength(n);
  o.onProgress?.({ done: doneBytes, total: m.size, sent: 0 });

  // Saves are chained so a slow save can't overwrite a newer one.
  let saving: Promise<void> = Promise.resolve();
  const save = () => {
    st.parts = [...done.values()].sort((a, b) => a.partNumber - b.partNumber);
    const snapshot: UploadState = { ...st, parts: st.parts.slice() };
    saving = saving.then(() => states.save(snapshot));
    return saving;
  };

  const todo: number[] = [];
  for (let n = 1; n <= partCount; n++) if (!done.has(n)) todo.push(n);
  let next = 0;
  let failed = false;
  const worker = async (): Promise<void> => {
    try {
      while (next < todo.length && !failed) {
        const n = todo[next++];
        const len = partLength(n);
        const bytes = await readVerified(o, (n - 1) * partSize, len);
        const { etag } = await withRetries(o, async () => {
          result.bytesSent += len;
          return upload.uploadPart(n, bytes);
        });
        done.set(n, { partNumber: n, etag, size: len });
        result.partsSent++;
        doneBytes += len;
        await save();
        o.onProgress?.({ done: doneBytes, total: m.size, sent: result.bytesSent });
      }
    } catch (e) {
      failed = true;
      throw e;
    }
  };
  const workers = Math.max(1, Math.min(o.concurrency ?? 2, todo.length));
  // Let every in-flight part finish or fail before returning, so no save lands after the caller resumes.
  const settled = await Promise.allSettled(Array.from({ length: workers }, worker));
  await saving;
  const bad = settled.find((r) => r.status === "rejected");
  try {
    if (bad) throw (bad as PromiseRejectedResult).reason;
    const parts = [...done.values()].sort((a, b) => a.partNumber - b.partNumber);
    await withRetries(o, () => upload.complete(parts.map((p) => ({ partNumber: p.partNumber, etag: p.etag }))));
  } catch (e) {
    // The store dropped the upload under us: forget it, so the next attempt starts over rather than failing again.
    if (uploadGone(e)) await states.delete(key);
    throw e;
  }
  await states.delete(key);
  return result;
}

/** Errors that mean the store has no such multipart upload (S3 and R2 say NoSuchUpload). */
function uploadGone(e: unknown): boolean {
  const err = e as { name?: string; code?: string; message?: string; status?: number } | undefined;
  return /NoSuchUpload/i.test(`${err?.name} ${err?.code} ${err?.message}`) || err?.status === 404;
}

async function abortQuietly(store: BlobStore, key: string, uploadId: string): Promise<void> {
  try {
    await (await store.resumeMultipart(key, uploadId)).abort();
  } catch {
    // Already gone: nothing to clean up.
  }
}

async function ensureManifest(o: UploadOptions): Promise<void> {
  const k = manifestKey(o.manifest.hash);
  const h = await withRetries(o, () => o.store.head(k));
  if (h && h.size === o.manifest.bytes.length) return;
  await withRetries(o, () => o.store.put(k, o.manifest.bytes, { contentType: "application/octet-stream" }));
}

/** Gives up on an open upload: the store drops its parts and the saved state is removed. */
export async function cancelUpload(store: BlobStore, states: UploadStateStore, hash: string): Promise<void> {
  const key = mediaKey(hash);
  const st = await states.load(key);
  if (st) await abortQuietly(store, key, st.uploadId);
  await states.delete(key);
}
