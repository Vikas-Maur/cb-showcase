// The shots for Carton UX v2, History (N2), beside docs/carton-ux/v2's mockups (after/history-landmarks-*.png,
// history-search-*.png, history-goback-*.png, bring-back-*.png, compare-menu-384.png, compare-pick-384.png,
// history-filter-landmarks-384.png, editor-peek.png): shoot.mjs picks up every states/*.shots.mjs (states/README.md).
export function shots({ P, menuItem, foldOlder, uxMenu }) {
  const card = async (p, text) => {
    await foldOlder(p);
    await p.locator(".carton-version", { hasText: text }).first().click();
    await p.locator(".carton-card-version").first().waitFor();
    await p.waitForTimeout(250);
  };
  const goBack = async (p) => {
    await card(p, "Add captions to the interview");
    await p.locator(".carton-card-version .carton-btn", { hasText: "Go back…" }).click();
    await p.locator(".carton-goback").waitFor();
    await p.waitForTimeout(250);
  };
  const clips = async (p) => {
    await goBack(p);
    await p.locator(".carton-goback-choice", { hasText: "Bring back one clip" }).click();
    await p.locator(".carton-card-version .carton-btn", { hasText: "Choose a clip…" }).click();
    await p.locator(".carton-bringback-row").first().waitFor();
    await p.waitForTimeout(250);
  };
  const search = async (p, text) => {
    await p.locator(".carton-search-input").click();
    await p.keyboard.type(text, { delay: 30 });
    await p.waitForTimeout(500);
  };
  return [
    P("n2-landmarks", "n2-history", "The story with landmarks: Claude Code's turn Now; your six changes; the Director's turn; Sent to client (NAMED, also sent); EXPORTED 1080p for the client (the fold); BEFORE before the restore; each day's START; older days folded with their landmarks.", foldOlder),
    P("n2-goback", "n2-noclip", "The Director's older turn → its card → Go back…: the four choices, smallest first, nothing picked (\"Choose one\").", goBack),
    P("n2-goback-clip", "n2-history", "“Interview B” selected on the timeline → the Director's turn → Go back…: Bring back one clip picked for it, its button \"Bring back “Interview B” as it was\".", goBack),
    P("n2-goback-picked", "n2-noclip", "n2-goback, then a click on Restore the whole edit: its button names the action.", async (p) => { await goBack(p); await p.locator(".carton-goback-choice", { hasText: "Restore the whole edit" }).click(); await p.waitForTimeout(150); }),
    P("n2-goback-turn", "n2-history", "⋯ on the Director's turn → Undo this turn: Go back… with Undo Director's turn picked.", async (p) => { await foldOlder(p); await uxMenu(p, "Add captions to the interview"); await menuItem(p, "Undo this turn").click(); await p.locator(".carton-goback").waitFor(); await p.waitForTimeout(250); }),
    P("n2-bringback", "n2-noclip", "Go back… → Bring back one clip → Choose a clip…: the clips that differ since the Director's turn, in three groups; the first hovered.", async (p) => { await clips(p); await p.locator(".carton-bringback-row").first().hover(); await p.waitForTimeout(150); }, { keepHover: true }),
    P("n2-bringback-confirm", "n2-noclip", "n2-bringback, then Bring back on “B-roll 3” (deleted since): the confirmation in place, with See it first.", async (p) => { await clips(p); const r = p.locator(".carton-bringback-row", { hasText: "B-roll 3" }).first(); await r.hover(); await r.locator(".carton-bringback-btn").click(); await p.locator(".carton-bringback-confirm").waitFor(); await p.waitForTimeout(200); }),
    P("n2-bringback-again", "n2-noclip", "N0b: Bring back on “Intro”, then the Director trims “Intro” again before the click: the engine refuses (\"“Intro” just changed again. Nothing was brought back.\") and the confirmation asks again over the clip as it is now.", async (p) => {
      await clips(p);
      const r = p.locator(".carton-bringback-row", { hasText: "“Intro”" }).first();
      await r.hover();
      await r.locator(".carton-bringback-btn").click();
      await p.locator(".carton-bringback-confirm").waitFor();
      await p.evaluate(() => window.__cap.ui.addVersion({ kind: "edit" }, [{ key: "timelineItems/item-intro", itemId: "item-intro", clip: "video", kind: "change", text: "Trimmed “Intro”, now ends at 0:04", at: 0, end: 4 }]));
      await p.waitForTimeout(300);
      await p.locator(".carton-bringback-confirm .carton-btn[data-variant=primary]").click();
      await p.locator(".carton-goback-warn").waitFor();
      await p.waitForTimeout(200);
    }),
    P("n2-bringback-takeout", "n2-noclip", "n2-bringback, then Take out on “Jane Smith, Founder” (not there yet then): \"Take out …?\".", async (p) => { await clips(p); const r = p.locator(".carton-bringback-row", { hasText: "Jane Smith" }).first(); await r.hover(); await r.locator(".carton-bringback-btn").click(); await p.locator(".carton-bringback-confirm").waitFor(); await p.waitForTimeout(200); }),
    P("n2-search", "n2-history", "\"intro\" typed in the search field: the clip first (“Intro”, the clip, Only this clip), then the versions that mention it, each saying why.", async (p) => { await foldOlder(p); await search(p, "intro"); }),
    P("n2-search-person", "n2-history", "\"director\" typed: the Director's versions (a person), newest first.", async (p) => { await foldOlder(p); await search(p, "director"); }),
    P("n2-search-empty", "n2-history", "\"drone at night\" typed: nothing found, what to try, the cut searched, Clear search.", async (p) => { await foldOlder(p); await search(p, "drone at night"); }),
    P("n2-filter-landmarks", "n2-history", "The filter menu → Landmarks: the story of the project in a screenful.", async (p) => { await foldOlder(p); await p.locator(".carton-filter-btn").click(); await p.waitForTimeout(150); await menuItem(p, "Landmarks").click(); await p.waitForTimeout(300); }),
    P("n2-filter-menu", "n2-history", "The filter menu, Landmarks second after All versions.", async (p) => { await foldOlder(p); await p.locator(".carton-filter-btn").click(); await p.waitForTimeout(150); await menuItem(p, "Landmarks").hover(); await p.waitForTimeout(120); }, { keepHover: true }),
    P("n2-compare-menu", "n2-history", "⇆ Compare in the cut bar: \"Compare your edit with…\" the version you sent, the last export, how it was this morning, another cut, pick a version.", async (p) => { await foldOlder(p); await p.locator(".carton-compare-btn").click(); await p.waitForTimeout(250); await p.locator(".carton-compare-entry").first().hover(); await p.waitForTimeout(120); }, { keepHover: true }),
    P("n2-pick", "n2-history", "⋯ on Sent to client → Compare with…: the pick line, the From pill; another row hovered shows ⇆ Compare.", async (p) => { await foldOlder(p); await uxMenu(p, "Sent to client"); await menuItem(p, "Compare with…").click(); await p.waitForTimeout(200); await p.locator(".carton-version", { hasText: "Tighten the intro" }).first().hover(); await p.waitForTimeout(150); }, { keepHover: true }),
    // N2c: Compare with… a version on another cut
    P("n2c-pick-cuts", "n2-history", "⋯ on Sent to client → Compare with… → the pick line's cut button: \"A version on …\" for each other cut.", async (p) => { await foldOlder(p); await uxMenu(p, "Sent to client"); await menuItem(p, "Compare with…").click(); await p.waitForTimeout(150); await p.locator(".carton-pick-cut-btn").click(); await p.waitForTimeout(200); await menuItem(p, "A version on 30s Instagram cut").hover(); await p.waitForTimeout(120); }, { keepHover: true }),
    P("n2c-picker", "n2c-big", "n2c-pick-cuts → A version on 30s Instagram cut…: that cut's History to pick from (12,000 versions, read a page at a time), \"as it is now\" first, a way back to Main cut.", async (p) => { await foldOlder(p); await uxMenu(p, "Sent to client"); await menuItem(p, "Compare with…").click(); await p.waitForTimeout(150); await p.locator(".carton-pick-cut-btn").click(); await p.waitForTimeout(150); await menuItem(p, "A version on 30s Instagram cut").click(); await p.locator(".carton-cut-pick-row").nth(2).waitFor(); await p.locator(".carton-cut-pick-row").nth(2).hover(); await p.waitForTimeout(150); }, { keepHover: true }),
    P("n2c-picker-search", "n2c-big", "n2c-picker, then \"outro\" typed in the search field: that cut's versions that say so, marked (your cut's filter steps aside).", async (p) => { await foldOlder(p); await uxMenu(p, "Sent to client"); await menuItem(p, "Compare with…").click(); await p.waitForTimeout(150); await p.locator(".carton-pick-cut-btn").click(); await p.waitForTimeout(150); await menuItem(p, "A version on 30s Instagram cut").click(); await p.locator(".carton-cut-pick-row").nth(2).waitFor(); await p.locator(".carton-search-input").click(); await p.keyboard.type("outro", { delay: 30 }); await p.locator(".carton-cut-pick-row .carton-hit").first().waitFor(); await p.waitForTimeout(200); }),
    P("n2c-compare-cut", "n2-history", "⇆ Compare → Another cut: \"A version on …\" for each other cut (its History to pick from).", async (p) => { await foldOlder(p); await p.locator(".carton-compare-btn").click(); await p.waitForTimeout(150); await menuItem(p, "Another cut").click(); await p.waitForTimeout(200); }),
    P("n2-row-menu", "n2-history", "⋯ on the Director's turn: Compare with… after Compare with your edit; Undo this turn after Restore….", async (p) => { await foldOlder(p); await uxMenu(p, "Add captions to the interview"); await menuItem(p, "Compare with…").hover(); await p.waitForTimeout(120); }, { keepHover: true }),
    P("n2-peek", "n2-history", "The EXPORTED row held (pointer down 450 ms): it is viewed while held, the row says Holding.", async (p) => { await foldOlder(p); const r = p.locator(".carton-version[data-landmark=exported]").first(); const b = await r.boundingBox(); await p.mouse.move(b.x + 80, b.y + b.height / 2); await p.waitForTimeout(200); await p.mouse.down(); await p.waitForTimeout(450); }, { keepHover: true }),
    P("n2-peek-window", "n2-history", "n2-peek in the whole window: the chip, the stage's frame and the timeline's frame while the row is held.", async (p) => { await foldOlder(p); const r = p.locator(".carton-version[data-landmark=exported]").first(); const b = await r.boundingBox(); await p.mouse.move(b.x + 80, b.y + b.height / 2); await p.waitForTimeout(200); await p.mouse.down(); await p.waitForTimeout(600); }, { keepHover: true, target: "window", perWidth: false }),
  ];
}
