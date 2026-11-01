// Retires the web demo's service worker. Browsers that opened the web demo (apps/web) registered /sw.js with scope "/";
// it caches the app and would keep serving it. While the demo isn't served, this replacement installs at once,
// removes itself, and reloads the open pages so they get the plain landing page.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    for (const key of await caches.keys()) await caches.delete(key);
    await self.registration.unregister();
    for (const client of await self.clients.matchAll({ type: "window" })) client.navigate(client.url);
  })());
});
