// H8: an external agent's hook events reach the lease holder's materializer (cardboard-adapter's real Materializer,
// on the engine thread as the app runs it). Each hook is its own process in production (`carton hook …`,
// `cb carton-hook …`), so it goes as `sendHookEvent` does: carton.db read-only for the lease, then the holder's socket.
//   - A hooked agent's Read of timeline.tsx freezes the shared file against the person's changes; its Stop ends the
//     freeze at once (a hook event is no `cb` call, which would keep the file frozen for a minute).
//   - A Write/Edit of timeline.tsx credits the next foreign save of it to the agent; the same request told twice (a
//     retry) credits only one.
//   - A hooked agent's own `cb` call (served by the holder, or committed by another process and found by the follower)
//     freezes it the same way, until that Stop; not for a minute after it, as a windowless agent's does.
//   - With no holder, nobody is told, no helper starts, and a project without Carton gets no carton.db.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Rec } from "@carton/core";
import { openLocal } from "../src/open.ts";
import { EngineThread } from "../src/engine-thread.ts";
import { runHook } from "../src/hook-cli.ts";
import { existingCartonDbs, openExistingProjectStore, sendHookEvent } from "../src/hook-send.ts";
import { Carton } from "@carton/core";
import { openSqliteStore, projectKey } from "@carton/store-sqlite";
import { nodeHasher } from "../src/hasher.ts";
import { scratch } from "./support/scratch.ts";
import type { HookSend } from "../src/hooks.ts";
import { parseActorId } from "../src/identity.ts";
import type { CbResult } from "../src/writes.ts";
import { adapter, bundle, doc0 } from "./support/real.ts";

const here = (f: string) => fileURLToPath(new URL(f, import.meta.url));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const me = { kind: "human" as const, id: "human:me", name: "me" };
const session = { session_id: "abcdef1234" };

async function until(f: () => unknown, ms: number, what: string, now: () => unknown = () => null) {
  for (const end = Date.now() + ms; !(await f()); await sleep(25)) if (Date.now() > end) throw new Error(`timed out waiting for ${what}; now: ${JSON.stringify(now())}`);
}
/** The shared timeline.tsx's items (null mid-rename). */
function shared(dir: string): Rec[] | null {
  try {
    const text = readFileSync(join(dir, "timeline.tsx"), "utf8");
    return JSON.parse(text.slice(text.indexOf("\n{") + 1)).timelineItems as Rec[];
  } catch { return null; }
}
function project(dir: string): Rec[] | null {
  try { return JSON.parse(readFileSync(join(dir, "project.json"), "utf8")).project?.timelineItems ?? null; } catch { return null; }
}
const named = (items: Rec[] | null | undefined, id: string) => items?.find((i) => i.id === id)?.name;
/** The person's save in the app: Cardboard writes project.json (the materializer applies it; it freezes nothing). */
function saveProject(dir: string, id: string, name: string) {
  const file = join(dir, "project.json");
  const env = JSON.parse(readFileSync(file, "utf8"));
  env.project.timelineItems.find((i: Rec) => i.id === id).name = name;
  writeFileSync(file, JSON.stringify(env));
}
/** An agent's save of the shared file: its own edit of one clip's name, on the file as it is. */
function saveShared(dir: string, id: string, name: string) {
  const file = join(dir, "timeline.tsx");
  const text = readFileSync(file, "utf8");
  const at = text.indexOf("\n{") + 1;
  const body = JSON.parse(text.slice(at));
  body.timelineItems.find((i: Rec) => i.id === id).name = name;
  writeFileSync(file, text.slice(0, at) + JSON.stringify(body, null, 1) + "\n");
}

/** The app (engine thread: lease holder + cardboard's Materializer on the bundle) and another process's handle. */
async function world(t: { after(f: () => Promise<void>): void }, name: string, config: Record<string, unknown> = {}) {
  const { dir, projectId } = bundle(name);
  const init = await openLocal({ projectDir: dir, projectId, adapter, init: { doc: doc0() }, actor: me });
  const dbPath = init.dbPath;
  await init.close();
  const th = await EngineThread.start({ dbPath, factory: here("./support/real-mz-factory.ts"), config: { projectDir: dir, ...config } });
  const other = await openLocal({ projectDir: dir, projectId, adapter, actor: me });
  t.after(async () => { await other.close(); await th.stop(); });
  await until(() => named(shared(dir), "c1") === "c1" && named(project(dir), "c1") === "c1", 10_000, "the app's first print", () => shared(dir));
  const answers: CbResult[] = [];
  const send = async (e: HookSend) => { answers.push(await sendHookEvent({ projectDir: dir, projectId, ...e })); };
  /** A hook process: Claude Code's input in, the event sent to the holder (as `carton hook …` does). */
  const hook = (event: "pre-tool-use" | "stop", input: object) => runHook(event, { ...session, ...input }, { env: {}, projectDir: dir, send });
  /**
   * The person's edit in the app (a GUI save of project.json), applied by the materializer. Not a write from another
   * process: the holder takes one of those for a `cb` call (B11), which freezes the shared file for a minute.
   */
  const person = async (id: string, v: string) => {
    saveProject(dir, id, v);
    await until(async () => named((await other.carton.head()).doc.timelineItems as Rec[], id) === v, 10_000, `the person's ${id} to land`);
  };
  return { dir, projectId, th, other, answers, hook, person };
}

test("a hooked agent's Read of timeline.tsx freezes it against the person's changes; its Stop ends the freeze at once", { timeout: 60_000 }, async (t) => {
  const { dir, answers, hook, person } = await world(t, "hook-freeze");
  // not frozen yet: the person's change reaches both files
  await person("c2", "person 1");
  await until(() => named(shared(dir), "c2") === "person 1" && named(project(dir), "c2") === "person 1", 10_000, "both files to follow head", () => shared(dir));

  assert.deepEqual(await hook("pre-tool-use", { tool_name: "Read", tool_input: { file_path: join(dir, "timeline.tsx") } }), {});
  assert.deepEqual(answers.map((a) => [a.status, a.hook]), [["confirmed", { event: "read", delivered: true }]], JSON.stringify(answers));
  await person("c3", "person 2");
  await sleep(500);
  assert.equal(named(shared(dir), "c3"), "c3", "the agent is reading the shared file: it stays as the agent read it");

  assert.deepEqual(await hook("stop", { hook_event_name: "Stop" }), {});
  assert.deepEqual(answers.at(-1)?.hook, { event: "stop", delivered: true });
  // the turn is over: the shared file catches up now, not a minute later (a hook event is no cb call)
  await until(() => named(shared(dir), "c3") === "person 2", 5_000, "the shared file to catch up after the stop", () => shared(dir));
});

const set = (id: string, f: string, v: unknown) => ({ op: "set" as const, path: ["timelineItems", id, f], value: v });

test("a hooked agent's cb call freezes timeline.tsx until its Stop, which ends the freeze at once (not a minute later)", { timeout: 60_000 }, async (t) => {
  const { dir, projectId, answers, hook, person } = await world(t, "hook-cb");
  // the agent's own `cb` (CARDBOARD_ACTOR as its hooks name it), served by the app's holder
  const agent = parseActorId("claude-code/abcdef12")!;
  const cb = await openLocal({ projectDir: dir, projectId, adapter, actor: agent });
  t.after(() => cb.close());
  const w = await cb.write({ kind: "commit", ops: [set("c1", "name", "the agent's cb edit")] });
  assert.equal(w.status, "confirmed", JSON.stringify(w));
  await person("c3", "person 2");
  await sleep(500);
  assert.equal(named(shared(dir), "c3"), "c3", "the agent is working: the shared file stays as it was");

  assert.deepEqual(await hook("stop", { hook_event_name: "Stop" }), {});
  assert.deepEqual(answers.at(-1)?.hook, { event: "stop", delivered: true });
  await until(() => named(shared(dir), "c3") === "person 2", 5_000, "the shared file to catch up after the stop", () => shared(dir));
});

test("a hooked agent's cb call with no Stop (a turn the user interrupted): the freeze ends after its quiet time (dec0271)", { timeout: 60_000 }, async (t) => {
  // the materializer's quiet time, short here (60 s in the app)
  const idle = 2_000;
  const { dir, projectId, person } = await world(t, "hook-cb-idle", { freezeIdleMs: idle });
  const agent = parseActorId("claude-code/abcdef12")!;
  const cb = await openLocal({ projectDir: dir, projectId, adapter, actor: agent });
  t.after(() => cb.close());
  const t0 = Date.now();
  assert.equal((await cb.write({ kind: "commit", ops: [set("c1", "name", "the agent's cb edit")] })).status, "confirmed");
  await person("c3", "person 2");
  assert.equal(named(shared(dir), "c3"), "c3", "the agent is working: the shared file stays as it was");
  // no Stop ever comes: the file catches up once the agent has been quiet for the idle time
  await until(() => named(shared(dir), "c3") === "person 2", idle + 8_000, "the shared file to catch up after the quiet time", () => shared(dir));
  assert.ok(Date.now() - t0 >= idle, `not before the quiet time: ${Date.now() - t0} ms`);
});

test("a hooked agent's change another process committed (the follower) freezes timeline.tsx until its Stop, too", { timeout: 60_000 }, async (t) => {
  const { dir, other, answers, hook, person } = await world(t, "hook-cb-follow");
  // committed outside the holder (a cb in its own process, or a helper that had the lease): the app's follower finds it
  const agent = parseActorId("claude-code/abcdef12")!;
  await other.carton.commit({ author: agent, ops: [set("c1", "name", "committed elsewhere")] });
  await until(() => named(project(dir), "c1") === "committed elsewhere", 10_000, "the follower to bring project.json up", () => project(dir));
  await person("c3", "person 2");
  await sleep(500);
  assert.equal(named(shared(dir), "c3"), "c3", "the agent is working: the shared file stays as it was");

  assert.deepEqual(await hook("stop", { hook_event_name: "Stop" }), {});
  assert.deepEqual(answers.at(-1)?.hook, { event: "stop", delivered: true });
  await until(() => named(shared(dir), "c3") === "person 2", 5_000, "the shared file to catch up after the stop", () => shared(dir));
});

test("an Edit of timeline.tsx credits the agent's next save of it; the same request told twice credits one save", { timeout: 60_000 }, async (t) => {
  const { dir, projectId, other } = await world(t, "hook-credit");
  const agent = parseActorId("claude-code/abcdef12/sub-editor-q")!;
  const op = { kind: "hook" as const, event: "write" as const, file: "timeline.tsx" };
  // a retry of one request (its answer lost): the holder tells its materializer once
  const first = await sendHookEvent({ projectDir: dir, projectId, actor: agent, op, id: "hook.edit.1" });
  const again = await sendHookEvent({ projectDir: dir, projectId, actor: agent, op, id: "hook.edit.1" });
  assert.deepEqual([first.hook, again.hook], [{ event: "write", delivered: true }, { event: "write", delivered: true, again: true }]);

  const lastBy = async () => (await other.carton.log({ limit: 1 }))[0]?.author?.id;
  const nameOf = async (id: string) => named((await other.carton.head()).doc.timelineItems as Rec[], id);
  saveShared(dir, "c4", "the agent's edit");
  await until(async () => (await nameOf("c4")) === "the agent's edit", 10_000, "the agent's save to land");
  assert.equal(await lastBy(), agent.id, "credited to the agent that announced it, down to the subagent");
  saveShared(dir, "c5", "someone else's edit");
  await until(async () => (await nameOf("c5")) === "someone else's edit", 10_000, "the next save to land");
  assert.equal(await lastBy(), "external:timeline.tsx", "one announcement, one credit: the retry added none");
});

test("no holder: nobody is told and no helper starts; a project without Carton gets no carton.db", { timeout: 30_000 }, async () => {
  const { dir, projectId } = bundle("hook-none");
  const lc = await openLocal({ projectDir: dir, projectId, adapter, init: { doc: doc0() }, actor: me });
  try {
    const agent = parseActorId("claude-code/abcdef12")!;
    const t0 = Date.now();
    const r = await sendHookEvent({ projectDir: dir, projectId, actor: agent, op: { kind: "hook", event: "read", file: "timeline.tsx" } });
    assert.deepEqual([r.status, r.hook], ["confirmed", { event: "read", delivered: false }], JSON.stringify(r));
    // the cb-side handle's own write: in process with no materializer, never a helper
    const w = await lc.write({ kind: "hook", event: "stop" }, { actor: agent });
    assert.deepEqual([w.status, w.hook], ["confirmed", { event: "stop", delivered: false }], JSON.stringify(w));
    assert.ok(Date.now() - t0 < 5_000, "answered without waiting for a helper");
    assert.equal(await lc.lease.nonce(), null, "no helper took the lease");
  } finally {
    await lc.close();
  }
  const bare = bundle("hook-bare");
  const r = await sendHookEvent({ projectDir: bare.dir, projectId: bare.projectId, actor: parseActorId("claude-code/abcdef12")!, op: { kind: "hook", event: "read" } });
  assert.deepEqual(r.hook, { event: "read", delivered: false });
  assert.equal(existsSync(join(bare.dir, ".carton")), false, "nothing made where Carton isn't on");
});

test("history kept in app data (a FAT/exFAT, read-only or synced bundle): the hook finds the holder there (review H8 #2)", { timeout: 60_000 }, async (t) => {
  // openLocal keeps carton.db in app data where the bundle can't take it; on Windows and macOS only the hard-link probe
  // tells, and a hook doesn't probe (it writes files). The app's holder runs on that carton.db.
  const { dir, projectId } = bundle("hook-appdata");
  const dataDir = mkdtempSync(join(scratch(), "appdata-"));
  const dbPath = join(dataDir, "projects", projectKey(projectId), "carton.db");
  mkdirSync(join(dataDir, "projects", projectKey(projectId)), { recursive: true });
  const store = await openSqliteStore(dbPath);
  await (await Carton.open({ adapter, store, hasher: nodeHasher, init: { doc: doc0() }, actor: me })).close();
  await store.close();
  assert.equal(existsSync(join(dir, ".carton", "carton.db")), false, "nothing in the bundle");
  assert.deepEqual(existingCartonDbs({ projectDir: dir, projectId, dataDir }), [dbPath]);
  const th = await EngineThread.start({ dbPath, factory: here("./support/real-mz-factory.ts"), config: { projectDir: dir } });
  t.after(async () => { await th.stop(); });
  await until(() => named(shared(dir), "c1") === "c1", 10_000, "the app's first print");
  const agent = parseActorId("claude-code/abcdef12")!;
  const r = await sendHookEvent({ projectDir: dir, projectId, dataDir, actor: agent, op: { kind: "hook", event: "read", file: "timeline.tsx" } });
  assert.deepEqual(r.hook, { event: "read", delivered: true }, JSON.stringify(r));
  // the Stop hook's store is that carton.db too, opened where it is: nothing made in the bundle, nothing moved
  const s2 = await openExistingProjectStore({ projectDir: dir, projectId, dataDir });
  assert.equal(s2?.path, dbPath);
  await s2?.close();
  assert.equal(existsSync(join(dir, ".carton", "carton.db")), false);
  assert.equal(await openExistingProjectStore({ projectDir: bundle("hook-appdata-bare").dir, dataDir }), null, "no carton.db: none made");
});
