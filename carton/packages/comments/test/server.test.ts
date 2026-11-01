// The server half (server.ts) over node:sqlite: roles, the watch link's scope, authorship, rate limits, paging, the
// stream's order, a reset, the per-project cap, idempotent retries, and the rows a change costs.
import test from "node:test";
import assert from "node:assert/strict";
import { nodeSqliteStorage } from "@carton/server-node";
import { createCommentRoom, mayComment, mayReadComments, type CommentPeer } from "../src/server.ts";
import type { Comment, CommentAnswerMsg, CommentPatch, CommentServerMessage, CommentsRowsMsg } from "../src/types.ts";
import { auth } from "./helpers.ts";

type Role = Parameters<typeof auth>[0];
function peer(role: Role, account: string, branches?: string[]) {
  const got: CommentServerMessage[] = [];
  const p: CommentPeer & { got: CommentServerMessage[]; last(): CommentServerMessage | undefined; answers(): CommentAnswerMsg[]; rows(): Comment[] } = {
    auth: auth(role, account, branches),
    send: (m) => void got.push(JSON.parse(JSON.stringify(m))),
    got,
    last: () => got[got.length - 1],
    answers: () => got.filter((m): m is CommentAnswerMsg => m.type === "commentAnswer"),
    rows: () => got.filter((m): m is CommentsRowsMsg => m.type === "comments").flatMap((m) => m.rows),
  };
  return p;
}
let n = 0;
const patch = (body: string, cut = "main", extra: Partial<CommentPatch> = {}): CommentPatch => ({ add: { body, cut, at: 1000 }, at: 1000, author: { id: "whoever", name: "Claimed Name" }, ...extra });
function world(opts: Parameters<typeof createCommentRoom>[0]["limits"] = {}, clock?: () => number) {
  const storage = nodeSqliteStorage(":memory:");
  const room = createCommentRoom({ storage, limits: opts, ...(clock ? { clock } : {}) });
  const peers: ReturnType<typeof peer>[] = [];
  const join = (role: Role, account: string, branches?: string[]) => {
    const p = peer(role, account, branches);
    room.onComments(p, { type: "comments", branchId: branches?.[0] ?? "main", since: 0 });
    peers.push(p);
    return p;
  };
  const send = (p: ReturnType<typeof peer>, id: string, pt: CommentPatch, op?: string) => {
    room.onComment(p, { type: "comment", branchId: "main", n: ++n, id, patch: pt, ...(op ? { op } : {}) }, peers);
    return p.answers().at(-1)!;
  };
  return { storage, room, join, send, peers };
}

test("owners, editors and commenters comment; viewers read only; the author is the session's account", () => {
  const w = world();
  const owner = w.join("owner", "olga"),
    editor = w.join("editor", "ed"),
    commenter = w.join("commenter", "cora"),
    viewer = w.join("viewer", "vic");
  for (const [p, id] of [[owner, "c1"], [editor, "c2"], [commenter, "c3"]] as const) {
    const a = w.send(p, id, patch(`from ${p.auth.account}`));
    assert.ok(a.row, `${p.auth.role} may comment`);
    assert.deepEqual(a.row!.author, { id: p.auth.account, name: "Claimed Name" }, "the id is the account, never the claim");
  }
  const v = w.send(viewer, "c4", patch("let me in"));
  assert.deepEqual([v.refused, v.reason], ["forbidden", "viewers can read comments but not write them"]);
  assert.deepEqual(viewer.rows().map((r) => r.id), ["c1", "c2", "c3"], "a viewer reads every comment (fan-out)");
  assert.deepEqual(commenter.rows().map((r) => r.id), ["c1", "c2"], "the writer gets its own row in the answer, not the fan-out");
});

test("a watch link reads only comments on its Published cut; a scoped commenter writes only there and learns nothing else", () => {
  const w = world();
  const ed = w.join("editor", "ed");
  const watch = w.join("viewer", "guest", ["pub"]);
  const review = w.join("commenter", "client", ["pub"]);
  w.send(ed, "onMain", patch("internal note", "main"));
  w.send(ed, "onPub", patch("for the client", "pub"));
  assert.deepEqual(watch.rows().map((r) => r.id), ["onPub"]);
  assert.deepEqual(review.rows().map((r) => r.id), ["onPub"]);
  const late = peer("viewer", "late", ["pub"]);
  w.room.onComments(late, { type: "comments", branchId: "pub", since: 0 });
  assert.deepEqual(late.rows().map((r) => r.id), ["onPub"], "catch-up is filtered the same way");
  assert.ok(w.send(review, "r1", patch("Looks great", "pub", { add: { body: "Looks great", cut: "x", at: 1, replyTo: "onPub" } })).row);
  assert.equal(w.send(review, "r2", patch("sneaky", "main")).refused, "forbidden");
  // another cut's comment answers as if absent, whatever is tried on it
  for (const pt of [{ resolved: true }, { body: "x" }, { deleted: true as const }]) assert.equal(w.send(review, "onMain", { ...pt, at: 1, author: { id: "x", name: "x" } }).refused, "not-found");
  assert.equal(w.send(review, "r3", patch("reply", "pub", { add: { body: "reply", cut: "pub", at: 1, replyTo: "onMain" } })).refused, "not-found");
  assert.ok(mayReadComments(auth("editor", "e", ["pub"]), "main"), "a scoped writer (a remote agent) still reads everything");
  assert.ok(!mayComment(auth("editor", "e", ["pub"]), "main"));
});

test("only the author edits or deletes; anyone who may comment resolves", () => {
  const w = world();
  const alice = w.join("editor", "alice"),
    bob = w.join("commenter", "bob");
  w.send(alice, "c1", patch("Too long"));
  assert.equal(w.send(bob, "c1", { body: "Fine", at: 2, author: { id: "alice", name: "Alice" } }).refused, "forbidden", "claiming the author's id changes nothing");
  assert.equal(w.send(bob, "c1", { deleted: true, at: 2, author: { id: "bob", name: "Bob" } }).refused, "forbidden");
  assert.deepEqual(w.send(bob, "c1", { resolved: true, at: 3, author: { id: "bob", name: "Bob" } }).row?.resolved, { by: { id: "bob", name: "Bob" }, at: 3 });
  assert.equal(w.send(alice, "c1", { body: "Too long here", at: 4, author: { id: "alice", name: "Alice" } }).row?.body, "Too long here");
  assert.ok(w.send(alice, "c1", { deleted: true, at: 5, author: { id: "alice", name: "Alice" } }).row?.deleted);
});

test("a retried patch is stored once: the same answer, no new row in the stream", () => {
  const w = world();
  const a = w.join("editor", "alice");
  const first = w.send(a, "c1", patch("Hello"));
  const again = w.send(a, "c1", patch("Hello"));
  assert.equal(again.row?.seq, first.row?.seq);
  assert.equal(w.room.head(), 1);
  const resolved = w.send(a, "c1", { resolved: true, at: 2, author: { id: "alice", name: "A" } });
  const resolvedAgain = w.send(a, "c1", { resolved: true, at: 3, author: { id: "alice", name: "A" } });
  assert.equal(resolvedAgain.row?.seq, resolved.row?.seq);
});

test("an op is applied once: retried after its answer was lost and a later change, it undoes nothing", () => {
  const w = world();
  const laptop = w.join("editor", "alice");
  const phone = w.join("editor", "alice");
  const bob = w.join("editor", "bob");
  const me = { id: "alice", name: "A" };
  // the add goes in; its answer is lost; the phone edits the comment
  const first = w.send(laptop, "c1", patch("Hello"), "o-add");
  w.send(phone, "c1", { body: "Hello (edited on the phone)", at: 5, author: me }, "o-edit");
  const retry = w.send(laptop, "c1", patch("Hello"), "o-add");
  assert.equal(retry.row?.body, "Hello (edited on the phone)", "the retry answers the row as it is now");
  assert.equal(w.room.head(), first.row!.seq! + 1, "and writes nothing");
  // a resolve goes in, bob reopens, the resolve is retried: still open
  w.send(laptop, "c1", { resolved: true, at: 6, author: me }, "o-res");
  w.send(bob, "c1", { resolved: false, at: 7, author: { id: "bob", name: "B" } }, "o-bob");
  assert.equal(w.send(laptop, "c1", { resolved: true, at: 6, author: me }, "o-res").row?.resolved, undefined);
  // an op that changed nothing is remembered too: retried after a change, it still changes nothing
  w.send(laptop, "c1", { resolved: false, at: 8, author: me }, "o-noop");
  w.send(bob, "c1", { resolved: true, at: 9, author: { id: "bob", name: "B" } }, "o-bob2");
  assert.ok(w.send(laptop, "c1", { resolved: false, at: 8, author: me }, "o-noop").row?.resolved, "still resolved");
  // ops are per account: bob's op ids don't hide alice's
  assert.equal(w.send(laptop, "c1", { body: "Hi", at: 10, author: me }, "o-bob").row?.body, "Hi");
  // a bad op id is refused
  assert.equal(w.send(laptop, "c1", { body: "x", at: 11, author: me }, "bad op").refused, "bad-request");
});

test("catch-up pages are limited per connection: past the read bucket, no rows and when to ask again", () => {
  let now = 0;
  const w = world({ readBurst: 2, readPerSec: 4 }, () => now);
  const ed = w.join("editor", "ed"); // one page taken
  w.send(ed, "c1", patch("x"));
  const ask = () => {
    w.room.onComments(ed, { type: "comments", branchId: "main", since: 0 });
    return ed.got.at(-1) as CommentsRowsMsg;
  };
  assert.equal(ask().rows.length, 1);
  const limited = ask();
  assert.deepEqual([limited.rows.length, limited.head, limited.more, limited.retryMs], [0, 0, true, 250]);
  now += 250;
  assert.equal(ask().rows.length, 1);
});

test("a watch link never receives an account id: authors are display names or a label stable within the project", () => {
  const storage = nodeSqliteStorage(":memory:");
  // the people record knows alice's name; bob has none (his patches claim one, which a watch link never sees)
  const people: Record<string, string> = { "acct-alice-7f3": "Alice Chen" };
  const room = createCommentRoom({ storage, nameOf: (a) => people[a.account] });
  const peers: ReturnType<typeof peer>[] = [];
  const join = (role: Role, account: string, branches?: string[], cut = "pub") => {
    const p = peer(role, account, branches);
    room.onComments(p, { type: "comments", branchId: cut, since: 0 });
    peers.push(p);
    return p;
  };
  const send = (p: ReturnType<typeof peer>, id: string, pt: CommentPatch) => {
    room.onComment(p, { type: "comment", branchId: "pub", n: ++n, id, patch: pt, op: `o${n}` }, peers);
    return p.answers().at(-1)!;
  };
  const alice = join("editor", "acct-alice-7f3");
  const bob = join("editor", "acct-bob-91c");
  const claim = (name: string) => ({ id: "x", name });
  send(alice, "c1", { add: { body: "Music in too early", cut: "pub", at: 1 }, at: 1, author: claim("A") });
  send(bob, "r1", { add: { replyTo: "c1", body: "Moved it", cut: "pub", at: 2 }, at: 2, author: claim("Bob from Accounts") });
  send(bob, "c1", { resolved: true, at: 3, author: claim("Bob from Accounts") });
  // a watch link: catch-up, then live rows; a review link (a scoped commenter) writes and gets its answers
  const watch = join("viewer", "acct-watch-001", ["pub"]);
  const review = join("commenter", "acct-rev-55", ["pub"]);
  send(alice, "c2", { add: { body: "And here", cut: "pub", at: 4 }, at: 4, author: claim("A") });
  const mine = send(review, "c3", { add: { body: "From the review link", cut: "pub", at: 5 }, at: 5, author: claim("R") });
  const reopened = send(review, "c1", { resolved: false, at: 6, author: claim("R") });
  const leaked = (p: ReturnType<typeof peer>, accounts: string[]) => accounts.filter((a) => JSON.stringify(p.got).includes(a));
  assert.deepEqual(leaked(watch, ["acct-alice-7f3", "acct-bob-91c", "acct-rev-55", "Bob from Accounts"]), [], "nothing of anyone's account reaches the watch link");
  assert.deepEqual(leaked(review, ["acct-alice-7f3", "acct-bob-91c"]), [], "nor the review link (it is scoped too)");
  const seen = (p: ReturnType<typeof peer>) => new Map(p.rows().map((r) => [r.id, r]));
  const w = seen(watch);
  assert.deepEqual(w.get("c1")?.author, { id: "teammate:1", name: "Alice Chen" }, "the people record's name");
  assert.deepEqual(w.get("r1")?.author, { id: "teammate:2", name: "Teammate 2" }, "no name there: a label");
  assert.deepEqual(w.get("c2")?.author, w.get("c1")?.author, "the same label for the same person");
  assert.deepEqual(w.get("c3")?.author, { id: "teammate:3", name: "Teammate 3" }, "a claimed name is never shown to a link");
  assert.equal(mine.row?.author.id, "acct-rev-55", "a session's own comments keep its own id (it edits them)");
  assert.equal(reopened.row?.resolved, undefined, "a link reopens a thread");
  // a second watch link, later: the same labels
  const watch2 = join("viewer", "acct-watch-002", ["pub"]);
  assert.deepEqual(seen(watch2).get("r1")?.author, { id: "teammate:2", name: "Teammate 2" });
  // the team sees full authors
  const team = seen(alice);
  assert.deepEqual(team.get("c3")?.author.id, "acct-rev-55");
  assert.deepEqual(seen(join("editor", "acct-carol-3", undefined, "main")).get("r1")?.author, { id: "acct-bob-91c", name: "Bob from Accounts" });
  // and after a wake (a new room over the same storage) the labels are the same
  const again = createCommentRoom({ storage, nameOf: (a) => people[a.account] });
  const w3 = peer("viewer", "acct-watch-003", ["pub"]);
  again.onComments(w3, { type: "comments", branchId: "pub", since: 0 });
  assert.deepEqual(seen(w3).get("r1")?.author, { id: "teammate:2", name: "Teammate 2" });
  assert.equal(seen(w3).get("c1")?.resolved, undefined);
});

test("the stream: a changed comment moves to the end; catching up from any place reads each changed comment once", () => {
  const w = world();
  const a = w.join("editor", "alice");
  for (const id of ["c1", "c2", "c3"]) w.send(a, id, patch(id));
  w.send(a, "c1", { body: "c1 edited", at: 5, author: { id: "alice", name: "A" } });
  const reader = peer("viewer", "v");
  w.room.onComments(reader, { type: "comments", branchId: "main", since: 0 });
  const page = reader.last() as CommentsRowsMsg;
  assert.deepEqual(page.rows.map((r) => [r.id, r.seq]), [["c2", 2], ["c3", 3], ["c1", 4]]);
  assert.deepEqual([page.head, page.more, page.reply], [4, undefined, true]);
  w.room.onComments(reader, { type: "comments", branchId: "main", since: 2 });
  assert.deepEqual((reader.last() as CommentsRowsMsg).rows.map((r) => r.id), ["c3", "c1"]);
});

test("pages: a long stream comes in pages with the position to ask from; filtered pages still advance", () => {
  const w = world({ page: 3 });
  const ed = w.join("editor", "ed");
  for (let i = 1; i <= 8; i++) w.send(ed, `c${i}`, patch(`c${i}`, i % 2 ? "main" : "pub"));
  const watch = peer("viewer", "guest", ["pub"]);
  let since = 0;
  const seen: string[] = [];
  for (let guard = 0; guard < 10; guard++) {
    w.room.onComments(watch, { type: "comments", branchId: "pub", since });
    const m = watch.last() as CommentsRowsMsg;
    seen.push(...m.rows.map((r) => r.id));
    since = m.head;
    if (!m.more) break;
  }
  assert.deepEqual(seen, ["c2", "c4", "c6", "c8"]);
  assert.equal(since, 8);
});

test("pages stop at their byte budget, always holding one row", () => {
  const w = world({ pageBytes: 1500 });
  const ed = w.join("editor", "ed");
  for (let i = 1; i <= 5; i++) w.send(ed, `c${i}`, patch("x".repeat(1000)));
  const r = peer("viewer", "v");
  const pages: number[] = [];
  let since = 0;
  for (let guard = 0; guard < 10; guard++) {
    w.room.onComments(r, { type: "comments", branchId: "main", since });
    const m = r.last() as CommentsRowsMsg;
    pages.push(m.rows.length);
    since = m.head;
    if (!m.more) break;
  }
  assert.deepEqual(pages, [1, 1, 1, 1, 1]);
  assert.equal(since, 5);
});

test("a position past the stream's end (the server's storage was reset) is answered from the start, marked reset", () => {
  const w = world();
  const ed = w.join("editor", "ed");
  w.send(ed, "c1", patch("one"));
  const p = peer("viewer", "v");
  w.room.onComments(p, { type: "comments", branchId: "main", since: 40 });
  const m = p.last() as CommentsRowsMsg;
  assert.deepEqual([m.reset, m.head, m.rows.map((r) => r.id)], [true, 1, ["c1"]]);
});

test("rate limit per connection, like presence's: a burst, then refused with when to retry, then refilled", () => {
  let now = 0;
  const w = world({ burst: 3, perSec: 2 }, () => now);
  const ed = w.join("editor", "ed");
  for (let i = 0; i < 3; i++) assert.ok(w.send(ed, `c${i}`, patch("x")).row);
  const limited = w.send(ed, "c9", patch("x"));
  assert.deepEqual([limited.refused, limited.retryMs], ["rate-limited", 500]);
  now += 500;
  assert.ok(w.send(ed, "c9", patch("x")).row);
  const other = w.join("editor", "other");
  assert.ok(w.send(other, "o1", patch("y")).row, "another connection has its own bucket");
});

test("at most perProject comments; edits of existing ones still go through", () => {
  const w = world({ perProject: 2 });
  const ed = w.join("editor", "ed");
  w.send(ed, "c1", patch("1"));
  w.send(ed, "c2", patch("2"));
  assert.equal(w.send(ed, "c3", patch("3")).refused, "too-many");
  assert.ok(w.send(ed, "c1", { body: "1!", at: 2, author: { id: "ed", name: "E" } }).row);
});

test("malformed messages are refused, never stored", () => {
  const w = world();
  const ed = w.join("editor", "ed");
  assert.equal(w.send(ed, "bad id", patch("x")).refused, "bad-request");
  assert.equal(w.send(ed, "c1", { ...patch("x"), extra: 1 } as unknown as CommentPatch).refused, "bad-request");
  assert.equal(w.send(ed, "c1", patch("x".repeat(70_000))).refused, "bad-request");
  assert.equal(w.send(ed, "c1", { body: "x", at: 1, author: { id: "ed", name: "E" } }).refused, "not-found");
  assert.equal(w.room.head(), 0);
});

test("a change costs 4 rows written (the comment, its place in the stream, the old place removed, its op)", () => {
  const w = world();
  const ed = w.join("editor", "ed");
  w.send(ed, "c1", patch("x"), "o1");
  const before = w.storage.stats().rowsWritten;
  w.send(ed, "c1", { body: "y", at: 2, author: { id: "ed", name: "E" } }, "o2");
  assert.equal(w.storage.stats().rowsWritten - before, 4);
});
