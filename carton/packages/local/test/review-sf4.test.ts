// Regressions from Stage F review round 4 (GPT 6.1 Sol): folding one version again folds in that version's kept-out
// part only; a "fold in the rest" interrupted before its revert completes on retry; a server answer that arrives before
// the save is recorded as the view's last change still reaches its sidecar; a late conflict's sidecar isn't overwritten
// by its confirmation; a card-only file save retried keeps its author's cards once.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Carton } from "@carton/core";
import type { Actor, Rec } from "@carton/core";
import type { AuthContext, AuthProvider, Store } from "@carton/core/plugins";
import { createMemoryStore } from "@carton/store-memory";
import { createInProcessHost } from "@carton/server";
import { jsonTimelineCodec } from "@carton/cardboard";
import { Materializer, viewPath, statusPath } from "@carton/cardboard/node";
import { findRev } from "../../cardboard/src/header.ts";
import { sqliteStorage } from "../../conformance/src/system/sqlite.ts";
import { runWrite, actorKey } from "../src/writes.ts";
import { CartonHolderEngine } from "../src/open.ts";
import { CartonMaterializerEngine } from "../src/materializer-engine.ts";
import { adapter, doc0, schema } from "./support/real.ts";
import { scratch } from "./support/scratch.ts";

const actor: Actor = { kind: "agent", id: "review4", name: "Reviewer", group: "review4" };
const set = (id: string, f: string, value: unknown) => ({ op: "set" as const, path: ["timelineItems", id, f], value });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(f: () => Promise<unknown> | unknown, ms = 5000, what = "condition") {
  for (const end = Date.now() + ms; !(await f()); await sleep(5)) if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
}
const item = async (c: Carton, cut: string, id: string) => ((await c.head(cut)).doc.timelineItems as Rec[]).find((x) => x.id === id)!;
async function partial(c: Carton, from: string, into: string, id: string, reject: string[]) {
  const r = await runWrite(c, { id, actor, op: { kind: "fold", from, into, reject } });
  assert.equal(r.status, "confirmed", JSON.stringify(r));
}
function world() {
  const db = sqliteStorage();
  const tokens = new Map<string, AuthContext>();
  const auth: AuthProvider = { kind: "table", async verify(t) { return tokens.get(t) ?? null; } };
  const host = createInProcessHost({ storage: db, auth, timeline: schema.timeline!, groupOf: (c, f) => schema.collections[c]?.groupOf.get(f)?.name });
  const sync = (name: string) => {
    tokens.set(name, { account: name, credential: `${name}/install`, role: "editor", projectId: "p", expires: Date.now() + 3600_000 });
    return { transport: host.transport, url: host.url, token: name, autoConnect: false };
  };
  return { db, sync };
}
async function sharedHandle(w: ReturnType<typeof world>, store: Store, name = "alice") {
  const c = await Carton.open({ adapter, store, init: { doc: doc0() }, actor, sync: w.sync(name) });
  await c.share();
  await c.sync!.connect({ nonce: name });
  await until(async () => (await c.cuts())[0]!.sequencer.kind === "server", 5000, "the hand-off");
  return c;
}

test("folding one version again folds in that version's kept-out part, not a later version's", async () => {
  const c = await Carton.open({ adapter, store: createMemoryStore(), init: { doc: doc0() }, actor });
  try {
    const main = c.cut;
    const alt = await c.fork("Alt");
    await c.commit({ cut: alt.id, ops: [set("c1", "opacity", 0.2)] });
    const old = (await c.head(alt.id)).ref.seq;
    await partial(c, `${alt.id}@${old}`, main, "sf4.old-partial", ["timelineItems/c1"]);
    await c.commit({ cut: alt.id, ops: [set("c2", "opacity", 0.3)] });
    await partial(c, alt.id, main, "sf4.new-partial", ["timelineItems/c2"]);
    const r = await runWrite(c, { id: "sf4.old-rest", actor, op: { kind: "fold", from: `${alt.id}@${old}`, into: main } });
    assert.equal(r.status, "confirmed", JSON.stringify(r));
    assert.equal(r.rest, true, JSON.stringify(r));
    assert.equal((await item(c, main, "c1")).opacity, 0.2, "the requested version's kept-out part is folded in");
    assert.equal((await item(c, main, "c2")).opacity, 1, "a later version's kept-out part stays out");
    // folding the cut (its newest partial fold): the rest of it
    const all = await runWrite(c, { id: "sf4.cut-rest", actor, op: { kind: "fold", from: alt.id, into: main } });
    assert.equal(all.rest, true, JSON.stringify(all));
    assert.equal((await item(c, main, "c2")).opacity, 0.3);
  } finally {
    await c.close();
  }
});

test("a fold-in-the-rest interrupted before its revert folds the rest in on retry", async () => {
  const c = await Carton.open({ adapter, store: createMemoryStore(), init: { doc: doc0() }, actor });
  try {
    const main = c.cut;
    const alt = await c.fork("Alt");
    await c.commit({ cut: alt.id, ops: [set("c1", "opacity", 0.2)] });
    await partial(c, alt.id, main, "sf4.partial", ["timelineItems/c1"]);
    const revert = c.revert.bind(c);
    (c as { revert: Carton["revert"] }).revert = async () => { throw new Error("interrupted before the revert"); };
    const req = { id: "sf4.rest", actor, op: { kind: "fold" as const, from: alt.id, into: main } };
    await assert.rejects(runWrite(c, structuredClone(req)), /interrupted/);
    (c as { revert: Carton["revert"] }).revert = revert;
    const retry = await runWrite(c, structuredClone(req));
    assert.equal(retry.status, "confirmed", JSON.stringify(retry));
    assert.equal(retry.rest, true, JSON.stringify(retry));
    assert.equal((await item(c, main, "c1")).opacity, 0.2, "the kept-out part is folded in");
    // and once more: the same answer, nothing folded twice
    const again = await runWrite(c, structuredClone(req));
    assert.deepEqual([again.status, again.rest, again.id], [retry.status, retry.rest, retry.id]);
  } finally {
    await c.close();
  }
});

test("a server answer that arrives before the save is the view's last change still reaches the view", async () => {
  const w = world();
  const store = createMemoryStore();
  const c = await sharedHandle(w, store);
  const updates: { view: string; id: string; status: string }[] = [];
  const engine = new CartonHolderEngine(c, { materializer: { printView: async () => ({ name: "v", path: "v", ref: "v" }), onChangeUpdate: async (view, id, s) => { updates.push({ view, id, status: s.status }); } } });
  try {
    await store.write([{ table: "views", key: ["view", "v"], value: { lastChange: null } }]);
    const r = await c.commit({ id: "sf4.early", ops: [set("c1", "name", "early")], author: actor });
    assert.equal(r.status, "pending");
    assert.equal((await c.sync!.waitFor("sf4.early", 5000)).status, "confirmed");
    await sleep(50);
    assert.deepEqual(updates, [], "no view names it yet");
    // the save finishes: the view records it as its last change
    await store.write([{ table: "views", key: ["view", "v"], value: { lastChange: "sf4.early" } }]);
    await until(() => updates.length === 1, 2000, "the answer to reach the view");
    assert.deepEqual(updates, [{ view: "v", id: "sf4.early", status: "confirmed" }]);
    await store.write([{ table: "views", key: ["view", "v"], value: { lastChange: "sf4.early", printGen: 2 } }]);
    await sleep(50);
    assert.equal(updates.length, 1, "told once");
  } finally {
    await engine.close();
    await c.close();
    w.db.close();
  }
});

test("a late conflict's sidecar update isn't overwritten by its confirmation", async () => {
  const w = world();
  const store = createMemoryStore();
  const a = await sharedHandle(w, store);
  let b: Carton | null = null;
  const updates: { id: string; status: string }[] = [];
  const engine = new CartonHolderEngine(a, { materializer: { printView: async () => ({ name: "v", path: "v", ref: "v" }), onChangeUpdate: async (_v, id, s) => { updates.push({ id, status: s.status }); } } });
  try {
    await a.sync!.disconnect();
    // bob, from a copy of the same replica, changes c5's time first
    const bs = createMemoryStore();
    for (const table of ["meta", "cuts", "changes", "states", "lineage", "keyframes", "ids", "rids"]) {
      const rows = await store.range(table);
      if (rows.length) await bs.write(rows.map((r) => ({ table, key: r.key, value: structuredClone(r.value) })));
    }
    b = await Carton.open({ adapter, store: bs, actor: { kind: "human", id: "bob" }, sync: w.sync("bob") });
    await b.sync!.connect({ nonce: "b" });
    const br = await b.commit({ ops: [set("c5", "endTime", 29), set("c5", "trimEnd", 4)] });
    assert.equal((await b.sync!.waitFor(br.status === "pending" ? br.id : "", 5000)).status, "confirmed");
    await b.close();
    b = null;
    // the agent's save, offline, clashes with it: confirmed with a late conflict once it goes up
    await a.commit({ id: "sf4.late", ops: [set("c5", "endTime", 29.4), set("c5", "trimEnd", 4.4), set("c0", "name", "independent")], author: actor });
    await store.write([{ table: "views", key: ["view", "v"], value: { lastChange: "sf4.late" } }]);
    await a.sync!.connect({ nonce: "a2" });
    assert.equal((await a.sync!.waitFor("sf4.late", 5000)).status, "conflicts");
    await until(() => updates.some((x) => x.status === "conflicts"), 2000, "the late conflict");
    await sleep(100);
    assert.equal(updates.at(-1)!.status, "conflicts", `the sidecar keeps its cards: ${JSON.stringify(updates)}`);
  } finally {
    await engine.close();
    await b?.close();
    await a.close();
    w.db.close();
  }
});

test("a card-only file save retried keeps its author's cards once", async () => {
  const store = createMemoryStore();
  const c = await Carton.open({ adapter, store, init: { doc: doc0() }, actor });
  const dir = mkdtempSync(join(scratch(), "sf4-cards-"));
  writeFileSync(join(dir, "project.json"), JSON.stringify({ project: doc0() }));
  const engine = new CartonMaterializerEngine(c);
  const host = { fromProject: (p: any) => ({ name: p.name, tracks: p.tracks, timelineItems: p.timelineItems }), toProject: (d: any, cur: any) => ({ ...cur, name: d.name, tracks: d.tracks, timelineItems: d.timelineItems }), merge3: (_b: any, _o: any, t: any) => t, diagnose: () => [] };
  const mz = new Materializer({ bundle: dir, engine, host, codec: jsonTimelineCodec, writeProject: false });
  try {
    await mz.start();
    await mz.printView("v", actor);
    await c.commit({ ops: [set("c1", "opacity", 0.6)] }); // someone else changes c1 after the print
    // the agent's view save changes only c1: every edit carded. Storing the save's result fails once (a crash there)
    const put = engine.putMeta.bind(engine);
    let failed = false;
    engine.putMeta = async (key, value) => {
      if (!failed && key[0] === "attempt" && (value as { result?: unknown } | undefined)?.result) { failed = true; throw new Error("injected: the result wasn't stored"); }
      return put(key, value);
    };
    const file = join(dir, viewPath("v"));
    const text = readFileSync(file, "utf8");
    const f = findRev(text)!;
    const doc = JSON.parse(text.slice(f.end));
    doc.timelineItems.find((x: any) => x.id === "c1").opacity = 0.33;
    writeFileSync(file, `${f.line}\n${JSON.stringify(doc)}\n`);
    mz.onFsEvent(viewPath("v"));
    await mz.idle();
    assert.ok(failed, "the first try failed after keeping its cards");
    await sleep(10);
    mz.onFsEvent(viewPath("v")); // the retry
    await mz.idle();
    const rows = (await store.range<{ cards?: unknown[] }>("notices", { prefix: [actorKey(actor)] })).filter((r) => r.value.cards?.length);
    assert.equal(rows.length, 1, `one cards notice for the save: ${JSON.stringify(rows.map((r) => r.key))}`);
    assert.equal(JSON.parse(readFileSync(join(dir, statusPath("v")), "utf8")).status, "conflicts");
  } finally {
    await mz.close();
    await c.close();
  }
});

test("a real view save whose answer comes before its save returns: the sidecar ends confirmed, not pending", async () => {
  const w = world();
  const store = createMemoryStore();
  const c = await sharedHandle(w, store);
  const dir = mkdtempSync(join(scratch(), "sf4-early-"));
  writeFileSync(join(dir, "project.json"), JSON.stringify({ project: doc0() }));
  const engine = new CartonMaterializerEngine(c);
  const host = { fromProject: (p: any) => ({ name: p.name, tracks: p.tracks, timelineItems: p.timelineItems }), toProject: (d: any, cur: any) => ({ ...cur, name: d.name, tracks: d.tracks, timelineItems: d.timelineItems }), merge3: (_b: any, _o: any, t: any) => t, diagnose: () => [] };
  const mz = new Materializer({ bundle: dir, engine, host, codec: jsonTimelineCodec, writeProject: false });
  const holder = new CartonHolderEngine(c, { materializer: mz });
  try {
    await mz.start();
    await mz.printView("v", actor);
    // the server answers while the save is still being processed (before the view records it as its last change)
    const commit = engine.commit.bind(engine);
    engine.commit = async (input) => {
      const r = await commit(input);
      assert.equal(r.status, "pending");
      await c.sync!.waitFor(r.id!, 5000);
      await sleep(20);
      return r;
    };
    const file = join(dir, viewPath("v"));
    const text = readFileSync(file, "utf8");
    const f = findRev(text)!;
    const doc = JSON.parse(text.slice(f.end));
    doc.timelineItems.find((x: any) => x.id === "c1").name = "from the file";
    writeFileSync(file, `${f.line}\n${JSON.stringify(doc)}\n`);
    mz.onFsEvent(viewPath("v"));
    await mz.idle();
    const status = () => JSON.parse(readFileSync(join(dir, statusPath("v")), "utf8"));
    await until(() => status().status === "confirmed", 2000, `the sidecar to say confirmed (it says ${status().status})`);
    assert.ok(await store.get("ids", [status().change]), "and the change is confirmed in the store");
  } finally {
    await holder.close();
    await mz.close();
    await c.close();
    w.db.close();
  }
});
