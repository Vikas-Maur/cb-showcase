// The Worker with no R2 bound: media, keyframes and segments go to the DO-blob fallback (L11). The HTTP API suite
// runs through it, and the BlobStore suite on the vault with signed URLs answered by serveSignedBlob.
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { httpApiSuite, blobStoreSuite } from "@carton/conformance";
import { createBlobUrlSigner, serveSignedBlob } from "@carton/blob-memory/signed";
import { doBlobStore } from "../src/blob-do.ts";
import type { DurableObjectNamespace } from "../src/cf.ts";
import { startDev } from "./dev-server.ts";
import { stateDir } from "./state.ts";

const SECRET = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url");
const ADMIN = Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString("base64url");
const dev = await startDev({ config: join(import.meta.dirname, "wrangler.vault.dev.toml"), state: stateDir(`dev-vault-${Date.now()}`), vars: { AUTH_SECRET: SECRET, ADMIN_TOKEN: ADMIN } });
after(() => dev.stop());

httpApiSuite("server-cloudflare (Worker, DO-blob fallback)", async () => ({ origin: dev.origin, adminToken: ADMIN }));

const vaultNs: DurableObjectNamespace = {
  idFromName: (n) => n,
  get: (id) => ({
    fetch: (u: Request | string, init?: RequestInit) => {
      const url = new URL(typeof u === "string" ? u : u.url);
      return fetch(`${dev.origin}/__test/vault/${encodeURIComponent(String(id))}${url.pathname}${url.search}`, init);
    },
  }),
};
const signer = createBlobUrlSigner({ secret: SECRET, baseUrl: "https://carton.test/blob/p" });
const store = doBlobStore(vaultNs, `vault-signed-${Date.now()}`, { signer });
blobStoreSuite("do-blob with signed URLs", async () => store, {
  reportsCreated: true,
  fetch: (async (input: string | URL | Request, init?: RequestInit) => serveSignedBlob(new Request(input, init), store, signer)) as typeof fetch,
});

// A part streamed to the vault (uploadPartStream, cf-lab): its bytes arrive whole, a wrong declared length is refused,
// and the object completes the same as a buffered part's.
test("a streamed part reaches the vault whole; a body that doesn't match its declared length is refused", async () => {
  const v = doBlobStore(vaultNs, `vault-stream-${Date.now()}`);
  const up = await v.createMultipart("m/streamed");
  assert.ok(up.uploadPartStream, "the vault takes streamed parts");
  const bytes = new Uint8Array((5 << 20) + 123).map((_, i) => i % 251);
  const stream = (b: Uint8Array) => new Blob([b as Uint8Array<ArrayBuffer>]).stream();
  const p1 = await up.uploadPartStream!(1, stream(bytes), bytes.byteLength);
  await assert.rejects(up.uploadPartStream!(2, stream(new Uint8Array(10)), 11), /declared/);
  const info = await up.complete([p1]);
  assert.equal(info.size, bytes.byteLength);
  const back = await v.get("m/streamed");
  assert.ok(back && back.byteLength === bytes.byteLength && back.every((x, i) => x === bytes[i]), "the bytes read back are the bytes sent");
});
