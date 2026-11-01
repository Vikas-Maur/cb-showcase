// Live sync through a host, end to end, as users run it: two replicas, each core's ReplicaQueue with its SyncClient,
// over the host's Transport. They edit one cut at once, including the same clip, and must end on the same confirmed
// state with every change confirmed once. Then the host restarts under them (when the fixture can), and the clients
// reconnect on their own and keep syncing. The protocol's own scenarios are the system suite's; this checks that a
// host carries a real client correctly.

import { describe, test, after } from "node:test";
import assert from "node:assert/strict";
import { defineSchema, sync, type Doc } from "@carton/core";
import type { HostFixture } from "./index.ts";

const TL = { collection: "timelineItems", lanes: "tracks", lane: "trackId", start: "startTime", end: "endTime", source: "trimStart", sourceEnd: "trimEnd", speed: "playbackSpeed" };
const schema = defineSchema({
  collections: {
    tracks: { key: "id", seq: true },
    timelineItems: { key: "id", parent: { field: "trackId", collection: "tracks" }, groups: [{ name: "time", fields: ["startTime", "endTime", "trimStart", "trimEnd", "playbackSpeed"] }] },
  },
  timeline: TL,
});
const clip = (id: string, s: number, e: number, track = "V1") => ({ id, trackId: track, startTime: s, endTime: e, trimStart: 0, trimEnd: e - s, opacity: 1, name: id });
const DOC0 = { tracks: [{ id: "V1" }, { id: "V2" }], timelineItems: [clip("c0", 0, 5), clip("c1", 10, 15), clip("c2", 20, 25, "V2")] } as unknown as Doc;

async function until(cond: () => boolean, what: string, dump: () => string, ms = 30_000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error(`timed out: ${what}\n${dump()}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

async function share(f: HostFixture, branch: string): Promise<void> {
  // the server adopts the cut (§5.3) from a raw connection, as the hand-off upload does
  const owner = await f.transport.connect(f.host.url, { token: await f.token("owner") });
  const adopted = new Promise((ok) => owner.onMessage((m) => m.type === "adopted" && ok(m)));
  owner.send({ type: "adopt", branchId: branch, n: 0, stateHash: "", rows: [], rec: { id: branch, name: "main", forkOf: null, owner: "owner", kind: "main", sequencer: { kind: "server", since: 0 } }, doc0: DOC0, closure: [] } as unknown as sync.ClientMessage);
  await adopted;
  owner.close();
}

async function makeReplica(f: HostFixture, branch: string, who: string, clients: sync.SyncClient[]) {
  const q = new sync.ReplicaQueue(schema);
  q.addBranch({ id: branch, name: "main", kind: "main", sequencer: { kind: "server", since: 0 } }, DOC0);
  const token = await f.token("editor"); // one device per replica, kept across a restart
  const events: sync.SyncEvent[] = [];
  const blobs = f.clientBlobs?.(token);
  const client = sync.createSyncClient(q, { transport: f.transport, url: f.host.url, token, branchId: branch, schemaVersion: 1, backoffMs: 100, onEvent: (e) => events.push(e), ...(blobs ? { blobs } : {}) });
  clients.push(client);
  client.start();
  const rid = crypto.getRandomValues(new Uint8Array(12)).reduce((s, b) => s + b.toString(16).padStart(2, "0"), "");
  let n = 0;
  // the owner (core's History) commits, then tells its one pusher to push
  const commit = (ops: sync.CommitInput["ops"]) => {
    q.commit(branch, { id: `${rid}.${++n}`, author: { kind: "human", id: who }, ops, at: Date.now() });
    client.pump();
  };
  return { q, client, events, commit, settled: () => q.pending(branch).length === 0 };
}

export function liveSyncSuite(name: string, make: () => Promise<HostFixture>): void {
  describe(`Live sync through the host: ${name}`, () => {
    const clients: sync.SyncClient[] = [];
    let fx: HostFixture | null = null;
    after(async () => {
      for (const c of clients) c.stop();
      await fx?.close();
    });

    test("two replicas converge through a same-field clash and a host restart, every change confirmed once", async () => {
      fx = await make();
      const f = fx;
      const branch = `live-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
      await share(f, branch);

      const replica = (who: string) => makeReplica(f, branch, who, clients);
      const a = await replica("alice"), b = await replica("bob");
      const dump = () => JSON.stringify({ a: { head: a.q.headSeq(branch), pending: a.q.pending(branch).length, ev: a.events.slice(-12) }, b: { head: b.q.headSeq(branch), pending: b.q.pending(branch).length, ev: b.events.slice(-12) } });
      await until(() => a.client.online && b.client.online, "both online", dump);

      a.commit([{ op: "set", path: ["timelineItems", "c0", "opacity"], value: 0.5 }]);
      b.commit([{ op: "set", path: ["timelineItems", "c2", "opacity"], value: 0.25 }]);
      a.commit([{ op: "set", path: ["timelineItems", "c1", "name"], value: "Alice's title" }]);
      b.commit([{ op: "set", path: ["timelineItems", "c1", "name"], value: "Bob's title" }]);
      await until(() => a.settled() && b.settled() && a.q.headSeq(branch) === b.q.headSeq(branch) && a.q.headSeq(branch) >= 3, "both settled on one head", dump);
      const head1 = a.q.headSeq(branch);
      assert.deepEqual(a.q.confirmedState(branch, head1), b.q.confirmedState(branch, head1), "the same confirmed state");
      const ids = a.q.rows(branch).filter((r) => !r.placeholder).map((r) => r.id);
      assert.equal(new Set(ids).size, ids.length, "every change confirmed once");

      if (!f.restart) return;
      await f.restart();
      a.commit([{ op: "set", path: ["timelineItems", "c0", "name"], value: "after restart" }]);
      await until(() => a.settled() && b.q.headSeq(branch) === a.q.headSeq(branch) && a.q.headSeq(branch) > head1, "synced after the restart", dump, 60_000);
      const head2 = a.q.headSeq(branch);
      assert.deepEqual(a.q.confirmedState(branch, head2), b.q.confirmedState(branch, head2));
      const c0 = (b.q.confirmedState(branch, head2) as unknown as { timelineItems: { id: string; name: string }[] }).timelineItems.find((c) => c.id === "c0");
      assert.equal(c0?.name, "after restart");
    });

    test("a big change (33 MiB unless the host caps lower) travels as envelopes, up to the host and down to the other replica", async (t) => {
      const f = fx ?? (fx = await make());
      if (!f.clientBlobs) return t.skip("the host gives clients no blob store for envelopes");
      const branch = `big-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
      await share(f, branch);
      const a = await makeReplica(f, branch, "alice", clients), b = await makeReplica(f, branch, "bob", clients);
      const dump = () => JSON.stringify({ a: { head: a.q.headSeq(branch), pending: a.q.pending(branch).length, ev: a.events.slice(-8) }, b: { head: b.q.headSeq(branch), ev: b.events.slice(-8) } }).slice(0, 2000);
      await until(() => a.client.online && b.client.online, "both online", dump);
      // over 32 MiB, Cloudflare's own WebSocket cap, it only fits as an envelope; a host that caps messages lower for
      // memory (a Durable Object) says how big it carries, still far over the 1 MiB envelope threshold
      const notes = "envelope ".repeat(Math.ceil((f.bigMessageBytes ?? 33 << 20) / 9));
      a.commit([{ op: "set", path: ["timelineItems", "c2", "notes"], value: notes }]);
      await until(() => a.settled() && b.q.headSeq(branch) === a.q.headSeq(branch) && a.q.headSeq(branch) >= 1, "the 33 MiB change confirmed and fanned out", dump, 180_000);
      const got = (b.q.confirmedState(branch, b.q.headSeq(branch)) as unknown as { timelineItems: { id: string; notes?: string }[] }).timelineItems.find((c) => c.id === "c2");
      assert.equal(got?.notes?.length, notes.length);
      assert.ok(got?.notes === notes, "the other replica got different bytes");
      // and small edits keep flowing on the same connections after it
      b.commit([{ op: "set", path: ["timelineItems", "c0", "name"], value: "after the big one" }]);
      await until(() => b.settled() && a.q.headSeq(branch) === b.q.headSeq(branch), "a small edit after the envelope", dump);
    });
  });
}
