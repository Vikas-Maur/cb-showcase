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
// A shared project's status beside the icons (UI audit P2-11): a dot on the icon (amber offline, white while edits are
// sending), and the people here as small avatars, in the tooltip too. live is the page's summary (scripts/carton/ui.js
// liveSummary): {state, words, people: [{name, initials, color, idle}], more}.
function __cbCartonStripButton({ id, label, pressed, live }) {
  const tip = live ? [label, live.words, live.here].filter(Boolean).join(" · ") : label;
  return n.jsxs("button", {
    type: "button",
    "aria-label": tip,
    "aria-pressed": pressed,
    title: tip,
    "data-carton-strip": id,
    style: { gap: 5 },
    onClick: () => I({ action: "carton-" + id }),
    className: w(C, "relative px-[6px]", pressed ? "bg-white/[0.12] text-white hover:bg-white/[0.14]" : "text-white/45 hover:bg-white/[0.06] hover:text-white/80"),
    children: [
      n.jsx("svg", { viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 1.75, strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": !0, className: "size-4 shrink-0", children: __cbCartonStripIcons[id].map((d, i) => n.jsx("path", { d }, i)) }, "i"),
      // sizes inline: the strip's stylesheet has only the classes Cardboard itself uses
      live && live.state !== "ok" ? n.jsx("span", { "aria-hidden": !0, "data-carton-sync": live.state, style: { position: "absolute", top: 4, left: 18, width: 7, height: 7, borderRadius: 999, pointerEvents: "none", boxShadow: "0 0 0 2px #0c0c0c", background: live.state === "offline" ? "#fbbd23" : "rgba(255,255,255,0.85)" } }, "d") : null,
      live && live.people?.length ? n.jsxs("span", { "aria-hidden": !0, style: { display: "flex", alignItems: "center" }, children: [
        ...live.people.map((p, i) => n.jsx("span", { style: { display: "flex", alignItems: "center", justifyContent: "center", width: 16, height: 16, borderRadius: 999, fontSize: 7.5, fontWeight: 600, letterSpacing: "-0.02em", color: "#141414", background: p.color, opacity: p.idle ? 0.5 : 1, marginLeft: i ? -4 : 0, boxShadow: "0 0 0 1.5px #0c0c0c" }, children: p.initials }, i)),
        live.more ? n.jsx("span", { style: { marginLeft: 3, fontSize: 10, color: "rgba(255,255,255,0.5)", fontVariantNumeric: "tabular-nums" }, children: "+" + live.more }, "m") : null,
      ] }, "p") : null,
    ],
  });
}
// Narrow windows: the strip keeps History only (Share is one of the side panel's own tabs), so it adds half as much to
// a title bar whose tabs already run short (UI audit P3-6). The status then shows on History's icon.
const __cbCartonNarrow = "(max-width: 1180px)";
function __cbCartonStrip({ panel }) {
  const p = panel && typeof panel === "object" ? panel : { panel, live: null };
  const [narrow, setNarrow] = c.useState(() => typeof matchMedia === "function" && matchMedia(__cbCartonNarrow).matches);
  c.useEffect(() => {
    if (typeof matchMedia !== "function") return undefined;
    const q = matchMedia(__cbCartonNarrow), f = () => setNarrow(q.matches);
    q.addEventListener?.("change", f);
    return () => q.removeEventListener?.("change", f);
  }, []);
  const live = p.live ?? null;
  return n.jsxs("div", { className: "flex shrink-0 items-center gap-[2px]", "data-carton-narrow": narrow ? "" : void 0, children: [
    n.jsx(__cbCartonStripButton, { id: "history", label: "Version history", pressed: p.panel === "history" || (narrow && p.panel === "share"), live: narrow && live ? { ...live, people: [], more: 0 } : null }, "history"),
    narrow ? null : n.jsx(__cbCartonStripButton, { id: "share", label: "Share", pressed: p.panel === "share", live }, "share"),
  ] });
}
`;
