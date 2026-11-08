// The recording switch in the editor's page (fix/take5-names; CARTON_AGENT_NAME on Cardboard's process, README "Carton:
// settings for a recording"): the page asks the worker (`recording`) once, and with it on a teammate's "Claude 2" keeps
// its number in History's rows and the title bar's "… is here"; off, as in every normal run, the page is as before
// ("Claude"). The real carton-ui code (scripts/carton/ui.js with sync/ui.js, bundled as scripts/carton/build.js bundles
// it) on React 19 in happy-dom, loaded afresh for each answer (the switch is per page); its view model is
// @carton/react's mock, served by the real serveUi over the bridge's wire.
//   node --test scripts/carton/test/recording.test.js
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs"), os = require("os"), path = require("path"), { pathToFileURL } = require("url");

const ROOT = path.resolve(__dirname, "../../..");
const CARTON = path.join(ROOT, "carton");
const skip = !fs.existsSync(path.join(CARTON, "node_modules", "esbuild")) && "run `npm ci` in carton/";
// Never /tmp (a small shared tmpfs on the build box).
const OUT = path.join(process.env.CARTON_TEST_DIR ?? path.join(os.homedir(), "gfv-scratch", "carton", "windows-sync"), "recording");
const BUNDLE = path.join(OUT, "carton-ui.cjs");
const opt = { skip, timeout: 60_000 };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let React, client, act, win, createMockUi, serveUi;
test.before(async () => {
  if (skip) return;
  const esbuild = require(path.join(CARTON, "node_modules", "esbuild"));
  fs.mkdirSync(OUT, { recursive: true });
  await esbuild.build({
    bundle: true, format: "cjs", logLevel: "warning", absWorkingDir: CARTON, nodePaths: [path.join(CARTON, "node_modules")],
    platform: "browser", target: "chrome140", outfile: BUNDLE,
    stdin: { contents: 'export * from "./ui.js";\nimport "./sync/ui.js";\n', resolveDir: path.join(ROOT, "scripts", "carton"), loader: "js" },
    alias: { react: path.join(ROOT, "scripts", "carton", "react-shim.js") },
  });
  const { Window } = require(path.join(CARTON, "node_modules", "happy-dom"));
  win = new Window({ url: "http://localhost/", width: 1280, height: 800 });
  for (const k of ["window", "document", "navigator", "localStorage", "Node", "Element", "HTMLElement", "HTMLInputElement", "HTMLButtonElement", "HTMLDivElement", "SVGElement", "Text", "Event", "KeyboardEvent", "MouseEvent", "PointerEvent", "FocusEvent", "CustomEvent", "MutationObserver", "getComputedStyle", "requestAnimationFrame", "cancelAnimationFrame", "DOMParser", "ResizeObserver"])
    if (win[k] !== undefined) Object.defineProperty(globalThis, k, { value: win[k], configurable: true, writable: true });
  globalThis.matchMedia = win.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  React = require(path.join(CARTON, "node_modules", "react"));
  client = require(path.join(CARTON, "node_modules", "react-dom", "client"));
  act = React.act;
  window.__cartonReact = React;
  ({ createMockUi } = await import(pathToFileURL(path.join(CARTON, "packages", "react", "src", "mock.ts")).href));
  ({ serveUi } = await import(pathToFileURL(path.join(CARTON, "packages", "react", "src", "remote.ts")).href));
}, { timeout: 300_000 });
test.after(async () => { await win?.happyDOM.close(); });

const h = (...a) => React.createElement(...a);
const PROJECT = "p-rec";
const CLAUDE2 = { key: "human/Claude", kind: "human", name: "Claude 2" };

/** A page, its carton-ui loaded afresh (its own switch), over a bridge whose worker answers `recording` with `answer`. */
async function page(answer) {
  delete require.cache[require.resolve(BUNDLE)];
  const { CartonSide } = require(BUNDLE);
  const ui = createMockUi({ versions: 4 });
  ui.addVersion({ author: CLAUDE2, summary: "Added title “Hello?” and media “Hello.wav”" });
  const live = { shared: true, status: "up-to-date", pending: 0, peers: [{ actor: CLAUDE2 }] };
  const cmds = new Set(), evs = new Set(), servers = new Map(), reports = [], asked = [];
  const bridge = {
    projectId: PROJECT,
    projectName: "Weekend reel",
    call: async (method, [arg] = []) => {
      asked.push(method);
      if (method === "ui") {
        let s = servers.get(arg.client);
        if (!s) servers.set(arg.client, (s = serveUi(ui, (message) => queueMicrotask(() => { for (const f of [...evs]) f({ client: arg.client, message }); }))));
        s.receive(arg.message);
        return null;
      }
      if (method === "recording") return answer;
      if (method === "liveStatus") return structuredClone(live);
      return undefined;
    },
    onEvent: (f) => (evs.add(f), () => evs.delete(f)),
    onCommand: (f) => (cmds.add(f), () => cmds.delete(f)),
    command: (c) => { const ev = typeof c === "string" ? { action: c } : c; for (const f of [...cmds]) f(ev); },
    reportPanel: (panel, l, chip) => reports.push({ panel, live: l ?? null, ...chip }),
    preview: async () => {},
  };
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = client.createRoot(container);
  await act(async () => { root.render(h(CartonSide, { projectId: PROJECT, bridge })); await sleep(20); });
  await act(async () => { await sleep(20); });
  await act(async () => { bridge.command("carton-history"); await sleep(60); });
  await act(async () => { await sleep(20); });
  // the name the row shows (ActorName's short part; its long part, the whole name, only shows on hover)
  const newestRow = () => {
    const meta = container.querySelector(".carton-version .carton-version-meta");
    return (meta?.querySelector(".carton-actor-name .carton-more-short") ?? meta?.querySelector(".carton-actor-name"))?.textContent ?? "";
  };
  return { asked, reports, newestRow, here: () => reports.filter((r) => r.live).at(-1)?.live?.here ?? null, done: async () => { await act(() => root.unmount()); container.remove(); } };
}

test("switch off (the worker answers { on: false }, as in every normal run): “Claude 2” is “Claude”, as before", opt, async () => {
  const p = await page({ on: false });
  try {
    assert.ok(p.asked.includes("recording"), "the page asked: " + p.asked.join(", "));
    assert.equal(p.here(), "Claude is here");
    assert.equal(p.newestRow(), "Claude");
  } finally { await p.done(); }
});

test("no answer (an older worker, or one that failed): as before", opt, async () => {
  const p = await page(undefined);
  try {
    assert.equal(p.here(), "Claude is here");
    assert.equal(p.newestRow(), "Claude");
  } finally { await p.done(); }
});

test("switch on (the worker answers { on: true }): “Claude 2” keeps its number in History's row and the title bar", opt, async () => {
  const p = await page({ on: true });
  try {
    assert.equal(p.here(), "Claude 2 is here");
    assert.equal(p.newestRow(), "Claude 2");
    // the first report that named anyone named them so: the switch was known before the first live status was drawn
    assert.equal(p.reports.find((r) => r.live?.here)?.live.here, "Claude 2 is here");
  } finally { await p.done(); }
});
