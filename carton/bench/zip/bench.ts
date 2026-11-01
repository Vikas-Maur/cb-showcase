#!/usr/bin/env node
// The .cbproj writer's throughput (PLAN §13): `ZipWriter.addFile` of one large media file, against
//   stream  the pipeline yazl's addFile uses (read stream → CRC transform → write stream), given zlib.crc32 (yazl itself
//           uses the slower JS buffer-crc32). It writes the bytes only, no zip records, so it is the stream cost alone.
//   copy    fs.copyFileSync: the floor. It computes no CRC, and on Linux it may copy in the kernel (copy_file_range).
// The order rotates every run, the source is read once first so the page cache is warm, and the archive `ours` wrote
// is read back once (size and CRC checked) so the comparison is with a correct zip. Prints every run, then medians.
//
//   node bench/zip/bench.ts <source file> [--runs 7] [--make-mib 256] [--only ours,stream,copy]
//
// --make-mib writes that many MiB of random bytes to <source file> first if it isn't already that size. Outputs go
// next to the source (the same volume) and are removed after each run. Every number it prints is UNVERIFIED until a
// separate verifier re-runs it (AGENTS.md rule 6).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomFillSync } from "node:crypto";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import zlib from "node:zlib";
import { ZipReader, ZipWriter } from "../../packages/cardboard/src/node/cbproj/zip.ts";

const MiB = 1024 * 1024;
const argv = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const i = argv.indexOf(`--${name}`);
  return i < 0 ? undefined : argv[i + 1];
};
const src = argv.find((a, i) => !a.startsWith("--") && !argv[i - 1]?.startsWith("--"));
if (!src) {
  console.error("usage: node bench/zip/bench.ts <source file> [--runs 7] [--make-mib 256] [--only ours,stream,copy]");
  process.exit(2);
}
const runs = Number(flag("runs") ?? 7);
const makeMiB = flag("make-mib") ? Number(flag("make-mib")) : null;

if (makeMiB !== null && (!fs.existsSync(src) || fs.statSync(src).size !== makeMiB * MiB)) {
  const fd = fs.openSync(src, "w");
  const chunk = Buffer.alloc(8 * MiB);
  for (let left = makeMiB * MiB; left > 0; left -= chunk.length) fs.writeSync(fd, randomFillSync(chunk), 0, Math.min(left, chunk.length));
  fs.closeSync(fd);
}
const size = fs.statSync(src).size;
const dir = path.dirname(path.resolve(src));
const out = (name: string) => path.join(dir, `zip-bench-${process.pid}-${name}.out`);

/** Reads the whole file once (the page cache warm-up) and returns its CRC. */
function crcOf(file: string): number {
  const fd = fs.openSync(file, "r");
  const buf = Buffer.alloc(8 * MiB);
  let crc = 0;
  for (let n; (n = fs.readSync(fd, buf, 0, buf.length, null)) > 0; ) crc = zlib.crc32(buf.subarray(0, n), crc);
  fs.closeSync(fd);
  return crc;
}

const variants: Record<string, (to: string) => Promise<void>> = {
  async ours(to) {
    const z = await ZipWriter.create(to);
    await z.addFile("media/a.bin", src);
    await z.close();
  },
  async stream(to) {
    let crc = 0;
    const crcT = new Transform({
      transform(c: Buffer, _e, cb) {
        crc = zlib.crc32(c, crc);
        cb(null, c);
      },
    });
    await pipeline(fs.createReadStream(src), crcT, fs.createWriteStream(to));
    void crc;
  },
  async copy(to) {
    fs.copyFileSync(src, to);
  },
};
const names = (flag("only")?.split(",") ?? ["ours", "stream", "copy"]).filter((n) => {
  if (!variants[n]) throw new Error(`unknown variant ${n} (ours, stream, copy)`);
  return true;
});

const crc = crcOf(src);
console.log(`# ${new Date().toISOString()} ${process.platform} ${os.release()} node ${process.version}; ${os.cpus()[0]?.model ?? "?"}`);
console.log(`# load ${os.loadavg().map((l) => l.toFixed(2)).join(" ")}; source ${src}, ${(size / MiB).toFixed(1)} MiB; ${runs} runs, order rotating`);

// once, untimed: the archive is a correct zip of the source
{
  const to = out("check");
  await variants.ours!(to);
  const r = await ZipReader.open(to);
  const e = r.entries.find((x) => x.name === "media/a.bin");
  await r.close();
  fs.rmSync(to, { force: true });
  if (!e || e.size !== size || e.crc32 !== crc) throw new Error(`ZipWriter wrote a wrong entry: ${JSON.stringify(e)}, want size ${size} crc ${crc}`);
  console.log(`# check: ours wrote one STORED entry of ${size} bytes, CRC ${crc.toString(16)} (matches the source)`);
}

const ms: Record<string, number[]> = Object.fromEntries(names.map((n) => [n, []]));
for (let i = 0; i < runs; i++) {
  const order = names.map((_, k) => names[(k + i) % names.length]!);
  for (const name of order) {
    const to = out(name);
    fs.rmSync(to, { force: true });
    const t0 = process.hrtime.bigint();
    await variants[name]!(to);
    const t = Number(process.hrtime.bigint() - t0) / 1e6;
    fs.rmSync(to, { force: true });
    ms[name]!.push(t);
    console.log(`${name}\trun ${i}\t${t.toFixed(1)} ms\t${(size / MiB / (t / 1000)).toFixed(0)} MiB/s`);
  }
}
const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length % 2 ? s[(s.length - 1) / 2]! : (s[s.length / 2 - 1]! + s[s.length / 2]!) / 2;
};
console.log(`# load after ${os.loadavg().map((l) => l.toFixed(2)).join(" ")}`);
for (const n of names) console.log(`median\t${n}\t${median(ms[n]!).toFixed(1)} ms\t${(size / MiB / (median(ms[n]!) / 1000)).toFixed(0)} MiB/s`);
if (ms.ours && ms.stream) console.log(`median stream / ours: ${(median(ms.stream) / median(ms.ours)).toFixed(2)}`);
