// Runs @carton/conformance's media suites against this package's own plug-ins.
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { after } from "node:test";
import { browserParitySuite, hasherSuite, mediaStoreSuite, proxyEncoderSuite } from "@carton/conformance";
import { webCryptoHasher } from "../src/hash.ts";
import { ffmpegEncoder, CHAIN_ORDER } from "../src/node/ffmpeg-encoder.ts";
import { nodeHasher } from "../src/node/node-hasher.ts";
import { CountingMemoryStore } from "../src/testing.ts";
import { FFMPEG, FFPROBE, haveFfmpeg, makeClip, SCRATCH_ROOT, scratchDir } from "./helpers.ts";

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

if (haveFfmpeg()) {
  // Kept small for the shared box: a 720p source, so the suite checks the format, progress and abort rules rather than
  // downscaling (test/ffmpeg-encoder.test.ts covers scaling).
  const s = scratchDir("encoder-suite");
  after(() => s.cleanup());
  const sample = makeClip(join(s.dir, "sample.mp4"), { seconds: 2, size: "1280x720" });
  // Every encoder of the chain: here only libx264 can run; the GPU ones must say so through probe() and skip.
  for (const codec of CHAIN_ORDER) proxyEncoderSuite(codec, ffmpegEncoder(codec, { ffmpeg: FFMPEG }), { sample, ffprobe: FFPROBE, scratch: s.dir });
}
