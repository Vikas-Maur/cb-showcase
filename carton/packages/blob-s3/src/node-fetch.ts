// On Node, S3 requests go through node:http and node:https, not the global fetch (CI #29). Node's built-in undici,
// behind fetch, can crash the whole process with an uncaught `AssertionError: assert(!this.paused)` when a server
// closes the connection while the reader has paused the body (backpressure). undici throws it from its own socket
// handler, so no caller can catch it. node:http reports the same drop as an error on the response stream, so the read
// rejects instead. Workers and browsers keep fetch.
//
// The modules come from `process.getBuiltinModule`, so nothing here imports `node:*`: bundles for other platforms
// stay clean, and this file typechecks without Node's types (the few shapes it uses are declared below).

import type { FetchLike, S3FetchInit } from "./s3-client.ts";

interface IncomingMessage {
  statusCode?: number;
  statusMessage?: string;
  headers: Record<string, string | string[] | undefined>;
  resume(): void;
  destroy(error?: Error): void;
}
interface ClientRequest {
  on(event: "error", listener: (error: Error) => void): void;
  end(data?: Uint8Array): void;
  destroy(error?: Error): void;
}
interface HttpModule {
  request(url: URL, options: { method: string; headers: Record<string, string>; signal?: AbortSignal }, onResponse: (res: IncomingMessage) => void): ClientRequest;
}
interface StreamModule {
  Readable: {
    toWeb(readable: IncomingMessage): ReadableStream<Uint8Array>;
    fromWeb(stream: ReadableStream<Uint8Array>): { on(event: "error", listener: (error: Error) => void): unknown; pipe(destination: ClientRequest): unknown };
  };
}
type NodeProcess = { versions?: { node?: string }; getBuiltinModule?(id: string): unknown };

/** A FetchLike over node:http(s) when running on Node; null elsewhere (Workers, browsers), where fetch is right. */
export function nodeFetch(): FetchLike | null {
  const proc = (globalThis as { process?: NodeProcess }).process;
  const ua = (globalThis as { navigator?: { userAgent?: string } }).navigator?.userAgent;
  if (!proc?.versions?.node || typeof proc.getBuiltinModule !== "function" || ua === "Cloudflare-Workers") return null;
  const http = proc.getBuiltinModule("node:http") as HttpModule | undefined;
  const https = proc.getBuiltinModule("node:https") as HttpModule | undefined;
  const stream = proc.getBuiltinModule("node:stream") as StreamModule | undefined;
  if (!http || !https || !stream) return null;
  const { Readable } = stream;

  return (url: string, init: S3FetchInit) =>
    new Promise<Response>((resolve, reject) => {
      const u = new URL(url);
      const mod = u.protocol === "https:" ? https : http;
      const headers: Record<string, string> = {};
      new Headers(init.headers ?? {}).forEach((value, name) => (headers[name] = value));
      const req = mod.request(u, { method: init.method ?? "GET", headers, ...(init.signal ? { signal: init.signal } : {}) }, (res) => {
        const status = res.statusCode ?? 0;
        if (status < 200 || status > 599) {
          res.destroy();
          return reject(new Error(`unexpected HTTP status ${status}`));
        }
        const got = new Headers();
        for (const [name, value] of Object.entries(res.headers)) {
          if (value === undefined) continue;
          for (const v of Array.isArray(value) ? value : [value]) got.append(name, v);
        }
        const empty = init.method === "HEAD" || status === 204 || status === 304;
        if (empty) res.resume();
        // a connection dropped mid-body errors this stream: the reader's next read rejects
        resolve(new Response(empty ? null : Readable.toWeb(res), { status, statusText: res.statusMessage ?? "", headers: got }));
      });
      req.on("error", reject);
      const body = init.body;
      if (body === undefined || body === null) req.end();
      else if (body instanceof Uint8Array) req.end(body);
      else {
        const source = Readable.fromWeb(body as ReadableStream<Uint8Array>);
        source.on("error", (e) => req.destroy(e));
        source.pipe(req);
      }
    });
}
