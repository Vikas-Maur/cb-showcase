// Regression tests for the GPT 6.1 Sol review round 5 findings (shared-cut wiring; reviews/foundation-core.md).
import { test } from "node:test";
import assert from "node:assert/strict";
import { Carton, type Actor, type Notice } from "@carton/core";
import type { AuthContext, AuthProvider, Store, StoreWrite } from "@carton/core/plugins";
import { createInProcessHost } from "@carton/server";
import { sqliteStorage } from "../../conformance/src/system/sqlite.ts";
import { createMemoryData, createMemoryStore, type MemoryStoreData } from "../src/index.ts";
import { adapter, schema, doc0, set, item } from "./fixture.ts";

const alice: Actor = { kind: "human", id: "alice", group: "alice@laptop" };
const bob: Actor = { kind: "human", id: "bob", group: "bob@desk" };
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
  const sync = (name: string, autoConnect = true) => {
    tokens.set(`tok-${name}`, { account: name, credential: `${name}/install`, role: "editor", projectId: "p", expires: Date.now() + 3600_000 });
    return { transport: host.transport, url: host.url, token: `tok-${name}`, autoConnect };
  };
  return { host, sync };
}
async function copyStore(data: MemoryStoreData): Promise<MemoryStoreData> {
  const from = createMemoryStore({ shared: data });
  const to = createMemoryData();
  const st = createMemoryStore({ shared: to });
  for (const t of data.tables.keys()) {
    const rows = await from.range(t);
    if (rows.length) await st.write(rows.map((r) => ({ table: t, key: r.key, value: JSON.parse(JSON.stringify(r.value)) })));
  }
  return to;
}
/** A store whose write runs `before` (once, when `when` matches) before delegating: a deterministic race. */
function racy(data: MemoryStoreData, when: (w: readonly StoreWrite[]) => boolean, before: () => Promise<void>): Store {
  const inner = createMemoryStore({ shared: data });
  let fired = false;
  return { ...inner, info: inner.info, get: inner.get, range: inner.range, close: inner.close, write: async (w, c) => {
    if (!fired && when(w)) {
      fired = true;
      await before();
    }
    return inner.write(w, c);
  } };
}
async function sharedPair() {
  const w = world();
  const data = createMemoryData();
  const a = await Carton.open({ adapter, store: createMemoryStore({ shared: data }), init: { doc: doc0() }, actor: alice, sync: w.sync("alice") });
  await a.share();
  await until(async () => (await a.cuts())[0]!.sequencer.kind === "server", 5000, "the hand-off");
  const b = await Carton.open({ adapter, store: createMemoryStore({ shared: await copyStore(data) }), actor: bob, sync: w.sync("bob") });
  await until(() => b.sync!.status === "up-to-date", 5000, "bob connected");
  return { w, data, a, b };
}

test("R5-1 a local edit another process confirms during the hand-off is in the log the server adopts", async () => {
  const w = world();
  const data = createMemoryData();
  const other = await Carton.open({ adapter, store: createMemoryStore({ shared: data }), init: { doc: doc0() }, actor: bob });
  // the other process confirms a local edit just before this handle's hand-off write lands
  const store = racy(data, (ws) => ws.some((x) => x.table === "cuts" && (x.value as { sequencer?: { kind: string } })?.sequencer?.kind === "handingOff"), async () => {
    await other.commit({ ops: [set("a", "name", "slipped in")] });
  });
  const a = await Carton.open({ adapter, store, actor: alice, sync: w.sync("alice") });
  const rec = await a.share();
  assert.equal(rec.sequencer.kind === "handingOff" && rec.sequencer.n, 1, "the hand-off retried on the new head");
  await until(async () => (await a.cuts())[0]!.sequencer.kind === "server", 5000, "the hand-off");
  const r = await a.commit({ ops: [set("b", "name", "after")], wait: 5000 });
  assert.equal(r.status, "confirmed");
  const head = (await a.head()).doc;
  assert.equal(item(head, "a")!.name, "slipped in", "the slipped-in edit survived");
  assert.equal(item(head, "b")!.name, "after");
  await a.close();
  w.host.close();
});

test("R5-2 a pending edit that was rebased is kept as rebased: a restart doesn't overwrite the remote edit", async () => {
  const { w, data, a, b } = await sharedPair();
  const a1 = await Carton.open({ adapter, store: createMemoryStore({ shared: data }), actor: alice, sync: w.sync("alice", false) });
  assert.equal((await a1.commit({ ops: [set("c", "name", "mine c"), set("b", "name", "mine b")] })).status, "pending");
  assert.equal((await b.commit({ ops: [set("b", "name", "bob's b")], wait: 5000 })).status, "confirmed");
  const store = createMemoryStore({ shared: data });
  await until(async () => (await store.range("changes")).length === 1, 5000, "bob's row stored by the lease holder");
  await a1.head(); // a1 learns the stored row: its pending edit is rebased (the b clash keeps bob's value)
  await a1.close();
  const a3 = await Carton.open({ adapter, store: createMemoryStore({ shared: data }), actor: alice, sync: w.sync("alice", false) });
  const head = (await a3.head()).doc;
  assert.equal(item(head, "b")!.name, "bob's b", "the rebased version, not the original ops");
  assert.equal(item(head, "c")!.name, "mine c");
  for (const c of [a, b, a3]) await c.close();
  w.host.close();
});

test("R5-3 a failed save of confirmed rows leaves History where the store is, and the next settlement saves them", async () => {
  const w = world();
  const data = createMemoryData();
  let fail = 1;
  const inner = createMemoryStore({ shared: data });
  const flaky: Store = { ...inner, info: inner.info, get: inner.get, range: inner.range, close: inner.close, write: async (ws, c) => {
    if (fail > 0 && ws.some((x) => x.table === "changes") && ws.some((x) => x.table === "pending")) {
      fail--;
      throw new Error("disk busy");
    }
    return inner.write(ws, c);
  } };
  const a = await Carton.open({ adapter, store: flaky, init: { doc: doc0() }, actor: alice, sync: w.sync("alice") });
  await a.share();
  await until(async () => (await a.cuts())[0]!.sequencer.kind === "server", 5000, "the hand-off");
  await a.commit({ ops: [set("a", "name", "x")], wait: 5000 });
  await a.commit({ ops: [set("b", "name", "y")], wait: 5000 });
  await until(async () => (await createMemoryStore({ shared: data }).range("changes")).length === 2, 5000, "both rows saved");
  await a.close();
  const again = await Carton.open({ adapter, store: createMemoryStore({ shared: data }), actor: alice });
  const head = (await again.head()).doc;
  assert.deepEqual([item(head, "a")!.name, item(head, "b")!.name], ["x", "y"]);
  w.host.close();
});

test("R5-4 pending edits come back in their queue order (not by id) after a restart", async () => {
  const w = world();
  const data = createMemoryData();
  const a = await Carton.open({ adapter, store: createMemoryStore({ shared: data }), init: { doc: doc0() }, actor: alice, sync: w.sync("alice"), clock: () => 1000 });
  await a.share();
  await until(async () => (await a.cuts())[0]!.sequencer.kind === "server", 5000, "the hand-off");
  await a.sync!.disconnect();
  for (let i = 1; i <= 12; i++) await a.commit({ ops: [set("a", "name", `edit-${i}`)] });
  assert.equal(item((await a.head()).doc, "a")!.name, "edit-12");
  await a.close();
  const again = await Carton.open({ adapter, store: createMemoryStore({ shared: data }), actor: alice, sync: w.sync("alice", false), clock: () => 1000 });
  assert.equal(item((await again.head()).doc, "a")!.name, "edit-12");
  w.host.close();
});

test("R5-5 an edit queued while a fold is being prepared is never overwritten by the fold", async () => {
  const w = world();
  const data = createMemoryData();
  let c: Carton | null = null;
  let edit: Promise<unknown> | null = null;
  const inner = createMemoryStore({ shared: data });
  // the commit lands while the fold looks up its id (after the fold computed its ops, in the code before the fix)
  const store: Store = { ...inner, info: inner.info, range: inner.range, write: inner.write, close: inner.close, get: async (t, k) => {
    if (c && !edit && t === "meta" && k[0] === "noop" && k[1] === "fold.1") {
      edit = c.commit({ ops: [set("a", "name", "edit")] });
      await edit; // only this read waits for it (the commit's own reads must not)
    }
    return inner.get(t, k);
  } };
  c = await Carton.open({ adapter, store, init: { doc: doc0() }, actor: alice, sync: w.sync("alice") });
  const main = c.cut;
  await c.share();
  await until(async () => (await c!.cuts()).find((x) => x.id === main)!.sequencer.kind === "server", 5000, "the hand-off");
  const v = await c.fork("variant");
  await c.commit({ cut: v.id, ops: [set("a", "name", "variant")] });
  const f = await c.fold(v.id, { into: main, id: "fold.1" }).catch((e: Error) => e);
  assert.ok(f instanceof Error && /waiting to sync/.test(f.message), "the fold sees the queued edit and waits");
  await until(() => c!.sync!.state().pending === 0, 5000, "the edit confirmed");
  assert.equal(item((await c.head(main)).doc, "a")!.name, "edit", "the edit was not overwritten");
  await c.close();
  w.host.close();
});

test("R5-6 an unchanged save on a shared cut spends its id: its retry after another edit stays a no-op", async () => {
  const { w, a, b } = await sharedPair();
  const same = (await a.head()).doc;
  const r1 = await a.commit({ doc: same, id: "cb.save.1" });
  assert.ok(r1.status === "confirmed" && r1.empty);
  await a.commit({ ops: [set("a", "name", "later")], wait: 5000 });
  const r2 = await a.commit({ doc: same, id: "cb.save.1" });
  assert.ok(r2.status === "confirmed" && r2.empty);
  await until(() => a.sync!.state().pending === 0, 5000, "settled");
  assert.equal(item((await a.head()).doc, "a")!.name, "later");
  for (const x of [a, b]) await x.close();
  w.host.close();
});

test("R5-7 an id another process confirmed on a local variant is never confirmed again on a shared cut", async () => {
  const { w, data, a, b } = await sharedPair();
  const other = await Carton.open({ adapter, store: createMemoryStore({ shared: data }), actor: alice, sync: w.sync("alice", false) });
  const v = await a.fork("variant"); // a variant this handle already knows
  await a.cuts();
  await other.commit({ cut: v.id, ops: [set("e", "name", "variant")], id: "cb.write.7" });
  const r = await a.commit({ ops: [set("e", "name", "shared")], id: "cb.write.7" });
  assert.equal(r.status, "confirmed");
  assert.equal(r.status === "confirmed" && r.ref.branchId, v.id, "acked as the variant's change");
  assert.equal(item((await a.head()).doc, "e")!.name, "e", "nothing queued on the shared cut");
  for (const x of [a, b, other]) await x.close();
  w.host.close();
});

test("R5-8 a late conflict is kept as a notice for its writer, also after a restart", async () => {
  const { w, a, b } = await sharedPair();
  const bobStore = (b as unknown as { store: Store }).store;
  await b.sync!.disconnect();
  const mine = await b.commit({ ops: [set("b", "name", "bob's")] });
  assert.equal(mine.status, "pending");
  await a.commit({ ops: [set("b", "name", "alice's")], wait: 5000 });
  await b.sync!.connect({ nonce: "bob-lease" });
  await until(async () => (await b.notices(bob)).length > 0, 5000, "the notice");
  const n = (await b.notices(bob)) as Notice[];
  assert.equal(n[0]!.kind, "late-conflict");
  await b.close();
  const again = await Carton.open({ adapter, store: bobStore, actor: bob });
  assert.equal((await again.notices(bob, { take: true }))[0]!.kind, "late-conflict");
  await a.close();
  w.host.close();
});

test("R5-9 a shared commit honours the caller's conditions (a lease fence)", async () => {
  const { w, data, a, b } = await sharedPair();
  await createMemoryStore({ shared: data }).write([{ table: "lease", key: ["sync", "nonce"], value: "n2" }]);
  await assert.rejects(a.commit({ ops: [set("a", "name", "fenced")], conditions: [{ table: "lease", key: ["sync", "nonce"], expect: { equals: "n1" } }] }), /condition failed/);
  assert.equal(item((await a.head()).doc, "a")!.name, "a");
  assert.equal(a.sync!.state().pending, 0);
  assert.equal((await createMemoryStore({ shared: data }).range("pending")).length, 0);
  for (const x of [a, b]) await x.close();
  w.host.close();
});

test("R5-10 a pin of a shared cut includes its pending edits", async () => {
  const { w, a, b } = await sharedPair();
  await a.sync!.disconnect();
  const r = await a.commit({ ops: [set("a", "name", "pending edit")] });
  const p = await a.pin({ owner: "agent-turn" });
  assert.deepEqual(p.ref.pending, [r.status === "pending" ? r.id : ""]);
  assert.equal(item(await a.checkout(p.header), "a")!.name, "pending edit");
  for (const x of [a, b]) await x.close();
  w.host.close();
});

test("R5-11 reopened without auto-connect, a shared cut shows its pending edits and their count", async () => {
  const { w, data, a, b } = await sharedPair();
  await a.sync!.disconnect();
  await a.commit({ ops: [set("a", "name", "offline")] });
  await a.close();
  const again = await Carton.open({ adapter, store: createMemoryStore({ shared: data }), actor: alice, sync: w.sync("alice", false) });
  assert.equal(again.sync!.state().pending, 1);
  assert.equal(item((await again.head()).doc, "a")!.name, "offline");
  for (const x of [again, b]) await x.close();
  w.host.close();
});
