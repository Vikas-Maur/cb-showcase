// @carton/http-node: the fetch every Carton blob client uses (blob-s3's S3 client, host-http's media and envelope
// clients), with no dependencies. On Node, requests go through node:http and node:https, not the global fetch (CI #29).
// Node's built-in undici, behind fetch, meets a paused parser when a server ends the connection while the reader has paused the body: in CI it threw an
// uncaught `AssertionError: assert(!this.paused)` from its own socket handler (no caller can catch it, the process
// dies), and here the read never settles. node:http reports the same drop as an error on the response stream, so the
// read rejects. Workers and browsers keep fetch.
//
// The modules come from `process.getBuiltinModule`, so nothing here imports `node:*`: bundles for other platforms
// stay clean, and this file typechecks without Node's types (the few shapes it uses are declared below).
// Redirects are followed as fetch follows them (`redirect: "follow"`, at most 20; 303, and 301/302 after a POST, go
// on as a GET without the body; Authorization is dropped when the redirect leaves the origin; a streamed body can't be
// sent twice, so a 307/308 after one is an error); `redirect: "manual"` returns the 3xx and `"error"` rejects.
// Differences from fetch, none of which the blob clients rely on: no Accept-Encoding sent (so bodies come as stored),
// no cookies or cache, and a followed response's `url` and `redirected` are not set.

interface IncomingMessage {
  statusCode?: number;
  statusMessage?: string;
  headers: Record<string, string | string[] | undefined>;
  resume(): void;
  destroy(error?: Error): void;
}
interface ClientRequest {
  on(event: "error" | "close" | "drain", listener: (error?: Error) => void): void;
  off(event: "error" | "close" | "drain", listener: (error?: Error) => void): void;
  write(chunk: Uint8Array): boolean;
  end(data?: Uint8Array | (() => void), done?: () => void): void;
  destroy(error?: Error): void;
  readonly destroyed: boolean;
}
interface HttpModule {
  request(url: URL, options: { method: string; headers: Record<string, string>; signal?: AbortSignal }, onResponse: (res: IncomingMessage) => void): ClientRequest;
}
interface StreamModule {
  Readable: {
    toWeb(readable: IncomingMessage, options?: { strategy?: QueuingStrategy<Uint8Array> }): ReadableStream<Uint8Array>;
  };
}
type NodeProcess = { versions?: { node?: string }; getBuiltinModule?(id: string): unknown };

/** The shape of `fetch` the blob clients call: a URL (string or URL) and a RequestInit (`duplex` for streamed bodies). */
export type BlobFetch = (input: string | URL, init?: RequestInit & { duplex?: "half" }) => Promise<Response>;

/** Resolves when `req` can take more, rejects if it closes first. */
function drained(req: ClientRequest): Promise<void> {
  return new Promise((ok, fail) => {
    const done = () => {
      req.off("drain", done);
      req.off("close", closed);
      ok();
    };
    const closed = () => {
      req.off("drain", done);
      req.off("close", closed);
      fail(new Error("the request closed while its body was being sent"));
    };
    req.on("drain", done);
    req.on("close", closed);
  });
}

// a response body buffers up to 1 MiB ahead of its reader (Readable.toWeb's default is a 16 KiB count, which pauses
// and resumes the socket for nearly every chunk of a large download)
const BODY_STRATEGY = { strategy: new ByteLengthQueuingStrategy({ highWaterMark: 1 << 20 }) };

let cached: BlobFetch | null | undefined;

/** A fetch over node:http(s) when running on Node; null elsewhere (Workers, browsers), where fetch is right. */
export function nodeFetch(): BlobFetch | null {
  if (cached !== undefined) return cached;
  const proc = (globalThis as { process?: NodeProcess }).process;
  const ua = (globalThis as { navigator?: { userAgent?: string } }).navigator?.userAgent;
  if (!proc?.versions?.node || typeof proc.getBuiltinModule !== "function" || ua === "Cloudflare-Workers") return (cached = null);
  const http = proc.getBuiltinModule("node:http") as HttpModule | undefined;
  const https = proc.getBuiltinModule("node:https") as HttpModule | undefined;
  const stream = proc.getBuiltinModule("node:stream") as StreamModule | undefined;
  if (!http || !https || !stream) return (cached = null);
  const { Readable } = stream;

  // one request, no redirects: the response once its head is in (a 2xx after a streamed body only once that went out),
  // and a way to stop the request (a redirect after a streamed body that is still going out)
  const send = (u: URL, method: string, headers: Record<string, string>, body: Uint8Array | ReadableStream<Uint8Array> | null, signal?: AbortSignal) =>
    new Promise<{ response: Response; stop(): void }>((resolve, reject) => {
      const mod = u.protocol === "https:" ? https : http;
      let req!: ClientRequest;
      let uploaded: Promise<void> | null = null;
      // a streamed body: sent chunk by chunk, counted against its declared content-length (more or fewer bytes fail the
      // request, never store a prefix), and done only once the source has ended and the request is flushed. If the
      // request fails or closes first, the source is cancelled, even while a read of it is waiting.
      const pump = async (source: ReadableStream<Uint8Array>): Promise<void> => {
        const declared = headers["content-length"] === undefined ? undefined : Number(headers["content-length"]);
        const reader = source.getReader();
        let sent = 0, finished = false, failure: Error | null = null;
        const stop = (e?: Error) => {
          if (finished) return;
          failure ??= e ?? new Error("the request closed while its body was being sent");
          reader.cancel(failure).catch(() => {});
        };
        req.on("error", stop);
        req.on("close", stop);
        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (failure) throw failure;
            if (done) break;
            sent += value.byteLength;
            if (declared !== undefined && sent > declared) throw new Error(`the body is longer than its content-length (${declared})`);
            if (!req.write(value)) await drained(req);
          }
          if (declared !== undefined && sent !== declared) throw new Error(`the body is ${sent} bytes, not its content-length (${declared})`);
          await new Promise<void>((ok, fail) => {
            req.on("error", (e) => fail(e));
            req.end(() => ok());
          });
        } catch (e) {
          finished = true;
          reader.cancel(e).catch(() => {});
          req.destroy(e as Error);
          throw e;
        } finally {
          finished = true;
          req.off("error", stop);
          req.off("close", stop);
        }
      };
      req = mod.request(u, { method, headers, ...(signal ? { signal } : {}) }, (res) => {
        try {
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
          // the statuses fetch gives no body (Response refuses one for them)
          const empty = method === "HEAD" || status === 204 || status === 205 || status === 304;
          if (empty) res.resume();
          // a connection dropped mid-body errors this stream: the reader's next read rejects
          const response = new Response(empty ? null : Readable.toWeb(res, BODY_STRATEGY), { status, statusText: res.statusMessage ?? "", headers: got });
          // success only once the whole streamed body went out; a refusal or a redirect comes back as it is
          const done = { response, stop: () => req.destroy() };
          if (uploaded && status < 300) uploaded.then(() => resolve(done), reject);
          else resolve(done);
        } catch (e) {
          res.destroy();
          reject(e);
        }
      });
      req.on("error", reject);
      if (body === null) req.end();
      else if (body instanceof Uint8Array) req.end(body);
      else {
        uploaded = pump(body);
        uploaded.catch(reject);
      }
    });

  return (cached = async (input, init = {}) => {
    let u = new URL(String(input));
    let method = (init.method ?? "GET").toUpperCase();
    const headers: Record<string, string> = {};
    new Headers(init.headers ?? {}).forEach((value, name) => (headers[name] = value));
    // a body fetch would take (a string, a Blob, an ArrayBuffer…) as bytes; a stream is piped as it comes
    let body: Uint8Array | ReadableStream<Uint8Array> | null = null;
    if (init.body instanceof Uint8Array || init.body instanceof ReadableStream) body = init.body as Uint8Array | ReadableStream<Uint8Array>;
    else if (init.body !== null && init.body !== undefined) {
      const r = new Response(init.body);
      if (!headers["content-type"] && r.headers.get("content-type")) headers["content-type"] = r.headers.get("content-type")!;
      body = new Uint8Array(await r.arrayBuffer());
    }
    const mode = init.redirect ?? "follow";
    for (let hops = 0; ; hops++) {
      const { response: r, stop } = await send(u, method, headers, body, init.signal ?? undefined);
      const location = r.headers.get("location");
      if (!REDIRECTS.has(r.status) || location === null || mode === "manual") return r;
      await r.body?.cancel().catch(() => {});
      if (body instanceof ReadableStream) stop(); // its body is never sent twice: what is still going out stops
      if (mode === "error") throw new TypeError(`redirected (${r.status}) with redirect: "error"`);
      if (hops >= 20) throw new TypeError("too many redirects");
      const next = new URL(location, u);
      if (next.protocol !== "http:" && next.protocol !== "https:") throw new TypeError(`redirect to ${next.protocol} refused`);
      // as fetch: 303 (but for HEAD), and 301/302 after a POST, go on as a GET without the body
      if ((r.status === 303 && method !== "GET" && method !== "HEAD") || ((r.status === 301 || r.status === 302) && method === "POST")) {
        method = "GET";
        body = null;
        for (const h of ["content-type", "content-length", "content-encoding", "content-language", "content-location"]) delete headers[h];
      } else if (body instanceof ReadableStream) throw new TypeError(`a streamed body can't follow a ${r.status} redirect`);
      if (next.origin !== u.origin) delete headers["authorization"];
      u = next;
    }
  });
}

const REDIRECTS: ReadonlySet<number> = new Set([301, 302, 303, 307, 308]);

/** The fetch a blob client should default to: node:http(s) on Node, the global fetch elsewhere (wrapped, since
 * browsers and Workers throw "Illegal invocation" for a detached fetch). */
export function platformFetch(): BlobFetch {
  return nodeFetch() ?? ((input, init) => globalThis.fetch(input, init));
}
