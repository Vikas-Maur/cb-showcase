// The BlobStore suite on blob-s3, against a real S3-compatible server: VersityGW (POSIX backend), which checks SigV4
// strictly. Skipped with a reason when the binary isn't installed (VERSITYGW_BIN).
import { after, test } from "node:test";
import { blobStoreSuite } from "@carton/conformance";
import { createS3BlobStore, S3_MIN_PART_SIZE } from "../src/index.ts";
import { startVersityGw, createBucket, versitygwMissingReason, type Gateway } from "./versitygw.ts";

const missing = versitygwMissingReason();
if (missing) {
  test("BlobStore conformance: s3 (VersityGW)", (t) => t.skip(missing));
} else {
  const gw: Gateway = await startVersityGw();
  after(() => gw.stop());
  await createBucket(gw, "carton-conformance");
  const make = (payload: "signed" | "unsigned") => async () =>
    createS3BlobStore({ endpoint: gw.endpoint, bucket: "carton-conformance", region: gw.region, ...gw.credentials, payload });
  // VersityGW's POSIX backend (like MinIO's) can't keep an object at `a` beside objects under `a/`; AWS and R2 can.
  const posix = { reason: "VersityGW's POSIX backend refuses an object whose key is a folder of others (ObjectParentIsFile)" };
  blobStoreSuite("s3 (VersityGW, unsigned payload)", make("unsigned"), { minPartSize: S3_MIN_PART_SIZE, expiryWaitMs: 2100, objectsBesideFolders: posix, reportsCreated: true });
  blobStoreSuite("s3 (VersityGW, signed payload)", make("signed"), { minPartSize: S3_MIN_PART_SIZE, objectsBesideFolders: posix, reportsCreated: true });
}
