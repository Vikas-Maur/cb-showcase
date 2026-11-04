// UX redesign PLAN 5.3 on a shared cut: a toast's Undo or Redo (`expect`, a change id) is checked where the step is
// planned, on the state it joins (this replica's pending edits included), inside the write: another entry on top means
// StackMoved, and nothing is queued. A retried id answers where its first try went, though that step moved the stack.
// Online (the edits confirmed) and offline (still pending, so the stack is read on the queue's tail).
import { test } from "node:test";
import assert from "node:assert/strict";
import { Carton, groupOf } from "@carton/core";
import type { Actor, CommitResult } from "@carton/core";
import type { AuthContext, AuthProvider } from "@carton/core/plugins";
import { createMemoryStore } from "@carton/store-memory";
import { createInProcessHost } from "@carton/server";
import { sqliteStorage } from "../../conformance/src/system/sqlite.ts";
import { adapter, doc0, schema } from "./support/real.ts";

const me: Actor = { kind: "human", id: "me" };
const ME = groupOf(me);
const set = (id: string, v: string) => ({ op: "set" as const, path: ["timelineItems", id, "name"], value: v });
const moved = (e: Error & { code?: string }) => e.code === "STACK_MOVED";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(f: () => Promise<unknown> | unknown, ms = 5000, what = "condition") {
  for (const end = Date.now() + ms; !(await f()); await sleep(10)) if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
}

async function sharedCarton(): Promise<Carton> {
  const tokens = new Map<string, AuthContext>();
  const auth: AuthProvider = { kind: "table", async verify(t) { return tokens.get(t) ?? null; } };
  const host = createInProcessHost({ storage: sqliteStorage(), auth, timeline: schema.timeline!, groupOf: (cl, f) => schema.collections[cl]?.groupOf.get(f)?.name });
  tokens.set("tok", { account: "me", credential: "me/install", role: "editor", projectId: "p", expires: Date.now() + 3600_000 });
  const c = await Carton.open({ adapter, store: createMemoryStore(), init: { doc: doc0() }, actor: me, sync: { transport: host.transport, url: host.url, token: "tok", autoConnect: false } });
  const cut = c.cut;
  await c.share();
  assert.ok(await c.sync!.connect({ nonce: "n" }));
  await until(async () => (await c.cuts()).find((x) => x.id === cut)!.sequencer.kind === "server", 5000, "the hand-off");
  return c;
}

for (const online of [true, false]) {
  test(`PLAN 5.3, a shared cut (${online ? "online: confirmed" : "offline: pending"}): \`expect\` steps only that entry, else StackMoved and nothing queued; a retried id answers its first try`, async () => {
    const c = await sharedCarton();
    try {
      if (!online) await c.sync!.disconnect();
      // a change id, once confirmed when online (so the stack is read on History's rows, not the queue's tail)
      const made = async (r: CommitResult): Promise<string> => {
        const id = r.status === "pending" ? r.id : r.status === "confirmed" ? r.change!.id : assert.fail(JSON.stringify(r));
        if (online) assert.equal((await c.sync!.waitFor(id, 5000)).status, "confirmed");
        return id;
      };
      const names = async () => {
        const items = (await c.head()).doc.timelineItems as { id: string; name: string }[];
        return [items.find((i) => i.id === "c1")!.name, items.find((i) => i.id === "c2")!.name];
      };
      const action = await made(await c.commit({ ops: [set("c1", "A")] }));
      // an edit lands after the action: it is on top now
      const newer = await made(await c.commit({ ops: [set("c2", "B")] }));
      const pending = await c.pendingCount();
      await assert.rejects(c.undo(ME, { expect: action }), moved, "the toast's Undo would take back the newer edit: refused");
      assert.equal(await c.pendingCount(), pending, "nothing queued");
      assert.deepEqual(await names(), ["A", "B"]);
      assert.equal((await c.undoStack(ME, { limit: 1 }))[0]!.changeId, newer, "the stack as it was");
      // the newer edit's own id: taken back, as Ctrl+Z would
      const undoOfNewer = await made(await c.undo(ME, { expect: newer }));
      assert.deepEqual(await names(), ["A", "c2"]);
      // now the action is on top: its Undo works, and its retry (same id) answers the first try, though the stack moved
      const first = await c.undo(ME, { expect: action, id: "toast.1" });
      const undoOfAction = await made(first);
      assert.equal(undoOfAction, "toast.1");
      const queued = await c.pendingCount();
      const again = await c.undo(ME, { expect: action, id: "toast.1" });
      assert.equal(again.status, online ? "confirmed" : "pending", JSON.stringify(again));
      assert.equal(again.status === "pending" ? again.id : again.status === "confirmed" ? again.change?.id : null, "toast.1", "the first try's change");
      assert.equal(await c.pendingCount(), queued, "nothing queued again");
      assert.deepEqual(await names(), ["c1", "c2"]);
      // redo: the newest undo only, and nothing queued when refused
      await assert.rejects(c.redo(ME, { expect: undoOfNewer }), moved);
      assert.equal(await c.pendingCount(), queued, "nothing queued");
      assert.deepEqual(await names(), ["c1", "c2"]);
      await made(await c.redo(ME, { expect: undoOfAction, id: "toast.2" }));
      assert.deepEqual(await names(), ["A", "c2"]);
      const redone = await c.pendingCount();
      const redoAgain = await c.redo(ME, { expect: undoOfAction, id: "toast.2" });
      assert.equal(redoAgain.status === "pending" ? redoAgain.id : redoAgain.status === "confirmed" ? redoAgain.change?.id : null, "toast.2", "a retried redo answers its first try");
      assert.equal(await c.pendingCount(), redone);
    } finally {
      await c.close();
    }
  });
}
