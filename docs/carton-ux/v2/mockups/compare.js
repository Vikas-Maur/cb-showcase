// Compare in the editor: the stage takes two players (or a wipe, or a flip), Cardboard's own timeline carries the marks,
// and History shrinks to the change list. Static prototypes only. Uses ../../mockups/{icons,kit,story,editor}.js.
Object.assign(ICONS, {
  compare: '<path d="M4 8h14M14 4l4 4-4 4"/><path d="M20 16H6M10 12l-4 4 4 4"/>',
  side: '<rect x="3" y="6" width="8" height="12" rx="1.5"/><rect x="13" y="6" width="8" height="12" rx="1.5"/>',
  wipe: '<rect x="3.5" y="5.5" width="17" height="13" rx="2"/><path d="M12 3v18"/>',
  flip: '<rect x="3.5" y="5.5" width="13" height="10" rx="2"/><path d="M7.5 18.5h13v-10"/>',
  sparkle: '<path d="M12 3.5v4M12 16.5v4M3.5 12h4M16.5 12h4M6 6l2.5 2.5M15.5 15.5 18 18M6 18l2.5-2.5M15.5 8.5 18 6"/>',
  clip: '<rect x="4" y="7" width="16" height="10" rx="2"/><path d="M8 7v10M16 7v10"/>',
});
const SENT = "“Sent to client”", SENT_WHEN = "yesterday at 4:10 pm";
const CUT30 = "“30s Instagram cut”", DOT30 = "#f59e0b";

// The version you're comparing with (A, left) and your edit (B, right). Your edit is always the right side when it's in
// the comparison; otherwise the older version is on the left.
const STORY = {
  // B: your edit now (0:36). [start, end, name, mark]: mark = add | chg | null; tag is the clip's small label.
  b: {
    Titles: [[1, 5, "Summer launch", "chg", "•"], [18, 23, "Jane Smith, Founder"], [26, 30, "Meet the team"]],
    "Track 1": [[0, 5, "Intro", "chg", "", { oldEnd: 6 }], [5, 12, "Interview A"], [12, 16, "Drone shot", "add", "+"], [16, 25, "Interview B", "chg", "←4 s"], [25, 29, "B-roll 3"], [29, 36, "Outro"]],
    Captions: [[0.5, 3, "we cut editing time"], [3.2, 5, "in half", "chg", "•"], [26, 29, "built for speed"]],
    Music: [[0, 36, "Tone.mp3"]],
  },
  ghosts: { Captions: [[7, 10.5, "our new look"]] }, // removed where a gap was left: a ghost of its size
  seams: { "Track 1": [[5, "B-roll pier"]] }, // removed with the rest moved up: a seam where it was
  // A: "Sent to client", its own time (0:40), main track only, for the strip above the timeline.
  a: [[0, 6, "Intro"], [6, 9, "B-roll pier", "rem"], [9, 16, "Interview A"], [16, 20, "Product close-up"], [20, 29, "Interview B"], [29, 33, "B-roll 3"], [33, 40, "Outro"]],
};
const CHANGES = [
  ["0:00", "v", "chg", "Trimmed “Intro”, now ends at 0:05"],
  ["0:01", "t", "chg", "Changed title “Summer sale” to “Summer launch”"],
  ["0:03", "c", "chg", "Changed caption to “in half”"],
  ["0:05", "v", "rem", "Removed “B-roll pier”"],
  ["0:07", "c", "rem", "Removed caption “our new look”"],
  ["0:12", "v", "add", "Added “Drone shot”"],
  ["0:16", "v", "chg", "Moved “Interview B” 4 s earlier"],
];
// Across two cuts the sentences say where a clip is, not what someone did.
const CUT_CHANGES = [
  ["0:00", "v", "chg", "“Intro” ends at 0:05 here, 0:03 in the 30s cut"],
  ["0:05", "v", "add", "Only in Main cut: “Interview A”"],
  ["0:12", "v", "add", "Only in Main cut: “Drone shot”"],
  ["0:16", "v", "chg", "“Interview B” is 6 s shorter in the 30s cut"],
  ["0:18", "t", "add", "Only in Main cut: “Jane Smith, Founder”"],
  ["0:25", "v", "rem", "Only in the 30s cut: “Logo sting”"],
  ["0:29", "v", "add", "Only in Main cut: “Outro”"],
];

/** A stand-in frame: a soft scene with a title and a caption, so two sides can differ visibly. */
const scene = ({ w, h, title = "Summer launch", cap = "in half", hue = 214, sh = 0 }) => `
  <div class="scene" style="background:radial-gradient(120% 90% at ${30 + sh}% 20%,hsl(${hue} 38% 42%),hsl(${hue + 10} 35% 16%) 70%),#111">
    <div style="position:absolute;left:0;right:0;bottom:0;height:42%;background:linear-gradient(180deg,transparent,hsl(${hue + 20} 30% 9% / .9))"></div>
    <div style="position:absolute;left:${58 + sh / 2}%;top:34%;width:${w * 0.16}px;height:${w * 0.16}px;border-radius:50%;background:hsl(${hue - 20} 45% 70% / .35);filter:blur(2px)"></div>
    ${title ? `<span class="ttl" style="left:${w * 0.06}px;top:${h * 0.56}px;font-size:${Math.max(11, w * 0.042)}px">${title}</span>` : ""}
    ${cap ? `<span class="cap" style="bottom:${h * 0.07}px;font-size:${Math.max(9, w * 0.026)}px">${cap}</span>` : ""}
  </div>`;
const slate = (what, side) => `<div class="slate">${I("clip", 18)}<span><b>${what}</b> isn't in ${side}</span><span style="font-size:11.5px;color:var(--fg4)">Its shot plays on the other side</span></div>`;
const player = ({ x, y, w, label, sub = "", tc = "", pic, on = false }) => {
  const h = (w * 9) / 16;
  return `<div class="player${on ? " on" : ""}" style="left:${x}px;top:${y}px;width:${w}px">
    <div class="pic" style="height:${h}px">${pic(w, h)}</div>
    <div class="lbl">${label}${sub ? `<span class="dim">· ${sub}</span>` : ""}<span class="tc">${tc}</span></div></div>`;
};
// Narrow stage (under 600 px): the modes keep their icons and drop their words (tooltips keep them), Side by side is
// greyed with its reason, the count goes (the list has it) and "Done comparing" shortens to "Done".
const modes = (mode, { only = false, narrow = false } = {}) => only
  ? `<span class="seg"><span class="on">${I("flip", 13)}Flip</span></span>`
  : `<span class="seg"><span class="${mode === "side" ? "on" : ""}${narrow ? " dis" : ""}" title="${narrow ? "Side by side needs a wider stage. Close the chat or widen the window." : "Side by side"}">${I("side", 13)}${narrow ? "" : "Side by side"}</span><span class="${mode === "wipe" ? "on" : ""}" title="Wipe">${I("wipe", 13)}${narrow ? "" : "Wipe"}</span><span class="${mode === "flip" ? "on" : ""}" title="Flip (hold B)">${I("flip", 13)}Flip</span></span>`;
const cmpbar = (mode, opts = {}) => `<div class="cmpbar">${modes(mode, opts)}<span class="sp"></span>${opts.narrow ? "" : `<span class="dim" style="font-size:12px">${opts.count ?? "7 changes"}</span>`}<button class="btn sm sec" title="Done comparing (Esc)">${opts.narrow ? "Done" : "Done comparing"}</button></div>`;
const transport = (y, { playing = false, prog = 8, step = true } = {}) => `<div class="cmptransport" style="top:${y}px">
  <button class="btn xs sec" style="height:26px">${I(playing ? "pause" : "play", 11)}${playing ? "Pause" : "Play both"}</button>
  <span class="prog"><i style="width:${prog}%"></i></span>
  ${step ? `<span title="Both sides play the same shot together. A shot that's longer on one side waits for the other." style="display:inline-flex;align-items:center;gap:4px">In step by shot${I("info", 12)}</span>` : ""}</div>`;

/** The stage while comparing. mode: side | wipe | flip. */
function cmpStage({ mode = "side", stageW, topH, a, b, playing = false, prog = 8, only = false, narrow = false, flipShows = "b", count, extra = "" }) {
  let body = "";
  if (mode === "side") {
    const gap = 14, pw = (stageW - gap * 3) / 2, ph = (pw * 9) / 16, y = Math.max(52, (topH - ph - 26 - 40) / 2 + 8);
    body = player({ x: gap, y, w: pw, ...a }) + player({ x: gap * 2 + pw, y, w: pw, ...b, on: true }) + transport(y + ph + 34, { playing, prog });
  } else {
    const vw = Math.min(stageW - 40, ((topH - 44 - 92) * 16) / 9), vh = (vw * 9) / 16, x = (stageW - vw) / 2, y = 52;
    if (mode === "wipe") {
      const at = 0.56;
      body = `<div class="player" style="left:${x}px;top:${y}px;width:${vw}px"><div class="pic" style="height:${vh}px">
        <div style="position:absolute;inset:0;clip-path:inset(0 ${100 - at * 100}% 0 0)">${a.pic(vw, vh)}</div>
        <div style="position:absolute;inset:0;clip-path:inset(0 0 0 ${at * 100}%)">${b.pic(vw, vh)}</div>
        <span class="wipe-line" style="left:${at * vw - 1}px"></span><span class="wipe-knob" style="left:${at * vw}px">${I("compare", 15)}</span>
        <span class="tag" style="left:8px;top:8px">${a.label}</span><span class="tag" style="right:8px;top:8px">${b.label}</span>
      </div><div class="lbl"><span class="dim">Drag the line, or ← →, to wipe between them</span><span class="tc">${b.tc}</span></div></div>` + transport(y + vh + 34, { playing, prog });
    } else {
      const s = flipShows === "a" ? a : b;
      body = `<div class="player${flipShows === "a" ? "" : " on"}" style="left:${x}px;top:${y}px;width:${vw}px"><div class="pic" style="height:${vh}px">${s.pic(vw, vh)}
        <span class="tag" style="left:8px;top:8px;${flipShows === "a" ? "background:#8ab4ffd9;color:#0b1730;font-weight:600" : ""}">${flipShows === "a" ? "Showing " : ""}${s.label}${s.sub ? `<span class="w" style="${flipShows === "a" ? "color:#0b1730b3" : ""}">${s.sub}</span>` : ""}</span>
      </div><div class="lbl" style="gap:8px"><span class="seg" style="height:24px"><span class="${flipShows === "a" ? "on" : ""}" style="height:20px">${a.short ?? a.label}</span><span class="${flipShows === "b" ? "on" : ""}" style="height:20px">${b.short ?? b.label}</span></span>${narrow ? "" : `<span class="dim">Hold <span style="color:var(--fg2)">B</span> to flip, or click</span>`}<span class="tc">${narrow ? s.tc.replace(/ ·.*/, "") : s.tc}</span></div></div>` + transport(y + vh + 34, { playing, prog });
    }
  }
  return cmpbar(mode, { only, narrow, count }) + body + extra;
}

/** Cardboard's timeline with Compare's marks, and a thin strip of the other version on top. */
function cmpTimeline({ w, h = 242, playhead = 1, aPlayhead = 1.2, sel = "Summer launch", aName = "Sent to client", story = STORY, legend = true, end = 36 }) {
  const pps = (w - 140) / (end + 2), top = 70, x0 = 120;
  const tracks = Object.keys(story.b);
  const X = (s) => x0 + s * pps;
  const clips = (t, i) => story.b[t].map(([s, e, n, mk, tag, o]) => {
    const old = o?.oldEnd ? `<span class="trimold" style="left:${X(e) - 1}px;width:${(o.oldEnd - e) * pps}px;top:${top + i * 42 + 5}px;height:32px"></span>` : "";
    return old + `<span class="tl-clip${mk ? ` mk mk-${mk}` : ""}${sel === n ? " mk-sel" : ""}" style="left:${X(s)}px;width:${(e - s) * pps - 2}px;top:${top + i * 42 + 5}px;height:32px;background:${COLOR[t]}">${n}${tag ? `<span class="mtag${mk === "add" ? " add" : ""}">${tag}</span>` : ""}</span>`;
  }).join("");
  const ghosts = tracks.map((t, i) => (story.ghosts[t] ?? []).map(([s, e, n]) => `<span class="tl-ghost" style="left:${X(s)}px;width:${(e - s) * pps - 2}px;top:${top + i * 42 + 5}px;height:32px">${n}</span>`).join("") +
    (story.seams[t] ?? []).map(([s, n]) => `<span class="tl-seam" title="Removed “${n}” here" style="left:${X(s) - 1}px;top:${top + i * 42 + 1}px;height:40px"><span>−</span></span>`).join("")).join("");
  const strip = `<div class="astrip" style="top:44px"><span class="nm">${aName}</span>${story.a.map(([s, e, n, k]) => `<span class="c${k ? " " + k : ""}" title="${n}" style="left:${X(s)}px;width:${(e - s) * pps - 2}px"></span>`).join("")}<span class="ph" style="left:${X(aPlayhead)}px"></span></div>`;
  return `<div class="timeline viewing cmp" style="width:${w}px;height:${h}px">
    <div class="tl-tools"><span class="tnum">0:${String(Math.floor(playhead)).padStart(2, "0")} / 0:${end}</span>${I("undo", 16, "dim")}<span style="flex:1"></span>${I("prev", 14)}${I("play", 14)}${I("next", 14)}<span style="flex:1"></span>
    ${legend ? `<span class="legend"><span><i style="box-shadow:inset 0 0 0 2px var(--ok)"></i>added</span><span><i style="border:1.5px dashed var(--danger)"></i>removed</span><span><i style="box-shadow:inset 0 0 0 2px var(--warn)"></i>changed or moved</span></span>` : ""}</div>
    ${strip}
    ${tracks.map((t, i) => `<div class="tl-track" style="top:${top + i * 42}px;height:42px"><span class="tl-name" style="top:13px">${t}</span></div>`).join("")}
    ${ghosts}${tracks.map(clips).join("")}
    <div style="position:absolute;top:${top - 4}px;bottom:0;left:${X(playhead)}px;width:2px;background:#fff"></div>
  </div>`;
}

/** History, shrunk to the change list. sel: the index of the selected change; open: its detail. */
function cmpPanel({ w = 384, h = 770, sel = 1, open = true, rows = CHANGES, range, count = "7 changes · 0:36", foot, detail, tabs = true }) {
  const rng = range ?? `From <b>${SENT}</b> · ${SENT_WHEN}<br>to <b>your edit now</b>`;
  const det = detail ?? `<div class="chgx"><div class="tn"><span>Then</span><span>“Summer sale”</span><span>Now</span><span>“Summer launch”</span></div>
      <div style="display:flex;gap:6px;flex-wrap:wrap"><button class="btn xs sec">${I("restore", 12)}Bring back “Summer sale”</button></div>
      <div class="hint" style="margin-top:6px;font-size:11.5px">Only this title changes. Ctrl+Z takes it back.</div></div>`;
  const list = rows.map(([tc, k, b, t], i) => chg(tc, k, b, t, "", i === sel ? "sel" : "") + (i === sel && open ? det : "")).join("");
  return panel((tabs ? head() : "") + `
    <div class="cmphead"><button class="btn xs ghost" style="margin-left:-8px;color:var(--fg2)" title="Done comparing (Esc)">${I("arrowLeft", 13)}History</button>
      <div class="rng">${rng}</div><div class="n">${count}</div></div>
    <div class="clist">${list}</div>
    <div class="cmpfoot">${foot ?? `<button class="btn sm ghost" style="justify-content:flex-start;margin-left:-8px">${I("restore", 14)}Restore your edit to ${SENT}…</button>`}</div>`, h);
}

const sideA = (o = {}) => ({ label: `<b>Sent to client</b>`, short: "Sent to client", sub: SENT_WHEN, tc: "0:01", pic: (w, h) => scene({ w, h, title: "Summer sale", cap: "in a third" }), ...o });
const sideB = (o = {}) => ({ label: `<b>Your edit now</b>`, short: "Your edit now", tc: "0:01 · same shot", pic: (w, h) => scene({ w, h, title: "Summer launch", cap: "in half" }), ...o });
const cmpChip = (label = `Comparing ${SENT} with your edit`, cut = {}) => cutChip({ ...cut, viewing: "__CMP__" }).replace(`${I("eye")}__CMP__`, `${I("compare")}${label}`);

/** The whole window while comparing. The Library steps aside for the stage; the chat stays. */
function cmpEditor({ W = 1522, H = 810, panelW = 384, chatW = 384, chip = cmpChip(), stage = {}, tl = {}, panelHtml, chatHtml, over = "", stageExtra = "", drawerTab = "", barTop = 0 } = {}) {
  const body = H - 40, topH = Math.round(body * 0.686), rail = 46;
  const leftW = W - chatW - panelW, stageW = leftW - rail;
  const a = stage.a ?? sideA(), b = stage.b ?? sideB();
  return `<div style="width:${W}px;height:${H}px;position:relative;background:#0e0e0e;overflow:hidden">
    ${titlebar({ chip, history: panelW > 0, w: W })}
    <div style="display:flex;height:${body}px">
      <div style="width:${leftW}px;display:flex;flex-direction:column">
        <div style="display:flex;height:${topH}px">
          <div style="width:${rail}px;background:#141414;display:flex;flex-direction:column;align-items:center;gap:20px;padding-top:16px;color:#ffffff59">${["film", "grid", "music", "cc", "text", "layers"].map((n) => I(n, 18)).join("")}</div>
          <div class="stage viewing" style="width:${stageW}px;height:${topH}px">${cmpStage({ stageW, topH, a, b, ...stage }).replace('<div class="cmpbar">', `<div class="cmpbar" style="top:${barTop}px">`)}${drawerTab}${stageExtra}</div>
        </div>
        ${cmpTimeline({ w: leftW, h: body - topH, ...tl })}
      </div>
      ${panelW ? `<div style="width:${panelW}px">${panelHtml ?? cmpPanel({ w: panelW, h: body })}</div>` : ""}
      ${chatW ? (chatHtml ?? chat(chatW)) : ""}
    </div>${over}</div>`;
}
const stageToast = (html, bottom = 14) => `<div style="position:absolute;left:12px;right:12px;bottom:${bottom}px;display:flex;justify-content:center;pointer-events:none"><div class="toast" style="white-space:normal;max-width:100%">${html}</div></div>`;
