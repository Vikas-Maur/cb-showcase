// First-frame latency through the loopback range server over a throttled link (PLAN §11, R2-12).
//
// What it times, per run, against a fresh RangeSource (so every run starts cold) behind a fresh range server:
// - chromium: headless Chromium, from setting <video muted autoplay>.src to 'playing' (in-page clock);
// - ffmpeg: `ffmpeg -i URL -frames:v 1 -f null -`, wall time from spawn to exit (process start included);
// - ffmpeg-grab: the same with `-ss <middle>` first, i.e. what grab_frame does.
// Each over a faststart clip (moov first, like Cardboard's proxies) and a moov-at-end one (like camera files), and over
// each link in --links plus "none" (plain loopback: the tool's own cost). Rounds alternate the order of the configs.
//
// The link model (throttledSource): every read waits one RTT before its first byte, then bytes leave at the link rate
// in small ticks. All reads of one source share the link, as concurrent requests share a real one. Bytes are released
// only as the server pulls them, so the loopback socket buffers can't fill faster than the link.
//
// Output: one JSON line per run, then one summary line per config with every run and the median. Numbers from this
// file are UNVERIFIED until an independent run reproduces them (AGENTS.md).
//
// The source is pluggable: runFirstFrameBench({ makeSource }) takes a factory, so the real MediaReader over a throttled
// BlobStore can replace the default (a throttled file source). Clips carry their Carton manifest for that.

import { execFile } from "node:child_process";
import { readFileSync, statSync, writeFileSync, appendFileSync, mkdirSync, existsSync } from "node:fs";
import { open } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { createRequire } from "node:module";
import type { AddressInfo } from "node:net";
import { cpus, loadavg } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { bytesSource, hashSource } from "../../packages/media/src/hash.ts";
import type { Manifest } from "../../packages/media/src/manifest.ts";
import { nodeHasher } from "../../packages/media/src/node/node-hasher.ts";
import { startRangeServer, type RangeRequestInfo } from "../../packages/media/src/node/range-server.ts";
import type { MediaStat, RangeSource } from "../../packages/media/src/range-source.ts";
import { FFMPEG, makeClip, scratchDir } from "../../packages/media/test/helpers.ts";

export interface LinkConfig {
  name: string;
  /** 0 or Infinity: no throttle. */
  bytesPerSecond: number;
  rttMs: number;
}

export interface BenchClip {
  name: "faststart" | "moov-at-end";
  /** The Carton media hash (manifest id), so a MediaReader factory can serve it by its real id. */
  hash: string;
  manifest: Manifest;
  path: string;
  size: number;
  seconds: number;
}

/** Called once per run, so each run starts with a cold source. */
export type SourceFactory = (clips: readonly BenchClip[], link: LinkConfig) => RangeSource | Promise<RangeSource>;

export type Tool = "chromium" | "ffmpeg" | "ffmpeg-grab";

export interface BenchOptions {
  rounds?: number;
  links?: LinkConfig[];
  tools?: Tool[];
  clipSeconds?: number;
  clipSize?: string;
  clipKbps?: number;
  makeSource?: SourceFactory;
  /** Each JSON line goes here as well as to stdout. */
  out?: string;
  keepClips?: boolean;
  timeoutMs?: number;
}

export interface RunResult {
  type: "run";
  round: number;
  tool: Tool;
  clip: string;
  clipBytes: number;
  link: LinkConfig;
  ok: boolean;
  error?: string;
  /** chromium: src set → 'playing'; ffmpeg: spawn → exit. */
  ms: number | null;
  /** chromium only: src set → 'loadedmetadata'. */
  metadataMs?: number | null;
  /**
   * chromium only: src set → 'loadeddata', the first frame decoded. 'playing' can come much later: autoplay waits
   * until Chromium expects to play through, so on a link near the clip's bitrate it buffers more first.
   */
  firstFrameMs?: number | null;
  /** Body bytes the server handed to the socket during the run (what the source served). */
  bytesServed: number;
  /** chromium: bytes served when the page reported 'playing'. */
  bytesAtPlaying?: number;
  /** ffmpeg: what ffmpeg itself read (its AVIOContext statistics). */
  ffmpegBytesRead?: number;
  requests: { range: string | null; bytes: number; aborted: boolean; status: number }[];
  load: number[];
}

/** No throttle: plain loopback, which shows each tool's own cost. */
export const NO_LINK: LinkConfig = { name: "none", bytesPerSecond: 0, rttMs: 0 };
export const DEFAULT_LINKS: LinkConfig[] = [
  NO_LINK,
  { name: "2MBps-50ms", bytesPerSecond: 2_000_000, rttMs: 50 },
  { name: "0.5MBps-150ms", bytesPerSecond: 500_000, rttMs: 150 },
];

/**
 * Wraps a source in a simulated link: one RTT per read and per first stat of a hash, then bytes released at
 * `bytesPerSecond` in `tickMs` slices. Slices are views of the inner chunks, never copies.
 */
export function throttledSource(inner: RangeSource, link: { bytesPerSecond: number; rttMs: number; tickMs?: number }): RangeSource {
  const rate = link.bytesPerSecond;
  const limited = rate > 0 && Number.isFinite(rate);
  if (!limited && link.rttMs <= 0) return inner;
  const slice = limited ? Math.max(1024, Math.floor((rate * (link.tickMs ?? 10)) / 1000)) : Infinity;
  // The link is busy until linkFreeAt (performance.now() clock). Each slice books its transfer time after the last one,
  // so concurrent reads share the rate instead of each getting all of it.
  let linkFreeAt = 0;
  const statted = new Set<string>();
  return {
    async stat(hash, signal) {
      // The first stat of a hash stands for fetching its manifest: one round trip.
      if (!statted.has(hash) && link.rttMs > 0) await sleep(link.rttMs, undefined, { signal });
      statted.add(hash);
      return inner.stat(hash, signal);
    },
    async *read(hash, offset, length, signal) {
      if (link.rttMs > 0) await sleep(link.rttMs, undefined, { signal });
      for await (const chunk of inner.read(hash, offset, length, signal)) {
        for (let o = 0; o < chunk.length; o += slice) {
          const piece = slice >= chunk.length ? chunk : chunk.subarray(o, Math.min(chunk.length, o + slice));
          if (limited) {
            const now = performance.now();
            linkFreeAt = Math.max(now, linkFreeAt) + (piece.length * 1000) / rate;
            const wait = linkFreeAt - now;
            if (wait >= 1) await sleep(wait, undefined, { signal });
          }
          yield piece;
        }
      }
    },
  };
}

/** Clips read from disk. Each chunk is a fresh buffer: the range server hands chunks to the socket without copying. */
export function fileRangeSource(clips: readonly BenchClip[]): RangeSource {
  const byHash = new Map(clips.map((c) => [c.hash, c]));
  return {
    async stat(hash): Promise<MediaStat | null> {
      const c = byHash.get(hash);
      return c === undefined ? null : { size: c.size, contentType: "video/mp4" };
    },
    async *read(hash, offset, length, signal) {
      const fh = await open(byHash.get(hash)!.path, "r");
      try {
        for (let pos = offset; pos < offset + length; ) {
          signal?.throwIfAborted();
          const want = Math.min(64 * 1024, offset + length - pos);
          const buf = new Uint8Array(want);
          const { bytesRead } = await fh.read(buf, 0, want, pos);
          if (bytesRead === 0) return;
          pos += bytesRead;
          yield bytesRead === want ? buf : buf.subarray(0, bytesRead);
        }
      } finally {
        await fh.close();
      }
    },
  };
}

export const defaultSourceFactory: SourceFactory = (clips, link) => throttledSource(fileRangeSource(clips), link);

const PLAYWRIGHT = process.env.PLAYWRIGHT ?? "/home/ubuntu/.npm/_npx/e41f203b7505f1fb/node_modules/playwright";
const CHROME = process.env.CHROME ?? "/home/ubuntu/.cache/ms-playwright/chromium-1248/chrome-linux-arm64/chrome";

interface Browser {
  newContext(): Promise<Context>;
  close(): Promise<void>;
}
interface Context {
  newPage(): Promise<Page>;
  close(): Promise<void>;
}
interface Page {
  exposeFunction(name: string, fn: (...args: never[]) => unknown): Promise<void>;
  goto(url: string): Promise<unknown>;
  evaluate(expression: string): Promise<unknown>;
}

const PAGE = `<!doctype html><video id=v muted autoplay playsinline></video><script>
  for (const e of ["loadedmetadata", "loadeddata", "playing", "error"]) v.addEventListener(e, () => cbMark(e, performance.now() - (window.t0 ?? 0)));
</script>`;

/** Cores busy over `ms` while this process idles, i.e. other work on a shared box (Linux /proc/stat; null elsewhere). */
async function busyCores(ms: number): Promise<number | null> {
  const sample = (): [number, number] | null => {
    try {
      const f = readFileSync("/proc/stat", "utf8").split("\n")[0].trim().split(/\s+/).slice(1).map(Number);
      const idle = f[3] + f[4];
      return [f.reduce((a, b) => a + b, 0) - idle, idle];
    } catch {
      return null;
    }
  };
  const a = sample();
  await sleep(ms);
  const b = sample();
  if (a === null || b === null) return null;
  const busy = b[0] - a[0];
  const total = busy + b[1] - a[1];
  return total > 0 ? Math.round((busy / total) * cpus().length * 100) / 100 : null;
}

function median(xs: number[]): number | null {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

async function makeClips(dir: string, seconds: number, size: string, kbps: number): Promise<BenchClip[]> {
  const clips: BenchClip[] = [];
  for (const [name, faststart] of [["faststart", true], ["moov-at-end", false]] as const) {
    const path = makeClip(join(dir, `${name}.mp4`), { seconds, size, kbps, faststart });
    const manifest = await hashSource(bytesSource(readFileSync(path)), nodeHasher);
    clips.push({ name, hash: manifest.hash, manifest, path, size: statSync(path).size, seconds });
  }
  return clips;
}

export async function runFirstFrameBench(opts: BenchOptions = {}): Promise<RunResult[]> {
  const rounds = opts.rounds ?? 3;
  const links = opts.links ?? DEFAULT_LINKS;
  const tools = opts.tools ?? ["chromium", "ffmpeg", "ffmpeg-grab"];
  const makeSource = opts.makeSource ?? defaultSourceFactory;
  const timeoutMs = opts.timeoutMs ?? 60_000;
  const emit = (o: object): void => {
    const line = JSON.stringify(o);
    console.log(line);
    if (opts.out !== undefined) appendFileSync(opts.out, line + "\n");
  };
  if (opts.out !== undefined) writeFileSync(opts.out, "");

  const scratch = scratchDir("first-frame");
  const results: RunResult[] = [];
  let site: Server | undefined;
  let browser: Browser | undefined;
  try {
    const clips = await makeClips(scratch.dir, opts.clipSeconds ?? 12, opts.clipSize ?? "1280x720", opts.clipKbps ?? 4000);
    emit({
      type: "start",
      clips: clips.map((c) => ({ name: c.name, bytes: c.size, seconds: c.seconds })),
      links,
      tools,
      rounds,
      load: loadavg(),
      otherCores: await busyCores(3000),
    });

    if (tools.includes("chromium")) {
      site = createServer((_req, res) => res.writeHead(200, { "Content-Type": "text/html" }).end(PAGE));
      await new Promise<void>((r) => site!.listen(0, "127.0.0.1", r));
      const { chromium } = createRequire(import.meta.url)(PLAYWRIGHT) as { chromium: { launch(o: object): Promise<Browser> } };
      browser = await chromium.launch({ headless: true, executablePath: CHROME, timeout: 30_000 });
    }
    const sitePort = site === undefined ? 0 : (site.address() as AddressInfo).port;

    const runOne = async (round: number, tool: Tool, clip: BenchClip, link: LinkConfig): Promise<RunResult> => {
      const r: RunResult = { type: "run", round, tool, clip: clip.name, clipBytes: clip.size, link, ok: false, ms: null, bytesServed: 0, requests: [], load: loadavg() };
      const log: RangeRequestInfo[] = [];
      // Counted at the source, not from onRequest: 'playing' arrives while responses are still streaming.
      let served = 0;
      const source = await makeSource(clips, link);
      const counted: RangeSource = {
        stat: (h, s) => source.stat(h, s),
        async *read(h, o, l, s) {
          for await (const c of source.read(h, o, l, s)) {
            served += c.length;
            yield c;
          }
        },
      };
      const srv = await startRangeServer({ source: counted, onRequest: (i) => log.push(i) });
      const url = srv.url(clip.hash);
      try {
        if (tool === "chromium") {
          const ctx = await browser!.newContext();
          try {
            const page = await ctx.newPage();
            const marks: Record<string, { ms: number; bytes: number }> = {};
            let done!: () => void;
            const finished = new Promise<void>((res) => (done = res));
            await page.exposeFunction("cbMark", (ev: string, ms: number) => {
              marks[ev] ??= { ms, bytes: served };
              if (ev === "playing" || ev === "error") done();
            });
            await page.goto(`http://127.0.0.1:${sitePort}/`);
            await page.evaluate(`window.t0 = performance.now(); v.src = ${JSON.stringify(url)}`);
            const timer = sleep(timeoutMs, undefined, { ref: false }).then(() => "timeout" as const);
            if ((await Promise.race([finished, timer])) === "timeout") throw new Error(`no 'playing' after ${timeoutMs} ms`);
            if (marks.error !== undefined) throw new Error(`media error: ${String(await page.evaluate(`v.error && v.error.message`))}`);
            r.ms = marks.playing.ms;
            r.metadataMs = marks.loadedmetadata?.ms ?? null;
            r.firstFrameMs = marks.loadeddata?.ms ?? null;
            r.bytesAtPlaying = marks.playing.bytes;
          } finally {
            await ctx.close();
          }
        } else {
          const args = ["-hide_banner", "-v", "verbose", "-nostdin"];
          if (tool === "ffmpeg-grab") args.push("-ss", String(clip.seconds / 2));
          args.push("-i", url, "-frames:v", "1", "-f", "null", "-");
          const t0 = performance.now();
          const { stderr } = await new Promise<{ stderr: string }>((resolve, reject) => {
            execFile(FFMPEG, args, { timeout: timeoutMs, maxBuffer: 16 << 20 }, (err, _out, stderr) => (err ? reject(err) : resolve({ stderr })));
          });
          r.ms = performance.now() - t0;
          const m = /Statistics: (\d+) bytes read/.exec(stderr);
          if (m !== null) r.ffmpegBytesRead = Number(m[1]);
        }
        r.ok = true;
      } catch (e) {
        r.error = e instanceof Error ? e.message.split("\n")[0] : String(e);
      } finally {
        await srv.close();
      }
      r.bytesServed = served;
      r.requests = log.map((i) => ({ range: i.range, bytes: i.bytes, aborted: i.aborted, status: i.status }));
      return r;
    };

    // One unrecorded run per tool first: the first media load in a fresh browser (and the first ffmpeg spawn) pays
    // one-off start-up costs that would otherwise land on whichever config happens to go first.
    for (const tool of tools) emit({ ...(await runOne(0, tool, clips[0], NO_LINK)), type: "warmup" });

    const configs: { tool: Tool; clip: BenchClip; link: LinkConfig }[] = [];
    for (const link of links) for (const clip of clips) for (const tool of tools) configs.push({ tool, clip, link });

    for (let round = 1; round <= rounds; round++) {
      emit({ type: "round", round, load: loadavg(), otherCores: await busyCores(1000) });
      const order = round % 2 === 1 ? configs : [...configs].reverse();
      for (const { tool, clip, link } of order) {
        const r = await runOne(round, tool, clip, link);
        results.push(r);
        emit(r);
      }
    }

    for (const { tool, clip, link } of configs) {
      const runs = results.filter((x) => x.tool === tool && x.clip === clip.name && x.link.name === link.name);
      const ok = runs.filter((x) => x.ok && x.ms !== null);
      emit({
        type: "summary",
        tool,
        clip: clip.name,
        link: link.name,
        runsMs: runs.map((x) => (x.ms === null ? null : Math.round(x.ms))),
        medianMs: median(ok.map((x) => x.ms!)),
        runsBytesServed: runs.map((x) => x.bytesServed),
        medianBytesServed: median(ok.map((x) => x.bytesServed)),
        ...(tool === "chromium"
          ? {
              runsFirstFrameMs: runs.map((x) => (x.firstFrameMs == null ? null : Math.round(x.firstFrameMs))),
              medianFirstFrameMs: median(ok.flatMap((x) => (x.firstFrameMs == null ? [] : [x.firstFrameMs]))),
              medianBytesAtPlaying: median(ok.map((x) => x.bytesAtPlaying ?? 0)),
            }
          : { medianFfmpegBytesRead: median(ok.map((x) => x.ffmpegBytesRead ?? 0)) }),
        failures: runs.length - ok.length,
      });
    }
    emit({ type: "end", load: loadavg() });
  } finally {
    await browser?.close();
    if (site !== undefined) await new Promise((r) => site!.close(r));
    if (!opts.keepClips) scratch.cleanup();
  }
  return results;
}

const USAGE = `usage: node carton/bench/media/first-frame.ts [options]
  --rounds N           rounds, alternating the config order (default 3)
  --links LIST         name=bytesPerSecond:rttMs,... (default none=0:0,2MBps-50ms=2000000:50,0.5MBps-150ms=500000:150)
  --tools LIST         chromium,ffmpeg,ffmpeg-grab (default all)
  --seconds S          clip length (default 12)
  --size WxH           clip size (default 1280x720, the collab proxy's)
  --kbps K             clip video bitrate (default 4000, the collab proxy's ceiling)
  --out FILE           also write the JSON lines to FILE
  --keep               keep the generated clips
Env: FFMPEG, PLAYWRIGHT (playwright package dir), CHROME (Chromium binary), CARTON_MEDIA_SCRATCH.
Prints one JSON line per run and a summary line per config. Numbers are UNVERIFIED until reproduced independently.`;

function parseLinks(s: string): LinkConfig[] {
  return s.split(",").map((part) => {
    const [name, spec] = part.includes("=") ? part.split("=") : [part, part];
    const [rate, rtt] = spec.split(":").map(Number);
    if (!Number.isFinite(rate) || !Number.isFinite(rtt)) throw new Error(`bad link: ${part}`);
    return { name, bytesPerSecond: rate, rttMs: rtt };
  });
}

async function main(argv: string[]): Promise<void> {
  const opts: BenchOptions = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = (): string => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${a} needs a value`);
      return v;
    };
    if (a === "--help" || a === "-h") {
      console.log(USAGE);
      return;
    } else if (a === "--rounds") opts.rounds = Number(next());
    else if (a === "--links") opts.links = parseLinks(next());
    else if (a === "--tools") opts.tools = next().split(",") as Tool[];
    else if (a === "--seconds") opts.clipSeconds = Number(next());
    else if (a === "--size") opts.clipSize = next();
    else if (a === "--kbps") opts.clipKbps = Number(next());
    else if (a === "--out") opts.out = next();
    else if (a === "--keep") opts.keepClips = true;
    else throw new Error(`unknown option ${a}\n${USAGE}`);
  }
  if (opts.tools?.includes("chromium") !== false && !existsSync(CHROME)) throw new Error(`Chromium not found at ${CHROME} (set CHROME, or --tools ffmpeg,ffmpeg-grab)`);
  if (opts.out !== undefined) mkdirSync(join(opts.out, ".."), { recursive: true });
  await runFirstFrameBench(opts);
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  main(process.argv.slice(2)).catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exitCode = 1;
  });
}
