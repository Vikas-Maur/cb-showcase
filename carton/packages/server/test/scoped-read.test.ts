// A Published cut's watch link (PLAN §0.1, §14): its viewer invite is scoped to the Published cut, so the edit behind
// it stays out of reach: a scoped reader's hello for any other cut is refused before a row is sent, and the Published
// cut's welcome says only how far its source has moved (a count). Found by the web demo's review (round 1, R1-1): a
// project-wide viewer invite let the watch page read Main's unpublished edits.
import test from "node:test";
import assert from "node:assert/strict";
import type { sync } from "@carton/core";
import { createHmacAuth } from "../src/index.ts";
import { BRANCH, clip, doc, fakeConn, push, set, world } from "./helpers.ts";

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
  assert.deepEqual(w.source, { branchId: BRANCH, at: 1, head: 2 }, "one newer version since publishing");
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
      assert.deepEqual(viewer.inbox, [{ type: "error", reason: `this token can't read ${cut}` }], `${msg.type} on ${cut}`);
    }
  }
});
