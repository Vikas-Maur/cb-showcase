// windows-sync review round 4 #1: the person's own action in the app (`lc.write(op, { gui: true })`: a GUI save, ⌘Z)
// that another process's lease holder serves (a helper that took the lease while the app's engine thread was busy)
// lands in carton.db as another connection's change. The app's follower must tell the head move (the files show it)
// without telling the materializer someone is busy: a `cb` call freezes the shared timeline.tsx for a while, the
// person's own action never does. Here the other holder is an engine thread (its own realm, as another process's).
import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { openLocal, CartonHolderEngine } from "../src/open.ts";
import { EngineThread } from "../src/engine-thread.ts";
import type { ViewPrinter } from "../src/writes.ts";
import { adapter, bundle, doc0 } from "./support/real.ts";

const here = (f: string) => fileURLToPath(new URL(f, import.meta.url));
const set = (id: string, f: string, v: unknown) => ({ op: "set" as const, path: ["timelineItems", id, f], value: v });
const person = { kind: "human" as const, id: "person", name: "me", group: "gui-follow@test" };

test("a GUI write another process's holder served: the app's follower tells the head move, and no freeze (windows-sync r4 #1)", { timeout: 60_000 }, async (t) => {
  const { dir, projectId } = bundle("gui-follow");
  const init = await openLocal({ projectDir: dir, projectId, adapter, init: { doc: doc0() }, actor: person });
  const dbPath = init.dbPath;
  await init.close();
  // the holder in another process: it holds the lease and serves every write handed to it
  const th = await EngineThread.start({ dbPath, factory: here("./support/real-factory.ts"), config: { projectDir: dir } });
  // the app (this process): its facade's write path, and its follower on carton.db with the app's materializer
  const lc = await openLocal({ projectDir: dir, projectId, adapter, actor: person });
  const calls: string[] = [];
  const mz: ViewPrinter = {
    printView: async (name) => ({ name, path: name, ref: name }),
    onCb: async () => void calls.push("cb"),
    onHeadChange: (k) => void calls.push(`head:${k}`),
    onExternalHeadChange: async () => { calls.push("external"); return "head"; },
  };
  const engine = new CartonHolderEngine(lc.carton, { materializer: mz, follow: { intervalMs: 0 } });
  t.after(async () => { await engine.close(); await lc.close(); await th.stop(); });
  await engine.nudge();
  assert.deepEqual(calls.splice(0), [], "the first look only records where carton.db is");

  const gui = await lc.write({ kind: "commit", ops: [set("c1", "name", "the person's GUI save")] }, { actor: person, gui: true });
  assert.equal(gui.status, "confirmed", JSON.stringify(gui));
  await engine.nudge();
  assert.deepEqual(calls.splice(0), ["external"], "the head move is told; the person's own action freezes nothing");

  const undo = await lc.write({ kind: "undo", group: person.group }, { actor: person, gui: true });
  assert.equal(undo.status, "confirmed", JSON.stringify(undo));
  await engine.nudge();
  assert.deepEqual(calls.splice(0), ["external"], "nor does the person's ⌘Z");

  // control: the same write as a `cb` call (no `gui`) is someone at work: the file freezes for a while
  const cb = await lc.write({ kind: "commit", ops: [set("c2", "name", "a cb call")] }, { actor: person });
  assert.equal(cb.status, "confirmed", JSON.stringify(cb));
  await engine.nudge();
  assert.deepEqual(calls.splice(0), ["cb", "external"]);

  // a GUI write and a cb call in one look: the cb call's author is told, the GUI write isn't
  await lc.write({ kind: "commit", ops: [set("c3", "name", "gui again")] }, { actor: person, gui: true });
  await lc.write({ kind: "commit", ops: [set("c3", "name", "cb again")] }, { actor: person });
  await engine.nudge();
  assert.deepEqual(calls.splice(0), ["cb", "external"]);
});

// The review's missing coverage: the facade may write through one LocalCarton and follow carton.db with another in the
// same process (the worker opens a project twice). The note is per process, not per handle.
test("a GUI write through one handle, followed by another handle in the same process: still no freeze; a cb call in the same look still freezes", { timeout: 60_000 }, async (t) => {
  const { dir, projectId } = bundle("gui-follow-2");
  const init = await openLocal({ projectDir: dir, projectId, adapter, init: { doc: doc0() }, actor: person });
  const dbPath = init.dbPath;
  await init.close();
  const th = await EngineThread.start({ dbPath, factory: here("./support/real-factory.ts"), config: { projectDir: dir } });
  const writer = await openLocal({ projectDir: dir, projectId, adapter, actor: person });
  const followed = await openLocal({ projectDir: dir, projectId, adapter, actor: person });
  const calls: string[] = [];
  const mz: ViewPrinter = {
    printView: async (name) => ({ name, path: name, ref: name }),
    onCb: async () => void calls.push("cb"),
    onExternalHeadChange: async () => { calls.push("external"); return "head"; },
  };
  const engine = new CartonHolderEngine(followed.carton, { materializer: mz, follow: { intervalMs: 0 } });
  t.after(async () => { await engine.close(); await followed.close(); await writer.close(); await th.stop(); });
  await engine.nudge();
  calls.splice(0);
  assert.equal((await writer.write({ kind: "commit", ops: [set("c1", "name", "gui through another handle")] }, { actor: person, gui: true })).status, "confirmed");
  await engine.nudge();
  assert.deepEqual(calls.splice(0), ["external"], "the other handle's GUI write freezes nothing");
  // another process's cb call and a GUI write in one look: the cb call freezes
  const cb = await openLocal({ projectDir: dir, projectId, adapter, actor: { kind: "agent", id: "codex/gui-follow", name: "Codex" } });
  t.after(() => cb.close());
  await writer.write({ kind: "commit", ops: [set("c2", "name", "gui")] }, { actor: person, gui: true });
  assert.equal((await cb.write({ kind: "commit", ops: [set("c3", "name", "an agent's cb call")] })).status, "confirmed");
  await engine.nudge();
  assert.deepEqual(calls.splice(0), ["cb", "external"]);
});
