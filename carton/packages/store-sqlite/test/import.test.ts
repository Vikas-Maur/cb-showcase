// An existing project comes in as main@1 (§16 Migration): one attributed insert-all change on an empty root.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { importProject, importChangeId, IMPORT_AUTHOR } from "../src/index.ts";
import { adapter, projectDoc } from "./import-fixture.ts";
import { scratch } from "./scratch.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = scratch("import");
after(() => fs.rmSync(root, { recursive: true, force: true }));
const names = (d: { items?: unknown }) => ((d.items ?? []) as { id: string }[]).map((i) => i.id).sort();

test("a project is imported as main@1: one insert-all change, credited to the import, on an empty root", async () => {
  const bundleDir = path.join(root, "Promo.cardboard");
  const r = await importProject({ bundleDir, projectId: "proj-1", adapter, host: projectDoc(), appDataDir: path.join(root, "appdata") });
  assert.equal(r.imported, true);
  assert.equal(r.location.placement, "bundle");
  assert.equal(r.store.path, path.join(bundleDir, ".carton", "carton.db"));
  const head = await r.carton.head();
  assert.equal(head.ref.seq, 1);
  assert.deepEqual(names(head.doc), ["a", "b"]);
  assert.equal(head.doc.name, "Promo");
  const log = await r.carton.log();
  assert.deepEqual(log.map((v) => v.ref.seq), [1, 0]);
  assert.equal(log[0].author?.id, IMPORT_AUTHOR.id);
  assert.equal(log[0].change, importChangeId("proj-1"));
  assert.equal(log[0].name, "Imported");
  assert.deepEqual(names(await r.carton.checkout({ branchId: head.ref.branchId, seq: 0 })), [], "main@0 is the empty root");
  assert.equal(r.carton.projectId, "proj-1");
  await r.carton.close();
  await r.store.close();

  // Opening again imports nothing: it is the same history.
  const again = await importProject({ bundleDir, projectId: "proj-1", adapter, host: { ...projectDoc(), name: "Changed on disk" }, appDataDir: path.join(root, "appdata") });
  assert.equal(again.imported, false);
  assert.equal((await again.carton.head()).ref.seq, 1);
  assert.equal((await again.carton.head()).doc.name, "Promo");
  await again.carton.close();
  await again.store.close();
});

test("four processes importing the same project at once record main@1 exactly once", async () => {
  const bundleDir = path.join(root, "Race.cardboard");
  const appDataDir = path.join(root, "appdata-race");
  const runs = await Promise.all(
    [0, 1, 2, 3].map(
      () =>
        new Promise<{ code: number | null; out: { imported: boolean; seq: number } | null }>((resolve) => {
          const child = spawn(process.execPath, [path.join(here, "import-worker.ts"), bundleDir, appDataDir], { stdio: ["ignore", "pipe", "inherit"] });
          let out = "";
          child.stdout.on("data", (d) => (out += d));
          child.on("exit", (code) => resolve({ code, out: code === 0 ? JSON.parse(out) : null }));
        }),
    ),
  );
  assert.deepEqual(runs.map((r) => r.code), [0, 0, 0, 0]);
  assert.deepEqual(runs.map((r) => r.out!.seq), [1, 1, 1, 1], "every process sees main@1 as head");
  assert.ok(runs.some((r) => r.out!.imported), "someone imported it");
  const r = await importProject({ bundleDir, appDataDir, projectId: "proj-race", adapter, host: projectDoc() });
  assert.deepEqual((await r.carton.log()).map((v) => v.ref.seq), [1, 0], "one import change, nothing more");
  assert.deepEqual(names((await r.carton.head()).doc), ["a", "b"]);
  await r.carton.close();
  await r.store.close();
});

test("a project in a synced folder is imported into app data, keyed by its id (L15)", async () => {
  const sync = path.join(root, "Dropbox");
  fs.mkdirSync(path.join(sync, ".dropbox.cache"), { recursive: true });
  const bundleDir = path.join(sync, "Promo.cardboard");
  fs.mkdirSync(bundleDir, { recursive: true });
  const r = await importProject({ bundleDir, projectId: "proj-sync", adapter, host: projectDoc(), appDataDir: path.join(root, "appdata") });
  assert.equal(r.location.placement, "cloud-sync");
  assert.equal(r.location.provider, "Dropbox");
  assert.equal(r.store.path, path.join(root, "appdata", "projects", "proj-sync", "carton.db"));
  assert.equal((await r.carton.head()).ref.seq, 1);
  assert.ok(!fs.existsSync(path.join(bundleDir, ".carton")));
  await r.carton.close();
  await r.store.close();
});

test("Carton on carton.db: three processes committing at once all confirm, and history has every change once", async () => {
  const bundleDir = path.join(root, "Busy.cardboard");
  const appDataDir = path.join(root, "appdata-busy");
  const N = 25;
  const runs = await Promise.all(
    ["w0", "w1", "w2"].map(
      (w) =>
        new Promise<{ code: number | null; out: { statuses: string[] } | null }>((resolve) => {
          const child = spawn(process.execPath, [path.join(here, "carton-worker.ts"), bundleDir, appDataDir, w, String(N)], { stdio: ["ignore", "pipe", "inherit"] });
          let out = "";
          child.stdout.on("data", (d) => (out += d));
          child.on("exit", (code) => resolve({ code, out: code === 0 ? JSON.parse(out) : null }));
        }),
    ),
  );
  assert.deepEqual(runs.map((r) => r.code), [0, 0, 0]);
  for (const r of runs) assert.deepEqual(r.out!.statuses, ["confirmed"]);
  const r = await importProject({ bundleDir, appDataDir, projectId: "proj-carton", adapter, host: projectDoc() });
  const head = await r.carton.head();
  assert.equal(head.ref.seq, 1 + 3 * N, "main@1 plus every commit, none lost");
  const a = (head.doc.items as Record<string, unknown>[]).find((i) => i.id === "a")!;
  assert.deepEqual([a.note_w0, a.note_w1, a.note_w2], [N - 1, N - 1, N - 1]);
  const log = await r.carton.log({ limit: 1000 });
  assert.equal(new Set(log.map((v) => v.change)).size, log.length, "no change recorded twice");
  await r.carton.close();
  await r.store.close();
});
