// What the web demo needs from @carton/server (sync-sequencer's package; requests in the web-demo notes, "Requests to
// sync-sequencer"). Each is a `todo` test: it runs and reports, and fails until the server has it, without failing
// this suite. It was a contract(server) commit on this branch (f537dfa), taken out when the branch took
// sync-sequencer's side for packages/server.
//
// REQ-3 (a real Cloudflare bug): a Durable Object's SQLite allows at most 5 terms in a compound SELECT and 100 bound
// variables (measured in local workerd on 2026-10-31: 5 terms run, 6 fail "too many terms in compound SELECT"; 96
// variables run, 120 fail). Tables.records() batches 32 ids as one UNION ALL, so on the Worker every change touching
// two or more clips (an undo of a turn, a ripple) is answered "internal: too many terms in compound SELECT" and stays
// pending for good. node:sqlite is set to the DO's limits here.
// (REQ-2/REQ-4, scoped readers and welcome.source, came with foundation-core's f0fd418: server/test/scoped-read.test.ts.)
import assert from "node:assert/strict";
import test from "node:test";
import { clip, doc, fakeConn, push, set, sqliteStorage, verdict, world } from "../../../packages/server/test/helpers.ts";

const TODO3 = "sync-sequencer: Tables.records() within 5 compound terms (REQ-3)";

const clips = (n: number) => Array.from({ length: n }, (_, i) => clip(`c${i}`, i * 5, (i + 1) * 5, "V1"));
function doStorage() {
  const s = sqliteStorage();
  s.db.limits.compoundSelect = 5;
  s.db.limits.variableNumber = 100;
  return s;
}

for (const n of [2, 5, 6, 33, 200]) {
  test(`REQ-3: a change touching ${n} clips is judged within a Durable Object's SQLite limits`, { todo: TODO3 }, async () => {
    const storage = doStorage();
    const { seq, d0 } = await world(doc(clips(Math.max(n, 2))), { storage });
    const c = fakeConn("x/k");
    const r = await push(seq, c, d0, Array.from({ length: n }, (_, i) => set(`c${i}`, "name", `renamed ${i}`)));
    assert.equal(verdict(r), "ack");
    // and a trim of every one of them (timing ops: the records lookup with spans)
    const r2 = await push(seq, c, d0, Array.from({ length: n }, (_, i) => set(`c${i}`, "endTime", (i + 1) * 5 - 1)), { base: { seq: 1, pending: [] } });
    assert.equal(verdict(r2), "ack");
  });
}
