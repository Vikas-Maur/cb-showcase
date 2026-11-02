// Restore and "New cut from here" on "Started the cut" (laptop, build 915eb36): an imported project's history starts at
// an empty root (main@0, §16) and the project itself is main@1. Restoring that root wrote a project.json with no name and
// empty tracks and media, and the project left Cardboard's library. The empty root holds nothing to restore: History
// says so in the log (`blank`) and refuses to restore it.
import test from "node:test";
import assert from "node:assert/strict";
import { defineSchema } from "../src/schema.ts";
import { EmptyVersion, History, nodeId } from "../src/history/index.ts";
import { isBlank } from "../src/engine/index.ts";
import type { Doc } from "../src/types.ts";

const schema = defineSchema({ collections: { tracks: { key: "id", seq: true }, items: { key: "id" } } });
const empty = (): Doc => ({ tracks: [], items: [] });
const film = (): Doc => ({ name: "Film", tracks: [{ id: "t1", "#pos": "V" }], items: [{ id: "a", name: "a" }] }) as unknown as Doc;
const me = { kind: "human" as const, id: "me" };

function imported() {
  const h = History.create(schema, empty());
  const main = h.current;
  h.commit(main, { doc: film(), author: { kind: "system", id: "import" }, kind: "import", id: "import.p" });
  h.commit(main, { ops: [{ op: "set", path: ["items", "a", "name"], value: "A" }], author: me });
  return { h, main };
}

test("isBlank: no root field and every collection empty", () => {
  assert.equal(isBlank(empty(), schema), true);
  assert.equal(isBlank({}, schema), true, "collections left out are empty");
  assert.equal(isBlank({ tracks: [], items: [], name: undefined } as Doc, schema), true, "an undefined field is no field");
  assert.equal(isBlank({ tracks: [], items: [], name: "Film" } as Doc, schema), false, "a name is something");
  assert.equal(isBlank({ tracks: [], items: [], aspectRatio: "" } as Doc, schema), false);
  assert.equal(isBlank({ tracks: [{ id: "t1" }], items: [] } as unknown as Doc, schema), false);
});

test("the log marks an imported project's empty root, and only it", () => {
  const { h, main } = imported();
  const log = h.log(main);
  assert.deepEqual(log.map((v) => [v.ref.seq, v.kind, !!v.blank]), [[2, "edit", false], [1, "import", false], [0, "root", true]]);
  // a cut made from a real version starts with something
  const alt = h.fork(nodeId(main, 1), "Alt");
  assert.equal(h.log(alt).find((v) => v.ref.seq === 0)!.blank, undefined);
  // a root that is the project (not an import) is never blank
  const plain = History.create(schema, film());
  assert.equal(plain.log(plain.current)[0]!.blank, undefined);
});

test("restoring the empty root is refused, and nothing changes", () => {
  const { h, main } = imported();
  const before = h.headSeq(main);
  assert.throws(() => h.restore(main, nodeId(main, 0)), (e: unknown) => e instanceof EmptyVersion && e.code === "EMPTY_VERSION" && /Nothing to restore/.test(e.message));
  assert.equal(h.headSeq(main), before, "no version was made");
  assert.equal((h.stateOf(h.head(main))! as { name?: string }).name, "Film");
  // a real version still restores
  assert.equal(h.restore(main, nodeId(main, 1)).status, "confirmed");
  assert.equal(((h.stateOf(h.head(main))! as { items: { name: string }[] }).items[0]!.name), "a");
});
