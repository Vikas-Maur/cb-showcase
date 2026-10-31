// R5-05: the 30 s spacing of shared timeline.tsx rewrites applies to remote changes only. A local GUI edit appears
// in the shared file promptly (the 300 ms GUI debounce plus the rewrite) when no freeze is active; rewrites caused
// by remote changes are ≥ 30 s apart. Port of system-v11 `test/r5-05-rewrite-spacing.test.mjs`.
import test from "node:test";
import assert from "node:assert/strict";
import { doc, clips } from "../sim/world.ts";
import { TIMELINE, TAKES, parse } from "../sim/replica.ts";
import { A, world, runFor, botWriter, assertConverged, report, ENGINE } from "../helpers.ts";

export function register(): void {
  test(`R5-05 under remote churn: local GUI edits reach the file in ~300 ms; remote rewrites ≥ 30 s apart [${ENGINE}]`, async (t) => {
    const w = world({ seed: 130 });
    const m1 = w.replica({ name: "m1", link: w.net.link({ rtt: 100 }) });
    const remotes = [1, 2, 3].map((i) => w.replica({ name: `remote${i}`, link: w.net.link({ rtt: 100 }) }));
    const b = w.shared(doc({ items: clips(40) }), [m1, ...remotes]);
    await m1.startApp();
    for (const r of remotes) await r.startApp({ gui: false, materialize: false });
    const writes: { t: number; doc: A.SimDoc }[] = [];
    m1.fs.watchers.push((path, f) => { if (path === TIMELINE && f.writer === TAKES) writes.push({ t: w.sim.now, doc: parse(f.content).doc }); });
    const T = 5 * 60e3;
    for (const r of remotes) botWriter(r, { rate: 1, untilT: T });
    const edits: { t: number; id: string; v: string }[] = [];
    const human = () => {
      if (w.sim.now > T) return;
      const k = Math.floor(w.sim.rand() * 40), v = `gui-${edits.length}`;
      m1.worker!.gui!.edit((d) => { d.timelineItems!.find((i) => i.id === `c${k}`)!.name = v; }, [[`timelineItems/c${k}/name`, v]]);
      edits.push({ t: w.sim.now, id: `c${k}`, v });
      w.sim.after(w.sim.exp(7000), human);
    };
    w.sim.after(2000, human);
    await runFor(w, T + 60e3);

    const fileAt = (id: string, v: unknown, from: number) => writes.find((x) => x.t >= from && A.item(x.doc, id)?.name === v)?.t ?? Infinity;
    // every GUI save reaches the file promptly (no 30 s spacing for local edits)
    const saves = m1.worker!.gui!.saves;
    const saveLat = saves.map((s) => { const [p, v] = [...s.saved][0]!; return fileAt(p.split("/")[1]!, v, s.t) - s.t; });
    assert.ok(saveLat.every((x) => x <= 100), `every GUI save in the file within 100 ms (max ${Math.max(...saveLat)})`);
    // edit → file: the 300 ms GUI debounce plus the rewrite, unless another GUI edit restarted the debounce
    const lat = edits.map((e) => fileAt(e.id, e.v, e.t) - e.t);
    const lone = edits.map((e, i) => !edits[i + 1] || edits[i + 1]!.t - e.t > 300);
    assert.ok(lat.every((x, i) => !lone[i] || x <= 400), `edits with no other edit in their debounce: in the file within 400 ms (max ${Math.max(...lat.filter((_, i) => lone[i]))})`);
    const mz = m1.worker!.materializer!;
    const remoteRw = mz.rewrites.filter((r) => r.cause === "remote").map((r) => r.t);
    const gaps = remoteRw.slice(1).map((x, i) => x - remoteRw[i]!);
    assert.ok(gaps.every((g) => g >= 30000 - 1e-6), `remote rewrites ≥ 30 s apart (min ${Math.min(...gaps)})`);
    assert.ok(!mz.freeze.active && mz.rewrites.every((r) => !r.frozen), "no freeze was active");
    assertConverged(w, b, [m1, ...remotes]);
    const byCause: Record<string, number> = {};
    for (const r of mz.rewrites) byCause[r.cause] = (byCause[r.cause] ?? 0) + 1;
    lat.sort((a, b) => a - b);
    report(t, { guiEdits: edits.length, guiSaves: saves.length, saveToFileMaxMs: Math.max(...saveLat), editToFileMs: { min: lat[0], median: lat[lat.length >> 1], max: lat.at(-1) }, editsSharingADebounce: lone.filter((x) => !x).length, remoteRewrites: remoteRw.length, minRemoteGapMs: Math.min(...gaps), rewritesByCause: byCause, remoteChanges: w.server.branches.get(b)!.rows.length - edits.length });
  });
}
