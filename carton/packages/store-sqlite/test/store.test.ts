// store-sqlite beyond the shared Store suite: the file format, the export copy, space reclaim, paths, and failure
// modes that only a real database file has.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { randomBytes } from "node:crypto";
import { openSqliteStore, openProjectStore, BusyError, DatabaseHeldError, FORMAT_VERSION } from "../src/index.ts";
import { Db, OPEN_RETRY_MS, OPEN_CHECKPOINT_BYTES, OPEN_CHECKPOINT_DELAY_MS, openRetrying, openPlatform } from "../src/db.ts";
import { scratch } from "./scratch.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = scratch("store");
after(() => fs.rmSync(root, { recursive: true, force: true }));
let n = 0;
const fresh = () => path.join(root, `s${++n}`, ".carton", "carton.db");
const sleepMs = (ms: number) => new Promise((r) => setTimeout(r, ms));
const pragma = (file: string, name: string) => {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    return Object.values(db.prepare(`PRAGMA ${name}`).get() as object)[0];
  } finally {
    db.close();
  }
};

test("a new carton.db: WAL, marked as Carton's (application_id CRTN, format version), incremental auto-vacuum", async () => {
  const file = fresh();
  const s = await openSqliteStore(file);
  await s.write([{ table: "changes", key: ["c", 1], value: 1 }]);
  await s.close();
  assert.equal(pragma(file, "journal_mode"), "wal");
  assert.equal(pragma(file, "application_id"), 0x4352544e);
  assert.equal(pragma(file, "user_version"), FORMAT_VERSION);
  assert.equal(pragma(file, "auto_vacuum"), 2);
});

test("another program's SQLite file, or a newer Carton's, is refused and left untouched", async () => {
  const foreign = path.join(root, "foreign.db");
  const f = new DatabaseSync(foreign);
  f.exec("CREATE TABLE notes(x); INSERT INTO notes VALUES ('mine')");
  f.close();
  await assert.rejects(openSqliteStore(foreign), /not a carton\.db/);
  const marked = path.join(root, "other-app.db");
  const g = new DatabaseSync(marked);
  g.exec("PRAGMA application_id=1234; CREATE TABLE t(x)");
  g.close();
  await assert.rejects(openSqliteStore(marked), /not a carton\.db/);
  const newer = fresh();
  await (await openSqliteStore(newer)).close();
  const h = new DatabaseSync(newer);
  h.exec(`PRAGMA user_version=${FORMAT_VERSION + 1}`);
  h.close();
  await assert.rejects(openSqliteStore(newer), /newer Carton/);
  const check = new DatabaseSync(foreign, { readOnly: true });
  assert.deepEqual(check.prepare("SELECT name FROM sqlite_schema").all().map((r) => (r as { name: string }).name), ["notes"]);
  check.close();
  assert.equal(pragma(foreign, "journal_mode"), "delete", "not even switched to WAL");
  assert.equal(pragma(foreign, "application_id"), 0);
});

test("Carton tables are readable SQLite tables: names kept, case made safe, odd names escaped", async () => {
  const file = fresh();
  const s = await openSqliteStore(file);
  await s.write([
    { table: "changes", key: ["c", 1], value: 1 },
    { table: "pathMap", key: ["p"], value: 1 },
    { table: "pathmap", key: ["p"], value: 2 },
    { table: "a-b c", key: ["k"], value: 3 },
    { table: "sqlite_x", key: ["k"], value: 4 },
    { table: "\ud800", key: ["k"], value: 5 },
    { table: "\ud801", key: ["k"], value: 6 },
  ]);
  const names = (s.db.raw.prepare("SELECT name FROM sqlite_schema WHERE type = 'table' ORDER BY name").all() as { name: string }[]).map((r) => r.name);
  // "a-b c" and "sqlite_x" as UTF-16 code units in hex; lone surrogates keep their own names.
  assert.deepEqual(names, ["_carton", "_t_0061002d006200200063", "_t_00730071006c006900740065005f0078", "_t_d800", "_t_d801", "changes", "path$map", "pathmap"]);
  assert.equal(await s.get("pathMap", ["p"]), 1);
  assert.equal(await s.get("pathmap", ["p"]), 2);
  assert.equal(await s.get("a-b c", ["k"]), 3);
  assert.equal(await s.get("sqlite_x", ["k"]), 4);
  assert.equal(await s.get("\ud800", ["k"]), 5, "lone surrogates in a table name stay distinct");
  assert.equal(await s.get("\ud801", ["k"]), 6);
  await s.close();
});

test("exportCopy: a full-history copy without the local tables, whose bytes hold no trace of them", async () => {
  const file = fresh();
  const s = await openSqliteStore(file);
  const SECRET = "C:\\Users\\ana.secret\\Videos\\raw-footage.mov";
  // Enough rows to cross several export batches.
  for (let i = 0; i < 5; i++) await s.write(Array.from({ length: 1000 }, (_, j) => ({ table: "changes", key: ["main", i * 1000 + j + 1], value: { id: `r.${i * 1000 + j + 1}`, ops: [] } })));
  await s.write([
    { table: "meta", key: ["projectId"], value: "p1" },
    { table: "pathMap", key: ["m1"], value: SECRET },
    { table: "lease", key: ["sync"], value: { pid: 1, socketPath: SECRET } },
    { table: "pins", key: ["main", 3, "abcd1234"], value: { owners: { [SECRET]: 1 } } },
  ]);
  const out = path.join(root, "export", "full.carton.db");
  // A write that lands during the export is not in it (one snapshot) and is not blocked by it.
  const during = s.exportCopy(out, ["pathMap", "lease", "pins", "notices", "views", "ephemeral", "pending"]);
  assert.equal(await s.write([{ table: "changes", key: ["main", 5001], value: { id: "late" } }]), true);
  await during;
  assert.ok(!fs.readdirSync(path.dirname(out)).some((f) => f.includes(".part-")), "no partial file left");
  assert.ok(!fs.readFileSync(out).includes(Buffer.from("ana.secret")), "no local data in the file's bytes");
  const copy = await openSqliteStore(out, { readOnly: true });
  assert.equal((await copy.range("changes", { prefix: ["main"] })).length, 5000);
  assert.equal(await copy.get("meta", ["projectId"]), "p1");
  assert.equal(await copy.get("pathMap", ["m1"]), undefined);
  assert.deepEqual(await copy.range("lease"), []);
  assert.deepEqual(await copy.range("pins"), []);
  await copy.close();
  assert.equal(pragma(out, "application_id"), 0x4352544e);
  assert.notEqual(pragma(out, "journal_mode"), "wal", "a single self-contained file");
  const meta = new DatabaseSync(out, { readOnly: true });
  assert.deepEqual(meta.prepare(`SELECT k FROM "_carton"`).all(), [], "no machine id or placement marks in a shared copy");
  meta.close();
  assert.ok(!fs.existsSync(`${out}-wal`));
  await s.close();
});

test("reclaim gives the pages of pruned keyframes back to the disk", async () => {
  const file = fresh();
  const s = await openSqliteStore(file);
  // Random content, so compression can't hide the pages: the shrink below is the vacuum's.
  const big = { blob: randomBytes(20000).toString("base64") };
  for (let seq = 64; seq <= 64 * 100; seq += 64) await s.write([{ table: "keyframes", key: ["main", seq], value: big }]);
  s.db.raw.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  const before = fs.statSync(file).size;
  await s.write(Array.from({ length: 99 }, (_, i) => ({ table: "keyframes", key: ["main", 64 * (i + 1)], value: undefined })));
  await s.reclaim();
  s.db.raw.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  const afterSize = fs.statSync(file).size;
  assert.ok(afterSize < before / 10, `file shrank from ${before} to ${afterSize} bytes`);
  assert.equal((await s.range("keyframes")).length, 1);
  await s.close();
});

test("non-ASCII and spaced paths (a Windows user folder in any language)", async () => {
  const file = path.join(root, "Vidéos de Zoë", "プロジェクト 1.cardboard", ".carton", "carton.db");
  const s = await openSqliteStore(file);
  assert.equal(await s.write([{ table: "t", key: ["ключ"], value: "значение" }]), true);
  await s.close();
  const again = await openSqliteStore(file);
  assert.equal(await again.get("t", ["ключ"]), "значение");
  await again.close();
});

test("read-only handles read and refuse writes", async () => {
  const file = fresh();
  const w = await openSqliteStore(file);
  await w.write([{ table: "t", key: ["k"], value: 1 }]);
  const r = await openSqliteStore(file, { readOnly: true });
  assert.equal(await r.get("t", ["k"]), 1);
  await assert.rejects(r.write([{ table: "t", key: ["k"], value: 2 }]), /readonly|read-only/i);
  assert.equal(await w.get("t", ["k"]), 1);
  await r.close();
  await w.close();
});

test("durability 'full' fsyncs every commit (synchronous=FULL); the default is NORMAL", async () => {
  const a = await openSqliteStore(fresh(), { durability: "full" });
  const b = await openSqliteStore(fresh());
  assert.equal((a.db.raw.prepare("PRAGMA synchronous").get() as { synchronous: number }).synchronous, 2);
  assert.equal((b.db.raw.prepare("PRAGMA synchronous").get() as { synchronous: number }).synchronous, 1);
  await a.close();
  await b.close();
});

test("a lock held longer than busyTimeoutMs fails the write with BusyError, writes nothing, and never blocks the loop", async () => {
  const file = fresh();
  const s = await openSqliteStore(file, { busyTimeoutMs: 150 });
  await s.write([{ table: "changes", key: ["main", 0], value: { id: "root" } }]);
  const holder = spawn(process.execPath, [path.join(here, "xproc-holder.ts"), file, "800"], { stdio: ["ignore", "pipe", "inherit"] });
  await new Promise<void>((resolve) => holder.stdout.on("data", (d) => String(d).includes("locked") && resolve()));
  const exited = new Promise((r) => holder.on("exit", r));
  let maxStall = 0, last = performance.now(), beats = 0;
  const beat = setInterval(() => { const now = performance.now(); maxStall = Math.max(maxStall, now - last); last = now; beats++; }, 2);
  const t0 = performance.now();
  const err = await s.write([{ table: "changes", key: ["main", 9], value: { id: "mine" } }]).catch((e) => e);
  const took = performance.now() - t0;
  clearInterval(beat);
  maxStall = Math.max(maxStall, performance.now() - last);
  assert.ok(beats >= 5, `only ${beats} heartbeats in ${Math.round(took)} ms`);
  assert.ok(err instanceof BusyError, String(err));
  assert.equal(err.code, "CARTON_DB_BUSY");
  assert.ok(took >= 140 && took < 3000, `gave up after ${Math.round(took)} ms`);
  assert.ok(maxStall < took * 0.6, `event loop stalled ${Math.round(maxStall)} ms of ${Math.round(took)} ms`);
  await exited;
  assert.deepEqual((await s.range<{ id: string }>("changes", { prefix: ["main"] })).map((r) => r.value.id), ["root", "holder"]);
  await s.close();
});

test("openProjectStore: in the bundle normally, in app data for a synced folder (L15)", async () => {
  const bundle = path.join(root, "Promo.cardboard");
  fs.mkdirSync(bundle, { recursive: true });
  const local = await openProjectStore({ bundleDir: bundle, projectId: "p1", appDataDir: path.join(root, "appdata") });
  assert.equal(local.location.placement, "bundle");
  assert.equal(local.store.path, path.join(bundle, ".carton", "carton.db"));
  await local.store.close();

  const synced = path.join(root, "Sync", "Promo.cardboard");
  fs.mkdirSync(synced, { recursive: true });
  fs.mkdirSync(path.join(root, "Sync", ".stfolder"));
  const away = await openProjectStore({ bundleDir: synced, projectId: "p2", appDataDir: path.join(root, "appdata") });
  assert.equal(away.location.placement, "cloud-sync");
  assert.equal(away.store.path, path.join(root, "appdata", "projects", "p2", "carton.db"));
  assert.ok(fs.existsSync(away.store.path));
  assert.ok(!fs.existsSync(path.join(synced, ".carton")), "nothing written into the synced folder");
  await away.store.close();
});

test("closing twice is harmless; using a closed store rejects", async () => {
  const s = await openSqliteStore(fresh());
  await s.close();
  await s.close();
  await assert.rejects(s.get("t", ["k"]));
  await assert.rejects(s.write([{ table: "t", key: ["k"], value: 1 }]));
});

test("large values (keyframes) are stored compressed and read back exactly; small ones stay text", async () => {
  const file = fresh();
  const s = await openSqliteStore(file);
  const items = Array.from({ length: 1000 }, (_, i) => ({ id: `item-${i}`, trackId: `track-${i % 6}`, startTime: i * 0.5, endTime: i * 0.5 + 0.45, name: `Clip ${i}`, transform: { x: 0, y: 0, scale: 1 } }));
  const kf = { name: "Promo", items };
  await s.write([
    { table: "keyframes", key: ["main", 64], value: kf },
    { table: "keyframes", key: ["main", 128], value: { small: true } },
    { table: "changes", key: ["main", 1], value: { id: "r.1", ops: [] } },
  ]);
  const kinds = (s.db.raw.prepare(`SELECT typeof(v) AS t, length(v) AS n FROM keyframes ORDER BY k`).all() as { t: string; n: number }[]);
  assert.equal(kinds[0].t, "blob");
  assert.ok(kinds[0].n * 5 < JSON.stringify(kf).length, `stored ${kinds[0].n} bytes for ${JSON.stringify(kf).length} of JSON`);
  assert.equal(kinds[1].t, "text", "a small keyframe stays text");
  assert.equal((s.db.raw.prepare(`SELECT typeof(v) AS t FROM changes`).get() as { t: string }).t, "text");
  assert.deepEqual(await s.get("keyframes", ["main", 64]), kf);
  assert.deepEqual((await s.range("keyframes", { prefix: ["main"], reverse: true, limit: 2 })).map((r) => r.key), [["main", 128], ["main", 64]]);
  assert.deepEqual((await s.range("keyframes", { prefix: ["main"], lte: ["main", 64] }))[0].value, kf);
  assert.equal(await s.write([{ table: "t", key: ["x"], value: 1 }], [{ table: "keyframes", key: ["main", 64], expect: { equals: { items, name: "Promo" } } }]), true, "equals sees through compression");
  const big = { items: Array.from({ length: 12000 }, (_, i) => ({ ...items[i % 1000], id: `big-${i}` })) };
  await s.write([{ table: "keyframes", key: ["main", 192], value: big }]);
  assert.deepEqual(await s.get("keyframes", ["main", 192]), big, "a value over 1 MiB (deflated off the event loop) round-trips");
  const out = path.join(root, "export-z", "copy.db");
  await s.exportCopy(out, []);
  const copy = await openSqliteStore(out, { readOnly: true });
  assert.deepEqual(await copy.get("keyframes", ["main", 64]), kf, "the export carries compressed values as they are");
  await copy.close();
  await s.close();
});

test("a write that fails after creating a table leaves no ghost table behind", async () => {
  const s = await openSqliteStore(fresh());
  // A write whose insert fails (as with SQLITE_FULL) after its CREATE TABLE ran in the same transaction.
  const db = s.db.raw;
  const orig = s.db.stmt.bind(s.db);
  let fail = true;
  (s.db as { stmt: typeof s.db.stmt }).stmt = (sql: string) => {
    if (fail && sql.startsWith('INSERT INTO "ghost"')) {
      fail = false;
      throw Object.assign(new Error("database or disk is full"), { errcode: 13 });
    }
    return orig(sql);
  };
  await assert.rejects(s.write([{ table: "ghost", key: ["a"], value: 1 }]), /disk is full/);
  assert.equal(db.prepare("SELECT count(*) AS n FROM sqlite_schema WHERE name = 'ghost'").get()!.n, 0, "the CREATE rolled back");
  assert.equal(await s.get("ghost", ["a"]), undefined, "reading a rolled-back table is just absent");
  assert.deepEqual(await s.range("ghost"), []);
  assert.equal(await s.write([{ table: "ghost", key: ["a"], value: 1 }]), true, "and writing it later creates it");
  assert.equal(await s.get("ghost", ["a"]), 1);
  await s.close();
});

test("many processes creating the same new carton.db at once all open it (identity read in one snapshot)", async () => {
  const files = Array.from({ length: 5 }, (_, i) => path.join(root, `race-${i}`, ".carton", "carton.db"));
  const runs = files.flatMap((f) =>
    Array.from({ length: 4 }, () =>
      new Promise<{ code: number | null; err: string }>((resolve) => {
        const child = spawn(process.execPath, ["--input-type=module", "-e", `import { openSqliteStore } from ${JSON.stringify(new URL("../src/index.ts", import.meta.url).href)}; const s = await openSqliteStore(${JSON.stringify(f)}); await s.write([{ table: "t", key: [process.pid], value: 1 }]); await s.close();`], { stdio: ["ignore", "ignore", "pipe"] });
        let err = "";
        child.stderr.on("data", (d) => (err += d));
        child.on("exit", (code) => resolve({ code, err }));
      }),
    ),
  );
  const out = await Promise.all(runs);
  assert.deepEqual(out.filter((r) => r.code !== 0).map((r) => r.err.split("\n").find((l) => /Error/.test(l))), []);
  for (const f of files) {
    const s = await openSqliteStore(f);
    assert.equal((await s.range("t")).length, 4);
    await s.close();
  }
});

test("exportCopy refuses its own database (also through a symlink or hard link) and any database in use", async () => {
  const file = fresh();
  const s = await openSqliteStore(file);
  await s.write([{ table: "changes", key: ["c", 1], value: 1 }, { table: "pathMap", key: ["m"], value: "C:\\Users\\ana\\x.mov" }]);
  await assert.rejects(s.exportCopy(file, ["pathMap"]), /own database/);
  const link = path.join(root, `link-${n}.db`);
  fs.symlinkSync(file, link);
  await assert.rejects(s.exportCopy(link, ["pathMap"]), /own database/);
  const hard = path.join(path.dirname(file), "hard.db");
  fs.linkSync(file, hard);
  await assert.rejects(s.exportCopy(hard, ["pathMap"]), /own database/);
  const other = await openSqliteStore(fresh());
  await other.write([{ table: "t", key: ["k"], value: 1 }]);
  await assert.rejects(s.exportCopy(other.path, ["pathMap"]), /already exists/);
  await other.close();
  assert.equal(await s.get("pathMap", ["m"]), "C:\\Users\\ana\\x.mov", "nothing was replaced");
  await s.close();
  const again = await openSqliteStore(file);
  assert.equal((await again.range("changes")).length, 1);
  await again.close();
});

test("WAL checkpoints never run inside a commit (no commit-latency spikes), yet the WAL stays bounded", async () => {
  const file = fresh();
  const s = await openSqliteStore(file);
  assert.equal((s.db.raw.prepare("PRAGMA wal_autocheckpoint").get() as { wal_autocheckpoint: number }).wal_autocheckpoint, 0);
  // ~6 MB of WAL in one burst. Awaited writes that find no lock resolve without a macrotask, so the deferred
  // checkpoint can't run during the loop: a WAL past SQLite's old 1,000-page trigger proves no commit checkpointed.
  const blob = randomBytes(4500).toString("base64"); // ~6 KB of text: under the 8 KiB compression threshold
  for (let i = 0; i < 1000; i++) await s.write([{ table: "changes", key: ["main", i], value: { blob, i } }]);
  const walBytes = fs.statSync(`${file}-wal`).size;
  assert.ok(walBytes > 1000 * 4096 * 1.2, `the WAL grew to ${walBytes} bytes during the burst`);
  assert.equal(s.db.checkpoints, 0, "none ran inside a commit");
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
  assert.ok(s.db.checkpoints >= 1, "then a checkpoint ran on its own turn of the event loop");
  // Fully checkpointed, so the next write starts the WAL over: it holds a handful of frames, not thousands.
  await s.write([{ table: "changes", key: ["main", 5000], value: 1 }]);
  const after = s.db.raw.prepare("PRAGMA wal_checkpoint(PASSIVE)").get() as { log: number };
  assert.ok(after.log < 50, `${after.log} frames in the WAL after the checkpoint`);
  assert.equal((await s.range("changes", { prefix: ["main"] })).length, 1001, "and nothing was lost");
  await s.close();
});

test("a WAL left large by other processes is checkpointed at open, not by a commit", async () => {
  const file = fresh();
  const w = await openSqliteStore(file);
  const blob = randomBytes(4500).toString("base64");
  // Another connection (a cb process) fills the WAL and stays open, so closing it doesn't checkpoint.
  for (let i = 0; i < 900; i++) await w.write([{ table: "changes", key: ["x", i], value: { blob } }]);
  const s = await openSqliteStore(file);
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
  assert.ok(s.db.checkpoints + w.db.checkpoints >= 1, "someone checkpointed it without a commit doing so");
  await w.close();
  await s.close();
});

test("each durability gets its checkpoint mode: deferred and out of the lock by default, SQLite's own for full", async () => {
  const blob = randomBytes(4500).toString("base64");
  const normal = await openSqliteStore(fresh());
  const full = await openSqliteStore(fresh(), { durability: "full" });
  const auto = (s: typeof normal) => (s.db.raw.prepare("PRAGMA wal_autocheckpoint").get() as { wal_autocheckpoint: number }).wal_autocheckpoint;
  assert.equal(auto(normal), 0, "default: SQLite's checkpoint off, ours deferred");
  assert.equal(auto(full), 1000, "full: SQLite's automatic checkpoint, as before");
  for (let i = 0; i < 1100; i++) {
    await normal.write([{ table: "t", key: [i], value: { blob } }]);
    await full.write([{ table: "t", key: [i], value: { blob } }]);
  }
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
  assert.ok(normal.db.checkpoints >= 1, "the default ran its own deferred checkpoint");
  assert.equal(full.db.checkpoints, 0, "full never queues one");
  const walFull = fs.statSync(`${full.path}-wal`).size;
  assert.ok(walFull < 1100 * 4096, `and its WAL was still checkpointed by SQLite (${walFull} bytes)`);
  await normal.close();
  await full.close();
});

// perf/apply-latency: a short `cb` call doesn't pay for a checkpoint at open while the WAL is small; a process that
// stays still runs it, and the WAL file's size bounds what is left unchecked. Waits are on the condition, not on a
// sleep: a timer that fires only queues the checkpoint for the next turn, and a loaded runner delivers timers late.
const until = async (what: string, f: () => boolean, ms = OPEN_CHECKPOINT_DELAY_MS + 15_000) => {
  for (const end = performance.now() + ms; !f(); ) {
    if (performance.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleepMs(20);
    await new Promise((r) => setImmediate(r));
  }
};
const quick = async () => { await new Promise((r) => setImmediate(r)); await new Promise((r) => setImmediate(r)); };

test("a small WAL left by other processes is checkpointed OPEN_CHECKPOINT_DELAY_MS after open, not at once", async () => {
  const file = fresh();
  const w = await openSqliteStore(file);
  let s: Awaited<ReturnType<typeof openSqliteStore>> | null = null;
  try {
    await until("w's own deferred checkpoint", () => w.db.checkpoints >= 1);
    const before = w.db.checkpoints;
    // Another connection (a cb process) adds a few frames and stays open, so closing it doesn't checkpoint.
    for (let i = 0; i < 20; i++) await w.write([{ table: "changes", key: ["x", i], value: { i } }]);
    const walBytes = fs.statSync(`${file}-wal`).size;
    assert.ok(walBytes > 0 && walBytes <= OPEN_CHECKPOINT_BYTES, `a small WAL: ${walBytes} bytes`);
    const t0 = performance.now();
    s = await openSqliteStore(file);
    await quick();
    // (unless this process was held up past the delay itself, when the deferred one may have run already)
    if (performance.now() - t0 < OPEN_CHECKPOINT_DELAY_MS) assert.equal(s.db.checkpoints, 0, "not at open: a short process exits before it");
    const opened = s;
    await until("s's deferred checkpoint", () => opened.db.checkpoints >= 1);
    assert.equal(s.db.checkpoints, 1, "a process that stays runs it, once");
    if (performance.now() - t0 < 25_000) assert.equal(w.db.checkpoints, before, "w's next one is on its 30 s timer");
  } finally {
    await w.close();
    await s?.close();
  }
});

test("a WAL past OPEN_CHECKPOINT_BYTES is checkpointed at open through a symlink to carton.db too (SQLite's WAL is the target's)", async (t) => {
  const file = fresh();
  const link = path.join(path.dirname(file), "alias.db");
  const w = await openSqliteStore(file);
  let s: Awaited<ReturnType<typeof openSqliteStore>> | null = null;
  try {
    await until("w's own deferred checkpoint", () => w.db.checkpoints >= 1);
    try { fs.symlinkSync(file, link); } catch (e) { t.skip(`no symlinks here: ${(e as Error).message}`); return; }
    const blob = randomBytes(4500).toString("base64");
    for (let i = 0; i < 900; i++) await w.write([{ table: "changes", key: ["x", i], value: { blob } }]);
    assert.ok(fs.statSync(`${file}-wal`).size > OPEN_CHECKPOINT_BYTES, "a large WAL beside the real file");
    assert.equal(fs.existsSync(`${link}-wal`), false, "and none beside the link");
    const before = w.db.checkpoints;
    s = await openSqliteStore(link);
    await quick();
    assert.equal(s.db.checkpoints + w.db.checkpoints - before, 1, "checkpointed at open, through the link");
  } finally {
    await w.close();
    await s?.close();
  }
});

test("closing a store before its open checkpoint is due drops it (no timer keeps a closed store)", async () => {
  const s = await openSqliteStore(fresh());
  const t0 = performance.now();
  await s.write([{ table: "changes", key: ["x", 0], value: 0 }]);
  await s.close();
  const closedAt = performance.now() - t0;
  await sleepMs(OPEN_CHECKPOINT_DELAY_MS + 500);
  await quick();
  if (closedAt < OPEN_CHECKPOINT_DELAY_MS) assert.equal(s.db.checkpoints, 0);
});

test("a caller that never yields still gets checkpoints: the WAL stays bounded through the Store API alone", async () => {
  const s = await openSqliteStore(fresh());
  // 2,500 small writes in one tight loop of awaited calls: the deferred checkpoint never gets a turn of its own.
  for (let i = 0; i < 2500; i++) await s.write([{ table: "changes", key: ["main", i], value: { i } }]);
  assert.ok(s.db.checkpoints >= 1, "one ran inline, before a write, once the budget was twice spent");
  const frames = (s.db.raw.prepare("PRAGMA wal_checkpoint(PASSIVE)").get() as { log: number }).log;
  assert.ok(frames < 2500, `the WAL was reused: ${frames} frames for 2,500 commits`);
  await s.close();
});

// On Windows something else (an antivirus, the indexer, a backup tool, a process being terminated) can briefly hold
// carton.db or its -wal/-shm: an open retries for a moment, then reports DatabaseHeldError. Tested with injected
// errors (any OS) and, on Windows, with a sidecar really held.
const sqliteError = (errcode: number, message: string) => Object.assign(new Error(message), { code: "ERR_SQLITE_ERROR", errcode });
const ioerr = () => sqliteError(10 | (13 << 8), "disk I/O error"); // SQLITE_IOERR_ACCESS (3338)

test("Windows: a held carton.db is retried on a fresh connection with backoff, without blocking the loop", async () => {
  const file = fresh();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const seen = new Set<unknown>();
  const errors = [ioerr(), sqliteError(14, "unable to open database file"), ioerr()];
  let beats = 0;
  const beat = setInterval(() => beats++, 1);
  const db = await openRetrying(file, () => Db.open(file, {}, (raw) => {
    seen.add(raw);
    const e = errors.shift();
    if (e) throw e;
  }), "win32");
  clearInterval(beat);
  try {
    assert.equal(seen.size, 4, "four attempts, each on its own connection");
    assert.ok(beats > 0, "the waits between them are asynchronous");
    assert.equal((db.raw.prepare("PRAGMA journal_mode").get() as { journal_mode: string }).journal_mode, "wal", "and the open then finishes");
  } finally {
    db.close();
  }
});

test("Windows: still held after the retry window, the open fails with DatabaseHeldError", async () => {
  const t0 = Date.now();
  let attempts = 0;
  await assert.rejects(openRetrying("C:\\p\\carton.db", async () => { attempts++; throw ioerr(); }, "win32"), (e: DatabaseHeldError) => {
    assert.ok(e instanceof DatabaseHeldError);
    assert.equal(e.code, "CARTON_DB_HELD");
    assert.equal(e.path, "C:\\p\\carton.db");
    assert.match(e.message, /may still be holding it .*check its permissions .*errcode 3338/);
    assert.equal((e.cause as { errcode: number }).errcode, 3338);
    return true;
  });
  const took = Date.now() - t0;
  assert.ok(took >= OPEN_RETRY_MS && took < OPEN_RETRY_MS + 1000, `${took} ms`);
  assert.ok(attempts >= 4 && attempts <= 12, `${attempts} attempts (backoff, not a spin)`);
});

test("other failures, and I/O errors off Windows, are reported at once (an I/O error with its extended code)", async () => {
  let attempts = 0;
  const failWith = (e: Error) => async () => { attempts++; throw e; };
  await assert.rejects(openRetrying("x", failWith(new Error("not a carton.db")), "win32"), /^Error: not a carton.db$/);
  await assert.rejects(openRetrying("x", failWith(sqliteError(1, "SQL logic error")), "win32"), /^Error: SQL logic error$/);
  await assert.rejects(openRetrying("x", failWith(ioerr()), "linux"), /^Error: disk I\/O error \(SQLite errcode 3338\)$/);
  await assert.rejects(openRetrying("x", failWith(sqliteError(14, "unable to open database file")), "darwin"), /^Error: unable to open database file$/);
  // on Windows "unable to open" is retried only for a file that exists: a missing one (or folder) is lasting
  await assert.rejects(openRetrying(path.join(root, "missing", "carton.db"), failWith(sqliteError(14, "unable to open database file")), "win32"), /^Error: unable to open database file$/);
  await assert.rejects(openRetrying("x", failWith(sqliteError(11, "database disk image is malformed")), "win32"), /malformed$/);
  await assert.rejects(openRetrying("x", failWith(sqliteError(26, "file is not a database")), "win32"), /not a database$/);
  // what a failing disk, memory or file system looks like is never retried: plain, READ, SHORT_READ, WRITE, FSYNC,
  // TRUNCATE, NOMEM, CORRUPTFS; nor "unable to open" for a directory (CANTOPEN_ISDIR), though the path exists
  for (const code of [10, 266, 522, 778, 1034, 1546, 3082, 8458]) await assert.rejects(openRetrying("x", failWith(sqliteError(code, "disk I/O error")), "win32"), new RegExp(`errcode ${code}\\)$`));
  await assert.rejects(openRetrying(root, failWith(sqliteError(526, "unable to open database file")), "win32"), /^Error: unable to open database file$/);
  assert.equal(attempts, 16);
});

test("Windows: a -wal or -shm held exclusively by another process gives DatabaseHeldError, and opens once let go", { skip: process.platform !== "win32" ? "Windows sharing modes" : false }, async () => {
  for (const side of ["-wal", "-shm"]) {
    const file = fresh();
    const s = await openSqliteStore(file);
    await s.write([{ table: "changes", key: ["main", 1], value: { id: "a" } }]);
    await s.close();
    // Another process opens the sidecar with no sharing at all (as a scanner can), by path from the environment.
    const ps = path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
    const holder = spawn(ps, ["-NoProfile", "-NonInteractive", "-Command", "$ErrorActionPreference = 'Stop'; $f = [IO.File]::Open($env:CARTON_HOLD, 'OpenOrCreate', 'ReadWrite', 'None'); [Console]::Out.WriteLine('held'); [void][Console]::In.ReadLine(); $f.Close()"], { env: { ...process.env, CARTON_HOLD: file + side }, stdio: ["pipe", "pipe", "inherit"], windowsHide: true });
    const closed = new Promise<void>((r) => holder.once("close", () => r()));
    holder.stdin!.on("error", () => {}); // a holder that already died: its exit is what the test reports
    const within = <T>(p: Promise<T>, ms: number, what: string) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      return Promise.race([p, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`${what}: no answer in ${ms} ms`)), ms); })]).finally(() => clearTimeout(timer));
    };
    try {
      let out = "";
      await within(new Promise<void>((resolve, reject) => {
        holder.stdout!.on("data", (d) => { out += d; if (/^held\r?$/m.test(out)) resolve(); });
        holder.once("error", reject);
        holder.once("close", (c) => reject(new Error(`the holder ended (${c}) before holding ${side}`)));
      }), 30_000, `holding ${side}`);
      await assert.rejects(openSqliteStore(file), DatabaseHeldError, `held ${side}`);
    } finally {
      holder.stdin!.end("\n");
      try {
        await within(closed, 10_000, "the holder letting go");
      } catch {
        holder.kill();
        await within(closed, 10_000, "the holder being killed");
      }
    }
    const again = await openSqliteStore(file);
    assert.deepEqual((await again.range("changes")).map((r) => r.value), [{ id: "a" }], `opens once ${side} is let go`);
    await again.close();
  }
});

test("Windows: an I/O error after the connection is up (marking a new file) is retried too, on a fresh connection, the failed one closed", async () => {
  const file = fresh();
  const proto = DatabaseSync.prototype as unknown as { prepare(sql: string): unknown };
  const prepare = proto.prepare;
  const conns: DatabaseSync[] = [];
  let failures = 2;
  proto.prepare = function (this: DatabaseSync, sql: string) {
    if (!conns.includes(this)) conns.push(this);
    if (failures > 0 && sql.startsWith("INSERT INTO") && sql.includes("_carton")) {
      failures--;
      throw ioerr();
    }
    return prepare.call(this, sql);
  };
  openPlatform.override = "win32";
  let store;
  try {
    store = await openSqliteStore(file);
  } finally {
    proto.prepare = prepare;
    delete openPlatform.override;
  }
  try {
    assert.equal(failures, 0, "both injected failures happened in init, after Db.open");
    assert.equal(conns.length, 3, "three attempts, each on its own connection");
    assert.deepEqual(conns.map((c) => c.isOpen), [false, false, true], "the failed ones are closed");
    assert.equal(pragma(file, "application_id"), 0x4352544e, "and the file is marked once, normally");
  } finally {
    await store.close();
  }
});

test("Windows: a missing file opened read-only is reported at once, not as held", async () => {
  openPlatform.override = "win32";
  const t0 = Date.now();
  try {
    await assert.rejects(openSqliteStore(path.join(root, "nowhere", "carton.db"), { readOnly: true }), (e: Error) => !(e instanceof DatabaseHeldError) && /unable to open/.test(e.message));
  } finally {
    delete openPlatform.override;
  }
  assert.ok(Date.now() - t0 < OPEN_RETRY_MS, "no retry window");
});

test("Windows: the retry window is a deadline: an attempt that runs past it is the last, and the bound is configurable", async () => {
  let attempts = 0;
  const t0 = performance.now();
  // an attempt as slow as SQLite's own synchronous retries inside one call: no second attempt starts after it
  await assert.rejects(openRetrying("x", async () => { attempts++; await sleepMs(OPEN_RETRY_MS + 50); throw ioerr(); }, "win32"), DatabaseHeldError);
  assert.equal(attempts, 1);
  assert.ok(performance.now() - t0 < OPEN_RETRY_MS + 500);
  attempts = 0;
  const t1 = performance.now();
  await assert.rejects(openRetrying("x", async () => { attempts++; throw ioerr(); }, "win32", 30), (e: Error) => /within 30 ms/.test(e.message));
  const took = performance.now() - t1;
  assert.ok(took >= 30 && took < 30 + 200, `${took} ms for a 30 ms bound`);
  assert.ok(attempts >= 2 && attempts <= 4, `${attempts} attempts`);
});

test("a connection whose setup fails while constructing is closed, not left open", async () => {
  const file = fresh();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const proto = DatabaseSync.prototype as unknown as { prepare(sql: string): unknown };
  const prepare = proto.prepare;
  let conn: DatabaseSync | undefined;
  proto.prepare = function (this: DatabaseSync, sql: string) {
    if (sql === "COMMIT") {
      conn = this;
      throw sqliteError(7, "out of memory");
    }
    return prepare.call(this, sql);
  };
  try {
    await assert.rejects(Db.open(file), /out of memory/);
  } finally {
    proto.prepare = prepare;
  }
  assert.equal(conn?.isOpen, false);
});

test("openRetryMs must be finite and not negative (NaN or Infinity would retry forever)", async () => {
  let attempts = 0;
  for (const bad of [NaN, Infinity, -1]) {
    await assert.rejects(openRetrying("x", async () => { attempts++; throw ioerr(); }, "win32", bad), TypeError);
    const file = fresh();
    await assert.rejects(openSqliteStore(file, { openRetryMs: bad }), /openRetryMs must be a finite number/);
    assert.ok(!fs.existsSync(path.dirname(path.dirname(file))), "refused before any folder was made");
  }
  assert.equal(attempts, 0, "refused before any attempt");
  let zero = 0;
  await assert.rejects(openRetrying("x", async () => { zero++; throw ioerr(); }, "win32", 0), DatabaseHeldError);
  assert.equal(zero, 1, "0 means one attempt, no retry");
});
