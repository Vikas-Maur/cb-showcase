// Browser/Node id parity (P6, PLAN §11): headless Chromium runs @carton/media's own hashing code with WebCrypto, on
// bytes built in the page, on a disk-backed File picked through <input type=file>, and inside a Web Worker (off the
// UI thread), and must produce exactly the ids Node computes with node:crypto.
//
// The page loads the package's TypeScript sources directly, with types stripped by Node, so what runs in the browser
// is the same code the Node tests run, not a build of it.

import assert from "node:assert/strict";
import { createRequire, stripTypeScriptTypes } from "node:module";
import { createServer, type Server } from "node:http";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import type { Hasher } from "@carton/core/plugins";
import { bytesSource, hashSource } from "@carton/media";
import { MEDIA_ID_VECTORS, xorshiftBytes } from "./vectors.ts";

export interface BrowserParityOptions {
  /** Path to a playwright (or playwright-core) package folder. */
  playwright: string;
  /** Chromium executable; playwright's own when absent. */
  chromium?: string;
  /** Node's hasher, the reference. */
  hasher: Hasher;
  /** Scratch folder for the File test (on disk, not a small tmpfs). */
  scratch?: string;
}

const MEDIA_SRC = dirname(fileURLToPath(import.meta.resolve("@carton/media")));
const HERE = dirname(fileURLToPath(import.meta.url));

/** Serves stripped TypeScript from the two source folders the page needs, and nothing else. */
function serve(): Promise<Server> {
  const roots: Record<string, string> = { "/media/": MEDIA_SRC, "/conformance/": HERE };
  const page = `<!doctype html><meta charset=utf-8><input type=file id=f><script type=module>
    import { blobSource, bytesSource, hashSource, webCryptoHasher } from "/media/hash.ts";
    import { xorshiftBytes } from "/conformance/vectors.ts";
    const h = webCryptoHasher();
    window.hashVector = async (size, seed, readSize, concurrency) => {
      const data = xorshiftBytes(size, seed);
      const a = (await hashSource(bytesSource(data), h)).hash;
      const b = (await hashSource(blobSource(new Blob([data])), h, { readSize, concurrency })).hash;
      return [a, b];
    };
    window.hashPicked = async () => (await hashSource(blobSource(document.getElementById("f").files[0]), h, { readSize: 4 << 20, concurrency: 2 })).hash;
    window.hashInWorker = (size, seed) => new Promise((resolve, reject) => {
      const w = new Worker("/worker.js", { type: "module" });
      w.onmessage = (e) => { w.terminate(); resolve(e.data); };
      w.onerror = (e) => { w.terminate(); reject(new Error(e.message)); };
      w.postMessage(new Blob([xorshiftBytes(size, seed)]));
    });
    window.ready = true;
  </script>`;
  const worker = `import { blobSource, hashSource, webCryptoHasher } from "/media/hash.ts";
    self.onmessage = async (e) => self.postMessage((await hashSource(blobSource(e.data), webCryptoHasher(), { concurrency: 3 })).hash);`;
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    if (url.pathname === "/") return void res.writeHead(200, { "content-type": "text/html" }).end(page);
    if (url.pathname === "/worker.js") return void res.writeHead(200, { "content-type": "text/javascript" }).end(worker);
    for (const [prefix, root] of Object.entries(roots)) {
      if (!url.pathname.startsWith(prefix) || !url.pathname.endsWith(".ts")) continue;
      const file = resolve(root, `.${url.pathname.slice(prefix.length - 1)}`);
      if (!file.startsWith(root + sep) || !existsSync(file)) break;
      const js = stripTypeScriptTypes(readFileSync(file, "utf8"), { mode: "strip" });
      return void res.writeHead(200, { "content-type": "text/javascript" }).end(js);
    }
    res.writeHead(404).end();
  });
  return new Promise((r) => server.listen(0, "127.0.0.1", () => r(server)));
}

export function browserParitySuite(opts: BrowserParityOptions): void {
  test("[media/parity] headless Chromium computes the same media ids as Node", async (t) => {
    if (!existsSync(opts.playwright) || (opts.chromium && !existsSync(opts.chromium))) return t.skip("playwright or Chromium not installed here");
    const { chromium } = createRequire(import.meta.url)(opts.playwright);
    const server = await serve();
    const scratch = mkdtempSync(join(opts.scratch ?? tmpdir(), "parity-"));
    const browser = await chromium.launch({ headless: true, executablePath: opts.chromium });
    try {
      const page = await browser.newPage();
      const { port } = server.address() as { port: number };
      await page.goto(`http://127.0.0.1:${port}/`);
      await page.waitForFunction(() => (globalThis as unknown as { ready?: boolean }).ready === true, null, { timeout: 15000 });

      for (const v of MEDIA_ID_VECTORS) {
        const [a, b] = await page.evaluate(([s, seed]: number[]) => (globalThis as any).hashVector(s, seed, 1 << 20, 3), [v.size, v.seed]);
        assert.equal(a, v.mediaHash, `bytes, ${v.size}`);
        assert.equal(b, v.mediaHash, `Blob, ${v.size}`);
      }

      // Bigger and odd-sized, with the reference computed by Node here rather than read from a table.
      const size = 9 * (1 << 20) + 77;
      const want = (await hashSource(bytesSource(xorshiftBytes(size, 77)), opts.hasher)).hash;
      const [a, b] = await page.evaluate(([s]: number[]) => (globalThis as any).hashVector(s, 77, 4 << 20, 2), [size]);
      assert.equal(a, want);
      assert.equal(b, want);
      assert.equal(await page.evaluate(([s]: number[]) => (globalThis as any).hashInWorker(s, 77), [size]), want, "in a Web Worker");

      // A disk-backed File, as when a user picks one.
      const file = join(scratch, "picked.bin");
      const picked = xorshiftBytes(6 * (1 << 20) + 3, 78);
      writeFileSync(file, picked);
      await page.setInputFiles("#f", file);
      assert.equal(await page.evaluate(() => (globalThis as any).hashPicked()), (await hashSource(bytesSource(picked), opts.hasher)).hash, "picked File");
    } finally {
      await browser.close();
      server.close();
      rmSync(scratch, { recursive: true, force: true });
    }
  });
}
