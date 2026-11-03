// A stand-in for Cardboard's editor window (title bar, rail, Library, stage, timeline, chat), drawn from the real
// app's screenshots, so the panel, the title bar and the stage layer can be shown in place. 1522×810 CSS px.
const CLIPS = {
  Titles: [[2, 7, "Summer launch"], [12, 17, "Jane Smith, Founder"], [26, 31, "Meet the team"]],
  "Track 1": [[0, 5, "Intro"], [5, 12, "Interview A"], [12, 18, "Product close-up"], [18, 27, "Interview B"], [27, 31, "B-roll 3"], [31, 38, "Outro"]],
  Captions: [[0.5, 3, "we cut editing time"], [3.2, 6, "in half"], [26, 30, "built for speed"]],
  Music: [[0, 38, "Tone.mp3"]],
};
const COLOR = { Titles: "var(--t-text)", "Track 1": "var(--t-video)", Captions: "var(--t-caption)", Music: "var(--t-audio)" };
function titlebar({ chip = "", tabs = "Weekend reel", history = false, share = "", w = 1522 } = {}) {
  return `<div class="titlebar" style="width:${w}px">
    <span style="display:inline-flex;color:#fff;margin:0 6px 0 4px">${I("director", 18)}</span>
    <span class="tb-btn" style="color:#ffffff80">${I("grid")}Dashboard</span>
    <span style="width:1px;height:18px;background:#ffffff1a;margin:0 6px"></span>
    <span class="tb-btn on" style="padding-right:6px"><span style="width:18px;height:12px;border-radius:3px;background:linear-gradient(90deg,#f00,#0c0,#ff0,#00f)"></span>${tabs}<span style="color:#ffffff59;margin-left:10px">${I("x", 12)}</span></span>
    <span class="tb-btn" style="color:#ffffff59">${I("plus")}</span>
    <span style="flex:1"></span>
    ${chip}
    <span class="tb-chip" style="color:#ffffffb3">${I("aspect")}16:9${I("caret", 11)}</span>
    <span class="tb-chip" style="color:#ffffffb3"><span style="width:13px;height:13px;border-radius:9px;box-shadow:inset 0 0 0 1.6px #ffffffb3"></span>0</span>
    <span class="tb-btn${history ? " on" : ""}" title="Version history (Ctrl+Shift+H)">${I("versions", 16)}</span>
    ${share || `<span class="tb-btn">${I("users", 16)}</span>`}
    <span class="tb-btn">${I("bug", 16)}</span>
    <span class="export">Export <span>Ctrl+E</span></span>
    <span class="tb-btn">${I("panelR", 16)}</span>
  </div>`;
}
const cutChip = ({ cut = "Main cut", viewing = null, dot = null } = {}) => {
  const name = `${dot ? `<span class="cutdot" style="background:${dot}"></span>` : I("cut")}${cut}${I("caret", 11)}`;
  return viewing
    ? `<span class="tb-seg"><span class="s">${name}</span><span class="s view">${I("eye")}${viewing}<span style="display:inline-flex;margin-left:2px;opacity:.8" title="Back to my edit (Esc)">${I("x", 12)}</span></span></span>`
    : `<span class="tb-chip hov" style="box-shadow:inset 0 0 0 1px #ffffff14">${name}</span>`;
};
function timeline({ viewing = false, w = 754, h = 242, highlight = null, playhead = 13, moved = {}, label = "" } = {}) {
  const pps = (w - 140) / 38, top = 44;
  const tracks = Object.keys(CLIPS);
  return `<div class="timeline${viewing ? " viewing" : ""}" style="width:${w}px;height:${h}px">
    <div class="tl-tools"><span class="tnum">0:${String(playhead).padStart(2, "0")} / 0:38</span>${I("undo", 16, "dim")}<span style="flex:1"></span>${I("prev", 14)}${I("play", 14)}${I("next", 14)}<span style="flex:1"></span>${label}${I("search", 14)}<span style="width:110px;height:3px;background:#ffffff26;border-radius:3px"></span></div>
    ${tracks.map((t, i) => `<div class="tl-track" style="top:${top + i * 48}px;height:48px"><span class="tl-name">${t}</span>${CLIPS[t].map(([s0, e0, n]) => { const [s, e] = moved[n] ?? [s0, e0]; return `<span class="tl-clip" style="left:${120 + s * pps}px;width:${(e - s) * pps - 2}px;top:5px;height:38px;background:${COLOR[t]};${highlight === n ? "box-shadow:0 0 0 2px var(--sel)" : ""}">${n}</span>`; }).join("")}</div>`).join("")}
    <div style="position:absolute;top:${top - 4}px;bottom:0;left:${120 + playhead * pps}px;width:2px;background:#fff"></div>
  </div>`;
}
function library(w = 366) {
  const tile = (bg, name, d) => `<div style="width:150px"><div style="height:94px;border-radius:8px;background:${bg};position:relative"><span style="position:absolute;left:6px;bottom:6px;font-size:11px;background:#000a;padding:1px 5px;border-radius:4px;color:#fff">${d}</span></div><div style="font-size:12px;margin-top:6px;color:var(--fg1)">${name}</div></div>`;
  return `<div style="width:${w}px;background:#141414;display:flex">
    <div style="width:46px;display:flex;flex-direction:column;align-items:center;gap:20px;padding-top:16px;color:#ffffff80">${["film", "grid", "music", "cc", "text", "layers"].map((n) => I(n, 18)).join("")}</div>
    <div style="flex:1;padding:16px 14px">
      <div style="font-size:18px;font-weight:600;color:#fff;margin-bottom:14px">Library</div>
      <div class="input" style="background:#1d1d1d;margin-bottom:14px"><span class="ph">Search project media…</span></div>
      <div style="display:flex;flex-wrap:wrap;gap:12px">${tile("linear-gradient(135deg,#3b5b74,#18242e)", "interview-a.mp4", "1:24")}${tile("linear-gradient(135deg,#6b4d3a,#22160f)", "interview-b.mp4", "2:10")}${tile("linear-gradient(135deg,#355d3c,#122016)", "broll-03.mp4", "0:18")}${tile("linear-gradient(135deg,#5a3a66,#1d1222)", "product.mp4", "0:42")}</div>
    </div></div>`;
}
function chat(w = 430) {
  return `<div class="chat" style="width:${w}px;display:flex;flex-direction:column;border-left:1px solid #ffffff0a">
    <div style="height:40px;display:flex;align-items:center;padding:0 14px;gap:8px"><span class="tb-btn" style="background:#ffffff0f;color:#fff">New chat</span><span style="flex:1"></span>${I("restore", 16, "dim")}${I("plus", 16, "dim")}</div>
    <div style="flex:1;display:flex;flex-direction:column;justify-content:flex-end;padding:16px;gap:12px">
      <div style="align-self:flex-end;background:#262626;border-radius:12px;padding:8px 12px;color:var(--fg1);max-width:80%">Tighten the intro and add a lower third for Jane</div>
      <div style="color:var(--fg2);line-height:20px">Done. I trimmed the intro to end at 0:05, moved the title a second earlier, added a lower third “Jane Smith, Founder” at 0:12 and removed the third B-roll shot.</div>
    </div>
    <div style="margin:12px;height:120px;border-radius:12px;background:#1b1b1b;box-shadow:inset 0 0 0 1px #ffffff12;padding:12px;color:var(--fg4)">Describe the edit…</div>
  </div>`;
}
/** The whole window: Library and stage over a timeline as wide as both; the panel and the chat beside them. */
function editor({ chip = cutChip(), history = false, panelHtml = "", panelW = 384, stage = "", viewing = false, tl = {}, over = "", share = "" } = {}) {
  const W = 1522, H = 770, lib = 366, chatW = 384, topH = 528;
  const leftW = W - chatW - (panelHtml ? panelW : 0), stageW = leftW - lib;
  const vw = Math.min(stageW - 40, ((topH - 80) * 16) / 9), vh = (vw * 9) / 16;
  return `<div style="width:${W}px;height:${H + 40}px;position:relative;background:#0e0e0e;overflow:hidden">
    ${titlebar({ chip, history: !!panelHtml || history, share })}
    <div style="display:flex;height:${H}px">
      <div style="width:${leftW}px;display:flex;flex-direction:column">
        <div style="display:flex;height:${topH}px">
          ${library(lib)}
          <div class="stage${viewing ? " viewing" : ""}" style="width:${stageW}px;height:${topH}px">
            <div class="video" style="left:${(stageW - vw) / 2}px;top:${(topH - vh) / 2}px;width:${vw}px;height:${vh}px"></div>
            <div style="position:absolute;left:${(stageW - vw) / 2 + 18}px;top:${(topH - vh) / 2 + vh - 44}px;font:600 18px Geist;color:#fff;text-shadow:0 2px 8px #000">Summer launch</div>
            ${stage}
          </div>
        </div>
        ${timeline({ w: leftW, h: H - topH, viewing, ...tl })}
      </div>
      ${panelHtml ? `<div style="width:${panelW}px">${panelHtml}</div>` : ""}
      ${chat(chatW)}
    </div>
    ${over}
  </div>`;
}
