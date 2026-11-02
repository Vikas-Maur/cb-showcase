// @carton/conformance's BlobStore suite against httpBlobStore over a real Node host. Not a test file itself (the glob
// is test/**/*.test.ts): http-blobs-conformance.test.ts runs it with the tests the HTTP API can't pass skipped.
//
// The API has no list or delete route, so the store under test reaches the host's own store for those two: the
// suite's cleanup needs them, and "keys are opaque" uses list to check that keys written over HTTP landed under their
// own names.

import type { BlobStore } from "@carton/core/plugins";
import { httpBlobStore } from "../../src/http-blobs.ts";
import { startTestHost, type TestHost } from "../host.ts";

// Imported through a computed specifier, so this app's typecheck doesn't type-check the conformance package and
// everything it imports (other packages, under this app's DOM typings); the suite's signature is restated here.
const conformance = "@carton/conformance";
const { blobStoreSuite } = (await import(conformance)) as {
  blobStoreSuite(name: string, make: () => Promise<BlobStore>, opts?: { cleanup?: () => Promise<void>; expiryWaitMs?: number }): void;
};

let th: TestHost | undefined;

blobStoreSuite(
  "http (server-node + blob-fs)",
  async () => {
    th = await startTestHost();
    const token = await th.session("conf");
    const backend = th.mediaScope("conf");
    return { ...httpBlobStore({ baseUrl: th.url, projectId: "conf", token: () => token }), list: backend.list, delete: backend.delete };
  },
  // a 1 s signed URL is checked to stop working (the host's expiry has whole-second resolution)
  { cleanup: () => th!.close(), expiryWaitMs: 2500 },
);
