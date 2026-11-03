// The gallery: every component on mock data, framed like Cardboard's window, one section per screenshot.
// Built by gallery/build.mjs into dist/ (React and preact/compat bundles). Screenshots come from the capture rig
// (gallery/capture/, `npm run screens`), which shoots the app's own composition.
import { createElement as h, useEffect, useRef, useState, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import {
  CartonProvider,
  CompareCard,
  ConflictList,
  CreditsPopover,
  CutsMenu,
  FoldInDialog,
  GhostLayer,
  HistoryPanel,
  PresenceAvatars,
  PreviewBanner,
  PublishedStatus,
  SyncStatusWords,
  UndoTurnButton,
  WatchTheChanges,
} from "../src/index.ts";
import { createMockUi, makeShotDiff, type MockUi } from "../src/mock.ts";
import { injectCardboardSkin } from "../src/skin/cardboard.ts";

declare global {
  interface Window {
    __carton: { ui: MockUi; runtime: string; ready: boolean; stopLive?: () => void };
  }
}

injectCardboardSkin(document);
const params = new URLSearchParams(location.search);
const versions = Number(params.get("versions") ?? 12000);
const ui = createMockUi({ versions, seed: 7 });
window.__carton = { ui, runtime: (globalThis as { __CARTON_RUNTIME__?: string }).__CARTON_RUNTIME__ ?? "react", ready: false };

function Frame({ id, title, note, width, children, pad = true }: { id: string; title: string; note?: string; width?: number; children: ReactNode; pad?: boolean }) {
  return h(
    "section",
    { className: "g-section", id },
    h("div", { className: "g-caption" }, h("h2", null, title), note ? h("p", null, note) : null),
    h("div", { className: "g-frame", "data-shot": id, "data-carton-skin": "cardboard", style: { width, padding: pad ? 16 : 0 } }, children),
  );
}

/** A strip of Cardboard's top bar: where the Cuts menu, presence and sync words live. */
function TopBar() {
  return h(
    "div",
    { className: "g-topbar" },
    h("span", { className: "g-tab g-tab-dim" }, "▦  Dashboard"),
    h("span", { className: "g-tab" }, h("span", { className: "g-tab-thumb" }), "Weekend reel"),
    h("span", { className: "g-sep" }),
    h(CutsMenu, { onFoldIn: () => {} }),
    h(SyncStatusWords),
    h("span", { className: "g-flex" }),
    h(PresenceAvatars),
    h("span", { className: "g-ratio" }, "▭ 16:9"),
    h("button", { className: "g-export" }, "Export ", h("span", null, "Ctrl+E")),
  );
}

/** A timeline like Cardboard's, with ghosts of Bob's and his Director's drags over it. */
function TimelineWithGhosts() {
  const pps = 22, top = 34, row = 52, gap = 4;
  const tracks = [
    { id: "Titles", name: "Titles", color: "var(--timeline-color-text, #4f4096)", clips: [[2, 7, "Summer launch"], [24, 29, "Meet the team"]] },
    { id: "V1", name: "Track 1", color: "var(--timeline-color-video, #2680d9)", clips: [[0, 6, "Intro"], [6, 12, "Interview A"], [17, 24, "Product close-up"], [24, 33, "Interview B"]] },
    { id: "Captions", name: "Captions", color: "var(--timeline-color-caption, #5d4db3)", clips: [[0.5, 3, "we cut editing time"], [3.2, 6, "in half"], [26, 30, "built for speed"]] },
    { id: "Music", name: "Music", color: "var(--timeline-color-audio, #1c7054)", clips: [[0, 33, "Tone.mp3"]] },
  ] as const;
  const band = (id: string) => {
    const i = tracks.findIndex((t) => t.id === id);
    return i < 0 ? null : { top: top + i * (row + gap) + 6, height: row - 12 };
  };
  return h(
    "div",
    { className: "g-timeline" },
    h("div", { className: "g-ruler" }, ...[0, 5, 10, 15, 20, 25, 30].map((s) => h("span", { key: s, style: { left: 120 + s * pps } }, `${s}s`))),
    ...tracks.map((t, i) =>
      h(
        "div",
        { key: t.id, className: "g-track", style: { top: top + i * (row + gap), height: row } },
        h("span", { className: "g-track-name" }, t.name),
        ...t.clips.map(([s, e, n]) => h("span", { key: n, className: "g-clip", style: { left: 120 + s * pps, width: (e - s) * pps - 2, background: t.color } }, n)),
      ),
    ),
    h("div", { className: "g-playhead", style: { left: 120 + 13 * pps } }),
    h("div", { style: { position: "absolute", left: 120, top: 0, right: 0, bottom: 0, zIndex: 4 } }, h(GhostLayer, { timeToX: (t: number) => t * pps, trackBand: band })),
  );
}

/** A host preview for Watch the changes: a canvas redrawn every frame (what a real player does). */
function CanvasPreview({ register }: { register: (draw: (side: "a" | "b", t: number) => void) => void }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const c = ref.current!;
    const ctx = c.getContext("2d")!;
    const d = makeShotDiff(26);
    register((side, t) => {
      const shots = side === "a" ? d.a : d.b;
      const s = shots.find((x) => t >= x.start && t < x.end) ?? shots[shots.length - 1]!;
      const hue = (s.sig * 47) % 360;
      const g = ctx.createLinearGradient(0, 0, c.width, c.height);
      g.addColorStop(0, `hsl(${hue} 35% 30%)`);
      g.addColorStop(1, `hsl(${(hue + 40) % 360} 30% 12%)`);
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, c.width, c.height);
      // Something that moves every frame, so a dropped frame is visible.
      const x = ((t - s.start) / (s.end - s.start)) * c.width;
      ctx.fillStyle = "rgba(255,255,255,.12)";
      ctx.fillRect(x - 40, 0, 80, c.height);
      ctx.fillStyle = "rgba(255,255,255,.9)";
      ctx.font = "600 34px Geist, system-ui, sans-serif";
      ctx.fillText(s.label ?? "", 36, c.height - 64);
      ctx.font = "500 18px Geist Mono, monospace";
      ctx.fillStyle = side === "a" ? "#f4a3a3" : "#86efac";
      ctx.fillText(side === "a" ? "BEFORE" : "AFTER", 36, 52);
      ctx.fillStyle = "rgba(255,255,255,.7)";
      ctx.fillText(`${t.toFixed(2)} s`, c.width - 130, 52);
    });
  }, [register]);
  return h("canvas", { ref, width: 1280, height: 720, style: { width: "100%", height: "100%", display: "block" } });
}

function WatchSection({ current }: { current: string }) {
  const draw = useRef<((side: "a" | "b", t: number) => void) | null>(null);
  const [registered, setRegistered] = useState(false);
  return h(WatchTheChanges, {
    a: "main@11998",
    b: current,
    diff: makeShotDiff(26),
    onFrame: (s: "a" | "b", t: number) => draw.current?.(s, t),
    preview: h(CanvasPreview, {
      register: (fn) => {
        draw.current = fn;
        if (!registered) setRegistered(true);
      },
    }),
  });
}

function SyncStates() {
  const make = (s: Parameters<MockUi["setSync"]>[0]) => {
    const m = createMockUi({ versions: 4 });
    m.setSync(s);
    return m;
  };
  const [uis] = useState(() => [make({ kind: "syncing", waiting: 2 }), make({ kind: "upToDate" }), make({ kind: "offline", waiting: 3 })]);
  return h("div", { className: "g-row" }, ...uis.map((u, i) => h(CartonProvider, { key: i, ui: u }, h("div", { className: "g-chip" }, h(SyncStatusWords)))));
}

function App() {
  const current = ui.cuts().find((c) => c.current)!;
  return h(
    CartonProvider,
    { ui },
    h("header", { className: "g-head" }, h("h1", null, "@carton/react · gallery"), h("p", null, `Mock data · ${versions.toLocaleString()} versions · runtime: ${window.__carton.runtime}`)),
    h(Frame, { id: "topbar", title: "Top bar: Cuts menu, sync status, live presence", width: 1180, pad: false }, h(TopBar)),
    h(
      "div",
      { className: "g-grid" },
      h(Frame, { id: "history", title: "History", note: "Virtualized: 12,004 versions, newest first.", width: 380, pad: false }, h("div", { style: { height: 640 } }, h(HistoryPanel, { currentRef: current.head, onWatch: () => {} }))),
      h(
        "div",
        { className: "g-col" },
        h(Frame, { id: "cuts", title: "Cuts menu", width: 420 }, h("div", { className: "g-cuts", style: { height: 330 } }, h(CutsMenu, { onFoldIn: () => {} }))),
        h(Frame, { id: "conflicts", title: "Conflict cards", width: 420 }, h(ConflictList)),
      ),
      h(
        "div",
        { className: "g-col" },
        h(Frame, { id: "compare", title: "Compare card", width: 400 }, h(CompareCard, { a: "main@11998", b: current.head, onWatch: () => {}, onRestore: () => {} })),
        h(Frame, { id: "credits", title: "Credits", width: 400 }, h(CreditsPopover, { itemId: "item-broll" })),
        h(Frame, { id: "status", title: "Undo turn · Published cut · Sync words", width: 400 }, h("div", { className: "g-stack" }, h(UndoTurnButton), h(PublishedStatus, { onOpen: () => {} }), h(SyncStates))),
      ),
    ),
    h(Frame, { id: "presence", title: "Live presence and ghosts of remote drags", note: "People with their agents and subagents; Bob and his Director are dragging clips.", width: 1180 }, h("div", { className: "g-stack" }, h(PresenceAvatars, { max: 6 }), h(TimelineWithGhosts))),
    h(Frame, { id: "fold", title: "Fold in, with partial accept", width: 1180, pad: false }, h("div", { className: "g-dialog-host" }, h(FoldInDialog, { fromCutId: "cut-ig", intoCutId: "cut-main", onClose: () => {} }))),
    h(Frame, { id: "watch", title: "Watch the changes", note: "Aligned like a text diff; Play changes; aligned A/B; read-only preview.", width: 1180 }, h(WatchSection, { current: current.head })),
    h(Frame, { id: "preview", title: "Read-only preview banner", width: 760 }, h(PreviewProbe)),
  );
}

function PreviewProbe() {
  const [local] = useState(() => {
    const m = createMockUi({ versions: 4 });
    m.openPreview("main@11998", "Sent to client, Monday");
    m.blockEdit();
    return m;
  });
  return h(CartonProvider, { ui: local }, h(PreviewBanner));
}

createRoot(document.getElementById("root")!).render(h(App));
setTimeout(() => (window.__carton.ready = true), 300);
