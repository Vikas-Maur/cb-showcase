// A raw-socket WebSocket client for edge-case tests. It writes handshakes and frames byte for byte
// and parses what the server sends back, so a test can break the protocol on purpose, which a real
// client (Node's global WebSocket) never does.

import { randomBytes } from "node:crypto";
import net from "node:net";

export const OP = { CONTINUATION: 0x0, TEXT: 0x1, BINARY: 0x2, CLOSE: 0x8, PING: 0x9, PONG: 0xa } as const;

export interface Frame {
  fin: boolean;
  rsv: number;
  opcode: number;
  masked: boolean;
  payload: Buffer;
}

export interface FrameOptions {
  fin?: boolean;
  rsv?: number;
  /** Client frames must be masked; false builds an invalid unmasked one. */
  mask?: boolean;
  /** Declare this payload length in the header instead of the real one (for oversize claims). */
  declaredLength?: number;
}

/** Builds a client frame (masked unless told otherwise). */
export function clientFrame(opcode: number, payload: string | Uint8Array = "", opts: FrameOptions = {}): Buffer {
  const data = Buffer.from(typeof payload === "string" ? Buffer.from(payload) : payload); // own copy: masked in place
  const length = opts.declaredLength ?? data.length;
  const mask = opts.mask ?? true;
  const extended = length < 126 ? 0 : length < 0x10000 ? 2 : 8;
  const header = Buffer.alloc(2 + extended + (mask ? 4 : 0));
  header[0] = ((opts.fin ?? true) ? 0x80 : 0) | ((opts.rsv ?? 0) << 4) | opcode;
  header[1] = (mask ? 0x80 : 0) | (extended === 0 ? length : extended === 2 ? 126 : 127);
  if (extended === 2) header.writeUInt16BE(length, 2);
  if (extended === 8) header.writeBigUInt64BE(BigInt(length), 2);
  if (mask) {
    const key = randomBytes(4);
    key.copy(header, 2 + extended);
    for (let i = 0; i < data.length; i++) data[i] ^= key[i & 3];
  }
  return Buffer.concat([header, data]);
}

export function closePayload(code: number, reason = ""): Buffer {
  const out = Buffer.alloc(2 + Buffer.byteLength(reason));
  out.writeUInt16BE(code, 0);
  out.write(reason, 2);
  return out;
}

export interface ConnectOptions {
  path?: string;
  /** Header overrides; null removes a default header. */
  headers?: Record<string, string | null>;
  method?: string;
  /** Bytes sent in the same write as the request (they reach the server as the upgrade's `head`). */
  extra?: Buffer;
  timeoutMs?: number;
}

export class RawClient {
  readonly socket: net.Socket;
  status = 0;
  headers: Record<string, string> = {};
  /** Resolves when the TCP socket is fully closed. */
  readonly closed: Promise<void>;
  error: Error | null = null;
  #buf: Buffer = Buffer.alloc(0);
  #ended = false;
  #wake: (() => void) | null = null;

  constructor(socket: net.Socket) {
    this.socket = socket;
    socket.setNoDelay(true);
    socket.on("data", (chunk: Buffer) => {
      this.#buf = this.#buf.length === 0 ? chunk : Buffer.concat([this.#buf, chunk]);
      this.#notify();
    });
    socket.on("end", () => {
      this.#ended = true;
      this.#notify();
    });
    socket.on("error", (err) => {
      this.error = err;
    });
    this.closed = new Promise((resolve) => {
      socket.once("close", () => {
        this.#ended = true;
        this.#notify();
        resolve();
      });
    });
  }

  /** Connects and performs a WebSocket handshake, resolving once the response headers are in. */
  static async connect(port: number, opts: ConnectOptions = {}): Promise<RawClient> {
    const socket = net.connect(port, "127.0.0.1");
    const client = new RawClient(socket);
    const headers: Record<string, string | null> = {
      Host: `127.0.0.1:${port}`,
      Upgrade: "websocket",
      Connection: "Upgrade",
      "Sec-WebSocket-Key": randomBytes(16).toString("base64"),
      "Sec-WebSocket-Version": "13",
      ...opts.headers,
    };
    let request = `${opts.method ?? "GET"} ${opts.path ?? "/"} HTTP/1.1\r\n`;
    for (const [name, value] of Object.entries(headers)) if (value !== null) request += `${name}: ${value}\r\n`;
    request += "\r\n";
    socket.write(opts.extra ? Buffer.concat([Buffer.from(request), opts.extra]) : request);
    await client.#until(() => client.#readResponse(), opts.timeoutMs ?? 3000, "the handshake response");
    return client;
  }

  #notify(): void {
    const wake = this.#wake;
    this.#wake = null;
    wake?.();
  }

  async #until<T>(read: () => T | undefined, timeoutMs: number, what: string): Promise<T> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const value = read();
      if (value !== undefined) return value;
      if (this.#ended) throw new Error(`socket closed while waiting for ${what}`);
      const left = deadline - Date.now();
      if (left <= 0) throw new Error(`timed out waiting for ${what}`);
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, left);
        this.#wake = () => {
          clearTimeout(timer);
          resolve();
        };
      });
    }
  }

  #readResponse(): true | undefined {
    const end = this.#buf.indexOf("\r\n\r\n");
    if (end < 0) return undefined;
    const [statusLine, ...lines] = this.#buf.subarray(0, end).toString("latin1").split("\r\n");
    this.status = Number(statusLine.split(" ")[1]);
    for (const line of lines) {
      const colon = line.indexOf(":");
      this.headers[line.slice(0, colon).trim().toLowerCase()] = line.slice(colon + 1).trim();
    }
    this.#buf = this.#buf.subarray(end + 4);
    return true;
  }

  #readFrame(): Frame | undefined {
    const b = this.#buf;
    if (b.length < 2) return undefined;
    const masked = (b[1] & 0x80) !== 0;
    let length = b[1] & 0x7f;
    let at = 2;
    if (length === 126) {
      if (b.length < 4) return undefined;
      length = b.readUInt16BE(2);
      at = 4;
    } else if (length === 127) {
      if (b.length < 10) return undefined;
      length = Number(b.readBigUInt64BE(2));
      at = 10;
    }
    const maskAt = at;
    if (masked) at += 4;
    if (b.length < at + length) return undefined;
    const payload = Buffer.from(b.subarray(at, at + length));
    if (masked) for (let i = 0; i < payload.length; i++) payload[i] ^= b[maskAt + (i & 3)];
    this.#buf = b.subarray(at + length);
    return { fin: (b[0] & 0x80) !== 0, rsv: (b[0] >> 4) & 7, opcode: b[0] & 0x0f, masked, payload };
  }

  /** The next frame from the server; rejects if the socket closes or nothing arrives in time. */
  nextFrame(timeoutMs = 3000): Promise<Frame> {
    return this.#until(() => this.#readFrame(), timeoutMs, "a frame");
  }

  /** Expects a close frame next and returns its code (1005 if empty) and reason. */
  async nextClose(timeoutMs = 3000): Promise<{ code: number; reason: string }> {
    const frame = await this.nextFrame(timeoutMs);
    if (frame.opcode !== OP.CLOSE) throw new Error(`expected a close frame, got opcode ${frame.opcode}`);
    if (frame.payload.length === 0) return { code: 1005, reason: "" };
    return { code: frame.payload.readUInt16BE(0), reason: frame.payload.subarray(2).toString() };
  }

  /** Whatever the server sent that hasn't been parsed (e.g. an HTTP error body). */
  rest(): string {
    return this.#buf.toString();
  }

  /** Waits for the server to close the TCP connection. */
  async waitClosed(timeoutMs = 3000): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("timed out waiting for the server to close the socket")), timeoutMs);
    });
    try {
      await Promise.race([this.closed, timeout]);
    } finally {
      clearTimeout(timer);
    }
  }

  write(data: Uint8Array | string): void {
    this.socket.write(data);
  }

  /** Writes one byte per TCP write, waiting `delayMs` between them so each tends to be its own segment. */
  async writeBytewise(data: Uint8Array, delayMs = 1): Promise<void> {
    for (let i = 0; i < data.length; i++) {
      this.socket.write(data.subarray(i, i + 1));
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }

  destroy(): void {
    this.socket.destroy();
  }
}

/** Sends `request` verbatim and collects everything the server answers until it closes the socket. */
export async function rawExchange(port: number, request: string, timeoutMs = 3000): Promise<string> {
  const socket = net.connect(port, "127.0.0.1");
  socket.on("error", () => {});
  const chunks: Buffer[] = [];
  socket.on("data", (c: Buffer) => chunks.push(c));
  socket.write(request);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      new Promise<void>((resolve) => socket.once("close", () => resolve())),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("server did not close the socket")), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
    socket.destroy();
  }
  return Buffer.concat(chunks).toString();
}
