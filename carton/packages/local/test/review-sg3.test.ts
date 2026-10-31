// Regressions from Stage G review round 3 (GPT 6.1 Sol):
//   - #1: the app opening a new project while a `cb` opened it too: the `cb` wrote the starting-state mark after the
//     app's handle had loaded the store, the app saw the row and skipped its own, and its handle (core doesn't reload
//     exports another process wrote) sent `.cbproj`s without that version: a copy folded from the empty root.
//   - #2: an export of the empty root, made before the import landed, counted as the mark.
//   - #3: a switch the holder served whose materializer call failed: the follower dropped what it owed (the handle had
//     left that cut) and nothing told the materializer again (the holder's own writes never move its stamp).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { Carton } from "@carton/core";
import type { Actor, Rec } from "@carton/core";
import { bringInTheirChanges } from "@carton/cardboard/node";
import { openProjectStore, openSqliteStore } from "@carton/store-sqlite";
import { CartonHolderEngine, openLocal } from "../src/open.ts";
import type { LocalCarton } from "../src/open.ts";
import { adapter, bundle, doc0 } from "./support/real.ts";
import { scratch } from "./support/scratch.ts";

const actor: Actor = { kind: "agent", id: "reviewG3", name: "Review", group: "reviewG3" };
const set = (id: string, f: string, value: unknown) => ({ op: "set" as const, path: ["timelineItems", id, f], value });
const item = (doc: { timelineItems?: unknown }, id: string) => (doc.timelineItems as Rec[]).find((i) => i.id === id)!;
const LOCAL = ["pending", "pins", "notices", "views", "ephemeral", "lease", "pathMap"];
const project = (name: string) => ({ ...bundle(name), dataDir: mkdtempSync(join(scratch(), `${name}-data-`)) });
const opts = (p: ReturnType<typeof project>, name: string) => ({ projectDir: p.dir, projectId: p.projectId, dataDir: p.dataDir, adapter, actor, name });

/** Bob: a copy of `a`'s folder, carton.db and all (store-sqlite's copy, local tables dropped). */
async function clone(a: LocalCarton, projectId: string): Promise<LocalCarton> {
  const p = { ...project("sg3-bob"), projectId };
  const { store, location } = await openProjectStore({ bundleDir: p.dir, projectId, appDataDir: p.dataDir });
  await store.close();
  for (const f of [location.dbPath, `${location.dbPath}-wal`, `${location.dbPath}-shm`]) rmSync(f, { force: true });
  await (a.store as unknown as { exportCopy(to: string, drop: string[]): Promise<void> }).exportCopy(location.dbPath, LOCAL);
  return openLocal(opts(p, "Bob"));
}

test("SG3-1: the app's handle carries the starting version in its .cbproj though a `cb` marked it while the app opened", async () => {
  const p = project("sg3-concurrent");
  const original = Carton.open;
  let loaded!: () => void, release!: () => void;
  const isLoaded = new Promise<void>((r) => (loaded = r)), gate = new Promise<void>((r) => (release = r));
  let first = true;
  Carton.open = (async function (this: typeof Carton, o: Parameters<typeof Carton.open>[0]) {
    const c = await original.call(this, o);
    if (first) { first = false; loaded(); await gate; }
    return c;
  }) as typeof Carton.open;
  let a: LocalCarton | undefined, b: LocalCarton | undefined;
  try {
    // the app creates the project; its handle has loaded the store when a `cb` opens it (and marks it)
    const opening = openLocal({ ...opts(p, "Alice"), init: { doc: doc0() } });
    await isLoaded;
    const cb = await openLocal(opts(p, "CLI"));
    await cb.close();
    release();
    a = await opening;
    b = await clone(a, p.projectId);
    assert.equal((await a.write({ kind: "commit", ops: [set("c1", "opacity", 0.7)] })).status, "confirmed");
    assert.equal((await b.write({ kind: "commit", ops: [set("c2", "opacity", 0.4)] })).status, "confirmed");
    const pkg = await a.carton.exportShallow({ to: "Bob" });
    assert.ok(pkg.nodes.some((n) => n.seq === 1), `the starting version is in the app's .cbproj: ${JSON.stringify(pkg.nodes.map((n) => n.seq))}`);
    const r = await bringInTheirChanges(b.carton as never, { shallow: pkg });
    assert.equal((r as { fold?: { status: string } }).fold?.status, "confirmed", JSON.stringify(r));
    assert.equal(item((await b.carton.head()).doc, "c1").opacity, 0.7);
  } finally {
    Carton.open = original;
    release();
    await b?.close();
    await a?.close();
  }
});

test("SG3-2: an export of the empty root made before the import landed is not the mark: the starting version is marked, a copy folds cleanly", async () => {
  const p = project("sg3-root");
  const { store } = await openProjectStore({ bundleDir: p.dir, projectId: p.projectId, appDataDir: p.dataDir });
  const raw = await Carton.open({ adapter, store, actor, init: { doc: { tracks: [], timelineItems: [] }, projectId: p.projectId, asChange: false } });
  const cut = raw.cut;
  await raw.exportShallow({ to: "someone, before the import" });
  await raw.close();
  await store.close();
  // the next open with init finishes the import (core, request 7), then marks it
  const a = await openLocal({ ...opts(p, "Alice"), init: { doc: doc0() } });
  let b: LocalCarton | undefined;
  try {
    const marks = (await a.store.range("meta", { prefix: ["export"] })).map((r) => String(r.key[1])).sort();
    assert.deepEqual(marks, [`${cut}@0`, `${cut}@1`]);
    b = await clone(a, p.projectId);
    assert.equal((await a.write({ kind: "commit", ops: [set("c1", "opacity", 0.7)] })).status, "confirmed");
    assert.equal((await b.write({ kind: "commit", ops: [set("c2", "opacity", 0.4)] })).status, "confirmed");
    const r = await bringInTheirChanges(a.carton as never, { shallow: await b.carton.exportShallow({ to: "Alice" }) });
    assert.equal((r as { fold?: { status: string } }).fold?.status, "confirmed", JSON.stringify(r));
  } finally {
    await b?.close();
    await a.close();
  }
});

test("SG3-3: a served switch whose materializer call failed is told again at the next look; a notice owed for a cut left since is not", async () => {
  const path = join(mkdtempSync(join(scratch(), "sg3-mz-")), "carton.db");
  const s = await openSqliteStore(path), os = await openSqliteStore(path);
  const c = await Carton.open({ adapter, store: s, actor, init: { doc: doc0() } });
  const other = await Carton.open({ adapter, store: os, actor });
  const alt = (await c.fork("Alt")).id, third = (await c.fork("Third")).id;
  const name = (cut: string) => (cut === alt ? "Alt" : cut === third ? "Third" : "Main");
  let fail = false;
  let shown = "Main";
  const calls: string[] = [];
  const mz = {
    async onCutSwitch(cut: string) { calls.push(name(cut)); if (fail) throw new Error("the printer failed"); shown = name(c.cut); },
    onHeadChange() {},
  };
  const engine = new CartonHolderEngine(c, { materializer: mz as never, follow: { intervalMs: 0 } });
  try {
    await engine.nudge();
    fail = true;
    await other.switchTo(alt);
    await engine.nudge();
    await assert.rejects(engine.serve({ id: "sg3.third", actor, op: { kind: "switch", cut: third } }), /the printer failed/);
    assert.equal(c.cut, third);
    fail = false;
    await engine.nudge();
    await engine.nudge();
    assert.equal(shown, "Third", "the files show the cut the app is on");
    assert.deepEqual(calls, ["Alt", "Third", "Third"], "told once more, for Third; never again for Alt");
  } finally {
    await engine.close();
    await other.close();
    await c.close();
    await os.close();
    await s.close();
  }
});

test("request 9: a handle's .cbproj carries a version another process exported after this handle loaded", { todo: "foundation-core request 9 (local-cli notes)" }, async () => {
  const path = join(mkdtempSync(join(scratch(), "sg3-req9-")), "carton.db");
  const s = await openSqliteStore(path), os = await openSqliteStore(path);
  // the app's handle, open all along
  const app = await Carton.open({ adapter, store: s, actor, init: { doc: doc0() } });
  const cb = await Carton.open({ adapter, store: os, actor });
  try {
    assert.equal((await app.commit({ ops: [set("c1", "opacity", 0.7)] })).status, "confirmed");
    // a `cb` process sends a .cbproj of version 1: a lineage point from now on
    const sent = await cb.exportShallow({ to: "Bob" });
    assert.equal(sent.head, `${app.cut}@1`);
    assert.equal((await app.commit({ ops: [set("c3", "opacity", 0.2)] })).status, "confirmed");
    const pkg = await app.exportShallow({ to: "Carol" });
    assert.ok(pkg.nodes.some((n) => n.seq === 1), `the app's .cbproj carries the version the cb sent: ${JSON.stringify(pkg.nodes.map((n) => [n.seq, n.kinds]))}`);
  } finally {
    await cb.close();
    await app.close();
    await os.close();
    await s.close();
  }
});
