// The web app on its own (no desktop app, no admin token), against the PRODUCTION Worker config
// (wrangler.production.toml: open creation on, blobs in the BlobVault Durable Object, no R2) under `wrangler dev`,
// local only, never deployed:
//   1. Alice opens the site, makes a New project (the browser is its owner), adds a short clip and invites Bob;
//   2. Bob joins from the link, sees the clip on the timeline and plays it while Alice's upload is still going, and
//      trims it;
//   3. Alice sees Bob's trim; her upload finishes; the landing page lists the project.
// Alice's upload is slowed (DevTools network throttling) so the clip is still going up while Bob watches.
// Screenshots: CARTON_E2E_SHOTS=<dir>. Host: CARTON_E2E_CREATE_HOST=cloudflare (default) | node | <https://… URL of a
// running host, e.g. the production Worker: nothing is started; the project made there stays>.
// CARTON_E2E_PROJECT=<name> names the project (default "Beach day"). Timings are printed as `[timing] …` lines.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { buildClient, joinAs, launchChromium, newPerson, remoteHost, scratch, startHost, type Browser, type Page, type TestHost } from "./harness.ts";

const shots = process.env.CARTON_E2E_SHOTS;
const hostArg = process.env.CARTON_E2E_CREATE_HOST ?? "cloudflare";
const remote = /^https?:\/\//.test(hostArg) ? hostArg : null;
const kind = remote ? "remote" : (hostArg as "node" | "cloudflare");
const projectName = process.env.CARTON_E2E_PROJECT ?? "Beach day";
const timing = (what: string, ms: number) => console.log(`[timing] ${what}: ${(ms / 1000).toFixed(1)} s`);
let browser: Browser, host: TestHost, clip: string;

before(async () => {
  if (!remote) await buildClient();
  browser = await launchChromium();
  if (shots) mkdirSync(shots, { recursive: true });
  // a 20 s 720p H.264 clip with its index (moov) at the end, as cameras and ffmpeg write it by default: the pieces
  // send the index first so a teammate can start playing
  mkdirSync(scratch, { recursive: true });
  clip = join(scratch, "beach-walk.mp4");
  if (!existsSync(clip))
    execFileSync(process.env.CARTON_FFMPEG ?? "ffmpeg", ["-loglevel", "error", "-y", "-f", "lavfi", "-i", "testsrc2=size=1280x720:rate=30", "-f", "lavfi", "-i", "sine=frequency=330", "-t", "20", "-c:v", "libx264", "-b:v", "3M", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", clip]);
  host = remote ? await remoteHost(remote) : await startHost(kind as "node" | "cloudflare", "create", kind === "cloudflare" ? { config: "wrangler.production.toml" } : { openCreate: true });
});
after(async () => {
  await browser?.close();
  await host?.close();
});

async function shot(page: Page, name: string): Promise<void> {
  if (shots) await page.screenshot({ path: join(shots, `${name}.png`) });
}
type Job = { phase: string; done: number; total: number };
const uploads = (page: Page): Promise<Job[]> => page.evaluate(() => (window as unknown as { __carton: { uploads: { get(): { phase: string; done: number; total: number }[] } } }).__carton.uploads.get());

test(`a project made in the browser: create, upload, invite, a teammate plays it while it uploads and edits (${remote ?? kind})`, { timeout: 600_000 }, async () => {
  const a = await newPerson(browser);
  const alice = await a.newPage();
  alice.on("pageerror", (e: Error) => console.error(`[alice] page error: ${e.message}`));
  await alice.goto(host.url);
  await alice.getByTestId("new-project").click();
  await alice.getByTestId("new-title").fill(projectName);
  await alice.getByTestId("new-person").fill("Alice");
  await alice.locator("[data-testid=create]:not([disabled])").waitFor();
  await shot(alice, "2-new-project");
  const t0 = Date.now();
  await alice.getByTestId("create").click();
  await alice.getByTestId("timeline").waitFor({ timeout: 30_000 });
  timing("create: Create project pressed → editor open", Date.now() - t0);
  await alice.getByTestId("empty-timeline").waitFor();
  assert.equal(await alice.getByTestId("project-name").textContent(), projectName);
  const me = await alice.evaluate(() => (window as unknown as { __carton: { session: { role: string; projectId: string } } }).__carton.session);
  assert.equal(me.role, "owner");

  // a file the browser can't play is refused in words, and nothing is added
  await alice.getByTestId("add-video-input").setInputFiles({ name: "notes.mov", mimeType: "video/quicktime", buffer: Buffer.from("not a video at all") });
  await alice.getByText("can't play in a browser").waitFor();
  assert.equal(await alice.locator("[data-clip-id]").count(), 0);
  await shot(alice, "2b-unplayable-refused");
  await alice.getByRole("button", { name: "Dismiss" }).click();

  // Alice's uplink at about 1.5 MB/s, so the clip (about 8 MB, sent as pieces and then whole) takes several seconds
  const cdp = await a.newCDPSession(alice);
  await cdp.send("Network.enable");
  await cdp.send("Network.emulateNetworkConditions", { offline: false, latency: 5, downloadThroughput: -1, uploadThroughput: 1_500_000 });
  const tUpload = Date.now();
  await alice.getByTestId("add-video-input").setInputFiles(clip);
  const clipEl = alice.locator("[data-clip-id]").first();
  await clipEl.waitFor({ timeout: 20_000 });
  const clipId = await clipEl.getAttribute("data-clip-id");
  timing("upload: file picked → clip on Alice's timeline", Date.now() - tUpload);
  await alice.getByTestId("upload-progress").waitFor();
  // some of it is up (a piece or two), most is still to go
  await alice.waitForFunction(() => {
    const pct = Number(document.querySelector("[data-testid=upload-progress] .cb-upload")?.getAttribute("data-pct"));
    return pct >= 5 && pct < 60;
  }, null, { timeout: 30_000 });
  // Alice plays it from her own file at once
  await alice.waitForFunction(() => (document.querySelector(".cb-viewer video") as HTMLVideoElement | null)?.readyState! >= 2, null, { timeout: 15_000 });
  await shot(alice, "3-upload-in-progress");

  // Invite to edit, with the roles
  await alice.getByTestId("invite").click();
  await alice.locator("[data-testid=invite-link][data-role=editor]").waitFor({ timeout: 20_000 });
  const roles = await alice.getByTestId("invite-role").locator("option").allTextContents();
  assert.deepEqual(roles, ["Can edit", "Can comment", "Can watch"]);
  await shot(alice, "4-invite");
  const link = await alice.getByTestId("invite-link").inputValue();
  await alice.getByRole("button", { name: "Done" }).click();

  // Bob joins while the clip is still uploading, and plays it
  const b = await newPerson(browser);
  const tJoin = Date.now();
  const bob = await joinAs(b, link, "Bob");
  await bob.locator(`[data-clip-id="${clipId}"]`).waitFor({ timeout: 20_000 });
  timing("Bob: Join pressed → clip on his timeline", Date.now() - tJoin);
  assert.equal((await uploads(alice)).find((j) => j.phase === "uploading") !== undefined, true, "Alice's upload is still going when Bob opens the project");
  const tPlay = Date.now();
  await bob.getByTestId("play").click();
  await bob.waitForFunction(() => {
    const v = document.querySelector(".cb-viewer video") as HTMLVideoElement | null;
    return !!v && v.readyState >= 2 && v.currentTime > 0;
  }, null, { timeout: 60_000 });
  timing("Bob: Play pressed → first frame moving", Date.now() - tPlay);
  await bob.waitForFunction(() => {
    const v = document.querySelector(".cb-viewer video") as HTMLVideoElement | null;
    return !!v && v.readyState >= 2 && v.currentTime > 0.5;
  }, null, { timeout: 60_000 });
  const stillUploading = (await uploads(alice)).some((j) => j.phase === "uploading");
  timing("Bob: Play pressed → 0.5 s played", Date.now() - tPlay);
  await bob.getByTestId("play").click(); // pause
  await shot(bob, "5-bob-plays-while-uploading");
  assert.ok(stillUploading, "Bob's player ran while Alice's upload was still going");

  // Bob trims the clip's end; Alice sees it
  const before = Number(await alice.locator(`[data-clip-id="${clipId}"]`).getAttribute("data-end"));
  const box = await bob.locator(`[data-clip-id="${clipId}"]`).boundingBox();
  await bob.mouse.move(box.x + box.width - 2, box.y + box.height / 2);
  await bob.mouse.down();
  for (let i = 1; i <= 10; i++) await bob.mouse.move(box.x + box.width - 2 - 12 * i, box.y + box.height / 2);
  await bob.mouse.up();
  const bobEnd = Number(await bob.locator(`[data-clip-id="${clipId}"]`).getAttribute("data-end"));
  assert.ok(bobEnd < before, `Bob trimmed it (${before} → ${bobEnd})`);
  const tTrim = Date.now();
  await alice.waitForFunction(([sel, v]: [string, string]) => document.querySelector(sel)?.getAttribute("data-end") === v, [`[data-clip-id="${clipId}"]`, bobEnd.toFixed(1)], { timeout: 20_000 });
  timing("Bob's trim → seen on Alice's timeline", Date.now() - tTrim);
  await shot(bob, "6-bob-trimmed");

  // the upload finishes (pieces, then the whole file) and Alice's chip goes
  await alice.waitForFunction(() => !document.querySelector("[data-testid=upload-progress]"), null, { timeout: 300_000 });
  timing("upload: file picked → fully up (pieces, then the whole file; throttled to 1.5 MB/s)", Date.now() - tUpload);
  assert.deepEqual((await uploads(alice)).map((j) => j.phase), ["done"]);
  // the whole file is on the host, and its pieces are gone
  const held = await alice.evaluate(async () => {
    const c = (window as unknown as { __carton: { live: { doc: { media: { contentHash: string }[] } }; hasBlob(k: string): Promise<boolean> } }).__carton;
    const hash = c.live.doc.media[0]!.contentHash;
    return { whole: await c.hasBlob(`m/${hash}`), info: await c.hasBlob(`lv/${hash}/info`), piece: await c.hasBlob(`lv/${hash}/0`) };
  });
  assert.deepEqual(held, { whole: true, info: false, piece: false });

  // the landing page lists the project for Alice (owner) and Bob (can edit)
  await alice.close();
  const home = await a.newPage();
  await home.goto(host.url);
  await home.getByTestId("project-list").waitFor();
  assert.match(await home.getByTestId("project-list").textContent(), new RegExp(`${projectName}.*Owner`));
  await shot(home, "1-landing");
  const bobHome = await b.newPage();
  await bobHome.goto(host.url);
  assert.match(await bobHome.getByTestId("project-list").textContent(), new RegExp(`${projectName}.*Can edit`));
  // and reopens it
  await home.getByTestId("project-open").first().click();
  await home.getByTestId("timeline").waitFor({ timeout: 30_000 });
  await home.locator(`[data-clip-id="${clipId}"]`).waitFor();
  await a.close();
  await b.close();
});
