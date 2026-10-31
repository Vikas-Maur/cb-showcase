// Regression from Stage G review round 5 (GPT 6.1 Sol): core moves a handle to the stored current cut when it reloads
// a cut it didn't know (another process made a cut and switched to it), in any call that refreshes: the follower's own
// scan, or a call the app made. Round 4's guard took every move of the handle during a look for a served switch, which
// tells the materializer itself, and dropped the look's notice: nothing ever told the listeners the handle was on the new
// cut (a ViewPrinter without `onExternalHeadChange` kept showing main; `onExternal` heard nothing). Now the follower
// knows which cut it (or a served switch) last announced, and every look tells a cut never announced.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { Carton } from "@carton/core";
import type { Actor } from "@carton/core";
import { openSqliteStore } from "@carton/store-sqlite";
import { CartonHolderEngine } from "../src/open.ts";
import { adapter, doc0 } from "./support/real.ts";
import { scratch } from "./support/scratch.ts";

const actor: Actor = { kind: "agent", id: "reviewG5", name: "Review", group: "reviewG5" };
const set = (v: string) => ({ op: "set" as const, path: ["timelineItems", "c1", "name"], value: v });

/** The app (a holder engine whose printer has no onExternalHeadChange), another process, and a third one. */
async function world(name: string) {
  const path = join(mkdtempSync(join(scratch(), `${name}-`)), "carton.db");
  const [s, os, ts] = [await openSqliteStore(path), await openSqliteStore(path), await openSqliteStore(path)];
  const c = await Carton.open({ adapter, store: s, actor, init: { doc: doc0() } });
  const other = await Carton.open({ adapter, store: os, actor });
  const third = await Carton.open({ adapter, store: ts, actor });
  const main = c.cut, alt = (await c.fork("Alt")).id;
  const cuts = new Map<string, string>([[main, "Main"], [alt, "Alt"]]);
  const name_ = (cut: string) => cuts.get(cut) ?? "?";
  const shown: string[] = [];
  const external: string[] = [];
  const mz = { async onCutSwitch(cut: string) { shown.push(name_(cut)); }, onHeadChange() {} };
  const engine = new CartonHolderEngine(c, { materializer: mz as never, onExternal: (e) => void external.push(`${e.type}:${name_(e.cut)}`), follow: { intervalMs: 0 } });
  /** The third process makes cut B and switches this machine to it. */
  const makeB = async () => { const b = (await third.fork("B")).id; cuts.set(b, "B"); await third.commit({ cut: b, ops: [set("on B")] }); await third.switchTo(b); return b; };
  const close = async () => { await engine.close(); await third.close(); await other.close(); await c.close(); for (const x of [ts, os, s]) await x.close(); };
  return { c, s, other, alt, engine, name: name_, shown, external, makeB, close };
}

test("SG5-1: a cut another process made and switched to while the follower adopted the previous one is told, once", async () => {
  const w = await world("sg5-adopt");
  const adopt = w.c.switchTo.bind(w.c);
  let inject = true;
  w.c.switchTo = async (cut, o) => { await adopt(cut, o); if (inject) { inject = false; await w.makeB(); } };
  try {
    await w.engine.nudge();
    await w.other.switchTo(w.alt);
    await w.engine.nudge();
    await w.engine.nudge();
    await w.engine.nudge();
    assert.equal(w.name(w.c.cut), "B");
    assert.equal(w.name((await w.s.get<string>("meta", ["current"]))!), "B");
    assert.deepEqual(w.shown, ["B"], "the printer was told of B, once");
    assert.deepEqual(w.external, ["cut:B"]);
  } finally {
    await w.close();
  }
});

test("SG5-1: a cut the handle was moved to by a call of the app's own (core reloading) is told at the next look", async () => {
  const w = await world("sg5-refresh");
  try {
    await w.engine.nudge();
    await w.makeB();
    // the app lists its cuts (a `cb cut list` it serves): core reloads, and the handle is on B
    await w.c.cuts();
    assert.equal(w.name(w.c.cut), "B");
    await w.engine.nudge();
    await w.engine.nudge();
    assert.deepEqual(w.shown, ["B"], "a cut switch, not just a head move");
    assert.deepEqual(w.external, ["cut:B"]);
  } finally {
    await w.close();
  }
});

test("SG5-1: a switch the app served and printed is not told again by the follower", async () => {
  const w = await world("sg5-served");
  try {
    await w.engine.nudge();
    const r = (await w.engine.serve({ id: "sg5.switch", actor, op: { kind: "switch", cut: w.alt } })) as { status: string };
    assert.equal(r.status, "confirmed");
    assert.deepEqual(w.shown, ["Alt"], "the served switch told the printer");
    await w.engine.nudge();
    await w.engine.nudge();
    assert.deepEqual(w.shown, ["Alt"], "nothing more");
    assert.deepEqual(w.external, []);
  } finally {
    await w.close();
  }
});
