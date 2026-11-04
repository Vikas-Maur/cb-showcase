// The shots for Compare with History closed (states/room.js): the laptop's layout before and after a click on the greyed
// Side by side, and Compare with History open, then closed from the title bar's icon. A step that waits for what the
// change brings waits a while and goes on without it, so the same shots run on a build without the change (before).
export function shots({ ED }) {
  const LAPTOP = { width: 1444, height: 810 };
  const W = (name, s, how, steps, o = {}) => ({ name, s, how, steps, target: "window", perWidth: false, viewport: ED, ...o });
  const open = async (p) => { await p.locator(".carton-compare").waitFor(); await p.locator(".carton-compare-list .carton-change").first().waitFor({ timeout: 4000 }).catch(() => {}); await p.waitForTimeout(400); };
  const side = (p) => p.locator('.carton-compare [role=radio][data-mode="side"]');
  const measure = (p) => p.evaluate(() => {
    const w = (s) => Math.round(document.querySelector(s)?.getBoundingClientRect().width ?? 0);
    window.__cap.room = { stage: w("[data-carton-stage-host]"), history: w("aside.carton-sidebar"), chat: w(".cap-chat"), mode: document.querySelector(".carton-compare")?.getAttribute("data-mode") ?? null };
  });
  return [
    W("room-laptop-greyed", "room-laptop", "The laptop's 1444 px window (rail 46, Library 320, History 374, chat 384): Compare opened, the Library aside, the stage under 682 px: Flip, Side by side greyed; the pointer on it shows its tooltip.", async (p) => {
      await open(p);
      await side(p).hover();
      await p.waitForTimeout(700);
      await measure(p);
    }, { viewport: LAPTOP, keepHover: true }),
    W("room-laptop-clicked", "room-laptop", "room-laptop-greyed, then a click on the greyed Side by side: History closes, Compare stays on, Side by side on the wider stage, the frame's own label.", async (p) => {
      await open(p);
      // (forced: before this change a greyed Side by side was disabled, and a click on it did nothing)
      await side(p).click({ force: true });
      await p.locator('.carton-compare[data-mode="side"]').waitFor({ timeout: 3000 }).catch(() => {});
      await p.waitForTimeout(500);
      await measure(p);
    }, { viewport: LAPTOP }),
    W("room-history-open", "room-side", "Compare in Side by side with History open (its change list), the mockups' 1522 px window.", async (p) => { await open(p); await measure(p); }),
    W("room-history-closed", "room-side", "room-history-open, then History closed from the title bar's icon: Compare stays on, Side by side re-measured to the wider stage, the frame's own label ⇆ … · 7 changes ✕.", async (p) => {
      await open(p);
      await p.evaluate(() => window.__carton.command("carton-history"));
      await p.waitForTimeout(800);
      await measure(p);
    }),
  ];
}
