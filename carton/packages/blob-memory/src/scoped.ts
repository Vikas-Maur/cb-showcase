// A BlobStore seen through a key prefix (`projects/<id>/`), so one bucket serves many projects and no project can
// name another's keys. Hosts wrap their bucket in one per project. Listing strips the prefix again, and cursors
// stay opaque to the caller.
//
// Key length: S3 and R2 cap the whole key at 1024 bytes, prefix included, so a scoped store takes keys up to 1024
// bytes less its prefix (a project's media scope, `projects/<id>/media/`, leaves about 1000). It says so when it
// refuses one, rather than passing the caller's key on to fail the inner store's check against a limit the caller
// never saw.

import type { BlobInfo, BlobStore, ByteRange, MultipartUpload } from "@carton/core/plugins";
import { BlobError, checkKey, checksKeys, MAX_KEY_BYTES, withCreated, type ChecksKeys } from "./rules.ts";

const enc = new TextEncoder();

export function scopedBlobStore(inner: BlobStore, prefix: string): BlobStore {
  if (!prefix.endsWith("/") || prefix.startsWith("/")) throw new Error(`scope prefix must end with "/" and not start with one: ${prefix}`);
  const room = MAX_KEY_BYTES - enc.encode(prefix).byteLength;
  if (room < 1) throw new Error(`scope prefix leaves no room for a key under the ${MAX_KEY_BYTES}-byte limit`);
  const full = (key: string) => {
    checkKey(key);
    // UTF-16 length ≥ bytes/3, so only long keys pay for the encode
    if (key.length * 3 > room && enc.encode(key).byteLength > room)
      throw new BlobError("InvalidKey", `blob key longer than ${room} bytes, what the ${MAX_KEY_BYTES}-byte limit leaves after this store's ${MAX_KEY_BYTES - room}-byte scope prefix`);
    return prefix + key;
  };
  const strip = (i: BlobInfo): BlobInfo => withCreated({ ...i, key: i.key.slice(prefix.length) }, i);
  const wrap = (u: MultipartUpload): MultipartUpload => ({
    key: u.key.slice(prefix.length),
    uploadId: u.uploadId,
    uploadPart: (n, d) => u.uploadPart(n, d),
    ...(u.uploadPartStream ? { uploadPartStream: (n: number, body: ReadableStream<Uint8Array>, size: number) => u.uploadPartStream!(n, body, size) } : {}),
    listParts: () => u.listParts(),
    complete: async (parts) => strip(await u.complete(parts)),
    abort: () => u.abort(),
  });
  const store: BlobStore & ChecksKeys = {
    kind: `${inner.kind}+scope`,
    // this scope's room, then the inner store's own rules (a scope inside another's)
    checkKey: (key) => {
      const f = full(key);
      if (checksKeys(inner)) inner.checkKey(f);
    },
    put: async (key, data, opts) => strip(await inner.put(full(key), data, opts)),
    // async throughout, so a refused key is a rejected promise like any other store's, never a throw from the call
    get: async (key: string, range?: ByteRange) => inner.get(full(key), range),
    head: async (key) => {
      const i = await inner.head(full(key));
      return i ? strip(i) : null;
    },
    delete: async (key) => inner.delete(full(key)),
    list: async (p, opts) => {
      const r = await inner.list(prefix + p, opts);
      return r.cursor ? { blobs: r.blobs.map(strip), cursor: r.cursor } : { blobs: r.blobs.map(strip) };
    },
    createMultipart: async (key, opts) => wrap(await inner.createMultipart(full(key), opts)),
    resumeMultipart: async (key, id) => wrap(await inner.resumeMultipart(full(key), id)),
  };
  if (inner.getStream) {
    const gs = inner.getStream.bind(inner);
    store.getStream = async (key, range) => gs(full(key), range);
  }
  if (inner.getWithInfo) {
    const gi = inner.getWithInfo.bind(inner);
    store.getWithInfo = async (key, range) => {
      const o = await gi(full(key), range);
      return o && { ...o, info: strip(o.info) };
    };
  }
  if (inner.signedUrl) {
    const su = inner.signedUrl.bind(inner);
    store.signedUrl = async (key, opts) => su(full(key), opts);
  }
  return store;
}
