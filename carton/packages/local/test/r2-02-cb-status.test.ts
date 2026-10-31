// R2-02: `cb` statuses on a shared cut, on real processes (port of system-v11 test/r2-02-cb-status.test.mjs): a real
// sequencer host (server-node over WebSocket), the lease holder pushing, `cb` calls handing their writes to it.
//   - online: confirmed@seq, the server's seq;
//   - the server down: pending at once (offline), confirmed once it is back;
//   - a late conflict: a pending trim that another replica's trim of the same edge beats to the server comes back as a
//     notice at the start of the actor's next cb result, once.
//   - the Stop/SubagentStop hook, run as its own process as host Claude Code does, blocks that subagent once with the
//     conflict, lets it stop the second time, and hands what it left to the person.
// The immediate conflicts result (a stale-base save) is in review-3.test.ts.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { Carton, LOCAL_TABLES } from "@carton/core";
import type { Actor } from "@carton/core";
import { openSqliteStore, locateCartonDb } from "@carton/store-sqlite";
import { webSocketTransport } from "@carton/server-node";
import { spawnSync } from "node:child_process";
import { openLocal } from "../src/open.ts";
import { parseActorId } from "../src/identity.ts";
import { humanCards } from "../src/notices.ts";
import { adapter, bundle, doc0 } from "./support/real.ts";

const here = (f: string) => fileURLToPath(new URL(f, import.meta.url));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const set = (id: string, f: string, v: unknown) => ({ op: "set" as const, path: ["timelineItems", id, f], value: v });
// a Director subagent (its identity as the PreToolUse prefixer gives it), so its late conflict can come back through
// the SubagentStop hook
const agent: Actor = parseActorId("director/c2/t1/sub-editor-a1")!;

function proc(script: string, args: string[]) {
  const p = spawn(process.execPath, [here(script), ...args], { stdio: ["pipe", "pipe", "inherit"], env: { ...process.env, CARDBOARD_ACTOR: "", CLAUDECODE: "" } });
  const lines: any[] = [];
  const waiting: ((x: any) => void)[] = [];
  createInterface({ input: p.stdout! }).on("line", (l) => { const x = JSON.parse(l); const w = waiting.shift(); if (w) w(x); else lines.push(x); });
  return { p, next: () => new Promise<any>((r) => (lines.length ? r(lines.shift()) : waiting.push(r))), send: (l: string) => p.stdin!.write(l + "\n") };
}
async function until<T>(f: () => Promise<T | null | false | undefined>, ms = 60_000, what = "condition"): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await f();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(50);
  }
}

test("R2-02 cb statuses on a shared cut: confirmed@seq online, pending with the server down then confirmed, a late conflict on the next call once and through the SubagentStop hook once", async (t) => {
  const { dir, projectId } = bundle("r202");
  const procs: ReturnType<typeof spawn>[] = [];
  const startHost = async (port?: number) => { const h = proc("./support/host.ts", [dir, projectId, ...(port ? [String(port)] : [])]); procs.push(h.p); await h.next(); return h; };
  let host = await startHost();
  const { url, port } = JSON.parse(readFileSync(join(dir, "host.json"), "utf8"));
  const syncCfg = { url, tokenFile: join(dir, "token-alice") };
  const init = await openLocal({ projectDir: dir, projectId, adapter, init: { doc: doc0() }, actor: { kind: "human", id: "human:alice" } });
  await init.close();
  const startWorker = async () => { const w = proc("./support/real-worker.ts", [dir, projectId, "./real-sync-factory.ts", JSON.stringify(syncCfg)]); procs.push(w.p); await w.next(); return w; };
  let worker = await startWorker();
  const local = await openLocal({ projectDir: dir, projectId, adapter, actor: agent, helperFactory: here("./support/real-sync-factory.ts"), helperConfig: syncCfg });
  const rows = async () => { host.send("rows"); return (await host.next()).rows as { branch: string; seq: number; id: string }[]; };
  const statuses: string[] = [];
  try {
    const cut = local.carton.cut;
    assert.equal((await local.write({ kind: "share" })).status, "confirmed");
    await until(async () => (await local.carton.cuts()).find((c) => c.id === cut)!.sequencer.kind === "server", 30_000, "the cut to be shared");

    // online: confirmed@seq, the server's seq
    const r1 = await local.write({ kind: "commit", ops: [set("c1", "name", "online")] });
    assert.equal(r1.status, "confirmed", JSON.stringify(r1));
    const onServer = (await rows()).find((r) => r.id === r1.id);
    assert.ok(onServer && r1.status === "confirmed" && onServer.seq === r1.seq, "confirmed@seq is the server's seq");
    statuses.push(r1.status);

    // the server goes down: pending, at once (no 5 s wait when the holder knows it is offline)
    host.p.kill("SIGKILL");
    await until(async () => { const s = await local.write({ kind: "pin", owner: "probe" }); return s.status === "confirmed"; }, 5_000, "a holder to answer");
    await sleep(500);
    const t0 = Date.now();
    const r2 = await local.write({ kind: "commit", ops: [set("c2", "opacity", 0.4)] });
    assert.equal(r2.status, "pending", JSON.stringify(r2));
    statuses.push(r2.status);
    const offlineMs = Date.now() - t0;

    // a late conflict: the agent's trim of c5's end waits in the queue (server down) ...
    const r3 = await local.write({ kind: "commit", ops: [set("c5", "endTime", 29.4), set("c5", "trimEnd", 4.4)] });
    assert.equal(r3.status, "pending");
    worker.p.kill("SIGKILL"); // and nobody pushes it until a holder comes back
    // ... while bob, on another machine with the project, trims the same edge and reaches the server first
    host = await startHost(port);
    const { dbPath } = locateCartonDb({ bundleDir: dir, projectId });
    const aliceDb = await openSqliteStore(dbPath);
    const bobPath = join(dir, "bob.db");
    await aliceDb.exportCopy(bobPath, [...LOCAL_TABLES]);
    await aliceDb.close();
    const bob = await Carton.open({ adapter, store: await openSqliteStore(bobPath), actor: { kind: "human", id: "bob", name: "bob" },
      sync: { transport: webSocketTransport({ keepaliveMs: 0 }), url, token: readFileSync(join(dir, "token-bob"), "utf8").trim() } });
    const rb = await bob.commit({ ops: [set("c5", "endTime", 29), set("c5", "trimEnd", 4)] });
    const bobOutcome = rb.status === "pending" ? await bob.sync!.waitFor(rb.id, 30_000) : rb;
    assert.equal(bobOutcome.status, "confirmed", JSON.stringify(bobOutcome));
    await bob.close();

    // the agent's next cb call: a holder comes back (the app restarts), pushes the queue, the trim comes back carded
    worker = await startWorker();
    await until(async () => (await rows()).some((r) => r.id === r2.id), 30_000, "the offline edit to reach the server");
    statuses.push("pending→confirmed");
    const notice = await until(async () => {
      const r = await local.write({ kind: "commit", ops: [set("c0", "name", "next call")] });
      return r.notices.find((n) => n.change === r3.id) ?? null;
    }, 30_000, "the late conflict notice");
    assert.equal(notice.kind, "late-conflict");
    assert.ok(notice.cards?.some((c) => c.path.startsWith("timelineItems/c5")), JSON.stringify(notice));
    statuses.push("late:" + notice.kind);
    const again = await local.write({ kind: "commit", ops: [set("c0", "name", "and the one after")] });
    assert.ok(!again.notices.some((n) => n.change === r3.id), "delivered once");

    // the subagent tries to stop: its SubagentStop hook (a separate process per event) blocks once with the conflict
    const hook = (active: boolean) => {
      const out = spawnSync(process.execPath, [here("./support/stop-hook.ts"), dir, projectId], {
        input: JSON.stringify({ hook_event_name: "SubagentStop", session_id: "s1", agent_id: "a1", agent_type: "editor", stop_hook_active: active }),
        encoding: "utf8", env: { ...process.env, CARDBOARD_ACTOR: "director/c2/t1" },
      });
      return JSON.parse(out.stdout.trim().split("\n").at(-1)!);
    };
    const h1 = hook(false);
    assert.equal(h1.decision, "block", JSON.stringify(h1));
    assert.ok(h1.reason.includes(r3.id as string), "the block names the change that conflicted");
    const h2 = hook(true);
    assert.deepEqual(h2, {}, "stop_hook_active: it may stop now");
    assert.deepEqual(hook(false), {}, "blocked at most once per conflict set");
    const cards = await humanCards(local.store);
    assert.ok(cards.some((c) => c.change === r3.id), "what the subagent left is a card for the person");
    statuses.push("stop-hook:block-once");
    const c = await local.write({ kind: "pin", owner: "check" });
    assert.equal(c.status, "confirmed");
    t.diagnostic(JSON.stringify({ statuses, offlineAnswerMs: offlineMs }));
  } finally {
    await local.close();
    for (const p of procs) if (p.exitCode === null) p.kill("SIGKILL");
  }
});
