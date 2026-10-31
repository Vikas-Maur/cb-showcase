// store-sqlite beyond the shared Store suite: the file format, the export copy, space reclaim, paths, and failure
// modes that only a real database file has.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { openSqliteStore, openProjectStore, BusyError, FORMAT_VERSION } from "../src/index.ts";
import { scratch } from "./scratch.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = scratch("store");
after(() => fs.rmSync(root, { recursive: true, force: true }));
let n = 0;
const fresh = () => path.join(root, `s${++n}`, ".carton", "carton.db");
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
  ]);
  const names = (s.db.raw.prepare("SELECT name FROM sqlite_schema WHERE type = 'table' ORDER BY name").all() as { name: string }[]).map((r) => r.name);
  assert.deepEqual(names, ["_carton", "_t_612d622063", "_t_73716c6974655f78", "changes", "path$map", "pathmap"]);
  assert.equal(await s.get("pathMap", ["p"]), 1);
  assert.equal(await s.get("pathmap", ["p"]), 2);
  assert.equal(await s.get("a-b c", ["k"]), 3);
  assert.equal(await s.get("sqlite_x", ["k"]), 4);
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
  assert.ok(!fs.existsSync(`${out}-wal`));
  await s.close();
});

test("reclaim gives the pages of pruned keyframes back to the disk", async () => {
  const file = fresh();
  const s = await openSqliteStore(file);
  const big = { items: Array.from({ length: 200 }, (_, i) => ({ id: `i${i}`, text: "x".repeat(100) })) };
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
  let maxStall = 0, last = performance.now();
  const beat = setInterval(() => { const now = performance.now(); maxStall = Math.max(maxStall, now - last); last = now; }, 2);
  const t0 = performance.now();
  const err = await s.write([{ table: "changes", key: ["main", 9], value: { id: "mine" } }]).catch((e) => e);
  const took = performance.now() - t0;
  clearInterval(beat);
  assert.ok(err instanceof BusyError, String(err));
  assert.equal(err.code, "CARTON_DB_BUSY");
  assert.ok(took >= 140 && took < 700, `gave up after ${Math.round(took)} ms`);
  assert.ok(maxStall < 100, `event loop stalled ${maxStall} ms`);
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
