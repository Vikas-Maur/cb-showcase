// First-frame latency through the whole media read path: the loopback range server in front of a fresh MediaReader
// (cold leaf cache), over a BlobStore behind a simulated link (one round trip per request, bytes at the link rate,
// streamed in small ticks, the rate shared by concurrent requests). Same tools and clips as first-frame.ts.
//
//   node carton/bench/media/first-frame-reader.ts --mode play-first|verified [first-frame.ts options]
//
// play-first: MediaReader.read (bytes go out as they arrive, each leaf checked when complete), what the player uses.
// verified:   MediaReader.toolSource() (each leaf goes out once verified), what ffmpeg-based tools are served.
// Numbers are UNVERIFIED until an independent run reproduces them.

import { readFileSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import { MemoryLeafCache } from "../../packages/media/src/cache.ts";
import type { BlobStore, ByteRange } from "../../packages/media/src/contracts.ts";
import { bytesSource } from "../../packages/media/src/hash.ts";
import { nodeHasher } from "../../packages/media/src/node/node-hasher.ts";
import { MediaReader } from "../../packages/media/src/read.ts";
import { CountingMemoryStore } from "../../packages/media/src/testing.ts";
import { uploadMedia } from "../../packages/media/src/upload.ts";
import { runFirstFrameBench, type BenchOptions, type LinkConfig, type SourceFactory, type Tool } from "./first-frame.ts";

/** A BlobStore behind a link: one round trip per request, then bytes at `bytesPerSecond`, shared by all requests. */
export function throttledStore(inner: BlobStore, link: LinkConfig, tickMs = 10): BlobStore {
  const rate = link.bytesPerSecond;
  const limited = rate > 0 && Number.isFinite(rate);
  const tick = limited ? Math.max(1024, Math.floor((rate * tickMs) / 1000)) : Infinity;
  let linkFreeAt = 0;
  const rtt = () => (link.rttMs > 0 ? sleep(link.rttMs) : Promise.resolve());
  const book = async (n: number) => {
    if (!limited) return;
    const now = performance.now();
    linkFreeAt = Math.max(now, linkFreeAt) + (n * 1000) / rate;
    const wait = linkFreeAt - now;
    if (wait >= 1) await sleep(wait);
  };
  return {
    kind: "throttled",
    head: async (k) => (await rtt(), inner.head(k)),
    get: async (k, r?: ByteRange) => {
      await rtt();
      const b = await inner.get(k, r);
      if (b) for (let o = 0; o < b.length; o += tick) await book(Math.min(tick, b.length - o));
      return b;
    },
    getStream: async (k, r?: ByteRange) => {
      await rtt();
      const b = await inner.get(k, r);
      if (!b) return null;
      let at = 0;
      return new ReadableStream<Uint8Array>({
        async pull(ctl) {
          if (at >= b.length) return ctl.close();
          const n = Math.min(tick, b.length - at);
          await book(n);
          ctl.enqueue(b.subarray(at, at + n));
          at += n;
        },
      });
    },
    put: (k, d, o) => inner.put(k, d, o),
    delete: (k) => inner.delete(k),
    list: (p, o) => inner.list(p, o),
    createMultipart: (k, o) => inner.createMultipart(k, o),
    resumeMultipart: (k, id) => inner.resumeMultipart(k, id),
  };
}

function readerFactory(mode: "play-first" | "verified"): SourceFactory {
  const store = new CountingMemoryStore();
  const uploaded = new Set<string>();
  return async (clips, link) => {
    for (const c of clips) {
      if (uploaded.has(c.hash)) continue;
      await uploadMedia({ store, hasher: nodeHasher, source: bytesSource(readFileSync(c.path)), manifest: c.manifest, contentType: "video/mp4" });
      uploaded.add(c.hash);
    }
    const reader = new MediaReader({ store: throttledStore(store, link), hasher: nodeHasher, cache: new MemoryLeafCache(), contentType: () => "video/mp4" });
    return mode === "verified" ? reader.toolSource() : reader;
  };
}

const argv = process.argv.slice(2);
const i = argv.indexOf("--mode");
const mode = (i >= 0 ? argv.splice(i, 2)[1] : "play-first") as "play-first" | "verified";
if (mode !== "play-first" && mode !== "verified") throw new Error("--mode play-first|verified");
const opts: BenchOptions = { makeSource: readerFactory(mode) };
for (let k = 0; k < argv.length; k++) {
  const a = argv[k];
  const v = argv[++k];
  if (a === "--rounds") opts.rounds = Number(v);
  else if (a === "--tools") opts.tools = v.split(",") as Tool[];
  else if (a === "--out") opts.out = v;
  else if (a === "--links")
    opts.links = v.split(",").map((part) => {
      const [name, spec] = part.split("=");
      const [rate, rtt] = spec.split(":").map(Number);
      return { name, bytesPerSecond: rate, rttMs: rtt };
    });
  else throw new Error(`unknown option ${a}`);
}
await runFirstFrameBench(opts);
