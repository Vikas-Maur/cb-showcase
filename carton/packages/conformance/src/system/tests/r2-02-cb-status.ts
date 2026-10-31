// R2-02: `cb` statuses (confirmed@seq / pending offline / conflicts), late-conflict notices delivered at the start of
// the actor's next call, and the Stop hook blocking at most once per conflict set. Port of system-v11
// `test/r2-02-cb-status.test.mjs`.
import test from "node:test";
import assert from "node:assert/strict";
import type { Op } from "@carton/core";
import { doc, clips, set } from "../sim/world.ts";
import { Agent } from "../sim/agent.ts";
import { TIMELINE, render, type Replica, type SimEvent } from "../sim/replica.ts";
import { A, world, until, runFor, assertConverged, report, ENGINE } from "../helpers.ts";

const remote = (r: Replica, ops: Op[]) =>
  r.worker!.proc.engine.post(() => {
    const id = `${r.worker!.proc.rid}.${++r.worker!.proc.n}`;
    r.store.commit(r.b, { id, author: r.newActor({ kind: "human", id: `human:${r.name}`, name: r.name }), ops, at: r.sim.now });
  });
const trimOut = (id: string, end: number, trimEnd: number) => [set(id, "endTime", end), set(id, "trimEnd", trimEnd)];

async function lateConflict({ hooked, seed }: { hooked: boolean; seed: number }) {
  const w = world({ seed });
  const m1 = w.replica({ name: "m1", link: w.net.link({ rtt: 150 }) });
  const m2 = w.replica({ name: "m2-bob", link: w.net.link({ rtt: 100 }) });
  const b = w.shared(doc({ items: clips(8) }), [m1, m2]);
  await m1.startApp();
  await m2.startApp({ gui: false, materialize: false });
  const agent = hooked
    ? new Agent(m1, { name: "director/c2/t1", hooked: true, actor: { window: m1.worker!.window, turn: "t1" } })
    : new Agent(m1, { name: "codex (terminal)", hooked: false });
  m1.link.down();
  const r = await until(w, agent.cb({ kind: "ops", write: true, ops: trimOut("c5", 29.4, 4.4) }));
  assert.equal(r.status, "pending");
  remote(m2, trimOut("c5", 29, 4)); // Bob trims the same edge on the server meanwhile
  await runFor(w, 2000);
  m1.link.restore();
  await runFor(w, 5000); // reconnect: the agent's pending change is rebased and gets a card
  return { w, b, m1, m2, agent, id: r.id as string };
}

export function register(): void {
  test(`R2-02 cb statuses: confirmed@seq online, pending offline, conflicts when the merge has cards [${ENGINE}]`, async (t) => {
    const w = world({ seed: 70 });
    const m1 = w.replica({ name: "m1", link: w.net.link({ rtt: 150 }) });
    const m2 = w.replica({ name: "m2-bob", link: w.net.link({ rtt: 100 }) });
    const b = w.shared(doc({ items: clips(8) }), [m1, m2]);
    await m1.startApp();
    await m2.startApp({ gui: false, materialize: false });
    const agent = new Agent(m1, { name: "director/c1/t1", hooked: true, actor: { window: m1.worker!.window, turn: "t1" } });

    const r1 = await until(w, agent.cb({ kind: "ops", write: true, ops: [set("c1", "name", "online")] }));
    assert.equal(r1.status, "confirmed");
    assert.equal(w.server.rows(b).find((r) => r.id === r1.id)!.seq, r1.seq, "confirmed@seq is the server's seq");

    m1.link.down();
    const r2 = await until(w, agent.cb({ kind: "ops", write: true, ops: [set("c2", "opacity", 0.4)] }));
    assert.equal(r2.status, "pending", "offline: pending");
    assert.equal(r2.online, false);
    m1.link.restore();
    await runFor(w, 3000);

    // conflicts: the agent prints, Bob trims c3's end, the agent applies a different trim of the same edge
    const pr = await until(w, agent.cb({ kind: "print" }));
    const seen = await until(w, agent.read(TIMELINE));
    remote(m2, trimOut("c3", 19, 4));
    await runFor(w, 1000);
    const mine = A.clone(seen.doc);
    Object.assign(mine.timelineItems!.find((i) => i.id === "c3")!, { endTime: 18.5, trimEnd: 3.5 });
    Object.assign(mine.timelineItems!.find((i) => i.id === "c4")!, { name: "kept" });
    const r3 = await until(w, agent.cb({ kind: "apply", write: true, content: render(pr.ref, "agent", mine) }));
    assert.equal(r3.status, "conflicts");
    assert.ok(r3.conflicts.some((c: { path: string }) => c.path === "timelineItems/c3/#time"), "the card names c3's time group (core-v5 decides it as one unit)");
    await runFor(w, 3000);
    const head = m1.store.optimistic(b).doc;
    assert.equal(A.item(head, "c4")!.name, "kept", "the non-conflicting part of the apply landed");
    assert.equal(A.item(head, "c3")!.endTime, 19, "the clashing value stays at head until someone chooses (provisional)");
    agent.stop();
    agent.stop();
    await runFor(w, 70000);
    assertConverged(w, b, [m1, m2]);
    report(t, { statuses: [r1.status, r2.status, r3.status] });
  });

  test(`R2-02 late conflict: a notice at the start of the actor's next cb call [${ENGINE}]`, async (t) => {
    const { w, b, m1, m2, agent, id } = await lateConflict({ hooked: false, seed: 71 });
    assert.ok(m1.cards.some((c) => c.changeId === id && c.late), "the rebase raised a card");
    const next = await until(w, agent.cb({ kind: "status" }));
    assert.equal(next.notices.length, 1, "the late conflict comes back on the next call");
    assert.equal(next.notices[0].changeId, id);
    assert.ok(next.notices[0].cards.some((c: { path: string }) => c.path.startsWith("timelineItems/c5/")));
    const again = await until(w, agent.cb({ kind: "status" }));
    assert.equal(again.notices.length, 0, "delivered once");
    assertConverged(w, b, [m1, m2]);
    report(t, { notice: next.notices[0].text });
  });

  test(`R2-02 Stop hook: blocks once with the conflict text, then lets the agent stop; the rest becomes a human card [${ENGINE}]`, async (t) => {
    const { m1, agent, id } = await lateConflict({ hooked: true, seed: 72 });
    const s1 = agent.stop();
    assert.equal(s1.decision, "block");
    assert.match(s1.reason!, new RegExp(id.replace(".", "\\.")));
    const s2 = agent.stop(); // stop_hook_active: the agent couldn't resolve it
    assert.equal(s2.decision, "allow");
    assert.equal(s2.handedToHuman, 1);
    const s3 = agent.stop();
    assert.equal(s3.decision, "allow");
    assert.ok(m1.cards.some((c) => c.changeId === id && c.handedToHuman), "unresolved conflict handed to the human as a card");
    report(t, { decisions: [s1.decision, s2.decision, s3.decision] });
  });

  // Verification 4, M3: a local rebase can card a version the server never confirms. Here m1's opacity edit (lww) is in
  // flight when m2's opacity edit on the same clip lands; m1's local rebase cards it, but the server accepts m1's
  // in-flight version under lww. No late card, no notice: the log applied m1's value, and m2's author gets the toast.
  test(`M3: a card from a local rebase of a version the server never confirmed is dropped (lww overwrite accepted in flight) [${ENGINE}]`, async (t) => {
    const w = world({ seed: 73 });
    const m1 = w.replica({ name: "m1", link: w.net.link({ rtt: 1000 }) });
    const m2 = w.replica({ name: "m2-bob", link: w.net.link({ rtt: 100 }) });
    const b = w.shared(doc({ items: clips(4) }), [m1, m2]);
    await m1.startApp({ gui: false, materialize: false });
    await m2.startApp({ gui: false, materialize: false });
    await runFor(w, 3000);
    const toasts: SimEvent[] = [];
    m2.listeners.push((e) => {
      if (e.type === "overwritten") toasts.push(e);
    });
    const agent = new Agent(m1, { name: "agent", hooked: false });
    const call = agent.cb({ kind: "ops", write: true, policy: "lww", ops: [set("c1", "opacity", 0.3)] });
    await runFor(w, 200);
    remote(m2, [set("c1", "opacity", 0.8)]);
    const r = await until(w, call);
    await runFor(w, 5000);
    const id = r.id as string;
    const p = m1.store.versions.get(id)!;
    const row = w.server.rows(b).find((x) => x.id === id)!;
    assert.ok(p.length >= 2 && p[1]!.cards?.length >= 1, "m1's local rebase did card a newer version");
    assert.equal(row.rebase, 0, "the server confirmed the in-flight version 0");
    assert.equal(A.item(m1.store.optimistic(b).doc, "c1")!.opacity, 0.3, "the log applied m1's value (lww)");
    assert.equal(m1.cards.filter((c) => c.late).length, 0, "no late card");
    assert.equal((await until(w, agent.cb({ kind: "status" }))).notices.length, 0, "no notice");
    assert.equal(r.status, "confirmed");
    assert.ok(toasts.length >= 1, "the overwritten author is told (toast)");
    assertConverged(w, b, [m1, m2]);
    report(t, { status: r.status, versions: p.length, confirmedVersion: row.rebase, toasts: toasts.length });
  });
}
