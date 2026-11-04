// The capture page's states for Compare with History closed (fix/ux2-compare-room: DESIGN-V2 §1.9, the user's "close
// History without ending Compare", and a greyed Side by side's click making the room). Gallery code only.
// - room-laptop: the layout measured on the orchestrator's Windows laptop (1920 × 1080 at 125 %, a 1444 CSS px window):
//   icon rail 46, Library 320, History 374, chat 384. Comparing, the Library steps aside and the stage is under 682 px, so
//   Side by side is greyed; closing History gives it the room.
// - room-side: n1-side (the mockups' 1522 px window), for Compare with History open and then closed.

const LAPTOP_CSS = `
[data-cap-room] .cap-library{width:auto}
[data-cap-room] .cap-rail{width:46px}
[data-cap-room] .cap-lib{flex:none;width:320px;box-sizing:border-box}
[data-cap-room][data-cap-lib-aside] .cap-library{width:46px}
[data-cap-room] .cap-chat{width:384px}
`;

export function addStates(S) {
  S["room-laptop"] = () => {
    const r = S["n1-side"]();
    document.documentElement.setAttribute("data-cap-room", "");
    const st = document.createElement("style");
    st.textContent = LAPTOP_CSS;
    document.head.appendChild(st);
    // History as wide as it was there (its own resize keeps the width here)
    try { localStorage.setItem("carton.sidePanelWidth", "374"); } catch {}
    return r;
  };
  S["room-side"] = () => S["n1-side"]();
}
