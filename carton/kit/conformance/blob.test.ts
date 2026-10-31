// Template: copy it into your repo and swap the lines marked "← your …" for your own.
// Run the BlobStore suite against your own media store (Cardboard's GCS, say). blob-fs stands in for it here;
// the suite writes under a random `conf-…/` prefix and deletes what it wrote, so a real shared bucket is fine.
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { blobStoreSuite } from "@carton/conformance";
import { createFsBlobStore } from "@carton/blob-fs"; // ← your BlobStore's factory
import { MemoryBlobStore } from "@carton/blob-memory";
import { createBlobUrlSigner, serveSignedBlob } from "@carton/blob-memory/signed";

const root = process.env.CARTON_SCRATCH ?? join(tmpdir(), "carton-conformance");
mkdirSync(root, { recursive: true });
const dir = mkdtempSync(join(root, "blobs-"));

blobStoreSuite("my-blob-store", async () => createFsBlobStore({ root: dir }), {
  // minPartSize: 5 * 1024 * 1024,   // S3 / R2 / GCS-interop multipart minimum, when your service has one
  // objectsBesideFolders: { reason: "…" }, // only if the backend can't keep `a` beside `a/b` (POSIX-backed S3)
  cleanup: async () => rmSync(dir, { recursive: true, force: true }),
});

// A store that offers signedUrl: the suite fetches the URLs. Pass `fetch` when they are answered in-process, and
// `expiryWaitMs` (> 1000) to also check that a 1 s URL expires.
const signer = createBlobUrlSigner({ secret: "example-secret-example-secret-0123", baseUrl: "https://carton.test/blob/p" });
class SigningStore extends MemoryBlobStore {
  signedUrl(key: string, o: { method: "GET" | "PUT"; expiresIn: number }) {
    return signer.sign(o.method, key, o.expiresIn);
  }
}
const signing = new SigningStore();
blobStoreSuite("my-blob-store with signed URLs", async () => signing, {
  fetch: (async (input: string | URL | Request, init?: RequestInit) => serveSignedBlob(new Request(input, init), signing, signer)) as typeof fetch,
  expiryWaitMs: 2100,
});
