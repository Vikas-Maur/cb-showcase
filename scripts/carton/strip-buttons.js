// The title bar's Carton parts, prepended to Cardboard's tab strip bundle (tabs-*.js) by patch-carton.js. They run in
// that bundle's scope: `n` is the JSX runtime, `c` is React, `w` joins class names, `I` sends a strip command to main,
// `C` is the strip's button class, `G` formats a shortcut.
// - The cut chip (__cbCartonCutChip, Carton UX redesign PLAN 2.1-2.3), placed before Cardboard's own "16:9 ⌄" in the
//   same chip look: "✂ Main cut ⌄", or a colour dot for any other cut. The person always knows which cut they're on,
//   on every project tab, without opening History. While they're looking at something other than their own edit
//   (viewing: an older version played, a conflict side, a teammate's cut), it grows a second part, "👁 <label> ✕".
//   Its click sends carton-cuts (the editor's page opens History with its cuts menu open and focused: version 1 of
//   PLAN 2.2, since the menu can't be drawn by this page in the editor's); the ✕ sends carton-back (back to your edit).
// - The History and Share icons (__cbCartonStrip), just before "Report an issue", in its size, style and hover (icon
//   only, the name in the tooltip).
// They show only on a project tab in the editor with Carton on: the strip renders them when the tab's editor state
// carries `cartonPanel`, which only the editor's Carton layer reports (scripts/carton/ui.js CartonSide, through main's
// carton:panel: main-bridge.js `panel` keeps only the fields below). A click sends carton-history / carton-share /
// carton-cuts / carton-back, which main routes to that tab's page as carton:command; the page reports again what is
// open and which cut it is on, which comes back here.
// The report: `panel` ("history", "comments" or null), `live` (a shared project's summary, or null), `share` (the Share
// dialog is open), `cut` ({name, dot}: dot is a CSS colour for any cut but Main, null for Main), `viewing` ({label}, or
// null). An older report is a bare panel name: no chip then.
// A narrow window (QA G4): the chip is the one part of the editor's controls that gives way (patch-carton.js lets that
// row shrink), so the window's own buttons are never pushed out; below 1000 px, while the chip has its second part, the
// cut shows as its dot or scissors only, its name in the tooltip.
module.exports = String.raw`
const __cbCartonStripIcons = {
  // a stack of versions, not the clock the chat's own "chat history" button uses beside it (UI audit P2-14)
  history: ["M12 3.8l8.2 4.2-8.2 4.2-8.2-4.2z", "M3.8 12.2l8.2 4.2 8.2-4.2", "M3.8 16.2l8.2 4.2 8.2-4.2"],
  share: ["M12.3 8.8a3.3 3.3 0 1 1-6.6 0 3.3 3.3 0 0 1 6.6 0z", "M3 19.5c1-3.1 3.3-4.7 6-4.7s5 1.6 6 4.7", "M15.2 5.8a3.3 3.3 0 0 1 0 6.1", "M17.4 14.9c1.6.6 2.9 2.1 3.6 4.6"],
  // the cut chip's: scissors (Main cut), the caret, the eye (viewing) and its ✕
  cut: ["M8.2 7.4 20 17", "M8.2 16.6 20 7", "M8.6 6a2.6 2.6 0 1 1-5.2 0 2.6 2.6 0 0 1 5.2 0z", "M8.6 18a2.6 2.6 0 1 1-5.2 0 2.6 2.6 0 0 1 5.2 0z"],
  caret: ["M7 10l5 5 5-5"],
  eye: ["M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z", "M15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0z"],
  x: ["M6.5 6.5l11 11", "M17.5 6.5l-11 11"],
};
const __cbCartonSvg = (id, className, strokeWidth = 1.75) => n.jsx("svg", { viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth, strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": !0, className, children: __cbCartonStripIcons[id].map((d, i) => n.jsx("path", { d }, i)) }, id);
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
      __cbCartonSvg(id, "size-4 shrink-0"),
      // sizes inline: the strip's stylesheet has only the classes Cardboard itself uses
      live && live.state !== "ok" ? n.jsx("span", { "aria-hidden": !0, "data-carton-sync": live.state, style: { position: "absolute", top: 4, left: 18, width: 7, height: 7, borderRadius: 999, pointerEvents: "none", boxShadow: "0 0 0 2px #0c0c0c", background: live.state === "offline" ? "#fbbd23" : "rgba(255,255,255,0.85)" } }, "d") : null,
      // 16 px avatars, overlapping by 3 px, initials at 8 px: two letters stay readable (PLAN 9.4, AUDIT R4)
      live && live.people?.length ? n.jsxs("span", { "aria-hidden": !0, style: { display: "flex", alignItems: "center" }, children: [
        ...live.people.map((p, i) => n.jsx("span", { style: { display: "flex", alignItems: "center", justifyContent: "center", width: 16, height: 16, borderRadius: 999, fontSize: 7.5, fontWeight: 600, letterSpacing: "-0.02em", color: "#141414", background: p.color, opacity: p.idle ? 0.5 : 1, marginLeft: i ? -4 : 0, boxShadow: "0 0 0 1.5px #0c0c0c" }, children: p.initials }, i)),
        live.more ? n.jsx("span", { style: { marginLeft: 3, fontSize: 10, color: "rgba(255,255,255,0.5)", fontVariantNumeric: "tabular-nums" }, children: "+" + live.more }, "m") : null,
      ] }, "p") : null,
    ],
  });
}
// Narrow windows: the strip keeps History only (Share opens from the History panel's head there), so it adds half as
// much to a title bar whose tabs already run short (UI audit P3-6). The status then shows on History's icon. The cut
// chip stays, its name cut off at 150 px instead of 220 px (PLAN 2.3), and below 1000 px it gives the room to its second
// part (QA G4).
const __cbCartonNarrow = "(max-width: 1180px)", __cbCartonTight = "(max-width: 1000px)";
function __cbCartonUseMedia(query) {
  const [on, setOn] = c.useState(() => typeof matchMedia === "function" && matchMedia(query).matches);
  c.useEffect(() => {
    if (typeof matchMedia !== "function") return undefined;
    const q = matchMedia(query), f = () => setOn(q.matches);
    q.addEventListener?.("change", f);
    return () => q.removeEventListener?.("change", f);
  }, [query]);
  return on;
}
const __cbCartonUseNarrow = () => __cbCartonUseMedia(__cbCartonNarrow);
const __cbCartonReport = (panel) => (panel && typeof panel === "object" ? panel : { panel, live: null });
function __cbCartonStrip({ panel }) {
  const p = __cbCartonReport(panel);
  const narrow = __cbCartonUseNarrow();
  const live = p.live ?? null;
  return n.jsxs("div", { className: "flex shrink-0 items-center gap-[2px]", "data-carton-narrow": narrow ? "" : void 0, children: [
    n.jsx(__cbCartonStripButton, { id: "history", label: "Version history (" + (typeof G === "function" ? G("⇧H") : "Ctrl+Shift+H") + ")", pressed: p.panel === "history", live: narrow && live ? { ...live, people: [], more: 0 } : null }, "history"),
    narrow ? null : n.jsx(__cbCartonStripButton, { id: "share", label: "Share", pressed: !!p.share, live }, "share"),
  ] });
}
// The chip's second part: what the stage shows instead of your edit, and the ✕ that brings your edit back. The first
// state the report carries is shown. Each is one entry: the report's field (a {label}), its icon, what a screen reader
// hears before the label, its ✕'s words and command, and its tint. Another state (Compare's "⇆ Comparing … ✕") is one
// more entry here, and its icon in __cbCartonStripIcons.
const __cbCartonChipParts = [
  { field: "viewing", icon: "eye", said: "Looking at ", back: "Back to my edit (Esc)", action: "carton-back", tint: "rgba(138,180,255,0.11)", ink: "#d6e4ff" },
];
const __cbCartonChipPart = (p) => {
  for (const s of __cbCartonChipParts) if (p[s.field] && typeof p[s.field].label === "string") return { ...s, label: p[s.field].label };
  return null;
};
// The cut chip. Its words are fixed here (this bundle has no @carton/react): the cut's name and the second part's label
// come whole from the page, cut off with an ellipsis and shown whole in the tooltip and to screen readers.
function __cbCartonCutChip({ panel }) {
  const p = __cbCartonReport(panel);
  const narrow = __cbCartonUseNarrow(), tight = __cbCartonUseMedia(__cbCartonTight);
  const cut = p.cut && typeof p.cut.name === "string" ? p.cut : null;
  if (!cut) return null;
  const part = __cbCartonChipPart(p);
  // below 1000 px with a second part: the cut is its mark only (QA G4)
  const markOnly = tight && !!part;
  const clip = (max) => ({ minWidth: 0, maxWidth: max, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" });
  // data-no-drag: the title bar drags the window; the second part's label isn't a button, so it says so itself.
  // min-w-0 shrink: the chip gives way first in a narrow window (its marks and ✕ never do).
  return n.jsxs("div", { "data-no-drag": !0, "data-carton-cut-chip": "", ...(part ? { ["data-" + part.field]: "" } : {}), className: "flex min-w-0 shrink items-center overflow-hidden rounded-ui-sm", style: { boxShadow: "inset 0 0 0 1px rgba(255,255,255," + (part ? "0.12)" : "0.08)") }, children: [
    n.jsxs("button", {
      type: "button",
      "aria-haspopup": "menu",
      "aria-label": "Cut: " + cut.name + ". Switch cuts",
      title: cut.name,
      "data-carton-cut": cut.dot ? "other" : "main",
      "data-mark-only": markOnly ? "" : void 0,
      onClick: () => I({ action: "carton-cuts" }),
      className: w(C, "min-w-0 gap-1.5 px-2 text-white/85 hover:bg-white/[0.06] hover:text-white"),
      style: part ? { borderRadius: 0 } : void 0,
      children: [
        cut.dot ? n.jsx("span", { "aria-hidden": !0, "data-carton-cut-dot": "", style: { width: 8, height: 8, flex: "none", borderRadius: 999, background: cut.dot } }, "dot") : __cbCartonSvg("cut", "size-3.5 shrink-0"),
        // narrow with a second part: both parts must fit beside the tabs, the label shortened first (DESIGN §9)
        markOnly ? null : n.jsx("span", { style: clip(narrow ? (part ? 120 : 150) : 220), children: cut.name }, "name"),
        markOnly ? null : __cbCartonSvg("caret", "size-2.5 shrink-0 text-white/40", 2.4),
      ],
    }, "cut"),
    // no live region here: the editor's page announces viewing once (DESIGN §7), not this page too
    part ? n.jsxs("span", { ["data-carton-" + part.field]: "", title: part.label, className: "flex h-7 min-w-0 items-center gap-1.5", style: { paddingLeft: 9, paddingRight: 3, background: part.tint, color: part.ink, boxShadow: "inset 1px 0 0 rgba(255,255,255,0.12)" }, children: [
      __cbCartonSvg(part.icon, "size-3.5 shrink-0"),
      n.jsx("span", { className: "text-ui-sm font-medium", style: clip(narrow ? 100 : 240), children: [n.jsx("span", { className: "sr-only", children: part.said }, "s"), part.label] }, "label"),
      n.jsx("button", { type: "button", "aria-label": part.back, title: part.back, "aria-keyshortcuts": "Escape", "data-carton-back": "", onClick: () => I({ action: part.action }), className: w(C, "size-[22px] shrink-0 justify-center text-white/60 hover:bg-white/[0.08] hover:text-white"), children: __cbCartonSvg("x", "size-3 shrink-0", 2) }, "x"),
    ] }, part.field) : null,
  ] });
}
`;
