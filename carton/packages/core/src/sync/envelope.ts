// The oversized-message envelope. A transport frame has a cap (a WebSocket host's per-message limit; 32 MiB in the
// in-process host), and a hand-off upload, a catch-up page, a keyframe or one change with a long text can pass it.
// Any message whose JSON is over the threshold (1 MiB) travels as a reference instead: the sender uploads the JSON
// through the BlobStore plug-in and sends `{ type: "blob", ref: { key, size, sha256 } }`; the receiver fetches it,
// checks its size and digest, and handles the message inside as if it had come inline. It lives here and in the
// sequencer core, never in a host: a host carries envelopes like any other message.
//
// Order is kept on both sides. `Outbox`: a message after one being uploaded waits for it. `Inbox`: a message after an
// envelope being fetched waits for it. Nearly every message is small: those go straight through, synchronously, after
// one cheap size bound (`jsonBytesBound`), with no JSON.stringify of their own.
//
// Keys: `messages/c/<hour>/<sha256>-<nonce>` for a client's upload (read once by the server, which deletes it), and
// `messages/s/<hour>/<sha256>` for the server's (content-addressed: one upload serves a whole fan-out). The sequencer's
// `maintain()` sweeps old hours. Owner: sync-sequencer.

import type { BlobStore } from "../plugins.ts";

// SHA-256 of the bytes as they are, with the platform's WebCrypto (Workers, browsers, Node): the digest is computed
// natively, with no copy of the payload, which a message near a Durable Object's 128 MB budget can't afford (the
// portable hash first re-encodes the text and pads a copy). Same digest as sha256Hex of the text it encodes.
async function digestHex(bytes: Uint8Array): Promise<string> {
  const d = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes as Uint8Array<ArrayBuffer>));
  let s = "";
  for (let i = 0; i < d.length; i++) s += d[i]!.toString(16).padStart(2, "0");
  return s;
}

/** Messages whose JSON is over this many bytes travel as an envelope (1 MiB, the inline limit of a change body). */
export const ENVELOPE_BYTES = 1 << 20;
/** How long an envelope's blob is kept, in hour buckets: the sweep deletes buckets older than this many hours. */
export const ENVELOPE_KEEP_HOURS = 2;
/** Client uploads may come from a skewed clock: their buckets are kept a day. */
export const ENVELOPE_CLIENT_KEEP_HOURS = 24;
const HOUR = 3_600_000;

export interface BlobRef {
  key: string;
  /** Bytes of the message's UTF-8 JSON. */
  size: number;
  /** SHA-256 (hex) of those bytes. */
  sha256: string;
}
export interface EnvelopeMsg {
  type: "blob";
  ref: BlobRef;
}

const enc = new TextEncoder();
const dec = new TextDecoder();

/**
 * An upper bound on the UTF-8 size of `JSON.stringify(v)`, stopping once past `cap`. Each UTF-16 unit of a string is
 * at most 6 bytes (`\u001f`), a number at most 24 characters. Walks the value once without building any string: far
 * cheaper than serializing, and the exact size is computed only for the rare message the bound can't clear.
 */
export function jsonBytesBound(v: unknown, cap: number): number {
  let n = 0;
  const walk = (x: unknown, inArray: boolean): void => {
    switch (typeof x) {
      case "string":
        n += x.length * 6 + 2;
        return;
      case "number":
        n += 24;
        return;
      case "boolean":
        n += 5;
        return;
      case "object": {
        if (x === null) {
          n += 4;
          return;
        }
        if (Array.isArray(x)) {
          n += 2 + x.length;
          if (n > cap) return;
          for (const y of x) {
            walk(y, true);
            if (n > cap) return;
          }
          return;
        }
        n += 2;
        const o = x as Record<string, unknown>;
        for (const k in o) {
          const y = o[k];
          if (y === undefined || typeof y === "function" || typeof y === "symbol") continue;
          n += k.length * 6 + 4;
          walk(y, false);
          if (n > cap) return;
        }
        return;
      }
      default:
        if (inArray) n += 4; // undefined in an array is `null`
    }
  };
  walk(v, false);
  return n;
}

/** The message's JSON and its bytes when it is over `threshold` bytes; null when it can go inline. */
export function oversized(msg: unknown, threshold: number): { text: string; bytes: Uint8Array } | null {
  if (jsonBytesBound(msg, threshold) <= threshold) return null;
  const text = JSON.stringify(msg);
  if (text.length * 3 <= threshold) return null;
  const bytes = enc.encode(text);
  return bytes.byteLength > threshold ? { text, bytes } : null;
}

const hourOf = (now: number) => Math.floor(now / HOUR);
/** A client upload's key: unique per upload, so the server's delete after reading never removes another's. */
export function clientEnvelopeKey(sha256: string, now: number): string {
  let nonce = "";
  for (let i = 0; i < 4; i++) nonce += Math.floor(Math.random() * 0x1_0000_0000).toString(16).padStart(8, "0");
  return `messages/c/${hourOf(now)}/${sha256}-${nonce}`;
}
/** A server upload's key: the same message to every subscriber is one blob. */
export function serverEnvelopeKey(sha256: string, now: number): string {
  return `messages/s/${hourOf(now)}/${sha256}`;
}
const CLIENT_KEY = /^messages\/c\/\d{1,12}\/([0-9a-f]{64})-[0-9a-f]{8,64}$/;
const SERVER_KEY = /^messages\/s\/\d{1,12}\/([0-9a-f]{64})$/;
/** Is this a key the other side may have written, naming its own digest? */
export function envelopeKeyOk(ref: BlobRef, from: "client" | "server"): boolean {
  const m = (from === "client" ? CLIENT_KEY : SERVER_KEY).exec(typeof ref?.key === "string" ? ref.key : "");
  return !!m && m[1] === ref.sha256;
}
/** Is this envelope blob (key from `list`) older than its bucket's keep? */
export function envelopeExpired(key: string, now: number): boolean {
  const m = /^messages\/([cs])\/(\d{1,12})\//.exec(key);
  if (!m) return false;
  return Number(m[2]) < hourOf(now) - (m[1] === "c" ? ENVELOPE_CLIENT_KEEP_HOURS : ENVELOPE_KEEP_HOURS);
}

/** Upload an oversized message's JSON and return the envelope that stands for it. */
export async function seal(big: { text: string; bytes: Uint8Array }, blobs: BlobStore, keyOf: (sha256: string) => string): Promise<EnvelopeMsg> {
  const sha256 = await digestHex(big.bytes);
  const key = keyOf(sha256);
  await blobs.put(key, big.bytes, { contentType: "application/json", sha256, ifAbsent: true });
  return { type: "blob", ref: { key, size: big.bytes.byteLength, sha256 } };
}

export class EnvelopeError extends Error {}

/**
 * Fetch an envelope's message and check it: a key of the sender's kind naming the digest, a size within `maxBytes`,
 * exactly that many bytes, the same SHA-256, and a message that isn't itself an envelope.
 */
export async function unseal(ref: BlobRef, blobs: BlobStore, opts: { from: "client" | "server"; maxBytes: number }): Promise<unknown> {
  if (!envelopeKeyOk(ref, opts.from)) throw new EnvelopeError("a key that isn't an envelope's");
  if (!Number.isSafeInteger(ref.size) || ref.size < 0 || ref.size > opts.maxBytes) throw new EnvelopeError(`${ref.size} bytes (the limit is ${opts.maxBytes})`);
  const bytes = await blobs.get(ref.key);
  if (!bytes) throw new EnvelopeError("its blob is missing");
  if (bytes.byteLength !== ref.size) throw new EnvelopeError(`${bytes.byteLength} bytes, not ${ref.size}`);
  if ((await digestHex(bytes)) !== ref.sha256) throw new EnvelopeError("its digest doesn't match");
  const text = dec.decode(bytes);
  const msg = JSON.parse(text) as { type?: unknown };
  if (msg?.type === "blob") throw new EnvelopeError("an envelope inside an envelope");
  return msg;
}

/**
 * One connection's outgoing side: messages leave in the order they were pushed. A message given with `sealed` (its
 * envelope, being uploaded) leaves as that envelope once the upload is done, or inline if it failed (the transport may
 * then refuse it and close the connection: the sides recover as from any lost connection); the messages pushed after
 * it wait for it. With nothing waiting, a message goes out synchronously.
 */
export class Outbox<M> {
  private tail: Promise<void> = Promise.resolve();
  private waiting = 0;
  private readonly deliver: (m: M | EnvelopeMsg) => void;
  constructor(deliver: (m: M | EnvelopeMsg) => void) {
    this.deliver = deliver;
  }
  push(m: M, sealed?: Promise<EnvelopeMsg>): void {
    if (!sealed && this.waiting === 0) return this.deliver(m);
    this.waiting++;
    // the upload starts now (in parallel with earlier ones); delivery waits its turn. Never rejects.
    const out: Promise<M | EnvelopeMsg> = sealed ? sealed.then((e) => e, () => m) : Promise.resolve(m);
    this.tail = this.tail
      .then(() => out)
      .then((x) => {
        try {
          this.deliver(x);
        } catch {
          // a closed connection: what was in flight is resent after reconnecting
        }
      })
      .finally(() => void this.waiting--);
  }
  /** Messages pushed and not yet delivered. */
  get pending(): number {
    return this.waiting;
  }
  /** Resolves once every message pushed so far has been delivered. */
  flushed(): Promise<void> {
    return this.tail;
  }
}

/**
 * One connection's incoming side: messages are handled in arrival order; an envelope is fetched and checked before its
 * message (and every one after it) is handled. A failed fetch or check stops the inbox for good (`fail` is called
 * once): the receiver drops the connection and catches up on a new one.
 */
export class Inbox<M> {
  private tail: Promise<void> = Promise.resolve();
  private waiting = 0;
  private dead = false;
  private readonly o: { deliver: (m: M) => void; open: (ref: BlobRef) => Promise<unknown>; fail: (e: unknown) => void };
  constructor(o: { deliver: (m: M) => void; open: (ref: BlobRef) => Promise<unknown>; fail: (e: unknown) => void }) {
    this.o = o;
  }
  receive(m: M | EnvelopeMsg): void {
    if (this.dead) return;
    const env = (m as { type?: unknown })?.type === "blob" ? (m as EnvelopeMsg) : null;
    if (!env && this.waiting === 0) return this.o.deliver(m as M);
    this.waiting++;
    const got: Promise<unknown> = env ? this.o.open(env.ref) : Promise.resolve(m);
    got.catch(() => {}); // handled in turn below
    const failed = (e: unknown) => {
      if (this.dead) return;
      this.dead = true;
      this.o.fail(e);
    };
    // never rejects: a throw while handling a message fails the inbox like a bad envelope would
    this.tail = this.tail
      .then(() => got)
      .then((x) => {
        if (!this.dead) this.o.deliver(x as M);
      })
      .catch(failed)
      .finally(() => void this.waiting--);
  }
  get pending(): number {
    return this.waiting;
  }
}
