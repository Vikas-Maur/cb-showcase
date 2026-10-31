// Scenario 6: crash safety, with real processes killed with SIGKILL (TerminateProcess on Windows):
//   - the headless helper is killed in the middle of a push (its bytes held in the link, then delivered late, H1); the
//     next `cb` call takes over, the change is pushed again under the same id: one row on the server, its author kept;
//   - the app is killed in the middle of saves (its engine thread busy, a GUI save and an agent's view save written but
//     not applied yet); on restart both are applied once, neither credited to the wrong actor;
//   - the server restarts while both machines are syncing edits: both converge, nothing lost, nothing twice.
// Zero lost edits, zero edits re-attributed to another actor.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { makeMachine, itemNamed, SAMPLE, readEnvelope, type Machine } from "../support/project.ts";
import { Procs, killIfOurs } from "../support/procs.ts";
import { pkg, renameRetry, scratch, support, until, sleep } from "../support/env.ts";
import { cbOk, cbWrite, setOp } from "../support/cb.ts";
import { Link } from "../support/link.ts";
import { startHost } from "../support/hosts.ts";
import { twoMachines, state, gui, LOCAL_FACTORY, helperConfigFile } from "../support/live.ts";


test("S6 the helper is killed mid-push; the next cb takes over and retries under the same id: one row, its author kept (H1 late push included)", { timeout: 300_000 }, async (t) => {
  const procs = new Procs();
  let link: Link | null = null;
  const dir = scratch("s6-helper");
  const host = await startHost("node", dir, procs);
  t.after(async () => { await procs.close(); await link?.close(); await host.stop(); });
  link = await Link.open(host.port);
  // no app: a terminal agent's cb calls on a shared cut run through the detached helper (§6.2, R4-04)
  const m = makeMachine("s6-helper");
  procs.watchHelpers(m.dbDir);
  // the project's first cb call makes carton.db (main@1 = the import)
  const helper = { factory: LOCAL_FACTORY, config: { sync: { url: link.url(m.projectId), tokenFile: await host.tokenFile(m.home, "carol", m.projectId) } } };
  await initProject(m);
  const shared = await cbWrite(m, { kind: "share" }, { helper, actor: "codex/sharer" });
  assert.equal(shared.status, "confirmed", JSON.stringify(shared));
  await until(async () => (await cbOk(m, ["cut", "list"])).cuts[0].sequencer.kind === "server", 60_000, "the cut to become shared");
  const firstHelpers = procs.helperPids();
  assert.equal(firstHelpers.length, 1, "one helper took the lease");

  // a push in flight: the helper's connection is held in the link; cb answers pending after its wait
  link.hold();
  const clip = itemNamed(m, SAMPLE.clipA)!.id;
  const x = await cbWrite(m, { kind: "commit", ops: [setOp("timelineItems", clip, "opacity", 0.42)] }, { helper, actor: "director/chat6/turn1/sub-editor-k1", waitMs: 1500 });
  assert.equal(x.status, "pending", JSON.stringify(x));
  await until(() => link!.heldBytes > 0, 10_000, "the push to be on the wire");
  for (const pid of firstHelpers) killIfOurs(pid, [m.dbDir]);
  await sleep(200);
  // the next cb call finds the holder dead and takes over at once; the dead helper's queued change goes out again
  const t0 = Date.now();
  const y = await cbWrite(m, { kind: "commit", ops: [setOp("timelineItems", itemNamed(m, SAMPLE.logo)!.id, "zIndex", 8)] }, { helper, actor: "codex/next" });
  t.diagnostic(JSON.stringify({ takeoverCallMs: Date.now() - t0, y: y.status }));
  assert.ok(y.status === "confirmed" || y.status === "pending", JSON.stringify(y));
  const rows = await until(async () => { const r = (await host.rows(m.projectId))!; return r.some((q) => q.id === x.id) && r.some((q) => q.id === y.id) && r; }, 60_000, "both changes on the server");
  // the dead helper's push arrives late, after the takeover pushed it: acked as a duplicate, never a second row
  link.release();
  await sleep(1500);
  const after = (await host.rows(m.projectId))!;
  assert.equal(after.filter((r) => r.id === x.id).length, 1, "the change pushed twice is one row");
  assert.equal(new Set(after.map((r) => r.id)).size, after.length, "no change id twice on the server");
  assert.ok(after.length >= rows.length);
  // its author is the subagent that made it, not the helper that pushed it again
  await until(() => readEnvelope(m) && true, 1000);
  const h = await cbOk(m, ["history", "--limit", "20"]);
  const vx = h.versions.find((v: any) => v.change === x.id);
  assert.equal(vx?.by?.id, "director/chat6/turn1/sub-editor-k1", JSON.stringify(vx));
  assert.equal(h.versions.find((v: any) => v.change === y.id)?.by?.id, "codex/next");
  assert.equal((await cbOk(m, ["credits", SAMPLE.clipA])).by.id, "director/chat6/turn1/sub-editor-k1");
  assert.ok(procs.helperPids().length >= 2, "a second helper took over");
});

/** A project's first Carton open (main@1), as the app's first start would make it, then closed. */
async function initProject(m: Machine): Promise<void> {
  const procs = new Procs();
  try {
    const app = procs.start("init", [support("app.ts"), m.bundle, m.projectId, "{}"]);
    await app.next((x) => x.ready);
    await app.ask({ cmd: "exit" });
  } finally {
    await procs.close();
  }
}

test("S6 the app is killed mid-save (a GUI save and an agent's view save not applied yet): applied once on restart, credited right", { timeout: 240_000 }, async (t) => {
  const procs = new Procs();
  t.after(() => procs.close());
  const m = makeMachine("s6-app");
  procs.watchHelpers(m.dbDir);
  let app = procs.start("app", [support("app.ts"), m.bundle, m.projectId, "{}"]);
  await app.next((x) => x.ready);
  // an agent prints its view while the app is fine
  const actor = "director/chat7/turn1/sub-editor-v1";
  const agent = procs.start(actor, [support("agent.ts"), m.bundle, m.projectId, JSON.stringify({ waitGo: true, statusMs: 300_000, steps: [{ op: "set", name: SAMPLE.logo, set: { zIndex: 9 } }] })], { env: { CARDBOARD_ACTOR: actor } });
  await agent.next((x) => x.printed);
  // the engine thread is busy (for longer than the test needs: the app is killed during it); meanwhile the editor saves
  // project.json and the agent saves its view; then the app dies with both unapplied
  const marker = join(m.home, "stalled");
  const stalled = app.ask({ cmd: "serve", req: { e2e: "stall", ms: 120_000, marker } }).catch(() => null);
  await until(() => existsSync(marker), 30_000, "the engine thread to be stalled");
  const env = readEnvelope(m);
  env.project.timelineItems.find((i) => i.name === SAMPLE.title)!.fontSize = 133;
  env.project.stateUpdatedAt = Date.now();
  const tmp = join(m.bundle, ".project.json.gui.tmp");
  writeFileSync(tmp, JSON.stringify(env, null, 2));
  renameRetry(tmp, join(m.bundle, "project.json"));
  const viewFile = join(m.bundle, ".scratch", "views", `${(await agent.next((x) => x.printed)).printed.name}.tsx`);
  const printedText = readFileSync(viewFile, "utf8");
  agent.p.stdin!.write("go\n");
  await until(() => readFileSync(viewFile, "utf8") !== printedText, 10_000, "the agent's save on disk");
  assert.deepEqual((await cbOk(m, ["history"])).versions.map((v: any) => v.kind), ["import", "root"], "neither save applied before the crash");
  await app.kill("SIGKILL");
  void stalled;
  // restart: unseen saves are imported before anything is written over them
  app = procs.start("app-restarted", [support("app.ts"), m.bundle, m.projectId, "{}"]);
  await app.next((x) => x.ready, 60_000);
  await until(() => itemNamed(m, SAMPLE.title)?.fontSize === 133, 30_000, "the GUI save applied after the restart");
  const titleBy = (await cbOk(m, ["credits", SAMPLE.title])).by.id;
  assert.ok(titleBy === "human:me" || titleBy === "external:project.json", `the GUI save is the person's or an unattributed file save, never an agent's: ${titleBy}`);
  await t.test("B8: a view save the crashed app never applied is applied when the app restarts (and its sidecar written)", { todo: "B8, cardboard-adapter: Materializer.start() imports unseen saves of project.json and timeline.tsx, not of .scratch/views/*.tsx; applied only at the owner's next print" }, async () => {
    await until(() => itemNamed(m, SAMPLE.logo)?.zIndex === 9, 15_000, "the view save applied after the restart");
    assert.equal((await cbOk(m, ["credits", SAMPLE.logo])).by.id, actor, "the view save is its owner's, across the crash");
    // the agent that saved is still waiting on its sidecar (as AGENTS.md says): it hears about its save
    const out = await agent.next((x) => Array.isArray(x.results), 15_000);
    assert.equal(out.results[0].status, "confirmed", JSON.stringify(out.results[0]));
  });
  // never lost: the owner's next print applies the unread save first (then credits it to the owner)
  const reprint = procs.start(`${actor}-reprint`, [support("agent.ts"), m.bundle, m.projectId, JSON.stringify({ steps: [] })], { env: { CARDBOARD_ACTOR: actor } });
  await reprint.next((x) => Array.isArray(x.results), 60_000);
  await until(() => itemNamed(m, SAMPLE.logo)?.zIndex === 9, 20_000, "the view save applied at the owner's next print");
  assert.equal((await cbOk(m, ["credits", SAMPLE.logo])).by.id, actor, "the view save is its owner's, across the crash");
  const h = await cbOk(m, ["history", "--limit", "20"]);
  const changes = h.versions.filter((v: any) => v.change && v.kind !== "import");
  t.diagnostic(JSON.stringify(changes.map((v: any) => [v.version, v.by?.id])));
  assert.equal(changes.length, 2, "each save once");
});

test("S6 the server restarts with pushes on the wire: both machines converge, nothing lost, nothing twice", { timeout: 300_000 }, async (t) => {
  const { host, a, b } = await twoMachines(t, "node");
  const ids = new Map((readEnvelope(a.m).project.timelineItems).map((i) => [i.name, i.id]));
  const id = (name: string) => ids.get(name)!;
  const helperOf = (side: typeof a) => ({ factory: LOCAL_FACTORY, config: { sync: { url: side.link.url(side.m.projectId), tokenFile: join(side.m.home, `token-${side === a ? "alice" : "bob"}`) } } });
  const write = (side: typeof a, k: number, name: string, field: string, value: unknown, waitMs = 5000) =>
    cbWrite(side.m, { kind: "commit", ops: [setOp("timelineItems", id(name), field, value)] }, { actor: `codex/${side === a ? "a" : "b"}-${k}`, waitMs, helper: helperOf(side) });
  const plan = [
    [a, SAMPLE.title, "fontSize", 101], [b, SAMPLE.logo, "zIndex", 11], [a, SAMPLE.tone, "volume", 61],
    [b, SAMPLE.grade, "name", "Grade (B)"], [b, SAMPLE.clipA, "opacity", 0.61], [a, SAMPLE.badge, "zIndex", 5],
  ] as const;
  // two edits synced normally
  for (const k of [0, 1]) assert.equal((await write(plan[k][0], k, plan[k][1], plan[k][2], plan[k][3])).status, "confirmed");
  // B's next two pushes are on the wire (held in its link), A's next edit too; then the server dies and comes back
  // every connection, including any opened meanwhile (a reconnect, or a helper taking the lease over on a loaded runner)
  b.link.hold({ all: true });
  a.link.hold({ all: true });
  const inflight = [2, 3, 4].map((k) => write(plan[k][0], k, plan[k][1], plan[k][2], plan[k][3], 1000));
  await until(() => b.link.heldBytes > 0 && a.link.heldBytes > 0, 30_000, "pushes from both machines on the wire");
  const res = await Promise.all(inflight);
  t.diagnostic(JSON.stringify({ inflight: res.map((r) => r.status) }));
  for (const r of res) assert.equal(r.status, "pending", `unacknowledged: ${JSON.stringify(r)}`);
  await host.restart();
  a.link.release();
  b.link.release();
  // and one more edit after the restart
  const last = await write(plan[5][0], 5, plan[5][1], plan[5][2], plan[5][3]);
  assert.ok(last.status === "confirmed" || last.status === "pending", JSON.stringify(last));
  await until(async () => {
    const [ha, hb] = [await state(a.app), await state(b.app)];
    return typeof ha.docHash === "string" && ha.head.seq === hb.head.seq && ha.docHash === hb.docHash && ha.sync.pending === 0 && hb.sync.pending === 0;
  }, 90_000, "both machines on one head after the restart");
  for (const s of [a, b]) {
    await until(() => plan.every(([, name, field, value]) => itemNamed(s.m, field === "name" ? (value as string) : name)?.[field] === value), 30_000, "every edit in project.json");
    const hist = await cbOk(s.m, ["history", "--limit", "100"]);
    const changeIds = hist.versions.map((v: any) => v.change).filter(Boolean);
    assert.equal(new Set(changeIds).size, changeIds.length, "no change twice");
    for (const [k, [side, name]] of plan.entries()) assert.equal((await cbOk(s.m, ["credits", id(name)])).by.id, `codex/${side === a ? "a" : "b"}-${k}`, `${name}'s author`);
  }
  const rows = (await host.rows(a.m.projectId))!;
  assert.equal(new Set(rows.map((r) => r.id)).size, rows.length, "no change id twice on the server");
});

test("B7: with the app closed, a plain `cb` write on a shared cut starts a helper that syncs it (not 'open Carton with sync')", { timeout: 300_000, todo: "B7, local-cli + windows: the helper a cb starts gets no sync config (server URL, token file); nothing records it for the project" }, async (t) => {
  const { host, a, b } = await twoMachines(t, "node");
  await a.app.ask({ cmd: "exit" });
  rmSync(helperConfigFile(a.m), { force: true }); // the product's own behaviour: no recorded sync config
  const r = await cbWrite(a.m, { kind: "commit", ops: [setOp("timelineItems", itemNamed(a.m, SAMPLE.logo)!.id, "zIndex", 12)] }, { actor: "codex/closed-app" });
  assert.ok(r.status === "confirmed" || r.status === "pending", JSON.stringify(r));
  // synced for real: the server holds it, and the other machine sees it, credited to the agent
  await until(async () => (await host.rows(a.m.projectId))!.some((x) => x.id === r.id), 30_000, "the change on the server");
  await until(() => itemNamed(b.m, SAMPLE.logo)?.zIndex === 12, 30_000, "the change on B");
  assert.equal((await cbOk(b.m, ["credits", SAMPLE.logo])).by.id, "codex/closed-app");
});
