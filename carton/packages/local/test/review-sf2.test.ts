// Regressions from Stage F review round 2, on real Carton handles and the in-process sequencer host: a settle never
// removes a pending row that is still being written, whichever write started first; a handle fenced off and connected
// again pushes what it had pending and settles it; an empty shared save whose holder was replaced answers with the
// store's outcome, never a second one for the same id, and its retry names the same version; an empty `undo --turn`
// retried after new conflicting work stays empty; notices: a failed delivery gives none away, and two copies of one
// request both get what was delivered to it.
// The first four need core changes requested from foundation-core (notes: "Requests for foundation-core" 1–4): `todo`
// until they land. They fail fast (every wait has a deadline), so they never hold up the suite.
import { test } from "node:test";
import assert from "node:assert/strict";
import { Carton } from "@carton/core";
import type { Actor } from "@carton/core";
import type { AuthContext, AuthProvider, Store, Transport } from "@carton/core/plugins";
import { createMemoryStore } from "@carton/store-memory";
import { createInProcessHost } from "@carton/server";
import { sqliteStorage } from "../../conformance/src/system/sqlite.ts";
import { runWrite, actorKey } from "../src/writes.ts";
import { Lease, fence } from "../src/lease.ts";
import { adapter, doc0, schema } from "./support/real.ts";

const agent: Actor = { kind: "agent", id: "claude-code/sf2", name: "Claude Code", group: "local:me@box" };
const set = (id: string, f: string, v: unknown) => ({ op: "set" as const, path: ["timelineItems", id, f], value: v });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(f: () => Promise<unknown> | unknown, ms = 5000, what = "condition") {
  for (const end = Date.now() + ms; !(await f()); await sleep(5)) if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
}
const nameOf = async (c: Carton, id: string) => ((await c.head()).doc.timelineItems as { id: string; name: string }[]).find((x) => x.id === id)!.name;
const view = { materializer: { printView: async () => ({ name: "v", path: "v", ref: "v" }) } };
/** `p`, or a failure after `ms`: a test that waits on core never hangs the suite. */
function within<T>(ms: number, p: Promise<T>, what: string): Promise<T> {
  let t: NodeJS.Timeout;
  return Promise.race([p, new Promise<T>((_, no) => (t = setTimeout(() => no(new Error(`timed out waiting for ${what}`)), ms)))]).finally(() => clearTimeout(t));
}
const req = (n: number) => ({ todo: `foundation-core request ${n} (local-cli notes)`, timeout: 30_000 });

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
/** Holds the store's writes that match, until released. */
function gated(store: Store) {
  const original = store.write.bind(store);
  const gates: { match: (w: Parameters<Store["write"]>[0]) => boolean; entered: () => void; open: Promise<void>; release: () => void }[] = [];
  (store as { write: Store["write"] }).write = async (w, c) => {
    for (const g of gates) if (g.match(w)) { g.entered(); await g.open; }
    return original(w, c);
  };
  return {
    gate(match: (w: Parameters<Store["write"]>[0]) => boolean) {
      let entered!: () => void, release!: () => void;
      const reached = new Promise<void>((r) => (entered = r));
      const open = new Promise<void>((r) => (release = r));
      gates.push({ match, entered, open, release });
      return { reached, release };
    },
    restore() { for (const g of gates) g.release(); (store as { write: Store["write"] }).write = original; },
  };
}
const pendingOf = (id: string) => (w: Parameters<Store["write"]>[0]) => w.some((x) => x.table === "pending" && (x.value as { id?: string } | undefined)?.id === id);

test("a settle never removes a pending row still being written, though its write started after the settle did", req(1), async () => {
  const w = world();
  const store = createMemoryStore();
  const c = await Carton.open({ adapter, store, init: { doc: doc0() }, actor: agent, sync: w.sync("alice") });
  const g = gated(store);
  try {
    await c.share();
    assert.ok(await c.sync!.connect({ nonce: "n" }));
    await until(async () => (await c.cuts()).find((x) => x.id === c.cut)!.sequencer.kind === "server", 5000, "the hand-off");
    const one = g.gate(pendingOf("sf2.one"));
    const two = g.gate(pendingOf("sf2.two"));
    const p1 = c.commit({ id: "sf2.one", ops: [set("c1", "name", "one")] });
    await one.reached;
    await until(() => c.sync!.state().status === "up-to-date", 5000, "sf2.one confirmed by the server");
    const p2 = c.commit({ id: "sf2.two", ops: [set("c2", "name", "two")] });
    await two.reached;
    await until(() => c.sync!.state().status === "up-to-date", 5000, "sf2.two confirmed by the server");
    one.release();
    await within(5000, p1, "sf2.one's commit");
    await sleep(100);
    assert.equal(await store.get("ids", ["sf2.two"]), undefined, "the settle waits for sf2.two's row before recording it");
    two.release();
    await within(5000, p2, "sf2.two's commit");
    await until(async () => (await store.get("ids", ["sf2.two"])) !== undefined, 5000, "sf2.two recorded");
    await c.head();
    for (const id of ["sf2.one", "sf2.two"]) assert.equal(await store.get("pending", [c.cut, id]), undefined, `${id} is not left pending`);
  } finally {
    g.restore();
    await c.close();
  }
});

test("a handle fenced off, then connected again under the new nonce, pushes what it had pending and settles it", req(2), async () => {
  const w = world();
  const store = createMemoryStore();
  const lease = new Lease(store);
  const old = (await lease.take(null, { pid: 1, socketPath: "/old", kind: "worker" }))!;
  const c = await Carton.open({ adapter, store, init: { doc: doc0() }, actor: agent, sync: w.sync("alice") });
  try {
    let stopped = false;
    c.on((e) => { if (e.type === "sync" && e.status === "stopped") stopped = true; });
    await c.share();
    assert.ok(await c.sync!.connect({ nonce: old.nonce, conditions: [fence(old.nonce)] }));
    await until(async () => (await c.cuts()).find((x) => x.id === c.cut)!.sequencer.kind === "server", 5000, "the hand-off");
    const newer = (await lease.take(old.nonce, { pid: 2, socketPath: "/new", kind: "worker" }))!;
    // refused at once (over the client's own 32 MiB limit): its settle is fenced off, so nothing is recorded and the
    // handle stops
    const r = await within(20_000, c.commit({ id: "sf2.big", author: agent, ops: [set("c1", "name", "x".repeat(33 << 20))] }), "the big commit");
    assert.equal(r.status, "pending");
    await until(() => stopped, 5000, "the fenced handle to stop");
    assert.ok(await store.get("pending", [c.cut, "sf2.big"]), "still pending in the store");
    // the same handle gets the lease back (the app's engine thread re-acquires): the edit is answered and recorded
    assert.ok(await c.sync!.connect({ nonce: newer.nonce, conditions: [fence(newer.nonce)] }));
    await until(async () => (await store.get("pending", [c.cut, "sf2.big"])) === undefined, 5000, "the refused edit to be settled");
    const notices = await store.range<{ change?: string; kind: string }>("notices", { prefix: [actorKey(agent)] });
    assert.ok(notices.some((n) => n.value.change === "sf2.big" && n.value.kind === "rejected"), "its author is told");
  } finally {
    await c.close();
  }
});

test("an empty shared save whose holder was replaced mid-write answers with the store's outcome, never a no-op beside a change", req(3), async () => {
  const w = world();
  const store = createMemoryStore();
  const lease = new Lease(store);
  const old = (await lease.take(null, { pid: 1, socketPath: "/old", kind: "worker" }))!;
  const a = await Carton.open({ adapter, store, init: { doc: doc0() }, actor: agent, sync: w.sync("alice") });
  const g = gated(store);
  let b: Carton | null = null;
  try {
    await a.share();
    assert.ok(await a.sync!.connect({ nonce: old.nonce, fence: () => true, conditions: [fence(old.nonce)] }));
    await until(async () => (await a.cuts()).find((x) => x.id === a.cut)!.sequencer.kind === "server", 5000, "the hand-off");
    const hold = g.gate((wr) => wr.some((x) => x.table === "meta" && x.key[0] === "noop" && x.key[1] === "sf2.empty"));
    const req = { id: "sf2.empty", actor: agent, op: { kind: "commit" as const, ops: [set("c1", "name", "c1")] } };
    const first = runWrite(a, structuredClone(req));
    await hold.reached;
    // the lease moves; the replacement sees someone rename c1, then gets the retry: unanswered, so it applies
    const newer = (await lease.take(old.nonce, { pid: 2, socketPath: "/new", kind: "worker" }))!;
    b = await Carton.open({ adapter, store, actor: agent, sync: w.sync("bob") });
    assert.ok(await b.sync!.connect({ nonce: newer.nonce, conditions: [fence(newer.nonce)] }));
    const other = await b.commit({ ops: [set("c1", "name", "other")] });
    assert.equal((await b.sync!.waitFor(other.status === "pending" ? other.id : "", 5000)).status, "confirmed");
    const retry = await runWrite(b, structuredClone(req));
    assert.equal(retry.status, "confirmed", JSON.stringify(retry));
    assert.equal(retry.id, req.id);
    hold.release();
    const late = await within(5000, first, "the replaced holder's answer");
    assert.equal(late.status, "confirmed", JSON.stringify(late));
    assert.ok(!late.empty && late.id === req.id, `the replaced holder answers with the change the store holds: ${JSON.stringify(late)}`);
    assert.equal(await store.get("meta", ["noop", req.id]), undefined, "no no-op recorded beside the change");
    assert.equal(await nameOf(b, "c1"), "c1");
  } finally {
    g.restore();
    await b?.close();
    await a.close();
  }
});

test("an empty shared save names the same version on retry, even when the queue was ahead of the log", req(4), async () => {
  const w = world();
  const store = createMemoryStore();
  const c = await Carton.open({ adapter, store, init: { doc: doc0() }, actor: agent, sync: w.sync("alice") });
  const g = gated(store);
  try {
    await c.share();
    assert.ok(await c.sync!.connect({ nonce: "n" }));
    await until(async () => (await c.cuts()).find((x) => x.id === c.cut)!.sequencer.kind === "server", 5000, "the hand-off");
    // a pin's write holds the handle's queue, so the next confirmation is in the queue but not yet in the log
    const pins = g.gate((wr) => wr.some((x) => x.table === "pins"));
    const pin = c.pin({ owner: "hold" });
    await pins.reached;
    const r = await c.commit({ id: "sf2.ahead", ops: [set("c1", "name", "new")] });
    assert.equal(r.status, "pending");
    await until(() => c.sync!.state().status === "up-to-date", 5000, "the change confirmed by the server");
    const first = await within(5000, c.commit({ id: "sf2.noop", ops: [] }), "the empty commit");
    assert.equal(first.status, "confirmed");
    const recorded = await store.get<[string, number]>("meta", ["noop", "sf2.noop"]);
    assert.equal(recorded![1], first.status === "confirmed" ? first.seq : -1, "recorded at the version it answered with");
    pins.release();
    await within(5000, pin, "the pin");
    const retry = await within(5000, c.commit({ id: "sf2.noop", ops: [] }), "the retried empty commit");
    assert.deepEqual([retry.status, retry.status === "confirmed" && retry.seq], ["confirmed", first.seq]);
  } finally {
    g.restore();
    await c.close();
  }
});

test("an empty `undo --turn` retried after new conflicting work in the turn stays the empty answer", async () => {
  const store = createMemoryStore();
  const c = await Carton.open({ adapter, store, init: { doc: doc0() }, actor: agent });
  try {
    const req = { id: "sf2.undo", actor: agent, op: { kind: "undoTurn" as const, turn: "T" } };
    assert.equal((await runWrite(c, structuredClone(req))).empty, true);
    await c.commit({ author: { ...agent, turn: "T" }, ops: [set("c5", "endTime", 29), set("c5", "trimEnd", 4)] });
    await c.commit({ author: { kind: "human", id: "other" }, ops: [set("c5", "endTime", 29.4), set("c5", "trimEnd", 4.4)] });
    const again = await runWrite(c, structuredClone(req));
    assert.equal(again.status, "confirmed", JSON.stringify(again));
    assert.equal(again.empty, true);
  } finally {
    await c.close();
  }
});

test("notices: a delivery that fails gives none away; two copies of one request both get what was delivered to it", async () => {
  const store = createMemoryStore();
  const c = await Carton.open({ adapter, store, init: { doc: doc0() }, actor: agent });
  try {
    await store.write(["old.1", "old.2"].map((change, i) => ({ table: "notices", key: [actorKey(agent), i, 0], value: { to: actorKey(agent), kind: "rejected", text: change, change } })));
    const original = store.write.bind(store);
    (store as { write: Store["write"] }).write = async (wr, conds) => {
      if (wr.some((x) => x.table === "notices" && (x.value as { deliveredAt?: number } | undefined)?.deliveredAt)) throw new Error("disk unavailable");
      return original(wr, conds);
    };
    await assert.rejects(runWrite(c, { id: "sf2.failed", actor: agent, op: { kind: "printView" } }, view), /disk unavailable/);
    (store as { write: Store["write"] }).write = original;
    const req = { id: "sf2.twice", actor: agent, op: { kind: "printView" as const } };
    const [x, y] = await Promise.all([runWrite(c, structuredClone(req), view), runWrite(c, structuredClone(req), view)]);
    for (const r of [x, y]) assert.deepEqual(r.notices.map((n) => n.change).sort(), ["old.1", "old.2"], "both copies (either may be the reply that arrives)");
    const next = await runWrite(c, { id: "sf2.next", actor: agent, op: { kind: "pin", owner: "p" } });
    assert.deepEqual(next.notices, [], "delivered once, to that request");
  } finally {
    await c.close();
  }
});
