// e2e-qa's whole-system bugs in @carton/local, each pinned at the package level (their e2e tests are in carton/e2e on
// e2e-qa's branch): B6 a cut switch tells the materializer, so the files can follow; B10 a view save on a shared cut
// gets its sidecar settled by the lease holder when the server answers; B3 a `cb` call waits for a slow app instead of
// taking its lease over (a helper has no materializer), and the starting app has a slow helper hand over; B4 folding a
// cut again after a partial fold folds in the rest; S3-1 a replica is named after its person (or OS user), never
// "replica", so a .cbproj names its sender and a cut its owner; B5 a file save's cards are kept for its author, so
// `cb conflicts` lists them and `cb resolve` can pick one.
import { test } from "node:test";
import assert from "node:assert/strict";
import { Carton } from "@carton/core";
import type { Actor, ConflictCard } from "@carton/core";
import type { AuthContext, AuthProvider } from "@carton/core/plugins";
import { createMemoryStore } from "@carton/store-memory";
import { createInProcessHost } from "@carton/server";
import { sqliteStorage } from "../../conformance/src/system/sqlite.ts";
import { runWrite } from "../src/writes.ts";
import type { ViewPrinter } from "../src/writes.ts";
import { CartonHolderEngine } from "../src/open.ts";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { ControlServer } from "../src/ipc.ts";
import { Lease } from "../src/lease.ts";
import type { HolderKind } from "../src/lease.ts";
import { submit } from "../src/client.ts";
import { scratch } from "./support/scratch.ts";
import { adapter, doc0, schema } from "./support/real.ts";

const agent: Actor = { kind: "agent", id: "director/chat/turn1", name: "Director", group: "local:me@box", turn: "turn1" };
const set = (id: string, f: string, v: unknown) => ({ op: "set" as const, path: ["timelineItems", id, f], value: v });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(f: () => unknown, ms = 5000, what = "condition") {
  for (const end = Date.now() + ms; !(await f()); await sleep(10)) if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
}
const printView: ViewPrinter["printView"] = async (name) => ({ name, path: name, ref: name });

test("B6: `cb cut switch` tells the materializer the current cut changed (the files follow it)", async () => {
  const c = await Carton.open({ adapter, store: createMemoryStore(), init: { doc: doc0() }, actor: agent });
  try {
    const alt = await c.fork("Alt", { id: "b6.alt" });
    const calls: string[] = [];
    const mz: ViewPrinter = { printView, onCb: async () => void calls.push("cb"), onHeadChange: (k) => void calls.push(`head:${k}`), onCutSwitch: (cut) => void calls.push(`switch:${cut}`) };
    const r = await runWrite(c, { id: "b6.1", actor: agent, op: { kind: "switch", cut: alt.id } }, { materializer: mz });
    assert.equal(r.status, "confirmed");
    assert.equal(c.cut, alt.id);
    assert.deepEqual(calls, ["cb", `switch:${alt.id}`], "after the switch, with the new cut");
    // a materializer without the hook still hears that head moved (project.json follows)
    const old: string[] = [];
    await runWrite(c, { id: "b6.2", actor: agent, op: { kind: "switch", cut: (await c.cuts()).find((x) => x.kind === "main")!.id } }, { materializer: { printView, onHeadChange: (k) => void old.push(k) } });
    assert.deepEqual(old, ["local"]);
  } finally {
    await c.close();
  }
});

test("B10: on a shared cut the lease holder settles a view's sidecar when the server answers; never on a local cut", async () => {
  const tokens = new Map<string, AuthContext>();
  const auth: AuthProvider = { kind: "table", async verify(t) { return tokens.get(t) ?? null; } };
  const host = createInProcessHost({ storage: sqliteStorage(), auth, timeline: schema.timeline!, groupOf: (cl, f) => schema.collections[cl]?.groupOf.get(f)?.name });
  tokens.set("tok", { account: "alice", credential: "alice/install", role: "editor", projectId: "p", expires: Date.now() + 3600_000 });
  const store = createMemoryStore();
  const c = await Carton.open({ adapter, store, init: { doc: doc0() }, actor: agent, sync: { transport: host.transport, url: host.url, token: "tok", autoConnect: false } });
  const updates: { view: string; id: string; status: string; conflicts?: ConflictCard[] }[] = [];
  const mz: ViewPrinter = { printView, onChangeUpdate: async (view, id, s) => void updates.push({ view, id, status: s.status, conflicts: s.conflicts }) };
  new CartonHolderEngine(c, { materializer: mz });
  // what the materializer records when a view save commits: the view's last change
  const saved = (view: string, id: string) => store.write([{ table: "views", key: ["view", view], value: { lastChange: id } }]);
  try {
    // a local cut: the save answered itself (its sidecar is written by the save); nothing more is forwarded
    const local = await c.commit({ id: "b10.local", ops: [set("c1", "name", "local")] });
    await saved("agent-l", "b10.local");
    await sleep(100);
    assert.equal(local.status, "confirmed");
    assert.equal(updates.length, 0, "nothing forwarded for a local cut");
    // shared: pending at first, settled by the holder when the server confirms
    await c.share();
    assert.ok(await c.sync!.connect({ nonce: "n" }));
    await until(async () => (await c.cuts()).find((x) => x.id === c.cut)!.sequencer.kind === "server", 5000, "the hand-off");
    await c.sync!.disconnect();
    const r = await c.commit({ id: "b10.view", ops: [set("c2", "name", "from a view")] });
    assert.equal(r.status, "pending");
    await saved("agent-v", "b10.view");
    assert.ok(await c.sync!.connect({ nonce: "n2" }));
    await until(() => updates.some((u) => u.id === "b10.view"), 5000, "the view's sidecar to settle");
    assert.deepEqual(updates.map((u) => [u.view, u.id, u.status]), [["agent-v", "b10.view", "confirmed"]]);
  } finally {
    await c.close();
  }
});

test("B3: a `cb` call waits for an app that is slow to answer its ping; a slow helper or a dead app is taken over", async () => {
  const dir = mkdtempSync(join(scratch(), "b3-"));
  /** A lease holder whose ping answers after `delayMs` (a busy engine thread). */
  async function holder(kind: HolderKind, delayMs: number) {
    const lease = new Lease(createMemoryStore());
    const path = join(dir, `${kind}-${delayMs}.sock`);
    let nonce = "";
    const srv = await ControlServer.listen({
      path,
      open: ["carton.ping"],
      methods: {
        "carton.ping": async () => { await sleep(delayMs); return { pid: process.pid, nonce }; },
        "carton.commit": () => ({ status: "confirmed", seq: 1, ref: null, notices: [] }),
      },
    });
    nonce = (await lease.take(null, { pid: process.pid, socketPath: path, kind }))!.nonce;
    return { lease, nonce, close: () => srv.close() };
  }
  const call = (lease: Lease, spawned: (string | null)[]) =>
    submit("carton.commit", { id: "b3.1", op: { kind: "commit" } }, { lease, needsHelper: async () => true, spawnHelper: (seen) => spawned.push(seen), helperStartMs: 100 });

  const app = await holder("worker", 250);
  try {
    const spawned: (string | null)[] = [];
    const r = await call(app.lease, spawned);
    assert.equal(r.via, "holder", "the busy app got the write");
    assert.deepEqual(spawned, [], "no helper took the app's lease over");
  } finally {
    await app.close();
  }
  const helper = await holder("helper", 250);
  try {
    const spawned: (string | null)[] = [];
    await call(helper.lease, spawned);
    assert.equal(spawned[0], helper.nonce, "a slow helper is taken over at once, as before (R4-04: under 1 s)");
  } finally {
    await helper.close();
  }
  // a dead app refuses the connection: taken over without waiting through the patient pings
  const lease = new Lease(createMemoryStore());
  const dead = (await lease.take(null, { pid: 1, socketPath: join(dir, "gone.sock"), kind: "worker" }))!;
  const spawned: (string | null)[] = [];
  const t0 = Date.now();
  void call(lease, spawned);
  await until(() => spawned.length > 0, 5000, "the takeover");
  assert.equal(spawned[0], dead.nonce);
  assert.ok(Date.now() - t0 < 1000, `no patience for a holder that is gone (${Date.now() - t0} ms)`);
  await sleep(700); // let the call's attempts end
});

test("B4: folding a cut again after a partial fold folds in the rest, once; then it is up to date", async () => {
  const c = await Carton.open({ adapter, store: createMemoryStore(), init: { doc: doc0() }, actor: agent });
  try {
    const main = c.cut;
    const alt = await c.fork("Variant", { id: "b4.alt" });
    await c.commit({ cut: alt.id, ops: [set("c1", "name", "variant title"), set("c2", "opacity", 0.3)] });
    const item = async (id: string) => ((await c.head(main)).doc.timelineItems as { id: string; name: string; opacity: number }[]).find((x) => x.id === id)!;
    // fold in some of it: c2 kept out
    const some = await runWrite(c, { id: "b4.some", actor: agent, op: { kind: "fold", from: alt.id, into: main, reject: ["timelineItems/c2"] } });
    assert.equal(some.status, "confirmed", JSON.stringify(some));
    assert.deepEqual([(await item("c1")).name, (await item("c2")).opacity], ["variant title", 1]);
    // later: the same fold folds in the rest
    const rest = await runWrite(c, { id: "b4.rest", actor: agent, op: { kind: "fold", from: alt.id, into: main } });
    assert.equal(rest.status, "confirmed", JSON.stringify(rest));
    assert.equal(rest.rest, true);
    assert.equal((await item("c2")).opacity, 0.3, "the kept-out part is in");
    const retry = await runWrite(c, { id: "b4.rest", actor: agent, op: { kind: "fold", from: alt.id, into: main } });
    assert.equal(retry.status, "confirmed", "a retried request answers again, changing nothing");
    const again = await runWrite(c, { id: "b4.again", actor: agent, op: { kind: "fold", from: alt.id, into: main } });
    assert.equal(again.upToDate, true, JSON.stringify(again));
    assert.equal((await c.log({ cut: main, limit: 100 })).filter((v) => v.kind === "revert").length, 1, "the rest folded in once");
  } finally {
    await c.close();
  }
});

test("S3-1: a replica opened through @carton/local is named, never \"replica\": a .cbproj names its sender, a cut its owner", async () => {
  const { bundle } = await import("./support/real.ts");
  const { openLocal, replicaName } = await import("../src/open.ts");
  const { dir, projectId } = bundle("s3-1");
  const la = await openLocal({ projectDir: dir, projectId, adapter, init: { doc: doc0() }, actor: { kind: "human", id: "human:alice", name: "Alice", group: "alice@laptop" } });
  try {
    const pkg = await la.carton.exportShallow({ to: "bob" });
    assert.equal(pkg.sender, "Alice", "the file names who sent it");
    assert.equal((await la.carton.cuts())[0]!.owner, "Alice", "the cut names whose it is");
  } finally {
    await la.close();
  }
  assert.equal(replicaName("Bob"), "Bob");
  assert.notEqual(replicaName(undefined, agent), "replica", "an agent's process is named after this machine's user");
});

test("B5: a view save whose merge raises a card keeps it for its author (cb conflicts lists it), once", async () => {
  const { CartonMaterializerEngine } = await import("../src/materializer-engine.ts");
  const { actorKey } = await import("../src/writes.ts");
  const store = createMemoryStore();
  const c = await Carton.open({ adapter, store, init: { doc: doc0() }, actor: { kind: "system", id: "engine" } });
  try {
    const eng = new CartonMaterializerEngine(c);
    await eng.head();
    // the agent printed its view at this state ...
    const at = await c.head();
    const base = { baseDoc: structuredClone(at.doc), baseSeq: at.ref.seq, causal: [] as string[] };
    // ... the person then sets the same field ...
    await c.commit({ author: { kind: "human", id: "human:me" }, ops: [set("c1", "opacity", 0.6)] });
    // ... and the agent saves its view from what it read
    const doc = structuredClone(base.baseDoc) as { timelineItems: { id: string; opacity: number }[] };
    doc.timelineItems.find((i) => i.id === "c1")!.opacity = 0.33;
    // the materializer records the save's change id before committing
    const id = c.newChangeId();
    const out = await eng.commit({ doc: doc as never, base, author: agent, meta: { file: ".scratch/views/a.tsx", view: "a" }, id });
    assert.equal(out.status, "conflicts", JSON.stringify(out));
    const mine = async () => (await store.range<{ cards?: { path: string }[]; change?: string }>("notices", { prefix: [actorKey(agent)] })).map((r) => r.value);
    const rows = await mine();
    assert.equal(rows.length, 1, JSON.stringify(rows));
    assert.deepEqual(rows[0]!.cards?.map((x) => x.path), ["timelineItems/c1/opacity"], "the card, for cb conflicts / cb resolve");
    // the materializer's own text notice for that save adds nothing
    assert.equal(rows[0]!.change, id);
    await eng.notice(agent, { kind: "conflicts", text: "your save conflicted", change: id });
    assert.equal((await mine()).length, 1, "the materializer's text notice for that save adds nothing");
  } finally {
    await c.close();
  }
});
