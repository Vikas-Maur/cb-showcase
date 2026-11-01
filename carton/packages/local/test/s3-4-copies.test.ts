// e2e-qa's S3-4 at the package level (verify-ci found it regressed with `781a863`, a new project's starting state as
// `main@1`, an Import change): a teammate's project is a copy of yours (the folder copied with its carton.db), they
// edit and send a `.cbproj`; bringing it in must fold their edit in cleanly. A shallow export compresses a cut's
// lineage to its root, forks, merges and exports: with the starting state in `main@1` and an empty root at `main@0`,
// the common base found was the empty root, so every record read as added on both sides, and a field both copies hold
// at different values became a card with no base. Also: two copies of one project folder, each opened on its own
// (no shared carton.db), then one brought into the other.
import { test } from "node:test";
import assert from "node:assert/strict";
import { cpSync, mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { Actor, Rec } from "@carton/core";
import { bringInTheirChanges } from "@carton/cardboard/node";
import { openSqliteStore } from "@carton/store-sqlite";
import { openLocal } from "../src/open.ts";
import { adapter, bundle, doc0 } from "./support/real.ts";
import { scratch } from "./support/scratch.ts";

const person = (id: string, name: string): Actor => ({ kind: "human", id: `human:${id}`, name, group: `${id}@pc` });
const set = (id: string, f: string, value: unknown) => ({ op: "set" as const, path: ["timelineItems", id, f], value });
const item = (doc: { timelineItems?: unknown }, id: string) => (doc.timelineItems as Rec[]).find((i) => i.id === id)!;
const LOCAL = ["pending", "pins", "notices", "views", "ephemeral", "lease", "pathMap"];

/** Alice's project, opened once (it gets its carton.db); `dataDir` keeps carton.db outside the bundle. */
async function alices(name: string) {
  const { dir, projectId } = bundle(name);
  const dataDir = mkdtempSync(join(scratch(), `${name}-data-`));
  const a = await openLocal({ projectDir: dir, projectId, dataDir, adapter, init: { doc: doc0() }, actor: person("alice", "Alice"), name: "Alice" });
  const dbPath = a.dbPath;
  await a.close();
  return { dir, projectId, dataDir, dbPath };
}

test("S3-4: a .cbproj from a teammate whose project is a copy of yours (carton.db and all) folds their edit in, no card", async () => {
  const A = await alices("s34-a");
  // Bob's machine: the project folder copied, and its carton.db with it (store-sqlite's copy, local tables dropped)
  const bDir = mkdtempSync(join(scratch(), "s34-b-"));
  cpSync(join(A.dir, "project.json"), join(bDir, "project.json"));
  const bData = mkdtempSync(join(scratch(), "s34-b-data-"));
  const probe = await openLocal({ projectDir: bDir, projectId: A.projectId, dataDir: bData, adapter, init: { doc: doc0() }, actor: person("bob", "Bob"), name: "Bob" });
  const bDb = probe.dbPath;
  await probe.close();
  const src = await openSqliteStore(A.dbPath);
  try {
    mkdirSync(join(bDb, ".."), { recursive: true });
    for (const f of [bDb, `${bDb}-wal`, `${bDb}-shm`]) rmSync(f, { force: true });
    await src.exportCopy(bDb, LOCAL);
  } finally {
    await src.close();
  }
  const b = await openLocal({ projectDir: bDir, projectId: A.projectId, dataDir: bData, adapter, actor: person("bob", "Bob"), name: "Bob" });
  let theirs;
  try {
    assert.equal((await b.write({ kind: "commit", ops: [set("c2", "opacity", 0.4)] })).status, "confirmed");
    theirs = await b.carton.exportShallow({ to: "alice" });
  } finally {
    await b.close();
  }
  const a = await openLocal({ projectDir: A.dir, projectId: A.projectId, dataDir: A.dataDir, adapter, actor: person("alice", "Alice"), name: "Alice" });
  try {
    const r = await bringInTheirChanges(a.carton as never, { shallow: theirs });
    assert.equal(r.status, "folded", JSON.stringify(r));
    const fold = (r as { fold?: { status: string; cards?: unknown[] } }).fold!;
    assert.equal(fold.status, "confirmed", `a clean fold, no card: ${JSON.stringify(fold)}`);
    const head = (await a.carton.head()).doc;
    assert.equal(item(head, "c2").opacity, 0.4, "Bob's edit is in");
    assert.equal(item(head, "c3").name, "c3", "the rest as it was");
  } finally {
    await a.close();
  }
});

test("two copies of one project folder, each opened on its own (no shared carton.db): bringing one into the other says why", async () => {
  const A = await alices("s34-sep-a");
  // Bob copied the folder before it had a carton.db and opened it himself
  const bDir = mkdtempSync(join(scratch(), "s34-sep-b-"));
  cpSync(join(A.dir, "project.json"), join(bDir, "project.json"));
  const b = await openLocal({ projectDir: bDir, projectId: A.projectId, dataDir: mkdtempSync(join(scratch(), "s34-sep-b-data-")), adapter, init: { doc: doc0() }, actor: person("bob", "Bob"), name: "Bob" });
  let theirs;
  try {
    assert.equal((await b.write({ kind: "commit", ops: [set("c2", "opacity", 0.4)] })).status, "confirmed");
    theirs = await b.carton.exportShallow({ to: "alice" });
  } finally {
    await b.close();
  }
  const a = await openLocal({ projectDir: A.dir, projectId: A.projectId, dataDir: A.dataDir, adapter, actor: person("alice", "Alice"), name: "Alice" });
  try {
    // their cut ids are their own (no carton.db was copied): nothing is shared to fold from, and it says so, as it did
    // before the import change (a starting state both made alike doesn't make one history)
    const r = await bringInTheirChanges(a.carton as never, { shallow: theirs });
    assert.equal(r.status, "no-shared-lineage", JSON.stringify(r));
    assert.equal(item((await a.carton.head()).doc, "c2").opacity, 1, "nothing changed here");
  } finally {
    await a.close();
  }
});
