// Stage F: every mutating write runs under its request id, so a retried call (its holder died after receiving it) gets
// the first answer and never a second change: undo, revert, restore, fold, fold in some of it, new cut.
import { test } from "node:test";
import assert from "node:assert/strict";
import { Carton } from "@carton/core";
import type { Actor } from "@carton/core";
import { createMemoryStore } from "@carton/store-memory";
import { runWrite } from "../src/writes.ts";
import type { WriteOp } from "../src/writes.ts";
import { adapter, doc0 } from "./support/real.ts";

const agent: Actor = { kind: "agent", id: "codex/retry", name: "Codex", group: "local:me@box" };
const set = (id: string, f: string, v: unknown) => ({ op: "set" as const, path: ["timelineItems", id, f], value: v });

test("a retried write (same request id) gets the first answer and makes no second change", async () => {
  const c = await Carton.open({ adapter, store: createMemoryStore(), init: { doc: doc0() }, actor: agent });
  const main = c.cut;
  const once = async (id: string, op: WriteOp) => {
    const before = (await c.log({ limit: 1000 })).length;
    const a = await runWrite(c, { id, actor: agent, op: structuredClone(op) });
    const mid = (await c.log({ limit: 1000 })).length;
    const b = await runWrite(c, { id, actor: agent, op: structuredClone(op) });
    const after = (await c.log({ limit: 1000 })).length;
    assert.equal(after, mid, `${op.kind}: the retry made no second change`);
    assert.equal(b.status, a.status, `${op.kind}: same answer`);
    return { a, b, made: mid - before };
  };
  await runWrite(c, { id: "w.1", actor: agent, op: { kind: "commit", ops: [set("c1", "name", "x")] } });
  await runWrite(c, { id: "w.2", actor: agent, op: { kind: "commit", ops: [set("c2", "name", "y")] } });
  assert.equal((await once("u.1", { kind: "undo" })).made, 1, "one undo");
  const firstChange = (await c.log({ limit: 1000 })).find((v) => v.change === "w.1")!.change!;
  assert.equal((await once("rv.1", { kind: "revert", changeId: firstChange })).made, 1, "one revert");
  assert.equal((await once("rs.1", { kind: "restore", ref: `${main}@1` })).made, 1, "one restore");
  const f1 = await runWrite(c, { id: "fk.1", actor: agent, op: { kind: "fork", name: "Alt" } });
  const f2 = await runWrite(c, { id: "fk.1", actor: agent, op: { kind: "fork", name: "Alt" } });
  assert.equal((await c.cuts()).filter((x) => x.name === "Alt").length, 1, "one new cut");
  assert.equal((f1 as any).cut.id, (f2 as any).cut.id);
  const alt = (f1 as any).cut.id as string;
  await runWrite(c, { id: "w.3", actor: agent, op: { kind: "commit", cut: alt, ops: [set("c3", "name", "alt")] } });
  assert.equal((await once("fo.1", { kind: "fold", from: alt })).made, 1, "one fold");
  await runWrite(c, { id: "w.4", actor: agent, op: { kind: "commit", cut: alt, ops: [set("c4", "name", "alt-4"), set("c5", "name", "alt-5")] } });
  const some = await once("fs.1", { kind: "fold", from: alt, reject: ["timelineItems/c5"] });
  assert.ok(some.made >= 1, "fold in some of it, once");
});
