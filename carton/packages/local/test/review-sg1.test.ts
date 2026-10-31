// Regressions from Stage G review round 1 (GPT 6.1 Sol): a new project whose import change never landed is finished
// on the next open; a fold request's rest is decided before the fold, so the request is never answered without it;
// `undo --turn` raises one card per field, from the value before the turn; a copy of an undo request that finished
// meanwhile is never followed by a rewrite of its cards; the follower tells again what a failed listener missed; a
// follower stopped during its adoption read switches nothing.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { Carton } from "@carton/core";
import type { Actor, ConflictCard, Rec } from "@carton/core";
import type { Store } from "@carton/core/plugins";
import { createMemoryStore } from "@carton/store-memory";
import { openSqliteStore } from "@carton/store-sqlite";
import { followStore } from "../src/follow.ts";
import { openLocal } from "../src/open.ts";
import { actorKey, runWrite } from "../src/writes.ts";
import { adapter, bundle, doc0 } from "./support/real.ts";
import { scratch } from "./support/scratch.ts";

const actor: Actor = { kind: "agent", id: "reviewG1", name: "Review", group: "reviewG1" };
const set = (id: string, f: string, value: unknown) => ({ op: "set" as const, path: ["timelineItems", id, f], value });
const item = (doc: { timelineItems?: unknown }, id: string) => (doc.timelineItems as Rec[]).find((i) => i.id === id)!;
function gate() { let release!: () => void; const p = new Promise<void>((r) => (release = r)); return { p, release }; }
/** A wait that fails instead of hanging (the code under test never got there). */
function within<T>(p: Promise<T>, what: string, ms = 10_000): Promise<T> {
  let t!: NodeJS.Timeout;
  return Promise.race([p, new Promise<T>((_, no) => (t = setTimeout(() => no(new Error(`never reached: ${what}`)), ms)))]).finally(() => clearTimeout(t));
}
const empty = () => ({ tracks: [], timelineItems: [] });

/** A project left as core leaves it when stopped between its two init steps: the empty root at main@0, no import. */
async function halfInitialized(name: string) {
  const { dir, projectId } = bundle(name);
  const first = await openLocal({ projectDir: dir, projectId, adapter, init: { doc: empty(), asChange: false }, actor });
  assert.equal((await first.carton.head()).ref.seq, 0);
  await first.close();
  return { dir, projectId };
}

test("a new project whose import change never landed gets it on the next open with init: main@1, by the import, once", async () => {
  const { dir, projectId } = await halfInitialized("sg1-init");
  const again = await openLocal({ projectDir: dir, projectId, adapter, init: { doc: doc0() }, actor });
  try {
    const h = await again.carton.head();
    assert.equal(h.ref.seq, 1, "main@1");
    assert.equal(item(h.doc, "c3").name, "c3", "the starting state is the one given");
    const [v] = (await again.carton.log({ limit: 5 })).filter((x) => x.change);
    assert.equal(v!.author?.id, "import", "credited to the import");
  } finally {
    await again.close();
  }
  // opened again: nothing more (the project has a change now)
  const third = await openLocal({ projectDir: dir, projectId, adapter, init: { doc: { ...doc0(), timelineItems: [] } }, actor });
  try {
    assert.equal((await third.carton.head()).ref.seq, 1);
  } finally {
    await third.close();
  }
  // a project made empty on purpose (asChange: false) is a root, not a half-done import: left alone without asChange
  const { dir: d2, projectId: p2 } = await halfInitialized("sg1-init-root");
  const keep = await openLocal({ projectDir: d2, projectId: p2, adapter, init: { doc: doc0(), asChange: false }, actor });
  try {
    assert.equal((await keep.carton.head()).ref.seq, 0);
  } finally {
    await keep.close();
  }
});

test("Carton.open resumes an init whose import change never landed", { todo: "foundation-core request 7 (local-cli notes)" }, async () => {
  const store = createMemoryStore();
  const a = await Carton.open({ adapter, store, actor, init: { doc: empty(), asChange: false } });
  await a.close();
  const b = await Carton.open({ adapter, store, actor, init: { doc: doc0(), asChange: true } });
  try {
    assert.equal((await b.head()).ref.seq, 1, "core finishes its own two-step init");
  } finally {
    await b.close();
  }
});

/** Main and Alt; c1 folded in fully; then c2 on Alt folded in with c2 kept out (a partial fold). */
async function partlyFolded(c: Carton) {
  const main = c.cut;
  const alt = await c.fork("Alt");
  await c.commit({ cut: alt.id, ops: [set("c1", "name", "already folded")] });
  assert.equal((await runWrite(c, { id: "g1.full", actor, op: { kind: "fold", from: alt.id, into: main } })).status, "confirmed");
  await c.commit({ cut: alt.id, ops: [set("c2", "opacity", 0.2)] });
  assert.equal((await runWrite(c, { id: "g1.p1", actor, op: { kind: "fold", from: alt.id, into: main, reject: ["timelineItems/c2"] } })).status, "confirmed");
  return { main, alt };
}

test("a fold request is never answered before its rest is decided; a retry folds in the rest it decided, not a later one", async () => {
  const store = createMemoryStore();
  const c = await Carton.open({ adapter, store, actor, init: { doc: doc0() } });
  try {
    const { main, alt } = await partlyFolded(c);
    // 1. stopped while recording the decision: the fold hasn't run, so core holds no answer for the request
    const write = store.write.bind(store);
    store.write = (async (w: Parameters<Store["write"]>[0], cond?: Parameters<Store["write"]>[1]) => {
      if (w.some((x) => x.key[0] === "@fold-rest")) throw new Error("stopped here");
      return write(w, cond);
    }) as Store["write"];
    await assert.rejects(runWrite(c, { id: "g1.stop", actor, op: { kind: "fold", from: alt.id, into: main } }), /stopped here/);
    store.write = write;
    assert.equal(await store.get("meta", ["noop", "g1.stop"]), undefined, "no no-op recorded for it");
    assert.equal(await store.get("ids", ["g1.stop"]), undefined);
    // 2. stopped after the fold found nothing new, before folding in the rest
    const revert = c.revert;
    c.revert = (async () => { throw new Error("stopped here"); }) as typeof c.revert;
    const req = { id: "g1.rest", actor, op: { kind: "fold" as const, from: alt.id, into: main } };
    await assert.rejects(runWrite(c, structuredClone(req)), /stopped here/);
    c.revert = revert;
    // a later partial fold: c3 kept out
    await c.commit({ cut: alt.id, ops: [set("c3", "opacity", 0.3)] });
    assert.equal((await runWrite(c, { id: "g1.p2", actor, op: { kind: "fold", from: alt.id, into: main, reject: ["timelineItems/c3"] } })).status, "confirmed");
    const retry = await runWrite(c, structuredClone(req));
    assert.equal(retry.rest, true, JSON.stringify(retry));
    const doc = (await c.head(main)).doc;
    assert.equal(item(doc, "c2").opacity, 0.2, "the rest decided first: c2 folded in");
    assert.equal(item(doc, "c3").opacity, 1, "the later partial fold's kept-out part stays out");
  } finally {
    await c.close();
  }
});

const turnActor: Actor = { kind: "agent", id: "director/g1/t1", name: "Director", group: "local:g1", turn: "t1" };

test("undo --turn: a field the turn set twice, changed again since, is one card from the value before the turn", async () => {
  const store = createMemoryStore();
  const c = await Carton.open({ adapter, store, actor, init: { doc: doc0() } });
  try {
    await c.commit({ author: turnActor, ops: [set("c1", "opacity", 0.9)] });
    await c.commit({ author: turnActor, ops: [set("c1", "opacity", 0.8)] });
    await c.commit({ author: { kind: "human", id: "human:me" }, ops: [set("c1", "opacity", 0.84)] });
    const r = await runWrite(c, { id: "g1.undo", actor: turnActor, op: { kind: "undoTurn", turn: "t1" } });
    const cards = (r as { conflicts?: ConflictCard[] }).conflicts ?? [];
    assert.equal(cards.length, 1, JSON.stringify(cards));
    assert.deepEqual([cards[0]!.base, cards[0]!.ours, cards[0]!.theirs], [0.8, 0.84, 1], "base: the turn's last value; ours: head; theirs: before the turn");
    assert.equal(item((await c.head()).doc, "c1").opacity, 0.84, "head keeps the newer value until the card is decided");
    const listed = (await store.range<{ cards?: ConflictCard[] }>("notices", { prefix: [actorKey(turnActor)] })).flatMap((x) => x.value.cards ?? []);
    assert.equal(listed.length, 1, "one card for `cb conflicts`");
  } finally {
    await c.close();
  }
});

/**
 * Two copies of one `undo --turn` request: X stops at `pause` (where it is held), Y runs to the end and its author
 * resolves the card; then X goes on. X must answer as Y did and never write the card again.
 */
async function duplicateUndo(pauseAt: "log" | "cards") {
  const store = createMemoryStore();
  const c = await Carton.open({ adapter, store, actor, init: { doc: doc0() } });
  try {
    await c.commit({ author: turnActor, ops: [set("c1", "opacity", 0.5)] });
    await c.commit({ author: { kind: "human", id: "human:me" }, ops: [set("c1", "opacity", 0.6)] });
    const req = { id: "g1.dup", actor: turnActor, op: { kind: "undoTurn" as const, turn: "t1" } };
    const g = gate(), reached = gate();
    let held = false;
    const hold = async () => { if (held) return; held = true; reached.release(); await g.p; };
    const log = c.log.bind(c), get = store.get.bind(store);
    // "log": after X found no answer for the request, before it reads the turn; "cards": after it worked out the
    // undo and its cards, just before writing them
    if (pauseAt === "log") c.log = (async (...a: Parameters<typeof c.log>) => { await hold(); return log(...a); }) as typeof c.log;
    else store.get = (async (table: string, key: readonly unknown[]) => { if (key[0] === "@undo-cards") await hold(); return get(table, key as never); }) as Store["get"];
    const x = runWrite(c, structuredClone(req));
    await within(reached.p, `the ${pauseAt} hold`);
    const y = await runWrite(c, structuredClone(req));
    assert.equal((y as { conflicts?: unknown[] }).conflicts?.length, 1, JSON.stringify(y));
    const closed = await runWrite(c, { id: "g1.close", actor: turnActor, op: { kind: "closeCard", change: "g1.dup", path: "timelineItems/c1/opacity" } });
    assert.equal((closed as { closed?: boolean }).closed, true, JSON.stringify(closed));
    const mine = async () => (await store.range<{ cards?: ConflictCard[] }>("notices", { prefix: [actorKey(turnActor)] })).flatMap((r) => r.value.cards ?? []);
    assert.equal((await mine()).length, 0);
    g.release();
    const xr = await x;
    c.log = log;
    store.get = get;
    assert.equal(xr.status, y.status, JSON.stringify(xr));
    assert.deepEqual((xr as { conflicts?: unknown[] }).conflicts, (y as { conflicts?: unknown[] }).conflicts, "the same answer");
    assert.equal((await mine()).length, 0, "the resolved card stays resolved");
    assert.equal((await c.log({ limit: 10 })).filter((v) => v.kind === "undo").length, 1, "one undo");
  } finally {
    await c.close();
  }
}

test("undo --turn: a copy of the request that finished meanwhile is answered as it was (held before reading the turn)", () => duplicateUndo("log"));
test("undo --turn: a copy of the request that finished meanwhile never writes its resolved cards again (held before writing them)", () => duplicateUndo("cards"));

/** The app's handle and another process's on one carton.db, and a second cut. */
async function pair(t: { after(f: () => Promise<void>): void }) {
  const path = join(mkdtempSync(join(scratch(), "sg1-")), "carton.db");
  const s = await openSqliteStore(path);
  const c = await Carton.open({ adapter, store: s, actor, init: { doc: doc0() } });
  const alt = await c.fork("Alt");
  const os = await openSqliteStore(path);
  const other = await Carton.open({ adapter, store: os, actor });
  t.after(async () => { await other.close(); await c.close(); await os.close(); await s.close(); });
  return { s, c, os, other, alt };
}

test("the follower tells again what a listener failed to take: a change is never lost to one failure", async (t) => {
  const p = await pair(t);
  const heads: string[] = [];
  const errors: unknown[] = [];
  let fail = 1;
  const f = followStore(p.c, p.s, { intervalMs: 0, onHead: (cut) => { if (fail-- > 0) throw new Error("busy"); heads.push(cut); }, onCut: () => {}, onError: (e) => errors.push(e) })!;
  t.after(() => f.stop());
  await f.check();
  await p.other.commit({ ops: [set("c1", "name", "elsewhere")] });
  await f.check();
  assert.equal(errors.length, 1, "the listener failed once");
  assert.deepEqual(heads, []);
  // nothing else written since: the next look tells it again
  await f.check();
  assert.deepEqual(heads, [p.c.cut]);
  await f.check();
  assert.deepEqual(heads, [p.c.cut], "and only once");
});

test("a follower stopped during its adoption read switches nothing", async (t) => {
  const p = await pair(t);
  const main = p.c.cut;
  const f = followStore(p.c, p.s, { intervalMs: 0, onHead: () => {}, onCut: () => {} })!;
  await f.check();
  // the re-read under the lock: its value is taken, then the follower is held before it goes on
  const get = p.s.get.bind(p.s);
  const g = gate(), reached = gate();
  let reads = 0;
  p.s.get = (async (table: string, key: readonly unknown[]) => {
    const v = await get(table, key as never);
    if (table === "meta" && key[0] === "current" && ++reads === 2) { reached.release(); await g.p; }
    return v;
  }) as Store["get"];
  await p.other.switchTo(p.alt.id);
  const looking = f.check();
  await within(reached.p, "the adoption's re-read");
  const stopping = f.stop();
  await p.other.switchTo(main); // the newer choice
  g.release();
  await looking;
  await stopping;
  p.s.get = get;
  assert.equal(p.c.cut, main, "the handle stayed where it was");
  assert.equal(await get("meta", ["current"]), main, "and the newer choice stands");
});
