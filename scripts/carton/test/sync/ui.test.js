// The Share panel's "Live" section, rendered with React's server renderer (no app needed): when sync fails, the
// person reads why, in plain words and with the host's own message (H-SV), instead of "Syncing" for ever.
//   node --test scripts/carton/test/sync/ui.test.js
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs"), path = require("path");

const ROOT = path.resolve(__dirname, "../../../..");
const CARTON = path.join(ROOT, "carton");
// Never /tmp (a small shared tmpfs on the build box).
const OUT = path.join(process.env.CARTON_TEST_DIR ?? path.join(require("os").homedir(), "gfv-scratch", "carton", "windows-sync"), "ui-test");

let React, render, LiveStatus;
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
  ({ LiveStatus } = globalThis.window.__cartonSyncUi);
});

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
