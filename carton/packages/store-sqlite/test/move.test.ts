// History follows a project whose placement changes (§6.4, L15; review round 1, finding 1): into a synced folder and
// back out again, with the abandoned copy fenced, interrupted moves finished, and two real histories never merged by
// guesswork.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { spawn, execFileSync } from "node:child_process";
import * as os from "node:os";
import { DatabaseSync } from "node:sqlite";
import { openProjectStore, openSqliteStore, MovedError, PlacementConflictError, UnwritableHistoryError, isThisMachine, machineMark, FORMAT_VERSION } from "../src/index.ts";
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
    await assert.rejects(openProjectStore(p), (e: unknown) => e instanceof UnwritableHistoryError && e.code === "CARTON_DB_UNWRITABLE" && e.path === p.inBundle);
    assertNothingPublished(p);
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

test("an opener paused between settling and opening is never overtaken by a move (the placement lock covers the open)", async () => {
  const p = project();
  const seed = await openProjectStore(p);
  await seed.store.write(put(1));
  await seed.store.close();
  let other: Promise<Awaited<ReturnType<typeof openProjectStore>>> | null = null;
  const first = await openProjectStore(p, {
    afterSettle: async () => {
      // While this opener sits between "settled: the bundle" and opening it, the folder becomes synced and another
      // open starts: it must wait for the lock, then move the history this opener now has open.
      p.startSyncing();
      other = openProjectStore(p);
      await new Promise((r) => setTimeout(r, 200));
    },
  });
  assert.equal(first.store.path, p.inBundle);
  const second = await other!;
  assert.equal(second.store.path, p.inAppData);
  assert.deepEqual(await seqs(second.store), [1], "the history moved, nothing was recreated empty");
  await assert.rejects(first.store.write(put(2)), MovedError, "the first opener's file is fenced, not a second history");
  await first.store.close();
  await second.store.close();
  const third = await openProjectStore(p);
  assert.deepEqual(await seqs(third.store), [1]);
  assert.ok(!fs.existsSync(p.inBundle), "and the old copy is gone once nobody has it open");
  await third.store.close();
});

test("a machine mark in the earlier form (the host hash alone) is still this machine's, and is upgraded", async () => {
  const p = project();
  const a = await openProjectStore(p);
  await a.store.write(put(1));
  await a.store.close();
  const raw = new DatabaseSync(p.inBundle);
  raw.prepare(`UPDATE "_carton" SET v = ? WHERE k = 'machine'`).run(JSON.stringify(machineMark().host));
  raw.close();
  const b = await openProjectStore(p);
  assert.equal(b.location.setAside, undefined, "not mistaken for another machine's");
  assert.deepEqual(await seqs(b.store), [1]);
  await b.store.close();
  const check = new DatabaseSync(p.inBundle, { readOnly: true });
  assert.deepEqual(JSON.parse((check.prepare(`SELECT v FROM "_carton" WHERE k = 'machine'`).get() as { v: string }).v), machineMark());
  check.close();
});

test("a source without a file id (an export) gets one before it is moved, so its copy always names it", async () => {
  const p = project();
  const elsewhere = await openSqliteStore(path.join(path.dirname(p.bundleDir), "elsewhere", "carton.db"));
  await elsewhere.write(put(1));
  await elsewhere.exportCopy(p.inBundle, []); // a full-history copy: no _carton rows at all
  await elsewhere.close();
  p.startSyncing();
  const b = await openProjectStore(p);
  assert.deepEqual(await seqs(b.store), [1]);
  const copyOf = JSON.parse((b.store.db.raw.prepare(`SELECT v FROM "_carton" WHERE k = 'copyOf'`).get() as { v: string }).v);
  assert.match(copyOf.dbId, /^[0-9a-f]{16}$/, "an interrupted move of it could be recognised");
  await b.store.close();
});

test("a crash right after publishing an export's copy: the source's id was committed first, and recovery keeps later writes", async () => {
  const p = project();
  const elsewhere = await openSqliteStore(path.join(path.dirname(p.bundleDir), "elsewhere", "carton.db"));
  await elsewhere.write(put(1));
  await elsewhere.exportCopy(p.inBundle, []); // no _carton rows: no file id yet
  await elsewhere.close();
  p.startSyncing();
  // A process moves it and dies between publishing the copy and marking the source.
  const src = new URL("../src/index.ts", import.meta.url).href;
  const code = `import { openProjectStore } from ${JSON.stringify(src)}; await openProjectStore(${JSON.stringify({ bundleDir: p.bundleDir, appDataDir: p.appDataDir, projectId: p.projectId })}, { afterPublish: () => process.exit(0) });`;
  const child = spawn(process.execPath, ["--input-type=module", "-e", code], { stdio: ["ignore", "ignore", "inherit"] });
  assert.equal(await new Promise((r) => child.on("exit", r)), 0);
  const meta = (file: string, k: string) => {
    const raw = new DatabaseSync(file, { readOnly: true });
    try {
      const row = raw.prepare(`SELECT v FROM "_carton" WHERE k = ?`).get(k) as { v: string } | undefined;
      return row ? JSON.parse(row.v) : undefined;
    } finally {
      raw.close();
    }
  };
  const sourceId = meta(p.inBundle, "dbId");
  assert.match(sourceId, /^[0-9a-f]{16}$/, "the source's id survived the crash: it was committed before the copy");
  assert.equal(meta(p.inAppData, "copyOf").dbId, sourceId, "and the published copy names it");
  assert.equal(meta(p.inBundle, "movedTo"), undefined, "the move was never confirmed");
  // The source is still the history: a write lands there before anyone reopens through openProjectStore.
  const late = await openSqliteStore(p.inBundle);
  await late.write(put(2));
  await late.close();
  const b = await openProjectStore(p);
  assert.equal(b.store.path, p.inAppData);
  assert.deepEqual(await seqs(b.store), [1, 2], "the unconfirmed copy was redone from the source, with its later write");
  await b.store.close();
});

// Nothing at the new place: no copy, and no partial file of one.
function assertNothingPublished(p: ReturnType<typeof project>) {
  assert.ok(!fs.existsSync(p.inAppData), "no copy at the new place");
  const dir = path.dirname(p.inAppData);
  const left = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.startsWith("carton.db")) : [];
  assert.deepEqual(left, [], "no partial copy either");
}

// The read-only file case on every OS: on Windows chmod 0o444 sets the read-only attribute, which is exactly what CI
// hit (BEGIN IMMEDIATE succeeds there; only the first real write is refused). Elsewhere it is the file's mode.
test("a read-only carton.db in a writable folder is refused with UnwritableHistoryError before anything is copied", { skip: process.getuid?.() === 0 ? "root ignores file permissions" : false }, async () => {
  const p = project();
  const a = await openProjectStore(p);
  await a.store.write(put(1));
  await a.store.close();
  fs.chmodSync(p.inBundle, 0o444);
  try {
    p.startSyncing();
    let published = 0;
    for (let i = 0; i < 2; i++) {
      await assert.rejects(openProjectStore(p, { afterPublish: () => void published++ }), (e: unknown) => e instanceof UnwritableHistoryError && /read-only|writable/.test((e as Error).message));
      assertNothingPublished(p);
    }
    assert.equal(published, 0, "refused before a copy was ever made, not cleaned up after");
  } finally {
    fs.chmodSync(p.inBundle, 0o644);
  }
  const b = await openProjectStore(p);
  assert.equal(b.store.path, p.inAppData, "made writable again: it moves");
  assert.deepEqual(await seqs(b.store), [1]);
  await b.store.close();
});

test("a read-only exported carton.db (no file id yet) is refused before its id or anything else is written", { skip: process.getuid?.() === 0 ? "root ignores file permissions" : false }, async () => {
  const p = project();
  const elsewhere = await openSqliteStore(path.join(path.dirname(p.bundleDir), "elsewhere", "carton.db"));
  await elsewhere.write(put(1));
  await elsewhere.exportCopy(p.inBundle, []);
  await elsewhere.close();
  fs.chmodSync(p.inBundle, 0o444);
  try {
    p.startSyncing();
    await assert.rejects(openProjectStore(p), UnwritableHistoryError);
    assertNothingPublished(p);
  } finally {
    fs.chmodSync(p.inBundle, 0o644);
  }
  const check = new DatabaseSync(p.inBundle, { readOnly: true });
  assert.equal(check.prepare(`SELECT count(*) AS n FROM "_carton"`).get()!.n, 0, "untouched: no id was written");
  check.close();
});

// Windows: an ACL that denies writing (the attribute clear). SQLite then quietly opens the file read-only.
test("Windows: a carton.db whose ACL denies writing is refused the same way", { skip: process.platform !== "win32" ? "Windows ACLs" : false }, async () => {
  const p = project();
  const a = await openProjectStore(p);
  await a.store.write(put(1));
  await a.store.close();
  const user = `${process.env.USERDOMAIN ? process.env.USERDOMAIN + "\\" : ""}${os.userInfo().username}`;
  execFileSync("icacls", [p.inBundle, "/deny", `${user}:(W)`], { stdio: "ignore", windowsHide: true });
  try {
    // Readable but not writable: the case only the write probe catches (access() doesn't read ACLs on Windows).
    const reader = new DatabaseSync(p.inBundle, { readOnly: true });
    assert.equal((reader.prepare("SELECT count(*) AS n FROM changes").get() as { n: number }).n, 1);
    reader.close();
    p.startSyncing();
    let published = 0;
    await assert.rejects(openProjectStore(p, { afterPublish: () => void published++ }), UnwritableHistoryError);
    assert.equal(published, 0, "refused before a copy was made");
    assertNothingPublished(p);
  } finally {
    execFileSync("icacls", [p.inBundle, "/remove:d", user], { stdio: "ignore", windowsHide: true });
  }
  const b = await openProjectStore(p);
  assert.deepEqual(await seqs(b.store), [1]);
  await b.store.close();
});

test("any failure after the copy is published (before the mark lands) takes the copy back; the source stays the history", async () => {
  const p = project();
  const a = await openProjectStore(p);
  await a.store.write(put(1));
  await a.store.close();
  p.startSyncing();
  await assert.rejects(openProjectStore(p, { afterPublish: () => { throw new Error("disk went away"); } }), /disk went away/);
  assertNothingPublished(p);
  const raw = new DatabaseSync(p.inBundle, { readOnly: true });
  assert.equal(raw.prepare(`SELECT count(*) AS n FROM "_carton" WHERE k = 'movedTo'`).get()!.n, 0, "the source was never marked");
  raw.close();
  const b = await openProjectStore(p);
  assert.equal(b.store.path, p.inAppData);
  assert.deepEqual(await seqs(b.store), [1], "the next open moves it normally");
  await b.store.close();
});

test("a refusal never deletes what is beside the file: a WAL holding a committed change survives", { skip: process.getuid?.() === 0 ? "root ignores file permissions" : false }, async () => {
  const p = project();
  const a = await openProjectStore(p);
  await a.store.write(put(1));
  await a.store.close();
  // Another process commits a change and exits without checkpointing: the change lives only in the -wal.
  const key = new URL("../src/key.ts", import.meta.url).href;
  const code = `import { DatabaseSync } from "node:sqlite"; import { encodeKey } from ${JSON.stringify(key)}; const d = new DatabaseSync(${JSON.stringify(p.inBundle)}); d.exec("PRAGMA wal_autocheckpoint=0"); d.prepare("INSERT INTO changes(k, v) VALUES (?, ?)").run(encodeKey(["main", 2]), JSON.stringify({ id: "r.2" })); process.exit(0);`;
  const child = spawn(process.execPath, ["--input-type=module", "-e", code], { stdio: ["ignore", "ignore", "inherit"] });
  assert.equal(await new Promise((r) => child.on("exit", r)), 0);
  const walBefore = fs.statSync(`${p.inBundle}-wal`).size;
  assert.ok(walBefore > 0);
  fs.chmodSync(p.inBundle, 0o444);
  try {
    p.startSyncing();
    await assert.rejects(openProjectStore(p), UnwritableHistoryError);
    assert.equal(fs.statSync(`${p.inBundle}-wal`).size, walBefore, "the -wal is untouched");
    assertNothingPublished(p);
  } finally {
    fs.chmodSync(p.inBundle, 0o644);
  }
  const b = await openProjectStore(p);
  assert.deepEqual(await seqs(b.store), [1, 2], "and its change moved with the rest");
  await b.store.close();
});

test("a write probe that aborts the whole transaction (SQLITE_FULL) reports that error, not a lost savepoint, and copies nothing", async () => {
  const p = project();
  const a = await openProjectStore(p);
  await a.store.write(put(1));
  await a.store.close();
  p.startSyncing();
  let published = 0;
  const err = await openProjectStore(p, {
    // The database may not grow by a single page: the probe's page-sized write fails with SQLITE_FULL.
    afterSourceLock: (raw) => {
      const pages = (raw.prepare("PRAGMA page_count").get() as { page_count: number }).page_count;
      raw.exec(`PRAGMA max_page_count=${pages}`);
    },
    afterPublish: () => void published++,
  }).catch((e) => e);
  assert.ok(err instanceof Error);
  assert.match(String(err.message), /full/i, String(err));
  assert.doesNotMatch(String(err.message), /savepoint/);
  assert.equal(published, 0);
  assertNothingPublished(p);
  const b = await openProjectStore(p);
  assert.equal(b.store.path, p.inAppData, "the next open moves it normally (the lock and connection were released)");
  assert.deepEqual(await seqs(b.store), [1]);
  await b.store.close();
});

test("a copy that can't be published (the rename fails) leaves no partial file and leaves the source the history", async () => {
  const p = project();
  const a = await openProjectStore(p);
  await a.store.write(put(1));
  await a.store.close();
  p.startSyncing();
  // A directory where the copy goes makes the rename itself fail (EISDIR / EPERM), the way an exhausted retry would.
  await assert.rejects(openProjectStore(p, { beforePublish: (to) => fs.mkdirSync(to, { recursive: true }) }));
  const dir = path.dirname(p.inAppData);
  assert.deepEqual(fs.readdirSync(dir).filter((f) => f.includes(".part-")), [], "no partial copy left behind");
  fs.rmdirSync(p.inAppData);
  const raw = new DatabaseSync(p.inBundle, { readOnly: true });
  assert.equal(raw.prepare(`SELECT count(*) AS n FROM "_carton" WHERE k = 'movedTo'`).get()!.n, 0, "the source was never marked");
  raw.close();
  const b = await openProjectStore(p);
  assert.deepEqual(await seqs(b.store), [1]);
  await b.store.close();
});

test("a read-only carton.db from another machine at the other place never blocks this machine's history", { skip: process.getuid?.() === 0 ? "root ignores file permissions" : false }, async () => {
  const p = project();
  p.startSyncing();
  const here = await openProjectStore(p); // this machine's history lives in app data
  await here.store.write(put(1));
  await here.store.close();
  // A synced-in carton.db made on another machine, read-only, in the bundle.
  const theirs = await openSqliteStore(p.inBundle);
  await theirs.write(put(7));
  theirs.db.raw.prepare(`UPDATE "_carton" SET v = ? WHERE k = 'machine'`).run(JSON.stringify({ id: "0".repeat(32), host: "fedcba9876543210" }));
  await theirs.close();
  fs.chmodSync(p.inBundle, 0o444);
  try {
    const b = await openProjectStore(p);
    assert.equal(b.store.path, p.inAppData);
    assert.deepEqual(await seqs(b.store), [1], "this machine's history opens");
    await b.store.close();
    assert.deepEqual(fs.readdirSync(path.dirname(p.inBundle)).filter((f) => f.startsWith("carton.db")), ["carton.db"], "nothing made beside theirs");
  } finally {
    fs.chmodSync(p.inBundle, 0o644);
  }
  const check = await openSqliteStore(p.inBundle, { readOnly: true });
  assert.deepEqual(await seqs(check), [7], "theirs untouched");
  await check.close();
});

test("a read-only carton.db with a pending -wal is refused even if it looks foreign: the -wal could say otherwise", { skip: process.getuid?.() === 0 ? "root ignores file permissions" : false }, async () => {
  const p = project();
  const a = await openProjectStore(p);
  await a.store.write(put(1));
  await a.store.close();
  const raw = new DatabaseSync(p.inBundle);
  raw.prepare(`UPDATE "_carton" SET v = ? WHERE k = 'machine'`).run(JSON.stringify({ id: "0".repeat(32), host: "fedcba9876543210" }));
  raw.close();
  const key = new URL("../src/key.ts", import.meta.url).href;
  const code = `import { DatabaseSync } from "node:sqlite"; import { encodeKey } from ${JSON.stringify(key)}; const d = new DatabaseSync(${JSON.stringify(p.inBundle)}); d.exec("PRAGMA wal_autocheckpoint=0"); d.prepare("INSERT INTO changes(k, v) VALUES (?, ?)").run(encodeKey(["main", 2]), JSON.stringify({ id: "r.2" })); process.exit(0);`;
  const child = spawn(process.execPath, ["--input-type=module", "-e", code], { stdio: ["ignore", "ignore", "inherit"] });
  assert.equal(await new Promise((r) => child.on("exit", r)), 0);
  fs.chmodSync(p.inBundle, 0o444);
  try {
    p.startSyncing();
    await assert.rejects(openProjectStore(p), UnwritableHistoryError);
    assertNothingPublished(p);
  } finally {
    fs.chmodSync(p.inBundle, 0o644);
  }
});
