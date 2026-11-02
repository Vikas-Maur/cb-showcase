// The facade's save path (scripts/carton/carton-node.js) as shipped, on a local cut, with a real project cb made, run
// in a child process (Carton's handles stay open in the process that opens them). Review round 3:
//   #1 a save that changed nothing of its own but was rebased (head moved on in other fields) gets head, never the
//      writer's older document;
//   #2 a stale save whose merge clashes keeps its other edits; the clash becomes a card, head's value stays;
//   #6 a signed media URL goes onto the configured origin whole (scheme too), never http where the app said https;
//   #7 one host media client per project from one share to the next (media fd87449), let go on the facade's release.
// Laptop #2 (agents' cb edits overwrote each other): a cb edit made on an older version that core takes without a
//   rebase (nothing in it overlaps what landed since) gets head back for project.json, never the writer's document,
//   which lacks what landed since (the next print showed those older values under the newer version's rev, and the
//   next apply committed them back); so does one with nothing of its own.
// H8's save path: a GUI save tells the worker's Materializer its project.json write is under way (an extension's
//   hostWrite), and the install that lands it resolves `after` to the envelope written and the file's stamp.
// #1, #2 and the save path need Cardboard's bundles (CARDBOARD_PRISTINE, as ../patches.test.js); #6 and #7 run anywhere.
//   CARDBOARD_PRISTINE=… node --test --test-concurrency=1 scripts/carton/test/sync/facade.test.js
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs"), os = require("os"), path = require("path"), { spawnSync } = require("child_process");
const S = require("./support.js");

const ROOT = path.join(__dirname, "..", "..", "..", "..");
const CARTON = path.join(ROOT, "carton");

// In the child: the built facade's commit, as the store bridge calls it, on the project's own file.
const RUN = String.raw`
const fs = require("fs"), path = require("path");
const [carton, bundle] = process.argv.slice(1);
const api = require(path.join(carton, "carton-node.cjs")).cardboard14;
const read = () => JSON.parse(fs.readFileSync(path.join(bundle, "project.json"), "utf8")).project;
const commit = (base, doc, actor) => api.commit({ bundlePath: bundle, base, doc, actor });
const pick = (r) => ({ status: r.status, empty: !!r.empty, rebased: r.rebased ?? null, merged: r.merged, name: r.doc?.name, description: r.doc?.description ?? null, cards: (r.cards ?? []).map((c) => String(c.path)) });
(async () => {
  const p0 = read(), at = p0.stateUpdatedAt;
  // #1: A renames and describes; B, from the same older version, makes the same rename only.
  const a = await commit(p0, { ...p0, name: "Renamed", description: "theirs", stateUpdatedAt: at + 1 }, "codex/a");
  const b = await commit(p0, { ...p0, name: "Renamed", stateUpdatedAt: at + 2 }, "codex/b");
  // #2: from head, C renames; D, from the same version, renames otherwise and changes the description.
  const p1 = await api.headProject(bundle, { ...p0, stateUpdatedAt: -1 });
  const c = await commit(p1, { ...p1, name: "C's name", stateUpdatedAt: p1.stateUpdatedAt + 1 }, "codex/c");
  const d = await commit(p1, { ...p1, name: "D's name", description: "D's description", stateUpdatedAt: p1.stateUpdatedAt + 2 }, "codex/d");
  const head = await api.headProject(bundle, { ...p0, stateUpdatedAt: -1 });
  // laptop #2: from head, E renames; F, from the same version, changes only the description (core takes it on its
  // base, no rebase); G, from that version too, changes nothing
  const p2 = await api.headProject(bundle, { ...p0, stateUpdatedAt: -1 });
  const e = await commit(p2, { ...p2, name: "E's name", stateUpdatedAt: p2.stateUpdatedAt + 1 }, "codex/e");
  const f = await commit(p2, { ...p2, description: "F's description", stateUpdatedAt: p2.stateUpdatedAt + 2 }, "codex/f");
  const g = await commit(p2, { ...p2, stateUpdatedAt: p2.stateUpdatedAt + 3 }, "codex/g");
  const head2 = await api.headProject(bundle, { ...p0, stateUpdatedAt: -1 });
  process.stdout.write(JSON.stringify({ a: pick(a), b: pick(b), c: pick(c), d: pick(d), head: { name: head?.name, description: head?.description ?? null }, e: pick(e), f: pick(f), g: pick(g), head2: { name: head2?.name, description: head2?.description ?? null } }) + "\n");
  process.exit(0);
})().catch((e) => { process.stdout.write(JSON.stringify({ error: String(e?.stack ?? e) }) + "\n"); process.exit(1); });
`;

// In the child: GUI saves as the store makes them (commit, then writeNow's install of project.json with its rev and
// envelope), with an extension that takes the facade's hostWrite.
const GUI = String.raw`
const fs = require("fs"), path = require("path");
const [carton, bundle] = process.argv.slice(1);
const mod = require(path.join(carton, "carton-node.cjs")), api = mod.cardboard14;
const file = path.join(bundle, "project.json");
const told = [];
mod.extend({ name: "test", hostWrite: (b, after) => (told.push({ b, after }), true) });
const onDisk = () => JSON.parse(fs.readFileSync(file, "utf8"));
const stamp = () => { const st = fs.statSync(file, { bigint: true }); return st.ino + ":" + st.size + ":" + st.mtimeNs; };
let n = 0;
const gui = async (project, name) => {
  const r = await api.commit({ bundlePath: bundle, base: project, doc: { ...project, name, stateUpdatedAt: project.stateUpdatedAt + 1 }, actor: "person", meta: { base: project.stateUpdatedAt } });
  return r.doc;
};
const write = async (project) => {
  const envelope = { ...onDisk(), project }, tmp = path.join(bundle, ".project.json." + ++n + ".tmp");
  fs.writeFileSync(tmp, JSON.stringify(envelope));
  return { envelope, ok: await api.install(tmp, file, undefined, project.stateUpdatedAt, envelope) };
};
const what = async (after, envelope) => {
  const w = await after;
  return w ? { stamp: w.project.stamp === stamp(), same: w.project.envelope === envelope } : null;
};
(async () => {
  const p0 = onDisk().project;
  // its own write
  const s1 = await gui(p0, "one");
  const w1 = await write(s1);
  const one = { told: told.length, ok: w1.ok, got: await what(told[0].after, w1.envelope) };
  // two saves, the first one's write replaced by the second's (the store's queue)
  const s2 = await gui(s1, "two"), s3 = await gui(s2, "three");
  const w3 = await write(s3);
  const queued = { told: told.length, got: [await what(told[1].after, w3.envelope), await what(told[2].after, w3.envelope)] };
  // a write that doesn't install (its state is no longer head): nothing, the Materializer reads the file
  const s4 = await gui(s3, "four");
  const stale = await write({ ...s1, stateUpdatedAt: s1.stateUpdatedAt });
  const notHead = { ok: stale.ok, got: await told[3].after };
  // a save that isn't the GUI's (no editor base): not told
  await api.commit({ bundlePath: bundle, base: s4, doc: { ...s4, name: "cb", stateUpdatedAt: s4.stateUpdatedAt + 1 }, actor: "codex/x" });
  process.stdout.write(JSON.stringify({ one, queued, notHead: { ...notHead, got: notHead.got ?? null }, last: told.length, bundle: told.every((t) => t.b === bundle) }) + "\n");
  process.exit(0);
})().catch((e) => { process.stdout.write(JSON.stringify({ error: String(e?.stack ?? e) }) + "\n"); process.exit(1); });
`;

let b, pc, out;
test.before(async () => {
  if (S.skip) return;
  b = await S.build();
  pc = await S.computer("facade", b);
  S.seed(pc, b);
  const home = pc.home;
  const r = spawnSync(process.execPath, ["-e", RUN, b.carton, path.join(pc.root, "Demo.cardboard")], {
    env: { ...process.env, HOME: home, USERPROFILE: home, XDG_DATA_HOME: path.join(home, "appdata"), LOCALAPPDATA: path.join(home, "appdata"), CARDBOARD_CARTON: "1", CARDBOARD_ACTOR: "", CLAUDECODE: "" },
    encoding: "utf8",
    timeout: 120_000,
  });
  out = JSON.parse(r.stdout.trim().split("\n").pop() || "{}");
  if (out.error || r.status !== 0) throw new Error("facade run: " + (out.error ?? r.stdout + r.stderr));
}, { timeout: S.SETUP_MS });

test("#1 a save with nothing of its own, rebased onto a newer head, gets head: the other writer's description stays", { skip: S.skip }, () => {
  assert.equal(out.a.status, "confirmed", JSON.stringify(out.a));
  assert.equal(out.b.status, "confirmed", JSON.stringify(out.b));
  assert.equal(out.b.empty, true, "nothing of its own: " + JSON.stringify(out.b));
  assert.deepEqual([out.b.name, out.b.description, out.b.merged], ["Renamed", "theirs", true], "the file gets head, not the writer's older document");
});

test("#2 a stale save that clashes keeps its other edits: the clash is a card, head's value stays", { skip: S.skip }, () => {
  assert.equal(out.c.status, "confirmed", JSON.stringify(out.c));
  assert.equal(out.d.status, "conflicts", JSON.stringify(out.d));
  assert.ok(out.d.cards.some((p) => /name/.test(p)) && !out.d.cards.some((p) => /description/.test(p)), "one card, for the name: " + JSON.stringify(out.d.cards));
  assert.deepEqual([out.d.name, out.d.description], ["C's name", "D's description"], "what the save gets back");
  assert.deepEqual([out.head.name, out.head.description], ["C's name", "D's description"], "and what history holds");
});

test("H8 a GUI save's project.json write: the Materializer is told, and the install that lands it gives the envelope written with the file's stamp", { skip: S.skip }, () => {
  const home = pc.home;
  const r = spawnSync(process.execPath, ["-e", GUI, b.carton, path.join(pc.root, "Demo.cardboard")], {
    env: { ...process.env, HOME: home, USERPROFILE: home, XDG_DATA_HOME: path.join(home, "appdata"), LOCALAPPDATA: path.join(home, "appdata"), CARDBOARD_CARTON: "1", CARDBOARD_ACTOR: "", CLAUDECODE: "" },
    encoding: "utf8",
    timeout: 120_000,
  });
  const g = JSON.parse(r.stdout.trim().split("\n").pop() || "{}");
  assert.ok(!g.error && r.status === 0, "gui run: " + (g.error ?? r.stdout + r.stderr));
  assert.deepEqual(g.one, { told: 1, ok: true, got: { stamp: true, same: true } }, "its own write: the envelope written, the file's stamp");
  assert.deepEqual(g.queued, { told: 3, got: [{ stamp: true, same: true }, { stamp: true, same: true }] }, "a save whose write was replaced by a newer one's lands with it");
  assert.deepEqual(g.notHead, { ok: false, got: null }, "a write that doesn't install: nothing (the file is read)");
  assert.equal(g.last, 4, "a save that isn't the GUI's isn't told");
  assert.equal(g.bundle, true);
});

test("laptop #2 a cb edit core takes on an older version without a rebase gets head for project.json, not its own document", { skip: S.skip }, () => {
  assert.equal(out.e.status, "confirmed", JSON.stringify(out.e));
  assert.deepEqual([out.f.status, out.f.rebased], ["confirmed", 0], "F's edit went in on its older base: " + JSON.stringify(out.f));
  assert.deepEqual([out.f.name, out.f.description], ["E's name", "F's description"], "F's project.json is head, E's rename too");
  assert.deepEqual([out.g.name, out.g.description], ["E's name", "F's description"], "an edit with nothing of its own gets head too");
  assert.deepEqual([out.head2.name, out.head2.description], ["E's name", "F's description"]);
});

test("#6 a signed media URL goes onto the configured origin whole: scheme, host and port", async () => {
  const dir = path.join(process.env.CARTON_TEST_DIR ?? path.join(os.homedir(), "gfv-scratch", "carton", "windows-sync"), "facade-test");
  fs.mkdirSync(dir, { recursive: true });
  const esbuild = require(require.resolve("esbuild", { paths: [CARTON] }));
  const file = path.join(dir, "host.cjs");
  await esbuild.build({ entryPoints: [path.join(ROOT, "scripts/carton/sync/host.js")], bundle: true, platform: "node", format: "cjs", target: "node24", outfile: file, absWorkingDir: CARTON, nodePaths: [path.join(CARTON, "node_modules")], logLevel: "warning" });
  const { ontoOrigin } = require(file);
  const signed = "http://team.example/blob/p1/m/abc?sig=1&exp=2";
  assert.equal(ontoOrigin("https://team.example", signed), "https://team.example/blob/p1/m/abc?sig=1&exp=2", "TLS-terminated host: https, never http");
  assert.equal(ontoOrigin("https://team.example", "http://10.0.0.5:8787/blob/k?sig=1"), "https://team.example/blob/k?sig=1", "the host's own listen address and port go");
  assert.equal(ontoOrigin("http://127.0.0.1:9000", "http://localhost:9000/blob/k"), "http://127.0.0.1:9000/blob/k");
  assert.equal(ontoOrigin("https://team.example", "https://team.example/blob/k"), "https://team.example/blob/k", "already on it");
  assert.equal(ontoOrigin("https://team.example", "http://elsewhere/api/x"), "http://elsewhere/api/x", "not a blob URL: left alone");
});

// #7 (media fd87449): the reuse check remembers a stream it found whole per host client object, so the worker keeps one
// client per bundle, project and host from one share to the next; the facade's release of a folder lets the clients of
// bundles in it go (the sync half's release hook), and only those. Run in a child process on a bundle of the facade with
// the sync half (as build.js makes it), with its own app data; no request goes out (a dead proxy, should one try).
const MEDIA = String.raw`
const path = require("path");
const [file, root] = process.argv.slice(1);
const { cardboard14, media, store } = require(file);
const lib = path.join(root, "lib"), bundle = path.join(lib, "Demo.cardboard"), other = path.join(root, "lib2", "Demo.cardboard");
for (const b of [bundle, other]) {
  store.writeConfig(b, { projectId: "p1", host: "https://host.example", account: "a" });
  store.saveSession(b, "p1", { token: "t", context: { expires: Date.now() + 3_600_000 } });
}
(async () => {
  const a = media.storeFor(bundle, "p1"), o = media.storeFor(other, "p1");
  const out = { same: media.storeFor(bundle, "p1") === a, perLibrary: o !== a };
  await cardboard14.release(path.join(root, "lib2"));
  out.otherReleased = media.storeFor(other, "p1") !== o;
  out.keptElsewhere = media.storeFor(bundle, "p1") === a;
  await cardboard14.release(lib);
  const c = media.storeFor(bundle, "p1");
  out.newAfterRelease = c !== a;
  store.writeConfig(bundle, { projectId: "p1", host: "https://other.example", account: "a" });
  out.newForAnotherHost = media.storeFor(bundle, "p1") !== c;
  process.stdout.write(JSON.stringify(out) + "\n");
  process.exit(0);
})().catch((e) => { process.stdout.write(JSON.stringify({ error: String(e?.stack ?? e) }) + "\n"); process.exit(1); });
`;

test("#7 one host media client per project, kept from one share to the next; releasing a folder lets its bundles' clients go", async () => {
  const dir = path.join(process.env.CARTON_TEST_DIR ?? path.join(os.homedir(), "gfv-scratch", "carton", "windows-sync"), "facade-test", "media");
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  const esbuild = require(require.resolve("esbuild", { paths: [CARTON] }));
  const file = path.join(dir, "media.cjs");
  await esbuild.build({
    stdin: { contents: 'export { cardboard14 } from "./carton-node.js";\nimport "./sync/worker.js";\nexport * as media from "./sync/media.js";\nexport * as store from "./sync/store.js";\n', resolveDir: path.join(ROOT, "scripts/carton"), sourcefile: "media-entry.js", loader: "js" },
    bundle: true, platform: "node", format: "cjs", target: "node24", outfile: file, absWorkingDir: CARTON, nodePaths: [path.join(CARTON, "node_modules")], logLevel: "error",
    banner: { js: 'const __cartonUrl = require("node:url").pathToFileURL(__filename).href;' }, define: { "import.meta.url": "__cartonUrl" },
  });
  const appData = path.join(dir, "appdata"), dead = "http://127.0.0.1:9";
  const r = spawnSync(process.execPath, ["-e", MEDIA, file, dir], {
    env: { ...process.env, HOME: dir, USERPROFILE: dir, XDG_DATA_HOME: appData, LOCALAPPDATA: appData, NODE_USE_ENV_PROXY: "1", HTTP_PROXY: dead, HTTPS_PROXY: dead, NO_PROXY: "" },
    encoding: "utf8",
    timeout: 60_000,
  });
  const got = JSON.parse(r.stdout.trim().split("\n").pop() || "{}");
  assert.ok(!got.error && r.status === 0, got.error ?? r.stdout + r.stderr);
  assert.deepEqual(got, { same: true, perLibrary: true, otherReleased: true, keptElsewhere: true, newAfterRelease: true, newForAnotherHost: true });
});

// Every `cb` call loads carton-node.cjs. Its sync transport is made at the first connect: reading globalThis.WebSocket
// at load made Node load its WebSocket client (undici) in every process, syncing or not.
test("loading the facade doesn't load Node's WebSocket client: only a sync connect does", { skip: S.skip || S.noBuild }, async () => {
  const b = await S.build();
  const r = spawnSync(process.execPath, ["-e", `require(${JSON.stringify(path.join(b.carton, "carton-node.cjs"))}); process.stdout.write(JSON.stringify(process.moduleLoadList.filter((m) => /undici/.test(m))))`], { env: { ...process.env, CARDBOARD_CARTON: "1" }, encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout), []);
});
