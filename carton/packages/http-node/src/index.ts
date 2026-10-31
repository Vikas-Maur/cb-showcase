// @carton/http-node: the fetch every Carton blob client uses (blob-s3's S3 client, host-http's media and envelope
// clients), with no dependencies. On Node, requests go through node:http and node:https, not the global fetch (CI #29).
// Node's built-in undici, behind fetch, meets a paused parser when a server ends the connection while the reader has paused the body: in CI it threw an
// uncaught `AssertionError: assert(!this.paused)` from its own socket handler (no caller can catch it, the process
// dies), and here the read never settles. node:http reports the same drop as an error on the response stream, so the
// read rejects. Workers and browsers keep fetch.
//
// The modules come from `process.getBuiltinModule`, so nothing here imports `node:*`: bundles for other platforms
// stay clean, and this file typechecks without Node's types (the few shapes it uses are declared below).
// Differences from fetch, none of which the blob clients rely on: no redirects followed, no Accept-Encoding sent (so
// bodies come as stored), no cookies or cache.

interface IncomingMessage {
  statusCode?: number;
  statusMessage?: string;
  headers: Record<string, string | string[] | undefined>;
  resume(): void;
  destroy(error?: Error): void;
}
interface ClientRequest {
  on(event: "error" | "close" | "drain", listener: (error?: Error) => void): void;
  off(event: "close" | "drain", listener: () => void): void;
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

  return (cached = async (input, init = {}) => {
    const u = new URL(String(input));
    const mod = u.protocol === "https:" ? https : http;
    const method = (init.method ?? "GET").toUpperCase();
    const headers: Record<string, string> = {};
    new Headers(init.headers ?? {}).forEach((value, name) => (headers[name] = value));
    // a body fetch would take (a string, a Blob, an ArrayBuffer…) as bytes; a stream is piped as it comes
    let body = init.body ?? null;
    if (body !== null && !(body instanceof Uint8Array) && !(body instanceof ReadableStream)) {
      const r = new Response(body);
      if (!headers["content-type"] && r.headers.get("content-type")) headers["content-type"] = r.headers.get("content-type")!;
      body = new Uint8Array(await r.arrayBuffer());
    }
    let req!: ClientRequest;
    // a streamed body: sent chunk by chunk, counted against its declared content-length (more or fewer bytes fail the
    // request, never store a prefix), and done only once the source has ended and the request is flushed
    const pump = async (source: ReadableStream<Uint8Array>): Promise<void> => {
      const declared = headers["content-length"] === undefined ? undefined : Number(headers["content-length"]);
      const reader = source.getReader();
      let sent = 0;
      try {
        for (;;) {
          const { done, value } = await reader.read();
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
        reader.cancel(e).catch(() => {});
        req.destroy(e as Error);
        throw e;
      }
    };
    let uploaded: Promise<void> | null = null;
    return new Promise<Response>((resolve, reject) => {
      req = mod.request(u, { method, headers, ...(init.signal ? { signal: init.signal } : {}) }, (res) => {
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
        const empty = method === "HEAD" || status === 204 || status === 304;
        if (empty) res.resume();
        // a connection dropped mid-body errors this stream: the reader's next read rejects
        const response = new Response(empty ? null : Readable.toWeb(res, BODY_STRATEGY), { status, statusText: res.statusMessage ?? "", headers: got });
        // success only once the whole streamed body went out; a refusal comes back as it is
        if (uploaded && status < 300) uploaded.then(() => resolve(response), reject);
        else resolve(response);
      });
      req.on("error", reject);
      if (body === null) req.end();
      else if (body instanceof Uint8Array) req.end(body);
      else {
        uploaded = pump(body as ReadableStream<Uint8Array>);
        uploaded.catch(reject);
      }
    });
  });
}

/** The fetch a blob client should default to: node:http(s) on Node, the global fetch elsewhere (wrapped, since
 * browsers and Workers throw "Illegal invocation" for a detached fetch). */
export function platformFetch(): BlobFetch {
  return nodeFetch() ?? ((input, init) => globalThis.fetch(input, init));
}
