// A Published cut's watch link (PLAN §0.1, §14): its viewer invite is scoped to the Published cut, so the edit behind
// it stays out of reach: a scoped reader's hello for any other cut is refused before a row is sent, and the Published
// cut's welcome says only how far its source has moved (a count). Found by the web demo's review (round 1, R1-1): a
// project-wide viewer invite let the watch page read Main's unpublished edits.
import test from "node:test";
import assert from "node:assert/strict";
import { sync } from "@carton/core";
import { createHmacAuth } from "../src/index.ts";
import { BRANCH, clip, doc, fakeConn, memoryBlobs, push, set, world } from "./helpers.ts";

const PUB = "pub-0000-0000";
const hello = (branchId: string, have = -1): sync.HelloMsg => ({ type: "hello", branchId, have, pending: [], rids: [], schemaVersion: 1 });

test("a reader scoped to the Published cut can read it, not its source; the welcome counts the source's newer versions", async () => {
  const d0 = doc([clip("c0", 0, 5), clip("c1", 5, 10)]);
  const { seq } = await world(d0);
  const editor = fakeConn("e/k");
  await push(seq, editor, d0, [set("c0", "name", "one")]);
  await seq.createBranch({ id: PUB, name: "Main cut (published)", forkOf: `${BRANCH}@1`, owner: "alice", kind: "published", source: BRANCH, sequencer: { kind: "server", since: 0 } }, { doc0: d0 as never, stateHash: "h0" });
  await push(seq, editor, d0, [set("c1", "name", "two")], { base: { seq: 1, pending: [] } });
  const viewer = fakeConn("v/k", "viewer", { branches: [PUB] });
  await seq.handle(viewer, hello(BRANCH));
  assert.equal(viewer.last("error")?.reason, `this token can't read ${BRANCH}`);
  assert.equal(viewer.last("hello"), undefined, "no welcome, no rows");
  await seq.handle(viewer, hello(PUB));
  const w = viewer.last("hello")!;
  assert.deepEqual(w.source, { branchId: BRANCH, at: 1, head: 2, versions: 1 }, "one newer version since publishing");
  // a scoped viewer gets nothing fanned out from the source either
  viewer.inbox.length = 0;
  await push(seq, editor, d0, [set("c0", "name", "three")], { base: { seq: 2, pending: [] } });
  assert.equal(viewer.inbox.filter((m) => m.type === "changes").length, 0);
  // an unscoped viewer (a teammate who may read the project) still reads every cut
  const teammate = fakeConn("t/k", "viewer");
  await seq.handle(teammate, hello(BRANCH));
  assert.equal(teammate.last("hello")?.head, 3);
});

test("an invite's cut scope is carried into the sessions it makes, and refreshes keep it", async () => {
  const auth = createHmacAuth({ secret: "x".repeat(40) });
  const invite = await auth.createInvite("p1", "viewer", undefined, [PUB]);
  const j = await auth.join(invite, "viewer", "install-key-number-1");
  assert.deepEqual(j.context.branches, [PUB]);
  const r = await auth.refresh(j.token, "install-key-number-1");
  assert.deepEqual(r.context.branches, [PUB]);
  await assert.rejects(auth.createInvite("p1", "viewer", undefined, ["bad id/with slash"]), /bad branches/);
  await assert.rejects(auth.createInvite("p1", "viewer", undefined, []), /bad branches/);
  const plain = await auth.join(await auth.createInvite("p1", "editor"), "bob", "install-key-number-2");
  assert.equal(plain.context.branches, undefined, "an invite without a scope makes unscoped sessions");
});

test("a scoped reader's branchStatus for another cut is refused: not its existence, adoption key or head (Stage F round 5)", async () => {
  const d0 = doc([clip("c0", 0, 5)]);
  const { seq } = await world(d0);
  await seq.createBranch({ id: PUB, name: "Main cut (published)", forkOf: `${BRANCH}@0`, owner: "alice", kind: "published", source: BRANCH, sequencer: { kind: "server", since: 0 } }, { doc0: d0 as never, stateHash: "h0" });
  const viewer = fakeConn("v/k", "viewer", { branches: [PUB] });
  await seq.handle(viewer, { type: "branchStatus", branchId: BRANCH });
  assert.equal(viewer.last("status"), undefined);
  assert.equal(viewer.last("error")?.reason, `this token can't read ${BRANCH}`);
  await seq.handle(viewer, { type: "branchStatus", branchId: PUB });
  assert.equal(viewer.last("status")?.adopted, true, "its own cut answers");
  const teammate = fakeConn("t/k", "viewer");
  await seq.handle(teammate, { type: "branchStatus", branchId: BRANCH });
  assert.equal(teammate.last("status")?.adopted, true, "an unscoped reader still asks of any cut");
});

test("a scoped reader's push, withdraw and history for another cut are refused alike, existing or not: no head, no existence (web-demo stage review 1)", async () => {
  const d0 = doc([clip("c0", 0, 5)]);
  const { seq } = await world(d0);
  await seq.createBranch({ id: PUB, name: "Main cut (published)", forkOf: `${BRANCH}@0`, owner: "alice", kind: "published", source: BRANCH, sequencer: { kind: "server", since: 0 } }, { doc0: d0 as never, stateHash: "h0" });
  const viewer = fakeConn("v/k", "viewer", { branches: [PUB] });
  for (const cut of [BRANCH, "no-such-cut"]) {
    for (const msg of [
      { type: "push", branchId: cut, epoch: 1, changes: [] },
      { type: "withdraw", branchId: cut, id: "x.1", base: 0, epoch: 2 },
      { type: "history", branchId: cut, req: 1, after: 0, upTo: 1, lineage: true },
    ] as const) {
      viewer.inbox.length = 0;
      await seq.handle(viewer, msg as never);
      assert.deepEqual(viewer.inbox, [{ type: "error", code: "forbidden", reason: `this token can't read ${cut}` }], `${msg.type} on ${cut}`);
    }
  }
});

test("a cut named by anything but a string is refused before any lookup, directly or in an envelope (stage review round 2)", async () => {
  const blobs = memoryBlobs();
  const d0 = doc([clip("c0", 0, 5)]);
  const { seq } = await world(d0, { blobs, envelopeBytes: 4 * 1024 });
  // a private cut whose id reads as a number: SQLite would match 1.5 to "1.5"
  await seq.createBranch({ id: "1.5", name: "private", forkOf: `${BRANCH}@0`, owner: "alice", kind: "variant", sequencer: { kind: "server", since: 0 } } as never, { doc0: d0 as never, stateHash: "h0" });
  const viewer = fakeConn("v/k", "viewer", { branches: [PUB] });
  const refused = { type: "error", code: "bad-request", reason: "a message must name its cut by a string id" };
  for (const msg of [
    { type: "hello", branchId: 1.5, have: -1, pending: [], rids: [], schemaVersion: 1 },
    { type: "branchStatus", branchId: 1.5 },
    { type: "history", branchId: 1.5, req: 1, after: 0, upTo: 1, lineage: true },
    { type: "hello", branchId: ["1.5"], have: -1, pending: [], rids: [], schemaVersion: 1 },
  ]) {
    viewer.inbox.length = 0;
    await seq.handle(viewer, msg as never);
    assert.deepEqual(viewer.inbox, [refused], JSON.stringify(msg));
  }
  // the same hello inside an envelope
  const big = sync.oversized({ type: "hello", branchId: 1.5, have: -1, pending: [], rids: ["x".repeat(5000)], schemaVersion: 1 } as never, 4 * 1024)!;
  viewer.inbox.length = 0;
  await seq.handle(viewer, await sync.seal(big, blobs, (sha) => sync.clientEnvelopeKey(sha, Date.now())));
  assert.deepEqual(viewer.inbox, [refused], "enveloped");
  // a writer's fork must name its parent by a string too
  const editor = fakeConn("e/k");
  editor.inbox.length = 0;
  await seq.handle(editor, { type: "fork", branchId: "f1", from: 1.5, seq: 0, rec: { id: "f1", name: "f", forkOf: null, owner: "e", kind: "variant", sequencer: { kind: "server", since: 0 } } } as never);
  assert.deepEqual(editor.inbox, [refused]);
});

test("a Published cut of an unedited variant counts the variant's edits since its root (SF1-9)", async () => {
  const d0 = doc([clip("c0", 0, 5)]);
  const { seq } = await world(d0);
  const editor = fakeConn("e/k");
  for (let i = 0; i < 3; i++) await push(seq, editor, d0, [set("c0", "name", `n${i}`)], { base: { seq: i, pending: [] } });
  const rec = (id: string, o: object) => ({ id, name: id, owner: "alice", kind: "variant", sequencer: { kind: "server", since: 0 }, ...o });
  // the variant has no edits when it is published, so its version is its parent's node (BRANCH@3)
  await seq.createBranch(rec("variant", { forkOf: `${BRANCH}@3` }) as never, { doc0: d0 as never, stateHash: "h0" });
  await seq.createBranch(rec(PUB, { forkOf: `${BRANCH}@3`, source: "variant", kind: "published" }) as never, { doc0: d0 as never, stateHash: "h0" });
  await push(seq, editor, d0, [set("c0", "name", "a variant edit")], { branch: "variant", base: { seq: 0, pending: [] } });
  const viewer = fakeConn("v/k", "viewer", { branches: [PUB] });
  await seq.handle(viewer, hello(PUB));
  assert.deepEqual(viewer.last("hello")?.source, { branchId: "variant", at: 0, head: 1, versions: 1 }, "one variant edit since the publication");
});

test("an unedited variant's publication stays at the variant's version 0 after a later shallow share moves its root (stage review round 3)", async () => {
  const d0 = doc([clip("c0", 0, 5)]);
  const { seq } = await world(d0);
  const rec = (id: string, o: object) => ({ id, name: id, owner: "alice", kind: "variant", sequencer: { kind: "server", since: 0 } as const, ...o });
  await seq.createBranch(rec(PUB, { forkOf: `${BRANCH}@0`, source: "variant", kind: "published" }) as never, { doc0: d0 as never, stateHash: "h0" });
  // the variant reaches the server later, shallow: its root is its head then (2), after two edits made since publishing
  await seq.createBranch(rec("variant", { forkOf: `${BRANCH}@0` }) as never, { doc0: d0 as never, stateHash: "h2", rootSeq: 2 });
  const viewer = fakeConn("v/k", "viewer", { branches: [PUB] });
  await seq.handle(viewer, hello(PUB));
  assert.deepEqual(viewer.last("hello")?.source, { branchId: "variant", at: 0, head: 2, versions: 2 }, "both edits since the publication count");
});

test("hello refusals carry a code a client can act on: schema-too-new, unauthorized, forbidden (REQ-9)", async () => {
  const d0 = doc([clip("c0", 0, 5)]);
  let now = Date.now();
  const { seq } = await world(d0, { schemaVersion: 2, clock: () => now, projectId: "p" });
  const codeOf = async (conn: ReturnType<typeof fakeConn>, msg: object) => {
    conn.inbox.length = 0;
    await seq.handle(conn, msg as never);
    return (conn.inbox.find((m) => m.type === "error") as sync.ErrorMsg | undefined)?.code;
  };
  const editor = fakeConn("e/k");
  editor.auth.projectId = "p";
  assert.equal(await codeOf(editor, { ...hello(BRANCH), schemaVersion: 3 }), "schema-too-new");
  assert.equal(await codeOf(editor, hello(BRANCH)), undefined, "a client at the server's version is welcome");
  const other = fakeConn("o/k");
  other.auth.projectId = "q";
  assert.equal(await codeOf(other, hello(BRANCH)), "unauthorized", "another project's token");
  const late = fakeConn("l/k");
  late.auth.projectId = "p";
  late.auth.expires = now - 1;
  assert.equal(await codeOf(late, hello(BRANCH)), "unauthorized", "an expired token");
  const watcher = fakeConn("w/k", "viewer", { branches: [PUB] });
  watcher.auth.projectId = "p";
  assert.equal(await codeOf(watcher, hello(BRANCH)), "forbidden", "outside the token's cuts");
  now += 1;
});

test("a Published cut's welcome leaves withdraw rows (H1) out of the source's newer versions, and counts each row once", async () => {
  const d0 = doc([clip("c0", 0, 5), clip("c1", 5, 10)]);
  const { seq } = await world(d0);
  const editor = fakeConn("e/k");
  await push(seq, editor, d0, [set("c0", "name", "one")]);
  await seq.createBranch({ id: PUB, name: "Main cut (published)", forkOf: `${BRANCH}@1`, owner: "alice", kind: "published", source: BRANCH, sequencer: { kind: "server", since: 0 } }, { doc0: d0 as never, stateHash: "h0" });
  const viewer = fakeConn("v/k", "viewer", { branches: [PUB] });
  const withdraw = async (id: string) => {
    await seq.handle(editor, { type: "withdraw", branchId: BRANCH, id, base: seq.tables.head(BRANCH), epoch: 900 + seq.tables.head(BRANCH) });
    assert.equal(editor.last("ack")?.withdrawn, true);
  };
  // only a withdraw since publishing: nothing newer
  await withdraw("wd.1");
  await seq.handle(viewer, hello(PUB));
  assert.deepEqual(viewer.last("hello")?.source, { branchId: BRANCH, at: 1, head: 2, versions: 0 }, "a withdraw row is no newer version");
  // an edit, another withdraw, an edit: two versions among four rows
  await push(seq, editor, d0, [set("c1", "name", "two")], { base: { seq: 2, pending: [] } });
  await withdraw("wd.2");
  await push(seq, editor, d0, [set("c0", "name", "three")], { base: { seq: 4, pending: [] } });
  await seq.handle(viewer, hello(PUB));
  assert.deepEqual(viewer.last("hello")?.source, { branchId: BRANCH, at: 1, head: 5, versions: 2 });
  // a watcher asks every few seconds: nothing new to read once counted
  const read = seq.tables.meter.rowsRead;
  assert.equal(seq.tables.versionsAfter(BRANCH, 1), 2);
  assert.equal(seq.tables.meter.rowsRead, read, "counted rows aren't read again");
});

test("a Published cut's welcome counts a fold-some (its fold and partial revert) as one newer version, as core's log() does", async () => {
  // laptop re-check P3 (fold counts): the fold `X` and its partial revert `X.inverse` right after it are one version
  const d0 = doc([clip("c0", 0, 5), clip("c1", 5, 10), clip("c2", 10, 15)]);
  const { seq } = await world(d0);
  const editor = fakeConn("e/k");
  await push(seq, editor, d0, [set("c0", "name", "one")]);
  await seq.createBranch({ id: PUB, name: "Main cut (published)", forkOf: `${BRANCH}@1`, owner: "alice", kind: "published", source: BRANCH, sequencer: { kind: "server", since: 0 } }, { doc0: d0 as never, stateHash: "h0" });
  const viewer = fakeConn("v/k", "viewer", { branches: [PUB] });
  // a fold-some: its fold (two records), then the partial revert of one of them, sent as `<id>.inverse`
  await push(seq, editor, d0, [set("c1", "name", "fold-1"), set("c2", "name", "fold-2")], { base: { seq: 1, pending: [] }, id: "rid.7" });
  await seq.handle(viewer, hello(PUB));
  assert.equal(viewer.last("hello")?.source?.versions, 1, "the fold alone so far: one version ");
  await push(seq, editor, d0, [set("c2", "name", "c2")], { base: { seq: 2, pending: [] }, id: "rid.7.inverse" });
  await seq.handle(viewer, hello(PUB));
  assert.deepEqual(viewer.last("hello")?.source, { branchId: BRANCH, at: 1, head: 3, versions: 1 }, "fold and partial revert: one newer version");
  // an edit after it, and an `.inverse` that doesn't follow its fold (another row between): each a version
  await push(seq, editor, d0, [set("c0", "name", "two")], { base: { seq: 3, pending: [] }, id: "rid.8" });
  await push(seq, editor, d0, [set("c1", "name", "three")], { base: { seq: 4, pending: [] }, id: "rid.9" });
  await push(seq, editor, d0, [set("c1", "name", "four")], { base: { seq: 5, pending: [] }, id: "rid.8.inverse" });
  assert.equal(seq.tables.head(BRANCH), 6);
  assert.equal(seq.tables.versionsAfter(BRANCH, 1), 4, "the fold-some, rid.8, rid.9 and rid.8.inverse");
  // published at the fold half itself: its partial revert is a newer version (as publications() counts it)
  assert.equal(seq.tables.versionsAfter(BRANCH, 2), 4);
});
