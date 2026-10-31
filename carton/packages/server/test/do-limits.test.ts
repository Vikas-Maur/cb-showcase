// A Durable Object's SQLite allows at most 5 terms in a compound SELECT and 100 bound variables (measured in local
// workerd on 2026-10-31: 5 terms run, 6 fail "too many terms in compound SELECT"; 96 variables run, 120 fail). The
// sequencer runs on it unchanged, so every statement must fit both: here node:sqlite is set to the same limits.
// Found by the web demo: on the Worker every change touching two or more clips (an undo of a turn, a ripple) was
// answered "internal: too many terms in compound SELECT" and stayed pending for good.
import test from "node:test";
import assert from "node:assert/strict";
import { clip, doc, fakeConn, push, set, sqliteStorage, verdict, world } from "./helpers.ts";

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
