// R5-06: lease fencing, on real processes (port of system-v11 test/r5-06-fencing.test.mjs). Pings are answered on the
// engine thread; every push is dequeued after re-reading the lease nonce, and a holder whose nonce changed stops.
// Stall the holder during a push (its thread really blocked) so a second `cb` takes over: exactly one push of the
// change is confirmed, and the stale holder stops pushing at its next dequeue.
//
// The helper stalls are 1500 ms, not the plan's 500 ms: the simulation started a helper in 120 ms of virtual time, but a
// real helper process takes 300-700 ms to start on this shared 4-core box, so a 500 ms stall can end before the taker
// exists, and then the stale holder's next dequeue legitimately happens before the takeover and fencing isn't tested.
// The worker test keeps 500 ms: there no helper should start at all.
import { test } from "node:test";
import assert from "node:assert/strict";
import { World, sleep } from "./support/world.ts";

const ops = (id: string, v: string) => [{ op: "set", path: ["timelineItems", id, "name"], value: v }];
const STALL = 1500;

async function helperStall(name: string, { at, fence = true }: { at: "push" | "dequeue"; fence?: boolean }) {
  const w = new World(name);
  // the control holds D's first push at the server, so D is still queued in carton.db when the stale holder wakes
  // (in the simulation a remote writer kept the queue busy instead)
  await w.server(fence ? [] : ["--hold-first-push-ms", "2500", "--hold-marker", "\"D\""]);
  const warm = await w.cb({ ops: ops("c0", "warm-up"), config: { port: w.port, marker: "\"C\"", fence, ...(at === "push" ? { stallAfterPushMs: STALL } : { stallAfterQueueMs: STALL }) } });
  assert.equal(warm.r.result.status, "confirmed");
  const h1 = w.events().find((e) => e.type === "lease")!.pid;
  const second = w.cbArmed({ ops: ops("c2", "D") });
  await second.ready;
  const call = w.cb({ ops: ops("c1", "C") });
  const ev0 = await w.until((ev) => ev.some((e) => e.type === "stall" && e.pid === h1));
  const stalledAt = ev0.find((e) => e.type === "stall")!.t;
  const C = ev0.filter((e) => e.type === "queued" && e.pid === h1).at(-1)!.id;
  // another agent's call lands while the holder is stalled: its ping times out, it takes over
  second.go();
  const [r1, r2] = await Promise.all([call, second.result]);
  await sleep(fence ? 800 : 2500);
  const ev = w.events();
  const take = ev.find((e) => e.type === "lease" && e.pid !== h1);
  return { w, h1, C, stalledAt, take, r1, r2, ev };
}

for (const at of ["push", "dequeue"] as const) {
  test(`R5-06 holder stalled ${STALL} ms ${at === "push" ? "right after sending a push" : "before its dequeue"}: one push wins, the stale holder stops`, async (t) => {
    const { w, h1, C, stalledAt, take, r2, ev } = await helperStall(`r506-${at}`, { at });
    try {
      assert.ok(take && take.t < stalledAt + STALL, `a taker took over during the stall (${take && take.t - stalledAt} ms in)`);
      const st = await w.stats();
      assert.equal(st.rows.filter((r: any) => r.id === C).length, 1, "C confirmed exactly once");
      assert.equal(st.rows.filter((r: any) => r.id === r2.id).length, 1, "D (made after the takeover) confirmed exactly once");
      const after = ev.filter((e) => e.pid === h1 && e.t > take!.t && (e.type === "push" || e.type === "confirmed"));
      assert.deepEqual(after, [], "the stale holder neither pushed nor confirmed anything after the takeover");
      const stop = ev.find((e) => e.pid === h1 && e.type === "stop");
      assert.match(stop?.why ?? "", /^fenced/, "it stopped on the nonce check");
      assert.ok(stop!.t >= stalledAt + STALL - 5, "it noticed at its first transaction after the stall");
      const pushesOfC = ev.filter((e) => e.type === "push" && e.ids.includes(C)).length;
      t.diagnostic(JSON.stringify({ at, takeoverMsAfterStall: take!.t - stalledAt, staleStoppedMsAfterStall: stop!.t - stalledAt, pushesOfC, serverDuplicates: st.duplicates }));
    } finally {
      await w.close();
    }
  });
}

test("R5-06 control: the same dequeue stall with fencing off: the stale holder keeps pushing (stable ids still keep C once)", async (t) => {
  const { w, h1, C, take, ev, r2 } = await helperStall("r506-control", { at: "dequeue", fence: false });
  try {
    const after = ev.filter((e) => e.pid === h1 && e.t > take!.t && e.type === "push");
    assert.ok(after.length >= 1, "without the nonce check the replaced holder pushes after the takeover");
    const st = await w.stats();
    assert.ok(st.duplicates >= 1, "its copies reach the server as duplicates");
    assert.equal(st.rows.filter((r: any) => r.id === C).length, 1, "the server still confirms C once");
    assert.equal(st.rows.filter((r: any) => r.id === r2.id).length, 1, "and D once");
    t.diagnostic(JSON.stringify({ staleEntriesAfterTakeover: after.length, serverDuplicates: st.duplicates }));
  } finally {
    await w.close();
  }
});

async function workerStall(name: string, engineThread: boolean) {
  const w = new World(name);
  await w.server();
  const worker = await w.worker({ engineThread });
  const nonce0 = worker.ready.nonce;
  worker.send(`commit gui.1 ${JSON.stringify(ops("c0", "gui"))}`);
  await worker.next((x) => x.committed === "gui.1");
  // the library worker's main loop chews on a multi-MB project.json for 500 ms; an agent's cb lands meanwhile
  const agent = w.cbArmed({ ops: ops("c1", "D") });
  await agent.ready;
  worker.send("stall 500");
  await sleep(50);
  agent.go();
  const r = await agent.result;
  const stalled = await worker.next((x) => x.stalled);
  await sleep(engineThread ? 500 : 3500); // the control's worker takes the lease back after 2 s
  worker.send("nonce");
  const now = await worker.next((x) => "nonce" in x && !("ready" in x) && x !== worker.ready);
  return { w, worker, nonce0, r, stalled, now };
}

test("R5-06 worker main loop stalled 500 ms, pings answered on the engine thread: no false takeover", async (t) => {
  const { w, worker, nonce0, r, now } = await workerStall("r506-engine-thread", true);
  try {
    const ev = w.events();
    assert.ok(!ev.some((e) => e.type === "lease" && e.pid !== worker.proc.pid), "no helper took the lease");
    assert.equal(now.nonce, nonce0, "the worker still holds its lease");
    assert.equal(r.r.via, "holder");
    assert.equal(r.r.result.status, "confirmed");
    assert.equal(r.r.holder.pid, worker.proc.pid, "the agent's change went through the worker");
    const st = await w.stats();
    assert.equal(st.rows.filter((x: any) => x.id === r.id).length, 1);
    t.diagnostic(JSON.stringify({ takeovers: 0 }));
  } finally {
    await w.close();
  }
});

test("R5-06 control: pings answered on the main loop give a false takeover; fencing keeps one push; the worker takes the lease back", async (t) => {
  const { w, worker, nonce0, r, now } = await workerStall("r506-main-loop", false);
  try {
    const ev = w.events();
    const take = ev.find((e) => e.type === "lease" && e.pid !== worker.proc.pid);
    assert.ok(take, "the busy main loop was mistaken for death");
    const stop = ev.find((e) => e.pid === worker.proc.pid && e.type === "stop" && /^fenced/.test(e.why));
    assert.ok(stop, "the worker's old pusher stopped on the nonce check");
    assert.deepEqual(ev.filter((e) => e.pid === worker.proc.pid && e.nonce === nonce0 && e.t > take!.t && e.type === "push"), [], "and pushed nothing after the takeover");
    const st = await w.stats();
    assert.equal(st.rows.filter((x: any) => x.id === r.id).length, 1);
    assert.notEqual(now.nonce, nonce0);
    assert.ok(now.nonce, "the worker took the lease back by handover");
    const back = ev.find((e) => e.type === "lease" && e.pid === worker.proc.pid && e.t > take!.t);
    assert.ok(back);
    t.diagnostic(JSON.stringify({ falseTakeovers: 1, workerReacquiredMsAfterTakeover: back!.t - take!.t }));
  } finally {
    await w.close();
  }
});
