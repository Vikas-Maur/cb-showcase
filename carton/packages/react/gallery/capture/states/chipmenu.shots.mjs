// The title bar chip's cuts menu (PLAN 2.2 version 2) on chipmenu.js's states: opened by a click on the chip, as a
// person (or the recorded demo's DevTools clicks) would, by the documented selectors. `h`: shoot.mjs's helpers.

export function shots(h) {
  const { W, ED } = h;
  const chip = '[data-carton-cut-chip] > button[data-carton-cut]', pop = "[data-carton-cuts-pop]";
  const openFromChip = async (p) => { await p.locator(chip).click(); await p.locator(`${pop} [role=menu]`).waitFor(); await p.waitForTimeout(250); };
  // the mockup's crop: the title bar's right part and the menu under the chip
  const crop = async (p) => {
    const c = await p.locator("[data-carton-cut-chip]").boundingBox(), m = await p.locator(`${pop} [role=menu]`).boundingBox();
    const vw = p.viewportSize().width, x = Math.max(0, Math.floor(c.x - 380));
    return { x, y: 0, width: vw - x, height: Math.ceil(m.y + m.height + 24) };
  };
  const C = (name, s, how, steps, o = {}) => ({ name, s, how, steps, target: "clip", clip: crop, perWidth: false, viewport: ED, ...o });
  const view = (p) => p.evaluate(() => window.__cap.page().view({ kind: "version", ref: window.__cap.ui.history().all().at(-4).ref, label: "Your edit from 11:02 am" }));
  return [
    C("chipmenu-open", "chip-cuts", "Panel closed, on Main cut; the chip clicked: the cuts menu hangs from it (after/titlebar-cuts-menu.png). History stays closed.", openFromChip),
    C("chipmenu-open-hover", "chip-cuts", "chipmenu-open, the pointer on 30s Instagram cut (the mockup's hover).", async (p) => { await openFromChip(p); await p.locator('[data-carton-cut-name="30s Instagram cut"]').hover(); await p.waitForTimeout(150); }, { keepHover: true }),
    W("chipmenu-open-window", "chip-cuts", "chipmenu-open, the whole window: the menu under the chip, over the editor.", openFromChip, { viewport: ED }),
    C("chipmenu-turn", "chip-cuts-turn", "Claude Code working on Main cut; the chip clicked, then 30s Instagram cut: it opens in place with Switch when it finishes and Switch now.", async (p) => { await openFromChip(p); await p.locator('[data-carton-cut-name="30s Instagram cut"]').click(); await p.locator('[data-carton-cut-choice="now"]').waitFor(); await p.waitForTimeout(200); }),
    W("chipmenu-narrow-1100", "chip-cuts", "A 1100 px window (below 1180: the narrow title bar); the chip clicked.", openFromChip, { viewport: { width: 1100, height: 700 } }),
    W("chipmenu-960-mark-only", "chip-cuts", "A 960 px window with Windows' caption buttons, a version viewed (the chip shows the cut as its mark only); the chip clicked.", async (p) => { await view(p); await p.locator('[data-carton-cut-chip][data-viewing]').waitFor(); await p.waitForTimeout(250); await openFromChip(p); }, { viewport: { width: 960, height: 700 }, q: "&win=1" }),
    W("chipmenu-open-history", "chip-cuts", "chipmenu-open, then Open History: the menu closes, History opens.", async (p) => { await openFromChip(p); await p.locator('[data-carton-item="open-history"]').click(); await p.locator("aside.carton-sidebar").waitFor(); await p.waitForTimeout(300); }, { viewport: ED }),
  ];
}
