// R4-04: the detached helper's lifecycle. Port of system-v11 `test/r4-04-helper.test.mjs`.
// - killed in the middle of a push: the next `cb` call takes over in under 1 s of virtual time, and the change is
//   pushed exactly once (stable id);
// - the app starting while the helper holds the lease: handover (finish the in-flight push, release, exit), no
//   waiting for the helper's 60 s idle timeout.
import test from "node:test";
import assert from "node:assert/strict";
import { doc, clips, set } from "../sim/world.ts";
import { Agent } from "../sim/agent.ts";
import type { Helper, SimEvent } from "../sim/replica.ts";
import { world, until, runFor, assertConverged, countId, report, ENGINE } from "../helpers.ts";

interface KillOpts {
  when: "after-send" | "before-send";
  retryOnReset?: boolean;
  hang?: number;
  latePushMs?: number;
  seed: number;
}
async function killMidPush({ when, retryOnReset = false, hang = 0, latePushMs = 0, seed }: KillOpts) {
  const w = world({ seed });
  const m1 = w.replica({ name: "m1", link: w.net.link({ rtt: 200 }) });
  const b = w.shared(doc({ items: clips(4) }), [m1]);
  const agent = new Agent(m1, { name: "claude-code (terminal)", hooked: false });
  if (latePushMs) {
    // the dying helper's push sits in a stalled retransmit and reaches the server late
    let used = false;
    m1.link.delayHook = (msg) => (!used && msg.type === "push" && msg.changes.some((c) => c.author.id === agent.actor.id) ? ((used = true), latePushMs) : 0);
  }
  const call = agent.cb({ kind: "ops", write: true, ops: [set("c1", "name", "edited")] }, { retryOnReset });
  let C: string | null = null, h1: Helper | undefined;
  // stop H1 at the chosen moment: right after its push of C is sent, or before it is ever sent
  await w.sim.runUntil(() => {
    h1 = m1.helpers[0];
    C = m1.store.pending(b)[0]?.id ?? C;
    if (!h1 || !C) return false;
    const c = C;
    return when === "after-send" ? h1.sync!.log.some((e) => e.kind === "push" && e.ids!.includes(c)) : true;
  }, 30000);
  if (hang) h1!.proc.engine.stall(hang);
  else h1!.proc.kill();
  const killedAt = w.sim.now;
  let first: Record<string, any>, next: Record<string, any> | null = null, nextStart: number | null = null;
  if (hang) {
    // the next call arrives while the helper is still hung; the first call is still waiting on it
    await runFor(w, 200);
    nextStart = w.sim.now;
    [first, next] = await until(w, Promise.all([call, agent.cb({ kind: "status" })]));
  } else {
    first = await until(w, call);
    if (!retryOnReset) {
      await runFor(w, 2000);
      nextStart = w.sim.now;
      next = await until(w, agent.cb({ kind: "status" }));
    }
  }
  await runFor(w, 10000);
  const take = m1.events.find((e) => e.type === "takeover");
  return { w, b, m1, C: C!, killedAt, first, next, nextStart, take };
}

export function register(): void {
  for (const [label, opts] of [
    ["killed right after its push was sent", { when: "after-send", seed: 40 }],
    ["killed before its push was sent", { when: "before-send", seed: 41 }],
    ["hung for 3 s (alive, not answering), then wakes", { when: "after-send", hang: 3000, seed: 42 }],
    ["killed after sending a push that reaches the server only after the taker's", { when: "after-send", latePushMs: 3000, seed: 45 }],
  ] as [string, KillOpts][]) {
    test(`R4-04 helper ${label}: the next cb takes over in < 1 s, the change is pushed exactly once [${ENGINE}]`, async (t) => {
      const { w, b, m1, C, first, nextStart, take } = await killMidPush(opts);
      const h1 = m1.helpers[0]!;
      if (!opts.hang) assert.equal(first.status, "error", "the interrupted call saw the helper die");
      assert.ok(take, "a takeover happened");
      assert.ok(take.t! >= nextStart!, "it was the next cb call that took over");
      const ms = take.t! - nextStart!;
      assert.ok(ms < 1000, `takeover took ${ms} ms of virtual time`);
      assert.equal(countId(w, b, C), 1, "C confirmed exactly once");
      if (opts.latePushMs) assert.ok(w.server.stats.duplicates >= 1, "both copies reached the server; the late one was acked as a duplicate");
      if (opts.hang) {
        assert.match(h1.sync!.stopReason ?? "", /^fenced/, "the hung helper woke, saw the nonce had changed, and stopped");
        assert.deepEqual(h1.sync!.log.filter((e) => e.t > take.t!), [], "it pushed and rebased nothing after the takeover");
      }
      assert.equal(m1.store.pending(b).length, 0);
      assertConverged(w, b, [m1]);
      const pushesOfC = m1.helpers.flatMap((h) => (h.sync?.log ?? []).filter((e) => e.kind === "push" && e.ids!.includes(C))).length;
      report(t, { takeoverMsFromNextCall: Math.round(ms * 10) / 10, pushesOfCByHelpers: pushesOfC, serverDuplicates: w.server.stats.duplicates, serverPushesEvaluated: w.server.stats.pushes });
    });
  }

  test(`R4-04 the interrupted call itself retries with the same id: one change, confirmed once [${ENGINE}]`, async () => {
    const { w, b, C, first } = await killMidPush({ when: "after-send", retryOnReset: true, seed: 43 });
    assert.equal(first.status, "confirmed");
    assert.equal(first.id, C, "same stable id");
    assert.equal(countId(w, b, C), 1);
    assert.equal(w.server.rows(b).length, 1, "no second change");
  });

  test(`R4-04 app start while the helper holds the lease: handover, no wait for the 60 s idle timeout [${ENGINE}]`, async (t) => {
    const w = world({ seed: 44 });
    const m1 = w.replica({ name: "m1", link: w.net.link({ rtt: 1000 }) });
    const b = w.shared(doc({ items: clips(4) }), [m1]);
    const agent = new Agent(m1, { name: "claude-code (terminal)", hooked: false });
    await until(w, agent.cb({ kind: "ops", write: true, ops: [set("c0", "name", "first")] }));
    const h1 = m1.helpers[0]!;
    // a second change; the app starts while its push is in flight
    const call = agent.cb({ kind: "ops", write: true, ops: [set("c1", "name", "second")] });
    let C2: string | undefined;
    await w.sim.runUntil(() => {
      C2 = m1.store.pending(b)[0]?.id;
      const c = C2;
      return !!c && h1.sync!.log.some((e) => e.kind === "push" && e.ids!.includes(c));
    }, 30000);
    const appStart = w.sim.now;
    await until(w, m1.startApp());
    const leaseAt = w.sim.now;
    m1.worker!.gui!.edit((d) => {
      d.timelineItems!.find((i) => i.id === "c2")!.opacity = 0.5;
    }, [["timelineItems/c2/opacity", 0.5]]);
    const editAt = w.sim.now;
    await until(w, call);
    await runFor(w, 5000);
    const exit = m1.events.find((e) => e.type === "helper-exit");
    assert.equal(exit?.why, "handover", "the helper left on handover, not on its idle timeout");
    assert.ok(leaseAt - appStart < 2000, `worker had the lease ${leaseAt - appStart} ms after app start`);
    const lastHelperPush = Math.max(...h1.sync!.log.filter((e) => e.kind === "push").map((e) => e.t));
    assert.ok(lastHelperPush <= leaseAt, "the helper pushed nothing after the worker took the lease (one pusher at a time)");
    assert.equal(countId(w, b, C2!), 1, "the in-flight change landed once");
    const guiId = m1.worker!.gui!.saves[0]!.id;
    const conf: SimEvent | undefined = m1.events.find((e) => e.type === "confirmed" && e.id === guiId);
    // RTT is 1 s here: the worker's new connection (1 RTT), hello (1 RTT) and the push (1 RTT), plus the 300 ms debounce
    assert.ok(conf && conf.t! - editAt <= 4 * 1000 + 300, `the GUI edit was confirmed ${conf && conf.t! - editAt} ms after it was made`);
    assertConverged(w, b, [m1]);
    report(t, { leaseMsAfterAppStart: leaseAt - appStart, guiEditConfirmedMs: conf!.t! - editAt, idleTimeoutMs: 60000 });
  });
}
