// A shared cut's commit carries the caller's conditions (a lease fence) in the very write that queues it (windows-sync
// review round 3 #1): checked before the edit was queued but not with its pending row, a lease taken over in between
// left the edit pending in a process that no longer held the lease. Now that write fails, nothing is stored, the queue
// takes the edit back without an outcome, and the commit is rejected.
import { test } from "node:test";
import assert from "node:assert/strict";
import { Carton, type Actor, type Store } from "@carton/core";
import type { AuthContext, AuthProvider, StoreCondition, StoreWrite } from "@carton/core/plugins";
import { createInProcessHost } from "@carton/server";
import { sqliteStorage } from "../../conformance/src/system/sqlite.ts";
import { createMemoryData, createMemoryStore, type MemoryStoreData } from "../src/index.ts";
import { adapter, schema, doc0, set, item } from "./fixture.ts";

const alice: Actor = { kind: "human", id: "alice", group: "alice@laptop" };
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
  tokens.set("tok-alice", { account: "alice", credential: "alice/install", role: "editor", projectId: "p", expires: Date.now() + 3600_000 });
  return { host, sync: { transport: host.transport, url: host.url, token: "tok-alice", autoConnect: true } };
}

const LEASE = ["sync", "nonce"];
const fence: StoreCondition = { table: "lease", key: LEASE, expect: { equals: "n1" } };
const isFence = (c: StoreCondition) => c.table === "lease" && c.key[0] === "sync" && (c.expect as { equals?: unknown })?.equals === "n1";

/**
 * Alice's store, on which another process takes the lease over (`armed`) the moment the check of the fence alone (a
 * write of nothing, conditioned on it) has passed: between the check and the write that queues the edit.
 */
function takeover(data: MemoryStoreData) {
  const inner = createMemoryStore({ shared: data });
  const s = { armed: false, fired: false };
  const store: Store = { ...inner, info: inner.info, get: inner.get, range: inner.range, close: inner.close, write: async (w: readonly StoreWrite[], c?: readonly StoreCondition[]) => {
    const ok = await inner.write(w, c);
    if (s.armed && !s.fired && ok && w.length === 0 && c?.some(isFence)) {
      s.fired = true;
      await inner.write([{ table: "lease", key: LEASE, value: "n2" }]);
    }
    return ok;
  } };
  return { store, s };
}

async function sharedAlice() {
  const w = world();
  const data = createMemoryData();
  const t = takeover(data);
  const a = await Carton.open({ adapter, store: t.store, init: { doc: doc0() }, actor: alice, sync: w.sync });
  await a.share();
  await until(async () => (await a.cuts())[0]!.sequencer.kind === "server", 5000, "the hand-off");
  await createMemoryStore({ shared: data }).write([{ table: "lease", key: LEASE, value: "n1" }]);
  return { w, data, a, t, raw: createMemoryStore({ shared: data }) };
}

test("a lease taken over between the check of the commit's conditions and the write that queues it: the commit is rejected, nothing is pending", async () => {
  const { w, a, t, raw } = await sharedAlice();
  t.s.armed = true;
  await assert.rejects(a.commit({ ops: [set("a", "name", "fenced")], conditions: [fence] }), /condition failed/);
  assert.ok(t.s.fired, "the lease moved after the check passed");
  assert.equal(item((await a.head()).doc, "a")!.name, "a", "the edit isn't in the head");
  assert.equal(a.sync!.state().pending, 0, "nor in the queue");
  assert.equal((await raw.range("pending")).length, 0, "nor in the store");
  assert.deepEqual(await a.notices(alice), [], "nothing to tell: the commit itself was refused");
  // the queue is whole: a commit after it (the new holder's lease back in place) goes through
  await raw.write([{ table: "lease", key: LEASE, value: "n1" }]);
  const r = await a.commit({ ops: [set("b", "name", "after")], conditions: [fence], wait: 5000 });
  assert.equal(r.status, "confirmed");
  assert.equal(item((await a.head()).doc, "a")!.name, "a");
  assert.equal(item((await a.head()).doc, "b")!.name, "after");
  await a.close();
  w.host.close();
});

test("the edit taken back leaves an earlier pending edit as it was, which still goes through", async () => {
  const { w, a, t, raw } = await sharedAlice();
  await a.sync!.disconnect();
  const first = await a.commit({ ops: [set("c", "name", "queued first")] });
  assert.equal(first.status, "pending");
  t.s.armed = true;
  await assert.rejects(a.commit({ ops: [set("a", "name", "fenced")], conditions: [fence] }), /condition failed/);
  assert.equal(a.sync!.state().pending, 1);
  assert.deepEqual((await raw.range<{ id: string }>("pending")).map((e) => e.value.id), [first.status === "pending" ? first.id : ""]);
  const head = (await a.head()).doc;
  assert.equal(item(head, "c")!.name, "queued first");
  assert.equal(item(head, "a")!.name, "a");
  await a.sync!.connect({ nonce: "n1" });
  await until(async () => a.sync!.state().pending === 0 && (await raw.range("pending")).length === 0, 5000, "the first edit confirmed");
  assert.equal(item((await a.head()).doc, "c")!.name, "queued first");
  await a.close();
  w.host.close();
});

test("an empty commit (nothing changes) carries the conditions too: a takeover rejects it and spends nothing", async () => {
  const { w, a, t, raw } = await sharedAlice();
  t.s.armed = true;
  const id = a.newChangeId();
  await assert.rejects(a.commit({ id, ops: [set("a", "name", "a")], conditions: [fence] }), /condition failed/);
  assert.equal(await raw.get("meta", ["noop", id]), undefined, "its id isn't spent: the holder can still apply it");
  await a.close();
  w.host.close();
});
