// store-idb in headless Chromium: the Store conformance suite, then what only real tabs can show: the cross-tab
// compare-and-swap, BroadcastChannel notices, the Web Locks push role, and a database deleted under an open tab.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { launch, serve, openPage, urlOf, type Context, type Page } from "./browser.ts";
import type * as PageApi from "./page.ts";

const PAGE = urlOf("packages/store-idb/test/page.ts");
const started = await launch();
type Api = typeof PageApi;

/** Call `fn(api, arg)` inside a page, where `api` is page.ts. */
function inPage<R, A>(page: Page, fn: (api: Api, arg: A) => R | Promise<R>, arg: A): Promise<R> {
  return page.evaluate(
    async ({ url, src, arg }: { url: string; src: string; arg: A }) => {
      const api = await import(url);
      return (0, eval)(`(${src})`)(api, arg);
    },
    { url: PAGE, src: fn.toString(), arg },
  );
}

if (!started.browser) {
  test("store-idb in headless Chromium", { skip: started.skip }, () => {});
} else {
  const browser = started.browser;
  after(() => browser.close());
  const ctx: Context = await serve(browser);
  const page = await openPage(ctx);

  // One page runs the whole suite; each case gets a fresh database.
  const results = await inPage(page, (api) => api.conformance(), null);
  for (const r of results) {
    test(`store conformance (idb): ${r.name}`, () => {
      if (!r.ok) assert.fail(r.error);
    });
  }

  test("three tabs racing CAS appends lose nothing (IndexedDB readwrite transactions serialize across tabs)", async () => {
    const tabs = [page, await openPage(ctx), await openPage(ctx)];
    const id = `xtab-${Date.now()}`;
    const races = await Promise.all(tabs.map((p, i) => inPage(p, (api, a) => api.casAppend(a.id, a.tab, 100), { id, tab: `tab${i}` })));
    const log = await inPage(tabs[1], (api, id) => api.readLog(id), id);
    console.log(JSON.stringify({ rows: log.seqs.length, lostRaces: races.map((r) => r.lostRaces) }));
    assert.equal(log.seqs.length, 300);
    assert.ok(log.seqs.every((s, i) => s === i + 1), "seqs contiguous");
    assert.equal(new Set(log.ids).size, 300, "each append landed once");
    assert.equal(log.idRows, 300);
    await tabs[1].close();
    await tabs[2].close();
  });

  test("a write in one tab reaches the other tabs' watch listeners (BroadcastChannel)", async () => {
    const id = `bc-${Date.now()}`;
    const a = await openPage(ctx), b = await openPage(ctx);
    await inPage(a, (api, id) => api.watch(id), id);
    assert.equal(await inPage(b, (api, a) => api.write(a.id, "changes", ["main", 1], { x: 1 }), { id }), true);
    let heard: string[][] = [];
    for (let i = 0; i < 50 && !heard.length; i++) {
      heard = await inPage(a, (api) => api.heardSoFar(), null);
      if (!heard.length) await new Promise((r) => setTimeout(r, 20));
    }
    assert.deepEqual(heard, [["changes"]]);
    assert.deepEqual(await inPage(a, (api, id) => api.get(id, "changes", ["main", 1]), id), { x: 1 }, "and the other tab reads the write");
    await a.close();
    await b.close();
  });

  test("one pusher per origin: the push lock is exclusive and passes on when its tab closes", async () => {
    const id = `lock-${Date.now()}`;
    const a = await openPage(ctx), b = await openPage(ctx);
    assert.equal(await inPage(a, (api, id) => api.holdPushLock(id), id), true);
    assert.equal(await inPage(b, (api, id) => api.tryPushLock(id), id), false, "a second tab can't take it");
    await inPage(b, (api, id) => api.waitPushLock(id), id);
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(await inPage(b, (api) => api.waited(), null), false, "it waits while the holder lives");
    await a.close(); // a crash or close releases at once: no lease expiry
    let got = false;
    for (let i = 0; i < 100 && !got; i++) {
      got = await inPage(b, (api) => api.waited(), null);
      if (!got) await new Promise((r) => setTimeout(r, 10));
    }
    assert.equal(got, true, "the waiting tab took over");
    await b.close();
  });

  test("deleting the database from another tab is never blocked by an open store, which then says so", async () => {
    const id = `del-${Date.now()}`;
    const a = await openPage(ctx), b = await openPage(ctx);
    assert.equal(await inPage(a, (api, id) => api.write(id, "t", ["k"], 1), id), true);
    await inPage(b, (api, id) => api.deleteDb(id), id);
    assert.match(await inPage(a, (api, id) => api.afterDelete(id), id), /closed.*reload/);
    await a.close();
    await b.close();
  });

  test("writes survive a reload of the tab", async () => {
    const id = `reload-${Date.now()}`;
    const a = await openPage(ctx);
    assert.equal(await inPage(a, (api, id) => api.write(id, "changes", ["main", 1], { kept: true }), id), true);
    await a.goto("http://carton.localhost/");
    assert.deepEqual(await inPage(a, (api, id) => api.get(id, "changes", ["main", 1]), id), { kept: true });
    await a.close();
  });
}
