// The `history` request (Stage F, contract by foundation-core): a joiner's rows and lineage. The ancestry closure an
// adoption uploads keeps its carried states (as keyframes of the tracking branches) and last authors, and comes back
// as the adopted branch's lineage; rows come back paged, never past `upTo`.
import test from "node:test";
import assert from "node:assert/strict";
import { createSequencer } from "../src/index.ts";
import { clip, doc, fakeConn, memoryBlobs, set, sqliteStorage, staticAuth } from "./helpers.ts";
import type { Op, sync } from "@carton/core";

const rec = (id: string) => ({ id, name: id, forkOf: null, owner: "alice", kind: "main" as const, sequencer: { kind: "server" as const, since: 0 } });
const author = { kind: "human" as const, id: "alice" };
const H = (c: string) => c.repeat(64);
function row(id: string, seq: number, branchId: string) {
  const ops: Op[] = [set("c0", "name", `v${seq}`)];
  return { id, seq, hash: "h", author, branchId, base: { seq: seq - 1, pending: [] }, ops, intent: null, kinds: null, policy: "merge" as const, at: 0, paths: ["timelineItems/c0/name"], reads: ["timelineItems/c0"], spans: [], trackOrder: [] };
}
const node = (b: string, s: number, parents: string[] = []) => ({ id: `${b}@${s}`, branchId: b, seq: s, hash: H(String(s % 10)), kinds: ["fork" as const], parents: parents.map((id) => ({ id, remap: {} })) });

for (const blobs of [false, true])
  test(`history: an adoption's closure comes back as lineage with its states and authors; rows page up to upTo${blobs ? " (keyframes in the blob store)" : ""}`, async () => {
    const seq = createSequencer({ storage: sqliteStorage(), auth: staticAuth, catchupLimit: 2, ...(blobs ? { blobs: memoryBlobs() } : {}) });
    const c = fakeConn("alice/1");
    const d0 = doc([clip("c0", 0, 5)]);
    const forkState = doc([clip("c0", 0, 4)]);
    const rows = [1, 2, 3, 4, 5].map((s) => row(`alice.${s}`, s, "child"));
    const closure: sync.ClosureEntry[] = [
      { branchId: "parent", rec: rec("parent"), nodes: [node("parent", 0), node("parent", 7, ["parent@0"])], states: [{ seq: 7, hash: H("7"), doc: forkState as never }], authors: [["parent@7", { "timelineItems/c0": author }]] },
    ];
    await seq.handle(c, { type: "adopt", branchId: "child", n: 5, stateHash: H("c"), rows, rec: rec("child"), doc0: d0 as never, closure });
    assert.ok(c.last("adopted"));
    const ask = async (m: Omit<sync.HistoryMsg, "type" | "branchId">) => {
      await seq.handle(c, { type: "history", branchId: "child", ...m });
      return c.last("history")!;
    };
    const lin = await ask({ req: 1, after: 0, upTo: 0, lineage: true });
    assert.equal(lin.req, 1);
    assert.deepEqual(lin.rows, []);
    assert.equal(lin.lineage?.length, 1);
    const t = lin.lineage![0]!;
    assert.equal(t.branchId, "parent");
    assert.deepEqual(t.nodes.map((n) => n.id), ["parent@0", "parent@7"]);
    assert.deepEqual(t.states, [{ seq: 7, hash: H("7"), doc: forkState }]);
    assert.deepEqual(t.authors, [["parent@7", { "timelineItems/c0": author }]]);
    // rows: two per page (the catch-up limit), never past upTo
    const p1 = await ask({ req: 2, after: 1, upTo: 4 });
    assert.deepEqual(p1.rows.map((r) => r.seq), [2, 3]);
    assert.equal(p1.more, true);
    assert.equal(p1.lineage, undefined, "no lineage unless asked");
    const p2 = await ask({ req: 3, after: 3, upTo: 4 });
    assert.deepEqual(p2.rows.map((r) => r.seq), [4]);
    assert.equal(p2.more, undefined);
    // another adoption that shares the ancestor adds its nodes and authors to the tracking branch, never replaces it
    await seq.handle(c, { type: "adopt", branchId: "sibling", n: 0, stateHash: H("d"), rows: [], rec: rec("sibling"), doc0: d0 as never, closure: [{ branchId: "parent", rec: rec("parent"), nodes: [node("parent", 9, ["parent@7"])], authors: [["parent@9", {}]] }] });
    const tb = seq.tables.branch("parent")!;
    assert.deepEqual(tb.nodes!.map((n) => n.id), ["parent@0", "parent@7", "parent@9"]);
    assert.deepEqual(tb.authors!.map(([n]) => n), ["parent@7", "parent@9"]);
    assert.deepEqual(seq.tables.branch("sibling")!.closure, ["parent"]);
  });

test("history: an unknown branch, a cut the token doesn't cover and a bad closure state are refused", async () => {
  const seq = createSequencer({ storage: sqliteStorage(), auth: staticAuth });
  const c = fakeConn("alice/1");
  await seq.handle(c, { type: "history", branchId: "nope", req: 9, after: 0, upTo: 5 });
  assert.equal(c.last("history")!.error, "unknown branch");
  await seq.handle(c, { type: "adopt", branchId: "child", n: 0, stateHash: H("c"), rows: [], rec: rec("child"), doc0: doc([clip("c0", 0, 5)]) as never, closure: [] });
  const scoped = fakeConn("bob/1", "editor", { branches: ["other"] });
  await seq.handle(scoped, { type: "history", branchId: "child", req: 1, after: 0, upTo: 0, lineage: true });
  assert.equal(scoped.last("history")!.error, "forbidden");
  await seq.handle(c, { type: "adopt", branchId: "bad", n: 0, stateHash: H("c"), rows: [], rec: rec("bad"), doc0: doc([clip("c0", 0, 5)]) as never, closure: [{ branchId: "anc", rec: rec("anc"), nodes: [], states: [{ seq: -1, hash: "x", doc: {} as never }] }] });
  assert.match(c.last("adoptError")!.reason, /closure: bad/);
});

test("history: a session scoped to a cut gets no lineage outside its scope, so a variant folded into it stays unread (web-demo R3-1)", async () => {
  const seq = createSequencer({ storage: sqliteStorage(), auth: staticAuth });
  const c = fakeConn("alice/1");
  const d0 = doc([clip("c0", 0, 5)]);
  const variant = doc([clip("c0", 0, 3)]);
  const closure: sync.ClosureEntry[] = [{ branchId: "variant", rec: rec("variant"), nodes: [node("variant", 0), node("variant", 4, ["variant@0"])], states: [{ seq: 4, hash: H("4"), doc: variant as never }] }];
  await seq.handle(c, { type: "adopt", branchId: "pub", n: 0, stateHash: H("c"), rows: [], rec: rec("pub"), doc0: d0 as never, closure });
  assert.ok(c.last("adopted"));
  const ask = async (who: ReturnType<typeof fakeConn>) => {
    await seq.handle(who, { type: "history", branchId: "pub", req: 1, after: 0, upTo: 0, lineage: true });
    return who.last("history")!;
  };
  const watcher = await ask(fakeConn("w/1", "viewer", { branches: ["pub"] }));
  assert.equal(watcher.error, undefined);
  assert.deepEqual(watcher.lineage, [], "the variant's states reached a watch link");
  const teammate = await ask(fakeConn("t/1", "viewer"));
  assert.deepEqual(teammate.lineage?.map((t) => t.branchId), ["variant"], "an unscoped reader still gets the lineage");
  const both = await ask(fakeConn("e/1", "editor", { branches: ["pub", "variant"] }));
  assert.deepEqual(both.lineage?.map((t) => t.branchId), ["variant"], "a scope that covers the ancestor reads it");
});
