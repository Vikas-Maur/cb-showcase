// A deployment's daily write cap. A public Worker whose writes already need a session (no open creation, invites from
// an ADMIN_TOKEN) still wants a hard ceiling on what it stores in a day, so a leaked token or a runaway client can't
// fill the bucket (R2 bills past its free allowance; a Durable Object's storage is 5 GB on the Free plan). Off unless
// WRITE_CAP_BYTES_PER_DAY or WRITE_CAP_OPS_PER_DAY is set.
//
// - Every write a blob store makes through its public calls (put, createMultipart, uploadPart, complete) first reserves
//   its bytes and one operation in a counter for the UTC day: one row in the ProjectRoom named `write-cap/<day>` (as
//   open creation's daily count; project ids have no slash, so it is never a project's room). The room is
//   single-threaded, so check-and-add is atomic across every isolate.
// - Over the cap the write is refused before any byte is stored: WriteCapError, which the Worker answers 429 with code
//   `DailyWriteCap` and Retry-After until 00:00 UTC. Clients already treat a refused part as a failed attempt (backoff,
//   then a resumable stop), never as stored. The error carries `retryAt` (BlobStore's contract for a refusal for a
//   while), so a sync write the sequencer couldn't store reaches the client as `write-limit` with that time: the client
//   keeps its edits and sends them again after it, with no reconnect.
// - Reads and deletes are never capped: deleting is how a full bucket is emptied.
// - It sits under the scope and team wrappers, on the physical store, so team records and the sequencer's own blobs
//   (keyframes, segments, envelopes) count too. Not a team's grants (room.ts mediaBlobs): an editor's media HEAD writes
//   one, and reads must go on once the cap is reached. A store's own extra records (R2's per-part upload records) ride on the
//   call that makes them: an operation here is one public call, which is one to four R2 Class A operations.
// - Each reserve is one Durable Object request and one row written. For a part of 8 to 64 MiB that is noise; for a
//   stream of tiny writes it doubles the DO requests, which is why the cap is opt-in.

import type { BlobInfo, BlobStore, MultipartUpload } from "@carton/core/plugins";
import type { DurableObjectNamespace } from "./cf.ts";

export const WRITE_CAP_CODE = "DailyWriteCap";
/** The counter room's path (ProjectRoom.fetch). */
export const WRITE_CAP_PATH = "/write-cap/reserve";

export class WriteCapError extends Error {
  override name = "WriteCapError";
  readonly code = WRITE_CAP_CODE;
  /** Seconds until the counter resets (00:00 UTC). */
  readonly retryAfterSec: number;
  /** When the counter resets, in ms since the epoch (BlobStore's refusal for a while: `sync.writeLimitOf`). */
  readonly retryAt: number;
  constructor(message: string, retryAfterSec: number, retryAt = Date.now() + retryAfterSec * 1000) {
    super(message);
    this.retryAfterSec = retryAfterSec;
    this.retryAt = retryAt;
  }
}

export interface WriteCap {
  /** Reserves `bytes` and `ops` operations for today, or throws WriteCapError (nothing reserved). */
  reserve(bytes: number, ops?: number): Promise<void>;
}

export interface WriteCapEnv {
  PROJECT_ROOM: DurableObjectNamespace;
  WRITE_CAP_BYTES_PER_DAY?: string;
  WRITE_CAP_OPS_PER_DAY?: string;
}

/** What the counter room answers: whether it reserved, and today's totals after the call. */
export interface WriteCapAnswer {
  ok: boolean;
  bytes: number;
  ops: number;
}

const positive = (v: string | undefined): number => {
  const n = Number(v ?? 0);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
};
const dayOf = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const nextMidnight = (ms: number) => Date.UTC(new Date(ms).getUTCFullYear(), new Date(ms).getUTCMonth(), new Date(ms).getUTCDate() + 1);
const secondsToMidnight = (ms: number) => Math.max(1, Math.ceil((nextMidnight(ms) - ms) / 1000));

/** The deployment's cap, or undefined when neither limit is set. `opts.now`: the clock (tests cross midnight with it). */
export function writeCapOf(env: WriteCapEnv, opts: { now?: () => number } = {}): WriteCap | undefined {
  const maxBytes = positive(env.WRITE_CAP_BYTES_PER_DAY), maxOps = positive(env.WRITE_CAP_OPS_PER_DAY);
  if (!maxBytes && !maxOps) return undefined;
  return {
    async reserve(bytes, ops = 1) {
      const now = (opts.now ?? Date.now)();
      const room = env.PROJECT_ROOM.get(env.PROJECT_ROOM.idFromName(`write-cap/${dayOf(now)}`));
      const r = await room.fetch(new Request(`https://room${WRITE_CAP_PATH}`, { method: "POST", body: JSON.stringify({ bytes, ops, maxBytes, maxOps }) }));
      if (!r.ok) throw new Error(`write cap: the counter answered ${r.status}`);
      const a = (await r.json()) as WriteCapAnswer;
      if (!a.ok)
        throw new WriteCapError(
          `This host's daily write limit is reached (${a.bytes} bytes, ${a.ops} writes stored today). It resets at 00:00 UTC.`,
          secondsToMidnight(now),
          nextMidnight(now),
        );
    },
  };
}

/**
 * The counter's side, run inside the `write-cap/<day>` room: adds the reservation if it fits under both caps. One row
 * read and one written per call.
 */
export function reserveIn(sql: { exec(q: string, ...b: unknown[]): { toArray(): Record<string, unknown>[] } }, req: { bytes: number; ops: number; maxBytes: number; maxOps: number }): WriteCapAnswer {
  sql.exec("CREATE TABLE IF NOT EXISTS carton_write_cap (k TEXT PRIMARY KEY, bytes INTEGER NOT NULL, ops INTEGER NOT NULL) WITHOUT ROWID");
  const row = sql.exec("SELECT bytes, ops FROM carton_write_cap WHERE k = 'day'").toArray()[0];
  const bytes = Number(row?.bytes ?? 0), ops = Number(row?.ops ?? 0);
  const addBytes = Math.max(0, Math.floor(Number(req.bytes) || 0)), addOps = Math.max(0, Math.floor(Number(req.ops) || 0));
  if ((req.maxBytes > 0 && bytes + addBytes > req.maxBytes) || (req.maxOps > 0 && ops + addOps > req.maxOps)) return { ok: false, bytes, ops };
  sql.exec("INSERT OR REPLACE INTO carton_write_cap (k, bytes, ops) VALUES ('day', ?, ?)", bytes + addBytes, ops + addOps);
  return { ok: true, bytes: bytes + addBytes, ops: ops + addOps };
}

/**
 * `cap` with `bytes` and `ops` reserved in one call up front, for a request that knows what it will write (a stream
 * append: a manifest, the bytes and an entry per part): its writes draw on the reservation, one counter request in all
 * instead of one per write. A write past what is left reserves on its own, as without it.
 */
export async function prepaidCap(cap: WriteCap, bytes: number, ops: number): Promise<WriteCap> {
  await cap.reserve(bytes, ops);
  let leftBytes = bytes, leftOps = ops;
  return {
    async reserve(b, o = 1) {
      if (b <= leftBytes && o <= leftOps) {
        leftBytes -= b;
        leftOps -= o;
        return;
      }
      await cap.reserve(b, o);
    },
  };
}

/** A multipart handle that may also take a streamed part (fix/cf-stream-parts adds it to the contract). */
type Streams = MultipartUpload & { uploadPartStream?(n: number, body: ReadableStream<Uint8Array>, size: number): Promise<{ partNumber: number; etag: string }> };

/** `inner` with every write reserved against `cap` first; `inner` itself when there is no cap. */
export function cappedBlobStore(inner: BlobStore, cap: WriteCap | undefined): BlobStore {
  if (!cap) return inner;
  const wrap = (u: MultipartUpload): MultipartUpload => ({
    key: u.key,
    uploadId: u.uploadId,
    async uploadPart(n, data) {
      await cap.reserve(data.byteLength);
      return u.uploadPart(n, data);
    },
    // a streamed part (MultipartUpload.uploadPartStream, where the store has it) reserves its declared size first
    ...(typeof (u as Streams).uploadPartStream === "function"
      ? {
          async uploadPartStream(n: number, body: ReadableStream<Uint8Array>, size: number) {
            await cap.reserve(size);
            return (u as Streams).uploadPartStream!(n, body, size);
          },
        }
      : {}),
    listParts: () => u.listParts(),
    async complete(parts): Promise<BlobInfo> {
      await cap.reserve(0);
      return u.complete(parts);
    },
    abort: () => u.abort(),
  });
  // a Proxy, so whatever else the store offers (signedUrl, getStream, checkKey) passes through, bound to the store
  // itself (its methods may use private fields)
  return new Proxy(inner, {
    get(t, p) {
      if (p === "put")
        return async (key: string, data: Uint8Array, opts?: Parameters<BlobStore["put"]>[2]) => {
          await cap.reserve(data.byteLength);
          return t.put(key, data, opts);
        };
      if (p === "createMultipart")
        return async (key: string, opts?: { contentType?: string }) => {
          await cap.reserve(0);
          return wrap(await t.createMultipart(key, opts));
        };
      if (p === "resumeMultipart") return async (key: string, id: string) => wrap(await t.resumeMultipart(key, id));
      const v = Reflect.get(t, p, t) as unknown;
      return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(t) : v;
    },
  });
}

/** The Worker's answer to a refused write. */
export function writeCapResponse(e: WriteCapError): Response {
  return new Response(JSON.stringify({ error: e.message, code: e.code }), {
    status: 429,
    headers: { "content-type": "application/json", "cache-control": "no-store", "retry-after": String(e.retryAfterSec) },
  });
}
