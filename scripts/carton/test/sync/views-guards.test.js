// Guards of the per-agent views (scripts/carton/sync/views.js, view-cards.js) that the H8 review stage's round 1 found
// missing, each reproduced first with the reviewer's probe:
//   #1 a view save on a shared cut goes through the lease holder: while another process holds the lease, it waits and
//      is retried, never left pending in a handle that holder doesn't read;
//   #2 an agent's card belongs to the cut its save landed on: History shows it only there, a pick commits there;
//   #4 identical cards from two agents show once, and a pick closes the card for both agents;
//   a View released while it is still starting doesn't take the lease or timeline.tsx afterwards;
//   the freeze holds when another connection's write makes the holder look at head after the agent saved its view (CI
//   Windows: the app's printShared stopgap showed the person's edit then), and an agent's own cb commit shows in it.
// On real core, cardboard-adapter's Materializer and engine, @carton/local's lease and holder, and an in-process host,
// bundled with esbuild (no Cardboard bundles needed).
//   node --test --test-concurrency=1 scripts/carton/test/sync/views-guards.test.js
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs"), os = require("os"), path = require("path");

const ROOT = path.join(__dirname, "..", "..", "..", "..");
const CARTON = path.join(ROOT, "carton");
const FIXTURE = path.join(CARTON, "packages", "conformance", "src", "cardboard", "fixtures", "sample", "project.json");
const skip = !fs.existsSync(path.join(CARTON, "node_modules", "esbuild")) && "run `npm ci` in carton/";
const DIR = path.join(process.env.CARTON_TEST_DIR ?? path.join(os.homedir(), "gfv-scratch", "carton", "windows-sync"), "views-guards");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(f, ms = 20_000, what = "condition") {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(20)) { const v = await f(); if (v) return v; }
  throw new Error("timed out waiting for " + what);
}
const opt = { skip, timeout: 120_000 };
let A;

test.before(async () => {
  if (skip) return;
  fs.rmSync(DIR, { recursive: true, force: true });
  fs.mkdirSync(DIR, { recursive: true });
  const esbuild = require(require.resolve("esbuild", { paths: [CARTON] }));
  const file = path.join(DIR, "api.cjs");
  await esbuild.build({
    stdin: {
      contents: [
        'export { View } from "./sync/views.js";',
        'export { viewCards } from "./sync/view-cards.js";',
        'export { createMemoryStore } from "@carton/store-memory";',
        'export { Carton } from "@carton/core";',
        'export { cardboardAdapter, fromHost, materializeProject, jsonTimelineCodec } from "@carton/cardboard";',
        'export { Lease, Holder, CartonHolderEngine, holderSocketPath } from "@carton/local";',
        'export { fromCarton } from "@carton/react";',
        'export { cartonMaterializerEngine } from "@carton/cardboard/node";',
        'export { createInProcessHost } from "@carton/server";',
        'export { sqliteStorage } from "../../carton/packages/conformance/src/system/sqlite.ts";',
      ].join("\n"),
      resolveDir: path.join(ROOT, "scripts", "carton"), loader: "js",
    },
    bundle: true, platform: "node", format: "cjs", target: "node24", outfile: file, absWorkingDir: CARTON, nodePaths: [path.join(CARTON, "node_modules")], logLevel: "error",
    banner: { js: 'const __cartonUrl = require("node:url").pathToFileURL(__filename).href;' }, define: { "import.meta.url": "__cartonUrl" },
  });
  A = require(file);
}, { timeout: 300_000 });

const envelope = () => JSON.parse(fs.readFileSync(FIXTURE, "utf8"));
const keyOf = (a) => [a.kind, a.id, a.agentId].filter(Boolean).join("/");
const PERSON = { kind: "human", id: "person" };

test("#2 an agent's card belongs to its cut: not shown on another; a pick commits on its own cut, which it clears", opt, async () => {
  const project = envelope().project, title = project.timelineItems.find((i) => i.type === "text").id;
  const store = A.createMemoryStore(), actor = { kind: "agent", id: "director/c/t" };
  const c = await A.Carton.open({ adapter: A.cardboardAdapter, store, projectId: project.id, init: { doc: A.fromHost(project, null) }, actor: PERSON });
  let h;
  try {
    const cutA = c.cut, base = await c.head(), doc = structuredClone(base.doc);
    await c.commit({ ops: [{ op: "set", path: ["timelineItems", title, "fontSize"], value: 150 }] });
    doc.timelineItems.find((i) => i.id === title).fontSize = 170;
    const engine = A.cartonMaterializerEngine(c);
    const r = await engine.commit({ doc, base: { baseDoc: base.doc, baseSeq: base.ref.seq, causal: [] }, author: actor, id: engine.newChangeId() });
    assert.equal(r.status, "conflicts");
    const views = A.viewCards({ actorOf: (id) => ({ kind: "agent", id }), keyOf, me: PERSON }), lc = { carton: c, store };
    await views.keep(lc, { actor, cards: r.cards, at: Date.now(), batch: r.id, change: r.id, cut: cutA });
    const b = await c.fork("Variant B");
    await c.switchTo(b.id);
    await c.commit({ ops: [{ op: "set", path: ["timelineItems", title, "fontSize"], value: 222 }] });
    assert.deepEqual(await views.shown(lc), [], "on cut B, A's card isn't shown");
    // a panel that had it from before the switch: the pick goes to A
    h = A.fromCarton(c, { me: PERSON });
    await h.ready;
    views.present(h, h, lc, () => [h]);
    await c.switchTo(cutA);
    const onA = await views.shown(lc);
    assert.equal(onA.length, 1, "on A it is shown");
    await c.switchTo(b.id);
    h.reportConflicts(onA[0].cards, onA[0].by);
    const card = h.conflicts().find((x) => x.path.endsWith("/fontSize"));
    assert.ok(card, "the panel shows the card it was given");
    await views.resolve(lc, h, card.id, "theirs");
    const size = async (cut) => (await c.head(cut)).doc.timelineItems.find((i) => i.id === title).fontSize;
    assert.equal(await size(b.id), 222, "cut B unchanged");
    assert.equal(await size(cutA), 170, "Keep the agent's took the agent's value on A, where the clash was");
    await c.switchTo(cutA);
    assert.deepEqual(await views.shown(lc), [], "and the card is closed there");
    assert.deepEqual((await store.range("notices", { prefix: [keyOf(actor)] })).flatMap((x) => x.value.cards ?? []), [], "on the agent's side too");
  } finally {
    h?.dispose();
    await c.close();
  }
});

test("#4 identical cards from two agents show once; a pick closes the card for both agents", opt, async () => {
  const store = A.createMemoryStore(), lc = { store, carton: { cut: "main" } };
  const actorOf = (id) => ({ kind: "agent", id }), card = { kind: "field", path: "timelineItems/title/fontSize", base: 96, ours: 150, theirs: 170 };
  const v = A.viewCards({ actorOf, keyOf, me: PERSON });
  for (const id of ["director/c/a", "director/c/b"]) {
    const to = keyOf(actorOf(id));
    await store.write([{ table: "notices", key: [to, 1, 0, id], value: { to, kind: "late-conflict", cards: [card], at: 1 } }]);
    await v.keep(lc, { actor: actorOf(id), cards: [card], batch: id, at: 1 });
  }
  await v.close(lc, card, keyOf(actorOf("director/c/a")), "main");
  for (const id of ["director/c/a", "director/c/b"]) assert.deepEqual((await store.range("notices", { prefix: [keyOf(actorOf(id))] })).flatMap((r) => r.value.cards ?? []), [], id + "'s notice");
  assert.deepEqual(await v.shown(lc), []);
});

test("#1 a view save on a shared cut waits for the lease: never left pending while another process holds it, applied once the app has it back", opt, async () => {
  const bundle = path.join(DIR, "lease.cardboard");
  fs.rmSync(bundle, { recursive: true, force: true });
  fs.mkdirSync(bundle, { recursive: true });
  const env = envelope();
  fs.writeFileSync(path.join(bundle, "project.json"), JSON.stringify(env));
  const project = env.project, title = project.timelineItems.find((i) => i.type === "text").id;
  const store = A.createMemoryStore();
  const host = A.createInProcessHost({ storage: A.sqliteStorage(), auth: { kind: "test", verify: async () => ({ account: "alice", credential: "alice/install", role: "editor", projectId: project.id, expires: Date.now() + 3600_000 }) }, timeline: A.cardboardAdapter.schema.timeline, groupOf: (c, f) => A.cardboardAdapter.schema.collections[c]?.groupOf.get(f)?.name });
  const sync = { transport: host.transport, url: host.url, token: "test-token", autoConnect: false };
  const c = await A.Carton.open({ adapter: A.cardboardAdapter, store, projectId: project.id, init: { doc: A.fromHost(project, null) }, sync, actor: PERSON });
  const lc = { carton: c, store, lease: new A.Lease(store), dbPath: path.join(bundle, ".carton", "carton.db") };
  globalThis.__cartonTimelineCodec = A.jsonTimelineCodec;
  const api = { bundleOf: () => bundle, materialize: async () => { fs.writeFileSync(path.join(bundle, "project.json"), JSON.stringify({ ...env, project: A.materializeProject((await c.head()).doc, project) })); } };
  const v = new A.View({ api, bundlePath: bundle, lc });
  let c2, other, engine2;
  try {
    await v.start();
    const actor = { kind: "agent", id: "director/chat/turn", chat: "chat", turn: "turn" };
    await c.share();
    await v.connectSync();
    await until(async () => (await c.cuts()).find((x) => x.id === c.cut).sequencer.kind !== "local" && c.sync.state().status === "up-to-date", 20_000, "shared");
    const print = await v.mz.printView("handover", actor, { hooked: true });
    // another process takes the lease (a cb helper, while the worker's loop stalled)
    c2 = await A.Carton.open({ adapter: A.cardboardAdapter, store, actor: PERSON, sync });
    engine2 = new A.CartonHolderEngine(c2);
    other = new A.Holder({ lease: lc.lease, engine: engine2, kind: "worker", socketPath: A.holderSocketPath(DIR, "other") });
    assert.ok(await other.start());
    assert.ok(!v.holds(), "the View lost the lease");
    // the agent saves its view meanwhile
    const file = path.join(bundle, print.path);
    fs.writeFileSync(file, fs.readFileSync(file, "utf8").replace(/"fontSize": \d+/, '"fontSize": 123'));
    v.mz.onFsEvent(print.path);
    await sleep(1500);
    const pendingByAgent = async () => (await store.range("pending", { prefix: [c.cut] })).filter((r) => r.value.author?.id === actor.id);
    assert.deepEqual(await pendingByAgent(), [], "nothing pending in the handle the other holder doesn't read");
    const statusFile = file.replace(/\.tsx$/, ".status");
    assert.notEqual(fs.existsSync(statusFile) && JSON.parse(fs.readFileSync(statusFile, "utf8")).status, "pending", "the save isn't reported as pending");
    // the other process lets go; the View's keepLease takes the lease back, and the Materializer's retry applies the save
    await other.retire("test: handed back");
    other = null;
    await until(() => v.holds(), 20_000, "the View holds the lease again");
    await until(async () => (await c.head()).doc.timelineItems.find((i) => i.id === title).fontSize === 123, 60_000, "the agent's save applied");
    // head shows a pending edit at once; the server's confirmation follows (CI Windows: checked before it came)
    await until(async () => (await pendingByAgent()).every((r) => r.value.confirmed), 20_000, "the agent's save confirmed, not left pending");
  } finally {
    await other?.retire("test cleanup").catch(() => {});
    await engine2?.close?.().catch(() => {});
    await c2?.close().catch(() => {});
    await v.stop();
    await c.close();
    host.close();
  }
});

test("the freeze holds when the holder hears of another connection's write after the agent saved its view (CI Windows, director-turn step 5)", opt, async () => {
  const bundle = path.join(DIR, "freeze.cardboard");
  fs.rmSync(bundle, { recursive: true, force: true });
  fs.mkdirSync(bundle, { recursive: true });
  const env = envelope();
  fs.writeFileSync(path.join(bundle, "project.json"), JSON.stringify(env));
  const project = env.project, title = project.timelineItems.find((i) => i.type === "text").id;
  const store = A.createMemoryStore();
  const c = await A.Carton.open({ adapter: A.cardboardAdapter, store, projectId: project.id, init: { doc: A.fromHost(project, null) }, actor: PERSON });
  const lc = { carton: c, store, lease: new A.Lease(store), dbPath: path.join(bundle, ".carton", "carton.db") };
  globalThis.__cartonTimelineCodec = A.jsonTimelineCodec;
  const api = { bundleOf: () => bundle, materialize: async () => { fs.writeFileSync(path.join(bundle, "project.json"), JSON.stringify({ ...env, project: A.materializeProject((await c.head()).doc, project) })); } };
  const v = new A.View({ api, bundlePath: bundle, lc });
  try {
    await v.start();
    const actor = { kind: "agent", id: "director/chat/turn", chat: "chat", turn: "turn", provider: "claude-code" }; // a Director turn: hooked (local's hookDelivered)
    const shared = () => fs.readFileSync(path.join(bundle, "timeline.tsx"), "utf8");
    // the turn starts: its first read freezes timeline.tsx; it prints its own view
    await v.hook(actor, { event: "read" });
    const print = await v.mz.printView("turn", actor, { hooked: true });
    // the person edits in the GUI (this handle)
    assert.equal((await c.commit({ ops: [{ op: "set", path: ["timelineItems", title, "textContent"], value: "PERSON-WHILE-FROZEN" }] })).status, "confirmed");
    // the agent saves its view (the Materializer commits it in this handle, as its author)
    const file = path.join(bundle, print.path);
    fs.writeFileSync(file, fs.readFileSync(file, "utf8").replace(/"fontSize": \d+/, '"fontSize": 123'));
    v.mz.onFsEvent(print.path);
    await until(async () => (await c.head()).doc.timelineItems.find((i) => i.id === title).fontSize === 123, 20_000, "the agent's save");
    await v.mz.idle();
    assert.ok(!shared().includes("PERSON-WHILE-FROZEN"), "frozen after the agent's save");
    // then local's follower hears of another connection's write (a lease renewal, a sidecar, a notice: any data_version
    // move) and asks the printer to look at head
    await v.holder.materializer.onExternalHeadChange();
    await v.mz.idle();
    assert.ok(!shared().includes("PERSON-WHILE-FROZEN"), "the person's edit stays out of timeline.tsx until the turn stops");
    // the agent's own cb commit (served by this holder) shows in the frozen file at once, as with 1.4.0; the person's
    // edit still doesn't
    const out = await v.holder.serve({ id: "aaabbbcc.1", actor, op: { kind: "commit", ops: [{ op: "set", path: ["timelineItems", title, "fontSize"], value: 111 }] } });
    assert.equal(out.status, "confirmed", JSON.stringify(out));
    await until(() => shared().includes('"fontSize": 111'), 20_000, "the agent's cb edit in the frozen timeline.tsx");
    assert.ok(!shared().includes("PERSON-WHILE-FROZEN"), "the agent's cb edit shows without the person's");
    await v.hook(actor, { event: "stop" });
    await until(() => shared().includes("PERSON-WHILE-FROZEN"), 20_000, "the person's edit after the Stop");
  } finally {
    await v.stop();
    await c.close();
  }
});

test("a View released while it is still starting doesn't take the lease or timeline.tsx afterwards", opt, async () => {
  // views.js as the worker runs it (each name it imports is a parameter below: a new import needs one), with stand-ins for the packages: a Materializer whose start waits until told (`\r?`: a Windows checkout has CRLF lines)
  const src = fs.readFileSync(path.join(ROOT, "scripts", "carton", "sync", "views.js"), "utf8").replace(/^import .*;\r?\n/gm, "").replaceAll("export class ", "class ").replaceAll("export function ", "function ");
  let ext, open, go, leaseStarted = false, leaseStopped = false;
  const starting = new Promise((r) => (go = r));
  class Materializer { constructor() { this.freeze = {}; } async start() { await starting; } async close() {} }
  class CartonHolderEngine { async serve() {} async startSync() {} }
  const keepLease = () => ({ start: async () => { leaseStarted = true; }, stop: async () => { leaseStopped = true; } });
  const load = new Function("fs", "path", "AsyncLocalStorage", "extend", "cardboardFilesHost", "Materializer", "CARTON_DIR", "VIEWS_DIR", "TIMELINE_FILE", "keepLease", "holderSocketPath", "CartonHolderEngine", "cartonMaterializerEngine", "preToolUse", "parseActorId", "caughtUp", src + ";return { viewOf };");
  const saved = globalThis.__cartonTimelineCodec;
  globalThis.__cartonTimelineCodec = {};
  try {
    const bundle = path.join(DIR, "closing.cardboard");
    const mod = load(fs, path, require("node:async_hooks").AsyncLocalStorage, (e) => (ext = e), {}, Materializer, ".carton", ".scratch/views", "timeline.tsx", keepLease, () => path.join(DIR, "stub.sock"), CartonHolderEngine, () => ({}), () => ({}), () => null, async () => {});
    const api = { bundleOf: () => bundle, onOpen: (f) => (open = f) };
    ext.worker(api);
    const opening = open(bundle, { carton: { projectId: "p", cut: "main", on: () => () => {} }, store: {}, dbPath: path.join(bundle, ".carton", "carton.db") });
    const released = ext.release(bundle, (p) => p === bundle);
    go();
    assert.equal(await opening, null, "the start ends in nothing");
    await released;
    assert.equal(ext.ownsTimeline(bundle), false, "timeline.tsx stays Cardboard's");
    assert.ok(!leaseStarted || leaseStopped, "no lease left held in the released bundle");
    assert.equal(await mod.viewOf(bundle), null);
  } finally {
    globalThis.__cartonTimelineCodec = saved;
  }
});
