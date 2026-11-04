// fix/ux2-open's shots (states/open.js): Back to Fold in… (item 2), the newest day when nothing happened today (item 3),
// and History's landmark and group rows (the Windows check of b14f8a4e: items 4–6).
export function shots({ P, ED, menuItem, foldOlder }) {
  // a dialog shot whose steps open the dialog themselves (D waits for one to be open first)
  const dialog = (name, s, how, steps) => ({ name, s, how, steps, target: "dialog", perWidth: false, viewport: ED });
  const open = async (p) => {
    await p.locator(".carton-cuts-trigger").click();
    await p.waitForTimeout(150);
    await menuItem(p, "Fold in changes from a cut…").click();
    await p.locator(".carton-fold .carton-fold-box").first().waitFor();
    await p.waitForTimeout(200);
  };
  // the person leaves the title's change out and picks the other cut's side of the conflict
  const choose = async (p) => {
    await open(p);
    await p.locator(".carton-fold .carton-fold-change", { hasText: "Summer launch" }).locator("input").click();
    await p.locator(".carton-fold [role=radio]").nth(1).click();
    await p.waitForTimeout(150);
  };
  const sideAndBack = async (p, meanwhile) => {
    await p.locator(".carton-fold .carton-btn", { hasText: "See them side by side" }).click();
    const back = p.locator(".carton-btn", { hasText: "Back to Fold in…" }).first();
    await back.waitFor();
    await p.waitForTimeout(300);
    if (meanwhile) await p.evaluate(meanwhile);
    await back.click();
    await p.locator(".carton-fold .carton-fold-box").first().waitFor();
    await p.waitForTimeout(400);
  };
  // while comparing, the title's change went (folded in elsewhere) and a teammate's new one came
  const planMoved = () => {
    const ui = window.__cap.ui;
    const orig = ui.planFold.bind(ui);
    ui.planFold = async (f, i) => {
      const pl = await orig(f, i);
      return { ...pl, changes: [...pl.changes.filter((c) => !/Summer launch/.test(c.summary)), { id: "items/drone", summary: "Added “Drone shot”", author: pl.changes[0].author, at: Date.now() - 60_000, change: { key: "items/drone", text: "Added “Drone shot”", kind: "add", clip: "video", at: 12, end: 16 } }] };
    };
  };
  const scrollTo = (sel) => async (p) => {
    await foldOlder(p);
    await p.locator(sel).first().scrollIntoViewIfNeeded();
    await p.waitForTimeout(400);
  };
  return [
    dialog("open-fold-chosen", "open-fold", "Fold in from 30s Instagram cut: the title's change left out, the conflict picked the other cut's way, before See them side by side.", choose),
    dialog("open-fold-back", "open-fold", "open-fold-chosen, then See them side by side, then Back to Fold in…: the dialog as it reopens.", async (p) => { await choose(p); await sideAndBack(p); }),
    dialog("open-fold-back-changed", "open-fold", "open-fold-back, but while comparing the title's change went and a new one (“Drone shot”) came: the dialog as it reopens.", async (p) => { await choose(p); await sideAndBack(p, planMoved); }),
    P("open-yesterday", "open-yesterday", "Nothing happened today: History's newest day (Yesterday) as it opens, its landmarks loaded.", async (p) => {
      await p.locator(".carton-version[data-landmark]").first().waitFor();
      await p.waitForTimeout(400);
    }),
    P("open-rows-landmark", "open-rows", "History's story, older days folded, scrolled to the Exported row (the fold an hour ago).", scrollTo(".carton-version[data-landmark=exported]")),
    P("open-rows-group", "open-rows", "History's story, older days folded, scrolled to a group of your edits (closed).", scrollTo(".carton-version[data-group]")),
  ];
}
