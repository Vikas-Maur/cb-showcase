// Regressions from Stage G review round 2 (GPT 6.1 Sol):
//   - #1: the follower's retry of a failed notification (round 1 #5) ran before it read the store and repeated the
//     call it had failed, captured cut and all. A listener that kept failing held up every later look (another
//     process's newer switch was never adopted), and a retry after the app had switched away itself told it about the
//     cut it had left.
//   - #2: a project whose opener stopped between core's import and the starting-state mark (S3-4) was marked again
//     only by an open with `init` while nothing was written since: a `cb` open (no init) and its edit made the mark
//     impossible, and a copy of that carton.db folded from the empty root (a record card, base null). Since core made
//     the import a lineage point itself (request 8, `1423f0d`) there is no mark: these check that a copy of such a
//     project folds cleanly, and that opening it writes no export row.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { Carton } from "@carton/core";
import type { Actor, Rec } from "@carton/core";
import { bringInTheirChanges } from "@carton/cardboard/node";
import { openProjectStore, openSqliteStore } from "@carton/store-sqlite";
import { followStore } from "../src/follow.ts";
import { CartonHolderEngine, openLocal } from "../src/open.ts";
import { adapter, bundle, doc0 } from "./support/real.ts";
import { scratch } from "./support/scratch.ts";

const actor: Actor = { kind: "agent", id: "reviewG2", name: "Review", group: "reviewG2" };
const person = (id: string, name: string): Actor => ({ kind: "human", id: `human:${id}`, name, group: `${id}@pc` });
const set = (id: string, f: string, value: unknown) => ({ op: "set" as const, path: ["timelineItems", id, f], value });
const item = (doc: { timelineItems?: unknown }, id: string) => (doc.timelineItems as Rec[]).find((i) => i.id === id)!;
const LOCAL = ["pending", "pins", "notices", "views", "ephemeral", "lease", "pathMap"];

/** Two handles on one carton.db (as two processes have), a cut "Alt", and the first handle on main. */
async function twoHandles(name: string) {
  const path = join(mkdtempSync(join(scratch(), `${name}-`)), "carton.db");
  const s = await openSqliteStore(path), os = await openSqliteStore(path);
  const c = await Carton.open({ adapter, store: s, actor, init: { doc: doc0() } });
  const other = await Carton.open({ adapter, store: os, actor });
  const main = c.cut, alt = (await c.fork("Alt")).id;
  return { s, os, c, other, main, alt, close: async () => { await other.close(); await c.close(); await os.close(); await s.close(); } };
}

test("SG2-1: a listener that keeps failing for one cut never holds up adopting a newer switch", async () => {
  const { s, c, other, main, alt, close } = await twoHandles("sg2-starve");
  const told: string[] = [];
  const errors: string[] = [];
  const f = followStore(c, s, {
    intervalMs: 0,
    onHead: () => {},
    onCut: (cut) => { told.push(cut === alt ? "Alt" : "Main"); if (cut === alt) throw new Error("the Alt listener is down"); },
    onError: (e) => errors.push(String(e)),
  })!;
  try {
    await f.check();
    await other.switchTo(alt);
    await f.check();
    assert.equal(c.cut, alt, "adopted Alt (its notice failed)");
    await other.switchTo(main);
    await f.check();
    await f.check();
    assert.equal(c.cut, main, "the newer switch is adopted though the old notice still fails");
    assert.deepEqual(told, ["Alt", "Main"], "Main told once; the notice for Alt, a cut the handle has left, is dropped");
  } finally {
    await f.stop();
    await close();
  }
});

test("SG2-1: a failed cut notice is never told after the app switched away itself; while it stays, it is told again", async () => {
  const { c, other, main, alt, close } = await twoHandles("sg2-stale");
  let fail = 0;
  const notices: { event: string; actual: string }[] = [];
  const name = (cut: string) => (cut === main ? "Main" : "Alt");
  const engine = new CartonHolderEngine(c, {
    follow: { intervalMs: 0 },
    onExternal: (e) => { if (fail > 0) { fail--; throw new Error("listener failed once"); } notices.push({ event: name(e.cut), actual: name(c.cut) }); },
  });
  try {
    await engine.nudge();
    // another process switches to Alt; telling it fails once
    fail = 1;
    await other.switchTo(alt);
    await engine.nudge();
    assert.equal(c.cut, alt);
    assert.deepEqual(notices, []);
    // still on Alt: the next look tells it
    await engine.nudge();
    assert.deepEqual(notices, [{ event: "Alt", actual: "Alt" }]);
    // again, failing once, and then the app serves a switch back to main before the next look
    notices.length = 0;
    await engine.serve({ id: "sg2.back", actor, op: { kind: "switch", cut: main } });
    fail = 1;
    await other.switchTo(alt);
    await engine.nudge();
    assert.equal(c.cut, alt);
    await engine.serve({ id: "sg2.back2", actor, op: { kind: "switch", cut: main } });
    await engine.nudge();
    assert.deepEqual(notices, [], "nothing about Alt once the app is on main");
  } finally {
    await engine.close();
    await close();
  }
});

/** A project folder, and where openLocal keeps its carton.db (outside the folder). */
function project(name: string) {
  return { ...bundle(name), dataDir: mkdtempSync(join(scratch(), `${name}-data-`)) };
}
/** A project core created on its own (main@1, the import), as one whose opener stopped right after the import. */
async function coreMade(p: ReturnType<typeof project>) {
  const { store } = await openProjectStore({ bundleDir: p.dir, projectId: p.projectId, appDataDir: p.dataDir });
  const c = await Carton.open({ adapter, store, actor, init: { doc: doc0(), projectId: p.projectId, asChange: true } });
  return { c, store, close: async () => { await c.close(); await store.close(); } };
}
const exportRows = async (p: ReturnType<typeof project>) => {
  const a = await openProjectStore({ bundleDir: p.dir, projectId: p.projectId, appDataDir: p.dataDir });
  try { return (await a.store.range("meta", { prefix: ["export"] })).map((r) => String(r.key[1])); } finally { await a.store.close(); }
};
/** Bob's copy of Alice's folder, carton.db and all; he edits c2 and sends a `.cbproj`; Alice brings it in. */
async function copyAndBringIn(A: ReturnType<typeof project>) {
  const a0 = await openLocal({ projectDir: A.dir, projectId: A.projectId, dataDir: A.dataDir, adapter, actor: person("alice", "Alice"), name: "Alice" });
  const aDb = a0.dbPath;
  await a0.close();
  const B = project("sg2-bob");
  const probe = await openLocal({ projectDir: B.dir, projectId: A.projectId, dataDir: B.dataDir, adapter, init: { doc: doc0() }, actor: person("bob", "Bob"), name: "Bob" });
  const bDb = probe.dbPath;
  await probe.close();
  const src = await openSqliteStore(aDb);
  try {
    mkdirSync(join(bDb, ".."), { recursive: true });
    for (const f of [bDb, `${bDb}-wal`, `${bDb}-shm`]) rmSync(f, { force: true });
    await src.exportCopy(bDb, LOCAL);
  } finally {
    await src.close();
  }
  const b = await openLocal({ projectDir: B.dir, projectId: A.projectId, dataDir: B.dataDir, adapter, actor: person("bob", "Bob"), name: "Bob" });
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
    return { r, head: (await a.carton.head()).doc };
  } finally {
    await a.close();
  }
}

test("SG2-2: a project core made, opened by a `cb` (no init) that edits: no export row is written; a copy folds cleanly", async () => {
  const A = project("sg2-cb");
  const raw = await coreMade(A);
  await raw.close();
  // a cb call opens without init, and edits
  const cb = await openLocal({ projectDir: A.dir, projectId: A.projectId, dataDir: A.dataDir, adapter, actor });
  try {
    assert.equal((await cb.write({ kind: "commit", ops: [set("c1", "opacity", 0.7)] })).status, "confirmed");
  } finally {
    await cb.close();
  }
  assert.deepEqual(await exportRows(A), [], "opening writes no export row: the import is a lineage point by itself (core)");
  const { r, head } = await copyAndBringIn(A);
  assert.equal(r.status, "folded", JSON.stringify(r));
  assert.equal((r as { fold?: { status: string } }).fold!.status, "confirmed", JSON.stringify(r));
  assert.equal(item(head, "c2").opacity, 0.4, "Bob's edit is in");
  assert.equal(item(head, "c1").opacity, 0.7, "and Alice's kept");
});

test("SG2-2: written past the starting version by a writer that doesn't open through openLocal: a copy folds cleanly; no export row", async () => {
  const A = project("sg2-late");
  const raw = await coreMade(A);
  // a writer that doesn't open through openLocal
  assert.equal((await raw.c.commit({ ops: [set("c1", "opacity", 0.7)] })).status, "confirmed");
  await raw.close();
  const a = await openLocal({ projectDir: A.dir, projectId: A.projectId, dataDir: A.dataDir, adapter, actor, init: { doc: doc0() } });
  await a.close();
  const again = await openLocal({ projectDir: A.dir, projectId: A.projectId, dataDir: A.dataDir, adapter, actor });
  try {
    assert.equal((await again.write({ kind: "commit", ops: [set("c3", "opacity", 0.2)] })).status, "confirmed");
  } finally {
    await again.close();
  }
  assert.deepEqual(await exportRows(A), [], "no open writes an export row");
  const { r, head } = await copyAndBringIn(A);
  assert.equal(r.status, "folded", JSON.stringify(r));
  assert.equal((r as { fold?: { status: string } }).fold!.status, "confirmed", JSON.stringify(r));
  assert.equal(item(head, "c2").opacity, 0.4);
});
