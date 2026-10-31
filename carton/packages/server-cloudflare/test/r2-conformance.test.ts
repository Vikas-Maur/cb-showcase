// The BlobStore suite against blob-r2, on workerd's local R2 (wrangler's getPlatformProxy): R2's own rules, such as
// the 5 MiB part minimum and its range errors, apply.
import { after } from "node:test";
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
