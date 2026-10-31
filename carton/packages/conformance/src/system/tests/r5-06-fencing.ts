// R5-06: lease fencing. Pings are answered on the engine thread; every push is dequeued inside a transaction that
// re-reads the lease nonce, and a holder whose nonce changed stops. Stall the holder 500 ms during a push so that a
// taker takes over: exactly one push of the change is confirmed, and the stale holder stops pushing and rebasing at
// its next dequeue. Port of system-v11 `test/r5-06-fencing.test.mjs`.
import test from "node:test";
import assert from "node:assert/strict";
import { doc, clips, set } from "../sim/world.ts";
import { Agent } from "../sim/agent.ts";
import type { Helper, Replica } from "../sim/replica.ts";
import { world, until, runFor, assertConverged, countId, botWriter, report, ENGINE } from "../helpers.ts";

async function helperStall({ at, seed, fence = true }: { at: "push" | "dequeue"; seed: number; fence?: boolean }) {
  const w = world({ seed });
  const m1 = w.replica({ name: "m1", link: w.net.link({ rtt: 200 }) });
  m1.fence = fence;
  const m2 = w.replica({ name: "m2-bob", link: w.net.link({ rtt: 100 }) });
  const b = w.shared(doc({ items: clips(8) }), [m1, m2]);
  await m2.startApp({ gui: false, materialize: false });
  botWriter(m2, { rate: 1, untilT: 30000, ids: ["c5", "c6", "c7"] }); // remote changes keep arriving
  const a = new Agent(m1, { name: "agent-a", hooked: false });
  const bAgent = new Agent(m1, { name: "agent-b", hooked: false });
  await until(w, a.cb({ kind: "ops", write: true, ops: [set("c0", "name", "warm-up")] }));
  const h1: Helper = m1.helpers[0]!;
  let C: string | null = null, stalledAt: number | null = null;
  if (at === "dequeue") {
    // stall the holder's engine thread the moment C is queued, before its dequeue runs
    m1.storeTaps.push((ev) => {
      if (ev.type === "pending" && !stalledAt) {
        C = ev.change.id;
        stalledAt = w.sim.now;
        h1.proc.engine.stall(500);
      }
    });
  }
  const call = a.cb({ kind: "ops", write: true, ops: [set("c1", "name", "C")] });
  if (at === "push") {
    await w.sim.runUntil(() => {
      C = m1.store.pending(b).find((p) => p.author.id === "agent-a")?.id ?? null;
      const c = C;
      return !!c && h1.sync!.log.some((e) => e.kind === "push" && e.ids!.includes(c));
    }, 30000);
    stalledAt = w.sim.now;
    h1.proc.engine.stall(500);
  } else await w.sim.runUntil(() => !!stalledAt, 30000);
  // another agent's call lands while the holder is stalled: its ping times out, it takes over
  const call2 = bAgent.cb({ kind: "ops", write: true, ops: [set("c2", "name", "D")] });
  const r1 = await until(w, call), r2 = await until(w, call2);
  await runFor(w, 40000);
  const take = m1.events.find((e) => e.type === "takeover");
  return { w, b, m1, m2, h1, C: C as string | null, stalledAt: stalledAt as number | null, take, r1, r2 };
}

async function workerStall({ pingOn, seed }: { pingOn: "engine" | "main"; seed: number }) {
  const w = world({ seed });
  const m1 = w.replica({ name: "m1", link: w.net.link({ rtt: 200 }) });
  const b = w.shared(doc({ items: clips(4) }), [m1]);
  await m1.startApp({ pingOn });
  m1.worker!.reacquireMs = 2000;
  const nonce0 = m1.store.lease!.nonce;
  m1.worker!.gui!.edit((d) => {
    d.timelineItems!.find((i) => i.id === "c0")!.opacity = 0.3;
  }, [["timelineItems/c0/opacity", 0.3]]);
  let C: string | undefined;
  await w.sim.runUntil(() => {
    C = m1.worker!.gui!.saves[0]?.id;
    const c = C;
    return !!c && m1.worker!.sync!.log.some((e) => e.kind === "push" && e.ids!.includes(c));
  }, 30000);
  const s0 = m1.worker!.sync!;
  const stalledAt = w.sim.now;
  m1.worker!.proc.main.stall(500); // the library worker's main loop chews on a multi-MB project.json
  const agent = new Agent(m1, { name: "agent", hooked: false });
  const r = await until(w, agent.cb({ kind: "ops", write: true, ops: [set("c1", "name", "D")] }));
  await runFor(w, 15000);
  return { w, b, m1, nonce0, C: C!, s0, stalledAt, r };
}

export function register(): void {
  // Note: in the "push" case the outcome (C once, D once) would hold even without fencing, because C was already on
  // the wire; only the stop on the nonce shows fencing there. The "dequeue" case and its fencing-off control below are
  // the ones where fencing changes what happens.
  for (const at of ["push", "dequeue"] as const) {
    test(`R5-06 holder stalled 500 ms ${at === "push" ? "right after sending a push" : "before its dequeue"}: one push wins, the stale holder stops [${ENGINE}]`, async (t) => {
      const { w, b, m1, m2, h1, C, stalledAt, take, r2 } = await helperStall({ at, seed: at === "push" ? 60 : 61 });
      assert.ok(take && take.t! < stalledAt! + 500, "a taker took over during the stall");
      assert.equal(countId(w, b, C!), 1, "C confirmed exactly once");
      const D = r2.id;
      assert.equal(countId(w, b, D), 1, "D (made after the takeover) confirmed exactly once");
      const after = h1.sync!.log.filter((e) => e.t > take.t!);
      assert.deepEqual(after, [], "the stale holder neither pushed nor rebased after the takeover");
      assert.match(h1.sync!.stopReason ?? "", /^fenced/, "it stopped on the nonce check");
      assert.ok(h1.sync!.stoppedAt! >= stalledAt! + 500 - 1e-6, "it noticed at its first transaction after the stall");
      const pushesOfC = [h1, ...m1.helpers.slice(1)].flatMap((h) => h.sync!.log.filter((e) => e.kind === "push" && e.ids!.includes(C!))).length;
      assertConverged(w, b, [m1, m2]);
      report(t, { at, takeoverMsAfterStall: Math.round((take.t! - stalledAt!) * 10) / 10, staleStoppedMsAfterStall: Math.round((h1.sync!.stoppedAt! - stalledAt!) * 10) / 10, pushesOfC, serverDuplicates: w.server.stats.duplicates });
    });
  }

  test(`R5-06 control: the same dequeue stall with fencing off: the stale holder keeps pushing (stable ids still keep C once) [${ENGINE}]`, async (t) => {
    const { w, b, m1, h1, C, take } = await helperStall({ at: "dequeue", seed: 61, fence: false });
    const after = h1.sync!.log.filter((e) => e.t > take!.t!);
    assert.ok(after.some((e) => e.kind === "push"), "without the nonce check the replaced holder pushes after the takeover");
    assert.ok(w.server.stats.duplicates >= 1, "its copies reach the server as duplicates");
    assert.equal(countId(w, b, C!), 1, "the server still confirms C once");
    assertConverged(w, b, [m1, ...w.replicas.filter((r: Replica) => r !== m1)]);
    report(t, { staleEntriesAfterTakeover: after.length, serverDuplicates: w.server.stats.duplicates });
  });

  test(`R5-06 worker main loop stalled 500 ms, pings answered on the engine thread: no false takeover [${ENGINE}]`, async (t) => {
    const { w, b, m1, nonce0, C, r } = await workerStall({ pingOn: "engine", seed: 62 });
    assert.equal(m1.helpers.length, 0, "no helper was started");
    assert.ok(!m1.events.some((e) => e.type === "takeover"));
    assert.equal(m1.store.lease!.nonce, nonce0);
    assert.equal(r.status, "confirmed");
    assert.equal(countId(w, b, C), 1);
    assertConverged(w, b, [m1]);
    report(t, { takeovers: 0 });
  });

  test(`R5-06 control: pings answered on the main loop give a false takeover; fencing still keeps one push [${ENGINE}]`, async (t) => {
    const { w, b, m1, nonce0, C, s0, r } = await workerStall({ pingOn: "main", seed: 63 });
    const take = m1.events.find((e) => e.type === "takeover");
    assert.ok(take, "the busy main loop was mistaken for death");
    assert.match(s0.stopReason ?? "", /^fenced/, "the worker's old sync client stopped on the nonce check");
    assert.deepEqual(s0.log.filter((e) => e.t > take.t!), [], "and did nothing after the takeover");
    assert.equal(countId(w, b, C), 1);
    assert.equal(countId(w, b, r.id), 1);
    assert.notEqual(m1.store.lease!.nonce, nonce0);
    assert.ok(m1.store.lease && m1.worker!.nonce === m1.store.lease.nonce, "the worker took the lease back by handover");
    assertConverged(w, b, [m1]);
    report(t, { falseTakeovers: 1, workerReacquired: true });
  });
}
