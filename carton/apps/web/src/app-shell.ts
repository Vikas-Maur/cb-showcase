// The app shell offline (PLAN §13: offline is a first-class state): the Service Worker keeps the editor's own files
// (the HTML, the entry and its chunks; the list comes from the build), so a project opened in this browser before
// reopens with no network, from its IndexedDB store, and syncs its waiting edits once the network is back.
// Network first: a fresh build is always picked up when online; the cache answers only when the network can't.
// API routes, signed blob URLs and media are never cached here (media has its own verified leaf cache).

const SHELL = "carton-shell-v1";

interface ShellScope {
  readonly location: { readonly origin: string };
  addEventListener(type: "install", fn: (e: { waitUntil(p: Promise<unknown>): void }) => void): void;
  addEventListener(type: "fetch", fn: (e: { request: Request; respondWith(r: Promise<Response>): void }) => void): void;
}

export function installAppShell(sw: ShellScope, assets: readonly string[], cacheStorage: CacheStorage = caches): void {
  const known = new Set(assets);
  sw.addEventListener("install", (e) => e.waitUntil(cacheStorage.open(SHELL).then((c) => c.addAll([...assets])).catch(() => {})));
  sw.addEventListener("fetch", (e) => {
    const req = e.request;
    if (req.method !== "GET") return;
    const url = new URL(req.url);
    if (url.origin !== sw.location.origin) return;
    const page = req.mode === "navigate";
    if (!page && !known.has(url.pathname)) return;
    e.respondWith(
      (async () => {
        const cache = await cacheStorage.open(SHELL);
        try {
          const r = await fetch(req);
          if (r.ok) void cache.put(page ? url.pathname : req, r.clone()).catch(() => {});
          return r;
        } catch (err) {
          // offline: the page as last seen (the fragment never reaches here, so /#p=… is /), else its file
          const hit = (await cache.match(page ? url.pathname : req)) ?? (page ? await cache.match(url.pathname.endsWith("watch.html") ? "/watch.html" : "/index.html") : undefined);
          if (hit) return hit;
          throw err;
        }
      })(),
    );
  });
}
