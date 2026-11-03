// The capture page's states for Carton UX v2 N1, Compare in the editor (docs/carton-ux/v2/DESIGN-V2.md §1). Kept apart
// from entry.js (a few lines there use it), so other workstreams' rig states don't edit the same lines. Gallery code
// only: nothing here ships.
// - Stand-ins in Cardboard's own structure where Compare reads it: the stage (its padded stage div, the pan-and-zoom
//   wrapper, the picture), and the timeline (the scroll area, the tracks' scroll area, the tracks surface with one
//   [data-track-id] row per track, the track names' column, the toolbar's right-hand group). The clips are divs here
//   (Cardboard paints them on a canvas).
// - The second player: a stand-in picture of the left side (the app's is Cardboard's own preview engine).
// - The bridge's Compare half (renderer-bridge.js: hold, compareDoc, play, the playhead, the timeline's scale).
import { createElement as h, useEffect, useState } from "react";

const TRACKS = [
  { id: "t-titles", name: "Titles" },
  { id: "t-video", name: "Track 1" },
  { id: "t-captions", name: "Captions" },
  { id: "t-music", name: "Music" },
];
const item = (id, trackId, type, name, startTime, endTime, o = {}) => ({ id, trackId, type, name, startTime, endTime, trimStart: 0, trimEnd: 0, ...o });
// Your edit now (the right side): the mock's story timeline
const RIGHT = [
  item("item-intro", "t-video", "video", "Intro", 0, 5),
  item("item-summer", "t-titles", "text", "Summer launch", 1, 6),
  item("item-interview-a", "t-video", "video", "Interview A", 5, 12),
  item("item-jane", "t-titles", "text", "Jane Smith, Founder", 12, 17),
  item("item-drone", "t-video", "video", "Drone shot", 12, 16),
  item("item-interview-b", "t-video", "video", "Interview B", 16, 25),
  item("item-cap-1", "t-captions", "caption", "we cut editing time", 1, 3),
  item("item-cap-2", "t-captions", "caption", "in half", 3, 4.5),
  item("item-team", "t-titles", "text", "Meet the team", 26, 31),
  item("item-broll", "t-video", "video", "B-roll 3", 25, 29),
  item("item-outro", "t-video", "video", "Outro", 29, 36),
  item("item-built", "t-captions", "caption", "built for speed", 26, 28),
  item("item-music", "t-music", "audio", "Tone.mp3", 0, 36),
];
// “Sent to client” (the left side): the intro longer, the old title, B-roll pier where the drone shot is now, Interview
// B 4 s later, a caption since removed
const LEFT = [
  item("item-intro", "t-video", "video", "Intro", 0, 6),
  item("item-summer", "t-titles", "text", "Summer sale", 1, 6),
  item("item-interview-a", "t-video", "video", "Interview A", 6, 12),
  item("item-pier", "t-video", "video", "B-roll pier", 12, 15),
  item("item-interview-b", "t-video", "video", "Interview B", 20, 29),
  item("item-cap-1", "t-captions", "caption", "we cut costs", 1, 3),
  item("item-cap-2", "t-captions", "caption", "in a third", 3, 4.5),
  item("item-cap-old", "t-captions", "caption", "our new look", 7, 9),
  item("item-team", "t-titles", "text", "Meet the team", 30, 35),
  item("item-broll", "t-video", "video", "B-roll 3", 29, 33),
  item("item-outro", "t-video", "video", "Outro", 33, 40),
  item("item-built", "t-captions", "caption", "built for speed", 30, 32),
  item("item-music", "t-music", "audio", "Tone.mp3", 0, 40),
];
const doc = (items) => ({ tracks: TRACKS.map((t) => ({ id: t.id, name: t.name })), timelineItems: items, aspectRatio: "16:9", media: [] });
const chg = (key, clip, kind, text, s, e) => ({ key: `timelineItems/${key}`, itemId: key, clip, kind, text, at: s, end: e });
// The comparison's change rows, as core words them (the mockup's seven)
const CHANGES = [
  chg("item-intro", "video", "change", "Trimmed “Intro”, now ends at 0:05", 0, 5),
  chg("item-summer", "title", "change", "Changed title “Summer sale” to “Summer launch”", 1, 6),
  chg("item-cap-2", "caption", "change", "Changed caption to “in half”", 3, 4.5),
  chg("item-pier", "video", "remove", "Removed “B-roll pier”", 12, 15),
  chg("item-cap-old", "caption", "remove", "Removed caption “our new look”", 7, 9),
  chg("item-drone", "video", "add", "Added “Drone shot”", 12, 16),
  chg("item-interview-b", "video", "change", "Moved “Interview B” 4 s earlier", 16, 25),
];
// The shots both sides are made of (the video track), lined up: Intro, Interview A, [pier | drone], Interview B, B-roll 3, Outro
const shots = (list) => list.map(([start, end, label], i) => ({ start, end, sig: label.length * 31 + i, label }));
const SHOTDIFF = {
  a: shots([[0, 6, "Intro"], [6, 12, "Interview A"], [12, 15, "B-roll pier"], [15, 20, "Gap"], [20, 29, "Interview B"], [29, 33, "B-roll 3"], [33, 40, "Outro"]]),
  b: shots([[0, 5, "Intro"], [5, 12, "Interview A"], [12, 16, "Drone shot"], [16, 25, "Interview B"], [25, 29, "B-roll 3"], [29, 36, "Outro"]]),
  matches: [[1, 1], [4, 3], [5, 4], [6, 5]],
  aLabel: "Sent to client",
  bLabel: "Your edit",
};
// the two sides' “Interview A” share a signature (the diff's match): give matched shots the same sig
for (const [i, j] of SHOTDIFF.matches) SHOTDIFF.b[j] = { ...SHOTDIFF.b[j], sig: SHOTDIFF.a[i].sig };

const PPS = 20;

/** Add the scenarios to entry.js's table `S`, from its own builders. */
export function addN1(S, { ux, setCuts, CUTS, newest, people }) {
  const compare = (o = {}) => () => {
    const r = ux()();
    const ui = r.ui;
    const sent = ui.history().all().find((v) => v.name === "Sent to client");
    // the comparison's rows are the mockup's seven (the mock's between() would give the story's twenty)
    const changes = ui.changes.bind(ui);
    ui.changes = async (a, b) => (a === sent?.ref ? CHANGES : (o.cuts ? CHANGES.map((c) => ({ ...c, text: c.text.replace(/^Added “(.*)”$/, "Only in Main cut: “$1”").replace(/^Removed “(.*)”$/, "Only in the 30s cut: “$1”") })) : changes(a, b)));
    ui.shotDiff = async () => SHOTDIFF;
    return { ...r, n1: { from: o.cuts ? "cut-ig" : sent?.ref, mode: o.mode ?? "side", player: o.player !== false, agent: o.agent ?? null, open: o.open !== false }, panel: o.panel === undefined ? "history" : o.panel };
  };
  S["n1-side"] = compare();
  S["n1-wipe"] = compare({ mode: "wipe" });
  S["n1-flip"] = compare({ mode: "flip" });
  S["n1-flip-only"] = compare({ mode: "side", player: false });
  S["n1-cuts"] = compare({ cuts: true });
  S["n1-agent"] = compare({ open: false, agent: "idle" });
  S["n1-agent-offer"] = compare({ open: false, agent: "busy" });
  S["n1-drawer"] = compare({ panel: null });
  S["n1-entry"] = compare({ open: false });
}

/** The bridge's Compare half (renderer-bridge.js), on the page's fake bridge. */
export function n1Bridge(api, sc) {
  let t = 1.2, playing = false;
  const preview = api.preview.bind(api);
  // the worker's carton:event, for the agent's request (N0's OpenCompare)
  const evs = new Set(), onEvent = api.onEvent.bind(api);
  api.onEvent = (f) => { evs.add(f); const off = onEvent(f); return () => { evs.delete(f); off(); }; };
  api.fire = (ev) => { for (const f of [...evs]) f(ev); };
  const subs = new Set();
  const tell = () => { for (const f of [...subs]) f(); };
  Object.assign(api, {
    // your edit held: the stand-in stage shows it (as the base bridge's preview(null) tells it)
    hold(p) { window.__cap.held = (window.__cap.held ?? 0) + 1; return preview(p, null); },
    compareDoc: (_p, ref) => Promise.resolve(ref == null || ref === sc.ui.cuts().find((c) => c.current)?.head ? doc(RIGHT) : doc(sc.n1?.from === "cut-ig" ? LEFT.filter((i) => i.id !== "item-pier") : LEFT)),
    togglePlay() { playing = !playing; tell(); },
    pause() { if (playing) { playing = false; tell(); } },
    get playing() { return playing; },
    libraryAside(on) { document.documentElement.toggleAttribute("data-cap-lib-aside", !!on); },
    clock: () => t,
    timelineScale: () => ({ pps: PPS, tracks: TRACKS }),
    onTimeline(f) { subs.add(f); return () => subs.delete(f); },
    seek(x) { window.__cap.seekAt = x; t = x; tell(); },
  });
}

/**
 * Cardboard's stage in its own structure (EditorRoute: the padded stage div, its pan-and-zoom wrapper `absolute
 * inset-0`, the picture), the picture sized to the stage div's content box as Cardboard sizes it (a container query
 * here, its ResizeObserver there). `left`: the left side shown (a Flip, the previewed ref).
 */
export function N1Stage({ subscribe }) {
  const [ref, setRef] = useState(null);
  useEffect(() => subscribe(setRef), [subscribe]);
  const left = !!ref;
  return h("div", { className: "relative flex min-h-0 flex-1 items-center justify-center overflow-hidden p-6 cap-n1-stage" },
    h("div", { className: "absolute inset-0 flex items-center justify-center cap-n1-wrap", style: { width: "100%", height: "100%" } },
      h("div", { className: "cap-n1-pic", "data-left": left ? "" : undefined },
        h("span", { className: "cap-n1-sun" }),
        h("span", { className: "cap-n1-title" }, left ? "Summer sale" : "Summer launch"),
        h("span", { className: "cap-n1-cap" }, left ? "in a third" : "in half"))));
}

/** The second player's stand-in: the left side's picture (“Sent to client”), as Cardboard's engine would draw it. */
export function N1Player({ onReady }) {
  useEffect(() => { onReady?.(true); }, [onReady]);
  return h("div", { className: "cap-n1-pic cap-n1-fill", "data-left": "" },
    h("span", { className: "cap-n1-sun" }),
    h("span", { className: "cap-n1-title" }, "Summer sale"),
    h("span", { className: "cap-n1-cap" }, "in a third"));
}

/** Cardboard's timeline in its own structure, as Compare reads it (the marks' surface, the tracks' scroll area, the names). */
export function N1Timeline({ Wrap }) {
  const items = RIGHT;
  const rowH = 42;
  return h(Wrap, { className: "contents", "data-analytics-region": "editor-timeline" },
    h("div", { className: "cap-timeline cap-n1-timeline relative" },
      h("div", { className: "bg-timeline-track-bg" },
        h("div", { className: "cap-tl-toolbar flex items-center justify-between bg-[#141414]" },
          h("div", { className: "flex flex-1 items-center gap-2" }, h("span", { className: "cap-tl-time" }, "0:01 / 0:36")),
          h("div", { className: "flex flex-1 items-center justify-center" }, h("span", { className: "cap-tl-play" }, "▶")),
          h("div", { className: "flex flex-1 items-center justify-end gap-2" })),
        h("div", { className: "cap-n1-body" },
          h("div", { className: "no-scrollbar relative cap-n1-names", "data-vertical-scroll-region": "" },
            h("div", { className: "relative w-full" }, ...TRACKS.map((t) => h("div", { key: t.id, className: "cap-n1-name", style: { height: rowH } }, t.name)))),
          h("div", { className: "relative cap-n1-scroll", "data-timeline-scroll": "" },
            h("div", { id: "timeline-tracks-container", style: { width: 40 * PPS + 40 } },
              h("div", { className: "relative cap-n1-tracks", "data-tracks-content": "", "data-vertical-scroll-region": "" },
                h("div", { className: "relative", "data-timeline-canvas-surface": "", style: { height: TRACKS.length * rowH, width: 40 * PPS } },
                  ...TRACKS.map((t, i) => h("div", { key: t.id, "data-track-id": t.id, className: "absolute left-0 w-full", style: { top: i * rowH, height: rowH } })),
                  h("div", { className: "cap-n1-clips", "data-n1-clips": "" },
                    ...items.map((it) => h("span", { key: it.id, className: "cap-n1-clip", "data-type": it.type, style: { left: it.startTime * PPS, width: (it.endTime - it.startTime) * PPS - 2, top: TRACKS.findIndex((t) => t.id === it.trackId) * rowH + 4, height: rowH - 8 } }, it.name)),
                    h("span", { className: "cap-n1-playhead", style: { left: 1.2 * PPS } }))))))))));
}

export const N1_CSS = `
[data-cap-lib-aside] .cap-library{width:56px}
[data-cap-lib-aside] .cap-lib{display:none}
.cap-n1-stage{position:relative}
.cap-n1-wrap{container-type:size}
.cap-n1-pic{position:relative;aspect-ratio:16/9;width:min(100cqw,177.78cqh);border-radius:8px;overflow:hidden;background:radial-gradient(120% 90% at 30% 20%,#3d5f8f,#1b2b45 60%,#0e1626)}
.cap-n1-pic[data-left]{background:radial-gradient(120% 90% at 30% 20%,#405d84,#1d2a40 60%,#101827)}
.cap-n1-fill{width:100%;height:100%;border-radius:0}
.cap-n1-sun{position:absolute;left:58%;top:30%;width:16%;aspect-ratio:1;border-radius:50%;background:#ffffff22}
.cap-n1-title{position:absolute;left:6%;top:58%;padding:2px 8px;border-radius:4px;background:#0009;color:#fff;font:650 clamp(10px,4cqw,26px) Geist,system-ui;white-space:nowrap}
.cap-n1-cap{position:absolute;left:50%;bottom:8%;transform:translateX(-50%);padding:1px 6px;border-radius:3px;background:#000b;color:#fff;font:500 clamp(8px,2.4cqw,15px) Geist,system-ui;white-space:nowrap}
.carton-compare-pic>.cap-n1-pic{container-type:size}
.cap-n1-timeline{height:240px}
.cap-n1-body{display:flex;height:calc(100% - 46px)}
.cap-n1-names{flex:none;width:110px;overflow:hidden;background:#121212;border-right:1px solid #000}
.cap-n1-name{display:flex;align-items:center;padding:0 12px;font-size:12px;color:#bbb}
.cap-n1-scroll{flex:1;min-width:0;overflow:hidden}
.cap-n1-tracks{overflow:hidden}
.cap-n1-clips{position:absolute;inset:0}
.cap-n1-clip{position:absolute;border-radius:5px;padding:3px 6px;font:500 11px/14px Geist,system-ui;color:#fff;background:#3b5b8c;overflow:hidden;white-space:nowrap;box-sizing:border-box}
.cap-n1-clip[data-type=text]{background:#5b3fa8}
.cap-n1-clip[data-type=caption]{background:#4a3a6a}
.cap-n1-clip[data-type=audio]{background:#2c4a3a}
[data-carton-compare] .cap-n1-clip{filter:saturate(.35) brightness(.7)}
.cap-n1-playhead{position:absolute;top:0;bottom:0;width:2px;margin-left:-1px;background:#fff}
`;
