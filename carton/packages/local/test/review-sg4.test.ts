// Regressions from Stage G review round 4 (GPT 6.1 Sol): what a served switch owes the materializer (its printing
// failed, round 3 #3) was lost to a follower look already under way:
//   - a look that adopted Alt and was still reading the store when the switch to Third was served came back with its
//     notice for Alt, of the same rank as Third's: it replaced Third's, and once telling Alt failed too, that was dropped
//     (the handle had left Alt). The files kept showing the old cut;
//   - a call telling Alt that was already running when Third's was owed failed afterwards, and its notice overwrote
//     Third's.
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

const actor: Actor = { kind: "agent", id: "reviewG4", name: "Review", group: "reviewG4" };
function gate() { let open!: () => void; const p = new Promise<void>((r) => (open = r)); return { p, open }; }

/** The app's handle and another process's on one carton.db, with cuts Alt and Third. */
async function world(name: string) {
  const path = join(mkdtempSync(join(scratch(), `${name}-`)), "carton.db");
  const s = await openSqliteStore(path), os = await openSqliteStore(path);
  const c = await Carton.open({ adapter, store: s, actor, init: { doc: doc0() } });
  const other = await Carton.open({ adapter, store: os, actor });
  const alt = (await c.fork("Alt")).id, third = (await c.fork("Third")).id;
  const name_ = (cut: string) => (cut === alt ? "Alt" : cut === third ? "Third" : "Main");
  return { c, other, alt, third, name: name_, close: async () => { await other.close(); await c.close(); await os.close(); await s.close(); } };
}

test("SG4-1: a look under way when a served switch's printing failed never takes that debt with its older notice", async () => {
  const { c, other, alt, third, name, close } = await world("sg4-scan");
  let fail = false;
  let shown = "Main";
  const calls: string[] = [];
  const mz = { onHeadChange() {}, async onCutSwitch(cut: string) { calls.push(name(cut)); if (fail) throw new Error("the printer failed"); shown = name(c.cut); } };
  const engine = new CartonHolderEngine(c, { materializer: mz as never, follow: { intervalMs: 0 } });
  // hold the follower's look once it has adopted Alt, while it reads the cuts' rows
  const reached = gate(), release = gate();
  const cuts = c.cuts.bind(c);
  let hold = false;
  c.cuts = async () => { const rows = await cuts(); if (hold && c.cut === alt) { hold = false; reached.open(); await release.p; } return rows; };
  try {
    await engine.nudge();
    fail = true;
    await other.switchTo(alt);
    hold = true;
    const looking = engine.nudge();
    await reached.p;
    // the app serves a switch to Third meanwhile; printing it fails
    await assert.rejects(engine.serve({ id: "sg4.third", actor, op: { kind: "switch", cut: third } }), /the printer failed/);
    release.open();
    await looking;
    fail = false;
    await engine.nudge();
    await engine.nudge();
    assert.equal(name(c.cut), "Third");
    assert.equal(shown, "Third", `the files show the cut the app is on; calls: ${JSON.stringify(calls)}`);
    assert.equal(calls.at(-1), "Third");
  } finally {
    release.open();
    await engine.close();
    await close();
  }
});

test("SG4-1: a call telling an older cut that fails after a served switch's debt was owed never overwrites it", async () => {
  const { c, other, alt, third, name, close } = await world("sg4-inflight");
  const entered = gate(), release = gate();
  let recovered = false;
  let shown = "Main";
  const calls: string[] = [];
  const mz = {
    onHeadChange() {},
    async onCutSwitch(cut: string) {
      calls.push(name(cut));
      if (cut === alt) { entered.open(); await release.p; throw new Error("telling Alt failed"); }
      if (!recovered) throw new Error("telling Third failed");
      shown = name(c.cut);
    },
  };
  const engine = new CartonHolderEngine(c, { materializer: mz as never, follow: { intervalMs: 0 } });
  try {
    await engine.nudge();
    await other.switchTo(alt);
    const looking = engine.nudge();
    await entered.p;
    await assert.rejects(engine.serve({ id: "sg4.newer", actor, op: { kind: "switch", cut: third } }), /telling Third failed/);
    release.open();
    await looking;
    recovered = true;
    await engine.nudge();
    await engine.nudge();
    assert.equal(shown, "Third", `calls: ${JSON.stringify(calls)}`);
    assert.deepEqual(calls, ["Alt", "Third", "Third"], "Third told again once; Alt never again");
  } finally {
    release.open();
    await engine.close();
    await close();
  }
});
