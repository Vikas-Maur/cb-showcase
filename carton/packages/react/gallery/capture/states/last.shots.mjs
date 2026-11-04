// The last gaps of the Carton v2 design QA (QA-V2.md §4): G10 (an opened past day as its landmarks and one line per
// run between them, DESIGN-V2 §2.5) and G13 (Search every cut, §2.3). G9's landmarks at 300 px are n2-landmarks
// (states/n2.shots.mjs), G17's ghost is in N1's Compare shots (states/n1.shots.mjs).
export function shots({ P, foldOlder }) {
  // the newest past day, opened (a long History's past days start folded; foldOlder folds any that aren't)
  const pastDay = async (p) => {
    await foldOlder(p);
    await p.locator('.carton-day[aria-expanded="false"]:not(.carton-run)').filter({ hasNotText: /^Today/ }).first().click();
    await p.waitForTimeout(300);
  };
  return [
    P("last-pastday", "n2-history", "G10: the newest past day opened: its landmarks, and one quiet line per run of changes between them (\"› 6 changes by You and Director\").", pastDay),
    P("last-pastday-run", "n2-history", "last-pastday, then a click on its first run: its changes in place, grouped as any day's.", async (p) => {
      await pastDay(p);
      await p.locator(".carton-run").first().click();
      await p.waitForTimeout(300);
    }),
    P("last-every-cut", "n2-history", "G13: \"city\" searched (no version of Main cut mentions it), then Search every cut: the other cuts' versions, each with its cut's dot and name.", async (p) => {
      await p.locator(".carton-search-input").click();
      await p.keyboard.type("city", { delay: 30 });
      await p.locator(".carton-find-empty").waitFor();
      await p.waitForTimeout(300);
      const every = p.locator(".carton-find-every-btn");
      if (await every.count()) {
        await every.click();
        await p.locator(".carton-find-every-row, .carton-find-every-status").first().waitFor();
      }
      await p.waitForTimeout(300);
    }),
  ];
}
