// R4-04: the detached helper's lifecycle, on real processes (port of system-v11 test/r4-04-helper.test.mjs).
// - killed (SIGKILL) in the middle of a push: the next `cb` call takes over in under 1 s, and the change is pushed
//   exactly once (stable id);
// - hung (its engine thread blocked for 3 s): the next call takes over; the hung helper wakes, sees the nonce moved,
//   and stops without pushing or rebasing anything;
// - the app starting while a helper holds the lease: handover (finish the in-flight push, release, exit), no wait for
//   the helper's 60 s idle timeout.
// The sequencer and engine are the stand-ins in test/support (mini-server, mini-engine) until core's sync client and
// server-node land; carton.db is real SQLite shared by the processes, and the sockets are real.
import { test } from "node:test";
import assert from "node:assert/strict";
import { World, sleep } from "./support/world.ts";
import type { Ev } from "./support/world.ts";

const C_OPS = [{ op: "set", path: ["timelineItems", "c1", "name"], value: "C" }];
const pidsOf = (ev: Ev[], type: string) => [...new Set(ev.filter((e) => e.type === type).map((e) => e.pid))];

async function killMidPush(name: string, { when, retryOnReset = false, hang = 0, latePushMs = 0 }: { when: "after-send" | "before-send"; retryOnReset?: boolean; hang?: number; latePushMs?: number }) {
  const w = new World(name);
  await w.server(latePushMs ? ["--hold-first-push-ms", String(latePushMs), "--hold-marker", "\"C\""] : []);
  const fault = hang ? { stallAfterPushMs: hang } : when === "after-send" ? { dieAfterPush: true } : { dieAfterQueue: true };
  const first = w.cb({ ops: C_OPS, retryOnReset, config: { port: w.port, marker: "\"C\"", ...fault } });
  const ev0 = await w.until((ev) => ev.some((e) => e.type === (hang ? "stall" : "dying")));
  const h1 = ev0.find((e) => e.type === "queued")!.pid;
  const C = ev0.find((e) => e.type === "queued")!.id;
  let firstRes: any, nextRes: any = null, nextStart = 0;
  if (hang) {
    await sleep(200);
    nextStart = Date.now();
    [firstRes, nextRes] = await Promise.all([first, w.cb({ op: { kind: "status" } })]);
  } else {
    firstRes = await first;
    if (!retryOnReset) {
      await sleep(300);
      nextStart = Date.now();
      nextRes = await w.cb({ op: { kind: "status" } });
    }
  }
  await sleep(hang ? hang + 500 : Math.max(500, latePushMs));
  return { w, h1, C, firstRes, nextRes, nextStart };
}

for (const [label, opts] of [
  ["killed right after its push was sent", { when: "after-send" }],
  ["killed before its push was sent", { when: "before-send" }],
  // the first call keeps cb's default (retry on reset), so it also shows the same-id retry after the hang
  ["hung for 3 s (alive, not answering), then wakes", { when: "after-send", hang: 3000, retryOnReset: true }],
  ["killed after sending a push that reaches the server only after the taker's", { when: "after-send", latePushMs: 2500 }],
] as const) {
  test(`R4-04 helper ${label}: the next cb takes over in < 1 s, the change is pushed exactly once`, async (t) => {
    const { w, h1, C, firstRes, nextRes, nextStart } = await killMidPush(`r404-${label.split(" ")[0]}`, opts);
    try {
      if (!("hang" in opts)) assert.equal(firstRes.r.via, "error", "the interrupted call saw the helper die");
      const take = nextRes.events.find((e: any) => e.type === "takeover");
      assert.ok(take, "the next call took over");
      // from the moment the next cb process started its call until the new helper answered on the lease
      const ms = take.t - nextRes.started;
      assert.ok(ms < 1000, `takeover took ${ms} ms`);
      assert.ok(nextRes.started >= nextStart - 50);
      const st = await w.stats();
      assert.equal(st.rows.filter((r: any) => r.id === C).length, 1, "C confirmed exactly once");
      if ("latePushMs" in opts) assert.ok(st.duplicates >= 1, "both copies reached the server; the late one was acked as a duplicate");
      const ev = w.events();
      if ("hang" in opts) {
        const stop = ev.find((e) => e.pid === h1 && e.type === "stop");
        assert.match(stop?.why ?? "", /^fenced/, "the hung helper woke, saw the nonce had changed, and stopped");
        const takenAt = ev.find((e) => e.type === "lease" && e.pid !== h1)?.t ?? take.t;
        assert.deepEqual(ev.filter((e) => e.pid === h1 && e.t > takenAt && (e.type === "push" || e.type === "confirmed")), [], "it pushed and confirmed nothing after the takeover");
        assert.equal(firstRes.r.via, "holder", "the first call was retried with the same id on the new holder");
        assert.equal(firstRes.r.result.status, "confirmed");
      }
      t.diagnostic(JSON.stringify({ takeoverMsFromNextCall: ms, helpers: pidsOf(ev, "lease").length, serverDuplicates: st.duplicates, pushesOfC: ev.filter((e) => e.type === "push" && e.ids.includes(C)).length }));
    } finally {
      await w.close();
    }
  });
}

test("R4-04 the interrupted call itself retries with the same id: one change, confirmed once", async () => {
  const { w, C, firstRes } = await killMidPush("r404-retry", { when: "after-send", retryOnReset: true });
  try {
    assert.equal(firstRes.r.via, "holder");
    assert.equal(firstRes.r.result.status, "confirmed");
    assert.equal(firstRes.id, C, "same stable id");
    const st = await w.stats();
    assert.equal(st.rows.length, 1, "no second change");
    assert.equal(st.rows[0].id, C);
  } finally {
    await w.close();
  }
});

test("R4-04 app start while the helper holds the lease: handover, no wait for the 60 s idle timeout", async (t) => {
  const w = new World("r404-handover");
  await w.server(["--hold-first-push-ms", "1500", "--hold-marker", "C2"]);
  try {
    const r1 = await w.cb({ ops: [{ op: "set", path: ["timelineItems", "c0", "name"], value: "first" }] });
    assert.equal(r1.r.result.status, "confirmed");
    const h1 = w.events().find((e) => e.type === "lease")!.pid;
    // a second change; the app starts while its push is in flight
    const call = w.cb({ ops: [{ op: "set", path: ["timelineItems", "c1", "name"], value: "C2" }], waitMs: 5000 });
    const ev0 = await w.until((ev) => ev.some((e) => e.type === "push" && e.pid === h1 && ev.some((q) => q.type === "queued" && q.pid === h1 && e.ids.includes(q.id) && q.id !== r1.id)));
    const C2 = ev0.filter((e) => e.type === "queued" && e.pid === h1).at(-1)!.id;
    const appStart = Date.now();
    const worker = await w.worker();
    const leaseAt = Date.now();
    worker.send(`commit gui.1 ${JSON.stringify([{ op: "set", path: ["timelineItems", "c2", "opacity"], value: 0.5 }])}`);
    const gui = await worker.next((x) => x.committed === "gui.1");
    const r2 = await call;
    await sleep(300);
    const ev = w.events();
    const exit = ev.find((e) => e.pid === h1 && e.type === "retire");
    assert.equal(exit?.why, "handover", "the helper left on handover, not on its idle timeout");
    assert.ok(leaseAt - appStart < 2000 + 1500, `worker had the lease ${leaseAt - appStart} ms after app start`);
    const workerLease = ev.find((e) => e.type === "lease" && e.pid === worker.proc.pid)!.t;
    const lastHelperPush = Math.max(...ev.filter((e) => e.pid === h1 && e.type === "push").map((e) => e.t));
    assert.ok(lastHelperPush <= workerLease, "the helper pushed nothing after the worker took the lease (one pusher at a time)");
    const st = await w.stats();
    assert.equal(st.rows.filter((r: any) => r.id === C2).length, 1, "the in-flight change landed once");
    assert.equal(gui.r.status, "confirmed", "the GUI edit was confirmed through the worker");
    assert.ok(["confirmed", "pending"].includes(r2.r.result?.status ?? r2.r.via));
    t.diagnostic(JSON.stringify({ leaseMsAfterAppStart: leaseAt - appStart, guiConfirmedMs: gui.t - leaseAt, idleTimeoutMs: 60000 }));
  } finally {
    await w.close();
  }
});
