// `@carton/core/plugins`: every outside dependency behind a small interface (PLAN §3.1). Core never imports a
// backend; each implementation is its own package and is accepted when it passes its suite in `@carton/conformance`.
// The "Invariants" listed on each interface are exactly what those suites check.
//
// Wiring is configuration:
//   Carton.open({ adapter, store, hasher, actor, sync: { transport, url, auth }, media: { blobStore, encoders } })
//   createSequencer({ storage, blobs, auth })   (inside any SequencerHost, from @carton/server)

import type { Actor, Doc } from "./types.ts";
import type { Schema } from "./schema.ts";
import type { ClientMessage, ServerMessage } from "./sync/messages.ts";

// ------------------------------------------------------------------ Hasher

/**
 * SHA-256. Ships as node:crypto and WebCrypto.
 *
 * Invariants:
 * - Output is standard SHA-256 (FIPS 180-4): byte-identical on every platform (P6: browser and Node ids match).
 * - `sha256HexSync`, when present, equals the lowercase hex of `sha256` over the UTF-8 bytes of its input. Core uses
 *   it for state hashes; when absent, core's portable implementation gives the same output, only slower.
 * - Never mutates its input.
 */
export interface Hasher {
  readonly name: string;
  sha256(data: Uint8Array): Promise<Uint8Array>;
  sha256HexSync?(text: string): string;
}

// ------------------------------------------------------------------ Store (client-side history storage)

/** A key: compared element by element; numbers sort before strings, a shorter prefix before its extensions. */
export type StoreKey = readonly (string | number)[];

export interface StoreRange {
  /** Keys starting with these elements. */
  prefix?: StoreKey;
  /** Bounds, applied within the prefix (compared on the full key). */
  gt?: StoreKey;
  gte?: StoreKey;
  lt?: StoreKey;
  lte?: StoreKey;
  reverse?: boolean;
  limit?: number;
}

/** Put `value` at `key`; `value: undefined` deletes the key. */
export interface StoreWrite {
  table: string;
  key: StoreKey;
  value: unknown;
}

/** A precondition for a write batch: the key is absent, present, or holds exactly `equals` (canonical JSON). */
export interface StoreCondition {
  table: string;
  key: StoreKey;
  expect: "absent" | "present" | { equals: unknown };
}

export interface StoreInfo {
  /** `memory`, `sqlite`, `idb`. */
  readonly kind: string;
  readonly persistent: boolean;
  /** Several processes may open the same store at once (SQLite in WAL): writers must rely on conditions, not caches. */
  readonly multiProcess: boolean;
}

/**
 * Client-side history storage: a few tables of JSON values under ordered keys, with atomic conditional batches.
 * Ships as `store-sqlite` (`.carton/carton.db`), `store-idb`, `store-memory`. Tables and their keys are chosen by core's
 * history (`STORE_TABLES` in `@carton/core`); a store treats them as opaque.
 *
 * Invariants:
 * - `write` is atomic: if any condition fails nothing is written and it resolves `false`; otherwise every write is
 *   applied and durable (for persistent stores) before it resolves `true`. Conditions are checked and writes applied in
 *   one transaction, so two writers (even in two processes) can't both pass the same `absent` condition. This is the
 *   cross-process CAS the local sequencer relies on (P3: four processes CAS-appending, none lost).
 * - Within one batch, writes apply in order (a later write to the same key wins).
 * - `range` returns entries in key order (reverse when asked), honours `limit`, and sees every write that resolved
 *   before it was called, including other processes' when `multiProcess`.
 * - Values round-trip as JSON (numbers, strings, booleans, null, arrays, plain objects); `undefined` object members
 *   may be dropped. `Infinity` and `NaN` are not allowed.
 * - Values are immutable once written: callers never mutate a value they wrote or read, so a store may keep or return
 *   references (memory) or copies (sqlite, idb).
 * - Key order: element-wise; number < string; numbers numerically; strings by UTF-16 code units (as JS `<`).
 */
export interface Store {
  readonly info: StoreInfo;
  get<T = unknown>(table: string, key: StoreKey): Promise<T | undefined>;
  range<T = unknown>(table: string, range?: StoreRange): Promise<{ key: StoreKey; value: T }[]>;
  write(writes: readonly StoreWrite[], conditions?: readonly StoreCondition[]): Promise<boolean>;
  /** In-process notification after a successful write (optional; carton.db across processes has none). */
  watch?(listener: (tables: readonly string[]) => void): () => void;
  close(): Promise<void>;
}

// ------------------------------------------------------------------ SequencerHost + SequencerStorage (server side)

export type SqlValue = null | number | bigint | string | Uint8Array;

/**
 * SQL-like storage for the sequencer core: the Durable Object's `ctx.storage.sql`, or node:sqlite. Synchronous,
 * because both are and because the sequencer's check-then-append must not interleave with another push.
 *
 * Invariants:
 * - `exec` runs one statement with `?` bindings and returns every result row as an object keyed by column name.
 * - `transaction(fn)` runs `fn` atomically: a throw rolls back every statement it ran; nothing else runs in between.
 * - `WITHOUT ROWID` tables and primary-key range reads are supported (the §6.3 DDL has no secondary index).
 * - Rows written by a committed transaction survive a restart (hibernation, process restart).
 */
export interface SequencerStorage {
  exec<R extends Record<string, SqlValue> = Record<string, SqlValue>>(sql: string, ...params: SqlValue[]): R[];
  transaction<T>(fn: () => T): T;
  /** Rows read and written so far (P5 cost accounting); optional. */
  stats?(): { rowsRead: number; rowsWritten: number };
}

/** One client connection as the sequencer core sees it. The host owns the socket. */
export interface SequencerConnection {
  readonly id: string;
  /** Who connected, from `AuthProvider.verify`. Replica ids are bound to `auth.credential` (§6.3). */
  readonly auth: AuthContext;
  send(msg: ServerMessage): void;
}

/**
 * A place that runs the pure sequencer core (`createSequencer` from `@carton/server`) for shared cuts: its storage,
 * hibernation and fan-out. Ships as `server-cloudflare` (Durable Object) and `server-node` (node:sqlite). Hosts stay
 * thin: no ordering, validation or overlap logic lives in a host.
 *
 * Invariants:
 * - One sequencer instance per project at a time, and messages of one project are handled one at a time, in arrival
 *   order per connection (a DO's input gate; one Node event loop per project).
 * - A message is handed to the sequencer only after `AuthProvider.verify` accepted the connection's token.
 * - Fan-out reaches every connection subscribed to the branch; subscriptions survive hibernation.
 * - Restart-safe: a host that restarts between two pushes gives the same answers (all state is in its storage).
 */
export interface SequencerHost {
  readonly kind: string;
  /** Where clients connect: `ws://`, `wss://` or `inproc://`. */
  readonly url: string;
  close(): Promise<void>;
}

// ------------------------------------------------------------------ Transport

/**
 * Client ↔ host messages: changes, acks, presence. Ships as WebSocket and in-process.
 *
 * Invariants:
 * - Messages arrive whole, in send order, at most once per connection (no reordering, no duplication).
 * - After `close` (either side) or a dropped link, `onClose` fires exactly once and no message is delivered after it;
 *   `send` on a closed connection is a silent no-op. Reconnection is the sync client's job, not the transport's.
 * - Messages are JSON-serializable; a transport may serialize (WebSocket) or pass structured clones (in-process), and
 *   the receiver never sees the sender's objects.
 */
export interface Transport {
  connect(url: string, opts: { token: string; signal?: AbortSignal }): Promise<TransportConnection>;
}

export interface TransportConnection {
  readonly open: boolean;
  send(msg: ClientMessage): void;
  onMessage(listener: (msg: ServerMessage) => void): void;
  onClose(listener: (why: string) => void): void;
  close(): void;
}

// ------------------------------------------------------------------ BlobStore

export interface BlobInfo {
  key: string;
  size: number;
  etag?: string;
  sha256?: string;
  contentType?: string;
}

export interface ByteRange {
  offset: number;
  /** Bytes to read; to the end when absent. */
  length?: number;
}

export interface MultipartUpload {
  readonly key: string;
  readonly uploadId: string;
  uploadPart(partNumber: number, data: Uint8Array): Promise<{ partNumber: number; etag: string }>;
  /** Parts already stored (resume after a cut link). */
  listParts(): Promise<{ partNumber: number; etag: string; size: number }[]>;
  complete(parts: { partNumber: number; etag: string }[]): Promise<BlobInfo>;
  abort(): Promise<void>;
}

/**
 * Media objects, keyframes and archived change segments. Ships as `blob-r2` (inside server-cloudflare), `blob-s3`,
 * `blob-fs`, `blob-memory`.
 *
 * Invariants:
 * - Keys are opaque strings (content hashes or `segments/<branch>/<n>`), at most 1024 bytes, `/` allowed.
 * - `put` of an existing key with `ifAbsent` leaves the stored bytes untouched and resolves its info; a plain `put`
 *   replaces atomically (a reader sees the old or the new bytes, never a mix).
 * - `get` with a range returns exactly the bytes `[offset, offset + length)`, clipped at the end; `null` when the key
 *   is absent. A range past the end returns an empty array.
 * - Multipart: parts are numbered 1..10,000; all parts but the last have the same size (R2 requires it; S3 needs
 *   ≥ 5 MiB); `complete` concatenates in part-number order; an upload can be resumed by id after a restart.
 * - `delete` of an absent key is a no-op.
 */
export interface BlobStore {
  readonly kind: string;
  put(key: string, data: Uint8Array, opts?: { contentType?: string; sha256?: string; ifAbsent?: boolean }): Promise<BlobInfo>;
  get(key: string, range?: ByteRange): Promise<Uint8Array | null>;
  /** Streaming read for large media (optional). */
  getStream?(key: string, range?: ByteRange): Promise<ReadableStream<Uint8Array> | null>;
  head(key: string): Promise<BlobInfo | null>;
  delete(key: string): Promise<void>;
  list(prefix: string, opts?: { cursor?: string; limit?: number }): Promise<{ blobs: BlobInfo[]; cursor?: string }>;
  createMultipart(key: string, opts?: { contentType?: string }): Promise<MultipartUpload>;
  resumeMultipart(key: string, uploadId: string): Promise<MultipartUpload>;
  /** A short-lived URL for direct transfer (optional; §14 short-lived media URLs). */
  signedUrl?(key: string, opts: { method: "GET" | "PUT"; expiresIn: number }): Promise<string>;
}

// ------------------------------------------------------------------ AuthProvider

export type Role = "owner" | "editor" | "commenter" | "viewer";

/** A verified connection: account, device credential and scope. */
export interface AuthContext {
  account: string;
  /** Account plus per-install device key: what replica ids are bound to (§6.3). Survives reconnects. */
  credential: string;
  role: Role;
  projectId: string;
  /** Cuts this token may write, when scoped (remote agents, §14). */
  branches?: string[];
  /** ms epoch. */
  expires: number;
}

/**
 * Issues and checks tokens. Ships as demo HMAC invite tokens; Cardboard accounts later.
 *
 * Invariants:
 * - `verify` returns null for any token it didn't issue, a tampered token, or an expired one (no exceptions).
 * - A token verifies to the same `credential` every time, so a reconnect reclaims its replica ids.
 * - `verify` is constant-time in the token's secret part.
 * - Viewer and commenter roles can never push changes (the sequencer checks `role`).
 */
export interface AuthProvider {
  readonly kind: string;
  issue?(claims: Omit<AuthContext, "expires"> & { ttlMs: number }): Promise<string>;
  verify(token: string): Promise<AuthContext | null>;
}

// ------------------------------------------------------------------ ProxyEncoder

export interface ProxyProfile {
  /** e.g. 720 */
  height: number;
  /** Target video bitrate, bits/s (collab proxies: ≤ 4 Mb/s). */
  bitrate: number;
  codec: "h264";
  audio: "aac";
}

export type MediaInput = { path: string } | { blob: Blob };
export type MediaOutput = { path: string } | { sink: WritableStream<Uint8Array> };

/**
 * Makes collab proxies. Ships as Cardboard's own proxy (reused when ≤ 4 Mb/s), then NVENC → QSV → AMF → libx264
 * (VideoToolbox on Mac, WebCodecs on the web).
 *
 * Invariants:
 * - `probe` runs a 1-frame test encode and never throws: false when this encoder can't run here.
 * - `encode` produces a seekable MP4 (moov first) at the profile, honours `signal` (aborts and removes partial output),
 *   and reports progress in [0, 1], non-decreasing.
 */
export interface ProxyEncoder {
  readonly name: string;
  /** Runs on the GPU (stated, so the CPU cost of the fallback is known). */
  readonly hardware: boolean;
  probe(): Promise<boolean>;
  encode(input: MediaInput, output: MediaOutput, profile: ProxyProfile, opts?: { signal?: AbortSignal; onProgress?: (f: number) => void }): Promise<{ bytes: number; durationMs: number }>;
}

// ------------------------------------------------------------------ IdentitySource

/**
 * Who is acting: human, agent, subagent. Ships as Claude Code hooks (`CARDBOARD_ACTOR=director/<chat>/<turn>`, plus
 * `/sub-<type>-<id>` inside a subagent), `CARDBOARD_ACTOR`, and self-declared (L1).
 *
 * Invariants:
 * - Deterministic for the same environment; never invents a turn or agent id it wasn't given.
 * - A windowless local actor (a `cb` call without a turn id) gets the window's undo group (§8), never a remote one.
 */
export interface IdentitySource {
  readonly kind: string;
  current(env?: Readonly<Record<string, string | undefined>>): Actor | null;
}

// ------------------------------------------------------------------ HostAdapter

/** Did the committing author create element `id` of sequence `seqKey`? (M4 nesting keeps one author's run contiguous.) */
export type OwnFn = (seqKey: string, id: string) => boolean;

/**
 * The editor's document: schema, projection and files. Ships as `@carton/cardboard`.
 *
 * Invariants:
 * - `toHost(fromHost(h, base))` equals `h` on every versioned field (ephemeral fields aside), and `fromHost` keeps
 *   the sequence keys of `base` for elements whose relative order didn't change (LCS move recovery).
 * - `fromHost` is pure and deterministic: same input, same doc, byte for byte (`canonical`).
 * - `project(doc)` is idempotent (`project(project(d))` = `project(d)`) and a GUI save diffed through it touches
 *   only records the user changed (§4.3, B10).
 */
export interface HostAdapter<HostDoc = unknown> {
  readonly name: string;
  readonly schema: Schema;
  /** Sent in `hello`; a server refuses a newer client's unknown version. */
  readonly schemaVersion: number;
  fromHost(host: HostDoc, base: Doc | null, own?: OwnFn): Doc;
  toHost(doc: Doc): HostDoc;
  /** The host's lossy GUI projection P (`fm∘sv` for Cardboard), when it has one. */
  project?(doc: Doc): Doc;
  /** A GUI save as an engine doc: `diff(P(base), save)` restricted to P's fields, applied to `base`. */
  projectGuiSave?(base: Doc, save: HostDoc): Doc;
}
