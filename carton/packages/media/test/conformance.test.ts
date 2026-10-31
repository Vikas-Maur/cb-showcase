// Runs @carton/conformance's media suites against this package's own plug-ins.
import { hasherSuite, mediaStoreSuite, browserParitySuite } from "@carton/conformance";
import { webCryptoHasher } from "../src/hash.ts";
import { nodeHasher } from "../src/node/node-hasher.ts";
import { CountingMemoryStore } from "../src/testing.ts";
import { SCRATCH_ROOT } from "./helpers.ts";
import { mkdirSync } from "node:fs";

mkdirSync(SCRATCH_ROOT, { recursive: true });
hasherSuite("node:crypto", nodeHasher);
hasherSuite("webcrypto (Node)", webCryptoHasher());
mediaStoreSuite("counting-memory", async () => new CountingMemoryStore(), nodeHasher);
browserParitySuite({
  playwright: process.env.PLAYWRIGHT ?? "/home/ubuntu/.npm/_npx/e41f203b7505f1fb/node_modules/playwright",
  chromium: process.env.CHROMIUM ?? "/home/ubuntu/.cache/ms-playwright/chromium-1248/chrome-linux-arm64/chrome",
  hasher: nodeHasher,
  scratch: SCRATCH_ROOT,
});
