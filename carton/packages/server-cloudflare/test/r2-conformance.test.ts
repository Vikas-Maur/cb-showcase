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
