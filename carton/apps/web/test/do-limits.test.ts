// A Durable Object's SQLite allows at most 5 terms in a compound SELECT and 100 bound variables (measured in local
// workerd on 2026-10-31: 5 terms run, 6 fail "too many terms in compound SELECT"; 96 variables run, 120 fail). The
// server's sequencer runs on it unchanged, so every statement must fit both: node:sqlite is set to the same limits.
// Found by the web demo (REQ-3, fixed in hosts-plugins' canonical server cff9eee): on the Worker every change touching
// two or more clips (the demo's Undo turn of the Director's captions, a partial Fold in) stayed pending for good.
import assert from "node:assert/strict";
import test from "node:test";
import { clip, doc, fakeConn, push, set, sqliteStorage, verdict, world } from "../../../packages/server/test/helpers.ts";

const clips = (n: number) => Array.from({ length: n }, (_, i) => clip(`c${i}`, i * 5, (i + 1) * 5, "V1"));
function doStorage() {
  const s = sqliteStorage();
  s.db.limits.compoundSelect = 5;
  s.db.limits.variableNumber = 100;
  return s;
}

for (const n of [2, 5, 6, 33, 200]) {
  test(`a change touching ${n} clips is judged within a Durable Object's SQLite limits`, async () => {
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
