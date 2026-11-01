// The Comments handle on a real Carton (store-memory and Cardboard's adapter), with no server: writing, the rules,
// persistence, two processes on one store, "comments are not versions", and placements through real commits.
import test from "node:test";
import assert from "node:assert/strict";
import { createMemoryStore } from "@carton/store-memory";
import { Comments, CommentError } from "../src/comments.ts";
import { cartonCommentStore, type CommentStore } from "../src/store.ts";
import { BOB, ME, clip, commitDoc, edit, openCarton } from "./helpers.ts";

const items = () => [clip("a", 0, 10), clip("c", 10, 20), clip("d", 20, 30)];

test("write a thread, a reply, edit, resolve, delete: all kept here while there is no server", async () => {
  const carton = await openCarton(items());
  const comments = await Comments.open({ carton, me: ME });
  const { ref } = await carton.head();
  const c = await comments.add({ body: "Cut this pause", range: [12, 14] });
  assert.equal(c.author.id, "alice");
  assert.equal(c.anchor?.cut, carton.cut);
  assert.equal(c.anchor?.seq, ref.seq);
  assert.equal(c.anchor?.state, ref.hash);
  assert.deepEqual(c.anchor?.items?.map((i) => i.id), ["c"]);
  assert.ok(comments.isPending(c.id), "no server: it waits to be shared");
  const r = await comments.reply(c.id, "Done in the next version", { agent: "Director" });
  assert.deepEqual([r.replyTo, r.author.agent], [c.id, "Director"]);
  await comments.edit(c.id, "Cut this long pause");
  await comments.resolve(r.id); // a reply resolves its thread
  assert.equal(comments.get(c.id)?.body, "Cut this long pause");
  assert.ok(comments.get(c.id)?.resolved);
  assert.deepEqual(comments.threads().map((t) => [t.root.id, t.replies.map((x) => x.id)]), [[c.id, [r.id]]]);
  await comments.remove(r.id);
  assert.ok(comments.get(r.id)?.deleted);
  await comments.close();
});

test("the same rules as the server, checked before anything is saved", async () => {
  const carton = await openCarton(items());
  const store = carton.store;
  const alice = await Comments.open({ carton, me: ME });
  const bob = await Comments.open({ carton, me: BOB });
  const c = await alice.add({ body: "Too dark", range: [1, 2] });
  await bob.refresh();
  await assert.rejects(bob.edit(c.id, "Fine by me"), (e: unknown) => e instanceof CommentError && e.refused === "forbidden");
  await assert.rejects(bob.remove(c.id), (e: unknown) => e instanceof CommentError && e.refused === "forbidden");
  await bob.resolve(c.id);
  await assert.rejects(alice.add({ body: "  " }), (e: unknown) => e instanceof CommentError && e.refused === "bad-request");
  await assert.rejects(alice.reply("nope", "?"), (e: unknown) => e instanceof CommentError && e.refused === "not-found");
  assert.ok(store);
  await Promise.all([alice.close(), bob.close()]);
});

test("comments are not versions: no change, no new version in History, the same head", async () => {
  const carton = await openCarton(items());
  const before = await carton.head();
  const log0 = await carton.log();
  const rows0 = (await carton.store.range("changes")).length;
  const comments = await Comments.open({ carton, me: ME });
  const c = await comments.add({ body: "Music too loud", range: [3, 5] });
  await comments.reply(c.id, "Lowered it");
  await comments.resolve(c.id);
  await comments.edit(c.id, "Music too loud here");
  const after = await carton.head();
  assert.equal(after.ref.hash, before.ref.hash);
  assert.equal(after.ref.seq, before.ref.seq);
  assert.equal((await carton.log()).length, log0.length);
  assert.equal((await carton.store.range("changes")).length, rows0);
  assert.deepEqual(await carton.undoStack(), []);
  await comments.close();
});

test("kept in the project's store: a reopened handle sees them, and a second process's comment after refresh", async () => {
  const store = createMemoryStore();
  const carton = await openCarton(items(), store);
  const one = await Comments.open({ carton, me: ME });
  const c = await one.add({ body: "Keep this take", range: [21, 22] });
  await one.close();
  const again = await Comments.open({ carton, me: ME });
  assert.deepEqual(again.all().map((x) => x.body), ["Keep this take"]);
  // `cb` (another process on the same carton.db) adds a reply
  const cb = await Comments.open({ carton, me: { ...ME, agent: "Claude Code" } });
  await cb.reply(c.id, "Kept");
  assert.equal(again.threads()[0]!.replies.length, 0);
  await again.refresh();
  assert.equal(again.threads()[0]!.replies[0]!.body, "Kept");
  await Promise.all([again.close(), cb.close()]);
});

test("two processes editing one comment at once: both edits land (the second retries on the first's row)", async () => {
  const carton = await openCarton(items());
  const one = await Comments.open({ carton, me: ME });
  const two = await Comments.open({ carton, me: ME });
  const c = await one.add({ body: "First take", range: [1, 2] });
  await two.refresh();
  await Promise.all([one.edit(c.id, "Second take"), two.resolve(c.id)]);
  await one.refresh();
  const v = one.get(c.id)!;
  assert.equal(v.body, "Second take");
  assert.ok(v.resolved);
  await Promise.all([one.close(), two.close()]);
});

test("placements follow real versions: moved by a ripple, through a split by its lineage, outdated, removed", async () => {
  // no media ids: only lineage can follow the split's second piece
  const noMedia = (id: string, s: number, e: number) => clip(id, s, e, "V1", { mediaItemId: undefined });
  const carton = await openCarton([noMedia("a", 0, 10), noMedia("c", 10, 20), noMedia("d", 20, 30), noMedia("e", 30, 40)]);
  const comments = await Comments.open({ carton, me: ME });
  const onC = await comments.add({ body: "Love this moment", range: [16, 17] });
  const onD = await comments.add({ body: "Too dark", range: [25, 26] });
  const onE = await comments.add({ body: "Drop this", range: [35, 36] });
  const general = await comments.add({ body: "Overall: tighten it" });
  let p = await comments.placements();
  assert.deepEqual([p.get(onC.id)?.status, p.get(onD.id)?.status, p.get(general.id)?.status], ["exact", "exact", "general"]);
  // split c at 15: the second piece is c-b (Cardboard gives it a new id), recorded as the split's lineage
  await commitDoc(carton, (d) => edit(d, { c: { endTime: 15, trimEnd: 5 } }, [clip("c-b", 15, 20, "V1", { mediaItemId: undefined, trimStart: 5, trimEnd: 10 })]), { kind: "split", lineage: { c: ["c", "c-b"] } });
  // ripple-delete a's last 4 s: everything after moves 4 s earlier
  await commitDoc(carton, (d) => edit(d, { a: { endTime: 6, trimEnd: 6 }, c: { startTime: 6, endTime: 11 }, "c-b": { startTime: 11, endTime: 16 }, d: { startTime: 16, endTime: 26 }, e: { startTime: 26, endTime: 36 } }));
  // grade d, delete e
  await commitDoc(carton, (d) => edit(d, { d: { opacity: 0.6 }, e: null }));
  p = await comments.placements();
  assert.deepEqual([p.get(onC.id)?.status, p.get(onC.id)?.range, p.get(onC.id)?.items], ["moved", [12, 13], ["c-b"]]);
  assert.deepEqual([p.get(onD.id)?.status, p.get(onD.id)?.range], ["outdated", [21, 22]]);
  assert.deepEqual(p.get(onE.id)?.status, "removed");
  // nothing changed since: the same placements, not recomputed
  const again = await comments.placements();
  assert.equal(again.get(onC.id), p.get(onC.id));
  await comments.close();
});

test("a comment on an older version, placed on the head", async () => {
  const carton = await openCarton(items());
  const { ref } = await carton.head();
  await commitDoc(carton, (d) => edit(d, { a: { endTime: 8, trimEnd: 8 }, c: { startTime: 8, endTime: 18 }, d: { startTime: 18, endTime: 28 } }));
  const comments = await Comments.open({ carton, me: ME });
  const c = await comments.add({ body: "In the first cut this was better", range: [12, 13], version: { cut: ref.branchId, seq: ref.seq } });
  assert.equal(c.anchor?.seq, ref.seq);
  assert.equal(c.anchor?.state, ref.hash);
  const p = await comments.placements();
  assert.deepEqual([p.get(c.id)?.status, p.get(c.id)?.range], ["moved", [10, 11]]);
  await comments.close();
});

test("edits, replies and authors are checked before they are kept: nothing the server would refuse waits here", async () => {
  const carton = await openCarton(items());
  const comments = await Comments.open({ carton, me: ME });
  const c = await comments.add({ body: "Fine", range: [1, 2] });
  await assert.rejects(comments.edit(c.id, "   "), (e: unknown) => e instanceof CommentError && e.refused === "bad-request");
  await assert.rejects(comments.reply(c.id, ""), (e: unknown) => e instanceof CommentError && e.refused === "bad-request");
  await assert.rejects(comments.reply(c.id, "x".repeat(10_001)), (e: unknown) => e instanceof CommentError && e.refused === "bad-request");
  const long = await Comments.open({ carton, me: { id: "alice", name: "A".repeat(300) } });
  await assert.rejects(long.add({ body: "Hi", range: [1, 2] }), (e: unknown) => e instanceof CommentError && e.refused === "bad-request");
  assert.equal(comments.get(c.id)?.body, "Fine");
  assert.deepEqual(comments.all().map((x) => x.id), [c.id], "no reply kept");
  await Promise.all([comments.close(), long.close()]);
});

test("a split piece moved away is followed by its lineage, not by another clip of its media nearer the old place", async () => {
  const carton = await openCarton([clip("x", 0, 10)]);
  const comments = await Comments.open({ carton, me: ME, anchor: { media: "mediaItemId" } });
  const c = await comments.add({ body: "This frame", range: [6, 7] });
  // split x at 5: its second half (x2, a new id) moves to 30; another clip of the same media lands at 12, nearer
  await commitDoc(
    carton,
    (d) =>
      edit(d, { x: { endTime: 5, trimEnd: 5 } }, [
        { ...clip("x2", 30, 35), mediaItemId: "m-x", trimStart: 5, trimEnd: 10 },
        { ...clip("y", 12, 22), mediaItemId: "m-x" },
      ]),
    { kind: "split", lineage: { x: ["x", "x2"] } },
  );
  const p = (await comments.placements()).get(c.id)!;
  assert.deepEqual([p.status, p.range, p.items, p.guess], ["moved", [31, 32], ["x2"], undefined]);
  await comments.close();
});

test("an edit whose compare-and-set lost to an upload in another process still goes through (never 'not found')", async () => {
  const carton = await openCarton(items());
  const raw = cartonCommentStore(carton.store);
  let during: (() => Promise<void>) | null = null;
  const once = async () => {
    const f = during;
    during = null;
    if (f) await f();
  };
  // this handle's store: the other process's upload lands right after this handle's first read while it recovers
  const hooked: CommentStore = {
    ...raw,
    async pending() {
      const r = await raw.pending();
      await once();
      return r;
    },
    async read(ids) {
      const r = await raw.read(ids);
      await once();
      return r;
    },
  };
  const cb = await Comments.open({ carton, store: hooked, me: ME });
  const other = await Comments.open({ carton, me: ME });
  const c = await cb.add({ body: "Draft", range: [1, 2] });
  await other.refresh();
  await other.edit(c.id, "Draft (other process)");
  const [pend] = await raw.pending();
  // the worker's upload: the server's row in, the pending row out, one write
  during = async () => void (await raw.write({ rows: [{ ...other.get(c.id)!, seq: 1 }], head: 1, drop: [pend!] }));
  const r = await cb.edit(c.id, "Draft (cb)");
  assert.equal(r.body, "Draft (cb)");
  assert.equal((await raw.pending())[0]?.patch.body, "Draft (cb)", "kept as a new pending patch over the server's row");
  await Promise.all([cb.close(), other.close()]);
});

test("refresh after another process reset the stream: a row with the same id and seq but other content is taken", async () => {
  const carton = await openCarton(items());
  const raw = cartonCommentStore(carton.store);
  const h = await Comments.open({ carton, me: ME });
  const row = (body: string) => ({ id: "c1", author: BOB, body, cut: carton.cut, at: 1, seq: 1 });
  await raw.write({ rows: [row("Before the reset")], head: 1, epoch: "" });
  await h.refresh();
  assert.equal(h.get("c1")?.body, "Before the reset");
  await raw.write({ rows: [row("After the reset")], head: 1, reset: "e2" });
  await h.refresh();
  assert.equal(h.get("c1")?.body, "After the reset");
  await h.close();
});
