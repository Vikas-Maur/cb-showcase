// Regression tests for review round 2's findings on the sequencer (and the adoption-closure probe it reproduced).
import test from "node:test";
import assert from "node:assert/strict";
import { sha256Hex, sync, type Change, type Op } from "@carton/core";
import { createSequencer } from "../src/index.ts";
import { BRANCH, clip, declare, doc, fakeConn, ins, memoryBlobs, push, set, sqliteStorage, staticAuth, verdict, world } from "./helpers.ts";

const rec = (id: string) => ({ id, name: id, forkOf: null, owner: "alice", kind: "main" as const, sequencer: { kind: "server" as const, since: 0 } });
const hello = (o: Partial<sync.HelloMsg> = {}): sync.HelloMsg => ({ type: "hello", branchId: BRANCH, have: 0, pending: [], rids: [], schemaVersion: 1, ...o });
const author = { kind: "human" as const, id: "alice" };
const H = (c: string) => c.repeat(64);
function row(id: string, seq: number, branchId = BRANCH, name = id) {
  const ops: Op[] = [set("c0", "name", name)];
  return { id, seq, hash: "h", author, branchId, base: { seq: seq - 1, pending: [] }, ops, intent: null, kinds: null, policy: "merge" as const, at: 0, paths: ["timelineItems/c0/name"], reads: ["timelineItems/c0"], spans: [], trackOrder: [] };
}

test("round 2 finding 1: a client's envelope that understates its size is refused after reading at most size + 1 bytes", async () => {
  const blobs = memoryBlobs();
  const { seq } = await world(doc([clip("c0", 0, 5)]), { blobs });
  const a = fakeConn("alice/1");
  const text = JSON.stringify({ type: "presence", branchId: BRANCH, actor: author, state: { pad: "x".repeat(256 * 1024) } });
  const sha = sha256Hex(text);
  const key = sync.clientEnvelopeKey(sha, Date.now());
  await blobs.put(key, new TextEncoder().encode(text));
  blobs.maxGet = 0;
  await seq.handle(a, { type: "blob", ref: { key, size: 100, sha256: sha } });
  assert.match((a.inbox.at(-1) as sync.ErrorMsg).reason, /bytes, not 100/);
  assert.ok(blobs.maxGet <= 101, `read ${blobs.maxGet} bytes of a 256 KiB object`);
});

test("round 2 finding 2 (server side): a client that reads envelopes is told the largest message the server reads", async () => {
  const { seq } = await world(doc([clip("c0", 0, 5)]), { blobs: memoryBlobs(), maxEnvelopeBytes: 2048 });
  const a = fakeConn("alice/1"), b = fakeConn("bob/1");
  await seq.handle(a, hello({ envelopes: true }));
  await seq.handle(b, hello());
  assert.equal(a.last("hello")!.maxMessageBytes, 2048);
  assert.equal(b.last("hello")!.maxMessageBytes, undefined, "inline-only clients aren't sent a limit they can't use");
});

test("round 2 finding 3: a rolled-back adoption leaves no rid binding behind, in SQL or in a cache; the retry binds durably", async () => {
  const storage = sqliteStorage();
  const seq = createSequencer({ storage, auth: staticAuth });
  const c = fakeConn("alice/device");
  const d0 = doc([clip("c0", 0, 5)]);
  const rows = [row("fresh.1", 1, "adopted"), row("fresh.2", 2, "adopted"), row("fresh.3", 3, "adopted")];
  const adopt = { type: "adopt" as const, branchId: "adopted", n: 3, stateHash: "h", rows, rec: rec("adopted"), doc0: d0 as never, closure: [] };
  // the third row fails inside the transaction, after the first two bound (and read back) the rid
  await seq.handle(c, { ...adopt, rows: [rows[0]!, rows[1]!, { ...rows[2]!, ops: null as never }] });
  assert.ok(c.last("adoptError"));
  assert.equal(seq.tables.ridOwner("fresh"), undefined, "no owner survives the rollback");
  await seq.handle(c, adopt);
  assert.ok(c.last("adopted"));
  assert.deepEqual(storage.exec<{ credential: string }>("SELECT credential FROM rids WHERE rid = ?", "fresh").map((r) => r.credential), ["alice/device"], "bound in SQL by the retry");
  const restarted = createSequencer({ storage, auth: staticAuth });
  const other = fakeConn("mallory/device");
  await restarted.handle(other, hello({ branchId: "adopted", have: 3, rids: ["fresh"] }));
  assert.equal(restarted.tables.ridOwner("fresh"), "alice/device", "another credential can't claim it after a restart");
});

test("round 2 finding 4: the stateless checks refuse a negative start or trim start, and an inserted clip without valid trims", async () => {
  const d0 = doc([clip("c0", 0, 5)]);
  const cases: [string, Op[]][] = [
    ["negative start", [set("c0", "startTime", -1), set("c0", "endTime", 4)]],
    ["negative start alone", [set("c0", "startTime", -1)]],
    ["negative trim start", [set("c0", "trimStart", -0.5)]],
    ["negative inserted trim", [ins("timelineItems", "new", { ...clip("new", 10, 15), trimStart: -1 })]],
    ["missing inserted trims", [ins("timelineItems", "new", { id: "new", trackId: "V1", startTime: 10, endTime: 15 })]],
    ["inserted trims out of order", [ins("timelineItems", "new", { ...clip("new", 10, 15), trimStart: 3, trimEnd: 2 })]],
  ];
  for (const [name, ops] of cases) {
    const { seq } = await world(d0);
    assert.equal(verdict(await push(seq, fakeConn("alice/1"), d0, ops)), "invalid", name);
  }
  const { seq } = await world(d0);
  assert.equal(verdict(await push(seq, fakeConn("alice/1"), d0, [ins("timelineItems", "ok", clip("ok", 10, 15))])), "ack", "a valid clip is still accepted");
});

test("round 2 finding 5: when a message fails after a big row went out, handle() resolves only once the row, its ack and the error are delivered", async () => {
  const blobs = memoryBlobs();
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const put = blobs.put.bind(blobs);
  blobs.put = async (...args: Parameters<typeof put>) => (args[0].startsWith("messages/") ? (await gate, put(...args)) : put(...args));
  const d0 = doc([clip("c0", 0, 5), clip("c1", 5, 10)]);
  const { seq } = await world(d0, { blobs, envelopeBytes: 512 });
  const c = fakeConn("alice/1");
  await seq.handle(c, hello({ envelopes: true }));
  c.inbox.length = 0;
  const ops: Op[] = [set("c0", "name", "x".repeat(2048))];
  const first: Change = { ...row("alice1.1", 1), ops, ...declare(d0, ops, null) } as Change;
  const second = { ...row("alice1.2", 2), base: { seq: 0, pending: 42 } } as unknown as Change; // makes the handler throw
  let resolved = false;
  const done = seq.handle(c, { type: "push", branchId: BRANCH, epoch: 1, changes: [first, second] }).then(() => (resolved = true));
  for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0));
  assert.equal(resolved, false, "not resolved while the row's envelope is uploading");
  release();
  await done;
  assert.deepEqual(c.inbox.map((m) => m.type), ["blob", "ack", "error"]);
});

test("round 2 finding 6: adjacent claim windows count one each against the cap, merged or not", async () => {
  const d0 = doc([clip("c0", 0, 5)]);
  const { seq } = await world(d0, { controls: { claimWindows: 2 } });
  const c = fakeConn("alice/1");
  for (let i = 0; i < 12; i++) await push(seq, c, d0, [set("c0", "name", String(i))]);
  const calls: [number, number][] = [];
  const idsIn = seq.tables.idsIn.bind(seq.tables);
  seq.tables.idsIn = (b, lo, hi) => (calls.push([lo, hi]), idsIn(b, lo, hi));
  const x = fakeConn("x/1");
  await seq.handle(x, hello({ have: 12, pending: [{ id: "missing.1", bases: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11] }] }));
  assert.equal(x.last("hello")!.uncheckedFrom, 2, "two windows read, the rest reported unchecked");
  assert.deepEqual(calls, [[0, 12]], "the two merged windows (0 and 1, K = 100) read once");
});

test("round 2 finding 8: keyframes without a real digest are never stored, a fork's root needs one, and a client that refused one isn't served it again", async () => {
  const d0 = doc([clip("c0", 0, 5)]);
  const { seq } = await world(d0, { keyframeEvery: 2 });
  const a = fakeConn("alice/1");
  await push(seq, a, d0, [set("c0", "name", "1")]);
  await push(seq, a, d0, [set("c0", "name", "2")]);
  for (const stateHash of ["", "h", H("A")]) await seq.handle(a, { type: "keyframe", branchId: BRANCH, keyframe: { seq: 2, stateHash, doc: d0 as never } });
  assert.equal(seq.tables.keyframeAt(BRANCH, 2), null, "none stored");
  await seq.handle(a, { type: "keyframe", branchId: BRANCH, keyframe: { seq: 2, stateHash: H("b"), doc: d0 as never } });
  assert.equal(seq.tables.keyframeAt(BRANCH, 2)?.hash, H("b"));
  await seq.handle(a, { type: "fork", branchId: "V", from: BRANCH, seq: 0, rec: rec("V"), root: { stateHash: "", doc: d0 as never } });
  assert.match(a.last("error")!.reason, /root needs its state hash/);
  const j = fakeConn("j/1");
  await seq.handle(j, hello({ have: -1, noKeyframe: true }));
  assert.match(j.last("error")!.reason, /no state at or after 0 .* that the client can check/);
  assert.equal(j.last("hello"), undefined);
});

test("adoption closure (round 2 probe): a failure writing the ancestry rolls the whole adoption back; the retry writes both", async () => {
  const storage = sqliteStorage();
  const exec = storage.exec.bind(storage);
  let failAncestor = true;
  storage.exec = ((sql: string, ...p: Parameters<typeof exec>[1][]) => {
    if (failAncestor && sql.startsWith("INSERT INTO branches") && p[0] === "ancestor") throw new Error("closure write failed");
    return exec(sql, ...p);
  }) as typeof storage.exec;
  const seq = createSequencer({ storage, auth: staticAuth });
  const c = fakeConn("alice/1");
  const m = { type: "adopt" as const, branchId: "child", n: 0, stateHash: H("c"), rows: [], rec: rec("child"), doc0: doc([clip("c0", 0, 5)]) as never, closure: [{ branchId: "ancestor", rec: rec("ancestor"), nodes: [] }] };
  await seq.handle(c, m);
  assert.match(c.last("adoptError")!.reason, /closure write failed/);
  assert.equal(seq.tables.branch("child"), null, "nothing adopted");
  failAncestor = false;
  await seq.handle(c, m);
  assert.equal(c.last("adopted")!.repeat, undefined, "a real adoption, not a repeat");
  assert.ok(seq.tables.branch("child") && seq.tables.branch("ancestor")?.tracking);
});
