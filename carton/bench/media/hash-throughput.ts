// Hashing throughput of @carton/media's real code paths on one file, warm page cache (the cold case is disk-bound,
// P1 [V]). Every method checks it got the same media hash.
//
//   node carton/bench/media/hash-throughput.ts run <file> <rounds> <out.jsonl>   all methods, round-robin, locked
//   node carton/bench/media/hash-throughput.ts one <method> <file>              one measurement, one JSON line
//   node carton/bench/media/hash-throughput.ts make <file> <MiB>                 a random test file
//
// Methods:
//   node-read            8 MiB reads, no hashing: the I/O ceiling
//   node-inprocess       hashSource(fileSource) with node:crypto on the calling thread
//   node-hashFile-wN     hashFile with N worker threads; `MBps` includes starting the pool (a first share), and
//                        `MBpsWarmPool` is a second run on the started pool
//   browser-page         Chromium, a picked File, hashSource + WebCrypto on the page
//   browser-worker       the same inside a Web Worker

import { closeSync, openSync, readFileSync, readSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { createRequire, stripTypeScriptTypes } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomFillSync } from "node:crypto";
import { hashSource } from "../../packages/media/src/hash.ts";
import { closeHashWorkers, hashFile } from "../../packages/media/src/node/hash-file.ts";
import { fileSource } from "../../packages/media/src/node/file-source.ts";
import { nodeHasher } from "../../packages/media/src/node/node-hasher.ts";
import { runRounds, summarize } from "./runner.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const MEDIA_SRC = resolve(HERE, "../../packages/media/src");
const PLAYWRIGHT = process.env.PLAYWRIGHT ?? "/home/ubuntu/.npm/_npx/e41f203b7505f1fb/node_modules/playwright";
const CHROMIUM = process.env.CHROMIUM ?? "/home/ubuntu/.cache/ms-playwright/chromium-1248/chrome-linux-arm64/chrome";
const METHODS = ["node-read", "node-inprocess", "node-hashFile-w1", "node-hashFile-w2", "node-hashFile-w4", "browser-page", "browser-worker"];

function warm(file: string): void {
  // Read the whole file so every method starts from a warm page cache.
  const fd = openSync(file, "r");
  const buf = Buffer.allocUnsafe(8 << 20);
  try {
    let off = 0;
    for (let n; (n = readSync(fd, buf, 0, buf.length, off)) > 0; ) off += n;
  } finally {
    closeSync(fd);
  }
}

async function browser(file: string, inWorker: boolean): Promise<{ ms: number; hash: string }> {
  const page = `<!doctype html><input type=file id=f><script type=module>
    import { blobSource, hashSource, webCryptoHasher } from "/m/hash.ts";
    window.go = async (inWorker) => {
      const f = document.getElementById("f").files[0];
      if (!inWorker) {
        const t = performance.now();
        const m = await hashSource(blobSource(f), webCryptoHasher(), { readSize: 8 << 20, concurrency: 3 });
        return { ms: performance.now() - t, hash: m.hash };
      }
      const w = new Worker("/w.js", { type: "module" });
      await new Promise((r) => { w.onmessage = r; });            // worker loaded its modules
      const t = performance.now();
      const hash = await new Promise((r) => { w.onmessage = (e) => r(e.data); w.postMessage(f); });
      w.terminate();
      return { ms: performance.now() - t, hash };
    };
    window.ready = true;</script>`;
  const worker = `import { blobSource, hashSource, webCryptoHasher } from "/m/hash.ts";
    self.onmessage = async (e) => self.postMessage((await hashSource(blobSource(e.data), webCryptoHasher(), { readSize: 8 << 20, concurrency: 3 })).hash);
    self.postMessage("ready");`;
  const server = createServer((req, res) => {
    const p = new URL(req.url ?? "/", "http://x").pathname;
    if (p === "/") return void res.writeHead(200, { "content-type": "text/html" }).end(page);
    if (p === "/w.js") return void res.writeHead(200, { "content-type": "text/javascript" }).end(worker);
    const m = /^\/m\/([a-z-]+\.ts)$/.exec(p);
    if (m) return void res.writeHead(200, { "content-type": "text/javascript" }).end(stripTypeScriptTypes(readFileSync(join(MEDIA_SRC, m[1]), "utf8")));
    res.writeHead(404).end();
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { chromium } = createRequire(import.meta.url)(PLAYWRIGHT);
  const b = await chromium.launch({ headless: true, executablePath: CHROMIUM });
  try {
    const pg = await b.newPage();
    await pg.goto(`http://127.0.0.1:${(server.address() as { port: number }).port}/`);
    await pg.waitForFunction(() => (globalThis as any).ready === true);
    await pg.setInputFiles("#f", file);
    return await pg.evaluate((w: boolean) => (globalThis as any).go(w), inWorker);
  } finally {
    await b.close();
    server.close();
  }
}

async function one(method: string, file: string): Promise<Record<string, unknown>> {
  const size = statSync(file).size;
  warm(file);
  const MB = size / 1e6;
  if (method === "node-read") {
    const t = performance.now();
    warm(file);
    const ms = performance.now() - t;
    return { method, bytes: size, ms, MBps: Math.round(MB / (ms / 1000)) };
  }
  if (method === "node-inprocess") {
    const src = await fileSource(file);
    const t = performance.now();
    const m = await hashSource(src, nodeHasher, { readSize: 8 << 20, concurrency: 2 });
    const ms = performance.now() - t;
    await src.close();
    return { method, bytes: size, ms, MBps: Math.round(MB / (ms / 1000)), hash: m.hash };
  }
  const w = /^node-hashFile-w(\d)$/.exec(method);
  if (w) {
    const workers = Number(w[1]);
    let t = performance.now();
    const m = await hashFile(file, { workers });
    const ms = performance.now() - t;
    t = performance.now();
    const m2 = await hashFile(file, { workers });
    const msWarm = performance.now() - t;
    closeHashWorkers();
    if (m2.hash !== m.hash) throw new Error("hash differs between runs");
    return { method, bytes: size, ms, MBps: Math.round(MB / (ms / 1000)), msWarmPool: msWarm, MBpsWarmPool: Math.round(MB / (msWarm / 1000)), hash: m.hash };
  }
  if (method === "browser-page" || method === "browser-worker") {
    const r = await browser(file, method === "browser-worker");
    return { method, bytes: size, ms: r.ms, MBps: Math.round(MB / (r.ms / 1000)), hash: r.hash };
  }
  throw new Error(`unknown method ${method}`);
}

const [cmd, ...args] = process.argv.slice(2);
if (cmd === "one") {
  console.log(JSON.stringify(await one(args[0], args[1])));
} else if (cmd === "make") {
  const buf = Buffer.allocUnsafe(Number(args[1]) << 20);
  randomFillSync(buf);
  writeFileSync(args[0], buf);
} else if (cmd === "run") {
  const [file, rounds, out] = args;
  const self = fileURLToPath(import.meta.url);
  const runs = runRounds(METHODS.map((id) => ({ id, cmd: [process.execPath, self, "one", id, file] })), Number(rounds), out);
  const hashes = new Set(runs.map((r) => r.hash).filter(Boolean));
  console.log(JSON.stringify({ summary: summarize(runs, "MBps"), warmPool: summarize(runs.filter((r) => r.MBpsWarmPool), "MBpsWarmPool"), hashesAgree: hashes.size === 1 }, null, 1));
} else {
  console.log("usage: hash-throughput.ts run <file> <rounds> <out.jsonl> | one <method> <file> | make <file> <MiB>");
}
