// Regressions from review round 2: cards from every merge pass are kept when their value didn't land; cards survive a
// holder dying right after the append; notice updates never resurrect a resolved card; a probe never authorizes a
// takeover with a nonce it didn't observe; notices that arrive while a call waits for its ack reach the caller.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { createMemoryStore } from "@carton/store-memory";
import type { Store } from "@carton/core/plugins";
import { runWrite, deliverNotices, actorKey, casUpdate, SKIP } from "../src/writes.ts";
import { Lease } from "../src/lease.ts";
import { probeHolder } from "../src/holder.ts";
import { ControlServer } from "../src/ipc.ts";
import { scratch } from "./support/scratch.ts";

const dir = mkdtempSync(join(scratch(), "review2-"));
const agent = { kind: "agent" as const, id: "codex/x", name: "Codex" };
const schema = { collections: { timelineItems: { key: "id" } } } as any;
const card = (id: string, theirs: unknown, ours: unknown) => ({ kind: "field" as const, path: `timelineItems/${id}/name`, base: "b", ours, theirs });
const ref = { branchId: "cut1", seq: 1, pending: [] };

/** A Carton stand-in whose commits are scripted. */
function scripted(store: Store, steps: ((input: any) => any)[], landed: Record<string, string>) {
  const listeners: ((e: any) => void)[] = [];
  return {
    store, schema, cut: "cut1", sync: null,
    calls: [] as any[],
    on: (l: (e: any) => void) => { listeners.push(l); return () => listeners.splice(listeners.indexOf(l), 1); },
    emit: (e: any) => listeners.forEach((l) => l(e)),
    notices: async () => [],
    async commit(input: any) { this.calls.push(input); return steps.shift()!(input); },
    async checkout() { return { timelineItems: Object.entries(landed).map(([id, name]) => ({ id, name })) }; },
    async head() { return { ref, doc: await this.checkout() }; },
  } as any;
}

const cardsOf = async (store: Store) => (await store.range<any>("notices", { prefix: [actorKey(agent)] })).flatMap((r) => r.value.cards ?? []);

test("a card met only in the committing merge pass (another writer between passes) is kept and returned", async () => {
  const store = createMemoryStore();
  const carton = scripted(store, [
    () => ({ status: "conflicts", cards: [card("c1", "mine-1", "head-1")], ref }),
    (input) => {
      // the retry meets one more card: core decides it "ours" too (head keeps both values)
      for (const c of [card("c1", "mine-1", "head-1"), card("c2", "mine-2", "head-2")]) assert.equal(input.choices(c, 0), "ours");
      return { status: "confirmed", seq: 2, ref: { ...ref, seq: 2 }, change: { id: "r.1" }, rebased: 1, notices: [] };
    },
  ], { c1: "head-1", c2: "head-2" });
  const r = await runWrite(carton, { id: "r.1", actor: agent, op: { kind: "commit", ops: [] } });
  assert.equal(r.status, "conflicts");
  assert.deepEqual((r as any).conflicts.map((c: any) => c.path).sort(), ["timelineItems/c1/name", "timelineItems/c2/name"]);
  assert.deepEqual((await cardsOf(store)).map((c) => c.path).sort(), ["timelineItems/c1/name", "timelineItems/c2/name"]);
});

test("a card whose value landed after all (a later pass merged cleanly) is not kept", async () => {
  const store = createMemoryStore();
  const carton = scripted(store, [
    () => ({ status: "conflicts", cards: [card("c1", "mine-1", "head-1")], ref }),
    () => ({ status: "confirmed", seq: 2, ref: { ...ref, seq: 2 }, change: { id: "r.2" }, rebased: 1, notices: [] }),
  ], { c1: "mine-1" });
  const r = await runWrite(carton, { id: "r.2", actor: agent, op: { kind: "commit", ops: [] } });
  assert.equal(r.status, "confirmed");
  assert.deepEqual(await cardsOf(store), []);
});

test("the cards are written before the append: a holder that dies right after it leaves them for the retry", async () => {
  const base = createMemoryStore();
  let noticeWrites = 0;
  const store: Store = { ...base, info: base.info, get: base.get.bind(base), range: base.range.bind(base), close: base.close.bind(base),
    async write(w, c) { if (w.some((x) => x.table === "notices") && ++noticeWrites === 2) throw new Error("holder died"); return base.write(w, c); } };
  const carton = scripted(store, [
    () => ({ status: "conflicts", cards: [card("c1", "mine-1", "head-1")], ref }),
    () => ({ status: "confirmed", seq: 2, ref: { ...ref, seq: 2 }, change: { id: "r.3" }, rebased: 1, notices: [] }),
  ], { c1: "head-1" });
  await assert.rejects(runWrite(carton, { id: "r.3", actor: agent, op: { kind: "commit", ops: [] } }), /holder died/);
  assert.deepEqual((await cardsOf(base)).map((c) => c.path), ["timelineItems/c1/name"], "the card is there for cb conflicts / cb resolve");
});

test("delivering notices never resurrects a card resolved meanwhile", async () => {
  const base = createMemoryStore();
  const key = [actorKey(agent), 1, 0];
  await base.write([{ table: "notices", key, value: { to: actorKey(agent), kind: "late-conflict", text: "t", change: "r.4", cards: [card("c1", "a", "b")] } }]);
  let raced = false;
  const store: Store = { ...base, info: base.info, get: base.get.bind(base), range: base.range.bind(base), close: base.close.bind(base),
    async write(w, c) {
      // cb resolve closes the card between delivery's read and its write
      if (!raced && w.some((x) => x.table === "notices")) { raced = true; await base.write([{ table: "notices", key, value: undefined }]); }
      return base.write(w, c);
    } };
  const out = await deliverNotices({ store, notices: async () => [] } as any, agent);
  assert.deepEqual(out, []);
  assert.equal(await base.get("notices", key), undefined, "still resolved");
  assert.equal(await casUpdate(base, "notices", key, () => SKIP), false);
});

test("a probe never names a nonce it didn't observe: a holder that takes the lease mid-probe is pinged", async () => {
  const base = createMemoryStore();
  const lease0 = new Lease(base);
  const path = join(dir, "new-holder.sock");
  let nonce = "";
  const srv = await ControlServer.listen({ path, open: ["carton.ping"], methods: { "carton.ping": () => ({ pid: process.pid, nonce }) } });
  try {
    let injected = false;
    const store: Store = { ...base, info: base.info, range: base.range.bind(base), write: base.write.bind(base), close: base.close.bind(base),
      async get(t, k) {
        const v = await base.get(t, k);
        // another process takes the free lease between the nonce read and the row read
        if (!injected && t === "lease" && k.length === 2) { injected = true; nonce = (await lease0.take(null, { pid: 2, socketPath: path, kind: "helper" }))!.nonce; }
        return v as any;
      } };
    const p = await probeHolder(new Lease(store));
    assert.equal(p.live?.nonce, nonce, "the new holder was seen and pinged, not reported dead");
    assert.equal(p.seen, nonce);
  } finally {
    await srv.close();
  }
});

test("notices that arrive while a call waits for its ack go out with its answer", async () => {
  const store = createMemoryStore();
  const carton = scripted(store, [() => ({ status: "pending", id: "r.5", ref, notices: [] })], {});
  carton.sync = { status: "up-to-date" };
  const p = runWrite(carton, { id: "r.5", actor: agent, op: { kind: "commit", ops: [] }, waitMs: 2000 });
  await new Promise((r) => setTimeout(r, 30));
  // an older pending change of the same actor conflicted, then this one did
  await store.write([{ table: "notices", key: [actorKey(agent), 2, 0], value: { to: actorKey(agent), kind: "late-conflict", text: "older", change: "r.0", cards: [card("c9", "x", "y")] } }]);
  const mine = { to: actorKey(agent), kind: "late-conflict", text: "this one", change: "r.5", cards: [card("c1", "a", "b")] };
  await store.write([{ table: "notices", key: [actorKey(agent), 3, 0], value: mine }]);
  carton.emit({ type: "notice", notice: mine });
  const r = await p;
  assert.equal(r.status, "conflicts");
  assert.deepEqual(r.notices.map((n) => n.text), ["older"], "the older notice is delivered with this answer, not lost");
});
