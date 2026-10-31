// Not a critique id: a property run over the network faults the model offers. Three replicas (GUI humans, a remote
// bot, `cb` agents, a helper on the replica whose app is closed), lossy links (a lost message breaks the connection),
// random outages, jitter. After healing: every replica converges to the server's log, no change id is confirmed
// twice, and every change anyone committed is confirmed (nothing lost, nothing left pending). A client catches up
// (hello) before it pushes again, so a lost ack is resolved by the catch-up and never by a duplicate push; the
// duplicate-ack path is exercised by R3-01 (adversarial), R4-04 (late push) and R5-06 (fencing off).
// Port of system-v11 `test/chaos.test.mjs`.
import test from "node:test";
import assert from "node:assert/strict";
import { doc, clips, set } from "../sim/world.ts";
import { Agent } from "../sim/agent.ts";
import { world, until, runFor, botWriter, assertConverged, report, ENGINE } from "../helpers.ts";

async function chaos(seed: number) {
  const w = world({ seed });
  const L = () => w.net.link({ rtt: 80 + Math.floor(w.sim.rand() * 300), jitter: 40, loss: 0.01 });
  const a = w.replica({ name: "a", link: L() }), b2 = w.replica({ name: "b", link: L() }), c = w.replica({ name: "c-headless", link: L() });
  const b = w.shared(doc({ items: clips(20) }), [a, b2, c]);
  await a.startApp();
  await b2.startApp({ gui: false, materialize: false });
  const T = 4 * 60e3;
  botWriter(b2, { rate: 1, untilT: T });
  const human = () => {
    if (w.sim.now > T) return;
    const k = Math.floor(w.sim.rand() * 20), v = Math.round(w.sim.rand() * 100) / 100;
    a.worker!.gui!.edit((d) => {
      d.timelineItems![k]!.opacity = v;
    }, [[`timelineItems/${d0id(k)}/opacity`, v]]);
    w.sim.after(w.sim.exp(3000), human);
  };
  const d0id = (k: number) => `c${k}`;
  w.sim.after(500, human);
  // outages: each link goes down for 0.5–8 s now and then
  for (const r of [a, b2, c]) {
    const outage = () => {
      if (w.sim.now > T) return;
      r.link.down();
      w.sim.after(w.sim.uni(500, 8000), () => r.link.restore());
      w.sim.after(w.sim.exp(30000), outage);
    };
    w.sim.after(w.sim.exp(30000), outage);
  }
  // agents: one in A's terminal (via the worker), one on C (app closed: through a helper)
  const agents = [new Agent(a, { name: "agent-a", hooked: false }), new Agent(c, { name: "agent-c", hooked: false })];
  const ids: string[] = [];
  const loops = agents.map(async (ag, j) => {
    for (let k = 0; w.sim.now < T; k++) {
      await w.sim.sleep(w.sim.uni(2000, 15000));
      const r = await ag.cb({ kind: "ops", write: true, ops: [set(`c${(k * 7 + j) % 20}`, "name", `${ag.name}-${k}`)] });
      if (r.id) ids.push(r.id);
    }
  });
  await until(w, Promise.all(loops), T + 120e3);
  for (const r of [a, b2, c]) r.link.restore();
  await runFor(w, 60e3);
  // the headless replica's helper may have exited idle with nothing pending; make sure every replica is caught up
  await until(w, agents[1]!.cb({ kind: "status" }));
  await runFor(w, 10e3);
  return { w, b, reps: [a, b2, c], ids };
}

export function register(): void {
  test(`Chaos: loss 1% (a lost message breaks the connection), outages, jitter: lost acks happen and resolve; converged, exactly once, nothing lost [${ENGINE}]`, async (t) => {
    const out: Record<string, unknown>[] = [];
    let lostAcks = 0;
    for (const seed of [201, 202, 203]) {
      const { w, b, reps, ids } = await chaos(seed);
      assertConverged(w, b, reps);
      const logIds = new Set(w.server.rows(b).map((r) => r.id));
      for (const id of ids) assert.ok(logIds.has(id), `cb change ${id} confirmed`);
      const absorbed = new Set(reps[0]!.absorbed.map((a) => a.id));
      // a GUI save whose merge left no ops (head already held its values) commits nothing
      for (const s of reps[0]!.worker!.gui!.saves) if (s.ops.length) assert.ok(logIds.has(s.id) || absorbed.has(s.id), "GUI save confirmed, or absorbed (nothing left to push)");
      lostAcks += w.server.stats.lostAcks;
      out.push({
        seed,
        rows: logIds.size,
        absorbed: reps.map((r) => r.absorbed.length),
        lostAcks: w.server.stats.lostAcks,
        rejects: w.server.stats.rejects,
        duplicates: w.server.stats.duplicates,
        reconnects: reps.map((r) => (r.worker?.syncs ?? []).concat(r.helpers.flatMap((h) => (h.sync ? [h.sync] : []))).reduce((s, x) => s + (x?.stats.reconnects ?? 0), 0)),
        takeovers: reps[2]!.stats.takeovers,
      });
    }
    assert.ok(lostAcks > 0, "the server confirmed changes whose acks never arrived (resolved by catch-up on reconnect)");
    report(t, out);
  });
}
