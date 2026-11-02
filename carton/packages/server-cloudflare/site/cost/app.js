// The /cost/ page: loads data.json (the lab's measurements and Cloudflare's prices, built by build-data.mjs), runs
// model.js for the chosen settings and draws the bill, the Free-plan check, the chart, and the limits, speeds, inputs
// and glossary sections. Every text from data goes in with textContent. Tooltips: a "?" (or a status badge) is a
// button described by its bubble (aria-describedby); it opens on hover, keyboard focus or a tap, closes on Esc, and is
// placed inside the window.
import * as M from "./model.js";
import * as T from "./text.js";

// ------------------------------------------------------------------------------------------------ DOM helpers
function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs ?? {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k === "class") el.className = v;
    else if (k === "style") el.setAttribute("style", v);
    else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else if (k === "text") el.textContent = v;
    else el.setAttribute(k, v === true ? "" : String(v));
  }
  for (const kid of kids.flat(Infinity)) if (kid !== null && kid !== undefined && kid !== false) el.append(kid instanceof Node ? kid : String(kid));
  return el;
}
const SVG = "http://www.w3.org/2000/svg";
function s(tag, attrs, ...kids) {
  const el = document.createElementNS(SVG, tag);
  for (const [k, v] of Object.entries(attrs ?? {})) if (v !== undefined && v !== null) el.setAttribute(k, String(v));
  for (const kid of kids.flat()) if (kid !== null && kid !== undefined) el.append(kid instanceof Node ? kid : String(kid));
  return el;
}

// ------------------------------------------------------------------------------------------------ formatting
const money = (x) => {
  if (!Number.isFinite(x)) return "–";
  if (x === 0) return "$0";
  if (x < 0.01) return "<$0.01";
  if (x < 1000) return `$${x.toFixed(2)}`;
  return `$${Math.round(x).toLocaleString("en-US")}`;
};
const axisMoney = (x) => (x >= 1e6 ? `$${x / 1e6}M` : x >= 1e3 ? `$${x / 1e3}k` : x >= 1 ? `$${x}` : `$${x.toFixed(2)}`);
const moneyPer = (x) => (x > 0 && x < 1 ? (x < 0.001 ? "<$0.001" : `$${x.toFixed(3)}`) : money(x));
const count = (x) => {
  if (!Number.isFinite(x)) return "–";
  const a = Math.abs(x);
  if (a === 0) return "0";
  if (a < 10) return x.toLocaleString("en-US", { maximumFractionDigits: 2 });
  if (a < 1e4) return Math.round(x).toLocaleString("en-US");
  if (a < 1e6) return `${(x / 1e3).toFixed(a < 1e5 ? 1 : 0)}k`;
  if (a < 1e9) return `${(x / 1e6).toFixed(a < 1e7 ? 2 : 1)}M`;
  return `${(x / 1e9).toFixed(a < 1e10 ? 2 : 1)}B`;
};
const teamsWord = (x) => (x === Infinity ? "any number of teams" : `${x.toLocaleString("en-US")} team${x === 1 ? "" : "s"}`);
const dur = (ms) => {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return "–";
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)} s`;
  const m = Math.floor(ms / 60_000);
  const sec = Math.round((ms % 60_000) / 1000);
  return `${m} min${sec ? ` ${sec} s` : ""}`;
};
const pct = (x) => `${(x * 100).toFixed(x < 0.1 && x > 0 ? 1 : 0)}%`;
const sigNum = (x) => (x === 0 ? "0" : Math.abs(x) < 0.01 ? x.toPrecision(2) : x.toLocaleString("en-US", { maximumFractionDigits: Math.abs(x) < 10 ? 3 : 0 }));

// ------------------------------------------------------------------------------------------------ tooltips
let tipSeq = 0;
let open = null; // { trigger, bubble, pinned }

/** Makes `trigger` open `text` as a tooltip; the bubble goes right after it, described by aria-describedby. */
function withTip(trigger, text) {
  const id = `tip${++tipSeq}`;
  const bubble = h("span", { class: "bubble", role: "tooltip", id, hidden: true });
  if (text instanceof Node) bubble.append(text);
  else bubble.textContent = text;
  trigger.setAttribute("aria-describedby", id);
  trigger.setAttribute("aria-expanded", "false");
  trigger.dataset.tip = id;
  const frag = h("span", { class: "tipwrap" }, trigger, bubble);
  return frag;
}
/** A "?" button explaining `name`. */
function q(text, name) {
  return withTip(h("button", { type: "button", class: "tip", "aria-label": `What is ${name}?` }, "?"), text);
}
/** A status badge that explains itself. */
function badge(status, extra) {
  const st = T.STATUS[status] ?? T.STATUS.missing;
  const b = h("button", { type: "button", class: `badge ${T.STATUS[status] ? status : "missing"}` }, h("i", { "aria-hidden": "true" }), st.label);
  return withTip(b, extra ? `${st.tip} ${extra}` : st.tip);
}

function place(trigger, bubble) {
  bubble.hidden = false;
  bubble.style.left = "0px";
  bubble.style.top = "0px";
  const r = trigger.getBoundingClientRect();
  const b = bubble.getBoundingClientRect();
  const vw = document.documentElement.clientWidth;
  const vh = window.innerHeight;
  const m = 8;
  let left = r.left + r.width / 2 - b.width / 2;
  left = Math.max(m, Math.min(left, vw - b.width - m));
  let top = r.bottom + 8;
  if (top + b.height > vh - m && r.top - 8 - b.height >= m) top = r.top - 8 - b.height;
  top = Math.max(m, Math.min(top, vh - b.height - m));
  bubble.style.left = `${Math.round(left)}px`;
  bubble.style.top = `${Math.round(top)}px`;
}
function show(trigger, pinned = false) {
  const bubble = document.getElementById(trigger.dataset.tip);
  if (!bubble) return;
  if (open && open.trigger !== trigger) hide();
  open = { trigger, bubble, pinned: pinned || open?.pinned === true && open.trigger === trigger };
  trigger.setAttribute("aria-expanded", "true");
  place(trigger, bubble);
}
function hide() {
  if (!open) return;
  open.bubble.hidden = true;
  open.trigger.setAttribute("aria-expanded", "false");
  open = null;
}
const triggerOf = (el) => el?.closest?.("[data-tip]");
document.addEventListener("pointerover", (e) => {
  if (e.pointerType !== "mouse") return;
  const t = triggerOf(e.target);
  if (t && !(open?.pinned && open.trigger !== t)) show(t, false);
});
document.addEventListener("pointerout", (e) => {
  if (e.pointerType !== "mouse" || !open || open.pinned) return;
  const to = e.relatedTarget;
  if (to && (open.trigger.contains(to) || open.bubble.contains(to))) return;
  if (triggerOf(e.target) === open.trigger || open.bubble.contains(e.target)) hide();
});
document.addEventListener("focusin", (e) => {
  const t = triggerOf(e.target);
  if (t) show(t, false);
  else if (open && !open.bubble.contains(e.target)) hide();
});
document.addEventListener("focusout", (e) => {
  if (!open || open.pinned) return;
  if (triggerOf(e.target) === open.trigger && !open.bubble.contains(e.relatedTarget)) hide();
});
document.addEventListener("click", (e) => {
  const t = triggerOf(e.target);
  if (t) {
    // a tap or click pins it open (a second one closes it)
    if (open?.trigger === t && open.pinned) hide();
    else show(t, true);
    return;
  }
  if (open && !open.bubble.contains(e.target)) hide();
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && open) {
    const t = open.trigger;
    hide();
    if (document.activeElement !== t && t.isConnected) t.focus({ preventScroll: true });
  }
});
let raf = 0;
const follow = () => {
  if (raf) return;
  raf = requestAnimationFrame(() => {
    raf = 0;
    if (!open) return;
    if (!open.trigger.isConnected) return hide();
    const r = open.trigger.getBoundingClientRect();
    if (r.bottom < 0 || r.top > window.innerHeight) return hide();
    place(open.trigger, open.bubble);
  });
};
window.addEventListener("scroll", follow, { passive: true, capture: true });
window.addEventListener("resize", follow);

// ------------------------------------------------------------------------------------------------ state
const COLORS = ["var(--s1)", "var(--s2)", "var(--s3)", "var(--s4)", "var(--s5)", "var(--s6)", "var(--s7)", "var(--s8)"];
// labels inside a filled part: near-black on the light fills, white otherwise (dark palette, dataviz palette.md)
const DARK_LABEL = new Set(["var(--s4)"]);
const ACT_COLOR = Object.fromEntries(M.ACTIVITIES.map((a, i) => [a.key, COLORS[i]]));

let DATA = null; // data.json
let INPUTS = {}; // key → { value, status, … } as given
let settings = { ...M.DEFAULT_SETTINGS, ...M.PRESETS.team5.settings };
let preset = "team5";
let speedFilter = { storage: "r2", network: "all" };

// ------------------------------------------------------------------------------------------------ settings form
const FIELDS = [
  { legend: "Team", fields: [
    { key: "people", label: "People per team", min: 1, max: 500, step: 1 },
    { key: "teams", label: "Teams", min: 1, max: 1_000_000, step: 1 },
  ] },
  { legend: "Editing", fields: [
    { key: "days", label: "Editing days a month", min: 1, max: 31, step: 1 },
    { key: "hoursPerDay", label: "Editing hours a day", min: 0, max: 24, step: 0.5, unit: "h" },
    { key: "idleHoursPerDay", label: "Open but idle, hours a day", min: 0, max: 24, step: 0.5, unit: "h" },
    { key: "savesPerMinute", label: "Saves a minute", min: 0, max: 60, step: 0.5 },
    { key: "agentEditsPerDay", label: "Agent edits per person a day", min: 0, max: 100_000, step: 10 },
    { key: "dragShare", label: "Share of time dragging", min: 0, max: 100, step: 1, unit: "%", percent: true },
    { key: "connectsPerDay", label: "Connects a day", min: 0, max: 1000, step: 1 },
  ] },
  { legend: "Media", fields: [
    { key: "footageHoursPerMonth", label: "Footage per person a month", min: 0, max: 10_000, step: 1, unit: "h" },
    { key: "previewMbps", label: "Preview quality", type: "select", options: Object.entries(M.PREVIEW_QUALITY).map(([k, v]) => [v, `${k} · ${v} Mbit/s`]) },
    { key: "shareOriginals", label: "Share camera originals", type: "check" },
    { key: "originalMbps", label: "Originals' bitrate", min: 1, max: 5000, step: 10, unit: "Mbit/s", when: (st) => st.shareOriginals },
    { key: "retentionMonths", label: "Keep media for", min: 0, max: 120, step: 1, unit: "months" },
    { key: "viewShare", label: "Teammates' footage each plays", min: 0, max: 100, step: 5, unit: "%", percent: true },
    { key: "segmentSeconds", label: "Preview segment length", min: 1, max: 30, step: 1, unit: "s" },
  ] },
  { legend: "Where it runs", fields: [
    { key: "storage", label: "Media storage", type: "segs", options: [["r2", "R2"], ["vault", "Vault (no R2)"]] },
    { key: "plan", label: "Workers plan", type: "segs", options: [["free", "Free"], ["paid", "Paid ($5)"]] },
  ] },
];

function settingsPanel() {
  const form = h("form", { class: "card settings", "aria-label": "Usage settings", onsubmit: (e) => e.preventDefault() });
  for (const g of FIELDS) {
    const fs = h("fieldset", {}, h("legend", { text: g.legend }));
    for (const f of g.fields) {
      const id = `f-${f.key}`;
      const label = h("div", { class: "fl" }, h("label", { for: f.type === "segs" ? undefined : id, id: `${id}-l`, text: f.label }), q(T.SETTINGS[f.key] ?? "", f.label.toLowerCase()));
      let control;
      if (f.type === "select") {
        control = h("select", { id, onchange: (e) => set(f.key, Number(e.target.value)) }, f.options.map(([v, l]) => h("option", { value: v, text: l })));
      } else if (f.type === "check") {
        control = h("input", { id, type: "checkbox", onchange: (e) => set(f.key, e.target.checked) });
      } else if (f.type === "segs") {
        control = h("div", { class: "segs", role: "radiogroup", "aria-labelledby": `${id}-l`, id },
          f.options.map(([v, l]) => h("button", { type: "button", class: "seg", role: "radio", "data-v": v, "aria-checked": "false", onclick: () => set(f.key, v), onkeydown: segKeys }, l)));
      } else {
        const input = h("input", { id, type: "number", inputmode: "decimal", min: f.min, max: f.max, step: f.step, onchange: (e) => numChange(f, e.target), oninput: (e) => numChange(f, e.target, true) });
        control = f.unit ? h("div", { class: "unit" }, input, h("span", { "aria-hidden": "true", text: f.unit })) : input;
      }
      fs.append(h("div", { class: `field${f.type === "segs" ? " stack" : ""}`, "data-key": f.key }, label, control));
    }
    form.append(fs);
  }
  form.append(h("p", { class: "assumed" }, badge("assumed"), h("span", { text: "Every setting here is an assumption: change it to match how you work." })));
  return form;
}
function segKeys(e) {
  if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(e.key)) return;
  e.preventDefault();
  const btns = [...e.currentTarget.parentElement.querySelectorAll(".seg")];
  const i = btns.indexOf(e.currentTarget);
  const next = btns[(i + (e.key === "ArrowLeft" || e.key === "ArrowUp" ? btns.length - 1 : 1)) % btns.length];
  next.focus();
  next.click();
}
function numChange(f, el, typing = false) {
  if (el.value === "") return;
  let v = Number(el.value);
  if (!Number.isFinite(v)) return;
  if (typing && (v < f.min || v > f.max)) return; // wait for the person to finish typing
  v = Math.max(f.min, Math.min(f.max, v));
  set(f.key, f.percent ? v / 100 : v, typing);
}
function set(key, value, typing = false) {
  settings = M.normalizeSettings({ ...settings, [key]: value });
  preset = null;
  syncForm(typing ? key : null);
  render();
}
function syncForm(skipKey) {
  for (const g of FIELDS)
    for (const f of g.fields) {
      const row = document.querySelector(`.field[data-key="${f.key}"]`);
      if (!row) continue;
      row.hidden = f.when ? !f.when(settings) : false;
      const el = document.getElementById(`f-${f.key}`);
      const v = settings[f.key];
      if (f.type === "check") el.checked = !!v;
      else if (f.type === "segs") for (const b of el.querySelectorAll(".seg")) {
        const on = b.dataset.v === v;
        b.setAttribute("aria-checked", String(on));
        b.tabIndex = on ? 0 : -1;
      }
      else if (f.type === "select") {
        if (![...el.options].some((o) => Number(o.value) === v)) el.append(h("option", { value: v, text: `${v} Mbit/s` }));
        el.value = String(v);
      } else if (f.key !== skipKey) el.value = String(f.percent ? Math.round(v * 1000) / 10 : v);
    }
  for (const b of document.querySelectorAll(".presets .chip")) b.setAttribute("aria-pressed", String(b.dataset.preset === preset));
}
function applyPreset(key) {
  // a preset sets the usage profile; the storage choice stays as the person set it
  settings = M.normalizeSettings({ ...M.DEFAULT_SETTINGS, ...M.PRESETS[key].settings, storage: settings.storage });
  preset = key;
  syncForm();
  render();
}

// ------------------------------------------------------------------------------------------------ results
const results = h("div", { class: "results" });
// one short announcement per change for screen readers, instead of the whole results panel
const live = h("p", { class: "sr", "aria-live": "polite" });
const chartCard = h("div", { class: "card" });

function render() {
  if (!DATA) return;
  const r = M.compute(settings, INPUTS, DATA.prices);
  results.replaceChildren(totalCard(r), h("div", { class: "two" }, freeCard(r), driverCard(r)), billCard(r), metersCard(r));
  live.textContent = `${money(r.total)} a month, ${moneyPer(r.perUser)} per user. ${r.free.fits ? "Fits Workers Free." : "Doesn't fit Workers Free."}`;
  renderChart();
  renderLimitsAtSettings(r);
}

function totalCard(r) {
  const plan = r.plan === "paid" ? "Workers Paid" : "Workers Free";
  const blocked = r.plan === "free" && !r.free.fits;
  const head = h("h3", {}, "Your monthly bill", q("Everything Cloudflare would charge for a month at these settings: the plan fee, then each kind of use past what's included. Media storage is the steady state, once media has been kept for the months you chose.", "the monthly bill"));
  const planline = h("p", { class: "planline" }, `${plan}, media in ${r.settings.storage === "r2" ? "R2" : "the vault"}`, q(T.SETTINGS.plan, "the plan"));
  if (blocked) {
    // past a Free limit requests fail, so there's no Free price to show: say so, and what Paid would cost
    const paid = M.bill({ ...r.settings, plan: "paid" }, INPUTS, DATA.prices);
    return h("div", { class: "card" }, head,
      h("div", { class: "total" },
        h("div", { class: "big", text: "Doesn't fit Free" }),
        h("div", { class: "per" }, "On Workers Paid: ", h("b", { class: "num", text: `${money(paid.total)} a month` }), " · ", h("span", { class: "num", text: `${moneyPer(paid.perUser)} per user` }))),
      planline,
      h("p", { class: "alert" }, h("b", { text: "Workers Free can't run this. " }), r.suggestion.text.replace(/^Workers Free can't run this: /, "").replace(/ On Workers Paid it would cost .*$/, ""), " ",
        h("button", { type: "button", class: "chip", style: "margin-top:8px", onclick: () => set("plan", "paid") }, "Show it on Workers Paid")),
      h("p", { class: "note", text: `On Free, nothing bills past a limit: requests fail until midnight UTC. The lines below are what Free would charge (R2 only) on the days it holds.` }));
  }
  return h("div", { class: "card" }, head,
    h("div", { class: "total" },
      h("div", { class: "big num", text: money(r.total) }),
      h("div", { class: "per" }, h("b", { class: "num", text: moneyPer(r.perUser) }), " per active user a month · ", h("span", { class: "num", text: `${r.people.toLocaleString("en-US")} people` }))),
    planline);
}

function freeCard(r) {
  const fc = r.free;
  const verdict = fc.fits ? "yes" : "no";
  const card = h("div", { class: "card" },
    h("h3", {}, "Fits Workers Free?", q("Workers Free's limits are per day for the whole account (storage: 5 GB in total). Each is checked against an average editing day at these settings. Past a limit, requests fail until midnight UTC; nothing is ever billed.", "fitting Workers Free")),
    h("div", { class: `verdict ${verdict}` }, h("span", { class: "ico", "aria-hidden": "true", text: fc.fits ? "✓" : "✕" }), fc.fits ? "Yes" : "No"));
  let line;
  if (fc.cpu.over) line = `A request here needs more than ${fc.cpu.limit} ms of CPU (${fc.cpu.worst.what}), so Workers Free stops it at any scale.`;
  else if (!fc.first) line = "No Free limit is reached at any number of teams.";
  else if (fc.fits) line = `Up to ${teamsWord(fc.maxTeams)} like this. The first limit to go is ${fc.first.name}, at ${teamsWord(fc.first.breaksAt)}: from there you'd need Workers Paid.`;
  else if (fc.maxTeams > 0) line = `The first limit to go is ${fc.first.name}, at ${teamsWord(fc.first.breaksAt)}; you have ${teamsWord(r.settings.teams)}. You'd need Workers Paid.`;
  else line = `The first limit to go is ${fc.first.name}, already at 1 team. You'd need Workers Paid.`;
  card.append(h("p", { class: "small", style: "margin:0;color:var(--text)", text: line }));
  const list = h("ul", { class: "checks" });
  for (const c of fc.sorted) {
    const ratio = c.limit > 0 ? c.used / c.limit : 0;
    const unit = c.key === "doStorageGB" ? " GB" : c.key === "doGBs" ? " GB-s" : "";
    list.append(h("li", {},
      h("div", { class: "row" },
        h("span", { class: "name" }, c.name, q(T.FREE_CHECKS[c.key] ?? "", c.name.toLowerCase())),
        h("span", { class: "num muted", text: `${count(c.used)}${unit} of ${count(c.limit)}${unit}` })),
      h("div", { class: `meter ${ratio > 1 ? "over" : ratio > 0.8 ? "warn" : ""}`, role: "meter", "aria-valuemin": "0", "aria-valuemax": String(c.limit), "aria-valuenow": String(Math.min(c.used, c.limit)), "aria-label": `${c.name}: ${pct(ratio)} of the Free limit` },
        h("i", { style: `width:${Math.min(100, ratio * 100).toFixed(1)}%` }))));
  }
  if (fc.cpu.worst) list.append(h("li", {}, h("div", { class: "row" },
    h("span", { class: "name" }, "CPU per request (10 ms)", q(T.FREE_CHECKS.cpu, "the CPU limit")),
    h("span", { class: "num muted", text: `${sigNum(fc.cpu.worst.ms)} ms at most (${fc.cpu.worst.what})` }))));
  card.append(list);
  return card;
}

function driverCard(r) {
  const card = h("div", { class: "card driver" }, h("h3", {}, "Biggest cost, and how to lower it", q("The line costing the most this month, and one concrete change, priced by running the same model again with it.", "the biggest cost")));
  if (r.plan === "free" && !r.free.fits) {
    card.append(h("p", { text: r.suggestion.text }));
    return card;
  }
  const d = r.driver;
  if (!d) {
    card.append(h("p", { text: "Nothing bills at this scale: everything is inside the free amounts." }));
    return card;
  }
  card.append(h("p", {}, h("b", { style: "color:#fff", text: d.name }), ` · ${money(d.cost)} a month, ${pct(r.total ? d.cost / r.total : 0)} of the bill.`));
  if (r.suggestion.text) {
    card.append(h("p", { style: "margin-top:8px", text: r.suggestion.text }));
    if (r.suggestion.saving > 0) card.append(h("p", { class: "save num", text: `Saves ${money(r.suggestion.saving)} a month → ${money(r.suggestion.newTotal)}` }));
  }
  return card;
}

function billCard(r) {
  const lines = r.lines;
  const total = r.total;
  const card = h("div", { class: "card" }, h("h3", {}, "The bill, line by line", q("What the money is for. Each Cloudflare meter's cost is split between the lines in proportion to how much of it each one uses.", "the bill's lines")));
  // the segmented bar: one whole split into parts, labels inside only where they fit
  const bar = h("div", { class: `bar${total > 0 ? "" : " empty"}`, role: "group", "aria-label": `The bill split by what it's for, ${money(total)} in all` });
  const shown = lines.filter((l) => l.cost > 0);
  for (const l of shown) {
    const share = l.cost / total;
    const color = ACT_COLOR[l.key];
    const part = h("button", { type: "button", class: `part${DARK_LABEL.has(color) ? " dark" : ""}`, style: `flex:1 1 0;background:${color}`, "aria-label": `${l.name}: ${money(l.cost)}, ${pct(share)}` });
    part.append(h("span", { text: pct(share) }));
    const w = withTip(part, `${l.name}: ${money(l.cost)} a month, ${pct(share)} of the bill.`);
    w.style.cssText = `display:flex;flex:${share} 1 0;min-width:2px`;
    bar.append(w);
  }
  card.append(bar);
  card.append(h("ul", { class: "legend", "aria-label": "Legend" }, shown.map((l) => h("li", {}, h("span", { class: "sw", style: `background:${ACT_COLOR[l.key]}` }), l.name))));
  requestAnimationFrame(() => {
    // a label that doesn't fit its part is dropped (the tooltip and the table keep the value)
    for (const p of bar.querySelectorAll(".part")) {
      const sp = p.querySelector("span");
      if (sp && sp.scrollWidth + 10 > p.clientWidth) sp.remove();
    }
  });

  const tbody = h("tbody");
  for (const l of lines) {
    const meters = Object.entries(l.byMeter).filter(([, c]) => c > 0.0005).sort((a, b) => b[1] - a[1]);
    const sub = meters.length ? meters.map(([k, c]) => `${M.METERS.find((m) => m.key === k).name} ${money(c)}`).join(" · ") : l.key === "fee" ? (r.plan === "paid" ? "Once per account" : "Workers Free: no fee") : "Inside the free amounts";
    tbody.append(h("tr", {},
      h("td", { class: "first", "data-label": "Line" }, h("span", { class: "cellname" }, h("span", { class: "sw", style: `background:${ACT_COLOR[l.key]}` }), l.name, q(T.LINES[l.key], l.name.toLowerCase())), h("span", { class: "sub", text: sub })),
      h("td", { class: "r num", "data-label": "Cost", text: money(l.cost) }),
      h("td", { class: "r num", "data-label": "Share", text: total > 0 ? pct(l.cost / total) : "–" })));
  }
  card.append(h("div", {}, h("table", { class: "tbl rt" },
    h("thead", {}, h("tr", {}, h("th", { text: "Line" }), h("th", { class: "r", text: "A month" }), h("th", { class: "r", text: "Share" }))),
    tbody,
    h("tfoot", {}, h("tr", {}, h("td", { class: "first", "data-label": "", text: "Total" }), h("td", { class: "r num", "data-label": "Total", text: money(total) }), h("td", { class: "r num", "data-label": "Per user", text: `${moneyPer(r.perUser)} / user` }))))));
  return card;
}

function metersCard(r) {
  const paid = r.plan === "paid";
  const tbody = h("tbody");
  for (const m of r.meters) {
    const ws = m.key === "doReq" && m.wsMessages ? (paid ? `incl. ${count(m.wsMessages)} WebSocket messages billed 20:1` : `incl. ${count(m.wsMessages)} WebSocket messages`) : "";
    const inc = m.included === null ? (m.product === "r2" ? "" : "not billed on Free") : `${count(m.included)} included`;
    tbody.append(h("tr", {},
      h("td", { class: "first", "data-label": "Meter" }, h("span", { class: "cellname" }, m.name, q(T.METERS[m.key], m.name.toLowerCase())), ws ? h("span", { class: "sub", text: ws }) : null),
      h("td", { class: "r num", "data-label": "Used" }, `${count(m.used)} `, h("span", { class: "muted small", text: m.unit })),
      h("td", { class: "r num muted", "data-label": "Included", text: inc }),
      h("td", { class: "r num", "data-label": "Cost", text: money(m.cost) })));
  }
  return h("details", { class: "card" },
    h("summary", { style: "cursor:pointer;font-weight:600;font-size:15px;color:#fff" }, "Cloudflare's meters (the bill as Cloudflare counts it)"),
    h("p", { class: "note", text: `Totals for ${r.settings.teams.toLocaleString("en-US")} team${r.settings.teams === 1 ? "" : "s"} for a month. ${paid ? "Workers Paid: Workers and Durable Objects bill past the included amounts." : "Workers Free: Workers and Durable Objects never bill; past a daily limit, requests fail."} R2 bills past its own free amounts on either plan.` }),
    h("div", {}, h("table", { class: "tbl rt" },
      h("thead", {}, h("tr", {}, h("th", { text: "Meter" }), h("th", { class: "r", text: "Used a month" }), h("th", { class: "r", text: "Included" }), h("th", { class: "r", text: "Cost" }))),
      tbody)));
}

// ------------------------------------------------------------------------------------------------ chart
const SERIES_STYLE = {
  "r2-paid": { name: "R2, Workers Paid", color: "var(--s1)", dash: false },
  "vault-paid": { name: "Vault, Workers Paid", color: "var(--s2)", dash: false },
  "r2-free": { name: "R2, Workers Free", color: "var(--s1)", dash: true },
  "vault-free": { name: "Vault, Workers Free", color: "var(--s2)", dash: true },
};
let chartState = null;

function renderChart() {
  const series = M.curve(settings, INPUTS, DATA.prices);
  const box = chartCard.querySelector(".chartbox");
  chartState = { series, steps: series[0].points.map((p) => p.teams) };
  drawChart(box, chartState);
  const tb = chartCard.querySelector("tbody.curve");
  tb.replaceChildren(...chartState.steps.map((t, i) => h("tr", {},
    h("td", { class: "first num", "data-label": "Teams", text: t.toLocaleString("en-US") }),
    series.map((sr) => h("td", { class: "r num", "data-label": SERIES_STYLE[sr.key].name, text: sr.points[i].total === null ? "doesn't fit" : money(sr.points[i].total) })))));
  const notes = chartCard.querySelector(".chartnotes");
  notes.replaceChildren(...series.filter((x) => x.plan === "free").map((x) => h("li", {}, h("span", { class: `lk dash`, style: `border-color:${SERIES_STYLE[x.key].color}` }),
    x.maxTeams === Infinity ? `${SERIES_STYLE[x.key].name}: fits at every count shown.` : x.maxTeams === 0 ? `${SERIES_STYLE[x.key].name}: doesn't fit even 1 team.` : `${SERIES_STYLE[x.key].name}: fits up to ${teamsWord(x.maxTeams)}.`)));
}

function chartCardInit() {
  chartCard.append(
    h("h3", {}, T.CHART.title, q(T.CHART.tip, "this chart")),
    h("ul", { class: "legend", style: "margin-bottom:8px" }, Object.entries(SERIES_STYLE).map(([, st]) => h("li", {}, h("span", { class: `lk${st.dash ? " dash" : ""}`, style: `border-color:${st.color}` }), st.name))),
    h("div", { class: "chartbox", tabindex: "0", role: "img", "aria-label": "Monthly cost against number of teams. Use the left and right arrow keys to read each point; the table below has every number." }),
    h("ul", { class: "legend chartnotes", style: "margin-top:8px" }),
    h("details", { class: "numbers" }, h("summary", { text: "Show the numbers" }),
      h("table", { class: "tbl rt", style: "margin-top:8px" },
        h("thead", {}, h("tr", {}, h("th", { text: "Teams" }), Object.values(SERIES_STYLE).map((st) => h("th", { class: "r", text: st.name })))),
        h("tbody", { class: "curve" }))));
  const box = chartCard.querySelector(".chartbox");
  new ResizeObserver(() => chartState && drawChart(box, chartState)).observe(box);
}

function drawChart(box, st) {
  const W = Math.max(280, box.clientWidth || 600);
  const narrow = W < 560;
  const H = narrow ? 260 : 320;
  const m = { l: narrow ? 48 : 60, r: narrow ? 12 : 24, t: 12, b: 40 };
  const vals = st.series.flatMap((x) => x.points.map((p) => p.total)).filter((v) => v !== null);
  const pos = vals.filter((v) => v > 0);
  const hasZero = vals.some((v) => v === 0);
  const lo = Math.floor(Math.log10(Math.max(0.01, Math.min(...pos, 1))));
  const hi = Math.ceil(Math.log10(Math.max(...pos, 10)));
  const band = hasZero ? 26 : 0;
  const plotB = H - m.b - band;
  const x = (t) => m.l + ((Math.log10(t) - Math.log10(st.steps[0])) / (Math.log10(st.steps.at(-1)) - Math.log10(st.steps[0]))) * (W - m.l - m.r);
  const y = (v) => (v === 0 ? H - m.b - 6 : m.t + ((hi - Math.log10(v)) / (hi - lo)) * (plotB - m.t));
  const svg = s("svg", { width: W, height: H, viewBox: `0 0 ${W} ${H}`, "aria-hidden": "true" });
  // grid and axes
  for (let e = lo; e <= hi; e++) {
    const yy = y(10 ** e);
    svg.append(s("line", { x1: m.l, x2: W - m.r, y1: yy, y2: yy, stroke: "var(--grid)", "stroke-width": 1 }));
    svg.append(s("text", { x: m.l - 8, y: yy + 4, "text-anchor": "end", fill: "var(--axis)", "font-size": 11 }, axisMoney(10 ** e)));
  }
  if (hasZero) svg.append(s("text", { x: m.l - 8, y: H - m.b - 2, "text-anchor": "end", fill: "var(--axis)", "font-size": 11 }, "$0"));
  svg.append(s("line", { x1: m.l, x2: W - m.r, y1: H - m.b, y2: H - m.b, stroke: "var(--base)", "stroke-width": 1 }));
  for (const t of st.steps) {
    if (!/^1/.test(String(t))) continue;
    const xx = x(t);
    svg.append(s("line", { x1: xx, x2: xx, y1: H - m.b, y2: H - m.b + 4, stroke: "var(--base)" }));
    svg.append(s("text", { x: xx, y: H - m.b + 18, "text-anchor": "middle", fill: "var(--axis)", "font-size": 11 }, t >= 1000 ? `${t / 1000}k` : String(t)));
  }
  svg.append(s("text", { x: (m.l + W - m.r) / 2, y: H - 4, "text-anchor": "middle", fill: "var(--axis)", "font-size": 11 }, "teams (log scale)"));
  // where you are
  const you = Math.min(Math.max(settings.teams, st.steps[0]), st.steps.at(-1));
  svg.append(s("line", { x1: x(you), x2: x(you), y1: m.t, y2: H - m.b, stroke: "rgba(255,255,255,.35)", "stroke-width": 1 }));
  svg.append(s("text", { x: x(you) + (x(you) > W - 90 ? -6 : 6), y: m.t + 12, "text-anchor": x(you) > W - 90 ? "end" : "start", fill: "var(--ink-2)", "font-size": 11 }, `you: ${settings.teams.toLocaleString("en-US")}`));
  // lines: Paid under Free so the dashed Free line stays visible where they meet
  for (const key of ["vault-paid", "r2-paid", "vault-free", "r2-free"]) {
    const sr = st.series.find((x) => x.key === key);
    const sty = SERIES_STYLE[key];
    let d = "";
    let last = null;
    for (const p of sr.points) {
      if (p.total === null) break;
      d += `${d ? "L" : "M"}${x(p.teams).toFixed(1)},${y(p.total).toFixed(1)}`;
      last = p;
    }
    if (!d) continue;
    svg.append(s("path", { d, fill: "none", stroke: sty.color, "stroke-width": 2, "stroke-linejoin": "round", "stroke-linecap": "round", "stroke-dasharray": sty.dash ? "6 5" : null }));
    if (sr.plan === "free" && last && last.teams < st.steps.at(-1)) {
      // the Free line ends where a Free limit breaks
      svg.append(s("circle", { cx: x(last.teams), cy: y(last.total), r: 4.5, fill: sty.color, stroke: "var(--surface)", "stroke-width": 2 }));
    }
  }
  const cross = s("line", { y1: m.t, y2: H - m.b, stroke: "rgba(255,255,255,.5)", "stroke-width": 1, visibility: "hidden" });
  svg.append(cross);
  const dots = st.series.map((sr) => s("circle", { r: 4, fill: SERIES_STYLE[sr.key].color, stroke: "var(--surface)", "stroke-width": 2, visibility: "hidden" }));
  svg.append(...dots);
  const tipEl = h("div", { class: "ctip", hidden: true });
  box.replaceChildren(svg, tipEl);
  const showAt = (i) => {
    const t = st.steps[i];
    const xx = x(t);
    cross.setAttribute("x1", xx);
    cross.setAttribute("x2", xx);
    cross.setAttribute("visibility", "visible");
    st.series.forEach((sr, k) => {
      const v = sr.points[i].total;
      if (v === null) dots[k].setAttribute("visibility", "hidden");
      else {
        dots[k].setAttribute("cx", xx);
        dots[k].setAttribute("cy", y(v));
        dots[k].setAttribute("visibility", "visible");
      }
    });
    tipEl.replaceChildren(h("div", { class: "h num", text: `${t.toLocaleString("en-US")} team${t === 1 ? "" : "s"} of ${settings.people}` }),
      ...st.series.map((sr) => h("div", { class: "r" }, h("span", { class: `lk${SERIES_STYLE[sr.key].dash ? " dash" : ""}`, style: `border-color:${SERIES_STYLE[sr.key].color}` }), h("b", { class: "num", text: sr.points[i].total === null ? "–" : money(sr.points[i].total) }), h("span", { text: SERIES_STYLE[sr.key].name + (sr.points[i].total === null ? " (past a Free limit)" : "") }))));
    tipEl.hidden = false;
    const tw = tipEl.offsetWidth;
    let left = xx + 12;
    if (left + tw > W) left = Math.max(0, xx - tw - 12);
    tipEl.style.left = `${left}px`;
    tipEl.style.top = `${m.t}px`;
    st.cursor = i;
  };
  const hideTip = () => {
    tipEl.hidden = true;
    cross.setAttribute("visibility", "hidden");
    dots.forEach((d) => d.setAttribute("visibility", "hidden"));
  };
  const nearest = (px) => {
    let best = 0;
    for (let i = 1; i < st.steps.length; i++) if (Math.abs(x(st.steps[i]) - px) < Math.abs(x(st.steps[best]) - px)) best = i;
    return best;
  };
  box.onpointermove = (e) => {
    const r = box.getBoundingClientRect();
    const px = e.clientX - r.left;
    if (px < m.l - 10 || px > W - m.r + 10) return hideTip();
    showAt(nearest(px));
  };
  box.onpointerleave = hideTip;
  box.onfocus = () => showAt(st.cursor ?? nearest(x(you)));
  box.onblur = hideTip;
  box.onkeydown = (e) => {
    if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
      e.preventDefault();
      const i = Math.max(0, Math.min(st.steps.length - 1, (st.cursor ?? 0) + (e.key === "ArrowRight" ? 1 : -1)));
      showAt(i);
    } else if (e.key === "Escape") hideTip();
  };
}

// ------------------------------------------------------------------------------------------------ limits
const limitRows = new Map(); // check key → td to fill with "at your settings"

function limitsSection() {
  const tbody = h("tbody");
  for (const l of DATA.limits) {
    const meta = T.LIMITS[l.id] ?? { name: l.value || l.id, tip: l.value || "A limit the lab recorded." };
    const at = h("td", { "data-label": "Your settings", class: "small" });
    if (meta.check) limitRows.set(meta.check, at);
    else at.textContent = "–";
    tbody.append(h("tr", {},
      h("td", { class: "first", "data-label": "Limit" }, h("span", { class: "cellname" }, meta.name, q(meta.tip, meta.name.toLowerCase())), h("span", { class: "sub", text: l.value })),
      h("td", { "data-label": "What the lab saw", class: "small", text: l.observed || "–" }),
      h("td", { "data-label": "What Carton does", class: "small", text: l.carton || "–" }),
      at,
      h("td", { "data-label": "Status" }, badge(l.status, l.runs?.length ? `Runs: ${l.runs.join(", ")}.` : ""))));
  }
  if (!DATA.limits.length) tbody.append(h("tr", {}, h("td", { colspan: 5, class: "muted", text: "No limits in the measurement file." })));
  return h("section", { class: "block", id: "limits", "aria-labelledby": "limits-h" },
    h("h2", { class: "display", id: "limits-h", text: "The limits, and what happens at each" }),
    h("p", { class: "lead", text: "Cloudflare's per-request and per-day limits, what the lab saw when it pushed against them, and what Carton does about each. \"Your settings\" says where the calculator's current settings stand." }),
    h("div", { class: "card" }, h("table", { class: "tbl rt" },
      h("thead", {}, h("tr", {}, h("th", { text: "Limit" }), h("th", { text: "What the lab saw" }), h("th", { text: "What Carton does" }), h("th", { text: "Your settings" }), h("th", { text: "Status" }))),
      tbody)));
}

function renderLimitsAtSettings(r) {
  const fc = r.free;
  for (const [key, td] of limitRows) {
    if (key === "cpu") {
      td.textContent = fc.cpu.worst ? `About ${sigNum(fc.cpu.worst.ms)} ms at most (${fc.cpu.worst.what})${fc.cpu.over ? ": over the limit" : ""}.` : "–";
      continue;
    }
    const c = fc.checks.find((x) => x.key === key);
    if (!c) {
      td.textContent = "–";
      continue;
    }
    const unit = key === "doStorageGB" ? " GB" : key === "doGBs" ? " GB-s" : "";
    td.textContent = `${count(c.used)}${unit}${c.total ? "" : " a day"}: ${c.over ? "over" : pct(c.used / c.limit)}${c.over ? "" : " of it"}. ${c.maxTeams === Infinity ? "Never reached." : `Fits up to ${teamsWord(c.maxTeams)}.`}`;
  }
}

// ------------------------------------------------------------------------------------------------ speeds
const KIND_ORDER = ["sync", "flap", "outage", "preview", "upload", "download"];
const NET_ORDER = ["none", "good", "4g", "3g", "bad"];
const kindOf = (sp) => {
  const k = sp.id.split("-")[0];
  return T.SCENARIOS[k] ? k : "other";
};
const netName = (n) => T.NETWORKS[n]?.label ?? n;
const netTip = (n) => {
  const prof = DATA.networkProfiles?.[n];
  const base = T.NETWORKS[n]?.tip ?? "";
  return prof ? `${netName(n)}: ${prof}. ${base}` : base || `${n}: no profile description in the measurement file.`;
};

function speedsSection() {
  const body = h("div", { class: "card" });
  const filters = h("div", { class: "filters" });
  const sec = h("section", { class: "block", id: "speeds", "aria-labelledby": "speeds-h" },
    h("h2", { class: "display", id: "speeds-h", text: "How fast it is" }),
    h("p", { class: "lead", text: "Real Carton clients against the lab's Cloudflare deployments, each on its own simulated network. Times are from the person's side. Live sync behaves the same with or without R2 (same room code); media differs." }),
    filters, body);
  const storages = [["r2", "R2"], ["vault", "Vault (no R2)"]];
  const nets = ["all", ...NET_ORDER.filter((n) => DATA.speeds.some((x) => x.network === n)), ...[...new Set(DATA.speeds.map((x) => x.network))].filter((n) => !NET_ORDER.includes(n))];
  const draw = () => {
    filters.replaceChildren(
      h("div", { class: "grp", role: "group", "aria-label": "Storage" }, h("span", { class: "lbl", text: "Storage" }),
        storages.map(([v, l]) => h("button", { type: "button", class: "chip", "aria-pressed": String(speedFilter.storage === v), onclick: () => { speedFilter.storage = v; draw(); } }, l))),
      h("div", { class: "grp", role: "group", "aria-label": "Network" }, h("span", { class: "lbl", text: "Network" }),
        nets.map((n) => h("span", { style: "display:inline-flex;align-items:center;gap:4px" },
          h("button", { type: "button", class: "chip", "aria-pressed": String(speedFilter.network === n), onclick: () => { speedFilter.network = n; draw(); } }, n === "all" ? "All" : netName(n)),
          n === "all" ? null : q(netTip(n), `the ${netName(n)} network`)))));
    const rows = DATA.speeds
      .filter((x) => (x.storage === speedFilter.storage || x.storage === "either") && (speedFilter.network === "all" || x.network === speedFilter.network))
      .sort((a, b) => KIND_ORDER.indexOf(kindOf(a)) - KIND_ORDER.indexOf(kindOf(b)) || (a.parties ?? 0) - (b.parties ?? 0) || (a.sizeMB ?? 0) - (b.sizeMB ?? 0) || NET_ORDER.indexOf(a.network) - NET_ORDER.indexOf(b.network) || a.id.localeCompare(b.id));
    const tbody = h("tbody");
    let lastKind = null;
    for (const sp of rows) {
      const kind = kindOf(sp);
      if (kind !== lastKind) {
        const sc = T.SCENARIOS[kind];
        const metric = sp.metric === "convergence" ? T.METRICS.convergence : T.METRICS.duration;
        tbody.append(h("tr", { class: "group" }, h("td", { colspan: 7 }, h("span", { class: "cellname" }, sc?.name ?? sp.what, q(`${sc?.tip ?? sp.what} ${metric}`, (sc?.name ?? "this scenario").toLowerCase())))));
        lastKind = kind;
      }
      const who = sp.parties && kind !== "preview" ? `${sp.parties} parties` : sp.sizeMB ? `${sp.sizeMB} MB` : "";
      const fails = sp.p50 === null;
      tbody.append(h("tr", {},
        h("td", { class: "first", "data-label": "Case" }, h("span", { class: "cellname" }, [who, netName(sp.network)].filter(Boolean).join(" · "), q(netTip(sp.network), `the ${netName(sp.network)} network`))),
        h("td", { class: "r num", "data-label": "p50", text: fails ? "failed" : dur(sp.p50) }),
        h("td", { class: "r num", "data-label": "p90", text: fails ? "–" : dur(sp.p90) }),
        h("td", { class: "r num", "data-label": "p99", text: sp.p99 === null ? "–" : dur(sp.p99) }),
        h("td", { class: "r num", "data-label": "Runs", text: String(sp.runs) }),
        h("td", { "data-label": "Status" }, badge(sp.status)),
        h("td", { class: "note", "data-label": "Note", text: sp.note || "" })));
    }
    if (!rows.length) tbody.append(h("tr", {}, h("td", { colspan: 7, class: "muted", text: "Not measured on this network with this storage yet." })));
    const th = (label, key, cls) => h("th", { class: cls }, h("span", { class: "thx" }, label, q(T.METRICS[key], label)));
    body.replaceChildren(h("table", { class: "tbl rt" },
      h("thead", {}, h("tr", {}, h("th", { text: "Case" }), th("p50", "p50", "r"), th("p90", "p90", "r"), th("p99", "p99", "r"), th("Runs", "runs", "r"), h("th", { text: "Status" }), h("th", { text: "Note" }))),
      tbody));
  };
  draw();
  return sec;
}

// ------------------------------------------------------------------------------------------------ inputs
function inputsSection() {
  const tbody = h("tbody");
  for (const [group, keys] of T.INPUT_GROUPS) {
    tbody.append(h("tr", { class: "group" }, h("td", { colspan: 5, text: group })));
    for (const k of keys) tbody.append(inputRow(k, INPUTS[k]));
  }
  if (DATA.extraInputs?.length) {
    tbody.append(h("tr", { class: "group" }, h("td", { colspan: 5, text: "Also measured (not used by the model yet)" })));
    for (const k of DATA.extraInputs) tbody.append(inputRow(k, INPUTS[k], true));
  }
  return h("section", { class: "block", id: "inputs", "aria-labelledby": "inputs-h" },
    h("h2", { class: "display", id: "inputs-h", text: "What's measured, and what's a guess" }),
    h("p", { class: "lead" }, "Every per-operation number the calculator uses, with where it comes from. ",
      h("span", { text: DATA.measured?.generated ? `Measurement file of ${DATA.measured.generated.slice(0, 10)}${DATA.measured.source?.commit ? ` (lab/cloudflare @ ${DATA.measured.source.commit})` : ""}.` : "" })),
    h("div", { class: "card" }, h("table", { class: "tbl rt" },
      h("thead", {}, h("tr", {}, h("th", { text: "Input" }), h("th", { class: "r", text: "Value" }), h("th", { text: "Status" }), h("th", { class: "r", text: "Runs" }), h("th", { class: "r", text: "Range" }))),
      tbody)));
}
function inputRow(k, v, extra = false) {
  const label = T.INPUT_LABELS[k] ?? k;
  const missing = !v;
  const value = missing ? M.INPUT_DEFAULTS[k] : v.value;
  const unit = v?.unit ?? "";
  const how = missing ? `Not in the measurement file. The model uses its own estimate: ${sigNum(value)}.` : v.how || "No description in the measurement file.";
  return h("tr", {},
    h("td", { class: "first", "data-label": "Input" }, h("span", { class: "cellname" }, label, q(how, label.toLowerCase())), h("span", { class: "sub", text: extra ? `${k} · not used by the model` : k })),
    h("td", { class: "r num", "data-label": "Value" }, sigNum(value ?? 0), unit ? h("span", { class: "sub", text: unit }) : null),
    h("td", { "data-label": "Status" }, badge(missing ? "missing" : v.status)),
    h("td", { class: "r num", "data-label": "Runs", text: v?.n ? String(v.n) : "–" }),
    h("td", { class: "r num", "data-label": "Range", text: v && v.min !== null && v.max !== null && v.min !== undefined ? `${sigNum(v.min)}–${sigNum(v.max)}` : "–" }));
}

// ------------------------------------------------------------------------------------------------ glossary
function glossarySection() {
  return h("section", { class: "block", id: "glossary", "aria-labelledby": "glossary-h" },
    h("h2", { class: "display", id: "glossary-h", text: "Glossary" }),
    h("p", { class: "lead", text: "The words on this page, in plain terms." }),
    h("dl", { class: "gloss" }, T.GLOSSARY.map(([term, text]) => h("div", {}, h("dt", {}, term, q(text, term)), h("dd", { text })))));
}

// ------------------------------------------------------------------------------------------------ boot
function asOf() {
  const p = DATA.prices;
  const el = document.getElementById("asof");
  const date = (() => {
    const d = new Date(`${p.fetched}T00:00:00Z`);
    return Number.isNaN(d.getTime()) ? p.fetched : d.toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });
  })();
  el.replaceChildren(`Prices as of ${date}, from Cloudflare: `,
    ...(p.sources ?? []).flatMap((src, i) => [i ? " · " : "", h("a", { href: src.url, rel: "noopener", text: src.name })]),
    ". All in US dollars.");
}

async function load() {
  const app = document.getElementById("app");
  let note = null;
  try {
    const res = await fetch("./data.json", { cache: "no-cache" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    DATA = await res.json();
    if (!DATA?.prices) throw new Error("no prices");
  } catch {
    // no data.json: the model's estimates and prices.json, said plainly
    try {
      const prices = await (await fetch("./prices.json")).json();
      DATA = { prices, inputs: {}, speeds: [], limits: [], networkProfiles: {}, missingInputs: Object.keys(M.INPUT_DEFAULTS), extraInputs: [] };
      note = "The measurement file didn't load, so every input below is the model's estimate.";
    } catch {
      app.replaceChildren(h("p", { class: "loading", text: "The calculator couldn't load its prices. Try reloading the page." }));
      return;
    }
  }
  DATA.inputs = DATA.inputs && typeof DATA.inputs === "object" ? DATA.inputs : {};
  DATA.speeds = Array.isArray(DATA.speeds) ? DATA.speeds : [];
  DATA.limits = Array.isArray(DATA.limits) ? DATA.limits : [];
  INPUTS = DATA.inputs;
  asOf();
  const presets = h("div", { class: "presets", role: "group", "aria-label": "Presets" },
    Object.entries(M.PRESETS).map(([k, p]) => h("button", { type: "button", class: "chip", "data-preset": k, "aria-pressed": "false", onclick: () => applyPreset(k) }, p.label)));
  chartCardInit();
  app.replaceChildren(
    h("section", { class: "block", id: "calculator", "aria-labelledby": "calc-h", style: "margin-top:24px" },
      h("h2", { class: "display", id: "calc-h", text: "The calculator" }),
      h("p", { class: "lead", text: "Start from a preset, then change anything. The bill updates as you type." }),
      note ? h("p", { class: "alert", text: note }) : null,
      presets,
      h("div", { class: "calc" }, settingsPanel(), results),
      live,
      h("div", { style: "margin-top:20px" }, chartCard)),
    limitsSection(),
    speedsSection(),
    inputsSection(),
    glossarySection());
  syncForm();
  render();
}
load();
