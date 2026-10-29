// Presses Cardboard's keyboard shortcuts in a running instance and checks each did what it should.
// What happened is read over the DevTools protocol (cdp.js), and edits in the saved timeline through
// the CLI.
//
// Keys the page handles go in through DevTools (Input.dispatchKeyEvent: before-input-event, then the
// page, exactly as a keyboard's do), so those tests leave your foreground alone. The window menu's
// accelerators only run for OS keyboard input, so with --os those tests press real keys (sendkeys.ps1):
// the window comes to the front, and the run stops if another window takes it.
//
// Run against a throwaway instance, not your own library:
//   set CARDBOARD_USER_DATA=%TEMP%\cb-kbtest\userdata& set CARDBOARD_HOME=%TEMP%\cb-kbtest\home
//   Cardboard.exe --remote-debugging-port=9334
// with a project open as the second tab, then:
//   node test-shortcuts.js <project-id> <timeline.tsx with two clips on one track> [--os] [name filter]
const { execFileSync, spawn } = require("child_process");
const fs = require("fs");
const path = require("path");
const { connect, evaluate, press, targets } = require("./cdp");

const args = process.argv.slice(2);
const os = args.includes("--os");
const [projectId, timelineFile, filter] = args.filter((a) => a !== "--os");
if (!timelineFile) throw new Error("usage: node test-shortcuts.js <project-id> <timeline.tsx> [--os] [filter]");
const userData = process.env.CARDBOARD_USER_DATA;
if (!userData || !process.env.CARDBOARD_HOME) throw new Error("set CARDBOARD_USER_DATA and CARDBOARD_HOME to the test instance's");
const exe = process.env.CARDBOARD_EXE ?? path.join(__dirname, "..", "Cardboard-win", "Cardboard.exe");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── The app ──
const cb = (...a) => execFileSync(exe, [path.join(path.dirname(exe), "resources", "cli", "cardboard.mjs"), ...a], {
  env: { ...process.env, ELECTRON_RUN_AS_NODE: "1", CARDBOARD_SOCKET: path.join(userData, "cardboard.sock") }, encoding: "utf8",
});
const source = () => cb("source", "print", projectId);
const items = () => Number(/· (\d+) items?/.exec(source())?.[1]);
const muted = () => (source().match(/\bmuted\b/g) ?? []).length;
// Waits up to 3 s for a value to arrive (saves are debounced).
const settle = async (read, want) => {
  let v;
  for (let i = 0; i < 15; i++) { if ((v = await read()) === want) return v; await sleep(200); }
  return v;
};
const resetTimeline = async () => { cb("source", "apply", projectId, timelineFile); await settle(items, 2); };
const appPid = () => Number(execFileSync("powershell", ["-NoProfile", "-Command",
  "(Get-CimInstance Win32_Process -Filter \"Name='Cardboard.exe'\" | Where-Object { $_.CommandLine -match 'remote-debugging-port=" + (process.env.CDP_PORT || 9334) + "' -and $_.CommandLine -notmatch '--type=' }).ProcessId"], { encoding: "utf8" }).trim());

// ── Pages ──
let pages = {};
const page = async (part) => (pages[part] ??= await connect(part));
const forget = () => { for (const c of Object.values(pages)) c.close(); pages = {}; };
const on = async (part, js) => evaluate(await page(part), js);
const EDITOR = "app/editor/" + projectId, HOME = "app/home", SETTINGS = "/app/settings", STRIP = "tabs.html";

// ── Keys ──
// "ctrl+shift+z" → the DevTools form "Control+Shift+z".
const CDP_KEYS = { space: "Space", esc: "Escape", enter: "Enter", left: "ArrowLeft", right: "ArrowRight", up: "ArrowUp", down: "ArrowDown",
  delete: "Delete", backspace: "Backspace", tab: "Tab", f10: "F10", f11: "F11", ctrl: "Control", shift: "Shift", alt: "Alt", win: "Meta" };
const toCdp = (c) => c.split(/\+(?!$)/).map((k) => CDP_KEYS[k] ?? k).join("+");
// Keys into a page (default the editor).
const keys = async (...combos) => {
  const part = combos[0]?.startsWith?.("@") ? combos.shift().slice(1) : EDITOR;
  const c = await page(part);
  for (const k of combos) { await press(c, toCdp(k)); await sleep(120); }
  await sleep(300);
};
// Real keys through the OS, into whatever has focus in the window.
let kb = null;
const startOsKeys = async () => {
  const p = spawn("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", path.join(__dirname, "sendkeys.ps1"), "-Id", String(appPid()), "-Serve"]);
  let buf = "";
  const waiting = [];
  p.stdout.on("data", (d) => {
    buf += d;
    for (let i; (i = buf.indexOf("\n")) >= 0; buf = buf.slice(i + 1)) waiting.shift()?.(buf.slice(0, i).trim());
  });
  p.stderr.on("data", (d) => process.stderr.write(d));
  const next = () => new Promise((r) => waiting.push(r));
  if ((await next()) !== "ready") throw new Error("sendkeys did not start");
  kb = { p, press: async (c) => { p.stdin.write(c + "\n"); const r = await next(); if (r !== "ok") throw new Error(r); } };
};
const osKeys = async (...combos) => { for (const c of combos) { await kb.press(c); await sleep(140); } await sleep(300); };

// ── What the app shows ──
const editor = () => on(EDITOR, `(() => {
  const q = (s) => document.querySelector(s);
  // Panels collapse or slide away while staying in the page: shown means it is what's under its middle.
  const shown = (e) => { if (!e) return false; const r = e.getBoundingClientRect(); const x = r.left + r.width / 2, y = r.top + r.height / 2;
    return r.width > 0 && x > 0 && x < innerWidth && e.contains(document.elementFromPoint(x, y)); };
  const tc = [...document.querySelectorAll("span,div,p")].find((e) => e.childElementCount === 0 && /^\\d\\d:\\d\\d:\\d\\d\\.\\d{3}$/.test(e.textContent.trim()));
  const a = document.activeElement;
  return {
    playing: !!q('button[aria-label="Pause"]'),
    snapping: !!q('button[aria-label="Disable timeline snapping"]'),
    timeline: !!q('button[aria-label="Hide timeline"]'),
    chat: shown(q('textarea[aria-label$="the agent"]')),
    left: shown(q('input[placeholder="Search project media…"]')),
    time: tc ? tc.textContent.trim() : null,
    focus: a ? a.tagName + ":" + (a.getAttribute("aria-label") || "") : null,
    dialog: q('[role="dialog"]')?.textContent.slice(0, 60) ?? null,
    fullscreen: !!document.fullscreenElement,
  };
})()`);
const strip = () => on(STRIP, `({
  tabs: [...document.querySelectorAll('[role="tab"]')].map((t) => t.textContent.trim() + (t.getAttribute("aria-selected") === "true" ? "*" : "")),
  menu: !!document.querySelector('[role="menu"]'),
  fullscreen: document.documentElement.style.getPropertyValue("--desktop-controls-inset-end") === "0px",
})`);
const urls = async () => (await targets()).filter((t) => t.type === "page").map((t) => t.url);
const editors = async () => (await urls()).filter((u) => u.includes("/app/editor/")).length;
const activeIs = async (i) => (await strip()).tabs[i]?.endsWith("*");
// Closes every tab after ours (the second) with its close button, as a click would.
const closeExtraTabs = async () => {
  for (let n = (await strip()).tabs.length; n > 2; n--) {
    await on(STRIP, `[...document.querySelectorAll('button[aria-label^="Close "]')].at(-1)?.click(), true`);
    await sleep(700);
  }
  if (!(await activeIs(1))) await on(STRIP, `document.querySelectorAll('[role="tab"]')[1]?.click(), true`);
  await sleep(400);
};
// The activity log the patched app writes (there is none on an unpatched one).
const logFile = () => path.join(userData, "logs", `activity-${new Date().toLocaleDateString("sv")}.jsonl`);
const logLines = () => { try { return fs.readFileSync(logFile(), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };

// ── Tests ──
const tests = [];
const test = (name, fn, opts = {}) => tests.push({ name, fn, ...opts });
const expect = (cond, detail) => { if (!cond) throw new Error(detail); };

test("Space plays and pauses", async () => {
  // Clips to play, from the start: at the end of the timeline, play stops at once.
  await resetTimeline();
  await keys("ctrl+left", "space"); const a = await editor();
  await keys("space"); const b = await editor();
  expect(a.playing && !b.playing, `playing after 1st Space: ${a.playing}, after 2nd: ${b.playing}`);
});
test("Ctrl+→ jumps to the end, Ctrl+← to the beginning", async () => {
  await resetTimeline();
  await keys("ctrl+right"); const a = await editor();
  await keys("ctrl+left"); const b = await editor();
  expect(a.time === "00:00:14.000" && b.time === "00:00:00.000", `end ${a.time}, beginning ${b.time}`);
});
test("→ / ← step one frame", async () => {
  await keys("ctrl+left", "right"); const a = await editor();
  await keys("left"); const b = await editor();
  expect(a.time === "00:00:00.033" && b.time === "00:00:00.000", `after → ${a.time}, after ← ${b.time}`);
});
test("S toggles snapping", async () => {
  const a = await editor(); await keys("s"); const b = await editor(); await keys("s"); const c = await editor();
  expect(a.snapping !== b.snapping && c.snapping === a.snapping, `${a.snapping} → ${b.snapping} → ${c.snapping}`);
});
test("\\ toggles the timeline", async () => {
  await keys("\\"); const a = await editor(); await keys("\\"); const b = await editor();
  expect(!a.timeline && b.timeline, `hidden ${!a.timeline}, shown again ${b.timeline}`);
});
test("] toggles the Director panel", async () => {
  const s = (await editor()).chat;
  await keys("]"); await sleep(300); const a = await editor(); await keys("]"); await sleep(300); const b = await editor();
  expect(a.chat !== s && b.chat === s, `shown ${s} → ${a.chat} → ${b.chat}`);
});
test("[ toggles the media panel", async () => {
  const s = (await editor()).left;
  await keys("["); await sleep(300); const a = await editor(); await keys("["); await sleep(300); const b = await editor();
  expect(a.left !== s && b.left === s, `shown ${s} → ${a.left} → ${b.left}`);
});
test("/ focuses the Director composer", async () => {
  await keys("/"); const a = await editor();
  expect(a.focus === "TEXTAREA:Message the agent", `focus ${a.focus}`);
});
test("Ctrl+E opens Export, Esc closes it", async () => {
  await keys("ctrl+e"); await sleep(300); const a = await editor();
  await keys("esc"); await sleep(300); const b = await editor();
  expect(/export/i.test(a.dialog ?? "") && !b.dialog, `dialog ${JSON.stringify(a.dialog)}, after Esc ${JSON.stringify(b.dialog)}`);
});
test("F toggles the full-screen preview", async () => {
  await keys("f"); await sleep(400); const a = await editor();
  await keys("f"); await sleep(400); const b = await editor();
  if (b.fullscreen) await keys("esc");
  expect(a.fullscreen && !b.fullscreen, `full screen ${a.fullscreen}, after 2nd F ${b.fullscreen}`);
});
test("Ctrl+A, Delete removes the clips; Ctrl+Z brings them back", async () => {
  await resetTimeline();
  await keys("ctrl+a", "delete"); const a = await settle(items, 0);
  await keys("ctrl+z"); const b = await settle(items, 2);
  expect(a === 0 && b === 2, `after Delete ${a} items, after Ctrl+Z ${b}`);
});
test("Ctrl+A, Backspace removes the clips", async () => {
  await resetTimeline();
  await keys("ctrl+a", "backspace"); const a = await settle(items, 0);
  expect(a === 0, `after Backspace ${a} items`);
});
test("Ctrl+Shift+Z redoes", async () => {
  await resetTimeline();
  await keys("ctrl+a", "delete"); await settle(items, 0);
  await keys("ctrl+z"); await settle(items, 2);
  await keys("ctrl+shift+z"); const a = await settle(items, 0);
  expect(a === 0, `after Ctrl+Shift+Z ${a} items`);
});
test("Ctrl+Y redoes (Windows' redo key)", async () => {
  await resetTimeline();
  await keys("ctrl+a", "delete"); await settle(items, 0);
  await keys("ctrl+z"); await settle(items, 2);
  await keys("ctrl+y"); const a = await settle(items, 0);
  expect(a === 0, `after Ctrl+Y ${a} items (2: nothing happened)`);
});
test("Ctrl+D duplicates the selection", async () => {
  await resetTimeline();
  await keys("ctrl+a", "ctrl+d"); const a = await settle(items, 4);
  expect(a === 4, `after Ctrl+D ${a} items`);
});
test("Ctrl+C, Ctrl+V pastes a copy", async () => {
  await resetTimeline();
  await keys("ctrl+a", "ctrl+c", "ctrl+right", "ctrl+v"); const a = await settle(items, 4);
  await keys("ctrl+left");
  expect(a === 4, `after paste ${a} items`);
});
test("Ctrl+X cuts", async () => {
  await resetTimeline();
  await keys("ctrl+a", "ctrl+x"); const a = await settle(items, 0);
  expect(a === 0, `after Ctrl+X ${a} items`);
});
test("B splits at the playhead", async () => {
  await resetTimeline();
  await keys("esc", "ctrl+left", ...Array(30).fill("right"), "b"); const a = await settle(items, 3);
  await keys("ctrl+left");
  expect(a === 3, `after B ${a} items`);
});
test("M mutes the selection", async () => {
  await resetTimeline();
  await keys("ctrl+a", "m"); const a = await settle(muted, 2);
  await keys("esc");
  expect(a === 2, `muted clips after M: ${a}`);
});
test("Ctrl+Tab / Ctrl+Shift+Tab cycle tabs", async () => {
  const n = (await strip()).tabs.length, next = 2 % n;
  await keys("ctrl+tab"); await sleep(400); const a = await activeIs(next);
  await keys(`@${next === 0 ? HOME : "app/editor/"}`, "ctrl+shift+tab"); await sleep(400); const b = await activeIs(1);
  expect(a && b, `tab ${next} active after Ctrl+Tab: ${a}, ours after Ctrl+Shift+Tab: ${b}`);
});
test("Alt opens the menu, Esc closes it", async () => {
  await keys("alt"); const a = (await strip()).menu;
  await keys(`@${STRIP}`, "esc"); const b = (await strip()).menu;
  expect(a && !b, `menu open ${a}, after Esc ${b}`);
});
test("F10 opens the menu; Enter, Enter runs File ▸ New Project", async () => {
  const before = await editors();
  await keys("f10"); const a = (await strip()).menu;
  await keys(`@${STRIP}`, "enter", "enter"); await sleep(2500);
  const b = await editors();
  forget();
  await closeExtraTabs();
  expect(a && b === before + 1, `menu open ${a}, editors ${before} → ${b}`);
});

// Settings ▸ Shortcuts
// The page's own request for Settings ▸ Shortcuts (what Help ▸ Keyboard Shortcuts… does).
const openShortcuts = () => on(EDITOR, `window.desktop.send("main:request", { id: "kbtest-" + Date.now(), channel: "tabs:settings", data: { section: "shortcuts" } }), true`);
test("Shortcuts page draws a Windows keyboard", async () => {
  const s = await on(SETTINGS, `(() => {
    const board = document.querySelector('[role="tablist"][aria-label="Modifier"]')?.closest(".p-\\\\[16px\\\\]");
    const caps = [...(board?.querySelectorAll("button,span") ?? [])].filter((e) => e.childElementCount === 0).map((e) => e.textContent.trim());
    return { caps: [...new Set(caps)], layers: [...board.querySelectorAll('[role="tab"]')].map((t) => t.textContent) };
  })()`);
  const mac = s.caps.concat(s.layers).filter((c) => /[⌘⌥⌃⇧⌫]|Return/.test(c));
  expect(mac.length === 0 && ["Ctrl", "Win", "Alt", "Shift", "Enter", "Backspace"].every((c) => s.caps.includes(c)),
    `Mac keys drawn: ${mac.join(" ") || "none"}; layers: ${s.layers.join(" | ")}`);
}, { needs: "settings" });
test("Recording Ctrl+D for Split says Duplicate has it", async () => {
  await on(SETTINGS, `(() => { const b = document.querySelector('[aria-label="Change shortcut for Split at Playhead"]'); b.scrollIntoView({ block: "center" }); b.click(); return true; })()`);
  await sleep(300);
  await keys(`@${SETTINGS}`, "ctrl+d");
  const row = await on(SETTINGS, `(() => {
    const r = document.querySelector('[aria-label="Change shortcut for Split at Playhead"]')?.parentElement
      ?? [...document.querySelectorAll("*")].find((e) => e.childElementCount > 0 && /^Split at Playhead/.test(e.innerText) && e.innerText.length < 300);
    const all = [...document.querySelectorAll("*")].filter((e) => e.childElementCount > 0 && /^Split at Playhead/.test(e.innerText) && e.innerText.length < 300);
    const box = all[all.length - 1];
    const save = [...(box?.querySelectorAll("button") ?? [])].find((b) => b.textContent === "Save");
    return { text: box?.innerText.replace(/\\n/g, " "), canSave: save ? !save.disabled : null };
  })()`);
  await on(SETTINGS, `[...document.querySelectorAll("button")].find((b) => b.textContent === "Cancel")?.click(), true`);
  expect(/duplicate/i.test(row.text ?? "") && row.canSave === false, `row: "${row.text}", Save enabled: ${row.canSave}`);
}, { needs: "settings" });

// The activity log (patched app only)
test("Activity log has shortcuts, unhandled keys and page errors", async () => {
  const n = logLines().length;
  await keys("s", "s", "j", "ctrl+k");
  await on(EDITOR, "setTimeout(() => { throw new Error('cb-kbtest probe') }), true");
  await sleep(2500);
  const got = logLines().slice(n);
  const has = (f) => got.some(f);
  const want = {
    "shortcut S (toggle-snapping, with project)": has((e) => e.ev === "shortcut" && e.id === "toggle-snapping" && e.combo === "S" && e.project === projectId),
    "unhandled J": has((e) => e.ev === "key" && e.combo === "J" && e.handled === false),
    "unhandled Ctrl+K": has((e) => e.ev === "key" && e.combo === "Ctrl+K" && e.handled === false),
    "page error": has((e) => e.ev === "error" && /cb-kbtest probe/.test(e.msg)),
  };
  const missing = Object.entries(want).filter(([, ok]) => !ok).map(([k]) => k);
  expect(missing.length === 0, `missing: ${missing.join(", ")}; got ${JSON.stringify(got.map((e) => e.ev + ":" + (e.id ?? e.combo ?? e.item ?? "")))}`);
});

// ── Window menu accelerators: real keys (--os) ──
test("Ctrl+T shows the Dashboard, Ctrl+2 the project again", async () => {
  await osKeys("ctrl+t"); await sleep(400); const a = await activeIs(0);
  await osKeys("ctrl+2"); await sleep(400); const b = await activeIs(1);
  expect(a && b, `Dashboard active after Ctrl+T: ${a}, project after Ctrl+2: ${b}`);
}, { os: true });
test("Ctrl+1 shows the Dashboard", async () => {
  await osKeys("ctrl+1"); await sleep(400); const a = await activeIs(0);
  await osKeys("ctrl+2"); await sleep(400);
  expect(a, `Dashboard active: ${a}`);
}, { os: true });
test("Ctrl+, opens Settings, Ctrl+W closes its tab", async () => {
  await osKeys("ctrl+,"); await sleep(900); const a = (await urls()).some((u) => u.includes(SETTINGS));
  await osKeys("ctrl+w"); await sleep(900); const b = (await urls()).some((u) => u.includes(SETTINGS));
  expect(a && !b, `settings open ${a}, still open after Ctrl+W ${b}`);
}, { os: true });
test("Ctrl+/ opens Keyboard Shortcuts", async () => {
  await osKeys("ctrl+/"); await sleep(900); const u = (await urls()).find((x) => x.includes(SETTINGS));
  await osKeys("ctrl+w"); await sleep(700);
  expect(u, `settings tab: ${u}`);
}, { os: true });
test("Ctrl+N starts a project, Ctrl+W closes it", async () => {
  const before = await editors();
  await osKeys("ctrl+n"); await sleep(2500); const a = await editors();
  await osKeys("ctrl+w"); await sleep(1200); const b = await editors();
  expect(a === before + 1 && b === before, `editors ${before} → ${a} → ${b}`);
}, { os: true });
test("Ctrl+Shift+B opens Report an Issue", async () => {
  await osKeys("ctrl+shift+b"); await sleep(700); const a = await editor();
  await osKeys("esc");
  expect(/report|issue/i.test(a.dialog ?? ""), `dialog ${JSON.stringify(a.dialog)}`);
}, { os: true });
test("Ctrl+= / Ctrl+- zoom the window (Dashboard)", async () => {
  await osKeys("ctrl+1"); await sleep(500);
  const z = () => on(HOME, "Math.round(devicePixelRatio * 100)");
  const a = await z(); await osKeys("ctrl+="); const b = await z(); await osKeys("ctrl+-"); const c = await z();
  await osKeys("ctrl+2"); await sleep(400);
  expect(b > a && c === a, `zoom ${a} → ${b} → ${c}`);
}, { os: true });
test("F11 toggles full screen", async () => {
  await osKeys("f11"); await sleep(1000); const a = (await strip()).fullscreen;
  await osKeys("f11"); await sleep(1000); const b = (await strip()).fullscreen;
  expect(a && !b, `full screen ${a}, after 2nd F11 ${b}`);
}, { os: true });
test("Activity log has menu accelerators, and no unhandled-key line for them", async () => {
  const n = logLines().length;
  await osKeys("ctrl+t"); await sleep(400); await osKeys("ctrl+2"); await sleep(1500);
  const got = logLines().slice(n);
  const menu = got.some((e) => e.ev === "menu" && /New Tab/.test(e.item) && e.via === "accelerator" && e.combo === "Ctrl+T");
  const stray = got.some((e) => e.ev === "key" && e.combo === "Ctrl+T");
  expect(menu && !stray, `menu line ${menu}, stray key line ${stray}; got ${JSON.stringify(got.map((e) => e.ev + ":" + (e.item ?? e.combo ?? "")))}`);
}, { os: true });

(async () => {
  await closeExtraTabs();
  const run = tests.filter((t) => !!t.os === os && (!filter || t.name.toLowerCase().includes(filter.toLowerCase())));
  if (os) await startOsKeys();
  let pass = 0, fail = 0;
  try {
    for (const t of run) {
      try {
        if (t.needs === "settings") { await openShortcuts(); await sleep(1500); }
        // Ctrl+2 is a menu accelerator, which DevTools keys don't reach: click our tab in the strip.
        else if (!t.os) {
          if (!(await activeIs(1))) { await on(STRIP, `document.querySelectorAll('[role="tab"]')[1].click(), true`); await sleep(500); }
          await on(EDITOR, "document.activeElement?.blur?.(), true");
        }
        await t.fn();
        pass++;
        console.log("PASS ", t.name);
      } catch (e) {
        fail++;
        console.log("FAIL ", t.name, "—", e.message);
        forget();
        if (/foreground is process/.test(e.message)) { console.log("stopped: another window took the foreground"); break; }
      }
    }
  } finally {
    if (kb) { kb.p.stdin.end(); await new Promise((r) => kb.p.once("exit", r)); }
    forget();
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
