// Stage F: every mutating write runs under its request id, so a retried call (its holder died after receiving it) gets
// the first answer and never a second change: undo, revert, restore, fold, fold in some of it, new cut. And an outcome
// that arrives while `cb` waits is that call's answer, never told again as a notice on the next call.
import { test } from "node:test";
import assert from "node:assert/strict";
import { Carton } from "@carton/core";
import type { Actor } from "@carton/core";
import type { AuthContext, AuthProvider, Store } from "@carton/core/plugins";
import { createMemoryStore } from "@carton/store-memory";
import { createInProcessHost } from "@carton/server";
import { sqliteStorage } from "../../conformance/src/system/sqlite.ts";
import { runWrite, actorKey } from "../src/writes.ts";
import type { WriteOp } from "../src/writes.ts";
import { adapter, doc0, schema } from "./support/real.ts";

const agent: Actor = { kind: "agent", id: "codex/retry", name: "Codex", group: "local:me@box" };
const set = (id: string, f: string, v: unknown) => ({ op: "set" as const, path: ["timelineItems", id, f], value: v });

test("a retried write (same request id) gets the first answer and makes no second change", async () => {
  const c = await Carton.open({ adapter, store: createMemoryStore(), init: { doc: doc0() }, actor: agent });
  const main = c.cut;
  const once = async (id: string, op: WriteOp) => {
    const before = (await c.log({ limit: 1000 })).length;
    const a = await runWrite(c, { id, actor: agent, op: structuredClone(op) });
    const mid = (await c.log({ limit: 1000 })).length;
    const b = await runWrite(c, { id, actor: agent, op: structuredClone(op) });
    const after = (await c.log({ limit: 1000 })).length;
    assert.equal(after, mid, `${op.kind}: the retry made no second change`);
    assert.equal(b.status, a.status, `${op.kind}: same answer`);
    return { a, b, made: mid - before };
  };
  await runWrite(c, { id: "w.1", actor: agent, op: { kind: "commit", ops: [set("c1", "name", "x")] } });
  await runWrite(c, { id: "w.2", actor: agent, op: { kind: "commit", ops: [set("c2", "name", "y")] } });
  assert.equal((await once("u.1", { kind: "undo" })).made, 1, "one undo");
  const firstChange = (await c.log({ limit: 1000 })).find((v) => v.change === "w.1")!.change!;
  assert.equal((await once("rv.1", { kind: "revert", changeId: firstChange })).made, 1, "one revert");
  assert.equal((await once("rs.1", { kind: "restore", ref: `${main}@1` })).made, 1, "one restore");
  const f1 = await runWrite(c, { id: "fk.1", actor: agent, op: { kind: "fork", name: "Alt" } });
  const f2 = await runWrite(c, { id: "fk.1", actor: agent, op: { kind: "fork", name: "Alt" } });
  assert.equal((await c.cuts()).filter((x) => x.name === "Alt").length, 1, "one new cut");
  assert.equal((f1 as any).cut.id, (f2 as any).cut.id);
  const alt = (f1 as any).cut.id as string;
  await runWrite(c, { id: "w.3", actor: agent, op: { kind: "commit", cut: alt, ops: [set("c3", "name", "alt")] } });
  assert.equal((await once("fo.1", { kind: "fold", from: alt })).made, 1, "one fold");
  await runWrite(c, { id: "w.4", actor: agent, op: { kind: "commit", cut: alt, ops: [set("c4", "name", "alt-4"), set("c5", "name", "alt-5")] } });
  const some = await once("fs.1", { kind: "fold", from: alt, reject: ["timelineItems/c5"] });
  assert.ok(some.made >= 1, "fold in some of it, once");
});

test("a late conflict that arrives while cb waits is that call's answer, and is not told again on the next call", async () => {
  const tokens = new Map<string, AuthContext>();
  const auth: AuthProvider = { kind: "table", async verify(t) { return tokens.get(t) ?? null; } };
  const host = createInProcessHost({ storage: sqliteStorage(), auth, timeline: schema.timeline!, groupOf: (c, f) => schema.collections[c]?.groupOf.get(f)?.name });
  const sync = (name: string) => {
    tokens.set(`tok-${name}`, { account: name, credential: `${name}/install`, role: "editor", projectId: "p", expires: Date.now() + 3600_000 });
    return { transport: host.transport, url: host.url, token: `tok-${name}`, autoConnect: false };
  };
  // the holder's store writes the notice late (a busy handle settles behind other writes): cb must still see it
  const inner = createMemoryStore();
  let slowNotices = false;
  const store = new Proxy(inner, {
    get(t, k) {
      if (k === "write") return async (w: Parameters<Store["write"]>[0], ...rest: unknown[]) => {
        if (slowNotices && w.some((x) => x.table === "notices")) await new Promise((r) => setTimeout(r, 300));
        return (t.write as (...a: unknown[]) => unknown)(w, ...rest);
      };
      const v = (t as any)[k];
      return typeof v === "function" ? v.bind(t) : v;
    },
  }) as Store;
  const a = await Carton.open({ adapter, store, init: { doc: doc0() }, actor: agent, sync: sync("alice") });
  await a.share();
  assert.ok(await a.sync!.connect({ nonce: "n1" }));
  const shared = async () => (await a.cuts()).find((x) => x.id === a.cut)!.sequencer.kind === "server";
  for (let end = Date.now() + 10_000; !(await shared()); await new Promise((r) => setTimeout(r, 10))) if (Date.now() > end) throw new Error("hand-off");
  await a.sync!.disconnect();
  // another machine with the project trims c5's end first
  const bobStore = createMemoryStore();
  const data = (inner as unknown as { data: { tables: Map<string, unknown> } }).data;
  for (const t of data.tables.keys()) {
    const rows = await inner.range(t);
    if (rows.length) await bobStore.write(rows.map((r) => ({ table: t, key: r.key, value: JSON.parse(JSON.stringify(r.value)) })));
  }
  const bob = await Carton.open({ adapter, store: bobStore, actor: { kind: "human", id: "bob" }, sync: sync("bob") });
  assert.ok(await bob.sync!.connect({ nonce: "b1" }));
  const rb = await bob.commit({ ops: [set("c5", "endTime", 29), set("c5", "trimEnd", 4)] });
  assert.equal(rb.status, "pending");
  assert.equal((await bob.sync!.waitFor(rb.status === "pending" ? rb.id : "", 5000)).status, "confirmed");
  await bob.close();
  // the agent trims the same edge: queued while offline, and the connection comes back while its cb call waits
  slowNotices = true;
  const r = await runWrite(a, { id: "late.1", actor: agent, op: { kind: "commit", ops: [set("c5", "endTime", 29.4), set("c5", "trimEnd", 4.4)] } },
    { online: () => { void a.sync!.connect({ nonce: "n2" }); return true; } });
  assert.equal(r.status, "conflicts", JSON.stringify(r));
  assert.ok((r as any).conflicts.some((c: { path: string }) => c.path.startsWith("timelineItems/c5")), JSON.stringify(r));
  const rows = await inner.range<{ change?: string; deliveredAt?: number }>("notices", { prefix: [actorKey(agent)] });
  const late = rows.filter((x) => x.value.change === "late.1");
  assert.equal(late.length, 1, "core wrote its late-conflict notice for the author before the wait returned");
  assert.ok(late[0]!.value.deliveredAt, "and this call's answer marked it delivered");
  slowNotices = false;
  const next = await runWrite(a, { id: "next.1", actor: agent, op: { kind: "commit", ops: [set("c0", "name", "next")] } });
  assert.ok(!next.notices.some((n) => n.change === "late.1"), "not told again");
  await a.close();
});
