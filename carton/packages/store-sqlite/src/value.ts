// How values are stored. Small values (every change row) are their JSON text, read with one JSON.parse. Large ones
// (keyframes: whole documents, §5.4) are compressed: a BLOB of one codec byte then the raw-deflate of the JSON (JSON
// of this size always shrinks: even random base64 deflates to about 3/4). On a 1,000-item document deflate shrank the JSON about 12x and inflating cost a fraction of the
// JSON.parse a read pays anyway, so carton.db holds keyframes every K changes for little disk. Chromium already
// compresses IndexedDB values, so store-idb needs none of this.

import * as zlib from "node:zlib";
import { promisify } from "node:util";

/** JSON of at least this many characters is a candidate for compression. */
export const COMPRESS_FROM = 8 * 1024;
/** Above this, deflate runs on libuv's thread pool rather than blocking the event loop. */
const ASYNC_FROM = 1 << 20;
const DEFLATE_RAW = 1;
const deflateRaw = promisify(zlib.deflateRaw);

export async function encodeValue(v: unknown): Promise<string | Uint8Array> {
  const json = JSON.stringify(v);
  if (json === undefined) throw new TypeError("store: value is not JSON");
  if (json.length < COMPRESS_FROM) return json;
  const bytes = Buffer.from(json, "utf8");
  const z = bytes.length < ASYNC_FROM ? zlib.deflateRawSync(bytes, { level: 3 }) : await deflateRaw(bytes, { level: 3 });
  const out = new Uint8Array(z.length + 1);
  out[0] = DEFLATE_RAW;
  out.set(z, 1);
  return out;
}

export function decodeValue(raw: string | Uint8Array): unknown {
  if (typeof raw === "string") return JSON.parse(raw);
  if (raw[0] === DEFLATE_RAW) return JSON.parse(zlib.inflateRawSync(raw.subarray(1)).toString("utf8"));
  throw new Error(`store: a value written by a newer Carton (codec ${raw[0]})`);
}
