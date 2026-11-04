// The control socket (§6.2). The same wire format as Cardboard's own `cardboard.sock`: JSON-RPC 2.0, one message per
// line, an `auth` call with the token from the file next to the socket before anything else. So the worker can serve
// `carton.*` methods on Cardboard's socket, and a helper can serve them on its own, and `cb` talks to both the same way.
//
// - Mac and Linux: a Unix socket file. Windows can't listen on a file path, so the path is mapped to a named pipe
//   exactly as our Windows build maps `cardboard.sock` (scripts/patch-main.js `__cbSock`): the file path stays the
//   name everyone stores and passes around (the lease row, CARDBOARD_SOCKET), and the token file sits next to it.
// - `carton.ping` is answered before `auth`: it only returns the holder's pid and lease nonce, which carton.db already
//   shows to anyone who can read it, and skipping the auth round trip keeps the liveness check inside its 100 ms.
import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createConnection, createServer } from "node:net";
import type { Server, Socket } from "node:net";
import { dirname } from "node:path";

/** The listen/connect address for a socket path: the path itself, or on Windows the named pipe derived from it. */
export function pipeName(path: string, platform: string = process.platform): string {
  // already a pipe (`\\.\pipe\…` or `\\?\pipe\…`); a UNC path (`\\server\share\…`) is a file path like any other
  if (platform !== "win32" || /^\\\\[.?]\\pipe\\/i.test(path)) return path;
  return "\\\\.\\pipe\\cardboard-" + createHash("sha256").update(path.toLowerCase()).digest("hex").slice(0, 16);
}
export const tokenPath = (socketPath: string): string => `${socketPath}.token`;

export const RPC = { parse: -32700, invalidRequest: -32600, methodNotFound: -32601, invalidParams: -32602, internal: -32603, unauthorized: -32000 } as const;

export class RpcError extends Error {
  code: number;
  data: unknown;
  constructor(message: string, code: number = RPC.internal, data?: unknown) {
    super(message);
    this.name = "RpcError";
    this.code = code;
    this.data = data;
  }
}

/** Splits a byte stream into lines without re-scanning or re-concatenating what was already buffered. */
class LineReader {
  private parts: string[] = [];
  private size = 0;
  max: number;
  constructor(max: number) { this.max = max; }
  push(chunk: string, out: (line: string) => void): boolean {
    let start = 0;
    for (let nl = chunk.indexOf("\n"); nl !== -1; nl = chunk.indexOf("\n", start)) {
      const piece = chunk.slice(start, nl);
      const line = this.parts.length ? this.parts.join("") + piece : piece;
      this.parts.length = 0;
      this.size = 0;
      start = nl + 1;
      if (line.trim()) out(line);
    }
    if (start < chunk.length) {
      this.size += chunk.length - start;
      if (this.size > this.max) return false;
      this.parts.push(start ? chunk.slice(start) : chunk);
    }
    return true;
  }
}

/** 64 MB: a `cb source apply` sends the whole timeline file, which can be several MB on a large project. */
const MAX_LINE = 64 * 1024 * 1024;

export interface RpcContext { authed: boolean; socket: Socket }
export type RpcMethod = (params: any, ctx: RpcContext) => unknown | Promise<unknown>;

export interface ControlServerOptions {
  /** The socket path (a file path; mapped to a pipe on Windows). */
  path: string;
  methods: Record<string, RpcMethod>;
  /** Methods that may be called before `auth`. */
  open?: string[];
  /** Write a fresh token to `<path>.token` (mode 0600). Default true. */
  writeToken?: boolean;
}

export class ControlServer {
  readonly path: string;
  readonly token: string;
  private server: Server;
  private sockets = new Set<Socket>();
  private opts: ControlServerOptions;

  private constructor(opts: ControlServerOptions, token: string) {
    this.opts = opts;
    this.path = opts.path;
    this.token = token;
    this.server = createServer((s) => this.onSocket(s));
  }

  static async listen(opts: ControlServerOptions): Promise<ControlServer> {
    const token = randomBytes(24).toString("hex");
    if (opts.writeToken !== false) {
      mkdirSync(dirname(opts.path), { recursive: true });
      writeFileSync(tokenPath(opts.path), token + "\n", { mode: 0o600 });
    }
    const srv = new ControlServer(opts, token);
    const addr = pipeName(opts.path);
    // A socket file left by a process that died is in the way on POSIX. Our paths carry the owner's pid and a random
    // part, so whatever is there is stale.
    if (addr === opts.path) rmSync(opts.path, { force: true });
    await new Promise<void>((resolve, reject) => {
      srv.server.once("error", reject);
      srv.server.listen(addr, () => { srv.server.off("error", reject); resolve(); });
    });
    return srv;
  }

  private onSocket(s: Socket): void {
    this.sockets.add(s);
    s.setEncoding("utf8");
    s.setNoDelay?.(true);
    const ctx: RpcContext = { authed: false, socket: s };
    const reader = new LineReader(MAX_LINE);
    s.on("data", (chunk: string) => {
      if (!reader.push(chunk, (line) => void this.onLine(ctx, line))) s.destroy();
    });
    s.on("error", () => {});
    s.on("close", () => this.sockets.delete(s));
  }

  private async onLine(ctx: RpcContext, line: string): Promise<void> {
    let msg: any;
    try { msg = JSON.parse(line); } catch { return this.send(ctx.socket, { jsonrpc: "2.0", id: null, error: { code: RPC.parse, message: "parse error" } }); }
    const id = msg?.id ?? null;
    const reply = (body: object) => (id === null ? undefined : this.send(ctx.socket, { jsonrpc: "2.0", id, ...body }));
    if (typeof msg?.method !== "string") return reply({ error: { code: RPC.invalidRequest, message: "invalid request" } });
    if (msg.method === "auth") {
      if (msg.params?.token !== this.token) return reply({ error: { code: RPC.unauthorized, message: "bad token" } });
      ctx.authed = true;
      return reply({ result: { ok: true } });
    }
    if (!ctx.authed && !this.opts.open?.includes(msg.method)) return reply({ error: { code: RPC.unauthorized, message: "auth first" } });
    const fn = this.opts.methods[msg.method];
    if (!fn) return reply({ error: { code: RPC.methodNotFound, message: `unknown method ${msg.method}` } });
    try {
      const result = await fn(msg.params ?? {}, ctx);
      reply({ result: result ?? null });
    } catch (e: any) {
      // a string code (a domain error's: core's EMPTY_VERSION) travels in `data`, where JSON-RPC keeps an error's own
      // detail, so the caller can tell it (review of fix/recover-save #2: a refused undo read as an unknown failure)
      const data = e?.data !== undefined ? e.data : typeof e?.code === "string" ? { code: e.code } : undefined;
      reply({ error: { code: typeof e?.code === "number" ? e.code : RPC.internal, message: String(e?.message ?? e), ...(data !== undefined ? { data } : {}) } });
    }
  }

  private send(s: Socket, body: object): void {
    if (!s.destroyed) s.write(JSON.stringify(body) + "\n");
  }

  /** Stop listening and drop every connection (callers waiting on an answer see the connection close). */
  async close({ removeToken = true }: { removeToken?: boolean } = {}): Promise<void> {
    for (const s of this.sockets) s.destroy();
    await new Promise<void>((r) => this.server.close(() => r()));
    if (removeToken && this.opts.writeToken !== false) rmSync(tokenPath(this.path), { force: true });
  }
}

export interface ConnectOptions { timeoutMs?: number; token?: string | null; auth?: boolean }

/** One connection to a control socket. Calls are matched to answers by id; a closed connection fails them all. */
export class ControlClient {
  private s: Socket;
  private next = 1;
  private waiting = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();
  closed = false;

  private constructor(s: Socket) {
    this.s = s;
    s.setEncoding("utf8");
    s.setNoDelay?.(true);
    const reader = new LineReader(MAX_LINE);
    s.on("data", (chunk: string) => {
      if (!reader.push(chunk, (line) => this.onLine(line))) s.destroy(new Error("message too large"));
    });
    s.on("error", (e) => this.fail(e));
    s.on("close", () => this.fail(Object.assign(new Error("ECONNRESET: the holder closed the connection"), { code: "ECONNRESET" })));
  }

  /** Connect within `timeoutMs` (default 1 s), then authenticate with the token file next to the socket. */
  static async connect(path: string, { timeoutMs = 1000, token, auth = true }: ConnectOptions = {}): Promise<ControlClient> {
    const s = await new Promise<Socket>((resolve, reject) => {
      const sock = createConnection(pipeName(path));
      const timer = setTimeout(() => { sock.destroy(); reject(Object.assign(new Error("ETIMEDOUT: connect"), { code: "ETIMEDOUT" })); }, timeoutMs);
      sock.once("connect", () => { clearTimeout(timer); resolve(sock); });
      sock.once("error", (e) => { clearTimeout(timer); reject(e); });
    });
    const c = new ControlClient(s);
    if (auth) {
      const tok = token ?? readFileSync(tokenPath(path), "utf8").trim();
      try { await c.call("auth", { token: tok }, timeoutMs); } catch (e) { c.close(); throw e; }
    }
    return c;
  }

  call<T = any>(method: string, params: object = {}, timeoutMs = 30000): Promise<T> {
    if (this.closed) return Promise.reject(Object.assign(new Error("ECONNRESET: connection closed"), { code: "ECONNRESET" }));
    return new Promise<T>((resolve, reject) => {
      const id = this.next++;
      const timer = setTimeout(() => {
        this.waiting.delete(id);
        reject(Object.assign(new Error(`ETIMEDOUT: no answer to ${method} within ${timeoutMs} ms`), { code: "ETIMEDOUT" }));
      }, timeoutMs);
      this.waiting.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
      this.s.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });
  }

  private onLine(line: string): void {
    let msg: any;
    try { msg = JSON.parse(line); } catch { return; }
    const w = typeof msg?.id === "number" ? this.waiting.get(msg.id) : undefined;
    if (!w) return;
    this.waiting.delete(msg.id);
    clearTimeout(w.timer);
    if (msg.error) w.reject(new RpcError(msg.error.message, msg.error.code, msg.error.data));
    else w.resolve(msg.result);
  }

  private fail(e: Error): void {
    this.closed = true;
    for (const w of this.waiting.values()) { clearTimeout(w.timer); w.reject(e); }
    this.waiting.clear();
  }

  close(): void {
    this.closed = true;
    this.s.end();
    this.s.destroy();
  }
}

/** One call on a fresh connection: connect, auth, call, close. */
export async function callOnce<T = any>(path: string, method: string, params: object = {}, { timeoutMs = 30000, connectMs = 1000 }: { timeoutMs?: number; connectMs?: number } = {}): Promise<T> {
  const c = await ControlClient.connect(path, { timeoutMs: connectMs });
  try { return await c.call<T>(method, params, timeoutMs); } finally { c.close(); }
}
