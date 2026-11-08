// The take's "go" in the demo Cardboard, driven over DevTools (README steps 7-9, for a rehearsal or a take):
//   node go.js <DevTools port> <project id> [run folder] [--keep-library] [--layout-only] [--gone-after 3]
//                                                        [--end-after 4] [--cap-stop <file>] [--model "Opus 5.5"]
// 1. The layout: History open beside the chat (Ctrl+Shift+H as DevTools key events), the Library panel closed so the
//    preview has room (--keep-library: left open). --layout-only: report the layout, shoot it, and stop there.
// 2. The chat's picker set to a Claude Code row (provider "claude", --model's label if there is one; never Cloud, the
//    Director), the prompt typed and sent with the page's Send button.
// 3. Watches the page every ~0.25 s (History's top rows and their arrival ring, the chat's text, the timecode, the cut,
//    the timeline's items once a second from the editor's React state) and the stand-in's log, and shoots the key
//    moments as it notices them (a moment's time is when it was noticed, up to ~1 s after it happened; the stand-in's
//    log has the exact times): Claude 2's first row arriving, the chat's thinking row and first line, the playhead on
//    Claude 2's first title, Claude 1's first title, the switch to "Edit v2", back on Main with "He's gone.".
// 4. Sends the gone cue (GET /cue/gone) --gone-after seconds after the stand-in starts waiting for it, and the end cue
//    (GET /cue/end: Claude 1's last message, and the turn's end) --end-after seconds after it starts waiting for that.
//    And acts for the scene's operator cues (take 4), then sends them: "history" (Claude 1 has said "lemme check":
//    History closes, with its own shortcut), "cut-v2" and "cut-main" (the switch to Edit v2 and back, through the title
//    bar's cut chip: a click on the chip, its cuts menu opens under it, a click on the cut, and "Switch now", the turn
//    being Claude 1's), each followed by the timeline scrolled (sideways wheel steps) to where the stand-in puts the
//    playhead on that cut. The cut is read from the chip (History is closed by then).
// Throughout: the notices Cardboard puts over the preview about a teammate's media (".carton-media-notice": "N clips are
//    still on their way…", "This video plays from preview copies…") are dismissed as a person would, with a DevTools
//    click on their ✕, checked every ~100 ms; each is logged with when it appeared (seen in the page by a
//    MutationObserver), its text, and when it was dismissed (<run>\go-notices.jsonl). Never hidden with CSS.
// 5. At the end ("He's gone." on Main, the stand-in at its last message, the chat idle 3 s): asks the capture to stop
//    (writes --cap-stop, default <run>\cap.stop, the file cap-run.ps1 -StopFile waits for) and stops the window's
//    taskbar flash (unseen\flashstop.ps1).
// Log <run>\go.log, the chat's text over time <run>\go-chat.jsonl, moments <run>\go-moments.json, shots
// <run>\shots\1N-*.png. Paths from demo-env.ps1. DevTools page input only: nothing is sent to the OS.
const fs = require("fs"), path = require("path"), http = require("http");
const { spawnSync } = require("child_process");
const argv = process.argv.slice(2);
const opt = (k, d) => { const i = argv.indexOf("--" + k); if (i < 0) return d; const v = argv[i + 1]; argv.splice(i, 2); return v; };
const flag = (k) => { const i = argv.indexOf("--" + k); if (i < 0) return false; argv.splice(i, 1); return true; };
const KEEP_LIBRARY = flag("keep-library"), LAYOUT_ONLY = flag("layout-only"), GONE_AFTER = Number(opt("gone-after", 3)), END_AFTER = Number(opt("end-after", 4)), CAP_STOP = opt("cap-stop", null), MODEL = opt("model", "Opus 5.5");
const [port, id, given] = argv;
if (!port || !id) { console.error("usage: node go.js <DevTools port> <project id> [run folder] [--keep-library] [--layout-only] [--gone-after 3] [--end-after 4] [--cap-stop <file>] [--model <label>]"); process.exit(2); }
process.env.CDP_PORT = port;
const h = require("./lib/cdp-helpers");
const D = require("./lib/demo-env");
const OUT = D.runDir(given), SH = path.join(OUT, "shots");
const E = "app/editor/" + id;
const scene = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "claude1-scene.json"), "utf8"));
const PROMPT = scene.prompt ?? "Tidy up the promo";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ts = () => { const d = new Date(); return d.toTimeString().slice(0, 8) + "." + String(d.getMilliseconds()).padStart(3, "0"); };
let T0 = Date.now();
const log = (...a) => { const s = `${ts()} +${((Date.now() - T0) / 1000).toFixed(1).padStart(6)}s ${a.join(" ")}`; console.log(s); fs.appendFileSync(path.join(OUT, "go.log"), s + "\n"); };
const center = (sel) => `(() => { const b = ${sel}; if (!b) return null; const r = b.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`;
const btnSel = (label) => `[...document.querySelectorAll("button[aria-label]")].find((b) => b.getAttribute("aria-label") === ${JSON.stringify(label)} && b.getBoundingClientRect().width > 0)`;
let shotN = 10;
const shot = async (name) => { const f = path.join(SH, `${++shotN}-${name}.png`); const t = Date.now(); try { await h.shot(E, f); log(`shot ${path.basename(f)} (${Date.now() - t} ms)`); } catch (e) { log("shot failed", name, e.message); } return f; };
const cue = (name) => new Promise((res) => http.get(`http://127.0.0.1:${D.Port}/cue/${name}`, (r) => { let b = ""; r.on("data", (d) => (b += d)); r.on("end", () => res(`${r.statusCode} ${b.trim()}`)); }).on("error", (e) => res("error " + e.message)));
// cheap page reads, every ~0.25 s
const READ = `(() => {
  const sb = document.querySelector(".carton-sidebar");
  const rows = sb ? [...sb.querySelectorAll(".carton-version")].slice(0, 3).map((r) => { const a = r.querySelector(".carton-arrival"); return { text: r.innerText.replace(/\\s+/g, " ").trim().slice(0, 110), ring: !!a, glow: !!a?.hasAttribute("data-glow") }; }) : [];
  const lines = (sb?.innerText ?? "").split(String.fromCharCode(10)).map((s) => s.trim()).filter(Boolean);
  const cut = lines[lines.indexOf("Comments") + 1] ?? null;
  const tc = [...document.querySelectorAll(".tabular-nums")].find((e) => /^\\d\\d:\\d\\d:\\d\\d\\.\\d{3}$/.test(e.textContent.trim()))?.textContent.trim() ?? null;
  const ta = document.querySelector('textarea[aria-label="Message the agent"]');
  let chat = ta; while (chat && chat.parentElement && chat.getBoundingClientRect().height < 600) chat = chat.parentElement;
  const chatText = (chat?.innerText ?? "").replace(/\\n{2,}/g, "\\n").trim();
  const busy = [...document.querySelectorAll("button[aria-label]")].some((b) => /^Stop/i.test(b.getAttribute("aria-label")) && b.getBoundingClientRect().width > 0);
  const status = sb ? [...sb.querySelectorAll("[role=status],[aria-live]")].map((s) => s.textContent.trim()).filter(Boolean).join(" | ") : "";
  return { rows, cut, tc, chatText: chatText.slice(-2500), busy, status };
})()`;
// The title bar's cut chip (its page is tabs.html) and the cuts menu it opens in the editor's page (feat/cut-chip-menu)
// (selectors from feat/cut-chip-menu cc2ead00: the chip's button, the menu under it, a cut by its shown name, Switch now)
const CHIP = "[data-carton-cut-chip] > button[data-carton-cut]";
const CHIP_CUT = `(() => { const b = document.querySelector(${JSON.stringify(CHIP)}); return b ? (b.getAttribute("title") ?? b.textContent.trim()) : null; })()`;
const MENU = "[data-carton-cuts-pop] [role=menu]";
const visible = `(e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; }`;
const middle = (find) => `(() => { const vis = ${visible}; const e = ${find}; if (!e) return null; e.scrollIntoView({ block: "nearest" }); const r = e.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`;
const CUT_ITEM = (name) => middle(`[...document.querySelectorAll(${JSON.stringify(`${MENU} [data-carton-cut-name=${JSON.stringify(name)}]`)})].find(vis)`);
const SWITCH_NOW = middle(`[...document.querySelectorAll('${MENU} [data-carton-cut-choice="now"]')].find(vis)`);
const TOAST_CLOSE = middle(`[...document.querySelectorAll('.carton-toast button[aria-label="Close"]')].find(vis)`);
const SIDEBAR_OPEN = `!!document.querySelector(".carton-sidebar")?.offsetParent`;
// The timeline: its scroller ([data-timeline-scroll], scrolled natively by a sideways wheel) and its zoom (the editor's
// state: pixelsPerSecond, beside zoomLevel). The playhead is drawn on a canvas: where it is comes from the zoom.
const TIMELINE = `(() => { const e = document.querySelector("[data-timeline-scroll]"); if (!e) return null; const r = e.getBoundingClientRect(); return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2), sl: e.scrollLeft, cw: e.clientWidth, dpr: devicePixelRatio }; })()`;
const PPS = `(() => { const root = document.getElementById("root"); const key = Object.keys(root).find((k) => k.startsWith("__reactContainer")); const stack = [root[key]];
  while (stack.length) { const f = stack.pop(); if (!f) continue; for (let s = f.memoizedState, n = 0; s && n < 60; s = s.next, n++) { const c = s.memoizedState; if (c && typeof c === "object" && !Array.isArray(c) && typeof c.pixelsPerSecond === "number" && "zoomLevel" in c) return c.pixelsPerSecond; } if (f.child) stack.push(f.child); if (f.sibling) stack.push(f.sibling); }
  return null; })()`;
// where the stand-in puts the playhead around a cue: its last seek before the cue (cut-v2: the headline, 1.5 s), or its
// first one after (cut-main: back to Claude 1's last line), from the scene
const seekNear = (cue) => {
  const i = scene.steps.findIndex((x) => x.wait?.cue === cue), at = (x) => Number(/cb app seek ([\d.]+)/.exec(x?.command ?? "")?.[1] ?? NaN);
  const after = scene.steps.slice(i + 1).find((x) => !Number.isNaN(at(x))), before = scene.steps.slice(0, i).reverse().find((x) => !Number.isNaN(at(x)));
  return cue === "cut-v2" ? at(before) : at(after);
};
// the timeline's items, from the editor's React state
const ITEMS = `(() => { const root = document.getElementById("root"); const key = Object.keys(root).find((k) => k.startsWith("__reactContainer")); const stack = [root[key]]; let tl = null;
  while (stack.length && !tl) { const f = stack.pop(); if (!f) continue; for (let s = f.memoizedState, n = 0; s && n < 60; s = s.next, n++) { const c = s.memoizedState; if (c && typeof c === "object" && !Array.isArray(c) && "selectedTimelineItemIds" in c && "timelineItems" in c) { tl = c; break; } } if (f.child) stack.push(f.child); if (f.sibling) stack.push(f.sibling); }
  return tl ? tl.timelineItems.map((i) => (i.name ?? i.textContent ?? "") + "@" + Number(i.startTime).toFixed(1)) : null; })()`;
const LAYOUT = `(() => { const box = (e) => { if (!e) return null; const r = e.getBoundingClientRect(); return [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)]; }; const ta = document.querySelector('textarea[aria-label="Message the agent"]'); let c = ta; while (c && c.parentElement && c.getBoundingClientRect().height < 600) c = c.parentElement; return { win: [innerWidth, innerHeight], history: box(document.querySelector(".carton-sidebar")), chat: box(c), preview: box(document.querySelector("canvas")) }; })()`;
// the Library panel's own collapse button: the visible "Collapse panel" in the left half, in a panel header
const LIBRARY_COLLAPSE = `[...document.querySelectorAll('button[aria-label="Collapse panel"]')].find((b) => { const r = b.getBoundingClientRect(); return r.width > 0 && r.x > 0 && r.x < innerWidth / 2 && r.y < 100; })`;
const secs = (tc) => { if (!tc) return null; const [hh, mm, s] = tc.split(":"); return Number(hh) * 3600 + Number(mm) * 60 + Number(s); };
// the notices over the preview: a MutationObserver in the page notes when each first appears (and its text); every ~100 ms
// go.js looks for a visible one and clicks its ✕ (the notice's only button) with a DevTools mouse click
const NOTICE_WATCH = `(() => { if (window.__skitNotices) return "already"; const N = window.__skitNotices = new Map();
  const note = () => { for (const n of document.querySelectorAll(".carton-media-notice")) if (!N.has(n)) N.set(n, { seen: Date.now(), text: n.innerText.replace(/\\s+/g, " ").trim() }); };
  new MutationObserver(note).observe(document.body, { subtree: true, childList: true }); note(); return "installed"; })()`;
const NOTICE_FIND = `(() => { const N = window.__skitNotices; const n = [...document.querySelectorAll(".carton-media-notice")].find((n) => n.getBoundingClientRect().width > 0);
  if (!n) return null; const b = n.querySelector("button"); if (!b) return null; const r = b.getBoundingClientRect(); const m = N?.get(n) ?? { seen: null, text: n.innerText.replace(/\\s+/g, " ").trim() };
  if (N && !N.has(n)) N.set(n, m); return { x: r.x + r.width / 2, y: r.y + r.height / 2, label: b.getAttribute("aria-label"), seen: m.seen, text: m.text }; })()`;
// Recording only (take 7): History's own first rows (START "How it was when you opened it", the promo setup's version by
// "Teammate", "Project created") are hidden, and three made-up rows by You are drawn in their place, so the project reads
// as one You had been editing. Drawn over Carton's virtual list, from a copy of a real row; nothing in Cardboard changes.
const FAKE_HISTORY = `(() => {
  if (window.__skitFake) return "already";
  const now = Date.now(), clock = (m) => new Date(now - m * 60000).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" }).toLowerCase();
  const DUMMY = [["Swapped in the new product shots", "4 changes", 9], ["Tightened the intro", "2 changes", 23], ["First cut of the promo", "12 changes", 41]];
  const isSetup = (row) => row.matches(".carton-start") || !!row.querySelector('.carton-landmark-tag[data-kind="start"], .carton-landmark-tile[data-kind="start"]') || /Teammate/.test(row.querySelector(".carton-version-meta")?.textContent ?? "");
  const ty = (w) => Number((/translateY\\(([-\\d.]+)px\\)/.exec(w.style.transform) ?? [])[1] ?? 0);
  const make = (tpl, [title, count, ago]) => {
    const r = tpl.cloneNode(true);
    r.removeAttribute("id"); r.removeAttribute("aria-selected"); r.removeAttribute("data-active"); r.removeAttribute("data-start"); r.classList.remove("carton-start");
    r.setAttribute("data-kind", "edit"); r.style.pointerEvents = "none";
    const mark = r.querySelector(".carton-landmark-tile, .carton-version-mark");
    const av = document.createElement("span"); av.className = "carton-version-mark"; av.setAttribute("aria-hidden", "true");
    av.innerHTML = '<span class="carton-avatar" data-kind="human" style="width:20px;height:20px;font-size:8px;--carton-actor:#8f9cff"><span class="carton-avatar-initials">Y</span></span>';
    if (mark) mark.replaceWith(av); else r.prepend(av);
    const t = r.querySelector(".carton-version-title"); if (t) { t.removeAttribute("data-tail"); t.textContent = title; }
    let meta = r.querySelector(".carton-version-meta");
    if (!meta) { meta = document.createElement("span"); meta.className = "carton-version-meta"; (r.querySelector(".carton-version-main") ?? r).append(meta); }
    meta.textContent = count + " \u00b7 You";
    for (const w of r.querySelectorAll(".carton-version-when")) { w.removeAttribute("data-now"); w.removeAttribute("data-viewing"); w.textContent = clock(ago); }
    r.querySelectorAll(".carton-version-more, .carton-version-group, .carton-version-back, .carton-version-pick").forEach((e) => e.remove());
    return r;
  };
  let tplHtml = null;
  const apply = () => {
    for (const list of document.querySelectorAll(".carton-sidebar .carton-vlist")) {
      const inner = list.firstElementChild; if (!inner) continue;
      const rows = [...inner.querySelectorAll(":scope > .carton-vrow > .carton-version")];
      const setup = rows.filter(isSetup);
      for (const w of inner.querySelectorAll(":scope > .carton-vrow[data-skit-hid]")) if (!setup.includes(w.firstElementChild)) { w.style.visibility = ""; w.removeAttribute("data-skit-hid"); }
      let box = inner.querySelector(":scope > [data-skit-fake]");
      if (!setup.length) { if (box) box.style.display = "none"; continue; }
      const tpl = setup.find((r) => !r.matches(".carton-start")) ?? setup[0];
      if (!box) {
        box = document.createElement("div"); box.setAttribute("data-skit-fake", "");
        box.style.cssText = "position:absolute;top:0;left:0;right:0;pointer-events:none";
        DUMMY.forEach((d) => { const w = document.createElement("div"); w.className = "carton-vrow"; w.style.cssText = "position:relative;height:56px"; w.append(make(tpl, d)); box.append(w); });
        inner.append(box);
      }
      let base = Infinity;
      for (const r of setup) { const w = r.parentElement; base = Math.min(base, ty(w)); if (w.style.visibility !== "hidden") { w.style.visibility = "hidden"; w.setAttribute("data-skit-hid", ""); } }
      const want = "translateY(" + base + "px)"; if (box.style.transform !== want) box.style.transform = want;
      if (box.style.display) box.style.display = "";
      const minH = base + 56 * DUMMY.length + "px"; if (inner.style.minHeight !== minH) inner.style.minHeight = minH;
    }
  };
  window.__skitFake = new MutationObserver(apply);
  window.__skitFake.observe(document.body, { childList: true, subtree: true });
  setInterval(apply, 200); apply();
  return "installed";
})()`;
function watchNotices(page) {
  const file = path.join(OUT, "go-notices.jsonl"); let busy = false, stopped = false, handled = 0;
  const tick = async () => {
    if (busy || stopped) return; busy = true;
    try {
      const n = await h.ev(E, NOTICE_FIND);
      if (n) {
        await h.mouse(page, n.x, n.y); const at = Date.now(); await sleep(150);
        const still = await h.ev(E, `[...document.querySelectorAll(".carton-media-notice")].some((n) => n.getBoundingClientRect().width > 0)`);
        handled++; const rec = { appeared: n.seen ? new Date(n.seen).toISOString() : null, dismissed: new Date(at).toISOString(), shownMs: n.seen ? at - n.seen : null, button: n.label, text: n.text, stillVisible: still };
        fs.appendFileSync(file, JSON.stringify(rec) + "\n");
        log(`notice dismissed (${rec.shownMs ?? "?"} ms after it appeared${still ? "; another still shows" : ""}): ${JSON.stringify(n.text)}`);
      }
    } catch {} finally { busy = false; }
  };
  const iv = setInterval(tick, 100);
  return { stop: () => { stopped = true; clearInterval(iv); return handled; } };
}
(async () => {
  const page = await h.page(E);
  T0 = Date.now(); log(`go: project ${id}, run folder ${OUT}`);
  log("notice watcher:", await h.ev(E, NOTICE_WATCH)); const notices = watchNotices(page);
  log("fake History rows:", await h.ev(E, FAKE_HISTORY));
  // 1. the layout
  if (!(await h.ev(E, `!!document.querySelector(".carton-sidebar")?.offsetParent`))) { await h.keys(E, "Control+Shift+h"); await sleep(1200); }
  if (!KEEP_LIBRARY) {
    const lc = await h.ev(E, center(LIBRARY_COLLAPSE));
    if (lc) { await h.mouse(page, lc.x, lc.y); await sleep(900); log("Library panel closed"); } else log("no Library collapse button found (left as it is)");
  }
  log("layout (CSS px):", JSON.stringify(await h.ev(E, LAYOUT)));
  await shot("layout");
  if (LAYOUT_ONLY) { await sleep(1500); log(`notices dismissed: ${notices.stop()}`); h.forget(); process.exit(0); }
  // the stand-in's log: the newest in the demo folder (start-actor.ps1 makes one per run)
  const actorLog = fs.readdirSync(D.Demo).filter((f) => /^actor-.*\.log$/.test(f)).sort().pop();
  if (!actorLog) throw new Error("no stand-in log in " + D.Demo + ": start-actor.ps1 first");
  const ACTOR = path.join(D.Demo, actorLog);
  let lastIndex = null; try { lastIndex = JSON.parse(fs.readFileSync(ACTOR, "utf8").split("\n").find((l) => l.includes('"event":"scene"'))).messages - 1; } catch {}
  log(`stand-in log ${ACTOR} (the scene's last message: ${lastIndex})`);
  // 2. the picker: a Claude Code row, not Cloud (the Director)
  const pb = await h.ev(E, center(btnSel("Agent, model and effort"))); await h.mouse(page, pb.x, pb.y); await sleep(800);
  const rows = await h.ev(E, `[...document.querySelectorAll('[role=radiogroup][aria-label="Agent and model"] [role=radio]')].map((b) => { const k = Object.keys(b).find((k) => k.startsWith("__reactFiber")); let f = b[k], row = null; for (let i = 0; f && i < 6 && !row; i++, f = f.return) row = f.memoizedProps?.row ?? null; return { label: b.innerText.trim(), provider: row?.provider ?? null }; })`);
  const want = rows.findIndex((r) => r.provider === "claude" && r.label === MODEL), idx = want >= 0 ? want : rows.findIndex((r) => r.provider === "claude");
  if (idx < 0) throw new Error("no Claude Code row: " + JSON.stringify(rows));
  const rp = await h.ev(E, center(`document.querySelectorAll('[role=radiogroup][aria-label="Agent and model"] [role=radio]')[${idx}]`));
  await h.mouse(page, rp.x, rp.y); await sleep(700);
  if (await h.ev(E, `!!document.querySelector('[role=radiogroup][aria-label="Agent and model"]')`)) { await h.keys(E, "Escape"); await sleep(400); }
  const val = await h.ev(E, `(() => { const b = ${btnSel("Agent, model and effort")}; const k = Object.keys(b).find((k) => k.startsWith("__reactFiber")); let f = b[k]; for (let i = 0; f && i < 30; i++, f = f.return) if (f.memoizedProps?.connectors) return { value: f.memoizedProps.value, label: b.innerText.trim() }; return { label: b.innerText.trim() }; })()`);
  log(`picked "${rows[idx].label}" (provider ${rows[idx].provider}); picker now`, JSON.stringify(val));
  if (val.value && val.value.provider !== "claude") throw new Error("the picker isn't on Claude Code");
  // the prompt, typed and sent
  const ta = await h.ev(E, center(`document.querySelector('textarea[aria-label="Message the agent"]')`)); await h.mouse(page, ta.x, ta.y); await sleep(250);
  await page.send("Input.insertText", { text: PROMPT }); await sleep(400);
  const typed = await h.ev(E, `document.querySelector('textarea[aria-label="Message the agent"]').value`);
  await shot("typed");
  const sendB = await h.ev(E, center(btnSel("Send message")));
  const tSend = Date.now(); await h.mouse(page, sendB.x, sendB.y);
  log(`sent: ${JSON.stringify(typed)}`);
  // 3. watch
  const M = {}; const at = (k) => { M[k] = Date.now(); log(`MOMENT ${k} noticed at +${((Date.now() - tSend) / 1000).toFixed(1)} s after send`); };
  // the operator's acts for the scene's cues (take 4), each followed by its cue
  const chipCut = async () => { try { return await h.ev("tabs.html", CHIP_CUT); } catch { return null; } };
  const closeHistory = async () => {
    await sleep(900); // "lemme check" read first
    if (await h.ev(E, SIDEBAR_OPEN)) await h.keys(E, "Control+Shift+h");
    const closed = await h.until(async () => !(await h.ev(E, SIDEBAR_OPEN)), 3000, 100);
    log(closed ? "History closed" : "ERR History still open after its shortcut"); await shot("history-closed");
  };
  const chipSwitch = async (name, toastFor = 1200) => {
    const slug = name.toLowerCase().replace(/\W+/g, "-");
    const c = await h.center("tabs.html", CHIP);
    if (!c) throw new Error("no cut chip in the title bar");
    await h.mouse(await h.page("tabs.html"), c.x, c.y); log(`cut chip clicked (on ${await chipCut()})`);
    const item = await h.until(() => h.ev(E, CUT_ITEM(name)), 4000, 100);
    if (!item) throw new Error(`the chip's menu has no "${name}"`);
    at(`menu-${slug}`); await shot(`chip-menu-${slug}`);
    await sleep(800); // a beat on camera with the menu open
    const ed = await h.page(E);
    await h.mouse(ed, item.x, item.y); log(`clicked "${name}" in the chip's menu`);
    // a turn is running (Claude 1's): the cut opens in place with "Switch when it finishes" and "Switch now"
    const now = await h.until(() => h.ev(E, SWITCH_NOW), 2500, 100);
    if (now) { await shot(`chip-menu-${slug}-switch-now`); await sleep(700); await h.mouse(ed, now.x, now.y); log("clicked Switch now"); }
    const on = await h.until(async () => (await chipCut()) === name, 8000, 150);
    log(on ? `chip says ${name}` : `ERR chip still says ${await chipCut()}`);
    // The switch's toast ("You're on … now · Switch back to …") sits over the preview's bottom edge for ~6 s: seen for a
    // beat, then closed with its ✕, as a person would (the dry run: it covered "Fine!…" and "He's gone." typing in)
    const x = await h.until(() => h.ev(E, TOAST_CLOSE), 2500, 100);
    if (x) { await sleep(toastFor); await h.mouse(ed, x.x, x.y); log(`switch toast closed after ${toastFor} ms`); } else log("no switch toast seen");
  };
  // The timeline scrolled to a time (the user, take 5: "scroll the timeline when changing the cut"), as a person would:
  // sideways wheel steps over it, ~30 ms apart, until that time sits a third of the way in (or the timeline's start)
  const scrollTimelineTo = async (t) => {
    const pps = await h.ev(E, PPS);
    if (!pps || !Number.isFinite(t)) { log(`ERR timeline not scrolled (zoom ${pps}, to ${t})`); return; }
    const ed = await h.page(E);
    for (let i = 0; i < 60; i++) {
      const tl = await h.ev(E, TIMELINE); if (!tl) { log("ERR no timeline scroller"); return; }
      const left = Math.max(0, Math.round(t * pps - tl.cw / 3)) - tl.sl;
      if (Math.abs(left) < 6) { log(`timeline at ${t} s (scrollLeft ${tl.sl}, ${pps} px/s)`); return; }
      const step = Math.sign(left) * Math.min(Math.abs(left), 140);
      await ed.send("Input.dispatchMouseEvent", { type: "mouseWheel", x: tl.x, y: tl.y, deltaX: step * tl.dpr, deltaY: 0 });
      await sleep(30);
    }
    log(`ERR timeline didn't reach ${t} s`);
  };
  const asked = {};
  const operator = (name, act) => {
    if (asked[name]) return; asked[name] = true; at(`standin-waits-${name}`);
    (async () => { try { await act(); } catch (e) { log(`ERR ${name}: ${e.message}`); } log(`cue ${name} sent: ${await cue(name)}`); })();
  };
  let last = {}, lastChat = "", items = [], tItems = 0, actorPos = 0, actorBuf = "", goneAsked = false, endAsked = false, lastMsg = -1, turnEndSeen = 0, firstReq = null;
  const chatLog = fs.openSync(path.join(OUT, "go-chat.jsonl"), "a");
  const deadline = Date.now() + 30 * 60e3;
  while (Date.now() < deadline) {
    try { const st = fs.statSync(ACTOR); if (st.size > actorPos) { const fd = fs.openSync(ACTOR, "r"); const b = Buffer.alloc(st.size - actorPos); fs.readSync(fd, b, 0, b.length, actorPos); fs.closeSync(fd); actorPos = st.size; actorBuf += b.toString("utf8"); } } catch {}
    let nl; while ((nl = actorBuf.indexOf("\n")) >= 0) {
      const line = actorBuf.slice(0, nl); actorBuf = actorBuf.slice(nl + 1); let o = null; try { o = JSON.parse(line); } catch {}
      if (!o) continue;
      if (o.event === "request" && o.kind === "scene") { lastMsg = o.message; if (firstReq === null) { firstReq = Date.now(); log("stand-in: first scene request"); } }
      if (o.event === "request" && o.kind !== "scene") log(`stand-in: ${o.kind} request answered ${JSON.stringify(o.answered ?? "")}`);
      if (o.event === "tool") log(`stand-in: tool ${o.index} ${o.name} ${JSON.stringify(o.input).slice(0, 140)}`);
      if (o.event === "waited" || o.event === "wait-timeout") log(`stand-in: ${o.event} ${JSON.stringify(o).slice(36, 260)}`);
      if (o.event === "wait" && !o.cue) log(`stand-in: waits ${JSON.stringify(o).slice(36, 200)}`);
      if (o.event === "wait" && o.cue === "gone" && !goneAsked) {
        goneAsked = true; at("standin-waits-gone");
        setTimeout(async () => { const r = await cue("gone"); log(`cue gone sent (${GONE_AFTER} s after the stand-in's wait was noticed): ${r}`); }, GONE_AFTER * 1000);
      }
      if (o.event === "wait" && o.cue === "history") operator("history", closeHistory);
      if (o.event === "wait" && o.cue === "cut-v2") operator("cut-v2", async () => { await sleep(600); await chipSwitch("Edit v2", 1500); await scrollTimelineTo(seekNear("cut-v2")); });
      // (the timeline goes to Claude 1's last line before the stand-in moves the playhead there and adds "He's gone.")
      if (o.event === "wait" && o.cue === "cut-main") operator("cut-main", async () => { await sleep(600); await chipSwitch("Main cut", 900); await scrollTimelineTo(seekNear("cut-main")); });
      if (o.event === "wait" && o.cue === "end" && !endAsked) {
        endAsked = true; at("standin-waits-end");
        setTimeout(async () => { const r = await cue("end"); log(`cue end sent (${END_AFTER} s after the stand-in's wait was noticed): ${r}`); }, END_AFTER * 1000);
      }
    }
    let s; try { s = await h.ev(E, READ); } catch (e) { log("read failed", e.message); await sleep(500); continue; }
    if (!s.cut) s.cut = await chipCut(); // History closed: the chip says the cut
    if (s.chatText !== lastChat) { fs.writeSync(chatLog, JSON.stringify({ t: ts(), ms: Date.now() - tSend, chat: s.chatText.slice(-600), busy: s.busy }) + "\n"); lastChat = s.chatText; }
    if (JSON.stringify(s.rows[0]) !== JSON.stringify(last.rows?.[0])) log(`history top: ${JSON.stringify(s.rows[0])}${s.status ? " | status: " + s.status : ""}`);
    if (s.cut !== last.cut) log(`cut: ${s.cut}`);
    if (s.busy !== last.busy) log(`chat busy: ${s.busy}`);
    if (Date.now() - tItems > 1000) { tItems = Date.now(); try { const it = await h.ev(E, ITEMS); if (it && JSON.stringify(it) !== JSON.stringify(items)) { const added = it.filter((x) => !items.includes(x)), gone = items.filter((x) => !it.includes(x)); if (items.length) log(`timeline: +${JSON.stringify(added)} -${JSON.stringify(gone)} (${it.length} items)`); items = it; } } catch {} }
    const has = (p) => items.some((x) => x.startsWith(p));
    const t = secs(s.tc);
    // the key moments
    if (!M.ring && s.rows.some((r) => r.ring)) { at("ring"); await shot("history-claude2-row-arrival"); setTimeout(() => shot("history-claude2-row-1s5"), 1500); }
    if (!M.thinking && M.ring && /Thinking|Thought/.test(s.chatText.slice(-400))) { at("thinking"); await shot("chat-thinking-row"); }
    if (!M.firstLine && /Wait! Where did this clip come from/.test(s.chatText)) { at("firstLine"); await shot("chat-first-line"); }
    if (!M.playhead && M.firstLine && t !== null && t >= 24.95 && t <= 29.5) { at("playhead"); await shot("playhead-on-claude2-title"); }
    if (!M.c1title && has("Who are you")) { at("c1title"); await shot("claude1-first-title"); }
    if (!M.v2 && s.cut === "Edit v2") { at("v2"); await shot("switch-edit-v2"); setTimeout(() => shot("edit-v2-1s"), 1000); }
    if (!M.gone && M.v2 && s.cut && s.cut !== "Edit v2" && has("He's gone.")) { at("gone"); await shot("main-hes-gone"); setTimeout(() => shot("main-hes-gone-1s5"), 1500); }
    if (!M.final && /All done:/.test(s.chatText.slice(-800))) { at("final"); await shot("chat-final-message"); }
    // the end
    if (M.gone && (lastIndex === null || lastMsg >= lastIndex) && !s.busy) { if (!turnEndSeen) turnEndSeen = Date.now(); if (Date.now() - turnEndSeen > 3000) break; } else turnEndSeen = 0;
    last = s;
    await sleep(250);
  }
  at("end"); log(`notices dismissed during the take: ${notices.stop()}`); await shot("end");
  fs.writeFileSync(path.join(OUT, "go-moments.json"), JSON.stringify({ sent: new Date(tSend).toISOString(), noticedSecondsAfterSend: Object.fromEntries(Object.entries(M).map(([k, v]) => [k, +((v - tSend) / 1000).toFixed(1)])), items, lastChat: lastChat.slice(-2500) }, null, 1));
  fs.writeFileSync(CAP_STOP || path.join(OUT, "cap.stop"), "stop"); log("asked the capture to stop");
  const fl = spawnSync("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", path.join(__dirname, "unseen", "flashstop.ps1"), "-Port", String(port)], { encoding: "utf8" }); log("flashstop:", (fl.stdout || fl.stderr || "").trim().split("\n").pop());
  // a small repaint so the capture sees its "q" (Windows Graphics Capture gives a frame only when the window changes):
  // the pointer over the chat's input and away, which changes nothing else
  const tb = await h.ev(E, center(`document.querySelector('textarea[aria-label="Message the agent"]')`));
  if (tb) { await page.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: tb.x, y: tb.y }); await sleep(600); await page.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: 5, y: 5 }); }
  h.forget(); process.exit(0);
})().catch((e) => { log("ERR", e.stack); h.forget(); process.exit(1); });
