// The shots for Carton UX v2 N1, Compare in the editor (docs/carton-ux/v2/DESIGN-V2.md §1), beside the mockups in
// docs/carton-ux/v2/after/compare-*.png: shoot.mjs adds them to its list (one line there). Editor shots at 1522 × 810,
// the mockups' window; narrow at 1100 × 810; the panel at 384 and 300 px.
export function n1Shots({ P }) {
  const editor = { width: 1522, height: 810 };
  const W = (name, s, how, steps, o = {}) => ({ name, s, how, steps, target: "window", perWidth: false, viewport: editor, ...o });
  const open = async (p) => { await p.locator(".carton-compare").waitFor(); await p.locator(".carton-compare-list .carton-change").first().waitFor({ timeout: 4000 }).catch(() => {}); await p.waitForTimeout(300); };
  const pick = async (p, text) => { await p.locator(".carton-compare-list .carton-change", { hasText: text }).first().click(); await p.waitForTimeout(250); };
  return [
    W("n1-side-by-side", "n1-side", "See them on “Sent to client” (opened as its card opens it): Side by side, the title change picked in the list; the strip, the marks, the legend; the chip.", async (p) => { await open(p); await pick(p, "Summer sale"); }),
    W("n1-wipe", "n1-wipe", "Compare in Wipe: the line in the middle, the labels in the top corners.", open),
    W("n1-flip", "n1-flip", "Compare in Flip, B held: the stage shows “Sent to client”, its tag blue.", async (p) => { await open(p); await p.keyboard.down("b"); await p.waitForTimeout(300); }),
    W("n1-flip-only", "n1-flip-only", "No second player in this bundle: Flip only, the modes show Flip alone; everything else as usual.", open),
    W("n1-cuts", "n1-cuts", "The cuts menu's Compare on “30s Instagram cut”: the two cuts, by shot; differences, not changes.", open),
    W("n1-edit-attempt", "n1-side", "An edit tried while comparing (the bridge's blocked(), as Cardboard's refusal asks it): one line, Done comparing, Esc; the frame pulses.", async (p) => { await open(p); await p.evaluate(() => window.__carton.blocked()); await p.waitForTimeout(200); }, { keepAnimations: true }),
    W("n1-agent", "n1-agent", "Director's cb compare --show while the person is idle: Compare opens, History opens to its list, one toast says who.", async (p) => { await open(p); await p.locator(".carton-toast").waitFor(); await p.waitForTimeout(200); }),
    W("n1-agent-offer", "n1-agent-offer", "Director's cb compare --show while the person views a version: never replaced; a toast with Open.", async (p) => { await p.locator(".carton-toast").waitFor(); await p.waitForTimeout(200); }),
    W("n1-drawer-hidden", "n1-drawer", "Compare with History closed: the frame's own label (⇆ … · 7 changes ✕).", open),
    W("n1-narrow", "n1-side", "A 1100 px window: the stage under 682 px, Flip by default, Side by side greyed.", open, { viewport: { width: 1100, height: 810 } }),
    W("n1-entry", "n1-entry", "History before Compare: the Sent to client card's See them opens it (this shot: after the click).", async (p) => {
      await p.locator(".carton-version", { hasText: "Sent to client" }).first().click();
      await p.waitForTimeout(250);
      await p.locator(".carton-card-version .carton-link").first().click();
      await open(p);
    }),
    P("n1-panel", "n1-side", "The History panel during Compare: ← History, the range in words, the count, every change; the title change picked.", async (p) => { await open(p); await pick(p, "Summer sale"); }),
  ];
}
