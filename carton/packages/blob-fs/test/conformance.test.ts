import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { blobStoreSuite } from "@carton/conformance";
import { FsBlobStore } from "../src/index.ts";
import { scratchDir } from "./scratch.ts";

const dirs: string[] = [];
blobStoreSuite(
  "fs",
  async () => {
    const dir = mkdtempSync(join(scratchDir(), "conf-"));
    dirs.push(dir);
    return new FsBlobStore({ root: dir });
  },
  { cleanup: async () => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); }, reportsCreated: true },
);
