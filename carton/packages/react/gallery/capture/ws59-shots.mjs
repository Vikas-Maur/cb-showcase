// The shots for UX redesign workstreams 5 and 9 (docs/carton-ux PLAN 5.x, 9.x), beside the mockups after/toasts.png,
// editor-toast-offline.png, history-restore-*.png, history-newcut-384.png and comments-*.png: shoot.mjs adds them to
// its list (one line there). `h`: shoot.mjs's own helpers (P, T, menuItem, foldOlder, uxMenu, openCard, cutsMenu, tab).
export function ws59Shots({ P, T, menuItem, foldOlder, uxMenu, openCard, cutsMenu, tab }) {
  const toast = async (p) => { await p.locator(".carton-toast").waitFor(); await p.waitForTimeout(200); };
  const restore = async (p) => {
    await foldOlder(p);
    await uxMenu(p, "Moved “Interview B” 2 s later");
    await menuItem(p, "Restore…").click();
    // Go back… opens with Restore the whole edit picked (Carton UX v2, DESIGN-V2 §3.1)
    await p.locator(".carton-goback").waitFor();
    await p.locator(".carton-goback .carton-btn", { hasText: "Restore the whole edit" }).first().click();
    await toast(p);
  };
  const panel = { panelOpen: true };
  const fold = async (p) => {
    await cutsMenu(p);
    await menuItem(p, "Fold in changes from a cut…").click();
    await p.locator(".carton-fold .carton-fold-box, .carton-fold .carton-fold-nothing").first().waitFor();
    await p.waitForTimeout(150);
    await p.locator(".carton-fold .carton-btn", { hasText: "Fold in" }).last().click();
    await toast(p);
  };
  return [
    T("after-toast-restore", "ws59-history", "⋯ on your six changes → Restore… → Restore: \"Restored your edit from 12:41 pm. Later changes are in History.\" [Undo].", restore, panel),
    T("after-toast-undone", "ws59-history", "after-toast-restore, then its Undo: \"Restore undone.\" [Redo] (the capture bridge answers the undo at once).", async (p) => { await restore(p); await p.locator(".carton-toast .carton-btn", { hasText: "Undo" }).click(); await p.locator(".carton-toast", { hasText: "undone" }).waitFor(); await p.waitForTimeout(200); }, panel),
    T("after-toast-fold", "ws6-fold-all", "On Main cut: the cuts menu → Fold in changes from a cut… (30s Instagram cut) → Fold in 4 changes: \"Folded 4 changes from “30s Instagram cut” into Main cut.\" [Undo].", fold, panel),
    T("after-toast-newcut", "ws59-history", "⋯ on the Director's turn → New cut from this version… → \"30s Instagram cut\" → Make cut: [Switch back to Main cut].", async (p) => { await foldOlder(p); await uxMenu(p, "Add captions to the interview"); await menuItem(p, "New cut from this version").click(); await p.keyboard.type("30s Instagram cut"); await p.keyboard.press("Enter"); await toast(p); }, panel),
    T("after-toast-turn", "ws59-history", "Claude Code's turn (the newest) → its card → Undo this turn: \"Took out Claude Code's “Tighten the intro…” (4 changes).\" [Undo].", async (p) => { await foldOlder(p); await openCard(p, "Tighten the intro"); await p.locator(".carton-card-version .carton-btn", { hasText: "Undo this turn" }).click(); await toast(p); }, panel),
    T("after-toast-pick", "ws59-pick", "A conflict card: Claude Code's side picked, then Keep Claude Code's: \"Kept Claude Code's move of “Interview B”.\" [Undo].", async (p) => { await p.locator(".carton-conflict [role=radio][data-choice=theirs]").click(); await p.waitForTimeout(100); await p.locator(".carton-conflict .carton-btn", { hasText: /^Keep Claude Code/ }).click(); await toast(p); }),
    T("after-toast-switch", "ws6-cuts", "The cuts menu → 30s Instagram cut: \"You're on “30s Instagram cut” now.\" [Switch back to Main cut].", async (p) => { await cutsMenu(p); await p.locator(".carton-cut-item", { hasText: "30s Instagram cut" }).click(); await toast(p); }, panel),
    P("after-toast-offline", "ws59-offline", "Offline with 3 changes not sent, then a restore: the toast sits above the offline chip, not over it.", restore, { target: "window", perWidth: false }),
    // R3 (PLAN 9.4): the Share dialog's field with its error border (WS8 drew it; its dialog is shot here, the old panel shot
    // no longer has a panel to wait for)
    P("after-share-unreachable", "share-unreachable", "Share → the server's address typed (https://share.nowhere.test), which can't be reached: the message at the field, and its red border.", async (p) => { await p.locator(".carton-dialog").waitFor(); await p.fill("#carton-share-host", "https://share.nowhere.test"); await p.waitForTimeout(800); }, { target: "dialog", perWidth: false }),
    P("after-comments", "ws59-comments", "History open, then the Comments tab: the box says where the note goes, times as 0:12, \"That moment changed since. See it as it was\", Whole video; nothing resolved, so no Open/Resolved/All.", (p) => tab(p, "Comments").then(() => p.waitForTimeout(300))),
  ];
}
