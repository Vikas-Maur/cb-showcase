// History.pin's hash: a pin of a confirmed version with nothing laid over it takes that version's hash, kept per
// version, instead of hashing the whole state again (a print of head pins it after every save); a pin with pending
// edits or a doc of its own still hashes the state it pins.
import test from "node:test";
import assert from "node:assert/strict";
import { defineSchema } from "../src/schema.ts";
import { apply, fork, hashDoc } from "../src/engine/index.ts";
import { History } from "../src/history/index.ts";
import type { Doc, Op } from "../src/types.ts";

const S = defineSchema({ collections: { items: { key: "id" } } });
const ME = { kind: "human", id: "me" } as const;
const named = (d: Doc, name: string): Doc => ({ ...d, items: (d.items as { id: string }[]).map((i) => (i.id === "a" ? { ...i, name } : i)) });

test("a pin's hash is the state it pins: a version's own (no edits over it), or the state with its pending edits or doc", () => {
  const d0: Doc = { name: "P", items: [{ id: "a", name: "a" }, { id: "b", name: "b" }] };
  const r = History.create(S, d0);
  const b = r.current;
  const s0 = fork(r.stateOf(`${b}@0`)!, S);
  r.commit(b, { doc: named(d0, "one"), author: ME } as never);
  r.commit(b, { doc: named(d0, "two"), author: ME } as never);
  const s2 = fork(r.stateOf(`${b}@2`)!, S);
  const head = r.pin({ cutId: b, owner: "test" });
  assert.equal(head.seq, 2);
  assert.equal(head.hash, hashDoc(s2, S), "head, nothing over it");
  const old = r.pin({ cutId: b, seq: 0, owner: "test" });
  assert.equal(old.hash, hashDoc(s0, S), "an older version: its own hash, not head's");
  assert.equal(r.pin({ cutId: b, doc: s2, owner: "test" }).hash, head.hash, "a doc equal to the version");
  const op: Op = { op: "set", path: ["items", "b", "name"], value: "pending" };
  const pending = r.pin({ cutId: b, pending: [{ id: "p.1", ops: [op] }], owner: "test" });
  assert.equal(pending.hash, hashDoc(apply(fork(s2, S), [op], S), S), "with a pending edit");
  assert.notEqual(pending.hash, head.hash);
  assert.equal(r.pin({ cutId: b, seq: 1, doc: named(d0, "doc's own"), owner: "test" }).hash, hashDoc(named(d0, "doc's own"), S), "with a doc of its own");
});
