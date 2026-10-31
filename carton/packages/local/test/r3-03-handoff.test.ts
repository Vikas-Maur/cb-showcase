// R3-03: the sequencer hand-off (local → handing off → server, §5.3) on real processes: a real sequencer host
// (server-node over WebSocket), the app's engine thread holding the lease, and `cb` calls handing their writes to it.
// Port of system-v11 test/r3-03-handoff.test.mjs: commits made during the upload stay pending and become the next seqs;
// the cut's seqs 1..n are adopted verbatim, once; nothing is sequenced locally after n; when the holder dies in the
// middle of the hand-off (its ack never arrives), the next holder asks the server and never sequences locally again.
// The windows are made certain, not left to timing: the replicas reach the host through a proxy that holds what the
// server sends, so the adoption is on the server while its answer is withheld.
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
import { holdProxy } from "./support/hold-proxy.ts";

const here = (f: string) => fileURLToPath(new URL(f, import.meta.url));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const set = (id: string, f: string, v: unknown) => ({ op: "set", path: ["timelineItems", id, f], value: v });
/** The server's answer to an upload (`{type: "adopted", …}`, §5.3). */
const ADOPTED = '"type":"adopted"';

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
  const { url, port } = JSON.parse(readFileSync(join(dir, "host.json"), "utf8"));
  const proxy = await holdProxy(port);
  const syncCfg = { url: proxy.via(url), tokenFile: join(dir, "token-alice") };
  const open = () => openLocal({ projectDir: dir, projectId, adapter, actor: { kind: "agent", id: "codex/hand-off", name: "Codex" }, helperFactory: here("./support/real-sync-factory.ts"), helperConfig: syncCfg });
  // the starting state as the root (main@0): the seqs and credits below count only this test's own changes
  const init = await openLocal({ projectDir: dir, projectId, adapter, init: { doc: doc0(), asChange: false }, actor: { kind: "human", id: "human:alice" } });
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
  const close = () => { for (const p of procs) if (p.exitCode === null) p.kill("SIGKILL"); void proxy.close(); };
  const onServer = async (cut: string) => (await rows()).filter((x) => x.branch === cut);
  return { dir, projectId, open, rows, onServer, worker, close, localIds, proxy };
}

/** The detached helper a cb call started holds the lease after the test: stop it with the test. */
async function stopHolder(local: LocalCarton | undefined) {
  const row = await local?.lease.read().catch(() => null);
  if (row && row.pid !== process.pid) try { process.kill(row.pid, "SIGKILL"); } catch {}
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
    w.proxy.holdFrom(ADOPTED); // the adoption reaches the server; its answer doesn't come back yet
    const shared = await local.write({ kind: "share" });
    assert.equal(shared.status, "confirmed", JSON.stringify(shared));
    const adopted = await until(async () => { const r = await w.onServer(cut); return r.length >= 5 && r; }, 30_000, "the server to adopt the cut");
    const mid = await cutOf(local);
    assert.equal(mid.sequencer.kind, "handingOff", "the upload is on the server, its answer not back");
    // two commits during the upload: on a cut that is handing off they are never confirmed locally (§5.3)
    const c1 = await local.write({ kind: "commit", ops: [set("c0", "name", "during-1")] }, { waitMs: 300 });
    const c2 = await local.write({ kind: "commit", ops: [set("c1", "name", "during-2")] }, { waitMs: 300 });
    for (const c of [c1, c2]) assert.equal(c.status, "pending", JSON.stringify(c));
    assert.equal((await w.onServer(cut)).length, 5, "nothing pushed after the upload before the server answered it");
    assert.equal(adopted.length, 5);
    w.proxy.release();
    const rows = await until(async () => { const r = await w.onServer(cut); return r.length >= 7 && r; }, 60_000, "the server to hold 7 rows");
    assert.deepEqual(rows.slice(0, 5).map((r) => r.id), w.localIds, "seqs 1..5 adopted verbatim");
    assert.deepEqual(rows.slice(5).map((r) => r.id).sort(), [c1.id, c2.id].sort(), "the two pending changes became seqs 6 and 7");
    assert.equal(new Set(rows.map((r) => r.id)).size, rows.length, "no change id twice on the server");
    const after = await until(async () => { const c = await cutOf(local); return c.sequencer.kind === "server" && c; }, 30_000, "the cut to become server-sequenced");
    assert.equal((after.sequencer as { since: number }).since, 5);
    // the holder records the server's rows in carton.db just after the server has them: wait for it, then check
    const newest = async () => (await local.carton.log({ limit: 20 })).filter((v) => v.change).map((v) => v.change).slice(0, 2).sort();
    await until(async () => JSON.stringify(await newest()) === JSON.stringify([c1.id, c2.id].sort()), 30_000, "the local log to take the server's seqs").catch(() => {});
    assert.deepEqual(await newest(), [c1.id, c2.id].sort(), "the local log took the server's seqs for them");
    await local.close();
    t.diagnostic(JSON.stringify({ serverRows: rows.length, midState: mid.sequencer.kind }));
  } finally {
    w.close();
  }
});

test("R3-03 the holder dies in the middle of the hand-off: the next holder asks the server, never sequences locally again; one adoption", async (t) => {
  const w = await world("r303-killed");
  let opened: LocalCarton | undefined;
  try {
    const wk = w.worker();
    await wk.next();
    const local = (opened = await w.open());
    const cut = local.carton.cut;
    w.proxy.holdFrom(ADOPTED);
    assert.equal((await local.write({ kind: "share" })).status, "confirmed");
    // the server has adopted the cut; the holder dies before its answer arrives
    await until(async () => (await w.onServer(cut)).length >= 5, 30_000, "the server to adopt the cut");
    assert.equal((await cutOf(local)).sequencer.kind, "handingOff", "the answer is withheld");
    wk.p.kill("SIGKILL");
    await until(async () => wk.p.exitCode !== null || wk.p.signalCode !== null, 5000, "the holder to die");
    w.proxy.release();
    const st = await cutOf(local);
    assert.equal(st.sequencer.kind, "handingOff", "a cut that started handing off never goes back to local sequencing");
    // the next cb call finds no live holder: the cut isn't local any more, so a helper takes over and syncs
    const c = await local.write({ kind: "commit", ops: [set("c2", "name", "after-kill")] });
    assert.ok(c.status === "pending" || c.status === "confirmed", JSON.stringify(c));
    const rows = await until(async () => { const r = (await w.rows()).filter((x) => x.branch === cut); return r.length >= 6 && r; }, 60_000, "the server to hold 6 rows");
    assert.deepEqual(rows.slice(0, 5).map((r) => r.id), w.localIds, "seqs 1..5 adopted verbatim, once");
    assert.equal(rows[5]!.id, c.id);
    assert.equal(new Set(rows.map((r) => r.id)).size, rows.length, "no change id twice");
    const after = await until(async () => { const x = await cutOf(local); return x.sequencer.kind === "server" && x; }, 30_000, "server sequencing");
    assert.equal((after.sequencer as { since: number }).since, 5);
    t.diagnostic(JSON.stringify({ serverRows: rows.length, stateAfterKill: st.sequencer.kind }));
  } finally {
    await stopHolder(opened);
    await opened?.close();
    w.close();
  }
});
