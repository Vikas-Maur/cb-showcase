// contract(local), windows-sync: a write still pending can ask for the holder's head (`WriteOp` `head: true`).
// The Windows app's cb writes project.json itself after each save, from its own handle, which holds the confirmed rows
// only: with the holder offline, the state that includes the edit (merged onto the holder's own pending edits and what
// it had from teammates) is the holder's, so the holder hands it back. Real processes, as R2-02: a server-node host,
// the lease holder (a worker), a cb-like handle writing through it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { openLocal } from "../src/open.ts";
import { adapter, bundle, doc0 } from "./support/real.ts";

const here = (f: string) => fileURLToPath(new URL(f, import.meta.url));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const set = (id: string, f: string, v: unknown) => ({ op: "set" as const, path: ["timelineItems", id, f], value: v });
const item = (doc: any, id: string) => (doc.timelineItems as any[]).find((i) => i.id === id);

function proc(script: string, args: string[]) {
  const p = spawn(process.execPath, [here(script), ...args], { stdio: ["pipe", "pipe", "inherit"], env: { ...process.env, CARDBOARD_ACTOR: "", CLAUDECODE: "" } });
  const lines: any[] = [];
  const waiting: ((x: any) => void)[] = [];
  createInterface({ input: p.stdout! }).on("line", (l) => { const x = JSON.parse(l); const w = waiting.shift(); if (w) w(x); else lines.push(x); });
  return { p, next: () => new Promise<any>((r) => (lines.length ? r(lines.shift()) : waiting.push(r))), send: (l: string) => p.stdin!.write(l + "\n") };
}
async function until<T>(f: () => Promise<T | null | false | undefined>, ms = 30_000, what = "condition"): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await f();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(50);
  }
}

test("a pending commit that asks for it gets the holder's head: its edit merged onto the holder's other pending edits", async () => {
  const { dir, projectId } = bundle("commit-head");
  const procs: ReturnType<typeof spawn>[] = [];
  const host = proc("./support/host.ts", [dir, projectId]);
  procs.push(host.p);
  await host.next();
  const { url } = JSON.parse(readFileSync(join(dir, "host.json"), "utf8"));
  const syncCfg = { url, tokenFile: join(dir, "token-alice") };
  const init = await openLocal({ projectDir: dir, projectId, adapter, init: { doc: doc0() }, actor: { kind: "human", id: "human:alice" } });
  await init.close();
  const worker = proc("./support/real-worker.ts", [dir, projectId, "./real-sync-factory.ts", JSON.stringify(syncCfg)]);
  procs.push(worker.p);
  await worker.next();
  const local = await openLocal({ projectDir: dir, projectId, adapter, actor: { kind: "agent", id: "codex/c1" }, helperFactory: here("./support/real-sync-factory.ts"), helperConfig: syncCfg });
  try {
    const cut = local.carton.cut;
    assert.equal((await local.write({ kind: "share" })).status, "confirmed");
    await until(async () => (await local.carton.cuts()).find((c) => c.id === cut)!.sequencer.kind === "server", 30_000, "the cut to be shared");
    const base = (await local.carton.head()).ref;

    // the server goes down; the holder keeps an edit of its own pending
    host.p.kill("SIGKILL");
    await until(async () => (await local.write({ kind: "pin", owner: "probe" })).status === "confirmed", 5_000, "a holder to answer");
    await sleep(500);
    const first = await local.write({ kind: "commit", ops: [set("c1", "name", "the holder's")] });
    assert.equal(first.status, "pending", JSON.stringify(first));
    assert.equal(first.head, undefined, "only a commit that asks gets the head");

    // a save made on the older base, asking for the head
    const r = await local.write({ kind: "commit", base, ops: [set("c2", "opacity", 0.4)], head: true });
    assert.equal(r.status, "pending", JSON.stringify(r));
    const head = r.head as { ref: unknown; doc: any } | undefined;
    assert.ok(head?.doc, "the holder's head came back");
    assert.equal(item(head.doc, "c2").opacity, 0.4, "with this edit");
    assert.equal(item(head.doc, "c1").name, "the holder's", "merged onto the holder's own pending edit");
    // what this handle reads itself is the confirmed state: neither edit
    const mine = (await local.carton.head()).doc as any;
    assert.notEqual(item(mine, "c2").opacity, 0.4);
    assert.notEqual(item(mine, "c1").name, "the holder's");

    // not only commits (owner's addition): a restore of the shared version, still pending, asking for the head, gets
    // the head of the cut it went to with the restore in
    const back = await local.write({ kind: "restore", ref: `${cut}@${base.seq}`, head: true });
    assert.equal(back.status, "pending", JSON.stringify(back));
    const h2 = back.head as { ref: { branchId: string }; doc: any } | undefined;
    assert.equal(h2?.ref.branchId, cut);
    assert.equal(item(h2!.doc, "c2").opacity, 1, "the restore is in: c2 as it was");
    assert.equal(item(h2!.doc, "c1").name, "c1");
  } finally {
    await local.close();
    for (const p of procs) if (p.exitCode === null) p.kill("SIGKILL");
  }
});
