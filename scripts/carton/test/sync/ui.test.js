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

test("a host too old for the app: the words say it needs an update, then the host's own message", () => {
  const detail = "this client's documents are schema version 2, newer than this server accepts (up to 1): update the server";
  const out = html({ ...base, problem: { code: "update-server", words: "The host is older than this app: it needs an update before this project can sync.", detail } });
  assert.match(out, /role="alert"/);
  assert.match(out, /data-code="update-server"/);
  assert.match(out, /needs an update before this project can sync/);
  assert.match(out, /class="carton-sync-detail[^"]*">this client&#x27;s documents are schema version 2, newer than this server accepts \(up to 1\): update the server</);
});

test("no problem: no alert; a problem without a message of its own shows the words once", () => {
  assert.doesNotMatch(html({ ...base, status: "up-to-date", problem: null }), /role="alert"/);
  const out = html({ ...base, problem: { code: "unreachable", words: "The host can't be reached.", detail: null } });
  assert.match(out, /role="alert"/);
  assert.doesNotMatch(out, /carton-sync-detail/);
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
  assert.match(form, /The address whoever runs your sharing server gave you\./);
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

test("PLAN 8.1: People: You with the name teammates see and your role, then everyone here with what they're doing", () => {
  const st = { ...base, status: "up-to-date", name: "Vikas", role: "owner", peers: [
    { actor: { key: "human/leo", kind: "human", id: "leo", name: "Leo" }, activity: "Editing captions", idle: false },
    { actor: { key: "human/mia", kind: "human", id: "mia", name: "Mia" }, activity: null, idle: true },
    { actor: { key: "agent/director/leo", kind: "agent", id: "director", name: "Director" }, activity: "Working on “Add a title card”", idle: false },
  ] };
  const out = render(React.createElement(ui.People, { st }));
  const rows = [...out.matchAll(/<li class="carton-share-person"[^>]*>([\s\S]*?)<\/li>/g)].map((m) => m[1].replace(/<[^>]+>/g, "|").replace(/\|+/g, "|"));
  assert.deepEqual(rows, ["|V|You|Vikas · here now|Owner|", "|L|Leo|Here now · editing captions|", "|M|Mia|Here, not editing|", "|D|Director|Here now · working on “Add a title card”|"]);
  assert.match(out, /data-you=""/);
  assert.match(out, /data-here=""/, "who is here wears the green ring");
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

test("review finding 3: an Invite or Open failure shows under its button, whatever field its words name", () => {
  const p = ui.shareProblem("fetch failed", "invite");
  const shown = render(React.createElement(ui.Problem, { error: p }));
  assert.match(shown, /role="alert"/);
  assert.match(shown, /Can&#x27;t reach this address/);
  // the Share form has a field for it: shown there, not twice
  assert.equal(render(React.createElement(ui.Problem, { error: p, fields: ["host"] })), "");
});

test("review finding 8: the Share form doesn't claim every original stays here: audio and stills go as they are", () => {
  globalThis.localStorage = { getItem: () => null, setItem() {} };
  const form = render(React.createElement(ui.ShareForm, { projectId: "p", bridge: { call: async () => ({}), onEvent: () => () => {} }, onShared() {}, onClose() {} }));
  assert.match(form, /Teammates get preview copies of your video; the originals stay on this computer\. Audio and still images go as they are\./);
});
