// A proxy stream through a Carton host (cf-proxy-path): published in batches, one request each (POST
// /streams/<id>/append), and read in batches (GET /streams/<id>/read), with the store's layout unchanged so the
// part-by-part path (older apps, a host from before the routes) reads and writes the same stream.
import { test } from "node:test";
import assert from "node:assert/strict";
import type { AuthContext, BlobStore } from "@carton/core/plugins";
import { createHmacAuth } from "@carton/server";
import { createMemoryBlobStore } from "@carton/blob-memory";
import {
  mediaHash,
  mediaKey,
  MediaReader,
  MemoryLeafCache,
  ProxyStreamReader,
  ProxyStreamWriter,
  streamEndKey,
  streamInitKey,
  streamSegmentKey,
  toBase64,
  webCryptoHasher,
  type PlayedPart,
} from "@carton/media";
import { handleHttp, projectMediaStore, type HttpDeps } from "../src/index.ts";
import { hostMediaBlobs } from "../src/client.ts";
import { headerFrame, splitFrame } from "../src/stream-wire.ts";

const SECRET = "test-only-secret-test-only-secret-0123";
const auth = createHmacAuth({ secret: SECRET });
const hasher = webCryptoHasher();
const fill = (n: number, seed: number) => new Uint8Array(n).map((_, i) => (i * 31 + seed * 7 + (i >> 8)) & 0xff);
const INIT = fill(900, 1);
const seg = (i: number) => fill(200_000 + i * 13, 10 + i);
const enc = new TextEncoder();

/** A host over one store, and a client fetch that counts requests by route. */
function host(store: BlobStore, over: Partial<HttpDeps> = {}) {
  const deps: HttpDeps = { auth, secret: SECRET, blobsFor: () => store, upgrade: async () => new Response(null, { status: 500 }), ...over };
  const seen: string[] = [];
  const fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const req = new Request(url, init);
    const u = new URL(req.url);
    seen.push(u.pathname.startsWith("/blob/") ? `signed-${req.method}` : `${req.method} ${u.pathname.replace(/^\/api\/projects\/[^/]+/, "").replace(/\/streams\/[0-9a-f]{64}/, "/streams/:id")}`);
    return (await handleHttp(req, deps)) ?? new Response(null, { status: 404 });
  }) as typeof globalThis.fetch;
  const token = (role: AuthContext["role"] = "editor", branches?: string[], projectId = "p") =>
    auth.issue({ account: "a", credential: "a/dev", role, projectId, ttlMs: 60_000, ...(branches ? { branches } : {}) });
  const client = async (role: AuthContext["role"] = "editor", branches?: string[]) => hostMediaBlobs({ origin: "http://host", projectId: "p", token: await token(role, branches), fetch });
  return { deps, seen, fetch, token, client };
}

const reader = (store: BlobStore, id: string, cache = new MemoryLeafCache()) =>
  new ProxyStreamReader({ store, media: new MediaReader({ store, hasher, cache }), id, pollMs: 5, maxPollMs: 20 });

async function playAll(r: ProxyStreamReader): Promise<PlayedPart[]> {
  const out: PlayedPart[] = [];
  for await (const p of r.play()) out.push(p);
  return out;
}

function assertStream(parts: PlayedPart[], n: number): void {
  assert.equal(parts.length, n + 1);
  assert.ok(parts[0]!.part === "init");
  assert.deepEqual(parts[0]!.bytes, INIT);
  for (let i = 0; i < n; i++) {
    const p = parts[i + 1]!;
    assert.ok(p.part === "segment" && p.segment.index === i, `segment ${i}`);
    assert.deepEqual(p.bytes, seg(i), `segment ${i}'s bytes`);
  }
}

test("a stream published through the host goes up in batches, one request each, and reads back the same through both paths", async () => {
  const store = createMemoryBlobStore();
  const { seen, client } = host(store);
  const media = await client();
  const w = new ProxyStreamWriter({ store: media, hasher });
  await w.init(INIT);
  for (let i = 0; i < 6; i++) await w.segment(seg(i), 2);
  const end = await w.end();
  assert.equal(w.segments, 6);
  const appends = seen.filter((s) => s === "POST /streams/:id/append").length;
  assert.ok(appends >= 1 && appends <= 7, `${appends} appends for 7 parts and the end`);
  assert.deepEqual(seen.filter((s) => s !== "POST /streams/:id/append" && s !== "POST /blobs/heads"), [], `only appends and the dedup probe: ${seen}`);
  assert.ok(seen.filter((s) => s === "POST /blobs/heads").length <= 1, "one dedup probe at most");
  // the layout media has always used: an entry per part, the bytes and manifest under their hash
  assert.ok(await store.head(streamInitKey(w.id)));
  for (let i = 0; i < 6; i++) assert.ok(await store.head(streamSegmentKey(w.id, i)));
  assert.deepEqual(JSON.parse(new TextDecoder().decode((await store.get(streamEndKey(w.id)))!)), end);
  // read straight from the store, entry by entry (an older app's reader, any store)
  assertStream(await playAll(reader(store, w.id)), 6);
  // read through the host, in batches
  seen.length = 0;
  assertStream(await playAll(reader(await client("viewer"), w.id)), 6);
  const reads = seen.filter((s) => s === "GET /streams/:id/read").length;
  assert.ok(reads >= 2 && reads <= 3, `${reads} reads: the first frame's, then the rest (${seen})`);
  assert.deepEqual(seen.filter((s) => s !== "GET /streams/:id/read"), [], "no request per entry, manifest or segment");
});

test("an older app's part-by-part stream reads through the batch route (manifests fetched by the host), and the layout comes from one end entry", async () => {
  const store = createMemoryBlobStore();
  const w = new ProxyStreamWriter({ store, hasher, batch: false }); // straight into the store, as through any store
  await w.init(INIT);
  for (let i = 0; i < 4; i++) await w.segment(seg(i), 2);
  await w.end();
  // entries as older writers wrote them: no manifest
  for (const k of [streamInitKey(w.id), ...[0, 1, 2, 3].map((i) => streamSegmentKey(w.id, i))]) {
    const v = JSON.parse(new TextDecoder().decode((await store.get(k))!));
    delete v.manifest;
    await store.put(k, enc.encode(JSON.stringify(v)));
  }
  const { seen, client } = host(store);
  assertStream(await playAll(reader(await client("viewer"), w.id)), 4);
  assert.ok(seen.every((s) => s === "GET /streams/:id/read"), `${seen}`);
  seen.length = 0;
  const r = reader(await client("viewer"), w.id);
  assert.equal((await r.known()).length, 4);
  assert.ok(seen.length <= 2, `the layout of a finished stream: ${seen}`);
});

test("a live reader is held at the edge and gets each batch as it lands, without polling every entry", async () => {
  const store = createMemoryBlobStore();
  const { seen, client } = host(store);
  const w = new ProxyStreamWriter({ store: await client(), hasher });
  await w.init(INIT);
  await w.segment(seg(0), 2);
  await w.flush();
  const got: number[] = [];
  const r = reader(await client("viewer"), w.id);
  const playing = (async () => {
    for await (const p of r.play()) if (p.part === "segment") got.push(p.segment.index);
  })();
  await new Promise((res) => setTimeout(res, 300));
  assert.deepEqual(got, [0]);
  seen.length = 0;
  for (let i = 1; i < 4; i++) {
    await w.segment(seg(i), 2);
    await w.flush();
    await new Promise((res) => setTimeout(res, 1300)); // the host checks once a second
  }
  await w.end();
  await playing;
  assert.deepEqual(got, [0, 1, 2, 3]);
  const reads = seen.filter((s) => s === "GET /streams/:id/read").length;
  assert.ok(reads <= 8, `${reads} reads for 3 segments over ~4 s at the edge`);
});

test("only editors append; a session reads only its project's streams, and a watch link scoped to cuts can't read one", async () => {
  const store = createMemoryBlobStore();
  const { fetch, token, client } = host(store);
  const w = new ProxyStreamWriter({ store: await client(), hasher });
  await w.init(INIT);
  await w.segment(seg(0), 2);
  await w.end();
  const viewer = new ProxyStreamWriter({ store: await client("viewer"), hasher, upload: { retries: 0 } });
  await viewer.init(INIT);
  await assert.rejects(viewer.segment(seg(0), 2).then(() => viewer.flush()), (e: { status?: number }) => e.status === 403);
  const read = (tok: string, project = "p") => fetch(`http://host/api/projects/${project}/streams/${w.id}/read?from=0&init=1`, { headers: { authorization: `Bearer ${tok}` } });
  assert.equal((await read(await token("viewer"))).status, 200);
  assert.equal((await read(await token("viewer", undefined, "q"), "p")).status, 403, "another project's session");
  assert.equal((await read(await token("viewer", ["published"]))).status, 403, "a watch link reads only content keys and its cuts");
  assert.equal((await fetch(`http://host/api/projects/p/streams/${w.id}/read`)).status, 401);
  assert.equal((await fetch(`http://host/api/projects/p/streams/not-a-stream/read`, { headers: { authorization: `Bearer ${await token()}` } })).status, 400);
});

test("a team host: a read of a part this project wasn't granted sends no bytes, and the client's own read finds nothing either", async () => {
  const root = createMemoryBlobStore();
  const a = projectMediaStore(root, "p", "t1");
  const { client } = host(a);
  const w = new ProxyStreamWriter({ store: await client(), hasher });
  await w.init(INIT);
  await w.segment(seg(0), 2);
  await w.end();
  assertStream(await playAll(reader(await client("viewer"), w.id)), 1);
  // the bytes went to the team's scope, granted to this project by the write
  const h0 = (await mediaHash(seg(0), hasher)).hash;
  assert.ok(await root.head(`teams/t1/media/m/${h0}`));
  assert.ok(await root.head(`projects/p/grants/${h0}`));
  await root.delete(`projects/p/grants/${h0}`);
  await assert.rejects(playAll(reader(await client("viewer"), w.id)), { name: "MediaMissingError" });
});

test("a retried append is kept (same entries); another writer's entry at the same index is a 409, and nothing of the batch is lost", async () => {
  const store = createMemoryBlobStore();
  const { fetch, token, client } = host(store);
  const id = "c".repeat(64);
  const part = async (i: number, at = 1) => {
    const m = await mediaHash(seg(i), hasher);
    return { kind: "segment" as const, hash: m.hash, size: m.size, manifest: m.bytes, bytes: seg(i), index: i, durationSec: 2, at };
  };
  const media = await client();
  await media.appendStream(id, { parts: [await part(0), await part(1)] });
  await media.appendStream(id, { parts: [await part(0, 999), await part(1)] }); // the same parts, retried
  // index 1 with other content
  const other = await mediaHash(fill(1000, 77), hasher);
  await assert.rejects(
    media.appendStream(id, { parts: [{ kind: "segment", hash: other.hash, size: other.size, manifest: other.bytes, bytes: fill(1000, 77), index: 1, durationSec: 2, at: 1 }] }),
    (e: { status?: number; code?: string }) => e.status === 409 && e.code === "Conflict",
  );
  const r = await fetch(`http://host/api/projects/p/streams/${id}/read?from=0&bytes=0`, { headers: { authorization: `Bearer ${await token()}` } });
  const { header } = splitFrame(new Uint8Array(await r.arrayBuffer()));
  assert.deepEqual((header as { segments: { hash: string }[] }).segments.map((s) => s.hash), [(await part(0)).hash, (await part(1)).hash]);
});

test("a part sent without its bytes must be stored, the right size and not reported damaged; else 409 Missing, and the writer sends the bytes", async () => {
  const store = createMemoryBlobStore();
  const { client, seen } = host(store);
  const media = await client();
  const m0 = await mediaHash(seg(0), hasher);
  const ref = { kind: "segment" as const, hash: m0.hash, size: m0.size, manifest: m0.bytes, bytes: null, index: 0, durationSec: 2, at: 1 };
  await assert.rejects(media.appendStream("d".repeat(64), { parts: [ref] }), { name: "StreamPartMissingError" });
  await store.put(mediaKey(m0.hash), seg(0));
  await store.put(`bad/${m0.hash}`, enc.encode('{"leaf":0}'));
  await assert.rejects(media.appendStream("d".repeat(64), { parts: [ref] }), { name: "StreamPartMissingError" }, "reported damaged");
  await store.delete(`bad/${m0.hash}`);
  await media.appendStream("d".repeat(64), { parts: [ref] });
  assert.ok(await store.head(streamSegmentKey("d".repeat(64), 0)));

  // a writer re-encoding the same source (a takeover) sends no bytes it finds stored, and the bytes when a part vanished
  seen.length = 0;
  const w = new ProxyStreamWriter({ store: media, hasher });
  await w.init(INIT);
  await w.segment(seg(0), 2);
  await w.flush();
  assert.equal(seen.filter((s) => s === "POST /blobs/heads").length, 0, "the first frame's batch waits for no probe");
  await w.segment(seg(1), 2);
  await w.flush();
  assert.equal(seen.filter((s) => s === "POST /blobs/heads").length, 1, "the next one is probed");
  await w.segment(seg(2), 2);
  await w.end();
  assertStream(await playAll(reader(store, w.id)), 3);
  assert.equal(seen.filter((s) => s === "POST /blobs/heads").length, 1, "the probe stops once it finds nothing");
});

test("a host from before the stream routes: the writer and the reader go part by part, and the stream is the same", async () => {
  const store = createMemoryBlobStore();
  const old = host(store);
  // the routes answer as an older host's unknown route
  const fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const u = new URL(new Request(url, init).url);
    if (u.pathname.includes("/streams/")) return new Response(JSON.stringify({ error: "no such route" }), { status: 404, headers: { "content-type": "application/json" } });
    return old.fetch(url, init);
  }) as typeof globalThis.fetch;
  const media = hostMediaBlobs({ origin: "http://host", projectId: "p", token: await old.token(), fetch });
  const w = new ProxyStreamWriter({ store: media, hasher });
  await w.init(INIT);
  for (let i = 0; i < 3; i++) await w.segment(seg(i), 2);
  await w.end();
  assertStream(await playAll(reader(store, w.id)), 3);
  const viewer = hostMediaBlobs({ origin: "http://host", projectId: "p", token: await old.token("viewer"), fetch });
  assertStream(await playAll(reader(viewer, w.id)), 3);
});

test("append checks every part before writing anything: shapes, order, manifests, sizes and the bytes that follow", async () => {
  const store = createMemoryBlobStore();
  const { fetch, token } = host(store);
  const id = "e".repeat(64);
  const m0 = await mediaHash(seg(0), hasher), m1 = await mediaHash(seg(1), hasher);
  const p = (m: typeof m0, i: number, extra: Record<string, unknown> = {}) => ({ kind: "segment", hash: m.hash, size: m.size, manifest: toBase64(m.bytes), bytes: true, index: i, durationSec: 2, at: 1, ...extra });
  const send = async (header: unknown, ...bodies: Uint8Array[]) => {
    const head = headerFrame(header);
    const all = new Uint8Array(head.length + bodies.reduce((n, b) => n + b.length, 0));
    all.set(head, 0);
    let at = head.length;
    for (const b of bodies) all.set(b, (at += b.length) - b.length);
    return (await fetch(`http://host/api/projects/p/streams/${id}/append`, { method: "POST", body: all, headers: { authorization: `Bearer ${await token()}` } })).status;
  };
  assert.equal(await send({ v: 2, parts: [p(m0, 0)] }, seg(0)), 400, "wire version");
  assert.equal(await send({ v: 1, parts: [p(m0, 0), p(m1, 2)] }, seg(0), seg(1)), 400, "indexes that skip");
  assert.equal(await send({ v: 1, parts: [p(m0, 0, { manifest: toBase64(m1.bytes) })] }, seg(0)), 400, "a manifest for other bytes");
  assert.equal(await send({ v: 1, parts: [p(m0, 0, { size: 5 })] }, seg(0)), 400, "a size its manifest doesn't say");
  assert.equal(await send({ v: 1, parts: [p(m0, 0)] }, seg(0).subarray(1)), 400, "short bytes");
  assert.equal(await send({ v: 1, parts: [p(m0, 0)] }, seg(0), new Uint8Array(3)), 400, "extra bytes");
  assert.equal(await send({ v: 1, parts: [p(m0, 0)], end: { segments: 5, durationSec: 2, size: 1, at: 1 } }, seg(0)), 400, "an end that doesn't follow the last segment");
  assert.equal(await send({ v: 1, parts: [{ ...p(m0, 0), kind: "init" }, { ...p(m1, 1), kind: "init" }] }, seg(0), seg(1)), 400, "two init segments");
  assert.deepEqual((await store.list("")).blobs, [], "nothing written");
  assert.equal(await send({ v: 1, parts: [p(m0, 0), p(m1, 1)] }, seg(0), seg(1)), 200);
});

test("the write cap is reserved once per append, for all of its writes", async () => {
  const store = createMemoryBlobStore();
  const asked: [number, number][] = [];
  const { client } = host(store, {
    blobsForWrites: async (_p, bytes, ops) => {
      asked.push([bytes, ops]);
      return store;
    },
  });
  const media = await client();
  const m0 = await mediaHash(seg(0), hasher), m1 = await mediaHash(seg(1), hasher);
  await media.appendStream("f".repeat(64), {
    parts: [
      { kind: "segment", hash: m0.hash, size: m0.size, manifest: m0.bytes, bytes: seg(0), index: 0, durationSec: 2, at: 1 },
      { kind: "segment", hash: m1.hash, size: m1.size, manifest: m1.bytes, bytes: seg(1), index: 1, durationSec: 2, at: 1 },
    ],
    end: { segments: 2, durationSec: 4, size: m0.size + m1.size, at: 2 },
  });
  assert.equal(asked.length, 1);
  const [bytes, ops] = asked[0]!;
  assert.equal(ops, 7, "a manifest, the bytes and an entry per part; the end");
  const stored = (await store.list("")).blobs.reduce((n, b) => n + b.size, 0);
  assert.equal(bytes, stored, "exactly what was stored");
});

// ---------------------------------------------------------------------------------------- review round (cf-proxy-path)

const segPart = async (i: number, extra: Record<string, unknown> = {}) => {
  const m = await mediaHash(seg(i), hasher);
  return { kind: "segment" as const, hash: m.hash, size: m.size, manifest: m.bytes, bytes: seg(i) as Uint8Array | null, index: i, durationSec: 2, at: 1, ...extra };
};

test("every object an append writes is held to the host's per-object limit: an end entry over maxUploadBytes is 413", async () => {
  const store = createMemoryBlobStore();
  const { client } = host(store, { maxUploadBytes: 300_000 });
  const media = await client();
  const p0 = await segPart(0);
  // the host writes the end as it reads it (unknown fields dropped), so only its lists can make it big
  const big = { segments: 10_000, durationSec: 20_000, size: p0.size * 10_001, at: 1, parts: Array(10_001).fill(p0.hash) };
  await assert.rejects(media.appendStream("a1".repeat(32), { parts: [], end: big }), (e: { status?: number }) => e.status === 413);
  assert.deepEqual((await store.list("")).blobs, [], "nothing written");
});

test("a held read whose client goes away stops checking the store", async () => {
  const store = createMemoryBlobStore();
  let gets = 0;
  const counting = new Proxy(store, { get: (t, p) => (p === "get" ? (...a: [string]) => (gets++, t.get(...a)) : Reflect.get(t, p, t)) });
  const { deps, token } = host(counting as BlobStore);
  const ac = new AbortController();
  const t0 = Date.now();
  setTimeout(() => ac.abort(), 1500);
  const r = await handleHttp(new Request(`http://host/api/projects/p/streams/${"b1".repeat(32)}/read?from=0&wait=20000`, { headers: { authorization: `Bearer ${await token()}` }, signal: ac.signal }), deps);
  assert.ok(Date.now() - t0 < 5000, `answered ${Date.now() - t0} ms after it started`);
  assert.equal(r?.status, 499);
  assert.ok(gets <= 6, `${gets} reads`);
});

test("batched playback: an entry gone from a finished stream whose end lists it plays from the end, not reported damaged", async () => {
  const store = createMemoryBlobStore();
  const { client } = host(store);
  const w = new ProxyStreamWriter({ store: await client(), hasher });
  await w.init(INIT);
  for (let i = 0; i < 3; i++) await w.segment(seg(i), 2);
  await w.end();
  await store.delete(streamSegmentKey(w.id, 1));
  assertStream(await playAll(reader(await client(), w.id)), 3);
  assert.equal(await store.head(`bad/${w.id}`), null, "not reported");
});

test("a read keeps its header under what the client takes: a long stream's end goes without its lists, then tail entries go", async () => {
  const store = createMemoryBlobStore();
  const { client, fetch, token } = host(store);
  const id = "c1".repeat(32);
  const n = 16_000; // an end listing 16,000 parts is ~1.5 MB of JSON
  const m0 = await mediaHash(seg(0), hasher);
  for (let i = 0; i < 200; i++) await store.put(streamSegmentKey(id, i), enc.encode(JSON.stringify({ hash: m0.hash, size: m0.size, index: i, durationSec: 2, at: 1, manifest: toBase64(m0.bytes) })));
  const end = { segments: n, durationSec: 2 * n, size: m0.size * (n + 1), at: 1, parts: Array(n + 1).fill(m0.hash), sizes: Array(n + 1).fill(m0.size), durations: Array(n).fill(2) };
  await store.put(streamEndKey(id), enc.encode(JSON.stringify(end)));
  // entries only, from 0: 200 entries, then the edge (entry 200 isn't there) and the end
  const items = [];
  for await (const it of (await client()).readStream(id, { from: 0, maxBytes: 0, maxParts: 1000 })) items.push(it);
  const status = items.at(-1) as { kind: string; end?: { segments: number; parts?: unknown } };
  assert.equal(status.kind, "status");
  assert.equal(status.end?.segments, n);
  assert.equal(status.end?.parts, undefined, "the lists dropped to fit");
  const r = await fetch(`http://host/api/projects/p/streams/${id}/read?from=0&bytes=0`, { headers: { authorization: `Bearer ${await token()}` } });
  assert.ok(new DataView(await r.arrayBuffer()).getUint32(0) <= 1 << 20);
});

test("a retried append must carry the same entry: another duration for a segment, or another end, is a 409", async () => {
  const store = createMemoryBlobStore();
  const media = await host(store).client();
  const id = "d1".repeat(32);
  const p0 = await segPart(0);
  await media.appendStream(id, { parts: [p0], end: { segments: 1, durationSec: 2, size: p0.size, at: 1, parts: [p0.hash, p0.hash] } });
  await media.appendStream(id, { parts: [p0], end: { segments: 1, durationSec: 2, size: p0.size, at: 9, parts: [p0.hash, p0.hash] } }); // a retry
  await assert.rejects(media.appendStream(id, { parts: [{ ...p0, durationSec: 1.5 }] }), (e: { status?: number }) => e.status === 409);
  await assert.rejects(media.appendStream(id, { parts: [], end: { segments: 1, durationSec: 2, size: p0.size, at: 1, parts: [p0.hash, "e".repeat(64)] } }), (e: { status?: number }) => e.status === 409);
});

test("a part sent again after a Missing answer for a damage report answers the report, so later dedup finds it stored", async () => {
  const store = createMemoryBlobStore();
  const { client } = host(store);
  const media = await client();
  const p0 = await segPart(0);
  await store.put(mediaKey(p0.hash), seg(0));
  await store.put(`bad/${p0.hash}`, enc.encode('{"leaf":0,"nonce":"1"}'));
  // the writer's own path: found stored by the probe, refused as reported, sent again with its bytes
  const w = new ProxyStreamWriter({ store: media, hasher });
  await w.init(INIT);
  await w.segment(seg(5), 2); // the first frame's batch (no probe)
  await w.flush();
  await w.segment(seg(0), 2);
  await w.end();
  assert.ok(await store.head(`repaired/${p0.hash}`), "the report is answered");
  await media.appendStream("e1".repeat(32), { parts: [{ ...p0, bytes: null }] });
  assert.ok(await store.head(streamSegmentKey("e1".repeat(32), 0)), "a later append that sends no bytes is taken");
});

test("a team host's append reserves its grants' writes too, in the one reservation", async () => {
  const root = createMemoryBlobStore();
  const a = projectMediaStore(root, "p", "t1");
  const asked: [number, number][] = [];
  const media = await host(a, { blobsForWrites: async (_p, b, o) => (asked.push([b, o]), a) }).client();
  await media.appendStream("f1".repeat(32), { parts: [await segPart(0), await segPart(1)] });
  assert.deepEqual(asked.map(([, o]) => o), [10], "manifest, bytes and entry per part, and a grant beside each of the first two");
});
