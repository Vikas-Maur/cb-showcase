// The client side of the host's message routes: a BlobStore a sync client passes as `blobs` (SyncClientOptions) so it
// can send and receive messages over 1 MiB as envelopes through any Carton host. It does only what the envelope code
// asks of a store: put a client envelope, get a server one. Web-standard fetch, so it runs in Node, Electron and
// browsers.

import type { BlobInfo, BlobStore, MultipartUpload } from "@carton/core/plugins";

export interface HostBlobsOptions {
  /** The host's origin, e.g. `https://carton.example` or `http://127.0.0.1:8787`. */
  origin: string;
  projectId: string;
  /** The session token, or a function that returns a fresh one. */
  token: string | (() => Promise<string>);
  fetch?: typeof fetch;
}

const unsupported = (what: string): never => {
  throw new Error(`hostMessageBlobs: ${what} is not available (this store only carries sync envelopes)`);
};

export function hostMessageBlobs(opts: HostBlobsOptions): BlobStore {
  const f = opts.fetch ?? ((u: string | URL | Request, i?: RequestInit) => globalThis.fetch(u, i));
  const base = `${opts.origin.replace(/\/+$/, "")}/api/projects/${encodeURIComponent(opts.projectId)}/messages/`;
  const auth = async () => ({ authorization: `Bearer ${typeof opts.token === "string" ? opts.token : await opts.token()}` });
  return {
    kind: "host-messages",
    async put(key, data, o = {}): Promise<BlobInfo> {
      const r = await f(base + key, { method: "PUT", body: data as Uint8Array<ArrayBuffer>, headers: { ...(await auth()), "content-type": o.contentType ?? "application/json" } });
      if (!r.ok) throw new Error(`envelope upload refused: ${r.status} ${await r.text()}`);
      return { key, size: data.byteLength, ...(o.sha256 ? { sha256: o.sha256 } : {}) };
    },
    async get(key) {
      const r = await f(base + key, { headers: await auth() });
      if (r.status === 404) return null;
      if (!r.ok) throw new Error(`envelope fetch refused: ${r.status}`);
      return new Uint8Array(await r.arrayBuffer());
    },
    head: async () => unsupported("head"),
    delete: async () => unsupported("delete"),
    list: async () => unsupported("list"),
    createMultipart: async (): Promise<MultipartUpload> => unsupported("multipart"),
    resumeMultipart: async (): Promise<MultipartUpload> => unsupported("multipart"),
  };
}
