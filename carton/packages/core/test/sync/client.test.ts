// SyncClient and ReplicaQueue against a scripted connection: each server message is fed by hand, so the order of the
// client's steps is pinned exactly (the system suite runs the same code against the real sequencer).
import test from "node:test";
import assert from "node:assert/strict";
import { defineSchema } from "../../src/schema.ts";
import { timeAlgebra, hashDoc } from "../../src/engine/index.ts";
import { ReplicaQueue, SyncClient, type ClientMessage, type ServerMessage } from "../../src/sync/index.ts";
import type { TransportConnection } from "../../src/plugins.ts";
import type { ConfirmedChange, Doc, Op } from "../../src/types.ts";

const TL = { collection: "timelineItems", lanes: "tracks", lane: "trackId", start: "startTime", end: "endTime", source: "trimStart", sourceEnd: "trimEnd", speed: "playbackSpeed" };
const schema = defineSchema({
  collections: {
    tracks: { key: "id", seq: true },
    timelineItems: { key: "id", parent: { field: "trackId", collection: "tracks" }, groups: [{ name: "time", fields: ["startTime", "endTime", "trimStart", "trimEnd", "playbackSpeed"], algebra: timeAlgebra(TL) }] },
  },
  timeline: TL,
});
const clip = (id: string, s: number, e: number) => ({ id, trackId: "V1", startTime: s, endTime: e, trimStart: 0, trimEnd: e - s, opacity: 1 });
const d0: Doc = { tracks: [{ id: "V1", "#pos": "a" }], timelineItems: [clip("c0", 0, 5), clip("c1", 5, 10), clip("c2", 10, 15)] };
const set = (id: string, f: string, v: unknown): Op => ({ op: "set", path: ["timelineItems", id, f], value: v });
const B = "b1";
const me = { kind: "human" as const, id: "me" };

/** A connection the test drives: it records what the client sends and delivers what the test feeds. */
class Scripted implements TransportConnection {
  open = true;
  sent: ClientMessage[] = [];
  private onMsg: ((m: ServerMessage) => void)[] = [];
  private onCls: ((why: string) => void)[] = [];
  send(m: ClientMessage) {
    if (this.open) this.sent.push(structuredClone(m));
  }
  onMessage(l: (m: ServerMessage) => void) {
    this.onMsg.push(l);
  }
  onClose(l: (why: string) => void) {
    this.onCls.push(l);
  }
  close() {
    this.open = false;
  }
  feed(m: ServerMessage) {
    for (const l of this.onMsg) l(structuredClone(m));
  }
  drop() {
    this.open = false;
    for (const l of this.onCls) l("dropped");
  }
  last<T extends ClientMessage["type"]>(type: T) {
    return this.sent.filter((m) => m.type === type).at(-1) as Extract<ClientMessage, { type: T }> | undefined;
  }
}

const tick = () => new Promise((r) => setTimeout(r, 0));
/** Let the client's deferred steps (resubmission after a reject, the push after a commit) run. */
const flush = () => new Promise((r) => setTimeout(r, 0));
async function setup(opts: { fence?: () => boolean } = {}) {
  const q = new ReplicaQueue(schema);
  q.addBranch({ id: B, name: "main", kind: "main", sequencer: { kind: "server", since: 0 } }, d0);
  const conns: Scripted[] = [];
  const client = new SyncClient({ queue: q, branchId: B, schemaVersion: 1, connect: async () => { const c = new Scripted(); conns.push(c); return c; }, defer: (fn) => queueMicrotask(fn), backoffMs: 1, ...opts }).start();
  await tick();
  const c = conns[0]!;
  c.feed({ type: "hello", branchId: B, head: 0, rows: [], confirmed: [] });
  return { q, client, c, conns };
}
function rowOf(q: ReplicaQueue, id: string, seq: number, ops: Op[], over: Partial<ConfirmedChange> = {}): ConfirmedChange {
  return { id, hash: "h", author: me, branchId: B, base: { seq: seq - 1, pending: [] }, ops, intent: null, kinds: null, policy: "merge", at: 0, paths: [], reads: [], spans: [], trackOrder: [], rebase: 0, seq, ...over };
}

test("hello claims every pending id it sent with every base it was sent on (R10-01, bounded scan)", async () => {
  const { q, client, c, conns } = await setup();
  q.commit(B, { id: "r1.1", author: me, ops: [set("c0", "name", "a")], at: 0 });
  q.commit(B, { id: "r1.2", author: me, ops: [set("c1", "name", "b")], at: 0 });
  client.pump();
  assert.deepEqual(c.last("push")!.changes.map((x) => [x.id, x.base.seq, x.base.pending]), [["r1.1", 0, []], ["r1.2", 0, ["r1.1"]]]);
  // someone else's row arrives: the queue is rebased onto seq 1; a reject makes the client resend on the new base
  c.feed({ type: "changes", branchId: B, rows: [rowOf(q, "o.1", 1, [set("c2", "name", "o")])] });
  c.feed({ type: "reject", branchId: B, id: "r1.1", reason: "overlap", head: 1, concurrent: [{ seq: 1, id: "o.1" }], epoch: client.epoch });
  await flush();
  assert.equal(c.last("push")!.changes[0]!.base.seq, 1);
  c.drop();
  await new Promise((r) => setTimeout(r, 10));
  const hello = conns[1]!.last("hello")!;
  assert.deepEqual(hello.pending, [{ id: "r1.1", bases: [0, 1] }, { id: "r1.2", bases: [0, 1] }]);
  assert.deepEqual(hello.rids, ["r1"]);
  client.stop();
});

test("unpinned v12 rule, now pinned: on a keyframe catch-up, ids the server lists as confirmed leave the queue before the rebase, so a confirmed change is never rebased", async () => {
  const { q, client, c } = await setup();
  q.commit(B, { id: "r1.1", author: me, ops: [set("c0", "opacity", 0.3)], policy: "lww", at: 0 });
  q.commit(B, { id: "r1.2", author: me, ops: [set("c1", "name", "late")], at: 0 });
  client.pump(); // both sent; r1.1 is confirmed at seq 1 but its ack is lost
  const rebased: string[] = [];
  const versionsAtRebase = new Map<string, number>();
  const orig = q.rebaseAll.bind(q);
  q.rebaseAll = (b) => {
    for (const p of q.pending(b)) versionsAtRebase.set(p.id, p.versions.length);
    rebased.push(...q.pending(b).map((p) => p.id));
    return orig(b);
  };
  const kfDoc = structuredClone(d0) as { timelineItems: { opacity: number }[] };
  kfDoc.timelineItems[0]!.opacity = 0.9; // later rows (someone else's) are in the keyframe
  c.drop();
  await new Promise((r) => setTimeout(r, 10));
  const c2 = (client as unknown as { conn: Scripted }).conn;
  c2.feed({ type: "hello", branchId: B, head: 130, keyframe: { seq: 128, stateHash: hashDoc(kfDoc as Doc, schema), doc: kfDoc as Doc }, rows: [], confirmed: [{ id: "r1.1", seq: 1, rebase: 0 }] });
  await flush();
  assert.deepEqual(rebased, ["r1.2"], "only the change not yet confirmed was rebased");
  assert.equal(q.pending(B).length, 1);
  assert.equal(q.versions.get("r1.1")!.length, 1, "the confirmed change has no rebased version");
  client.stop();
});

test("an absorbed change that was sent is withdrawn and leaves the queue only on the withdrawn ack (H1); one never sent is absorbed at once", async () => {
  const { q, client, c } = await setup();
  const events: string[] = [];
  q.on((e) => events.push(`${e.type}${e.type === "absorbed" ? `:${e.change.id}:${e.withdrawn}` : ""}`));
  q.commit(B, { id: "r1.1", author: me, ops: [set("c0", "opacity", 0.3)], policy: "lww", at: 0 });
  client.pump();
  // Bob's merge-policy edit of the same leaf arrives first: the rebase cards it (head's value kept) and leaves nothing
  c.feed({ type: "changes", branchId: B, rows: [rowOf(q, "bob.1", 1, [set("c0", "opacity", 0.9)], { paths: ["timelineItems/c0/opacity"], reads: ["timelineItems/c0"] })] });
  c.feed({ type: "reject", branchId: B, id: "r1.1", reason: "overlap", head: 1, concurrent: [{ seq: 1, id: "bob.1" }], epoch: client.epoch });
  await flush();
  const w = c.last("withdraw")!;
  assert.deepEqual([w.id, w.base], ["r1.1", 1]);
  assert.equal(q.pending(B).length, 1, "still queued until the server spends the id");
  c.feed({ type: "ack", branchId: B, id: "r1.1", seq: 2, epoch: w.epoch, withdrawn: true });
  assert.equal(q.pending(B).length, 0);
  assert.ok(events.includes("absorbed:r1.1:true"));
  // a change made and emptied before it was ever sent: no copy can exist, so no withdraw row
  q.commit(B, { id: "r1.2", author: me, ops: [set("c1", "opacity", 0.5)], policy: "lww", at: 0 });
  q.integrate(B, [rowOf(q, "bob.2", 2, [set("c1", "opacity", 0.5)])]);
  client.pump();
  assert.equal(c.sent.filter((m) => m.type === "withdraw" && m.id === "r1.2").length, 0, "no withdraw row for a change never sent");
  assert.ok(events.includes("absorbed:r1.2:false"));
  client.stop();
});

test("\"lww on structure\" is resubmitted as merge, never dropped (H2); a validation reject drops the change as rejected", async () => {
  const { q, client, c } = await setup();
  const rejected: string[] = [];
  q.on((e) => e.type === "rejected" && rejected.push(`${e.change.id}:${e.reason}`));
  q.commit(B, { id: "r1.1", author: me, ops: [set("c0", "name", "x")], policy: "lww", at: 0 });
  client.pump();
  assert.equal(c.last("push")!.changes[0]!.policy, "lww", "a leaf edit stays lww");
  c.feed({ type: "reject", branchId: B, id: "r1.1", reason: "lww on structure", head: 0, concurrent: [], epoch: client.epoch });
  await flush();
  assert.equal(c.last("push")!.changes[0]!.policy, "merge", "resubmitted as merge");
  assert.equal(q.pending(B).length, 1, "not dropped");
  c.feed({ type: "reject", branchId: B, id: "r1.1", reason: "span missing", head: 0, concurrent: [], epoch: client.epoch });
  await flush();
  assert.deepEqual(rejected, ["r1.1:span missing"]);
  assert.equal(q.pending(B).length, 0);
  // the client rule: lww asked for a timing edit is committed as merge
  q.commit(B, { id: "r1.2", author: me, ops: [set("c1", "endTime", 9), set("c1", "trimEnd", 4)], policy: "lww", at: 0 });
  assert.equal(q.pending(B)[0]!.versions[0]!.policy, "merge");
  client.stop();
});

test("\"behind\": listed ids leave the queue, the rest is rebased onto head and resent with base = head; a head itself too far behind catches up first", async () => {
  const { q, client, c } = await setup();
  for (let i = 1; i <= 3; i++) q.commit(B, { id: `r1.${i}`, author: me, ops: [set("c0", "name", `n${i}`)], at: 0 });
  client.pump();
  const rows = Array.from({ length: 5 }, (_, i) => rowOf(q, `o.${i + 1}`, i + 1, [set("c2", "name", `o${i}`)]));
  c.feed({ type: "changes", branchId: B, rows });
  c.feed({ type: "reject", branchId: B, id: "r1.2", reason: "behind", head: 6, concurrent: [], epoch: client.epoch, confirmed: [{ id: "r1.1", seq: 6, rebase: 0 }] });
  await flush();
  assert.deepEqual(c.last("push")!.changes.map((x) => [x.id, x.base.seq]), [["r1.1", 5], ["r1.2", 5], ["r1.3", 5]], "seq 6 isn't held yet: r1.1 waits for its row");
  c.feed({ type: "reject", branchId: B, id: "r1.1", reason: "behind", head: 500, concurrent: [], epoch: client.epoch });
  await flush();
  assert.equal(c.sent.at(-1)!.type, "hello", "500 is more than K past our head: catch up first");
  client.stop();
});

test("fencing: a client whose lease nonce changed stops for good and never touches the queue again (R5-06)", async () => {
  let holder = true;
  const { q, client, c } = await setup({ fence: () => holder });
  q.commit(B, { id: "r1.1", author: me, ops: [set("c0", "name", "x")], at: 0 });
  holder = false;
  client.pump();
  assert.equal(c.sent.filter((m) => m.type === "push").length, 0);
  assert.equal(client.status, "stopped");
  c.feed({ type: "changes", branchId: B, rows: [rowOf(q, "o.1", 1, [set("c2", "name", "o")])] });
  assert.equal(q.headSeq(B), 0, "a stopped client integrates nothing");
});

// ---------------------------------------------------------------- review round 1 (GPT 6.1 Sol, f50da49)
test("finding 3: rows out of order (a gap) make the client catch up again, never throw", async () => {
  const { q, client, c } = await setup();
  const before = c.sent.length;
  c.feed({ type: "changes", branchId: B, rows: [rowOf(q, "o.3", 3, [set("c2", "name", "o")])] });
  assert.equal(q.headSeq(B), 0, "nothing appended");
  assert.equal(c.sent.slice(before).at(-1)?.type, "hello", "a resync hello");
  client.stop();
});

test("finding 10: an incomplete confirmed list makes the client ask for the rest before it acts on any of it", async () => {
  const { q, client, c } = await setup();
  q.commit(B, { id: "r1.1", author: me, ops: [set("c0", "name", "a")], at: 0 });
  client.pump();
  q.pending(B)[0]!.sentBases.push(40, 300); // pushed on several bases over time (all fates unknown)
  c.drop();
  await new Promise((r) => setTimeout(r, 10));
  const c2 = (client as unknown as { conn: Scripted }).conn;
  c2.feed({ type: "hello", branchId: B, head: 0, rows: [], confirmed: [], uncheckedFrom: 40 });
  const again = c2.last("hello")!;
  assert.deepEqual(again.pending, [{ id: "r1.1", bases: [40, 300] }], "only the unchecked bases are claimed again");
  assert.equal(client.caughtUp, false, "not caught up on a partial answer");
  client.stop();
});

test("finding 13: a fold-in's history travels with the change, and an empty fold is kept and pushed, not absorbed", async () => {
  const { q, client, c } = await setup();
  const res = q.commit(B, { id: "r1.1", author: me, ops: [], at: 0, history: { kind: "merge", mergeOf: { branchId: "V", seq: 3 } } });
  assert.equal(res.status, "pending", "an empty fold is a DAG node: it is recorded");
  client.pump();
  await flush();
  const pushed = c.last("push")!.changes[0]!;
  assert.deepEqual([pushed.kind, pushed.mergeOf], ["merge", { branchId: "V", seq: 3 }]);
  assert.equal(c.sent.filter((m) => m.type === "withdraw").length, 0);
  client.stop();
});

test("finding 14: a keyframe that fails its hash is refused; the client catches up by rows only", async () => {
  const { q, client, c, conns } = await setup();
  const errors: string[] = [];
  (client as unknown as { o: { onEvent?: (e: { type: string; error?: string }) => void } }).o.onEvent = (e) => e.type === "error" && errors.push(e.error!);
  c.drop();
  await new Promise((r) => setTimeout(r, 10));
  const c2 = conns[1]!;
  c2.feed({ type: "hello", branchId: B, head: 200, keyframe: { seq: 128, stateHash: "forged", doc: d0 }, rows: [], confirmed: [] });
  assert.equal(q.headSeq(B), 0, "not installed");
  assert.match(errors.join(), /doesn't match/);
  assert.equal(c2.last("hello")!.noKeyframe, true);
  client.stop();
});

test("finding 18: a change confirmed through the server's list keeps its version id", async () => {
  const q = new ReplicaQueue(schema);
  q.addBranch({ id: B, name: "main", kind: "main", sequencer: { kind: "server", since: 0 } }, d0);
  q.commit(B, { id: "r1.1", author: me, ops: [set("c0", "name", "a")], at: 0 });
  q.jumpTo(B, { seq: 10, stateHash: hashDoc(d0, schema), doc: d0 });
  q.confirmFromList(B, [{ id: "r1.1", seq: 4, rebase: 0 }]);
  assert.deepEqual(q.versionId(B, "r1.1"), { id: `${B}@4`, provisional: false });
});

test("finding 20: a commit after catching up turns the status back to syncing until it is confirmed", async () => {
  const { q, client, c } = await setup();
  assert.equal(client.status, "up-to-date");
  q.commit(B, { id: "r1.1", author: me, ops: [set("c0", "name", "a")], at: 0 });
  assert.equal(client.status, "syncing");
  await flush();
  const id = c.last("push")!.changes[0]!.id;
  c.feed({ type: "changes", branchId: B, rows: [{ ...rowOf(q, id, 1, [set("c0", "name", "a")]), author: me }] });
  c.feed({ type: "ack", branchId: B, id, seq: 1, epoch: client.epoch });
  assert.equal(client.status, "up-to-date");
  client.stop();
});
