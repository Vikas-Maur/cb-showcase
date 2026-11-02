// A follower's `cb` write served by the lease holder (withdrawn-outcome.test.ts has the writer's own process), on real
// processes: a sequencer host (server-node over WebSocket), the app's engine thread holding the lease with a sync
// client, and this process's handle sending its write over the holder's socket. Bob, on another machine, makes an edit to
// the same clip. The holder's view of the server goes through a proxy that holds Bob's row back, so the holder pushes
// the follower's edit on the old base; released, the rebase empties it after it was sent and the holder withdraws it.
// The follower hears: confirmed + absorbed + "already in place" (an identical edit), or conflicts with the card that
// took its place (a different value). Never "confirmed" at the withdraw row's seq.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { Carton, hashDoc, type Actor } from "@carton/core";
import { createMemoryStore } from "@carton/store-memory";
import { webSocketTransport } from "@carton/server-node";
import { openLocal } from "../src/open.ts";
import { ALREADY_IN_PLACE } from "../src/writes.ts";
import type { CbResult } from "../src/writes.ts";
import { adapter, bundle, doc0, schema } from "./support/real.ts";
import { holdProxy } from "./support/hold-proxy.ts";

const here = (f: string) => fileURLToPath(new URL(f, import.meta.url));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const set = (id: string, f: string, v: unknown) => ({ op: "set", path: ["timelineItems", id, f], value: v });
const agent: Actor = { kind: "agent", id: "claude-code/wd-follower", name: "Claude Code" };

function proc(script: string, args: string[]) {
  const p = spawn(process.execPath, [here(script), ...args], { stdio: ["pipe", "pipe", "inherit"], env: { ...process.env, CARDBOARD_ACTOR: "", CLAUDECODE: "" } });
  const lines: any[] = [];
  const waiting: ((x: any) => void)[] = [];
  createInterface({ input: p.stdout! }).on("line", (l) => { const x = JSON.parse(l); const w = waiting.shift(); if (w) w(x); else lines.push(x); });
  return { p, next: () => new Promise<any>((r) => (lines.length ? r(lines.shift()) : waiting.push(r))), send: (l: string) => p.stdin!.write(l + "\n") };
}
async function until(f: () => Promise<unknown> | unknown, ms = 30_000, what = "condition") {
  for (const end = Date.now() + ms; !(await f()); await sleep(25)) if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
}

/** The follower's answer, and the server's rows with its id: the withdraw row that spent it (none if never sent). */
async function followerWithdrawn(name: string, followerName: string, bobName: string): Promise<{ r: CbResult; serverRows: { seq: number; id: string }[] }> {
  const { dir, projectId } = bundle(name);
  const procs: ReturnType<typeof spawn>[] = [];
  let local: Awaited<ReturnType<typeof openLocal>> | undefined;
  let bob: Carton | undefined;
  let proxy: Awaited<ReturnType<typeof holdProxy>> | undefined;
  try {
    const host = proc("./support/host.ts", [dir, projectId]);
    procs.push(host.p);
    await host.next();
    const { url, port } = JSON.parse(readFileSync(join(dir, "host.json"), "utf8"));
    proxy = await holdProxy(port);
    const syncCfg = { url: proxy.via(url), tokenFile: join(dir, "token-alice") };
    const init = await openLocal({ projectDir: dir, projectId, adapter, init: { doc: doc0() }, actor: { kind: "human", id: "human:alice" } });
    await init.close();
    // the app's library worker: the lease holder, syncing through the proxy
    const wk = proc("./support/real-worker.ts", [dir, projectId, "./real-sync-factory.ts", JSON.stringify(syncCfg)]);
    procs.push(wk.p);
    await wk.next();
    // this process: a follower with no sync of its own; its writes go to the holder
    local = await openLocal({ projectDir: dir, projectId, adapter, actor: agent, helperFactory: here("./support/real-sync-factory.ts"), helperConfig: syncCfg });
    assert.equal(local.carton.sync, null, "the follower doesn't sync: only the holder can answer its write");
    assert.equal((await local.write({ kind: "share" })).status, "confirmed");
    await until(async () => (await local!.carton.cuts()).find((c) => c.id === local!.carton.cut)!.sequencer.kind === "server", 30_000, "the hand-off");
    const cut = (await local.carton.cuts()).find((c) => c.id === local!.carton.cut)!;
    // Bob, on another machine, joins the cut straight at the host
    const root = await local.carton.checkout(`${cut.id}@0`);
    bob = await Carton.open({
      adapter, store: createMemoryStore(), actor: { kind: "human", id: "bob" },
      init: { join: { projectId, cut, doc0: root, rootHash: hashDoc(root, schema) } },
      sync: { transport: webSocketTransport({ keepaliveMs: 0 }), url, token: readFileSync(join(dir, "token-bob"), "utf8").trim(), autoConnect: false },
    });
    assert.ok(await bob.sync!.connect({ nonce: "bob", timeoutMs: 10_000 }), "bob connected");
    // Bob's edit lands first; the holder doesn't hear of it yet
    const bobId = bob.newChangeId();
    proxy.holdFrom(`"${bobId}"`);
    assert.equal((await bob.commit({ id: bobId, ops: [set("c1", "name", bobName)] as never, wait: 10_000 })).status, "confirmed");
    // the follower's write: the holder pushes it on the base it knows
    const answer = local.write({ kind: "commit", ops: [set("c1", "name", followerName)] }, { waitMs: 20_000 });
    const store = (local.carton as unknown as { store: { range<T>(t: string, o: object): Promise<{ value: T }[]> } }).store;
    await until(async () => (await store.range<{ sentBases?: number[] }>("pending", { prefix: [cut.id] })).some((r) => r.value.sentBases?.length), 30_000, "the follower's edit pushed");
    proxy.release();
    const r = await answer;
    host.send("rows");
    const rows = ((await host.next()).rows as { branch: string; seq: number; id: string }[]).filter((x) => x.branch === cut.id && x.id === r.id);
    return { r, serverRows: rows };
  } finally {
    proxy?.release();
    await bob?.close();
    const row = await local?.lease.read().catch(() => null);
    if (row && row.pid !== process.pid) try { process.kill(row.pid, "SIGKILL"); } catch {}
    await local?.close();
    for (const p of procs) if (p.exitCode === null) p.kill("SIGKILL");
    await proxy?.close();
  }
}

test("a follower's write that a teammate's identical edit emptied after it was sent answers confirmed, absorbed, already in place", { timeout: 120_000 }, async () => {
  const { r, serverRows } = await followerWithdrawn("wd-follow-same", "Same", "Same");
  assert.equal(serverRows.length, 1, "sent, then withdrawn: the server spent its id with one row");
  assert.equal(r.status, "confirmed", JSON.stringify(r));
  assert.equal(r.absorbed, true, JSON.stringify(r));
  assert.equal(r.note, ALREADY_IN_PLACE);
});

test("a follower's write a card took the place of after it was sent answers conflicts with that card", { timeout: 120_000 }, async () => {
  const { r, serverRows } = await followerWithdrawn("wd-follow-card", "Follower's", "Bob's");
  assert.equal(serverRows.length, 1, "sent, then withdrawn: the server spent its id with one row");
  assert.equal(r.status, "conflicts", JSON.stringify(r));
  const cards = (r as Extract<CbResult, { status: "conflicts" }>).conflicts;
  assert.ok(cards.some((k) => k.path.startsWith("timelineItems/c1")), JSON.stringify(cards));
  assert.equal(r.absorbed, true, JSON.stringify(r));
});
