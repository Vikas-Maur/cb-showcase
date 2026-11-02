// What compressing a keyframe costs and saves (the reason value.ts deflates values of 8 KiB and more): per deflate
// level, the size of a 1,000-item document's JSON before and after, and the median time to deflate, to inflate, to
// JSON.parse the text, and to inflate plus parse. Prints one JSON line per level.
// usage: flock /tmp/gfv-race/cpu.lock node bench/compress.ts [items=1000] [runs=15]
import * as zlib from "node:zlib";
import { doc } from "./fixture.ts";

const items = Number(process.argv[2] ?? 1000);
const runs = Number(process.argv[3] ?? 15);
const json = JSON.stringify(doc(items));
const buf = Buffer.from(json);
const med = (f: () => unknown) => {
  const xs: number[] = [];
  for (let i = 0; i < runs; i++) {
    const t = performance.now();
    f();
    xs.push(performance.now() - t);
  }
  return Math.round([...xs].sort((a, b) => a - b)[runs >> 1] * 1000) / 1000;
};
for (const level of [1, 3, 6]) {
  const z = zlib.deflateRawSync(buf, { level });
  console.log(JSON.stringify({
    items, level, raw: buf.length, z: z.length, ratio: Math.round((buf.length / z.length) * 10) / 10,
    deflateMs: med(() => zlib.deflateRawSync(buf, { level })),
    inflateMs: med(() => zlib.inflateRawSync(z)),
    parseMs: med(() => JSON.parse(json)),
    inflateParseMs: med(() => JSON.parse(zlib.inflateRawSync(z).toString())),
    node: process.versions.node,
  }));
}
