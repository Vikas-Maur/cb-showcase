// P3, ported from proofs/sqlite-check.js: N processes CAS-append to one carton.db through BEGIN IMMEDIATE and lose
// nothing. Also checks the P3b consequence: a writer waiting for the lock keeps its event loop running.
// Runs under plain Node, and under Electron's Node with `ELECTRON_RUN_AS_NODE=1 <electron> --test` (§20 P3).
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { openSqliteStore } from "../src/index.ts";
import { scratch } from "./scratch.ts";

const here = path.dirname(fileURLToPath(import.meta.url));

test("P3: 4 processes x 500 CAS appends lose no write (sqlite-check)", async () => {
  const dir = scratch("xproc");
  const file = path.join(dir, ".carton", "carton.db");

  const N = 4, COUNT = 500;
  const kids = Array.from({ length: N }, (_, n) => {
    const child = spawn(process.execPath, [path.join(here, "xproc-writer.ts"), file, `w${n}`, String(COUNT)], { stdio: ["ignore", "pipe", "inherit"], env: process.env });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    return new Promise<{ code: number | null; report: { maxStallMs: number; busyRetries: number; lostRaces: number } }>((resolve) =>
      child.on("exit", (code) => resolve({ code, report: code === 0 ? JSON.parse(out) : null })));
  });
  const results = await Promise.all(kids);

  const store = await openSqliteStore(file);
  const rows = await store.range<{ id: string; author: string }>("changes", { prefix: ["main"] });
  const ids = await store.range("ids");
  const raw = store.db.raw;
  const runtime = { node: process.versions.node, electron: process.versions.electron ?? null, sqlite: (raw.prepare("SELECT sqlite_version() AS v").get() as { v: string }).v };
  const journal = (raw.prepare("PRAGMA journal_mode").get() as { journal_mode: string }).journal_mode;
  await store.close();
  // How often consecutive seqs came from different writers: the appends interleaved, so the CAS was exercised.
  const switches = rows.reduce((n, r, i) => n + (i > 0 && r.value.author !== rows[i - 1].value.author ? 1 : 0), 0);
  console.log(JSON.stringify({ ...runtime, journal, rows: rows.length, maxSeq: rows.at(-1)?.key[1], switches, writers: results.map((r) => r.report) }));

  assert.deepEqual(results.map((r) => r.code), [0, 0, 0, 0]);
  assert.equal(journal, "wal");
  assert.equal(rows.length, N * COUNT);
  assert.ok(rows.every((r, i) => r.key[1] === i + 1), "seqs are contiguous: every append saw the true head");
  assert.equal(new Set(rows.map((r) => r.value.id)).size, N * COUNT, "each change landed exactly once");
  assert.equal(ids.length, N * COUNT, "the id index and the log were written together");
  // The writers contend on purpose. A waiting writer's thread must keep serving its event loop: the stall is
  // bounded by SQLite's short busy wait plus one transaction, never by another process's whole lock hold. The bound
  // is loose because this box is shared; the measured value is printed above.
  const worst = Math.max(...results.map((r) => r.report.maxStallMs));
  assert.ok(worst < 250, `event loop stalled ${worst} ms`);
  assert.ok(switches > N, `the writers really ran at once (${switches} hand-offs between writers)`);
});

test("P3b: a write waiting for another process's lock keeps the event loop running", async () => {
  const dir = scratch("xproc-hold");
  const file = path.join(dir, "carton.db");
  const store = await openSqliteStore(file);
  await store.write([{ table: "changes", key: ["main", 0], value: { id: "root" } }]);
  const HOLD = 400;
  const holder = spawn(process.execPath, [path.join(here, "xproc-holder.ts"), file, String(HOLD)], { stdio: ["ignore", "pipe", "inherit"], env: process.env });
  await new Promise<void>((resolve) => holder.stdout.on("data", (d) => String(d).includes("locked") && resolve()));
  const exited = new Promise((r) => holder.on("exit", r));

  let last = performance.now(), maxStall = 0, beats = 0;
  const beat = setInterval(() => {
    const now = performance.now();
    maxStall = Math.max(maxStall, now - last);
    last = now;
    beats++;
  }, 2);
  const t0 = performance.now();
  // The holder took the lock right after this process read head 0, so the conditional append of seq 1 must wait
  // for it, then fail (the holder wrote seq 1), then land at seq 2 on the retry.
  let attempts = 0;
  for (;;) {
    attempts++;
    const top = await store.range("changes", { prefix: ["main"], reverse: true, limit: 1 });
    const seq = (attempts === 1 ? 0 : (top[0].key[1] as number)) + 1;
    if (await store.write([{ table: "changes", key: ["main", seq], value: { id: "waiter" } }], [{ table: "changes", key: ["main", seq], expect: "absent" }])) break;
  }
  const waited = performance.now() - t0;
  clearInterval(beat);
  await exited;
  const ids = (await store.range<{ id: string }>("changes", { prefix: ["main"] })).map((r) => r.value.id);
  const busyRetries = store.db.busyRetries;
  await store.close();
  console.log(JSON.stringify({ waitedMs: Math.round(waited), maxStallMs: Math.round(maxStall * 10) / 10, beats, busyRetries, attempts }));

  assert.deepEqual(ids, ["root", "holder", "waiter"], "the waiter's CAS failed on the holder's seq and landed after it");
  assert.equal(attempts, 2);
  assert.ok(waited >= HOLD * 0.5, `the write really waited (${waited} ms)`);
  assert.ok(busyRetries > 0);
  // A DatabaseSync with the prototype's busy_timeout=5000 would block here for the whole ~400 ms hold.
  assert.ok(maxStall < 100, `event loop stalled ${maxStall} ms while waiting`);
});
