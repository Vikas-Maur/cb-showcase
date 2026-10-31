// The oversized-message envelope end to end: one change of 33 MiB through the in-process host, whose transport refuses
// any message over 32 MiB (as a WebSocket host's would). With the blob store on both sides the change is pushed as an
// envelope, confirmed, fanned out as an envelope, and caught up by a replica that joins afterwards, with no connection
// lost. The controls: the transport does refuse a message over 32 MiB (it closes the connection), and a client without
// the blob store rejects such a change itself as too large, so it never strands the edits after it.
// And catch-up by pages of at most 4 MiB: a replica joining after many large changes asks again until it has them all.
import test from "node:test";
import assert from "node:assert/strict";
import { createMemoryBlobStore } from "@carton/blob-memory";
import type { Transport } from "@carton/core/plugins";
import { item, set, sharedCutWorld, until } from "./shared-cuts.ts";

const MiB = 1 << 20;
/** The transport, counting the hellos sent through it (one per catch-up page). */
const countingHellos = (seen: string[]) => (t: Transport): Transport => ({
  async connect(url, opts) {
    const c = await t.connect(url, opts);
    return {
      get open() { return c.open; },
      send: (m) => (seen.push(m.type), c.send(m)),
      onMessage: (l) => c.onMessage(l),
      onClose: (l) => c.onClose(l),
      close: () => c.close(),
    };
  },
});
/** One string over the transport's 32 MiB cap (ASCII: 1 byte per character in JSON and in memory). */
const payload = () => "0123456789abcdef".repeat((33 * MiB) / 16);

export function register(): void {
  test("envelope: a 33 MiB change crosses a 32 MiB transport as envelopes: pushed, confirmed, fanned out, caught up by a late joiner", async () => {
    const blobs = createMemoryBlobStore();
    const { host, a, b, replica, close } = await sharedCutWorld({ blobs });
    try {
      const big = payload();
      const id = a.commit([set("c0", "name", big)]);
      const out = await a.cut.waitFor(id, 60_000);
      assert.deepEqual(out, { status: "confirmed", id, seq: 1 });
      await until(() => b.cut.queue.headSeq("cut-main") === 1, 60_000, "bob receives the row");
      assert.equal(item(b.head(), "c0").name, big, "bob holds the 33 MiB value");
      // a replica joining now catches up from nothing: its welcome carries the row, over the cap
      const c = replica("carol");
      assert.ok(await c.cut.connect({ nonce: "nc", timeoutMs: 60_000 }), "carol caught up");
      assert.equal(item(c.head(), "c0").name, big);
      assert.equal(host.tooBig, 0, "the transport never carried a message over its cap");
      for (const r of [a, b, c]) assert.equal(r.cut.sync!.stats.reconnects, 1, "no connection was lost");
      assert.ok(a.cut.sync!.stats.envelopesSent >= 1, "alice's push went as an envelope");
      for (const r of [b, c]) assert.ok(r.cut.sync!.stats.envelopesReceived >= 1);
      assert.ok(host.sequencer.stats.envelopesIn >= 1 && host.sequencer.stats.envelopesOut >= 2);
      const left = await blobs.list("messages/c/");
      assert.equal(left.blobs.length, 0, "the server deleted the client's upload after reading it");
    } finally {
      await close();
    }
  });

  test("envelope control: the in-process transport refuses a message over 32 MiB by closing the connection", async () => {
    const { host, close } = await sharedCutWorld({ blobs: createMemoryBlobStore() });
    try {
      const conn = await host.transport.connect(host.url, { token: "tok-alice" });
      let closed = "";
      conn.onClose((why) => (closed = why));
      conn.send({ type: "presence", branchId: "cut-main", actor: { kind: "human", id: "alice" }, state: { pad: payload() } });
      await until(() => closed !== "", 5000, "the connection closes");
      assert.equal(closed, "message too big");
      assert.equal(host.tooBig, 1);
    } finally {
      await close();
    }
  });

  test("envelope control: a client without the blob store rejects a 33 MiB change itself as too large; the next edit still confirms", async () => {
    const { host, a, close } = await sharedCutWorld({ blobs: createMemoryBlobStore(), clientBlobs: false });
    try {
      const big = a.commit([set("c0", "name", payload())]);
      const small = a.commit([set("c1", "name", "after")]);
      assert.deepEqual(await a.cut.waitFor(big, 30_000), { status: "rejected", id: big, reason: "too large" });
      assert.deepEqual(await a.cut.waitFor(small, 30_000), { status: "confirmed", id: small, seq: 1 });
      assert.equal(host.tooBig, 0, "nothing over the cap was sent");
      assert.equal(a.cut.sync!.stats.reconnects, 1);
    } finally {
      await close();
    }
  });

  test("catch-up pages: a replica joining after 30 changes of 400 KiB (12 MiB) asks again page after page (4 MiB each) until it has every row, in order", async () => {
    const blobs = createMemoryBlobStore();
    const { a, replica, close } = await sharedCutWorld({ blobs });
    try {
      const ids: string[] = [];
      for (let i = 0; i < 30; i++) ids.push(a.commit([set(`c${i % 3}`, "name", `${i}:`.padEnd(400 * 1024, "z"))]));
      assert.equal((await a.cut.waitFor(ids.at(-1)!, 60_000)).status, "confirmed");
      const sent: string[] = [];
      const c = replica("carol", countingHellos(sent));
      assert.ok(await c.cut.connect({ nonce: "nc", timeoutMs: 60_000 }), "carol caught up");
      assert.equal(c.cut.queue.headSeq("cut-main"), 30, "every row");
      assert.equal(JSON.stringify(c.head()), JSON.stringify(a.head()), "the same state as alice");
      const hellos = sent.filter((x) => x === "hello" || x === "blob").length;
      assert.equal(c.cut.sync!.stats.reconnects, 1, "one connection: the hellos are pages, not reconnects");
      assert.ok(hellos >= 3, `12 MiB in pages of at most 4 MiB: ${hellos} hellos`);
    } finally {
      await close();
    }
  });
}
