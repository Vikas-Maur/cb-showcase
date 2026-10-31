// Regressions from Stage F review round 1, on real Carton handles and the in-process sequencer host: retried shared
// requests answer as the first time (empty, or with their cards); a holder replaced before its fence noticed records
// nothing; a change refused at once still finds its author and never comes back pending; notices go out once, to the
// call that reports them, and again only to a retry of that call; a Stop decision blocks once; a write's online state
// is its own cut's; a live absorption reads "already in place"; an empty `undo --turn` stays empty on retry.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { Carton } from "@carton/core";
import type { Actor } from "@carton/core";
import type { AuthContext, AuthProvider, Store, Transport } from "@carton/core/plugins";
import { createMemoryStore } from "@carton/store-memory";
import { openSqliteStore } from "@carton/store-sqlite";
import { createInProcessHost } from "@carton/server";
import { sqliteStorage } from "../../conformance/src/system/sqlite.ts";
import { runWrite, actorKey, ALREADY_IN_PLACE } from "../src/writes.ts";
import type { CbResult } from "../src/writes.ts";
import { StoreNoticeBox } from "../src/notices.ts";
import { stopHook } from "../src/hooks.ts";
import { Lease, fence } from "../src/lease.ts";
import { adapter, doc0, schema } from "./support/real.ts";
import { scratch } from "./support/scratch.ts";

const agent: Actor = { kind: "agent", id: "claude-code/sf1", name: "Claude Code", group: "local:me@box" };
const set = (id: string, f: string, v: unknown) => ({ op: "set" as const, path: ["timelineItems", id, f], value: v });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(f: () => Promise<boolean> | boolean, ms = 5000, what = "condition") {
  for (const end = Date.now() + ms; !(await f()); await sleep(10)) if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
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
async function share(c: Carton, cut = c.cut, nonce = "n1") {
  await c.share(cut);
  assert.ok(await c.sync!.connect({ nonce }));
  await until(async () => (await c.cuts()).find((x) => x.id === cut)!.sequencer.kind === "server", 5000, "the hand-off");
}
/** A copy of a memory store's tables: another machine with the project. */
async function copyOf(from: Store): Promise<Store> {
  const to = createMemoryStore();
  for (const t of (from as unknown as { data: { tables: Map<string, unknown> } }).data.tables.keys()) {
    const rows = await from.range(t);
    if (rows.length) await to.write(rows.map((r) => ({ table: t, key: r.key, value: structuredClone(r.value) })));
  }
  return to;
}
const nameOf = async (c: Carton, id: string) => ((await c.head()).doc.timelineItems as { id: string; name: string }[]).find((x) => x.id === id)!.name;

test("a retried shared request answers as the first time: an empty save stays empty, a carded one keeps its cards", async () => {
  const w = world();
  const c = await Carton.open({ adapter, store: createMemoryStore(), init: { doc: doc0() }, actor: agent, sync: w.sync("alice") });
  try {
    await share(c);
    // empty: c1 is already named c1. Someone renames it; the retry must not put the agent's value back over theirs
    const empty = { id: "sf1.empty", actor: agent, op: { kind: "commit" as const, ops: [set("c1", "name", "c1")] } };
    assert.equal((await runWrite(c, structuredClone(empty))).empty, true);
    const other = await c.commit({ ops: [set("c1", "name", "other")] });
    assert.equal((await c.sync!.waitFor(other.status === "pending" ? other.id : "", 2000)).status, "confirmed");
    const again = await runWrite(c, structuredClone(empty));
    assert.equal(again.status, "confirmed");
    assert.equal(again.empty, true, "the retry is still the empty answer");
    await sleep(50);
    assert.equal(await nameOf(c, "c1"), "other", "never re-applied over someone else's edit");
    assert.ok(!(await c.log()).some((v) => v.change === empty.id), "no change under the request's id");

    // carded: a save from a stale base clashes on c2's name; its retry is conflicts again, with the same cards
    const base = (await c.head()).ref;
    const theirs = await c.commit({ ops: [set("c2", "name", "theirs")] });
    assert.equal((await c.sync!.waitFor(theirs.status === "pending" ? theirs.id : "", 2000)).status, "confirmed");
    const carded = { id: "sf1.cards", actor: agent, op: { kind: "commit" as const, base: base as unknown as string, ops: [set("c2", "name", "mine"), set("c3", "name", "clean")] } };
    const first = await runWrite(c, structuredClone(carded));
    assert.equal(first.status, "conflicts", JSON.stringify(first));
    const retry = await runWrite(c, structuredClone(carded));
    assert.equal(retry.status, "conflicts", JSON.stringify(retry));
    assert.deepEqual((retry as { conflicts: { path: string }[] }).conflicts.map((x) => x.path), (first as { conflicts: { path: string }[] }).conflicts.map((x) => x.path));
  } finally {
    await c.close();
  }
});

test("a holder replaced before its fence noticed records nothing from the server and stops; its replacement records it once", async () => {
  const w = world();
  const store = createMemoryStore();
  const lease = new Lease(store);
  const old = (await lease.take(null, { pid: 1, socketPath: "/old", kind: "worker" }))!;
  const a = await Carton.open({ adapter, store, init: { doc: doc0() }, actor: agent, sync: w.sync("alice") });
  const stopped: string[] = [];
  a.on((e) => { if (e.type === "sync" && e.status === "stopped") stopped.push("stopped"); });
  await a.share();
  // this holder's own fence (refreshed by heartbeats) still says yes; the store's lease condition is what holds
  assert.ok(await a.sync!.connect({ nonce: old.nonce, fence: () => true, conditions: [fence(old.nonce)] }));
  await until(async () => (await a.cuts()).find((x) => x.id === a.cut)!.sequencer.kind === "server", 5000, "the hand-off");
  const fresh = (await lease.take(old.nonce, { pid: 2, socketPath: "/new", kind: "helper" }))!;
  const r = await a.commit({ ops: [set("c4", "name", "while replaced")] });
  assert.equal(r.status, "pending");
  const id = r.status === "pending" ? r.id : "";
  await until(() => stopped.length > 0, 5000, "the replaced holder to stop");
  assert.equal(await store.get("ids", [id]), undefined, "the replaced holder recorded nothing");
  assert.ok(await store.get("pending", [a.cut, id]), "its pending row stays for the replacement");
  await a.close();
  const b = await Carton.open({ adapter, store, actor: agent, sync: w.sync("alice2") });
  try {
    assert.ok(await b.sync!.connect({ nonce: fresh.nonce, conditions: [fence(fresh.nonce)] }));
    await until(async () => (await store.get("ids", [id])) !== undefined, 5000, "the replacement to record it");
    assert.equal(await store.get("pending", [b.cut, id]), undefined);
  } finally {
    await b.close();
  }
});

test("a change refused at once (too large) on carton.db finds its author, tells them once, and never comes back pending", async () => {
  const w = world();
  // the welcome declares a 16 KiB limit, as a host with blob envelopes does
  const transport: Transport = {
    async connect(url, o) {
      const inner = await w.host.transport.connect(url, o);
      return {
        get open() { return inner.open; },
        send: (m) => inner.send(m),
        onClose: (f) => inner.onClose(f),
        close: (...x) => inner.close(...x),
        onMessage: (f) => inner.onMessage((m: any) => f(m?.type === "hello" ? { ...m, maxMessageBytes: 16 * 1024 } : m)),
      } as typeof inner;
    },
  } as Transport;
  const store = await openSqliteStore(join(mkdtempSync(join(scratch(), "sf1-")), "carton.db"));
  const c = await Carton.open({ adapter, store, init: { doc: doc0() }, actor: agent, sync: w.sync("alice", transport) });
  try {
    await share(c);
    const big = await runWrite(c, { id: "sf1.big", actor: agent, op: { kind: "commit", ops: [set("c3", "name", "x".repeat(64 * 1024))] } });
    assert.equal(big.status, "rejected", JSON.stringify(big).slice(0, 200));
    assert.equal((big as { reason: string }).reason, "too large");
    await c.head();
    assert.ok(!(await store.range<{ id: string }>("pending")).some((x) => x.value.id === "sf1.big"), "not back in the pending table");
    const mine = (await store.range<{ change?: string; deliveredAt?: number }>("notices", { prefix: [actorKey(agent)] })).filter((x) => x.value.change === "sf1.big");
    assert.equal(mine.length, 1, "its author's notice was written");
    assert.ok(mine[0]!.value.deliveredAt, "and reported by this call, so the next call doesn't repeat it");
    const next = await runWrite(c, { id: "sf1.next", actor: agent, op: { kind: "commit", ops: [set("c4", "name", "small")] } });
    assert.ok(!next.notices.some((n) => n.change === "sf1.big"));
  } finally {
    await c.close();
    await store.close();
  }
});

test("notices: a call that fails gives none away; a retried request gets its own again; another call's awaited outcome is left to it", async () => {
  const store = createMemoryStore();
  const c = await Carton.open({ adapter, store, init: { doc: doc0() }, actor: agent });
  try {
    await store.write([{ table: "notices", key: [actorKey(agent), 1, 0], value: { to: actorKey(agent), kind: "late-conflict", text: "unread", change: "old.1", cards: [{ kind: "field", path: "timelineItems/c1/name", base: 1, ours: 2, theirs: 3 }] } }]);
    await assert.rejects(runWrite(c, { id: "sf1.fails", actor: agent, op: { kind: "commit", cut: "no-such-cut", ops: [set("c1", "name", "x")] } }));
    const got = await runWrite(c, { id: "sf1.r1", actor: agent, op: { kind: "pin", owner: "x" } });
    assert.deepEqual(got.notices.map((n) => n.change), ["old.1"], "still there after the failed call");
    const retry = await runWrite(c, { id: "sf1.r1", actor: agent, op: { kind: "pin", owner: "x" } });
    assert.deepEqual(retry.notices.map((n) => n.change), ["old.1"], "a retry of that request (its answer was lost) gets it again");
    const other = await runWrite(c, { id: "sf1.r2", actor: agent, op: { kind: "pin", owner: "x" } });
    assert.deepEqual(other.notices, [], "any other call doesn't");
  } finally {
    await c.close();
  }
});

test("a late conflict that another call of the same actor could pick up first is reported once, by the write waiting for it", async () => {
  const w = world();
  const inner = createMemoryStore();
  let during: CbResult | null = null;
  let c!: Carton;
  // when core stores the notice, a second cb call of the same agent runs before the waiting write resumes
  const store = new Proxy(inner, {
    get(t, k) {
      if (k === "write") return async (wr: Parameters<Store["write"]>[0], ...rest: unknown[]) => {
        const ok = await (t.write as (...a: unknown[]) => Promise<boolean>)(wr, ...rest);
        if (!during && wr.some((x) => x.table === "notices" && (x.value as { change?: string } | undefined)?.change === "sf1.trim")) {
          // (a write that doesn't queue behind this one: it runs inside core's settle, which a pin would wait for)
          during = await runWrite(c, { id: "sf1.during", actor: agent, op: { kind: "printView", name: "x" } }, { materializer: { printView: async () => ({ name: "x", path: "x", ref: "x" }) } });
        }
        return ok;
      };
      const v = (t as any)[k];
      return typeof v === "function" ? v.bind(t) : v;
    },
  }) as Store;
  c = await Carton.open({ adapter, store, init: { doc: doc0() }, actor: agent, sync: w.sync("alice") });
  try {
    await share(c);
    await c.sync!.disconnect();
    const bob = await Carton.open({ adapter, store: await copyOf(inner), actor: { kind: "human", id: "bob" }, sync: w.sync("bob") });
    assert.ok(await bob.sync!.connect({ nonce: "b" }));
    const rb = await bob.commit({ ops: [set("c5", "endTime", 29), set("c5", "trimEnd", 4)] });
    assert.equal((await bob.sync!.waitFor(rb.status === "pending" ? rb.id : "", 5000)).status, "confirmed");
    await bob.close();
    const r = await runWrite(c, { id: "sf1.trim", actor: agent, op: { kind: "commit", ops: [set("c5", "endTime", 29.4), set("c5", "trimEnd", 4.4)] } },
      { online: () => { void c.sync!.connect({ nonce: "n2" }); return true; } });
    assert.equal(r.status, "conflicts", JSON.stringify(r));
    const d = during as CbResult | null;
    assert.ok(d, "the other call ran while the notice was being stored");
    assert.ok(!d.notices.some((n) => n.change === "sf1.trim"), "the other call left it to the waiting write");
    const later = await runWrite(c, { id: "sf1.later", actor: agent, op: { kind: "pin", owner: "x" } });
    assert.ok(!later.notices.some((n) => n.change === "sf1.trim"), "and nobody reports it again");
  } finally {
    await c.close();
  }
});

test("a live absorption (another replica saved the identical edit first) reads as confirmed, already in place", async () => {
  const w = world();
  const store = createMemoryStore();
  const c = await Carton.open({ adapter, store, init: { doc: doc0() }, actor: agent, sync: w.sync("alice") });
  try {
    await share(c);
    await c.sync!.disconnect();
    const bob = await Carton.open({ adapter, store: await copyOf(store), actor: { kind: "human", id: "bob" }, sync: w.sync("bob") });
    assert.ok(await bob.sync!.connect({ nonce: "b" }));
    const rb = await bob.commit({ ops: [set("c1", "name", "same")] });
    assert.equal((await bob.sync!.waitFor(rb.status === "pending" ? rb.id : "", 5000)).status, "confirmed");
    await bob.close();
    const r = await runWrite(c, { id: "sf1.same", actor: agent, op: { kind: "commit", ops: [set("c1", "name", "same")] } },
      { online: () => { void c.sync!.connect({ nonce: "n2" }); return true; } });
    assert.equal(r.status, "confirmed", JSON.stringify(r));
    assert.equal(r.absorbed, true, JSON.stringify(r));
    assert.equal(r.note, ALREADY_IN_PLACE);
  } finally {
    await c.close();
  }
});

test("a write to a connected shared cut that isn't the current one waits for its answer (online is the written cut's)", async () => {
  const w = world();
  const c = await Carton.open({ adapter, store: createMemoryStore(), init: { doc: doc0() }, actor: agent, sync: w.sync("alice") });
  try {
    const alt = await c.fork("Shared alt", { id: "sf1.alt" });
    await share(c, alt.id);
    assert.equal((await c.cuts()).find((x) => x.id === c.cut)!.sequencer.kind, "local", "the current cut stays local");
    const r = await runWrite(c, { id: "sf1.alt.1", actor: agent, op: { kind: "commit", cut: alt.id, ops: [set("c2", "name", "alt")] } });
    assert.equal(r.status, "confirmed", JSON.stringify(r));
  } finally {
    await c.close();
  }
});

test("an empty `undo --turn` stays empty on retry: work that reached the turn since is not undone", async () => {
  const c = await Carton.open({ adapter, store: createMemoryStore(), init: { doc: doc0() }, actor: agent });
  try {
    const req = { id: "sf1.undo", actor: agent, op: { kind: "undoTurn" as const, turn: "T" } };
    assert.equal((await runWrite(c, structuredClone(req))).empty, true);
    await c.commit({ author: { ...agent, turn: "T" }, ops: [set("c1", "name", "late subagent")] });
    const again = await runWrite(c, structuredClone(req));
    assert.equal(again.empty, true, JSON.stringify(again));
    assert.equal(await nameOf(c, "c1"), "late subagent");
    // and a retry of an undo that did land answers with that undo, not "nothing to undo"
    const real = { id: "sf1.undo2", actor: agent, op: { kind: "undoTurn" as const, turn: "T" } };
    const first = await runWrite(c, structuredClone(real));
    assert.equal(first.status, "confirmed");
    assert.ok(!first.empty && first.id === "sf1.undo2", JSON.stringify(first));
    const retried = await runWrite(c, structuredClone(real));
    assert.equal(retried.id, "sf1.undo2", JSON.stringify(retried));
    assert.equal(await nameOf(c, "c1"), "c1");
  } finally {
    await c.close();
  }
});

test("two Stop hook calls at once for the same conflict: one blocks, the other lets the agent stop", async () => {
  const store = createMemoryStore();
  await store.write([{ table: "notices", key: [actorKey(agent), 1, 0], value: { to: actorKey(agent), kind: "late-conflict", text: "card", change: "x.1", cards: [{ kind: "field", path: "timelineItems/c1/name", base: 1, ours: 2, theirs: 3 }] } }]);
  const input = { hook_event_name: "Stop", session_id: "sf1", stop_hook_active: false };
  const [a, b] = await Promise.all([new StoreNoticeBox(store).run(agent.id, (box) => stopHook(input as any, box)), new StoreNoticeBox(store).run(agent.id, (box) => stopHook(input as any, box))]);
  assert.deepEqual([a.decision, b.decision].sort(), ["allow", "block"]);
});
