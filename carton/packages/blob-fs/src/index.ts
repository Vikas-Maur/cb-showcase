// BlobStore plug-in on the local file system: content-addressed files under `root`, written to a temp name and renamed
// into place (Windows: the rename retries on EPERM/EBUSY while another process holds the file; keys never contain
// characters Windows forbids, and case-insensitive volumes are assumed). Owner: hosts-plugins.
import type { BlobStore } from "@carton/core/plugins";

const todo = (what: string): never => {
  throw new Error(`not implemented: ${what}`);
};

export interface FsBlobStoreOptions {
  root: string;
}

export function createFsBlobStore(opts: FsBlobStoreOptions): BlobStore {
  return todo("createFsBlobStore");
}
