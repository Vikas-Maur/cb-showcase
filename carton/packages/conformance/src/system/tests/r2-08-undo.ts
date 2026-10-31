// R2-08 (C10): an external `cb` (a terminal agent, no window) then ⌘Z in the app reverts it; a teammate's change is
// never reverted by ⌘Z. Port of system-v11 `test/r2-08-undo.test.mjs`.
import test from "node:test";
import assert from "node:assert/strict";
import { doc, clips, set } from "../sim/world.ts";
import { Agent } from "../sim/agent.ts";
import { A, world, until, runFor, assertConverged, report, ENGINE } from "../helpers.ts";

const find = (d: A.SimDoc, id: string) => d.timelineItems!.find((i) => i.id === id)!;

export function register(): void {
  test(`R2-08 external cb then ⌘Z reverts it; the teammate's later change survives every ⌘Z [${ENGINE}]`, async (t) => {
    const w = world({ seed: 100 });
    const m1 = w.replica({ name: "m1-alice", link: w.net.link({ rtt: 100 }) });
    const m2 = w.replica({ name: "m2-bob", link: w.net.link({ rtt: 100 }) });
    const b = w.shared(doc({ items: clips(5) }), [m1, m2]);
    await m1.startApp();
    await m2.startApp();
    const gui = m1.worker!.gui!;
    gui.edit((d) => { find(d, "c2").opacity = 0.4; }, [["timelineItems/c2/opacity", 0.4]]);
    await runFor(w, 1000);
    const cc = new Agent(m1, { name: "claude-code (terminal)", hooked: false });
    const r = await until(w, cc.cb({ kind: "ops", write: true, ops: [set("c1", "name", "by Claude Code")] }));
    assert.equal(r.status, "confirmed");
    await runFor(w, 500);
    m2.worker!.gui!.edit((d) => { find(d, "c3").name = "by Bob"; }, [["timelineItems/c3/name", "by Bob"]]);
    await runFor(w, 2000);
    assert.ok(gui.undo.every((e) => e.actor !== "human:m2-bob"), "the teammate's change is not in the undo stack");

    const z1 = gui.cmdZ()!;
    assert.equal(z1.reverted, r.id, "⌘Z reverts the terminal agent's cb change");
    assert.match(z1.label, /claude-code \(terminal\)/);
    await runFor(w, 2000);
    let head = m1.store.optimistic(b).doc;
    assert.equal(A.item(head, "c1")!.name, "c1");
    assert.equal(A.item(head, "c3")!.name, "by Bob", "Bob's later change kept");
    assert.equal(A.item(head, "c2")!.opacity, 0.4, "Alice's own edit untouched");

    const z2 = gui.cmdZ()!;
    assert.equal(z2.reverted, gui.saves[0]!.id, "the next ⌘Z reverts Alice's own edit");
    await runFor(w, 2000);
    head = m1.store.optimistic(b).doc;
    assert.equal(A.item(head, "c2")!.opacity, 1);
    assert.equal(A.item(head, "c3")!.name, "by Bob");

    const z3 = gui.cmdZ();
    assert.equal(z3, null, "nothing left: Bob's change is never Alice's to undo");
    await runFor(w, 2000);
    assert.equal(A.item(m2.store.optimistic(b).doc, "c3")!.name, "by Bob");
    assertConverged(w, b, [m1, m2]);
    report(t, { undone: [z1.label, z2.label] });
  });
}
