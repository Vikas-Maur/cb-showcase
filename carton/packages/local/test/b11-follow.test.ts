// e2e-qa's B11: a write that reaches carton.db without the app's lease holder (a helper that took the lease over while
// the app's engine thread was busy, a `cb` that committed in its own process) must still reach the app's materializer:
// project.json follows carton.db's head, whoever moved it. The app here is the real thing as far as Carton goes: its
// engine thread holds the lease and runs the cardboard materializer on the bundle; the other writer is a second
// connection to carton.db (as another process's would be).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Rec } from "@carton/core";
import { openLocal } from "../src/open.ts";
import { EngineThread } from "../src/engine-thread.ts";
import { ControlServer } from "../src/ipc.ts";
import { holderSocketPath } from "../src/holder.ts";
import { nudgeHolder } from "../src/client.ts";
import { adapter, bundle, doc0 } from "./support/real.ts";

const here = (f: string) => fileURLToPath(new URL(f, import.meta.url));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const set = (id: string, f: string, v: unknown) => ({ op: "set" as const, path: ["timelineItems", id, f], value: v });
const me = { kind: "human" as const, id: "human:me" };
const agent = { kind: "agent" as const, id: "codex/b11", name: "Codex" };

/** An item as project.json shows it now (null while the file has no project yet). */
function shown(dir: string, id: string): Rec | null {
  try {
    const env = JSON.parse(readFileSync(join(dir, "project.json"), "utf8"));
    return ((env.project?.timelineItems ?? []) as Rec[]).find((i) => i.id === id) ?? null;
  } catch { return null; } // read between the materializer's temp file and its rename
}
async function until(f: () => boolean, ms: number, what: string) {
  for (const end = Date.now() + ms; !f(); await sleep(25)) if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
}

async function app(name: string, config: Record<string, unknown> = {}) {
  const { dir, projectId } = bundle(name);
  const init = await openLocal({ projectDir: dir, projectId, adapter, init: { doc: doc0() }, actor: me });
  const dbPath = init.dbPath;
  await init.close();
  const th = await EngineThread.start({ dbPath, factory: here("./support/real-mz-factory.ts"), config: { projectDir: dir, ...config } });
  // the materializer's first print: project.json shows head
  await until(() => shown(dir, "c1")?.name === "c1", 10_000, "the app's first project.json");
  return { dir, projectId, th };
}

test("B11: a write another process commits to carton.db reaches the app's project.json", async (t) => {
  const { dir, projectId, th } = await app("b11-head");
  const other = await openLocal({ projectDir: dir, projectId, adapter, actor: agent });
  t.after(async () => { await other.close(); await th.stop(); });
  // straight into carton.db, past the lease holder (as a takeover helper or an in-process `cb` commits)
  await other.carton.commit({ author: agent, ops: [set("c1", "name", "from another process")] });
  await until(() => shown(dir, "c1")?.name === "from another process", 5_000, "project.json to show the other process's write");
});

test("B11: a cut switch another process makes is followed: project.json shows the new cut", async (t) => {
  const { dir, projectId, th } = await app("b11-cut");
  const other = await openLocal({ projectDir: dir, projectId, adapter, actor: agent });
  t.after(async () => { await other.close(); await th.stop(); });
  const alt = await other.carton.fork("Alt", { id: "b11.alt" });
  await other.carton.commit({ author: agent, cut: alt.id, ops: [set("c2", "name", "on the alt cut")] });
  await sleep(600); // the app has looked meanwhile: a cut it isn't on changed nothing it shows
  assert.equal(shown(dir, "c2")?.name, "c2");
  await other.carton.switchTo(alt.id);
  await until(() => shown(dir, "c2")?.name === "on the alt cut", 5_000, "project.json to show the cut switched to");
  // and the app is on that cut now: its next own write lands there
  const r = await th.call("serve", { id: "b11.after", actor: me, op: { kind: "commit", ops: [set("c3", "name", "after the switch")] } });
  assert.equal(r.status, "confirmed", JSON.stringify(r));
  assert.equal(((await other.carton.head(alt.id)).doc.timelineItems as Rec[]).find((i) => i.id === "c3")!.name, "after the switch");
});

test("B11: a nudge on the control socket makes the app look at once (polling off)", async (t) => {
  const { dir, projectId, th } = await app("b11-nudge", { followMs: 0 });
  const other = await openLocal({ projectDir: dir, projectId, adapter, actor: agent });
  t.after(async () => { await other.close(); await th.stop(); });
  await other.carton.commit({ author: agent, ops: [set("c1", "name", "nudged")] });
  await sleep(600);
  assert.equal(shown(dir, "c1")?.name, "c1", "with polling off, nothing has looked yet");
  const row = (await other.lease.read())!;
  assert.equal(await nudgeHolder(row.socketPath), true, "the app's holder answered the nudge (no auth)");
  await until(() => shown(dir, "c1")?.name === "nudged", 5_000, "project.json after the nudge");
});

test("B11: a cb write committed in its own process nudges the holder it passed over", async (t) => {
  const { dir, projectId } = bundle("b11-passed");
  const local = await openLocal({ projectDir: dir, projectId, adapter, init: { doc: doc0() }, actor: agent });
  // a lease row whose holder stopped beating 10 s ago (expired: the write goes in-process), but whose socket answers
  const nudges: number[] = [];
  const path = holderSocketPath(dir, "worker");
  const srv = await ControlServer.listen({ path, open: ["carton.ping", "carton.nudge"], methods: { "carton.ping": () => ({ pid: process.pid, nonce: "x" }), "carton.nudge": () => { nudges.push(Date.now()); return { ok: true }; } } });
  t.after(async () => { await srv.close(); await local.close(); });
  assert.ok(await local.lease.take(null, { pid: process.pid, socketPath: path, kind: "worker" }, Date.now() - 10_000));
  const r = await local.write({ kind: "commit", ops: [set("c1", "name", "in-process")] });
  assert.equal(r.status, "confirmed", JSON.stringify(r));
  assert.equal(((await local.carton.head()).doc.timelineItems as Rec[]).find((i) => i.id === "c1")!.name, "in-process", "committed here");
  await until(() => nudges.length === 1, 2_000, "the nudge");
  // a write that changed nothing tells nobody
  const again = await local.write({ kind: "commit", ops: [] });
  assert.equal(again.status, "confirmed", JSON.stringify(again));
  assert.equal(again.empty, true, JSON.stringify(again));
  await sleep(300);
  assert.equal(nudges.length, 1, "no nudge for an empty commit");
});
