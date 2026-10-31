// What the web demo needs from @carton/server (sync-sequencer's package; requests in the web-demo notes, "Requests to
// sync-sequencer"). Each is a `todo` test: it runs and reports, and fails until the server has it, without failing
// this suite. They were contract(server) commits on this branch (f537dfa, 06b8915), taken out when the branch took
// sync-sequencer's side for packages/server.
//
// REQ-3 (a real Cloudflare bug): a Durable Object's SQLite allows at most 5 terms in a compound SELECT and 100 bound
// variables (measured in local workerd on 2026-10-31: 5 terms run, 6 fail "too many terms in compound SELECT"; 96
// variables run, 120 fail). Tables.records() batches 32 ids as one UNION ALL, so on the Worker every change touching
// two or more clips (an undo of a turn, a ripple) is answered "internal: too many terms in compound SELECT" and stays
// pending for good. node:sqlite is set to the DO's limits here.
//
// REQ-4 (web-demo review R1-1): a Published cut's watch link carries a viewer invite scoped to that cut; a scoped
// reader's hello for any other cut must be refused before a row is sent, and the Published cut's welcome says only how
// far its source has moved (`source {branchId, at, head}`, a count).
import assert from "node:assert/strict";
import test from "node:test";
import type { sync } from "@carton/core";
import { createHmacAuth } from "../../../packages/server/src/index.ts";
import { BRANCH, clip, doc, fakeConn, push, set, sqliteStorage, verdict, world } from "../../../packages/server/test/helpers.ts";

const TODO3 = "sync-sequencer: Tables.records() within 5 compound terms (REQ-3)";
const TODO4 = "sync-sequencer: scoped readers and welcome.source (REQ-4)";

const clips = (n: number) => Array.from({ length: n }, (_, i) => clip(`c${i}`, i * 5, (i + 1) * 5, "V1"));
function doStorage() {
  const s = sqliteStorage();
  s.db.limits.compoundSelect = 5;
  s.db.limits.variableNumber = 100;
  return s;
}

for (const n of [2, 5, 6, 33, 200]) {
  test(`REQ-3: a change touching ${n} clips is judged within a Durable Object's SQLite limits`, { todo: TODO3 }, async () => {
    const storage = doStorage();
    const { seq, d0 } = await world(doc(clips(Math.max(n, 2))), { storage });
    const c = fakeConn("x/k");
    const r = await push(seq, c, d0, Array.from({ length: n }, (_, i) => set(`c${i}`, "name", `renamed ${i}`)));
    assert.equal(verdict(r), "ack");
    // and a trim of every one of them (timing ops: the records lookup with spans)
    const r2 = await push(seq, c, d0, Array.from({ length: n }, (_, i) => set(`c${i}`, "endTime", (i + 1) * 5 - 1)), { base: { seq: 1, pending: [] } });
    assert.equal(verdict(r2), "ack");
  });
}

const PUB = "pub-0000-0000";
const hello = (branchId: string, have = -1): sync.HelloMsg => ({ type: "hello", branchId, have, pending: [], rids: [], schemaVersion: 1 });

test("REQ-4: a reader scoped to the Published cut can read it, not its source; the welcome counts the source's newer versions", { todo: TODO4 }, async () => {
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
  assert.deepEqual((w as sync.WelcomeMsg & { source?: unknown }).source, { branchId: BRANCH, at: 1, head: 2 }, "one newer version since publishing");
  // a scoped viewer gets nothing fanned out from the source either
  viewer.inbox.length = 0;
  await push(seq, editor, d0, [set("c0", "name", "three")], { base: { seq: 2, pending: [] } });
  assert.equal(viewer.inbox.filter((m) => m.type === "changes").length, 0);
  // an unscoped viewer (a teammate who may read the project) still reads every cut
  const teammate = fakeConn("t/k", "viewer");
  await seq.handle(teammate, hello(BRANCH));
  assert.equal(teammate.last("hello")?.head, 3);
});

test("REQ-4: an invite's cut scope is carried into the sessions it makes, and refreshes keep it", { todo: TODO4 }, async () => {
  const auth = createHmacAuth({ secret: "x".repeat(40) });
  // the cut scope is a fourth argument the server's createInvite doesn't take yet
  const scoped = auth.createInvite.bind(auth) as unknown as (p: string, role: string, ttlMs?: number, branches?: string[]) => Promise<string>;
  const invite = await scoped("p1", "viewer", undefined, [PUB]);
  const j = await auth.join(invite, "viewer", "install-key-number-1");
  assert.deepEqual(j.context.branches, [PUB]);
  const r = await auth.refresh(j.token, "install-key-number-1");
  assert.deepEqual(r.context.branches, [PUB]);
  await assert.rejects(scoped("p1", "viewer", undefined, ["bad id/with slash"]), /bad branches/);
  await assert.rejects(scoped("p1", "viewer", undefined, []), /bad branches/);
  const plain = await auth.join(await auth.createInvite("p1", "editor"), "bob", "install-key-number-2");
  assert.equal(plain.context.branches, undefined, "an invite without a scope makes unscoped sessions");
});
