// Small helpers shared by the media tests.

/** Deterministic pseudo-random bytes (xorshift), so a failure reproduces. */
export function seededBytes(n: number, seed: number): Uint8Array {
  const b = new Uint8Array(n);
  let x = (seed * 2654435761) >>> 0 || 1;
  for (let i = 0; i < n; i++) {
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    x >>>= 0;
    b[i] = x & 0xff;
  }
  return b;
}

export function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.byteLength !== b.byteLength) return false;
  for (let i = 0; i < a.byteLength; i++) if (a[i] !== b[i]) return false;
  return true;
}

export async function collect(it: AsyncIterable<Uint8Array>): Promise<Uint8Array> {
  const parts: Uint8Array[] = [];
  let n = 0;
  for await (const p of it) {
    parts.push(p.slice());
    n += p.length;
  }
  const out = new Uint8Array(n);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

export interface Call {
  method: string;
  url: URL;
  headers: Headers;
}

/** A fetch that records every request before passing it on. */
export function recordingFetch(inner: typeof fetch = fetch): { calls: Call[]; fetch: typeof fetch } {
  const calls: Call[] = [];
  return {
    calls,
    fetch: (input, init) => {
      const req = new Request(input, init);
      calls.push({ method: req.method, url: new URL(req.url), headers: req.headers });
      return inner(input, init);
    },
  };
}

/**
 * A fetch that flips the byte at `offset` of `key`'s signed-URL responses, `times` times, inside the response stream
 * (the way a bad link or a bad cache in between would), leaving everything else alone.
 */
export function corruptingFetch(projectId: string, key: string, offset: number, times = 1): typeof fetch {
  const path = `/blob/${projectId}/${key}`;
  let left = times;
  return async (input, init) => {
    const res = await fetch(input, init);
    const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
    if (left <= 0 || url.pathname !== path || !res.body || (res.status !== 200 && res.status !== 206)) return res;
    const start = res.status === 206 ? Number(/^bytes (\d+)-(\d+)/.exec(res.headers.get("content-range") ?? "")?.[1]) : 0;
    const length = Number(res.headers.get("content-length"));
    if (offset < start || offset >= start + length) return res;
    left--;
    let at = start;
    const flip = new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, ctl) {
        if (offset >= at && offset < at + chunk.length) {
          chunk = chunk.slice();
          chunk[offset - at] ^= 0xff;
        }
        at += chunk.length;
        ctl.enqueue(chunk);
      },
    });
    return new Response(res.body.pipeThrough(flip), { status: res.status, headers: res.headers });
  };
}
