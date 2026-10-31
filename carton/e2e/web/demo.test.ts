// The PLAN §17 demo script as an end-to-end test, driven through the real UI in Chromium: two browser contexts (Alice
// and Bob, each their own profile and IndexedDB) and the Director bot as a separate process.
//   1. Alice opens her invite, invites Bob from the editor ("Invite to edit"), Bob joins: both hold the shared cut.
//   2. Live edits with presence: Alice drags a clip; Bob sees her ghost during the drag, then the move.
//   3. The Director rewrites captions (a turn, partly through a subagent) while Bob trims a clip: both land.
//   4. Alice undoes the agent's turn ("Undo Director: punch up the captions"): the captions go back, Bob's trim stays.
//   5. Bob goes offline (the button), trims a clip and edits a caption; Alice trims the same clip end. Bob rejoins:
//      the clean edit rebases silently, the clash is a conflict card; Bob picks his side, and Alice sees it.
//   6. Real offline (the browser's network off): Bob's edit waits, then lands when the network is back.
//   7. Watch the changes: Alice compares the first version with now and plays the changes.
//   8. Alice publishes; a viewer opens the watch page (the published version), and is told when newer edits exist.
// A second test per host: Fold in, including partial ("fold in some of it") and "Fold in the rest" later, from a cut
// on Alice's machine into the shared Main cut.
// Hosts: CARTON_E2E_HOST=node (default) | cloudflare (`wrangler dev`, local) | both.
// Video for the demo recording: CARTON_E2E_VIDEO=<dir> (one .webm per person) and CARTON_E2E_SLOWMO=<ms>.
// Screenshots of each step go to CARTON_E2E_SHOTS=<dir> when set.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { buildClient, carton as cartonDir, joinAs, launchChromium, newPerson, startHost, type Browser, type Page, type TestHost } from "./harness.ts";
import { seedDemo, type SeedResult } from "../../apps/web/scripts/seed.ts";

const hosts = (process.env.CARTON_E2E_HOST ?? "node") === "both" ? ["node", "cloudflare"] : [process.env.CARTON_E2E_HOST ?? "node"];
const video = process.env.CARTON_E2E_VIDEO;
const shots = process.env.CARTON_E2E_SHOTS;
const slow = Number(process.env.CARTON_E2E_SLOWMO ?? 0);
// CARTON_E2E_MEDIA=fake: clip records with no playable media (protocol and UI only, no ffmpeg)
const fakeMedia = process.env.CARTON_E2E_MEDIA === "fake" ? ["Sunrise", "Road", "Cafe", "Dusk"].map((name, i) => ({ id: `media-${i + 1}`, name, hash: String(i + 1).repeat(64), size: 1000, duration: 6 })) : null;

let browser: Browser;
before(async () => {
  await buildClient();
  browser = await launchChromium();
  if (shots) mkdirSync(shots, { recursive: true });
});
after(async () => {
  await browser?.close();
});

const pause = (ms: number) => new Promise((r) => setTimeout(r, ms + slow));
async function shot(page: Page, name: string): Promise<void> {
  if (shots) await page.screenshot({ path: join(shots, `${name}.png`) });
}
const clipEl = (page: Page, id: string) => page.locator(`[data-clip-id="${id}"]`);
async function clipTimes(page: Page, id: string): Promise<{ start: number; end: number }> {
  const el = clipEl(page, id);
  return { start: Number(await el.getAttribute("data-start")), end: Number(await el.getAttribute("data-end")) };
}
async function waitClip(page: Page, id: string, attr: "data-start" | "data-end", value: number, ms = 10_000): Promise<void> {
  await page.waitForFunction(([sel, a, v]: [string, string, string]) => document.querySelector(sel)?.getAttribute(a) === v, [`[data-clip-id="${id}"]`, attr, value.toFixed(1)], { timeout: ms });
}
async function captionOf(page: Page, id: string): Promise<string> {
  return (await clipEl(page, id).locator(".cb-clip-label").textContent()) ?? "";
}
async function waitCaption(page: Page, id: string, text: string, ms = 10_000): Promise<void> {
  await page.waitForFunction(([sel, t]: [string, string]) => document.querySelector(sel)?.textContent === t, [`[data-clip-id="${id}"] .cb-clip-label`, text], { timeout: ms });
}
/**
 * Drag a clip's body or one of its edges by dx pixels, in small steps (so presence ghosts go out), optionally
 * holding before release (`during` runs while the mouse is still down).
 */
async function drag(page: Page, id: string, part: "body" | "start" | "end", dx: number, during?: () => Promise<void>): Promise<void> {
  const box = await clipEl(page, id).boundingBox();
  const y = box.y + box.height / 2;
  const x = part === "start" ? box.x + 2 : part === "end" ? box.x + box.width - 2 : box.x + box.width / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  const steps = 12;
  for (let i = 1; i <= steps; i++) {
    await page.mouse.move(x + (dx * i) / steps, y);
    await pause(30);
  }
  if (during) await during();
  await page.mouse.up();
}
async function editCaption(page: Page, id: string, text: string): Promise<void> {
  await clipEl(page, id).click();
  const input = page.getByTestId("caption-text");
  await input.fill(text);
  await input.press("Enter");
}
async function syncWords(page: Page): Promise<string> {
  return (await page.locator(".carton-sync").textContent()) ?? "";
}

class Bot {
  readonly proc: ChildProcess;
  #waiters: ((e: Record<string, unknown>) => boolean)[] = [];
  /** Events nobody was waiting for yet (a turn can finish while the test is still dragging). */
  #unread: Record<string, unknown>[] = [];
  constructor(link: string, forAccount: string) {
    this.proc = spawn(process.execPath, [join(cartonDir, "apps", "web", "scripts", "director.ts"), "--link", link, "--for", forAccount, "--gap", String(900 + slow)], { stdio: ["pipe", "pipe", "inherit"] });
    createInterface({ input: this.proc.stdout! }).on("line", (line) => {
      let e: Record<string, unknown>;
      try {
        e = JSON.parse(line);
      } catch {
        return;
      }
      const before = this.#waiters.length;
      this.#waiters = this.#waiters.filter((w) => !w(e));
      if (this.#waiters.length === before) this.#unread.push(e);
    });
  }
  next(event: string, ms = 30_000): Promise<Record<string, unknown>> {
    const i = this.#unread.findIndex((e) => e.event === event || e.event === "error");
    if (i >= 0) {
      const [e] = this.#unread.splice(i, 1);
      return e!.event === "error" ? Promise.reject(new Error(String(e!.error))) : Promise.resolve(e!);
    }
    return new Promise((res, rej) => {
      const t = setTimeout(() => rej(new Error(`the bot sent no ${event}`)), ms);
      this.#waiters.push((e) => {
        if (e.event === "error") return clearTimeout(t), rej(new Error(String(e.error))), true;
        if (e.event !== event) return false;
        clearTimeout(t);
        res(e);
        return true;
      });
    });
  }
  send(cmd: Record<string, unknown>): void {
    this.proc.stdin!.write(JSON.stringify(cmd) + "\n");
  }
  async stop(): Promise<void> {
    if (this.proc.exitCode !== null) return;
    this.send({ cmd: "quit" });
    await new Promise((r) => setTimeout(r, 1000));
    if (this.proc.exitCode === null) this.proc.kill("SIGKILL");
  }
}

for (const kind of hosts as ("node" | "cloudflare")[]) {
  test(`§17 demo script on ${kind === "node" ? "server-node" : "server-cloudflare (wrangler dev)"}`, { timeout: 300_000 }, async () => {
    const host: TestHost = await startHost(kind, "demo");
    let bot: Bot | null = null;
    const contexts: { close(): Promise<void> }[] = [];
    const pages: [string, Page][] = [];
    try {
      const seed: SeedResult = await seedDemo({ baseUrl: host.url, adminToken: host.adminToken, media: fakeMedia ? { given: fakeMedia } : { generate: { clipsDir: join(process.env.HOME ?? ".", "gfv-scratch", "carton", "web-demo", "clips") } } });
      const vdir = (who: string) => (video ? join(video, `${kind}-${who}`) : undefined);
      const aliceCtx = await newPerson(browser, vdir("alice"));
      const bobCtx = await newPerson(browser, vdir("bob"));
      contexts.push(aliceCtx, bobCtx);

      // A slow Service Worker install on Alice's first load: the player must not ask for /media/ before the worker
      // controls the page, or the video would stay broken after it does (review R2-2)
      const mediaFromNetwork: string[] = [];
      await aliceCtx.route("**/sw.js", async (route: { continue(): Promise<void> }) => {
        await new Promise((r) => setTimeout(r, 1500));
        await route.continue();
      });
      aliceCtx.on("response", (r: { url(): string; fromServiceWorker(): boolean }) => {
        if (new URL(r.url()).pathname.startsWith("/media/") && !r.fromServiceWorker()) mediaFromNetwork.push(r.url());
      });

      // 1. Alice shares, Bob joins
      const alice = await joinAs(aliceCtx, seed.alice, "Alice");
      pages.push(["alice", alice]);
      if (!fakeMedia) {
        // the preview loads its clip through the worker once it is in control
        await alice.waitForFunction(() => {
          const v = document.querySelector<HTMLVideoElement>('[data-testid="player"] video');
          return !!v && !!v.getAttribute("src") && v.readyState >= 2;
        }, null, { timeout: 30_000 });
        assert.deepEqual(mediaFromNetwork, [], "no media request bypassed the Service Worker");
      }
      await alice.getByTestId("invite").click();
      const link = await alice.getByTestId("invite-link").inputValue();
      assert.match(link, /#join=/);
      await alice.keyboard.press("Escape");
      const bob = await joinAs(bobCtx, link, "Bob");
      pages.push(["bob", bob]);
      for (const p of [alice, bob]) await p.locator(".carton-sync", { hasText: "Up to date" }).waitFor({ timeout: 15_000 });
      await alice.locator('.carton-presence .carton-peer[data-kind="human"]').first().waitFor({ timeout: 10_000 });
      await bob.locator('.carton-presence .carton-peer[data-kind="human"]').first().waitFor({ timeout: 10_000 });
      await shot(alice, `${kind}-1-joined-alice`);

      // 2. a live edit with presence: Bob sees Alice's ghost while she drags, then the move
      const before = await clipTimes(alice, "clip-2");
      await drag(alice, "clip-2", "body", 70, async () => {
        await bob.locator(".carton-ghost").first().waitFor({ state: "visible", timeout: 5000 });
        await shot(bob, `${kind}-2-ghost-bob`);
      });
      const moved = await clipTimes(alice, "clip-2");
      assert.ok(moved.start > before.start, "the clip moved");
      await waitClip(bob, "clip-2", "data-start", moved.start);
      await bob.locator(".carton-ghost").first().waitFor({ state: "detached", timeout: 5000 }).catch(() => {});

      // 3. the Director rewrites captions while Bob trims a clip
      // the Director acts for Alice: its turns are in her undo group (her account is unique per install)
      const aliceAccount: string = await alice.evaluate(() => (window as unknown as { __carton: { session: { account: string } } }).__carton.session.account);
      bot = new Bot(seed.bob, aliceAccount);
      await bot.next("ready");
      await bob.locator('.carton-presence .carton-peer[data-kind="agent"]').first().waitFor({ timeout: 10_000 });
      bot.send({ cmd: "turn", plan: "captions" });
      await pause(400);
      const c3 = await clipTimes(bob, "clip-3");
      await drag(bob, "clip-3", "end", -45);
      const trimmed = await clipTimes(bob, "clip-3");
      assert.ok(trimmed.end < c3.end, "Bob trimmed clip-3");
      // presence while it all happens: Alice sees Bob and the Director (an agent acting for her)
      await alice.locator('.carton-presence .carton-peer[data-kind="human"]').first().waitFor({ timeout: 5000 });
      await alice.locator('.carton-presence .carton-peer[data-kind="agent"]').first().waitFor({ timeout: 5000 });
      const turn = await bot.next("turn-done");
      assert.deepEqual((turn.results as { status: string }[]).map((r) => r.status), ["confirmed", "confirmed", "confirmed", "confirmed"]);
      await waitCaption(alice, "cap-4", "Same time next weekend?");
      await waitCaption(bob, "cap-1", "Saturday. 7 am. Let's go.");
      await waitClip(alice, "clip-3", "data-end", trimmed.end);
      // Credits: who last changed a clip, down to the subagent
      await clipEl(alice, "cap-3").click();
      await alice.getByTestId("credits").click();
      await alice.locator(".cb-credits", { hasText: "Director › captions" }).waitFor({ timeout: 5000 });
      await shot(alice, `${kind}-3-director-alice`);
      await alice.getByTestId("credits").click();

      // 4. Alice undoes the agent's turn
      const undo = alice.locator(".carton-undo", { hasText: "Undo Director: punch up the captions" });
      await undo.waitFor({ timeout: 10_000 });
      await shot(alice, `${kind}-4-undo-turn-alice`);
      await undo.click();
      await waitCaption(alice, "cap-1", "Saturday, 7 am");
      await waitCaption(bob, "cap-4", "See you next weekend");
      assert.equal((await clipTimes(bob, "clip-3")).end, trimmed.end, "Bob's trim kept");

      // 5. Bob goes offline, edits twice; Alice trims the same clip end; Bob rejoins: one card, one clean rebase
      await bob.getByTestId("offline-toggle").click();
      await bob.locator(".carton-sync", { hasText: "Offline" }).waitFor({ timeout: 5000 });
      await drag(bob, "clip-4", "end", -30);
      const bobs = await clipTimes(bob, "clip-4");
      await editCaption(bob, "cap-2", "Bob was offline here");
      await bob.locator(".carton-sync", { hasText: "Offline: 2 edits waiting" }).waitFor({ timeout: 5000 });
      await shot(bob, `${kind}-5-offline-bob`);
      await drag(alice, "clip-4", "end", -80);
      const alices = await clipTimes(alice, "clip-4");
      assert.notEqual(alices.end, bobs.end);
      await pause(300);
      await bob.getByTestId("offline-toggle").click();
      await bob.getByTestId("conflicts").waitFor({ timeout: 10_000 });
      await waitCaption(alice, "cap-2", "Bob was offline here");
      assert.equal(await bob.locator(".cb-conflicts .carton-card, .cb-conflicts [class*=conflict]").count() > 0, true);
      await waitClip(bob, "clip-4", "data-end", alices.end); // head's value stays until Bob picks (H5)
      await shot(bob, `${kind}-5-conflict-bob`);
      await bob.getByRole("button", { name: /^Keep yours/ }).first().click();
      await waitClip(alice, "clip-4", "data-end", bobs.end);
      await bob.getByTestId("conflicts").waitFor({ state: "detached", timeout: 5000 });

      // 6. real offline: the network goes away, the edit waits, then lands
      await bobCtx.setOffline(true);
      await bob.locator(".carton-sync", { hasText: "Offline" }).waitFor({ timeout: 10_000 });
      await editCaption(bob, "cap-3", "Written with no network");
      await bob.locator(".carton-sync", { hasText: "Offline: 1 edit waiting" }).waitFor({ timeout: 5000 });
      // reopening with no network: the shell comes from the Service Worker's cache, the project from the store
      await bob.reload();
      await bob.getByTestId("timeline").waitFor({ timeout: 20_000 });
      await waitCaption(bob, "cap-3", "Written with no network");
      await bob.locator(".carton-sync", { hasText: "Offline: 1 edit waiting" }).waitFor({ timeout: 10_000 });
      await shot(bob, `${kind}-6-reopened-offline-bob`);
      await bobCtx.setOffline(false);
      await waitCaption(alice, "cap-3", "Written with no network", 20_000);

      // 7. Watch the changes: the first version against now
      await alice.locator('[aria-label="Actions for Started the cut"]').click();
      await alice.getByRole("menuitem", { name: "Compare with current" }).click();
      await alice.getByRole("button", { name: "Watch the changes" }).click();
      await alice.getByTestId("watch").waitFor();
      await alice.getByRole("button", { name: "Play changes" }).click();
      await pause(1500);
      await shot(alice, `${kind}-7-watch-alice`);
      await alice.keyboard.press("Escape");
      await alice.getByTestId("watch").waitFor({ state: "detached", timeout: 5000 });
      await alice.locator(".carton-preview-banner").waitFor({ state: "detached", timeout: 5000 });

      // 8. publish, open the watch page as a viewer, then newer edits
      await alice.getByTestId("publish").click();
      await alice.locator(".carton-published").waitFor({ timeout: 10_000 });
      const url: string = await alice.waitForFunction(() => {
        const links = (window as unknown as { __carton: { links: Map<string, string> } }).__carton.links;
        return [...links.values()][0];
      }, null, { timeout: 10_000 }).then((h: { jsonValue(): Promise<string> }) => h.jsonValue());
      assert.match(url, /\/watch\.html#/);
      const viewerCtx = await newPerson(browser, vdir("viewer"));
      contexts.push(viewerCtx);
      const watch = await viewerCtx.newPage();
      await watch.goto(url);
      await watch.getByTestId("up-to-date").waitFor({ timeout: 15_000 });
      await watch.getByTestId("player").waitFor();
      await shot(watch, `${kind}-8-watch-page`);
      await editCaption(bob, "cap-1", "An edit after publishing");
      await watch.getByTestId("newer-edits").waitFor({ timeout: 20_000 }); // the watch page asks every 5 s
      await alice.locator(".carton-published[data-stale]").waitFor({ timeout: 10_000 });
      await shot(watch, `${kind}-8-watch-page-newer`);
      assert.equal(await captionOf(alice, "cap-1"), "An edit after publishing");
    } catch (e) {
      // what each person saw when it failed
      if (shots) for (const [who, page] of pages) await page.screenshot({ path: join(shots, `${kind}-FAILED-${who}.png`) }).catch(() => {});
      for (const [who, page] of pages) {
        const peers = await page.evaluate(() => (window as unknown as { __carton: { ui: { peers(): { actor: { key: string }; idle: boolean }[] } } }).__carton.ui.peers().map((p) => p.actor.key + (p.idle ? " (idle)" : ""))).catch(() => []);
        console.error(`[${who}] sync: ${await syncWords(page).catch(() => "?")}; peers: ${peers.join(", ")}; notes: ${await page.locator(".carton-undo-note, [role=alert]").allTextContents().catch(() => [])}`);
      }
      throw e;
    } finally {
      await bot?.stop();
      for (const c of contexts) await c.close().catch(() => {});
      await host.close();
    }
  });
}

for (const kind of hosts as ("node" | "cloudflare")[]) {
  test(`Fold in some of it, then the rest, into the shared Main cut on ${kind === "node" ? "server-node" : "server-cloudflare (wrangler dev)"}`, { timeout: 180_000 }, async () => {
    const host: TestHost = await startHost(kind, "fold");
    const contexts: { close(): Promise<void> }[] = [];
    try {
      const seed: SeedResult = await seedDemo({ baseUrl: host.url, adminToken: host.adminToken, media: fakeMedia ? { given: fakeMedia } : { generate: { clipsDir: join(process.env.HOME ?? ".", "gfv-scratch", "carton", "web-demo", "clips") } } });
      const aliceCtx = await newPerson(browser), bobCtx = await newPerson(browser);
      contexts.push(aliceCtx, bobCtx);
      const alice = await joinAs(aliceCtx, seed.alice, "Alice");
      const bob = await joinAs(bobCtx, seed.bob, "Bob");
      const cuts = alice.locator(".carton-cuts-trigger");
      // a cut of her own, from Main's head: it lives on her machine
      await cuts.click();
      await alice.getByRole("menuitem", { name: "New cut from here" }).click();
      await alice.getByPlaceholder("30s Instagram cut").fill("30s Instagram cut");
      await alice.getByRole("button", { name: "Create" }).click();
      await alice.locator(".carton-cuts-name", { hasText: "30s Instagram cut" }).waitFor();
      const c1 = await clipTimes(alice, "clip-1");
      await drag(alice, "clip-1", "end", -40);
      const trimmed = await clipTimes(alice, "clip-1");
      assert.ok(trimmed.end < c1.end);
      await editCaption(alice, "cap-4", "Follow for part two");
      await pause(300);
      assert.equal((await clipTimes(bob, "clip-1")).end, c1.end, "Bob's Main cut doesn't see the cut's edits");
      // fold in some of it: the trim, not the caption
      await cuts.click();
      await alice.getByRole("menuitem", { name: /^Fold into/ }).click();
      const dialog = alice.locator(".carton-dialog");
      await dialog.waitFor();
      const caption = dialog.locator("li, .carton-fold-change", { hasText: "Follow for part two" }).locator("input[type=checkbox]");
      await caption.uncheck();
      await shot(alice, `${kind}-fold-dialog`);
      await dialog.getByRole("button", { name: "Fold in 1 of 2" }).click();
      await dialog.waitFor({ state: "detached", timeout: 10_000 });
      await waitClip(bob, "clip-1", "data-end", trimmed.end);
      assert.equal(await captionOf(bob, "cap-4"), "See you next weekend", "the left-out edit stays out");
      // back on Main, "Fold in the rest" from History
      await cuts.click();
      await alice.getByRole("menuitemradio", { name: "Main cut" }).click();
      await alice.locator(".carton-cuts-name", { hasText: "Main cut" }).waitFor();
      // the newest version is the fold's inverse (the part left out): its menu offers the rest
      const row = alice.locator(".carton-version").first();
      await row.waitFor({ timeout: 10_000 });
      await row.hover();
      await row.locator(".carton-version-more").click();
      await alice.getByRole("menuitem", { name: "Fold in the rest" }).click();
      await waitCaption(bob, "cap-4", "Follow for part two");
      await shot(bob, `${kind}-fold-rest-bob`);
    } catch (e) {
      if (shots) for (const [i, c] of contexts.entries()) for (const pg of (c as unknown as { pages(): Page[] }).pages()) await pg.screenshot({ path: join(shots, `${kind}-fold-FAILED-${i}.png`) }).catch(() => {});
      throw e;
    } finally {
      for (const c of contexts) await c.close().catch(() => {});
      await host.close();
    }
  });
}
