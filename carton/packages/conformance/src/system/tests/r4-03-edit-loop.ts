// R4-03: Edit loops under live sync (3 remote writers at 1 change/s each).
// - A hooked agent on its per-agent view: every Edit succeeds (Takes never rewrites the view).
// - An unhooked agent on the shared timeline.tsx: every edit lands; refusals ("modified since read") and retries are
//   counted. Two agent rhythms: re-read before each edit, or edit straight from the last read/write.
// Port of system-v11 `test/r4-03-edit-loop.test.mjs`.
import test from "node:test";
import assert from "node:assert/strict";
import { doc, clips } from "../sim/world.ts";
import { Agent } from "../sim/agent.ts";
import { TIMELINE, type Replica } from "../sim/replica.ts";
import { A, world, until, runFor, botWriter, assertConverged, report, ENGINE } from "../helpers.ts";

const N = 20;
async function scenario({ mode, seed, rereadEachStep = false }: { mode: "view" | "shared"; seed: number; rereadEachStep?: boolean }) {
  const w = world({ seed });
  const m1 = w.replica({ name: "m1", link: w.net.link({ rtt: 100 }) });
  const remotes = [1, 2, 3].map((i) => w.replica({ name: `remote${i}`, link: w.net.link({ rtt: 100 }) }));
  const b = w.shared(doc({ items: clips(40) }), [m1, ...remotes]);
  await m1.startApp({ gui: false });
  for (const r of remotes) await r.startApp({ gui: false, materialize: false });
  const stopAt = 40 * 60e3;
  for (const r of remotes) botWriter(r, { rate: 1, untilT: stopAt }); // timing and opacity edits on all 40 clips
  const agent = mode === "view"
    ? new Agent(m1, { name: "director/c/t1", hooked: true, actor: { window: m1.worker!.window, turn: "t1" } })
    : new Agent(m1, { name: "claude-code (terminal)", hooked: false });
  let path = TIMELINE;
  if (mode === "view") path = (await until(w, agent.cb({ kind: "printView" }))).path;
  await until(w, agent.read(path));
  const firstTry: boolean[] = [];
  const loop = (async () => {
    for (let k = 0; k < N; k++) {
      await w.sim.sleep(w.sim.uni(5000, 60000)); // LLM time between edits
      if (rereadEachStep) { await agent.read(path); await w.sim.sleep(w.sim.uni(2000, 8000)); }
      const before = agent.stats.refusals;
      await agent.editUntilDone(path, (d) => { d.timelineItems!.find((i) => i.id === `c${k}`)!.name = `agent-${k}`; });
      firstTry.push(agent.stats.refusals === before);
    }
  })();
  await until(w, loop);
  const loopEnd = w.sim.now;
  await runFor(w, 5000);
  if (mode === "view") agent.stop();
  await runFor(w, Math.max(0, stopAt - w.sim.now) + 70000);
  return { w, b, m1, remotes, agent, firstTry, loopEnd };
}

function landed(m1: Replica, b: string) {
  const head = m1.store.optimistic(b).doc;
  return Array.from({ length: N }, (_, k) => A.item(head, `c${k}`)!.name === `agent-${k}`);
}

export function register(): void {
  test(`R4-03 hooked agent, per-agent view, 3 remote writers at 1/s: every Edit succeeds first time and lands [${ENGINE}]`, async (t) => {
    const { w, b, m1, remotes, agent, firstTry } = await scenario({ mode: "view", seed: 110 });
    assert.equal(agent.stats.refusals, 0, "no Edit refused");
    assert.ok(firstTry.every(Boolean));
    assert.ok(landed(m1, b).every(Boolean), "all edits landed");
    assertConverged(w, b, [m1, ...remotes]);
    // v14 (H1): the row count includes withdraw rows (seed 110: 5 bot changes absorbed after they were sent), so this
    // reports 7025 where the prototype, which absorbed silently, reported 7020
    report(t, { edits: N, refusals: agent.stats.refusals, remoteChanges: w.server.branches.get(b)!.rows.length - N });
  });

  for (const reread of [false, true]) {
    test(`R4-03 unhooked agent on the shared timeline.tsx (${reread ? "re-reads before each edit" : "edits from its last read/write"}): every edit lands; refusals counted [${ENGINE}]`, async (t) => {
      const { w, b, m1, remotes, agent, firstTry } = await scenario({ mode: "shared", seed: reread ? 112 : 111, rereadEachStep: reread });
      assert.ok(landed(m1, b).every(Boolean), "all edits landed");
      const mz = m1.worker!.materializer!;
      assert.equal(mz.superseded.length, 0);
      assertConverged(w, b, [m1, ...remotes]);
      const byCause: Record<string, number> = {};
      for (const r of mz.rewrites) byCause[r.cause] = (byCause[r.cause] ?? 0) + 1;
      report(t, { edits: N, firstTrySuccesses: firstTry.filter(Boolean).length, refusals: agent.stats.refusals, retries: agent.stats.retries, sharedFileRewrites: byCause });
    });
  }
}
