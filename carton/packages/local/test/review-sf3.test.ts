// Regressions from Stage F review round 3 (GPT 6.1 Sol): a retried `undo --turn` answers where its first try went (a
// pending undo on a shared cut), even after the current cut changed; a delivery that can't get its notices through
// fails the call (retryable) instead of answering without them.
import { test } from "node:test";
import assert from "node:assert/strict";
import { Carton } from "@carton/core";
import type { Actor } from "@carton/core";
import type { AuthContext, AuthProvider, Store } from "@carton/core/plugins";
import { createMemoryStore } from "@carton/store-memory";
import { createInProcessHost } from "@carton/server";
import { sqliteStorage } from "../../conformance/src/system/sqlite.ts";
import { runWrite, actorKey } from "../src/writes.ts";
import { adapter, doc0, schema } from "./support/real.ts";

const agent: Actor = { kind: "agent", id: "director/chat/t1", name: "Director", group: "local:me@box", turn: "t1" };
const set = (id: string, f: string, v: unknown) => ({ op: "set" as const, path: ["timelineItems", id, f], value: v });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(f: () => Promise<unknown> | unknown, ms = 5000, what = "condition") {
  for (const end = Date.now() + ms; !(await f()); await sleep(10)) if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
}

test("a retried `undo --turn` answers where its first try went, though the current cut changed since", async () => {
  const tokens = new Map<string, AuthContext>();
  const auth: AuthProvider = { kind: "table", async verify(t) { return tokens.get(t) ?? null; } };
  const host = createInProcessHost({ storage: sqliteStorage(), auth, timeline: schema.timeline!, groupOf: (cl, f) => schema.collections[cl]?.groupOf.get(f)?.name });
  tokens.set("tok", { account: "alice", credential: "alice/install", role: "editor", projectId: "p", expires: Date.now() + 3600_000 });
  const store = createMemoryStore();
  const c = await Carton.open({ adapter, store, init: { doc: doc0() }, actor: agent, sync: { transport: host.transport, url: host.url, token: "tok", autoConnect: false } });
  try {
    const shared = c.cut;
    await c.share();
    assert.ok(await c.sync!.connect({ nonce: "n" }));
    await until(async () => (await c.cuts()).find((x) => x.id === shared)!.sequencer.kind === "server", 5000, "the hand-off");
    const turnEdit = await c.commit({ author: agent, ops: [set("c1", "name", "turn edit")] });
    assert.equal((await c.sync!.waitFor(turnEdit.status === "pending" ? turnEdit.id : "", 5000)).status, "confirmed");
    // offline: the undo of the turn goes pending on the shared cut (no explicit cut: the current one)
    await c.sync!.disconnect();
    const req = { id: "sf3.undo", actor: agent, op: { kind: "undoTurn" as const, turn: "t1" } };
    const first = await runWrite(c, structuredClone(req), { online: () => false });
    assert.equal(first.status, "pending", JSON.stringify(first));
    // the person switches to a local cut where the turn also has work
    const local = await c.fork("Local", { id: "sf3.local" });
    await c.switchTo(local.id);
    await c.commit({ author: agent, ops: [set("c2", "name", "turn edit on the local cut")] });
    // the retry (its first answer was lost): the pending undo on the shared cut, nothing done on the local one
    const again = await runWrite(c, structuredClone(req), { online: () => false });
    assert.equal(again.status, "pending", JSON.stringify(again));
    assert.equal(again.id, "sf3.undo");
    assert.ok(!(await c.log({ cut: local.id, limit: 100 })).some((v) => v.kind === "undo"), "no undo on the local cut");
    assert.ok(await store.get("pending", [shared, "sf3.undo"]), "still the one pending undo, on the shared cut");
  } finally {
    await c.close();
  }
});

test("a delivery whose notices keep changing fails the call (retryable), and gives nothing away", async () => {
  const store = createMemoryStore();
  const c = await Carton.open({ adapter, store, init: { doc: doc0() }, actor: agent });
  try {
    const key = [actorKey(agent), 1, 0];
    await store.write([{ table: "notices", key, value: { to: actorKey(agent), kind: "late-conflict", text: "card", change: "old.1", cards: [] } }]);
    // another writer (a Stop hook's mark, a resolve) changes the row before every delivery batch lands
    const original = store.write.bind(store);
    let marks = 0;
    (store as { write: Store["write"] }).write = async (wr, conds) => {
      if (wr.some((x) => x.table === "notices" && (x.value as { deliveredAt?: number } | undefined)?.deliveredAt)) {
        const cur = await store.get<Record<string, unknown>>("notices", key);
        await original([{ table: "notices", key, value: { ...cur, touched: ++marks } }]);
      }
      return original(wr, conds);
    };
    await assert.rejects(runWrite(c, { id: "sf3.r", actor: agent, op: { kind: "pin", owner: "p" } }), /store changed under this write/);
    (store as { write: Store["write"] }).write = original;
    assert.equal((await store.get<{ deliveredAt?: number }>("notices", key))?.deliveredAt, undefined, "not given away");
    // the call is run again (withRaceRetry does this for every write): now it goes out with the answer
    const retry = await runWrite(c, { id: "sf3.r", actor: agent, op: { kind: "pin", owner: "p" } });
    assert.deepEqual(retry.notices.map((n) => n.change), ["old.1"]);
  } finally {
    await c.close();
  }
});
