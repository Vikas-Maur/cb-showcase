// A cb write on a shared cut whose change the server answers `absorbed` (spent by a withdraw: its effect was already
// there) answers confirmed, never a conflicts result built from cards the outcome doesn't have.
import { test } from "node:test";
import assert from "node:assert/strict";
import type { Actor, Carton } from "@carton/core";
import { runWrite } from "../src/writes.ts";

test("a shared-cut write the server answers `absorbed` is confirmed, with absorbed: true", async () => {
  const ref = { branchId: "cut-1", seq: 6, pending: [] };
  const carton = {
    cut: "cut-1",
    store: undefined,
    notices: async () => [],
    on: () => () => {},
    head: async () => ({ ref, doc: {} }),
    cuts: async () => [{ id: "cut-1", name: "Main cut", sequencer: { kind: "server", since: 1 } }],
    commit: async () => ({ status: "pending", id: "r.1", ref }),
    sync: { status: "up-to-date", waitFor: async (id: string) => ({ status: "absorbed", id, seq: 7 }) },
  } as unknown as Carton;
  const actor: Actor = { kind: "agent", id: "codex", group: "local:me@box" };
  const r = await runWrite(carton, { id: "r.1", actor, op: { kind: "commit", ops: [] } }, { online: () => true });
  assert.deepEqual([r.status, r.status === "confirmed" && r.seq, r.absorbed], ["confirmed", 7, true]);
});
