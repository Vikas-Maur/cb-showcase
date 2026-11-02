// A proxy stream's batches in real workerd (cf-proxy-path): the Worker advertises its batch limits (PREVIEW_BATCH_*) in
// GET /api/host and every append's answer, and clamps reads; and a writer whose batch is stopped by a CPU cutoff, as
// Cloudflare's Free plan stops a request over 10 ms (error 1102: 503 "error code: 1102", the request's work cut partway,
// some of its writes landed), sends it again in smaller pieces and the stream comes out whole.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { createHmacAuth } from "@carton/server";
import { hostMediaBlobs } from "@carton/host-http/client";
import { MediaReader, MemoryLeafCache, ProxyStreamReader, ProxyStreamWriter, webCryptoHasher } from "@carton/media";
import { startDev, type DevServer } from "./dev-server.ts";
import { stateDir } from "./state.ts";

const SECRET = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url");
const dev: DevServer = await startDev({
  config: join(import.meta.dirname, "wrangler.r2.dev.toml"),
  state: stateDir(`dev-cutoff-${Date.now()}`),
  // a host that asks for big batches, so the cutoff below has something to stop
  vars: { AUTH_SECRET: SECRET, PREVIEW_BATCH_PARTS: "8", PREVIEW_BATCH_BYTES: "8388608", PREVIEW_READ_BYTES: "1048576" },
});
after(() => dev.stop());

const auth = createHmacAuth({ secret: SECRET });
const client = async (projectId: string) => hostMediaBlobs({ origin: dev.origin, projectId, token: await auth.issue({ account: "o", credential: "o/dev", role: "editor", projectId, ttlMs: 3600_000 }) });
const fill = (n: number, seed: number) => new Uint8Array(n).map((_, i) => (i * 31 + seed * 7 + (i >> 8)) & 0xff);

test("the Worker advertises its batch limits, in GET /api/host and in an append's answer", async () => {
  const host = (await (await fetch(`${dev.origin}/api/host`)).json()) as { streams?: unknown };
  assert.deepEqual(host.streams, { appendParts: 8, appendBytes: 8388608, readBytes: 1048576 });
  const media = await client("limits");
  const hasher = webCryptoHasher();
  const { mediaHash } = await import("@carton/media");
  const m = await mediaHash(fill(5000, 1), hasher);
  const answer = await media.appendStream("ab".repeat(32), { parts: [{ kind: "segment", hash: m.hash, size: m.size, manifest: m.bytes, bytes: fill(5000, 1), index: 0, durationSec: 2, at: 1 }] });
  assert.deepEqual(answer, { limits: { parts: 8, bytes: 8388608 } });
});

test("a batch stopped by a CPU cutoff (503, error code 1102, some writes landed) goes again in smaller pieces, and the stream comes out whole", async () => {
  assert.equal((await (await fetch(`${dev.origin}/__test/cpu-cutoff?parts=2`)).json() as { parts: number }).parts, 2);
  try {
    const media = await client("cutoff");
    const hasher = webCryptoHasher();
    const w = new ProxyStreamWriter({ store: media, hasher, upload: { retryDelayMs: 5 } });
    const segs = Array.from({ length: 12 }, (_, i) => fill(150_000 + i * 11, i + 2));
    await w.init(fill(800, 9));
    for (const s of segs) await w.segment(s, 2); // queued faster than appends land: batches of up to 8 form
    await w.end();
    const { cutoffs } = (await (await fetch(`${dev.origin}/__test/cpu-cutoff?parts=2`)).json()) as { cutoffs: number };
    assert.ok(cutoffs >= 1, "at least one batch was cut off");
    assert.equal(w.segments, 12);
    // the stream reads back whole, in order, through the batched reads (clamped to the host's 1 MiB)
    const r = new ProxyStreamReader({ store: media, media: new MediaReader({ store: media, hasher, cache: new MemoryLeafCache() }), id: w.id });
    const got: Uint8Array[] = [];
    for await (const p of r.play()) if (p.part === "segment") got.push(p.bytes);
    assert.equal(got.length, 12);
    got.forEach((b, i) => assert.deepEqual(b, segs[i], `segment ${i}`));
  } finally {
    await fetch(`${dev.origin}/__test/cpu-cutoff?parts=0`);
  }
});
