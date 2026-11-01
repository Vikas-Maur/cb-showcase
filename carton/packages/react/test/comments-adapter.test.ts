// commentsUi() over a real @carton/comments handle on a real Carton (store-memory): threads, placements that follow
// the document's versions, view identities kept across unrelated changes, waiting comments and refusals.
import test from "node:test";
import assert from "node:assert/strict";
import { Carton, defineSchema, POS, type Doc, type Rec } from "@carton/core";
import type { HostAdapter } from "@carton/core/plugins";
import { createMemoryStore } from "@carton/store-memory";
import { Comments } from "@carton/comments";
import { commentsUi } from "../src/comments/from-comments.ts";
import type { CommentsSource } from "../src/comments/from-comments.ts";

const TL = { collection: "items", lanes: "tracks", lane: "trackId", start: "startTime", end: "endTime", source: "trimStart", sourceEnd: "trimEnd", speed: "playbackSpeed" };
const schema = defineSchema({ collections: { tracks: { seq: true }, items: { parent: { field: "trackId", collection: "tracks" } } }, timeline: TL });
const adapter: HostAdapter<Doc> = { name: "test", schema, schemaVersion: 1, fromHost: (h) => h, toHost: (d) => d };
const clip = (id: string, s: number, e: number): Rec => ({ id, trackId: "t1", startTime: s, endTime: e, trimStart: 0, trimEnd: e - s });
const ME = { id: "alice", name: "Alice" };

async function setup() {
  const carton = await Carton.open({ adapter, store: createMemoryStore(), init: { doc: { tracks: [{ id: "t1", [POS]: "V" }], items: [clip("a", 0, 10), clip("b", 10, 20)] } } });
  const comments = await Comments.open({ carton, me: ME });
  // the structural contract: a Comments handle is a CommentsSource
  const source: CommentsSource = comments;
  const ui = commentsUi(source, { versions: { on: (l) => carton.on(() => l()) } });
  return { carton, comments, ui };
}

test("threads with their placements, followed as the document moves on", async () => {
  const { carton, comments, ui } = await setup();
  await ui.add("Too long", [12, 13]);
  await ui.add("Overall: good", null);
  await ui.settled();
  let ts = ui.threads();
  assert.deepEqual(ts.map((t) => [t.root.body, t.placement?.status, t.placement?.range]), [["Too long", "exact", [12, 13]], ["Overall: good", "general", null]]);
  assert.equal(ts[0]!.root.mine, true);
  assert.equal(ts[0]!.root.pending, true, "no server: waiting");
  assert.deepEqual(ui.status(), { state: "local", waiting: 2 });
  const general = ts[1];
  // a ripple: b moves 4 s earlier
  const { doc } = await carton.head();
  await carton.commit({ doc: { ...doc, items: [clip("a", 0, 6), { ...clip("b", 6, 16) }] } });
  await new Promise((r) => setTimeout(r, 0));
  await ui.settled();
  ts = ui.threads();
  assert.deepEqual([ts[0]!.placement?.status, ts[0]!.placement?.range], ["moved", [8, 9]]);
  assert.equal(ts[1], general, "a thread nothing touched keeps its view object");
  ui.close();
  await comments.close();
});

test("reply, resolve, edit and delete go through to the handle; identities change only where something did", async () => {
  const { comments, ui } = await setup();
  await ui.add("First", [1, 2]);
  await ui.add("Second", [3, 4]);
  await ui.settled();
  const [first, second] = ui.threads();
  await ui.reply(first!.id, "A reply");
  await ui.settled();
  assert.equal(ui.threads()[1], second);
  assert.notEqual(ui.threads()[0], first);
  assert.equal(ui.threads()[0]!.replies[0]!.body, "A reply");
  await ui.resolve(second!.id, true);
  await ui.edit(first!.id, "First, edited");
  await ui.remove(ui.threads()[0]!.replies[0]!.id);
  await ui.settled();
  const [f, s] = ui.threads();
  assert.ok(s!.resolved);
  assert.equal(f!.root.body, "First, edited");
  assert.ok(f!.replies[0]!.deleted);
  assert.equal(comments.threads().length, 2);
  ui.close();
  await comments.close();
});
