// The holes the system verifier found in system-v11 (verify/RESULTS.md §3, H1–H4), closed in PLAN v13/v14, as
// system-level tests on the real code. The scenarios are the verifier's own probes (verify/probe-client.mjs §1 and §4,
// verify/probe-trackmove.mjs), with the assertions the plan now requires. H3 (nested forks) is a server-level case:
// server/test/sequencer.test.ts "H3: nested forks…".
import test from "node:test";
import assert from "node:assert/strict";
import { doc, clips, set } from "../sim/world.ts";
import { Agent } from "../sim/agent.ts";
import type { Replica } from "../sim/replica.ts";
import type { World } from "../sim/world.ts";
import { A, world, until, runFor, serverDoc, assertConverged, report, ENGINE } from "../helpers.ts";

function commitOn(w: World, b: string, r: Replica, ops: ReturnType<typeof set>[], policy: "merge" | "lww" = "merge") {
  r.worker!.proc.engine.post(() => r.store.commit(b, { id: r.worker!.proc.nextId(), author: { kind: "human", id: `human:${r.name}` }, ops, policy, at: w.sim.now }));
}

// H1: an agent's opacity edit goes through helper H1, which dies after sending its push; the push reaches the server
// late (a stalled retransmit). Meanwhile Bob sets the opacity. The next `cb` call's helper takes over, rebases the
// change onto Bob's row (a card keeps head's value: nothing left to push) and withdraws it. Whatever order the late
// push and the withdraw reach the server in, the cards and the notice never contradict the log.
async function deadHelper({ policy, bobValue, lateMs, seed }: { policy: "lww" | "merge"; bobValue: number; lateMs: number; seed: number }) {
  const w = world({ seed });
  const m1 = w.replica({ name: "m1", link: w.net.link({ rtt: 200 }) });
  const m2 = w.replica({ name: "bob", link: w.net.link({ rtt: 50 }) });
  const b = w.shared(doc({ items: clips(4) }), [m1, m2]);
  await m2.startApp({ gui: false, materialize: false });
  const agent = new Agent(m1, { name: "agent", hooked: false });
  await until(w, agent.cb({ kind: "status" })); // H1 up and caught up
  let used = false;
  m1.link.delayHook = (msg) => (!used && msg.type === "push" && msg.changes.some((c) => c.author.id === agent.actor.id) ? ((used = true), lateMs) : 0);
  const call = agent.cb({ kind: "ops", write: true, policy, ops: [set("c1", "opacity", 0.3)] }, { retryOnReset: false });
  await w.sim.runUntil(() => !!m1.helpers[0]?.sync?.log.some((e) => e.kind === "push"), 10000);
  const h1 = m1.helpers[0]!;
  const C = h1.sync!.log.find((e) => e.kind === "push")!.ids![0]!;
  h1.proc.kill(); // its push is on the wire: it reaches the server `lateMs` later
  commitOn(w, b, m2, [set("c1", "opacity", bobValue)], "lww");
  await until(w, call);
  await runFor(w, 300);
  await until(w, agent.cb({ kind: "status" })); // takeover: the taker rebases C onto Bob's row
  await runFor(w, Math.max(10000, lateMs + 4000));
  const st = await until(w, agent.cb({ kind: "status" }));
  await runFor(w, 2000);
  const rows = w.server.rows(b).filter((r) => r.id === C);
  return {
    w, b, m1, m2, C,
    confirmed: rows.filter((r) => !(r as { withdrawn?: boolean }).withdrawn).length,
    withdrawRows: rows.filter((r) => (r as { withdrawn?: boolean }).withdrawn).length,
    absorbed: m1.absorbed.filter((a) => a.id === C),
    cards: m1.cards.filter((c) => c.changeId === C).flatMap((c) => c.cards),
    notices: st.notices as { changeId?: string }[],
    final: A.item(serverDoc(w, b), "c1")!.opacity as number,
  };
}

export function register(): void {
  for (const [label, o] of [
    ["lww, Bob sets another value, the late push arrives after the withdraw", { policy: "lww", bobValue: 0.9, lateMs: 6000, seed: 300 }],
    ["lww, Bob sets the same value", { policy: "lww", bobValue: 0.3, lateMs: 6000, seed: 301 }],
    ["merge, Bob sets another value", { policy: "merge", bobValue: 0.9, lateMs: 6000, seed: 302 }],
  ] as const) {
    test(`H1: a dead helper's late push of an absorbed change is acked as withdrawn, never confirmed (${label}) [${ENGINE}]`, async (t) => {
      const r = await deadHelper(o);
      assert.equal(r.confirmed, 0, "the late copy was never confirmed");
      assert.equal(r.withdrawRows, 1, "the taker spent the id with one withdraw row");
      assert.equal(r.absorbed.length, 1, "absorbed once, after the server confirmed the withdraw");
      assert.ok(r.absorbed[0]!.withdrawn);
      assert.equal(r.final, o.bobValue, "the log holds Bob's value");
      for (const c of r.cards) assert.notEqual(c.ours, 0.3, "no card claims the agent's value is in the log");
      assert.equal(w(r).server.stats.lww, 0, "no lww overwrite happened: the late copy never overwrote Bob's value");
      assertConverged(r.w, r.b, [r.m1, r.m2]);
      report(t, { C: r.C, withdrawRows: r.withdrawRows, cards: r.cards.length, final: r.final });
    });
  }
  const w = (r: { w: World }) => r.w;

  test(`H1 race, the other order: the dead helper's push is confirmed before the taker withdraws; the taker keeps it as confirmed, with no card [${ENGINE}]`, async (t) => {
    const r = await deadHelper({ policy: "lww", bobValue: 0.9, lateMs: 150, seed: 303 });
    assert.equal(r.confirmed, 1, "confirmed once");
    assert.equal(r.withdrawRows, 0, "no withdraw row: the id was already confirmed");
    assert.equal(r.cards.length, 0, "no card: the confirmed version is the one the agent made");
    assertConverged(r.w, r.b, [r.m1, r.m2]);
    report(t, { final: r.final, absorbed: r.absorbed.length });
  });

  // H2: the GUI asks for lww on a save with no time-group field and no insert or remove. A clip dragged to another
  // track at the same time, or a track reorder, is structure: committed as merge, and it lands (the prototype's GUI
  // sent lww and dropped both as cards on every such save).
  for (const [name, mutate, touched] of [
    ["c1 dragged to T2 at the same time", (d: A.SimDoc) => { A.item(d, "c1")!.trackId = "T2"; }, [["timelineItems/c1/trackId", "T2"]]],
    ["T2 dragged above V1", (d: A.SimDoc) => { d.tracks!.find((t) => t.id === "T2")!["#pos"] = "VWlnC"; }, [["tracks/T2/#pos", "VWlnC"]]],
  ] as const) {
    test(`H2: a GUI ${name.startsWith("T2") ? "track reorder" : "same-time track move"} is committed as merge and lands, never refused as lww (${name}) [${ENGINE}]`, async (t) => {
      const w = world({ seed: name.startsWith("T2") ? 332 : 330 });
      const m1 = w.replica({ name: "m1", link: w.net.link({ rtt: 100 }) });
      const b = w.shared(doc({ tracks: ["V1", "T2"], items: clips(4) }), [m1]);
      await m1.startApp({ materialize: false });
      await runFor(w, 1000);
      m1.worker!.gui!.edit(mutate, touched as unknown as [string, unknown][]);
      await runFor(w, 3000);
      const d = serverDoc(w, b);
      assert.equal(w.server.stats.rejectReasons["lww on structure"] ?? 0, 0, "never refused as lww");
      assert.deepEqual(w.server.rows(b).map((r) => r.policy), ["merge"], "one row, committed as merge");
      if (name.startsWith("T2")) assert.equal(d.tracks!.find((t) => t.id === "T2")!["#pos"], "VWlnC", "the reorder landed");
      else assert.equal(A.item(d, "c1")!.trackId, "T2", "the move landed");
      assert.equal(m1.cards.length, 0, "no card");
      report(t, { rows: w.server.rows(b).length });
    });
  }

  test(`H2: a client that still sends lww on structure is refused "lww on structure", resubmits as merge, and the edit lands [${ENGINE}]`, async (t) => {
    const w = world({ seed: 333 });
    const m1 = w.replica({ name: "m1", link: w.net.link({ rtt: 100 }) });
    const b = w.shared(doc({ tracks: ["V1", "T2"], items: clips(4) }), [m1]);
    await m1.startApp({ gui: false, materialize: false });
    await runFor(w, 1000);
    let forced = 0;
    m1.worker!.sync!.tamper = (ch) => (forced++ === 0 ? { ...ch, policy: "lww" } : ch); // an old client's first send
    commitOn(w, b, m1, [set("c1", "endTime", 9), set("c1", "trimEnd", 4)]);
    await runFor(w, 3000);
    assert.equal(w.server.stats.rejectReasons["lww on structure"], 1, "refused once");
    assert.equal(A.item(serverDoc(w, b), "c1")!.endTime, 9, "then resubmitted as merge and confirmed");
    assert.deepEqual(w.server.rows(b).map((r) => r.policy), ["merge"]);
    assert.equal(m1.cards.length, 0, "not dropped as a card");
    report(t, { rejectReasons: w.server.stats.rejectReasons });
  });

  // H4: a timing edit or a remove of a clip that was just moved to another track (or removed) by someone else carries
  // its span on the track the clip had in its base. It is rejected for overlap and rebased, never dropped as
  // "span missing" (the prototype dropped three of these four).
  for (const edit of ["trim", "remove"] as const)
    for (const first of ["move", "edit"] as const) {
      test(`H4: ${edit} concurrent with a track move, ${first === "move" ? "the move" : "the " + edit} confirmed first: rejected for overlap and rebased, never "span missing" [${ENGINE}]`, async (t) => {
        const w = world({ seed: 340 });
        const mover = w.replica({ name: "mover", link: w.net.link({ rtt: first === "move" ? 50 : 400 }) });
        const editor = w.replica({ name: "editor", link: w.net.link({ rtt: first === "move" ? 400 : 50 }) });
        const b = w.shared(doc({ tracks: ["V1", "T2"], items: clips(4) }), [mover, editor]);
        await mover.startApp({ gui: false, materialize: false });
        await editor.startApp({ gui: false, materialize: false });
        await runFor(w, 1000);
        commitOn(w, b, mover, [set("c1", "trackId", "T2")]);
        commitOn(w, b, editor, edit === "trim" ? [set("c1", "endTime", 9.5), set("c1", "trimEnd", 4.5)] : [{ op: "remove", path: ["timelineItems", "c1"] } as never]);
        await runFor(w, 8000);
        const d = serverDoc(w, b), c1 = A.item(d, "c1");
        assert.equal(w.server.stats.rejectReasons["span missing"] ?? 0, 0, "never span missing");
        assert.ok((w.server.stats.rejectReasons.overlap ?? 0) >= 1, "the second push was rejected for overlap");
        if (edit === "trim") assert.deepEqual([c1?.trackId, c1?.endTime, c1?.trimEnd], ["T2", 9.5, 4.5], "both edits: c1 moved and trimmed");
        // a remove against a concurrent track move is delete-versus-modify: the remove holds, or the clash is a card
        // (never lost silently either way)
        else assert.ok(c1 === undefined || [mover, editor].some((r) => r.cards.some((c) => c.cards.some((x) => x.path.startsWith("timelineItems/c1")))), "the remove holds, or a card keeps both");
        assert.ok(![mover, editor].some((r) => r.cards.some((c) => c.rejected)), "nothing dropped as a rejected card");
        assertConverged(w, b, [mover, editor]);
        report(t, { rejectReasons: w.server.stats.rejectReasons, rows: w.server.rows(b).length, cards: [mover, editor].map((r) => r.cards.length) });
      });
    }
}
