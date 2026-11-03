// The design QA of Carton UX v2 (docs/carton-ux/v2/qa/QA-V2.md): History states N2's shots (states/n2.shots.mjs) don't
// reach. Search clearing, each Go back… choice, the clip confirmations ("changed again" too), the toast, a past day's
// runs, Another cut, and the editor around them.
export function shots({ P, T, W, menuItem, foldOlder, uxMenu }) {
  const ED = { width: 1522, height: 810 };
  const card = async (p, text) => {
    await foldOlder(p);
    await p.locator(".carton-version", { hasText: text }).first().click();
    await p.locator(".carton-card-version").first().waitFor();
    await p.waitForTimeout(250);
  };
  const goBack = async (p, text = "Add captions to the interview") => {
    await card(p, text);
    await p.locator(".carton-card-version .carton-btn", { hasText: "Go back…" }).click();
    await p.locator(".carton-goback").waitFor();
    await p.waitForTimeout(200);
  };
  const choose = async (p, name) => {
    await p.locator(".carton-goback-choice", { hasText: name }).click();
    await p.waitForTimeout(150);
  };
  const clips = async (p) => {
    await goBack(p);
    await choose(p, "Bring back one clip");
    await p.locator(".carton-card-version .carton-btn", { hasText: "Choose a clip…" }).click();
    await p.locator(".carton-bringback-row").first().waitFor();
    await p.waitForTimeout(200);
  };
  const pickClip = async (p, name) => {
    const r = p.locator(".carton-bringback-row", { hasText: name }).first();
    await r.hover();
    await r.locator(".carton-bringback-btn").click();
    await p.locator(".carton-bringback-confirm").waitFor();
    await p.waitForTimeout(200);
  };
  const search = async (p, text) => {
    await p.locator(".carton-search-input").click();
    await p.keyboard.type(text, { delay: 30 });
    await p.waitForTimeout(500);
  };
  // your edit moves on while the confirmation is open: a teammate trims "Intro" again
  const trimIntroAgain = (p) =>
    p.evaluate(() => {
      const ui = window.__cap.ui;
      ui.addVersion({ author: { id: "leo", kind: "human", name: "Leo Park" }, kind: "edit" }, [{ itemId: "item-intro", kind: "change", clip: "video", text: "Trimmed “Intro”, now ends at 0:04", at: 0, end: 4 }]);
    });
  return [
    // search
    P("qa2-search-cleared", "n2-history", "\"intro\" typed, then the field's ✕: the whole history again, the field empty and focused.", async (p) => { await foldOlder(p); await search(p, "intro"); await p.locator(".carton-search-x").click(); await p.waitForTimeout(400); }),
    P("qa2-search-esc", "n2-history", "\"intro\" typed, then Esc in the field: cleared, History still open.", async (p) => { await foldOlder(p); await search(p, "intro"); await p.keyboard.press("Escape"); await p.waitForTimeout(400); }),
    P("qa2-search-filtered", "n2-history", "Filter → Landmarks, then \"intro\" typed: the filter chip stays above the results.", async (p) => { await foldOlder(p); await p.locator(".carton-filter-btn").click(); await p.waitForTimeout(150); await menuItem(p, "Landmarks").click(); await p.waitForTimeout(250); await search(p, "intro"); }),
    P("qa2-search-one-letter", "n2-history", "One letter typed (\"i\"): nothing searched yet.", async (p) => { await foldOlder(p); await search(p, "i"); }),
    P("qa2-search-result-card", "n2-history", "\"intro\" typed, then a click on the first version found: its card opens in the results.", async (p) => { await foldOlder(p); await search(p, "intro"); await p.locator(".carton-history-list .carton-version").first().click(); await p.waitForTimeout(400); }),
    // landmarks and days
    P("qa2-landmarks-yesterday", "n2-history", "n2-landmarks, then Yesterday opened: its landmarks, and one line for each run between them.", async (p) => { await foldOlder(p); await p.locator(".carton-day", { hasText: "Yesterday" }).click(); await p.waitForTimeout(300); await p.locator(".carton-history-list").evaluate((e) => { e.scrollTop = 420; e.dispatchEvent(new Event("scroll")); }); await p.waitForTimeout(300); }),
    P("qa2-peek-tip", "n2-history", "The pointer resting on the EXPORTED row for 1.2 s: the hint \"Click to open · hold to peek\".", async (p) => { await foldOlder(p); const r = p.locator(".carton-version[data-landmark=exported]").first(); await r.hover(); await p.waitForTimeout(1300); }, { keepHover: true, anim: true }),
    P("qa2-card-v2", "n2-noclip", "A click on the Director's older turn: the card with See them and Go back… (after/history-card-v2-384.png).", (p) => card(p, "Add captions to the interview")),
    // Go back…, each choice
    P("qa2-goback-clip-nosel", "n2-noclip", "Go back… with nothing selected on the timeline, then Bring back one clip picked: \"Choose a clip…\".", async (p) => { await goBack(p); await choose(p, "Bring back one clip"); }),
    P("qa2-goback-turn-click", "n2-noclip", "Go back…, then Undo Director's turn picked: the button names it.", async (p) => { await goBack(p); await choose(p, "Undo Director"); }),
    P("qa2-goback-newcut", "n2-noclip", "Go back…, then Start a new cut from here picked: \"Name the new cut…\".", async (p) => { await goBack(p); await choose(p, "Start a new cut"); }),
    P("qa2-goback-newcut-form", "n2-noclip", "qa2-goback-newcut, then Name the new cut…: the name field in the card.", async (p) => { await goBack(p); await choose(p, "Start a new cut"); await p.locator(".carton-card-version .carton-btn", { hasText: "Name the new cut…" }).click(); await p.waitForTimeout(200); await p.keyboard.type("Shorter open"); await p.waitForTimeout(150); }),
    P("qa2-goback-mine", "n2-noclip", "Go back… on your own six changes (not an agent's turn): three choices, no Undo turn.", async (p) => { await goBack(p, "Moved “Interview B” 2 s later"); }),
    P("qa2-goback-clip-confirm", "n2-history", "“Interview B” selected on the timeline → Go back… → Bring back “Interview B” as it was: its confirmation.", async (p) => { await goBack(p); await p.locator(".carton-card-version .carton-btn", { hasText: "Bring back “Interview B”" }).click(); await p.locator(".carton-bringback-confirm").waitFor(); await p.waitForTimeout(200); }),
    P("qa2-goback-restore-row", "n2-noclip", "⋯ on your six changes → Restore…: Go back… with Restore the whole edit picked.", async (p) => { await foldOlder(p); await uxMenu(p, "Moved “Interview B” 2 s later"); await menuItem(p, "Restore…").click(); await p.locator(".carton-goback").waitFor(); await p.waitForTimeout(250); }),
    // Bring back one clip
    P("qa2-bringback-changed", "n2-noclip", "Choose a clip… → Bring back on “Intro” (changed since): its confirmation.", async (p) => { await clips(p); await pickClip(p, "Intro"); }),
    P("qa2-bringback-again", "n2-noclip", "qa2-bringback-changed, then a teammate trims “Intro” again before the click: \"“Intro” just changed again…\".", async (p) => { await clips(p); await pickClip(p, "Intro"); await trimIntroAgain(p); await p.waitForTimeout(400); await p.locator(".carton-bringback-confirm .carton-btn[data-variant=primary]").click(); await p.waitForTimeout(400); }),
    P("qa2-bringback-done", "n2-noclip", "Bring back “B-roll 3” confirmed: the panel after it (the card, the new row).", async (p) => { await clips(p); await pickClip(p, "B-roll 3"); await p.locator(".carton-bringback-confirm .carton-btn[data-variant=primary]").click(); await p.waitForTimeout(600); }),
    T("qa2-bringback-toast", "n2-noclip", "Bring back “B-roll 3” confirmed: the toast with Undo, on the stage.", async (p) => { await clips(p); await pickClip(p, "B-roll 3"); await p.locator(".carton-bringback-confirm .carton-btn[data-variant=primary]").click(); await p.locator(".carton-toast").waitFor(); await p.waitForTimeout(250); }, { panelOpen: true }),
    T("qa2-takeout-toast", "n2-noclip", "Take out “Jane Smith, Founder” confirmed: its toast.", async (p) => { await clips(p); await pickClip(p, "Jane Smith"); await p.locator(".carton-bringback-confirm .carton-btn[data-variant=primary]").click(); await p.locator(".carton-toast").waitFor(); await p.waitForTimeout(250); }, { panelOpen: true }),
    // Compare's entries
    P("qa2-compare-cuts", "qa2-cuts", "⇆ Compare → Another cut ›: the cuts to compare your edit with.", async (p) => { await foldOlder(p); await p.locator(".carton-compare-btn").click(); await p.waitForTimeout(200); await menuItem(p, "Another cut").click(); await p.waitForTimeout(200); }),
    P("qa2-compare-menu-cuts", "qa2-cuts", "⇆ Compare with other cuts: the whole menu.", async (p) => { await foldOlder(p); await p.locator(".carton-compare-btn").click(); await p.waitForTimeout(250); }),
    P("qa2-pick-cut", "qa2-cuts", "⇆ Compare → Pick a version…: the pick line, its cut button opened.", async (p) => { await foldOlder(p); await p.locator(".carton-compare-btn").click(); await p.waitForTimeout(200); await menuItem(p, "Pick a version").click(); await p.waitForTimeout(200); await p.locator(".carton-pick-cut-btn").click(); await p.waitForTimeout(200); }),
    P("qa2-pick-search", "n2-history", "⋯ on Sent to client → Compare with…, then \"director\" typed: picking among the search results.", async (p) => { await foldOlder(p); await uxMenu(p, "Sent to client"); await menuItem(p, "Compare with…").click(); await p.waitForTimeout(200); await search(p, "director"); await p.locator(".carton-history-list .carton-version").first().hover(); await p.waitForTimeout(150); }, { keepHover: true }),
    P("qa2-pick-from-row", "n2-history", "Pick mode from Sent to client, then the From row hovered.", async (p) => { await foldOlder(p); await uxMenu(p, "Sent to client"); await menuItem(p, "Compare with…").click(); await p.waitForTimeout(200); await p.locator(".carton-version", { hasText: "Sent to client" }).first().hover(); await p.waitForTimeout(150); }, { keepHover: true }),
    // the editor around them, at the mockups' size
    W("qa2-editor-goback", "n2-history", "The editor at 1522 × 810 with Go back… open on the Director's turn (“Interview B” selected on the timeline).", goBack, { viewport: ED }),
    W("qa2-editor-search", "n2-history", "The editor at 1522 × 810 with \"intro\" searched.", async (p) => { await foldOlder(p); await search(p, "intro"); }, { viewport: ED }),
    W("qa2-editor-bringback-toast", "n2-noclip", "The editor at 1522 × 810 after Bring back “B-roll 3”: the toast, the new row.", async (p) => { await clips(p); await pickClip(p, "B-roll 3"); await p.locator(".carton-bringback-confirm .carton-btn[data-variant=primary]").click(); await p.locator(".carton-toast").waitFor(); await p.waitForTimeout(250); }, { viewport: ED }),
    W("qa2-editor-1100-search", "n2-history", "A 1100 px window (History at 300 px) with \"intro\" searched.", async (p) => { await foldOlder(p); await search(p, "intro"); }, { viewport: { width: 1100, height: 760 } }),
  ];
}
