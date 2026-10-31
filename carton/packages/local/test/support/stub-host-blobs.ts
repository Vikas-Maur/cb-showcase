// A stand-in for `@carton/host-http/client` in tests: hostMessageBlobs records what it was given and returns an
// in-memory BlobStore.
import { createMemoryBlobStore } from "@carton/blob-memory";

export const calls: { origin: string; projectId: string; token: string }[] = [];
export function hostMessageBlobs(o: { origin: string; projectId: string; token: () => Promise<string> }) {
  const store = createMemoryBlobStore();
  void o.token().then((token) => calls.push({ origin: o.origin, projectId: o.projectId, token }));
  return store;
}
