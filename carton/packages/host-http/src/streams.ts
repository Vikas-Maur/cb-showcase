// A proxy stream's two routes (cf-proxy-path): publish a batch of parts in one request, read a batch in one request.
// The layout in the store is media's, unchanged (stream.ts): `m/<hash>` and `mf/<hash>` per part, `ps/<id>/init`,
// `ps/<id>/s/<n>`, `ps/<id>/end`, so clients that read or write it part by part (older apps, any store) see the same
// stream. What changes is the number of round trips and storage calls:
//
// - POST /api/projects/:p/streams/:id/append (editor): the parts' bytes, manifests and entries, and maybe the end, in
//   one request, where the part-by-part path took ten per segment (a head of the bytes, a damage check, a head of the
//   manifest, then a signed URL and a PUT each for the manifest, the bytes and the entry), one after another. The host
//   writes every part's manifest and bytes, then every entry, then the end (see `media` below for the order).
//   No head first: the parts of a new stream are new, and dedup is the client's (it sends a part it found stored
//   without its bytes, and the host checks the object is there, its size, and that no damage report is open). An entry
//   or end that is already there is kept if it says the same (a retried request), else 409. The daily write cap (a
//   Worker's) is reserved once for the whole request, where each write reserved on its own before.
// - GET /api/projects/:p/streams/:id/read?from=&init=&bytes=&parts=&wait= (any session that may read the stream): the
//   init entry if asked, then segment entries from `from`, each with its manifest (from the entry, which a batch writer
//   includes; else `mf/<hash>`), and the bytes of as many as fit in `bytes` (at least one segment's; 0: entries only),
//   in one response. Where the part-by-part path took six requests per segment (a signed URL and a read each for the
//   entry, the manifest and the bytes), every read a head and a get. When it reaches a part that isn't up, it looks for
//   the end, and with `wait` holds the answer (checking once a second, then every two) until the first part asked for is up.
//
// Entries of one append may land in any order (they are written a few at once); the request answers once all are in,
// and a writer retries a request that failed, so a gap lasts no longer than that, unless the writer dies mid-request:
// then readers wait at the gap as they would at a stream that stopped there, and the stream goes stale and is taken
// over (media's claim). Readers verify every leaf against its manifest as they always do: the host checks shapes,
// sizes and manifests (a manifest is verified by its own hash), never the media bytes (no hashing of segment bytes in a
// request that has 10 ms of CPU on a Worker's Free plan), as the signed PUT it replaces never did.

import type { AuthContext, BlobStore, BlobWithInfo } from "@carton/core/plugins";
import { canPush } from "@carton/server";
import { readBody, BodyTooLarge } from "@carton/blob-memory/signed";
import { putCreated } from "@carton/blob-memory/rules";
import {
  decodeManifest,
  fromBase64,
  manifestKey,
  markRepaired,
  mediaKey,
  openReport,
  streamEndKey,
  streamEndOf,
  streamInitKey,
  streamPartOf,
  streamSegmentKey,
  streamSegmentOf,
  toBase64,
  webCryptoHasher,
  type Manifest,
  type StreamEnd,
} from "@carton/media";
import { eachLimit } from "./pool.ts";
import { isTeamMediaStore } from "./team.ts";
import { headerFrame, MAX_APPEND_HEADER, MAX_STREAM_HEADER, splitFrame, StreamWireError, STREAM_WIRE_VERSION, u32, type AppendHeaderPart, type ReadHeader, type ReadHeaderSegment } from "./stream-wire.ts";

const hasher = webCryptoHasher();
const utf8 = new TextEncoder();
const fromUtf8 = new TextDecoder();
const STREAM_ID = /^[0-9a-f]{64}$/;
const MAX_INDEX = 999_999;

/** Parts one append may carry. */
export const MAX_APPEND_PARTS = 64;
/** The largest append body (and never more than the host's request limit). */
export const MAX_APPEND_BYTES = 64 << 20;
/** The most bytes one read sends. */
export const MAX_READ_BYTES = 32 << 20;
/** The longest a read may be held at the live edge. */
export const MAX_READ_WAIT_MS = 25_000;
const READ_CHECK_MS = 1000;
/** Storage calls at once (a Worker opens at most six connections at a time, R2 calls included). */
const AT_ONCE = 6;
/** Objects fetched ahead of the one being sent in a read. */
const READ_AHEAD = 3;

export interface StreamRouteContext {
  ctx: AuthContext;
  /** The project's media store, for reads. */
  store: BlobStore;
  /** The same store for a write of about `bytes` in `ops` calls (a host with a write cap reserves them in one go). */
  storeForWrites(bytes: number, ops: number): Promise<BlobStore>;
  mayRead(key: string): boolean;
  /** Runs a write of `m/<hash>` under the host's media lock (the repair check's). */
  lock<T>(key: string, fn: () => Promise<T>): Promise<T>;
  /** The host's request body limit. */
  maxBodyBytes: number;
  maxUploadBytes?: number;
  /** Entries one read lists at most (a Worker's budget of storage calls). */
  maxEntries: number;
}

const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
const err = (status: number, message: string, extra: Record<string, unknown> = {}) => json({ error: message, ...extra }, status);

class Refused extends Error {
  readonly status: number;
  readonly extra: Record<string, unknown>;
  constructor(status: number, message: string, extra: Record<string, unknown> = {}) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}

/** `/streams/<id>/<route>`, or null when `rest` isn't a stream route. */
export async function streamRoutes(req: Request, url: URL, rest: string, c: StreamRouteContext): Promise<Response | null> {
  const m = /^\/streams\/([^/]+)\/(append|read)$/.exec(rest);
  if (!m) return null;
  const [, stream, route] = m as unknown as [string, string, "append" | "read"];
  if (!STREAM_ID.test(stream)) return err(400, "a stream id is 64 lowercase hex characters");
  try {
    if (route === "append") {
      if (req.method !== "POST") return err(405, "POST");
      return await append(req, stream, c);
    }
    if (req.method !== "GET") return err(405, "GET");
    return await read(url, stream, c, req.signal);
  } catch (e) {
    if (e instanceof Refused) return err(e.status, e.message, e.extra);
    if (e instanceof StreamWireError) return err(400, e.message);
    throw e;
  }
}

// ------------------------------------------------------------------------------------------------------------ append

interface Part {
  kind: "init" | "segment";
  manifest: Manifest;
  bytes: Uint8Array | null;
  entry: Uint8Array;
  key: string;
  index: number;
  durationSec: number;
  repair: boolean;
}

const isCount = (n: unknown): n is number => typeof n === "number" && Number.isSafeInteger(n) && n >= 0;
const isSeconds = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n) && n >= 0;

async function append(req: Request, stream: string, c: StreamRouteContext): Promise<Response> {
  if (!canPush(c.ctx)) return err(403, "read-only role");
  const max = Math.min(c.maxBodyBytes, MAX_APPEND_BYTES);
  const declared = Number(req.headers.get("content-length") ?? NaN);
  if (declared > max) return err(413, "append body too large");
  let raw: Uint8Array;
  try {
    // With a declared length (the client always sends one) the runtime buffers the body itself: read chunk by chunk in
    // JavaScript, a 3 MB batch cost a Worker ~80 ms of CPU (the Free plan allows 10).
    raw = Number.isSafeInteger(declared) && declared >= 0 ? new Uint8Array(await req.arrayBuffer()) : await readBody(req, max);
  } catch (e) {
    if (e instanceof BodyTooLarge) return err(413, "append body too large");
    throw e;
  }
  if (raw.length > max) return err(413, "append body too large");
  const { header, rest } = splitFrame(raw, MAX_APPEND_HEADER);
  const h = header as { v?: unknown; parts?: unknown; end?: unknown };
  if (!h || typeof h !== "object" || h.v !== STREAM_WIRE_VERSION) return err(400, `stream wire version ${STREAM_WIRE_VERSION} expected`);
  if (!Array.isArray(h.parts) || h.parts.length > MAX_APPEND_PARTS || (h.parts.length === 0 && h.end === undefined))
    return err(400, `parts must be 1..${MAX_APPEND_PARTS} entries (or none, with the end)`);

  // every part checked before anything is written: shapes, order, manifests, sizes, and the bytes that follow
  const parts: Part[] = [];
  let at = 0, lastIndex = -1;
  for (const [n, raw] of (h.parts as unknown[]).entries()) {
    const p = raw as Partial<AppendHeaderPart> | null;
    if (!p || (p.kind !== "init" && p.kind !== "segment") || typeof p.manifest !== "string" || typeof p.bytes !== "boolean") return err(400, `part ${n}: bad shape`);
    if (p.kind === "init" && n !== 0) return err(400, "the init segment comes first");
    const mb = p.manifest.length <= 64 * 1024 ? fromBase64(p.manifest) : null;
    let manifest: Manifest;
    try {
      if (!mb) throw new Error();
      manifest = await decodeManifest(mb, hasher, typeof p.hash === "string" ? p.hash : undefined);
    } catch {
      return err(400, `part ${n}: its manifest doesn't verify`);
    }
    if (p.size !== manifest.size) return err(400, `part ${n}: size ${p.size}, its manifest says ${manifest.size}`);
    if (c.maxUploadBytes !== undefined && manifest.size > c.maxUploadBytes) return err(413, `part ${n} is bigger than this host takes`);
    let bytes: Uint8Array | null = null;
    if (p.bytes) {
      if (at + manifest.size > rest.length) return err(400, `part ${n}: its bytes are short`);
      bytes = rest.subarray(at, at + manifest.size);
      at += manifest.size;
    }
    let entry: Record<string, unknown>, key: string, index = -1;
    if (p.kind === "init") {
      key = streamInitKey(stream);
      entry = { hash: manifest.hash, size: manifest.size, manifest: p.manifest };
    } else {
      if (!isCount(p.index) || p.index > MAX_INDEX || (lastIndex >= 0 && p.index !== lastIndex + 1)) return err(400, `part ${n}: segment indexes must follow each other`);
      if (!isSeconds(p.durationSec) || !isCount(p.at)) return err(400, `part ${n}: bad duration or time`);
      index = lastIndex = p.index;
      key = streamSegmentKey(stream, index);
      entry = { hash: manifest.hash, size: manifest.size, index, durationSec: p.durationSec, at: p.at, manifest: p.manifest };
    }
    const entryBytes = utf8.encode(JSON.stringify(entry));
    // every object this request writes is held to the host's per-object limit, as a signed PUT of it would be
    if (c.maxUploadBytes !== undefined && Math.max(mb.length, entryBytes.length) > c.maxUploadBytes) return err(413, `part ${n}'s manifest or entry is bigger than this host takes`);
    parts.push({ kind: p.kind, manifest, bytes, entry: entryBytes, key, index, durationSec: p.kind === "segment" ? (p.durationSec as number) : 0, repair: p.repair === true && !!bytes });
  }
  if (at !== rest.length) return err(400, `${rest.length - at} bytes follow the parts`);
  let end: StreamEnd | null = null, endBytes: Uint8Array | null = null;
  if (h.end !== undefined) {
    end = streamEndOf(h.end);
    if (!end) return err(400, "bad end entry");
    if (lastIndex >= 0 && end.segments !== lastIndex + 1) return err(400, `the end says ${end.segments} segments; the last one sent is ${lastIndex}`);
    endBytes = utf8.encode(JSON.stringify(end));
    if (c.maxUploadBytes !== undefined && endBytes.length > c.maxUploadBytes) return err(413, "the end entry is bigger than this host takes");
  }

  // One reservation for every write below: the manifest, the bytes and the entry per part, a repair's answer, and the
  // end. (A team store's grants aren't charged: the Worker keeps them outside its cap, room.ts mediaBlobs.) Refused, the
  // host's cap error (with `retryAt`) goes up before anything is written: the client waits and sends the batch again.
  let bytes = endBytes?.length ?? 0, ops = end ? 1 : 0;
  for (const p of parts) {
    bytes += p.manifest.bytes.length + p.entry.length + (p.bytes?.length ?? 0) + (p.repair ? 256 : 0);
    ops += (p.bytes ? 3 : 2) + (p.repair ? 1 : 0);
  }
  const store = await c.storeForWrites(bytes, ops);

  // Bytes and manifests first, every part's at once (up to the Worker's six connections), each manifest no later than
  // its bytes: before them on a team store, which needs it to take the bytes, beside them elsewhere, where nothing reads
  // a segment's bytes before its entry names them. Then the entries, at once. R2 is a round trip away from the edge
  // (APAC from BOM: hundreds of ms), so a batch costs three round trips, however many parts it carries.
  const together = !isTeamMediaStore(store);
  const media = async (p: Part) => {
    const hash = p.manifest.hash, mk = mediaKey(hash);
    if (!p.bytes) {
      // sent without its bytes: they must be there, the right size, and not reported damaged (else the client sends them)
      const there = await store.head(mk);
      if (!there || there.size !== p.manifest.size || (await openReport(store, hash))) throw new Refused(409, `part ${hash.slice(0, 12)} isn't stored: send its bytes`, { code: "Missing", index: p.index });
    }
    // a part the client sends again after a Missing answer: the report that made it missing is answered once the
    // bytes are in (read first, as an upload's repair reads it before replacing the object)
    const report = p.repair ? await openReport(store, hash) : null;
    const manifest = () => store.put(manifestKey(hash), p.manifest.bytes, { contentType: "application/octet-stream" });
    const bytes = () => (p.bytes ? c.lock(mk, () => store.put(mk, p.bytes!, { contentType: "video/mp4" })) : Promise.resolve());
    if (together) await Promise.all([manifest(), bytes()]);
    else {
      await manifest();
      await bytes();
    }
    if (report) await markRepaired(store, hash, report);
  };
  await eachLimit(parts, together ? AT_ONCE / 2 : AT_ONCE, media);
  await eachLimit(parts, AT_ONCE, (p) =>
    putEntry(store, p.key, p.entry, (old) => {
      // a retried request writes the same entry; another writer's (or other metadata) is a conflict
      if (p.kind === "init") {
        const v = streamPartOf(old);
        return !!v && v.hash === p.manifest.hash && v.size === p.manifest.size;
      }
      const v = streamSegmentOf(old, p.index);
      return !!v && v.hash === p.manifest.hash && v.size === p.manifest.size && v.durationSec === p.durationSec;
    }),
  );
  if (end) {
    await putEntry(store, streamEndKey(stream), endBytes!, (old) => {
      const v = streamEndOf(old);
      const same = (a?: unknown[], b?: unknown[]) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
      return !!v && v.segments === end!.segments && v.size === end!.size && v.durationSec === end!.durationSec && same(v.parts, end!.parts) && same(v.sizes, end!.sizes) && same(v.durations, end!.durations);
    });
  }
  return json({ stored: parts.length, ...(end ? { ended: true } : {}) });
}

/** Writes an entry once. One already there must be the same entry (`same`): a retried request; else 409. */
async function putEntry(store: BlobStore, key: string, body: Uint8Array, same: (old: unknown) => boolean): Promise<void> {
  const info = await store.put(key, body, { contentType: "application/json", ifAbsent: true });
  if (putCreated(info) === true) return;
  const old = await store.get(key);
  let v: unknown = null;
  try {
    v = old && JSON.parse(fromUtf8.decode(old));
  } catch {}
  if (!same(v)) throw new Refused(409, `${key.split("/").slice(2).join("/")} is already there with other content: one writer per stream`, { code: "Conflict" });
}

// -------------------------------------------------------------------------------------------------------------- read

/** Waits `ms`, or less if `signal` aborts (the caller checks it). */
const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((r) => {
    const t = setTimeout(done, ms);
    function done() {
      clearTimeout(t);
      signal?.removeEventListener("abort", done);
      r();
    }
    signal?.addEventListener("abort", done, { once: true });
  });

/**
 * Keeps a read's header under what a client accepts (MAX_STREAM_HEADER): a long stream's end lists every part, and
 * with a few hundred entries beside it could pass it. The end goes without its lists first (what a reader needs from it
 * here is where the stream stops; the whole entry is one signed read away), then entries from the tail.
 */
function fitHeader(h: ReadHeader): void {
  const room = MAX_STREAM_HEADER - 1024;
  const size = () => utf8.encode(JSON.stringify(h)).length;
  if (size() <= room) return;
  const e = h.end as StreamEnd | null | undefined;
  if (e) h.end = { segments: e.segments, durationSec: e.durationSec, size: e.size, at: e.at };
  while (h.segments.length > 1 && size() > room) h.segments.pop();
}

async function getJson(store: BlobStore, key: string): Promise<unknown> {
  const b = await store.get(key);
  if (!b) return null;
  try {
    return JSON.parse(fromUtf8.decode(b));
  } catch {
    return null; // a damaged entry reads as absent, as media's reader takes it
  }
}

const intParam = (url: URL, name: string, dflt: number, max: number): number => {
  const v = url.searchParams.get(name);
  const n = v === null ? dflt : Number(v);
  return Number.isSafeInteger(n) && n >= 0 ? Math.min(n, max) : dflt;
};

interface Listed {
  hash: string;
  size: number;
  manifest?: string;
  bytes: boolean;
}

async function read(url: URL, stream: string, c: StreamRouteContext, signal?: AbortSignal): Promise<Response> {
  // the same rule as a signed URL for these keys (a watch link's scope)
  if (!c.mayRead(streamInitKey(stream))) return err(403, "outside this link's scope");
  const from = intParam(url, "from", 0, MAX_INDEX);
  const wantInit = url.searchParams.get("init") === "1";
  const maxBytes = intParam(url, "bytes", 4 << 20, MAX_READ_BYTES);
  const maxParts = Math.max(1, intParam(url, "parts", c.maxEntries, c.maxEntries));
  const waitMs = intParam(url, "wait", 0, MAX_READ_WAIT_MS);
  const store = c.store;
  const deadline = Date.now() + waitMs;

  let h: ReadHeader;
  for (let checks = 0; ; checks++) {
    // a reader that went away (its request aborted) costs no more storage reads
    if (signal?.aborted) return err(499, "the client went away");
    h = await collect(store, stream, from, wantInit, maxBytes, maxParts);
    const something = wantInit ? h.init !== null : h.segments.length > 0;
    // once a second at first, then every two (each check is a storage read or two)
    const pause = checks < 4 ? READ_CHECK_MS : 2 * READ_CHECK_MS;
    if (something || (h.end !== undefined && h.end !== null) || Date.now() + pause > deadline) break;
    await sleep(pause, signal);
  }
  fitHeader(h);

  // the manifests the entries don't carry (entries from before a batch writer wrote them)
  const sent: Listed[] = [...(h.init ? [h.init] : []), ...h.segments].filter((p) => p.bytes);
  await eachLimit(
    sent.filter((p) => !p.manifest),
    4,
    async (p) => {
      const mb = await store.get(manifestKey(p.hash));
      if (mb) p.manifest = toBase64(mb);
      else p.bytes = false; // nothing to verify it with: the client reads it the usual way
    },
  );
  const parts = sent.filter((p) => p.bytes);
  return new Response(body(store, h, parts), { headers: { "content-type": "application/octet-stream", "cache-control": "no-store" } });
}

/** The entries from `from` (and the init's, if asked), with which of them get their bytes; the end if it reached the edge. */
async function collect(store: BlobStore, stream: string, from: number, wantInit: boolean, maxBytes: number, maxParts: number): Promise<ReadHeader> {
  const h: ReadHeader = { v: STREAM_WIRE_VERSION, segments: [] };
  if (wantInit) {
    const v = await getJson(store, streamInitKey(stream));
    const p = streamPartOf(v);
    // the init segment is small, and with a first segment's bytes it is the first frame: it never counts against `bytes`
    h.init = p ? { hash: p.hash, size: p.size, ...withManifest(v), bytes: maxBytes > 0 } : null;
    if (!p) return h; // only claimed: nothing else is up
  }
  let used = 0, window = 1, reachedEdge = false;
  // entries a few at once, stopping at the first one not up; the first window is one (a live reader is usually at the edge)
  for (let i = from; h.segments.length < maxParts && i <= MAX_INDEX && !reachedEdge; ) {
    const n = Math.min(window, maxParts - h.segments.length, MAX_INDEX + 1 - i);
    const got = await Promise.all(Array.from({ length: n }, (_, k) => getJson(store, streamSegmentKey(stream, i + k))));
    for (let k = 0; k < n; k++) {
      const v = got[k];
      const s = streamSegmentOf(v, i + k);
      if (!s) {
        reachedEdge = true;
        break;
      }
      let bytes = false;
      if (maxBytes > 0) {
        // at least one segment's bytes, then as many as fit; an entry whose bytes don't fit ends the list
        if (used > 0 && used + s.size > maxBytes) return h;
        bytes = true;
        used += s.size;
      }
      const seg: ReadHeaderSegment = { index: s.index, hash: s.hash, size: s.size, durationSec: s.durationSec, at: s.at, ...withManifest(v), bytes };
      h.segments.push(seg);
    }
    i += n;
    // grow the window towards what the budget leaves room for
    const last = h.segments[h.segments.length - 1]?.size ?? 512 * 1024;
    window = maxBytes > 0 ? Math.max(1, Math.min(4, Math.ceil((maxBytes - used) / Math.max(1, last)))) : Math.min(AT_ONCE, window * 2);
  }
  if (reachedEdge) h.end = streamEndOf(await getJson(store, streamEndKey(stream)));
  return h;
}

function withManifest(v: unknown): { manifest?: string } {
  const m = (v as { manifest?: unknown } | null)?.manifest;
  return typeof m === "string" && m.length <= 64 * 1024 && fromBase64(m) ? { manifest: m } : {};
}

/** The response body: the header, then each part's bytes (length first), a few objects fetched ahead of the one sent. */
// workerd's byte stream that a native body is piped into without passing each chunk through JavaScript (through a
// JavaScript TransformStream, a 3 MB answer cost a Worker ~80 ms of CPU); elsewhere a plain TransformStream.
const Identity = (globalThis as { IdentityTransformStream?: new () => TransformStream<Uint8Array, Uint8Array> }).IdentityTransformStream;

function body(store: BlobStore, h: ReadHeader, parts: Listed[]): ReadableStream<Uint8Array> {
  const { readable, writable } = Identity ? new Identity() : new TransformStream<Uint8Array, Uint8Array>();
  const fetched: Promise<BlobWithInfo | Uint8Array | null>[] = [];
  const fetchAt = (k: number): void => {
    if (k >= parts.length || k < fetched.length) return; // asked for in order, so the fetched ones are a prefix
    const key = mediaKey(parts[k]!.hash);
    const p = store.getWithInfo ? store.getWithInfo(key) : store.get(key);
    p.catch(() => {}); // seen below, or dropped with the response
    fetched[k] = p;
  };
  void (async () => {
    let w = writable.getWriter();
    try {
      await w.write(headerFrame(h));
      for (let k = 0; k < parts.length; k++) {
        for (let a = k; a < k + READ_AHEAD; a++) fetchAt(a);
        const part = parts[k]!;
        let o: BlobWithInfo | Uint8Array | null = null;
        try {
          o = await fetched[k]!;
        } catch {} // unreadable now: the client reads it the usual way
        const size = o === null ? -1 : o instanceof Uint8Array ? o.length : o.info.size;
        if (o === null || size !== part.size) {
          if (o && !(o instanceof Uint8Array)) await o.body?.cancel().catch(() => {});
          await w.write(u32(0));
          continue;
        }
        await w.write(u32(part.size));
        if (o instanceof Uint8Array) await w.write(o);
        else if (o.body) {
          w.releaseLock();
          await o.body.pipeTo(writable, { preventClose: true });
          w = writable.getWriter();
        }
      }
      await w.close();
    } catch (e) {
      await w.abort(e).catch(() => {});
      for (const f of fetched) void f?.then((o) => (o && !(o instanceof Uint8Array) ? o.body?.cancel() : undefined)).catch(() => {});
    }
  })();
  return readable;
}
