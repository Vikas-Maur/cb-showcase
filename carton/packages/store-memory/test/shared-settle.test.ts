// How a shared cut's answers are settled into the store (absorbed from local-cli's `2dab570`, Stage F review round 1,
// findings 1, 2, 3, 9; ported here from its `runWrite` tests to Carton itself): an empty commit stays empty on retry; a
// holder the lease moved on from records nothing and stops; a change refused at once finds its author and never comes
// back pending; a live absorption answers as an empty confirmation.
import { test } from "node:test";
import assert from "node:assert/strict";
import { Carton, actorKey, type Actor } from "@carton/core";
import type { BlobStore, Store, StoreCondition, Transport } from "@carton/core/plugins";
import { createMemoryBlobStore } from "../../blob-memory/src/index.ts";
import { createMemoryStore } from "../src/index.ts";
import { adapter, doc0, set, item } from "./fixture.ts";
import { copyStore, sleep, until, world } from "./world.ts";

const alice: Actor = { kind: "human", id: "alice", group: "alice@laptop" };
const agent: Actor = { kind: "agent", id: "claude-code/s1", name: "Claude Code", group: "alice@laptop" };
const bob: Actor = { kind: "human", id: "bob", group: "bob@desk" };
const holder = (nonce: string): StoreCondition => ({ table: "lease", key: ["holder"], expect: { equals: { nonce } } });

async function shared(w: ReturnType<typeof world>, store: Store, actor: Actor = alice, transport?: Transport, connect: Parameters<NonNullable<Carton["sync"]>["connect"]>[0] = { nonce: "n1" }) {
  const c = await Carton.open({ adapter, store, init: { doc: doc0() }, actor, sync: { ...w.sync("alice", false), ...(transport ? { transport } : {}) } });
  await c.share();
  assert.ok(await c.sync!.connect(connect));
  await until(async () => (await c.cuts())[0]!.sequencer.kind === "server", 5000, "the hand-off");
  return c;
}

test("finding 1: an empty commit on a shared cut stays empty on retry, never applied later over someone else's edit", async () => {
  const w = world();
  const sa = createMemoryStore();
  const a = await shared(w, sa);
  const b = await Carton.open({ adapter, store: await copyStore(sa), actor: bob, sync: w.sync("bob") });
  await until(() => b.sync!.status === "up-to-date", 5000, "bob connected");
  // a save of the doc as it already is (as cb's runWrite sends it): nothing to record
  const saved = (await a.head()).doc;
  const empty = await a.commit({ id: "sf1.1", doc: saved });
  assert.equal(empty.status === "confirmed" && empty.empty, true, JSON.stringify(empty));
  assert.equal((await b.commit({ ops: [set("a", "name", "other")], wait: 5000 })).status, "confirmed");
  await until(async () => item((await a.head()).doc, "a")!.name === "other", 5000, "bob's edit at alice");
  const again = await a.commit({ id: "sf1.1", doc: saved });
  assert.equal(again.status === "confirmed" && again.empty, true, "the retry is still the empty answer");
  await sleep(50);
  assert.equal(item((await a.head()).doc, "a")!.name, "other", "never re-applied over bob's edit");
  assert.ok(!(await a.log()).some((v) => v.change === "sf1.1"));
  await a.close();
  await b.close();
  w.host.close();
});

test("finding 2: a holder the lease moved on from records nothing from the server and stops; its replacement records it once", async () => {
  const w = world();
  const store = createMemoryStore();
  await store.write([{ table: "lease", key: ["holder"], value: { nonce: "old" } }]);
  // its own fence still says yes (it hasn't noticed); the store's condition is what holds
  const a = await shared(w, store, alice, undefined, { nonce: "old", fence: () => true, conditions: [holder("old")] });
  const stopped: string[] = [];
  a.on((e) => void (e.type === "sync" && e.status === "stopped" && stopped.push("stopped")));
  await store.write([{ table: "lease", key: ["holder"], value: { nonce: "new" } }]);
  const r = await a.commit({ ops: [set("d", "name", "while replaced")] });
  assert.equal(r.status, "pending");
  const id = r.status === "pending" ? r.id : "";
  await until(() => stopped.length > 0, 5000, "the replaced holder to stop");
  assert.equal(await store.get("ids", [id]), undefined, "the replaced holder recorded nothing");
  assert.ok(await store.get("pending", [a.cut, id]), "its pending row stays for the replacement");
  await a.close();
  const b = await Carton.open({ adapter, store, actor: alice, sync: w.sync("alice", false) });
  assert.ok(await b.sync!.connect({ nonce: "new", conditions: [holder("new")] }));
  await until(async () => (await store.get("ids", [id])) !== undefined, 5000, "the replacement to record it");
  assert.equal(await store.get("pending", [b.cut, id]), undefined);
  assert.equal(item((await b.head()).doc, "d")!.name, "while replaced");
  await b.close();
  w.host.close();
});

test("finding 3: a change refused at once finds its author, tells them once, and never comes back pending", async () => {
  const w = world();
  // pending rows land late, as on a busy carton.db: the refusal must not settle before the row it removes exists
  const mem = createMemoryStore();
  // (the first write of each row: the commit's own, which a settlement must wait for)
  const first = new Set<string>();
  const store: Store = Object.assign(Object.create(mem) as Store, {
    write: async (ws: Parameters<Store["write"]>[0], c?: Parameters<Store["write"]>[1]) => {
      const fresh = ws.filter((x) => x.table === "pending" && x.value !== undefined && !first.has(String(x.key[1])));
      for (const x of fresh) first.add(String(x.key[1]));
      if (fresh.length) await sleep(150);
      return mem.write(ws, c);
    },
  });
  const a = await shared(w, store, alice);
  // the server refuses it as soon as it arrives: its rid ("zz") belongs to bob's device, who used it first (§6.3)
  const b = await Carton.open({ adapter, store: await copyStore(mem), actor: bob, sync: w.sync("bob") });
  await until(() => b.sync!.status === "up-to-date", 5000, "bob connected");
  assert.equal((await b.commit({ id: "zz.1", ops: [set("b", "name", "bob's")], wait: 5000 })).status, "confirmed");
  await b.close();
  const r = await a.commit({ id: "zz.2", ops: [set("c", "name", "agent's")], author: agent });
  const id = r.status === "pending" ? r.id : assert.fail(r.status);
  await until(async () => (await a.notices(agent)).some((n) => n.change === id), 5000, "the author's notice");
  await sleep(100);
  assert.equal((await a.notices(agent)).filter((n) => n.change === id).length, 1, "told once, to its author");
  assert.equal((await a.notices(alice)).filter((n) => n.change === id).length, 0, "not to the holder's actor");
  assert.ok(!(await mem.range<{ id: string }>("pending")).some((x) => x.value.id === id), "not back in the pending table");
  await a.close();
  const again = await Carton.open({ adapter, store: mem, actor: alice, sync: w.sync("alice", false) });
  assert.equal(again.sync!.state().pending, 0, "a restart doesn't queue it again");
  await again.close();
  w.host.close();
});

test("finding 9: a live absorption (another replica saved the identical edit first) answers as an empty confirmation", async () => {
  const w = world();
  const sa = createMemoryStore();
  const a = await shared(w, sa);
  await a.sync!.disconnect();
  const b = await Carton.open({ adapter, store: await copyStore(sa), actor: bob, sync: w.sync("bob") });
  await until(() => b.sync!.status === "up-to-date", 5000, "bob connected");
  assert.equal((await b.commit({ ops: [set("e", "name", "same")], wait: 5000 })).status, "confirmed");
  // alice's identical edit waits for its answer while she reconnects
  const p = a.commit({ ops: [set("e", "name", "same")], wait: 5000 });
  await sleep(10);
  assert.ok(await a.sync!.connect({ nonce: "n2" }));
  const r = await p;
  assert.equal(r.status, "confirmed", JSON.stringify(r));
  assert.equal(r.status === "confirmed" && r.empty, true, "saved in effect, with nothing of its own");
  const r2 = await (async () => {
    await a.sync!.disconnect();
    const x = await a.commit({ ops: [set("f", "name", "same too")] });
    assert.equal((await b.commit({ ops: [set("f", "name", "same too")], wait: 5000 })).status, "confirmed");
    void a.sync!.connect({ nonce: "n3" });
    return a.sync!.waitFor(x.status === "pending" ? x.id : "", 5000);
  })();
  assert.equal(r2.status, "absorbed", "its outcome says absorbed, not confirmed");
  assert.equal(actorKey(alice), "human/alice");
  await a.close();
  await b.close();
  w.host.close();
});

test("F5: a process without the sync lease queues a shared-cut write in carton.db; the next holder to start pushes it", async () => {
  const w = world();
  const store = createMemoryStore();
  const h = await shared(w, store, alice, undefined, { nonce: "h1" });
  // another process on the same carton.db (a cb call that committed itself instead of handing the write to the
  // holder): it never connects, so its write waits in the store
  const n = await Carton.open({ adapter, store, actor: agent, sync: w.sync("alice", false) });
  const r = await n.commit({ ops: [set("a", "name", "from another process")] });
  const id = r.status === "pending" ? r.id : assert.fail(r.status);
  assert.ok(await store.get("pending", [n.cut, id]), "kept in carton.db");
  await sleep(100);
  assert.equal(await store.get("ids", [id]), undefined, "the running holder doesn't push another process's queue");
  await h.close();
  const h2 = await Carton.open({ adapter, store, actor: alice, sync: w.sync("alice", false) });
  assert.ok(await h2.sync!.connect({ nonce: "h2" }));
  await until(async () => (await store.get("ids", [id])) !== undefined, 5000, "the next holder to push it");
  await until(async () => (await n.log()).some((v) => v.change === id), 5000, "the writer to see it confirmed");
  assert.equal(item((await h2.head()).doc, "a")!.name, "from another process");
  for (const c of [n, h2]) await c.close();
  w.host.close();
});

test("verify-ci #10: a change over the client's message limit is refused as too large, never confirmed; the next edit still goes through", { timeout: 120_000 }, async () => {
  const w = world();
  const mem = createMemoryStore();
  const a = await shared(w, mem);
  // over the client's own limit without blob envelopes (32 MiB, a WebSocket frame): refused before it is sent
  const big = await a.commit({ ops: [set("c", "name", "x".repeat(33 << 20))], author: agent, wait: 5000 });
  assert.equal(big.status, "rejected", JSON.stringify(big).slice(0, 200));
  assert.equal(big.status === "rejected" && big.reason, "too large");
  const next = await a.commit({ ops: [set("d", "name", "small")], wait: 5000 });
  assert.equal(next.status, "confirmed", "the edit after it is not held back");
  assert.equal(item((await a.head()).doc, "c")!.name, "c", "the refused edit is not in the head");
  assert.deepEqual((await a.notices(agent)).filter((n) => n.kind === "rejected").map((n) => n.cut), [a.cut], "its author is told once, with the cut (ui 37efc2a)");
  assert.equal((await mem.range("pending")).length, 0, "nothing left pending");
  assert.ok(!(await a.log()).some((v) => v.author?.id === agent.id), "never confirmed");
  await a.close();
  w.host.close();
});

/** A shared cut on a Carton whose sync client gets `extra` (a blob store, a message limit), over `transport`. */
async function sharedWith(w: ReturnType<typeof world>, store: Store, extra: { blobs?: BlobStore; maxMessageBytes?: number }, transport: Transport = w.host.transport) {
  const c = await Carton.open({ adapter, store, init: { doc: doc0() }, actor: alice, sync: { ...w.sync("alice", false), transport, ...extra } });
  await c.share();
  assert.ok(await c.sync!.connect({ nonce: "n1" }));
  await until(async () => (await c.cuts())[0]!.sequencer.kind === "server", 5000, "the hand-off");
  return c;
}
async function refusedAlone(c: Carton, store: Store, size: number) {
  const big = await c.commit({ ops: [set("c", "name", "x".repeat(size))], author: agent, wait: 5000 });
  assert.equal(big.status, "rejected", JSON.stringify(big).slice(0, 200));
  assert.equal(big.status === "rejected" && big.reason, "too large");
  assert.equal((await c.commit({ ops: [set("d", "name", "small")], wait: 5000 })).status, "confirmed", "the edit after it goes through");
  assert.equal((await c.notices(agent)).filter((n) => n.kind === "rejected").length, 1, "its author is told once");
  assert.equal((await store.range("pending")).length, 0, "nothing left pending");
}

test("verify-ci #10: with `sync.blobs` the host's declared message limit is the client's: a change over it is refused as too large", async () => {
  const w = world();
  // the welcome declares 16 KiB, as a host with blob envelopes and a smaller frame does
  const transport: Transport = {
    async connect(url, o) {
      const inner = await w.host.transport.connect(url, o);
      return {
        get open() {
          return inner.open;
        },
        send: (m) => inner.send(m),
        onClose: (f) => inner.onClose(f),
        close: (...x) => inner.close(...x),
        onMessage: (f) => inner.onMessage((m: unknown) => f(((m as { type?: string })?.type === "hello" ? { ...(m as object), maxMessageBytes: 16 * 1024 } : m) as never)),
      } as typeof inner;
    },
  } as Transport;
  const store = createMemoryStore();
  const c = await sharedWith(w, store, { blobs: createMemoryBlobStore() }, transport);
  await refusedAlone(c, store, 64 * 1024);
  await c.close();
  w.host.close();
});

test("verify-ci #10: `sync.maxMessageBytes` matches a host set below 32 MiB: a change over it is refused as too large, not left pending", async () => {
  const w = world();
  const store = createMemoryStore();
  const c = await sharedWith(w, store, { maxMessageBytes: 64 * 1024 });
  await refusedAlone(c, store, 200 * 1024);
  await c.close();
  w.host.close();
});

// local-cli's Stage F review round 2 requests (their notes, "Requests for foundation-core"), on Carton itself

test("round-2 request 1: a pending row whose write starts while a settle waits never lingers once its change is confirmed", async () => {
  const w = world();
  const mem = createMemoryStore();
  // every change's first pending-row write lands late, as on a busy carton.db
  const first = new Set<string>();
  const store: Store = Object.assign(Object.create(mem) as Store, {
    write: async (ws: Parameters<Store["write"]>[0], c?: Parameters<Store["write"]>[1]) => {
      const fresh = ws.filter((x) => x.table === "pending" && x.value !== undefined && !first.has(String(x.key[1])));
      for (const x of fresh) first.add(String(x.key[1]));
      if (fresh.length) await sleep(120);
      return mem.write(ws, c);
    },
  });
  const a = await shared(w, store);
  const x = await a.commit({ ops: [set("a", "name", "x")] });
  await sleep(30); // a settle is now waiting for x's row; y's write starts during that wait
  const y = await a.commit({ ops: [set("b", "name", "y")] });
  const ids = [x, y].map((r) => (r.status === "pending" ? r.id : assert.fail(r.status)));
  for (const id of ids) assert.equal((await a.sync!.waitFor(id, 5000)).status, "confirmed");
  await sleep(300);
  assert.deepEqual((await mem.range("pending")).map((e) => e.key[1]), [], "no row left behind");
  await a.close();
  const again = await Carton.open({ adapter, store: mem, actor: alice, sync: w.sync("alice", false) });
  assert.equal(again.sync!.state().pending, 0, "nothing re-queued after a restart");
  await again.close();
  w.host.close();
});

test("round-2 request 2: a fenced handle connected again under a new nonce pushes what it had pending, and its author hears", async () => {
  const w = world();
  const mem = createMemoryStore();
  await mem.write([{ table: "lease", key: ["holder"], value: { nonce: "old" } }]);
  // the lease moves to another holder exactly as this one settles the refusal: its queue has already dropped the change
  let moveOnNotice = false;
  const store: Store = Object.assign(Object.create(mem) as Store, {
    write: async (ws: Parameters<Store["write"]>[0], c?: Parameters<Store["write"]>[1]) => {
      if (moveOnNotice && ws.some((x) => x.table === "notices")) {
        moveOnNotice = false;
        await mem.write([{ table: "lease", key: ["holder"], value: { nonce: "new" } }]);
      }
      return mem.write(ws, c);
    },
  });
  const a = await shared(w, store, alice, undefined, { nonce: "old", fence: () => true, conditions: [holder("old")] });
  // bob's device owns rid "zz": a change under it is refused by the server
  const b = await Carton.open({ adapter, store: await copyStore(mem), actor: bob, sync: w.sync("bob") });
  await until(() => b.sync!.status === "up-to-date", 5000, "bob connected");
  assert.equal((await b.commit({ id: "zz.1", ops: [set("b", "name", "bob's")], wait: 5000 })).status, "confirmed");
  await b.close();
  const stopped: string[] = [];
  a.on((e) => void (e.type === "sync" && e.status === "stopped" && stopped.push("stopped")));
  moveOnNotice = true;
  const r = await a.commit({ id: "zz.2", ops: [set("c", "name", "agent's")], author: agent });
  assert.equal(r.status, "pending");
  await until(() => stopped.length > 0, 5000, "the fenced holder to stop");
  assert.equal((await a.notices(agent)).length, 0, "the fenced holder recorded nothing");
  assert.ok(await mem.get("pending", [a.cut, "zz.2"]), "its row stays");
  // the lease comes back to this handle (the app's engine thread re-acquires)
  await mem.write([{ table: "lease", key: ["holder"], value: { nonce: "back" } }]);
  assert.ok(await a.sync!.connect({ nonce: "back", conditions: [holder("back")] }));
  await until(async () => (await a.notices(agent)).some((n) => n.change === "zz.2"), 5000, "the author's notice");
  assert.equal(await mem.get("pending", [a.cut, "zz.2"]), undefined, "and the row is gone");
  await a.close();
  w.host.close();
});

test("round-2 request 3: an empty shared save records a no-op only while nobody else answered its id", async () => {
  const w = world();
  const mem = createMemoryStore();
  await mem.write([{ table: "lease", key: ["holder"], value: { nonce: "old" } }]);
  const a = await shared(w, mem, alice, undefined, { nonce: "old", fence: () => true, conditions: [holder("old")] });
  const saved = (await a.head()).doc;
  // its id already queued by another holder: the answer is that, not a no-op beside it
  await mem.write([{ table: "pending", key: [a.cut, "q1.1"], value: { id: "q1.1", author: alice, ops: [set("a", "name", "theirs")], at: 0, order: 0, intent: null, kinds: null, policy: "merge" } }]);
  const queued = await a.commit({ id: "q1.1", doc: saved });
  assert.equal(queued.status, "pending");
  assert.equal(await mem.get("meta", ["noop", "q1.1"]), undefined);
  // the lease moved to another holder: no no-op is recorded, and the write says so
  await mem.write([{ table: "lease", key: ["holder"], value: { nonce: "new" } }]);
  await assert.rejects(a.commit({ id: "q2.1", doc: saved }), /lease moved/);
  assert.equal(await mem.get("meta", ["noop", "q2.1"]), undefined);
  await a.close();
  w.host.close();
});

test("round-2 request 4: an empty shared save names the same version on retry, with edits still waiting to sync", async () => {
  const w = world();
  const mem = createMemoryStore();
  const a = await shared(w, mem);
  await a.sync!.disconnect();
  assert.equal((await a.commit({ ops: [set("a", "name", "waiting")] })).status, "pending");
  const doc = (await a.head()).doc;
  const first = await a.commit({ id: "e4.1", doc });
  const retry = await a.commit({ id: "e4.1", doc });
  assert.equal(first.status === "confirmed" && first.empty, true, JSON.stringify(first));
  assert.deepEqual(retry, first, "the same answer, version and ref");
  await a.close();
  w.host.close();
});
