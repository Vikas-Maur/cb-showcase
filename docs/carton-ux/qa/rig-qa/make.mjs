// Design QA (2026-11-03): extend the integrated capture page with the states the merged rig dropped (WS7's conflict
// cards, WS2+8's Share dialog family and the 960 px title bar with Windows' caption buttons, the compact footage notice,
// a few error states). Gallery-only, never committed to product code: it writes an untracked copy of the rig's entry at
// carton/packages/react/gallery/capture-qa/ (same depth, so the entry's relative imports still resolve) and builds it.
//   node make.mjs <worktree>/carton/packages/react
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const react = process.argv[2];
const { build } = await import(pathToFileURL(join(react, "..", "..", "node_modules", "esbuild", "lib", "main.js")).href);
const cap = join(react, "gallery", "capture");
const qa = join(react, "gallery", "capture-qa");
mkdirSync(qa, { recursive: true });
let src = readFileSync(join(cap, "entry.js"), "utf8");
src = src.replace('from "./ws59.js"', 'from "../capture/ws59.js"');

const EXTRA = String.raw`
// ------------------------------------------------------------------ QA additions (design QA 2026-11-03)
const s7 = (author, at, text, did, what = "edit") => ({ author, summary: text, at, text, did, what });
const CARDS7 = {
  interview: card({ id: "c7-interview", path: "timelineItems/ib/#time", title: "'Interview B' timing", item: "item-ib", clip: "Interview B", provisional: "mine", sig: "18|20",
    mine: s7(people.alice, now0 - 2 * MIN, "Moved it to start at 0:18", "moved it", "move"), theirs: s7(people.terminal, now0 + 15_000, "Moved it to start at 0:20", "moved it", "move") }),
  tone: card({ id: "c7-tone", path: "timelineItems/tone/mediaItemId", title: "'Tone.mp3' media", item: "item-tone", clip: "Tone.mp3", provisional: "mine", canKeepBoth: true, both: "Leo Park's music on a new track under yours",
    mine: s7(people.alice, now0 - 5 * MIN, "Kept “Tone.mp3” from 0:00", "kept it"), theirs: s7(leo, now0 - 3 * MIN, "Replaced it with “Upbeat.wav”", "replaced it") }),
  twice: card({ id: "c7-twice", path: "media/m-w1/data/content", title: "'Summer launch' text", item: "item-summer", clip: "Summer launch", provisional: "theirs",
    mine: s7(people.alice, new Date(2026, 10, 3, 10, 5).getTime(), "Changed it to “Summer sale”", "changed its text"), theirs: s7(people.alice, new Date(2026, 10, 3, 10, 4).getTime(), "Changed it to “Summer launch”", "changed its text") }),
  size: card({ id: "c7-size", path: "timelineItems/w6/fontSize", title: "'W6' font size", item: "item-w6", clip: "W6", provisional: "mine", sig: "80|120",
    mine: s7(people.alice, now0 + 10_000, "Made it smaller (font size 80)", "changed its font size"), theirs: s7(people.terminal, now0 + 15_000, "Made it bigger (font size 120)", "changed its font size") }),
};
const see7 = (ui) => { ui.conflictRef = async (id, side) => "main@" + (side === "mine" ? 9 : 10); };
const uxStage = (setup) => () => { const r = ux()(); setup(r.ui); return { ...r, panel: null }; };
S["qa-conflict"] = uxStage((ui) => { see7(ui); ui.setConflicts([CARDS7.interview, CARDS7.tone]); });
S["qa-conflict-twice"] = uxStage((ui) => { see7(ui); ui.setConflicts([CARDS7.twice]); });
S["qa-conflict-turn"] = uxStage((ui) => { see7(ui); ui.setConflicts([CARDS7.size]); ui.setWorking({ actor: people.terminal, label: "Make the titles bigger", edits: 1, since: now0 - MIN, cutId: "cut-main" }); });
S["qa-conflict-again"] = uxStage((ui) => {
  see7(ui); ui.setConflicts([CARDS7.size]); ui.setWorking({ actor: people.terminal, label: "Make the titles bigger", edits: 1, since: now0 - MIN, cutId: "cut-main" });
  window.__again = () => ui.setConflicts([{ ...CARDS7.size, sig: "80|150", theirs: s7(people.terminal, now0 + 15_000, "Made it bigger (font size 150)", "changed its font size") }]);
});
S["qa-conflict-panel"] = () => { const r = ux()(); see7(r.ui); r.ui.setConflicts([CARDS7.interview, CARDS7.tone]); return { ...r, panel: "history" }; };
S["qa-conflict-old"] = uxStage((ui) => { ui.setConflicts([CARDS.intro, CARDS.w6]); });
// the compact footage notice with the offline chip (after/stage-live-media.png)
S["qa-live-media"] = () => ({ ...ux()(), panel: null, live: shared({ status: "offline", pending: 3, label: "Offline" }), media: { waiting: [{ mediaId: "m1", fileName: "interview-b.mp4" }, { mediaId: "m2", fileName: "broll-03.mp4" }], playable: 3, from: "Leo" } });
// the Share dialog as the mockups have it: Vikas, Leo here with his Director working, Mia idle
const leoA = { key: "human/leo", kind: "human", name: "Leo" }, miaA = { key: "human/mia", kind: "human", name: "Mia" };
const leoDirA = { key: "agent/director-leo", kind: "agent", name: "Director", parent: "human/leo" };
const VIKAS = shared({ name: "Vikas", account: "vikas", host: "https://share.northlight.studio" });
const shareUx = (live, extra = {}) => () => ({ ...ux()(), panel: "share", live, ...extra });
S["qa-share-first"] = shareUx({ shared: false });
S["qa-share-known"] = shareUx({ shared: false }, { name: "Vikas", host: "https://share.northlight.studio" });
S["qa-share-code"] = shareUx({ shared: false }, { hostInfo: { openCreate: false }, name: "Vikas" });
S["qa-share-unreachable"] = shareUx({ shared: false }, { hostInfo: "unreachable", name: "Vikas" });
S["qa-share-owner"] = shareUx({ ...VIKAS, peers: [peer(leoA, "Editing captions"), peer(leoDirA, "Working on “Add a title card”"), peer(miaA, null, true)] });
S["qa-share-offline"] = shareUx({ ...VIKAS, status: "offline", pending: 3, label: "Offline", peers: [], problem: { code: "unreachable", words: "The sharing server can't be reached. Your edits wait here and go out when it's back.", detail: "fetch failed: connect ECONNREFUSED 10.0.0.12:443" } });
S["qa-share-editor"] = shareUx({ ...VIKAS, role: "editor", peers: [peer(leoA, "Watching")] });
S["qa-share-update"] = shareUx({ ...VIKAS, status: "offline", pending: 1, label: "Offline", problem: { code: "update-server", words: "The sharing server is older than this app. It needs an update before this project can sync.", detail: "This project's history is newer than this server accepts (up to 3): update the server" } });
// the editor shared, Leo and Mia here (the title bar's avatars), and offline
S["qa-shared"] = () => ({ ...ux()(), panel: null, live: shared({ peers: [peer(leoA, "Editing captions"), peer(miaA, "Watching")] }) });
S["qa-offline"] = () => ({ ...ux()(), panel: null, live: shared({ status: "offline", pending: 3, label: "Offline", peers: [peer(leoA, "Editing captions")] }) });
// a long cut name, on another cut
S["qa-long-cut"] = () => { const r = ux()(); const long = "Client review: the long version with the drone shot"; setCuts(r.ui, [...WS6_CUTS(newest(r.ui), "cut-long"), cut({ id: "cut-long", name: long, label: long, head: newest(r.ui), color: "#22d3ee", updatedAt: Date.now() - 4 * MIN, updatedBy: people.alice })].map((c) => ({ ...c, current: c.id === "cut-long" }))); return { ...r, panel: null }; };
S["qa-teammate-window"] = () => ({ ...S["ws6-teammate"](), panel: "history" });
// errors: an action that fails says so in its card
S["qa-errors"] = () => { const r = ux()(); r.ui.restore = async () => { throw new Error("EPERM: operation not permitted, rename 'project.json'"); }; r.ui.undoTurnOf = async () => { throw new Error("worker gone"); }; return r; };
// one cut only: the chip and the menu with nothing to fold
S["qa-one-cut"] = () => { const r = ux()(); setCuts(r.ui, WS6_CUTS(newest(r.ui)).slice(0, 1)); return r; };
`;
src = src.replace("addWs59(S, {", EXTRA + "\naddWs59(S, {");
// Windows' caption buttons (patch-strip.js #3 leaves 138 px for them): ?win=1 draws a stand-in
src = src.replace('h("span", { className: "cap-sidebar-toggle" }, ico(["M4 5h16v14H4z", "M15 5v14"])),', 'h("span", { className: "cap-sidebar-toggle" }, ico(["M4 5h16v14H4z", "M15 5v14"])),\n    params.get("win") ? h("span", { className: "cap-wincontrols", style: { flex: "none", display: "flex", width: 138, justifyContent: "space-around", color: "#a3a3a3", fontSize: 12 } }, "—", "▢", "✕") : null,');
if (!src.includes("cap-wincontrols")) throw new Error("caption-button anchor not found");
if (!src.includes("qa-conflict")) throw new Error("scenario anchor not found");
writeFileSync(join(qa, "entry.js"), src);

// build, as gallery/capture/build.mjs does
const carton = join(react, "..", "..");
const out = join(react, "gallery", "dist", "capture-qa");
mkdirSync(out, { recursive: true });
const assets = process.env.CARTON_CARDBOARD_ASSETS;
const files = readdirSync(assets);
const pick = (re) => files.find((f) => re.test(f));
const css = pick(/^styles-.*\.css$/), tabs = pick(/^tabs-.*\.js$/);
const sans = pick(/^Geist-Variable.*\.woff2$/), mono = pick(/^GeistMono-Variable.*\.woff2$/);
const stripClass = readFileSync(join(assets, tabs), "utf8").match(/,C="(flex h-7 cursor-pointer[^"]*)"/)[1];
const common = { entryPoints: [join(qa, "entry.js")], bundle: true, format: "iife", platform: "browser", target: "chrome140", logLevel: "warning", absWorkingDir: carton, nodePaths: [join(carton, "node_modules")], define: { "process.env.NODE_ENV": '"production"', __STRIP_BUTTON_CLASS__: JSON.stringify(stripClass) } };
const clock = readFileSync(join(cap, "clock.js"), "utf8");
const preact = { react: "preact/compat", "react-dom/client": "preact/compat/client", "react-dom": "preact/compat", "react/jsx-runtime": "preact/jsx-runtime" };
await Promise.all([
  build({ ...common, outfile: join(out, "capture.react.js"), banner: { js: 'globalThis.__CARTON_RUNTIME__="react";\n' + clock } }),
  build({ ...common, outfile: join(out, "capture.preact.js"), banner: { js: 'globalThis.__CARTON_RUNTIME__="preact";\n' + clock }, alias: preact }),
]);
const fonts = `@font-face{font-family:Geist;src:url("${pathToFileURL(join(assets, sans))}") format("woff2");font-weight:100 900}@font-face{font-family:"Geist Mono";src:url("${pathToFileURL(join(assets, mono))}") format("woff2");font-weight:100 900}`;
const own = readFileSync(join(cap, "capture.css"), "utf8");
for (const rt of ["react", "preact"])
  writeFileSync(join(out, `capture.${rt}.html`), `<!doctype html>\n<html lang="en" class="dark"><head><meta charset="utf-8"><meta name="color-scheme" content="dark"><title>Carton QA (${rt})</title>\n<link rel="stylesheet" href="${pathToFileURL(join(assets, css))}">\n<style>${fonts}${own}</style></head>\n<body><div id="root"></div><script src="./capture.${rt}.js"></script></body></html>\n`);
console.log("qa capture built:", out, existsSync(join(out, "capture.react.js")));
