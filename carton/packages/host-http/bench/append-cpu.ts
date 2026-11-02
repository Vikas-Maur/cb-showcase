// The JavaScript work of a stream append on the host (cf-proxy-path), with storage taken out: handleHttp's append route
// over an in-memory store, wrapped as the Worker wraps R2 (scoped, with a write cap's wrapper), timed by CPU. What a
// Worker spends on top of this is the runtime's: the request's bytes, the storage calls. Run it before and after a
// change to the route; parts are real-sized, with real manifests.
//   node bench/append-cpu.ts [--parts 4] [--appends 200] [--part-kb 650]
import { parseArgs } from "node:util";
import { createHmacAuth } from "@carton/server";
import { createMemoryBlobStore } from "@carton/blob-memory";
import { scopedBlobStore } from "@carton/blob-memory/scoped";
import { mediaHash, webCryptoHasher, type StreamAppendPart } from "@carton/media";
import { handleHttp, type HttpDeps } from "../src/index.ts";
import { hostMediaBlobs } from "../src/client.ts";

const { values: a } = parseArgs({ options: { parts: { type: "string", default: "4" }, appends: { type: "string", default: "200" }, "part-kb": { type: "string", default: "650" } } });
const PARTS = Number(a.parts), APPENDS = Number(a.appends), PART = Number(a["part-kb"]) * 1024;
const SECRET = "bench-only-secret-bench-only-secret-0123";
const auth = createHmacAuth({ secret: SECRET });
const root = createMemoryBlobStore();
let serverUs = 0;
const deps: HttpDeps = {
  auth,
  secret: SECRET,
  blobsFor: (p) => scopedBlobStore(root, `projects/${p}/media/`),
  blobsForWrites: async (p) => scopedBlobStore(root, `projects/${p}/media/`),
  upgrade: async () => new Response(null, { status: 500 }),
};
// time only the host's work: the request in, the answer built (the client's own work is outside)
const fetch = (async (url: string | URL | Request, init?: RequestInit) => {
  const req = new Request(url, init);
  const c0 = process.cpuUsage();
  const r = (await handleHttp(req, deps))!;
  const c = process.cpuUsage(c0);
  serverUs += c.user + c.system;
  return r;
}) as typeof globalThis.fetch;
const hasher = webCryptoHasher();
const one = crypto.getRandomValues(new Uint8Array(PART > 65536 ? 65536 : PART));
const parts: StreamAppendPart[] = [];
for (let i = 0; i < PARTS; i++) {
  const b = new Uint8Array(PART);
  for (let o = 0; o < PART; o += one.length) b.set(one.subarray(0, Math.min(one.length, PART - o)), o);
  b[0] = i;
  const m = await mediaHash(b, hasher);
  parts.push({ kind: "segment", hash: m.hash, size: m.size, manifest: m.bytes, bytes: b, index: 0, durationSec: 2, at: 1 });
}
const media = hostMediaBlobs({ origin: "http://host", projectId: "bench", token: await auth.issue({ account: "a", credential: "a/dev", role: "editor", projectId: "bench", ttlMs: 600_000 }), fetch });
const run = async (n: number) => {
  for (let k = 0; k < n; k++) {
    const id = (k + 1).toString(16).padStart(64, "0");
    await media.appendStream(id, { parts: parts.map((p, i) => ({ ...p, index: i })) });
  }
};
await run(20); // warm-up
serverUs = 0;
await run(APPENDS);
console.log(JSON.stringify({ parts: PARTS, partKB: PART / 1024, appends: APPENDS, hostCpuMsPerAppend: +(serverUs / 1000 / APPENDS).toFixed(3), hostCpuMsPerPart: +(serverUs / 1000 / APPENDS / PARTS).toFixed(3) }));
