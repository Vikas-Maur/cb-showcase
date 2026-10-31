// The loopback range server (PLAN §11, R2-12). ffmpeg-based agent tools (grab_frame, filmstrip, detect_scenes) can't
// read Carton's leaf cache, but they all speak HTTP, and ffmpeg seeks with Range: a frame grab at 0:08 fetches the
// index and the GOP it decodes, not the whole proxy. Verification, the leaf cache and the repair path all live behind
// RangeSource; this file only speaks HTTP.
//
// Anything on this machine that can open a socket can reach it, so (PLAN §14):
// - it binds 127.0.0.1 only, never 0.0.0.0;
// - every URL carries a random token (`?t=`), compared in constant time;
// - the Host header must name the loopback address and our port. A web page that points its own hostname at 127.0.0.1
//   (DNS rebinding) sends its own name as Host, so it gets 403 even if it learnt the token;
// - only GET and HEAD, only `/m/<64 hex>`. Error answers never echo the URL, so the token stays out of logs.
//
// Play first: bytes go out as the source yields them. A leaf that fails verification after some of its bytes went out
// makes the source throw; the socket is then destroyed, so the client sees a broken response instead of a clean end,
// stops, and asks again for the range, which the repair path has refetched by then (R2-11).

import { randomBytes, timingSafeEqual } from "node:crypto";
import { once } from "node:events";
import { createServer, STATUS_CODES, type IncomingMessage, type OutgoingHttpHeaders, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { isMediaHash } from "../bytes.ts";
import { parseRange } from "../http-range.ts";
import { LeafMismatchError, type RangeSource } from "../range-source.ts";

export interface RangeServerOptions {
  source: RangeSource;
  /** Loopback only. The option exists to say so; anything else throws. */
  host?: "127.0.0.1";
  /** 0 (the default) picks a free port. */
  port?: number;
  /** Defaults to 32 random bytes as hex. A caller-chosen token must be at least 32 characters. */
  token?: string;
  /**
   * A connection that moves no bytes either way for this long is closed (default 60 s). A paused player holds its
   * response open without reading; closing it frees the source read, and the player asks again when it needs more.
   */
  idleTimeoutMs?: number;
  /** Called once per request when its response ends, however it ends. */
  onRequest?: (info: RangeRequestInfo) => void;
  /** Don't keep the process alive for this server alone. Off by default: a tool may be mid-read when main code ends. */
  unref?: boolean;
}

export interface RangeRequestInfo {
  method: string;
  /** The media asked for, once the path parsed; null otherwise. */
  hash: string | null;
  /** 0 when the request ended before any answer went out. */
  status: number;
  /** The Range header as sent, or null. */
  range: string | null;
  /** The span this response carries: [offset, offset + length). */
  offset: number;
  length: number;
  /** Body bytes handed to the socket. Less than `length` when the client left or the source failed. */
  bytes: number;
  /** The client closed the connection before the response ended. */
  aborted: boolean;
  /** What the source (or the handler) threw, e.g. LeafMismatchError. */
  error?: unknown;
  ms: number;
}

export interface RangeServer {
  readonly port: number;
  readonly token: string;
  /** `http://127.0.0.1:<port>/m/<hash>?t=<token>`: what a tool gets. */
  url(hash: string): string;
  /** Stops listening, drops every connection (in-flight reads are aborted) and resolves once the server is closed. */
  close(): Promise<void>;
}

export { parseRange, type ByteSpan } from "../http-range.ts";

const MEDIA_PATH = "/m/";
const DEFAULT_TYPE = "application/octet-stream";

export async function startRangeServer(opts: RangeServerOptions): Promise<RangeServer> {
  const host = opts.host ?? "127.0.0.1";
  if (host !== "127.0.0.1") throw new TypeError(`the range server binds 127.0.0.1 only, not ${String(host)}`);
  const token = opts.token ?? randomBytes(32).toString("hex");
  if (token.length < 32) throw new TypeError("a range server token must be at least 32 characters");
  const expected = Buffer.from(token, "utf8");
  const source = opts.source;
  const onRequest = opts.onRequest;

  const tokenOk = (given: string | null): boolean => {
    if (given === null) return false;
    const got = Buffer.from(given, "utf8");
    // timingSafeEqual throws on unequal lengths. The token's length isn't secret, only its bytes are.
    return got.length === expected.length && timingSafeEqual(got, expected);
  };

  let hostOk = (_host: string | undefined): boolean => false; // set once the port is known

  // Responses not closed yet. close() waits for them, so once it resolves every read it started has been aborted and
  // the caller can shut the source down.
  let open = 0;
  let drained: (() => void) | undefined;

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const t0 = performance.now();
    const ac = new AbortController();
    open++;
    const info: RangeRequestInfo = {
      method: req.method ?? "",
      hash: null,
      status: 0,
      range: req.headers.range ?? null,
      offset: 0,
      length: 0,
      bytes: 0,
      aborted: false,
      ms: 0,
    };
    let markClosed!: () => void;
    const closed = new Promise<void>((r) => (markClosed = r));
    res.once("close", () => {
      if (!res.writableFinished) {
        // The client left, the idle timeout fired, close() ran, or we destroyed the socket after a source error. A
        // client that hangs up once it has every byte (its Content-Length is met) while we finish the source's read
        // lost nothing: that is not an abort.
        if (info.error === undefined && !(info.length > 0 && info.bytes === info.length)) info.aborted = true;
        ac.abort();
      }
      markClosed();
    });

    try {
      await respond(req, res, ac, info);
    } finally {
      // Report once the response is closed AND this handler is done, the source's read included (its cleanup can
      // outlast the socket), so onRequest and close() mean "this request is completely over".
      await closed;
      if (onRequest !== undefined) {
        info.status = res.headersSent ? res.statusCode : 0; // 0: it ended before any answer
        info.ms = performance.now() - t0;
        try {
          onRequest(info);
        } catch (e) {
          process.emitWarning(`range server onRequest threw: ${String(e)}`);
        }
      }
      if (--open === 0 && drained !== undefined) drained();
    }
  };

  const respond = async (req: IncomingMessage, res: ServerResponse, ac: AbortController, info: RangeRequestInfo): Promise<void> => {
    try {
      if (!hostOk(req.headers.host)) return reply(res, 403, CLOSE);
      const url = req.url ?? "";
      const q = url.indexOf("?");
      const path = q < 0 ? url : url.slice(0, q);
      if (!tokenOk(q < 0 ? null : new URLSearchParams(url.slice(q + 1)).get("t"))) return reply(res, 403, CLOSE);
      const head = req.method === "HEAD";
      // A request with another method may carry a body; closing is cheaper than reading it to keep the connection.
      if (!head && req.method !== "GET") return reply(res, 405, { Allow: "GET, HEAD", ...CLOSE });
      const hash = path.length === MEDIA_PATH.length + 64 && path.startsWith(MEDIA_PATH) ? path.slice(MEDIA_PATH.length) : "";
      if (!isMediaHash(hash)) return reply(res, 404);
      info.hash = hash;

      const stat = await source.stat(hash, ac.signal);
      if (ac.signal.aborted) return;
      if (stat === null) return reply(res, 404);
      const size = stat.size;
      const headers: OutgoingHttpHeaders = {
        "Accept-Ranges": "bytes",
        "Content-Type": stat.contentType ?? DEFAULT_TYPE,
        // The URL carries a token and the bytes are already in our leaf cache: no browser disk cache copies.
        "Cache-Control": "no-store",
        // Content-addressed, so the hash is a strong validator. It also lets If-Range work (below).
        ETag: `"${hash}"`,
      };
      // RFC 9110: Range applies to GET only; If-Range with another validator means "send it all". An empty body has
      // no satisfiable range, but 200 with nothing is what players and ffmpeg cope with, not 416.
      const ifRange = req.headers["if-range"];
      const span = head || size === 0 || (ifRange !== undefined && ifRange !== headers.ETag) ? null : parseRange(req.headers.range, size);
      if (span === "unsatisfiable") return reply(res, 416, { ...headers, "Content-Range": `bytes */${size}` });
      const status = span === null ? 200 : 206;
      const offset = span === null ? 0 : span.start;
      const length = span === null ? size : span.end - span.start + 1;
      headers["Content-Length"] = length;
      if (span !== null) headers["Content-Range"] = `bytes ${span.start}-${span.end}/${size}`;
      info.offset = offset;
      info.length = length;
      if (head || length === 0) {
        res.writeHead(status, headers);
        res.end();
        return;
      }
      await sendBody(res, source, hash, offset, length, status, headers, ac.signal, info);
    } catch (e) {
      if (ac.signal.aborted) return; // the client left; there is no one to answer
      info.error = e;
      // Headers go out with the first body bytes (sendBody), so headersSent means the client has part of a body: break
      // the response so it can't mistake it for a complete one. Before that, a plain 502 says "try again".
      if (res.headersSent) res.destroy();
      else reply(res, 502);
    }
  };

  // requestTimeout covers receiving the request, which for GET and HEAD ends with the headers; 0 makes sure Node never
  // times out a long response. headersTimeout bounds slow header senders, the idle timeout (below) stalled sockets.
  const server = createServer({ requestTimeout: 0, headersTimeout: 10_000 }, (req, res) => {
    handle(req, res).catch(() => res.destroy());
  });
  // Without a 'timeout' listener Node destroys a socket that went idle, which closes its response and aborts its read.
  server.setTimeout(opts.idleTimeoutMs ?? 60_000);

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen({ host, port: opts.port ?? 0 }, () => {
      server.off("error", reject);
      resolve();
    });
  });
  if (opts.unref) server.unref();
  const port = (server.address() as AddressInfo).port;
  const allowed = [`127.0.0.1:${port}`, `localhost:${port}`];
  hostOk = (h) => h !== undefined && (h === allowed[0] || h.toLowerCase() === allowed[1]);
  const query = `?t=${encodeURIComponent(token)}`;

  let closing: Promise<void> | undefined;
  return {
    port,
    token,
    url(hash) {
      if (!isMediaHash(hash)) throw new TypeError(`not a media hash: ${String(hash).slice(0, 80)}`);
      return `http://127.0.0.1:${port}${MEDIA_PATH}${hash}${query}`;
    },
    close() {
      closing ??= new Promise<void>((resolve) => {
        // The server's 'close' can come before the dropped responses emit theirs, so wait for both.
        let pending = 2;
        const done = (): void => {
          if (--pending === 0) resolve();
        };
        server.close(() => done());
        if (open === 0) done();
        else drained = done;
        server.closeAllConnections();
      });
      return closing;
    },
  };
}

const CLOSE = { Connection: "close" };

function reply(res: ServerResponse, status: number, extra?: OutgoingHttpHeaders): void {
  const body = `${status} ${STATUS_CODES[status] ?? ""}\n`;
  res.writeHead(status, {
    "Content-Type": "text/plain; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store",
    ...extra,
  });
  res.end(body);
}

/**
 * Streams [offset, offset + length) from the source. Chunks go to the socket as they are, with no copy, so a source
 * must not reuse a chunk's memory after yielding it. A false write waits for 'drain', which is what keeps a slow
 * client from making us pull (and the source fetch) the whole file into memory.
 */
async function sendBody(
  res: ServerResponse,
  source: RangeSource,
  hash: string,
  offset: number,
  length: number,
  status: number,
  headers: OutgoingHttpHeaders,
  signal: AbortSignal,
  info: RangeRequestInfo,
): Promise<void> {
  let sent = 0;
  for (let attempt = 0; ; attempt++) {
    try {
      // A retry (below) only happens before any byte went out, so it asks for the same span.
      for await (const chunk of source.read(hash, offset, length, signal)) {
        if (signal.aborted) return;
        // A source that yields past the end is trimmed (a view, not a copy) rather than overrunning Content-Length.
        const c = chunk.length > length - sent ? chunk.subarray(0, length - sent) : chunk;
        if (c.length === 0) continue;
        // Headers wait for the first bytes, so a source that fails first can still get a clean 502.
        if (!res.headersSent) res.writeHead(status, headers);
        sent += c.length;
        info.bytes = sent;
        if (!res.write(c)) await once(res, "drain", { signal });
        if (sent === length) break;
      }
      break;
    } catch (e) {
      // A leaf that failed verification before any of it reached the client costs the client nothing: read again,
      // once. The repair path has refetched the leaf by then; a second failure is answered with 502.
      if (sent === 0 && attempt === 0 && e instanceof LeafMismatchError && !signal.aborted) continue;
      throw e;
    }
  }
  if (signal.aborted) return;
  if (sent !== length) throw new Error(`media ${hash.slice(0, 12)}: the source ended after ${sent} of ${length} bytes`);
  res.end();
}
