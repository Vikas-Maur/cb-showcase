// The harness's own turn lock, which must survive Windows' "delete pending" folders (CI, local (windows): a writer died
// with EPERM on mkdir ctl\lock right after another writer removed it), and a short real turn-mode trial.
//   node --test race.test.ts
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { endTurn, takeTurn, trial, writerSteps } from "./race.ts";

const SCRATCH = process.env.CARTON_SCRATCH ?? path.join(os.homedir(), "gfv-scratch", "carton", "cardboard-adapter", "test");
const err = (code: string) => Object.assign(new Error(code), { code });
const WIN = { windows: true }; // act out Windows: busy errors are retried only there
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
    assert.equal(takeTurn("ctl/lock", () => false, counter, { ...WIN, mkdir: m.fn }), true);
    assert.equal(m.calls.length, 3);
    assert.equal(counter.busy, 2, "the retries are counted as busy retries");
  }
});

test("turn lock: after the delete completes another writer may take the turn first (EEXIST), and we wait for it", () => {
  const m = failing(["EPERM", "EEXIST", "EEXIST", "EACCES"]);
  const counter = { busy: 0 };
  assert.equal(takeTurn("ctl/lock", () => false, counter, { ...WIN, mkdir: m.fn }), true);
  assert.equal(m.calls.length, 5);
  assert.equal(counter.busy, 2);
});

test("turn lock: the trial ending while another writer holds the turn returns false", () => {
  const m = failing(Array(10).fill("EEXIST"));
  let checks = 0;
  assert.equal(takeTurn("ctl/lock", () => ++checks > 3, {}, { mkdir: m.fn }), false);
  assert.equal(m.calls.length, 3);
});

test("turn lock: EPERM that outlasts the budget, and any other error, ends the writer", () => {
  const forever = () => {
    throw err("EPERM");
  };
  const t0 = performance.now();
  assert.throws(() => takeTurn("ctl/lock", () => false, {}, { ...WIN, mkdir: forever, budgetMs: 30 }), { code: "EPERM" });
  const took = performance.now() - t0;
  assert.ok(took < 1_000, `gave up after ${took} ms with a 30 ms budget`);
  const gone = failing(["ENOENT"]);
  assert.throws(() => takeTurn("ctl/lock", () => false, {}, { ...WIN, mkdir: gone.fn }), { code: "ENOENT" });
  assert.equal(gone.calls.length, 1, "not retried");
});

test("turn lock: on Linux and macOS EPERM is a real permission error and fails at once", () => {
  const m = failing(["EPERM"]);
  assert.throws(() => takeTurn("ctl/lock", () => false, {}, { windows: false, mkdir: m.fn }), { code: "EPERM" });
  assert.equal(m.calls.length, 1);
});

test("turn lock: releasing retries while another process has the folder open (EBUSY, EPERM)", () => {
  const m = failing(["EBUSY", "EPERM"]);
  const counter = { busy: 0 };
  endTurn("ctl/lock", counter, { ...WIN, rmdir: m.fn });
  assert.equal(m.calls.length, 3);
  assert.equal(counter.busy, 2);
});

// CI #11: on Windows the in-place writer's read-back of the view (and its in-place open) fails with EPERM while the
// engine renames or displaces it; a real Windows app retries, and so must the harness's writer, or the run dies.
test("writer steps: a busy view (EPERM, EBUSY, EACCES) is waited out on every step and each retry is counted per step", (t) => {
  fs.mkdirSync(SCRATCH, { recursive: true });
  const dir = fs.mkdtempSync(path.join(SCRATCH, "race-steps-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const view = path.join(dir, "view.json");
  fs.writeFileSync(view, "v0");
  const busy = ["EPERM", "EBUSY", "EACCES"];
  const flaky = <K extends "readFileSync" | "writeFileSync" | "statSync" | "renameSync">(name: K) => {
    const real = fs[name] as (...a: unknown[]) => unknown;
    let left = [...busy];
    t.mock.method(fs, name, (...a: unknown[]) => {
      const c = a.includes(view) ? left.shift() : undefined;
      if (c) throw err(c);
      return real(...a);
    });
    return () => (left = [...busy]);
  };
  const out: { busy?: number; by?: Record<string, number> } = {};
  const step = writerSteps(view, out, WIN);
  flaky("writeFileSync");
  step.writeInPlace("v1");
  flaky("readFileSync");
  assert.equal(step.readBack()?.toString(), "v1");
  flaky("statSync");
  assert.ok(step.statBack());
  const tmp = path.join(dir, "view.json.t.tmp");
  fs.writeFileSync(tmp, "v2");
  flaky("renameSync");
  step.renameOver(tmp);
  t.mock.restoreAll();
  assert.equal(fs.readFileSync(view, "utf8"), "v2");
  assert.equal(out.busy, 12);
  assert.deepEqual(out.by, { "write in place": 3, "read back": 3, "stat back": 3, rename: 3 });
  // a view that is gone is no error for the read-back (the engine displaced it); on Linux and macOS EPERM is real
  fs.rmSync(view);
  assert.equal(step.readBack(), undefined);
  fs.writeFileSync(view, "v3");
  flaky("readFileSync");
  assert.throws(() => writerSteps(view, {}, { windows: false }).readBack(), { code: "EPERM" });
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

test("a short in-place trial (the configs CI #11 couldn't finish on NTFS): the shipped displace + settle 2 loses none, writer retries reported", { timeout: 120_000 }, async (t) => {
  fs.mkdirSync(SCRATCH, { recursive: true });
  const base = fs.mkdtempSync(path.join(SCRATCH, "race-ip-"));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const r = await trial({
    base,
    fsLabel: "test",
    size: 512,
    mode: "turn",
    style: "inplace",
    protocol: "displace",
    settle: 2,
    engine: "sync",
    writers: 1,
    rounds: 200,
    widen: 0,
    jitter: 60,
    pace: 1,
    reader: false,
    oracle: null,
    keep: false,
  });
  assert.ok(r.landed > 0, "the writer wrote");
  assert.equal(r.lostByEngine, 0);
  assert.equal(typeof r.writerBusy, "number", "writer retries are part of the result");
  assert.deepEqual(Object.keys(r.writerBusyBy).filter((k) => !["write in place", "read back"].includes(k)), [], "in place: only those two steps");
});

test("--lock: the engine installs under the bundle's install lock and Carton's retrying reader never fails a read", { timeout: 120_000 }, async (t) => {
  fs.mkdirSync(SCRATCH, { recursive: true });
  const base = fs.mkdtempSync(path.join(SCRATCH, "race-lock-"));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const seen: boolean[] = [];
  const real = fs.linkSync;
  t.mock.method(fs, "linkSync", (from: fs.PathLike, to: fs.PathLike) => {
    if (String(to).endsWith("view.json")) seen.push(fs.existsSync(path.join(path.dirname(String(to)), ".carton", "install.lock")));
    return real(from, to);
  });
  const r = await trial({ base, fsLabel: "test", size: 512, mode: "turn", style: "rename", protocol: "displace", engine: "sync", writers: 0, rounds: 200, widen: 0, jitter: 0, pace: 1, reader: "retry", lock: true, oracle: null, keep: false });
  t.mock.restoreAll();
  assert.ok(seen.length >= 200 && seen.every(Boolean), "every link ran under the lock");
  assert.ok(r.rreads > 0);
  assert.equal(r.rfailed, 0, "no read failed");
});
