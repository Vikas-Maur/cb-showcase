// The harness's own turn lock, which must survive Windows' "delete pending" folders (CI, local (windows): a writer died
// with EPERM on mkdir ctl\lock right after another writer removed it), and a short real turn-mode trial.
//   node --test race.test.ts
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { endTurn, takeTurn, trial } from "./race.ts";

const SCRATCH = process.env.CARTON_SCRATCH ?? path.join(os.homedir(), "gfv-scratch", "carton", "cardboard-adapter", "test");
const err = (code: string) => Object.assign(new Error(code), { code });
/** A mkdir/rmdir that fails with each listed code in turn, then succeeds. */
const failing = (codes: string[]) => {
  const calls: string[] = [];
  const fn = (p: string) => {
    calls.push(p);
    const c = codes.shift();
    if (c) throw err(c);
  };
  return { fn, calls };
};

test("turn lock: a folder still being deleted (EPERM, EACCES) is waited out, not fatal", () => {
  for (const code of ["EPERM", "EACCES"]) {
    const m = failing([code, code]);
    const counter = { busy: 0 };
    assert.equal(takeTurn("ctl/lock", () => false, counter, { mkdir: m.fn }), true);
    assert.equal(m.calls.length, 3);
    assert.equal(counter.busy, 2, "the retries are counted as busy retries");
  }
});

test("turn lock: after the delete completes another writer may take the turn first (EEXIST), and we wait for it", () => {
  const m = failing(["EPERM", "EEXIST", "EEXIST", "EACCES"]);
  const counter = { busy: 0 };
  assert.equal(takeTurn("ctl/lock", () => false, counter, { mkdir: m.fn }), true);
  assert.equal(m.calls.length, 5);
  assert.equal(counter.busy, 2);
});

test("turn lock: the trial ending while another writer holds the turn returns false", () => {
  const m = failing(Array(10).fill("EEXIST"));
  let checks = 0;
  assert.equal(takeTurn("ctl/lock", () => ++checks > 3, {}, { mkdir: m.fn }), false);
  assert.equal(m.calls.length, 3);
});

test("turn lock: EPERM that outlasts the backoff, and any other error, ends the writer", () => {
  const forever = () => {
    throw err("EPERM");
  };
  assert.throws(() => takeTurn("ctl/lock", () => false, {}, { mkdir: forever, attempts: 3 }), { code: "EPERM" });
  const gone = failing(["ENOENT"]);
  assert.throws(() => takeTurn("ctl/lock", () => false, {}, { mkdir: gone.fn }), { code: "ENOENT" });
  assert.equal(gone.calls.length, 1, "not retried");
});

test("turn lock: releasing retries while another process has the folder open (EBUSY, EPERM)", () => {
  const m = failing(["EBUSY", "EPERM"]);
  const counter = { busy: 0 };
  endTurn("ctl/lock", counter, { rmdir: m.fn });
  assert.equal(m.calls.length, 3);
  assert.equal(counter.busy, 2);
});

test("a short turn-mode trial: four writers take turns through the real lock, and displace loses none", { timeout: 120_000 }, async (t) => {
  fs.mkdirSync(SCRATCH, { recursive: true });
  const base = fs.mkdtempSync(path.join(SCRATCH, "race-"));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const r = await trial({
    base,
    fsLabel: "test",
    size: 512,
    mode: "turn",
    style: "rename",
    protocol: "displace",
    engine: "sync",
    writers: 4,
    rounds: 300,
    widen: 0,
    jitter: 60,
    pace: 1, // ≥ 300 ms, so the writers get turns
    reader: false,
    oracle: null,
    keep: false,
  });
  assert.ok(r.landed > 0, "the writers wrote");
  assert.equal(r.lostByEngine, 0);
  assert.equal(r.keptNotRecorded, 0);
});
