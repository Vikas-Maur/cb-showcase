// Joining a shared cut from nothing (`init: {join}`: a browser opening an invite link), and the writes History plans on
// a shared cut's confirmed head: undo (the §17 script's "undo the agent's turn"), restore, revert ("Fold in the
// rest") and fold in some of it, against a real sequencer (the in-process host of @carton/server).
import { test } from "node:test";
import assert from "node:assert/strict";
import { Carton, hashDoc, type Actor, type CutRecord } from "@carton/core";
import type { AuthContext, AuthProvider } from "@carton/core/plugins";
import { createInProcessHost } from "@carton/server";
import { sqliteStorage } from "../../conformance/src/system/sqlite.ts";
import { createMemoryStore } from "../src/index.ts";
import { adapter, schema, doc0, set, item } from "./fixture.ts";

const alice: Actor = { kind: "human", id: "alice", group: "alice@laptop" };
const bob: Actor = { kind: "human", id: "bob", group: "bob@desk" };
// the Director acting for Alice: its turn is in Alice's undo group (§8)
const director = (turn: string): Actor => ({ kind: "agent", id: `director/chat/${turn}`, name: "Director", turn, group: "alice@laptop" });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(pred: () => boolean | Promise<boolean>, ms = 5000, what = "condition"): Promise<void> {
  const end = Date.now() + ms;
  while (!(await pred())) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(10);
  }
}

function world() {
  const tokens = new Map<string, AuthContext>();
  const auth: AuthProvider = { kind: "table", async verify(t) { return tokens.get(t) ?? null; } };
  const host = createInProcessHost({ storage: sqliteStorage(), auth, timeline: schema.timeline!, groupOf: (c, f) => schema.collections[c]?.groupOf.get(f)?.name });
  const sync = (name: string) => {
    tokens.set(`tok-${name}`, { account: name, credential: `${name}/install`, role: "editor", projectId: "p", expires: Date.now() + 3600_000 });
    return { transport: host.transport, url: host.url, token: `tok-${name}` };
  };
  return { host, sync };
}

/** Alice's project, shared: what an invite carries to a joiner (the cut's record and its root). */
async function sharedProject(w: ReturnType<typeof world>) {
  const a = await Carton.open({ adapter, store: createMemoryStore(), init: { doc: doc0(), projectId: "p" }, actor: alice, sync: w.sync("alice") });
  await a.share();
  await until(async () => (await a.cuts())[0]!.sequencer.kind === "server", 5000, "the hand-off");
  const cut = (await a.cuts())[0]!;
  const root = await a.checkout(`${cut.id}@0`);
  return { a, join: { projectId: a.projectId, cut: cut as CutRecord, doc0: root, rootHash: hashDoc(root, schema) } };
}

test("join: a replica with an empty store opens a shared cut from its record and root, catches up and edits", async () => {
  const w = world();
  const { a, join } = await sharedProject(w);
  assert.equal((await a.commit({ ops: [set("a", "name", "before bob")], wait: 5000 })).status, "confirmed");
  const store = createMemoryStore();
  const b = await Carton.open({ adapter, store, init: { join }, actor: bob, sync: w.sync("bob") });
  assert.equal(b.projectId, "p");
  assert.equal(b.cut, join.cut.id, "the joined cut keeps the host's id");
  await until(async () => item((await b.head()).doc, "a")!.name === "before bob", 5000, "bob catches up");
  await until(async () => (await b.log()).length === 2, 5000, "the caught-up row in History");
  assert.equal((await b.log())[0]!.author?.id, "alice");
  assert.equal((await b.commit({ ops: [set("b", "name", "from bob")], wait: 5000 })).status, "confirmed");
  await until(async () => item((await a.head()).doc, "b")!.name === "from bob", 5000, "alice sees bob's edit");
  assert.equal((await b.credits(["items", "b"]))?.id, "bob");
  await b.close();
  // the store now holds the project: it reopens without `init`
  const again = await Carton.open({ adapter, store, actor: bob, sync: w.sync("bob") });
  await until(async () => item((await again.head()).doc, "b")!.name === "from bob", 5000, "reopened");
  await again.close();
  await a.close();
  w.host.close();
});

test("join refuses a root that doesn't match its hash, a cut that isn't sequenced by a host, and no sync", async () => {
  const w = world();
  const { a, join } = await sharedProject(w);
  const s = createMemoryStore();
  await assert.rejects(Carton.open({ adapter, store: s, init: { join: { ...join, doc0: { ...join.doc0, name: "tampered" } } }, sync: w.sync("bob") }), /doesn't match its hash/);
  await assert.rejects(Carton.open({ adapter, store: s, init: { join: { ...join, cut: { ...join.cut, sequencer: { kind: "local" } } } }, sync: w.sync("bob") }), /needs a cut a host sequences/);
  await assert.rejects(Carton.open({ adapter, store: s, init: { join } }), /needs `sync`/);
  assert.equal(await s.get("meta", ["project"]), undefined, "nothing was stored");
  await a.close();
  w.host.close();
});

test("undo on a shared cut: the agent's turn is undone as one change, a teammate's edit in between is kept", async () => {
  const w = world();
  const { a, join } = await sharedProject(w);
  const bot = await Carton.open({ adapter, store: createMemoryStore(), init: { join }, actor: director("t1"), sync: w.sync("director") });
  const b = await Carton.open({ adapter, store: createMemoryStore(), init: { join }, actor: bob, sync: w.sync("bob") });
  for (const c of [bot, b]) await until(() => c.sync!.status === "up-to-date", 5000, "connected");
  assert.equal((await bot.commit({ ops: [set("a", "name", "Intro (tight)")], wait: 5000 })).status, "confirmed");
  assert.equal((await b.commit({ ops: [set("c", "name", "bob's")], wait: 5000 })).status, "confirmed");
  assert.equal((await bot.commit({ ops: [set("b", "name", "Middle (tight)")], wait: 5000 })).status, "confirmed");
  await until(async () => (await a.log()).length === 4, 5000, "alice has every row");
  const stack = await a.undoStack();
  assert.deepEqual(stack.map((e) => e.author.turn), ["t1", "t1"], "the turn is in Alice's group");
  const uid = a.newChangeId(); // shared cuts take change ids of the form <rid>.<n>
  const r = await a.undo(undefined, { id: uid });
  assert.ok(r.status === "pending" || r.status === "confirmed", r.status);
  assert.equal(r.entry?.author.turn, "t1");
  await until(async () => (await a.log()).length === 5, 5000, "the undo confirmed");
  const head = (await a.head()).doc;
  assert.equal(item(head, "a")!.name, "a", "the turn's first edit undone");
  assert.equal(item(head, "b")!.name, "b", "the turn's second edit undone");
  assert.equal(item(head, "c")!.name, "bob's", "bob's edit in between kept");
  const undo = (await a.log())[0]!;
  assert.equal(undo.kind, "undo");
  assert.deepEqual(await a.undoStack(), [], "the turn left the stack");
  // every replica sees it as an undo of those changes
  await until(async () => item((await bot.head()).doc, "a")!.name === "a", 5000, "the bot sees the undo");
  await until(async () => (await b.log()).length === 5, 5000, "bob has the undo row");
  assert.equal((await b.log())[0]!.kind, "undo");
  // retried with its id: the first answer, no second change
  const again = await a.undo(undefined, { id: uid });
  assert.equal(again.status, "confirmed");
  assert.equal((await a.log()).length, 5);
  for (const c of [a, b, bot]) await c.close();
  w.host.close();
});

test("undo on a shared cut gives cards when a teammate changed the same field since, and queues nothing", async () => {
  const w = world();
  const { a, join } = await sharedProject(w);
  const bot = await Carton.open({ adapter, store: createMemoryStore(), init: { join }, actor: director("t2"), sync: w.sync("director") });
  const b = await Carton.open({ adapter, store: createMemoryStore(), init: { join }, actor: bob, sync: w.sync("bob") });
  for (const c of [bot, b]) await until(() => c.sync!.status === "up-to-date", 5000, "connected");
  assert.equal((await bot.commit({ ops: [set("a", "name", "director's")], wait: 5000 })).status, "confirmed");
  await until(async () => item((await b.head()).doc, "a")!.name === "director's", 5000, "bob sees it");
  assert.equal((await b.commit({ ops: [set("a", "name", "bob's")], wait: 5000 })).status, "confirmed");
  await until(async () => (await a.log()).length === 3, 5000, "alice has every row");
  const r = await a.undo();
  assert.equal(r.status, "conflicts");
  assert.ok(r.status === "conflicts" && r.cards.some((c) => c.path.startsWith("items/a")));
  assert.equal(a.sync!.state().pending, 0, "nothing queued");
  assert.equal(item((await a.head()).doc, "a")!.name, "bob's");
  for (const c of [a, b, bot]) await c.close();
  w.host.close();
});

test("restore and revert on a shared cut are queued as their own changes, confirmed, and seen by the other replica", async () => {
  const w = world();
  const { a, join } = await sharedProject(w);
  const b = await Carton.open({ adapter, store: createMemoryStore(), init: { join }, actor: bob, sync: w.sync("bob") });
  await until(() => b.sync!.status === "up-to-date", 5000, "connected");
  assert.equal((await a.commit({ ops: [set("a", "name", "one")], wait: 5000 })).status, "confirmed");
  const two = await a.commit({ ops: [set("a", "name", "two"), set("b", "name", "two")], wait: 5000 });
  assert.equal(two.status, "confirmed");
  // restore the version with "one": a new version, nothing lost
  const r = await a.restore(`${a.cut}@1`);
  assert.ok(r.status === "pending" || r.status === "confirmed", r.status);
  await until(async () => (await a.log()).length === 4, 5000, "the restore confirmed");
  assert.equal((await a.log())[0]!.kind, "restore");
  await until(async () => item((await b.head()).doc, "b")!.name === "b", 5000, "bob sees the restore");
  assert.equal(item((await b.head()).doc, "a")!.name, "one");
  // revert the restore itself: back to "two"
  const restoreId = (await a.log())[0]!.change!;
  const v = await a.revert(restoreId);
  assert.ok(v.status === "pending" || v.status === "confirmed", v.status);
  await until(async () => item((await b.head()).doc, "a")!.name === "two", 5000, "bob sees the revert");
  assert.equal((await a.log())[0]!.kind, "revert");
  for (const c of [a, b]) await c.close();
  w.host.close();
});

test("fold in some of it into a shared cut: the fold, then its inverse, confirmed in order; the rest folds in later", async () => {
  const w = world();
  const { a, join } = await sharedProject(w);
  const main = a.cut;
  const b = await Carton.open({ adapter, store: createMemoryStore(), init: { join }, actor: bob, sync: w.sync("bob") });
  await until(() => b.sync!.status === "up-to-date", 5000, "connected");
  const v = await a.fork("30s Instagram cut");
  await a.commit({ cut: v.id, ops: [set("a", "name", "short A")] });
  await a.commit({ cut: v.id, ops: [set("b", "name", "short B")] });
  const r = await a.foldSome(v.id, { into: main, reject: ["items/b"] });
  assert.ok(r.status === "pending" || r.status === "confirmed", r.status);
  await until(async () => (await a.log({ cut: main })).length === 3, 5000, "the fold and its inverse confirmed");
  const [inv, fold] = await a.log({ cut: main });
  assert.equal(fold!.kind, "merge");
  assert.equal(inv!.kind, "partial-revert");
  await until(async () => item((await b.head()).doc, "a")!.name === "short A", 5000, "bob sees the fold");
  assert.equal(item((await b.head()).doc, "b")!.name, "b", "the left-out record stays as it was");
  assert.equal((await a.fold(v.id, { into: main })).status, "up-to-date", "the merge edge is recorded");
  // "Fold in the rest": revert the inverse
  const rest = await a.revert(inv!.change!, { cut: main });
  assert.ok(rest.status === "pending" || rest.status === "confirmed", rest.status);
  await until(async () => item((await b.head()).doc, "b")!.name === "short B", 5000, "the rest folded in");
  for (const c of [a, b]) await c.close();
  w.host.close();
});

test("planned writes on a shared cut wait for this replica's own edits, and refuse while they can't sync", async () => {
  const w = world();
  const { a } = await sharedProject(w);
  await a.commit({ ops: [set("a", "name", "x")], wait: 5000 });
  await a.sync!.disconnect();
  await a.commit({ ops: [set("b", "name", "offline")] });
  await assert.rejects(a.restore(`${a.cut}@0`), /1 edit waiting to sync/);
  await a.sync!.connect();
  // the edit lands first; the restore is then planned on the head that holds it
  const r = await a.restore(`${a.cut}@0`);
  assert.ok(r.status === "pending" || r.status === "confirmed", r.status);
  await until(async () => item((await a.head()).doc, "b")!.name === "b" && a.sync!.state().pending === 0, 5000, "restored");
  await a.close();
  w.host.close();
});

/** A memory store whose next read of a no-op marker (`["noop", id]`, read when a planned write is queued) waits for `open()`. */
function gatedStore() {
  const inner = createMemoryStore();
  let armed = false, reached = false;
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const store = new Proxy(inner, {
    get(t, k) {
      if (k === "get")
        return async (table: string, key: unknown[]) => {
          if (armed && table === "meta" && key[0] === "noop") {
            armed = false;
            reached = true;
            await gate;
          }
          return t.get(table, key as never);
        };
      const v = Reflect.get(t, k, t);
      return typeof v === "function" ? v.bind(t) : v;
    },
  });
  return { store, arm: () => (armed = true), reached: () => reached, open: () => release() };
}
/** A memory store that records each write batch's keys. */
function recordingStore() {
  const inner = createMemoryStore();
  const batches: string[][] = [];
  const store = new Proxy(inner, {
    get(t, k) {
      if (k === "write") return (w: { table: string; key: unknown[] }[], c?: unknown) => (batches.push(w.map((x) => `${x.table}:${JSON.stringify(x.key)}`)), t.write(w as never, c as never));
      const v = Reflect.get(t, k, t);
      return typeof v === "function" ? v.bind(t) : v;
    },
  });
  return { store, batches };
}

test("a planned write meets the rows that arrived after it was planned: a clash is a card, never an overwrite (review R1-3)", async () => {
  const w = world();
  const g = gatedStore();
  const a0 = await Carton.open({ adapter, store: createMemoryStore(), init: { doc: doc0(), projectId: "p" }, actor: alice, sync: w.sync("alice") });
  await a0.share();
  await until(async () => (await a0.cuts())[0]!.sequencer.kind === "server", 5000, "the hand-off");
  const cut = (await a0.cuts())[0]!;
  const join = { projectId: "p", cut, doc0: await a0.checkout(`${cut.id}@0`) };
  await a0.close();
  const a = await Carton.open({ adapter, store: g.store, init: { join }, actor: alice, sync: w.sync("alice") });
  const bot = await Carton.open({ adapter, store: createMemoryStore(), init: { join }, actor: director("t9"), sync: w.sync("director") });
  const b = await Carton.open({ adapter, store: createMemoryStore(), init: { join }, actor: bob, sync: w.sync("bob") });
  for (const c of [a, bot, b]) await until(() => c.sync!.status === "up-to-date", 5000, "connected");
  assert.equal((await bot.commit({ ops: [set("a", "name", "director's")], wait: 5000 })).status, "confirmed");
  await until(async () => item((await a.head()).doc, "a")!.name === "director's", 5000, "alice has the turn");
  // the undo is planned on a head without Bob's edit; Bob's edit to the same field lands before it is queued
  g.arm();
  const undo = a.undo();
  await until(() => g.reached(), 5000, "the undo is planned and about to be queued");
  assert.equal((await b.commit({ ops: [set("a", "name", "bob's")], wait: 5000 })).status, "confirmed");
  await until(async () => item((await a.head()).doc, "a")!.name === "bob's", 5000, "alice's queue has Bob's row");
  g.open();
  const r = await undo;
  assert.equal(r.status, "conflicts", "the clash is a card");
  assert.equal(a.sync!.state().pending, 0, "nothing queued");
  await new Promise((res) => setTimeout(res, 200));
  assert.equal(item((await b.head()).doc, "a")!.name, "bob's", "Bob's edit stands");
  for (const c of [a, bot, b]) await c.close();
  w.host.close();
});

test("fold in some of it on a shared cut queues the fold and its inverse in one store batch (review R1-4)", async () => {
  const w = world();
  const { a: a0, join } = await sharedProject(w);
  await a0.close();
  const rec = recordingStore();
  const a = await Carton.open({ adapter, store: rec.store, init: { join }, actor: alice, sync: w.sync("alice") });
  await until(() => a.sync!.status === "up-to-date", 5000, "connected");
  const v = await a.fork("variant");
  await a.commit({ cut: v.id, ops: [set("a", "name", "va")] });
  await a.commit({ cut: v.id, ops: [set("b", "name", "vb")] });
  const id = a.newChangeId();
  rec.batches.length = 0;
  const r = await a.foldSome(v.id, { into: join.cut.id, reject: ["items/b"], id });
  assert.ok(r.status === "pending" || r.status === "confirmed", r.status);
  const both = rec.batches.find((ks) => ks.includes(`pending:${JSON.stringify([join.cut.id, id])}`));
  assert.ok(both, "the fold's pending row was written");
  assert.ok(both!.includes(`pending:${JSON.stringify([join.cut.id, `${id}.inverse`])}`), "in the same batch as its inverse");
  await until(async () => (await a.log()).length === 3, 5000, "both confirmed");
  await a.close();
  w.host.close();
});

test("a shared Published cut is read-only to every planned write, not only commit (review R1-6)", async () => {
  const w = world();
  const { a } = await sharedProject(w);
  const main = a.cut;
  await a.commit({ ops: [set("a", "name", "one")], wait: 5000 });
  const pub = await a.publish({ name: "Published" });
  await a.share(pub.id);
  await until(async () => (await a.cuts()).find((c) => c.id === pub.id)?.sequencer.kind === "server", 5000, "published cut handed off");
  await assert.rejects(a.restore(`${main}@0`, { cut: pub.id }), /read-only/);
  await assert.rejects(a.undo(undefined, { cut: pub.id }), /read-only/);
  await assert.rejects(a.commit({ cut: pub.id, ops: [set("a", "name", "x")] }), /read-only/);
  // a fold with something to bring in (Main moved on since publishing)
  assert.equal((await a.commit({ ops: [set("a", "name", "two")], wait: 5000 })).status, "confirmed");
  await assert.rejects(a.fold(main, { into: pub.id }), /read-only/);
  assert.equal(item((await a.head(pub.id)).doc, "a")!.name, "one");
  await a.close();
  w.host.close();
});
