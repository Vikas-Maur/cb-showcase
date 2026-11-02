// Regressions from Stage F review round 5 (GPT 6.1 Sol), the follower (B11) and the sidecar forwarding: a stale
// observation never undoes a newer cut switch; an external write right after the app's own cut switch is reported; the
// app's own commit is never taken for another process's; a stopped follower switches and tells nothing; a forwarded
// answer whose sidecar install failed is tried again; a fold request's "rest" is decided once, so its retry never
// folds in a partial fold made after it was answered.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { Carton } from "@carton/core";
import type { Actor, Rec } from "@carton/core";
import { createMemoryStore } from "@carton/store-memory";
import { openSqliteStore } from "@carton/store-sqlite";
import { followStore } from "../src/follow.ts";
import { forwardSettles } from "../src/sidecars.ts";
import { runWrite } from "../src/writes.ts";
import { adapter, doc0 } from "./support/real.ts";
import { scratch } from "./support/scratch.ts";

const actor: Actor = { kind: "agent", id: "review5", name: "Review", group: "review5" };
const set = (id: string, f: string, value: unknown) => ({ op: "set" as const, path: ["timelineItems", id, f], value });
const turn = () => new Promise((r) => setImmediate(r));
function gate() { let release!: () => void; const p = new Promise<void>((r) => (release = r)); return { p, release }; }

/** The app's handle and another process's (a second connection) on one carton.db, with two more cuts. */
async function pair(t: { after(f: () => Promise<void>): void }) {
  const path = join(mkdtempSync(join(scratch(), "sf5-")), "carton.db");
  const s = await openSqliteStore(path);
  const c = await Carton.open({ adapter, store: s, actor, init: { doc: doc0() } });
  const a = await c.fork("Alt A");
  const b = await c.fork("Alt B");
  const os = await openSqliteStore(path);
  const other = await Carton.open({ adapter, store: os, actor });
  t.after(async () => { await other.close(); await c.close(); await os.close(); await s.close(); });
  return { s, c, os, other, a, b };
}

test("a stale observation of another process's switch never undoes a newer switch served here", async (t) => {
  const p = await pair(t);
  const f = followStore(p.c, p.s, { intervalMs: 0, onHead: () => {}, onCut: () => {} })!;
  t.after(() => f.stop());
  await f.check();
  await p.other.switchTo(p.a.id); // another process switches to A
  const reached = gate(), release = gate();
  const cuts = p.c.cuts.bind(p.c);
  (p.c as { cuts: Carton["cuts"] }).cuts = async () => { const r = await cuts(); reached.release(); await release.p; return r; };
  const checking = f.check(); // the follower read A and pauses
  await reached.p;
  (p.c as { cuts: Carton["cuts"] }).cuts = cuts;
  const reply = await runWrite(p.c, { id: "sf5.switch", actor, op: { kind: "switch", cut: p.b.id } }); // a newer switch, here
  assert.equal(reply.cut, p.b.id);
  release.release();
  await checking;
  assert.equal(await p.s.get("meta", ["current"]), p.b.id, "the newer switch stays");
  assert.equal(p.c.cut, p.b.id);
});

test("another process's write right after the app's own cut switch is reported", async (t) => {
  const p = await pair(t);
  const heads: string[] = [];
  const f = followStore(p.c, p.s, { intervalMs: 0, onHead: (cut) => { heads.push(cut); }, onCut: () => {} })!;
  t.after(() => f.stop());
  await f.check();
  await p.c.switchTo(p.a.id); // the app switches itself
  f.served(p.a.id); // and its listeners know (the holder says so for a switch it served and printed)
  await p.other.commit({ cut: p.a.id, ops: [set("c1", "name", "external")] });
  await f.check();
  assert.deepEqual(heads, [p.a.id]);
  await f.check();
  assert.deepEqual(heads, [p.a.id], "once");
});

test("a switch made on the followed handle that nobody announced is told as a cut switch at the next look, once (Stage G round 5)", async (t) => {
  const p = await pair(t);
  const told: string[] = [];
  const f = followStore(p.c, p.s, { intervalMs: 0, onHead: (cut) => { told.push(`head:${cut}`); }, onCut: (cut) => { told.push(`cut:${cut}`); } })!;
  t.after(() => f.stop());
  await f.check();
  await p.c.switchTo(p.a.id);
  await p.other.commit({ cut: p.a.id, ops: [set("c1", "name", "external")] });
  await f.check();
  await f.check();
  assert.deepEqual(told, [`cut:${p.a.id}`], "the whole cut (its head included), once");
});

test("the app's own commit is never taken for another process's, though an unrelated write moved the stamp", async (t) => {
  const p = await pair(t);
  const heads: string[] = [];
  const f = followStore(p.c, p.s, { intervalMs: 0, onHead: (cut) => { heads.push(cut); }, onCut: () => {} })!;
  t.after(() => f.stop());
  await f.check();
  await p.c.commit({ ops: [set("c1", "name", "own GUI edit")] });
  await p.os.write([{ table: "lease", key: ["unrelated"], value: "heartbeat" }]);
  await f.check();
  assert.deepEqual(heads, [], "nothing from elsewhere");
  // and a real external write after it still is
  await p.other.commit({ ops: [set("c2", "name", "external")] });
  await f.check();
  assert.deepEqual(heads, [p.c.cut]);
});

test("a stopped follower switches nothing and tells nothing, and stop waits for the look in progress", async (t) => {
  const p = await pair(t);
  const cutsTold: string[] = [];
  const f = followStore(p.c, p.s, { intervalMs: 0, onHead: () => {}, onCut: (cut) => { cutsTold.push(cut); } })!;
  await f.check();
  await p.other.switchTo(p.a.id);
  const reached = gate(), release = gate();
  const cuts = p.c.cuts.bind(p.c);
  (p.c as { cuts: Carton["cuts"] }).cuts = async () => { const r = await cuts(); reached.release(); await release.p; return r; };
  const checking = f.check();
  await reached.p;
  let stopped = false;
  const stopping = f.stop().then(() => { stopped = true; });
  await turn();
  assert.equal(stopped, false, "stop waits for the look in progress");
  release.release();
  await stopping;
  await checking;
  (p.c as { cuts: Carton["cuts"] }).cuts = cuts;
  assert.notEqual(p.c.cut, p.a.id, "not switched after stop");
  assert.deepEqual(cutsTold, []);
});

test("a forwarded answer whose sidecar install failed is tried again", async () => {
  const s = createMemoryStore();
  let listener!: (e: unknown) => void;
  const fake = { on: (f: (e: unknown) => void) => { listener = f; return () => {}; }, cuts: async () => [{ id: "shared", sequencer: { kind: "server" } }] } as unknown as Carton;
  let calls = 0;
  const told: string[] = [];
  const stop = forwardSettles(fake, s, async (_v, id, u) => { calls++; if (calls === 1) throw new Error("EBUSY: sidecar install failed"); told.push(`${id} ${u.status}`); });
  try {
    await s.write([{ table: "views", key: ["view", "v"], value: { lastChange: "save1" } }]);
    listener({ type: "change", branchId: "shared", seq: 1, change: { id: "save1" } });
    for (let i = 0; i < 10 && calls < 1; i++) await turn();
    assert.equal(calls, 1);
    await s.write([{ table: "views", key: ["view", "v"], value: { lastChange: "save1", printGen: 2 } }]);
    for (let i = 0; i < 10 && !told.length; i++) await turn();
    assert.deepEqual(told, ["save1 confirmed"], "the next views write delivers it");
  } finally {
    await stop();
    await s.close();
  }
});

test("a fold request's rest is decided once: its retry never folds in a partial fold made after it was answered", async () => {
  const c = await Carton.open({ adapter, store: createMemoryStore(), actor, init: { doc: doc0() } });
  try {
    const main = c.cut;
    const alt = await c.fork("Alt");
    await c.commit({ cut: alt.id, ops: [set("c1", "name", "already folded")] });
    assert.equal((await runWrite(c, { id: "sf5.full", actor, op: { kind: "fold", from: alt.id, into: main } })).status, "confirmed");
    const req = { id: "sf5.noop", actor, op: { kind: "fold" as const, from: alt.id, into: main } };
    const first = await runWrite(c, structuredClone(req));
    assert.equal(first.upToDate, true, JSON.stringify(first));
    // later: new work on Alt, folded in part
    await c.commit({ cut: alt.id, ops: [set("c2", "opacity", 0.2)] });
    assert.equal((await runWrite(c, { id: "sf5.partial", actor, op: { kind: "fold", from: alt.id, into: main, reject: ["timelineItems/c2"] } })).status, "confirmed");
    const retry = await runWrite(c, structuredClone(req));
    assert.equal(retry.status, "confirmed", JSON.stringify(retry));
    assert.notEqual(retry.rest, true, JSON.stringify(retry));
    assert.equal(((await c.head(main)).doc.timelineItems as Rec[]).find((i) => i.id === "c2")!.opacity, 1, "the later partial fold's kept-out part stays out");
  } finally {
    await c.close();
  }
});
