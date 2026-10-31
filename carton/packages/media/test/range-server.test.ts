import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { open } from "node:fs/promises";
import { createServer, request, type IncomingHttpHeaders, type Server } from "node:http";
import { createRequire } from "node:module";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { promisify } from "node:util";
import { parseRange, startRangeServer, type RangeRequestInfo, type RangeServer } from "../src/node/range-server.ts";
import { LeafMismatchError, type MediaStat, type RangeSource } from "../src/range-source.ts";
import { FFMPEG, FFPROBE, haveFfmpeg, makeClip, scratchDir, xorshiftBytes } from "./helpers.ts";

const run = promisify(execFile);
const KiB = 1024;
const MiB = 1024 * 1024;
const HASH_A = "a".repeat(64);
const HASH_EMPTY = "e".repeat(64);
const HASH_UNKNOWN = "0".repeat(64);

/** In-memory media, yielded in 64 KiB views. The bytes are never written to, so views are safe to hand out. */
function memorySource(media: Record<string, Uint8Array>, chunk = 64 * KiB): RangeSource {
  return {
    async stat(hash) {
      const b = media[hash];
      return b === undefined ? null : { size: b.length, contentType: "video/mp4" };
    },
    async *read(hash, offset, length) {
      const b = media[hash];
      for (let o = offset; o < offset + length; o += chunk) yield b.subarray(o, Math.min(offset + length, o + chunk));
    },
  };
}

interface Got {
  status: number;
  headers: IncomingHttpHeaders;
  body: Buffer;
  /** False when the response ended before Content-Length bytes arrived. */
  complete: boolean;
  error?: Error;
}

function get(port: number, path: string, opts: { method?: string; headers?: Record<string, string> } = {}): Promise<Got> {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, path, method: opts.method ?? "GET", headers: opts.headers, agent: false }, (res) => {
      const parts: Buffer[] = [];
      let error: Error | undefined;
      res.on("data", (b: Buffer) => parts.push(b));
      res.on("error", (e) => (error = e));
      res.on("close", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(parts), complete: res.complete, error }));
    });
    req.on("error", reject);
    req.end();
  });
}

const pathOf = (srv: RangeServer, hash: string): string => new URL(srv.url(hash)).pathname + new URL(srv.url(hash)).search;

async function until(cond: () => boolean, ms = 3000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error("timed out waiting");
    await new Promise((r) => setTimeout(r, 10));
  }
}

test("parseRange: forms, clamping, coalescing, and headers it ignores", () => {
  assert.equal(parseRange(undefined, 100), null);
  assert.deepEqual(parseRange("bytes=0-9", 100), { start: 0, end: 9 });
  assert.deepEqual(parseRange("bytes=90-", 100), { start: 90, end: 99 });
  assert.deepEqual(parseRange("bytes=-10", 100), { start: 90, end: 99 });
  assert.deepEqual(parseRange("bytes=-1000", 100), { start: 0, end: 99 }, "a suffix longer than the body is the body");
  assert.deepEqual(parseRange("bytes=50-1000", 100), { start: 50, end: 99 }, "end clamps to size - 1");
  assert.deepEqual(parseRange("BYTES = 5-6", 100), { start: 5, end: 6 }, "the unit is case-insensitive");
  assert.deepEqual(parseRange("bytes=10-19, 40-49,,-5", 100), { start: 10, end: 99 }, "coalesced");
  assert.deepEqual(parseRange("bytes=200-300, 0-0", 100), { start: 0, end: 0 }, "unsatisfiable parts drop out");
  assert.deepEqual(parseRange("bytes=0-99999999999999999999999", 100), { start: 0, end: 99 });
  assert.equal(parseRange("bytes=100-", 100), "unsatisfiable");
  assert.equal(parseRange("bytes=-0", 100), "unsatisfiable");
  assert.equal(parseRange("bytes=0-", 0), "unsatisfiable");
  for (const bad of ["bytes=", "bytes=abc", "bytes=5-4", "bytes=-", "items=0-1", "bytes 0-1", "bytes=0-1,x", "bytes=1-2-3"]) {
    assert.equal(parseRange(bad, 100), null, bad);
  }
});

describe("range server over an in-memory source", () => {
  const data = xorshiftBytes(300 * KiB + 7, 11);
  const size = data.length;
  let srv: RangeServer;
  const seen: RangeRequestInfo[] = [];
  before(async () => {
    srv = await startRangeServer({ source: memorySource({ [HASH_A]: data, [HASH_EMPTY]: new Uint8Array(0) }), onRequest: (i) => seen.push(i) });
  });
  after(() => srv.close());

  test("200 with the whole body and the headers players need", async () => {
    const r = await get(srv.port, pathOf(srv, HASH_A));
    assert.equal(r.status, 200);
    assert.ok(Buffer.from(data).equals(r.body));
    assert.equal(r.headers["accept-ranges"], "bytes");
    assert.equal(r.headers["content-length"], String(size));
    assert.equal(r.headers["content-type"], "video/mp4");
    assert.equal(r.headers["cache-control"], "no-store");
    assert.equal(r.headers["x-content-type-options"], undefined, "players sniff; nosniff is not wanted");
    assert.equal(r.headers["content-range"], undefined);
    const info = seen.at(-1)!;
    assert.equal(info.hash, HASH_A);
    assert.equal(info.status, 200);
    assert.equal(info.bytes, size);
    assert.equal(info.aborted, false);
  });

  test("206 for each range form, with Content-Range", async () => {
    const cases: [string, number, number][] = [
      ["bytes=100-199", 100, 199],
      [`bytes=${size - 10}-`, size - 10, size - 1],
      ["bytes=-1000", size - 1000, size - 1],
      ["bytes=5-99999999", 5, size - 1],
      ["bytes=0-0", 0, 0],
    ];
    for (const [range, a, b] of cases) {
      const r = await get(srv.port, pathOf(srv, HASH_A), { headers: { Range: range } });
      assert.equal(r.status, 206, range);
      assert.equal(r.headers["content-range"], `bytes ${a}-${b}/${size}`, range);
      assert.equal(r.headers["content-length"], String(b - a + 1), range);
      assert.ok(Buffer.from(data.subarray(a, b + 1)).equals(r.body), range);
    }
  });

  test("several ranges come back as one span, lowest start to highest end", async () => {
    const r = await get(srv.port, pathOf(srv, HASH_A), { headers: { Range: "bytes=1000-1999, 50-60, 70000-70010" } });
    assert.equal(r.status, 206);
    assert.equal(r.headers["content-range"], `bytes 50-70010/${size}`);
    assert.ok(Buffer.from(data.subarray(50, 70011)).equals(r.body));
  });

  test("416 when no range starts inside the body; a malformed Range gets the whole body", async () => {
    const r = await get(srv.port, pathOf(srv, HASH_A), { headers: { Range: `bytes=${size}-` } });
    assert.equal(r.status, 416);
    assert.equal(r.headers["content-range"], `bytes */${size}`);
    const bad = await get(srv.port, pathOf(srv, HASH_A), { headers: { Range: "bytes=9-3" } });
    assert.equal(bad.status, 200);
    assert.equal(bad.body.length, size);
  });

  test("If-Range with our ETag keeps the range; with anything else the whole body comes back", async () => {
    const etag = `"${HASH_A}"`;
    const ok = await get(srv.port, pathOf(srv, HASH_A), { headers: { Range: "bytes=0-9", "If-Range": etag } });
    assert.equal(ok.status, 206);
    assert.equal(ok.headers.etag, etag);
    const stale = await get(srv.port, pathOf(srv, HASH_A), { headers: { Range: "bytes=0-9", "If-Range": '"other"' } });
    assert.equal(stale.status, 200);
    assert.equal(stale.body.length, size);
  });

  test("HEAD sends the headers only, and ignores Range as RFC 9110 asks", async () => {
    const r = await get(srv.port, pathOf(srv, HASH_A), { method: "HEAD", headers: { Range: "bytes=0-9" } });
    assert.equal(r.status, 200);
    assert.equal(r.headers["content-length"], String(size));
    assert.equal(r.headers["accept-ranges"], "bytes");
    assert.equal(r.body.length, 0);
  });

  test("zero-size media: 200 with an empty body, with or without Range", async () => {
    const variants: Record<string, string>[] = [{}, { Range: "bytes=0-" }, { Range: "bytes=-5" }];
    for (const headers of variants) {
      const r = await get(srv.port, pathOf(srv, HASH_EMPTY), { headers });
      assert.equal(r.status, 200);
      assert.equal(r.headers["content-length"], "0");
      assert.equal(r.body.length, 0);
    }
    const h = await get(srv.port, pathOf(srv, HASH_EMPTY), { method: "HEAD" });
    assert.equal(h.status, 200);
    assert.equal(h.headers["content-length"], "0");
  });

  test("403 for a missing or wrong token, or a Host that isn't our loopback address", async () => {
    const path = `/m/${HASH_A}`;
    assert.equal((await get(srv.port, path)).status, 403);
    assert.equal((await get(srv.port, `${path}?t=`)).status, 403);
    assert.equal((await get(srv.port, `${path}?t=${"0".repeat(64)}`)).status, 403);
    assert.equal((await get(srv.port, `${path}?t=${srv.token}0`)).status, 403, "a longer token");
    assert.equal((await get(srv.port, `${path}?t=${srv.token.slice(1)}`)).status, 403, "a shorter token");
    const good = pathOf(srv, HASH_A);
    for (const host of ["evil.example", `evil.example:${srv.port}`, `127.0.0.1:${srv.port + 1}`, "127.0.0.1", `[::1]:${srv.port}`]) {
      const r = await get(srv.port, good, { headers: { Host: host } });
      assert.equal(r.status, 403, host);
      assert.ok(!r.body.toString().includes(srv.token), "error answers never echo the token");
    }
    assert.equal((await get(srv.port, good, { method: "HEAD", headers: { Host: `localhost:${srv.port}` } })).status, 200);
    assert.equal((await get(srv.port, good, { method: "HEAD", headers: { Host: `LocalHost:${srv.port}` } })).status, 200);
  });

  test("404 for anything but /m/<64 hex>, and for unknown media; 405 for other methods", async () => {
    const t = `?t=${srv.token}`;
    for (const p of [`/${t}`, `/m/${t}`, `/m/abc${t}`, `/m/${HASH_A.toUpperCase()}${t}`, `/m/${HASH_A}/x${t}`, `/m/${HASH_A}a${t}`, `/x/${HASH_A}${t}`, `/m//${HASH_A}${t}`]) {
      assert.equal((await get(srv.port, p)).status, 404, p);
    }
    assert.equal((await get(srv.port, pathOf(srv, HASH_UNKNOWN))).status, 404);
    for (const method of ["POST", "PUT", "DELETE", "OPTIONS"]) {
      const r = await get(srv.port, pathOf(srv, HASH_A), { method });
      assert.equal(r.status, 405, method);
      assert.equal(r.headers.allow, "GET, HEAD");
    }
  });

  test("url() and the options refuse what they shouldn't take", async () => {
    assert.match(srv.url(HASH_A), new RegExp(`^http://127\\.0\\.0\\.1:${srv.port}/m/${HASH_A}\\?t=[0-9a-f]{64}$`));
    assert.throws(() => srv.url("../etc"), TypeError);
    await assert.rejects(startRangeServer({ source: memorySource({}), host: "0.0.0.0" as "127.0.0.1" }), TypeError);
    await assert.rejects(startRangeServer({ source: memorySource({}), token: "short" }), TypeError);
  });
});

test("a slow client doesn't make the server pull the whole body: the source is read lazily", async () => {
  const total = 64 * MiB;
  const block = new Uint8Array(64 * KiB); // never written to, so yielding it again and again is safe
  let pulled = 0;
  let readDone = false;
  const source: RangeSource = {
    async stat() {
      return { size: total };
    },
    async *read(_hash, offset, length) {
      try {
        for (let o = offset; o < offset + length; o += block.length) {
          const n = Math.min(block.length, offset + length - o);
          pulled += n;
          yield n === block.length ? block : block.subarray(0, n);
        }
      } finally {
        readDone = true;
      }
    },
  };
  const srv = await startRangeServer({ source });
  try {
    const got = await new Promise<{ received: number; plateau: number[] }>((resolve, reject) => {
      const req = request({ host: "127.0.0.1", port: srv.port, path: pathOf(srv, HASH_A), agent: false }, (res) => {
        let received = 0;
        res.on("data", (b: Buffer) => (received += b.length));
        res.once("data", async () => {
          res.pause();
          const plateau: number[] = [];
          for (let i = 0; i < 3; i++) {
            await new Promise((r) => setTimeout(r, 250));
            plateau.push(pulled);
          }
          res.on("end", () => resolve({ received, plateau }));
          res.resume();
        });
        res.on("error", reject);
      });
      req.on("error", reject);
      req.end();
    });
    const [a, b, c] = got.plateau;
    console.log(`backpressure: pulled ${a} / ${b} / ${c} bytes of ${total} while the client was paused`);
    assert.ok(a < 16 * MiB, `pulled ${a} bytes of ${total} while the client was paused`);
    assert.equal(c, a, "nothing more is pulled while the client stays paused");
    assert.equal(got.received, total);
    assert.equal(pulled, total);
    assert.ok(readDone);
  } finally {
    await srv.close();
  }
});

test("a client that disconnects aborts the source read", async () => {
  let signal: AbortSignal | undefined;
  let finallyRan = false;
  const source: RangeSource = {
    async stat() {
      return { size: 1 << 30 };
    },
    async *read(_hash, _offset, _length, s) {
      signal = s;
      try {
        for (;;) {
          await new Promise((r) => setTimeout(r, 20));
          s?.throwIfAborted();
          yield new Uint8Array(16 * KiB);
        }
      } finally {
        finallyRan = true;
      }
    },
  };
  const infos: RangeRequestInfo[] = [];
  const srv = await startRangeServer({ source, onRequest: (i) => infos.push(i) });
  try {
    await new Promise<void>((resolve, reject) => {
      const req = request({ host: "127.0.0.1", port: srv.port, path: pathOf(srv, HASH_A), agent: false }, (res) => {
        res.once("data", () => {
          req.destroy();
          resolve();
        });
      });
      req.on("error", (e) => ((e as NodeJS.ErrnoException).code === "ECONNRESET" ? undefined : reject(e)));
      req.end();
    });
    await until(() => signal?.aborted === true && finallyRan && infos.length === 1);
    assert.equal(infos[0].aborted, true);
    assert.ok(infos[0].bytes > 0 && infos[0].bytes < infos[0].length);
  } finally {
    await srv.close();
  }
});

test("a leaf mismatch mid-response breaks the response; the next request gets good bytes", async () => {
  const data = xorshiftBytes(2 * MiB, 5);
  let failNext = true;
  const inner = memorySource({ [HASH_A]: data });
  const source: RangeSource = {
    stat: inner.stat,
    async *read(hash, offset, length, signal) {
      let n = 0;
      for await (const c of inner.read(hash, offset, length, signal)) {
        if (failNext && n === 3) {
          failNext = false;
          throw new LeafMismatchError(hash, 0);
        }
        n++;
        yield c;
      }
    },
  };
  const infos: RangeRequestInfo[] = [];
  const srv = await startRangeServer({ source, onRequest: (i) => infos.push(i) });
  try {
    const broken = await get(srv.port, pathOf(srv, HASH_A));
    assert.equal(broken.status, 200, "the headers went out with the first bytes");
    assert.equal(broken.complete, false, "the client must see a broken response, not a clean end");
    assert.ok(broken.body.length < data.length);
    assert.ok(Buffer.from(data.subarray(0, broken.body.length)).equals(broken.body));
    await until(() => infos.length === 1);
    assert.ok(infos[0].error instanceof LeafMismatchError);
    assert.equal(infos[0].aborted, false, "the server broke it, not the client");

    const retry = await get(srv.port, pathOf(srv, HASH_A), { headers: { Range: `bytes=${broken.body.length}-` } });
    assert.equal(retry.status, 206);
    assert.ok(retry.complete);
    assert.ok(Buffer.from(data.subarray(broken.body.length)).equals(retry.body));
  } finally {
    await srv.close();
  }
});

test("a failure before any byte: one transparent retry for a leaf mismatch, else 502", async () => {
  const data = xorshiftBytes(100 * KiB, 6);
  let mismatches = 0;
  let mode: "mismatch-once" | "mismatch-always" | "error" = "mismatch-once";
  const inner = memorySource({ [HASH_A]: data });
  const source: RangeSource = {
    stat: inner.stat,
    async *read(hash, offset, length, signal) {
      if (mode === "error") throw new Error("store unreachable");
      if (mode === "mismatch-always" || mismatches === 0) {
        mismatches++;
        throw new LeafMismatchError(hash, 0);
      }
      yield* inner.read(hash, offset, length, signal);
    },
  };
  const srv = await startRangeServer({ source });
  try {
    const ok = await get(srv.port, pathOf(srv, HASH_A));
    assert.equal(ok.status, 200);
    assert.ok(Buffer.from(data).equals(ok.body));
    assert.equal(mismatches, 1);
    mode = "mismatch-always";
    assert.equal((await get(srv.port, pathOf(srv, HASH_A))).status, 502);
    mode = "error";
    assert.equal((await get(srv.port, pathOf(srv, HASH_A))).status, 502);
  } finally {
    await srv.close();
  }
});

test("a source that ends short breaks the response instead of hanging", async () => {
  const data = xorshiftBytes(256 * KiB, 7);
  const source: RangeSource = {
    async stat() {
      return { size: data.length };
    },
    async *read(_hash, offset) {
      yield data.subarray(offset, offset + 100 * KiB); // and then nothing
    },
  };
  const srv = await startRangeServer({ source });
  try {
    const r = await get(srv.port, pathOf(srv, HASH_A));
    assert.equal(r.complete, false);
    assert.equal(r.body.length, 100 * KiB);
  } finally {
    await srv.close();
  }
});

test("close() drops an active response and resolves", async () => {
  let signal: AbortSignal | undefined;
  let yielded = 0;
  const source: RangeSource = {
    async stat() {
      return { size: 1 << 30 };
    },
    async *read(_h, _o, _l, s) {
      signal = s;
      for (;;) {
        await new Promise((r) => setTimeout(r, 20));
        if (s?.aborted) return;
        yielded++;
        yield new Uint8Array(KiB);
      }
    },
  };
  const srv = await startRangeServer({ source });
  const pending = get(srv.port, pathOf(srv, HASH_A));
  await until(() => yielded >= 2); // the response has started
  await srv.close();
  const r = await pending;
  assert.equal(r.status, 200);
  assert.equal(r.complete, false);
  assert.equal(signal?.aborted, true);
  await assert.rejects(get(srv.port, pathOf(srv, HASH_A)), /ECONNREFUSED/);
});

test("an idle connection is closed after idleTimeoutMs, which aborts its read", async () => {
  let signal: AbortSignal | undefined;
  const source: RangeSource = {
    async stat() {
      return { size: 1 << 20 };
    },
    async *read(_h, _o, _l, s) {
      signal = s;
      yield new Uint8Array(KiB);
      await new Promise((r) => setTimeout(r, 5000)); // a stalled store
    },
  };
  const srv = await startRangeServer({ source, idleTimeoutMs: 200 });
  try {
    const r = await get(srv.port, pathOf(srv, HASH_A));
    assert.equal(r.complete, false);
    assert.equal(r.body.length, KiB);
    await until(() => signal?.aborted === true); // the client can see the close a moment before the server's 'close'
  } finally {
    await srv.close();
  }
});

// ---- real tools: ffprobe, ffmpeg and headless Chromium read real MP4s through the server ----

/** File-backed media that counts the bytes it reads. Each chunk is a fresh buffer: the server doesn't copy them. */
function fileSource(files: Map<string, string>, counter: { bytes: number }): RangeSource {
  return {
    async stat(hash): Promise<MediaStat | null> {
      const path = files.get(hash);
      return path === undefined ? null : { size: statSync(path).size, contentType: "video/mp4" };
    },
    async *read(hash, offset, length, signal) {
      const fh = await open(files.get(hash)!, "r");
      try {
        for (let pos = offset; pos < offset + length; ) {
          signal?.throwIfAborted();
          const want = Math.min(64 * KiB, offset + length - pos);
          const buf = new Uint8Array(want);
          const { bytesRead } = await fh.read(buf, 0, want, pos);
          if (bytesRead === 0) return;
          pos += bytesRead;
          counter.bytes += bytesRead;
          yield bytesRead === want ? buf : buf.subarray(0, bytesRead);
        }
      } finally {
        await fh.close();
      }
    },
  };
}

const PLAYWRIGHT = process.env.PLAYWRIGHT ?? "/home/ubuntu/.npm/_npx/e41f203b7505f1fb/node_modules/playwright";
const CHROME = process.env.CHROME ?? "/home/ubuntu/.cache/ms-playwright/chromium-1248/chrome-linux-arm64/chrome";
const FFMPEG_OK = haveFfmpeg();
const CHROMIUM_OK = existsSync(CHROME) && existsSync(join(PLAYWRIGHT, "package.json"));
const SECONDS = 16;

describe("real tools read MP4s through the range server", { skip: !FFMPEG_OK && "ffmpeg is not installed" }, () => {
  const clips: { name: string; hash: string; path: string; size: number }[] = [];
  const counter = { bytes: 0 };
  const log: RangeRequestInfo[] = [];
  let srv: RangeServer;
  let scratch: { dir: string; cleanup: () => void };
  before(async () => {
    scratch = scratchDir("range-server");
    // 1 s GOPs (makeClip: 30 fps, -g 30), so a seek decodes at most one second of video.
    for (const [name, faststart] of [["moov-at-end", false], ["faststart", true]] as const) {
      const path = makeClip(join(scratch.dir, `${name}.mp4`), { seconds: SECONDS, size: "640x360", faststart, kbps: 2000 });
      const hash = createHash("sha256").update(readFileSync(path)).digest("hex");
      clips.push({ name, hash, path, size: statSync(path).size });
    }
    srv = await startRangeServer({ source: fileSource(new Map(clips.map((c) => [c.hash, c.path])), counter), onRequest: (i) => log.push(i) });
  });
  after(async () => {
    await srv?.close();
    scratch?.cleanup();
  });

  test("ffprobe reads the duration and streams over HTTP", async () => {
    for (const c of clips) {
      const { stdout } = await run(FFPROBE, ["-v", "error", "-show_entries", "format=duration:stream=codec_type,codec_name,width,height", "-of", "json", srv.url(c.hash)], { timeout: 30_000 });
      const j = JSON.parse(stdout) as { format: { duration: string }; streams: { codec_type: string; codec_name: string; width?: number; height?: number }[] };
      assert.ok(Math.abs(Number(j.format.duration) - SECONDS) < 0.2, `${c.name}: duration ${j.format.duration}`);
      const v = j.streams.find((s) => s.codec_type === "video");
      assert.equal(v?.codec_name, "h264", c.name);
      assert.equal(v?.width, 640);
      assert.equal(v?.height, 360);
      assert.equal(j.streams.find((s) => s.codec_type === "audio")?.codec_name, "aac", c.name);
    }
  });

  // ffmpeg's own count (AVIOContext "Statistics: N bytes read", at -v verbose) is what the tool consumed. What the
  // server pushed is larger: on loopback, from a source as fast as a local file, the socket buffers take a few MiB
  // ahead of the reader on each connection until ffmpeg closes it. bench/media/first-frame.ts measures that over a
  // throttled link, which is what a network-backed source sees.
  test("ffmpeg grabs a frame from the middle by seeking with Range, reading far less than the file", async () => {
    for (const c of clips) {
      const out = join(scratch.dir, `${c.name}.png`);
      counter.bytes = 0;
      const first = log.length;
      const { stderr } = await run(FFMPEG, ["-hide_banner", "-v", "verbose", "-y", "-ss", String(SECONDS / 2), "-i", srv.url(c.hash), "-frames:v", "1", out], { timeout: 30_000 });
      await new Promise((r) => setTimeout(r, 200)); // let the server see ffmpeg's last connection close
      const png = readFileSync(out);
      assert.ok(png.subarray(1, 4).toString() === "PNG" && png.length > 1000, `${c.name}: a PNG came out`);
      const reads = [...stderr.matchAll(/Statistics: (\d+) bytes read/g)].map((m) => Number(m[1]));
      assert.equal(reads.length, 1, `${c.name}: one input AVIOContext reported its reads`);
      const requests = log.slice(first);
      console.log(
        `grab_frame ${c.name} (${c.size} bytes): ffmpeg read ${reads[0]} (${((100 * reads[0]) / c.size).toFixed(1)}%), ` +
          `server pushed ${counter.bytes} (${((100 * counter.bytes) / c.size).toFixed(1)}%), ${requests.length} requests: ` +
          requests.map((i) => `${i.range ?? "-"} → ${i.bytes}${i.aborted ? " (closed)" : ""}`).join("; "),
      );
      assert.ok(reads[0] < c.size / 2, `${c.name}: ffmpeg read ${reads[0]} of ${c.size} bytes`);
      assert.ok(requests.some((i) => i.status === 206 && i.offset > 0.4 * c.size && i.offset < 0.6 * c.size), `${c.name}: a Range request started near the middle`);
    }
  });

  test("headless Chromium plays both clips and seeks to the middle", { skip: !CHROMIUM_OK && `Chromium not found (${CHROME})`, timeout: 120_000 }, async () => {
    const page = `<!doctype html><video id=v muted autoplay playsinline></video><script>
      window.ev = [];
      for (const e of ["loadedmetadata", "playing", "seeked", "error"]) v.addEventListener(e, () => ev.push(e));
    </script>`;
    const site: Server = createServer((_req, res) => res.writeHead(200, { "Content-Type": "text/html" }).end(page));
    await new Promise<void>((r) => site.listen(0, "127.0.0.1", r));
    const { chromium } = createRequire(import.meta.url)(PLAYWRIGHT) as { chromium: { launch(o: object): Promise<Browser> } };
    let browser: Browser | undefined;
    try {
      browser = await chromium.launch({ headless: true, executablePath: CHROME, timeout: 30_000 });
      for (const c of clips) {
        const p = await browser.newPage();
        try {
          await p.goto(`http://127.0.0.1:${(site.address() as AddressInfo).port}/`);
          const first = log.length;
          // Page code goes in as strings: this package's tsconfig has no DOM types.
          await p.evaluate(`v.src = ${JSON.stringify(srv.url(c.hash))}`);
          await p.waitForFunction(`ev.includes("playing") || ev.includes("error")`, null, { timeout: 30_000 });
          const error = await p.evaluate(`v.error && "media error " + v.error.code + ": " + v.error.message`);
          assert.ok(!error, `${c.name}: ${String(error)}`);
          const mid = Number(await p.evaluate(`v.currentTime = v.duration / 2`));
          await p.waitForFunction(`ev.includes("seeked")`, null, { timeout: 30_000 });
          const at = Number(await p.evaluate(`v.currentTime`));
          assert.ok(mid > 0 && Math.abs(at - mid) < 1, `${c.name}: seeked to ${at}, wanted ${mid}`);
          const requests = log.slice(first).map((i) => `${i.range ?? "-"} → ${i.bytes}${i.aborted ? " (closed)" : ""}`);
          console.log(`chromium ${c.name}: playing and seeked to ${at.toFixed(2)} s; requests so far: ${requests.join("; ")}`);
        } finally {
          await p.close();
        }
      }
    } finally {
      await browser?.close();
      await new Promise((r) => site.close(r));
    }
  });
});

interface Browser {
  newPage(): Promise<Page>;
  close(): Promise<void>;
}
interface Page {
  goto(url: string): Promise<unknown>;
  evaluate(expression: string): Promise<unknown>;
  waitForFunction(expression: string, arg: unknown, opts: { timeout: number }): Promise<unknown>;
  close(): Promise<void>;
}
