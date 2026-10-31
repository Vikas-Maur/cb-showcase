// R3-03: the sequencer handoff (local → handing-off → server). Connection dropped right after adoption (lost ack);
// local commits during the upload; a double upload. Expect one adoption, no seq collision, no duplicate.
// Port of system-v11 `test/r3-03-handoff.test.mjs`.
import test from "node:test";
import assert from "node:assert/strict";
import { doc, clips } from "../sim/world.ts";
import type { Gui, Replica, SimActor, SimEvent } from "../sim/replica.ts";
import { A, world, runFor, assertConverged, countId, report, ENGINE } from "../helpers.ts";

const edit = (gui: Gui, id: string, v: number) =>
  gui.edit((d) => {
    d.timelineItems!.find((i) => i.id === id)!.opacity = v;
  }, [[`timelineItems/${id}/opacity`, v]]);
const handOff = (r: Replica, id: string, n: number) => r.store.setSequencer(id, { kind: "handingOff", n, stateHash: A.hashDoc(r.store.confirmedState(id, n)) });

interface Opts {
  dropAck?: boolean;
  double?: boolean;
  reupload?: boolean;
}
async function scenario({ dropAck, double, reupload }: Opts) {
  const w = world({ seed: 30 + (dropAck ? 1 : 0) + (double ? 2 : 0) });
  const a = w.replica({ name: "alice", link: w.net.link({ rtt: 300 }) });
  const main = w.local(doc({ items: clips(6) }), a);
  await a.startApp();
  for (let i = 0; i < 5; i++) {
    edit(a.worker!.gui!, `c${i}`, 0.1 * (i + 1));
    await runFor(w, 1000);
  }
  assert.equal(a.store.headSeq(main), 5, "5 changes confirmed by the local sequencer");
  // a local variant forked at main@3 with two micro-changes (private)
  const vid = w.uuid();
  a.store.addBranch({ id: vid, name: "variant", kind: "variant", forkOf: { branchId: main, seq: 3 }, sequencer: { kind: "local" }, lineage: [{ seq: 0, kind: "fork" }, { seq: 2, kind: "export" }] }, a.store.confirmedState(main, 3));
  for (let i = 0; i < 2; i++) a.store.commit(vid, { id: `v.${i}`, author: { kind: "human", id: "human:alice" } as SimActor, ops: [{ op: "set", path: ["timelineItems", "c5", "name"], value: `scrap${i}` }], at: w.sim.now });

  const localRows = a.store.rows(main).map((r) => ({ id: r.id, hash: (r as { hash: string }).hash }));
  const events: SimEvent[] = [];
  a.listeners.push((e) => events.push(e));
  // the replica reports a local confirmation as "confirmed"; the store's own event says it was the local sequencer's
  a.storeTaps.push((e) => {
    if (e.type === "local-confirmed" && e.branchId === main) events.push({ type: "local-confirmed", t: w.sim.now, id: e.row.id });
  });
  let dropped = false;
  if (dropAck)
    w.server.hooks.beforeSend = (conn, msg) => {
      if (msg.type === "adopted" && !dropped) {
        dropped = true;
        conn.break("dropped after adoption");
        return false;
      }
      return true;
    };
  // share: local → handing-off
  const shareAt = w.sim.now;
  handOff(a, main, 5);
  a.worker!.startSync();
  if (double) a.worker!.sync!.forceAdoptTwice = true;
  if (reupload) a.worker!.sync!.reuploadOnReconnect = true;
  // commits during the upload
  await runFor(w, 100);
  edit(a.worker!.gui!, "c0", 0.91);
  await runFor(w, 400);
  edit(a.worker!.gui!, "c1", 0.92);
  await runFor(w, 350);
  const midState = a.store.branch(main).sequencer.kind;
  const midHead = a.store.headSeq(main);
  const midPending = a.store.pending(main).length;
  await runFor(w, 20000);
  return { w, a, main, vid, localRows, events, shareAt, midState, midHead, midPending, dropped };
}

export function register(): void {
  for (const [label, opts] of [["lost ack", { dropAck: true }], ["double upload on one connection", { double: true }], ["lost ack, then the upload repeated on the new connection", { dropAck: true, reupload: true }]] as [string, Opts][]) {
    test(`R3-03 handoff, ${label}: one adoption, no seq collision, no duplicate [${ENGINE}]`, async (t) => {
      const { w, a, main, vid, localRows, events, shareAt, midState, midHead, midPending, dropped } = await scenario(opts);
      if (opts.dropAck) assert.ok(dropped, "the adoption's ack was lost");
      assert.equal(midState, "handingOff", "still handing off while unacknowledged: local sequencing never resumed");
      assert.equal(midHead, 5, "no local seq after 5 during the handoff");
      assert.equal(midPending, 2, "commits made during the upload are pending");
      assert.equal(w.server.stats.adopts, 1, "adopted once");
      if (opts.double || opts.reupload) assert.ok(w.server.stats.adoptRepeats >= 1, "the repeated upload got the same answer");
      else assert.equal(w.server.stats.adoptRepeats, 0, "after the lost ack the replica asked branchStatus; it didn't upload again");
      const rows = w.server.rows(main);
      assert.deepEqual(rows.slice(0, 5).map((r) => ({ id: r.id, hash: r.hash })), localRows, "seqs 1..5 adopted verbatim");
      assert.equal(rows.length, 7, "the two pending changes became seqs 6 and 7");
      for (const r of rows.slice(5)) assert.equal(countId(w, main, r.id), 1);
      const sq = a.store.branch(main).sequencer;
      assert.equal(sq.kind, "server");
      assert.equal(sq.kind === "server" ? sq.since : undefined, 5);
      assert.ok(!events.some((e) => e.type === "local-confirmed" && e.t! > shareAt), "nothing confirmed locally after the share started");
      assertConverged(w, main, [a]);
      const tv = w.server.branches.get(vid);
      assert.ok(tv?.tracking, "the variant went up as a read-only tracking branch");
      assert.equal(tv.rows.length, 0, "its micro-changes stayed private (shallow closure)");
      assert.equal(tv.nodes.length, 2, "lineage nodes with their states");
      assert.ok(tv.nodes.every((n) => (n as { state?: A.SimDoc }).state?.timelineItems), "each node carries its state");
      report(t, { adopts: w.server.stats.adopts, adoptRepeats: w.server.stats.adoptRepeats, serverRows: rows.length });
    });
  }

  test(`§5.3 two replicas with diverged local "main" both share: two branches adopted, each with its own log, neither overwritten [${ENGINE}]`, async () => {
    const w = world({ seed: 35 });
    const a = w.replica({ name: "alice" }), b = w.replica({ name: "bob" });
    const d0 = doc({ items: clips(3) });
    const ma = w.local(d0, a), mb = w.local(d0, b);
    await a.startApp();
    await b.startApp();
    edit(a.worker!.gui!, "c0", 0.3);
    edit(b.worker!.gui!, "c1", 0.4);
    await runFor(w, 2000);
    for (const [r, id] of [[a, ma], [b, mb]] as const) {
      handOff(r, id, r.store.headSeq(id));
      r.worker!.startSync();
    }
    await runFor(w, 5000);
    assert.equal(w.server.stats.adopts, 2, "both adopted; the second didn't collide with the first");
    for (const [r, id] of [[a, ma], [b, mb]] as const) {
      assert.equal(w.server.branches.get(id)!.rec.name, "main");
      assert.deepEqual(w.server.rows(id).map((x) => x.id), r.store.rows(id).map((x) => x.id), "each server branch holds exactly its replica's log");
      assert.equal(r.store.branch(id).sequencer.kind, "server");
    }
    // (merging the two through the DAG is core-level and not covered here)
  });
}
