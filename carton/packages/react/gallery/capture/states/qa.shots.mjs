// The design QA's shots (docs/carton-ux/qa, 2026-11-03) on its states (qa.js) and the rig's: editor compositions at the
// mockups' size, the title bar at 1522, 1100 and 960 px with Windows' caption buttons, the stage's conflict cards, the
// panel states the redesign's list didn't have, tooltips, and the Share and Join dialogs. `h`: shoot.mjs's helpers.

export function shots(h) {
  const { P, T, W, B, D, ED, menuItem, foldOlder, uxMenu, openCard, changes, playDirector, holdBefore } = h;
  const side = (p, s) => p.locator(`.carton-conflict-side[data-side=${s}]`).first();
  const seeTheirs = async (p) => { await side(p, "theirs").click(); await side(p, "theirs").locator(".carton-see").click(); await p.waitForTimeout(350); };
  const cutsFromChip = async (p) => { await p.locator("[data-carton-cut]").first().click(); await p.locator(".carton-menu-pop").first().waitFor(); await p.waitForTimeout(250); };
  // an editor composition at the mockups' size (1522 × 810)
  const E = (name, s, how, steps, o = {}) => W(name, s, how, steps, { viewport: ED, ...o });
  const NARROW = { width: 960, height: 700 };
  const failPreview = (p) => p.evaluate(() => { window.__carton.preview = () => Promise.reject(new Error("load failed")); });
  return [
    // ---------------------------------------------------------- editor compositions (beside after/editor-*.png)
    E("editor-default", "ux-history", "History open, Claude Code's newest turn opened (after/editor-default.png).", async (p) => { await foldOlder(p); await openCard(p, "Tighten the intro"); }),
    E("editor-play-newest", "ux-history", "The newest turn's card → Play all: plays on your edit, so no frame, no chip label.", async (p) => { await foldOlder(p); await openCard(p, "Tighten the intro"); await p.locator(".carton-card-version .carton-btn", { hasText: "Play all" }).click(); await p.waitForTimeout(600); }),
    E("editor-viewing", "ux-history", "The Director's older turn → Play all (after/editor-viewing.png).", playDirector),
    E("editor-before", "ux-history", "editor-viewing, then Before held (after/editor-before.png).", async (p) => { await playDirector(p); await holdBefore(p, ".carton-card-version"); }, { keepHover: true }),
    E("editor-edit-attempt", "ux-history", "editor-viewing, then an edit tried (the bridge's blocked()) (after/editor-edit-attempt.png).", async (p) => { await playDirector(p); await p.evaluate(() => window.__carton.blocked()); await p.waitForTimeout(150); }),
    E("editor-export-viewing", "ux-history", "editor-viewing, then Export opened (the bridge's beforeExport()): back to your edit first, with its toast.", async (p) => { await playDirector(p); await p.evaluate(() => window.__carton.beforeExport()); await p.waitForTimeout(400); }),
    E("editor-conflict-card", "qa-conflict", "Panel closed, two conflicts: the first card, yours picked.", null),
    E("editor-conflict-theirs", "qa-conflict", "Claude Code's side → See it: the card down to its title and sides, see-through (after/editor-conflict-theirs.png).", seeTheirs),
    E("editor-conflict-pill", "qa-conflict-panel", "History open with two conflicts: the pill (after/editor-conflict-pill.png).", foldOlder),
    E("editor-other-cut", "ws1-other-cut", "On 30s Instagram cut, panel closed (after/editor-other-cut.png).", null),
    E("editor-teammate-cut", "qa-teammate-window", "Leo's Main cut on screen with History open (after/history-teammate-cut + titlebar-teammate-cut).", null),
    E("editor-chip-menu", "ws1-other-cut", "The chip clicked with the panel closed: History opens with its cuts menu (PLAN 2.2 v1).", cutsFromChip),
    E("editor-comments-see", "ws59-comments", "Comments → See it as it was: the frame's label tab (History's list isn't on screen).", async (p) => { await p.locator('[role=tab][aria-label="Comments"]').click(); await p.waitForTimeout(250); await p.getByRole("button", { name: /See it as it was/ }).first().click(); await p.waitForTimeout(400); }),
    E("editor-play-fail", "ux-history", "Play all on an older version that can't load (the bridge's preview rejects): what the chip, frame and row say.", async (p) => { await failPreview(p); await playDirector(p); await p.waitForTimeout(800); }),
    E("editor-play-slow", "ux-history", "Play all on an older version that takes 3 s to load: shot at 1 s.", async (p) => { await p.evaluate(() => { const orig = window.__carton.preview; window.__carton.preview = (...a) => new Promise((r) => setTimeout(() => r(orig(...a)), 3000)); }); await foldOlder(p); await openCard(p, "Add captions to the interview"); await p.locator(".carton-card-version .carton-btn", { hasText: "Play all" }).click(); await p.waitForTimeout(1000); }),
    E("editor-viewing-esc", "ux-history", "editor-viewing, then Esc: back to your edit (the marks go).", async (p) => { await playDirector(p); await p.keyboard.press("Escape"); await p.waitForTimeout(400); }),
    E("editor-viewing-close", "ux-history", "editor-viewing, then History closed with its ✕: back to your edit.", async (p) => { await playDirector(p); await p.locator("aside.carton-sidebar button[aria-label^=Close]").first().click(); await p.waitForTimeout(400); }),
    E("editor-shared", "qa-shared", "Shared, Leo and Mia here, panel closed.", null),
    E("editor-live-media", "qa-live-media", "Offline with 3 changes, two clips arriving from Leo (after/stage-live-media.png).", null),
    E("editor-narrow-1100", "ux-history", "A 1100 px window: Share joins History's head; the chip at 150 px.", foldOlder, { viewport: { width: 1100, height: 810 } }),
    E("editor-960", "ux-history", "A 960 px window with History open.", foldOlder, { viewport: NARROW }),

    // ---------------------------------------------------------- title bar (the bar's rightmost 900 px, or all of it)
    B("titlebar-default", "qa-one-cut", "Main cut, nothing open (after/titlebar-default.png).", null),
    B("titlebar-other-cut", "ws1-other-cut", "30s Instagram cut (after/titlebar-other-cut.png).", null),
    B("titlebar-viewing", "ux-history", "Viewing the Director's turn (after/titlebar-viewing.png).", playDirector),
    B("titlebar-before", "ux-history", "Before held (the chip reads Before …).", async (p) => { await playDirector(p); await holdBefore(p, ".carton-card-version"); }, { keepHover: true }),
    B("titlebar-teammate", "qa-teammate-window", "Leo's Main cut (after/titlebar-teammate-cut.png).", null),
    B("titlebar-shared", "qa-shared", "Shared, Leo and Mia here (after/titlebar-shared.png).", null),
    B("titlebar-offline", "qa-offline", "Offline, 3 changes not sent (after/titlebar-offline.png).", null),
    B("titlebar-conflict-see", "qa-conflict", "A conflict side seen: the chip's label.", seeTheirs),
    ...[["main", "qa-shared"], ["other", "ws1-other-cut"], ["long-viewing", "qa-long-cut"]].map(([n, s]) => B(`titlebar-960-${n}`, s, "A 960 px window with Windows' caption buttons: nothing overlaps (PLAN 2.3).", null, { viewport: NARROW, crop: 0, q: "&win=1" })),
    B("titlebar-960-viewing", "ux-history", "A 960 px window, viewing the Director's turn, caption buttons.", playDirector, { viewport: NARROW, crop: 0, q: "&win=1" }),
    B("titlebar-1100", "qa-long-cut", "1100 px (< 1180): a long cut name cut at 150 px, Share gone from the bar (after/titlebar-narrow.png).", null, { viewport: { width: 1100, height: 700 }, crop: 0, q: "&win=1" }),

    // ---------------------------------------------------------- the stage, panel closed
    T("conflict-card", "qa-conflict", "You and Claude Code both moved “Interview B”; a second card behind (after/conflict-card.png).", null),
    T("conflict-picked", "qa-conflict", "Claude Code's side picked: the stage doesn't change; Keep names the pick.", async (p) => { await side(p, "theirs").click(); await p.waitForTimeout(150); }),
    T("conflict-theirs", "qa-conflict", "Claude Code's side → See it: the card keeps its title and sides, see-through, until the pointer is on it.", seeTheirs),
    T("conflict-theirs-hover", "qa-conflict", "conflict-theirs, then the pointer on the card: whole again, with Keep.", async (p) => { await seeTheirs(p); await p.locator(".carton-stack .carton-card-title").first().hover(); await p.waitForTimeout(250); }, { keepHover: true }),
    T("conflict-both", "qa-conflict", "› to the second card, Both picked (after/conflict-keep-both.png).", async (p) => { await p.locator(".carton-conflict-next").first().click(); await p.waitForTimeout(150); await side(p, "both").click(); await p.waitForTimeout(150); }),
    T("conflict-twice", "qa-conflict-twice", "Two of your own changes (after/conflict-same-person.png).", null),
    T("conflict-turn", "qa-conflict-turn", "Claude Code still working (after/conflict-during-turn.png).", null),
    T("conflict-again", "qa-conflict-again", "Claude Code changed it again after a pick: Pick again.", async (p) => { await side(p, "theirs").click(); await p.waitForTimeout(100); await p.evaluate(() => window.__again()); await p.waitForTimeout(250); }),
    T("conflict-pill", "qa-conflict", "Not now: the pill (after/conflict-pill.png).", async (p) => { await p.getByRole("button", { name: "Not now" }).first().click(); await p.waitForTimeout(150); }),
    T("conflict-old-words", "qa-conflict-old", "Cards without their sentences (the engine's 'Intro' timing): the fallback words (design QA G30).", null),
    T("conflict-focus", "qa-conflict", "Keyboard: focus in the card's sides, then ↓ to Claude Code's side.", async (p) => { await p.locator(".carton-conflict [role=radio]").first().focus(); await p.keyboard.press("ArrowDown"); await p.waitForTimeout(150); }),
    T("conflict-narrow", "qa-conflict", "A 360 px stage.", null, { viewport: { width: 290 + 360 + 380, height: 900 } }),
    T("conflict-narrow-theirs", "qa-conflict", "A 360 px stage, Claude Code's side → See it.", seeTheirs, { viewport: { width: 290 + 360 + 380, height: 900 } }),
    T("toast-warning", "stage-toast-warning", "A save that failed: the warning toast.", async (p) => { await p.locator(".carton-toast").waitFor(); await p.waitForTimeout(100); }),
    T("live-media", "qa-live-media", "The footage notice and the offline chip (after/stage-live-media.png).", null),

    // ---------------------------------------------------------- panel states (at each panel width)
    P("history-group-open", "ux-history", "Your six changes' group opened: each one indented.", async (p) => { await foldOlder(p); await p.locator(".carton-version-group").first().click(); await p.waitForTimeout(200); }),
    P("history-filter-on", "ux-history", "Filter → Agent turns: the removable chip under the cut bar.", async (p) => { await foldOlder(p); await p.locator(".carton-filter-btn").click(); await p.waitForTimeout(150); await menuItem(p, "Agent turns").click(); await p.waitForTimeout(250); }),
    P("history-filter-empty", "ux-empty", "Filter → Named versions on a history with none: the empty text.", async (p) => { await p.locator(".carton-filter-btn").click(); await p.waitForTimeout(150); await menuItem(p, "Named versions").click(); await p.waitForTimeout(250); }),
    P("history-restore-error", "qa-errors", "Restore… → Restore, and it fails: the card says so.", async (p) => { await foldOlder(p); await uxMenu(p, "Add captions to the interview"); await menuItem(p, "Restore…").click(); await p.locator(".carton-card-confirm").waitFor(); await p.locator(".carton-card-confirm .carton-btn", { hasText: "Restore" }).first().click(); await p.waitForTimeout(400); }),
    P("history-undo-turn-error", "qa-errors", "Undo this turn fails: the card says so.", async (p) => { await foldOlder(p); await openCard(p, "Tighten the intro"); await p.locator(".carton-card-version .carton-btn", { hasText: "Undo this turn" }).click(); await p.waitForTimeout(400); }),
    P("history-play-fail", "ux-history", "Play all on an older version, and the version can't load: the card says so.", async (p) => { await failPreview(p); await playDirector(p); await p.waitForTimeout(500); }),
    P("history-offline-menu", "ux-offline", "⋯ on a change not sent yet.", (p) => uxMenu(p, "Trimmed “Outro”")),
    P("history-keyboard", "ux-history", "Keyboard: focus in the list, ↓ ↓ (the focus ring on a row).", async (p) => { await foldOlder(p); await p.locator(".carton-history-list").focus(); await p.keyboard.press("ArrowDown"); await p.keyboard.press("ArrowDown"); await p.waitForTimeout(150); }),
    P("history-name", "ux-history", "⋯ → Name this version, \"Sent to client, Monday\" typed.", async (p) => { await foldOlder(p); await uxMenu(p, "Add captions to the interview"); await menuItem(p, "Name this version").click(); await p.keyboard.type("Sent to client, Monday"); await p.waitForTimeout(150); }),
    P("history-start-row", "ux-history", "Scrolled to the bottom: the single start row.", async (p) => { await foldOlder(p); await p.locator(".carton-history-list").evaluate((e) => { e.scrollTop = e.scrollHeight; e.dispatchEvent(new Event("scroll")); }); await p.waitForTimeout(300); }),
    P("history-fold-row-menu", "ux-history", "⋯ on the partial fold: Fold in the rest.", async (p) => { await foldOlder(p); await uxMenu(p, "Folded in"); }),
    P("history-nameless", "qa-nameless", "A change by someone with no name, and one the system made: \"Teammate\", and a count with no stray dot (design QA G30).", null),
    P("cuts-one", "qa-one-cut", "One cut: the cuts menu.", async (p) => { await p.locator(".carton-cuts-trigger").click(); await p.waitForTimeout(200); }),
    P("cuts-other-cut", "qa-other-cut-panel", "On 30s Instagram cut, History open: the cut bar draws it as the chip does, its dot alone (design QA G12).", null),
    P("teammate-fold", "ws6-teammate", "Leo's Main cut → Fold into Main cut…: the dialog.", async (p) => { await p.getByRole("button", { name: /Fold into/ }).first().click(); await p.locator(".carton-dialog").first().waitFor(); await p.waitForTimeout(300); }, { target: "window", perWidth: false }),
    P("changes-play-older", "ux-history", "Changes view on the Director's turn, Play all, Before held.", async (p) => { await foldOlder(p); await changes(p); await p.locator(".carton-changes-view .carton-play-all .carton-btn").click(); await p.waitForTimeout(800); await holdBefore(p, ".carton-changes-view"); }, { keepHover: true }),
    P("tip-undo-turn", "ux-history", "Hover on Undo this turn: its tooltip.", async (p) => { await foldOlder(p); await openCard(p, "Tighten the intro"); await p.locator(".carton-card-version .carton-btn", { hasText: "Undo this turn" }).hover(); await p.waitForTimeout(900); }, { keepHover: true, anim: true }),
    P("tip-before", "ux-history", "Playing, hover on Before: its tooltip.", async (p) => { await playDirector(p); await p.locator(".carton-card-version .carton-before").first().hover(); await p.waitForTimeout(900); }, { keepHover: true, anim: true }),
    P("tip-filter", "ux-history", "Hover on the filter button at the panel's right edge.", async (p) => { await p.locator(".carton-filter-btn").hover(); await p.waitForTimeout(900); }, { keepHover: true, anim: true }),
    P("tip-viewing-x", "ux-history", "Viewing, hover on the row's ✕.", async (p) => { await playDirector(p); await p.locator(".carton-version-back").first().hover(); await p.waitForTimeout(900); }, { keepHover: true, anim: true }),

    // ---------------------------------------------------------- dialogs
    D("share-first", "qa-share-first", "Share, not shared yet: server and name typed (after/share-first.png).", async (p) => { await p.fill("#carton-share-host", "share.northlight.studio"); await p.fill("#carton-share-name", "Vikas"); await p.waitForTimeout(700); }),
    D("share-first-empty", "qa-share-first", "Share, not shared yet, nothing typed.", null),
    D("share-submitted", "qa-share-first", "Share project pressed with nothing filled: the field errors.", async (p) => { await p.locator(".carton-dialog .carton-btn", { hasText: "Share project" }).first().click(); await p.waitForTimeout(250); }),
    D("share-known", "qa-share-known", "Not shared, the server and name known: one line with Change.", null),
    D("share-code", "qa-share-code", "The server asks for an invite code.", async (p) => { await p.fill("#carton-share-host", "https://share.example.com"); await p.waitForTimeout(800); }),
    D("share-unreachable", "qa-share-unreachable", "The server can't be reached (after/share-unreachable.png).", async (p) => { await p.fill("#carton-share-host", "https://share.nowhere.test"); await p.waitForTimeout(800); }),
    D("share-owner", "qa-share-owner", "Shared, owner, Leo here with his Director working, Mia idle (after/share-owner.png).", null),
    D("share-offline", "qa-share-offline", "Shared and offline, 3 changes waiting (after/share-offline.png).", null),
    D("share-editor", "qa-share-editor", "Joined as an editor: no invite.", null),
    D("share-update", "qa-share-update", "The server needs an update.", null),
    W("join", "join", "The Dashboard's Join dialog (after/join-dialog.png).", null, { viewport: { width: 1280, height: 800 } }),
    W("join-errors", "join", "Join and open pressed with nothing filled in.", async (p) => { await p.locator(".carton-join-dialog .carton-btn").last().click(); await p.waitForTimeout(250); }, { viewport: { width: 1280, height: 800 } }),
    W("join-filled", "join", "The invite link pasted.", async (p) => { await p.fill("#carton-join-link", "https://share.example.com/p/7f3a9c#join=ct1.editor.Zk9QmV2xL0aT8bWn4RjYc"); await p.waitForTimeout(200); }, { viewport: { width: 1280, height: 800 } }),
  ];
}
