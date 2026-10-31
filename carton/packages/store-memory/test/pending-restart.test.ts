// A reload between a rebase and the server's answer (web-demo REQ-7, its review R3-2): a pending change on a shared
// cut resumes where the queue had it, not as a fresh change. Before, the store kept only its latest ops: the cards its
// rebase raised were lost (a change that clashed came back as only its clean ops, and nobody was told the other side's
// value was kept), and one the rebase had emptied was dropped without being withdrawn.
import { test } from "node:test";
import assert from "node:assert/strict";
import { Carton, type Actor, type CommitResult, type ConfirmedChange } from "@carton/core";
import type { Store, Transport, TransportConnection } from "@carton/core/plugins";
import { createMemoryStore } from "../src/index.ts";
import { adapter, doc0, item, set } from "./fixture.ts";
import { copyStore, until, world } from "./world.ts";

const alice: Actor = { kind: "human", id: "alice", group: "alice@laptop" };
const bob: Actor = { kind: "human", id: "bob", group: "bob@desk" };
const pendingId = (r: CommitResult): string => (r.status === "pending" ? r.id : assert.fail(`expected pending, got ${r.status}`));
type Row = { id: string; ops: unknown[]; k?: number; cards?: { k: number; cards: { path: string }[] }[]; sentBases?: number[] };
const pendingRow = async (s: Store, cut: string, id: string) => (await s.get<Row>("pending", [cut, id])) ?? null;
const confirmedRow = async (s: Store, cut: string, id: string) => (await s.range<ConfirmedChange>("changes", { prefix: [cut] })).map((r) => r.value).find((c) => c.id === id);

/** The host's transport, except that this client's pushes and withdraws never reach the server (it never answers). */
function unanswered(t: Transport, dropped: { type: string }[]): Transport {
  return {
    async connect(url, opts) {
      const c = await t.connect(url, opts);
      const out: TransportConnection = {
        get open() {
          return c.open;
        },
        send: (m) => (m.type === "push" || m.type === "withdraw" ? void dropped.push(m) : c.send(m)),
        onMessage: (l) => c.onMessage(l),
        onClose: (l) => c.onClose(l),
        close: () => c.close(),
      };
      return out;
    },
  };
}

/** Alice's change is sent (the server never gets it), bob's clash on items/a is confirmed, alice's queue rebases it. */
async function rebasedThenClosed(ops: ReturnType<typeof set>[]) {
  const w = world();
  const sa = createMemoryStore();
  const first = await Carton.open({ adapter, store: sa, init: { doc: doc0() }, actor: alice, sync: w.sync("alice") });
  await first.share();
  await until(async () => (await first.cuts())[0]!.sequencer.kind === "server", 5000, "the hand-off");
  const cut = first.cut;
  const sb = await copyStore(sa);
  await first.close();
  const dropped: { type: string }[] = [];
  const a = await Carton.open({ adapter, store: sa, actor: alice, sync: { ...w.sync("alice"), transport: unanswered(w.host.transport, dropped) } });
  const b = await Carton.open({ adapter, store: sb, actor: bob, sync: w.sync("bob") });
  await until(() => a.sync!.status !== "offline" && b.sync!.status === "up-to-date", 5000, "both connected");
  const id = pendingId(await a.commit({ ops }));
  await until(async () => !!(await pendingRow(sa, cut, id))?.sentBases?.length, 5000, "alice's change sent (and its base kept)");
  assert.equal((await b.commit({ ops: [set("a", "name", "Bob's")], wait: 5000 })).status, "confirmed");
  await until(async () => ((await pendingRow(sa, cut, id))?.k ?? 0) >= 1, 5000, "alice's change rebased onto bob's, as the store keeps it");
  await a.close();
  return { w, sa, sb, b, cut, id, dropped };
}

test("REQ-7: a change that clashed in a rebase comes back after a reload with its card: confirmed as that rebase, its author told", async () => {
  const { w, sa, b, cut, id } = await rebasedThenClosed([set("a", "name", "Alice's"), set("b", "name", "Alice's b")]);
  const kept = (await pendingRow(sa, cut, id))!;
  assert.deepEqual(kept.ops, [{ op: "set", path: ["items", "b", "name"], value: "Alice's b" }], "only its clean op is left to push");
  assert.ok(kept.cards?.some((c) => c.k === 1 && c.cards.some((x) => x.path.startsWith("items/a"))), JSON.stringify(kept.cards));
  const again = await Carton.open({ adapter, store: sa, actor: alice, sync: w.sync("alice") });
  await until(async () => !!(await confirmedRow(sa, cut, id)), 5000, "alice's change confirmed after the reload");
  const r = (await confirmedRow(sa, cut, id))!;
  assert.equal(r.rebase, 1, "confirmed as the rebased version, not as a fresh change");
  assert.deepEqual(r.supersedes, [`${id}#0`]);
  const d = (await again.head()).doc;
  assert.equal(item(d, "a")!.name, "Bob's");
  assert.equal(item(d, "b")!.name, "Alice's b");
  // the "Keep yours" card reaches its author when the change settles
  await until(async () => (await again.notices(alice)).some((n) => n.kind === "late-conflict" && n.change === id), 5000, "alice's late-conflict notice");
  const n = (await again.notices(alice)).find((x) => x.change === id)!;
  assert.ok(n.cards?.some((c) => c.path.startsWith("items/a")), JSON.stringify(n.cards));
  assert.deepEqual(await again.store.range("pending", { prefix: [cut] }), []);
  for (const c of [again, b]) await c.close();
  w.host.close();
});

test("REQ-7: a change a rebase emptied, sent before, is withdrawn after a reload and its card reported, never dropped silently", async () => {
  const { w, sa, b, cut, id } = await rebasedThenClosed([set("a", "name", "Alice's")]);
  const kept = (await pendingRow(sa, cut, id))!;
  assert.deepEqual(kept.ops, [], "the rebase left nothing to push");
  assert.ok(kept.sentBases?.length, "but a copy was sent");
  const again = await Carton.open({ adapter, store: sa, actor: alice, sync: w.sync("alice") });
  await until(async () => (await again.notices(alice)).some((n) => n.kind === "late-conflict" && n.change === id), 5000, "alice told her change kept bob's value");
  await until(async () => (await again.store.range("pending", { prefix: [cut] })).length === 0, 5000, "withdrawn, out of the queue");
  // its id is spent as a withdrawn row: nothing of it applied
  const r = (await confirmedRow(sa, cut, id)) as (ConfirmedChange & { withdrawn?: boolean }) | undefined;
  assert.equal(r?.withdrawn, true, "the server recorded a withdraw, not the change");
  assert.deepEqual(r?.ops, []);
  assert.equal(item((await again.head()).doc, "a")!.name, "Bob's");
  assert.equal(again.sync!.status, "up-to-date");
  for (const c of [again, b]) await c.close();
  w.host.close();
});
