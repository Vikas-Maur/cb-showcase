// R3-01: worker and `cb` both online, a pending ripple (a recorded remap intent), a forced reject, both try to push:
// the ripple applies exactly once. Port of system-v11 `test/r3-01-ripple-once.test.mjs`.
import test from "node:test";
import assert from "node:assert/strict";
import { sync } from "@carton/core";
import { doc, clip } from "../sim/world.ts";
import { Agent } from "../sim/agent.ts";
import { Proc } from "../sim/kernel.ts";
import type { SimSync } from "../sim/replica.ts";
import { A, world, until, runFor, it, assertConverged, countId, serverDoc, report, ENGINE } from "../helpers.ts";

// V1: a [0,10], gap [10,15], c [15,25], d [25,35]. The agent closes the gap: ripple at 15 by -5.
// Bob inserts h at [40,45] meanwhile, so the ripple's push (span [10, ∞)) is rejected and rebased.
async function scenario({ rogue }: { rogue: boolean }) {
  const w = world({ seed: rogue ? 21 : 20 });
  const m1 = w.replica({ name: "m1", link: w.net.link({ rtt: 2000 }) });
  const m2 = w.replica({ name: "m2-bob", link: w.net.link({ rtt: 100 }) });
  const b = w.shared(doc({ items: [clip("a", 0, 10), clip("c", 15, 25), clip("d", 25, 35)] }), [m1, m2]);
  await m1.startApp();
  await m2.startApp();
  const workerNonce = m1.store.lease!.nonce;
  let rogueClient: SimSync | null = null;
  if (rogue) {
    // Adversarial: a second process on M1 pushes the same queue as if it also held the lease (the bug the lease is
    // there to prevent). It wakes on every new pending change, like the worker. Stable ids must still make the
    // ripple land once.
    const p = new Proc(w, "cb", "m1/cb-rogue");
    const rc = m1.syncClient({ proc: p }, workerNonce);
    rogueClient = rc;
    m1.store.on((ev) => {
      if (ev.type === "pending") p.engine.post(() => rc.pump());
    });
  }
  await runFor(w, 4000);
  const agent = new Agent(m1, { name: "claude-code (terminal)", hooked: false });
  const call = agent.cb({ kind: "ripple", write: true, track: "V1", at: 15, delta: -5 });
  m2.worker!.gui!.edit((d) => {
    d.timelineItems!.push({ id: "h", trackId: "V1", type: "video", name: "h", startTime: 40, endTime: 45, trimStart: 0, trimEnd: 5, opacity: 1 });
  }, [["timelineItems/h", "insert"]]);
  await runFor(w, 600);
  const R = m1.store.pending(b)[0]?.id;
  assert.ok(R && m1.store.pending(b)[0]!.versions[0]!.intent?.maps?.V1, "the ripple is pending with its recorded intent");

  // a second `cb` call while the ripple is pending: it must find the worker's live lease and not push itself
  const second = agent.cb({ kind: "status" });
  const res1 = await until(w, call);
  const res2 = await until(w, second);
  await runFor(w, 20000);
  return { w, b, m1, m2, R: R!, res1, res2, workerNonce, rogueClient };
}

export function register(): void {
  test(`R3-01 ripple-once: forced reject, the worker rebases and resubmits; cb never pushes; applied exactly once [${ENGINE}]`, async (t) => {
    const { w, b, m1, m2, R, res2, workerNonce } = await scenario({ rogue: false });
    assert.ok(w.server.stats.rejects >= 1, "the ripple's first push was rejected");
    assert.equal(m1.helpers.length, 0, "no cb process became a pusher (no helper started)");
    assert.equal(m1.store.lease!.nonce, workerNonce, "the worker kept the lease");
    assert.equal(res2.online, true);
    assert.equal(countId(w, b, R), 1, "the ripple's id is confirmed exactly once");
    const f = serverDoc(w, b);
    assert.deepEqual(["a", "c", "d", "h"].map((x) => [it(f, x)!.startTime, it(f, x)!.endTime]), [[0, 10], [10, 20], [20, 30], [35, 40]], "shifted once; h mapped through the ripple once");
    assertConverged(w, b, [m1, m2]);
    const pushesOfR = m1.worker!.sync!.log.filter((e) => e.kind === "push" && e.ids!.includes(R)).length;
    report(t, { serverRejects: w.server.stats.rejects, pushesOfRByWorker: pushesOfR, duplicates: w.server.stats.duplicates });
  });

  test(`R3-01 ripple-once, adversarial: two pushers on one replica push the same ripple; still exactly once [${ENGINE}]`, async (t) => {
    const { w, b, m1, m2, R, rogueClient } = await scenario({ rogue: true });
    const byWorker = m1.worker!.sync!.log.filter((e) => e.kind === "push" && e.ids!.includes(R)).length;
    const byRogue = rogueClient!.log.filter((e) => e.kind === "push" && e.ids!.includes(R)).length;
    assert.ok(byWorker >= 1 && byRogue >= 1, "both processes pushed the ripple");
    assert.ok(w.server.stats.duplicates >= 1, "the second copy reached the server and was acked as a duplicate");
    assert.equal(countId(w, b, R), 1, "the server confirmed it once (duplicate id acked with the existing seq)");
    const f = serverDoc(w, b);
    assert.deepEqual(["c", "d", "h"].map((x) => it(f, x)!.startTime), [10, 20, 35], "shifted once");
    assertConverged(w, b, [m1, m2]);
    report(t, { pushesByWorker: byWorker, pushesByRogue: byRogue, serverDuplicates: w.server.stats.duplicates, serverRejects: w.server.stats.rejects });
  });

  // On core-proto a second copy of the ripple under a new id shifted everything twice (archive/v9-core-proto). core-v5's
  // remap transform counts identical deletions once, so the engine itself is a second line of defence. Hand-computed
  // rebase of the original copy over the confirmed head, with every confirmed row (R included) as concurrent.
  // (The prototype called its adapter's `rebase`; here a fresh ReplicaQueue holds the copy as its one pending change
  // and integrates every confirmed row, which runs the queue's own rebase with those rows as the concurrent side.)
  test(`R3-01 engine check: a second copy of the ripple under a new id, rebased over the confirmed head, shifts once on core-v5 [${ENGINE}]`, async () => {
    const { w, b, m1, R } = await scenario({ rogue: false });
    const rows = w.server.rows(b);
    const doc0 = w.server.branches.get(b)!.doc0!;
    const original = m1.store.versions.get(R)![0]!; // the copy the second pusher would hold
    const q = new sync.ReplicaQueue(A.S);
    q.addBranch({ id: b, name: "main", kind: "main", sequencer: { kind: "server", since: 0 } }, doc0);
    q.commit(b, { id: "copy.1", author: { kind: "agent", id: "copy" }, ops: original.ops, intent: original.intent, kinds: original.kinds, at: 0 });
    q.integrate(b, rows);
    const copy = { doc: q.optimistic(b).doc, ops: sync.last(q.pending(b)[0]!.versions).ops };
    assert.equal(it(copy.doc, "h")!.startTime, 35, "h stays at 35: not shifted a second time");
    assert.equal(it(copy.doc, "d")!.startTime, 20, "d stays at 20");
    assert.equal(copy.ops.length, 0, "the copy adds nothing");
  });
}
