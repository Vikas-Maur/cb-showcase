// The media path in a real browser: headless Chromium opens a page served by a Node host (staticDir: a tiny page and
// the built sw.js), the page starts the media client, and a <video> on /media/<hash> must load, seek and play through
// the Service Worker (the host itself has no /media route). Then the two ways a page learns that bytes went out bad.
//
// Uses Playwright and a Chromium from outside this repo (no dependency on them): set CARTON_PLAYWRIGHT (the playwright
// package folder) and CARTON_CHROMIUM (the browser binary); the test is skipped when they aren't there.

import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, describe, test } from "node:test";
import { build } from "esbuild";
import { mediaKey } from "@carton/media";
import { httpBlobStore } from "../src/http-blobs.ts";
import { buildServiceWorker } from "../scripts/build-sw.ts";
import { makeSampleClips, type SampleClip } from "../scripts/clips.ts";
import { uploadSampleMedia, type UploadedClip } from "../scripts/upload-media.ts";
import { SCRATCH, startTestHost, type TestHost } from "./host.ts";

const PLAYWRIGHT = process.env.CARTON_PLAYWRIGHT ?? "/home/ubuntu/.npm/_npx/e41f203b7505f1fb/node_modules/playwright";
const CHROMIUM = process.env.CARTON_CHROMIUM ?? "/home/ubuntu/.cache/ms-playwright/chromium-1248/chrome-linux-arm64/chrome";
const skip = existsSync(PLAYWRIGHT) && existsSync(CHROMIUM) ? false : "Playwright or Chromium not found (set CARTON_PLAYWRIGHT and CARTON_CHROMIUM)";

// The slice of Playwright's API used here (it isn't a dependency of this app, so no types from it).
interface Page {
  goto(url: string): Promise<unknown>;
  waitForFunction(fn: string, arg?: unknown, opts?: { timeout?: number; polling?: number }): Promise<unknown>;
  evaluate<T>(fn: string): Promise<T>;
  on(event: "console" | "pageerror", fn: (m: { text?: () => string; message?: string }) => void): void;
}
interface Context {
  newPage(): Promise<Page>;
  close(): Promise<void>;
}
interface Browser {
  newContext(): Promise<Context>;
  close(): Promise<void>;
}

describe("media in Chromium, through the Service Worker", { skip }, () => {
  let th: TestHost;
  let staticDir: string;
  let browser: Browser;
  let good: UploadedClip; // a multi-leaf clip, intact
  let clip: SampleClip;
  let token: string;
  let badToken: string;
  const logs: string[] = [];

  before(async () => {
    await mkdir(SCRATCH, { recursive: true });
    staticDir = await mkdtemp(join(SCRATCH, "static-"));
    await writeFile(join(staticDir, "index.html"), '<!doctype html><meta charset="utf-8"><title>carton media test</title><body><script type="module" src="/page.js"></script></body>');
    await buildServiceWorker(join(staticDir, "sw.js"));
    await build({
      entryPoints: [fileURLToPath(new URL("./fixtures/browser-page.ts", import.meta.url))],
      outfile: join(staticDir, "page.js"),
      bundle: true,
      format: "esm",
      platform: "browser",
      target: "es2022",
      logLevel: "warning",
    });
    th = await startTestHost({ staticDir });
    const clips = await makeSampleClips(join(SCRATCH, "clips"));
    clip = clips.find((c) => c.id === "life")!;
    token = await th.session("web");
    [good] = await uploadSampleMedia({ store: httpBlobStore({ baseUrl: th.url, projectId: "web", token: () => token }), clips: [clip] });
    // project "bad" holds the same clip with one byte flipped on the host, inside the first leaf after the moov
    badToken = await th.session("bad");
    await uploadSampleMedia({ store: httpBlobStore({ baseUrl: th.url, projectId: "bad", token: () => badToken }), clips: [clip] });
    const bytes = new Uint8Array(await readFile(clip.file));
    bytes[600_000] ^= 0xff;
    await th.mediaScope("bad").put(mediaKey(good!.hash), bytes, { contentType: "video/mp4" });

    const { chromium } = createRequire(import.meta.url)(PLAYWRIGHT) as { chromium: { launch(o: object): Promise<Browser> } };
    browser = await chromium.launch({ executablePath: CHROMIUM, headless: true, args: ["--autoplay-policy=no-user-gesture-required"], timeout: 30_000 });
  });

  after(async () => {
    await browser?.close();
    await th?.close();
    if (staticDir) await rm(staticDir, { recursive: true, force: true });
  });

  async function open(projectId: string, tok: string, hash: string): Promise<{ page: Page; ctx: Context }> {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    page.on("console", (m) => logs.push(`console: ${m.text?.()}`));
    page.on("pageerror", (e) => logs.push(`pageerror: ${e.message}`));
    await page.goto(`${th.url}/#p=${projectId}&t=${encodeURIComponent(tok)}&h=${hash}`);
    await page.waitForFunction("window.__media && window.__media.done", undefined, { timeout: 30_000 });
    return { page, ctx };
  }

  test("a first load plays /media/<hash> through the worker: loads, seeks, plays", { timeout: 90_000 }, async () => {
    assert.equal((await fetch(`${th.url}/media/${good.hash}`)).status, 404, "the host has no /media route: only the worker answers it");
    const { page, ctx } = await open("web", token, good.hash);
    try {
      const out = await page.evaluate<{ error?: string; controlled?: boolean; loaded?: { readyState: number; duration: number; width: number; height: number } }>("window.__media");
      assert.equal(out.error, undefined, `${out.error}\n${logs.join("\n")}`);
      assert.equal(out.controlled, true, "the worker took over the page on its first load");
      assert.ok(out.loaded!.readyState >= 2, "loadeddata");
      assert.ok(Math.abs(out.loaded!.duration - clip.duration) < 0.1, `duration ${out.loaded!.duration}`);
      assert.deepEqual([out.loaded!.width, out.loaded!.height], [640, 360]);
      // a seek near the end is a range request the worker answers from later leaves
      const seeked = await page.evaluate<number>(`new Promise((ok) => { const v = window.__video; v.addEventListener("seeked", () => ok(v.readyState), { once: true }); v.currentTime = ${clip.duration - 1.5}; })`);
      assert.ok(seeked >= 2, "seeked with a frame to show");
      const played = await page.evaluate<number>(`new Promise((ok, fail) => { const v = window.__video; const t0 = v.currentTime; const tick = () => v.currentTime > t0 + 0.4 ? ok(v.currentTime - t0) : setTimeout(tick, 50); v.play().then(tick, fail); })`);
      assert.ok(played > 0.4, "it plays");
    } finally {
      await ctx.close();
    }
  });

  test("carton-media-bad reloads the <video> showing that media, at the time it was at", { timeout: 60_000 }, async () => {
    const { page, ctx } = await open("web", token, good.hash);
    try {
      await page.evaluate(`new Promise((ok) => { const v = window.__video; v.addEventListener("seeked", ok, { once: true }); v.currentTime = 3; })`);
      // the message the worker posts, dispatched on the page's ServiceWorkerContainer
      await page.evaluate(`navigator.serviceWorker.dispatchEvent(new MessageEvent("message", { data: { type: "carton-media-bad", hash: "${good.hash}" } }))`);
      await page.waitForFunction(`window.__video.currentSrc.includes("reload=") && window.__video.readyState >= 1 && Math.abs(window.__video.currentTime - 3) < 0.05`, undefined, { timeout: 20_000 });
      const state = await page.evaluate<{ bad: string[]; hash: string | null }>(`({ bad: window.__media.bad, hash: window.__hashOf(window.__video.currentSrc) })`);
      assert.deepEqual(state.bad, [good.hash], "onBad listeners hear it too");
      assert.equal(state.hash, good.hash, "the reloaded URL still names the same media");
      // a copy bad on the host reports on every read: reloads stop after three a minute instead of looping
      for (let i = 0; i < 4; i++) {
        await page.evaluate(`navigator.serviceWorker.dispatchEvent(new MessageEvent("message", { data: { type: "carton-media-bad", hash: "${good.hash}" } }))`);
        await page.waitForFunction("window.__video.readyState >= 1", undefined, { timeout: 20_000 });
      }
      const src = await page.evaluate<string>("window.__video.currentSrc");
      assert.equal(new URL(src).searchParams.get("reload"), "3", src);
    } finally {
      await ctx.close();
    }
  });

  test("a copy that is bad on the host: the worker's served-bad reaches the page", { timeout: 60_000 }, async () => {
    const { page, ctx } = await open("bad", badToken, good.hash);
    try {
      await page.waitForFunction("window.__media.bad.length > 0", undefined, { timeout: 30_000 });
      const bad = await page.evaluate<string[]>("window.__media.bad");
      assert.equal(bad[0], good.hash);
    } finally {
      await ctx.close();
    }
  });
});
