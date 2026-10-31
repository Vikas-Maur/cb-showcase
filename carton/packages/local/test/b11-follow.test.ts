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
import { mkdtempSync } from "node:fs";
import { Carton } from "@carton/core";
import { openSqliteStore } from "@carton/store-sqlite";
import { CartonHolderEngine } from "../src/open.ts";
import type { ViewPrinter } from "../src/writes.ts";
import { parseActorId } from "../src/identity.ts";
import { scratch } from "./support/scratch.ts";
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

test("B11: another process's change by a hooked agent is hookRead (its Stop ends the freeze); anyone else's onCb (windows-sync H8)", async (t) => {
  const path = join(mkdtempSync(join(scratch(), "b11-hooked-")), "carton.db");
  const s = await openSqliteStore(path);
  const c = await Carton.open({ adapter, store: s, actor: me, init: { doc: doc0() } });
  const os = await openSqliteStore(path);
  const other = await Carton.open({ adapter, store: os, actor: agent });
  const calls: string[] = [];
  const mz: ViewPrinter = {
    printView: async (name) => ({ name, path: name, ref: name }),
    hookRead: async (a) => void calls.push(`read ${a.id}`),
    hookStop: async (a) => void calls.push(`stop ${a.id}`),
    onCb: async () => void calls.push("cb"),
    onExternalHeadChange: async () => { calls.push("external"); return "head"; },
  };
  const engine = new CartonHolderEngine(c, { materializer: mz, follow: { intervalMs: 0 } });
  t.after(async () => { await engine.close(); await other.close(); await c.close(); await os.close(); await s.close(); });
  await engine.nudge();
  const hooked = parseActorId("claude-code/abcdef12/sub-editor-q")!;
  await other.commit({ author: hooked, ops: [set("c1", "name", "hooked 1")] });
  await other.commit({ author: hooked, ops: [set("c1", "name", "hooked 2")] });
  await engine.nudge();
  assert.deepEqual(calls.splice(0), [`read ${hooked.id}`, "external"], "its changes: one hookRead, no windowless freeze");
  // a windowless agent's change among them: its freeze too
  await other.commit({ author: hooked, ops: [set("c1", "name", "hooked 3")] });
  await other.commit({ author: agent, ops: [set("c2", "name", "windowless")] });
  await engine.nudge();
  assert.deepEqual(calls.splice(0), [`read ${hooked.id}`, "cb", "external"]);
});

test("B11: the follower tells cardboard's materializer through onExternalHeadChange, on every other connection's write", async (t) => {
  const path = join(mkdtempSync(join(scratch(), "b11-ext-")), "carton.db");
  const s = await openSqliteStore(path);
  const c = await Carton.open({ adapter, store: s, actor: me, init: { doc: doc0() } });
  const alt = await c.fork("Alt");
  const os = await openSqliteStore(path);
  const other = await Carton.open({ adapter, store: os, actor: agent });
  const calls: string[] = [];
  const mz: ViewPrinter = {
    printView: async (name) => ({ name, path: name, ref: name }),
    onCb: async () => void calls.push("cb"),
    onHeadChange: (k) => void calls.push(`head:${k}`),
    onCutSwitch: (cut) => void calls.push(`switch:${cut === alt.id ? "alt" : cut}`),
    onExternalHeadChange: async () => { calls.push("external"); return "head"; },
  };
  const engine = new CartonHolderEngine(c, { materializer: mz, follow: { intervalMs: 0 } });
  t.after(async () => { await engine.close(); await other.close(); await c.close(); await os.close(); await s.close(); });
  await engine.nudge();
  assert.deepEqual(calls, [], "the first look only records where carton.db is");
  // another process's change on the current cut: a cb call happened, and the materializer reads head itself
  await other.commit({ author: agent, ops: [set("c1", "name", "elsewhere")] });
  await engine.nudge();
  assert.deepEqual(calls.splice(0), ["cb", "external"]);
  // a write elsewhere (another cut): the materializer looks (one head read; nothing when it shows that head), no freeze
  await other.commit({ author: agent, cut: alt.id, ops: [set("c2", "name", "on alt")] });
  await engine.nudge();
  assert.deepEqual(calls.splice(0), ["external"]);
  // a cut switch: told as a switch
  await other.switchTo(alt.id);
  await engine.nudge();
  assert.deepEqual(calls.splice(0), ["switch:alt"]);
  // nothing new: nothing told
  await engine.nudge();
  assert.deepEqual(calls, []);
});
