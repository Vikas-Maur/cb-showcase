// A printed header's `b:` names its cut by `branchToken(id)` (cardboard-adapter cfa541a, moved into core): any cut id
// reads back, not only ids that start with 8 lowercase hex characters, and two cuts with one token are told apart.
import { test } from "node:test";
import assert from "node:assert/strict";
import { Carton, branchToken, sha256Hex, type Doc, type Rec } from "@carton/core";
import { createMemoryStore } from "../src/index.ts";
import { adapter, doc0, set } from "./fixture.ts";

const nameOf = (d: Doc, id: string) => (d.items as Rec[]).find((x) => x.id === id)!.name;

test("branchToken: an id core makes keeps its first 8 characters; any other id gives 8 hex of its SHA-256", () => {
  assert.equal(branchToken("b7e1c2d3-0000-4000-8000-000000000000"), "b7e1c2d3", "a UUID: as headers always printed it");
  assert.equal(branchToken("0123456789abcdef01234567.2"), "01234567", "`cb cut new`'s ids likewise");
  const odd = ["b6b.alt", "ab-cdef01234", "ÉCLAT-cut", "main", "B7E1C2D3-0000", "abc", "\u{1f3ac} cut"];
  for (const id of odd) {
    assert.match(branchToken(id), /^[0-9a-f]{8}$/, id);
    assert.equal(branchToken(id), sha256Hex(id).slice(0, 8), id);
  }
  assert.equal(new Set(odd.map(branchToken)).size, odd.length, "distinct ids, distinct tokens");
});

test("a header for a cut id core didn't make (a dot, a dash, non-ASCII) reads back: resolve, and a save on it", async () => {
  const c = await Carton.open({ adapter, store: createMemoryStore(), init: { doc: doc0() } });
  // ids core makes print as they always did
  const main = c.cut;
  const { header: mh } = await c.pin({ owner: "t", cut: main });
  assert.ok(mh.includes(` b:${main.slice(0, 8)}`), mh);
  for (const id of ["b6b.alt", "ab-cdef01234", "ÉCLAT-cut"]) {
    await c.fork(`alt ${id}`, { id });
    await c.commit({ cut: id, ops: [set("a", "name", id)] });
    const { header } = await c.pin({ owner: "t", cut: id, by: "Claude Code" });
    assert.ok(header.includes(` b:${branchToken(id)} `), header);
    const r = await c.resolve(header);
    assert.equal(r.seq, 1);
    assert.equal(nameOf(r.doc, "a"), id, `${id}: the header names its own cut's state`);
    // an agent's save on that header: based on it, on that cut
    const out = await c.commit({ cut: id, base: header, ops: [set("b", "name", `${id} 2`)] });
    assert.equal(out.status, "confirmed", id);
    assert.equal(nameOf(await c.checkout(id), "b"), `${id} 2`);
  }
  await c.close();
});

test("two cuts with one token are told apart by the header's state, then by its cut name", async () => {
  const c = await Carton.open({ adapter, store: createMemoryStore(), init: { doc: doc0() } });
  // one token, "0123abcd", as a renamed copy shares its original's
  const one = "0123abcd-one",
    two = "0123abcd-two";
  assert.equal(branchToken(one), branchToken(two));
  await c.fork("One", { id: one });
  await c.fork("Two", { id: two });
  await c.commit({ cut: one, ops: [set("a", "name", "from one")] });
  await c.commit({ cut: two, ops: [set("a", "name", "from two")] });
  for (const [id, want] of [[one, "from one"], [two, "from two"]] as const) {
    const { header } = await c.pin({ owner: "t", cut: id });
    assert.equal(nameOf((await c.resolve(header)).doc, "a"), want, `by name: ${header}`);
  }
  // the same name on both: the cut that has the header's state at its seq
  await c.renameCut(one, "Same");
  await c.renameCut(two, "Same");
  for (const [id, want] of [[two, "from two"], [one, "from one"]] as const) {
    const { header } = await c.pin({ owner: "t", cut: id });
    assert.equal(nameOf((await c.resolve(header)).doc, "a"), want, `by state: ${header}`);
  }
  await c.close();
});

test("a header printed on a cut renamed since reads back from that cut, not from one now under the printed name (cardboard-adapter 0760ef2)", async () => {
  const c = await Carton.open({ adapter, store: createMemoryStore(), init: { doc: doc0() } });
  const one = "0123abcd-one",
    two = "0123abcd-two";
  await c.fork("One", { id: one });
  await c.fork("Two", { id: two });
  await c.commit({ cut: one, ops: [set("a", "name", "from one")] });
  await c.commit({ cut: two, ops: [set("a", "name", "from two")] });
  const { header } = await c.pin({ owner: "t", cut: one });
  // a held state on `one` (a freeze view): only its pin has it
  const d = (await c.head(one)).doc;
  const held = { ...d, items: (d.items as Rec[]).map((x) => (x.id === "b" ? { ...x, name: "held on one" } : x)) };
  const { header: heldHeader } = await c.pin({ owner: "t", cut: one, doc: held });
  await c.renameCut(one, "Moved");
  await c.renameCut(two, "One");
  assert.equal(nameOf((await c.resolve(header)).doc, "a"), "from one", `the cut with the printed state: ${header}`);
  assert.equal(nameOf((await c.resolve(heldHeader)).doc, "b"), "held on one", `a pinned state counts: ${heldHeader}`);
  await c.close();
});
