import { blobStoreSuite } from "@carton/conformance";
import { MemoryBlobStore } from "../src/index.ts";

blobStoreSuite("memory", async () => new MemoryBlobStore(), { reportsCreated: true });
