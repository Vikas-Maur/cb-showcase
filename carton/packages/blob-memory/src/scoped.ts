// A BlobStore seen through a key prefix (`projects/<id>/`), so one bucket serves many projects and no project can
// name another's keys. Hosts wrap their bucket in one per project. Listing strips the prefix again, and cursors
// stay opaque to the caller.

import type { BlobInfo, BlobStore, ByteRange, MultipartUpload } from "@carton/core/plugins";
import { checkKey } from "./rules.ts";

export function scopedBlobStore(inner: BlobStore, prefix: string): BlobStore {
  if (!prefix.endsWith("/") || prefix.startsWith("/")) throw new Error(`scope prefix must end with "/" and not start with one: ${prefix}`);
  const full = (key: string) => {
    checkKey(key); // before prefixing, so the limit is the caller's key length
    return prefix + key;
  };
  const strip = (i: BlobInfo): BlobInfo => ({ ...i, key: i.key.slice(prefix.length) });
  const wrap = (u: MultipartUpload): MultipartUpload => ({
    key: u.key.slice(prefix.length),
    uploadId: u.uploadId,
    uploadPart: (n, d) => u.uploadPart(n, d),
    listParts: () => u.listParts(),
    complete: async (parts) => strip(await u.complete(parts)),
    abort: () => u.abort(),
  });
  const store: BlobStore = {
    kind: `${inner.kind}+scope`,
    put: async (key, data, opts) => strip(await inner.put(full(key), data, opts)),
    get: (key: string, range?: ByteRange) => inner.get(full(key), range),
    head: async (key) => {
      const i = await inner.head(full(key));
      return i ? strip(i) : null;
    },
    delete: (key) => inner.delete(full(key)),
    list: async (p, opts) => {
      const r = await inner.list(prefix + p, opts);
      return r.cursor ? { blobs: r.blobs.map(strip), cursor: r.cursor } : { blobs: r.blobs.map(strip) };
    },
    createMultipart: async (key, opts) => wrap(await inner.createMultipart(full(key), opts)),
    resumeMultipart: async (key, id) => wrap(await inner.resumeMultipart(full(key), id)),
  };
  if (inner.getStream) {
    const gs = inner.getStream.bind(inner);
    store.getStream = (key, range) => gs(full(key), range);
  }
  if (inner.signedUrl) {
    const su = inner.signedUrl.bind(inner);
    store.signedUrl = (key, opts) => su(full(key), opts);
  }
  return store;
}
