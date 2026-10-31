// The BlobStore suite against blob-r2, on workerd's local R2 (wrangler's getPlatformProxy): R2's own rules, such as
// the 5 MiB part minimum and its range errors, apply.
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { getPlatformProxy } from "wrangler";
import { blobStoreSuite } from "@carton/conformance";
import { createBlobUrlSigner, serveSignedBlob } from "@carton/blob-memory/signed";
import { r2BlobStore, R2_MIN_PART_SIZE } from "../src/blob-r2.ts";
import type { R2Bucket } from "../src/cf.ts";
import { stateDir } from "./state.ts";

const proxy = await getPlatformProxy<{ BLOBS: R2Bucket }>({ configPath: join(import.meta.dirname, "wrangler.r2.toml"), persist: { path: stateDir("r2") } });

after(() => proxy.dispose());

blobStoreSuite("r2 (local workerd)", async () => r2BlobStore(proxy.env.BLOBS), { minPartSize: R2_MIN_PART_SIZE });

// Signed URLs: the store signs, `serveSignedBlob` answers (the Worker's /blob route), here called in-process.
const signer = createBlobUrlSigner({ secret: "test-secret-test-secret-test-secret!", baseUrl: "https://carton.test/blob" });
const signedStore = r2BlobStore(proxy.env.BLOBS, { signer });
blobStoreSuite("r2 with signed URLs", async () => signedStore, {
  minPartSize: R2_MIN_PART_SIZE,
  fetch: (async (input: string | URL | Request, init?: RequestInit) => serveSignedBlob(new Request(input, init), signedStore, signer)) as typeof fetch,
  expiryWaitMs: 2100,
});

test("a part replaced while its record write fails is not listed with a dead etag; a resume sends it again", async () => {
  const real = proxy.env.BLOBS;
  let failMarker = false;
  const flaky = new Proxy(real, {
    get(t, prop) {
      if (prop === "put")
        return (k: string, v: unknown, o: unknown) => {
          if (failMarker && k.startsWith(".carton-uploads/") && /\/p\d{5}$/.test(k)) throw new Error("injected marker failure");
          return (t.put as (...a: unknown[]) => unknown)(k, v, o);
        };
      const v = Reflect.get(t, prop);
      return typeof v === "function" ? v.bind(t) : v;
    },
  }) as R2Bucket;
  const store = r2BlobStore(flaky);
  const up = await store.createMultipart("fault/part-replace");
  await up.uploadPart(1, new Uint8Array(R2_MIN_PART_SIZE).fill(1));
  failMarker = true;
  await assert.rejects(up.uploadPart(1, new Uint8Array(R2_MIN_PART_SIZE).fill(2)), /injected/);
  failMarker = false;
  const resumed = await store.resumeMultipart("fault/part-replace", up.uploadId);
  assert.deepEqual((await resumed.listParts()).map((p) => p.partNumber), [], "the replaced part is listed with a stale etag");
  const p1 = await resumed.uploadPart(1, new Uint8Array(R2_MIN_PART_SIZE).fill(3));
  const p2 = await resumed.uploadPart(2, new Uint8Array(10).fill(4));
  const info = await resumed.complete([p1, p2]);
  assert.equal(info.size, R2_MIN_PART_SIZE + 10);
  await store.delete("fault/part-replace");
});

// A bucket whose puts can be held until released, to replay an exact interleaving. A hold catches the first put
// its matcher accepts; `engaged()` tells when it has.
function holdable(real: R2Bucket) {
  const holds: { match: (k: string, o: { onlyIf?: { etagMatches?: string } } | undefined) => boolean; gate: Promise<void>; engaged: boolean }[] = [];
  const bucket = new Proxy(real, {
    get(t, prop) {
      if (prop === "put")
        return async (k: string, v: unknown, o: { onlyIf?: { etagMatches?: string } } | undefined) => {
          const h = holds.find((x) => !x.engaged && x.match(k, o));
          if (h) {
            h.engaged = true;
            await h.gate;
          }
          return (t.put as (...a: unknown[]) => unknown)(k, v, o);
        };
      const val = Reflect.get(t, prop);
      return typeof val === "function" ? val.bind(t) : val;
    },
  }) as R2Bucket;
  const hold = (match: (k: string, o: { onlyIf?: { etagMatches?: string } } | undefined) => boolean) => {
    let release!: () => void;
    const h = { match, gate: new Promise<void>((r) => (release = r)), engaged: false };
    holds.push(h);
    return { release: () => release(), engaged: () => h.engaged };
  };
  return { bucket, hold };
}
const isLock = (k: string) => /\/l00001$/.test(k);
const isRecord = (k: string) => /\/p00001$/.test(k);
const until = async (cond: () => boolean) => {
  while (!cond()) await new Promise((r) => setTimeout(r, 10));
};

test("overlapping uploads of one part: one at a time, so its record names the bytes R2 kept (A, B, C)", async () => {
  const { bucket, hold } = holdable(proxy.env.BLOBS);
  const store = r2BlobStore(bucket);
  const up = await store.createMultipart("fault/overlap");
  const a1 = hold((k) => isRecord(k)); // A's record write waits, A's part already in R2
  const releaseA = a1.release;
  const a = up.uploadPart(1, new Uint8Array(R2_MIN_PART_SIZE).fill(1));
  await new Promise((r) => setTimeout(r, 300));
  await assert.rejects(up.uploadPart(1, new Uint8Array(R2_MIN_PART_SIZE).fill(2)), /being uploaded/, "B overlapped A");
  await assert.rejects(up.uploadPart(1, new Uint8Array(R2_MIN_PART_SIZE).fill(3)), /being uploaded/, "C overlapped A");
  releaseA();
  const pa = await a;
  assert.deepEqual((await up.listParts()).map((p) => p.etag), [pa.etag]);
  // after A, a replacement goes through and its record follows it
  const pb = await up.uploadPart(1, new Uint8Array(R2_MIN_PART_SIZE).fill(2));
  assert.deepEqual((await up.listParts()).map((p) => p.etag), [pb.etag]);
  const last = await up.uploadPart(2, new Uint8Array(10));
  await up.complete([pb, last]);
  assert.deepEqual([...(await store.get("fault/overlap", { offset: 0, length: 4 }))!], [2, 2, 2, 2]);
  assert.deepEqual((await proxy.env.BLOBS.list({ prefix: `.carton-uploads/${up.uploadId}/` })).objects, [], "records left after complete");
  await store.delete("fault/overlap");
});

test("two requests taking over the same stale lock: exactly one wins (each holder writes a fresh token)", async () => {
  const { bucket, hold } = holdable(proxy.env.BLOBS);
  const store = r2BlobStore(bucket);
  const up = await store.createMultipart("fault/two-takers");
  // a dead holder's lock with an empty body: if a takeover only rewrote the metadata, its etag wouldn't change and both
  // takers' compare-and-swaps would match
  await proxy.env.BLOBS.put(`.carton-uploads/${up.uploadId}/l00001`, null, { customMetadata: { state: "held", at: String(Date.now() - 2 * 3600_000) } });
  const t1cas = hold((k, o) => isLock(k) && !!o?.onlyIf?.etagMatches); // taker 1's compare-and-swap waits
  const t1 = up.uploadPart(1, new Uint8Array(R2_MIN_PART_SIZE).fill(1));
  await until(t1cas.engaged);
  const t2rec = hold((k) => isRecord(k)); // taker 2 gets the lock and waits at its record write
  const t2 = up.uploadPart(1, new Uint8Array(R2_MIN_PART_SIZE).fill(2));
  await until(t2rec.engaged);
  t1cas.release();
  await assert.rejects(t1, /being uploaded/, "both takers won the same stale lock");
  t2rec.release();
  const p2 = await t2;
  assert.deepEqual((await up.listParts()).map((p) => p.etag), [p2.etag]);
  await up.abort();
});

test("a holder that outlived its lock can neither release the new holder's lock nor leave a stale record", async () => {
  const { bucket, hold } = holdable(proxy.env.BLOBS);
  const store = r2BlobStore(bucket);
  const up = await store.createMultipart("fault/outlived");
  const aRec = hold((k) => isRecord(k)); // A has its lock and its part is in R2; it stalls before its record
  const a = up.uploadPart(1, new Uint8Array(R2_MIN_PART_SIZE).fill(1));
  await until(aRec.engaged);
  // A's lock expires (rewritten with an old time, as after 30 minutes)
  await proxy.env.BLOBS.put(`.carton-uploads/${up.uploadId}/l00001`, "expired", { customMetadata: { state: "held", at: String(Date.now() - 2 * 3600_000) } });
  const bRec = hold((k) => isRecord(k)); // B takes over, replaces the part, and stalls before its record
  const b = up.uploadPart(1, new Uint8Array(R2_MIN_PART_SIZE).fill(2));
  await until(bRec.engaged);
  aRec.release(); // A's late record: there is none yet (B removed it), so A's is created...
  const ra = await a.then((x) => x, (e: Error) => e);
  bRec.release(); // ...and B then finds it: B clears it and fails
  const rb = await b.then((x) => x, (e: Error) => e);
  assert.ok(rb instanceof Error && /same time/.test(rb.message), `B: ${String(rb)}`);
  const lock = await proxy.env.BLOBS.head(`.carton-uploads/${up.uploadId}/l00001`);
  assert.equal(lock?.customMetadata?.state, "released", "B released its own lock; A, which lost it, changed nothing");
  // the part is unlisted, never listed with an etag R2 doesn't hold, so it is sent again
  const listed = await up.listParts();
  assert.deepEqual(listed, [], `stale record left: ${JSON.stringify(listed)} (A returned ${ra instanceof Error ? ra.message : ra.etag})`);
  const p1 = await up.uploadPart(1, new Uint8Array(R2_MIN_PART_SIZE).fill(3));
  const p2 = await up.uploadPart(2, new Uint8Array(10));
  await up.complete([p1, p2]);
  assert.deepEqual([...(await store.get("fault/outlived", { offset: 0, length: 2 }))!], [3, 3]);
  await store.delete("fault/outlived");
});

test("a lock left by a request that died is taken over after its TTL", async () => {
  const store = r2BlobStore(proxy.env.BLOBS);
  const up = await store.createMultipart("fault/stale-lock");
  await proxy.env.BLOBS.put(`.carton-uploads/${up.uploadId}/l00001`, "dead-holder", { customMetadata: { state: "held", at: String(Date.now() - 2 * 3600_000) } });
  const p1 = await up.uploadPart(1, new Uint8Array(10));
  await up.complete([p1]);
  await store.delete("fault/stale-lock");
});

test("uploadPart through another key touches nothing of the upload", async () => {
  const store = r2BlobStore(proxy.env.BLOBS);
  const up = await store.createMultipart("fault/victim");
  const p1 = await up.uploadPart(1, new Uint8Array(R2_MIN_PART_SIZE).fill(7));
  const other = await store.resumeMultipart("fault/attacker", up.uploadId);
  await assert.rejects(other.uploadPart(1, new Uint8Array(10)));
  assert.deepEqual((await up.listParts()).map((p) => p.etag), [p1.etag], "the victim's part record survived");
  await up.complete([p1]);
  await store.delete("fault/victim");
});
