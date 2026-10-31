// R5-04: after each apply of a per-agent view, Takes writes `.scratch/views/<name>.status`
// {status: confirmed|pending|conflicts, ref, conflicts, diagnostics}. View names are distinct: hooked agents use
// their actor id, unhooked callers get a fresh random name printed back. Port of system-v11 `test/r5-04-status.test.mjs`.
import test from "node:test";
import assert from "node:assert/strict";
import type { Op } from "@carton/core";
import { doc, clips, set } from "../sim/world.ts";
import { Agent } from "../sim/agent.ts";
import { statusPath, type Replica } from "../sim/replica.ts";
import { A, world, until, runFor, assertConverged, report, ENGINE } from "../helpers.ts";

const remote = (r: Replica, ops: Op[]) => r.worker!.proc.engine.post(() => {
  const id = r.worker!.proc.nextId();
  r.store.commit(r.b, { id, author: r.newActor({ kind: "human", id: `human:${r.name}`, name: r.name }), ops, at: r.sim.now });
});
const find = (d: A.SimDoc, id: string) => d.timelineItems!.find((i) => i.id === id)!;

export function register(): void {
  test(`R5-04 the agent reads its status after each save: confirmed, pending (offline), conflicts, diagnostics, late conflicts [${ENGINE}]`, async (t) => {
    const w = world({ seed: 120 });
    const m1 = w.replica({ name: "m1", link: w.net.link({ rtt: 150 }) });
    const m2 = w.replica({ name: "m2-bob", link: w.net.link({ rtt: 100 }) });
    const b = w.shared(doc({ items: clips(8) }), [m1, m2]);
    await m1.startApp({ gui: false });
    await m2.startApp({ gui: false, materialize: false });
    const agent = new Agent(m1, { name: "director/c/t1", hooked: true, actor: { window: m1.worker!.window, turn: "t1" } });
    const { name, path } = await until(w, agent.cb({ kind: "printView" }));
    assert.equal(name, "director_c_t1", "a hooked agent's view is named after its actor id");
    await until(w, agent.read(path));
    const readStatus = async () => { await w.sim.sleep(2000); return JSON.parse(m1.fs.read(statusPath(name))!.content); }; // read without touching the view
    const save = (fn: (d: A.SimDoc) => void) => until(w, agent.editUntilDone(path, fn));
    const seen: string[] = [];

    await save((d) => { find(d, "c1").name = "s1"; });
    let s = await until(w, readStatus());
    assert.equal(s.status, "confirmed");
    assert.equal(s.seq, w.server.branches.get(b)!.rows.at(-1)!.seq);
    assert.match(s.ref, /^main@\d+$/);
    seen.push(s.status);

    m1.link.down();
    await save((d) => { find(d, "c2").name = "s2"; });
    s = await until(w, readStatus());
    assert.equal(s.status, "pending", "offline: pending");
    seen.push(s.status);
    m1.link.restore();
    await runFor(w, 3000);
    s = JSON.parse(m1.fs.read(statusPath(name))!.content);
    assert.equal(s.status, "confirmed", "the sidecar follows the change once the server confirms it");

    remote(m2, [set("c3", "endTime", 19), set("c3", "trimEnd", 4)]); // Bob trims c3; the agent's view still shows 20
    await runFor(w, 1000);
    await save((d) => { Object.assign(find(d, "c3"), { endTime: 18.5, trimEnd: 3.5 }); });
    s = await until(w, readStatus());
    assert.equal(s.status, "conflicts");
    assert.ok(s.conflicts.some((c: { path: string }) => c.path === "timelineItems/c3/#time"), "c3's time group is carded");
    seen.push(s.status);

    await save((d) => { Object.assign(find(d, "c4"), { endTime: 19 }); }); // c4 is 20..25: ends before it starts
    s = await until(w, readStatus());
    assert.ok(s.diagnostics.some((x: string) => /c4 ends at or before it starts/.test(x)), "the hard validator shows up as a diagnostic");
    assert.equal(s.status, "conflicts", "the invalid clip is a card, not committed (core-v5's hard validators in merge3)");
    assert.equal(A.item(m1.store.optimistic(b).doc, "c4")!.endTime, 25, "head keeps the valid clip");

    m1.link.down();
    await save((d) => { Object.assign(find(d, "c5"), { endTime: 29.4, trimEnd: 4.4 }); });
    s = await until(w, readStatus());
    assert.equal(s.status, "pending");
    remote(m2, [set("c5", "endTime", 29), set("c5", "trimEnd", 4)]);
    await runFor(w, 1000);
    m1.link.restore();
    await runFor(w, 4000);
    s = JSON.parse(m1.fs.read(statusPath(name))!.content);
    assert.equal(s.status, "conflicts", "a late conflict flips the sidecar");
    assert.ok(s.conflicts.some((c: { path: string }) => c.path.startsWith("timelineItems/c5/")));
    seen.push("late:" + s.status);
    agent.stop();
    agent.stop();
    await runFor(w, 5000);
    assertConverged(w, b, [m1, m2]);
    report(t, { statusesSeen: seen });
  });

  test(`R5-04 unhooked agents never share a view file [${ENGINE}]`, async (t) => {
    const w = world({ seed: 121 });
    const m1 = w.replica({ name: "m1" });
    const b = w.shared(doc({ items: clips(4) }), [m1]);
    await m1.startApp({ gui: false });
    const a1 = new Agent(m1, { name: "terminal-1", hooked: false });
    const a2 = new Agent(m1, { name: "terminal-2", hooked: false });
    const [p1, p2] = await until(w, Promise.all([a1.cb({ kind: "printView" }), a2.cb({ kind: "printView" })]));
    assert.notEqual(p1.name, p2.name);
    assert.match(p1.name, /^agent-[0-9a-f]{4}$/);
    await until(w, Promise.all([a1.read(p1.path), a2.read(p2.path)]));
    await until(w, Promise.all([
      a1.editUntilDone(p1.path, (d) => { d.timelineItems![0]!.name = "from-1"; }),
      a2.editUntilDone(p2.path, (d) => { d.timelineItems![1]!.name = "from-2"; }),
    ]));
    await runFor(w, 3000);
    assert.equal(a1.stats.refusals + a2.stats.refusals, 0);
    const rows = w.server.branches.get(b)!.rows;
    assert.deepEqual(rows.map((r) => r.author.id).sort(), [`external:${p1.path}`, `external:${p2.path}`].sort(), "each save applied from its own file");
    const names = new Set([p1.name, p2.name]);
    for (let i = 0; i < 300; i++) names.add((await until(w, a1.cb({ kind: "printView" }))).name);
    assert.equal(names.size, 302, "302 prints without a name, 302 distinct views");
    assertConverged(w, b, [m1]);
    report(t, { views: [p1.name, p2.name], distinctOf302: names.size });
  });
}
