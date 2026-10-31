// What the reuse check costs for a long finished stream proxy: `usableProxy` on a stream of N parts (default 2,000:
// about 67 minutes of 2 s segments) whose parts are all there, so it is reused. Against a real host (server-node over
// blob-fs, through hosts-plugins' `hostMediaBlobs` client, which has no list), and against blob-fs directly (a store that
// can list, as S3 can), each also with a simulated round trip per request (20 ms: a remote host or bucket). The stream is seeded straight into blob-fs, so
// only the check is timed. Each run is a fresh process; `src` picks the @carton/media source to measure (a checkout
// of an older commit for "before").
//
//   node carton/bench/media/reuse-check.ts run <rounds> <out.jsonl> <beforeSrc> [parts=2000]
//   node carton/bench/media/reuse-check.ts one <src> <host|fs> <parts> <rttMs>
//
// Per run: `firstMs` the first check, `againMs` a second check of the same stream in the same process (a share asks
// up to 3 times: the clip's record, the proxy, the claim), and the requests each made, by kind.

import { mkdirSync, rmSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { median, runRounds, summarize } from "./runner.ts";

const SCRATCH = process.env.CARTON_MEDIA_SCRATCH ?? "/home/ubuntu/gfv-scratch/carton/media/bench";
const HERE = fileURLToPath(new URL(".", import.meta.url));
const SRC_NOW = resolve(HERE, "../../packages/media/src");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function one(src: string, kind: "host" | "fs", parts: number, rttMs: number): Promise<void> {
  const { createFsBlobStore } = await import("@carton/blob-fs");
  const keys = await import(join(src, "keys.ts"));
  const stream = await import(join(src, "stream.ts"));
  const dir = join(SCRATCH, `reuse-${process.pid}`);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const blobs = createFsBlobStore({ root: join(dir, "blobs"), durable: false });
  let close = async () => {};
  let store: any = blobs;
  let at = (k: string) => k;
  if (kind === "host") {
    const { createHmacAuth } = await import("@carton/server");
    const { startNodeHost } = await import("@carton/server-node");
    const { hostMediaBlobs } = await import("@carton/host-http/client");
    const secret = "bench-only-secret-bench-only-secret-01";
    const auth = createHmacAuth({ secret });
    const h = await startNodeHost({ dataDir: join(dir, "data"), auth, secret, blobs, durability: "normal" });
    close = () => h.close();
    const token = await auth.issue({ account: "o", credential: "o/dev", role: "editor", projectId: "p", ttlMs: 3600_000 });
    store = hostMediaBlobs({ origin: h.httpUrl, projectId: "p", token });
    at = (k) => `projects/p/media/${k}`;
  }
  // Seed: N parts of 100-199 bytes, the end listing them, the pointer.
  const source = randomBytes(32).toString("hex");
  const id = randomBytes(32).toString("hex");
  const hashes: string[] = [];
  let size = 0;
  for (let i = 0; i < parts; i++) {
    const h = randomBytes(32).toString("hex");
    const n = 100 + (i % 100);
    await blobs.put(at(keys.mediaKey(h)), new Uint8Array(n));
    hashes.push(h);
    size += n;
  }
  const json = (v: unknown) => new TextEncoder().encode(JSON.stringify(v));
  await blobs.put(at(keys.streamEndKey(id)), json({ segments: parts - 1, durationSec: 2 * (parts - 1), size, at: Date.now(), parts: hashes }));
  await blobs.put(at(keys.proxyPointerKey(source, "p1")), json({ stream: id, encoder: "libx264", at: Date.now() }));

  // Count requests by kind, and pay a round trip on each.
  const counts: Record<string, number> = {};
  const counted = new Proxy(store, {
    get(t, p, r) {
      const v = Reflect.get(t, p, r);
      if (typeof v !== "function" || !["get", "head", "list", "put"].includes(String(p))) return typeof v === "function" ? v.bind(t) : v;
      return async (...a: unknown[]) => {
        counts[String(p)] = (counts[String(p)] ?? 0) + 1;
        if (rttMs > 0) await sleep(rttMs);
        return v.apply(t, a);
      };
    },
  });
  const check = async () => {
    for (const k of Object.keys(counts)) delete counts[k];
    const t0 = performance.now();
    const p = await stream.usableProxy(counted, source, "p1");
    const ms = performance.now() - t0;
    if (!p || p.stream !== id) throw new Error("the sound stream was not reused");
    return { ms: Math.round(ms * 10) / 10, requests: { ...counts } };
  };
  const first = await check();
  const again = await check();
  await close();
  rmSync(dir, { recursive: true, force: true });
  console.log(JSON.stringify({ kind, parts, rttMs, firstMs: first.ms, firstRequests: first.requests, againMs: again.ms, againRequests: again.requests }));
}

const [cmd, ...a] = process.argv.slice(2);
if (cmd === "one") {
  await one(resolve(a[0]!), a[1] as "host" | "fs", Number(a[2]), Number(a[3]));
} else if (cmd === "run") {
  const [rounds, out, before, partsArg] = a;
  const parts = partsArg ?? "2000";
  const self = fileURLToPath(import.meta.url);
  const methods = [];
  for (const [label, src] of [
    ["before", resolve(before!)],
    ["after", SRC_NOW],
  ]) {
    for (const [kind, rtt] of [
      ["host", "0"],
      ["host", "20"],
      ["fs", "0"],
      ["fs", "20"],
    ]) {
      methods.push({ id: `${label} ${kind} rtt${rtt}`, cmd: ["node", self, "one", src!, kind!, parts, rtt!] });
    }
  }
  const runs = runRounds(methods, Number(rounds), out!);
  for (const field of ["firstMs", "againMs"]) console.log(field, JSON.stringify(summarize(runs, field)));
  void median;
} else {
  console.error("usage: reuse-check.ts run <rounds> <out.jsonl> <beforeSrc> [parts] | one <src> <host|fs> <parts> <rttMs>");
  process.exit(2);
}
