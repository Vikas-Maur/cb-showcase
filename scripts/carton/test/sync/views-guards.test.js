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
        'export { cardboard14 } from "./carton-node.js";',
        'export { Live } from "./sync/live.js";',
        'import "./sync/cbproj.js";',
        'export { openSqliteStore } from "@carton/store-sqlite";',
        'export { cutOfChange } from "./sync/view-cards.js";',
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
  const load = new Function("fs", "path", "AsyncLocalStorage", "extend", "TIMELINE_OWNER", "cardboardFilesHost", "Materializer", "CARTON_DIR", "VIEWS_DIR", "TIMELINE_FILE", "keepLease", "holderSocketPath", "CartonHolderEngine", "cartonMaterializerEngine", "preToolUse", "parseActorId", "fence", "caughtUp", "cutOfChange", src + ";return { viewOf };");
  const saved = globalThis.__cartonTimelineCodec;
  globalThis.__cartonTimelineCodec = {};
  try {
    const bundle = path.join(DIR, "closing.cardboard");
    const mod = load(fs, path, require("node:async_hooks").AsyncLocalStorage, (e) => (ext = e), ["timelineOwner"], {}, Materializer, ".carton", ".scratch/views", "timeline.tsx", keepLease, () => path.join(DIR, "stub.sock"), CartonHolderEngine, () => ({}), () => ({}), () => null, () => ({}), async () => {}, async () => null);
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

// ---------------------------------------------------------------- review H8 round 2
const freshBundle = (name) => {
  const bundle = path.join(DIR, name);
  fs.rmSync(bundle, { recursive: true, force: true });
  fs.mkdirSync(bundle, { recursive: true });
  const env = envelope();
  fs.writeFileSync(path.join(bundle, "project.json"), JSON.stringify(env));
  return { bundle, env, project: env.project, title: env.project.timelineItems.find((i) => i.type === "text").id };
};
const testHost = (project) => A.createInProcessHost({ storage: A.sqliteStorage(), auth: { kind: "test", verify: async () => ({ account: "alice", credential: "alice/install", role: "editor", projectId: project.id, expires: Date.now() + 3600_000 }) }, timeline: A.cardboardAdapter.schema.timeline, groupOf: (c, f) => A.cardboardAdapter.schema.collections[c]?.groupOf.get(f)?.name });
const DIRECTOR = { kind: "agent", id: "director/chat/turn", chat: "chat", turn: "turn", provider: "claude-code" };

test("r2 #1 a view save whose lease is taken between the check and the write is refused whole, then applied once the app has the lease back", opt, async () => {
  const { bundle, project, title } = freshBundle("lease-race.cardboard");
  const store = A.createMemoryStore(), host = testHost(project);
  const sync = { transport: host.transport, url: host.url, token: "test-token", autoConnect: false };
  const c = await A.Carton.open({ adapter: A.cardboardAdapter, store, projectId: project.id, init: { doc: A.fromHost(project, null) }, sync, actor: PERSON });
  const lc = { carton: c, store, lease: new A.Lease(store), dbPath: path.join(bundle, ".carton", "carton.db") };
  globalThis.__cartonTimelineCodec = A.jsonTimelineCodec;
  const v = new A.View({ bundlePath: bundle, lc, api: { bundleOf: () => bundle, materialize: async () => {} } });
  const commit = c.commit.bind(c);
  let c2, other, engine2, resume, entered = false;
  try {
    await v.start();
    await c.share();
    await v.connectSync();
    await until(() => c.sync.state().status === "up-to-date", 20_000, "shared");
    const print = await v.mz.printView("agent", DIRECTOR, { hooked: true }), file = path.join(bundle, print.path);
    // the agent's save passes #mayCommit, then waits just before core writes it
    c.commit = async (input) => { if (input.author?.id === DIRECTOR.id && !entered) { entered = true; await new Promise((r) => (resume = r)); } return commit(input); };
    fs.writeFileSync(file, fs.readFileSync(file, "utf8").replace(/"fontSize": \d+/, '"fontSize": 123'));
    assert.ok(v.holds());
    v.mz.onFsEvent(print.path);
    await until(() => entered, 20_000, "the save past its lease check");
    // another process takes the lease meanwhile
    c2 = await A.Carton.open({ adapter: A.cardboardAdapter, store, actor: PERSON, sync });
    engine2 = new A.CartonHolderEngine(c2);
    other = new A.Holder({ lease: lc.lease, engine: engine2, kind: "worker", socketPath: A.holderSocketPath(DIR, "race-other") });
    assert.ok(await other.start());
    assert.ok(!v.holds());
    resume();
    await v.mz.idle();
    const byAgent = async () => (await store.range("pending", { prefix: [c.cut] })).filter((r) => r.value.author?.id === DIRECTOR.id);
    assert.deepEqual(await byAgent(), [], "nothing queued in the handle that lost the lease");
    assert.equal((await c2.commit({ ops: [{ op: "set", path: ["timelineItems", title, "textContent"], value: "REPLACEMENT" }], wait: 5000 })).status, "confirmed");
    // the other process lets go: the save is applied, and confirmed
    await other.retire("test: handed back");
    other = null;
    await until(() => v.holds(), 20_000, "the View holds the lease again");
    await until(async () => (await c.head()).doc.timelineItems.find((i) => i.id === title).fontSize === 123, 60_000, "the agent's save applied");
    await until(async () => (await byAgent()).every((r) => r.value.confirmed), 20_000, "and confirmed");
  } finally {
    resume?.();
    c.commit = commit;
    await other?.retire("test cleanup").catch(() => {});
    await engine2?.close?.().catch(() => {});
    await c2?.close().catch(() => {});
    await v.stop();
    await c.close();
    host.close();
  }
});

test("r2 #2 a view save's cards resumed after a restart on another cut keep the cut the save landed on", opt, async () => {
  const { bundle, project, title } = freshBundle("resume.cardboard");
  const store = A.createMemoryStore();
  const c = await A.Carton.open({ adapter: A.cardboardAdapter, store, projectId: project.id, init: { doc: A.fromHost(project, null) }, actor: PERSON });
  const lc = { carton: c, store, lease: new A.Lease(store), dbPath: path.join(bundle, ".carton", "carton.db") }, cards = [];
  const api = { bundleOf: () => bundle, materialize: async () => {}, agentCards: async (_b, x) => void cards.push(x) };
  globalThis.__cartonTimelineCodec = A.jsonTimelineCodec;
  let v = new A.View({ bundlePath: bundle, lc, api });
  const write = store.write.bind(store);
  let failedOnce = false;
  try {
    await v.start();
    const cutA = c.cut, p = await v.mz.printView("agent", DIRECTOR, { hooked: true });
    await c.commit({ ops: [{ op: "set", path: ["timelineItems", title, "fontSize"], value: 150 }] });
    const file = path.join(bundle, p.path);
    fs.writeFileSync(file, fs.readFileSync(file, "utf8").replace(/"fontSize": \d+/, '"fontSize": 170'));
    // the process stops right after the save's result is stored (before its cards go anywhere)
    store.write = async (batch, ...rest) => {
      const out = await write(batch, ...rest);
      if (!failedOnce && batch.some((w) => w.table === "views" && w.key[0] === "attempt" && w.value?.result)) { failedOnce = true; throw new Error("test: the process stopped here"); }
      return out;
    };
    v.mz.onFsEvent(p.path);
    await until(() => failedOnce, 20_000, "the stop");
    await v.mz.idle();
    assert.equal(cards.length, 0);
    await v.stop();
    store.write = write;
    // it starts again on another cut, and the Materializer resumes the stored result
    const b = await c.fork("B");
    await c.switchTo(b.id);
    v = new A.View({ bundlePath: bundle, lc, api });
    await v.start();
    v.mz.onFsEvent(p.path);
    const got = await until(() => cards[0], 20_000, "the resumed cards");
    assert.equal(got.cut, cutA, "the card belongs to cut A, where the save landed");
  } finally {
    store.write = write;
    await v.stop();
    await c.close();
  }
});

test("r2 #4 a pick on one cut leaves the same agent's identical card on another cut open, on both sides", opt, async () => {
  const project = envelope().project, title = project.timelineItems.find((i) => i.type === "text").id;
  const store = A.createMemoryStore();
  const c = await A.Carton.open({ adapter: A.cardboardAdapter, store, projectId: project.id, init: { doc: A.fromHost(project, null) }, actor: PERSON });
  try {
    const agent = { kind: "agent", id: "director/c/t" }, key = keyOf(agent), lc = { carton: c, store };
    const card = { kind: "field", path: `timelineItems/${title}/fontSize`, base: 96, ours: 150, theirs: 170 };
    const views = A.viewCards({ actorOf: (id) => ({ kind: "agent", id }), keyOf, me: PERSON });
    const cutA = c.cut;
    const changes = {};
    for (const [cut, value] of [[cutA, 111], [null, 222]]) {
      if (!cut) { const b = await c.fork("B"); await c.switchTo(b.id); }
      await c.commit({ ops: [{ op: "set", path: ["timelineItems", title, "name"], value: "v" + value }], author: agent });
      const r = { id: (await c.log({ limit: 1 }))[0].change };
      changes[c.cut] = r.id;
      // the engine's notice for the agent (keyed by its change), and the person's copy
      await store.write([{ table: "notices", key: [key, value, 0, r.id], value: { to: key, kind: "late-conflict", change: r.id, cards: [card], at: value } }]);
      await views.keep(lc, { actor: agent, cards: [card], cut: c.cut, batch: r.id, change: r.id, at: value });
    }
    const cutB = c.cut;
    assert.equal(await A.cutOfChange(store, changes[cutA]), cutA, "a change's cut, from core's ids");
    await views.close(lc, card, key, cutA);
    const agentRows = (await store.range("notices", { prefix: [key] })).filter((r) => r.value.cards?.length);
    assert.deepEqual(agentRows.map((r) => r.value.change), [changes[cutB]], "the agent's card on B stays open");
    assert.equal((await views.shown(lc)).length, 1, "and the person's on B shows");
  } finally {
    await c.close();
  }
});

test("r2 #3 a kept GUI conflict shows in History on its own cut only, and Keep yours commits there", opt, async () => {
  const project = envelope().project, title = project.timelineItems.find((i) => i.type === "text").id;
  const store = A.createMemoryStore();
  const c = await A.Carton.open({ adapter: A.cardboardAdapter, store, projectId: project.id, init: { doc: A.fromHost(project, null) }, actor: PERSON });
  const servers = new Map(), messages = [], lc = { carton: c, store };
  try {
    const cutA = c.cut;
    await c.commit({ ops: [{ op: "set", path: ["timelineItems", title, "fontSize"], value: 150 }] });
    const b = await c.fork("B");
    await c.switchTo(b.id);
    await c.commit({ ops: [{ op: "set", path: ["timelineItems", title, "fontSize"], value: 222 }] });
    // a late conflict of a GUI save on A, kept for the person (core says its cut)
    const card = { kind: "field", path: `timelineItems/${title}/fontSize`, base: 96, ours: 150, theirs: 170 };
    await store.write([{ table: "notices", key: ["human/person", 1, 0, "late"], value: { to: "human/person", cut: cutA, kind: "late-conflict", text: "a GUI save met a teammate's", cards: [card], at: 1 } }]);
    const library = { projects: { read: async () => null, bundlePathFor: () => null } };
    const services = A.cardboard14.workerServices({ library, emit: (m) => messages.push(m.message), bundleOf: () => path.join(DIR, "panel.cardboard"), lcOf: async () => lc, servers });
    await services.ui({ projectId: project.id, client: "late", message: { t: "hello" } });
    const init = await until(() => messages.find((m) => m.t === "init"), 20_000, "the panel");
    const sizeCards = (list) => (list ?? []).filter((x) => x.path?.endsWith("/fontSize"));
    assert.deepEqual(sizeCards(init.topics.conflicts), [], "on B, A's card doesn't show");
    let n = 0;
    const call = async (method, ...args) => {
      const id = ++n;
      await services.ui({ projectId: project.id, client: "late", message: { t: "call", id, method, args } });
      const ret = await until(() => messages.find((m) => m.t === "ret" && m.id === id), 20_000, method);
      assert.ok(ret.ok, method + ": " + ret.error);
      return ret.value;
    };
    await call("switchCut", cutA);
    const shown = await until(() => { const t = messages.filter((m) => m.t === "topic" && m.topic === "conflicts").pop(); return sizeCards(t?.value)[0]; }, 20_000, "A's card on A");
    await call("resolve", shown.id, "mine");
    assert.equal((await c.head(cutA)).doc.timelineItems.find((x) => x.id === title).fontSize, 170, "Keep yours: on A");
    assert.equal((await c.head(b.id)).doc.timelineItems.find((x) => x.id === title).fontSize, 222, "B untouched");
  } finally {
    for (const s of servers.values()) s.close();
    await c.close();
  }
});

test("r2 #6 cb leaves timeline.tsx to the worker only when the worker's lease is a View's (not Live's holder without one)", opt, async () => {
  const { bundle, project } = freshBundle("mirror.cardboard");
  const db = path.join(bundle, ".carton", "carton.db");
  fs.mkdirSync(path.dirname(db), { recursive: true });
  const store = await A.openSqliteStore(db), host = testHost(project);
  const sync = { transport: host.transport, url: host.url, token: "test-token", autoConnect: false };
  const c = await A.Carton.open({ adapter: A.cardboardAdapter, store, projectId: project.id, init: { doc: A.fromHost(project, null) }, actor: PERSON, sync });
  const lc = { carton: c, store, lease: new A.Lease(store), dbPath: db };
  globalThis.__cartonTimelineCodec = A.jsonTimelineCodec;
  let live, v;
  try {
    await c.share();
    // Live's own holder (the View didn't start): it holds a worker lease and prints nothing
    live = new A.Live({ api: { materialize: async () => {}, emit: () => {} }, bundlePath: bundle, projectId: project.id, lc });
    await live.start();
    assert.ok(live.holds());
    assert.equal(await A.cardboard14.mirrorOwned(bundle), false, "cb prints timeline.tsx itself");
    await live.stop();
    // a View's holder: the worker prints it
    v = new A.View({ bundlePath: bundle, lc, api: { bundleOf: () => bundle, materialize: async () => {} } });
    await v.start();
    await until(() => v.holds(), 20_000, "the View's lease");
    await until(async () => (await A.cardboard14.mirrorOwned(bundle)) === true, 20_000, "cb leaves it to the worker's View");
  } finally {
    await A.cardboard14.release(bundle).catch(() => {});
    await live?.stop().catch(() => {});
    await v?.stop();
    await c.close();
    host.close();
  }
});
