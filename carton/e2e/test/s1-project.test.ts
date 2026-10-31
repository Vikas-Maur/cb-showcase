// Scenario 1: a real Cardboard project on disk (the bundle Cardboard 1.4.0's own CLI wrote), the app's engine thread
// holding the sync lease with the materializer watching the bundle, and real `cb` and agent processes:
//   - the import as main@1 and the shared timeline.tsx header contract;
//   - a person's GUI save (project.json, temp + rename) applied through the materializer and credited to them;
//   - a Director turn plus two parallel subagents, each making three dependent edits through its own per-agent view
//     (print --view handed to the lease holder over its control socket; status sidecars): all edits land, each
//     credited down to the subagent (R2-03);
//   - `cb history`, `cb credits`, `cb undo --turn` (the whole turn, subagents included, the person's edit kept) and
//     `cb restore`, each through the standalone `carton` bin.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { findRev } from "@carton/cardboard";
import { makeMachine, itemNamed, items, SAMPLE } from "../support/project.ts";
import { Procs } from "../support/procs.ts";
import { support, until } from "../support/env.ts";
import { cb, cbOk } from "../support/cb.ts";
import { named, untilShown } from "../support/head.ts";

const DIRECTOR = "director/chat1/turn1";
const SUB = (x: string) => `${DIRECTOR}/sub-editor-${x}`;

/** A subagent's three dependent edits on a title it adds: insert, re-word, re-time (each needs the one before). */
const titleSteps = (x: string, at: number) => [
  { op: "insert", like: SAMPLE.title, id: `title-${x}`, name: `Title ${x}`, set: { textContent: `${x} v1`, startTime: at, endTime: at + 1, trimStart: 0, trimEnd: 1 } },
  { op: "set", name: `Title ${x}`, set: { textContent: `${x} v2` } },
  { op: "set", name: `Title ${x}`, set: { startTime: at + 1, endTime: at + 2 } },
];

test("S1 a real Cardboard project: GUI save, a Director turn with two parallel subagents × three dependent edits through their views, history, credits, undo --turn, restore, header contract", { timeout: 240_000 }, async (t) => {
  const procs = new Procs();
  t.after(() => procs.close());
  const m = makeMachine("s1");
  procs.watchHelpers(m.dbDir);
  const app = procs.start("app", [support("app.ts"), m.bundle, m.projectId, "{}"]);
  await app.next((x) => x.ready);

  // --- the import (§16) and the shared file's header contract (R7-01)
  const shared = readFileSync(join(m.bundle, "timeline.tsx"), "utf8");
  const rev = findRev(shared)?.rev;
  assert.equal(rev?.kind, "carton", "Carton's header replaced 1.4.0's timestamp rev");
  assert.match((rev as any).ref, /^Main cut@1~[0-9a-f]{8}$/, "the header names main@1, the imported project");
  assert.match(String((rev as any).branch8), /^[0-9a-f]{8}$/);
  assert.match(String((rev as any).nonce), /^[0-9a-z]{8}$/i);
  let h = await cbOk(m, ["history"]);
  assert.deepEqual(h.versions.map((v: any) => [v.version, v.kind, v.by?.id ?? null]), [["main@1", "import", "import"], ["main@0", "root", null]]);

  // --- a person's GUI save: Cardboard writes project.json; the materializer applies it, credited to the person
  await app.ask({ cmd: "serve", req: { e2e: "gui", set: [{ name: SAMPLE.title, field: "fontSize", value: 150 }] } });
  h = await until(async () => { const x = await cbOk(m, ["history"]); return x.versions[0]?.by?.id === "human:me" && x; }, 20_000, "the GUI save in history");
  assert.equal((await cbOk(m, ["credits", SAMPLE.title])).by.id, "human:me", "credits name the person");
  const guiSeq = h.versions[0].ref.seq;

  // --- a Director turn and two parallel subagents, each through its own view (the documented flow)
  const agent = (actor: string, steps: unknown[]) => procs.start(actor, [support("agent.ts"), m.bundle, m.projectId, JSON.stringify({ steps })], { env: { CARDBOARD_ACTOR: actor } });
  const runs = [
    agent(DIRECTOR, [{ op: "set", name: SAMPLE.clipA, set: { opacity: 0.5 } }]),
    agent(SUB("A"), titleSteps("A", 4)),
    agent(SUB("B"), titleSteps("B", 8)),
  ];
  const outs = await Promise.all(runs.map((r) => r.next((x) => Array.isArray(x.results), 120_000)));
  for (const o of outs) for (const s of o.results) assert.equal(s.status, "confirmed", `${o.actor}: ${JSON.stringify(s)}`);
  t.diagnostic(JSON.stringify({ printRetries: outs.map((o) => o.printRetries) })); // B3: > 0 when a cb took the lease over
  assert.equal(new Set(outs.map((o) => o.view.name)).size, 3, "three distinct view files");
  for (const o of outs) {
    assert.ok(existsSync(join(m.bundle, o.view.path)), o.view.path);
    const vr = findRev(readFileSync(join(m.bundle, o.view.path), "utf8"))?.rev as any;
    assert.equal(vr?.kind, "carton", "each view keeps Carton's header (its print's pin)");
  }

  // all six subagent edits (and the Director's) are in head, on disk and in project.json, once each
  // (the Director's own save can land last: B3's retries delay its print on a loaded machine)
  await until(() => itemNamed(m, "Title B")?.startTime === 9 && itemNamed(m, "Title A")?.startTime === 5 && itemNamed(m, SAMPLE.clipA)?.opacity === 0.5, 30_000, "project.json to show head");
  for (const [x, at] of [["A", 5], ["B", 9]] as const) {
    const it = itemNamed(m, `Title ${x}`)!;
    assert.equal(it.textContent, `${x} v2`, `${x}'s second edit landed`);
    assert.deepEqual([it.startTime, it.endTime], [at, at + 1], `${x}'s third edit landed`);
  }
  assert.equal(items(m).filter((i) => /^Title [AB]$/.test(i.name ?? "")).length, 2, "no duplicate titles");
  if (itemNamed(m, SAMPLE.clipA)!.opacity !== 0.5) {
    const hist = await cbOk(m, ["history", "--limit", "30"]);
    const steps = [];
    for (const v of hist.versions.filter((x: any) => x.ref.seq > 1).reverse()) steps.push([v.version, v.by?.id ?? null, (await cbOk(m, ["compare", `main@${v.ref.seq - 1}`, v.version])).changes]);
    assert.fail(`the Director's edit isn't in project.json (Clip A opacity ${itemNamed(m, SAMPLE.clipA)!.opacity}); history ${JSON.stringify(steps)}; Director ${JSON.stringify(outs[0])}`);
  }
  assert.equal(itemNamed(m, SAMPLE.title)!.fontSize, 150, "the person's GUI edit is still there");

  // history: every version, attributed down to the subagent (R2-03)
  h = await cbOk(m, ["history", "--limit", "50"]);
  const by = (id: string) => h.versions.filter((v: any) => v.by?.id === id);
  for (const x of ["A", "B"]) {
    const mine = by(SUB(x));
    assert.equal(mine.length, 3, `three versions by sub-editor-${x}`);
    assert.ok(mine.every((v: any) => v.by.agentType === "editor" && v.by.agentId === x && v.by.turn === "turn1" && v.by.chat === "chat1"), JSON.stringify(mine[0]?.by));
    assert.equal((await cbOk(m, ["credits", `title-${x}`])).by.id, SUB(x), `credits name sub-editor-${x}`);
  }
  assert.equal(by(DIRECTOR).length, 1, "one version by the Director itself");
  assert.equal((await cbOk(m, ["credits", SAMPLE.clipA])).by.id, DIRECTOR);
  const ids = h.versions.map((v: any) => v.change).filter(Boolean);
  assert.equal(new Set(ids).size, ids.length, "no change id twice");
  const beforeUndo = h.versions[0].version;

  // --- undo the whole turn (Director and subagents): one undo change; the person's GUI edit stays
  const u = await cbOk(m, ["undo", "--turn", "turn1"]);
  assert.equal(u.status, "confirmed", JSON.stringify(u));
  const undone = await untilShown(m, (l) => !named(l, "Title A") && !named(l, "Title B") && named(l, SAMPLE.clipA)!.opacity === 0.9, "the turn undone");
  assert.equal(named(undone, SAMPLE.title)!.fontSize, 150, "undo --turn kept the person's edit");
  h = await cbOk(m, ["history", "--limit", "50"]);
  assert.equal(h.versions[0].kind, "undo");
  assert.equal(h.versions.filter((v: any) => v.kind === "undo").length, 1, "one undo change for the whole turn");

  // --- restore the version before the undo: saved as a new version, every edit back
  const r = await cbOk(m, ["restore", beforeUndo]);
  assert.equal(r.status, "confirmed", JSON.stringify(r));
  const restored = await untilShown(m, (l) => named(l, "Title A")?.textContent === "A v2" && named(l, "Title B")?.startTime === 9, "the restore");
  h = await cbOk(m, ["history", "--limit", "50"]);
  assert.ok(h.versions[0].ref.seq > guiSeq + 7, "restore is a new version, history kept");
  assert.equal(named(restored, SAMPLE.clipA)!.opacity, 0.5);

  // the shared timeline.tsx: a valid header that core resolves exactly (a stale or unknown one would fail loudly)
  const sharedRev = findRev(readFileSync(join(m.bundle, "timeline.tsx"), "utf8"))?.rev as any;
  assert.equal(sharedRev?.kind, "carton");
  const cmp = await cb(m, ["compare", `${sharedRev.ref} b:${sharedRev.branch8}`]);
  assert.equal(cmp.code, 0, `the shared file's header resolves: ${cmp.stdout}${cmp.stderr}`);
  await app.ask({ cmd: "exit" });
});
