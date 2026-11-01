// The facade's save path (scripts/carton/carton-node.js) as shipped, on a local cut, with a real project cb made, run
// in a child process (Carton's handles stay open in the process that opens them). Review round 3:
//   #1 a save that changed nothing of its own but was rebased (head moved on in other fields) gets head, never the
//      writer's older document;
//   #2 a stale save whose merge clashes keeps its other edits; the clash becomes a card, head's value stays;
//   #6 a signed media URL goes onto the configured origin whole (scheme too), never http where the app said https;
//   #7 one host media client per project from one share to the next (media fd87449), let go on the facade's release.
// #1 and #2 need Cardboard's bundles (CARDBOARD_PRISTINE, as ../patches.test.js); #6 and #7 run anywhere.
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
  process.stdout.write(JSON.stringify({ a: pick(a), b: pick(b), c: pick(c), d: pick(d), head: { name: head?.name, description: head?.description ?? null } }) + "\n");
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
