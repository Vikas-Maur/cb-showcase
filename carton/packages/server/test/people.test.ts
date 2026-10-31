// The people record (windows-sync R3, foundation-core's request): a device credential's person, so the generic
// "person" author of a GUI save resolves by its change's rid. Tests (a)–(f) are the request's; the rest are the
// server's own rules (names, scoped readers, the rate cap, controls, rollback, persistence).
import test from "node:test";
import assert from "node:assert/strict";
import type { Op, sync } from "@carton/core";
import { createSequencer } from "../src/index.ts";
import { BRANCH, clip, doc, fakeConn, push, set, sqliteStorage, staticAuth, verdict, world, type FakeConn } from "./helpers.ts";

const rec = (id: string) => ({ id, name: id, forkOf: null, owner: "alice", kind: "main" as const, sequencer: { kind: "server" as const, since: 0 } });
const hello = (o: Partial<sync.HelloMsg> = {}): sync.HelloMsg => ({ type: "hello", branchId: BRANCH, have: 0, pending: [], rids: [], schemaVersion: 1, ...o });
const author = { kind: "human" as const, id: "person" };
function row(id: string, seq: number, branchId: string, name = id) {
  const ops: Op[] = [set("c0", "name", name)];
  return { id, seq, hash: "h", author, branchId, base: { seq: seq - 1, pending: [] }, ops, intent: null, kinds: null, policy: "merge" as const, at: 0, paths: ["timelineItems/c0/name"], reads: ["timelineItems/c0"], spans: [], trackOrder: [] };
}
const people = (c: FakeConn) => c.inbox.filter((m) => m.type === "people") as sync.PeopleMsg[];
const errors = (c: FakeConn) => c.inbox.filter((m) => m.type === "error") as sync.ErrorMsg[];
const welcomePeople = (c: FakeConn) => c.last("hello")!.people;
const identity = (id: string, name: string): sync.IdentityMsg => ({ type: "identity", branchId: BRANCH, identity: { id, name } });
const d0 = () => doc([clip("c0", 0, 5)]);

test("(a) an identity under another account is forbidden: nothing recorded, and the connection goes on", async () => {
  const { seq, d0: before } = await world(d0());
  const a = fakeConn("alice/dev1");
  await seq.handle(a, hello({ identity: { id: "bob", name: "Bob" } }));
  assert.deepEqual(errors(a).map((e) => e.code), ["forbidden"]);
  assert.match(errors(a)[0]!.reason, /^identity: "bob" isn't this session's account/);
  assert.deepEqual(welcomePeople(a), [], "the welcome still comes, with nothing recorded");
  await seq.handle(a, identity("bob", "Bob"));
  await seq.handle(a, { type: "identity", branchId: BRANCH, identity: null as never });
  assert.deepEqual(errors(a).map((e) => e.code), ["forbidden", "forbidden", "forbidden"]);
  assert.deepEqual(seq.tables.people(), []);
  assert.equal(verdict(await push(seq, a, before, [set("c0", "name", "x")])), "ack", "the connection is still served");
});

test("(b) a share's earlier edits resolve: the joiner's welcome names every rid the hand-off bound to the sharer", async () => {
  const { seq } = await world(d0());
  const a = fakeConn("alice/dev1"), b = fakeConn("bob/dev1");
  await seq.handle(a, hello({ identity: { id: "alice", name: "Alice" } }));
  // two earlier processes (r1, r2) edited the cut before it was shared; the hand-off uploads their rows
  const rows = [row("r1aaaaaaaaaaaaaaaaaaaaaa.1", 1, "shared"), row("r2bbbbbbbbbbbbbbbbbbbbbb.1", 2, "shared")];
  a.inbox.length = 0;
  await seq.handle(a, { type: "adopt", branchId: "shared", n: 2, stateHash: "h", rows, rec: rec("shared"), doc0: d0() as never, closure: [] });
  assert.ok(a.last("adopted"));
  assert.deepEqual(people(a).map((p) => p.people), [[{ id: "alice", name: "Alice", rids: ["r1aaaaaaaaaaaaaaaaaaaaaa", "r2bbbbbbbbbbbbbbbbbbbbbb"] }]], "told once the hand-off committed");
  await seq.handle(b, hello({ branchId: "shared", have: 0 }));
  const entry = welcomePeople(b)!.find((p) => p.id === "alice")!;
  assert.equal(entry.name, "Alice");
  for (const rid of ["r1aaaaaaaaaaaaaaaaaaaaaa", "r2bbbbbbbbbbbbbbbbbbbbbb"]) assert.ok(entry.rids.includes(rid), rid);
});

test("(c) a new process of the same device: its rid is told to everyone before the row it binds", async () => {
  const { seq, d0: before } = await world(d0());
  const a = fakeConn("alice/dev1"), b = fakeConn("bob/dev1");
  await seq.handle(a, hello({ identity: { id: "alice", name: "Alice" } }));
  await seq.handle(b, hello());
  const a2 = fakeConn("alice/dev1"); // the same credential, a new process (rid r3)
  await seq.handle(a2, hello({ identity: { id: "alice", name: "Alice" } }));
  b.inbox.length = 0;
  assert.equal(verdict(await push(seq, a2, before, [set("c0", "name", "r3's")], { id: "r3cccccccccccccccccccccc.1" })), "ack");
  const told = b.inbox.findIndex((m) => m.type === "people" && m.people.some((p) => p.rids.includes("r3cccccccccccccccccccccc")));
  const row3 = b.inbox.findIndex((m) => m.type === "changes" && m.rows[0]!.id.startsWith("r3cccccccccccccccccccccc."));
  assert.ok(told >= 0 && row3 > told, `people at ${told}, the row at ${row3}`);
  assert.deepEqual((b.inbox[told] as sync.PeopleMsg).people, [{ id: "alice", name: "Alice", rids: ["r3cccccccccccccccccccccc"] }], "the new rid alone");
  // a hello's claim binds too: told the same way
  b.inbox.length = 0;
  await seq.handle(fakeConn("alice/dev1"), hello({ rids: ["r4dddddddddddddddddddddd"] }));
  assert.deepEqual(people(b).map((p) => p.people), [[{ id: "alice", name: "Alice", rids: ["r4dddddddddddddddddddddd"] }]]);
  // a device without a person binds rids silently
  b.inbox.length = 0;
  await seq.handle(fakeConn("carol/dev1"), hello({ rids: ["r5eeeeeeeeeeeeeeeeeeeeee"] }));
  assert.deepEqual(people(b), []);
});

test("(d) a rename reaches every connection of the project, the sender's own as its confirmation; the same name again is nothing", async () => {
  const { seq } = await world(d0());
  await seq.createBranch(rec("other"), { doc0: d0() as never, stateHash: "h0" });
  const a = fakeConn("alice/dev1"), b = fakeConn("bob/dev1"), v = fakeConn("vic/dev1", "viewer"), o = fakeConn("olga/dev1");
  for (const c of [a, b, v]) await seq.handle(c, hello(c === a ? { identity: { id: "alice", name: "Alice" } } : {}));
  await seq.handle(o, hello({ branchId: "other" })); // on another cut of the project
  for (const c of [a, b, v, o]) c.inbox.length = 0;
  await seq.handle(a, identity("alice", "  Alice B.  "));
  for (const c of [a, b, v, o]) assert.deepEqual(people(c).map((p) => [p.branchId, p.people]), [[c === o ? "other" : BRANCH, [{ id: "alice", name: "Alice B.", rids: [] }]]], c.auth.credential);
  for (const c of [a, b, v, o]) c.inbox.length = 0;
  await seq.handle(a, identity("alice", "Alice B."));
  for (const c of [a, b, v, o]) assert.deepEqual(c.inbox, [], "no change, no message");
});

test("(e) a hello without identity gets `people` in its welcome: [] on a fresh project, then everyone's", async () => {
  const { seq } = await world(d0());
  const b = fakeConn("bob/dev1");
  await seq.handle(b, hello());
  assert.deepEqual(welcomePeople(b), []);
  await seq.handle(fakeConn("alice/dev1"), hello({ identity: { id: "alice", name: "Alice" }, rids: ["r1aaaaaaaaaaaaaaaaaaaaaa"] }));
  await seq.handle(b, hello());
  assert.deepEqual(welcomePeople(b), [{ id: "alice", name: "Alice", rids: ["r1aaaaaaaaaaaaaaaaaaaaaa"] }]);
  // a claims-only page (the list not yet complete: here past 2 claim windows) subscribes nothing and holds no people
  const { seq: s2, d0: before } = await world(d0(), { controls: { claimWindows: 2 } });
  const w = fakeConn("will/dev1");
  for (let i = 0; i < 12; i++) await push(s2, w, before, [set("c0", "name", String(i))]);
  const c = fakeConn("carol/dev1");
  await s2.handle(c, hello({ have: 12, pending: [{ id: "missing.1", bases: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11] }] }));
  const partial = c.last("hello")!;
  assert.deepEqual([partial.uncheckedFrom, partial.people], [2, undefined]);
});

test("(f) an old client (no identity field) is unaffected: served as before, never refused", async () => {
  const { seq, d0: before } = await world(d0());
  const a = fakeConn("alice/dev1"), old = fakeConn("olga/dev1");
  await seq.handle(a, hello({ identity: { id: "alice", name: "Alice" } }));
  await seq.handle(old, hello());
  assert.equal(verdict(await push(seq, old, before, [set("c0", "name", "old")])), "ack");
  assert.equal(verdict(await push(seq, a, before, [set("c0", "name", "new")], { base: { seq: 1, pending: [] } })), "ack");
  assert.ok(old.inbox.some((m) => m.type === "changes"));
  assert.deepEqual(errors(old), []);
});

test("names: 1–200 characters after trimming (code points), no control characters; anything else is a bad request", async () => {
  const { seq } = await world(d0());
  const a = fakeConn("alice/dev1");
  await seq.handle(a, hello());
  for (const name of ["", "   ", "x".repeat(201), "Al\nice", "Al\u0000ice", "\u0085", 42 as never]) {
    a.inbox.length = 0;
    await seq.handle(a, identity("alice", name));
    assert.deepEqual(errors(a).map((e) => e.code), ["bad-request"], JSON.stringify(name));
  }
  assert.deepEqual(seq.tables.people(), []);
  await seq.handle(a, identity("alice", "😀".repeat(200)));
  assert.equal(seq.tables.people()[0]?.name, "😀".repeat(200), "200 characters, 400 UTF-16 units");
});

test("a reader scoped to some cuts (a watch link) learns no one: `people: []` in its welcome, no `people` messages", async () => {
  const { seq } = await world(d0());
  const a = fakeConn("alice/dev1"), w = fakeConn("watcher/link", "viewer", { branches: [BRANCH] }), v = fakeConn("vic/dev1", "viewer");
  await seq.handle(a, hello({ identity: { id: "alice", name: "Alice" }, rids: ["r1aaaaaaaaaaaaaaaaaaaaaa"] }));
  await seq.handle(w, hello());
  await seq.handle(v, hello());
  assert.deepEqual(welcomePeople(w), [], "present, so the client knows people are kept, but empty");
  assert.equal(welcomePeople(v)!.length, 1, "a viewer of the whole project is a teammate");
  await seq.handle(a, identity("alice", "Alice B."));
  await seq.handle(fakeConn("alice/dev1"), hello({ rids: ["r2bbbbbbbbbbbbbbbbbbbbbb"] }));
  assert.deepEqual(people(w), []);
  assert.equal(people(v).length, 2);
  // a scoped writer reads every cut anyway: it sees the people
  const sw = fakeConn("sam/dev1", "editor", { branches: [BRANCH] });
  await seq.handle(sw, hello());
  assert.equal(welcomePeople(sw)!.length, 1);
});

test("changes to a person are capped per connection: 5 at once, then one every 12 s; the same name costs nothing", async () => {
  let now = 1_000_000;
  const { seq } = await world(d0(), { clock: () => now });
  const a = fakeConn("alice/dev1");
  await seq.handle(a, hello());
  for (let i = 0; i < 5; i++) await seq.handle(a, identity("alice", `Alice ${i}`));
  await seq.handle(a, identity("alice", "Alice 4"));
  assert.deepEqual(errors(a), []);
  await seq.handle(a, identity("alice", "Alice 5"));
  assert.deepEqual(errors(a).map((e) => [e.code, e.reason]), [["bad-request", "identity: changed too often; try again in a minute"]]);
  assert.equal(seq.tables.people()[0]!.name, "Alice 4");
  now += 12_000;
  await seq.handle(a, identity("alice", "Alice 5"));
  assert.equal(seq.tables.people()[0]!.name, "Alice 5");
});

test("controls: without rid binding a person is kept with no rids; per-connection binding keys people by connection", async () => {
  const { seq } = await world(d0(), { controls: { bindRid: false } });
  const a = fakeConn("alice/dev1");
  await seq.handle(a, hello({ identity: { id: "alice", name: "Alice" }, rids: ["r1aaaaaaaaaaaaaaaaaaaaaa"] }));
  assert.deepEqual(welcomePeople(a), [{ id: "alice", name: "Alice", rids: [] }]);
  const { seq: perConn } = await world(d0(), { controls: { bindRid: "connection" } });
  const c1 = fakeConn("alice/dev1"), c2 = fakeConn("alice/dev1");
  await perConn.handle(c1, hello({ identity: { id: "alice", name: "Alice" }, rids: ["r1aaaaaaaaaaaaaaaaaaaaaa"] }));
  await perConn.handle(c2, hello({ identity: { id: "alice", name: "Alice (laptop)" }, rids: ["r2bbbbbbbbbbbbbbbbbbbbbb"] }));
  assert.deepEqual(welcomePeople(c2), [{ id: "alice", name: "Alice", rids: ["r1aaaaaaaaaaaaaaaaaaaaaa"] }, { id: "alice", name: "Alice (laptop)", rids: ["r2bbbbbbbbbbbbbbbbbbbbbb"] }]);
});

test("a hand-off that rolls back tells no one of its rids; the retry does", async () => {
  const { seq } = await world(d0());
  const a = fakeConn("alice/dev1"), b = fakeConn("bob/dev1");
  await seq.handle(a, hello({ identity: { id: "alice", name: "Alice" } }));
  await seq.handle(b, hello());
  const rows = [row("r1aaaaaaaaaaaaaaaaaaaaaa.1", 1, "shared"), row("r2bbbbbbbbbbbbbbbbbbbbbb.1", 2, "shared")];
  const adopt = { type: "adopt" as const, branchId: "shared", n: 2, stateHash: "h", rows, rec: rec("shared"), doc0: d0() as never, closure: [] };
  b.inbox.length = 0;
  await seq.handle(a, { ...adopt, rows: [rows[0]!, { ...rows[1]!, ops: null as never }] }); // fails inside the transaction
  assert.ok(a.last("adoptError"));
  assert.deepEqual(people(b), [], "nothing was bound");
  assert.deepEqual(seq.tables.people(), [{ id: "alice", name: "Alice", rids: [] }], "nor cached");
  await seq.handle(a, adopt);
  assert.deepEqual(people(b).map((p) => p.people[0]!.rids), [["r1aaaaaaaaaaaaaaaaaaaaaa", "r2bbbbbbbbbbbbbbbbbbbbbb"]]);
});

test("the people persist: a new sequencer over the same storage (a restart, a woken room) welcomes with them", async () => {
  const storage = sqliteStorage();
  const first = createSequencer({ storage, auth: staticAuth });
  await first.createBranch(rec(BRANCH), { doc0: d0() as never, stateHash: "h0" });
  await first.handle(fakeConn("alice/dev1"), hello({ identity: { id: "alice", name: "Alice" }, rids: ["r1aaaaaaaaaaaaaaaaaaaaaa"] }));
  const again = createSequencer({ storage, auth: staticAuth });
  const b = fakeConn("bob/dev1");
  await again.handle(b, hello());
  assert.deepEqual(welcomePeople(b), [{ id: "alice", name: "Alice", rids: ["r1aaaaaaaaaaaaaaaaaaaaaa"] }]);
  // and a rid bound after the restart joins the person read back
  await again.handle(fakeConn("alice/dev1"), hello({ rids: ["r2bbbbbbbbbbbbbbbbbbbbbb"] }));
  assert.deepEqual(again.tables.people()[0]!.rids, ["r1aaaaaaaaaaaaaaaaaaaaaa", "r2bbbbbbbbbbbbbbbbbbbbbb"]);
});
