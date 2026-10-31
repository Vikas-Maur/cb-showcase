// R3-03: the sequencer hand-off (local → handing off → server, §5.3) on real processes: a real sequencer host
// (server-node over WebSocket), the app's engine thread holding the lease, and `cb` calls handing their writes to it.
// Port of system-v11 test/r3-03-handoff.test.mjs: commits made during the upload stay pending and become the next seqs;
// the cut's seqs 1..n are adopted verbatim, once; nothing is sequenced locally after n; when the holder dies in the
// middle of the hand-off (its ack never arrives), the next holder asks the server and never sequences locally again.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { openLocal } from "../src/open.ts";
import type { LocalCarton } from "../src/open.ts";
import { adapter, bundle, doc0 } from "./support/real.ts";

const here = (f: string) => fileURLToPath(new URL(f, import.meta.url));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const set = (id: string, f: string, v: unknown) => ({ op: "set", path: ["timelineItems", id, f], value: v });

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

async function world(name: string) {
  const { dir, projectId } = bundle(name);
  const host = proc("./support/host.ts", [dir, projectId]);
  await host.next();
  const { url } = JSON.parse(readFileSync(join(dir, "host.json"), "utf8"));
  const syncCfg = { url, tokenFile: join(dir, "token-alice") };
  const open = () => openLocal({ projectDir: dir, projectId, adapter, actor: { kind: "agent", id: "codex/hand-off", name: "Codex" }, helperFactory: here("./support/real-sync-factory.ts"), helperConfig: syncCfg });
  const init = await openLocal({ projectDir: dir, projectId, adapter, init: { doc: doc0() }, actor: { kind: "human", id: "human:alice" } });
  const localIds: string[] = [];
  for (let i = 0; i < 5; i++) {
    const r = await init.write({ kind: "commit", ops: [set(`c${i}`, "opacity", 0.1 * (i + 1))] });
    assert.equal(r.status, "confirmed", "the local sequencer confirms at once");
    localIds.push(r.id as string);
  }
  await init.close();
  const rows = async () => { host.send("rows"); return (await host.next()).rows as { branch: string; seq: number; id: string }[]; };
  const procs = [host.p];
  const worker = () => { const w = proc("./support/real-worker.ts", [dir, projectId, "./real-sync-factory.ts", JSON.stringify(syncCfg)]); procs.push(w.p); return w; };
  const close = () => { for (const p of procs) if (p.exitCode === null) p.kill("SIGKILL"); };
  return { dir, projectId, open, rows, worker, close, localIds };
}

async function cutOf(local: LocalCarton) {
  return (await local.carton.cuts()).find((c) => c.id === local.carton.cut)!;
}

test("R3-03 hand-off with the app open: commits made during the upload stay pending and become the next seqs; seqs 1..5 adopted verbatim, once", async (t) => {
  const w = await world("r303-open");
  try {
    const wk = w.worker();
    await wk.next();
    const local = await w.open();
    const cut = local.carton.cut;
    const shared = await local.write({ kind: "share" });
    assert.equal(shared.status, "confirmed", JSON.stringify(shared));
    const mid = await cutOf(local);
    // two commits during the upload: on a cut that is handing off they are never confirmed locally (§5.3)
    const c1 = await local.write({ kind: "commit", ops: [set("c0", "name", "during-1")] });
    const c2 = await local.write({ kind: "commit", ops: [set("c1", "name", "during-2")] });
    for (const c of [c1, c2]) assert.ok(c.status === "pending" || c.status === "confirmed", JSON.stringify(c));
    const rows = await until(async () => { const r = (await w.rows()).filter((x) => x.branch === cut); return r.length >= 7 && r; }, 60_000, "the server to hold 7 rows");
    assert.deepEqual(rows.slice(0, 5).map((r) => r.id), w.localIds, "seqs 1..5 adopted verbatim");
    assert.deepEqual(rows.slice(5).map((r) => r.id).sort(), [c1.id, c2.id].sort(), "the two pending changes became seqs 6 and 7");
    assert.equal(new Set(rows.map((r) => r.id)).size, rows.length, "no change id twice on the server");
    const after = await until(async () => { const c = await cutOf(local); return c.sequencer.kind === "server" && c; }, 30_000, "the cut to become server-sequenced");
    assert.equal((after.sequencer as { since: number }).since, 5);
    assert.ok(mid.sequencer.kind === "handingOff" || mid.sequencer.kind === "server");
    const log = await local.carton.log({ limit: 20 });
    assert.deepEqual(log.filter((v) => v.change).map((v) => v.change).slice(0, 2).sort(), [c1.id, c2.id].sort(), "the local log took the server's seqs for them");
    await local.close();
    t.diagnostic(JSON.stringify({ serverRows: rows.length, midState: mid.sequencer.kind }));
  } finally {
    w.close();
  }
});

test("R3-03 the holder dies in the middle of the hand-off: the next holder asks the server, never sequences locally again; one adoption", async (t) => {
  const w = await world("r303-killed");
  try {
    const wk = w.worker();
    await wk.next();
    const local = await w.open();
    const cut = local.carton.cut;
    assert.equal((await local.write({ kind: "share" })).status, "confirmed");
    wk.p.kill("SIGKILL"); // the upload may or may not have reached the server; its answer never reaches this holder
    await sleep(100);
    const st = await cutOf(local);
    assert.notEqual(st.sequencer.kind, "local", "a cut that started handing off never goes back to local sequencing");
    // the next cb call finds no live holder: the cut isn't local any more, so a helper takes over and syncs
    const c = await local.write({ kind: "commit", ops: [set("c2", "name", "after-kill")] });
    assert.ok(c.status === "pending" || c.status === "confirmed", JSON.stringify(c));
    const rows = await until(async () => { const r = (await w.rows()).filter((x) => x.branch === cut); return r.length >= 6 && r; }, 60_000, "the server to hold 6 rows");
    assert.deepEqual(rows.slice(0, 5).map((r) => r.id), w.localIds, "seqs 1..5 adopted verbatim, once");
    assert.equal(rows[5]!.id, c.id);
    assert.equal(new Set(rows.map((r) => r.id)).size, rows.length, "no change id twice");
    const after = await until(async () => { const x = await cutOf(local); return x.sequencer.kind === "server" && x; }, 30_000, "server sequencing");
    assert.equal((after.sequencer as { since: number }).since, 5);
    await local.close();
    t.diagnostic(JSON.stringify({ serverRows: rows.length, stateAfterKill: st.sequencer.kind }));
  } finally {
    w.close();
  }
});
