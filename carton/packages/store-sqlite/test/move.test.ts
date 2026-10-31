// History follows a project whose placement changes (§6.4, L15; review round 1, finding 1): into a synced folder and
// back out again, with the abandoned copy fenced, interrupted moves finished, and two real histories never merged by
// guesswork.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { spawn } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { openProjectStore, openSqliteStore, MovedError, PlacementConflictError, isThisMachine, machineMark, FORMAT_VERSION } from "../src/index.ts";
import { scratch } from "./scratch.ts";

const root = scratch("move");
after(() => fs.rmSync(root, { recursive: true, force: true }));
let n = 0;

function project() {
  const base = path.join(root, `case-${++n}`);
  const sync = path.join(base, "Sync");
  const bundleDir = path.join(sync, "Promo.cardboard");
  fs.mkdirSync(bundleDir, { recursive: true });
  const appDataDir = path.join(base, "appdata");
  return {
    bundleDir,
    appDataDir,
    projectId: `proj-${n}`,
    inBundle: path.join(bundleDir, ".carton", "carton.db"),
    inAppData: path.join(appDataDir, "projects", `proj-${n}`, "carton.db"),
    startSyncing: () => fs.mkdirSync(path.join(sync, ".stfolder")), // Syncthing's root marker
    stopSyncing: () => fs.rmSync(path.join(sync, ".stfolder"), { recursive: true }),
  };
}
const seqs = async (s: { range: (t: string, r: object) => Promise<{ key: readonly (string | number)[] }[]> }) => (await s.range("changes", { prefix: ["main"] })).map((r) => r.key[1]);
const put = (seq: number) => [{ table: "changes", key: ["main", seq], value: { id: `r.${seq}` } }];

test("into a synced folder and back: the history moves both ways and nothing is lost", async () => {
  const p = project();
  const a = await openProjectStore(p);
  assert.equal(a.location.placement, "bundle");
  for (const i of [1, 2, 3]) await a.store.write(put(i));
  await a.store.write([{ table: "pathMap", key: ["m"], value: "/Users/ana/x.mov" }]);
  await a.store.close();

  p.startSyncing();
  const b = await openProjectStore(p);
  assert.equal(b.location.placement, "cloud-sync");
  assert.equal(b.store.path, p.inAppData);
  assert.deepEqual(await seqs(b.store), [1, 2, 3], "the history came along");
  assert.equal(await b.store.get("pathMap", ["m"]), "/Users/ana/x.mov", "local tables too: same machine");
  await b.store.write(put(4));
  await b.store.close();
  assert.ok(!fs.existsSync(p.inBundle), "no database left in the synced folder for the sync client to upload");

  p.stopSyncing();
  const c = await openProjectStore(p);
  assert.equal(c.location.placement, "bundle");
  assert.deepEqual(await seqs(c.store), [1, 2, 3, 4], "back in the bundle with what was added meanwhile, not the stale copy");
  await c.store.write(put(5));
  await c.store.close();
  assert.ok(!fs.existsSync(p.inAppData), "the app-data copy went away once moved back");

  const d = await openProjectStore(p);
  assert.deepEqual(await seqs(d.store), [1, 2, 3, 4, 5], "settled: opening again moves nothing");
  await d.store.close();
});

test("a process that still has the old file open can't write into the abandoned history", async () => {
  const p = project();
  const early = await openProjectStore(p);
  await early.store.write(put(1));
  p.startSyncing();
  const moved = await openProjectStore(p);
  assert.equal(moved.store.path, p.inAppData);
  await assert.rejects(early.store.write(put(2)), MovedError);
  assert.deepEqual(await seqs(moved.store), [1]);
  assert.ok(fs.existsSync(p.inBundle), "kept while a process has it open");
  await assert.rejects(openSqliteStore(p.inBundle), (e: unknown) => e instanceof MovedError && e.to === p.inAppData);
  await early.store.close();
  await moved.store.close();
  (await openProjectStore(p)).store.close();
  assert.ok(!fs.existsSync(p.inBundle), "deleted at the next open, once nobody has it open");
});

test("a carton.db another machine made (it arrived through a sync client) is left alone, never adopted", async () => {
  const p = project();
  const a = await openProjectStore(p);
  await a.store.write(put(1));
  await a.store.close();
  const raw = new DatabaseSync(p.inBundle);
  raw.prepare(`UPDATE "_carton" SET v = ? WHERE k = 'machine'`).run(JSON.stringify("0123456789abcdef"));
  raw.close();
  p.startSyncing();
  const b = await openProjectStore(p);
  assert.equal(b.store.path, p.inAppData);
  assert.deepEqual(await seqs(b.store), [], "a fresh history here; the bundle's project.json comes in as an external change (L15)");
  await b.store.close();
  assert.ok(fs.existsSync(p.inBundle), "and the other machine's file is not touched");
});

test("two separate histories are never merged or dropped by guesswork", async () => {
  const p = project();
  const a = await openProjectStore(p);
  await a.store.write(put(1));
  await a.store.close();
  const b = await openSqliteStore(p.inAppData); // another history at the other place, not a moved copy
  await b.write(put(7));
  await b.close();
  p.startSyncing();
  await assert.rejects(openProjectStore(p), (e: unknown) => e instanceof PlacementConflictError && e.paths.includes(p.inAppData) && e.paths.includes(p.inBundle));
  const check = [await openSqliteStore(p.inBundle), await openSqliteStore(p.inAppData)];
  assert.deepEqual([await seqs(check[0]), await seqs(check[1])], [[1], [7]], "both kept as they were");
  for (const s of check) await s.close();
});

test("an interrupted move (copy in place, old file never marked) is redone from the old file, which stayed the history", async () => {
  const p = project();
  const a = await openProjectStore(p);
  await a.store.write(put(1));
  // The state a crash between "rename the copy into place" and "mark the old file" leaves: a copy that says whose
  // copy it is, and an old file without the mark, which kept taking writes.
  await a.store.exportCopy(p.inAppData, []);
  const dbId = (a.store.db.raw.prepare(`SELECT v FROM "_carton" WHERE k = 'dbId'`).get() as { v: string }).v;
  const copy = new DatabaseSync(p.inAppData);
  copy.prepare(`INSERT INTO "_carton"(k, v) VALUES ('copyOf', ?)`).run(JSON.stringify({ path: p.inBundle, token: "0badc0de0badc0de", dbId: JSON.parse(dbId) }));
  copy.close();
  await a.store.write(put(2));
  await a.store.close();
  p.startSyncing();
  const b = await openProjectStore(p);
  assert.equal(b.store.path, p.inAppData);
  assert.deepEqual(await seqs(b.store), [1, 2], "the unconfirmed copy was replaced by a fresh one");
  await b.store.close();
});

test("moving back over an old copy that another process still has open is refused, and nothing is touched", async () => {
  const p = project();
  const a = await openProjectStore(p);
  await a.store.write(put(1));
  await a.store.close();
  // Another process holds the bundle's carton.db open (idle) through the move out and the attempt to move back.
  const holder = spawn(process.execPath, ["--input-type=module", "-e", `import { DatabaseSync } from "node:sqlite"; const d = new DatabaseSync(${JSON.stringify(p.inBundle)}); d.prepare("SELECT 1").get(); process.stdout.write("open\\n"); setTimeout(() => d.close(), 3000);`], { stdio: ["ignore", "pipe", "inherit"] });
  await new Promise<void>((r) => holder.stdout.on("data", () => r()));
  p.startSyncing();
  const b = await openProjectStore(p);
  await b.store.write(put(2));
  await b.store.close();
  assert.ok(fs.existsSync(p.inBundle), "the old copy stays while it is open");
  p.stopSyncing();
  await assert.rejects(openProjectStore(p), /still open in another program/);
  const appData = await openSqliteStore(p.inAppData);
  assert.deepEqual(await seqs(appData), [1, 2], "the current history is untouched");
  await appData.close();
  await new Promise((r) => holder.on("exit", r));
  const c = await openProjectStore(p);
  assert.equal(c.store.path, p.inBundle);
  assert.deepEqual(await seqs(c.store), [1, 2]);
  await c.store.close();
});

test("several processes opening a project whose placement just changed move it once", async () => {
  const p = project();
  const a = await openProjectStore(p);
  for (let i = 1; i <= 50; i++) await a.store.write(put(i));
  await a.store.close();
  p.startSyncing();
  // A file: URL, not a path: an ES import of "C:\\…" fails on Windows.
  const src = new URL("../src/index.ts", import.meta.url).href;
  const runs = await Promise.all(
    [0, 1, 2, 3].map(
      (w) =>
        new Promise<{ code: number | null; err: string }>((resolve) => {
          const code = `import { openProjectStore } from ${JSON.stringify(src)}; const r = await openProjectStore(${JSON.stringify({ bundleDir: p.bundleDir, appDataDir: p.appDataDir, projectId: p.projectId })}); await r.store.write([{ table: "changes", key: ["main", 100 + ${w}], value: {} }]); await r.store.close();`;
          const child = spawn(process.execPath, ["--input-type=module", "-e", code], { stdio: ["ignore", "ignore", "pipe"] });
          let err = "";
          child.stderr.on("data", (d) => (err += d));
          child.on("exit", (c) => resolve({ code: c, err }));
        }),
    ),
  );
  assert.deepEqual(runs.map((r) => r.code), [0, 0, 0, 0], runs.map((r) => r.err).join("\n"));
  const s = await openSqliteStore(p.inAppData);
  assert.deepEqual(await seqs(s), [...Array.from({ length: 50 }, (_, i) => i + 1), 100, 101, 102, 103], "one move; every process wrote into the moved history");
  await s.close();
});

test("a source recreated after its cleanup (empty, or a new unrelated history) never destroys the moved history", async () => {
  const p = project();
  const a = await openProjectStore(p);
  for (const i of [1, 2]) await a.store.write(put(i));
  await a.store.close();
  p.startSyncing();
  (await openProjectStore(p)).store.close();
  assert.ok(!fs.existsSync(p.inBundle), "moved and cleaned up");
  // A stray opener recreates the old path: first as an empty file, then as a fresh carton.db of its own.
  new DatabaseSync(p.inBundle).close();
  let b = await openProjectStore(p);
  assert.deepEqual(await seqs(b.store), [1, 2], "an empty file at the old place is ignored");
  await b.store.close();
  fs.rmSync(p.inBundle);
  const stray = await openSqliteStore(p.inBundle);
  await stray.write(put(99));
  await stray.close();
  await assert.rejects(openProjectStore(p), PlacementConflictError, "a different file is a second history, never an interrupted move");
  b = { store: await openSqliteStore(p.inAppData), location: b.location };
  assert.deepEqual(await seqs(b.store), [1, 2], "and the moved history is intact");
  await b.store.close();
});

test("a history Carton can't write is never copied as if it were frozen", { skip: process.getuid?.() === 0 ? "root ignores file permissions" : false }, async () => {
  const p = project();
  const a = await openProjectStore(p);
  await a.store.write(put(1));
  await a.store.close();
  const dir = path.dirname(p.inBundle);
  fs.chmodSync(p.inBundle, 0o444);
  fs.chmodSync(dir, 0o555);
  try {
    p.startSyncing();
    await assert.rejects(openProjectStore(p), /can't write/);
    assert.ok(!fs.existsSync(p.inAppData), "nothing published at the new place");
  } finally {
    fs.chmodSync(dir, 0o755);
    fs.chmodSync(p.inBundle, 0o644);
  }
  const check = await openSqliteStore(p.inBundle);
  assert.deepEqual(await seqs(check), [1]);
  await check.close();
});

test("a carton.db of a newer format is never moved, rewritten or deleted", async () => {
  const p = project();
  const a = await openProjectStore(p);
  await a.store.write(put(1));
  await a.store.close();
  const raw = new DatabaseSync(p.inBundle);
  raw.exec(`PRAGMA user_version=${FORMAT_VERSION + 1}; CREATE TABLE future(x, y, z)`);
  raw.close();
  p.startSyncing();
  await assert.rejects(openProjectStore(p), /newer Carton/);
  assert.ok(!fs.existsSync(p.inAppData));
  const check = new DatabaseSync(p.inBundle, { readOnly: true });
  assert.equal((check.prepare("PRAGMA user_version").get() as { user_version: number }).user_version, FORMAT_VERSION + 1);
  assert.ok(check.prepare("SELECT 1 FROM sqlite_schema WHERE name = 'future'").get(), "its own tables are untouched");
  check.close();
});

test("tables whose names merely look like SQLite's own (sqlitecache) move and export with the rest", async () => {
  const p = project();
  const a = await openProjectStore(p);
  await a.store.write([...put(1), { table: "sqlitecache", key: ["k"], value: "kept" }]);
  await a.store.exportCopy(path.join(path.dirname(p.bundleDir), "export.db"), []);
  await a.store.close();
  const exp = await openSqliteStore(path.join(path.dirname(p.bundleDir), "export.db"), { readOnly: true });
  assert.equal(await exp.get("sqlitecache", ["k"]), "kept");
  await exp.close();
  p.startSyncing();
  const b = await openProjectStore(p);
  assert.equal(await b.store.get("sqlitecache", ["k"]), "kept");
  await b.store.close();
});

test("a carton.db another machine made, found where this project's history goes, is set aside, never adopted", async () => {
  const p = project();
  const a = await openProjectStore(p);
  await a.store.write([...put(1), { table: "pathMap", key: ["m"], value: "D:\\their\\footage.mov" }]);
  await a.store.close();
  const raw = new DatabaseSync(p.inBundle);
  raw.prepare(`UPDATE "_carton" SET v = ? WHERE k = 'machine'`).run(JSON.stringify({ id: "0".repeat(32), host: "fedcba9876543210" }));
  raw.close();
  const b = await openProjectStore(p);
  assert.equal(b.location.placement, "bundle");
  assert.ok(b.location.setAside && fs.existsSync(b.location.setAside) && /carton\.from-fedcba98-/.test(b.location.setAside));
  assert.deepEqual(await seqs(b.store), [], "a fresh history of this machine's own");
  assert.equal(await b.store.get("pathMap", ["m"]), undefined, "none of their local tables");
  await b.store.close();
  const theirs = await openSqliteStore(b.location.setAside!, { readOnly: true });
  assert.deepEqual(await seqs(theirs), [1], "theirs is kept whole for the host to offer");
  await theirs.close();
});

test("this machine is recognised by its install id or its host, so renaming the computer or wiping app data alone changes nothing", () => {
  const me = machineMark();
  assert.ok(isThisMachine(me));
  assert.ok(isThisMachine({ id: me.id, host: "renamed-computer" }), "computer renamed");
  assert.ok(isThisMachine({ id: "f".repeat(32), host: me.host }), "app data wiped");
  assert.ok(!isThisMachine({ id: "f".repeat(32), host: "0123456789abcdef" }), "another machine");
  assert.ok(isThisMachine(undefined), "no mark (an export, an older file)");
  assert.equal(machineMark(), me, "stable for the process");
});
