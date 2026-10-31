// The WebSocket Transport (PLAN §3.1, §12): a client's connection to any Carton host (`server-node`, the Worker).
// Only the web-standard WebSocket API, so the same code runs in Node 24 (global WebSocket), Electron, and browsers.
//
// The session token rides in the subprotocol list (`carton.v1`, `carton.auth.<token>`), because browsers can't set
// headers on a WebSocket; the host answers `carton.v1`. Messages are one JSON text frame each.
// Contract (Transport): whole messages, in order, at most once; `onClose` exactly once, nothing delivered after it;
// `send` after close is a silent no-op. Reconnecting is the sync client's job.
// Keepalive: a `ping` text frame every `keepaliveMs` (the Worker's runtime answers `pong` without waking the room;
// server-node answers it too), so NATs and proxies don't drop an idle link.

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
}

export function webSocketTransport(opts: WebSocketTransportOptions = {}): Transport {
  const WS = opts.WebSocket ?? globalThis.WebSocket;
  const keepaliveMs = opts.keepaliveMs ?? 25_000;
  const connectTimeoutMs = opts.connectTimeoutMs ?? 10_000;
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
        const timer = setTimeout(() => fail(new Error(`connect timed out after ${connectTimeoutMs} ms`)), connectTimeoutMs);
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
          if (ws.protocol !== PROTOCOL) return fail(new Error(`host answered subprotocol ${JSON.stringify(ws.protocol)}, not ${PROTOCOL}`));
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
            return reject(new Error(e.code === 1006 ? "connection refused or dropped (check the token and URL)" : `closed ${e.code} ${e.reason}`));
          }
          finish(e.reason ? `${e.code} ${e.reason}` : String(e.code));
        };
        ws.onerror = () => {}; // the close event carries the outcome
      });
    },
  };
}
