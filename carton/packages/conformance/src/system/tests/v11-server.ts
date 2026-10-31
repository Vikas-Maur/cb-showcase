// PLAN v11 §6.3 server rules, as they affect system behaviour (port of system-v11 `test/v11-server.test.mjs`):
//  - K = 100: a push more than 100 changes behind is rejected at once ("rebase from keyframe"), without a scan; the
//    client rebases its whole pending queue onto the head and re-pushes with every base set to it;
//  - a timing op must carry a span that contains its new edges;
//  - a replica id is bound to the device credential (account + per-install key) and reclaimed on reconnect; a push
//    carrying an id bound to another credential is rejected;
//  - existence is per branch: one row appended per insert or remove, keyed (branch, coll, id, seq); a lookup reads the
//    newest row ≤ the bound, following the fork chain.
// Server-level cases drive the sequencer directly with a stand-in connection; the system cases run replicas.
import test from "node:test";
import assert from "node:assert/strict";
import { declare } from "@carton/core";
import type { Change, Doc, Op, Span, sync } from "@carton/core";
import type { HostConnection } from "@carton/server";
import { doc, clips, set, type SimServer } from "../sim/world.ts";
import { Agent } from "../sim/agent.ts";
import type { SimActor } from "../sim/replica.ts";
import { A, world, until, runFor, assertConverged, report, ENGINE } from "../helpers.ts";

// A stand-in connection: the sequencer talks to it as to a client socket. It says hello on `branchId` at once (the
// real sequencer refuses a push before hello), and on any other branch before its first push there.
interface FakeConn {
  writer: string;
  inbox: sync.ServerMessage[];
  conn: HostConnection;
  subs: Set<string>;
}
async function fakeConn(server: SimServer, writer: string, branchId: string): Promise<FakeConn> {
  const inbox: sync.ServerMessage[] = [];
  const conn: HostConnection = { id: `fake:${writer}`, auth: { account: writer, credential: writer, role: "editor", projectId: "sim", expires: Number.MAX_SAFE_INTEGER }, send: (m) => void inbox.push(m) };
  const c: FakeConn = { writer, inbox, conn, subs: new Set() };
  await hello(server, c, branchId);
  return c;
}
async function hello(server: SimServer, c: FakeConn, branchId: string): Promise<void> {
  await server.seq.handle(c.conn, { type: "hello", branchId, have: server.seq.tables.head(branchId), pending: [], rids: [], schemaVersion: 1 });
  c.subs.add(branchId);
}
let N = 0;
type Answer = sync.AckMsg | sync.RejectMsg;
async function push(server: SimServer, conn: FakeConn, branchId: string, before: Doc, ops: Op[], { base = null, spans, id = `${conn.writer}.${++N}` }: { base?: { seq: number; pending: string[] } | null; spans?: Span[]; id?: string } = {}): Promise<Answer> {
  if (!conn.subs.has(branchId)) await hello(server, conn, branchId);
  const d = declare(A.S, before, ops, null);
  const head = server.seq.tables.head(branchId);
  const ch: Change = { id, hash: "h", author: { kind: "agent", id: conn.writer }, branchId, base: base ?? { seq: head, pending: [] }, ops, intent: null, kinds: null, policy: "merge", at: 0, ...d, spans: spans ?? d.spans };
  conn.inbox.length = 0;
  await server.seq.handle(conn.conn, { type: "push", branchId, epoch: ++N, changes: [ch] });
  return conn.inbox.find((m): m is Answer => m.type === "ack" || m.type === "reject")!;
}
const human = (id: string) => ({ kind: "human", id }) as SimActor;
const valueOf = (op: Op | undefined) => (op as { value?: unknown } | undefined)?.value;

// Reconnect (v11 §6.3): the worker pushes "first", which is confirmed; the link drops; while offline the same worker
// commits "second"; the link comes back and a new connection presents the same device credential, reclaiming the rid,
// so "second" is accepted. Bound to one connection instead (the control), "second" is rejected and lost to a card.
async function reconnectWithPending({ bindRid, seed }: { bindRid: "credential" | "connection"; seed: number }) {
  const w = world({ seed, server: { bindRid } });
  const m1 = w.replica({ name: "m1", link: w.net.link({ rtt: 200 }) });
  const b = w.shared(doc({ items: clips(4) }), [m1]);
  await m1.startApp({ gui: false, materialize: false });
  await runFor(w, 1000);
  const commit = (field: string, name: string) =>
    m1.worker!.proc.engine.post(() => {
      const id = `${m1.worker!.proc.rid}.${++m1.worker!.proc.n}`;
      m1.store.commit(b, { id, author: human("human:m1"), ops: [set("c1", field, name)], at: w.sim.now });
    });
  commit("name", "first");
  await runFor(w, 2000);
  m1.link.down();
  await runFor(w, 200);
  commit("textContent", "second"); // made offline: pending
  await runFor(w, 800);
  const conn0 = [...w.server.rids.values()][0];
  m1.link.restore();
  await runFor(w, 5000);
  return { w, b, m1, conn0 };
}

// Existence per branch with history (v11 §6.3). Main has tracks V1 and T2. Main removes T2 (seq 2) and re-inserts it
// (seq 3, an undo); later it inserts a new item Z (seq 4). Variants fork at different points:
//   V1 at seq 1 (T2 alive, Z unborn), V2 at seq 2 (T2 removed), V3 at seq 3 (T2 back).
// Placing an item on T2 must be accepted on V1 and V3 and rejected on V2; inserting an item with Z's id on V1 must be
// accepted (Z didn't exist at V1's fork point); on main T2 is alive and Z exists.
async function forkScenario(records: "history" | "latest-only") {
  // the prototype's "ddl" control is `records: "latest-only"` on the real sequencer
  const w = world({ seed: 186, server: { records } });
  const b = w.shared(doc({ tracks: ["V1", "T2"], items: clips(3) }), []);
  const S = w.server, d0 = S.branches.get(b)!.doc0! as A.SimDoc, c = await fakeConn(S, "x", b);
  const T2 = d0.tracks!.find((x) => x.id === "T2");
  const at = (head: number) => ({ base: { seq: head, pending: [] } });
  const ok = (r: Answer) => (r.type === "ack" ? "ack" : r.reason);
  assert.equal((await push(S, c, b, d0, [set("c0", "name", "m1")])).type, "ack"); // seq 1
  S.forkBranch("V1", { id: "V1", name: "v1", kind: "variant" }, b, 1);
  assert.equal((await push(S, c, b, d0, [{ op: "remove", path: ["tracks", "T2"] }])).type, "ack"); // seq 2
  S.forkBranch("V2", { id: "V2", name: "v2", kind: "variant" }, b, 2);
  assert.equal((await push(S, c, b, d0, [{ op: "insert", path: ["tracks", "T2"], value: T2 }])).type, "ack", "re-inserted (undo)"); // seq 3
  S.forkBranch("V3", { id: "V3", name: "v3", kind: "variant" }, b, 3);
  const Z = { ...clips(3)[2], id: "Z", startTime: 20, endTime: 25 };
  assert.equal((await push(S, c, b, d0, [{ op: "insert", path: ["timelineItems", "Z"], value: Z }])).type, "ack"); // seq 4
  const title = (id: string) => ({ id, trackId: "T2", type: "text", name: id, textContent: "x", startTime: 0, endTime: 3, trimStart: 0, trimEnd: 3, opacity: 1 });
  const place = async (v: string) => ok(await push(S, c, v, d0, [{ op: "insert", path: ["timelineItems", `t-${v}`], value: title(`t-${v}`) }], at(0)));
  const out = {
    V1: await place("V1"),
    V2: await place("V2"),
    V3: await place("V3"),
    zOnV1: ok(await push(S, c, "V1", d0, [{ op: "insert", path: ["timelineItems", "Z"], value: Z }], at(1))),
    mainT2: S.exists(b, "tracks/T2"),
    mainZ: S.exists(b, "timelineItems/Z"),
  };
  return out;
}

// R10-01. X pushes a ripple R, a style edit S and an insert I; all three are confirmed (seqs 1–3) but the link drops
// before the acks. Bob then inserts h, moves e and sets the opacity S had set, and makes 110 more changes, so X is more
// than K = 100 behind and catches up from a keyframe (seq 64) plus the tail, not from the rows.
// v12: hello lists X's pending ids already confirmed; X drops them before the whole-queue rebase. Control: no list.
async function lostAckKcap({ confirmedList, seed }: { confirmedList: boolean; seed: number }) {
  const w = world({ seed, server: { confirmedList } });
  const mk = (id: string, s: number, e: number, o: Record<string, unknown> = {}) => ({ ...clips(1)[0], id, name: id, startTime: s, endTime: e, trimStart: 0, trimEnd: e - s, ...o });
  const X = w.replica({ name: "X", link: w.net.link({ rtt: 100 }) });
  const B = w.replica({ name: "bob", link: w.net.link({ rtt: 50 }) });
  const b = w.shared(doc({ tracks: ["V1", "T2"], items: [mk("a", 0, 10), mk("c", 15, 25), mk("d", 25, 35), mk("e", 35, 40), ...clips(20, { prefix: "n", track: "T2" }).map((c) => ({ ...c, startTime: c.startTime + 100, endTime: c.endTime + 100 }))] }), [X, B]);
  await X.startApp({ gui: false, materialize: false });
  await B.startApp({ gui: false, materialize: false });
  await runFor(w, 1000);
  const commit = (r: typeof X, fn: (h: A.SimDoc) => { ops: Op[]; policy?: "lww" | "merge"; intent?: ReturnType<typeof A.rippleAction>["intent"] }, extra = {}) =>
    r.worker!.proc.engine.post(() => {
      const id = `${r.worker!.proc.rid}.${++r.worker!.proc.n}`;
      const o = fn(r.store.optimistic(b).doc as A.SimDoc);
      r.store.commit(b, { id, author: human(`human:${r.name}`), at: w.sim.now, ...o, ...extra });
    });
  commit(X, (h) => A.rippleAction(h, { track: "V1", at: 15, delta: -5 }));
  commit(X, () => ({ ops: [set("a", "opacity", 0.3)], policy: "lww" }));
  commit(X, () => ({ ops: [{ op: "insert", path: ["timelineItems", "x2"], value: mk("x2", 0, 5, { trackId: "T2" }) }] }));
  await w.sim.runUntil(() => X.worker!.sync!.log.some((e) => e.kind === "push"), 5000);
  w.sim.after(1, () => X.link.down()); // the push reaches the server; the acks don't come back
  await runFor(w, 2000);
  const confirmedEarly = w.server.rows(b).map((r) => r.id);
  commit(B, () => ({ ops: [{ op: "insert", path: ["timelineItems", "h"], value: mk("h", 40, 45) }] }));
  await runFor(w, 300);
  commit(B, (h) => ({ ops: [set("e", "startTime", A.item(h, "e")!.startTime + 1), set("e", "endTime", A.item(h, "e")!.endTime + 1)] }));
  commit(B, () => ({ ops: [set("a", "opacity", 0.9)], policy: "lww" }));
  for (let i = 0; i < 110; i++) commit(B, () => ({ ops: [set(`n${i % 20}`, "name", `b${i}`)] }));
  await runFor(w, 5000);
  X.link.restore();
  await runFor(w, 10000);
  return { w, b, X, B, confirmedEarly };
}

// Restart (R10-02). The worker pushes "first" (binding its rid); offline, it commits "second" (same rid); the app quits
// and starts again with a new worker process (new rid), which pushes "second" with the old rid on the same device
// credential: accepted, confirmed once. Bound to one connection instead, it is rejected.
async function restartWithPending({ bindRid, seed }: { bindRid: "credential" | "connection"; seed: number }) {
  const w = world({ seed, server: { bindRid } });
  const m1 = w.replica({ name: "m1", link: w.net.link({ rtt: 200 }) });
  const b = w.shared(doc({ items: clips(4) }), [m1]);
  await m1.startApp({ gui: false, materialize: false });
  await runFor(w, 1000);
  const commit = (f: string, v: string) =>
    m1.worker!.proc.engine.post(() => {
      const id = `${m1.worker!.proc.rid}.${++m1.worker!.proc.n}`;
      m1.store.commit(b, { id, author: human("human:m1"), ops: [set("c1", f, v)], at: w.sim.now });
    });
  commit("name", "first");
  await runFor(w, 2000);
  m1.link.down();
  commit("textContent", "second");
  await runFor(w, 500);
  const oldRid = m1.worker!.proc.rid;
  m1.worker!.proc.kill();
  m1.worker = null; // the app quits; takes.db keeps the pending change
  await runFor(w, 1000);
  m1.link.restore();
  await until(w, m1.startApp({ gui: false, materialize: false }));
  await runFor(w, 5000);
  return { w, b, m1, oldRid };
}

// Helper takeover (R10-02). With the app closed, an agent's change C goes through helper H1, whose push is rejected
// (Bob trimmed the same clip first). H1 dies before it can rebase; the next `cb` call's helper takes over, rebases C and
// pushes it under C's original rid (bound by H1's push): accepted on the device credential, rejected per connection.
async function takeover({ bindRid, seed }: { bindRid: "credential" | "connection"; seed: number }) {
  const w = world({ seed, server: { bindRid } });
  const m1 = w.replica({ name: "m1", link: w.net.link({ rtt: 400 }) });
  const m2 = w.replica({ name: "m2", link: w.net.link({ rtt: 50 }) });
  const b = w.shared(doc({ items: clips(4) }), [m1, m2]);
  await m2.startApp({ gui: false, materialize: false });
  const agent = new Agent(m1, { name: "agent", hooked: false });
  await until(w, agent.cb({ kind: "status" })); // H1 up and caught up
  const h1 = m1.helpers[0]!;
  m2.worker!.proc.engine.post(() => m2.store.commit(b, { id: `${m2.worker!.proc.rid}.1`, author: human("human:m2"), ops: [set("c1", "endTime", 9.5), set("c1", "trimEnd", 4.5)], at: w.sim.now }));
  const call = agent.cb({ kind: "ops", write: true, ops: [set("c1", "startTime", 5.5), set("c1", "trimStart", 0.5)] }, { retryOnReset: false });
  await w.sim.runUntil(() => h1.sync!.log.some((e) => e.kind === "push"), 10000);
  h1.proc.kill(); // the push is on the wire; its reject will find nobody
  const first = await until(w, call);
  await runFor(w, 2000);
  await until(w, agent.cb({ kind: "status" })); // the next call takes over
  await runFor(w, 5000);
  return { w, b, m1, m2, first };
}

export function register(): void {
  test(`v11 K cap: a push 100 behind is evaluated; 101 behind is rejected "behind" without the overlap check, listing its already-confirmed ids [${ENGINE}]`, async (t) => {
    const w = world({ seed: 180 });
    const b = w.shared(doc({ items: clips(40) }), []);
    const S = w.server, d0 = S.branches.get(b)!.doc0!;
    const other = await fakeConn(S, "other", b), me = await fakeConn(S, "me", b);
    for (let i = 0; i < 101; i++) assert.equal((await push(S, other, b, d0, [set(`c${10 + (i % 30)}`, "name", `n${i}`)])).type, "ack");
    const read0 = S.stats.rowsRead;
    const r100 = await push(S, me, b, d0, [set("c0", "name", "late-100")], { base: { seq: 1, pending: [] } });
    const read100 = S.stats.rowsRead - read0;
    const r101 = await push(S, me, b, d0, [set("c1", "name", "late-101")], { base: { seq: 0, pending: [] } });
    const read101 = S.stats.rowsRead - read0 - read100;
    assert.equal(r100.type, "ack", "100 behind: scanned and accepted (no overlap)");
    assert.ok(read100 >= 100, "it read the 100-row tail");
    assert.equal(r101.type, "reject");
    const rj = r101 as sync.RejectMsg;
    assert.equal(rj.reason, "behind");
    assert.equal(rj.concurrent.length, 0, "no rows sent back, no overlap check");
    assert.deepEqual(rj.confirmed, [], "R10-01: the list of this push's ids already confirmed (none here)");
    // the only read is v12's id-column scan for that list, from the push's oldest base
    report(t, { rowsRead100: read100, rowsRead101IdScan: read101 });
  });

  test(`v11 K cap through the system: a push stalled while 150 remote changes land is rejected "behind", rebased, and confirmed once afterwards [${ENGINE}]`, async (t) => {
    const w = world({ seed: 181 });
    const m1 = w.replica({ name: "m1", link: w.net.link({ rtt: 100 }) });
    const m2 = w.replica({ name: "m2", link: w.net.link({ rtt: 20 }) });
    const b = w.shared(doc({ items: clips(40) }), [m1, m2]);
    await m1.startApp({ gui: false, materialize: false });
    await m2.startApp({ gui: false, materialize: false });
    await runFor(w, 1000);
    let stalled = false;
    m1.link.delayHook = (msg) => (!stalled && msg.type === "push" ? ((stalled = true), 8000) : 0); // a stalled retransmit
    const agent = new Agent(m1, { name: "agent", hooked: false });
    const call = agent.cb({ kind: "ops", write: true, ops: [set("c0", "name", "late")] });
    await runFor(w, 300);
    for (let i = 0; i < 150; i++)
      w.sim.after(i * 40, () =>
        m2.worker!.proc.engine.post(() => {
          // 25/s, each pushed at once
          const id = `${m2.worker!.proc.rid}.${++m2.worker!.proc.n}`;
          m2.store.commit(b, { id, author: human("human:m2"), ops: [set(`c${10 + (i % 30)}`, "name", `r${i}`)], at: w.sim.now });
        }),
      );
    const res = await until(w, call);
    await runFor(w, 10000);
    assert.equal(w.server.stats.rejectReasons.behind, 1, "rejected as behind");
    assert.equal(res.status, "pending", "the stalled push outlasted cb's 5 s wait (§6.2)");
    assert.equal(w.server.rows(b).filter((r) => r.id === res.id).length, 1);
    assertConverged(w, b, [m1, m2]);
    report(t, { rejectReasons: w.server.stats.rejectReasons, rows: w.server.rows(b).length });
  });

  test(`v11 span check: a timing op without a span containing its new edge is rejected; with one it is accepted [${ENGINE}]`, async (t) => {
    const w = world({ seed: 182 });
    const b = w.shared(doc({ items: clips(4) }), []);
    const S = w.server, d0 = S.branches.get(b)!.doc0!, c = await fakeConn(S, "x", b);
    const move = [set("c1", "startTime", 6), set("c1", "endTime", 11)];
    const reason = (r: Answer) => (r.type === "reject" ? r.reason : undefined);
    assert.equal(reason(await push(S, c, b, d0, move, { spans: [] })), "span missing", "no span");
    assert.equal(reason(await push(S, c, b, d0, move, { spans: [{ track: "V1", lo: 5, hi: 10 }] })), "span missing", "a span that doesn't reach the new end (11)");
    assert.equal((await push(S, c, b, d0, move)).type, "ack", "the engine's declaration covers it");
    assert.equal((await push(S, c, b, d0, [set("c2", "opacity", 0.5)], { spans: [] })).type, "ack", "a style edit needs no span");
    report(t, { rejectReasons: S.stats.rejectReasons });
  });

  test(`v11 span check through the system: a client that strips spans gets its change rejected once, as a card and a notice, never retried in a loop [${ENGINE}]`, async (t) => {
    const w = world({ seed: 183 });
    const m1 = w.replica({ name: "m1", link: w.net.link({ rtt: 100 }) });
    const b = w.shared(doc({ items: clips(4) }), [m1]);
    await m1.startApp({ gui: false, materialize: false });
    await runFor(w, 1000);
    m1.worker!.sync!.tamper = (ch) => ({ ...ch, spans: [] }); // a buggy or hostile client
    const agent = new Agent(m1, { name: "agent", hooked: false });
    const r = await until(w, agent.cb({ kind: "ops", write: true, ops: [set("c1", "startTime", 6), set("c1", "endTime", 11)] }));
    await runFor(w, 5000);
    assert.equal(r.status, "rejected");
    assert.equal(w.server.stats.rejectReasons["span missing"], 1, "rejected once");
    assert.equal(m1.store.pending(b).length, 0, "not left in the queue");
    assert.ok(m1.cards.some((c) => c.rejected === "span missing"), "a card for the human");
    assert.equal((await until(w, agent.cb({ kind: "status" }))).notices.length, 1, "a notice for the agent");
    assert.equal(A.item(m1.store.optimistic(b).doc, "c1")!.startTime, 5, "nothing applied");
    report(t, { status: r.status });
  });

  test(`v11 rid bound to the device credential: a second install of the same account can't push the first install's ids; one install's processes push each other's ids [${ENGINE}]`, async (t) => {
    const w = world({ seed: 184 });
    const m1 = w.replica({ name: "m1", account: "acct:alice", link: w.net.link({ rtt: 100 }) }); // Alice's laptop
    const m2 = w.replica({ name: "m2", account: "acct:alice", link: w.net.link({ rtt: 100 }) }); // Alice's desktop
    assert.notEqual(m1.credential, m2.credential, "same account, different per-install keys");
    const b = w.shared(doc({ items: clips(4) }), [m1, m2]);
    await m1.startApp({ gui: false, materialize: false });
    await m2.startApp({ gui: false, materialize: false });
    const r1 = await until(w, new Agent(m1, { name: "a1", hooked: false }).cb({ kind: "ops", write: true, ops: [set("c1", "name", "m1")] }));
    const rid = r1.id.split(".")[0];
    const forged = await until(w, new Agent(m2, { name: "a2", hooked: false }).cb({ kind: "ops", write: true, id: `${rid}.77`, ops: [set("c2", "name", "forged")] }));
    await runFor(w, 3000);
    assert.equal(r1.status, "confirmed", "m1's worker pushed an id made by a cb process (same replica)");
    assert.equal(forged.status, "rejected");
    assert.equal(w.server.stats.rejectReasons["foreign id"], 1);
    assert.equal(A.item(m2.store.optimistic(b).doc, "c2")!.name, "c2");
    assertConverged(w, b, [m1, m2]);
    report(t, { forged: forged.status });
  });

  // A replica's own burst: 150 edits made offline are pushed, pipelined, on reconnect. From the 102nd on, their base is
  // more than 100 behind (all of it the replica's own rows, listed as causal past): one "behind" reject, then the queue
  // is re-based on head and the rest go through. (A client that kept its old bases would be rejected forever.)
  test(`v11 K cap and a 150-edit offline burst: one "behind" reject, every edit confirmed exactly once [${ENGINE}]`, async (t) => {
    const w = world({ seed: 187 });
    const m1 = w.replica({ name: "m1", link: w.net.link({ rtt: 100 }) });
    const b = w.shared(doc({ items: clips(40) }), [m1]);
    await m1.startApp({ gui: false, materialize: false });
    await runFor(w, 1000);
    // record every push message the server receives: its changes' bases, and the head when it arrived
    const msgs: { head: number; bases: number[] }[] = [];
    const recv = w.server.receive.bind(w.server);
    w.server.receive = (conn, msg) => {
      if (msg.type === "push") msgs.push({ head: w.server.rows(b).length, bases: msg.changes.map((ch) => ch.base.seq) });
      return recv(conn, msg);
    };
    m1.link.down();
    for (let i = 0; i < 150; i++)
      m1.worker!.proc.engine.post(() => {
        const id = `${m1.worker!.proc.rid}.${++m1.worker!.proc.n}`;
        m1.store.commit(b, { id, author: human("human:m1"), ops: [set(`c${i % 40}`, "name", `o${i}`)], at: w.sim.now });
      });
    await runFor(w, 2000);
    m1.link.restore();
    await runFor(w, 20000);
    assert.equal(w.server.rows(b).length, 150);
    assert.equal(w.server.stats.rejectReasons.behind, 1);
    // one pipelined message of 150 (changes 102.. are > 100 behind when evaluated); after the reject, the 49 left are
    // re-pushed once, every base set to the head they were rebased onto
    assert.equal(msgs.length, 2);
    assert.equal(msgs[0]!.bases.length, 150);
    assert.deepEqual([msgs[1]!.bases.length, new Set(msgs[1]!.bases).size, msgs[1]!.bases[0], msgs[1]!.head], [49, 1, 101, 101]);
    assertConverged(w, b, [m1]);
    report(t, { rejectReasons: w.server.stats.rejectReasons, messages: msgs.map((m) => ({ n: m.bases.length, bases: [...new Set(m.bases)], head: m.head })) });
  });

  test(`v11 reconnect: a new connection with the same device credential reclaims the rid; the change made offline is confirmed [${ENGINE}]`, async (t) => {
    const { w, b, m1 } = await reconnectWithPending({ bindRid: "credential", seed: 185 });
    assert.deepEqual(w.server.rows(b).map((x) => valueOf(x.ops[0])), ["first", "second"]);
    assert.equal(A.item(m1.store.optimistic(b).doc, "c1")!.textContent, "second");
    assert.equal(w.server.stats.rejectReasons["foreign id"] ?? 0, 0);
    assert.ok((m1.worker!.sync!.stats.reconnects ?? 0) >= 2, "it was a new connection");
    report(t, { rows: 2, reconnects: m1.worker!.sync!.stats.reconnects });
  });
  test(`v11 control: binding a replica id to one connection rejects the offline change after the reconnect, so it is lost to a card [${ENGINE}]`, async (t) => {
    const { w, b, m1 } = await reconnectWithPending({ bindRid: "connection", seed: 185 });
    assert.equal(w.server.stats.rejectReasons["foreign id"], 1, "the replica's own id is foreign on its new connection");
    assert.equal(A.item(m1.store.optimistic(b).doc, "c1")!.textContent, undefined, "the offline edit was dropped");
    assert.ok(m1.cards.some((c) => c.rejected === "foreign id"));
    report(t, { rejectReasons: w.server.stats.rejectReasons });
  });

  test(`v11 per-branch existence: remove and re-insert on the parent after the fork; each variant sees the record as it was at its own fork point [${ENGINE}]`, async (t) => {
    const r = await forkScenario("history");
    assert.equal(r.V1, "ack", "V1 (forked before the remove) still has T2");
    assert.equal(r.V2, "read of a missing record", "V2 (forked between remove and re-insert) has no T2");
    assert.equal(r.V3, "ack", "V3 (forked after the re-insert) has T2");
    assert.equal(r.zOnV1, "ack", "Z was born on main after V1's fork point");
    assert.equal(r.mainT2, true);
    assert.equal(r.mainZ, true);
    report(t, r);
  });
  test(`v11 control: one row per record (v10's PRIMARY KEY) answers V1 wrongly once the parent has touched T2 after the fork [${ENGINE}]`, async (t) => {
    const r = await forkScenario("latest-only");
    assert.equal(r.V1, "read of a missing record", "V1's valid placement is rejected");
    report(t, r);
  });

  // Verification 4, M5: "a span on its track". The server knows an item's track from its records rows.
  test(`v11 span check is per track: a move on V1 with a span only on T2, a slip with a span elsewhere, a track change spanning only one track, an unset with no span are all rejected [${ENGINE}]`, async (t) => {
    const w = world({ seed: 188 });
    const b = w.shared(doc({ tracks: ["V1", "T2"], items: clips(4) }), []);
    const S = w.server, d0 = S.branches.get(b)!.doc0!, c = await fakeConn(S, "x", b);
    const reason = (r: Answer) => (r.type === "ack" ? "ack" : r.reason);
    const out = {
      moveSpanOnT2: reason(await push(S, c, b, d0, [set("c1", "startTime", 6), set("c1", "endTime", 11)], { spans: [{ track: "T2", lo: 5, hi: 11 }] })),
      slipSpanElsewhere: reason(await push(S, c, b, d0, [set("c1", "trimStart", 0.5), set("c1", "trimEnd", 5.5)], { spans: [{ track: "T2", lo: 0, hi: 100 }] })),
      trackChangeOneSpan: reason(await push(S, c, b, d0, [set("c1", "trackId", "T2")], { spans: [{ track: "V1", lo: 5, hi: 10 }] })),
      unsetNoSpan: reason(await push(S, c, b, d0, [{ op: "unset", path: ["timelineItems", "c1", "playbackSpeed"] }], { spans: [] })),
      removeNoSpan: reason(await push(S, c, b, d0, [{ op: "remove", path: ["timelineItems", "c2"] }], { spans: [] })),
    };
    for (const [k, v] of Object.entries(out)) assert.equal(v, "span missing", k);
    assert.equal(reason(await push(S, c, b, d0, [set("c1", "trackId", "T2")])), "ack", "the engine's own declaration (both tracks) is accepted");
    const d1 = A.applyOps(d0, [set("c1", "trackId", "T2")]);
    assert.equal(reason(await push(S, c, b, d1, [set("c1", "startTime", 6), set("c1", "endTime", 11)], { spans: [{ track: "V1", lo: 5, hi: 11 }] })), "span missing", "after the move, c1's track is T2");
    assert.equal(reason(await push(S, c, b, d1, [set("c1", "startTime", 6), set("c1", "endTime", 11)])), "ack");
    report(t, out);
  });

  test(`R10-01: lost ack, then > 100 changes, then a keyframe catch-up and whole-queue rebase: the ripple applies once, the style edit gets no card, the insert doesn't stall [${ENGINE}]`, async (t) => {
    const { w, b, X, B, confirmedEarly } = await lostAckKcap({ confirmedList: true, seed: 190 });
    assert.equal(confirmedEarly.length, 3, "R, S and I were confirmed before the drop");
    assert.ok(X.events.some((e) => e.type === "keyframe"), "X caught up from a keyframe");
    const head = X.store.optimistic(b).doc;
    assert.deepEqual(["c", "d", "e", "h"].map((id) => A.item(head, id)!.startTime), [10, 20, 31, 40], "the ripple applied once; Bob's move and insert untouched");
    assert.equal(A.item(head, "a")!.opacity, 0.9, "Bob's later opacity stands");
    assert.equal(X.cards.length, 0, "no card (no phantom 0.9 vs 0.3)");
    assert.equal(X.store.pending(b).length, 0, "nothing stuck in the queue");
    const ids = w.server.rows(b).map((r) => r.id);
    assert.equal(new Set(ids).size, ids.length, "no id confirmed twice");
    assert.equal(w.server.stats.rejectReasons["no ops"] ?? 0, 0);
    assertConverged(w, b, [X, B]);
    report(t, { rows: ids.length, xCards: X.cards.length });
  });
  test(`R10-01 control: without the confirmed list the keyframe hides X's confirmed changes; the ripple is applied twice and confirmed again, the style edit gets a phantom card [${ENGINE}]`, async (t) => {
    const { w, b, X } = await lostAckKcap({ confirmedList: false, seed: 190 });
    const head = X.store.optimistic(b).doc;
    const ids = w.server.rows(b).map((r) => r.id);
    const twice = ids.filter((id, i) => ids.indexOf(id) !== i);
    // v14 (H1): S and I, rebased to nothing, are withdrawn, so their ids also appear twice (a withdraw row each);
    // the ripple R is the change actually confirmed twice
    assert.ok(twice.length >= 1, "a change confirmed twice (tail-scoped dedup can't see seq 1 from the new base)");
    assert.equal(A.item(head, "h")!.startTime, 35, "h shifted by the ripple a second time");
    assert.ok(X.cards.some((c) => c.cards.some((x) => x.path === "timelineItems/a/opacity")), "a phantom card on a's opacity");
    report(t, { confirmedTwice: twice.length, h: A.item(head, "h")!.startTime, e: A.item(head, "e")!.startTime });
  });

  test(`R10-02 restart: a pending change made by the previous app process is pushed by the new one on the same credential and confirmed once [${ENGINE}]`, async (t) => {
    const { w, b, m1, oldRid } = await restartWithPending({ bindRid: "credential", seed: 191 });
    assert.notEqual(m1.worker!.proc.rid, oldRid, "a new process, a new rid");
    const rows = w.server.rows(b);
    assert.deepEqual(rows.map((r) => valueOf(r.ops[0])), ["first", "second"]);
    assert.ok(rows[1]!.id.startsWith(oldRid), "pushed under the old process's rid");
    assert.equal(A.item(m1.store.optimistic(b).doc, "c1")!.textContent, "second");
    report(t, { rows: rows.length });
  });
  test(`R10-02 restart control: bound to one connection, the restarted app's push of the old rid is rejected and lost to a card [${ENGINE}]`, async (t) => {
    const { w, m1 } = await restartWithPending({ bindRid: "connection", seed: 191 });
    assert.equal(w.server.stats.rejectReasons["foreign id"], 1);
    assert.ok(m1.cards.some((c) => c.rejected === "foreign id"));
    report(t, { rejectReasons: w.server.stats.rejectReasons });
  });

  test(`R10-02 helper takeover: the taker pushes the dead helper's change (its original rid) and it is confirmed once, composed with Bob's trim [${ENGINE}]`, async (t) => {
    const { w, b, m1, m2, first } = await takeover({ bindRid: "credential", seed: 192 });
    assert.equal(first.status, "error", "the first call saw its helper die");
    assert.ok(w.server.stats.rejectReasons.overlap! >= 1, "H1's push was rejected (overlap through the group path)");
    const c1 = A.item(w.server.rows(b).reduce((d, r) => A.applyOps(d, r.ops), w.server.branches.get(b)!.doc0!), "c1")!;
    assert.deepEqual([c1.startTime, c1.endTime, c1.trimStart, c1.trimEnd], [5.5, 9.5, 0.5, 4.5], "both trims, composed");
    assert.equal(w.server.stats.rejectReasons["foreign id"] ?? 0, 0);
    assertConverged(w, b, [m1, m2]);
    report(t, { rejectReasons: w.server.stats.rejectReasons });
  });
  test(`R10-02 helper takeover control: bound to one connection, the taker's push of the dead helper's rid is rejected [${ENGINE}]`, async (t) => {
    const { w } = await takeover({ bindRid: "connection", seed: 192 });
    assert.equal(w.server.stats.rejectReasons["foreign id"], 1);
    report(t, { rejectReasons: w.server.stats.rejectReasons });
  });
}
