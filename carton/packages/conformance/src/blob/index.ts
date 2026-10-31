// BlobStore plug-in conformance (PLAN §3.1, §11): put/get/head/delete, exact ranges, ifAbsent, listing, multipart
// with equal parts and resume by upload id. Owner: hosts-plugins.
import type { BlobStore } from "@carton/core/plugins";

const todo = (what: string): never => {
  throw new Error(`not implemented: ${what}`);
};

export function blobStoreSuite(name: string, make: () => Promise<BlobStore>): void {
  todo("blobStoreSuite");
}
