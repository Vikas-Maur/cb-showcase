// The stream routes' bodies (cf-proxy-path), shared by the host (streams.ts) and its client (client.ts): a JSON header,
// then raw bytes.
//
//   u32 big-endian length of the header | the header, UTF-8 JSON | …
//
// - POST /streams/<id>/append: the header lists the parts in order (each with its encoded manifest, base64, and whether
//   its bytes follow) and maybe the end entry; then the bytes of the parts that have them, back to back.
// - GET /streams/<id>/read: the header lists the entries found (each with its manifest when the host has it) and the
//   end entry if the host looked; then, for each part the header marks `bytes: true`, in order: u32 length | the bytes.
//   A length of 0 means the host couldn't send that part (gone, or not the size its entry says): the client reads it
//   the usual way, which repairs and reports.

export const STREAM_WIRE_VERSION = 1;
/** The largest read header a client accepts (a host keeps its answers under it). */
export const MAX_STREAM_HEADER = 1 << 20;
/**
 * The largest append header a host accepts: the end entry rides in it, and a long stream's end lists every part (hash,
 * size and duration, about 90 bytes a segment: 8 MiB is about 90,000 segments, 50 hours of 2 s segments).
 */
export const MAX_APPEND_HEADER = 8 << 20;

export interface AppendHeaderPart {
  kind: "init" | "segment";
  hash: string;
  size: number;
  /** The encoded manifest, base64. */
  manifest: string;
  /** Its bytes follow; false: the client found them stored (the host checks). */
  bytes: boolean;
  /**
   * Sent again with its bytes after the host answered that the stored copy was missing or reported damaged: the host
   * answers the open damage report (repaired/<hash>) once the bytes are in, as an upload's repair does.
   */
  repair?: boolean;
  index?: number;
  durationSec?: number;
  at?: number;
}
export interface AppendHeader {
  v: number;
  parts: AppendHeaderPart[];
  end?: unknown;
  /** The publisher's lease renewal, written beside the entries (`ps/<id>/lease`): {n, at, every}. */
  lease?: unknown;
}

export interface ReadHeaderPart {
  hash: string;
  size: number;
  manifest?: string;
  bytes: boolean;
}
export interface ReadHeaderSegment extends ReadHeaderPart {
  index: number;
  durationSec: number;
  at: number;
}
export interface ReadHeader {
  v: number;
  /** Absent: not asked for. null: asked for and not up (the stream is only claimed). */
  init?: ReadHeaderPart | null;
  segments: ReadHeaderSegment[];
  /** Absent: the host didn't look. null: it looked and the stream hasn't ended. */
  end?: unknown;
}

const utf8 = new TextEncoder();
const fromUtf8 = new TextDecoder();

export function u32(n: number): Uint8Array {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, n);
  return b;
}

/** The header as the body's first frame. */
export function headerFrame(header: unknown): Uint8Array {
  const json = utf8.encode(JSON.stringify(header));
  const out = new Uint8Array(4 + json.length);
  out.set(u32(json.length), 0);
  out.set(json, 4);
  return out;
}

export class StreamWireError extends Error {
  override name = "StreamWireError";
}

/** A whole body's header and what follows it. */
export function splitFrame(body: Uint8Array, maxHeader = MAX_STREAM_HEADER): { header: unknown; rest: Uint8Array } {
  if (body.length < 4) throw new StreamWireError("body too short for its header");
  const n = new DataView(body.buffer, body.byteOffset, 4).getUint32(0);
  if (n > maxHeader || 4 + n > body.length) throw new StreamWireError("bad header length");
  let header: unknown;
  try {
    header = JSON.parse(fromUtf8.decode(body.subarray(4, 4 + n)));
  } catch {
    throw new StreamWireError("the header is not JSON");
  }
  return { header, rest: body.subarray(4 + n) };
}

/** Reads a response body in exact pieces. */
export class ByteReader {
  readonly #r: ReadableStreamDefaultReader<Uint8Array>;
  #buf: Uint8Array[] = [];
  #have = 0;

  constructor(body: ReadableStream<Uint8Array>) {
    this.#r = body.getReader();
  }

  async exactly(n: number): Promise<Uint8Array> {
    while (this.#have < n) {
      const { done, value } = await this.#r.read();
      if (done) throw new StreamWireError(`the body ended ${n - this.#have} bytes short`);
      if (value.byteLength) {
        this.#buf.push(value);
        this.#have += value.byteLength;
      }
    }
    const out = new Uint8Array(n);
    let at = 0;
    while (at < n) {
      const c = this.#buf[0]!;
      const take = Math.min(c.byteLength, n - at);
      out.set(c.subarray(0, take), at);
      at += take;
      if (take === c.byteLength) this.#buf.shift();
      else this.#buf[0] = c.subarray(take);
    }
    this.#have -= n;
    return out;
  }

  async u32(): Promise<number> {
    const b = await this.exactly(4);
    return new DataView(b.buffer, b.byteOffset, 4).getUint32(0);
  }

  async header(): Promise<unknown> {
    const n = await this.u32();
    if (n > MAX_STREAM_HEADER) throw new StreamWireError("bad header length");
    try {
      return JSON.parse(fromUtf8.decode(await this.exactly(n)));
    } catch (e) {
      if (e instanceof StreamWireError) throw e;
      throw new StreamWireError("the header is not JSON");
    }
  }

  cancel(): void {
    this.#r.cancel().catch(() => {});
  }
}
