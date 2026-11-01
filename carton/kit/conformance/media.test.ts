// Template: copy it into your repo and swap the lines marked "← your …" for your own.
// The media suites on your plug-ins: a Hasher, @carton/media over your BlobStore, a ProxyEncoder (the GPU
// ones skip themselves through probe() where they can't run), and browser/Node id parity in headless Chromium.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after } from "node:test";
import { hasherSuite, mediaStoreSuite, proxyEncoderSuite, browserParitySuite } from "@carton/conformance";
import { webCryptoHasher } from "@carton/media";
import { nodeHasher, ffmpegEncoder, CHAIN_ORDER } from "@carton/media/node"; // ← your Hasher / ProxyEncoder
import { createFsBlobStore } from "@carton/blob-fs"; // ← your BlobStore

const root = process.env.CARTON_SCRATCH ?? join(tmpdir(), "carton-conformance");
mkdirSync(root, { recursive: true });
const dir = mkdtempSync(join(root, "media-"));
after(() => rmSync(dir, { recursive: true, force: true }));

hasherSuite("my-hasher", nodeHasher);
hasherSuite("webcrypto", webCryptoHasher());

// partSize: your service's multipart minimum (default 5 MiB, S3/R2's). Each test uploads 3 parts and a short one.
let stores = 0;
mediaStoreSuite("my-blob-store", async () => createFsBlobStore({ root: join(dir, `blobs-${++stores}`) }), nodeHasher);

// A short clip with video and audio, made with ffmpeg (skipped when ffmpeg isn't on PATH). The suite encodes it at the
// profile (default 720p, 2 Mb/s, H.264/AAC).
const sample = join(dir, "sample.mp4");
let haveFfmpeg = true;
try {
  execFileSync("ffmpeg", ["-hide_banner", "-v", "error", "-y", "-f", "lavfi", "-i", "testsrc2=size=640x360:rate=30:duration=1", "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000:duration=1", "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", sample]);
} catch {
  haveFfmpeg = false;
}
if (haveFfmpeg) for (const codec of CHAIN_ORDER) proxyEncoderSuite(codec, ffmpegEncoder(codec), { sample, scratch: dir, profile: { height: 240, bitrate: 500_000, codec: "h264", audio: "aac" } });

// Needs a playwright package folder (and optionally a Chromium binary); skips itself when they are missing.
if (process.env.PLAYWRIGHT) browserParitySuite({ playwright: process.env.PLAYWRIGHT, chromium: process.env.CHROMIUM, hasher: nodeHasher, scratch: dir });
