// The WebSocket Transport (PLAN §3.1, §12): a client's connection to any Carton host (`server-node`, the Worker).
// Only the web-standard WebSocket API, so the same code runs in Node 24 (global WebSocket), Electron, and browsers.
//
// The session token rides in the subprotocol list (`carton.v1`, `carton.auth.<token>`), because browsers can't set
// headers on a WebSocket; the host answers `carton.v1`. Messages are one JSON text frame each.
// Contract (Transport): whole messages, in order, at most once; `onClose` exactly once, nothing delivered after it;
// `send` after close is a silent no-op. Reconnecting is the sync client's job.
// Keepalive: a `ping` text frame every `keepaliveMs` (the Worker's runtime answers `pong` without waking the room;
// server-node answers it too), so NATs and proxies don't drop an idle link.
// A dead link: one that stops carrying anything without closing (Wi-Fi gone, a laptop lid, a NAT that forgot the
// flow) leaves TCP retransmitting for up to ~15 minutes, and the socket looks open all that time: the client shows
// "Up to date" while its edits go nowhere. So each ping expects an answer: if nothing at all (a pong or any message)
// arrives within `deadAfterMs` of a ping, the connection is closed as dead and the sync client reconnects. A send
// after `deadAfterMs` of silence pings at once, so an edit made on a dead link finds out in `deadAfterMs`, not at the
// next keepalive. (cf-lab: on a 5-minute outage the client stayed "online" throughout; see bench/cloudflare.)
// A failed `connect` rejects with a TransportError whose `code` says why: `unreachable` (offline, no host there, a
// timeout, or the connection dropped before it opened), `unauthorized` (the host refused this session), `protocol`
// (the host answered another subprotocol), `closed` (closed before it opened, with a code of its own). A browser's
// WebSocket can't see the HTTP status of a refused handshake (both cases close with 1006), so on 1006 one request to
// the host's session route with the same token tells them apart (401 or 403: unauthorized), within what is left of
// the connect deadline and under the caller's signal.

import type { Transport, TransportConnection } from "@carton/core/plugins";
import type { sync } from "@carton/core";

const PROTOCOL = "carton.v1";
const AUTH_PREFIX = "carton.auth.";

export interface WebSocketTransportOptions {
  keepaliveMs?: number;
  // how long a ping may go unanswered (nothing at all heard) before the link is taken for dead and closed; default
  // 15 s with a keepalive (a pong on a 400 ms, 3%-loss link arrives in a few seconds even after retransmits), never
  // without one; 0 = never
  deadAfterMs?: number;
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

/** The HTTP route the probe asks (`/api/projects/<p>/session`: the session alone, as every valid one may), or null. */
function probeUrl(wsUrl: string): string | null {
  try {
    const u = new URL(wsUrl);
    const m = /^(\/api\/projects\/[^/]+)\/ws$/.exec(u.pathname);
    if (!m || (u.protocol !== "ws:" && u.protocol !== "wss:")) return null;
    u.protocol = u.protocol === "wss:" ? "https:" : "http:";
    u.pathname = `${m[1]}/session`;
    u.search = "";
    return u.toString();
  } catch {
    return null;
  }
}

/**
 * Node abandons each connect attempt to one of a host's addresses after 250 ms by default (happy eyeballs), so over a
 * link with a longer round trip (satellite, a congested mobile cell) the socket never opens, though browsers and curl
 * connect fine (Cloudflare lab, 2026-11-02, a 400 ms link). Raises Node's process-wide default to at least 2 s, never
 * lowering a longer one; @carton/http-node's allowSlowLinks does the same for the blob clients.
 */
function allowSlowLinks(ms = 2000): void {
  const proc = (globalThis as { process?: { versions?: { node?: string }; getBuiltinModule?(id: string): unknown } }).process;
  if (!proc?.versions?.node || typeof proc.getBuiltinModule !== "function") return;
  const net = proc.getBuiltinModule("node:net") as { getDefaultAutoSelectFamilyAttemptTimeout?(): number; setDefaultAutoSelectFamilyAttemptTimeout?(ms: number): void } | undefined;
  if (net?.getDefaultAutoSelectFamilyAttemptTimeout && net.setDefaultAutoSelectFamilyAttemptTimeout && net.getDefaultAutoSelectFamilyAttemptTimeout() < ms) net.setDefaultAutoSelectFamilyAttemptTimeout(ms);
}

export function webSocketTransport(opts: WebSocketTransportOptions = {}): Transport {
  allowSlowLinks();
  const WS = opts.WebSocket ?? globalThis.WebSocket;
  const keepaliveMs = opts.keepaliveMs ?? 25_000;
  const deadAfterMs = opts.deadAfterMs ?? (keepaliveMs > 0 ? 15_000 : 0);
  const connectTimeoutMs = opts.connectTimeoutMs ?? 10_000;
  const fetchImpl = opts.fetch ?? globalThis.fetch;
  // a handshake that closed 1006 before opening: refused (401, 403 to the same token over HTTP) or unreachable
  async function why1006(url: string, token: string, signal: AbortSignal): Promise<TransportError> {
    const probe = probeUrl(url);
    if (probe && fetchImpl) {
      try {
        const r = await fetchImpl(probe, { headers: { authorization: `Bearer ${token}` }, signal });
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
        // when anything last arrived, and the pending check of the last unanswered ping
        let heard = Date.now();
        let probe: ReturnType<typeof setTimeout> | undefined;
        const ping = () => {
          if (!open) return;
          try {
            ws.send("ping");
          } catch {}
          if (deadAfterMs <= 0 || probe) return;
          const asked = Date.now();
          probe = setTimeout(() => {
            probe = undefined;
            if (open && heard < asked) fail(transportError(`the link is dead: no answer from the host in ${deadAfterMs} ms`, "unreachable"));
          }, deadAfterMs);
          (probe as { unref?: () => void }).unref?.();
        };
        const started = Date.now();
        const timer = setTimeout(() => fail(transportError(`couldn't connect to the host: no answer in ${connectTimeoutMs} ms`, "unreachable")), connectTimeoutMs);
        const onAbort = () => fail(signal?.reason ?? new Error("aborted"));
        signal?.addEventListener("abort", onAbort, { once: true });

        function finish(why: string) {
          if (closed) return;
          closed = true;
          open = false;
          if (keepalive) clearInterval(keepalive);
          if (probe) clearTimeout(probe);
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
            // silent for a while: make sure the link still carries anything before this edit counts as sent
            if (deadAfterMs > 0 && Date.now() - heard > deadAfterMs) ping();
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
          heard = Date.now();
          if (keepaliveMs > 0) {
            keepalive = setInterval(ping, keepaliveMs);
            (keepalive as { unref?: () => void }).unref?.();
          }
          resolve(conn);
        };
        ws.onmessage = (e) => {
          heard = Date.now();
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
          if (!settled) {
            closed = true;
            const done = (err: TransportError) => {
              if (settled) return; // the deadline or the caller's abort came first
              settled = true;
              clearTimeout(timer);
              signal?.removeEventListener("abort", onAbort);
              reject(err);
            };
            if (e.code !== 1006) return done(transportError(`closed ${e.code} ${e.reason}`, "closed"));
            // still connecting: the timer and an abort settle `connect` while the probe runs, and the probe stops
            // with them
            const left = Math.max(1, connectTimeoutMs - (Date.now() - started));
            const probeSignal = AbortSignal.any([AbortSignal.timeout(left), ...(signal ? [signal] : [])]);
            return void why1006(url, token, probeSignal).then(done);
          }
          clearTimeout(timer);
          finish(e.reason ? `${e.code} ${e.reason}` : String(e.code));
        };
        ws.onerror = () => {}; // the close event carries the outcome
      });
    },
  };
}
