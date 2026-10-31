// Verifier's cross-check of stores' compression claim (VERIFIED.md S7): "inflate well under JSON.parse" for a keyframe
// stored at deflate level 3. stores' own bench/compress.ts reports one median of 15 per operation; this keeps every
// sample, alternates the two operations' order each iteration (so neither always runs on a warmer cache), and records
// CPU time (process.cpuUsage) beside wall time. Same document (bench/fixture.ts doc(1000)), same zlib call as
// store-sqlite's value.ts (deflateRawSync, level 3). Prints one JSON object.
//   node ci/xcheck/compress-samples.ts [iterations=200] [warmup=20]
import zlib from "node:zlib";
import { doc } from "../../packages/store-sqlite/bench/fixture.ts";

const iterations = Number(process.argv[2] ?? 200);
const warmup = Number(process.argv[3] ?? 20);
const json = JSON.stringify(doc(1000));
const z = zlib.deflateRawSync(Buffer.from(json), { level: 3 });
const ops = {
  inflate: () => zlib.inflateRawSync(z),
  parse: () => JSON.parse(json),
};
type Op = keyof typeof ops;
const samples: Record<Op, { wallMs: number[]; cpuMs: number[] }> = { inflate: { wallMs: [], cpuMs: [] }, parse: { wallMs: [], cpuMs: [] } };

function once(op: Op, keep: boolean) {
  const c0 = process.cpuUsage();
  const t0 = performance.now();
  ops[op]();
  const wall = performance.now() - t0;
  const c = process.cpuUsage(c0);
  if (keep) {
    samples[op].wallMs.push(Math.round(wall * 1000) / 1000);
    samples[op].cpuMs.push((c.user + c.system) / 1000);
  }
}
for (let i = 0; i < warmup + iterations; i++) for (const op of (i % 2 ? ["parse", "inflate"] : ["inflate", "parse"]) as Op[]) once(op, i >= warmup);

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length % 2 ? s[(s.length - 1) / 2]! : (s[s.length / 2 - 1]! + s[s.length / 2]!) / 2;
};
const pct = (xs: number[], p: number) => [...xs].sort((a, b) => a - b)[Math.floor((xs.length - 1) * p)]!;
const pairsBelow = samples.inflate.wallMs.filter((w, i) => w < samples.parse.wallMs[i]!).length;
console.log(
  JSON.stringify({
    rawBytes: Buffer.byteLength(json),
    deflatedBytes: z.length,
    ratio: Math.round((Buffer.byteLength(json) / z.length) * 100) / 100,
    iterations,
    warmup,
    node: process.versions.node,
    summary: Object.fromEntries(
      (Object.keys(ops) as Op[]).map((op) => [op, { wallMedianMs: median(samples[op].wallMs), wallP10Ms: pct(samples[op].wallMs, 0.1), wallP90Ms: pct(samples[op].wallMs, 0.9), cpuMedianMs: median(samples[op].cpuMs) }]),
    ),
    inflateBelowParseInPairs: `${pairsBelow}/${iterations}`,
    samples,
  }),
);
