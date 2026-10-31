// Joining a shared cut from nothing (`init: {join}`: a browser opening an invite link) and undo on a shared cut (the
// §17 script's "undo the agent's turn"), against a real sequencer (the in-process host of @carton/server).
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
