// How a shared cut's answers are settled into the store (absorbed from local-cli's `2dab570`, Stage F review round 1,
// findings 1, 2, 3, 9; ported here from its `runWrite` tests to Carton itself): an empty commit stays empty on retry; a
// holder the lease moved on from records nothing and stops; a change refused at once finds its author and never comes
// back pending; a live absorption answers as an empty confirmation.
import { test } from "node:test";
import assert from "node:assert/strict";
import { Carton, actorKey, type Actor } from "@carton/core";
import type { Store, StoreCondition, Transport } from "@carton/core/plugins";
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
