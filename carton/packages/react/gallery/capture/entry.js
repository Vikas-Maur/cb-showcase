// The "in the app" capture page: Carton's real editor parts (scripts/carton/ui.js: CartonSide, CartonStage, JoinDialog;
// scripts/carton/sync/ui.js: the Share panel; scripts/carton/strip-buttons.js: the title bar's icons) mounted the way
// editor-panel.js mounts them, in stand-ins for Cardboard's window (title bar, library, stage, timeline, chat), on
// Cardboard's own stylesheet. They talk to a fake bridge that serves @carton/react's mock through the real wire
// protocol (serveUi / serveComments), so the panel runs exactly the code the app runs. Gallery code only: nothing here
// ships. The page's clock is fixed (clock.js, put ahead of the bundle by build.mjs). One scenario per page load: capture.html?s=<scenario>&w=<panel width>. gallery/capture/shoot.mjs drives it.
import * as React from "react";
import { createElement as h, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import * as jsxRuntime from "react/jsx-runtime";
import { serveUi, serveComments, createMockComments } from "@carton/react";
import { createMockUi, people } from "@carton/react/mock";
import "../../../../../scripts/carton/sync/ui.js"; // sets window.__cartonSyncUi (the Share panel), as the app's bundle does
import { CartonSide, CartonStage, JoinDialog, liveSummary } from "../../../../../scripts/carton/ui.js";
import stripSource from "../../../../../scripts/carton/strip-buttons.js";

const params = new URLSearchParams(location.search);
const scenarioName = params.get("s") ?? "history-few";
const panelWidth = Number(params.get("w") ?? 384);
// file:// pages share one localStorage: every load starts clean, then sets what its scenario needs.
try { localStorage.clear(); localStorage.setItem("carton.sidePanelWidth", String(panelWidth)); } catch {}

// ------------------------------------------------------------------ actors the mock doesn't have
const MIN = 60_000;
const leo = { key: "human/leo", kind: "human", name: "Leo Park" };
const leosDirector = { key: "agent/director-leo", kind: "agent", name: "Director", parent: "human/leo" };
const codex = { key: "agent/codex", kind: "agent", name: "Codex", parent: "human/alice", isYou: true, model: "GPT-5.5" };
const SYSTEM = { key: "system/carton", kind: "system", name: "" };
const EXTRA = { [leo.key]: leo, [leosDirector.key]: leosDirector, [codex.key]: codex };

/** The mock, with the extra actors known (so "Leo Park's Director" is named by its owner). */
function mock(opts) {
  const ui = createMockUi(opts);
  const actor = ui.actor;
  ui.actor = (k) => EXTRA[k] ?? actor(k);
  return ui;
}
const newest = (ui) => ui.history().all().at(-1)?.ref ?? "main@0";
/** Replace the cuts the mock shows (a gallery wrapper: the mock keeps its own for its actions). */
function setCuts(ui, list) {
  let cuts = list;
  ui.cuts = () => cuts;
  ui.switchCut = async (id) => { cuts = cuts.map((c) => ({ ...c, current: c.id === id })); ui.hub.notify("cuts"); };
  ui.renameCut = async (id, name) => { cuts = cuts.map((c) => (c.id === id ? { ...c, name, label: name } : c)); ui.hub.notify("cuts"); };
  ui.hub.notify("cuts");
}
const cut = (o) => ({ readOnly: false, current: false, kind: "cut", owner: people.alice, head: "main@1", updatedAt: Date.now() - 3_600_000, ...o });
const CUTS = (head, current = "cut-main") => [
  cut({ id: "cut-main", name: "Main cut", label: "Main cut", kind: "main", head, shared: true }),
  cut({ id: "cut-ig", name: "30s Instagram cut", label: "30s Instagram cut", head: "ig@41" }),
  cut({ id: "cut-dir", name: "Director's cut: punchier open", label: "Director's cut: punchier open", kind: "director", owner: people.director, head: "dir@12" }),
  cut({ id: "cut-leo-main", name: "Main cut", label: "Leo's Main cut", kind: "main", readOnly: true, owner: leo, head: "leomain@88", shared: true }),
].map((c) => ({ ...c, current: c.id === current }));

/** A short History, oldest first: every kind of row the app shows. */
function fewVersions(ui, { provisional = false, named = true, turns = true } = {}) {
  const now = Date.now();
  // 20 s past the minute: a row never sits on a "N min ago" boundary, so a few ms of page timing can't change its words.
  const add = (ago, o) => ui.addVersion({ at: now - ago * MIN - 20_000, kind: "edit", ...o });
  add(48, { author: SYSTEM, summary: "Started the cut" });
  add(47, { author: people.alice, summary: "Added media 'clip.mp4'" });
  add(46, {
    author: people.alice,
    summary: "Added 2 tracks, 7 clips and 6 media files",
    details: ["Added track 'Mine'", "Added track 'Agents'", "Added video 'clip.mp4' on 'Mine' at 0:00.0", "Added video 'W1' on 'Agents' at 0:00.0", "Added video 'W2' on 'Agents' at 0:01.0", "Added video 'W3' on 'Agents' at 0:02.0", "Added 6 media files"],
  });
  if (turns) add(40, { author: codex, kind: "turn", turn: { label: "tighten the interview pauses", edits: 4 }, summary: "Removed 1.2 s from 'V1' at 0:14.0 (later items pulled left)" });
  add(33, { author: leo, summary: "Changed 'Title 1' text 'Summer sale' → 'Summer launch'" });
  if (named) add(30, { author: people.alice, name: "Rough cut", summary: "Moved 'Interview B' 0:24.0 → 0:22.5" });
  if (turns) add(25, { author: leosDirector, kind: "turn", turn: { label: "add captions to the interview", edits: 9 }, summary: "Added caption 'we cut editing time' on 'Captions' at 0:00.5" });
  add(18, { author: people.alice, kind: "fold", summary: "Folded in some of '30s Instagram cut' (2 left out)", foldRest: true });
  add(12, { author: people.alice, kind: "restore", summary: "Restored 'Rough cut'" });
  if (turns) add(6, { author: people.terminal, kind: "turn", turn: { label: "", edits: 1 }, summary: "Changed 'W2' font size 100 → 222" });
  if (turns) add(2, { author: people.director, kind: "turn", turn: { label: "tighter intro", edits: 12 }, summary: "Trimmed 'Intro' end 6.0 s → 4.5 s" });
  add(1, { author: people.alice, summary: "Trimmed 'Interview A' end 9.2 s → 8.0 s" });
  const head = newest(ui);
  if (provisional) {
    add(0.4, { author: people.alice, summary: "Moved 'B-roll city' 0:12.0 → 0:14.5", provisional: true, seq: null, ref: "main@pending-1" });
    add(0.1, { author: people.alice, summary: "Trimmed 'Outro' end 4.0 s → 3.0 s", provisional: true, seq: null, ref: "main@pending-2" });
  }
  return head;
}

// ------------------------------------------------------------------ fold plans (30s Instagram cut → Main cut)
const FOLD3 = (now) => [
  { id: "items/intro", summary: "Trimmed 'Intro' end 6.0 s → 3.5 s", author: people.director, at: now - 34 * MIN },
  { id: "items/cap-12", summary: "Added caption 'built for speed' on 'Captions' at 0:21.5", author: people.captions, at: now - 32 * MIN },
  { id: "tracks/music", summary: "Changed 'Music' volume 100 → 70", author: people.alice, at: now - 30 * MIN },
];
function planWith(ui, make) {
  ui.planFold = async (fromId, intoId) => {
    const cuts = ui.cuts(), from = cuts.find((c) => c.id === fromId), into = cuts.find((c) => c.id === intoId);
    return { from, into, conflicts: [], warnings: [], ...make(Date.now(), from, into) };
  };
}
const foldConflict = (from, into, now) => ({
  id: "items/intro/#time", title: "'Intro' timing", canKeepBoth: false, provisional: "mine",
  reason: "Both changed when this clip plays. Doing both would end it before it starts.",
  mine: { author: people.alice, summary: "Trimmed the end to 0:05.0", at: now - 40 * MIN, where: into.label },
  theirs: { author: people.director, summary: "Moved it to start at 0:02.0 and end at 0:08.0", at: now - 34 * MIN, where: from.label },
});

// ------------------------------------------------------------------ conflict cards over the stage
const card = (o) => ({ canKeepBoth: false, provisional: "theirs", ...o });
const now0 = Date.now() - 20_000; // off the minute boundary, as in fewVersions
const CARDS = {
  intro: card({ id: "c-intro", title: "'Intro' timing", item: "item-intro", reason: "Both changed when this clip plays. Doing both would end it before it starts.", mine: { author: people.alice, summary: "Trimmed the end to 0:05.0", at: now0 - 25_000 }, theirs: { author: people.director, summary: "Moved it to start at 0:02.0 and end at 0:08.0", at: now0 - 70_000 } }),
  w6: card({ id: "c-w6", title: "'W6' timing", item: "item-w6", mine: { author: people.alice, summary: "Moved 5.0 s → 7.0 s", at: now0 - 90_000 }, theirs: { author: people.terminal, summary: "Moved 5.0 s → 9.0 s", at: now0 - 60_000 } }),
  title: card({ id: "c-title", title: "Title text", item: "item-title", canKeepBoth: true, mine: { author: people.alice, summary: "\"Summer sale\"", at: now0 - 300_000 }, theirs: { author: leo, summary: "\"Summer launch\"", at: now0 - 240_000 } }),
  self: card({ id: "c-self", title: "'Interview A' volume", item: "item-ia", provisional: "mine", mine: { author: people.alice, summary: "Changed volume 100 → 60", at: now0 - 8 * MIN }, theirs: { author: people.alice, summary: "Changed volume 100 → 85", at: now0 - 3 * MIN } }),
  both: card({ id: "c-both", title: "New track 'Captions'", canKeepBoth: true, mine: { author: people.alice, summary: "Added track 'Captions' with 4 captions", at: now0 - 5 * MIN }, theirs: { author: leosDirector, summary: "Added track 'Captions' with 6 captions", at: now0 - 4 * MIN } }),
};

// ------------------------------------------------------------------ live status (the Share panel, the chip, the strip)
const peer = (a, activity, idle = false) => ({ actor: { key: a.key, kind: a.kind, id: a.key.split("/").pop(), name: a.name }, cut: "cut-main", activity, idle });
const shared = (o) => ({ shared: true, host: "https://share.example.com", account: "alice", name: "Alice Moreau", role: "owner", status: "up-to-date", pending: 0, label: "Up to date", holder: true, peers: [], problem: null, ...o });
const PEERS = [peer(people.bob, "Editing captions"), peer(leo, "Watching"), peer(people.priya, null, true), peer({ key: "human/sam", kind: "human", name: "Sam Rivera" }, "Editing")];

// ------------------------------------------------------------------ scenarios
// Each returns { ui, comments?, live?, hostInfo?, media?, panel?, chrome?, notice? }. `panel`: which side panel opens.
const S = {};
const hist = (o = {}) => () => { const ui = mock({ versions: 0 }); const head = fewVersions(ui, o); setCuts(ui, CUTS(head)); ui.setSync({ kind: "upToDate" }); ui.setConflicts([]); return { ui, panel: "history" }; };
S["history-none"] = () => { const ui = mock({ versions: 0 }); setCuts(ui, CUTS("main@0").slice(0, 1)); ui.setConflicts([]); ui.setSync({ kind: "local" }); return { ui, panel: "history" }; };
S["history-start"] = () => { const ui = mock({ versions: 0 }); ui.addVersion({ author: SYSTEM, kind: "edit", summary: "Started the cut", at: Date.now() - 2 * MIN - 20_000 }); setCuts(ui, CUTS(newest(ui)).slice(0, 1)); ui.setConflicts([]); ui.setSync({ kind: "local" }); return { ui, panel: "history" }; };
S["history-few"] = hist();
S["history-provisional"] = hist({ provisional: true });
S["history-no-named-turns"] = hist({ named: false, turns: false });
S["history-many"] = () => { const ui = mock({ versions: 3000, seed: 7 }); setCuts(ui, CUTS(newest(ui))); ui.setConflicts([]); ui.setSync({ kind: "upToDate" }); return { ui, panel: "history" }; };
S["cuts-one"] = () => { const ui = mock({ versions: 0 }); const head = fewVersions(ui); setCuts(ui, [cut({ id: "cut-main", name: "Main cut", label: "Main cut", kind: "main", head, current: true })]); ui.setConflicts([]); return { ui, panel: "history" }; };
S["cuts-long"] = () => {
  const ui = mock({ versions: 0 }); const head = fewVersions(ui);
  const long = "Director's cut: punchier open with the drone shot and the new music";
  setCuts(ui, [...CUTS(head, "cut-long"), cut({ id: "cut-long", name: long, label: long, kind: "director", owner: people.director, head })].map((c) => ({ ...c, current: c.id === "cut-long" })));
  ui.setConflicts([]); return { ui, panel: "history" };
};
const foldScenario = (make) => () => { const r = hist()(); planWith(r.ui, make); return r; };
S["fold-all"] = foldScenario((now) => ({ changes: FOLD3(now) }));
S["fold-conflict"] = foldScenario((now, from, into) => ({ changes: FOLD3(now), conflicts: [foldConflict(from, into, now)], warnings: ["'B-roll city' overlaps 'Interview A' by 0.4 s on 'V1'"] }));
S["fold-leftout"] = foldScenario((now) => ({ changes: [
  { id: "items/logo", summary: "Deleted video 'Logo sting'", author: people.alice, at: now - 50 * MIN, leftOut: "fold-17" },
  { id: "root/aspectRatio", summary: "Changed the aspect ratio 16:9 → 9:16", author: people.alice, at: now - 49 * MIN, leftOut: "fold-17" },
  ...FOLD3(now).slice(0, 2),
] }));
S["fold-nothing"] = foldScenario(() => ({ changes: [] }));
S["toast-fold"] = () => { const r = hist()(); setCuts(r.ui, CUTS(newest(r.ui), "cut-ig")); planWith(r.ui, (now) => ({ changes: FOLD3(now) })); return { ...r, panel: "history" }; };
S["comments-empty"] = () => ({ ...hist()(), comments: createMockComments({ seed: false }) });
S["comments-some"] = () => ({ ...hist()(), comments: createMockComments({}) });
// Stage: the panel closed, unless the scenario opens it.
const stage = (setup) => () => { const ui = mock({ versions: 0 }); fewVersions(ui); setCuts(ui, CUTS(newest(ui))); ui.setConflicts([]); ui.setSync({ kind: "upToDate" }); return { ui, panel: null, ...setup(ui) }; };
S["stage-preview-version"] = stage((ui) => { ui.openPreview("main@6", "the version from 2:14 PM (Codex)"); return {}; });
S["stage-preview-long"] = stage((ui) => { ui.openPreview("main@6", "“Sent to client, Monday: the long version with the new music and the alternate ending”"); return {}; });
S["stage-preview-blocked"] = stage((ui) => { ui.openPreview("main@6", "“Rough cut”"); ui.blockEdit(); return {}; });
S["stage-conflict-preview"] = stage((ui) => { ui.setConflicts([CARDS.w6]); ui.conflictRef = async (id, side) => `main@${side === "mine" ? 9 : 10}`; return {}; });
S["stage-conflict-one"] = stage((ui) => { ui.setConflicts([CARDS.intro]); return {}; });
S["stage-conflict-several"] = stage((ui) => { ui.setConflicts([CARDS.w6, CARDS.intro, CARDS.title]); return {}; });
S["stage-conflict-self"] = stage((ui) => { ui.setConflicts([CARDS.self]); return {}; });
S["stage-conflict-both"] = stage((ui) => { ui.setConflicts([CARDS.both]); return {}; });
S["stage-conflict-panel-open"] = () => ({ ...stage((ui) => { ui.setConflicts([CARDS.w6, CARDS.intro]); return {}; })(), panel: "history" });
S["stage-toast-warning"] = stage(() => ({ notice: "Your last change couldn't be saved. It's on screen, but it isn't in the project yet." }));
S["stage-live-offline"] = stage(() => ({ live: shared({ status: "offline", pending: 3, label: "Offline" }) }));
S["stage-live-syncing"] = stage(() => ({ live: shared({ status: "syncing", pending: 2, label: "Syncing" }) }));
const media = (o) => stage(() => ({ live: shared({ role: "editor", name: "Bob Okafor" }), media: o }));
S["stage-media-waiting-one"] = media({ waiting: [{ mediaId: "m1", fileName: "interview-a.mov" }], playable: 3 });
S["stage-media-waiting-many"] = media({ waiting: [{ mediaId: "m1", fileName: "interview-a.mov" }, { mediaId: "m2", fileName: "drone-shot.mp4" }, { mediaId: "m3", fileName: "b-roll-city.mp4" }, { mediaId: "m4", fileName: "outro.mov" }], playable: 2 });
S["stage-media-arrived"] = media({ waiting: [{ mediaId: "m1", fileName: "interview-a.mov" }], playable: 3, fastPoll: true });
S["stage-media-copies"] = media({ waiting: [], playable: 4 });
S["stage-media-unchecked"] = media({ waiting: [{ mediaId: "m1", fileName: "interview-a.mov" }, { mediaId: "m2", fileName: "drone-shot.mp4" }], playable: 0, unchecked: true });
// Share
const share = (live, extra = {}) => () => ({ ...hist()(), panel: "share", live, ...extra });
S["share-empty"] = share({ shared: false });
S["share-invite-code"] = share({ shared: false }, { hostInfo: { openCreate: false }, name: "Alice Moreau" });
S["share-unreachable"] = share({ shared: false }, { hostInfo: "unreachable", name: "Alice Moreau" });
S["share-owner"] = share(shared({}));
S["share-peers"] = share(shared({ peers: PEERS }));
S["share-editor-peers"] = share(shared({ role: "editor", name: "Bob Okafor", peers: [peer(people.alice, "Editing"), peer(leo, "Watching")] }));
S["share-offline"] = share(shared({ status: "offline", pending: 3, label: "Offline", peers: [], problem: { code: "unreachable", words: "The sharing server can't be reached. Your edits wait here and go out when it's back.", detail: "fetch failed: connect ECONNREFUSED 10.0.0.12:443" } }));
S["share-update-server"] = share(shared({ status: "offline", pending: 1, label: "Offline", problem: { code: "update-server", words: "The sharing server is older than this app. It needs an update before this project can sync.", detail: "This project's history is newer than this server accepts (up to 3): update the server" } }));
S["join"] = () => ({ ui: mock({ versions: 0 }), chrome: "join" });
// Title bar: the strip's icons, from the page's report (bridge.reportPanel), as the strip draws them.
S["titlebar"] = () => ({ ui: mock({ versions: 0 }), chrome: "titlebar" });
// Workstream 4: the mock's story (its newest versions: DESIGN §3), behind the app's History
S["changes-story"] = () => { const ui = mock({ versions: 40 }); setCuts(ui, CUTS(newest(ui))); ui.setSync({ kind: "upToDate" }); ui.setConflicts([]); return { ui, panel: "history" }; };

// ------------------------------------------------------------------ cuts menu and Fold in (UX redesign PLAN 6.x)
// The mockups' cuts (after/cuts-menu-*.png): who changed each and when, a dot for each but Main, Leo's under From teammates
const WS6_CUTS = (head, current = "cut-main") => {
  const now = Date.now();
  return [
    cut({ id: "cut-main", name: "Main cut", label: "Main cut", kind: "main", head, shared: true, updatedAt: now - 20_000, updatedBy: people.alice }),
    cut({ id: "cut-ig", name: "30s Instagram cut", label: "30s Instagram cut", head: "ig@41", updatedAt: now - 130 * MIN, updatedBy: people.director, color: "#f59e0b" }),
    cut({ id: "cut-client", name: "Client review — shorter version with alternate ending", label: "Client review — shorter version with alternate ending", head: "cr@9", updatedAt: now - 26 * 60 * MIN, updatedBy: people.alice, color: "#22d3ee" }),
    cut({ id: "cut-leo-main", name: "Main cut", label: "Leo's Main cut", kind: "main", readOnly: true, owner: leo, head: "leomain@88", shared: true, updatedAt: now - 5 * MIN - 20_000, updatedBy: leo }),
  ].map((c) => ({ ...c, current: c.id === current }));
};
const ws6 = (setup = () => {}) => () => { const ui = mock({ versions: 0 }); const head = fewVersions(ui); setCuts(ui, WS6_CUTS(head)); ui.setSync({ kind: "upToDate" }); ui.setConflicts([]); setup(ui); return { ui, panel: "history" }; };
S["ws6-cuts"] = ws6();
S["ws6-cuts-turn"] = ws6((ui) => ui.setWorking({ actor: people.terminal, label: "Tighten the intro and add a lower third", edits: 2, since: Date.now() - 90_000, cutId: "cut-main" }));
S["ws6-cuts-many"] = () => {
  const r = ws6()();
  const names = ["Teaser", "Festival cut", "Vertical 9:16", "Director's cut: punchier open", "Rough cut for Priya", "Alt ending", "No music", "Captions off", "Trailer A", "Trailer B", "Long version"];
  setCuts(r.ui, [...WS6_CUTS(newest(r.ui)), ...names.map((n, i) => cut({ id: `cut-x${i}`, name: n, label: n, head: `x${i}@3`, updatedAt: Date.now() - (i + 3) * 60 * MIN, updatedBy: i % 3 ? people.alice : people.director, color: ["#a78bfa", "#f472b6", "#a3e635", "#fb923c", "#38bdf8", "#34d399"][i % 6] }))]);
  return r;
};
// Fold in: the mockups' changes (after/fold-*.png), as change rows
const ws6Row = (id, summary, author, ago, change, more = {}) => ({ id, summary, author, at: Date.now() - ago, change: { key: id, text: summary, ...change }, ...more });
const WS6_FOLD = () => [
  ws6Row("items/intro", "Trimmed “Intro”, now ends at 0:03", people.director, 130 * MIN, { kind: "change", clip: "video", at: 0, end: 3 }),
  ws6Row("items/summer", "Changed “Summer launch” to “Summer sale”", people.alice, 70 * MIN, { kind: "change", clip: "title", at: 3, end: 7 }),
  ws6Row("items/closeup", "Removed “Product close-up”", people.director, 65 * MIN, { kind: "remove", clip: "video", at: 12, end: 16 }),
  ws6Row("aspectRatio", "Changed the aspect ratio to 9:16", people.director, 131 * MIN, { kind: "change", clip: "project" }, { locked: true }),
];
// 30s Instagram cut was made from Main cut at 12:20 pm (the capture clock is 2:30 pm)
const WS6_MADE = { which: "from", at: Date.now() - 130 * MIN };
const ws6Fold = (make) => () => {
  const r = ws6()();
  r.ui.planFold = async (fromId, intoId) => {
    const cuts = r.ui.cuts(), from = cuts.find((c) => c.id === fromId), into = cuts.find((c) => c.id === intoId);
    return { from, into, made: WS6_MADE, conflicts: [], warnings: [], ...make(from, into) };
  };
  return r;
};
S["ws6-fold-all"] = ws6Fold(() => ({ changes: WS6_FOLD() }));
S["ws6-fold-conflict"] = ws6Fold((from, into) => ({
  changes: WS6_FOLD().filter((c) => c.id !== "items/closeup"),
  conflicts: [{ id: "timelineItems/item-interview-b/#time", title: "'Interview B' timing", clip: "Interview B", canKeepBoth: false, provisional: "mine",
    mine: { author: people.alice, summary: "starts at 0:18", at: Date.now() - 13 * MIN, what: "move", where: into.label },
    theirs: { author: people.director, summary: "starts at 0:20", at: Date.now() - 70 * MIN, what: "move", where: from.label } }],
}));
S["ws6-fold-rest"] = ws6Fold(() => ({ changes: [ws6Row("left:fold-17:items/closeup", "Removed “Product close-up”", people.director, 4 * 24 * 60 * MIN, { kind: "remove", clip: "video", at: 12, end: 16 }, { leftOut: "fold-17", leftOutAt: new Date(2026, 9, 30, 16, 10).getTime() })] }));
S["ws6-fold-nothing"] = ws6Fold(() => ({ changes: [], made: undefined }));
// Leo's Main cut on screen (after/history-teammate-cut-384.png): History lists its versions, with what you can do with it
S["ws6-teammate"] = () => {
  const ui = mock({ versions: 0 });
  const now = Date.now();
  const add = (ago, o) => ui.addVersion({ at: now - ago * MIN - 20_000, kind: "edit", ...o });
  add(30, { author: leo, summary: "Trimmed “Outro”, now ends at 0:34", changes: 5 });
  add(140, { author: leosDirector, kind: "turn", turn: { label: "Add a title card at the end", edits: 3 }, summary: "Added title “Thanks for watching”", changes: 3 });
  add(-20, { author: leo, summary: "Replaced the music with “Upbeat.wav”", changes: 1 });
  setCuts(ui, WS6_CUTS(newest(ui), "cut-leo-main"));
  ui.setSync({ kind: "upToDate" }); ui.setConflicts([]);
  return { ui, panel: "history" };
};

const scenario = (S[scenarioName] ?? S["history-few"])();
const ui = scenario.ui;

// ------------------------------------------------------------------ the fake bridge (window.__carton in the app)
function makeBridge(sc) {
  const events = new Set(), commands = new Set(), notices = new Set(), servers = new Map();
  const emit = (ev) => queueMicrotask(() => { for (const f of [...events]) f(ev); });
  const comments = sc.comments ?? createMockComments({ seed: false });
  const calls = [];
  const api = {
    projectId: "proj-" + scenarioName,
    calls,
    call(name, [arg] = []) {
      calls.push(name);
      if (name === "ui" || name === "comments") {
        let s = servers.get(arg.client);
        if (!s) servers.set(arg.client, (s = name === "ui" ? serveUi(ui, (m) => emit({ client: arg.client, message: m })) : serveComments(comments, (m) => emit({ client: arg.client, message: m }))));
        s.receive(arg.message);
        return Promise.resolve(null);
      }
      if (name === "liveStatus") return Promise.resolve(sc.live ?? { shared: false });
      if (name === "liveHostInfo") return sc.hostInfo === "unreachable" ? Promise.reject(new Error("fetch failed")) : Promise.resolve(sc.hostInfo ?? { openCreate: true });
      if (name === "liveInvite") return Promise.resolve({ link: `https://share.example.com/p/7f3a9c#join=ct1.${arg?.role ?? "editor"}.Zk9QmV2xL0aT8bWn4RjYc` });
      if (name === "liveJoin") return new Promise((r) => setTimeout(() => r({ projectId: "proj-joined", name: "Weekend reel" }), 150));
      if (name === "liveShare") return Promise.resolve({ ok: true });
      if (name === "liveMediaHere") return Promise.resolve({ clips: Object.fromEntries((sc.media?.waiting ?? []).map((w) => [w.mediaId, "playable"])) });
      return Promise.reject(new Error(`no ${name} in the capture bridge`));
    },
    onEvent(f) { events.add(f); return () => events.delete(f); },
    onCommand(f) { commands.add(f); return () => commands.delete(f); },
    onNotice(f) { notices.add(f); return () => notices.delete(f); },
    command(action) { for (const f of [...commands]) f({ action }); },
    notice(text) { for (const f of [...notices]) f(text); },
    reportPanel(panel, live) { window.__cap.strip = { panel, live: live ?? null }; for (const f of stripSubs) f(window.__cap.strip); },
    preview(_projectId, ref) { window.__cap.previewRef = ref; for (const f of previewSubs) f(ref); return Promise.resolve(); },
    seek(t) { window.__cap.seekAt = t; },
    // Play and Before (Workstream 4): Before's side loaded ahead, and your edit's length (the story's 0:38)
    prefetch(_projectId, ref) { (window.__cap.prefetched ??= []).push(ref); },
    editLength: () => 38,
    playhead: () => 12.4,
    selection: () => null,
    reveal(item) { window.__cap.revealed = item; },
    openProject: () => new Promise((r) => setTimeout(r, 100)),
  };
  return api;
}
const stripSubs = new Set(), previewSubs = new Set();
if (scenario.media) {
  // MediaNotice checks every 15 s; "arrived" is that check's answer, so this scenario's page checks at once.
  if (scenario.media.fastPoll) {
    const si = window.setInterval.bind(window);
    window.setInterval = (fn, ms, ...a) => si(fn, ms === 15000 ? 150 : ms, ...a);
  }
}
const bridge = makeBridge(scenario);
window.__carton = bridge;
window.__cap = { scenario: scenarioName, width: panelWidth, ui, bridge, ready: false, strip: { panel: null, live: null }, runtime: globalThis.__CARTON_RUNTIME__ ?? "react" };
if (scenario.media) window.__cartonMediaHere = { projectId: bridge.projectId, ...scenario.media };
if (scenario.name) localStorage.setItem("carton.name", scenario.name);

// ------------------------------------------------------------------ the title bar's icons, run as the strip runs them
// strip-buttons.js runs in Cardboard's tab-strip bundle: n is its JSX runtime, w joins classes, I sends a command, C is
// the strip's button class (read from the pristine bundle at build time: __STRIP_BUTTON_CLASS__), c is React, G formats
// a shortcut.
const Strip = new Function("n", "w", "I", "C", "c", "G", stripSource + "\nreturn __cbCartonStrip;")(
  jsxRuntime,
  (...a) => a.filter(Boolean).join(" "),
  (cmd) => bridge.command(cmd.action),
  __STRIP_BUTTON_CLASS__,
  React,
  (k) => "Ctrl+" + k.replace("⇧", "Shift+"),
);
function useStrip() {
  const [s, setS] = useState(window.__cap.strip);
  useEffect(() => { stripSubs.add(setS); return () => { stripSubs.delete(setS); }; }, []);
  return s;
}
const ico = (d, size = 16) => h("svg", { viewBox: "0 0 24 24", width: size, height: size, fill: "none", stroke: "currentColor", strokeWidth: 1.75, strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": true }, ...[].concat(d).map((p, i) => h("path", { key: i, d: p })));
function TitleBar({ strip }) {
  const S_ = strip ?? { panel: null, live: null };
  return h("div", { className: "cap-titlebar" },
    h("span", { className: "cap-logo" }),
    h("span", { className: "cap-tab cap-tab-dim" }, ico(["M4 4h7v7H4z", "M13 4h7v7h-7z", "M4 13h7v7H4z", "M13 13h7v7h-7z"], 14), "Dashboard"),
    h("span", { className: "cap-tab cap-tab-dim" }, h("span", { className: "cap-tab-thumb cap-tab-thumb-dim" }), "Blank"),
    h("span", { className: "cap-tab" }, h("span", { className: "cap-tab-thumb" }), "Weekend reel", h("span", { className: "cap-tab-x" }, "✕")),
    h("span", { className: "cap-tab-plus" }, "+"),
    h("span", { className: "cap-flex" }),
    h("span", { className: "cap-ratio" }, "▭ 16:9 ⌄"),
    h(Strip, { panel: S_ }),
    h("button", { type: "button", className: __STRIP_BUTTON_CLASS__ + " group gap-1.5 px-[6px] text-white/45 hover:bg-white/[0.06] hover:text-white/80", "aria-label": "Report an issue (stand-in)" }, ico(["M12 8v5", "M12 16h.01", "M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18z"])),
    h("button", { type: "button", className: "cap-export" }, "Export", h("span", null, "Ctrl+E")),
    h("span", { className: "cap-sidebar-toggle" }, ico(["M4 5h16v14H4z", "M15 5v14"])),
  );
}

// ------------------------------------------------------------------ stand-ins for Cardboard's window
function Video() {
  const [ref, setRef] = useState(null);
  useEffect(() => { previewSubs.add(setRef); return () => { previewSubs.delete(setRef); }; }, []);
  return h("div", { className: "cap-video", "data-previewing": ref ? "" : undefined }, h("span", { className: "cap-video-caption" }, "Summer launch"));
}
function Timeline() {
  const tracks = [["Text 1", [[58, 66, "W6"]]], ["Mine", [[0, 25, "clip.mp4"]]], ["Agents", [[0, 8, "W1"], [8, 16, "W2"], [16, 24, "W3"], [24, 32, "W4"], [32, 40, "W5"]]]];
  return h("div", { className: "cap-timeline" },
    h("div", { className: "cap-tl-toolbar" },
      h("span", { className: "cap-tl-time" }, "0:00 / 0:10"),
      h("span", { className: "cap-flex" }),
      h("span", { className: "cap-tl-play" }, "▶"),
      h("span", { className: "cap-flex" }),
      h("button", { type: "button", className: "cap-tl-btn", "aria-label": "Fullscreen" }, ico(["M4 9V4h5", "M20 9V4h-5", "M4 15v5h5", "M20 15v5h-5"])),
      h("button", { type: "button", className: "cap-tl-btn", "aria-label": "Hide timeline" }, ico(["M4 5h16v14H4z", "M4 14h16"]))),
    h("div", { className: "cap-tl-ruler" }, ...[0, 2, 4, 6, 8, 10].map((s) => h("span", { key: s, style: { left: `calc(120px + ${s * 10}%)` } }, `${s}s`))),
    ...tracks.map(([name, clips]) => h("div", { key: name, className: "cap-tl-track" }, h("span", { className: "cap-tl-name" }, name),
      h("div", { className: "cap-tl-lane" }, ...clips.map(([a, b, n]) => h("span", { key: n, className: "cap-tl-clip", "data-kind": name, style: { left: `${a}%`, width: `${b - a}%` } }, n))))));
}
function Chat() {
  return h("div", { className: "cap-chat" },
    h("div", { className: "cap-chat-head" }, h("span", { className: "cap-chip" }, "New chat"), h("span", { className: "cap-flex" }), h("span", { className: "cap-muted" }, "↺  +")),
    h("div", { className: "cap-chat-empty" }, "Ask for a cut, captions, or something new."),
    h("div", { className: "cap-composer" }, h("span", { className: "cap-muted" }, "Describe the edit…"), h("span", { className: "cap-flex" }), h("span", { className: "cap-muted cap-composer-foot" }, "Opus 5.5  ⊙")));
}
function Library() {
  return h("div", { className: "cap-library" },
    h("div", { className: "cap-rail" }, ...Array.from({ length: 7 }, (_, i) => h("span", { key: i, className: "cap-rail-ico", "data-on": i === 0 ? "" : undefined }))),
    h("div", { className: "cap-lib" }, h("p", { className: "cap-lib-title" }, "Library"), h("div", { className: "cap-lib-search" }, "Search project media…"), h("div", { className: "cap-lib-thumb" }), h("p", { className: "cap-lib-name" }, "clip.mp4")));
}

function Editor() {
  const strip = useStrip();
  const pid = bridge.projectId;
  return h("div", { className: "cap-window" },
    h(TitleBar, { strip }),
    h("div", { className: "cap-row" },
      h("div", { className: "cap-editor" },
        h("div", { className: "cap-top" },
          h(Library),
          h("div", { className: "cap-stage bg-muted/60 relative", "data-carton-stage-host": "" }, h(Video), h(CartonStage, { projectId: pid, bridge, key: pid }))),
        h(Timeline)),
      h(CartonSide, { projectId: pid, bridge, key: pid }),
      h(Chat)));
}
function TitleOnly() {
  const [strip, setStrip] = useState({ panel: null, live: null });
  window.__cap.setStrip = (panel, st) => setStrip({ panel, live: st ? liveSummary(st) : null });
  window.__cap.liveSamples = { offline: shared({ status: "offline", pending: 3, peers: PEERS.slice(0, 2) }), peers: shared({ peers: PEERS }), syncing: shared({ status: "syncing", pending: 2, peers: PEERS.slice(0, 1) }) };
  return h("div", { className: "cap-window cap-window-title" }, h(TitleBar, { strip }));
}
function Join() {
  const [open, setOpen] = useState(true);
  return h("div", { className: "cap-window" }, h(TitleBar, { strip: null }),
    h("div", { className: "cap-dashboard" }, h("p", { className: "cap-lib-title" }, "Projects"), h("div", { className: "cap-dash-grid" }, ...["Weekend reel", "Launch teaser", "Join a shared project"].map((n) => h("div", { key: n, className: "cap-dash-tile" }, h("div", { className: "cap-dash-thumb" }), n)))),
    open ? h(JoinDialog, { bridge, onClose: () => setOpen(false) }) : null);
}

const App = scenario.chrome === "titlebar" ? TitleOnly : scenario.chrome === "join" ? Join : Editor;
createRoot(document.getElementById("root")).render(h(App));
setTimeout(() => {
  if (scenario.panel) bridge.command(scenario.panel === "share" ? "carton-share" : "carton-history");
  if (scenario.notice) setTimeout(() => bridge.notice(scenario.notice), 50);
  setTimeout(() => (window.__cap.ready = true), 250);
}, 60);
