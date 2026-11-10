// Tests for patch-carton.js, run under Node on Linux or Windows against Cardboard 1.4.0's own bundles. They are not
// in git: CARDBOARD_PRISTINE names a folder with app-asar/ (as `asar extract` gives it) and cli/. Without it the
// tests skip. Media import needs ffmpeg and ffprobe (CARDBOARD_FFMPEG / CARDBOARD_FFPROBE, or on PATH).
//   CARDBOARD_PRISTINE=… node --test --test-concurrency=1 scripts/carton/test/patches.test.js
// They check that:
// - with Carton off, the patched cb behaves as our Windows build does: the same output and the same files;
// - a .cbproj never carries .carton/ or Carton's view files, and carries anything else in .scratch/views/, with Carton
//   on or off;
// - with Carton on, every hook reaches the facade with the right arguments (a recording fake stands in for Carton);
// - the library worker runs patched, off and on: a GUI save, an agent's timeline.tsx, the carton RPC namespace.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs"), os = require("os"), path = require("path"), { spawnSync, execFileSync } = require("child_process");
const { stage, bundle } = require("./stage.js");
const S = require("./sync/support.js");

const PRISTINE = process.env.CARDBOARD_PRISTINE;
const skip = !PRISTINE || !fs.existsSync(path.join(PRISTINE ?? "", "app-asar")) ? "set CARDBOARD_PRISTINE to Cardboard 1.4.0's unpacked app and cli" : false;
const TMP = process.env.CARTON_TEST_DIR ?? path.join(os.tmpdir(), "carton-patch-tests");
const FAKE = path.join(__dirname, "fake-carton-node.cjs");

let win, carton, clip;
const env = (extra = {}) => ({ ...process.env, HOME: path.join(TMP, "home"), USERPROFILE: path.join(TMP, "home"), ...extra });
const cb = (cli, root, args, extra) => {
  const r = spawnSync(process.execPath, [path.join(cli, "cardboard.mjs"), "--root", root, "--json", ...args], { env: env(extra), encoding: "utf8", timeout: 120_000 });
  return { code: r.status, out: r.stdout + r.stderr };
};
// Ids, times and the library's path differ between two runs; nothing else may.
const norm = (s) => s
  .replace(/[\\/]lib-[a-z0-9-]+/g, "/LIB")
  .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, "UUID")
  .replace(/\b1[78]\d{11}\b/g, "REV")
  .replace(/\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d+Z/g, "TIME");

// One fixed session: create, import a clip, two applies (the second from the printed file, with its header), history,
// undo, verify. Returns every step's output.
const session = (cli, root, extra) => {
  fs.rmSync(root, { recursive: true, force: true });
  fs.mkdirSync(root, { recursive: true });
  const steps = [];
  const run = (...a) => steps.push(cb(cli, root, a, extra));
  run("project", "create", "Demo");
  run("media", "add", "Demo", clip);
  const edit1 = path.join(root, "..", path.basename(root) + "-edit1.tsx");
  fs.writeFileSync(edit1, 'export default (\n  <timeline aspect="16:9">\n    <track name="V1">\n      <clip src="clip.mp4" start={0} end={2} />\n    </track>\n    <track name="Titles">\n      <text start={0.5} end={2.5} fontSize={120} textContent="Hello" />\n    </track>\n  </timeline>\n);\n');
  run("source", "apply", "Demo", edit1);
  const tsx = path.join(root, "Demo.cardboard", "timeline.tsx"), edit2 = edit1.replace("edit1", "edit2");
  fs.writeFileSync(edit2, fs.readFileSync(tsx, "utf8").replace("fontSize={120}", "fontSize={140}"));
  run("source", "apply", "Demo", edit2);
  run("history", "Demo");
  run("undo", "Demo");
  run("verify", "Demo");
  return steps;
};
const files = (root) => Object.fromEntries(["project.json", "timeline.tsx", "AGENTS.md", "timeline.d.ts"].map((f) => [f, norm(fs.readFileSync(path.join(root, "Demo.cardboard", f), "utf8"))]));
const zipNames = (file) => {
  // A .cbproj is a stored zip: read the central directory's names.
  const b = fs.readFileSync(file), names = [];
  for (let i = b.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06])), o = b.readUInt32LE(i + 16), n = b.readUInt16LE(i + 10); n-- > 0;) {
    const len = b.readUInt16LE(o + 28), extra = b.readUInt16LE(o + 30), comment = b.readUInt16LE(o + 32);
    names.push(b.toString("utf8", o + 46, o + 46 + len));
    o += 46 + len + extra + comment;
  }
  return names.sort();
};
const fakeLog = (name) => {
  const file = path.join(TMP, name + ".log");
  fs.rmSync(file, { force: true });
  return { file, read: () => (fs.existsSync(file) ? fs.readFileSync(file, "utf8").trim().split("\n").map((l) => JSON.parse(l)) : []) };
};
const withFake = (log) => ({ CARDBOARD_CARTON: "1", CARTON_DIR: path.dirname(FAKE), FAKE_CARTON_LOG: log.file });

test.before(() => {
  if (skip) return;
  fs.mkdirSync(path.join(TMP, "home"), { recursive: true });
  win = stage(PRISTINE, path.join(TMP, "win"));
  carton = stage(PRISTINE, path.join(TMP, "carton"), { carton: true });
  // The fake is loaded as carton-node.cjs from CARTON_DIR.
  fs.copyFileSync(FAKE, path.join(path.dirname(FAKE), "carton-node.cjs"));
  clip = path.join(TMP, "clip.mp4");
  if (!fs.existsSync(clip)) execFileSync(process.env.CARDBOARD_FFMPEG ?? "ffmpeg", ["-loglevel", "error", "-f", "lavfi", "-i", "testsrc=size=320x180:rate=30", "-f", "lavfi", "-i", "sine=frequency=440", "-t", "3", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", clip]);
});
test.after(() => fs.rmSync(path.join(path.dirname(FAKE), "carton-node.cjs"), { force: true }));

test("Carton off: cb's output and files are the Windows build's", { skip }, () => {
  const a = session(win.cli, path.join(TMP, "lib-win")), b = session(carton.cli, path.join(TMP, "lib-off"), { CARDBOARD_CARTON: "0" });
  assert.deepEqual(a.map((s) => s.code), [0, 0, 0, 0, 0, 0, 0]);
  assert.deepEqual(b.map((s) => [s.code, norm(s.out)]), a.map((s) => [s.code, norm(s.out)]));
  assert.deepEqual(files(path.join(TMP, "lib-off")), files(path.join(TMP, "lib-win")));
});

test(".cbproj leaves out .carton/ and Carton's view files, and keeps everything else in .scratch/views/, on or off", { skip }, () => {
  const views = (files) => Object.keys(files).map((n) => ".scratch/views/" + n);
  for (const [name, extra] of [["off", { CARDBOARD_CARTON: "0" }], ["on", withFake(fakeLog("cbproj"))]]) {
    const root = path.join(TMP, "lib-cbproj-" + name);
    session(carton.cli, root, extra);
    const b = path.join(root, "Demo.cardboard");
    const put = (f, d) => (fs.mkdirSync(path.dirname(path.join(b, f)), { recursive: true }), fs.writeFileSync(path.join(b, f), d));
    for (const f of [".carton/carton.db", ".scratch/keep.tsx"]) put(f, "x");
    for (const [n, d] of Object.entries({ ...S.cartonViewFiles("agent-x"), ...S.ownViewFiles() })) put(".scratch/views/" + n, d);
    const out = path.join(TMP, name + ".cbproj");
    fs.rmSync(out, { force: true });
    assert.equal(cb(carton.cli, root, ["project", "save-as", "Demo", out], extra).code, 0);
    const names = zipNames(out);
    for (const n of [".scratch/keep.tsx", "project.json", ...views(S.ownViewFiles())]) assert.ok(names.includes(n), n + ": " + names.join(" "));
    for (const n of names) assert.ok(!n.startsWith(".carton/") && !views(S.cartonViewFiles("agent-x")).includes(n), n);
  }
});

test("Carton on: every cb hook reaches the facade", { skip }, () => {
  const log = fakeLog("cli"), root = path.join(TMP, "lib-on"), extra = withFake(log);
  const steps = session(carton.cli, root, extra);
  assert.deepEqual(steps.map((s) => s.code), [0, 0, 0, 0, 0, 0, 0]);
  const commits = log.read().filter((l) => l.what === "commit");
  // media add, apply, apply, undo: one change per mutation, each with the document it was applied to as its base.
  assert.equal(commits.length, 4);
  for (const c of commits) assert.ok(c.baseRev < c.docRev && c.actor === "cli" && c.bundle === "Demo.cardboard", JSON.stringify(c));
  // The second apply's file was printed at the first apply's version; the undo restores that version.
  assert.deepEqual(commits[2].meta, { source: "timeline", rev: commits[1].docRev, ownedFields: ["tracks", "timelineItems", "aspectRatio"] });
  assert.equal(commits[3].meta.source, "undo");
  assert.ok(log.read().filter((l) => l.what === "merge3").length === 2, "merge3 in place of rn for both applies");
  assert.ok(log.read().some((l) => l.what === "install" && l.file.endsWith("project.json")), "displace-then-install");
  // The Carton commands get the project as Cardboard resolves it, and head goes back into project.json after them.
  assert.deepEqual(JSON.parse(cb(carton.cli, root, ["carton-probe", "Demo"], extra).out), { probed: JSON.parse(fs.readFileSync(path.join(root, "Demo.cardboard", "project.json"), "utf8")).project.id });
  assert.deepEqual(log.read().filter((l) => l.what === "open" || l.what === "headProject").map((l) => [l.what, l.bundle]), [["open", "Demo.cardboard"], ["headProject", "Demo.cardboard"]]);
  // Off, undo --turn says it needs Carton rather than undoing something else.
  const off = cb(carton.cli, root, ["undo", "Demo", "--turn", "t-42"], { CARDBOARD_CARTON: "0" });
  assert.notEqual(off.code, 0);
  assert.match(off.out, /needs Carton/);
});

test("the library worker: Windows build, Carton off, Carton on", { skip }, () => {
  const seed = path.join(TMP, "lib-seed");
  session(win.cli, seed);
  const runWorker = (worker, name, extra) => {
    const root = path.join(TMP, "lib-worker-" + name);
    fs.rmSync(root, { recursive: true, force: true });
    fs.cpSync(seed, root, { recursive: true });
    const r = spawnSync(process.execPath, [path.join(__dirname, "worker-run.js"), worker, root], { env: env(extra), encoding: "utf8", timeout: 60_000 });
    assert.equal(r.status, 0, r.stderr);
    return JSON.parse(r.stdout.trim().split("\n").pop());
  };
  const expected = { guiSave: 150, watcher: ["timeline-applied"], after: 160 };
  assert.deepEqual(runWorker(win.worker, "win"), expected);
  assert.deepEqual(runWorker(carton.worker, "off", { CARDBOARD_CARTON: "0" }), expected);
  const log = fakeLog("worker");
  assert.deepEqual(runWorker(carton.worker, "on", withFake(log)), { ...expected, ping: "pong" });
  const commits = log.read().filter((l) => l.what === "commit");
  // The GUI save carries the editor's base and is the person's; the watched file is an outside agent's.
  assert.deepEqual([commits[0].actor, commits[0].meta.base], ["person", commits[0].baseRev]);
  assert.equal(commits[1].actor, "external:timeline.tsx");
  assert.equal(commits[1].meta.source, "timeline");
});

// Baseline P3-9 (final re-check N3): the stage's text editor opened inside a read-only preview and dropped what was
// typed. Both ways into it ask the bridge first (renderer-bridge.test.js: refused only in a Carton preview, with
// Cardboard's own note), and the store hands the bridge Cardboard's own guard of its edits, `me`: declared with the
// adopt the hook already passes (1.5.0: `const Ade=me,…,Mde=…;` right before it; 1.4.0's Ede, Rde), so the same binding. Each once, on the
// bundles as the build patches them (the Windows patches, then Carton's).
test("Carton on: the stage's text editor asks the bridge before it opens; the store hands over Cardboard's guard", { skip }, () => {
  const read = (re) => { const f = fs.readdirSync(carton.assets).find((n) => re.test(n)); return fs.readFileSync(path.join(carton.assets, f), "utf8"); };
  const editor = read(/^EditorRoute-.*\.js$/), store = read(/^installErrorTelemetry-.*\.js$/);
  const count = (s, t) => s.split(t).length - 1;
  assert.equal(count(editor, 'ue=o.useCallback(()=>{B&&B.type==="text"&&!pe&&!window.__carton?.refuse?.()&&(E(!1),T({kind:"edit-text"'), 1, "Enter on a selected title");
  assert.equal(count(editor, 'if(Pe&&(Pe.type==="text"||Pe.type==="caption")){if(window.__carton?.refuse?.())return;const{selectTimelineItem:$e,setEditingTextItemId:kt}'), 1, "a double-click on a title or caption");
  assert.equal(count(editor, "__carton?.refuse"), 2, "and nowhere else");
  // regress prod3: in a preview the stage's text and caption toolbars aren't shown (vn: what both are given); U is the
  // editor's store, whose state the bridge's adopt sets (cartonPreview), as the text toolbar itself reads it
  assert.equal(count(editor, "vn=B&&fe&&!p&&dt&&!pe&&!M&&!x&&!U.getState().cartonPreview?{item:B,bounds:fe,canvasRect:nt,scale:b.scale}:null"), 1, "the toolbars' props, none in a preview");
  assert.equal(count(editor, 'vn?.item.type==="caption"&&c.jsx(PB,{...vn}),vn?.item.type==="text"&&c.jsx(XB,{...vn})'), 1, "both toolbars render from it");
  const guard = store.indexOf("function me(){return Tv()?(_v(),!0):!1}const Ade=me,"), hook = store.indexOf("ne.setState=nN(");
  const between = store.slice(guard, hook);
  assert.ok(guard > 0 && hook > guard && between.includes(",Mde=t=>{") && between.endsWith(";") && between.length < 2000, "me and adopt (Mde) in one statement list, right before the hook");
  assert.equal(count(store, "deserialize:sv,projects:De,refuse:me,subscribe:ne.subscribe,clock:$x.get});"), 1, "the hook passes it, and the store's subscribe and playback clock (final re-check N5)");
  // $x (1.4.0's qx): the playback clock, a binding of the module itself (exported), declared before the hook runs
  assert.ok(/[,;]\$x=\{get:\(\)=>hg,set:/.test(store) && store.search(/[,;]\$x=\{get:/) < hook && /[{,]\$x as aK\b/.test(store), "$x is the module's own playback clock");
  assert.ok(store.includes("ne.subscribe((t,e)=>{t.playheadTime!==e.playheadTime&&$x.set(t.playheadTime)"), "Cardboard's own subscriber: (state, prev), the clock following playheadTime");
});

// Carton UX redesign PLAN 2.1: the title bar's cut chip goes before Cardboard's own "16:9 ⌄" (Bt) and the History and
// Share icons before "Report an issue" (Ut), from one anchor in the tab strip's editor controls (Wt), which matches
// once in Cardboard 1.4.0's strip as the Windows patch leaves it; main hands the strip the page's report through
// main-bridge's panel, and the chip's and Share's commands hand the editor's page the keyboard.
test("Carton on: the cut chip sits before the aspect ratio, the icons before Report an issue, each once; main relays the chip's report", { skip }, () => {
  const tabs = fs.readFileSync(path.join(carton.assets, fs.readdirSync(carton.assets).find((n) => /^tabs-.*\.js$/.test(n))), "utf8");
  const count = (s, t) => s.split(t).length - 1;
  const anchor = "n.jsx(Bt,{value:t.aspectRatio}),t.credits&&n.jsx(Ot,{credits:t.credits}),n.jsx(Ut,{}),";
  const plain = fs.readFileSync(path.join(win.assets, fs.readdirSync(win.assets).find((n) => /^tabs-.*\.js$/.test(n))), "utf8");
  assert.equal(count(plain, anchor), 1, "the anchor, once, in the strip as the Windows patch leaves it");
  assert.equal(count(tabs, "t.cartonPanel!==void 0&&n.jsx(__cbCartonCutChip,{panel:t.cartonPanel}),n.jsx(Bt,{value:t.aspectRatio}),t.credits&&n.jsx(Ot,{credits:t.credits}),t.cartonPanel!==void 0&&n.jsx(__cbCartonStrip,{panel:t.cartonPanel}),n.jsx(Ut,{}),"), 1);
  assert.equal(count(tabs, "n.jsx(__cbCartonCutChip,"), 1, "the chip once");
  assert.equal(count(tabs, "n.jsx(__cbCartonStrip,"), 1, "the icons once");
  assert.ok(tabs.includes("function __cbCartonCutChip(") && tabs.includes("function __cbCartonStrip("), "with their code");
  // QA G4: the editor controls' row may shrink, so the chip (min-w-0 shrink) gives way before the window's buttons do
  assert.equal(count(plain, 'className:"mr-[8px] ml-2 flex shrink-0 items-center gap-[8px] self-center"'), 1, "the row's class, once");
  assert.equal(count(tabs, 'className:"mr-[8px] ml-2 flex min-w-0 shrink items-center gap-[8px] self-center"'), 1, "the row may shrink");
  assert.equal(count(tabs, "flex shrink-0 items-center gap-[8px] self-center"), 0);
  // laptop P2-3: the tabs keep room for one project tab whole and "+", and never run on under "+" (the list scrolls)
  assert.equal(count(tabs, 'pl-[max(6px,var(--desktop-controls-inset)_+_4px)]",style:{minWidth:"min-content"},children:['), 1, "the tabs area takes what its parts need");
  assert.equal(count(tabs, 'n.jsxs("div",{ref:l,style:{...Ue(d),contain:"inline-size",minWidth:k?"calc(8rem + 32px)":void 0},onWheel:Ge,'), 1, "the project tabs' list: one tab and \"+\" at least");
  assert.equal(count(tabs, 'className:"flex min-w-0 items-center gap-[2px]",style:{minWidth:y.length?`calc(${y.length} * 8rem + ${(y.length-1)*2}px)`:void 0},'), 1, "the tabs never under their 8rem");
  assert.equal(count(plain, 'n.jsx(fn,{})'), 1, "\"+\" is fn, after the tabs in that list");
  assert.ok(plain.includes('fn=()=>n.jsx("button",{type:"button","aria-label":"New project"'), "fn is New project");
  assert.ok(plain.includes('className:"flex max-w-56 min-w-32 flex-1 basis-52 items-center"'), "a tab is 8rem at least (min-w-32)");
  assert.equal(count(tabs, 'className:w(W,"ml-[2px] w-[28px] shrink-0 justify-center",K),style:{width:28},children:n.jsx(We,'), 1, "\"+\" 28 px wide, as its class means");
  // Bt is the aspect ratio chip and Ut Report an issue, as the strip names them
  assert.ok(/Bt=\(\{value:e\}\)=>\{[\s\S]{0,1600}"aria-label":"Aspect ratio"/.test(plain) || plain.includes('"data-analytics":"strip-aspect-ratio"'), "Bt is the aspect ratio's");
  assert.ok(plain.includes('Ut=()=>n.jsxs("button",{type:"button","aria-label":"Report an issue"'), "Ut is Report an issue");
  const main = fs.readFileSync(carton.main, "utf8");
  assert.equal(count(main, '_e.handle("carton:panel",(t,r)=>{__cartonMain.on&&fe.__cartonPanel(r.sender,__cartonMain.panel(t))})'), 1);
  assert.equal(count(main, "if(__cartonMain.on&&/^carton-/.test(t?.action??\"\")){__cartonMain.takesKeys(t.action)&&r.focus();_e.emit(r,\"carton:command\",__cartonMain.command(t));return}"), 1);
  // main's own command handler, where it sends the active tab's webContents (r) the strip's commands
  assert.ok(main.includes("activeContents(){return this.model.activeView()?.webContents??null}"), "r is the active tab's webContents");
});

// Carton UX redesign Workstream 1 (PLAN 1.4–1.6), on the bundles as the build patches them: each new anchor once, and
// Cardboard's own refusal code (1.5.0's km, fre, Tv, _v, me; 1.4.0's Tm, ure, _v, xv, me, as the patched store has them) run against the real renderer
// bridge. In a Carton preview every edit its guard refuses (Delete, a drag or trim, Ctrl+Z, Enter on a title) is still
// refused, with the page's edit-attempt toast in place of its note; with no Carton part listening, its note, in Carton's
// words; with Carton off, or outside a preview (an agent's lock), Cardboard's own note, unchanged.
test("PLAN 1.4–1.6: the refusal asks Carton first only in a preview, the timeline's wrapper and Export's two opens, each once", { skip }, () => {
  const read = (dir, re) => fs.readFileSync(path.join(dir, fs.readdirSync(dir).find((n) => re.test(n))), "utf8");
  const editor = read(carton.assets, /^EditorRoute-.*\.js$/), store = read(carton.assets, /^installErrorTelemetry-.*\.js$/), index = fs.readFileSync(bundle(carton.assets, "index"), "utf8");
  const plain = { editor: read(win.assets, /^EditorRoute-.*\.js$/), store: read(win.assets, /^installErrorTelemetry-.*\.js$/), index: fs.readFileSync(bundle(win.assets, "index"), "utf8") };
  const count = (s, t) => s.split(t).length - 1;
  // the anchors, once each in the bundles as the Windows patches leave them
  assert.equal(count(plain.store, "function _v(){const t=ne.getState(),e=fre(t);"), 1);
  assert.equal(count(plain.editor, 'c.jsx("div",{className:"contents","data-analytics-region":"editor-timeline",children:c.jsx(xZ,{})})'), 1);
  assert.equal(count(plain.editor, "vZ=e=>{U.getState().setIsPlaying(!1),"), 1);
  assert.equal(count(plain.index, '"export.start":async e=>{const t=Es();if(t.isExporting)'), 1);
  // and patched, once each
  assert.equal(count(store, "function _v(){const t=ne.getState();if(t.cartonPreview&&window.__carton.blocked())return;const e=fre(t);"), 1);
  assert.equal(count(editor, 'c.jsx(__cbCartonTimeline,{className:"contents","data-analytics-region":"editor-timeline",children:c.jsx(xZ,{})})'), 1);
  assert.equal(count(editor, '"data-analytics-region":"editor-timeline"'), 1, "the timeline's region is that one");
  assert.ok(editor.includes("function __cbCartonTimeline(props)"), "with its code");
  assert.equal(count(editor, "vZ=(e,__again)=>{const __b=!__again&&window.__carton?.beforeExport?.();if(__b){__b.then(()=>vZ(e,!0),()=>{});return}U.getState().setIsPlaying(!1),"), 1);
  // vZ (1.4.0's sZ) is Export's: the EXPORT command calls it, and it opens the Export dialog's store
  assert.ok(editor.includes("tn(Vt.EXPORT,o.useCallback(()=>vZ(e),[e]))") && /vZ=\(e,__again\)=>\{[^]{0,420}Ao\.getState\(\)\.open\(\)\}/.test(editor), "vZ opens Export");
  assert.equal(count(index, '"export.start":async e=>{const __b=window.__carton?.beforeExport?.();__b&&await __b;const t=Es();if(t.isExporting)'), 1);
  // every edit path named in the plan goes through Cardboard's guard me() before it writes
  for (const a of ["removeTimelineItems:(n,r)=>{if(me()", "updateTimelineItems:(n,r)=>{if(me()", "updateTimelineItem:(n,r,i)=>{if(me()", "commitReorder:()=>{if(me()", "undo:()=>{if(window.__carton.undo())return;if(me())return;"])
    assert.equal(count(store, a), 1, a);
  assert.ok(store.includes("isWriteBlocked:km,onAcceptedDocumentWrite:iN,onRejectedWrite:_v"), "the gated setter's refusals go through xv too");
  // Cardboard's refusal code, as patched, against the real bridge (renderer-bridge.js)
  const tm = store.match(/[,;]km=(t=>!!t\.cartonPreview\|\|sh\(\)\|\|t\.timelineLockState!=="unlocked"\|\|!!t\.projectId&&hv\(t\.projectId\)),iN=/)[1];
  const from = store.indexOf("const dre=1800,"), to = store.indexOf("function me(){return Tv()?(_v(),!0):!1}") + "function me(){return Tv()?(_v(),!0):!1}".length;
  assert.ok(from > 0 && to > from && to - from < 1500, "the refusal's code, in one piece");
  const run = (enabled, start) => {
    const w = {};
    new Function("window", require("../renderer-bridge.js"))(w);
    let state = { projectId: "p1", cartonPreview: null, timelineLockState: "unlocked", tracks: [], timelineItems: [], ...start };
    const ne = { getState: () => state, setState: (p) => { state = { ...state, ...p }; } };
    w.__carton.store({ state: () => state, raw: (p) => ne.setState(p), adopt: (p) => ne.setState(p), armed: () => false, flush: async () => {}, invoke: async (_c, { method }) => (method === "enabled" ? enabled : method === "checkout" || method === "head" ? { id: "p1", tracks: [], timelineItems: [], aspectRatio: "16:9" } : null), on: () => () => {}, deserialize: (d) => d, projects: { getState: () => ({ projects: [] }), setState() {} } });
    // (1.5.0's names: km, sh, hv, Sd, _v; 1.4.0's Tm, ah, mv, kd, xv)
    const g = new Function("ne", "sh", "hv", "window", `const km=${tm};let Sd=null;${store.slice(from, to)};return {me,xv:_v};`)(ne, () => false, () => false, w);
    return { w, g, state: () => state, set: (p) => ne.setState(p) };
  };
  return (async () => {
    // Carton on, a preview: refused, and the page's part said it (no note of Cardboard's)
    const on = run(true);
    await on.w.__carton.ready;
    await on.w.__carton.preview("p1", "main@3");
    let told = 0;
    const off = on.w.__carton.onBlocked(() => (told++, true));
    for (const edit of ["Delete", "a drag", "a trim", "Ctrl+Z", "Enter on a title"]) assert.equal(on.g.me(), true, edit + " is refused");
    assert.equal(told, 5, "each told by the page");
    assert.equal(on.state().timelineInteractionFeedback, undefined, "and not by Cardboard's note");
    // nobody listening: Cardboard's note, in Carton's words
    off();
    assert.equal(on.g.me(), true);
    assert.equal(on.state().timelineInteractionFeedback?.message, on.w.__carton.previewMessage);
    // back to your edit: not refused at all
    on.set({ timelineInteractionFeedback: null });
    await on.w.__carton.preview("p1", null);
    assert.equal(on.g.me(), false, "your edit: nothing refused");
    // an agent's lock, Carton on: Cardboard's own note, and the page isn't asked
    on.w.__carton.onBlocked(() => (told++, true));
    on.set({ timelineLockState: "locked" });
    assert.equal(on.g.me(), true);
    assert.equal(on.state().timelineInteractionFeedback?.message, "Agent is editing. Timeline is read-only.");
    assert.equal(told, 5, "not asked outside a preview");
    // Carton off: Cardboard's own refusal, word for word
    const offc = run(false, { timelineLockState: "locked" });
    await offc.w.__carton.ready;
    offc.w.__carton.onBlocked(() => (told++, true));
    assert.equal(offc.g.me(), true);
    assert.equal(offc.state().timelineInteractionFeedback?.message, "Agent is editing. Timeline is read-only.");
    assert.equal(told, 5);
  })();
});

// The real facade, built from the carton workspace, on real Carton and carton.db: the cb commands end to end.
const WORKSPACE = path.join(__dirname, "..", "..", "..", "carton");
const noBuild = skip || (!fs.existsSync(path.join(WORKSPACE, "node_modules", "esbuild")) && "run `npm ci` in carton/ to build the facade");
test("Carton on, for real: history with authors, credits, cuts, fold, undo --turn, no lost update", { skip: noBuild }, async () => {
  const out = path.join(TMP, "bundle");
  fs.rmSync(out, { recursive: true, force: true });
  await require("../build.js").build(out, carton.assets);
  for (const f of ["carton-node.cjs", "engine-thread-main.js", "helper-main.js", "factory.js", "fmsv.cjs", "package.json"]) assert.ok(fs.existsSync(path.join(out, "carton", f)), f);
  assert.ok(fs.existsSync(path.join(carton.assets, "carton-ui.js")));
  const real = (actor) => ({ CARDBOARD_CARTON: "1", CARTON_DIR: path.join(out, "carton"), CARDBOARD_ACTOR: actor ?? "" });
  const root = path.join(TMP, "lib-real"), b = path.join(root, "Demo.cardboard");
  fs.rmSync(root, { recursive: true, force: true });
  const run = (actor, ...a) => { const r = cb(carton.cli, root, a, real(actor)); assert.equal(r.code, 0, a.join(" ") + "\n" + r.out); return r.out; };
  const json = (actor, ...a) => JSON.parse(run(actor, ...a).replace(/^\[carton\][^\n]*\n/gm, ""));
  run(null, "project", "create", "Demo");
  run(null, "media", "add", "Demo", clip);
  const edit = path.join(TMP, "real-edit.tsx");
  fs.writeFileSync(edit, 'export default (\n  <timeline aspect="16:9">\n    <track name="V1">\n      <clip src="clip.mp4" start={0} end={2} />\n    </track>\n    <track name="Titles">\n      <text name="Hello" start={0.5} end={2.5} fontSize={120} textContent="Hello" />\n    </track>\n  </timeline>\n);\n');
  assert.equal(json("director/chat1/turn1", "source", "apply", "Demo", edit).carton.status, "confirmed");
  fs.writeFileSync(edit, fs.readFileSync(path.join(b, "timeline.tsx"), "utf8").replace("fontSize={120}", "fontSize={140}"));
  json("director/chat1/turn2/sub-Explore-a1", "source", "apply", "Demo", edit);
  assert.ok(fs.existsSync(path.join(b, ".carton", "carton.db")));
  const textId = () => JSON.parse(fs.readFileSync(path.join(b, "project.json"), "utf8")).project.timelineItems.find((i) => i.type === "text");
  // A Director turn that ended takes a short name from its prompt, as History shows the chat's checkpoints.
  const named = spawnSync(process.execPath, ["-e", `
    const { cardboard14 } = require(${JSON.stringify(path.join(out, "carton", "carton-node.cjs"))});
    const w = cardboard14.worker({ library: { projects: { bundlePathFor: () => ${JSON.stringify(b)} } }, emit() {} });
    w.nameTurn({ projectId: "p", chat: "chat1", turn: "turn1", prompt: "Make the intro tighter. Then add a lower third." }).then((r) => console.log(JSON.stringify(r)));
  `], { env: env(), encoding: "utf8", timeout: 60_000 });
  assert.equal(JSON.parse(named.stdout.trim().split("\n").pop()).status, "named", named.stderr);
  assert.equal(json(null, "history", "Demo").versions.find((v) => v.by?.id === "director/chat1/turn1")?.name, "Make the intro tighter");
  // UX redesign 0.7: a running in-app turn shows in the project's History panels as working (one opened during it too),
  // with the changes it made so far, and no more once it ends
  const working = spawnSync(process.execPath, ["-e", `
    const { cardboard14 } = require(${JSON.stringify(path.join(out, "carton", "carton-node.cjs"))});
    const sent = [];
    const w = cardboard14.worker({ library: { projects: { bundlePathFor: () => ${JSON.stringify(b)}, read: async () => null } }, emit: (e) => e.kind === "carton" && sent.push(e.message) });
    (async () => {
      await w.working({ projectId: "p", chat: "chat1", provider: "director", actor: "director/chat1/turn3", actors: ["director/chat1/turn3"], prompt: "Add music under the interview. Then more.", since: Date.now() });
      await w.ui({ projectId: "p", client: "c1", message: { t: "hello" } });
      for (let i = 0; i < 100 && !sent.some((m) => m.t === "init"); i++) await new Promise((r) => setTimeout(r, 20));
      const init = sent.find((m) => m.t === "init");
      await w.working({ projectId: "p", chat: "chat1", done: true });
      for (let i = 0; i < 100 && !sent.some((m) => m.t === "topic" && m.topic === "working"); i++) await new Promise((r) => setTimeout(r, 20));
      const end = sent.find((m) => m.t === "topic" && m.topic === "working");
      console.log(JSON.stringify({ working: init?.topics?.working ?? null, after: end ? end.value : "none" }));
      process.exit(0);
    })().catch((e) => { console.error(e); process.exit(1); });
  `], { env: env(), encoding: "utf8", timeout: 60_000 });
  const shown = JSON.parse(working.stdout.trim().split("\n").pop());
  assert.deepEqual([shown.working?.actor?.name, shown.working?.label, shown.working?.edits, shown.after], ["Director", "Add music under the interview", 0, null], working.stderr);
  // The live-sync half's seam: an extension's services join the worker's namespace beside Carton's own (never replacing
  // one), it gets each project's open Carton and hears of every Carton opened, and one that throws is left out.
  const ext = spawnSync(process.execPath, ["-e", `
    const path = require("path");
    const { cardboard14, extend } = require(${JSON.stringify(path.join(out, "carton", "carton-node.cjs"))});
    const heard = [];
    let api;
    extend({ worker: (a) => ({ hello: async () => ((await a.carton("p"))?.carton ? "open" : "none"), ping: async () => "replaced", "bad-name": async () => 1 }) });
    extend({ worker: (a) => { api = a; a.onOpen((b) => heard.push("live:" + path.basename(b))); return {}; } });
    extend({ worker: () => { throw new Error("broken"); } });
    const w = cardboard14.worker({ library: { projects: { bundlePathFor: () => ${JSON.stringify(b)} } }, emit() {} });
    (async () => {
      const r = { hello: await w.hello(), ping: await w.ping(), bad: "bad-name" in w };
      await new Promise((r) => setTimeout(r, 50));
      api.onOpen((b) => heard.push("late:" + path.basename(b)));
      await new Promise((r) => setTimeout(r, 50));
      console.log(JSON.stringify({ ...r, heard }));
    })().catch((e) => { console.error(e); process.exit(1); });
  `], { env: env(), encoding: "utf8", timeout: 60_000 });
  assert.deepEqual(JSON.parse(ext.stdout.trim().split("\n").pop()), { hello: "open", ping: "pong", bad: false, heard: ["live:Demo.cardboard", "late:Demo.cardboard"] }, ext.stderr);
  assert.match(ext.stderr, /an extension failed to start: broken/);
  // Every helper Carton starts for a project (a lease holder, for a shared cut) opens carton.db with the worker's own
  // adapter and schema: openLocal hands it this bundle's helper-main.js and factory.js; that factory opens the worker's
  // carton.db to the same schema and head; the real helper opens it and exits clean; and from the library worker (an
  // Electron utility process, where the binary is the app's) its spawn runs the binary as Node.
  const helper = spawnSync(process.execPath, ["-e", `
    const fs = require("fs"), path = require("path"), crypto = require("crypto"), cp = require("child_process"), url = require("url");
    const dir = ${JSON.stringify(path.join(out, "carton"))}, bundle = ${JSON.stringify(b)};
    const { internals: I } = require(path.join(dir, "carton-node.cjs"));
    const canon = (v) => JSON.stringify(v, (_k, x) => (x && typeof x === "object" && !Array.isArray(x) ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => (a < b ? -1 : 1))) : x));
    const sha = (t) => crypto.createHash("sha256").update(t).digest("hex");
    (async () => {
      const r = {}, w = await I.local(bundle);
      r.paths = [path.relative(dir, I.helper.entry), path.relative(dir, I.helper.factory)];
      const { createHolderEngine } = await import(url.pathToFileURL(I.helper.factory).href);
      const h = await createHolderEngine({ dbPath: w.dbPath, config: { projectDir: bundle } });
      const head = await h.engine.carton.head();
      r.same = { schema: sha(canon(h.engine.carton.schema)) === w.schema, ref: canon(head.ref) === w.ref, doc: sha(canon(head.doc)) === w.doc };
      await h.close();
      await h.store.close();
      // The real helper, as spawnHelper starts it (here not detached, with a short idle time).
      const run = cp.spawnSync(process.execPath, [I.helper.entry, "--db", w.dbPath, "--seen", "-", "--factory", I.helper.factory, "--config", JSON.stringify({ projectDir: bundle }), "--idle-ms", "300"], { timeout: 30000 });
      const log = (() => { try { return fs.readFileSync(path.join(path.dirname(w.dbPath), "helper.log"), "utf8"); } catch { return ""; } })();
      const mine = log.split("\\n").filter(Boolean).map((l) => JSON.parse(l)).filter((e) => e.pid === run.pid);
      r.helper = { status: run.status, errors: mine.filter((e) => e.type === "error").map((e) => String(e.error).split("\\n")[0]), lease: mine.some((e) => e.type === "lease") };
      // In the worker: the app's binary, without ELECTRON_RUN_AS_NODE.
      const real = cp.spawn;
      let seen = null;
      process.versions.electron = "39.0.0";
      delete process.env.ELECTRON_RUN_AS_NODE;
      cp.spawn = (cmd, args, o) => ((seen = { cmd, args, env: o.env }), { unref() {}, pid: 0 });
      I.helper.spawn({ dbPath: w.dbPath, factory: I.helper.factory });
      cp.spawn = real;
      r.worker = { asNode: seen?.env?.ELECTRON_RUN_AS_NODE === "1", entry: seen?.args?.[0] === I.helper.entry, factory: seen?.args?.[seen.args.indexOf("--factory") + 1] === I.helper.factory };
      console.log(JSON.stringify(r));
      process.exit(0);
    })().catch((e) => { console.error(e); process.exit(1); });
  `], { env: env(), encoding: "utf8", timeout: 120_000 });
  assert.deepEqual(JSON.parse(helper.stdout.trim().split("\n").pop() || "{}"), {
    paths: ["helper-main.js", "factory.js"],
    same: { schema: true, ref: true, doc: true },
    helper: { status: 0, errors: [], lease: true },
    worker: { asNode: true, entry: true, factory: true },
  }, helper.stderr);
  // History: every version, with who made it down to the subagent.
  const by = json(null, "history", "Demo").versions.map((v) => v.by?.id ?? null);
  assert.deepEqual(by.slice(0, 2), ["director/chat1/turn2/sub-Explore-a1", "director/chat1/turn1"]);
  assert.equal(json(null, "credits", "Demo", textId().id).by.id, "director/chat1/turn2/sub-Explore-a1");
  // A cut: project.json follows the switch, the cut's edit stays on it, and folds back in.
  run(null, "cut", "new", "Demo", "30s cut");
  run(null, "cut", "switch", "Demo", "30s cut");
  fs.writeFileSync(edit, fs.readFileSync(path.join(b, "timeline.tsx"), "utf8").replace("fontSize={140}", "fontSize={90}"));
  json("codex/c7", "source", "apply", "Demo", edit);
  assert.equal(textId().fontSize, 90);
  run(null, "cut", "switch", "Demo", "Main cut");
  assert.equal(textId().fontSize, 140);
  run(null, "fold", "Demo", "30s cut");
  assert.equal(textId().fontSize, 90);
  // Undoing turn2 after the fold changed the same size again: a card, nothing lost.
  // (cb says so with exit code 1: a card is waiting.)
  const u = cb(carton.cli, root, ["undo", "Demo", "--turn", "turn2"], real("director/chat1/turn3"));
  assert.equal(JSON.parse(u.out.replace(/^\[carton\][^\n]*\n/gm, "")).status, "conflicts", u.out);
  assert.equal(textId().fontSize, 90);
  // An agent's timeline.tsx save that nothing applied yet (the app isn't running) is moved aside by the next cb
  // write's regeneration of the file, then applied as the agent's (1.4.0 overwrote it).
  fs.writeFileSync(path.join(b, "timeline.tsx"), fs.readFileSync(path.join(b, "timeline.tsx"), "utf8").replace(/fontSize=\{\d+\}/, "fontSize={77}"));
  run(null, "project", "rename", "Demo", "Demo cut");
  assert.equal(textId().fontSize, 77);
  // Nothing foreign is left aside: anything still in .carton/displaced is a state Carton wrote, waiting out its hold.
  const seen = new Set(Object.values(JSON.parse(fs.readFileSync(path.join(b, ".carton", "seen.json"), "utf8"))).flat());
  const dir = path.join(b, ".carton", "displaced");
  for (const n of fs.existsSync(dir) ? fs.readdirSync(dir) : []) assert.ok(seen.has(require("crypto").createHash("sha256").update(fs.readFileSync(path.join(dir, n))).digest("hex")), "foreign file left: " + n);
  // cb undo <rev> with a 1.4.0 rev (as cb history printed before Carton, or a timeline header) reaches that version.
  // (the project's rev: with Carton on the timeline's header is Carton's own, laptop #2)
  const header = JSON.parse(fs.readFileSync(path.join(b, "project.json"), "utf8")).project.stateUpdatedAt;
  assert.ok(header > 1e12);
  const undoRev = cb(carton.cli, root, ["undo", "Demo cut", String(header)], real());
  assert.equal(undoRev.code, 0, undoRev.out);
  // A GUI save through the real worker: the editor's lossy serializer dropped the clip's autoReframe and rounded its
  // times, but only the person's edit lands; Carton off (1.4.0) loses autoReframe (B10).
  const gui = (name, extra) => {
    const r2 = path.join(TMP, "lib-real-gui-" + name);
    fs.rmSync(r2, { recursive: true, force: true });
    fs.cpSync(root, r2, { recursive: true });
    fs.rmSync(path.join(r2, "Demo.cardboard", ".carton"), { recursive: true, force: true });
    const g = spawnSync(process.execPath, [path.join(__dirname, "worker-run.js"), carton.worker, r2], { env: env({ LOSSY: "1", ...extra }), encoding: "utf8", timeout: 120_000 });
    assert.equal(g.status, 0, g.stderr);
    return JSON.parse(g.stdout.trim().split("\n").pop());
  };
  const on = gui("on", { ...real(), STALE: "1", UNDO: "1", PANEL: "1" }), off = gui("off", { CARDBOARD_CARTON: "0" });
  // The History panel shows the GUI save's card at once, and again when opened later.
  assert.ok(on.panel.live > 0 && on.panel.reopened > 0, JSON.stringify(on.panel));
  // Core's card has head as ours (160) and the person's edit as theirs (170); the panel shows the person's as mine.
  assert.deepEqual(on.sides, { mine: "170", theirs: "160" }, JSON.stringify(on));
  // Two kept cards for one field, both shown: resolving the first removes only it, and the other (180) stays shown.
  assert.equal(on.keptBefore, 2);
  assert.deepEqual(on.keptAfter, [180], JSON.stringify(on));
  assert.deepEqual(on.shownNext, ["180"], JSON.stringify(on));
  // A second panel resolving the card already resolved leaves the next one kept; an agent's card stays the agent's.
  assert.deepEqual(on.keptAfterOther, [180, 175], JSON.stringify(on));
  assert.deepEqual([on.legacyShown, on.legacyGone], [true, true], JSON.stringify(on));
  assert.deepEqual([on.agentCards > 0, on.panelHasAgent], [true, false], JSON.stringify(on));
  assert.equal(on.guiSave, 150);
  // A stale GUI save's clash keeps head (160) and a card for the person; ⌘Z then reaches project.json and the pages.
  assert.deepEqual([on.stale, on.cards > 0], [160, true], JSON.stringify(on));
  assert.deepEqual([on.undo, on.undone !== 150, on.announced], ["confirmed", true, true], JSON.stringify(on));
  assert.equal(on.video.autoReframe, true, JSON.stringify(on.video));
  assert.equal(off.video.autoReframe, undefined);
  // The install lock and the sweep, through the facade's internals.
  const locks = spawnSync(process.execPath, ["-e", `
    const fs = require("fs"), path = require("path");
    const { internals: I } = require(${JSON.stringify(path.join(out, "carton", "carton-node.cjs"))});
    const bundle = ${JSON.stringify(b)}, dir = path.join(bundle, ".carton", "install.lock"), out = {};
    (async () => {
      // A lock left by a process that is gone, silent for over 10 s: taken over.
      fs.mkdirSync(dir); fs.writeFileSync(path.join(dir, "owner"), JSON.stringify({ pid: 2 ** 22 + 7, me: "dead" }));
      const old = new Date(Date.now() - 20_000); fs.utimesSync(path.join(dir, "owner"), old, old);
      out.dead = await I.withInstallLock(bundle, async (mine) => mine());
      // A live holder (this process), even one silent for 20 s: waited for, never taken over.
      fs.mkdirSync(dir); fs.writeFileSync(path.join(dir, "owner"), JSON.stringify({ pid: process.pid, me: "live" }));
      fs.utimesSync(path.join(dir, "owner"), old, old);
      const t0 = Date.now();
      setTimeout(() => fs.rmSync(dir, { recursive: true, force: true }), 400);
      await I.withInstallLock(bundle, async () => {});
      out.waited = Date.now() - t0 >= 380;
      // A running pid silent for over a minute (Windows reuses pids): taken over.
      fs.mkdirSync(dir); fs.writeFileSync(path.join(dir, "owner"), JSON.stringify({ pid: process.pid, me: "reused" }));
      const older = new Date(Date.now() - 70_000); fs.utimesSync(path.join(dir, "owner"), older, older);
      const t1 = Date.now();
      out.reused = await I.withInstallLock(bundle, async (mine) => mine()) && Date.now() - t1 < 5000;
      // A file displaced a moment ago is not swept, even if Carton wrote it and its own mtime is old.
      const d = path.join(bundle, ".carton", "displaced"); fs.mkdirSync(d, { recursive: true });
      const f = path.join(d, "fresh-0"); fs.writeFileSync(f, "x"); fs.utimesSync(f, old, old);
      const j = I.readJournal(bundle); j["fresh-0"] = { at: Date.now(), stamp: "?" };
      await I.sweep(path.join(bundle, "project.json"), { mine: new Set() }, j);
      out.fresh = fs.existsSync(f);
      fs.rmSync(f);
      // An install of a state that is no longer head is skipped, and says so.
      const tmp = path.join(bundle, ".stale.tmp");
      fs.writeFileSync(tmp, JSON.stringify({ project: { stateUpdatedAt: 1700000000123 } }));
      await I.setRevFor(bundle, 1700000000123, { branchId: (await I.refOfRev(bundle, JSON.parse(fs.readFileSync(path.join(bundle, "project.json"), "utf8")).project.stateUpdatedAt)).branchId, seq: 0 });
      out.skipped = (await I.install(tmp, path.join(bundle, "project.json"))) === false && !fs.existsSync(tmp);
      // Taken over in the middle of an install (stalled for a minute): the successor's newer file goes back.
      const pj = path.join(bundle, "project.json"), cur = JSON.parse(fs.readFileSync(pj, "utf8"));
      const head = await I.refOfRev(bundle, cur.project.stateUpdatedAt);
      const oursRev = 1700000000201, theirsRev = 1700000000202;
      await I.setRevFor(bundle, oursRev, head);
      await I.setRevFor(bundle, theirsRev, { branchId: head.branchId, seq: head.seq + 1 });
      const ours = path.join(bundle, ".ours.tmp");
      fs.writeFileSync(ours, JSON.stringify({ ...cur, project: { ...cur.project, stateUpdatedAt: oursRev } }));
      // The successor installs (B) and frees the lock a moment later; with a third writer (C, newer still), C
      // installs before that. B goes back only if it is still the newest on disk.
      // "third": a third writer installs before the lock is freed. "slow": the successor's file is Carton's (in
      // seen.json) and the lock stays taken past the review. "external": someone else saves just before it is freed.
      // "busy": the lock stays taken past the put-back's wait, and the file moved aside is someone's save.
      const theirs = JSON.stringify({ ...cur, project: { ...cur.project, stateUpdatedAt: theirsRev } });
      const takeover = async (mode, [oRev, tRev] = [oursRev, theirsRev]) => {
        let fired = false;
        const busySave = JSON.stringify({ ...cur, project: { ...cur.project, name: "Busy successor", stateUpdatedAt: tRev } });
        fs.writeFileSync(ours, JSON.stringify({ ...cur, project: { ...cur.project, stateUpdatedAt: oRev } }));
        if (mode === "slow") await I.markSeen(pj, I.sha(Buffer.from(theirs)));
        I.testHooks.between = () => {
          if (fired) return;
          fired = true;
          I.testHooks.between = null;
          fs.writeFileSync(path.join(dir, "owner"), JSON.stringify({ pid: process.pid, me: "successor" }));
          fs.writeFileSync(pj, mode === "busy" ? busySave : theirs);
          setTimeout(() => {
            if (mode === "third") fs.rmSync(pj, { force: true }), fs.writeFileSync(pj, JSON.stringify({ ...cur, project: { ...cur.project, stateUpdatedAt: thirdRev } }));
            if (mode === "external") fs.rmSync(pj, { force: true }), fs.writeFileSync(pj, JSON.stringify({ ...cur, project: { ...cur.project, name: "Saved elsewhere", stateUpdatedAt: 1700000000250 } }));
            fs.rmSync(dir, { recursive: true, force: true });
          }, mode === "slow" ? 900 : mode === "busy" ? 1500 : 200);
        };
        I.testHooks.lockWaitMs = mode === "busy" ? 300 : null;
        const res = await I.install(ours, pj);
        I.testHooks.lockWaitMs = null;
        I.testHooks.between = null;
        return [res, JSON.parse(fs.readFileSync(pj, "utf8")).project.stateUpdatedAt];
      };
      const thirdRev = 1700000000203;
      await I.setRevFor(bundle, thirdRev, { branchId: head.branchId, seq: head.seq + 2 });
      const [r1, on1] = await takeover(), [r2, on2] = await takeover("third");
      out.putBack = r1 === false && on1 === theirsRev && r2 === false && on2 === thirdRev;
      // The file to put back survives a review that runs while the successor still holds the lock.
      const [r3, on3] = await takeover("slow");
      // A save made while the put-back waited is moved aside by it, then imported, not deleted as Carton's.
      const [r4, on4] = await takeover("external");
      let imported = false;
      for (let i = 0; i < 60 && !imported; i++) await new Promise((r) => setTimeout(r, 50)), (imported = (await I.headProject(bundle))?.name === "Saved elsewhere");
      // A put-back that can't get the lock back leaves what it would have put back to the review: someone's save is
      // imported (and it was journaled, for a sweep if this process had exited first).
      // Its revs are on head's cut now: the import above moved head.
      const now = JSON.parse((await I.local(bundle)).ref), busyRevs = [1700000000211, 1700000000212];
      await I.setRevFor(bundle, busyRevs[0], now);
      await I.setRevFor(bundle, busyRevs[1], { branchId: now.branchId, seq: now.seq + 1 });
      const [r5, on5] = await takeover("busy", busyRevs);
      let busy = false;
      for (let i = 0; i < 100 && !busy; i++) await new Promise((r) => setTimeout(r, 50)), (busy = (await I.headProject(bundle))?.name === "Busy successor");
      for (let i = 0; i < 100 && fs.existsSync(dir); i++) await new Promise((r) => setTimeout(r, 50));
      out.putBackLater = { slow: r3 === false && on3 === theirsRev, external: r4 === false && on4 === theirsRev, imported, busy: r5 === false && on5 === busyRevs[0] && busy };
      // A save that lands just after an install, before Carton notes what it installed, isn't taken for Carton's: the
      // next install moves it aside and it is imported, not deleted as Carton's.
      const later = path.join(bundle, ".later.tmp"), afterSave = JSON.stringify({ ...cur, project: { ...cur.project, name: "Saved after install", stateUpdatedAt: 1700000000301 } });
      I.testHooks.installed = (f) => { I.testHooks.installed = null; fs.writeFileSync(f + ".x", afterSave); fs.renameSync(f + ".x", f); };
      for (const rev of [1700000000302, 1700000000303]) fs.writeFileSync(later, JSON.stringify({ ...cur, project: { ...cur.project, stateUpdatedAt: rev } })), await I.install(later, pj);
      out.ownAfter = false;
      for (let i = 0; i < 100 && !out.ownAfter; i++) await new Promise((r) => setTimeout(r, 50)), (out.ownAfter = (await I.headProject(bundle))?.name === "Saved after install");
      fs.rmSync(dir, { recursive: true, force: true });
      // A rename of seen.json or displaced.json that fails (a file kept busy past the retry budget on Windows; here a
      // folder in its place) fails the install: every busy-file call is awaited, so none fails unnoticed.
      // Kept cards are told apart as the panel tells them apart: a missing value isn't null; key order doesn't count.
      out.cardsApart = !I.sameCard({ path: "a", ours: undefined, theirs: 1 }, { path: "a", ours: null, theirs: 1 }) && I.sameCard({ path: "a", ours: { x: 1, y: 2 }, theirs: 1 }, { path: "a", ours: { y: 2, x: 1 }, theirs: 1 });
      out.surfaced = {};
      for (const [k, name] of ["seen.json", "displaced.json"].entries()) {
        const at = path.join(bundle, ".carton", name), saved = fs.existsSync(at) ? fs.readFileSync(at) : null;
        fs.rmSync(at, { force: true });
        fs.mkdirSync(at);
        const t = path.join(bundle, ".fail.tmp");
        fs.writeFileSync(t, JSON.stringify({ ...cur, project: { ...cur.project, stateUpdatedAt: 1700000000300 + k } }));
        out.surfaced[name] = await I.install(t, pj).then(() => "resolved", (e) => (e?.code ? "rejected" : "rejected: " + e));
        fs.rmSync(at, { recursive: true, force: true });
        if (saved) fs.writeFileSync(at, saved);
        fs.rmSync(t, { force: true });
      }
      fs.writeFileSync(pj, JSON.stringify(cur));
      console.log(JSON.stringify(out));
    })().catch((e) => { console.error(e); process.exit(1); });
  `], { env: env(), encoding: "utf8", timeout: 60_000 });
  assert.deepEqual(JSON.parse(locks.stdout.trim().split("\n").pop()), { dead: true, waited: true, reused: true, fresh: true, skipped: true, putBack: true, putBackLater: { slow: true, external: true, imported: true, busy: true }, ownAfter: true, cardsApart: true, surfaced: { "seen.json": "rejected", "displaced.json": "rejected" } }, locks.stderr);
  // Four agents at once on different titles: none loses its last edit (B1).
  const wroot = path.join(TMP, "lib-real-writers");
  fs.rmSync(wroot, { recursive: true, force: true });
  const w = (...a) => spawnSync(process.execPath, [path.join(__dirname, "..", "writers.js"), ...a], { env: env(real()), encoding: "utf8", timeout: 300_000 });
  assert.equal(w("setup", path.join(carton.cli, "cardboard.mjs"), wroot).status, 0);
  const r = w("run", path.join(carton.cli, "cardboard.mjs"), wroot, "--writers", "4", "--rate", "2", "--seconds", "15");
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /no lost updates/);
});
