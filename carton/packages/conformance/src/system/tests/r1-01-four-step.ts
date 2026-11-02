// R1-01: the four-step scenario (two replicas plus the server). Port of system-v11 `test/r1-01-four-step.test.mjs`.
// 1. M1 commits Alice's GUI edit E1 while offline: it is pending, and timeline.tsx shows it under a pin ref.
// 2. Bob's B1 reaches the server first (seq 1). E1 is confirmed after it (a), rejected by the server and rebased (b),
//    or (c) M1 was offline and rebases E1 locally when it reconnects.
// 3. M1's agent read the file when it showed E1 and not B1, and saves its edit after M1 has learned both.
// 4. The merge uses the pinned state as base: E1 kept, B1 kept, agent edit applied, nothing re-attributed/reverted.
import test from "node:test";
import assert from "node:assert/strict";
import { doc, clips } from "../sim/world.ts";
import { Agent } from "../sim/agent.ts";
import { TIMELINE, parse } from "../sim/replica.ts";
import { A, world, until, runFor, blame, it, assertConverged, report, ENGINE } from "../helpers.ts";

async function scenario({ overlap, offline = false }: { overlap: boolean; offline?: boolean }) {
  const w = world({ seed: overlap ? 11 : offline ? 13 : 10 });
  // M1's link is slow (one way 1 s), so E1 is still in flight when Bob's B1 lands; or M1 is offline (variant c)
  const m1 = w.replica({ name: "m1-alice", link: w.net.link({ rtt: offline ? 100 : 2000 }) });
  const m2 = w.replica({ name: "m2-bob", link: w.net.link({ rtt: 100 }) });
  const b = w.shared(doc({ items: clips(5) }), [m1, m2]);
  await m1.startApp();
  await m2.startApp();
  await runFor(w, 3000);

  if (offline) m1.link.down();
  // E1 (Alice, M1) and B1 (Bob, M2) are made at the same moment; B1 reaches the server first
  if (overlap) {
    // E1 trims c1's end, B1 trims c1's start: different fields of one clip's time group, so they overlap through the
    // group path (§6.1) and meet in merge3, where trim-in ∘ trim-out composes
    m1.worker!.gui!.edit((d) => { const c = A.item(d, "c1")!; c.endTime = 9.5; c.trimEnd = 4.5; }, [["timelineItems/c1/endTime", 9.5], ["timelineItems/c1/trimEnd", 4.5]]);
    m2.worker!.gui!.edit((d) => { const c = A.item(d, "c1")!; c.startTime = 5.5; c.trimStart = 0.5; }, [["timelineItems/c1/startTime", 5.5], ["timelineItems/c1/trimStart", 0.5]]);
  } else {
    m1.worker!.gui!.edit((d) => { A.item(d, "c1")!.opacity = 0.5; }, [["timelineItems/c1/opacity", 0.5]]);
    m2.worker!.gui!.edit((d) => { A.item(d, "c2")!.name = "Bob's cut"; }, [["timelineItems/c2/name", "Bob's cut"]]);
  }
  await runFor(w, 400);
  assert.equal(w.server.rows(b).length, 1, "B1 is seq 1 on the server");

  // 3. the agent reads the file: it shows E1 (pending) and not B1
  const agent = new Agent(m1, { name: "director/chat1/turn1", hooked: true, actor: { window: m1.worker!.window, turn: "turn1" } });
  const read = await until(w, agent.read(TIMELINE));
  assert.ok(A.item(read.doc, "c2")!.name === "c2" && A.item(read.doc, "c1")!.startTime === 5, "the file doesn't show B1");
  assert.equal(A.snapshot(read.doc), A.snapshot(m1.store.optimistic(b).doc), "the agent sees M1's optimistic state (E1, no B1)");
  assert.equal(m1.store.pending(b).length, 1, "E1 is pending");
  const e1 = m1.worker!.gui!.saves[0]!.id;
  if (offline) m1.link.restore();
  await runFor(w, 6000); // M1 learns B1; E1 is confirmed (a), rejected then rebased and confirmed (b), or pushed on reconnect (c)
  const rowsNow = w.server.rows(b).map((r) => r.id);
  assert.deepEqual(rowsNow.slice(1), [e1], "E1 confirmed after B1");
  if (overlap) assert.ok(w.server.stats.rejects >= 1, "variant b: E1 was rejected and rebased");
  else assert.equal(w.server.stats.rejects, 0);

  // the agent edits c3 in the file it read, long after M1's log moved on
  await until(w, agent.editUntilDone(TIMELINE, (d) => { const c = A.item(d, "c3")!; c.endTime = 19; c.trimEnd = 4; }));
  await runFor(w, 5000);
  agent.stop();
  await runFor(w, 65000);

  const rows = w.server.rows(b);
  const final = A.applyOps(w.server.branches.get(b)!.doc0!, rows.flatMap((r) => r.ops));
  const agentRow = rows.find((r) => r.author.id === agent.actor.id);
  return { w, b, m1, m2, final, rows, agentRow, agent, e1, header: read.ref, fileDoc: read.doc };
}

export function register(): void {
  for (const [label, opts] of [["a: E1 confirmed after B1", { overlap: false }], ["b: E1 rejected by the server and rebased", { overlap: true }], ["c: M1 offline, E1 rebased on reconnect", { overlap: false, offline: true }]] as const) {
    const overlap = opts.overlap;
    test(`R1-01 four-step scenario, ${label} [${ENGINE}]`, async (t) => {
      const { w, b, m1, m2, final, rows, agentRow, agent, e1 } = await scenario(opts);
      assertConverged(w, b, [m1, m2]);
      assert.equal(rows.length, 3, "B1, E1, the agent's change: three rows");
      assert.ok(agentRow, "the agent's change is confirmed");
      const touched = new Set(agentRow.ops.map((o) => A.pathKey(o.path.slice(0, 2))));
      assert.deepEqual([...touched], ["timelineItems/c3"], "the agent's change touches only the clip it edited");
      if (overlap) {
        assert.deepEqual([it(final, "c1")!.endTime, it(final, "c1")!.trimEnd], [9.5, 4.5], "E1 kept");
        assert.deepEqual([it(final, "c1")!.startTime, it(final, "c1")!.trimStart], [5.5, 0.5], "B1 kept (composed with E1)");
        assert.equal(blame(m1, ["timelineItems", "c1", "endTime"])!.id, e1, "E1 attributed to Alice");
        assert.equal((blame(m1, ["timelineItems", "c1", "startTime"]) as { author: { id: string } }).author.id, "human:m2-bob", "B1 attributed to Bob");
      } else {
        assert.equal(it(final, "c1")!.opacity, 0.5, "E1 kept");
        assert.equal(it(final, "c2")!.name, "Bob's cut", "B1 kept, not reverted");
        assert.equal(blame(m1, ["timelineItems", "c1", "opacity"])!.id, e1, "E1 attributed to Alice, not the agent");
        assert.equal((blame(m1, ["timelineItems", "c2", "name"]) as { author: { id: string } }).author.id, "human:m2-bob");
      }
      assert.deepEqual([it(final, "c3")!.endTime, it(final, "c3")!.trimEnd], [19, 4], "agent edit applied");
      assert.equal((blame(m1, ["timelineItems", "c3", "endTime"]) as { author: { id: string } }).author.id, agent.actor.id);
      report(t, { engine: ENGINE, serverRejects: w.server.stats.rejects, rows: rows.map((r) => `${r.seq}:${r.author.id}`) });
    });
  }

  test(`R1-01 control: with the global main@1 as base (a leaked local seq), B1 is reverted [${ENGINE}]`, async () => {
    const { w, b, fileDoc } = await scenario({ overlap: false });
    const rows = w.server.rows(b);
    const doc0 = w.server.branches.get(b)!.doc0!;
    const global1 = A.applyOps(doc0, rows[0]!.ops); // B1 without E1: what "main@1" names in the global log
    const headBefore = A.applyOps(global1, rows[1]!.ops); // B1 + E1
    const agentFile = A.clone(fileDoc);
    const c = A.item(agentFile, "c3")!;
    c.endTime = 19;
    c.trimEnd = 4;
    const wrong = A.merge3(global1, headBefore, agentFile);
    assert.equal(it(wrong.doc, "c2")!.name, "c2", "with the wrong base, B1 is silently reverted");
    assert.equal(wrong.conflicts.length, 0, "and no card says so");
    const ops = A.diff(headBefore, wrong.doc);
    assert.ok(ops.some((o) => A.pathKey(o.path) === "timelineItems/c2/name"), "the revert would be committed as the agent's edit");
  });

  test(`§5.2 expired ref: a save whose only pin was released fails loudly ("re-print"), never a 2-way merge [${ENGINE}]`, async () => {
    const w = world({ seed: 12 });
    const m1 = w.replica({ name: "m1" });
    const m2 = w.replica({ name: "m2-bob" });
    const b = w.shared(doc({ items: clips(3) }), [m1, m2]);
    await m1.startApp();
    await m2.startApp();
    // a hooked reader freezes the shared file at S0, so no other owner pins the state the agent prints next
    const reader = new Agent(m1, { name: "director/c/t8", hooked: true, actor: { window: m1.worker!.window, turn: "t8" } });
    await until(w, reader.read(TIMELINE));
    m2.worker!.gui!.edit((d) => { d.timelineItems![2]!.name = "remote"; }, [["timelineItems/c2/name", "remote"]]);
    await runFor(w, 2000);
    const agent = new Agent(m1, { name: "director/c/t9", hooked: true, actor: { window: m1.worker!.window, turn: "t9" } });
    const pr = await until(w, agent.cb({ kind: "printView" }));
    const view = await until(w, agent.read(pr.path));
    assert.notEqual(view.ref, parse(m1.fs.read(TIMELINE)!.content).ref, "the view's state is not the one the shared file pins");
    agent.stop(); // turn ends: its pins are released, and nobody else pins that state
    const before = w.server.rows(b).length;
    await until(w, agent.editUntilDone(pr.path, (d) => { d.timelineItems![0]!.name = "late"; }));
    await runFor(w, 2000);
    const status = JSON.parse(m1.fs.read(pr.path.replace(".tsx", ".status"))!.content);
    assert.equal(status.status, "error");
    assert.match(status.error, /state unknown: re-print/);
    assert.equal(w.server.rows(b).length, before, "nothing applied");
    assert.equal(A.item(m1.store.optimistic(b).doc, "c0")!.name, "c0");
  });
}
