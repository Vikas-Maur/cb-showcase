// BlobStore plug-in for any S3-compatible service (AWS S3, R2, GCS interop, MinIO, B2): fetch plus SigV4 signing on
// WebCrypto, so it runs in Node, browsers and Workers. Multipart with equal parts (R2's rule), ranges, presigned URLs.
// Credentials come from the caller, never from code. Owner: hosts-plugins.
import type { BlobStore } from "@carton/core/plugins";

const todo = (what: string): never => {
  throw new Error(`not implemented: ${what}`);
};

export interface S3BlobStoreOptions {
  endpoint: string;
  bucket: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
  /** Path-style URLs (MinIO, most non-AWS services). */
  forcePathStyle?: boolean;
  fetch?: typeof fetch;
}

export function createS3BlobStore(opts: S3BlobStoreOptions): BlobStore {
  return todo("createS3BlobStore");
}
