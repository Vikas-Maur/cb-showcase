// The behaviour every SequencerHost must show (PLAN §3.1, §6.3, §12), checked over the host's own Transport in real
// time. A host stays thin (storage and socket glue around `createSequencer`), so these are the places a host can
// break the protocol: authentication, ordering and fan-out, per-connection state (epochs, subscriptions), restart and
// hibernation, and the device-credential binding of replica ids. The last test runs two real SyncClients through the
// host and checks they converge. Branches are created the way a client shares one (an `adopt` upload), so a host needs
// nothing beyond auth, a transport and storage. Owner: sync-sequencer; hosts-plugins runs it against Node and
// Cloudflare (`sequencerHostSuite`), and conformance/test/system/host-suite.test.ts against the in-process host.

import { describe, test, before, after } from "node:test";
import assert from "node:assert/strict";
import type { TransportConnection } from "@carton/core/plugins";
import { declare, sync, type Change, type Doc } from "@carton/core";
import type { HostFixture } from "../hosts/index.ts";
import { cardboard, withKeys } from "../engine/fixtures/cardboard-schema.ts";

type ServerMessage = sync.ServerMessage;

/** One client connection with an inbox the test can wait on. */
class Client {
  readonly conn: TransportConnection;
  readonly inbox: ServerMessage[] = [];
  closed = false;
  private waiters: { pred: (m: ServerMessage) => boolean; res: (m: ServerMessage) => void }[] = [];
  constructor(conn: TransportConnection) {
    this.conn = conn;
    conn.onMessage((m) => {
      this.inbox.push(m);
      for (const w of [...this.waiters]) if (w.pred(m)) (this.waiters.splice(this.waiters.indexOf(w), 1), w.res(m));
    });
    conn.onClose(() => (this.closed = true));
  }
  send(m: sync.ClientMessage): void {
    this.conn.send(m);
  }
  /** The first message (already received or arriving within `ms`) that matches. */
  next<T extends ServerMessage["type"]>(type: T, pred: (m: Extract<ServerMessage, { type: T }>) => boolean = () => true, ms = 5000): Promise<Extract<ServerMessage, { type: T }>> {
    const match = (m: ServerMessage) => m.type === type && pred(m as Extract<ServerMessage, { type: T }>);
    const have = this.inbox.find(match);
    if (have) return Promise.resolve(have as Extract<ServerMessage, { type: T }>);
    return new Promise((res, rej) => {
      const w = { pred: match, res: res as (m: ServerMessage) => void };
      this.waiters.push(w);
      setTimeout(() => {
        const i = this.waiters.indexOf(w);
        if (i >= 0) (this.waiters.splice(i, 1), rej(new Error(`no ${type} within ${ms} ms; inbox: ${this.inbox.map((x) => x.type).join(",")}`)));
      }, ms);
    });
  }
  /** Resolves true if a matching message arrives within `ms`. */
  async gets<T extends ServerMessage["type"]>(type: T, pred?: (m: Extract<ServerMessage, { type: T }>) => boolean, ms = 300): Promise<boolean> {
    try {
      await this.next(type, pred, ms);
      return true;
    } catch {
      return false;
    }
  }
  close(): void {
    this.conn.close();
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let BRANCHES = 0;
const uid = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;

/** The suite's document: three clips on one track, in engine form. */
function doc0(): Doc {
  return withKeys({
    name: "Host suite",
    tracks: [{ id: "V1", name: "V1", order: 0 }],
    timelineItems: [0, 1, 2].map((i) => ({ id: `c${i}`, trackId: "V1", type: "video", name: `c${i}`, startTime: i * 5, endTime: (i + 1) * 5, trimStart: 0, trimEnd: 5, opacity: 1 })),
  });
}
/** A change as a replica builds it (declared against `base` by the engine). */
function change(base: Doc, id: string, ops: Change["ops"], o: Partial<Change> = {}): Change {
  return { id, hash: "h", author: { kind: "human", id: "suite" }, branchId: "", base: { seq: 0, pending: [] }, ops, intent: null, kinds: null, policy: "merge", at: Date.now(), ...declareOps(base, ops), ...o };
}
const declareOps = (base: Doc, ops: Change["ops"]) => {
  const d = declare(cardboard, base, ops);
  return { paths: d.paths, reads: d.reads, spans: d.spans, trackOrder: d.trackOrder };
};
const setName = (id: string, name: string): Change["ops"][number] => ({ op: "set", path: ["timelineItems", id, "name"], value: name });

export function hostSuite(name: string, make: () => Promise<HostFixture>): void {
  describe(`SequencerHost behaviour: ${name}`, () => {
    let fx: HostFixture;
    const open: Client[] = [];
    before(async () => {
      fx = await make();
    });
    after(async () => {
      for (const c of open) c.close();
      await fx?.close();
    });
    const connect = async (token: string): Promise<Client> => {
      const c = new Client(await fx.transport.connect(fx.host.url, { token }));
      open.push(c);
      return c;
    };
    /** Share a fresh branch (adopt with no rows), say hello on it from `c`, return its id. */
    const share = async (c: Client): Promise<string> => {
      const branchId = `suite-${uid()}-${++BRANCHES}`;
      const d = doc0();
      c.send({ type: "adopt", branchId, n: 0, stateHash: "s0", rows: [], rec: { id: branchId, name: "main", forkOf: null, owner: "suite", kind: "main", sequencer: { kind: "server", since: 0 } }, doc0: d, closure: [] });
      await c.next("adopted", (m) => m.branchId === branchId);
      return branchId;
    };
    const hello = async (c: Client, branchId: string, have = 0, extra: Partial<sync.HelloMsg> = {}) => {
      c.send({ type: "hello", branchId, have, pending: [], rids: [], schemaVersion: 1, ...extra });
      return c.next("hello", (m) => m.branchId === branchId);
    };

    test("a connection needs a token the host's AuthProvider accepts", async () => {
      let refused = false;
      try {
        const c = await connect("not-a-token");
        // a host may accept the socket and close it at once: then nothing it sends is ever answered
        c.send({ type: "branchStatus", branchId: "x" });
        refused = !(await c.gets("status", undefined, 500)) || c.closed;
      } catch {
        refused = true;
      }
      assert.ok(refused, "an invalid token gets no answers");
    });

    test("adopt is idempotent; branchStatus answers it; hello returns the head and rows", async () => {
      const a = await connect(await fx.token("editor"));
      const branchId = await share(a);
      a.send({ type: "adopt", branchId, n: 0, stateHash: "s0", rows: [], rec: { id: branchId, name: "main", forkOf: null, owner: "suite", kind: "main", sequencer: { kind: "server", since: 0 } }, doc0: doc0(), closure: [] });
      assert.equal((await a.next("adopted", (m) => m.branchId === branchId && m.repeat === true)).since, 0, "the same upload gets the same answer");
      a.send({ type: "branchStatus", branchId });
      const st = await a.next("status", (m) => m.branchId === branchId);
      assert.deepEqual([st.adopted, st.adoptKey, st.head], [true, `${branchId}|0|s0`, 0]);
      const w = await hello(a, branchId);
      assert.deepEqual([w.head, w.rows.length], [0, 0]);
    });

    test("a push is fanned out to every subscriber, the pusher's row before its ack; in order, once each", async () => {
      const a = await connect(await fx.token("editor")), b = await connect(await fx.token("editor"));
      const branchId = await share(a);
      await hello(a, branchId);
      await hello(b, branchId);
      const d = doc0(), rid = `r${uid()}`;
      const changes = [0, 1, 2].map((i) => change(d, `${rid}.${i + 1}`, [setName(`c${i}`, `n${i}`)], { branchId, base: { seq: 0, pending: Array.from({ length: i }, (_, j) => `${rid}.${j + 1}`) } }));
      a.send({ type: "push", branchId, epoch: 1, changes });
      await a.next("ack", (m) => m.id === `${rid}.3`);
      await b.next("changes", (m) => m.rows.some((r) => r.id === `${rid}.3`));
      const seen = (c: Client) => c.inbox.filter((m) => m.type === "changes" || m.type === "ack").map((m) => (m.type === "ack" ? `ack:${m.seq}` : `row:${(m as sync.ChangesMsg).rows.map((r) => r.seq).join(",")}`));
      assert.deepEqual(seen(a), ["row:1", "ack:1", "row:2", "ack:2", "row:3", "ack:3"]);
      assert.deepEqual(seen(b), ["row:1", "row:2", "row:3"]);
    });

    test("a reject kills the rest of its epoch; a duplicate id is acked with its seq; viewers can't push", async () => {
      const a = await connect(await fx.token("editor")), b = await connect(await fx.token("editor"));
      const branchId = await share(a);
      await hello(a, branchId);
      await hello(b, branchId);
      const d = doc0(), ra = `a${uid()}`, rb = `b${uid()}`;
      a.send({ type: "push", branchId, epoch: 1, changes: [change(d, `${ra}.1`, [setName("c0", "a")], { branchId })] });
      await a.next("ack", (m) => m.id === `${ra}.1`);
      b.send({ type: "push", branchId, epoch: 5, changes: [change(d, `${rb}.1`, [setName("c0", "b")], { branchId }), change(d, `${rb}.2`, [setName("c1", "b")], { branchId, base: { seq: 0, pending: [`${rb}.1`] } })] });
      const rej = await b.next("reject", (m) => m.id === `${rb}.1`);
      assert.deepEqual([rej.reason, rej.concurrent.map((x) => x.seq)], ["overlap", [1]]);
      b.send({ type: "push", branchId, epoch: 5, changes: [change(d, `${rb}.3`, [setName("c2", "b")], { branchId })] });
      assert.equal(await b.gets("ack", (m) => m.id === `${rb}.3`, 400), false, "a later message of the dead epoch is ignored");
      b.send({ type: "push", branchId, epoch: 6, changes: [change(d, `${rb}.3`, [setName("c2", "b")], { branchId, base: { seq: 1, pending: [] } })] });
      await b.next("ack", (m) => m.id === `${rb}.3`);
      a.send({ type: "push", branchId, epoch: 2, changes: [change(d, `${ra}.1`, [setName("c0", "a")], { branchId })] });
      const dup = await a.next("ack", (m) => m.id === `${ra}.1` && m.duplicate === true);
      assert.equal(dup.seq, 1);
      const v = await connect(await fx.token("viewer"));
      await hello(v, branchId);
      v.send({ type: "push", branchId, epoch: 1, changes: [change(d, `v${uid()}.1`, [setName("c1", "v")], { branchId, base: { seq: 2, pending: [] } })] });
      assert.equal((await v.next("reject")).reason, "forbidden");
    });

    test("a replica id belongs to the credential that first used it; a reconnect with the same token reclaims it", async () => {
      const tokA = await fx.token("editor");
      const a = await connect(tokA), m = await connect(await fx.token("editor"));
      const branchId = await share(a);
      const rid = `r${uid()}`;
      await hello(a, branchId, 0, { rids: [rid] }); // claimed in hello, never pushed (R10-02)
      await hello(m, branchId);
      const d = doc0();
      m.send({ type: "push", branchId, epoch: 1, changes: [change(d, `${rid}.1`, [setName("c0", "forged")], { branchId })] });
      assert.equal((await m.next("reject")).reason, "foreign id");
      a.close();
      const a2 = await connect(tokA);
      await hello(a2, branchId);
      a2.send({ type: "push", branchId, epoch: 1, changes: [change(d, `${rid}.2`, [setName("c0", "mine")], { branchId })] });
      await a2.next("ack", (x) => x.id === `${rid}.2`);
    });

    test("withdraw spends an id: a late push of it is acked as withdrawn, never confirmed (H1)", async () => {
      const a = await connect(await fx.token("editor"));
      const branchId = await share(a);
      await hello(a, branchId);
      const rid = `w${uid()}`;
      a.send({ type: "withdraw", branchId, id: `${rid}.1`, base: 0, epoch: 1 });
      const ack = await a.next("ack", (m) => m.id === `${rid}.1`);
      assert.deepEqual([ack.withdrawn, ack.seq], [true, 1]);
      a.send({ type: "push", branchId, epoch: 2, changes: [change(doc0(), `${rid}.1`, [setName("c0", "late")], { branchId })] });
      const late = await a.next("ack", (m) => m.id === `${rid}.1` && m.epoch === 2);
      assert.deepEqual([late.withdrawn, late.seq], [true, 1]);
    });

    test("the K cap: a push more than 100 changes behind is rejected \"behind\" with its confirmed-id list", async () => {
      const a = await connect(await fx.token("editor")), x = await connect(await fx.token("editor"));
      const branchId = await share(a);
      await hello(a, branchId);
      await hello(x, branchId);
      const d = doc0(), rid = `k${uid()}`, xid = `x${uid()}`;
      x.send({ type: "push", branchId, epoch: 1, changes: [change(d, `${xid}.1`, [setName("c1", "x")], { branchId })] });
      await x.next("ack", (m) => m.id === `${xid}.1`);
      for (let i = 0; i < 101; i++) a.send({ type: "push", branchId, epoch: 1, changes: [change(d, `${rid}.${i + 1}`, [setName("c0", `n${i}`)], { branchId, base: { seq: i + 1, pending: [] } })] });
      await a.next("ack", (m) => m.id === `${rid}.101`, 20000);
      x.send({ type: "push", branchId, epoch: 2, changes: [change(d, `${xid}.2`, [setName("c2", "late")], { branchId, base: { seq: 0, pending: [] } }), change(d, `${xid}.1`, [setName("c1", "x")], { branchId, base: { seq: 0, pending: [] } })] });
      const r = await x.next("reject", (m) => m.epoch === 2);
      assert.equal(r.reason, "behind");
      assert.deepEqual(r.confirmed?.map((e) => [e.id, e.seq]), [[`${xid}.1`, 1]]);
    });

    test("presence reaches the branch's other subscribers only, and isn't stored", async () => {
      const a = await connect(await fx.token("editor")), b = await connect(await fx.token("editor")), c = await connect(await fx.token("editor"));
      const branchId = await share(a);
      await hello(a, branchId);
      await hello(b, branchId);
      a.send({ type: "presence", branchId, actor: { kind: "human", id: "alice" }, state: { at: 3 } });
      assert.deepEqual((await b.next("presence")).state, { at: 3 });
      assert.equal(await a.gets("presence"), false, "not echoed");
      assert.equal(await c.gets("presence"), false, "not sent to connections that never said hello on the branch");
      const w = await hello(c, branchId);
      assert.equal(w.head, 0, "nothing was written");
    });

    test("restart-safe: after a restart the log, dedup and rid bindings are intact, and connections that say hello again get fan-out", async (t) => {
      if (!fx.restart) return t.skip("this host has no restart hook");
      const tokA = await fx.token("editor"), tokB = await fx.token("editor");
      const a = await connect(tokA);
      const branchId = await share(a);
      await hello(a, branchId);
      const d = doc0(), rid = `s${uid()}`;
      a.send({ type: "push", branchId, epoch: 1, changes: [change(d, `${rid}.1`, [setName("c0", "before")], { branchId })] });
      await a.next("ack", (m) => m.id === `${rid}.1`);
      await fx.restart();
      const a2 = await connect(tokA), b2 = await connect(tokB), m2 = await connect(await fx.token("editor"));
      const w = await hello(a2, branchId);
      assert.deepEqual([w.head, w.rows.map((r) => r.id)], [1, [`${rid}.1`]]);
      await hello(b2, branchId);
      a2.send({ type: "push", branchId, epoch: 1, changes: [change(d, `${rid}.1`, [setName("c0", "before")], { branchId })] });
      assert.equal((await a2.next("ack", (m) => m.id === `${rid}.1`)).duplicate, true);
      await hello(m2, branchId);
      m2.send({ type: "push", branchId, epoch: 1, changes: [change(d, `${rid}.9`, [setName("c1", "forged")], { branchId, base: { seq: 1, pending: [] } })] });
      assert.equal((await m2.next("reject")).reason, "foreign id");
      a2.send({ type: "push", branchId, epoch: 2, changes: [change(d, `${rid}.2`, [setName("c2", "after")], { branchId, base: { seq: 1, pending: [] } })] });
      await b2.next("changes", (m) => m.rows.some((r) => r.id === `${rid}.2`));
    });

    test("two real SyncClients editing the same clip concurrently through the host converge on one log", async () => {
      const d = doc0();
      const owner = await connect(await fx.token("editor"));
      const branchId = await share(owner);
      const replicas = [0, 1].map(() => {
        const q = new sync.ReplicaQueue(cardboard);
        q.addBranch({ id: branchId, name: "main", kind: "main", sequencer: { kind: "server", since: 0 } }, d);
        return q;
      });
      const tokens = [await fx.token("editor"), await fx.token("editor")];
      const clients = replicas.map((q, i) => new sync.SyncClient({ queue: q, branchId, schemaVersion: 1, connect: () => fx.transport.connect(fx.host.url, { token: tokens[i]! }) }).start());
      try {
        assert.ok((await Promise.all(clients.map((c) => c.whenCaughtUp(5000)))).every(Boolean), "both caught up");
        // the same clip's time group from both sides (an overlap: one is rejected and rebased through merge3), plus
        // style edits of different clips (no overlap)
        replicas[0]!.commit(branchId, { id: `x${uid()}.1`, author: { kind: "human", id: "x" }, ops: [{ op: "set", path: ["timelineItems", "c1", "endTime"], value: 9.5 }, { op: "set", path: ["timelineItems", "c1", "trimEnd"], value: 4.5 }], at: Date.now() });
        replicas[1]!.commit(branchId, { id: `y${uid()}.1`, author: { kind: "human", id: "y" }, ops: [{ op: "set", path: ["timelineItems", "c1", "startTime"], value: 5.5 }, { op: "set", path: ["timelineItems", "c1", "trimStart"], value: 0.5 }], at: Date.now() });
        replicas[0]!.commit(branchId, { id: `x${uid()}.2`, author: { kind: "human", id: "x" }, ops: [setName("c0", "x")], at: Date.now() });
        replicas[1]!.commit(branchId, { id: `y${uid()}.2`, author: { kind: "human", id: "y" }, ops: [setName("c2", "y")], at: Date.now() });
        for (const c of clients) c.pump();
        const deadline = Date.now() + 10000;
        while (Date.now() < deadline && (replicas.some((q) => q.pending(branchId).length) || replicas[0]!.headSeq(branchId) !== replicas[1]!.headSeq(branchId) || replicas[0]!.headSeq(branchId) < 4)) await sleep(20);
        const [x, y] = replicas;
        assert.equal(x!.headSeq(branchId), 4, "four rows");
        assert.deepEqual(x!.rows(branchId).map((r) => r.id), y!.rows(branchId).map((r) => r.id), "one log");
        const state = (q: sync.ReplicaQueue) => JSON.stringify(q.confirmedState(branchId, q.headSeq(branchId)));
        assert.equal(state(x!), state(y!), "one state");
        const c1 = (x!.confirmedState(branchId, 4).timelineItems as Record<string, number>[]).find((i) => (i as unknown as { id: string }).id === "c1")!;
        assert.deepEqual([c1.startTime, c1.endTime, c1.trimStart, c1.trimEnd], [5.5, 9.5, 0.5, 4.5], "the two trims composed");
      } finally {
        for (const c of clients) c.stop();
      }
    });
  });
}
