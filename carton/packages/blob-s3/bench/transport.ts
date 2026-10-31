// Throughput of blob-s3 on Node through the global fetch against through @carton/http-node (node:http), the default
// since CI #29. Uploads a clip as @carton/media does (multipart, 8 MiB parts, one after another), then downloads it
// whole through getStream, CARTON_BENCH_REPEAT times per run (a run's MB/s is over all of them). Runs alternate between
// the two, each in a fresh process; prints every run and the medians.
//
//   CARTON_BENCH_CLIP=/path/to/clip.mp4 node packages/blob-s3/bench/transport.ts        (from carton/)
//
// Environment:
//   CARTON_BENCH_CLIP          the file to move (required; the e2e's big clip: e2e/support/s5-stores.ts makeClips)
//   CARTON_BENCH_S3_ENDPOINT   an S3 endpoint; unset: a VersityGW is started (VERSITYGW_BIN, as blob-s3's tests)
//   CARTON_BENCH_S3_ACCESS_KEY, CARTON_BENCH_S3_SECRET_KEY, CARTON_BENCH_S3_REGION (us-east-1)
//   CARTON_BENCH_S3_BUCKET     created if missing (default carton-bench)
//   CARTON_BENCH_RUNS          runs per mode (default 3)
//   CARTON_BENCH_REPEAT        uploads and downloads of the clip per run (default 5)
//   CARTON_BENCH_LOCK          a lock file each run holds with flock (a shared box's CPU lock); unset: no lock
//   CARTON_BENCH_OUT           also append the raw output there
import { execFileSync, spawnSync } from "node:child_process";
import { appendFileSync, readFileSync } from "node:fs";
import { createS3BlobStore } from "../src/index.ts";

const PART = 8 << 20;
const env = process.env;

async function run(mode: "fetch" | "node", tag: string, endpoint: string, keys: { accessKeyId: string; secretAccessKey: string }): Promise<void> {
  const bucket = env.CARTON_BENCH_S3_BUCKET ?? "carton-bench";
  const store = createS3BlobStore({ endpoint, bucket, region: env.CARTON_BENCH_S3_REGION ?? "us-east-1", ...keys, ...(mode === "fetch" ? { fetch: (u: string | URL | Request, i?: RequestInit) => fetch(u, i) } : {}) });
  const data = new Uint8Array(readFileSync(env.CARTON_BENCH_CLIP!));
  // warm-up, untimed: one small object both ways (connection, JIT)
  await store.put(`warm/${tag}`, data.subarray(0, 1 << 20));
  await new Response(await store.getStream(`warm/${tag}`)).arrayBuffer();
  const repeat = Number(env.CARTON_BENCH_REPEAT ?? 5);
  let uploadMs = 0, downloadMs = 0;
  for (let k = 0; k < repeat; k++) {
    const key = `big/${tag}/${k}`;
    const t0 = performance.now();
    const up = await store.createMultipart(key, { contentType: "video/mp4" });
    const parts = [];
    for (let n = 1, at = 0; at < data.length; n++, at += PART) parts.push(await up.uploadPart(n, data.subarray(at, Math.min(at + PART, data.length))));
    await up.complete(parts.map((p, i) => ({ partNumber: i + 1, etag: p.etag })));
    const t1 = performance.now();
    const reader = (await store.getStream(key))!.getReader();
    let got = 0;
    for (;;) {
      const r = await reader.read();
      if (r.done) break;
      got += r.value.byteLength;
    }
    const t2 = performance.now();
    if (got !== data.length) throw new Error(`downloaded ${got} of ${data.length}`);
    uploadMs += t1 - t0;
    downloadMs += t2 - t1;
  }
  const mb = (repeat * data.length) / 1e6;
  console.log(JSON.stringify({ mode, tag, bytes: data.length, repeat, uploadMs: +uploadMs.toFixed(1), downloadMs: +downloadMs.toFixed(1), uploadMBps: +(mb / (uploadMs / 1000)).toFixed(1), downloadMBps: +(mb / (downloadMs / 1000)).toFixed(1) }));
}

if (process.argv[2] === "--run") {
  const [, , , mode, tag, endpoint, accessKeyId, secretAccessKey] = process.argv;
  await run(mode as "fetch" | "node", tag!, endpoint!, { accessKeyId: accessKeyId!, secretAccessKey: secretAccessKey! });
} else {
  if (!env.CARTON_BENCH_CLIP) throw new Error("set CARTON_BENCH_CLIP to the clip to move");
  const out = (s: string) => {
    process.stdout.write(s);
    if (env.CARTON_BENCH_OUT) appendFileSync(env.CARTON_BENCH_OUT, s);
  };
  let endpoint = env.CARTON_BENCH_S3_ENDPOINT;
  let keys = { accessKeyId: env.CARTON_BENCH_S3_ACCESS_KEY ?? "", secretAccessKey: env.CARTON_BENCH_S3_SECRET_KEY ?? "" };
  let stop = async () => {};
  const { startVersityGw, createBucket } = await import("../test/versitygw.ts");
  if (!endpoint) {
    const gw = await startVersityGw();
    endpoint = gw.endpoint;
    keys = gw.credentials;
    stop = () => gw.stop();
  }
  await createBucket({ endpoint, region: env.CARTON_BENCH_S3_REGION ?? "us-east-1", credentials: keys } as never, env.CARTON_BENCH_S3_BUCKET ?? "carton-bench").catch((e: Error) => {
    if (!/BucketAlready/.test(e.message)) throw e;
  });
  const runs = Number(env.CARTON_BENCH_RUNS ?? 3);
  const results: { mode: string; uploadMBps: number; downloadMBps: number }[] = [];
  out(`# blob-s3 transport bench ${new Date().toISOString()} node ${process.version} clip ${env.CARTON_BENCH_CLIP} endpoint ${endpoint}\n`);
  try {
    for (let i = 0; i < 2 * runs; i++) {
      const mode = i % 2 === 0 ? "fetch" : "node";
      let load = "";
      try {
        load = execFileSync("uptime", { encoding: "utf8" }).trim();
      } catch {}
      const args = [process.execPath, import.meta.filename, "--run", mode, `r${i + 1}-${mode}-${Date.now().toString(36)}`, endpoint, keys.accessKeyId, keys.secretAccessKey];
      const r = env.CARTON_BENCH_LOCK ? spawnSync("flock", [env.CARTON_BENCH_LOCK, ...args], { encoding: "utf8" }) : spawnSync(args[0]!, args.slice(1), { encoding: "utf8" });
      out(`## run ${i + 1} ${mode}\nuptime: ${load}\n${r.stdout}${r.stderr}`);
      if (r.status !== 0) throw new Error(`run ${i + 1} failed`);
      results.push(JSON.parse(r.stdout.trim().split("\n").pop()!));
    }
  } finally {
    await stop();
  }
  const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
  for (const mode of ["fetch", "node"]) {
    const rs = results.filter((r) => r.mode === mode);
    const ups = rs.map((r) => r.uploadMBps), downs = rs.map((r) => r.downloadMBps);
    out(`${mode}: upload MB/s ${ups.join(" ")} (median ${median(ups)}), download MB/s ${downs.join(" ")} (median ${median(downs)})\n`);
  }
}
