// The Share dialog (Carton UX redesign PLAN 8.1; it was the Share panel's "Live" section), rendered with React's server
// renderer (no app needed): when sync fails, the person reads why, in plain words and with the host's own message
// (H-SV), instead of "Syncing" for ever; and its form, People and Invite in editors' words.
//   node --test scripts/carton/test/sync/ui.test.js
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs"), path = require("path");

const ROOT = path.resolve(__dirname, "../../../..");
const CARTON = path.join(ROOT, "carton");
// Never /tmp (a small shared tmpfs on the build box).
const OUT = path.join(process.env.CARTON_TEST_DIR ?? path.join(require("os").homedir(), "gfv-scratch", "carton", "windows-sync"), "ui-test");

let React, render, LiveStatus, ui;
test.before(async () => {
  const esbuild = require(path.join(CARTON, "node_modules", "esbuild"));
  fs.mkdirSync(OUT, { recursive: true });
  const outfile = path.join(OUT, "sync-ui.cjs");
  await esbuild.build({
    entryPoints: [path.join(ROOT, "scripts/carton/sync/ui.js")],
    bundle: true, platform: "node", format: "cjs", logLevel: "warning", outfile,
    absWorkingDir: CARTON, nodePaths: [path.join(CARTON, "node_modules")],
    // As the build does: `react` is the editor's own, handed over as window.__cartonReact.
    alias: { react: path.join(ROOT, "scripts/carton/react-shim.js") },
  });
  React = require(path.join(CARTON, "node_modules", "react"));
  render = require(path.join(CARTON, "node_modules", "react-dom", "server")).renderToStaticMarkup;
  globalThis.window = { __cartonReact: React };
  require(outfile);
  ui = globalThis.window.__cartonSyncUi;
  ({ LiveStatus } = ui);
}, { timeout: 600_000 });

const base = { shared: true, status: "syncing", pending: 0, host: "https://host.example", name: "Bob", peers: [] };
const html = (st) => render(React.createElement(LiveStatus, { st }));

test("QA G9: a server too old for the app: one amber line says so, with what still holds; the server's own message only in its tooltip", () => {
  const detail = "this client's documents are schema version 2, newer than this server accepts (up to 1): update the server";
  const words = "Can't sync: the sharing server needs an update. Your changes are saved here.";
  // offline (sync stopped), as the server's refusal leaves it: one box, not the offline line and an alert both
  for (const status of ["offline", "syncing"]) {
    const out = html({ ...base, status, pending: 1, problem: { code: "update-server", words, detail } });
    assert.equal((out.match(/class="carton-share-offline"/g) ?? []).length, 1, status + ": one amber box");
    assert.match(out, /class="carton-share-offline" role="alert" data-code="update-server" title="this client&#x27;s documents are schema version 2/, "the detail only in its title");
    assert.match(out, /<strong>Can&#x27;t sync: the sharing server needs an update\.<\/strong> Your changes are saved here\./);
    assert.doesNotMatch(out, /carton-sync-detail|carton-field-error|You&#x27;re offline|newer than this server accepts \(up to 1\): update the server</);
  }
});

test("no problem: no alert; a problem without a message of its own shows the words once", () => {
  const ok = html({ ...base, status: "up-to-date", problem: null });
  assert.doesNotMatch(ok, /role="alert"/);
  assert.doesNotMatch(ok, /carton-share-offline/, "nothing to say: no box");
  const out = html({ ...base, problem: { code: "unreachable", words: "The host can't be reached.", detail: null } });
  assert.match(out, /role="alert"/);
  assert.equal((out.match(/can&#x27;t be reached/g) ?? []).length, 1);
  assert.doesNotMatch(out, /carton-sync-detail|title=/);
});

test("on a cut of your own (demo rehearsal FINDINGS §4.4): a plain line says so, never amber or Offline; You aren't shown as here; back on the shared cut, as before", () => {
  const own = { ...base, status: "up-to-date", ownCut: { name: "Bob's cut", shared: "Main cut" } };
  const out = html(own);
  assert.match(out, /class="carton-share-offline" data-tone="info" role="status" data-own-cut=""/, "a plain (info) line, a status");
  assert.match(out, /<strong>You&#x27;re on “Bob&#x27;s cut”, which isn&#x27;t shared\.<\/strong> Your edits there stay on this computer, and teammates don&#x27;t see you until you&#x27;re back on “Main cut”\./);
  assert.doesNotMatch(out, /role="alert"|You&#x27;re offline|Offline/);
  // You: on that cut, without the ring of someone here (teammates don't see you there)
  assert.match(out, /Bob · on “Bob&#x27;s cut”/);
  assert.doesNotMatch(out, /data-here/);
  // offline for real on your own cut: both, the plain line first
  const both = html({ ...own, status: "offline" });
  assert.ok(both.indexOf("data-own-cut") >= 0 && both.indexOf("data-own-cut") < both.indexOf("You&#x27;re offline"), "the cut's line, then the offline one");
  const back = html({ ...base, status: "up-to-date", ownCut: null });
  assert.doesNotMatch(back, /data-own-cut|isn&#x27;t shared/);
  assert.match(back, /Bob · here now/);
  assert.match(back, /data-here/);
});

// UI audit 2026-11-02, P1-8, P2-8, P2-9, P2-10, P2-12: words an editor reads, and a failure that says what to do.
test("P1-8: a server that can't be reached is said so at the address, never as a token problem or a raw 'fetch failed'", () => {
  const p = ui.shareProblem("fetch failed", "share");
  assert.equal(p.field, "host");
  assert.match(p.text, /^Can't reach this address\. Check it/);
  assert.equal(p.raw, "fetch failed", "the raw text is kept for the tooltip only");
  assert.equal(ui.shareProblem("Couldn't reach http://127.0.0.1:8799: check the address").field, "host");
  assert.equal(ui.shareProblem("connect ECONNREFUSED 127.0.0.1:8799", "join").field, "link");
});

test("P1-8: invalid or expired invite, server busy, limit reached and unknown failures each have their own words", () => {
  const bad = ui.shareProblem("The host didn't accept the invite or session (expired)", "share");
  assert.deepEqual([bad.field, bad.text], ["secret", "This invite isn't valid, or it has expired. Ask for a new one."]);
  assert.equal(ui.shareProblem("The host didn't accept the invite or session", "join").field, "link");
  assert.match(ui.shareProblem("The host answered 503: overloaded").text, /busy or having trouble\. Try again in a minute\./);
  assert.match(ui.shareProblem("This host takes no more new projects from your network today").text, /reached its limit for today\. Try again tomorrow/);
  assert.match(ui.shareProblem("This host needs an owner invite or its admin token to share a project").text, /asks for an invite code/);
  assert.match(ui.shareProblem("That isn't an invite link (it looks like https://host/#join=…)", "join").text, /isn't an invite link/);
  assert.match(ui.shareProblem("This project is already in your library", "join").text, /already in your library\. Open it from there\./);
  const odd = ui.shareProblem("TypeError: x is not a function");
  assert.equal(odd.text, "Something went wrong. Try again.");
  assert.equal(odd.field, null);
  // never a system or tool name in a message
  for (const raw of ["fetch failed", "The host answered 500", "The host didn't accept the invite or session", "This project is already shared on that host: ask its owner for an invite"])
    assert.doesNotMatch(ui.shareProblem(raw).text, /\bhost\b|carton|token|fetch/i, raw);
});

test("P2-8, P2-10: the Share form asks in editors' words, validates inline, and its role picker isn't an OS <select>", () => {
  globalThis.localStorage = { getItem: () => null, setItem() {} };
  const bridge = { call: async () => ({}), onEvent: () => () => {} };
  const form = render(React.createElement(ui.ShareForm, { projectId: "p", bridge, title: "Share “Weekend reel”", onShared() {}, onClose() {} }));
  assert.match(form, /role="dialog"/);
  assert.match(form, />Share “Weekend reel”</);
  assert.match(form, /Sharing server/);
  assert.match(form, /Teammates see this beside your changes\./);
  assert.match(form, /class="carton-dialog-foot"[\s\S]*>Cancel<[\s\S]*>Share project</, "Cancel and Share project at the foot");
  assert.match(form, /novalidate/i, "inline messages, not the browser's 'Please fill out this field'");
  assert.doesNotMatch(form, /required/);
  assert.doesNotMatch(form, /Carton host|admin token|Owner invite|Alice/);
  assert.doesNotMatch(form, /Invite code/, "the code is asked for only when the server wants one");
  assert.match(form, /the originals stay on this computer/);
  const invite = render(React.createElement(ui.Invite, { projectId: "p", bridge, offline: false }));
  assert.doesNotMatch(invite, /<select/);
  assert.match(invite, /aria-haspopup="menu"/);
  assert.match(invite, /Can edit/);
  assert.match(invite, />Copy link</);
  assert.doesNotMatch(invite, /placeholder|Copy link to make one/, "no placeholder that reads as a disabled field (QA G24)");
  assert.match(invite, /Anyone with this link can join and edit\./);
  // offline: no link can be made, and it says when it can
  const off = render(React.createElement(ui.Invite, { projectId: "p", bridge, offline: true }));
  assert.match(off, /<button[^>]*disabled=""[^>]*>.*Copy link/s);
  assert.match(off, /when you&#x27;re back online/);
});

test("PLAN 8.1: a sharing server once used is one line with Change; an address without https:// is the https one", () => {
  globalThis.localStorage = { getItem: (k) => (k === "carton.host" ? "https://share.northlight.studio" : null), setItem() {} };
  const form = render(React.createElement(ui.ShareForm, { projectId: "p", bridge: { call: async () => ({}), onEvent: () => () => {} }, onShared() {}, onClose() {} }));
  assert.match(form, /<span class="carton-known-value">share\.northlight\.studio<\/span> <button type="button" class="carton-link">Change<\/button>/);
  assert.doesNotMatch(form, /id="carton-share-host"/, "no field until Change");
  assert.equal(ui.hostAddress("share.northlight.studio"), "https://share.northlight.studio");
  assert.equal(ui.hostAddress(" http://127.0.0.1:8787 "), "http://127.0.0.1:8787");
  assert.equal(ui.hostAddress(""), "");
});

test("the user, 2026-11-05: with no address used yet, the Share form shows this build's own sharing server, one line with Change; one used before wins", () => {
  const bridge = { call: async () => ({}), onEvent: () => () => {} };
  for (const stored of [null, ""]) {
    globalThis.localStorage = { getItem: () => stored, setItem() {} };
    const form = render(React.createElement(ui.ShareForm, { projectId: "p", bridge, onShared() {}, onClose() {} }));
    assert.match(form, /<span class="carton-known-value">cardboard-showcase\.vikasmaur10\.workers\.dev<\/span> <button type="button" class="carton-link">Change<\/button>/, String(stored));
    assert.doesNotMatch(form, /id="carton-share-host"/, "nothing to type");
    assert.doesNotMatch(form, /The address whoever runs your sharing server gave you/, "no hint about an address nobody gave them");
  }
  globalThis.localStorage = { getItem: (k) => (k === "carton.host" ? "https://share.northlight.studio" : null), setItem() {} };
  assert.match(render(React.createElement(ui.ShareForm, { projectId: "p", bridge, onShared() {}, onClose() {} })), /carton-known-value">share\.northlight\.studio</);
});

test("PLAN 8.1, QA G3, G11: People: You, then each teammate with what they're doing and their role, their agents under them", () => {
  const st = { ...base, status: "up-to-date", name: "Vikas", role: "owner", peers: [
    { actor: { key: "human/leo", kind: "human", id: "leo", name: "Leo" }, activity: "Editing captions", idle: false, role: "editor" },
    { actor: { key: "human/mia", kind: "human", id: "mia", name: "Mia" }, activity: null, idle: true, role: "commenter" },
    { actor: { key: "agent/director/t1", kind: "agent", id: "director", name: "Director", parent: "human/leo", owner: { id: "leo", name: "Leo" } }, activity: "Working on “Add a title card”", idle: false },
    // a role this app doesn't know, or one that would read from the object's prototype: none shown
    { actor: { key: "human/bo", kind: "human", id: "bo", name: "Bo" }, activity: null, idle: false, role: "constructor" },
  ] };
  const out = render(React.createElement(ui.People, { st }));
  const rows = [...out.matchAll(/<li class="carton-share-person"[^>]*>([\s\S]*?)<\/li>/g)].map((m) => m[1].replace(/<[^>]+>/g, "|").replace(/\|+/g, "|"));
  assert.deepEqual(rows, ["|Y|You|Vikas · here now|Owner|", "|L|Leo|Here now · editing captions|Can edit|", "|Leo&#x27;s Director|Working on “Add a title card”|", "|M|Mia|Here, not editing|Can comment|", "|B|Bo|Here now|"]);
  assert.match(out, /data-you=""/);
  assert.match(out, /data-here=""/, "who is here wears the green ring");
  assert.match(out, /data-under=""[^>]*>[\s\S]*?data-agent="director"/, "the Director, under Leo, with its own mark");
  assert.doesNotMatch(out, /Nobody else is here/);
  assert.match(render(React.createElement(ui.People, { st: { ...st, peers: [] } })), /Nobody else is here right now\./);
});

test("P2-8: a known name is asked for once: Join and Share show it with Change", () => {
  globalThis.localStorage = { getItem: (k) => (k === "carton.name" ? "Vikas" : null), setItem() {} };
  const bridge = { call: async () => ({}), onEvent: () => () => {} };
  const form = render(React.createElement(ui.ShareForm, { projectId: "p", bridge, onShared() {}, onClose() {} }));
  assert.match(form, /Teammates see you as <span[^>]*>Vikas<\/span>/);
  assert.doesNotMatch(form, /Your name/);
});

test("P2-12, PLAN 8.1: offline says it once, in the amber line; the server's own words go to the tooltip, and nothing names the system", () => {
  const out = html({ ...base, status: "offline", pending: 3, host: "http://127.0.0.1:8790", problem: { code: "unreachable", words: "The sharing server can't be reached. Your edits wait here and go out when it's back.", detail: "couldn't connect to the host: offline, unreachable, or the connection dropped" } });
  assert.match(out, /class="carton-share-offline" role="status" title="couldn&#x27;t connect to the host/, "the detail only in the title");
  assert.match(out, /<strong>You&#x27;re offline\.<\/strong> Keep editing: 3 changes are saved here and are sent when you&#x27;re back\./);
  assert.equal((out.match(/can&#x27;t be reached|couldn&#x27;t connect/g) ?? []).length, 1, "said once: the amber line, the detail in its title");
  assert.doesNotMatch(out, /carton-sync-detail|role="alert"/);
  assert.match(out, />Bob</, "You, with the name teammates see");
  assert.doesNotMatch(out, />[^<]*(Shared through|127\.0\.0\.1)[^<]*</, "the address isn't in the text");
  assert.match(html({ ...base, status: "offline", pending: 1, problem: null }), /Keep editing: 1 change is saved here and is sent when you&#x27;re back\./);
});

test("review of fix/ux2-b: an invite link is made once while it's being made, kept only until a minute before it expires, and made again after a failure", async () => {
  let now = 1_000_000_000_000, n = 0, answer = (i) => ({ link: "L" + i, expiresAt: now + 7 * 86_400_000 });
  const realNow = Date.now;
  Date.now = () => now;
  try {
    const bridge = { call: async (m) => { assert.equal(m, "liveInvite"); n++; const a = answer(n); if (a instanceof Error) throw a; return a; } };
    // the dialog's opening and a Copy link meanwhile: one invite
    const [a, b] = await Promise.all([ui.linkFor(bridge, "p", "h", "editor"), ui.linkFor(bridge, "p", "h", "editor")]);
    assert.deepEqual([a, b, n], ["L1", "L1", 1]);
    // another role, server or project: its own
    assert.equal(await ui.linkFor(bridge, "p", "h", "viewer"), "L2");
    assert.equal(await ui.linkFor(bridge, "p", "h2", "editor"), "L3");
    // reopened within the hour: the same link; after it, a new one
    now += 59 * 60_000;
    assert.equal(await ui.linkFor(bridge, "p", "h", "editor"), "L1");
    now += 2 * 60_000;
    assert.equal(await ui.linkFor(bridge, "p", "h", "editor"), "L4");
    // a server whose invites last 90 s: kept 30 s (a minute before it expires), then made again
    answer = (i) => ({ link: "S" + i, expiresAt: now + 90_000 });
    assert.equal(await ui.linkFor(bridge, "q", "h", "editor"), "S5");
    now += 20_000;
    assert.equal(await ui.linkFor(bridge, "q", "h", "editor"), "S5");
    now += 15_000;
    assert.equal(await ui.linkFor(bridge, "q", "h", "editor"), "S6");
    // no expiry said: never kept for the next opening
    answer = (i) => ({ link: "U" + i });
    assert.equal(await ui.linkFor(bridge, "r", "h", "editor"), "U7");
    assert.equal(await ui.linkFor(bridge, "r", "h", "editor"), "U8");
    // a failure isn't kept
    answer = () => new Error("fetch failed");
    await assert.rejects(ui.linkFor(bridge, "s", "h", "editor"));
    answer = (i) => ({ link: "F" + i, expiresAt: now + 86_400_000 });
    assert.equal(await ui.linkFor(bridge, "s", "h", "editor"), "F10");
  } finally { Date.now = realNow; }
});

test("review finding 3: an Invite or Open failure shows under its button, whatever field its words name", () => {
  const p = ui.shareProblem("fetch failed", "invite");
  const shown = render(React.createElement(ui.Problem, { error: p }));
  assert.match(shown, /role="alert"/);
  assert.match(shown, /Can&#x27;t reach this address/);
  // the Share form has a field for it: shown there, not twice
  assert.equal(render(React.createElement(ui.Problem, { error: p, fields: ["host"] })), "");
});

test("QA G24: the Share form's lead is DESIGN's: the originals of your video stay here, nothing more", () => {
  globalThis.localStorage = { getItem: () => null, setItem() {} };
  const form = render(React.createElement(ui.ShareForm, { projectId: "p", bridge: { call: async () => ({}), onEvent: () => () => {} }, onShared() {}, onClose() {} }));
  assert.match(form, />Edit together, live, with the whole history\. Teammates get preview copies of your video; the originals stay on this computer\.</);
  assert.doesNotMatch(form, /Audio and still images/);
});
