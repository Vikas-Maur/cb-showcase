// A withdraw row (H1) on a shared cut is never a version anyone sees. Alice's edit is sent, Bob makes the same edit and
// his lands first: her rebase leaves nothing, so her client withdraws the id and the server spends it with an empty
// row (`author: {kind: "system", id: "withdraw"}`, `withdrawn: true`) that it fans out like any row.
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
const pendingRow = async (s: Store, cut: string, id: string) => (await s.get<{ sentBases?: number[] }>("pending", [cut, id])) ?? null;

/** The host's transport, except that this client's pushes are held back until `release()`; withdraws go through. */
function held(t: Transport) {
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
  return {
    transport,
    hold: () => void (open = false),
    release: () => {
      open = true;
      for (const { c, m } of queue.splice(0)) if (c.open) c.send(m);
    },
  };
}

/** Alice and Bob on one shared cut; Alice's edit is sent but held, Bob's identical edit lands, hers is withdrawn. */
async function withdrawnOnShared() {
  const w = world();
  const sa = createMemoryStore();
  const first = await Carton.open({ adapter, store: sa, init: { doc: doc0() }, actor: alice, sync: w.sync("alice") });
  await first.share();
  await until(async () => (await first.cuts())[0]!.sequencer.kind === "server", 5000, "the hand-off");
  const cut = first.cut;
  const sb = await copyStore(sa);
  await first.close();
  const gate = held(w.host.transport);
  const a = await Carton.open({ adapter, store: sa, actor: alice, sync: { ...w.sync("alice"), transport: gate.transport } });
  const b = await Carton.open({ adapter, store: sb, actor: bob, sync: w.sync("bob") });
  await until(() => a.sync!.status === "up-to-date" && b.sync!.status === "up-to-date", 5000, "both connected");
  const seen: { who: string; seq: number; id: string; withdrawn: boolean }[] = [];
  for (const [who, c] of [["alice", a], ["bob", b]] as const) c.on((e) => void (e.type === "change" && seen.push({ who, seq: e.seq, id: e.change.id, withdrawn: !!e.change.withdrawn })));
  gate.hold();
  const id = pendingId(await a.commit({ ops: [set("a", "name", "Same")] }));
  await until(async () => !!(await pendingRow(sa, cut, id))?.sentBases?.length, 5000, "alice's edit sent");
  assert.equal((await b.commit({ ops: [set("a", "name", "Same")], wait: 5000 })).status, "confirmed");
  assert.equal((await a.sync!.waitFor(id, 5000)).status, "absorbed", "alice's edit is withdrawn");
  gate.release();
  assert.equal(w.host.sequencer.stats.withdraws, 1, "the server spent alice's id with a withdraw row");
  // the withdraw row reaches Bob and is stored there: the id stays spent
  await until(async () => (await sb.range<ConfirmedChange>("changes", { prefix: [cut] })).some((r) => r.value.id === id && r.value.withdrawn), 5000, "the withdraw row on Bob's side");
  return { w, a, b, sa, sb, cut, id, seen };
}

test("a teammate's withdrawn edit is not a version in Bob's History", async () => {
  const { w, a, b, sb, cut, id } = await withdrawnOnShared();
  try {
    const rows = (await sb.range<ConfirmedChange>("changes", { prefix: [cut] })).map((r) => r.value);
    const wr = rows.find((r) => r.id === id)!;
    assert.equal(wr.withdrawn, true, "kept in storage: the id stays spent");
    assert.equal(wr.author.kind, "system");
    for (const c of [a, b]) {
      assert.equal((await c.head()).ref.seq, wr.seq, "the head is past the withdraw row: its seq stays taken");
      const log = await c.log();
      assert.ok(!log.some((v) => v.change === id), `withdraw row listed as a version: ${JSON.stringify(log.map((v) => [v.ref.seq, v.change, v.author]))}`);
      assert.ok(!log.some((v) => v.author?.kind === "system"), "no authorless system version");
      assert.deepEqual(log.map((v) => v.ref.seq), [wr.seq - 1, 0], "Bob's edit and the root");
      assert.equal(item((await c.head()).doc, "a")!.name, "Same");
      // a page ending at the gap still fills from below it, and summaries skip it too
      assert.deepEqual((await c.log({ limit: 1 })).map((v) => v.ref.seq), [wr.seq - 1]);
      const [top] = await c.log({ before: wr.seq + 1, limit: 1, summary: true });
      assert.equal(top!.ref.seq, wr.seq - 1);
      assert.ok(top!.summary, "described as the edit it is");
    }
  } finally {
    await a.close();
    await b.close();
    w.host.close();
  }
});

test("a real version after a withdraw shows normally, live, after a reload, and in the change event's flag", async () => {
  const { w, a, b, sb, cut, id, seen } = await withdrawnOnShared();
  let b2: Carton | undefined;
  try {
    const wseq = (await b.head()).ref.seq;
    assert.equal((await b.commit({ ops: [set("b", "name", "After")], wait: 5000 })).status, "confirmed");
    await until(async () => (await a.head()).ref.seq === wseq + 1, 5000, "bob's later edit at alice's");
    for (const c of [a, b]) {
      const log = await c.log();
      assert.deepEqual(log.map((v) => v.ref.seq), [wseq + 1, wseq - 1, 0], "the later version, then the one before the gap");
      assert.equal(log[0]!.author?.id, "bob");
      assert.equal(log[0]!.kind, "edit");
      assert.equal(item(await c.checkout(log[0]!.ref), "b")!.name, "After");
    }
    // each handle's change events: bob's edit, the withdraw row (flagged, so a listener can leave it out), bob's later edit
    for (const who of ["alice", "bob"])
      assert.deepEqual(seen.filter((e) => e.who === who).map((e) => [e.seq, e.id === id, e.withdrawn]), [[wseq - 1, false, false], [wseq, true, true], [wseq + 1, false, false]], who);
    // a handle opened on Bob's store loads the withdraw row from storage and leaves it out too
    await b.close();
    b2 = await Carton.open({ adapter, store: sb, actor: bob });
    const rows = (await sb.range<ConfirmedChange>("changes", { prefix: [cut] })).map((r) => r.value);
    assert.ok(rows.some((r) => r.id === id && r.withdrawn), "still stored");
    assert.deepEqual((await b2.log({ cut })).map((v) => v.ref.seq), [wseq + 1, wseq - 1, 0]);
    // paging across the gap: the page below the later version starts under the gap
    assert.deepEqual((await b2.log({ cut, before: wseq + 1, limit: 1 })).map((v) => v.ref.seq), [wseq - 1]);
  } finally {
    await a.close();
    await b.close();
    await b2?.close();
    w.host.close();
  }
});
