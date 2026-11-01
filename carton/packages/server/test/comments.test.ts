// Comments in the sequencer core (REQ-C1): the two message kinds go to @carton/comments' room, in turn with every
// other message and after the checks every message passes. The room's own rules (roles, scope, authors, rate, ops,
// the cap) are tested in @carton/comments; these test the routing: who is subscribed, where the subscription lives,
// which connections the rows reach, and that the rules hold through the core as a host runs it.
import test from "node:test";
import assert from "node:assert/strict";
import { sync } from "@carton/core";
import { createSequencer } from "../src/index.ts";
import { BRANCH, clip, doc, fakeConn, memoryBlobs, sqliteStorage, staticAuth, world, type FakeConn } from "./helpers.ts";

type Row = { id: string; cut: string; body: string; author: { id: string; name: string } };
const d0 = () => doc([clip("c0", 0, 5)]);
const subscribe = (branchId = BRANCH) => ({ type: "comments", branchId, since: 0 }) as unknown as sync.ClientMessage;
let n = 0;
const comment = (id: string, patch: Record<string, unknown>, branchId = BRANCH) =>
  ({ type: "comment", branchId, n: ++n, id, op: `op-${n}`, patch: { at: 1, author: { id: "claimed", name: "Claimed" }, ...patch } }) as unknown as sync.ClientMessage;
const add = (id: string, body: string, cut = BRANCH) => comment(id, { add: { body, cut, at: 1 } }, cut);
const answers = (c: FakeConn) => c.inbox.filter((m) => (m.type as string) === "commentAnswer") as unknown as { n: number; row?: Row; refused?: string; reason?: string }[];
const fanned = (c: FakeConn) => c.inbox.filter((m) => (m.type as string) === "comments" && !(m as { reply?: boolean }).reply).flatMap((m) => (m as unknown as { rows: Row[] }).rows);

test("a `comments` request subscribes the connection (in its state) and answers its catch-up; rows reach subscribers only, never the writer twice", async () => {
  const { seq } = await world(d0());
  const a = fakeConn("alice/1"), b = fakeConn("bob/1"), quiet = fakeConn("carol/1");
  await seq.handle(quiet, { type: "branchStatus", branchId: BRANCH } as sync.ClientMessage); // attached, never subscribed
  await seq.handle(b, subscribe());
  assert.equal(b.state?.comments, true, "kept in the connection's state, which a host keeps across hibernation");
  assert.equal((b.inbox.at(-1) as { reply?: boolean }).reply, true);
  await seq.handle(a, add("c1", "First"));
  const [ans] = answers(a);
  assert.equal(ans?.row?.id, "c1");
  assert.equal(ans?.row?.author.id, "alice", "the session's account, never the claim");
  assert.deepEqual(fanned(b).map((r) => r.id), ["c1"]);
  assert.deepEqual(fanned(a), [], "the writer has its answer");
  assert.equal(quiet.inbox.some((m) => (m.type as string) === "comments"), false);
});

test("the checks every message passes hold for comments too: a cut named by a string, a scoped reader's own cut, a live token", async () => {
  let now = 1_000_000;
  const { seq } = await world(d0(), { clock: () => now });
  const watch = fakeConn("w/1", "viewer", { branches: ["pub"] });
  await seq.handle(watch, subscribe("main-elsewhere"));
  assert.deepEqual(watch.inbox, [{ type: "error", code: "forbidden", reason: "this token can't read main-elsewhere" }]);
  assert.equal(watch.state?.comments, undefined, "not subscribed by a refused request");
  const a = fakeConn("alice/1");
  await seq.handle(a, { type: "comment", branchId: 7, n: 1, id: "x", patch: {} } as unknown as sync.ClientMessage);
  assert.deepEqual(a.inbox, [{ type: "error", code: "bad-request", reason: "a message must name its cut by a string id" }]);
  const late = fakeConn("bob/1", "editor", { expires: now + 10 });
  now += 20;
  await seq.handle(late, add("c-late", "too late"));
  assert.equal((late.inbox[0] as { code?: string }).code, "unauthorized");
  assert.deepEqual(answers(late), [], "never reached the room");
});

test("a watch link subscribed to its cut gets that cut's new comments and no other's", async () => {
  const { seq } = await world(d0());
  const watch = fakeConn("w/1", "viewer", { branches: ["pub"] }), a = fakeConn("alice/1");
  await seq.handle(watch, subscribe("pub"));
  await seq.handle(a, add("on-main", "Main", BRANCH));
  await seq.handle(a, add("on-pub", "Published", "pub"));
  assert.deepEqual(fanned(watch).map((r) => r.id), ["on-pub"]);
});

test("a comment inside a client envelope is routed as one sent inline", async () => {
  const blobs = memoryBlobs();
  const { seq } = await world(d0(), { blobs });
  const a = fakeConn("alice/1"), b = fakeConn("bob/1");
  await seq.handle(b, subscribe());
  const big = sync.oversized(add("c-env", "x".repeat(2000)), 1024)!;
  await seq.handle(a, await sync.seal(big, blobs, (sha) => sync.clientEnvelopeKey(sha, Date.now())));
  assert.equal(answers(a)[0]?.row?.id, "c-env");
  assert.deepEqual(fanned(b).map((r) => r.id), ["c-env"]);
});

test("the name the server keeps for a person (`people`) is the comment's author name, not the one a patch carries", async () => {
  const { seq } = await world(d0());
  const a = fakeConn("alice/1");
  await seq.handle(a, { type: "identity", branchId: BRANCH, identity: { id: "alice", name: "Alice Liddell" } } as sync.ClientMessage);
  await seq.handle(a, add("c-named", "hi"));
  assert.deepEqual(answers(a)[0]?.row?.author, { id: "alice", name: "Alice Liddell" });
});

test("after a wake (a new sequencer over the same storage, the socket's state kept) the subscription and the rows are still there", async () => {
  const storage = sqliteStorage();
  const { seq } = await world(d0(), { storage });
  const a = fakeConn("alice/1"), b = fakeConn("bob/1");
  await seq.handle(b, subscribe());
  await seq.handle(a, add("c1", "before"));
  // the Durable Object's wake: only what each socket's attachment kept comes back
  const woken = createSequencer({ storage, auth: staticAuth });
  const b2 = { ...fakeConn("bob/1"), id: b.id, state: structuredClone(b.state) };
  const a2 = { ...fakeConn("alice/1"), id: a.id, state: structuredClone(a.state) };
  woken.attach(b2);
  woken.attach(a2);
  await woken.handle(a2, add("c2", "after"));
  assert.deepEqual(fanned(b2).map((r) => r.id), ["c2"], "still subscribed");
  const fresh = fakeConn("carol/1");
  await woken.handle(fresh, subscribe());
  const page = fresh.inbox.at(-1) as unknown as { rows: Row[] };
  assert.deepEqual(page.rows.map((r) => r.id), ["c1", "c2"], "kept in the project's storage");
});

test("a subscriber that disconnected, or was replaced under its id, gets nothing more; its replacement does", async () => {
  const { seq } = await world(d0());
  const a = fakeConn("alice/1"), gone = fakeConn("bob/1"), old = fakeConn("carol/1");
  for (const c of [gone, old]) await seq.handle(c, subscribe());
  seq.disconnect(gone);
  const replacement = { ...fakeConn("carol/1"), id: old.id, state: structuredClone(old.state) };
  seq.attach(replacement);
  for (const c of [gone, old]) c.inbox.length = 0;
  await seq.handle(a, add("c1", "hello"));
  assert.deepEqual(fanned(gone), []);
  assert.deepEqual(fanned(old), [], "the replaced connection");
  assert.deepEqual(fanned(replacement).map((r) => r.id), ["c1"]);
});

test("the 100,000-comment cap holds through the core (the room's default limits)", async () => {
  const storage = sqliteStorage();
  const { seq } = await world(d0(), { storage });
  const a = fakeConn("alice/1");
  await seq.handle(a, add("c-first", "creates the tables"));
  storage.exec("UPDATE comment_meta SET v = 99999 WHERE k = 'count'");
  await seq.handle(a, add("c-last", "the 100,000th"));
  await seq.handle(a, add("c-over", "one too many"));
  assert.deepEqual(answers(a).map((x) => x.refused ?? x.row?.id), ["c-first", "c-last", "too-many"]);
  // an edit of one already there is no new comment
  await seq.handle(a, comment("c-first", { body: "edited" }));
  assert.equal(answers(a).at(-1)?.row?.body, "edited");
});
