// Line icons drawn for Carton in the weight of Cardboard's icon set (Phosphor "regular": thin round strokes), so they
// sit next to its toolbar icons without looking borrowed. 24-unit grid, stroke = currentColor.

import { createElement as h } from "react";

const P = (d: string) => h("path", { d });
const C = (cx: number, cy: number, r: number, fill = false) => h("circle", { cx, cy, r, fill: fill ? "currentColor" : "none", stroke: fill ? "none" : undefined });

const shapes = {
  history: [P("M3.6 12.4A8.5 8.5 0 1 0 6 6.1"), P("M3.4 3.9v4.4h4.4"), P("M12 7.8V12l3.1 2")],
  // Version history: a stack of saved versions. Not the clock above, which is the chat's own "chat history" button in
  // the same title bar (UI audit P2-14).
  versions: [P("M12 3.8l8.2 4.2-8.2 4.2-8.2-4.2z"), P("M3.8 12.2l8.2 4.2 8.2-4.2"), P("M3.8 16.2l8.2 4.2 8.2-4.2")],
  check: [P("M5 12.5l4.4 4.4L19 7.4")],
  caretDown: [P("M7 10l5 5 5-5")],
  caretRight: [P("M10 7l5 5-5 5")],
  caretLeft: [P("M14 7l-5 5 5 5")],
  plus: [P("M12 5v14M5 12h14")],
  pencil: [P("M4.5 19.5h4L19 9a2.1 2.1 0 0 0-3-3L5.5 16.5z"), P("M14 8l3 3")],
  restore: [P("M4.5 9.5h10.2a4.8 4.8 0 0 1 0 9.6H8"), P("M8 5.8L4.4 9.5 8 13.2")],
  eye: [P("M2.5 12S6 5.8 12 5.8 21.5 12 21.5 12 18 18.2 12 18.2 2.5 12 2.5 12z"), C(12, 12, 3)],
  play: [h("path", { d: "M8 5.6v12.8a.8.8 0 0 0 1.2.7l10-6.4a.8.8 0 0 0 0-1.4l-10-6.4A.8.8 0 0 0 8 5.6z", fill: "currentColor", stroke: "none" })],
  pause: [h("rect", { x: 6.5, y: 5, width: 3.6, height: 14, rx: 1, fill: "currentColor", stroke: "none" }), h("rect", { x: 13.9, y: 5, width: 3.6, height: 14, rx: 1, fill: "currentColor", stroke: "none" })],
  flag: [P("M5.5 21V4"), P("M5.5 4.5h11.3l-2.4 4 2.4 4H5.5")],
  bookmark: [P("M7 3.8h10a.8.8 0 0 1 .8.8v15.6l-5.8-3.7-5.8 3.7V4.6a.8.8 0 0 1 .8-.8z")],
  // A cut: scissors (DESIGN §4.1, "✂ Main cut"), as Cardboard's own split tool reads
  cut: [C(6.3, 6.8, 2.5), C(6.3, 17.2, 2.5), P("M8.5 8.1L20 16.4"), P("M8.5 15.9L20 7.6")],
  fold: [P("M12 20.5V12.8L6.5 7.3V3.5"), P("M12 12.8l5.5-5.5V3.5"), P("M8.8 17.4l3.2 3.2 3.2-3.2")],
  // Agents' own marks (UI audit P2-15), drawn for Carton in the set's weight, never a product's logo: Claude Code a
  // burst, Codex a hexagon, the Director a clapperboard. Any other agent keeps the sparkle.
  burst: [P("M12 3.5v17M3.5 12h17M6 6l12 12M18 6L6 18")],
  hexagon: [P("M12 3.4l7.4 4.3v8.6L12 20.6l-7.4-4.3V7.7z"), P("M9.4 10.2L7.6 12l1.8 1.8M14.6 10.2l1.8 1.8-1.8 1.8")],
  clapper: [h("rect", { x: 4, y: 9.5, width: 16, height: 10, rx: 1.4 }), P("M4.4 9.5l-.6-3.2 15-2.8.6 3.2z"), P("M8.6 5.6l1.6 3.1M13.4 4.7l1.6 3.1")],
  sparkle: [P("M12 3.5l1.7 5.6c.2.6.6 1 1.2 1.2l5.6 1.7-5.6 1.7c-.6.2-1 .6-1.2 1.2L12 20.5l-1.7-5.6c-.2-.6-.6-1-1.2-1.2L3.5 12l5.6-1.7c.6-.2 1-.6 1.2-1.2z")],
  user: [C(12, 8.5, 3.8), P("M4.8 20c1.2-3.6 4-5.4 7.2-5.4s6 1.8 7.2 5.4")],
  cloud: [P("M7.2 18.5h9.6a4.2 4.2 0 0 0 .6-8.4 5.9 5.9 0 0 0-11.2 1.2 3.6 3.6 0 0 0 1 7.2z")],
  cloudCheck: [P("M7.2 18.5h9.6a4.2 4.2 0 0 0 .6-8.4 5.9 5.9 0 0 0-11.2 1.2 3.6 3.6 0 0 0 1 7.2z"), P("M9.6 13.8l1.8 1.8 3.4-3.4")],
  cloudSlash: [P("M8.6 6.2A5.9 5.9 0 0 1 17.4 10.1a4.2 4.2 0 0 1 2.4 7.3"), P("M15.6 18.5H7.2a3.6 3.6 0 0 1-1-7.2c.1-.6.3-1.2.5-1.7"), P("M4 4l16 16")],
  syncing: [P("M19.5 10.5a7.6 7.6 0 0 0-13.6-3.4L4.5 8.8"), P("M4.5 4.6v4.2h4.2"), P("M4.5 13.5a7.6 7.6 0 0 0 13.6 3.4l1.4-1.7"), P("M19.5 19.4v-4.2h-4.2")],
  warning: [P("M10.6 4.5L3 18a1.6 1.6 0 0 0 1.4 2.4h15.2A1.6 1.6 0 0 0 21 18L13.4 4.5a1.6 1.6 0 0 0-2.8 0z"), P("M12 9.5v4.2"), C(12, 16.9, 0.9, true)],
  x: [P("M6.5 6.5l11 11M17.5 6.5l-11 11")],
  comment: [P("M4.5 5.5h15a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H10l-4.5 3.5v-3.5h-1a1 1 0 0 1-1-1v-9a1 1 0 0 1 1-1z")],
  target: [C(12, 12, 7), C(12, 12, 2.2), P("M12 2.5v3M12 18.5v3M2.5 12h3M18.5 12h3")],
  link: [P("M10.2 13.8a3.6 3.6 0 0 0 5.1 0l3-3a3.6 3.6 0 0 0-5.1-5.1l-1 1"), P("M13.8 10.2a3.6 3.6 0 0 0-5.1 0l-3 3a3.6 3.6 0 0 0 5.1 5.1l1-1")],
  dots: [C(5.5, 12, 1.5, true), C(12, 12, 1.5, true), C(18.5, 12, 1.5, true)],
  next: [P("M17.5 5.5v13"), h("path", { d: "M6 6.4v11.2a.7.7 0 0 0 1.1.6l8.2-5.6a.7.7 0 0 0 0-1.2L7.1 5.8a.7.7 0 0 0-1.1.6z", fill: "currentColor", stroke: "none" })],
  previous: [P("M6.5 5.5v13"), h("path", { d: "M18 6.4v11.2a.7.7 0 0 1-1.1.6l-8.2-5.6a.7.7 0 0 1 0-1.2l8.2-5.6a.7.7 0 0 1 1.1.6z", fill: "currentColor", stroke: "none" })],
  lock: [h("rect", { x: 5, y: 10.5, width: 14, height: 9.5, rx: 1.6 }), P("M8.5 10.5V7.8a3.5 3.5 0 0 1 7 0v2.7")],
  dot: [C(12, 12, 3, true)],
  arrowLeft: [P("M19 12H5.5"), P("M11 6.5L5.5 12l5.5 5.5")],
  users: [C(9, 8.8, 3.3), P("M3 19.5c1-3.1 3.3-4.7 6-4.7s5 1.6 6 4.7"), P("M15.2 5.8a3.3 3.3 0 0 1 0 6.1"), P("M17.4 14.9c1.6.6 2.9 2.1 3.6 4.6")],
} satisfies Record<string, unknown[]>;

export type IconName = keyof typeof shapes;

export function Icon({ name, size = 16, className }: { name: IconName; size?: number; className?: string }) {
  return h(
    "svg",
    {
      className: className ? `carton-icon ${className}` : "carton-icon",
      width: size,
      height: size,
      viewBox: "0 0 24 24",
      fill: "none",
      stroke: "currentColor",
      strokeWidth: 1.6,
      strokeLinecap: "round",
      strokeLinejoin: "round",
      "aria-hidden": true,
      focusable: "false",
      "data-icon": name,
    },
    ...shapes[name],
  );
}
