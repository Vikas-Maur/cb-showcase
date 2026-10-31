// Scenario 2: variants and folding on a real Cardboard project, through `cb` (the standalone carton bin) with the app
// open (its engine thread holds the lease; the materializer keeps project.json and timeline.tsx on the current cut):
//   - `cb cut new "30s Instagram cut"`, `cb cut switch`: the files follow the current cut;
//   - edits on both cuts (an agent through its view on the variant, the person's GUI saves on main);
//   - `cb fold --check` (nothing saved), a fold with cards (nothing saved, cards listed), a partial fold
//     (`--reject`, R2-14) and folding in the rest later;
//   - an agent's stale save that clashes: its conflict card listed by `cb conflicts` and picked with `cb resolve`.
// (R1-01's four-step scenario needs two replicas: it runs over live sync in s4-live.test.ts.)
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { findRev } from "@carton/cardboard";
import { openLocal } from "@carton/local";
import { cardboardAdapter } from "@carton/cardboard";
import type { HostAdapter } from "@carton/core";
import { makeMachine, itemNamed, SAMPLE, type Machine } from "../support/project.ts";
import { Procs, type Proc } from "../support/procs.ts";
import { support, until } from "../support/env.ts";
import { cb, cbOk, cbWrite, setOp } from "../support/cb.ts";

const CUT = "30s Instagram cut";
const sharedRef = (m: Machine) => (findRev(readFileSync(join(m.bundle, "timeline.tsx"), "utf8"))?.rev as any)?.ref as string;
const gui = (app: Proc, name: string, field: string, value: unknown) => app.ask({ cmd: "serve", req: { e2e: "gui", set: [{ name, field, value }] } });
const runAgent = async (procs: Procs, m: Machine, actor: string, steps: unknown[], statusMs = 30_000) =>
  procs.start(actor, [support("agent.ts"), m.bundle, m.projectId, JSON.stringify({ steps, statusMs })], { env: { CARDBOARD_ACTOR: actor } }).next((x) => Array.isArray(x.results), 120_000);

async function world(t: test.TestContext, name: string) {
  const procs = new Procs();
  t.after(() => procs.close());
  const m = makeMachine(name);
  procs.watchHelpers(m.dbDir);
  const app = procs.start("app", [support("app.ts"), m.bundle, m.projectId, "{}"]);
  await app.next((x) => x.ready);
  return { procs, m, app };
}

test("S2 variants: cut new, edits on both cuts, fold --check, a fold with cards, a partial fold, then the rest", { timeout: 240_000 }, async (t) => {
  const { m, app } = await world(t, "s2");
  const ids = { clipA: itemNamed(m, SAMPLE.clipA)!.id, logo: itemNamed(m, SAMPLE.logo)!.id, title: itemNamed(m, SAMPLE.title)!.id };
  await gui(app, SAMPLE.clipA, "opacity", 0.7);
  await until(() => itemNamed(m, SAMPLE.clipA)?.opacity === 0.7 && sharedRef(m)?.startsWith("Main cut@2"), 20_000, "the GUI save on main");

  const made = await cbOk(m, ["cut", "new", CUT]);
  assert.equal(made.status, "confirmed", JSON.stringify(made));
  const cuts = (await cbOk(m, ["cut", "list"])).cuts;
  assert.deepEqual(cuts.map((c: any) => c.name).sort(), [CUT, "Main cut"]);
  // on the variant: an agent shortens it (re-words the title, raises the logo, dims clip A), each a cb write on that
  // cut handed to the app's lease holder (switching the app to the cut is s2's other test: B6)
  const cutId = cuts.find((c: any) => c.name === CUT).id;
  const agentActor = "director/chat2/turn1";
  for (const [id, f, v] of [[ids.title, "textContent", "30s version"], [ids.logo, "zIndex", 7], [ids.clipA, "opacity", 0.4]] as const) {
    const r = await cbWrite(m, { kind: "commit", cut: cutId, ops: [setOp("timelineItems", id, f, v)] }, { actor: agentActor });
    assert.equal(r.status, "confirmed", JSON.stringify(r));
  }
  // the variant holds the agent's edits, main doesn't
  const onCut = await cbOk(m, ["history", "--cut", CUT]);
  assert.equal(onCut.versions.filter((v: any) => v.by?.id === agentActor).length, 3, "the agent's three edits landed on the variant");
  assert.equal(itemNamed(m, SAMPLE.title)!.textContent, "Carton fixture", "main's files don't show the variant's edits");
  // on main: the person sets clip A's opacity too (a clash with the variant's 0.4)
  await gui(app, SAMPLE.clipA, "opacity", 0.2);
  await until(() => itemNamed(m, SAMPLE.clipA)?.opacity === 0.2, 20_000, "main's GUI save");
  const mainSeq = (await cbOk(m, ["history"])).versions[0].ref.seq;

  // fold --check: the card, nothing saved
  const check = await cbOk(m, ["fold", CUT, "--check"]);
  assert.equal(check.check, true);
  assert.deepEqual(check.cards.map((c: any) => c.path), [`timelineItems/${ids.clipA}/opacity`], JSON.stringify(check.cards));
  assert.equal((await cbOk(m, ["history"])).versions[0].ref.seq, mainSeq, "--check saved nothing");
  // a fold with a card and no decision: nothing saved, the card listed (exit 1)
  const blocked = await cb(m, ["fold", CUT]);
  assert.equal(blocked.json?.status, "conflicts", blocked.stdout);
  assert.equal((await cbOk(m, ["history"])).versions[0].ref.seq, mainSeq, "a fold with cards saved nothing");

  // fold in some of it: keep the logo change out, keep main's opacity
  const some = await cbOk(m, ["fold", CUT, "--reject", `timelineItems/${ids.logo}`, "--keep", "mine"]);
  assert.equal(some.status, "confirmed", JSON.stringify(some));
  await until(() => itemNamed(m, SAMPLE.title)?.textContent === "30s version", 20_000, "the fold in project.json");
  assert.equal(itemNamed(m, SAMPLE.clipA)!.opacity, 0.2, "--keep mine kept main's value");
  assert.equal(itemNamed(m, SAMPLE.logo)!.zIndex, 2, "the rejected record stayed out");
  const h = await cbOk(m, ["history", "--limit", "10"]);
  assert.deepEqual(h.versions.slice(0, 2).map((v: any) => v.kind), ["partial-revert", "merge"], "a merge, then an inverse change that lists what was kept out");
  assert.equal((await cbOk(m, ["credits", SAMPLE.title])).by.id, "director/chat2/turn1", "the folded edit keeps its author");

  // later: fold in the rest (R2-14: "Accept the rest later reverts that inverse")
  const rest = await cb(m, ["fold", CUT]);
  t.diagnostic(`cb fold after a partial fold: ${rest.stdout.trim()}`);
  await t.test("B4: `cb fold <cut>` after a partial fold folds in the rest", { todo: "B4, local-cli (cli-mcp): no cb/MCP path to fold in the rest; cb fold answers 'Already folded in'" }, async () => {
    await until(() => itemNamed(m, SAMPLE.logo)?.zIndex === 7, 5_000, "the logo change folded in");
  });
  // what that command would run: core's revert of the inverse change (History.acceptRest), as a cb write
  const inverse = h.versions[0].change as string;
  const local = await openLocal({ projectDir: m.bundle, projectId: m.projectId, adapter: cardboardAdapter as HostAdapter, actor: { kind: "human", id: "human:me", name: "me" } });
  try {
    const r = await local.write({ kind: "revert", changeId: inverse });
    assert.equal(r.status, "confirmed", JSON.stringify(r));
  } finally {
    await local.close();
  }
  await until(() => itemNamed(m, SAMPLE.logo)?.zIndex === 7, 20_000, "the rest folded in");
  assert.equal(itemNamed(m, SAMPLE.clipA)!.opacity, 0.2, "folding in the rest left the decided card alone");
  assert.equal((await cbOk(m, ["fold", CUT, "--check"])).status, "up-to-date");
});

test("S2 conflict cards: an agent's stale save clashes; `cb conflicts` lists the card and `cb resolve` picks it", { timeout: 240_000 }, async (t) => {
  const { procs, m, app } = await world(t, "s2-cards");
  const clipA = itemNamed(m, SAMPLE.clipA)!.id;
  const actor = "director/chat3/turn1";
  // the agent prints its view; the person then changes the same field; the agent saves from what it read
  const agent = procs.start(actor, [support("agent.ts"), m.bundle, m.projectId, JSON.stringify({ waitGo: true, steps: [{ op: "set", name: SAMPLE.clipA, set: { opacity: 0.33 } }] })], { env: { CARDBOARD_ACTOR: actor } });
  await agent.next((x) => x.printed);
  await gui(app, SAMPLE.clipA, "opacity", 0.6);
  await until(() => itemNamed(m, SAMPLE.clipA)?.opacity === 0.6, 20_000, "the person's save");
  agent.p.stdin!.write("go\n");
  const st = (await agent.next((x) => Array.isArray(x.results), 120_000)).results[0];
  // the newer value is kept and the agent's is a card (nothing lost); the sidecar says so
  assert.equal(st.status, "conflicts", JSON.stringify(st));
  assert.deepEqual(st.conflicts.map((c: any) => c.path), [`timelineItems/${clipA}/opacity`]);
  assert.equal(itemNamed(m, SAMPLE.clipA)!.opacity, 0.6, "head kept the person's newer value");
  const listed = await cbOk(m, ["conflicts"], { actor });
  t.diagnostic(JSON.stringify({ cbConflicts: listed }));
  await t.test("B5: a view save's conflict card is listed by `cb conflicts` and resolved by `cb resolve`", { todo: "B5, cardboard-adapter + local-cli: a file save's cards reach the agent as a notice without cards, which cb conflicts skips" }, async () => {
    assert.equal(listed.cards.length, 1, JSON.stringify(listed));
    const r = await cbOk(m, ["resolve", "1", "--keep", "mine"], { actor });
    assert.equal(r.status, "confirmed");
    await until(() => itemNamed(m, SAMPLE.clipA)?.opacity === 0.33, 10_000, "the agent's value picked");
    assert.equal((await cbOk(m, ["conflicts"], { actor })).cards.length, 0);
  });
});

test("S2 cut switch: the files follow the current cut, and an agent's view save on it gets its status sidecar", { timeout: 180_000 }, async (t) => {
  const { procs, m, app } = await world(t, "s2-switch");
  // main@2 by the person, then a cut from it: the cut's seqs start at 0, so main's seq 2 doesn't exist on it yet
  await gui(app, SAMPLE.clipA, "opacity", 0.7);
  await until(() => sharedRef(m)?.startsWith("Main cut@2"), 20_000, "the GUI save on main");
  await cbOk(m, ["cut", "new", CUT]);
  await cbOk(m, ["cut", "switch", CUT]);
  await t.test("B6a: after `cb cut switch` the shared timeline.tsx (and project.json) show the new cut", { todo: "B6, local-cli: runWrite's switch never tells the materializer head moved" }, async () => {
    await until(() => sharedRef(m)?.startsWith(`${CUT}@`), 5_000, `timeline.tsx to show "${CUT}" after cb cut switch`);
  });
  await t.test("B6b: an agent's view save on the cut it switched to gets its status sidecar", { todo: "B6, cardboard-adapter: the freeze keeps the old cut's baseSeq; the R7-01 rewrite pins it on the new cut and throws 'state unknown' (or pins a wrong state) after the commit, so no sidecar" }, async () => {
    const ag = await runAgent(procs, m, "director/chat2/turn2", [{ op: "set", name: SAMPLE.badge, set: { zIndex: 4 } }], 10_000);
    assert.equal(ag.results[0].status, "confirmed");
  });
  // the save itself landed on the cut (nothing lost), whatever the sidecar said
  const onCut = await cbOk(m, ["history", "--cut", CUT]);
  t.diagnostic(JSON.stringify({ onCut: onCut.versions.map((v: any) => [v.version, v.by?.id ?? null]) }));
});
