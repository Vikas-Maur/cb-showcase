// Regressions from Stage F review round 6, second pass (GPT 6.1 Sol, high) over a8536bd; the reviewer's repros, kept.
import { test } from "node:test";
import assert from "node:assert/strict";
import { Carton, type Store } from "@carton/core";
import type { StoreCondition } from "@carton/core/plugins";
import { createMemoryData, createMemoryStore } from "../src/index.ts";
import { adapter, doc0, set } from "./fixture.ts";
import { until, world } from "./world.ts";

const fence: StoreCondition = { table: "lease", key: ["holder"], expect: { equals: "old" } };
const latch = () => {
  let release!: () => void;
  return { p: new Promise<void>((r) => (release = r)), release: () => release() };
};

test("R6-4 an empty shared commit whose store write throws must not poison a nonempty retry", async () => {
  const w = world();
  const raw = createMemoryStore();
  let armed = false;
  const store: Store = { ...raw, write: async (writes, conditions) => {
    if (armed && writes.some((x) => x.table === "meta" && x.key[0] === "noop")) {
      armed = false;
      throw new Error("injected storage failure");
    }
    return raw.write(writes, conditions);
  } };
  const a = await Carton.open({ adapter, store, init: { doc: doc0() }, sync: w.sync("alice") });
  try {
    await a.share();
    await until(async () => (await a.cuts())[0]!.sequencer.kind === "server");
    await a.sync!.disconnect();
    await raw.write([{ table: "lease", key: ["holder"], value: "old" }]);
    const id = a.newChangeId();
    armed = true;
    await assert.rejects(a.commit({ id, ops: [], conditions: [fence] }), /injected storage failure/);
    assert.equal(await raw.get("meta", ["noop", id]), undefined);
    const retry = await a.commit({ id, ops: [set("a", "name", "retry edit")], conditions: [fence], wait: 1 });
    assert.ok(await raw.get("pending", [a.cut, id]), "the offline retry is pending in the store");
    assert.equal(retry.status, "pending", "a failed empty attempt cannot confirm its offline retry");
  } finally {
    await a.close();
    w.host.close();
  }
});

test("R6-5 a synchronous Store.write throw must take back the held edit so later edits can sync", async () => {
  const w = world();
  const raw = createMemoryStore();
  let armed = false;
  const store: Store = { ...raw, write: (writes, conditions) => {
    if (armed && writes.some((x) => x.table === "pending") && conditions?.some((c) => c.table === "lease")) {
      armed = false;
      throw new Error("injected synchronous failure");
    }
    return raw.write(writes, conditions);
  } };
  const a = await Carton.open({ adapter, store, init: { doc: doc0() }, sync: w.sync("alice") });
  try {
    await a.share();
    await until(async () => (await a.cuts())[0]!.sequencer.kind === "server");
    await raw.write([{ table: "lease", key: ["holder"], value: "old" }]);
    armed = true;
    const id = a.newChangeId();
    await assert.rejects(a.commit({ id, ops: [set("a", "name", "refused")], conditions: [fence] }), /injected synchronous failure/);
    await a.sync!.disconnect();
    await a.sync!.connect({ nonce: "new" });
    const later = await a.commit({ ops: [set("b", "name", "later edit")], wait: 5000 });
    assert.equal(later.status, "confirmed", "the earlier failed held entry must not block the queue after reconnect");
  } finally {
    await a.close();
    w.host.close();
  }
});

test("R6-5 a throwing cardsWrite must not leave a held entry blocking every later edit", async () => {
  const w = world();
  const raw = createMemoryStore();
  const a = await Carton.open({ adapter, store: raw, init: { doc: doc0() }, sync: w.sync("alice") });
  try {
    await a.share();
    await until(async () => (await a.cuts())[0]!.sequencer.kind === "server");
    await raw.write([{ table: "lease", key: ["holder"], value: "old" }]);
    const stale = (await a.head()).ref;
    const first = await a.commit({ ops: [set("a", "name", "head value")], wait: 5000 });
    assert.equal(first.status, "confirmed");
    let called = false;
    await assert.rejects(a.commit({
      ops: [set("a", "name", "stale value")], base: stale, choices: ["theirs"], conditions: [fence],
      cardsWrite: () => { called = true; throw new Error("injected cards failure"); },
    }), /injected cards failure/);
    assert.ok(called, "the stale merge resolved a real conflict");
    await a.sync!.disconnect();
    await a.sync!.connect({ nonce: "new" });
    const later = await a.commit({ ops: [set("b", "name", "later edit")], wait: 5000 });
    assert.equal(later.status, "confirmed", "cards preparation failed before persistence, so its held edit must be gone");
  } finally {
    await a.close();
    w.host.close();
  }
});

test("R6-4 losing an empty commit to another process's pending edit must discard the provisional confirmation", async () => {
  const w = world();
  const raw = createMemoryStore();
  let armed = false;
  let unblock!: () => void, arrived!: () => void;
  const blocked = new Promise<void>((r) => { arrived = r; });
  const resume = new Promise<void>((r) => { unblock = r; });
  const store: Store = { ...raw, write: async (writes, conditions) => {
    if (armed && writes.some((x) => x.table === "meta" && x.key[0] === "noop")) {
      armed = false;
      arrived();
      await resume;
    }
    return raw.write(writes, conditions);
  } };
  const a = await Carton.open({ adapter, store, init: { doc: doc0() }, sync: w.sync("alice") });
  let b: Carton | undefined;
  try {
    await a.share();
    await until(async () => (await a.cuts())[0]!.sequencer.kind === "server");
    await a.sync!.disconnect();
    b = await Carton.open({ adapter, store: raw, sync: w.sync("alice", false) });
    const id = a.newChangeId();
    armed = true;
    const empty = a.commit({ id, ops: [] });
    await blocked;
    assert.equal((await b.commit({ id, ops: [set("a", "name", "other process's pending edit")] })).status, "pending");
    unblock();
    assert.equal((await empty).status, "pending", "the pending row won the no-op CAS");
    assert.ok(await raw.get("pending", [a.cut, id]));
    assert.equal((await a.sync!.waitFor(id, 1)).status, "pending", "the losing empty attempt must not confirm the other process's offline pending edit");
  } finally {
    unblock();
    await a.close();
    await b?.close();
    w.host.close();
  }
});

test("R6-6 a pin reload finishing across a History replacement cannot certify the replacement's older pins", async () => {
  const data = createMemoryData();
  const raw = createMemoryStore({ shared: data });
  const tailRead = latch(), resumeTail = latch();
  const rebuildRead = latch(), resumeRebuild = latch();
  const pinsRead = latch(), resumePins = latch();
  let holdTail = false, holdRebuild = false, holdPins = false;
  const store: Store = { ...raw,
    get: async (table, key) => {
      const value = await raw.get(table, key);
      if (holdRebuild && table === "meta" && key[0] === "current") {
        holdRebuild = false;
        rebuildRead.release();
        await resumeRebuild.p;
      }
      return value as never;
    },
    range: async (table, range) => {
      const rows = await raw.range(table, range);
      if (holdTail && table === "changes") {
        holdTail = false;
        tailRead.release();
        await resumeTail.p;
      }
      if (holdPins && table === "pins") {
        holdPins = false;
        pinsRead.release();
        await resumePins.p;
      }
      return rows as never;
    },
  };
  const a = await Carton.open({ adapter, store, init: { doc: doc0() } });
  const b = await Carton.open({ adapter, store: createMemoryStore({ shared: data }) });
  try {
    const cut = a.cut;
    const draft = { ...doc0(), name: "shared draft" };
    const first = await a.pin({ owner: "first", doc: draft });
    // This refresh has scanned the cuts before the fork appears. It can continue on the old History.
    holdTail = true;
    const reading = a.head();
    await tailRead.p;
    await b.fork("new cut");
    // The rebuild reads only 'first', then waits before publishing its replacement History.
    holdRebuild = true;
    const rebuilding = a.cuts();
    await rebuildRead.p;
    await b.pin({ owner: "view-b", cut, doc: draft });
    // The older refresh now reloads the current pins onto its captured old History.
    holdPins = true;
    resumeTail.release();
    await pinsRead.p;
    resumeRebuild.release();
    await rebuilding;
    // Its completion installs the current snapshot/token on the handle, whose History was replaced meanwhile.
    resumePins.release();
    await reading;
    await a.release(first.ref, "first");
    const rows = await raw.range<{ owners: { owner: string }[] }>("pins");
    assert.deepEqual(rows.flatMap((r) => r.value.owners.map((o) => o.owner)), ["view-b"], "a reload of the old History must not authorize deleting the other owner's persisted pin");
  } finally {
    resumeTail.release();
    resumeRebuild.release();
    resumePins.release();
    await a.close();
    await b.close();
  }
});

test("R6-7 removing a failed held change must pump the already-durable changes behind it", async () => {
  const w = world();
  const raw = createMemoryStore();
  const preflight = latch(), resumePreflight = latch(), blocked = latch(), resumeWrite = latch();
  let gatedId: string | undefined;
  let holdWrite = false;
  const fence: StoreCondition = { table: "lease", key: ["holder"], expect: { equals: "old" } };
  const store: Store = { ...raw,
    get: async (table, key) => {
      const v = await raw.get(table, key);
      if (gatedId && table === "pending" && key[1] === gatedId) {
        gatedId = undefined;
        preflight.release();
        await resumePreflight.p;
      }
      return v as never;
    },
    write: async (writes, conditions) => {
      if (holdWrite && writes.some((x) => x.table === "pending") && conditions?.some((x) => x.table === "lease")) {
        holdWrite = false;
        blocked.release();
        await resumeWrite.p;
      }
      return raw.write(writes, conditions);
    },
  };
  const a = await Carton.open({ adapter, store, init: { doc: doc0() }, sync: w.sync("alice") });
  try {
    await a.share();
    await until(async () => (await a.cuts())[0]!.sequencer.kind === "server");
    await raw.write([{ table: "lease", key: ["holder"], value: "old" }]);
    // The later edit passes #prepShared's queue wait before the held edit enqueues.
    const laterId = a.newChangeId();
    gatedId = laterId;
    const laterCommit = a.commit({ id: laterId, ops: [set("b", "name", "durable later edit")] });
    await preflight.p;
    holdWrite = true;
    const refusedId = a.newChangeId();
    const refused = assert.rejects(a.commit({ id: refusedId, ops: [set("a", "name", "refused")], conditions: [fence] }), /condition failed/);
    await blocked.p;
    // It now queues behind the held edit, and its independent store write succeeds.
    resumePreflight.release();
    assert.equal((await laterCommit).status, "pending");
    assert.ok(await raw.get("pending", [a.cut, laterId]));
    // Let both enqueue-scheduled pumps run against the held front entry.
    await new Promise((r) => setTimeout(r, 0));
    await raw.write([{ table: "lease", key: ["holder"], value: "new" }]);
    resumeWrite.release();
    await refused;
    // the refused edit is gone (the follower may already be sent and confirmed: the pusher woke up)
    assert.ok(!(await a.pendingChanges()).changes.some((p) => p.id === refusedId), "the refused edit is out of the queue");
    const withoutWakeup = await a.sync!.waitFor(laterId, 5000);
    // A reconnect provides the missing pump and confirms this same edit without another commit.
    await a.sync!.disconnect();
    await a.sync!.connect({ nonce: "new" });
    assert.equal((await a.sync!.waitFor(laterId, 5000)).status, "confirmed");
    assert.equal(withoutWakeup.status, "confirmed", "taking back the held front entry must wake the pusher for its follower");
  } finally {
    resumePreflight.release();
    resumeWrite.release();
    await a.close();
    w.host.close();
  }
});
