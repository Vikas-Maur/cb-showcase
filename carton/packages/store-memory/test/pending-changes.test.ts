// Carton.pendingChanges(cut?) (cardboard-adapter's contract(core) 9f90db1), checked by core's owner: this handle's
// queue in order, each change's author and the states around it, the last one head()'s; read-only; next to
// pendingCount, which counts every process's stored rows.
import { test } from "node:test";
import assert from "node:assert/strict";
import { Carton, hashDoc, type Actor, type Store } from "@carton/core";
import type { AuthContext, AuthProvider, StoreWrite } from "@carton/core/plugins";
import { createInProcessHost } from "@carton/server";
import { sqliteStorage } from "../../conformance/src/system/sqlite.ts";
import { createMemoryData, createMemoryStore } from "../src/index.ts";
import { adapter, schema, doc0, set, item } from "./fixture.ts";

const alice: Actor = { kind: "human", id: "alice", group: "alice@laptop" };
const agent: Actor = { kind: "agent", id: "claude", group: "alice@laptop" };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(pred: () => boolean | Promise<boolean>, ms = 5000, what = "condition"): Promise<void> {
  const end = Date.now() + ms;
  while (!(await pred())) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(10);
  }
}
const same = (a: unknown, b: unknown) => hashDoc(a as never, schema) === hashDoc(b as never, schema);

test("pendingChanges: this handle's queue in order with authors; states chain from the confirmed one to head(); no store write; a handle without sync lists none while pendingCount counts them", async () => {
  const tokens = new Map<string, AuthContext>();
  const auth: AuthProvider = { kind: "table", async verify(t) { return tokens.get(t) ?? null; } };
  const host = createInProcessHost({ storage: sqliteStorage(), auth, timeline: schema.timeline!, groupOf: (c, f) => schema.collections[c]?.groupOf.get(f)?.name });
  tokens.set("tok-alice", { account: "alice", credential: "alice/install", role: "editor", projectId: "p", expires: Date.now() + 3600_000 });
  const data = createMemoryData();
  const inner = createMemoryStore({ shared: data });
  let writes = 0;
  const store: Store = { ...inner, info: inner.info, get: inner.get, range: inner.range, close: inner.close, write: (w: readonly StoreWrite[], c) => (writes++, inner.write(w, c)) };
  const a = await Carton.open({ adapter, store, init: { doc: doc0() }, actor: alice, sync: { transport: host.transport, url: host.url, token: "tok-alice", autoConnect: true } });
  await a.share();
  await until(async () => (await a.cuts())[0]!.sequencer.kind === "server", 5000, "the hand-off");
  const c0 = await a.commit({ ops: [set("a", "name", "confirmed")], wait: 5000 });
  assert.equal(c0.status, "confirmed");
  await a.sync!.disconnect();
  const r1 = await a.commit({ ops: [set("a", "name", "alice's")] });
  const r2 = await a.commit({ ops: [set("b", "name", "the agent's")], author: agent });
  assert.ok(r1.status === "pending" && r2.status === "pending");
  await a.head(); // the settles the commits queued (pendingChanges waits for them, as head() does) have run
  writes = 0;
  const pc = await a.pendingChanges();
  assert.equal(writes, 0, "read-only: no write of its own");
  assert.deepEqual(pc.changes.map((c) => [c.id, c.author.id]), [[r1.id, "alice"], [r2.id, "claude"]]);
  assert.equal(pc.seq, c0.status === "confirmed" ? c0.seq : -1, "the confirmed seq the queue is on");
  assert.ok(same(pc.changes[0]!.before, await a.checkout(`${a.cut}@${pc.seq}`)), "the first change's before is the confirmed state");
  assert.ok(same(pc.changes[0]!.after, pc.changes[1]!.before));
  assert.equal(item(pc.changes[0]!.after, "a")!.name, "alice's");
  assert.equal(item(pc.changes[0]!.after, "b")!.name, "b");
  assert.ok(same(pc.changes[1]!.after, (await a.head()).doc), "the last change's after is head()");
  // a handle without sync (cb): pendingCount counts the stored rows, pendingChanges has no queue to list
  const cb = await Carton.open({ adapter, store: createMemoryStore({ shared: data }), actor: alice });
  assert.equal(await cb.pendingCount(a.cut), 2);
  assert.deepEqual((await cb.pendingChanges(a.cut)).changes, []);
  // a cut this replica sequences itself: none
  const v = await a.fork("variant");
  await a.commit({ cut: v.id, ops: [set("c", "name", "local")] });
  assert.deepEqual(await a.pendingChanges(v.id), { seq: 1, changes: [] });
  for (const x of [cb, a]) await x.close();
  host.close();
});

test("pendingChanges' rebases (cardboard-adapter b2c8656): 0 as committed, 1 once a confirmed change another process stored is rebased under it", async () => {
  const tokens = new Map<string, AuthContext>();
  const auth: AuthProvider = { kind: "table", async verify(t) { return tokens.get(t) ?? null; } };
  const host = createInProcessHost({ storage: sqliteStorage(), auth, timeline: schema.timeline!, groupOf: (c, f) => schema.collections[c]?.groupOf.get(f)?.name });
  for (const n of ["alice", "bob"]) tokens.set(`tok-${n}`, { account: n, credential: `${n}/install`, role: "editor", projectId: "p", expires: Date.now() + 3600_000 });
  const data = createMemoryData();
  // the holder (connected), and another process on the same carton.db that never connects (its edits stay pending)
  const a = await Carton.open({ adapter, store: createMemoryStore({ shared: data }), init: { doc: doc0() }, actor: alice, sync: { transport: host.transport, url: host.url, token: "tok-alice", autoConnect: true } });
  await a.share();
  await until(async () => (await a.cuts())[0]!.sequencer.kind === "server", 5000, "the hand-off");
  const b = await Carton.open({ adapter, store: createMemoryStore({ shared: data }), actor: agent, sync: { transport: host.transport, url: host.url, token: "tok-bob", autoConnect: false } });
  const mine = await b.commit({ ops: [set("c", "name", "the agent's")] });
  assert.equal(mine.status, "pending");
  assert.deepEqual((await b.pendingChanges()).changes.map((c) => [c.id, c.rebases]), [[mine.status === "pending" ? mine.id : "", 0]], "as committed");
  assert.equal((await a.commit({ ops: [set("a", "name", "the holder's")], wait: 5000 })).status, "confirmed");
  const pc = await b.pendingChanges(); // reads the holder's row, which the queue takes in under the pending edit
  assert.deepEqual(pc.changes.map((c) => c.rebases), [1], "rebased once");
  assert.equal(item(pc.changes[0]!.before, "a")!.name, "the holder's", "on the confirmed change");
  assert.equal(item(pc.changes[0]!.after, "c")!.name, "the agent's");
  for (const x of [b, a]) await x.close();
  host.close();
});
