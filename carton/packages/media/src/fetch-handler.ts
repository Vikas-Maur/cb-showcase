// Shared media as a Fetch-API Response, so the player reads through the same verified range cache as the tools
// (PLAN §11): Electron's `protocol.handle("cardboard-media", (req) => serveMedia(reader, hash, req))` on desktop, and a
// Service Worker's `fetch` event on the web. Range requests get 206; the body streams with backpressure (the player's
// reads pull it); a leaf that fails verification after its bytes went out errors the body, so playback stops and the
// player's retry is served repaired; a cancelled body stops the read.

import { parseRange } from "./http-range.ts";
import type { RangeSource } from "./range-source.ts";

export interface ServeMediaOptions {
  /** Used when the source doesn't know the type. Players sniff MP4 anyway. */
  contentType?: string;
}

export async function serveMedia(source: RangeSource, hash: string, request: Request, opts: ServeMediaOptions = {}): Promise<Response> {
  if (request.method !== "GET" && request.method !== "HEAD") return new Response(null, { status: 405, headers: { allow: "GET, HEAD" } });
  const stat = await source.stat(hash, request.signal);
  if (!stat) return new Response(null, { status: 404 });
  const { size } = stat;
  const headers = new Headers({
    "accept-ranges": "bytes",
    "content-type": stat.contentType ?? opts.contentType ?? "application/octet-stream",
    "cache-control": "no-store",
    // Content-addressed, so the hash is a strong validator.
    etag: `"${hash}"`,
  });
  // As the loopback server: Range applies to GET only, If-Range with another validator means "send it all", and an
  // empty body is a 200 with nothing (what players cope with), not a 416.
  const ifRange = request.headers.get("if-range");
  const ignoreRange = request.method === "HEAD" || size === 0 || (ifRange !== null && ifRange !== headers.get("etag"));
  const span = ignoreRange ? null : parseRange(request.headers.get("range") ?? undefined, size);
  if (span === "unsatisfiable") {
    headers.set("content-range", `bytes */${size}`);
    return new Response(null, { status: 416, headers });
  }
  const start = span ? span.start : 0;
  const length = span ? span.end - span.start + 1 : size;
  headers.set("content-length", String(length));
  if (span) headers.set("content-range", `bytes ${span.start}-${span.end}/${size}`);
  const status = span ? 206 : 200;
  if (request.method === "HEAD" || length === 0) return new Response(null, { status, headers });

  const ac = new AbortController();
  const onAbort = () => ac.abort(request.signal.reason);
  request.signal?.addEventListener("abort", onAbort, { once: true });
  const it = source.read(hash, start, length, ac.signal)[Symbol.asyncIterator]();
  const body = new ReadableStream<Uint8Array>({
    async pull(ctl) {
      try {
        const r = await it.next();
        if (r.done) {
          request.signal?.removeEventListener("abort", onAbort);
          ctl.close();
        } else {
          // Chunks may be views into cached leaves. Enqueueing doesn't transfer them, and readers copy what they keep.
          ctl.enqueue(r.value);
        }
      } catch (e) {
        request.signal?.removeEventListener("abort", onAbort);
        ctl.error(e);
      }
    },
    async cancel(reason) {
      request.signal?.removeEventListener("abort", onAbort);
      ac.abort(reason);
      await it.return?.();
    },
  });
  return new Response(body, { status, headers });
}
