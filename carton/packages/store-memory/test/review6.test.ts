// Regressions from Stage F review round 6 (GPT 6.1 Sol, high) over 90077ed..334325f; the reviewer's repros, kept.
import { test } from "node:test";
import assert from "node:assert/strict";
import { Carton, type Store } from "@carton/core";
import type { StoreCondition } from "@carton/core/plugins";
import { createMemoryData, createMemoryStore } from "../src/index.ts";
import { adapter, doc0, item, set } from "./fixture.ts";
import { copyStore, until, world } from "./world.ts";

const latch = () => {
  let release!: () => void;
  return { p: new Promise<void>((r) => (release = r)), release: () => release() };
};

/** A store whose first pin row write is held (`blocked` once it is) until `resume`. */
function heldPinWrite(raw: Store) {
  const blocked = latch(),
    resume = latch();
  const s = { armed: false };
  const store: Store = { ...raw, write: async (writes, conditions) => {
    if (s.armed && writes.some((w) => w.table === "pins")) {
      s.armed = false;
      blocked.release();
      await resume.p;
    }
    return raw.write(writes, conditions);
  } };
  return { store, blocked, resume, s };
}

test("R6-1 a pin whose write lands after a rebuild replaced History resolves at once on the same handle", async () => {
  const data = createMemoryData();
  const raw = createMemoryStore({ shared: data });
  const h = heldPinWrite(raw);
  const a = await Carton.open({ adapter, store: h.store, init: { doc: doc0() } });
  const b = await Carton.open({ adapter, store: createMemoryStore({ shared: data }) });
  try {
    const draft = { ...doc0(), name: "unsaved draft" };
    h.s.armed = true;
    const pinning = a.pin({ owner: "view-a", doc: draft });
    await h.blocked.p;
    await b.fork("new cut");
    await a.cuts(); // a rebuild publishes a History that didn't read A's pin, still being written
    h.resume.release();
    const pin = await pinning;
    assert.equal((await raw.range("pins")).length, 1, "the pin write succeeded");
    assert.equal((await a.checkout(pin.header)).name, draft.name, "the pin resolves at once");
  } finally {
    h.resume.release();
    await a.close();
    await b.close();
  }
});

test("R6-1 releasing an earlier owner after a pin that landed past a rebuild keeps the new owner", async () => {
  const data = createMemoryData();
  const raw = createMemoryStore({ shared: data });
  const h = heldPinWrite(raw);
  const a = await Carton.open({ adapter, store: h.store, init: { doc: doc0() } });
  const b = await Carton.open({ adapter, store: createMemoryStore({ shared: data }) });
  try {
    const draft = { ...doc0(), name: "shared pinned draft" };
    const first = await a.pin({ owner: "first", doc: draft });
    h.s.armed = true;
    const pinning = a.pin({ owner: "view-a", doc: draft });
    await h.blocked.p;
    await b.fork("new cut");
    await a.cuts();
    h.resume.release();
    await pinning;
    await a.release(first.ref, "first");
    const rows = await raw.range<{ owners: { owner: string }[] }>("pins");
    assert.deepEqual(rows.flatMap((r) => r.value.owners.map((o) => o.owner)), ["view-a"], "releasing first keeps the owner that pinned meanwhile");
  } finally {
    h.resume.release();
    await a.close();
    await b.close();
  }
});

test("R6-2 a conditioned shared commit is not sent before its write lands: one whose condition then fails never reached the server", async () => {
  const w = world();
  const raw = createMemoryStore();
  const blocked = latch(),
    resume = latch();
  let armed = false;
  const condition: StoreCondition = { table: "lease", key: ["holder"], expect: { equals: "old" } };
  const store: Store = { ...raw, write: async (writes, conditions) => {
    if (armed && writes.some((x) => x.table === "pending") && conditions?.some((x) => x.table === "lease" && x.key[0] === "holder")) {
      armed = false;
      blocked.release();
      await resume.p;
    }
    return raw.write(writes, conditions);
  } };
  const a = await Carton.open({ adapter, store, init: { doc: doc0() }, sync: w.sync("alice") });
  let b: Carton | undefined;
  try {
    await a.share();
    await until(async () => (await a.cuts())[0]!.sequencer.kind === "server");
    b = await Carton.open({ adapter, store: await copyStore(raw), sync: w.sync("bob") });
    await until(() => b!.sync!.status === "up-to-date");
    await raw.write([{ table: "lease", key: ["holder"], value: "old" }]);
    armed = true;
    const committing = a.commit({ ops: [set("a", "name", "must not be saved")], conditions: [condition] });
    const rejected = assert.rejects(committing, /condition failed/);
    await blocked.p;
    await raw.write([{ table: "lease", key: ["holder"], value: "new" }]);
    // the pump enqueue scheduled, and the transport's turns, run while the write can't finish
    await new Promise((r) => setTimeout(r, 0));
    resume.release();
    await rejected;
    assert.equal(item((await b.head()).doc, "a")!.name, "a", "the refused edit never reached the shared document");
    assert.equal(a.sync!.state().pending, 0);
    // a conditioned commit whose write lands goes out once it has
    await raw.write([{ table: "lease", key: ["holder"], value: "old" }]);
    const ok = await a.commit({ ops: [set("b", "name", "kept, then sent")], conditions: [condition], wait: 5000 });
    assert.equal(ok.status, "confirmed");
    await until(async () => item((await b!.head()).doc, "b")!.name === "kept, then sent", 5000, "bob has it");
  } finally {
    resume.release();
    await a.close();
    await b?.close();
    w.host.close();
  }
});

test("R6-3 a refused empty shared commit leaves no confirmation behind: a retry of its id with an edit is pending", async () => {
  const w = world();
  const raw = createMemoryStore();
  let armed = false;
  const fence: StoreCondition = { table: "lease", key: ["holder"], expect: { equals: "old" } };
  const store: Store = { ...raw, write: async (writes, conditions) => {
    const ok = await raw.write(writes, conditions);
    if (armed && ok && !writes.length && conditions?.some((c) => c.table === "lease" && c.key[0] === "holder")) {
      armed = false;
      await raw.write([{ table: "lease", key: ["holder"], value: "new" }]);
    }
    return ok;
  } };
  const a = await Carton.open({ adapter, store, init: { doc: doc0() }, sync: w.sync("alice") });
  try {
    await a.share();
    await until(async () => (await a.cuts())[0]!.sequencer.kind === "server");
    await a.sync!.disconnect();
    await raw.write([{ table: "lease", key: ["holder"], value: "old" }]);
    const id = a.newChangeId();
    armed = true;
    await assert.rejects(a.commit({ id, ops: [], conditions: [fence] }), /condition failed/);
    assert.equal(await raw.get("meta", ["noop", id]), undefined);
    await raw.write([{ table: "lease", key: ["holder"], value: "old" }]);
    const retry = await a.commit({ id, ops: [set("a", "name", "retry edit")], conditions: [fence], wait: 1 });
    assert.ok(await raw.get("pending", [a.cut, id]), "the offline retry is pending in the store");
    assert.equal(retry.status, "pending", "and pending to its caller, not the refused empty attempt's confirmation");
  } finally {
    await a.close();
    w.host.close();
  }
});
