// A clip uploaded from a browser plays for teammates while it uploads (host-http's PIECES). The whole file goes up as
// m/<hash> through @carton/media's resumable multipart upload, and a multipart object is invisible until it completes.
// So, before it, the file goes up in pieces, each its own object: `lv/<hash>/info` ({size, pieceSize, pieces}), then
// `lv/<hash>/<n>`, whole 1 MiB leaves, so a teammate's player verifies every leaf against the manifest (mf/<hash>, up
// first) as it does for any media. A file whose index (an MP4's `moov`) sits at its end sends that piece first, so a
// player can start before the rest arrives. Once m/<hash> is complete the pieces are removed (POST blobs/pieces-done).
//
// The reading side is `withPieces`: a media store whose m/<hash> falls back to the pieces while the whole object isn't
// there, waiting for a piece that hasn't arrived yet. The Service Worker's MediaReader reads through it.
//
// The cost: the clip's bytes go up twice (pieces, then the whole file), so it takes twice as long to be fully up.
// Editing never waits for either; teammates can play it from the first piece.

import type { BlobInfo, BlobStore, ByteRange } from "@carton/core/plugins";
import { LEAF_SIZE } from "@carton/media";

export interface PiecesInfo {
  v: 1;
  size: number;
  pieceSize: number;
  pieces: number;
}

export const piecesInfoKey = (hash: string) => `lv/${hash}/info`;
export const pieceKey = (hash: string, n: number) => `lv/${hash}/${n}`;

/** Two leaves a piece for files up to 64 MiB (a player starts sooner), eight above (fewer objects to remove). */
export function pieceSizeFor(size: number): number {
  return (size <= 64 * LEAF_SIZE ? 2 : 8) * LEAF_SIZE;
}

/**
 * Where an MP4's `moov` box lies, from its top-level boxes (8- or 16-byte headers, read without the payloads); null for
 * a file that isn't an MP4 or has none. A WebM needs no such care (its index is optional to start playing).
 */
export async function moovSpan(file: Blob): Promise<[number, number] | null> {
  let at = 0;
  for (let i = 0; i < 64 && at + 8 <= file.size; i++) {
    const head = new DataView(await file.slice(at, at + 16).arrayBuffer());
    let size = head.getUint32(0);
    const type = String.fromCharCode(head.getUint8(4), head.getUint8(5), head.getUint8(6), head.getUint8(7));
    if (size === 1 && head.byteLength >= 16) size = Number(head.getBigUint64(8));
    else if (size === 0) size = file.size - at;
    if (size < 8) return null;
    if (type === "moov") return [at, Math.min(file.size, at + size)];
    at += size;
  }
  return null;
}

/** The order pieces go up: those holding the index first (when it is at the end), then the rest from the start. */
export function playbackOrder(pieces: number, pieceSize: number, index: [number, number] | null): number[] {
  const first = index ? Array.from({ length: Math.floor((index[1] - 1) / pieceSize) - Math.floor(index[0] / pieceSize) + 1 }, (_, i) => Math.floor(index[0] / pieceSize) + i) : [];
  // an index in the first piece is sent first anyway
  const lead = first.filter((n) => n > 0);
  return [...lead, ...Array.from({ length: pieces }, (_, n) => n).filter((n) => !lead.includes(n))];
}

const MEDIA = /^m\/([0-9a-f]{64})$/;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface WithPiecesOptions {
  /** How long a read waits for a piece that hasn't arrived (default 120 s). */
  waitMs?: number;
  /** How often it looks again (default 500 ms). */
  pollMs?: number;
}

/**
 * `store` with m/<hash> served from the clip's pieces while the whole object isn't there (a clip still uploading from
 * a browser). Everything else, and every clip already up, goes to `store` as it is.
 */
export function withPieces(store: BlobStore, o: WithPiecesOptions = {}): BlobStore {
  const waitMs = o.waitMs ?? 120_000, pollMs = o.pollMs ?? 500;
  // the whole object, once seen, is read from then on (pieces are removed after it lands)
  const whole = new Set<string>();
  const infos = new Map<string, PiecesInfo>();
  const info = async (hash: string): Promise<PiecesInfo | null> => {
    const known = infos.get(hash);
    if (known) return known;
    const bytes = await store.get(piecesInfoKey(hash));
    if (!bytes) return null;
    try {
      const i = JSON.parse(new TextDecoder().decode(bytes)) as PiecesInfo;
      if (i?.v !== 1 || !Number.isSafeInteger(i.size) || !Number.isSafeInteger(i.pieceSize) || i.pieceSize % LEAF_SIZE || i.pieces !== Math.ceil(i.size / i.pieceSize)) return null;
      infos.set(hash, i);
      return i;
    } catch {
      return null;
    }
  };
  // a piece, waiting for it to arrive; if the whole object lands meanwhile, null (the caller reads that instead)
  const piece = async (hash: string, n: number): Promise<Uint8Array | null> => {
    const end = Date.now() + waitMs;
    for (;;) {
      const b = await store.get(pieceKey(hash, n));
      if (b) return b;
      if (await store.head(`m/${hash}`)) return (whole.add(hash), null);
      if (Date.now() > end) throw new Error("this clip is still uploading: try again in a moment");
      await sleep(pollMs);
    }
  };
  const fromPieces = async (hash: string, i: PiecesInfo, range?: ByteRange): Promise<Uint8Array | null> => {
    const from = range?.offset ?? 0;
    const to = Math.min(i.size, range?.length === undefined ? i.size : from + range.length);
    if (from >= to) return new Uint8Array(0);
    const out = new Uint8Array(to - from);
    for (let n = Math.floor(from / i.pieceSize); n * i.pieceSize < to; n++) {
      const b = await piece(hash, n);
      if (!b) return store.get(`m/${hash}`, range);
      const start = n * i.pieceSize;
      const a = Math.max(from, start), z = Math.min(to, start + b.length);
      if (z <= a) throw new Error("a piece of this clip is shorter than it should be");
      out.set(b.subarray(a - start, z - start), a - from);
    }
    return out;
  };
  const wrapped: BlobStore = {
    ...store,
    kind: store.kind,
    put: (k, d, op) => store.put(k, d, op),
    delete: (k) => store.delete(k),
    list: (p, op) => store.list(p, op),
    createMultipart: (k, op) => store.createMultipart(k, op),
    resumeMultipart: (k, id) => store.resumeMultipart(k, id),
    async head(key): Promise<BlobInfo | null> {
      const h = await store.head(key);
      const m = MEDIA.exec(key);
      if (h || !m) return (m && h && whole.add(m[1]!), h);
      const i = await info(m[1]!);
      return i ? { key, size: i.size } : null;
    },
    async get(key, range) {
      const m = MEDIA.exec(key);
      if (!m || whole.has(m[1]!)) return store.get(key, range);
      const b = await store.get(key, range);
      if (b) return (whole.add(m[1]!), b);
      const i = await info(m[1]!);
      return i ? fromPieces(m[1]!, i, range) : null;
    },
  };
  // the reader streams through get for media (its pieces are assembled there); other keys keep the store's stream
  if (store.getStream) {
    const gs = store.getStream.bind(store);
    wrapped.getStream = async (key, range) => {
      if (!MEDIA.exec(key)) return gs(key, range);
      const b = await wrapped.get(key, range);
      return b ? new Blob([b as BlobPart]).stream() : null;
    };
  }
  return wrapped;
}
