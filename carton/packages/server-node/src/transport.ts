// The WebSocket Transport (PLAN §3.1, §12): a client's connection to any Carton host (`server-node`, the Worker).
// Only the web-standard WebSocket API, so the same code runs in Node 24 (global WebSocket), Electron, and browsers.
//
// The session token rides in the subprotocol list (`carton.v1`, `carton.auth.<token>`), because browsers can't set
// headers on a WebSocket; the host answers `carton.v1`. Messages are one JSON text frame each.
// Contract (Transport): whole messages, in order, at most once; `onClose` exactly once, nothing delivered after it;
// `send` after close is a silent no-op. Reconnecting is the sync client's job.
// Keepalive: a `ping` text frame every `keepaliveMs` (the Worker's runtime answers `pong` without waking the room;
// server-node answers it too), so NATs and proxies don't drop an idle link.
// A failed `connect` rejects with a TransportError whose `code` says why: `unreachable` (offline, no host there, a
// timeout, or the connection dropped before it opened), `unauthorized` (the host refused this session), `protocol`
// (the host answered another subprotocol), `closed` (closed before it opened, with a code of its own). A browser's
// WebSocket can't see the HTTP status of a refused handshake (both cases close with 1006), so on 1006 one request to
// the host's HTTP API with the same token tells them apart (401 or 403: unauthorized).

import type { Transport, TransportConnection } from "@carton/core/plugins";
import type { sync } from "@carton/core";

const PROTOCOL = "carton.v1";
const AUTH_PREFIX = "carton.auth.";

export interface WebSocketTransportOptions {
  keepaliveMs?: number;
  // how long `connect` waits for the open before failing
  connectTimeoutMs?: number;
  // a WebSocket constructor (tests, or a polyfill); default: the global one
  WebSocket?: typeof WebSocket;
  // fetch for the probe that tells a refused session from an unreachable host; default: the global one
  fetch?: typeof fetch;
}

export type TransportErrorCode = "unreachable" | "unauthorized" | "protocol" | "closed";
export interface TransportError extends Error {
  code: TransportErrorCode;
}
export const transportError = (message: string, code: TransportErrorCode): TransportError => Object.assign(new Error(message), { code });

/** The HTTP route the probe asks (`/api/projects/<p>/blobs/head`, which checks the session first), or null. */
function probeUrl(wsUrl: string): string | null {
  try {
    const u = new URL(wsUrl);
    const m = /^(\/api\/projects\/[^/]+)\/ws$/.exec(u.pathname);
    if (!m || (u.protocol !== "ws:" && u.protocol !== "wss:")) return null;
    u.protocol = u.protocol === "wss:" ? "https:" : "http:";
    u.pathname = `${m[1]}/blobs/head`;
    u.search = "?key=carton-probe";
    return u.toString();
  } catch {
    return null;
  }
}

export function webSocketTransport(opts: WebSocketTransportOptions = {}): Transport {
  const WS = opts.WebSocket ?? globalThis.WebSocket;
  const keepaliveMs = opts.keepaliveMs ?? 25_000;
  const connectTimeoutMs = opts.connectTimeoutMs ?? 10_000;
  const fetchImpl = opts.fetch ?? globalThis.fetch;
  // a handshake that closed 1006 before opening: refused (401, 403 to the same token over HTTP) or unreachable
  async function why1006(url: string, token: string): Promise<TransportError> {
    const probe = probeUrl(url);
    if (probe && fetchImpl) {
      try {
        const r = await fetchImpl(probe, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(5000) });
        if (r.status === 401 || r.status === 403) {
          const reason = ((await r.json().catch(() => null)) as { error?: unknown } | null)?.error;
          return transportError(`the host refused this session (${r.status}${typeof reason === "string" ? `: ${reason}` : ""})`, "unauthorized");
        }
      } catch {}
    }
    return transportError("couldn't connect to the host: offline, unreachable, or the connection dropped", "unreachable");
  }
  return {
    connect(url, { token, signal }) {
      return new Promise<TransportConnection>((resolve, reject) => {
        if (signal?.aborted) return reject(signal.reason ?? new Error("aborted"));
        let ws: WebSocket;
        try {
          ws = new WS(url, [PROTOCOL, AUTH_PREFIX + token]);
        } catch (e) {
          return reject(e);
        }
        const listeners: ((m: sync.ServerMessage) => void)[] = [];
        const closers: ((why: string) => void)[] = [];
        let open = false, closed = false, settled = false;
        let keepalive: ReturnType<typeof setInterval> | undefined;
        const timer = setTimeout(() => fail(transportError(`couldn't connect to the host: no answer in ${connectTimeoutMs} ms`, "unreachable")), connectTimeoutMs);
        const onAbort = () => fail(signal?.reason ?? new Error("aborted"));
        signal?.addEventListener("abort", onAbort, { once: true });

        function finish(why: string) {
          if (closed) return;
          closed = true;
          open = false;
          if (keepalive) clearInterval(keepalive);
          for (const f of closers.splice(0)) f(why);
        }
        function fail(e: unknown) {
          clearTimeout(timer);
          signal?.removeEventListener("abort", onAbort);
          if (!settled) {
            settled = true;
            closed = true;
            try {
              ws.close();
            } catch {}
            reject(e);
          } else {
            try {
              ws.close(1000);
            } catch {}
            finish(String((e as Error)?.message ?? e));
          }
        }

        const conn: TransportConnection = {
          get open() {
            return open;
          },
          send(msg) {
            if (!open) return;
            try {
              ws.send(JSON.stringify(msg));
            } catch {} // the close event follows
          },
          onMessage(f) {
            listeners.push(f);
          },
          onClose(f) {
            if (closed) queueMicrotask(() => f("closed"));
            else closers.push(f);
          },
          close() {
            if (closed) return;
            try {
              ws.close(1000, "bye");
            } catch {}
            finish("closed");
          },
        };

        ws.onopen = () => {
          clearTimeout(timer);
          signal?.removeEventListener("abort", onAbort);
          if (ws.protocol !== PROTOCOL) return fail(transportError(`host answered subprotocol ${JSON.stringify(ws.protocol)}, not ${PROTOCOL}`, "protocol"));
          open = true;
          settled = true;
          if (keepaliveMs > 0) {
            keepalive = setInterval(() => {
              try {
                ws.send("ping");
              } catch {}
            }, keepaliveMs);
            (keepalive as { unref?: () => void }).unref?.();
          }
          resolve(conn);
        };
        ws.onmessage = (e) => {
          if (closed || typeof e.data !== "string" || e.data === "pong") return;
          let msg: sync.ServerMessage;
          try {
            msg = JSON.parse(e.data);
          } catch {
            return;
          }
          for (const f of listeners) f(msg);
        };
        ws.onclose = (e) => {
          clearTimeout(timer);
          if (!settled) {
            settled = true;
            closed = true;
            if (e.code !== 1006) return reject(transportError(`closed ${e.code} ${e.reason}`, "closed"));
            return void why1006(url, token).then(reject);
          }
          finish(e.reason ? `${e.code} ${e.reason}` : String(e.code));
        };
        ws.onerror = () => {}; // the close event carries the outcome
      });
    },
  };
}
