// SequencerHost and Transport conformance (PLAN §3.1, §6.3, §12): what every host must do around the sequencer
// core, checked from outside through its Transport, exactly as a client sees it. The ordering rules themselves are
// the system suite's (sync-sequencer); these check the host's part: authentication before the sequencer, ordered
// delivery, fan-out, presence relay, replica ids bound to the device credential across reconnects, restart safety,
// and that the host adds no storage rows of its own (P5: one row per change).

import { describe, test, before, after } from "node:test";
import assert from "node:assert/strict";
import type { TransportConnection } from "@carton/core/plugins";
import type { sync } from "@carton/core";
import type { HostFixture } from "./index.ts";
import { rawWebSocket } from "./raw-ws.ts";

type Msg = sync.ServerMessage;

// A Cardboard-shaped branch: two tracks, one clip.
export const HOST_SUITE_DOC = {
  tracks: [{ id: "V1" }, { id: "T2" }],
  timelineItems: [{ id: "c0", trackId: "V1", startTime: 0, endTime: 5, trimStart: 0, trimEnd: 5, opacity: 1 }],
};

let branchN = 0;
const newBranch = () => `hs-${Date.now().toString(36)}-${(++branchN).toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
const ridOf = () => crypto.getRandomValues(new Uint8Array(12)).reduce((s, b) => s + b.toString(16).padStart(2, "0"), "");

// A client that records every message and can wait for one.
interface Client {
  conn: TransportConnection;
  got: Msg[];
  closed: string | null;
  wait(pred: (m: Msg) => boolean, what: string, ms?: number): Promise<Msg>;
  waitClose(ms?: number): Promise<string>;
}

async function client(fx: HostFixture, token: string, given?: TransportConnection): Promise<Client> {
  const conn = given ?? (await fx.transport.connect(fx.host.url, { token }));
  const waiters: { pred: (m: Msg) => boolean; res: (m: Msg) => void }[] = [];
  const closeWaiters: ((why: string) => void)[] = [];
  const c: Client = {
    conn,
    got: [],
    closed: null,
    wait(pred, what, ms = 10_000) {
      const hit = c.got.find(pred);
      if (hit) return Promise.resolve(hit);
      return new Promise((res, rej) => {
        const t = setTimeout(() => rej(new Error(`timed out waiting for ${what}; got ${c.got.map((m) => m.type).join(",")}`)), ms);
        waiters.push({ pred, res: (m) => { clearTimeout(t); res(m); } });
      });
    },
    waitClose(ms = 10_000) {
      if (c.closed !== null) return Promise.resolve(c.closed);
      return new Promise((res, rej) => {
        const t = setTimeout(() => rej(new Error("timed out waiting for close")), ms);
        closeWaiters.push((w) => { clearTimeout(t); res(w); });
      });
    },
  };
  conn.onMessage((m) => {
    c.got.push(m);
    for (let i = waiters.length - 1; i >= 0; i--) if (waiters[i]!.pred(m)) waiters.splice(i, 1)[0]!.res(m);
  });
  conn.onClose((why) => {
    c.closed = why;
    for (const f of closeWaiters.splice(0)) f(why);
  });
  return c;
}

const rec = (id: string) => ({ id, name: "main", forkOf: null, owner: "alice", kind: "main", sequencer: { kind: "server", since: 0 } });

// Shares a fresh branch through the protocol's own hand-off (`adopt`), as a client does.
async function share(c: Client, branchId: string, doc0: unknown = HOST_SUITE_DOC): Promise<void> {
  c.conn.send({ type: "adopt", branchId, n: 0, stateHash: "", rows: [], rec: rec(branchId), doc0, closure: [] } as unknown as sync.ClientMessage);
  const m = await c.wait((m) => (m.type === "adopted" || m.type === "adoptError") && (m as { branchId?: string }).branchId === branchId, "adopted");
  assert.equal(m.type, "adopted", JSON.stringify(m));
}

function hello(c: Client, branchId: string, have = 0, rids: string[] = []): Promise<Msg> {
  c.conn.send({ type: "hello", branchId, have, pending: [], rids, schemaVersion: 1 } as sync.ClientMessage);
  return c.wait((m) => m.type === "hello" && (m as sync.WelcomeMsg).branchId === branchId, "hello answer");
}

// A style edit on c0 (no span: the lww-able kind), declared as the engine declares it.
function styleChange(branchId: string, id: string, base: number, value: unknown, pending: string[] = []) {
  return {
    id, hash: "0".repeat(64), author: { kind: "human", id: "suite" }, branchId, base: { seq: base, pending },
    ops: [{ op: "set", path: ["timelineItems", "c0", "name"], value }], intent: null, kinds: null, policy: "merge", at: Date.now(),
    paths: ["timelineItems/c0/name"], reads: ["timelineItems/c0"], spans: [], trackOrder: [],
  };
}

// An inserted clip: a record row besides the change row (P5: 2 rows).
function insertChange(branchId: string, id: string, base: number, clipId: string, start: number) {
  const clip = { id: clipId, trackId: "V1", startTime: start, endTime: start + 1, trimStart: 0, trimEnd: 1, opacity: 1 };
  return {
    id, hash: "0".repeat(64), author: { kind: "human", id: "suite" }, branchId, base: { seq: base, pending: [] },
    ops: [{ op: "insert", path: ["timelineItems", clipId], value: clip }], intent: null, kinds: null, policy: "merge", at: Date.now(),
    paths: [`timelineItems/${clipId}`], reads: ["tracks/V1"], spans: [{ track: "V1", lo: start, hi: start + 1 }], trackOrder: [],
  };
}

const push = (c: Client, branchId: string, epoch: number, changes: unknown[]) =>
  c.conn.send({ type: "push", branchId, epoch, changes } as unknown as sync.ClientMessage);
const ackOf = (id: string) => (m: Msg) => (m.type === "ack" || m.type === "reject") && (m as sync.AckMsg).id === id;

export function sequencerHostSuite(name: string, make: () => Promise<HostFixture>): void {
  describe(`SequencerHost conformance: ${name}`, () => {
    let fx: HostFixture;
    const open: Client[] = [];
    const connect = async (token: string) => {
      const c = await client(fx, token);
      open.push(c);
      return c;
    };
    before(async () => {
      fx = await make();
    });
    after(async () => {
      for (const c of open) c.conn.close();
      await fx.close();
    });

    test("a token the host didn't issue never reaches the sequencer", async () => {
      await assert.rejects(fx.transport.connect(fx.host.url, { token: "not-a-token" }));
      await assert.rejects(fx.transport.connect(fx.host.url, { token: "" }));
      if (fx.tokenFor) {
        const other = await fx.tokenFor({ credential: "x/other-project", projectId: "another-project" });
        const refused = await fx.transport.connect(fx.host.url, { token: other }).then(
          async (c) => {
            // a host may accept the socket and refuse every message instead; either way nothing is sequenced
            const cl = { got: [] as Msg[] };
            c.onMessage((m) => cl.got.push(m));
            c.send({ type: "hello", branchId: "x", have: 0, pending: [], rids: [], schemaVersion: 1 } as sync.ClientMessage);
            await new Promise((r) => setTimeout(r, 300));
            c.close();
            return cl.got.every((m) => m.type === "error");
          },
          () => true,
        );
        assert.ok(refused, "a token for another project was served");
      }
    });

    test("an accepted change reaches every subscriber, the pusher before its ack", async () => {
      const b = newBranch();
      const alice = await connect(await fx.token("editor"));
      const bob = await connect(await fx.token("editor"));
      await share(alice, b);
      await hello(alice, b);
      await hello(bob, b);
      const id = `${ridOf()}.1`;
      push(alice, b, 1, [styleChange(b, id, 0, "first")]);
      const ack = (await alice.wait(ackOf(id), "ack")) as sync.AckMsg;
      assert.equal(ack.type, "ack", JSON.stringify(ack));
      assert.equal(ack.seq, 1);
      const rowAt = alice.got.findIndex((m) => m.type === "changes" && (m as sync.ChangesMsg).rows.some((r) => r.id === id));
      assert.ok(rowAt >= 0 && rowAt < alice.got.indexOf(ack), "the pusher gets the row before its ack");
      const seen = (await bob.wait((m) => m.type === "changes", "fan-out")) as sync.ChangesMsg;
      assert.equal(seen.rows[0]!.id, id);
      assert.equal(seen.rows[0]!.seq, 1);
    });

    // A Durable Object's SQLite allows 5 terms in a compound SELECT and 100 bound variables (node:sqlite: 500 and
    // 32766), so a statement built per id must stay within both on every host (web-demo REQ-3: a change touching
    // more clips than one statement's terms was answered "too many terms in compound SELECT" and stayed pending).
    test("a change touching 33 clips is sequenced, and a trim of all of them: every statement fits a Durable Object's SQLite", async () => {
      const b = newBranch();
      const c = await connect(await fx.token("editor"));
      const items = Array.from({ length: 33 }, (_, i) => ({ id: `c${i}`, trackId: "V1", startTime: i * 5, endTime: i * 5 + 5, trimStart: 0, trimEnd: 5, opacity: 1 }));
      await share(c, b, { tracks: HOST_SUITE_DOC.tracks, timelineItems: items });
      await hello(c, b);
      const rid = ridOf();
      const change = (n: number, field: string, value: (it: (typeof items)[number]) => unknown, spans: boolean) => ({
        id: `${rid}.${n}`, hash: "0".repeat(64), author: { kind: "human", id: "suite" }, branchId: b, base: { seq: n - 1, pending: [] },
        ops: items.map((it) => ({ op: "set", path: ["timelineItems", it.id, field], value: value(it) })), intent: null, kinds: null, policy: "merge", at: Date.now(),
        // a timing field also declares its record's group path (`#time`), as the engine does
        paths: items.flatMap((it) => (spans ? [`timelineItems/${it.id}/${field}`, `timelineItems/${it.id}/#time`] : [`timelineItems/${it.id}/${field}`])),
        reads: items.map((it) => `timelineItems/${it.id}`),
        spans: spans ? items.map((it) => ({ track: "V1", lo: it.startTime, hi: it.endTime })) : [], trackOrder: [],
      });
      for (const [n, ch] of [[1, change(1, "name", (it) => `renamed ${it.id}`, false)], [2, change(2, "endTime", (it) => it.endTime - 1, true)]] as const) {
        push(c, b, 1, [ch]);
        const a = (await c.wait(ackOf(ch.id), `ack ${n}`)) as sync.AckMsg;
        assert.equal(a.type, "ack", JSON.stringify(a));
        assert.equal(a.seq, n);
      }
    });

    test("one connection's messages are handled in order: 20 pipelined changes are acked 1..20", async () => {
      const b = newBranch();
      const c = await connect(await fx.token("editor"));
      await share(c, b);
      await hello(c, b);
      const rid = ridOf(), ids: string[] = [];
      for (let i = 1; i <= 20; i++) {
        ids.push(`${rid}.${i}`);
        push(c, b, 1, [styleChange(b, `${rid}.${i}`, i - 1, `v${i}`, [])]);
      }
      const acks = await Promise.all(ids.map((id) => c.wait(ackOf(id), `ack ${id}`)));
      assert.deepEqual(acks.map((a) => [a.type, (a as sync.AckMsg).seq]), ids.map((_, i) => ["ack", i + 1]));
      const order = c.got.filter((m) => m.type === "ack").map((m) => (m as sync.AckMsg).id);
      assert.deepEqual(order, ids, "acks in push order");
    });

    test("a viewer's push is refused and changes nothing", async () => {
      const b = newBranch();
      const owner = await connect(await fx.token("owner"));
      await share(owner, b);
      const viewer = await connect(await fx.token("viewer"));
      const w = (await hello(viewer, b)) as sync.WelcomeMsg;
      assert.equal(w.head, 0);
      const id = `${ridOf()}.1`;
      push(viewer, b, 1, [styleChange(b, id, 0, "nope")]);
      const answer = await viewer.wait((m) => m.type === "error" || ackOf(id)(m), "refusal");
      assert.notEqual(answer.type, "ack");
      const again = (await hello(await connect(await fx.token("editor")), b)) as sync.WelcomeMsg;
      assert.equal(again.head, 0, "nothing was confirmed");
    });

    test("presence goes to the branch's other subscribers, not the sender, and is never stored", async () => {
      const b = newBranch();
      const a = await connect(await fx.token("editor"));
      const p = await connect(await fx.token("editor"));
      const outsider = await connect(await fx.token("editor"));
      await share(a, b);
      await hello(a, b);
      await hello(p, b);
      const before = fx.rows ? await fx.rows() : null;
      a.conn.send({ type: "presence", branchId: b, actor: { kind: "human", id: "a" }, state: { at: 1.5, dragging: true } } as sync.ClientMessage);
      const got = (await p.wait((m) => m.type === "presence", "presence")) as sync.PresenceFanoutMsg;
      assert.equal(got.state?.at, 1.5);
      await new Promise((r) => setTimeout(r, 200));
      assert.ok(!a.got.some((m) => m.type === "presence"), "echoed to the sender");
      assert.ok(!outsider.got.some((m) => m.type === "presence"), "sent to a connection not on the branch");
      if (before) assert.equal((await fx.rows!()).rowsWritten - before.rowsWritten, 0, "presence wrote rows");
    });

    // A client that crashed or lost its network never sends presence(null): the host owes its peers the leave.
    const showing = async () => {
      const b = newBranch();
      const owner = await connect(await fx.token("owner"));
      await share(owner, b);
      // over a network, a bare socket that can vanish or go silent; in process, a connection that closes unannounced
      const token = await fx.token("editor");
      const raw = fx.host.url.startsWith("ws:") ? await rawWebSocket(fx.host.url, token) : null;
      const a = raw ? await client(fx, token, raw) : await connect(token);
      if (raw) open.push(a);
      const kill = () => (raw ? raw.kill() : a.conn.close());
      const p = await connect(await fx.token("editor"));
      const outsider = await connect(await fx.token("editor"));
      const elsewhere = newBranch();
      await share(owner, elsewhere);
      await hello(outsider, elsewhere);
      await hello(a, b);
      await hello(p, b);
      const human = { kind: "human", id: "a-crashes" }, agent = { kind: "agent", id: "a-crashes", agentId: "director-1" };
      a.conn.send({ type: "presence", branchId: b, actor: human, state: { at: 2, dragging: true, ghosts: [{ item: "c0", track: "V1", start: 2, end: 3 }] } } as sync.ClientMessage);
      a.conn.send({ type: "presence", branchId: b, actor: agent, state: { at: 4 } } as sync.ClientMessage);
      await p.wait((m) => m.type === "presence" && (m as sync.PresenceFanoutMsg).actor.kind === "agent", "the agent's presence");
      const left = (actor: { kind: string; id: string; agentId?: string }) => (m: Msg) =>
        m.type === "presence" && (m as sync.PresenceFanoutMsg).state === null && (m as sync.PresenceFanoutMsg).actor.kind === actor.kind && (m as sync.PresenceFanoutMsg).actor.id === actor.id && (m as sync.PresenceFanoutMsg).actor.agentId === actor.agentId;
      return { b, raw, kill, p, outsider, human, agent, left };
    };

    test("a connection that drops without a leave: its peers get `state: null` for each actor it showed", async () => {
      const { kill, p, outsider, human, agent, left } = await showing();
      kill(); // no close frame, no presence(null)
      await p.wait(left(human), "the human's leave", 5000);
      await p.wait(left(agent), "the agent's leave", 5000);
      await new Promise((r) => setTimeout(r, 200));
      assert.equal(p.got.filter((m) => m.type === "presence" && (m as sync.PresenceFanoutMsg).state === null).length, 2, "one leave each");
      assert.ok(!outsider.got.some((m) => m.type === "presence"), "a connection on another branch never saw it");
    });

    test("the leaves survive the host's hibernation: a connection that drops after a wake still owes them", async (t) => {
      if (!fx.hibernate) return t.skip("needs hibernate");
      const { kill, p, human, agent, left } = await showing();
      await fx.hibernate();
      kill();
      await p.wait(left(human), "the human's leave", 5000);
      await p.wait(left(agent), "the agent's leave", 5000);
    });

    test("a connection that goes silent (no close, no keepalive) is dropped within the host's timeout, and its presence leaves", async (t) => {
      if (!fx.presenceTimeoutMs || !fx.host.url.startsWith("ws:")) return t.skip("needs presenceTimeoutMs and a ws: host");
      const { p, human, agent, left } = await showing();
      // the raw client never pings and never answers a ping: as a laptop whose network went away
      const t0 = Date.now();
      await p.wait(left(human), "the human's leave", fx.presenceTimeoutMs + 5000);
      await p.wait(left(agent), "the agent's leave", 1000);
      assert.ok(Date.now() - t0 <= fx.presenceTimeoutMs + 5000);
    });

    // Round 2: a Durable Object took each wake for every socket's activity, so a room that hibernated between its
    // checks never found a silent socket.
    test("a silent connection is dropped within the timeout even when the host wakes from hibernation between its checks", async (t) => {
      if (!fx.presenceTimeoutMs || !fx.hibernate || !fx.host.url.startsWith("ws:")) return t.skip("needs presenceTimeoutMs, hibernate and a ws: host");
      const { p, human, left } = await showing();
      let done = false;
      const waking = (async () => {
        while (!done) {
          await fx.hibernate!();
          await new Promise((r) => setTimeout(r, 250));
        }
      })();
      try {
        await p.wait(left(human), "the human's leave", fx.presenceTimeoutMs + 5000);
      } finally {
        done = true;
        await waking;
      }
    });

    test("replica ids are bound to the device credential and survive a reconnect; another credential can't use them", async (t) => {
      if (!fx.tokenFor) return t.skip("needs tokenFor");
      const b = newBranch();
      const cred = `dev-${ridOf().slice(0, 8)}`, rid = ridOf();
      const first = await connect(await fx.tokenFor({ credential: `alice/${cred}`, account: "alice" }));
      await share(first, b);
      await hello(first, b, 0, [rid]);
      push(first, b, 1, [styleChange(b, `${rid}.1`, 0, "one")]);
      assert.equal((await first.wait(ackOf(`${rid}.1`), "ack 1")).type, "ack");
      first.conn.close();
      const again = await connect(await fx.tokenFor({ credential: `alice/${cred}`, account: "alice" }));
      await hello(again, b, 1, [rid]);
      push(again, b, 1, [styleChange(b, `${rid}.2`, 1, "two")]);
      assert.equal((await again.wait(ackOf(`${rid}.2`), "ack 2")).type, "ack", "the same device reclaims its rid");
      const thief = await connect(await fx.tokenFor({ credential: `mallory/${cred}x`, account: "mallory" }));
      await hello(thief, b, 2);
      push(thief, b, 1, [styleChange(b, `${rid}.3`, 2, "stolen")]);
      const r = (await thief.wait(ackOf(`${rid}.3`), "reject")) as sync.RejectMsg;
      assert.equal(r.type, "reject");
      assert.equal(r.reason, "foreign id");
    });

    // The people record (windows-sync R3): a device credential's person, so a generic "person" author resolves by its
    // change's rid. Every test here is in one project, so these use accounts of their own and look entries up by id.
    const personIn = (m: Msg, id: string) => ((m as { people?: sync.PersonRids[] }).people ?? []).find((p) => p.id === id);
    const peopleWith = (id: string, pred: (p: sync.PersonRids) => boolean) => (m: Msg) => m.type === "people" && !!personIn(m, id) && pred(personIn(m, id)!);
    const identify = (c: Client, branchId: string, id: string, name: string) => c.conn.send({ type: "identity", branchId, identity: { id, name } } as sync.ClientMessage);

    test("people: a replica names only its own account; its rids, a hand-off's too, reach the project before their rows; a rename reaches everyone", async (t) => {
      if (!fx.tokenFor) return t.skip("needs tokenFor");
      const acct = `pp${ridOf().slice(0, 10)}`, cred = `${acct}/dev-${ridOf().slice(0, 6)}`;
      const a = await connect(await fx.tokenFor({ credential: cred, account: acct }));
      const b = await connect(await fx.token("editor"));
      const bx = newBranch();
      await share(a, bx);
      // another account's name is refused, and the welcome still comes
      a.conn.send({ type: "hello", branchId: bx, have: 0, pending: [], rids: [], schemaVersion: 1, identity: { id: "someone-else", name: "Mallory" } } as sync.ClientMessage);
      const refused = (await a.wait((m) => m.type === "error", "the refusal")) as sync.ErrorMsg;
      assert.equal(refused.code, "forbidden");
      const w0 = (await a.wait((m) => m.type === "hello", "the welcome")) as sync.WelcomeMsg;
      assert.ok(Array.isArray(w0.people), "the welcome says this host keeps people");
      assert.equal(personIn(w0, "someone-else"), undefined);
      identify(a, bx, acct, "Pat");
      await a.wait(peopleWith(acct, (p) => p.name === "Pat"), "its own confirmation");
      const wb = (await hello(b, bx)) as sync.WelcomeMsg;
      assert.deepEqual(personIn(wb, acct), { id: acct, name: "Pat", rids: [] });
      // a hand-off of edits two earlier processes made before the share: their rids are told once it commits
      const r1 = ridOf(), r2 = ridOf(), b0 = newBranch();
      const rows = [{ ...styleChange(b0, `${r1}.1`, 0, "one"), seq: 1 }, { ...styleChange(b0, `${r2}.1`, 1, "two"), seq: 2 }];
      a.conn.send({ type: "adopt", branchId: b0, n: 2, stateHash: "", rows, rec: rec(b0), doc0: HOST_SUITE_DOC, closure: [] } as unknown as sync.ClientMessage);
      assert.equal((await a.wait((m) => (m.type === "adopted" || m.type === "adoptError") && (m as { branchId?: string }).branchId === b0, "adopted")).type, "adopted");
      await b.wait(peopleWith(acct, (p) => p.rids.includes(r1) && p.rids.includes(r2)), "the hand-off's rids");
      // a new process of the same device: its rid reaches b before the row it binds
      const a2 = await connect(await fx.tokenFor({ credential: cred, account: acct }));
      await hello(a2, bx);
      const r3 = ridOf();
      push(a2, bx, 1, [styleChange(bx, `${r3}.1`, 0, "three")]);
      await b.wait((m) => m.type === "changes" && (m as sync.ChangesMsg).rows.some((r) => r.id === `${r3}.1`), "the new process's row");
      const told = b.got.findIndex(peopleWith(acct, (p) => p.rids.includes(r3)));
      const row3 = b.got.findIndex((m) => m.type === "changes" && (m as sync.ChangesMsg).rows.some((r) => r.id === `${r3}.1`));
      assert.ok(told >= 0 && told < row3, `the rid told at ${told}, its row at ${row3}`);
      // a rename reaches every connection, the sender's own
      identify(a, bx, acct, "Pat B.");
      for (const c of [a, a2, b]) await c.wait(peopleWith(acct, (p) => p.name === "Pat B."), "the rename");
      // a joiner's welcome: the person, with every rid that device used
      const j = await connect(await fx.token("viewer"));
      const wj = personIn(await hello(j, b0), acct)!;
      assert.equal(wj.name, "Pat B.");
      for (const rid of [r1, r2, r3]) assert.ok(wj.rids.includes(rid), rid);
    });

    test("people are kept by the host: a welcome after a hibernation or a restart still names them, and a rename still reaches everyone", async (t) => {
      if (!fx.tokenFor || (!fx.hibernate && !fx.restart)) return t.skip("needs tokenFor, and hibernate or restart");
      const acct = `pk${ridOf().slice(0, 10)}`, cred = `${acct}/dev-${ridOf().slice(0, 6)}`;
      const token = await fx.tokenFor({ credential: cred, account: acct });
      const a = await connect(token);
      const bx = newBranch();
      await share(a, bx);
      const rid = ridOf();
      a.conn.send({ type: "hello", branchId: bx, have: 0, pending: [], rids: [rid], schemaVersion: 1, identity: { id: acct, name: "Kim" } } as sync.ClientMessage);
      const w = (await a.wait((m) => m.type === "hello", "the welcome")) as sync.WelcomeMsg;
      assert.deepEqual(personIn(w, acct), { id: acct, name: "Kim", rids: [rid] }, "the sender's own welcome holds it");
      if (fx.hibernate) {
        const b = await connect(await fx.token("editor"));
        await hello(b, bx);
        await fx.hibernate();
        const late = await connect(await fx.token("viewer"));
        assert.deepEqual(personIn(await hello(late, bx), acct), { id: acct, name: "Kim", rids: [rid] }, "after a wake");
        identify(a, bx, acct, "Kim L."); // from a socket that slept through it, to one that did too
        await b.wait(peopleWith(acct, (p) => p.name === "Kim L." && p.rids.includes(rid)), "the rename after a wake");
      }
      if (fx.restart) {
        await fx.restart();
        await a.waitClose(30_000);
        const again = await connect(await fx.token("viewer"));
        const p = personIn(await hello(again, bx), acct);
        assert.ok(p && p.rids.includes(rid) && p.name.startsWith("Kim"), JSON.stringify(p));
      }
    });

    // People review round 1: the cap lived in the sequencer's memory, so each wake gave a socket a fresh burst.
    test("changes to a person are capped per connection, and a hibernation doesn't reset the cap", async (t) => {
      if (!fx.tokenFor || !fx.hibernate) return t.skip("needs tokenFor and hibernate");
      const acct = `pc${ridOf().slice(0, 10)}`, cred = `${acct}/dev-${ridOf().slice(0, 6)}`;
      const a = await connect(await fx.tokenFor({ credential: cred, account: acct }));
      const bx = newBranch();
      await share(a, bx);
      await hello(a, bx);
      for (let i = 0; i < 5; i++) {
        identify(a, bx, acct, `Cap ${i}`);
        await a.wait(peopleWith(acct, (p) => p.name === `Cap ${i}`), `rename ${i}`);
      }
      const capped = (m: Msg) => m.type === "error" && /changed too often/.test((m as sync.ErrorMsg).reason);
      identify(a, bx, acct, "over the cap");
      await a.wait(capped, "the cap");
      await fx.hibernate();
      a.got.length = 0;
      identify(a, bx, acct, "after the wake");
      const m = await a.wait((m) => capped(m) || peopleWith(acct, (p) => p.name === "after the wake")(m), "the cap, still");
      assert.equal(m.type, "error", "the woken room still caps the socket");
    });

    // Comments (REQ-C1, @carton/comments): their own messages and tables beside the sequencer's, never changes. Every
    // test is in the one project the suite shares, so each uses cuts and comment ids of its own.
    type CommentRow = { id: string; cut: string; body: string; seq?: number; author: { id: string; name: string } };
    let commentN = 0;
    const commentId = () => `cm-${Date.now().toString(36)}-${(++commentN).toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    const subscribe = async (c: Client, branchId: string) => {
      c.conn.send({ type: "comments", branchId, since: 0 } as unknown as sync.ClientMessage);
      return c.wait((m) => m.type === ("comments" as string) && (m as { reply?: boolean }).reply === true, "the comments catch-up");
    };
    /** Every row the catch-up from 0 holds, page by page. */
    const catchUp = async (c: Client, branchId: string): Promise<CommentRow[]> => {
      const rows: CommentRow[] = [];
      let since = 0;
      for (let i = 0; i < 50; i++) {
        const seen = c.got.length;
        c.conn.send({ type: "comments", branchId, since } as unknown as sync.ClientMessage);
        await c.wait((m) => c.got.indexOf(m) >= seen && m.type === ("comments" as string) && (m as { reply?: boolean }).reply === true, "a comments page");
        const page = c.got.slice(seen).find((m) => m.type === ("comments" as string) && (m as { reply?: boolean }).reply === true) as unknown as { rows: CommentRow[]; head: number; more?: boolean; retryMs?: number };
        if (page.retryMs) {
          await new Promise((r) => setTimeout(r, page.retryMs));
          continue;
        }
        rows.push(...page.rows);
        if (!page.more) return rows;
        since = page.head;
      }
      throw new Error("the catch-up never ended");
    };
    let opN = 0;
    const post = async (c: Client, branchId: string, id: string, patch: Record<string, unknown>) => {
      const n = ++opN;
      c.conn.send({ type: "comment", branchId, n, id, patch: { at: Date.now(), author: { id: "claimed", name: "Claimed" }, ...patch }, op: `op-${n}-${Math.random().toString(36).slice(2, 8)}` } as unknown as sync.ClientMessage);
      return (await c.wait((m) => m.type === ("commentAnswer" as string) && (m as { n?: number }).n === n, `the answer to comment ${id}`)) as unknown as { row?: CommentRow; refused?: string; retryMs?: number };
    };
    const fannedOut = (id: string, pred: (r: CommentRow) => boolean = () => true) => (m: Msg) =>
      m.type === ("comments" as string) && !(m as { reply?: boolean }).reply && ((m as unknown as { rows: CommentRow[] }).rows ?? []).some((r) => r.id === id && pred(r));

    test("comments: a comment reaches every connection that asked for them, the writer's answer holds the row under its session's account; only the author edits; a viewer reads and can't write", async () => {
      const cut = newBranch();
      const [a, b, v, quiet] = await Promise.all([fx.token("editor"), fx.token("editor"), fx.token("viewer"), fx.token("editor")].map(async (t) => connect(await t)));
      for (const c of [a, b, v]) await subscribe(c, cut);
      const id = commentId();
      const made = await post(a, cut, id, { add: { body: "Trim the intro", cut, at: 1 } });
      assert.ok(made.row, JSON.stringify(made));
      assert.notEqual(made.row.author.id, "claimed", "the author is the session's account, never the claim");
      for (const c of [b, v]) await c.wait(fannedOut(id), "the comment, fanned out");
      // the viewer reads, and is refused writing
      assert.equal((await post(v, cut, commentId(), { add: { body: "x", cut, at: 1 } })).refused, "forbidden");
      // only the author edits
      assert.equal((await post(b, cut, id, { body: "not mine to change" })).refused, "forbidden");
      const edited = await post(a, cut, id, { body: "Trim the intro by 2 s" });
      assert.equal(edited.row?.body, "Trim the intro by 2 s");
      await b.wait(fannedOut(id, (r) => r.body === "Trim the intro by 2 s"), "the edit, fanned out");
      // a connection that never asked for comments gets none
      assert.equal(quiet.got.some((m) => m.type === ("comments" as string)), false);
    });

    test("comments: a reader scoped to a Published cut (a watch link) reads only that cut's comments, in its catch-up and as they come", async (t) => {
      if (!fx.tokenFor) return t.skip("needs tokenFor");
      const pub = newBranch(), other = newBranch();
      const watch = await connect(await fx.tokenFor({ credential: `w${ridOf().slice(0, 8)}/watch`, role: "viewer", branches: [pub] }));
      watch.conn.send({ type: "comments", branchId: other, since: 0 } as unknown as sync.ClientMessage);
      const refused = await watch.wait((m) => m.type === "error" || m.type === ("comments" as string), "the answer to another cut");
      if (refused.type !== "error") return t.skip("the fixture's tokenFor doesn't scope tokens to cuts");
      const a = await connect(await fx.token("editor"));
      const onPub = commentId(), onOther = commentId();
      assert.ok((await post(a, pub, onPub, { add: { body: "on the published cut", cut: pub, at: 1 } })).row);
      assert.ok((await post(a, other, onOther, { add: { body: "on Main", cut: other, at: 1 } })).row);
      const seen = (await catchUp(watch, pub)).map((r) => r.id);
      assert.ok(seen.includes(onPub), "its cut's comment");
      assert.ok(!seen.includes(onOther), "never another cut's");
      const later = commentId(), laterOther = commentId();
      await post(a, other, laterOther, { add: { body: "later, on Main", cut: other, at: 2 } });
      await post(a, pub, later, { add: { body: "later, published", cut: pub, at: 2 } });
      await watch.wait(fannedOut(later), "its cut's new comment");
      assert.equal(watch.got.some(fannedOut(laterOther)), false, "another cut's new comment never reaches it");
      assert.equal(watch.got.some(fannedOut(onOther)), false);
    });

    test("comments: a burst past a connection's cap is refused `rate-limited`, saying when to retry; others' are unaffected", async () => {
      const cut = newBranch();
      const [a, b] = await Promise.all([fx.token("editor"), fx.token("editor")].map(async (t) => connect(await t)));
      const answers = await Promise.all(Array.from({ length: 14 }, (_, i) => post(a, cut, commentId(), { add: { body: `burst ${i}`, cut, at: i } })));
      const limited = answers.filter((x) => x.refused === "rate-limited");
      assert.ok(limited.length >= 1 && limited.every((x) => (x.retryMs ?? 0) > 0), JSON.stringify(answers.map((x) => x.refused ?? "ok")));
      assert.ok(answers.filter((x) => x.row).length >= 10, "the burst's first ten");
      assert.ok((await post(b, cut, commentId(), { add: { body: "another connection", cut, at: 1 } })).row);
    });

    test("comments are kept by the host: after a hibernation a subscription still gets others' comments; after a restart the rows are still there", async (t) => {
      if (!fx.hibernate && !fx.restart) return t.skip("needs hibernate or restart");
      const cut = newBranch();
      const [a, b] = await Promise.all([fx.token("editor"), fx.token("editor")].map(async (t) => connect(await t)));
      await subscribe(a, cut);
      const first = commentId(), second = commentId();
      assert.ok((await post(b, cut, first, { add: { body: "before", cut, at: 1 } })).row);
      await a.wait(fannedOut(first), "the comment before");
      if (fx.hibernate) {
        // subscribed just now (well within the host's activity grain), then the host sleeps: the subscription rides in
        // what the host keeps with the socket
        await fx.hibernate();
        assert.ok((await post(b, cut, second, { add: { body: "after the wake", cut, at: 2 } })).row);
        await a.wait(fannedOut(second), "a comment after the wake");
      }
      if (fx.restart) {
        await fx.restart();
        await a.waitClose(30_000);
        const again = await connect(await fx.token("viewer"));
        const ids = (await catchUp(again, cut)).map((r) => r.id);
        assert.ok(ids.includes(first), "kept across the restart");
        if (fx.hibernate) assert.ok(ids.includes(second));
      }
    });

    test("a duplicate push is acked with the original seq", async () => {
      const b = newBranch();
      const c = await connect(await fx.token("editor"));
      await share(c, b);
      await hello(c, b);
      const id = `${ridOf()}.1`;
      push(c, b, 1, [styleChange(b, id, 0, "x")]);
      await c.wait(ackOf(id), "ack");
      c.got.length = 0;
      push(c, b, 2, [styleChange(b, id, 0, "x")]);
      const dup = (await c.wait(ackOf(id), "duplicate ack")) as sync.AckMsg;
      assert.equal(dup.type, "ack");
      assert.equal(dup.seq, 1);
      assert.equal(dup.duplicate, true);
    });

    test("the host adds no rows of its own: 1 row per style change, 2 per insert, 0 per hello again (P5, §17)", async (t) => {
      if (!fx.rows) return t.skip("the host can't count rows");
      const b = newBranch();
      const c = await connect(await fx.token("editor"));
      await share(c, b);
      const rid = ridOf();
      await hello(c, b, 0, [rid]);
      let before = await fx.rows();
      push(c, b, 1, [styleChange(b, `${rid}.1`, 0, "a")]);
      await c.wait(ackOf(`${rid}.1`), "ack");
      let after = await fx.rows();
      assert.equal(after.rowsWritten - before.rowsWritten, 1, "a style change");
      before = after;
      push(c, b, 1, [insertChange(b, `${rid}.2`, 1, "c9", 10)]);
      assert.equal((await c.wait(ackOf(`${rid}.2`), "ack")).type, "ack");
      after = await fx.rows();
      assert.equal(after.rowsWritten - before.rowsWritten, 2, "an insert");
      before = after;
      await hello(c, b, 2, [rid]);
      after = await fx.rows();
      assert.equal(after.rowsWritten - before.rowsWritten, 0, "a second hello with the same rids");
    });

    test("a comment costs 4 rows written, new or changed (its row, its place in the stream, the old place's delete or the count, the op)", async (t) => {
      if (!fx.rows) return t.skip("the host can't count rows");
      const cut = newBranch();
      const c = await connect(await fx.token("editor"));
      assert.ok((await post(c, cut, commentId(), { add: { body: "warm-up: the tables exist", cut, at: 1 } })).row);
      const id = commentId();
      let before = await fx.rows();
      assert.ok((await post(c, cut, id, { add: { body: "a new comment", cut, at: 1 } })).row);
      let after = await fx.rows();
      assert.equal(after.rowsWritten - before.rowsWritten, 4, "a new comment");
      before = after;
      assert.equal((await post(c, cut, id, { body: "edited" })).row?.body, "edited");
      after = await fx.rows();
      assert.equal(after.rowsWritten - before.rowsWritten, 4, "an edit");
    });

    test("restart-safe: after a restart the head, the rows and duplicate detection are the same", async (t) => {
      if (!fx.restart) return t.skip("no restart()");
      const b = newBranch();
      // one device throughout: its token still verifies after the restart, and its rid stays bound to it
      const token = await fx.token("editor");
      const c = await connect(token);
      await share(c, b);
      await hello(c, b);
      const rid = ridOf();
      for (let i = 1; i <= 3; i++) push(c, b, 1, [styleChange(b, `${rid}.${i}`, i - 1, i)]);
      await c.wait(ackOf(`${rid}.3`), "ack 3");
      await fx.restart();
      const why = await c.waitClose(30_000);
      assert.equal(typeof why, "string", "the old connection closed");
      const d = await connect(token);
      const w = (await hello(d, b)) as sync.WelcomeMsg;
      assert.equal(w.head, 3);
      assert.deepEqual(w.rows.map((r) => r.id), [1, 2, 3].map((i) => `${rid}.${i}`));
      push(d, b, 1, [styleChange(b, `${rid}.2`, 1, 2)]);
      const dup = (await d.wait(ackOf(`${rid}.2`), "duplicate")) as sync.AckMsg;
      assert.equal(dup.seq, 2);
      assert.equal(dup.duplicate, true);
    });
  });
}

export function transportSuite(name: string, make: () => Promise<HostFixture>): void {
  describe(`Transport conformance: ${name}`, () => {
    let fx: HostFixture;
    before(async () => {
      fx = await make();
    });
    after(async () => {
      await fx.close();
    });

    // (Presence would make a convenient stream, but the sequencer caps it per connection, so ordered changes do.)
    test("messages arrive whole and in order: 200 pipelined changes, acked and fanned out in sequence", async () => {
      const b = newBranch();
      const a = await client(fx, await fx.token("editor"));
      const p = await client(fx, await fx.token("editor"));
      await share(a, b);
      await hello(a, b);
      await hello(p, b);
      const rid = ridOf(), ids: string[] = [];
      for (let i = 1; i <= 200; i++) {
        ids.push(`${rid}.${i}`);
        push(a, b, 1, [styleChange(b, `${rid}.${i}`, i - 1, i)]);
      }
      await a.wait(ackOf(`${rid}.200`), "the 200th ack", 60_000);
      assert.deepEqual(a.got.filter((m) => m.type === "ack").map((m) => (m as sync.AckMsg).id), ids, "acks in push order");
      await p.wait((m) => m.type === "changes" && (m as sync.ChangesMsg).rows.some((r) => r.id === `${rid}.200`), "the 200th row", 60_000);
      const rows = p.got.filter((m) => m.type === "changes").flatMap((m) => (m as sync.ChangesMsg).rows);
      assert.deepEqual(rows.map((r) => [r.id, r.seq]), ids.map((id, i) => [id, i + 1]), "rows in sequence, each once");
      a.conn.close();
      p.conn.close();
    });

    test("a large message (a 300 KB change) arrives whole", async () => {
      const b = newBranch();
      const a = await client(fx, await fx.token("editor"));
      const p = await client(fx, await fx.token("editor"));
      await share(a, b);
      await hello(a, b);
      await hello(p, b);
      const big = "ü".repeat(150_000);
      const id = `${ridOf()}.1`;
      push(a, b, 1, [styleChange(b, id, 0, big)]);
      assert.equal((await a.wait(ackOf(id), "ack")).type, "ack");
      const row = ((await p.wait((m) => m.type === "changes", "row")) as sync.ChangesMsg).rows[0]!;
      assert.equal((row.ops[0] as { value: string }).value, big);
      a.conn.close();
      p.conn.close();
    });

    test("close: onClose fires exactly once, nothing is delivered after it, send is a no-op", async () => {
      const b = newBranch();
      const a = await client(fx, await fx.token("editor"));
      await share(a, b);
      let closes = 0;
      a.conn.onClose(() => closes++);
      a.conn.close();
      a.conn.close();
      await new Promise((r) => setTimeout(r, 100));
      assert.equal(closes, 1);
      assert.equal(a.conn.open, false);
      const n = a.got.length;
      a.conn.send({ type: "hello", branchId: b, have: 0, pending: [], rids: [], schemaVersion: 1 } as sync.ClientMessage);
      await new Promise((r) => setTimeout(r, 200));
      assert.equal(a.got.length, n);
    });

    test("connect honours an aborted signal", async () => {
      const ac = new AbortController();
      ac.abort();
      await assert.rejects(fx.transport.connect(fx.host.url, { token: await fx.token("editor"), signal: ac.signal }));
    });
  });
}
