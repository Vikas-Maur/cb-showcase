// Benchmark page: scenarios the runner (bench/run.mjs) drives in headless Chromium, on React and on preact/compat.
// - list:  mount History with N versions, then scroll it; compare with rendering every row (no virtualization).
// - live:  a busy shared project (versions arriving in bursts, ghosts at 20 Hz, presence at 1 Hz): renders per
//          component, DOM mutations per region, frame times.
// - play:  Play all in the Changes view (PLAN 4.2): frame times, time spent in our per-frame work, renders during playback.
import { createElement as h } from "react";
import { createRoot } from "react-dom/client";
import { CartonProvider, ChangesView, ConflictList, CutsMenu, GhostLayer, HistoryPanel, PresenceAvatars, PublishedStatus, SyncStatusWords, UndoTurnButton, type Change, type CartonUi } from "../src/index.ts";
import { createMockUi, people } from "../src/mock.ts";
import { injectCardboardSkin } from "../src/skin/cardboard.ts";

declare const __CARTON_RUNTIME__: string;

injectCardboardSkin(document);
const runtime = typeof __CARTON_RUNTIME__ === "string" ? __CARTON_RUNTIME__ : "react";

// Renders per component. Preact calls options.__r once per component render. React has no public hook, so the bench
// build installs React DevTools' global hook (banner in bench/build.mjs) and counts the fibers flagged as having
// rendered in each commit. The bench is built with keepNames, so component names survive minification.
const renders: Record<string, number> = (window as unknown as { __renders: Record<string, number> }).__renders;
const bump = (name: string) => (renders[name] = (renders[name] ?? 0) + 1);
let hooked = false;
async function hookPreact() {
  if (runtime !== "preact" || hooked) return;
  hooked = true;
  const { options } = await import("preact");
  const o = options as unknown as Record<string, (v: { type: unknown }) => void>;
  const prev = o.__r;
  o.__r = (vnode) => {
    const t = vnode.type as { displayName?: string; name?: string } | string;
    if (typeof t === "function") {
      const n = t.displayName || t.name;
      if (n) bump(n);
    }
    prev?.(vnode);
  };
}

interface FrameStats {
  frames: number;
  p50: number;
  p95: number;
  p99: number;
  max: number;
  over20: number;
  over33: number;
}
function frameStats(deltas: number[]): FrameStats {
  const s = [...deltas].sort((a, b) => a - b);
  const q = (p: number) => (s.length ? s[Math.min(s.length - 1, Math.floor(p * s.length))]! : 0);
  return { frames: s.length, p50: q(0.5), p95: q(0.95), p99: q(0.99), max: s[s.length - 1] ?? 0, over20: s.filter((d) => d > 20).length, over33: s.filter((d) => d > 33.4).length };
}

/** Record rAF deltas, and the time each rAF callback spends (wrapping requestAnimationFrame). */
function recordFrames() {
  const deltas: number[] = [];
  const work: number[] = [];
  let last = 0, run = true;
  const tick = (t: number) => {
    if (!run) return;
    if (last) deltas.push(t - last);
    last = t;
    requestAnimationFrame(tick);
  };
  const raf = window.requestAnimationFrame.bind(window);
  window.requestAnimationFrame = (cb) =>
    raf((t) => {
      const s = performance.now();
      cb(t);
      work.push(performance.now() - s);
    });
  window.requestAnimationFrame(tick);
  return () => {
    run = false;
    window.requestAnimationFrame = raf;
    return { stats: frameStats(deltas), work: frameStats(work), workTotal: work.reduce((a, b) => a + b, 0) };
  };
}

const nextFrame = () => new Promise<number>((r) => requestAnimationFrame(r));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const root = document.getElementById("root")!;

/** The same row markup History uses, all of it, no virtualization: the baseline for the list. */
function FullList({ ui }: { ui: ReturnType<typeof createMockUi> }) {
  const n = ui.history().count("all");
  const out = [];
  for (let i = 0; i < n; i++) {
    const v = ui.history().at("all", i)!;
    out.push(h("div", { key: v.id, className: "carton-version", style: { height: 52 } }, h("span", { className: "carton-version-mark" }), h("div", { className: "carton-version-main" }, h("div", { className: "carton-version-title" }, v.name ?? v.summary), h("div", { className: "carton-version-meta" }, v.author.name))));
  }
  return h("div", { className: "carton-history", style: { height: 640, overflow: "auto" } }, out);
}

async function list(n: number, full: boolean) {
  const ui = createMockUi({ versions: n, seed: 1 });
  const holder = document.createElement("div");
  holder.setAttribute("data-carton-skin", "cardboard");
  holder.style.cssText = "width:380px;height:640px";
  root.appendChild(holder);
  await nextFrame();
  const t0 = performance.now();
  const r = createRoot(holder);
  r.render(h(CartonProvider, { ui }, full ? h(FullList, { ui }) : h(HistoryPanel, { initialHeight: 640 })));
  await nextFrame();
  const mountMs = performance.now() - t0; // render + commit + style + layout + first paint opportunity
  const domNodes = holder.querySelectorAll("*").length;
  const scroller = holder.querySelector(".carton-vlist") ?? holder.querySelector(".carton-history");
  const stop = recordFrames();
  const max = scroller!.scrollHeight - scroller!.clientHeight;
  for (let i = 1; i <= 240; i++) {
    scroller!.scrollTop = (max * i) / 240;
    await nextFrame();
  }
  const scroll = stop();
  const rowsInDom = holder.querySelectorAll(".carton-version").length;
  r.unmount();
  holder.remove();
  return { n: ui.history().count("all"), full, mountMs, domNodes, rowsInDom, scroll };
}

async function live(seconds: number, vps: number, burst: number) {
  await hookPreact();
  const ui = createMockUi({ versions: 10_000, seed: 2 });
  const holder = document.createElement("div");
  holder.setAttribute("data-carton-skin", "cardboard");
  root.appendChild(holder);
  const regions = ["history", "topbar", "ghosts", "conflicts", "published"] as const;
  const el: Record<string, HTMLElement> = {};
  const App = () =>
    h(
      CartonProvider,
      { ui },
      h("div", { id: "topbar", style: { display: "flex", gap: 8 } }, h(CutsMenu, {}), h(SyncStatusWords), h(PresenceAvatars), h(UndoTurnButton)),
      h("div", { id: "history", style: { width: 380, height: 640 } }, h(HistoryPanel, { initialHeight: 640 })),
      h("div", { id: "ghosts", style: { position: "relative", width: 900, height: 200 } }, h(GhostLayer, { timeToX: (t: number) => t * 20, trackBand: (id: string) => ({ top: id === "V1" ? 20 : 80, height: 40 }) })),
      h("div", { id: "conflicts", style: { width: 400 } }, h(ConflictList)),
      h("div", { id: "published", style: { width: 400 } }, h(PublishedStatus)),
    );
  createRoot(holder).render(h(App));
  await sleep(300);
  for (const r of regions) el[r] = holder.querySelector(`#${r}`)!;
  const mut: Record<string, number> = {};
  const mos = regions.map((r) => {
    mut[r] = 0;
    const mo = new MutationObserver((l) => (mut[r] += l.length));
    mo.observe(el[r]!, { subtree: true, childList: true, attributes: true, characterData: true });
    return mo;
  });
  for (const k of Object.keys(renders)) delete renders[k];
  const calls0 = new Map(ui.hub.calls);
  const stopFrames = recordFrames();
  const v0 = ui.history().count("all");
  const stopLive = ui.live({ versionsPerSecond: vps, burst, ghostHz: 20, presenceHz: 1 });
  await sleep(seconds * 1000);
  stopLive();
  await sleep(100);
  const frames = stopFrames();
  for (const mo of mos) mo.disconnect();
  const calls: Record<string, number> = {};
  for (const [t, n] of ui.hub.calls) calls[t] = n - (calls0.get(t) ?? 0);
  return { seconds, versionsAdded: ui.history().count("all") - v0, renders: { ...renders }, mutations: mut, topicCalls: calls, frames };
}

async function play(n: number, seconds: number) {
  await hookPreact();
  const ui = createMockUi({ versions: 10, seed: 3 });
  // `n` changes over the edit, two seconds apart, each its own clip: a range of a day's work (26) or of weeks (2000)
  const length = Math.max(38, n * 2 + 2);
  const list: Change[] = Array.from({ length: n }, (_, i) => ({ key: `timelineItems/c${i}`, text: `Trimmed “Clip ${i + 1}”, now ends at 0:${String((i * 2 + 2) % 60).padStart(2, "0")}`, kind: "change", clip: i % 5 ? "video" : "title", itemId: `c${i}`, at: i * 2, end: i * 2 + 1.5, author: i % 3 ? people.alice : people.terminal, when: Date.now() - (n - i) * 60_000 }));
  const fake = Object.assign(Object.create(ui), { changes: async () => list }) as CartonUi;
  const from = ui.history().all!()[2]!;
  const holder = document.createElement("div");
  holder.setAttribute("data-carton-skin", "cardboard");
  holder.style.cssText = "width:384px;height:640px;display:flex;flex-direction:column";
  root.appendChild(holder);
  let frameCalls = 0;
  // A host preview that draws every frame, like a real player would.
  const canvas = document.createElement("canvas");
  canvas.width = 640;
  canvas.height = 360;
  const ctx = canvas.getContext("2d")!;
  const onFrame = (t: number) => {
    frameCalls++;
    ctx.fillStyle = "#242";
    ctx.fillRect(0, 0, 640, 360);
    ctx.fillStyle = "#fff";
    ctx.fillText(t.toFixed(3), 20, 40);
  };
  createRoot(holder).render(h(CartonProvider, { ui: fake }, h(ChangesView, { from, onBack: () => {}, host: { onFrame, length: () => length } })));
  await sleep(300);
  for (const k of Object.keys(renders)) delete renders[k];
  const stop = recordFrames();
  (holder.querySelector(".carton-play-all .carton-btn") as HTMLButtonElement).click();
  await sleep(seconds * 1000);
  const playing = holder.querySelector(".carton-play-all .carton-btn")?.textContent;
  const frames = stop();
  return { changes: n, seconds, frameCalls, stillPlaying: playing === "Pause", renders: { ...renders }, frames };
}

/**
 * Carton UX v2 search (N2, DESIGN-V2 §2.3): History with N versions (landmarks on), a word typed a key at a time, as
 * the field gets it (the input's own setter, then "input"). Per key: the time the key's own work takes (to the next
 * frame), DOM mutations in the list and renders while typing. Then the last key to the results on screen, and the
 * mock's own find inside it (the engine's search is N0's: the panel's part is the rest, after the 90 ms wait).
 */
async function find(n: number, word: string) {
  await hookPreact();
  const ui = createMockUi({ versions: n, seed: 1, landmarks: true });
  let findMs = 0;
  const find0 = ui.find!.bind(ui);
  ui.find = async (q, o) => {
    const t = performance.now();
    const r = await find0(q, o);
    if (q) findMs += performance.now() - t;
    return r;
  };
  const holder = document.createElement("div");
  holder.setAttribute("data-carton-skin", "cardboard");
  holder.style.cssText = "width:384px;height:800px;display:flex;flex-direction:column";
  root.appendChild(holder);
  const r = createRoot(holder);
  r.render(h(CartonProvider, { ui }, h(HistoryPanel, { initialHeight: 700 })));
  await sleep(300);
  await nextFrame();
  const input = holder.querySelector(".carton-search-input") as HTMLInputElement;
  const list = holder.querySelector(".carton-history-list")!;
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  for (const k of Object.keys(renders)) delete renders[k];
  let muts = 0;
  const mo = new MutationObserver((l) => (muts += l.length));
  mo.observe(list, { subtree: true, childList: true, attributes: true, characterData: true });
  const keys: number[] = [];
  input.focus();
  for (let i = 1; i <= word.length; i++) {
    const t = performance.now();
    setter.call(input, word.slice(0, i));
    input.dispatchEvent(new Event("input", { bubbles: true }));
    await nextFrame();
    keys.push(performance.now() - t);
    await sleep(40); // a quick typist: 40 ms between keys, under the 90 ms wait
  }
  muts += mo.takeRecords().length;
  mo.disconnect();
  const typing = { keys, listMutations: muts, renders: { ...renders } };
  const t1 = performance.now();
  while (!holder.querySelector(".carton-find-count, .carton-find-empty")) await nextFrame();
  const toResults = performance.now() - t1;
  const rowsInDom = holder.querySelectorAll(".carton-version").length;
  const shown = holder.querySelector(".carton-find-count")?.textContent ?? "";
  // back to the whole list
  const t2 = performance.now();
  setter.call(input, "");
  input.dispatchEvent(new Event("input", { bubbles: true }));
  while (holder.querySelector(".carton-find-count")) await nextFrame();
  const toAll = performance.now() - t2;
  r.unmount();
  holder.remove();
  return { n: ui.history().count("all"), word, typing, toResults, findMs, rowsInDom, shown, toAll };
}

/** What the browser gives an empty page: the frame-rate ceiling every other number is read against. */
async function idle(seconds: number) {
  const stop = recordFrames();
  await sleep(seconds * 1000);
  return { seconds, frames: stop() };
}

(window as unknown as Record<string, unknown>).__bench = { list, live, play, idle, find, runtime };
(window as unknown as Record<string, unknown>).__benchReady = true;
