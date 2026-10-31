// The Worker with no R2 bound: media, keyframes and segments go to the DO-blob fallback (L11). The HTTP API suite
// runs through it, and the BlobStore suite on the vault with signed URLs answered by serveSignedBlob.
import { after } from "node:test";
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
  fetch: (async (input: string | URL | Request, init?: RequestInit) => serveSignedBlob(new Request(input, init), store, signer)) as typeof fetch,
});
