// The title bar's History and Share icons, prepended to Cardboard's tab strip bundle (tabs-*.js) by patch-carton.js and
// placed just before its "Report an issue" button, in its size, style and hover (the strip's button class `C`, the
// same colours; icon only, the name in the tooltip). They run in that bundle's scope: `n` is the JSX runtime, `w` joins
// class names, `I` sends a strip command to main.
// They show only on a project tab in the editor with Carton on: the strip renders them when the tab's editor state
// carries `cartonPanel`, which only the editor's Carton layer reports (null when no panel is open). A click sends
// carton-history / carton-share, which main routes to that tab's page as carton:command; the page toggles its side
// panel and reports the one open, which comes back here as the icon's pressed look.
module.exports = String.raw`
const __cbCartonStripIcons = {
  // a stack of versions, not the clock the chat's own "chat history" button uses beside it (UI audit P2-14)
  history: ["M12 3.8l8.2 4.2-8.2 4.2-8.2-4.2z", "M3.8 12.2l8.2 4.2 8.2-4.2", "M3.8 16.2l8.2 4.2 8.2-4.2"],
  share: ["M12.3 8.8a3.3 3.3 0 1 1-6.6 0 3.3 3.3 0 0 1 6.6 0z", "M3 19.5c1-3.1 3.3-4.7 6-4.7s5 1.6 6 4.7", "M15.2 5.8a3.3 3.3 0 0 1 0 6.1", "M17.4 14.9c1.6.6 2.9 2.1 3.6 4.6"],
};
function __cbCartonStripButton({ id, label, pressed }) {
  return n.jsx("button", {
    type: "button",
    "aria-label": label,
    "aria-pressed": pressed,
    title: label,
    "data-carton-strip": id,
    onClick: () => I({ action: "carton-" + id }),
    className: w(C, "px-[6px]", pressed ? "bg-white/[0.12] text-white hover:bg-white/[0.14]" : "text-white/45 hover:bg-white/[0.06] hover:text-white/80"),
    children: n.jsx("svg", { viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 1.75, strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": !0, className: "size-4 shrink-0", children: __cbCartonStripIcons[id].map((d, i) => n.jsx("path", { d }, i)) }),
  });
}
function __cbCartonStrip({ panel }) {
  return n.jsxs("div", { className: "flex shrink-0 items-center gap-[2px]", children: [
    n.jsx(__cbCartonStripButton, { id: "history", label: "Version history", pressed: panel === "history" }),
    n.jsx(__cbCartonStripButton, { id: "share", label: "Share", pressed: panel === "share" }),
  ] });
}
`;
