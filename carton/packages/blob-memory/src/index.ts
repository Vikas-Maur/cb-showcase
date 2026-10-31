// In-memory BlobStore plug-in (tests). Owner: hosts-plugins.
import type { BlobStore } from "@carton/core/plugins";

const todo = (what: string): never => {
  throw new Error(`not implemented: ${what}`);
};

export function createMemoryBlobStore(): BlobStore {
  return todo("createMemoryBlobStore");
}
