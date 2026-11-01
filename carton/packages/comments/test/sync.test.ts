// Two and more Comments handles sharing comments through the comment room over a Transport (the test host delivers
// JSON copies in order, as the in-process host does): convergence, offline and never-shared comments going up, a
// lost answer, refusals, rate limits, a watch link's scope, and a host from before comments.
import test from "node:test";
import assert from "node:assert/strict";
import { Comments } from "../src/comments.ts";
import { cartonCommentStore, type CommentStore } from "../src/store.ts";
import type { CommentsEvent } from "../src/comments.ts";
import { BOB, ME, clip, commentHost, openCarton, until } from "./helpers.ts";

const items = () => [clip("a", 0, 10), clip("c", 10, 20)];
type Host = ReturnType<typeof commentHost>;
async function client(host: Host, who: { id: string; name: string }, role: Parameters<Host["token"]>[0] = "editor", branches?: string[]) {
  const carton = await openCarton(items());
  const comments = await Comments.open({ carton, me: who, sync: { transport: host.transport, url: host.url, token: host.token(role, who.id, branches) } });
  return { carton, comments };
}

test("two people: a thread, a reply, an edit and a resolve reach the other; both end with the server's rows", async () => {
  const host = commentHost();
  const a = await client(host, ME);
  const b = await client(host, BOB);
  const c = await a.comments.add({ body: "Cut the pause here", range: [12, 13] });
  await until(() => !!b.comments.get(c.id), 3000, "bob sees alice's comment");
  const r = await b.comments.reply(c.id, "On it");
  await until(() => a.comments.threads()[0]?.replies.length === 1, 3000, "alice sees the reply");
  await a.comments.edit(c.id, "Cut the long pause here");
  await b.comments.resolve(c.id);
  assert.ok(await a.comments.settled());
  assert.ok(await b.comments.settled());
  await until(() => !!a.comments.get(c.id)?.resolved && b.comments.get(c.id)?.body === "Cut the long pause here");
  for (const x of [a, b]) {
    assert.equal(x.comments.isPending(c.id), false);
    assert.equal(x.comments.isPending(r.id), false);
    assert.ok(x.comments.get(c.id)!.seq! > 0);
  }
  assert.deepEqual(a.comments.get(c.id), b.comments.get(c.id));
  assert.equal(a.comments.get(c.id)!.author.id, "alice");
  assert.equal(b.comments.get(r.id)!.author.id, "bob");
  await Promise.all([a.comments.close(), b.comments.close()]);
});

test("written offline, and in a project never shared: kept, then sent once connected", async () => {
  const host = commentHost();
  // never shared: no sync at all
  const carton = await openCarton(items());
  const local = await Comments.open({ carton, me: ME });
  const early = await local.add({ body: "Before sharing", range: [1, 2] });
  await local.edit(early.id, "Before sharing (edited)");
  await local.close();
  // shared now: the same store, with sync
  const shared = await Comments.open({ carton, me: ME, sync: { transport: host.transport, url: host.url, token: host.token("editor", "alice") } });
  const b = await client(host, BOB);
  await until(() => b.comments.get(early.id)?.body === "Before sharing (edited)", 3000, "the never-shared comment went up");
  assert.equal(host.room.head(), 1, "an add and an edit made before sharing went up as one patch");
  // offline: the link drops and stays down while alice writes
  host.drop();
  const off = await shared.add({ body: "Written offline", range: [3, 4] });
  assert.ok(shared.isPending(off.id));
  await until(() => !!b.comments.get(off.id), 5000, "the offline comment went up after the reconnect");
  assert.ok(await shared.settled());
  assert.equal(shared.isPending(off.id), false);
  await Promise.all([shared.close(), b.comments.close()]);
});

test("an answer lost with the link: the patch is sent again and stored once", async () => {
  const host = commentHost();
  const a = await client(host, ME);
  await until(() => a.comments.syncStatus()?.state === "up-to-date");
  const c = await a.comments.add({ body: "Once", range: [1, 2] });
  host.drop(); // the add may or may not have reached the room; its answer is lost either way
  await until(() => a.comments.syncStatus()?.state === "up-to-date" && !a.comments.isPending(c.id), 5000, "settled after the reconnect");
  assert.equal(host.room.head(), 1);
  await a.comments.close();
});

test("refused for good (a viewer writes): the pending comment goes, and the writer is told", async () => {
  const host = commentHost();
  const v = await client(host, { id: "vic", name: "Vic" }, "viewer");
  const events: CommentsEvent[] = [];
  v.comments.on((e) => events.push(e));
  const c = await v.comments.add({ body: "Can I?", range: [1, 2] });
  await until(() => events.some((e) => e.type === "refused"), 3000, "the refusal");
  assert.deepEqual(events.find((e) => e.type === "refused"), { type: "refused", id: c.id, refused: "forbidden", reason: "viewers can read comments but not write them" });
  assert.equal(v.comments.get(c.id), undefined);
  assert.equal(v.comments.isPending(c.id), false);
  await v.comments.close();
});

test("rate-limited: a burst of comments, a thread with its reply, all go up in time, the reply after its thread", async () => {
  const host = commentHost({ limits: { burst: 2, perSec: 40 } });
  const a = await client(host, ME);
  const ids: string[] = [];
  for (let i = 0; i < 6; i++) ids.push((await a.comments.add({ body: `note ${i}`, range: [i, i + 1] })).id);
  const r = await a.comments.reply(ids[5]!, "and a reply");
  assert.ok(await a.comments.settled(8000), "everything answered");
  assert.equal(host.room.head(), 7);
  assert.equal(a.comments.get(r.id)?.replyTo, ids[5]);
  await a.comments.close();
});

test("a watch link sees only the Published cut's comments, live and on catch-up", async () => {
  const host = commentHost();
  const ed = await client(host, ME);
  const pub = await ed.carton.fork("For the client");
  const onPub = await ed.comments.add({ body: "Client: check the logo", range: [1, 2], cut: pub.id });
  const internal = await ed.comments.add({ body: "Internal: re-grade later", range: [1, 2] });
  const watch = await client(host, { id: "guest", name: "Guest" }, "viewer", [pub.id]);
  const shown = () => watch.comments.all().map((c) => c.id);
  await until(() => shown().includes(onPub.id), 3000, "the watch link's catch-up");
  const later = await ed.comments.add({ body: "Client: new music", range: [5, 6], cut: pub.id });
  await ed.comments.add({ body: "Internal: later", range: [5, 6] });
  await until(() => shown().includes(later.id), 3000, "live fan-out");
  assert.ok(await ed.comments.settled());
  assert.deepEqual(shown().sort(), [onPub.id, later.id].sort());
  assert.ok(!shown().includes(internal.id));
  await Promise.all([ed.comments.close(), watch.comments.close()]);
});

test("a host from before comments: the comments stay here, the status says so, no retry loop", async () => {
  const host = commentHost({ legacy: true });
  const a = await client(host, ME);
  await until(() => a.comments.syncStatus()?.state === "unsupported", 3000, "unsupported");
  const c = await a.comments.add({ body: "Still mine", range: [1, 2] });
  assert.ok(a.comments.isPending(c.id));
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(host.connections, 0, "it closed its connection and didn't come back");
  await a.comments.close();
});

test("someone else's unsent comment (a full-history .cbproj copies the pending table) is never sent as this person's", async () => {
  const host = commentHost();
  const carton = await openCarton(items());
  // Bob wrote a comment on his machine and sent the project with its history before it went up
  const bob = await Comments.open({ carton, me: BOB });
  const theirs = await bob.add({ body: "Bob's note", range: [1, 2] });
  await bob.close();
  // Alice opens that carton.db and shares
  const alice = await Comments.open({ carton, me: ME, sync: { transport: host.transport, url: host.url, token: host.token("editor", "alice") } });
  const mine = await alice.add({ body: "Alice's note", range: [3, 4] });
  await until(() => !alice.isPending(mine.id), 3000, "alice's own comment went up");
  assert.equal(host.room.head(), 1, "only alice's");
  assert.ok(alice.isPending(theirs.id), "bob's stays here, waiting for bob");
  await alice.close();
});

test("a fan-out row that can't be stored ends the connection; the next one catches up from the last stored position", async () => {
  const host = commentHost();
  const carton = await openCarton(items());
  const base = cartonCommentStore(carton.store);
  let fail = 0;
  const store: CommentStore = {
    ...base,
    async write(w) {
      if (fail > 0 && w.rows?.length && !w.put && !w.drop) {
        fail--;
        throw new Error("disk full");
      }
      return base.write(w);
    },
  };
  const a = await Comments.open({ carton, store, me: ME, sync: { transport: host.transport, url: host.url, token: host.token("editor", "alice") } });
  const b = await client(host, BOB);
  await until(() => a.syncStatus()?.state === "up-to-date", 3000, "alice caught up");
  fail = 1;
  const c1 = await b.comments.add({ body: "First", range: [1, 2] });
  const c2 = await b.comments.add({ body: "Second", range: [3, 4] });
  await until(() => !!a.get(c1.id) && !!a.get(c2.id), 5000, "alice has both, the one that failed too");
  await a.close();
  const again = await Comments.open({ carton, me: ME });
  assert.ok(again.get(c1.id) && again.get(c2.id), "both stored");
  await Promise.all([again.close(), b.comments.close()]);
});

test("a cb process's comment (no sync) goes up on the worker's refresh; cb can still edit it after the worker sent it", async () => {
  const host = commentHost();
  const carton = await openCarton(items());
  const worker = await Comments.open({ carton, me: ME, sync: { transport: host.transport, url: host.url, token: host.token("editor", "alice") } });
  const cb = await Comments.open({ carton, me: ME });
  const b = await client(host, BOB);
  await until(() => worker.syncStatus()?.state === "up-to-date", 3000, "the worker caught up");
  const c = await cb.add({ body: "From the CLI", range: [1, 2] });
  await worker.refresh();
  await until(() => !!b.comments.get(c.id), 3000, "the refresh sent cb's comment");
  await until(() => !worker.isPending(c.id), 3000, "answered");
  // cb still holds its own pending view; the worker's upload dropped the pending row and stored the server's row
  await cb.edit(c.id, "From the CLI (edited)");
  await worker.refresh();
  await until(() => b.comments.get(c.id)?.body === "From the CLI (edited)", 3000, "the edit went up too");
  await Promise.all([worker.close(), cb.close(), b.comments.close()]);
});

test("a catch-up over the host's read limit waits and asks again, and gets everything", async () => {
  const host = commentHost({ limits: { page: 1, readBurst: 1, readPerSec: 40 } });
  const b = await client(host, BOB);
  for (let i = 0; i < 4; i++) await b.comments.add({ body: `note ${i}`, range: [i, i + 1] });
  assert.ok(await b.comments.settled());
  const a = await client(host, ME);
  await until(() => a.comments.all().length === 4 && a.comments.syncStatus()?.state === "up-to-date", 5000, "alice caught up in limited pages");
  await Promise.all([a.comments.close(), b.comments.close()]);
});

test("another process resets the stream under a syncing handle: it reloads, asks again, and ends with the server's rows", async () => {
  const host = commentHost();
  const b = await client(host, BOB);
  const real = await b.comments.add({ body: "On the server", range: [1, 2] });
  assert.ok(await b.comments.settled());
  const carton = await openCarton(items());
  const a = await Comments.open({ carton, me: ME, sync: { transport: host.transport, url: host.url, token: host.token("editor", "alice") } });
  await until(() => !!a.get(real.id), 3000, "alice caught up");
  // another process on alice's carton.db writes a reset of its own (rows of no server, a head far ahead)
  await cartonCommentStore(carton.store).write({ rows: [{ id: "ghost", author: BOB, body: "Not on any server", cut: carton.cut, at: 1, seq: 99 }], head: 99, reset: "elsewhere" });
  // the next row alice's connection stores is of the old generation: refused; she reloads, asks from 99, is reset
  const next = await b.comments.add({ body: "After that", range: [3, 4] });
  await until(() => !!a.get(next.id) && !!a.get(real.id) && !a.get("ghost"), 5000, "alice has the server's rows only");
  await Promise.all([a.close(), b.comments.close()]);
});

test("refresh after another process wrote a reset's first page: the connection starts again, nothing is skipped", async () => {
  const host = commentHost();
  const b = await client(host, BOB);
  const made: Awaited<ReturnType<typeof b.comments.add>>[] = [];
  for (let i = 0; i < 4; i++) made.push(await b.comments.add({ body: `note ${i}`, range: [i, i + 1] }));
  assert.ok(await b.comments.settled());
  const carton = await openCarton(items());
  const a = await Comments.open({ carton, me: ME, sync: { transport: host.transport, url: host.url, token: host.token("editor", "alice") } });
  await until(() => made.every((c) => !!a.get(c.id)) && a.syncStatus()?.state === "up-to-date", 3000, "alice caught up");
  // another process's reset wrote its first page (one row, head 1) and exited
  const first = (await cartonCommentStore(carton.store).read([made[0]!.id]))[0]!;
  await cartonCommentStore(carton.store).write({ rows: [first], head: 1, reset: "elsewhere" });
  await a.refresh();
  const later = await b.comments.add({ body: "later", range: [9, 10] });
  await until(() => [...made, later].every((c) => !!a.get(c.id)), 5000, "alice has the rest of that catch-up and the new one");
  await a.close();
  const again = await Comments.open({ carton, me: ME });
  assert.deepEqual(again.all().map((c) => c.id).sort(), [...made, later].map((c) => c.id).sort(), "and so has the store");
  await Promise.all([again.close(), b.comments.close()]);
});
