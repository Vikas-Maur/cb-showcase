// A minimal RFC 6455 WebSocket server built only on node:*.
//
// Node 24 ships a WebSocket client (undici) but no server, and @carton/server-node may depend on
// nothing outside node:*. The sync protocol sends small JSON text frames (changes, acks, presence at
// up to ~20 Hz per user) to a few dozen sockets per project, so this aims at correctness, bounded
// memory and a cheap hot path rather than features:
//
// - No extensions. permessage-deflate offers are ignored, which RFC 6455 §9.1 allows; for frames
//   this small, compression would add a zlib context per socket and CPU per frame for little gain.
// - Outgoing messages are never fragmented. Incoming fragmented messages are reassembled.
// - The "minimal length encoding" rule (§5.2) binds senders; like most servers we accept a longer
//   encoding than needed instead of failing the connection over it.
//
// Usage from an http(s) server:
//   server.on("upgrade", async (req, socket, head) => {
//     // Node hands over the socket with no "error" listener: a client reset while auth awaits would
//     // otherwise be an uncaught ECONNRESET. acceptWebSocket and rejectUpgrade attach their own.
//     socket.on("error", () => {});
//     if (!(await authorized(req))) return rejectUpgrade(socket, 401);
//     const ws = acceptWebSocket(req, socket, head, { protocols: (p) => p.includes("carton.v1") ? "carton.v1" : null });
//     if (!ws) return;            // bad handshake: already answered with 400/426 and closed
//     ws.on("message", ...);      // attach listeners synchronously: frames that came with the upgrade arrive on the next tick
//   });
//
// "error" events are informational and only emitted when someone listens (a misbehaving client must
// not crash the host through an unhandled "error"); every connection ends with exactly one "close".

import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { STATUS_CODES } from "node:http";
import type { IncomingMessage } from "node:http";
import type { Socket } from "node:net";
import type { Duplex } from "node:stream";

export interface WsOptions {
  /** Largest message accepted, after reassembly (default 1 MiB). Larger → close 1009. */
  maxPayload?: number;
  /** Picks a subprotocol from the client's offer; return null for none. Only called when the client offered some. */
  protocols?: (offered: string[]) => string | null;
  /** Ping after this much inbound silence; terminate if another interval passes without anything back (default 30 s, 0 = off). */
  idleTimeoutMs?: number;
  /** Terminate a peer that leaves more than this many bytes unsent on our side (default 16 MiB). */
  maxBufferedBytes?: number;
  /** After sending a close frame, wait this long for the peer to finish the handshake before destroying the socket (default 5 s). */
  closeTimeoutMs?: number;
}

/** Why a connection failed: a protocol violation by the peer, a missing pong, or a slow consumer. */
export class WsError extends Error {
  /** The close code this failure maps to (1002, 1007, 1009, 1008 for a slow consumer, 1006 for a dead peer). */
  readonly closeCode: number;
  constructor(closeCode: number, message: string) {
    super(message);
    this.name = "WsError";
    this.closeCode = closeCode;
  }
}

type ServerWebSocketEvents = {
  /** A string for a text message, a Buffer for a binary one. */
  message: [data: string | Buffer];
  /** Code and reason from the peer's close frame (1005 if it carried none, 1006 if none arrived). */
  close: [code: number, reason: string, wasClean: boolean];
  error: [error: Error];
};

type ReadyState = 0 | 1 | 2 | 3;
const OPEN = 1;
const CLOSING = 2;
const CLOSED = 3;

const OP_CONTINUATION = 0x0;
const OP_TEXT = 0x1;
const OP_BINARY = 0x2;
const OP_CLOSE = 0x8;
const OP_PING = 0x9;
const OP_PONG = 0xa;

const ACCEPT_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
// 16 random bytes in base64: 22 characters and "==".
const KEY_PATTERN = /^[A-Za-z0-9+/]{22}==$/;

const EMPTY = Buffer.alloc(0);
// Up to this size an outgoing frame is copied into one buffer with its header (one pooled allocation,
// one write); larger payloads go out as header + payload in a single corked writev instead of a copy.
const COPY_LIMIT = 4096;
// fatal: invalid UTF-8 must fail the connection (1007). ignoreBOM: keep a leading U+FEFF, it is message content.
const utf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

function noop(): void {}

/** Close codes allowed on the wire (RFC 6455 §7.4 and the IANA registry). 1004-1006 and 1015 never are. */
function isValidCloseCode(code: number): boolean {
  return (code >= 1000 && code <= 1003) || (code >= 1007 && code <= 1014) || (code >= 3000 && code <= 4999);
}

function hasToken(header: string | undefined, token: string): boolean {
  if (header === undefined) return false;
  for (const part of header.split(",")) {
    if (part.trim().toLowerCase() === token) return true;
  }
  return false;
}

function unmask(data: Buffer, mask: Buffer): void {
  for (let i = 0; i < data.length; i++) data[i] ^= mask[i & 3];
}

/** Writes a FIN frame header for `length` payload bytes at the start of `frame`. Server frames are never masked. */
function writeHeader(frame: Buffer, opcode: number, length: number): void {
  frame[0] = 0x80 | opcode;
  if (length < 126) {
    frame[1] = length;
  } else if (length < 0x10000) {
    frame[1] = 126;
    frame.writeUInt16BE(length, 2);
  } else {
    frame[1] = 127;
    frame.writeUInt32BE(Math.floor(length / 0x100000000), 2);
    frame.writeUInt32BE(length >>> 0, 6);
  }
}

function headerLengthFor(length: number): number {
  return length < 126 ? 2 : length < 0x10000 ? 4 : 10;
}

/**
 * Answers an upgrade request with a minimal HTTP error and closes the socket. For use in an
 * "upgrade" handler before accepting, e.g. when authentication fails.
 */
export function rejectUpgrade(socket: Duplex, status: number, message?: string, headers?: Record<string, string>): void {
  // Node's http server drops its own "error" listener when it hands the socket to "upgrade"; a reset
  // while we answer must not become an uncaught error in the host.
  socket.on("error", noop);
  if (!socket.writable) {
    socket.destroy();
    return;
  }
  const text = STATUS_CODES[status] ?? "Error";
  const body = message ?? text;
  let head =
    `HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Type: text/plain; charset=utf-8\r\n` +
    `Content-Length: ${Buffer.byteLength(body)}\r\n`;
  if (headers) for (const name of Object.keys(headers)) head += `${name}: ${headers[name]}\r\n`;
  // Destroy once the response is flushed: ending alone would leave a half-open socket if the client never closes.
  socket.once("finish", () => socket.destroy());
  socket.end(head + "\r\n" + body);
}

function checkUpgrade(req: IncomingMessage): { status: number; message: string; headers?: Record<string, string> } | null {
  if (req.method !== "GET") return { status: 400, message: "WebSocket upgrade must be a GET request" };
  if (req.httpVersionMajor < 1 || (req.httpVersionMajor === 1 && req.httpVersionMinor < 1)) {
    return { status: 400, message: "WebSocket upgrade needs HTTP/1.1" };
  }
  if (!hasToken(req.headers.upgrade, "websocket")) return { status: 400, message: "Upgrade header must be websocket" };
  if (!hasToken(req.headers.connection, "upgrade")) return { status: 400, message: "Connection header must contain upgrade" };
  const version = req.headers["sec-websocket-version"];
  if (version === undefined) return { status: 400, message: "Missing Sec-WebSocket-Version" };
  if (version !== "13") {
    // RFC 6455 §4.2.2: tell the client which version we speak.
    return { status: 426, message: "Unsupported WebSocket version", headers: { "Sec-WebSocket-Version": "13" } };
  }
  const key = req.headers["sec-websocket-key"];
  if (key === undefined || !KEY_PATTERN.test(key)) return { status: 400, message: "Missing or invalid Sec-WebSocket-Key" };
  return null;
}

/**
 * Completes a WebSocket handshake on an http "upgrade" request. On a bad request it answers 400 or
 * 426, destroys the socket and returns null. The returned socket is already OPEN.
 */
export function acceptWebSocket(req: IncomingMessage, socket: Duplex, head: Buffer, opts: WsOptions = {}): ServerWebSocket | null {
  if (socket.destroyed) return null;
  const problem = checkUpgrade(req);
  if (problem !== null) {
    rejectUpgrade(socket, problem.status, problem.message, problem.headers);
    return null;
  }

  let protocol = "";
  const offeredHeader = req.headers["sec-websocket-protocol"];
  if (offeredHeader !== undefined && opts.protocols) {
    const offered = offeredHeader.split(",").map((p) => p.trim()).filter((p) => p.length > 0);
    // Only echo a protocol the client offered: anything else makes the client fail the connection.
    const picked = offered.length > 0 ? opts.protocols(offered) : null;
    if (picked != null && offered.includes(picked)) protocol = picked;
  }

  const key = req.headers["sec-websocket-key"] as string; // checked by checkUpgrade
  const accept = createHash("sha1").update(key + ACCEPT_GUID).digest("base64");
  let response = `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n`;
  if (protocol) response += `Sec-WebSocket-Protocol: ${protocol}\r\n`;
  socket.write(response + "\r\n");
  return new ServerWebSocket(socket, head, protocol, opts);
}

export class ServerWebSocket extends EventEmitter<ServerWebSocketEvents> {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;

  /** The negotiated subprotocol, "" if none. */
  readonly protocol: string;

  #socket: Duplex;
  #state: ReadyState = OPEN;
  #maxPayload: number;
  #maxBuffered: number;
  #closeTimeoutMs: number;

  // Incoming bytes not yet parsed: a queue of socket chunks, the read offset into the first one and
  // the total, so a frame inside one chunk is sliced out of it without copying.
  #chunks: Buffer[] = [];
  #offset = 0;
  #buffered = 0;
  // Frame being read: false while waiting for a header, true while waiting for its payload.
  #inPayload = false;
  #fin = false;
  #opcode = 0;
  #payloadLength = 0;
  #mask = Buffer.alloc(4);
  #scratch = Buffer.alloc(14); // a header that straddles chunks is gathered here
  // A payload that straddles chunks is copied here as it arrives, so the queue never holds more than
  // a header's worth of chunks: a payload trickled in tiny TCP reads costs its size, not a Buffer per read.
  #partial: Buffer | null = null;
  #partialBytes = 0;
  // Fragmented message being reassembled: its opcode (0 = none open), bytes so far and a buffer that
  // grows by doubling. Copying fragments in (rather than keeping a list of slices) keeps memory at the
  // message size even for a flood of 1-byte fragments.
  #fragOpcode = 0;
  #fragBytes = 0;
  #fragBuffer = EMPTY;
  // Set once nothing more may be parsed: after a close frame, a protocol error, the peer's FIN or termination.
  #discard = false;

  #closeSent = false;
  #closeReceived = false;
  #closeCode = 1006;
  #closeReason = "";
  #closeTimer: ReturnType<typeof setTimeout> | null = null;
  #idleTimer: ReturnType<typeof setTimeout> | null = null;
  #awaitingPong = false;

  /** @internal Use acceptWebSocket. */
  constructor(socket: Duplex, head: Buffer, protocol: string, opts: WsOptions = {}) {
    super();
    this.protocol = protocol;
    this.#socket = socket;
    this.#maxPayload = opts.maxPayload ?? 1024 * 1024;
    this.#maxBuffered = opts.maxBufferedBytes ?? 16 * 1024 * 1024;
    this.#closeTimeoutMs = opts.closeTimeoutMs ?? 5000;

    const tcp = socket as Partial<Socket>;
    // Small frames at 20 Hz should leave now, not wait for Nagle to batch them.
    tcp.setNoDelay?.(true);
    // The http server's request timeouts don't apply to a long-lived WebSocket; liveness is ours.
    tcp.setTimeout?.(0);

    // Bytes that arrived with the upgrade request are first in the queue, and parsed on the next tick
    // so the caller can attach listeners first. Not socket.unshift(head): if anything already made
    // the socket flowing, unshift emits "data" at once, before our listener exists, and the bytes are lost.
    if (head.length > 0) {
      this.#chunks.push(head);
      this.#buffered = head.length;
      process.nextTick(() => this.#parse());
    }
    socket.on("data", this.#onData);
    socket.on("end", this.#onEnd);
    socket.on("error", this.#onError);
    socket.on("close", this.#onClose);

    const idle = opts.idleTimeoutMs ?? 30_000;
    if (idle > 0) {
      // One timer per socket, refreshed by inbound data rather than re-created per frame.
      this.#idleTimer = setTimeout(this.#onIdle, idle);
      this.#idleTimer.unref();
    }
  }

  /** 0 CONNECTING, 1 OPEN, 2 CLOSING, 3 CLOSED, as in the browser WebSocket. */
  get readyState(): ReadyState {
    return this.#state;
  }

  /** Bytes queued on our side that the socket has not flushed yet. */
  get bufferedAmount(): number {
    return this.#socket.writableLength;
  }

  /** Sends a text (string) or binary message. Dropped silently unless OPEN, like a browser socket that is closing. */
  send(data: string | Uint8Array): void {
    if (this.#state !== OPEN || !this.#backlogOk()) return;
    if (typeof data === "string") this.#sendText(data);
    else this.#sendFrame(OP_BINARY, data);
  }

  ping(data: Uint8Array = EMPTY): void {
    if (data.length > 125) throw new RangeError("ping payload must be at most 125 bytes");
    if (this.#state !== OPEN || !this.#backlogOk()) return;
    this.#sendFrame(OP_PING, data);
  }

  /**
   * Starts the closing handshake: sends a close frame, waits for the peer's, then ends TCP. A peer
   * that doesn't answer within closeTimeoutMs is cut off.
   */
  close(code: number = 1000, reason: string = ""): void {
    if (!Number.isInteger(code) || !isValidCloseCode(code)) throw new RangeError(`invalid close code ${code}`);
    if (Buffer.byteLength(reason) > 123) throw new RangeError("close reason must be at most 123 bytes of UTF-8");
    if (this.#state !== OPEN) return;
    this.#writeClose(code, reason);
    this.#closeSent = true;
    this.#state = CLOSING;
    this.#armCloseTimer();
  }

  /** Destroys the connection at once, without a closing handshake. */
  terminate(): void {
    if (this.#state === CLOSED) return;
    this.#state = CLOSING;
    this.#stopParsing();
    this.#socket.destroy();
  }

  // ---- incoming ----

  #onData = (chunk: Buffer): void => {
    if (this.#idleTimer !== null) {
      this.#idleTimer.refresh();
      this.#awaitingPong = false;
    }
    if (this.#discard) return;
    this.#chunks.push(chunk);
    this.#buffered += chunk.length;
    this.#parse();
  };

  #parse(): void {
    while (!this.#discard) {
      if (!this.#inPayload) {
        if (!this.#readHeader()) return;
        this.#inPayload = true;
      }
      let payload: Buffer;
      if (this.#partial !== null) {
        const n = Math.min(this.#buffered, this.#payloadLength - this.#partialBytes);
        this.#moveInto(this.#partial, this.#partialBytes, n);
        this.#partialBytes += n;
        if (this.#partialBytes < this.#payloadLength) return;
        payload = this.#partial;
        this.#partial = null;
      } else if (this.#buffered >= this.#payloadLength) {
        payload = this.#take(this.#payloadLength);
      } else {
        // Only part of the payload is here. Its length is already within maxPayload.
        this.#partial = Buffer.allocUnsafe(this.#payloadLength);
        this.#partialBytes = this.#buffered;
        this.#moveInto(this.#partial, 0, this.#buffered);
        return;
      }
      unmask(payload, this.#mask);
      this.#inPayload = false;
      this.#handleFrame(payload);
    }
  }

  /** Reads and validates a frame header. False if more bytes are needed or the connection failed. */
  #readHeader(): boolean {
    if (this.#buffered < 2) return false;
    const b0 = this.#byteAt(0);
    const b1 = this.#byteAt(1);
    const fin = (b0 & 0x80) !== 0;
    const opcode = b0 & 0x0f;
    const length7 = b1 & 0x7f;

    // Fail on the first two bytes, before waiting for the rest of a frame we'd reject anyway.
    if ((b0 & 0x70) !== 0) return this.#fail(1002, "RSV bits set without a negotiated extension");
    if ((b1 & 0x80) === 0) return this.#fail(1002, "client frames must be masked");
    if (opcode >= 0x8) {
      if (opcode > OP_PONG) return this.#fail(1002, `unknown opcode ${opcode}`);
      if (!fin) return this.#fail(1002, "fragmented control frame");
      if (length7 > 125) return this.#fail(1002, "control frame payload over 125 bytes");
    } else if (opcode === OP_CONTINUATION) {
      if (this.#fragOpcode === 0) return this.#fail(1002, "continuation frame without a message to continue");
    } else if (opcode === OP_TEXT || opcode === OP_BINARY) {
      if (this.#fragOpcode !== 0) return this.#fail(1002, "new message inside a fragmented message");
    } else {
      return this.#fail(1002, `unknown opcode ${opcode}`);
    }

    const extended = length7 === 126 ? 2 : length7 === 127 ? 8 : 0;
    const headerLength = 2 + extended + 4;
    if (this.#buffered < headerLength) return false;
    let buf = this.#chunks[0];
    let at = this.#offset;
    if (buf.length - at < headerLength) {
      for (let i = 0; i < headerLength; i++) this.#scratch[i] = this.#byteAt(i);
      buf = this.#scratch;
      at = 0;
    }

    let length = length7;
    if (extended === 2) {
      length = buf.readUInt16BE(at + 2);
    } else if (extended === 8) {
      const high = buf.readUInt32BE(at + 2);
      if (high >= 0x80000000) return this.#fail(1002, "64-bit payload length with the most significant bit set");
      length = high * 0x100000000 + buf.readUInt32BE(at + 6);
    }
    // Checked before buffering any of the payload, so an oversize message costs us nothing.
    if (opcode < 0x8 && this.#fragBytes + length > this.#maxPayload) {
      return this.#fail(1009, `message over ${this.#maxPayload} bytes`);
    }

    const m = at + 2 + extended;
    this.#mask[0] = buf[m];
    this.#mask[1] = buf[m + 1];
    this.#mask[2] = buf[m + 2];
    this.#mask[3] = buf[m + 3];
    this.#skip(headerLength);
    this.#fin = fin;
    this.#opcode = opcode;
    this.#payloadLength = length;
    return true;
  }

  #handleFrame(payload: Buffer): void {
    const opcode = this.#opcode;
    if (opcode >= 0x8) {
      this.#handleControl(opcode, payload);
    } else if (this.#fin && this.#fragOpcode === 0) {
      this.#deliver(opcode, payload);
    } else {
      if (opcode !== OP_CONTINUATION) this.#fragOpcode = opcode;
      this.#appendFragment(payload);
      if (!this.#fin) return;
      const message = this.#fragBuffer.subarray(0, this.#fragBytes);
      const messageOpcode = this.#fragOpcode;
      this.#fragOpcode = 0;
      this.#fragBytes = 0;
      this.#fragBuffer = EMPTY; // the message buffer now belongs to the listener
      this.#deliver(messageOpcode, message);
    }
  }

  #appendFragment(payload: Buffer): void {
    const needed = this.#fragBytes + payload.length;
    if (needed > this.#fragBuffer.length) {
      // needed <= maxPayload was checked with the header, so the cap never cuts below it.
      const size = Math.min(Math.max(needed, this.#fragBuffer.length * 2, 1024), this.#maxPayload);
      const grown = Buffer.allocUnsafe(size);
      this.#fragBuffer.copy(grown, 0, 0, this.#fragBytes);
      this.#fragBuffer = grown;
    }
    payload.copy(this.#fragBuffer, this.#fragBytes);
    this.#fragBytes = needed;
  }

  #deliver(opcode: number, data: Buffer): void {
    if (opcode === OP_BINARY) {
      this.emit("message", data);
      return;
    }
    let text: string;
    try {
      // The whole message at once: a multi-byte character may be split across fragments.
      text = utf8.decode(data);
    } catch {
      this.#fail(1007, "text message is not valid UTF-8");
      return;
    }
    this.emit("message", text);
  }

  #handleControl(opcode: number, payload: Buffer): void {
    if (opcode === OP_PING) {
      // No pong once we sent a close: nothing but the peer's close is expected after ours.
      if (!this.#closeSent && this.#backlogOk()) this.#sendFrame(OP_PONG, payload);
      return;
    }
    if (opcode === OP_PONG) {
      this.#awaitingPong = false;
      return;
    }

    let code = 1005; // "no status code": the close frame was empty
    let reason = "";
    if (payload.length === 1) {
      this.#fail(1002, "close frame with a 1-byte payload");
      return;
    }
    if (payload.length >= 2) {
      code = payload.readUInt16BE(0);
      if (!isValidCloseCode(code)) {
        this.#fail(1002, `invalid close code ${code}`);
        return;
      }
      try {
        reason = utf8.decode(payload.subarray(2));
      } catch {
        this.#fail(1007, "close reason is not valid UTF-8");
        return;
      }
    }
    this.#closeReceived = true;
    this.#closeCode = code;
    this.#closeReason = reason;
    this.#stopParsing(); // nothing may follow a close frame
    if (!this.#closeSent) {
      // Echo the peer's code (an empty close frame if it sent none), RFC 6455 §5.5.1.
      if (code === 1005) this.#sendFrame(OP_CLOSE, EMPTY);
      else this.#writeClose(code, "");
      this.#closeSent = true;
    }
    this.#state = CLOSING;
    // Both close frames are exchanged: the server closes TCP first (RFC 6455 §7.1.1).
    this.#endSocket();
  }

  /** Fails the connection (RFC 6455 §7.1.7): close frame with `code`, end TCP, parse nothing more. */
  #fail(code: number, message: string): false {
    this.#stopParsing();
    if (!this.#closeSent) {
      this.#writeClose(code, message);
      this.#closeSent = true;
    }
    this.#state = CLOSING;
    this.#endSocket();
    if (this.listenerCount("error") > 0) this.emit("error", new WsError(code, message));
    return false;
  }

  // ---- outgoing ----

  /** Before queuing a frame: a peer that stopped reading must not make us buffer without bound. */
  #backlogOk(): boolean {
    if (this.#socket.writableLength <= this.#maxBuffered) return true;
    this.#abort(1008, `peer is not reading: over ${this.#maxBuffered} bytes queued`);
    return false;
  }

  #sendText(text: string): void {
    if (!this.#socket.writable) return;
    // Encode straight into the frame: one allocation, no intermediate payload buffer.
    const length = Buffer.byteLength(text);
    const headerLength = headerLengthFor(length);
    const frame = Buffer.allocUnsafe(headerLength + length);
    writeHeader(frame, OP_TEXT, length);
    frame.write(text, headerLength);
    this.#socket.write(frame);
  }

  #sendFrame(opcode: number, payload: Uint8Array): void {
    const socket = this.#socket;
    if (!socket.writable) return;
    const length = payload.length;
    const headerLength = headerLengthFor(length);
    if (length <= COPY_LIMIT) {
      const frame = Buffer.allocUnsafe(headerLength + length);
      writeHeader(frame, opcode, length);
      frame.set(payload, headerLength);
      socket.write(frame);
    } else {
      const header = Buffer.allocUnsafe(headerLength);
      writeHeader(header, opcode, length);
      socket.cork();
      socket.write(header);
      socket.write(payload);
      socket.uncork();
    }
  }

  #writeClose(code: number, reason: string): void {
    const payload = Buffer.allocUnsafe(2 + Buffer.byteLength(reason));
    payload.writeUInt16BE(code, 0);
    payload.write(reason, 2);
    this.#sendFrame(OP_CLOSE, payload);
  }

  // ---- lifecycle ----

  #onIdle = (): void => {
    if (this.#state !== OPEN) return; // closing: the close timer has taken over
    if (this.#awaitingPong) {
      this.#abort(1006, "no pong: the peer is gone or the connection is half-open");
      return;
    }
    this.#awaitingPong = true;
    if (this.#backlogOk()) this.#sendFrame(OP_PING, EMPTY);
    this.#idleTimer?.refresh();
  };

  #abort(code: number, message: string): void {
    this.terminate();
    if (this.listenerCount("error") > 0) this.emit("error", new WsError(code, message));
  }

  #onEnd = (): void => {
    // The peer half-closed TCP; nothing more can arrive. Without a close frame first this is an
    // abnormal end (reported as 1006). The http server allows half-open sockets, so end our side too.
    this.#stopParsing();
    if (this.#state === OPEN) this.#state = CLOSING;
    this.#endSocket();
  };

  #onError = (err: Error): void => {
    // Resets and broken pipes are routine for a server. The socket closes next and "close" follows.
    if (this.listenerCount("error") > 0) this.emit("error", err);
  };

  #onClose = (): void => {
    this.#state = CLOSED;
    this.#stopParsing();
    if (this.#idleTimer !== null) clearTimeout(this.#idleTimer);
    if (this.#closeTimer !== null) clearTimeout(this.#closeTimer);
    this.#idleTimer = null;
    this.#closeTimer = null;
    this.emit("close", this.#closeCode, this.#closeReason, this.#closeSent && this.#closeReceived);
  };

  #endSocket(): void {
    if (this.#socket.writable) this.#socket.end();
    this.#armCloseTimer();
  }

  #armCloseTimer(): void {
    if (this.#closeTimer !== null || this.#state === CLOSED) return;
    this.#closeTimer = setTimeout(this.#onCloseTimeout, this.#closeTimeoutMs);
    this.#closeTimer.unref();
  }

  #onCloseTimeout = (): void => {
    this.#socket.destroy();
  };

  #stopParsing(): void {
    this.#discard = true;
    this.#chunks.length = 0;
    this.#offset = 0;
    this.#buffered = 0;
    this.#partial = null;
    this.#fragBuffer = EMPTY;
    this.#fragBytes = 0;
  }

  // ---- byte queue ----

  #byteAt(index: number): number {
    let i = this.#offset + index;
    let k = 0;
    while (i >= this.#chunks[k].length) {
      i -= this.#chunks[k].length;
      k++;
    }
    return this.#chunks[k][i];
  }

  #skip(count: number): void {
    this.#buffered -= count;
    while (count > 0) {
      const left = this.#chunks[0].length - this.#offset;
      if (count < left) {
        this.#offset += count;
        return;
      }
      count -= left;
      this.#chunks.shift();
      this.#offset = 0;
    }
  }

  /** Removes `count` bytes from the queue: a slice of the first chunk when it holds them all, else one copy. */
  #take(count: number): Buffer {
    if (count === 0) return EMPTY;
    const first = this.#chunks[0];
    const start = this.#offset;
    const left = first.length - start;
    if (count > left) {
      const out = Buffer.allocUnsafe(count);
      this.#moveInto(out, 0, count);
      return out;
    }
    this.#buffered -= count;
    if (count < left) {
      this.#offset = start + count;
      return first.subarray(start, start + count);
    }
    this.#chunks.shift();
    this.#offset = 0;
    return start === 0 ? first : first.subarray(start);
  }

  /** Moves `count` queued bytes into `target` at `at`. */
  #moveInto(target: Buffer, at: number, count: number): void {
    this.#buffered -= count;
    while (count > 0) {
      const chunk = this.#chunks[0];
      const from = this.#offset;
      const n = Math.min(chunk.length - from, count);
      chunk.copy(target, at, from, from + n);
      at += n;
      count -= n;
      if (from + n === chunk.length) {
        this.#chunks.shift();
        this.#offset = 0;
      } else {
        this.#offset = from + n;
      }
    }
  }
}
