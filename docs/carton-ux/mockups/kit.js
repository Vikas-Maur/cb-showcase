// Small HTML builders shared by the mockups (static prototypes, not product code).
const I = (n, s, cls = "") => `<i data-i="${n}"${s ? ` data-s="${s}"` : ""} class="${cls}"></i>`;
const WHO = {
  you: { name: "You", cls: "you", ini: "V" },
  leo: { name: "Leo", cls: "leo", ini: "L" },
  mia: { name: "Mia", cls: "mia", ini: "M" },
  director: { name: "Director", agent: "director" },
  claude: { name: "Claude Code", agent: "claude" },
  codex: { name: "Codex", agent: "codex" },
  leoDirector: { name: "Leo's Director", agent: "director" },
};
const av = (w, sm = false, extra = "") => {
  const a = WHO[w];
  if (!a) return `<span class="av sys${sm ? " sm" : ""}"></span>`;
  return a.agent
    ? `<span class="av agent${sm ? " sm" : ""} ${extra}">${I(a.agent)}</span>`
    : `<span class="av ${a.cls}${sm ? " sm" : ""} ${extra}">${a.ini}</span>`;
};
const who = (w) => WHO[w]?.name ?? w;
/** A History row. */
const row = ({ w, title, meta = "", when = "", cls = "", whenCls = "", icon = "", more = false }) => `
  <div class="row ${cls}">
    <span class="av-wrap">${icon || av(w)}</span>
    <div class="t">${title}</div>
    <span class="when ${whenCls}">${when}</span>
    <div class="m">${meta}</div>
    ${more ? `<button class="btn icon more" style="background:#ffffff0f">${I("dots", 16)}</button>` : ""}
  </div>`;
const day = (label, n, collapsed = false) => `<div class="day">${I(collapsed ? "caretR" : "caret", 12)}<span>${label}</span><span class="sp"></span><span class="n">${n}</span></div>`;
const filterChip = (t) => `<div style="padding:0 12px 6px"><span class="pill" style="height:24px;padding:0 4px 0 9px;font-size:12px;gap:6px;color:var(--fg1)">${t}<button class="btn icon" style="width:18px;height:18px">${I("x", 11)}</button></span></div>`;
const head = (tab = "history", narrow = false) => `
  <div class="p-head">
    <span class="tab ${tab === "history" ? "on" : ""}">${I("versions")}${"History"}</span>
    <span class="tab ${tab === "comments" ? "on" : ""}">${I("comment")}${narrow && tab !== "comments" ? "" : "Comments"}</span>
    <span class="sp"></span>
    <button class="btn icon">${I("x", 16)}</button>
  </div>`;
const cutbar = ({ cut = "Main cut", right = "" } = {}) => `
  <div class="cutbar"><button class="cutbtn">${I("cut")}<span class="nm">${cut}</span>${I("caret", 12)}</button><span class="sp"></span>${right}</div>`;
const filterBtn = `<button class="btn icon" title="Show">${I("filter", 16)}</button>`;
const panel = (inner, h = 760) => `<div class="panel" style="height:${h}px">${inner}</div>`;
const shot = (name, w, h, inner, cap = "") => `<div><p class="cap">${name} · ${w}×${h}${cap ? " · " + cap : ""}</p><div class="shot" data-shot="${name}" style="width:${w}px;${h ? `height:${h}px` : ""}">${inner}</div></div>`;
/** One change: where in the edit, what kind of clip, what happened, who. A hovered or playing row shows its ▶. */
const chg = (tc, kind, badge, words, by = "", cls = "", bar = null) => `
  <div class="chg ${cls}"><span class="tc">${tc}</span><span class="kind ${kind}">${I({ v: "film", t: "text", a: "music", c: "cc", i: "film", g: "layers", p: "layers" }[kind])}${badge ? `<b class="b-${badge}">${{ add: "+", rem: "−", chg: "" }[badge]}</b>` : ""}</span>
  <span class="w">${words}${by ? `<span class="who">${by}</span>` : ""}</span><span class="pl">${/\b(hov|on)\b/.test(cls) ? `<button class="btn icon" title="Play this change" style="width:22px;height:22px;color:var(--fg1)">${I(cls.includes("on") ? "pause" : "play", 10)}</button>` : ""}</span>${bar != null ? `<span class="bar"><i style="width:${bar}%"></i></span>` : ""}</div>`;
/** The change map: the edit's length as a bar, a tick where each change is. ticks: [[pos%, kind, on]] */
const map = (ticks, ph = null, ends = ["0:00", "0:40"]) => `
  <div class="map"><span class="trk"></span>${ticks.map(([x, k, on]) => `<span class="tk k-${k}${on ? " on" : ""}" style="left:calc(${x}% - 2px)"></span>`).join("")}${ph != null ? `<span class="ph" style="left:calc(${ph}% - 1px)"></span>` : ""}</div>`;
function build(html) {
  document.body.innerHTML = `<div class="shots">${html}</div>`;
  iconize();
}
