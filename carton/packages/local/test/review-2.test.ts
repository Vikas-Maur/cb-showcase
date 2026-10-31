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
    async cuts() { return [{ id: "cut1", name: "main", kind: "main", sequencer: { kind: "server", since: 0 } }]; },
    async commit(input: any) { this.calls.push(input); return steps.shift()!(input); },
    async checkout() { return { timelineItems: Object.entries(landed).map(([id, name]) => ({ id, name })) }; },
    async head() { return { ref, doc: await this.checkout() }; },
  } as any;
}

const cardsOf = async (store: Store) => (await store.range<any>("notices", { prefix: [actorKey(agent)] })).flatMap((r) => r.value.cards ?? []);

// (the card-keeping tests moved to review-3.test.ts, on real Carton, when the design changed in round 3)

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
  carton.sync = { status: "up-to-date", state: () => ({ status: "up-to-date" }) };
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
