// A `cb` write on a shared cut whose edit was sent, then emptied by a rebase onto a teammate's change, is withdrawn: the
// server spends its id with a withdraw row (H1), fanned out as a `change` event. That row is no confirmation. The
// write's answer is decided by the `absorbed` event: with no card, confirmed + absorbed + "already in place" (the
// commit path's answer for an absorbed edit); with a card that took its place, conflicts with that card. Never
// "confirmed" at the withdraw row's seq, and never "confirmed" heard before the card.
// Here: the writer's own process (the lease holder runs the write). The follower served by the holder over its socket
// is in withdrawn-outcome-process.test.ts.
import { test } from "node:test";
import assert from "node:assert/strict";
import { Carton, type Actor, type CartonEvent, type ConfirmedChange } from "@carton/core";
import type { AuthContext, AuthProvider, Store, Transport, TransportConnection } from "@carton/core/plugins";
import { createMemoryStore } from "@carton/store-memory";
import { createInProcessHost } from "@carton/server";
import { sqliteStorage } from "../../conformance/src/system/sqlite.ts";
import { runWrite, watchOutcomes, ALREADY_IN_PLACE } from "../src/writes.ts";
import type { CbResult } from "../src/writes.ts";
import { forwardSettles } from "../src/sidecars.ts";
import { adapter, doc0, schema } from "./support/real.ts";

const agent: Actor = { kind: "agent", id: "claude-code/wd", name: "Claude Code", group: "local:me@box" };
const set = (id: string, f: string, v: unknown) => ({ op: "set" as const, path: ["timelineItems", id, f], value: v });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(f: () => Promise<boolean> | boolean, ms = 5000, what = "condition") {
  for (const end = Date.now() + ms; !(await f()); await sleep(10)) if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
}
/** The host's transport, except that pushes are held back while `hold()` is on (withdraws go through). */
function gated(t: Transport) {
  const queue: { c: TransportConnection; m: Parameters<TransportConnection["send"]>[0] }[] = [];
  let open = true;
  const transport: Transport = {
    async connect(url, opts) {
      const c = await t.connect(url, opts);
      return {
        get open() {
          return c.open;
        },
        send: (m) => (open || m.type !== "push" ? c.send(m) : void queue.push({ c, m })),
        onMessage: (l) => c.onMessage(l),
        onClose: (l) => c.onClose(l),
        close: () => c.close(),
      };
    },
  };
  return { transport, hold: () => void (open = false), release: () => { open = true; for (const { c, m } of queue.splice(0)) if (c.open) c.send(m); } };
}
function world() {
  const tokens = new Map<string, AuthContext>();
  const auth: AuthProvider = { kind: "table", async verify(t) { return tokens.get(t) ?? null; } };
  const host = createInProcessHost({ storage: sqliteStorage(), auth, timeline: schema.timeline!, groupOf: (c, f) => schema.collections[c]?.groupOf.get(f)?.name });
  const sync = (name: string, transport: Transport = host.transport) => {
    tokens.set(`tok-${name}`, { account: name, credential: `${name}/install`, role: "editor", projectId: "p", expires: Date.now() + 3600_000 });
    return { transport, url: host.url, token: `tok-${name}`, autoConnect: false };
  };
  return { host, sync };
}
async function copyOf(from: Store): Promise<Store> {
  const to = createMemoryStore();
  for (const t of (from as unknown as { data: { tables: Map<string, unknown> } }).data.tables.keys()) {
    const rows = await from.range(t);
    if (rows.length) await to.write(rows.map((r) => ({ table: t, key: r.key, value: structuredClone(r.value) })));
  }
  return to;
}

/**
 * Alice's holder runs `cb` write `id` (`aliceName` on c1): its push is held until Bob's edit (`bobName`) is confirmed,
 * then sent on the old base, so the rebase empties it after it was sent and her client withdraws it.
 */
async function withdrawnWrite(id: string, aliceName: string, bobName: string) {
  const w = world();
  const store = createMemoryStore();
  const gate = gated(w.host.transport);
  const c = await Carton.open({ adapter, store, init: { doc: doc0() }, actor: agent, sync: w.sync("alice", gate.transport) });
  const events: string[] = [];
  c.on((e: CartonEvent) => {
    if (e.type === "change" && e.change.id === id) events.push(`change${e.change.withdrawn ? " (withdraw row)" : ""}@${e.seq}`);
    if (e.type === "absorbed" && e.id === id) events.push(`absorbed${e.cards.length ? " with cards" : ""}`);
  });
  await c.share();
  assert.ok(await c.sync!.connect({ nonce: "n1" }));
  await until(async () => (await c.cuts())[0]!.sequencer.kind === "server", 5000, "the hand-off");
  const cut = c.cut;
  const bob = await Carton.open({ adapter, store: await copyOf(store), actor: { kind: "human", id: "bob" }, sync: w.sync("bob") });
  assert.ok(await bob.sync!.connect({ nonce: "b" }));
  gate.hold();
  const answer = runWrite(c, { id, actor: agent, op: { kind: "commit", ops: [set("c1", "name", aliceName)] }, waitMs: 5000 }, { online: () => true });
  await until(async () => !!(await store.get<{ sentBases?: number[] }>("pending", [cut, id]))?.sentBases?.length, 5000, "alice's edit sent");
  const rb = await bob.commit({ ops: [set("c1", "name", bobName)] });
  assert.equal((await bob.sync!.waitFor(rb.status === "pending" ? rb.id : "", 5000)).status, "confirmed");
  gate.release();
  const r = await answer;
  const row = (await store.range<ConfirmedChange>("changes", { prefix: [cut] })).map((x) => x.value).find((x) => x.id === id);
  return { w, c, bob, cut, r, row, events, close: async () => { await bob.close(); await c.close(); w.host.close(); } };
}

test("the writer's process: a sent edit a teammate's identical edit emptied answers confirmed, absorbed, already in place", async () => {
  const x = await withdrawnWrite("wd.same.1", "Same", "Same");
  try {
    assert.equal(x.row?.withdrawn, true, "the server spent the id with a withdraw row");
    assert.ok(x.events.includes(`change (withdraw row)@${x.row!.seq}`), JSON.stringify(x.events));
    assert.equal(x.r.status, "confirmed", JSON.stringify(x.r));
    assert.equal(x.r.absorbed, true, JSON.stringify(x.r));
    assert.equal(x.r.note, ALREADY_IN_PLACE);
  } finally {
    await x.close();
  }
});

test("the writer's process: a sent edit a card took the place of answers conflicts with that card, never confirmed", async () => {
  const x = await withdrawnWrite("wd.card.1", "Alice's", "Bob's");
  try {
    assert.equal(x.row?.withdrawn, true);
    assert.deepEqual(x.events, [`change (withdraw row)@${x.row!.seq}`, "absorbed with cards"], "the withdraw row's change event comes before the cards");
    assert.equal(x.r.status, "conflicts", JSON.stringify(x.r));
    const cards = (x.r as Extract<CbResult, { status: "conflicts" }>).conflicts;
    assert.ok(cards.some((k) => k.path.startsWith("timelineItems/c1")), JSON.stringify(cards));
  } finally {
    await x.close();
  }
});

// watchOutcomes answers a write when core has no outcome log to wait on (a handle without `sync.waitFor`), and the view
// sidecars are forwarded from the same events: both hear the withdraw row first, then the absorption.
const fakeCarton = () => {
  const ls = new Set<(e: CartonEvent) => void>();
  const carton = { on: (l: (e: CartonEvent) => void) => (ls.add(l), () => ls.delete(l)), cuts: async () => [{ id: "cut", sequencer: { kind: "server" } }] };
  const withdrawRow = (id: string, seq: number) => ({ type: "change", branchId: "cut", seq, local: true, change: { id, seq, ops: [], withdrawn: true, author: { kind: "system", id: "withdraw" } } }) as unknown as CartonEvent;
  return { carton: carton as unknown as Carton, emit: (e: CartonEvent) => { for (const l of ls) l(e); }, withdrawRow };
};
const card = { kind: "field", path: "timelineItems/c1/name", base: "c1", ours: "Bob's", theirs: "Alice's" };

test("watchOutcomes: a withdraw row settles nothing; the absorption decides (in place, or the card)", async () => {
  const { carton, emit, withdrawRow } = fakeCarton();
  const w = watchOutcomes(carton);
  try {
    // waiting when the events come
    const same = w.wait("a.1", 2000);
    emit(withdrawRow("a.1", 7));
    emit({ type: "absorbed", branchId: "cut", id: "a.1", cards: [] } as CartonEvent);
    assert.deepEqual(await same, { kind: "absorbed", seq: 7, cards: [] }, "in place, at the seq that spent its id");
    // the events came before the wait
    emit(withdrawRow("a.2", 8));
    emit({ type: "absorbed", branchId: "cut", id: "a.2", cards: [card] } as unknown as CartonEvent);
    assert.deepEqual(await w.wait("a.2", 2000), { kind: "absorbed", seq: 8, cards: [card] }, "the card, not a confirmation");
    // a withdraw row alone answers nothing
    emit(withdrawRow("a.3", 9));
    assert.equal(await w.wait("a.3", 50), null);
  } finally {
    w.close();
  }
});

test("runWrite without core's outcome log answers a withdrawn edit as the commit path does", async () => {
  for (const cards of [[], [card]]) {
    const { carton, emit, withdrawRow } = fakeCarton();
    const id = `b.${cards.length}`;
    const c = Object.assign(carton, {
      cut: "cut",
      sync: { state: () => ({ status: "up-to-date" }) },
      commit: async () => (queueMicrotask(() => { emit(withdrawRow(id, 5)); emit({ type: "absorbed", branchId: "cut", id, cards } as unknown as CartonEvent); }), { status: "pending", id, ref: { branchId: "cut", seq: 4, pending: [id] }, notices: [] }),
      notices: async () => [],
      head: async () => ({ ref: { branchId: "cut", seq: 5, pending: [] }, doc: doc0() }),
    }) as unknown as Carton;
    const r = await runWrite(c, { id, actor: agent, op: { kind: "commit", ops: [set("c1", "name", "x")] }, waitMs: 2000 }, { online: () => true });
    if (!cards.length) assert.deepEqual([r.status, r.absorbed, r.note, (r as { seq?: number }).seq], ["confirmed", true, ALREADY_IN_PLACE, 5], JSON.stringify(r));
    else assert.deepEqual([r.status, (r as Extract<CbResult, { status: "conflicts" }>).conflicts], ["conflicts", [card]], JSON.stringify(r));
  }
});

test("view sidecars: a withdraw row is never told as confirmed; the absorption is the answer", async () => {
  for (const cards of [[], [card]]) {
    const { carton, emit, withdrawRow } = fakeCarton();
    const store = createMemoryStore();
    await store.write([{ table: "views", key: ["view", "agent-1"], value: { lastChange: "v.1" } }]);
    const told: { status: string; seq?: number }[] = [];
    const stop = forwardSettles(carton, store, async (_v, _id, s) => void told.push({ status: s.status, ...(s.seq !== undefined ? { seq: s.seq } : {}) }));
    emit(withdrawRow("v.1", 3));
    await sleep(20);
    assert.equal(told.length, 0, `the withdraw row tells the sidecar nothing: ${JSON.stringify(told)}`);
    emit({ type: "absorbed", branchId: "cut", id: "v.1", cards } as unknown as CartonEvent);
    await until(() => told.length > 0, 2000, "the absorption told");
    await stop();
    assert.deepEqual(told.map((t) => t.status), [cards.length ? "conflicts" : "confirmed"]);
  }
});
