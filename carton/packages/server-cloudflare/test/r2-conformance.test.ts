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

// A bucket whose put of a part record can be held until released, to replay an exact interleaving.
function holdable(real: R2Bucket) {
  const holds: { match: (k: string) => boolean; gate: Promise<void> }[] = [];
  const bucket = new Proxy(real, {
    get(t, prop) {
      if (prop === "put")
        return async (k: string, v: unknown, o: unknown) => {
          const h = holds.find((x) => x.match(k));
          if (h) {
            holds.splice(holds.indexOf(h), 1);
            await h.gate;
          }
          return (t.put as (...a: unknown[]) => unknown)(k, v, o);
        };
      const val = Reflect.get(t, prop);
      return typeof val === "function" ? val.bind(t) : val;
    },
  }) as R2Bucket;
  const hold = (match: (k: string) => boolean) => {
    let release!: () => void;
    holds.push({ match, gate: new Promise<void>((r) => (release = r)) });
    return () => release();
  };
  return { bucket, hold };
}

test("two overlapping uploads of one part never leave a record naming bytes R2 doesn't hold", async () => {
  const { bucket, hold } = holdable(proxy.env.BLOBS);
  const store = r2BlobStore(bucket);
  const up = await store.createMultipart("fault/overlap");
  const releaseA = hold((k) => /\/p00001$/.test(k)); // A's record write waits after A's part is in R2
  const a = up.uploadPart(1, new Uint8Array(R2_MIN_PART_SIZE).fill(1));
  await new Promise((r) => setTimeout(r, 300));
  const b = await up.uploadPart(1, new Uint8Array(R2_MIN_PART_SIZE).fill(2)); // B replaces it, record and all
  releaseA();
  await assert.rejects(a, /uploaded twice at once/);
  const listed = await up.listParts();
  // either unlisted (sent again on resume) or listed with the etag R2 really holds (B's)
  assert.ok(listed.length === 0 || listed[0]!.etag === b.etag, `stale record: ${JSON.stringify(listed)}`);
  const again = listed.length ? b : await up.uploadPart(1, new Uint8Array(R2_MIN_PART_SIZE).fill(2));
  const last = await up.uploadPart(2, new Uint8Array(10));
  await up.complete([again, last]);
  const got = (await store.get("fault/overlap", { offset: 0, length: 4 }))!;
  assert.deepEqual([...got], [2, 2, 2, 2]);
  await store.delete("fault/overlap");
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
