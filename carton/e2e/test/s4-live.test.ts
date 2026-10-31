// Scenario 4: live sync between two machines (two library roots, two apps each holding its own lease) through a real
// sequencer host, first server-node, then server-cloudflare under `wrangler dev` (locally only):
//   - the hand-off from a local to a shared cut (R3-03): seqs 1..n adopted verbatim, a commit made during it lands next;
//   - concurrent edits from both machines (a person's GUI save, an agent's cb write) reach both, in project.json too;
//   - `cb` answers `confirmed` online; offline it answers `pending` at once, and the change is confirmed after rejoining;
//   - one machine goes offline (its link really drops), edits, rejoins and rebases: both converge, nothing lost;
//   - a late conflict reaches the subagent that caused it once, through the SubagentStop hook, and `cb conflicts`;
//   - R1-01's four-step scenario with Bob's B1 coming from the other machine.
// Each machine reaches the host through its own TCP link (support/link.ts), so "offline" is a dropped connection.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { itemNamed, items, SAMPLE } from "../support/project.ts";
import { runOnce } from "../support/procs.ts";
import { dataDirFor, renameRetry, support, until } from "../support/env.ts";
import { cb, cbOk, cbWrite, setOp, CB_BIN } from "../support/cb.ts";
import { hostMissing } from "../support/hosts.ts";
import { openSqliteStore } from "@carton/store-sqlite";
import { humanCards } from "@carton/local";
import { twoMachines, state, gui, startApp } from "../support/live.ts";
import { makeMachine } from "../support/project.ts";
import { Link } from "../support/link.ts";

for (const kind of ["node", "cloudflare"] as const) {
  const skip = hostMissing(kind) ?? (kind === "cloudflare" && process.env.CARTON_E2E_CLOUDFLARE === "0" ? "CARTON_E2E_CLOUDFLARE=0" : false);
  test(`S4 live sync through ${kind === "node" ? "server-node" : "server-cloudflare (wrangler dev)"}: hand-off, concurrent edits, pending → confirmed, offline + rejoin, a late conflict back to its subagent once`, { timeout: 420_000, skip }, async (t) => {
    const { host, a, b, shareRows } = await twoMachines(t, kind);
    const id = (name: string) => itemNamed(a.m, name)!.id;

    // --- concurrent edits, one from each machine (a person's GUI save on A, an agent's cb write on B)
    const [ga, rb] = await Promise.all([
      gui(a.app, SAMPLE.title, "textContent", "Shared title"),
      cbWrite(b.m, { kind: "commit", ops: [setOp("timelineItems", id(SAMPLE.grade), "name", "Warm grade (Bob)")] }, { actor: "director/chatB/turn1" }),
    ]);
    void ga;
    assert.equal(rb.status, "confirmed", `online, cb waits for the server's ack: ${JSON.stringify(rb)}`);
    for (const s of [a, b]) await until(() => itemNamed(s.m, SAMPLE.title)?.textContent === "Shared title" && itemNamed(s.m, "Warm grade (Bob)"), 30_000, `both edits on ${s === a ? "A" : "B"}`);

    // --- B goes offline: cb answers pending at once; B edits on, A edits the same field meanwhile
    b.link.down();
    await until(async () => (await state(b.app)).sync?.status === "offline", 30_000, "B to notice it is offline");
    const sub = "director/chatB/turn2/sub-editor-x1";
    const t0 = Date.now();
    const pend = await cbWrite(b.m, { kind: "commit", ops: [setOp("timelineItems", id(SAMPLE.clipA), "opacity", 0.3)] }, { actor: sub });
    assert.equal(pend.status, "pending", JSON.stringify(pend));
    t.diagnostic(JSON.stringify({ offlineAnswerMs: Date.now() - t0 }));
    await gui(b.app, SAMPLE.clipFast, "name", "Clip A fast (Bob, offline)");
    // a second cb write while offline, on a field nobody else touches: pending now, confirmed after the rejoin
    const pend2 = await cbWrite(b.m, { kind: "commit", ops: [setOp("timelineItems", id(SAMPLE.badge), "zIndex", 4)] }, { actor: sub });
    assert.equal(pend2.status, "pending", JSON.stringify(pend2));
    await until(async () => /^Offline: 3 edits waiting$/.test((await state(b.app)).sync?.label ?? ""), 20_000, "B's status: Offline: 3 edits waiting");
    await gui(a.app, SAMPLE.clipA, "opacity", 0.8);
    await until(() => itemNamed(a.m, SAMPLE.clipA)?.opacity === 0.8, 20_000, "A's clashing edit");
    const aOther = await cbWrite(a.m, { kind: "commit", ops: [setOp("timelineItems", id(SAMPLE.tone), "volume", 55)] }, { actor: "codex/alice-agent" });
    assert.equal(aOther.status, "confirmed", JSON.stringify(aOther));

    // --- B rejoins: its two edits rebase onto A's; both machines converge on one head, nothing lost
    b.link.up();
    await until(async () => (await state(b.app)).sync?.status === "up-to-date", 60_000, "B back up to date");
    const heads = await until(async () => {
      const [ha, hb] = [await state(a.app), await state(b.app)];
      return typeof ha.docHash === "string" && ha.head.seq === hb.head.seq && ha.docHash === hb.docHash && ha.sync.pending === 0 && hb.sync.pending === 0 && [ha, hb];
    }, 60_000, "A and B on the same head");
    t.diagnostic(JSON.stringify({ head: heads[0].head.seq, shareRows }));
    for (const s of [a, b]) {
      await until(() => itemNamed(s.m, "Clip A fast (Bob, offline)") && itemNamed(s.m, SAMPLE.tone)?.volume === 55, 30_000, "every edit in project.json").catch(async (e) => {
        const idle = (await s.app.ask({ cmd: "serve", req: { e2e: "idle" } })).result;
        throw new Error(`${e.message} on ${s === a ? "A" : "B"}: fast=${JSON.stringify(itemNamed(s.m, "Clip A fast (Bob, offline)")?.name ?? itemNamed(s.m, SAMPLE.clipFast)?.name)} tone=${itemNamed(s.m, SAMPLE.tone)?.volume} head=${JSON.stringify((await state(s.app)).head)} mz=${JSON.stringify(idle.log)}`);
      });
      assert.equal(itemNamed(s.m, SAMPLE.clipA)!.opacity, 0.8, "the clash kept the change confirmed first; B's value is a card, not lost");
    }
    // the pending change was confirmed once by the server: its id appears exactly once in history on both machines
    for (const s of [a, b]) {
      const h = await cbOk(s.m, ["history", "--limit", "100"]);
      const ids = h.versions.map((v: any) => v.change).filter(Boolean);
      assert.equal(new Set(ids).size, ids.length, "no change twice");
      assert.equal((await cbOk(s.m, ["credits", "Clip A fast (Bob, offline)"])).by.id, "human:me", "B's offline GUI edit is the person's");
      assert.equal((await cbOk(s.m, ["credits", SAMPLE.tone])).by.id, "codex/alice-agent");
    }
    // the id cb answered `pending` with is the change the server confirmed: on A's history, by its author
    const onA = (await cbOk(a.m, ["history", "--limit", "100"])).versions.find((v: any) => v.change === pend2.id);
    assert.equal(onA?.by?.id, sub, `the pending change ${pend2.id}, confirmed and attributed: ${JSON.stringify(onA)}`);
    const rows = await host.rows(a.m.projectId);
    if (rows) {
      assert.equal(new Set(rows.map((r) => r.id)).size, rows.length, "no change id twice on the server");
      assert.equal(rows.filter((r) => r.id === pend2.id).length, 1);
    }

    // --- the late conflict reaches the subagent that caused it: once through SubagentStop, and in cb conflicts
    const hook = (active: boolean) => runOnce("hook stop", [CB_BIN, "hook", "stop", "--project", b.m.bundle, "--data-dir", dataDirFor(b.m.bundle)], {
      env: { CARDBOARD_ACTOR: "director/chatB/turn2" },
      input: JSON.stringify({ hook_event_name: "SubagentStop", session_id: "sess-b", agent_id: "x1", agent_type: "editor", stop_hook_active: active, cwd: b.m.bundle }),
    });
    // (B9, fixed in foundation 35c6776: the notice was addressed to the lease holder's actor, not the change's author)
    await t.test("SubagentStop blocks once with the late conflict of the subagent's absorbed change; the card goes to the person after", async () => {
      const first = JSON.parse((await hook(false)).stdout.trim() || "{}");
      if (first.decision !== "block") {
        const st = await openSqliteStore(join(b.m.dbDir, "carton.db"));
        const rows = await st.range("notices");
        await st.close();
        assert.fail(`SubagentStop blocks with the late conflict: ${JSON.stringify(first)}; B's notices: ${JSON.stringify(rows.map((r) => [r.key[0], (r.value as any).kind, (r.value as any).change, ((r.value as any).cards ?? []).length]))}; the pending change was ${pend.id}`);
      }
      assert.match(String(first.reason), new RegExp(id(SAMPLE.clipA)), "the reason names the clip");
      const second = JSON.parse((await hook(true)).stdout.trim() || "{}");
      assert.deepEqual(second, {}, "at most once per conflict set (stop_hook_active)");
      const third = JSON.parse((await hook(false)).stdout.trim() || "{}");
      assert.deepEqual(third, {}, "a conflict already delivered never blocks again");
      // what the subagent left unresolved is the person's now: the card with both values, never dropped (§6.2)
      const st = await openSqliteStore(join(b.m.dbDir, "carton.db"));
      try {
        const cards = (await humanCards(st)).flatMap((n) => n.cards ?? []);
        const card = cards.find((c) => c.path.startsWith(`timelineItems/${id(SAMPLE.clipA)}`));
        assert.ok(card, `the person's cards hold the subagent's clash: ${JSON.stringify(cards)}`);
        assert.equal((card as any).theirs?.opacity ?? (card as any).theirs, 0.3, "the subagent's value is in the card");
      } finally {
        await st.close();
      }
    });
    // the card stays the agent's (or the person's, once handed over): never dropped
    const listed = await cb(b.m, ["conflicts"], { actor: sub });
    t.diagnostic(JSON.stringify({ subConflicts: listed.json }));
  });
}

// R1-01, the four-step scenario, on two real replicas (cardboard-adapter's conformance test runs it in single-sequencer
// form): 1. Alice's GUI edit E1 lands on A and timeline.tsx shows it under its header ref; 2. Bob's B1, made offline on
// B on the state before E1, arrives after it; 3. a terminal agent on A read timeline.tsx when it showed E1 and not B1,
// and saves its edit long after both landed (a stale writer on the legacy shared file); 4. the merge uses the header's
// state as base: E1 kept, B1 kept (never silently reverted), the agent's edit applied, nothing re-attributed.
for (const kind of ["node", "cloudflare"] as const) {
  const skip = hostMissing(kind) ?? (kind === "cloudflare" && process.env.CARTON_E2E_CLOUDFLARE === "0" ? "CARTON_E2E_CLOUDFLARE=0" : false);
  for (const overlap of [false, true]) {
    test(`R1-01 four-step on two replicas through ${kind}, ${overlap ? "b: E1 and B1 trim the same clip" : "a: E1 and B1 touch different clips"}`, { timeout: 300_000, skip }, async (t) => {
      // the shared file is frozen against GUI and remote changes for a while after any cb write (§6.4 freeze
      // triggers, 60 s); the setup's cb writes would hold step 1 back that long, so the apps use 2 s
      const { a, b } = await twoMachines(t, kind, { freezeIdleMs: 2000 });
      const id = (name: string) => itemNamed(a.m, name)!.id;
      // B goes offline first, so its B1 is made on the state before E1
      b.link.down();
      await until(async () => (await state(b.app)).sync?.status === "offline", 30_000, "B offline");
      // 1. E1 (Alice, GUI on A). "Clip A fast" plays at speed 2: a trim moves its source twice as far as the timeline
      // (an inconsistent pair is "unclassified" and becomes a card, rightly)
      if (overlap) await a.app.ask({ cmd: "serve", req: { e2e: "gui", who: "alice", set: [{ name: SAMPLE.clipFast, field: "endTime", value: 3 }, { name: SAMPLE.clipFast, field: "trimEnd", value: 3 }] } });
      else await a.app.ask({ cmd: "serve", req: { e2e: "gui", who: "alice", set: [{ name: SAMPLE.clipA, field: "opacity", value: 0.5 }] } });
      const shared = join(a.m.bundle, "timeline.tsx");
      const read = await until(() => {
        const text = readFileSync(shared, "utf8");
        const body = JSON.parse(text.slice(text.indexOf("\n{") + 1));
        const it = (body.timelineItems as any[]).find((i) => i.name === (overlap ? SAMPLE.clipFast : SAMPLE.clipA));
        return (overlap ? it.endTime === 3 : it.opacity === 0.5) && { text, body };
      }, 20_000, "3a. the shared timeline.tsx to show E1");
      // 2. B1 (Bob, GUI on B, offline): made on the state before E1, arrives after it
      if (overlap) await b.app.ask({ cmd: "serve", req: { e2e: "gui", who: "bob", set: [{ name: SAMPLE.clipFast, field: "startTime", value: 1.6 }, { name: SAMPLE.clipFast, field: "trimStart", value: 0.2 }] } });
      else await b.app.ask({ cmd: "serve", req: { e2e: "gui", who: "bob", set: [{ name: SAMPLE.clipFast, field: "name", value: "Bob's cut" }] } });
      await until(async () => (await state(b.app)).sync?.pending > 0, 20_000, "B1 queued on B");
      b.link.up();
      await until(async () => (await cbOk(a.m, ["history", "--limit", "20"])).versions.some((v: any) => v.by?.id === "human:bob"), 60_000, "B1 to reach A").catch(async (e) => {
        const hb = await cbOk(b.m, ["history", "--limit", "10"]);
        throw new Error(`${e.message}\nB: ${JSON.stringify(await state(b.app))}\nB history: ${JSON.stringify(hb.versions.map((v: any) => [v.version, v.by?.id, v.kind, v.change]))}\nB notices: ${JSON.stringify((await cb(b.m, ["conflicts"])).json)}`);
      });
      // 3b. the agent saves from its read: E1 but not B1, plus its own edit of the logo
      const items = (read.body.timelineItems as any[]).map((i) => (i.name === SAMPLE.logo ? { ...i, zIndex: 6 } : i));
      const head = read.text.slice(0, read.text.indexOf("\n{") + 1);
      writeFileSync(`${shared}.agent.tmp`, head + JSON.stringify({ ...read.body, timelineItems: items }, null, 1) + "\n");
      renameRetry(`${shared}.agent.tmp`, shared);
      // 4. everything lands, on both machines
      for (const s of [a, b]) {
        await until(() => itemNamed(s.m, SAMPLE.logo)?.zIndex === 6, 60_000, `the agent's edit on ${s === a ? "A" : "B"}`);
        const fast = itemNamed(s.m, overlap ? SAMPLE.clipFast : "Bob's cut");
        assert.ok(fast, "B1 kept, not reverted");
        if (overlap) {
          assert.deepEqual([fast!.endTime, fast!.trimEnd], [3, 3], "E1 kept");
          assert.deepEqual([fast!.startTime, fast!.trimStart], [1.6, 0.2], "B1 kept, composed with E1");
        } else {
          assert.equal(itemNamed(s.m, SAMPLE.clipA)!.opacity, 0.5, "E1 kept");
        }
      }
      const h = await cbOk(a.m, ["history", "--limit", "20"]);
      const recent = h.versions.filter((v: any) => v.change).slice(0, 3).map((v: any) => v.by?.id);
      assert.deepEqual(recent, ["external:timeline.tsx", "human:bob", "human:alice"], "three changes: E1 by Alice, B1 by Bob, then the agent's (an unhooked writer of the shared file)");
      assert.equal((await cbOk(a.m, ["credits", overlap ? SAMPLE.clipFast : SAMPLE.clipA])).by.id, overlap ? "human:bob" : "human:alice", "E1/B1 keep their authors");
      assert.equal((await cbOk(a.m, ["credits", SAMPLE.logo])).by.id, "external:timeline.tsx");
      const d = await cbOk(a.m, ["compare", `main@${h.versions[1].ref.seq}`, `main@${h.versions[0].ref.seq}`]);
      assert.equal(d.ops, 1, `the agent's change touches only the logo: ${JSON.stringify(d.changes)}`);
      void id;
    });
  }
}

// Agents through their per-agent views on a shared cut (the documented flow, §6.4): the status sidecar says `pending`
// at once, then the server's answer; offline, an agent's three dependent edits each say `pending` and it edits on from
// its own file; after the rejoin all three land, attributed, and its sidecar settles.
test("S4 view agents on a shared cut: online pending → confirmed; offline three dependent edits, settled after the rejoin (the product's own sidecar wiring, B10 fixed)", { timeout: 300_000 }, async (t) => {
  const { a, b, procs } = await twoMachines(t, "node");
  const agent = (actor: string, cfg: Record<string, unknown>) => procs.start(actor, [support("agent.ts"), b.m.bundle, b.m.projectId, JSON.stringify(cfg)], { env: { CARDBOARD_ACTOR: actor } });
  const online = await agent("director/chatV/turn1/sub-editor-o1", { settled: true, statusMs: 30_000, steps: [{ op: "set", name: SAMPLE.logo, set: { zIndex: 6 } }] }).next((x) => Array.isArray(x.results), 120_000);
  assert.equal(online.results[0].status, "confirmed", JSON.stringify(online.results[0]));
  await until(() => itemNamed(a.m, SAMPLE.logo)?.zIndex === 6, 30_000, "the view save on A");
  b.link.down();
  await until(async () => (await state(b.app)).sync?.status === "offline", 30_000, "B offline");
  const sub = "director/chatV/turn2/sub-editor-o2";
  const steps = [
    { op: "insert", like: SAMPLE.title, id: "title-V", name: "Title V", set: { textContent: "V v1", startTime: 6, endTime: 7, trimStart: 0, trimEnd: 1 } },
    { op: "set", name: "Title V", set: { textContent: "V v2" } },
    { op: "set", name: "Title V", set: { startTime: 7, endTime: 8 } },
  ];
  const off = await agent(sub, { steps }).next((x) => Array.isArray(x.results), 120_000);
  assert.deepEqual(off.results.map((r: any) => r.status), ["pending", "pending", "pending"], "offline, each save is acknowledged as pending");
  b.link.up();
  await until(() => itemNamed(a.m, "Title V")?.textContent === "V v2" && itemNamed(a.m, "Title V")?.startTime === 7, 60_000, "the three offline edits on A");
  const statusFile = join(b.m.bundle, off.view.path.replace(/\.tsx$/, ".status"));
  const settled = await until(() => { const s = JSON.parse(readFileSync(statusFile, "utf8")); return s.status !== "pending" && s; }, 30_000, "the agent's sidecar to settle");
  assert.equal(settled.status, "confirmed", JSON.stringify(settled));
  const h = await cbOk(a.m, ["history", "--limit", "30"]);
  assert.equal(h.versions.filter((v: any) => v.by?.id === sub).length, 3, "three changes by the offline subagent, on the other machine");
  assert.equal(items(a.m).filter((i) => i.name === "Title V").length, 1, "no duplicate");
});

// "Invite to edit" (§0.1): a machine that holds nothing of the project joins the shared cut from the invite (the cut's
// record and root, support/invite.ts) with an empty carton.db; every row comes from the host. Its files show A's edits,
// and edits from either machine reach the other.
test("S4 a machine joins a shared cut from an empty store (Invite to edit): catches up from the host, edits both ways", { timeout: 300_000 }, async (t) => {
  const { host, a, procs } = await twoMachines(t, "node");
  const inv = await runOnce("invite", [support("invite.ts"), join(a.m.dbDir, "carton.db")]);
  assert.equal(inv.code, 0, inv.stderr);
  const invite = inv.lines.at(-1);
  assert.equal(invite.cut.sequencer.kind, "server");
  // C has the project's files as they were before any of A's edits (the fixture): only Carton can bring A's edits in
  const c = makeMachine("s4-join-c");
  assert.equal(c.projectId, a.m.projectId);
  assert.ok(!existsSync(join(c.dbDir, "carton.db")), "nothing of A's carton.db on C");
  assert.ok(itemNamed(c, SAMPLE.logo)?.zIndex !== 3 && itemNamed(c, SAMPLE.title)?.fontSize !== 110, "C's files don't have A's edits yet");
  const linkC = await Link.open(host.port);
  t.after(() => linkC.close());
  const appC = await startApp(procs, c, host, "carol", linkC, { join: invite });
  await until(async () => (await state(appC)).sync?.status === "up-to-date", 60_000, "C caught up from the host");
  await until(async () => { const [ha, hc] = [await state(a.app), await state(appC)]; return typeof ha.docHash === "string" && ha.docHash === hc.docHash && ha.head.seq === hc.head.seq; }, 60_000, "C on A's head");
  await until(() => itemNamed(c, SAMPLE.logo)?.zIndex === 3 && itemNamed(c, SAMPLE.title)?.fontSize === 110, 30_000, "C's files to show A's edits");
  const h = await cbOk(c, ["history", "--limit", "20"]);
  t.diagnostic(JSON.stringify({ joinedHistory: h.versions.map((v: any) => [v.version, v.by?.id ?? null]) }));
  // edits both ways
  const rc = await cbWrite(c, { kind: "commit", ops: [setOp("timelineItems", itemNamed(c, SAMPLE.badge)!.id, "zIndex", 7)] }, { actor: "codex/carol" });
  assert.equal(rc.status, "confirmed", JSON.stringify(rc));
  await gui(a.app, SAMPLE.tone, "volume", 42);
  for (const s of [a.m, c]) await until(() => itemNamed(s, SAMPLE.badge)?.zIndex === 7 && itemNamed(s, SAMPLE.tone)?.volume === 42, 30_000, "both edits on both machines");
  assert.equal((await cbOk(a.m, ["credits", SAMPLE.badge])).by.id, "codex/carol");
});
