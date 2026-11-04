// The app's Ctrl+Z and redo through @carton/local (laptop report 90c4127, bugs 3 and 4): an actor the app named in
// CARDBOARD_ACTOR is the app's (`app`), a terminal's cb is not; the write path's `undo` with the app's scope (`app`,
// `since`) skips the terminal's edits and stops at the session's start, and `redo` re-applies what it took back. Every
// local actor keeps the machine's undo group (`cb undo`, History's Undo, the Materializer's local agents).
import { test } from "node:test";
import assert from "node:assert/strict";
import { Carton } from "@carton/core";
import type { Actor } from "@carton/core";
import { createMemoryStore } from "@carton/store-memory";
import { identify, localGroup } from "../src/identity.ts";
import { runWrite } from "../src/writes.ts";
import { adapter, doc0 } from "./support/real.ts";

const set = (id: string, f: string, v: unknown) => ({ op: "set" as const, path: ["timelineItems", id, f], value: v });
const name = async (c: Carton, id: string) => ((await c.head()).doc.timelineItems as { id: string; name: string }[]).find((i) => i.id === id)!.name;

test("an actor the app named (CARDBOARD_ACTOR, directly or through the hook) is the app's; a terminal's cb never is; all share the machine's group", () => {
  const director = identify({ env: { CARDBOARD_ACTOR: "director/c1/t7" } });
  const inApp = identify({ env: { CARDBOARD_ACTOR: "claude-code/chat9" } });
  const hooked = identify({ env: { CARDBOARD_ACTOR: "claude-code/chat9" }, hook: { session_id: "0123456789", agent_id: "a1", agent_type: "Explore" } });
  for (const a of [director, inApp, hooked]) assert.deepEqual([a.app, a.group], [true, localGroup()], a.id);
  const terminalHook = identify({ env: {}, hook: { session_id: "0123456789abcdef" } });
  const declared = identify({ env: {}, declared: "codex/fix-captions" });
  const claude = identify({ env: { CLAUDECODE: "1" } });
  const person = identify({ env: {} });
  for (const a of [terminalHook, declared, claude, person]) {
    assert.equal(a.app, undefined, `${a.id}: a terminal's cb is not the app's`);
    assert.equal(a.group, localGroup(), `${a.id}: still the machine's group`);
  }
});

test("the write path's undo with the app's scope skips a terminal's edit and stops at the session; redo re-applies it; a retry answers once", async () => {
  let now = 5_000;
  const c = await Carton.open({ adapter, store: createMemoryStore(), init: { doc: doc0() }, clock: () => now });
  const person: Actor = { kind: "human", id: "person", group: localGroup(), app: true };
  const terminal = identify({ env: { CLAUDECODE: "1" } });
  await c.commit({ ops: [set("c0", "name", "before the session")], author: person });
  now += 10;
  const since = now;
  now += 10;
  await c.commit({ ops: [set("c1", "name", "mine")], author: person });
  now += 10;
  await c.commit({ ops: [set("c2", "name", "terminal")], author: terminal });
  const scope = { group: localGroup(), since, app: true };

  now += 10;
  const z = await runWrite(c, { id: "app.z1", actor: person, gui: true, op: { kind: "undo", ...scope } });
  assert.equal(z.status, "confirmed");
  assert.deepEqual([await name(c, "c1"), await name(c, "c2")], ["c1", "terminal"], "the person's edit undone, the terminal's newer one kept");
  const again = await runWrite(c, { id: "app.z1", actor: person, gui: true, op: { kind: "undo", ...scope } });
  assert.equal(again.status === "confirmed" && again.seq, z.status === "confirmed" && z.seq, "a retried request gets its first answer");
  now += 10;
  const none = await runWrite(c, { id: "app.z2", actor: person, gui: true, op: { kind: "undo", ...scope } });
  assert.equal(none.status === "confirmed" && none.empty, true, "nothing more: the earlier edit is before the session");
  assert.equal(await name(c, "c0"), "before the session");

  now += 10;
  const y = await runWrite(c, { id: "app.y1", actor: person, gui: true, op: { kind: "redo", ...scope } });
  assert.equal(y.status, "confirmed");
  assert.equal(await name(c, "c1"), "mine", "redo brings back what the undo took back");
  now += 10;
  const y2 = await runWrite(c, { id: "app.y2", actor: person, gui: true, op: { kind: "redo", ...scope } });
  assert.equal(y2.status === "confirmed" && y2.empty, true, "nothing more to redo");
  // unscoped (`cb undo`, History's Undo): the whole machine group, the terminal's edit in it
  assert.ok((await c.undoStack(localGroup())).some((e) => e.author.id === terminal.id), "the machine group's stack has the terminal's edit");
  assert.ok(!(await c.undoStack(localGroup(), { since, app: true })).some((e) => e.author.id === terminal.id), "the app's Ctrl+Z never has it");
  await c.close();
});
