// One command for the whole capture: build the page, shoot every state on React (into <out>) and on preact/compat
// (into <out>/preact), and write <out>/INDEX.md from what was shot.
//   CARTON_CARDBOARD_ASSETS=<Cardboard 1.4.0 dist/renderer/assets>  CARTON_PLAYWRIGHT=<dir with node_modules/playwright>
//   CARTON_CHROMIUM=<chrome binary>  node gallery/capture/run.mjs <out dir> [--only <regex>] [--widths 384,300]
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const out = process.argv[2];
if (!out || out.startsWith("--")) throw new Error("usage: node gallery/capture/run.mjs <out dir> [--only <regex>] [--widths 384,300]");
const pass = process.argv.slice(3);
const node = (script, args, env = {}) => {
  try { execFileSync(process.execPath, [join(here, script), ...args], { stdio: "inherit", env: { ...process.env, ...env } }); return true; } catch { return false; }
};
node("build.mjs", []);
const okReact = node("shoot.mjs", ["--runtime", "react", ...pass], { CARTON_SHOTS: out });
const okPreact = node("shoot.mjs", ["--runtime", "preact", ...pass], { CARTON_SHOTS: join(out, "preact") });

// React against Preact, pixel by pixel (in Chromium: PNGs decoded on a canvas). A pixel counts when any channel
// differs by more than 16 (font antialiasing noise stays under it).
async function pixelDiff(pairs) {
  const pw = process.env.CARTON_PLAYWRIGHT;
  const { chromium } = createRequire(import.meta.url)(pw ? join(pw, pw.endsWith("node_modules") ? "" : "node_modules", "playwright") : "playwright");
  const browser = await chromium.launch({ executablePath: process.env.CARTON_CHROMIUM });
  const page = await browser.newPage();
  const res = [];
  for (const [file, a, b] of pairs) {
    const url = (f) => "data:image/png;base64," + readFileSync(f).toString("base64");
    res.push([file, await page.evaluate(async ([ua, ub]) => {
      const load = (u) => new Promise((r) => { const i = new Image(); i.onload = () => r(i); i.src = u; });
      const [ia, ib] = await Promise.all([load(ua), load(ub)]);
      if (ia.width !== ib.width || ia.height !== ib.height) return { size: `${ia.width}x${ia.height} vs ${ib.width}x${ib.height}` };
      const px = (i) => { const c = new OffscreenCanvas(i.width, i.height), x = c.getContext("2d"); x.drawImage(i, 0, 0); return x.getImageData(0, 0, i.width, i.height).data; };
      const da = px(ia), db = px(ib);
      let n = 0;
      for (let k = 0; k < da.length; k += 4) if (Math.abs(da[k] - db[k]) > 16 || Math.abs(da[k + 1] - db[k + 1]) > 16 || Math.abs(da[k + 2] - db[k + 2]) > 16) n++;
      return { changed: n, total: da.length / 4 };
    }, [url(a), url(b)])]);
  }
  await browser.close();
  return res;
}

// How a shot differs from the real app, beyond what every shot shares (the header below).
const DIFFERS = {
  "history-many": "Times come from the mock's generator: some rows say \"just now\" below rows from minutes ago (the generator clamps late times), which the real History never shows.",
  "history-compare": "Compare's numbers and side labels come from the mock's shot diff (makeShotDiff), not from the two versions' timelines.",
  "watch-": "The shot strip is the mock's 26-shot diff; the player (Cardboard's own preview) is the stand-in colour bars, which don't change with the side.",
  "window-watch": "The player is the stand-in colour bars (dimmed while a version is previewed); in the app it is Cardboard's own preview showing the side.",
  "window-preview": "The stage shows the stand-in bars, dimmed: the app shows the version's own frame.",
  "fold-": "The plan is a gallery-made FoldPlan (the mock's planFold, replaced from gallery code) for 30s Instagram cut → Main cut.",
  "comments-": "Comments come from @carton/react's comments mock (its people are Alice Chen, Bob Okafor, Cora Lind; the History mock's you is Alice Moreau).",
  "share-": "The worker's live services are the fake bridge: liveStatus, liveHostInfo and liveInvite answer with the scenario's values at once.",
  "stage-media-arrived": "The notice checks every 15 s in the app; this page checks every 150 ms so the \"arrived\" answer comes at once.",
  "stage-toast": "The toast was made by the real action (Restore / Fold in); its 6 s timeout is still running when shot.",
  "stage-conflict-preview": "The card's preview ref comes from a gallery conflictRef on the mock (the mock has none).",
  "titlebar": "Only the History/Share icons are Carton's (strip-buttons.js run with Cardboard's button class). The tabs, 16:9, report-issue, Export and sidebar buttons are stand-ins.",
  "join-": "The Dashboard behind the dialog is a stand-in.",
};
const differs = (name) => Object.entries(DIFFERS).filter(([k]) => name.startsWith(k)).map(([, v]) => v).join(" ");
const react = JSON.parse(readFileSync(join(out, "shots.json"), "utf8"));
const preact = JSON.parse(readFileSync(join(out, "preact", "shots.json"), "utf8"));
const pre = new Map(preact.shots.map((s) => [s.file ?? s.name, s]));
const diffs = await pixelDiff(react.shots.filter((s) => s.file && existsSync(join(out, "preact", s.file))).map((s) => [s.file, join(out, s.file), join(out, "preact", s.file)]));
const notSame = diffs.filter(([, d]) => d.size || d.changed > 0);
const pixelText = `Pixel comparison of every pair (a pixel counts when a channel differs by more than 16): ${diffs.length - notSame.length} of ${diffs.length} identical.` +
  (notSame.length ? " Differing (where a relative time sits on a minute boundary, Preact's first render can say \"just now\" where React says \"1 min ago\": @carton/react's minute clock is read at module load, and preact/compat's useSyncExternalStore apparently doesn't re-read it when it subscribes, as React's does; see notes/preact-first-render-clock.png): " + notSame.map(([f, d]) => `\`${f}\` (${d.size ? "size " + d.size : `${d.changed} px, ${(100 * d.changed / d.total).toFixed(2)} %`})`).join(", ") + "." : "");
const lines = react.shots.map((s) => {
  const p = pre.get(s.file ?? s.name);
  const errs = [...s.errors.map((e) => `React: ${e}`), ...(p?.errors ?? []).map((e) => `Preact: ${e}`)];
  return `| ${s.file ? `\`${s.file}\`` : `(not produced: ${s.name})`} | ${s.how} | \`?s=${s.scenario}${s.width ? `&w=${s.width}` : ""}\`, ${s.target} | ${[differs(s.name), errs.join("; ")].filter(Boolean).join(" ") || "—"} |`;
});
writeFileSync(join(out, "INDEX.md"), `# Carton UI, before: screenshots

Made by \`carton/packages/react/gallery/capture/run.mjs\` (see README.md here). Headless Chromium on Linux, DPR 2, React 19
(preact/compat copies in \`preact/\`). Every shot runs the app's own code: \`scripts/carton/ui.js\` (CartonSide,
CartonStage, JoinDialog), \`scripts/carton/sync/ui.js\` (Share), \`scripts/carton/strip-buttons.js\` (title-bar icons) and
@carton/react, over Cardboard 1.4.0's own stylesheet and Geist, talking to @carton/react's mock through the real wire
protocol (serveUi / serveComments) via a fake bridge. Interactions are real clicks, hovers and typing.

What every shot shares, unlike the real app: fonts render with Linux's rasterizer, not Windows' (DirectWrite), so text
is a little lighter and spacing differs by a pixel here and there; the window around Carton (title bar tabs, library,
stage video, timeline, chat) is a plain stand-in; data is the mock's (names: You = Alice Moreau, Bob Okafor, Priya
Shah, Leo Park, Director, Claude Code, Codex). Panel shots are the side panel alone at its width (384 or 300 CSS px, so
768 or 600 px wide), full window height (900 CSS px with a 50 px title bar). Stage shots are the stage alone: 700 CSS px
wide with the panel closed (the panel's room goes to the stage), 640 with it open. Window shots are the whole
${290 + 640}+panel+380 px window.

| File | State | Made with (page query, region) | Differs from the real app / page errors |
|---|---|---|---|
${lines.join("\n")}

## React and Preact

${(() => {
  const missing = react.shots.filter((s) => !pre.get(s.file ?? s.name)?.file).map((s) => s.name);
  const errs = preact.shots.filter((s) => s.errors.length).map((s) => `\`${s.file ?? s.name}\`: ${s.errors.join("; ")}`);
  return [`Preact shots: ${preact.shots.filter((s) => s.file).length} of ${react.shots.length}.${missing.length ? ` Not produced on Preact: ${missing.join(", ")}.` : ""}`, errs.length ? `Preact page errors: ${errs.join(" · ")}` : "No page errors on Preact.", pixelText].join("\n\n");
})()}
`);
console.log(`INDEX.md written in ${out}`);
if (!okReact || !okPreact) process.exitCode = 1;
