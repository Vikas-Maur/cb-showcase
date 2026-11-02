// local-cli request 8: the §16 import (main@1 over the empty root) is a lineage point. A hand-off closure starts at fork
// points and merges, which are past it, so it lists the import as a node (hash only) and never carries its state.
import test from "node:test";
import assert from "node:assert/strict";
import { defineSchema } from "../src/schema.ts";
import { History, nodeId } from "../src/history/index.ts";
import type { Doc } from "../src/types.ts";

const schema = defineSchema({ collections: { tracks: { key: "id", seq: true }, items: { key: "id" } } });
const empty = (): Doc => ({ tracks: [], items: [] });
const full = (): Doc => ({ tracks: [{ id: "t1" }], items: [{ id: "a", name: "a" }, { id: "b", name: "b" }] }) as unknown as Doc;
const me = { kind: "human" as const, id: "me" };

test("a hand-off closure lists the import as a lineage node without its state", () => {
  const h = History.create(schema, empty());
  const main = h.current;
  assert.equal(h.commit(main, { doc: full(), author: { kind: "system", id: "import" }, kind: "import", id: "import.p" }).status, "confirmed");
  h.commit(main, { ops: [{ op: "set", path: ["items", "a", "name"], value: "A" }], author: me });
  const alt = h.fork(nodeId(main, 2), "Alt");
  h.commit(alt, { ops: [{ op: "set", path: ["items", "b", "name"], value: "B" }], author: me });
  const entries = h.closure(alt);
  const m = entries.find((e) => e.branchId === main)!;
  assert.deepEqual(m.nodes.map((n) => [n.seq, [...n.kinds].sort()]).sort((x, y) => (x[0] as number) - (y[0] as number)), [[0, ["root"]], [1, ["import"]], [2, ["fork"]]]);
  assert.deepEqual((m.states ?? []).map((s) => s.seq), [2], "only the fork point's state");
});
