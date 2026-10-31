// P9 in the test suite (port of system-v11 `test/p9-contention.test.mjs`): S2 per keying (deterministic), and the
// contention acceptance on seeds 1..20 pooled (the full tables, 30 seeds plus a second seed set and sensitivity rows,
// come from `carton/bench/p9/run.ts`). Acceptance: v3 spans p99 ≤ 1.5 × per-item p99, bounded retries, S2 forced
// through merge3 under v3 (and missed by per-item paths, which is why per-item isn't the plan).
import test from "node:test";
import assert from "node:assert/strict";
import type { Keying } from "../rule-variants.ts";
import { runOnce, s2, pct, type P9Run } from "../p9.ts";
import { report, ENGINE } from "../helpers.ts";

export function register(): void {
  for (const keying of ["v3-spans", "v2-layout", "per-item", "v3-spans-v10"] as const) {
    test(`P9/S2 ${keying}: a ripple at 5 s against an append at 15 s, both arrival orders [${ENGINE}]`, async (t) => {
      for (const first of ["ripple", "append"] as const) {
        const r = await s2({ keying, first });
        if (keying === "per-item") {
          assert.equal(r.forcedThroughMerge3, false, "per-item paths miss S2");
          assert.equal(r.gap, 5, "the append is left 5 s after i3");
        } else {
          assert.equal(r.forcedThroughMerge3, true, "forced through merge3");
          assert.deepEqual(r.i4, [10, 15], "the append follows the ripple: right after i3");
        }
        report(t, r);
      }
    });
  }

  // v11's span rule (spans conflict only when one change is structural; the time group is a path) meets the target at
  // both RTTs. v10's rule (every intersecting span conflicts) misses it at RTT 300 on whole-clip spans; it is kept as
  // the comparison, asserted as measured, so a change that moves either outcome fails here.
  for (const rtt of [300, 50]) {
    test(`P9 single track, RTT ${rtt}, seeds 1..20 pooled: v3 spans (v11) meet the 1.5 × per-item target${rtt === 300 ? "; v10's rule misses it" : ""}; bounded retries, exactly once [${ENGINE}]`, async (t) => {
      const res: Record<string, { p99: number; slowerThan1Rtt: number; seedsWithP99Over1_5xRtt: number; maxRejectsOneChange: number; rejectRate: number; absorbed: number; withdrawn: number }> = {};
      for (const keying of ["v3-spans", "per-item", "v2-layout", "v3-spans-v10"] as Keying[]) {
        const runs: P9Run[] = [];
        for (let seed = 1; seed <= 20; seed++) runs.push(await runOnce({ keying, rtt, seed }));
        for (const r of runs) {
          assert.ok(r.converged, "replicas converged");
          assert.equal(r.duplicateIdsInLog, 0, "no id twice");
          assert.equal(r.pending, 0);
          assert.equal(r.confirmed + r.absorbed, r.edits, "every edit confirmed, or absorbed (its rebase left nothing to push)");
        }
        const all = runs.flatMap((r) => r.lat).sort((x, y) => x - y);
        res[keying] = {
          p99: pct(all, 0.99),
          slowerThan1Rtt: all.filter((x) => x > rtt * 1.05).length / all.length,
          seedsWithP99Over1_5xRtt: runs.filter((r) => r.p99 > 1.5 * rtt).length,
          maxRejectsOneChange: Math.max(...runs.map((r) => r.maxRejectsOneChange)),
          rejectRate: runs.reduce((s, r) => s + r.rejects, 0) / runs.reduce((s, r) => s + r.pushes, 0),
          absorbed: runs.reduce((s, r) => s + r.absorbed, 0),
          withdrawn: runs.reduce((s, r) => s + r.withdrawn, 0),
        };
      }
      const pi = res["per-item"]!.p99;
      assert.ok(res["v3-spans"]!.p99 <= 1.5 * pi, `v11: v3 p99 ${res["v3-spans"]!.p99} vs per-item ${pi}`);
      assert.ok(res["v3-spans"]!.maxRejectsOneChange <= 3, "no starvation");
      if (rtt === 300) assert.ok(res["v3-spans-v10"]!.p99 > 1.5 * pi, "v10's rule misses here (the comparison)");
      assert.ok(res["v2-layout"]!.p99 > 1.5 * pi, "control: v2's per-track key fails the same bar");
      report(t, res);
    });
  }
}
