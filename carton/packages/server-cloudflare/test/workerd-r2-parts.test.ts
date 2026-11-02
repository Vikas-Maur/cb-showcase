// R2 part uploads inside real workerd (wrangler dev, R2 bound), on the paths the review found untested (cf review
// finding 8): a part request cut off while it holds its part's lock, then resumed at once; a streamed part whose body
// is shorter or longer than its declared size (FixedLengthStream); and a part streamed through the Worker's production
// route, over time, with no test route in between.
//
// What local workerd can't show: on Cloudflare a client's disconnect cancels the request's work unless it is held with
// waitUntil (worker.ts), and a part request cut off that way left its lock held for 30 minutes (cf-lab, 2026-11-02).
// Locally the work runs on after a disconnect whether held or not (a request that waits a second after its body fails,
// then writes, writes, through wrangler's proxy and past it), so the lock test passes without that fix too: it checks
// the lock's whole life across a real disconnect and resume, and worker-wait-until.test.ts checks the hand-over.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { createHmacAuth } from "@carton/server";
import { hostMediaBlobs } from "@carton/host-http/client";
import { startDev } from "./dev-server.ts";
import { stateDir } from "./state.ts";
import { mediaApi } from "./media-api.ts";

const SECRET = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url");
const dev = await startDev({ config: join(import.meta.dirname, "wrangler.r2.dev.toml"), state: stateDir(`dev-r2-parts-${Date.now()}`), vars: { AUTH_SECRET: SECRET } });
after(() => dev.stop());
const auth = createHmacAuth({ secret: SECRET });
const bytes = (n: number, seed = 1) => new Uint8Array(n).map((_, i) => (i * 31 + seed) % 251);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const MiB = 1 << 20;

test("a part request cut off while it holds its R2 part lock releases it: the part's immediate resume is taken (cf review finding 8)", async () => {
  const project = `lock-${Date.now()}`;
  const api = await mediaApi(dev.origin, auth, project);
  const key = `m/${"c".repeat(64)}`;
  const data = bytes(MiB, 9);
  const made = await api.create(key, data.byteLength);
  assert.equal(made.status, 200, JSON.stringify(made.body));
  const id = String(made.body!.uploadId);
  // the lock is taken before the body arrives (the part streams to R2): cut off a quarter of the way in
  const cutAt = Date.now();
  assert.equal(await api.slowPart(key, id, 1, data, { pieces: 16, everyMs: 100, cutAfter: 4 }), "cut");
  const lock = async () => (await (await fetch(`${dev.origin}/__test/r2-lock?id=${encodeURIComponent(id)}&n=1`)).json()) as { state: string; at: number } | null;
  let l = await lock();
  for (const t = Date.now(); l?.state !== "released" && Date.now() - t < 2000; l = await lock()) await sleep(50);
  assert.equal(l?.state, "released", `the cut-off request's lock: ${JSON.stringify(l)}`);
  assert.ok(l!.at >= cutAt, "taken by the cut-off request, and released after it");
  // resumed at once, as the app's uploader retries: taken within a moment, not refused for the lock's 30 minutes
  const t0 = Date.now();
  let p1 = await api.part(key, id, 1, data);
  while (p1.status !== 200 && Date.now() - t0 < 3000) {
    await sleep(100);
    p1 = await api.part(key, id, 1, data);
  }
  assert.equal(p1.status, 200, `the resume of the cut-off part: ${JSON.stringify(p1.body)}`);
  const done = await api.complete(key, id, [p1.body]);
  assert.equal(done.status, 200, JSON.stringify(done.body));
  assert.equal(done.body!.size, MiB);
  const back = await hostMediaBlobs({ origin: dev.origin, projectId: project, token: api.token }).get(key);
  assert.ok(back && back.byteLength === MiB && back.every((x, i) => x === data[i]), "the object is the resumed part's bytes");
});

test("a streamed R2 part shorter or longer than its declared size is refused, nothing of it is listed, and its lock is free for the whole part (cf review finding 8)", async () => {
  const r = (await (await fetch(`${dev.origin}/__test/r2-fixed-length`)).json()) as { short: string; long: string; listed: number; whole: string; size: number | null };
  assert.match(r.short, /^refused/, `a short body: ${r.short}`);
  assert.match(r.long, /^refused/, `a long body: ${r.long}`);
  assert.equal(r.listed, 0, "neither bad part is listed");
  assert.equal(r.whole, "stored", "the whole part goes up at once: no lock left held");
  assert.equal(r.size, 64 * 1024);
});

test("a part streamed slowly through the Worker's production route is stored whole (cf review finding 8)", async () => {
  const project = `stream-${Date.now()}`;
  const api = await mediaApi(dev.origin, auth, project);
  const key = `m/${"d".repeat(64)}`;
  const data = bytes(2 * MiB + 7, 4);
  const id = String((await api.create(key, data.byteLength)).body!.uploadId);
  const p1 = await api.slowPart(key, id, 1, data, { pieces: 20, everyMs: 50 });
  assert.notEqual(p1, "cut");
  assert.equal((p1 as { status: number }).status, 200, JSON.stringify(p1));
  const done = await api.complete(key, id, [(p1 as { body: unknown }).body]);
  assert.equal(done.status, 200, JSON.stringify(done.body));
  const back = await hostMediaBlobs({ origin: dev.origin, projectId: project, token: api.token }).get(key);
  assert.ok(back && back.byteLength === data.byteLength && back.every((x, i) => x === data[i]), "the object is whole");
});
