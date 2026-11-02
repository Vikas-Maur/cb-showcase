// Laptop, final candidate P2-1 (review of fix/recover-save #1): an undo never leaves a project empty. History refuses
// one whose result the schema's rule takes for empty when it is made; on a shared cut a queued undo is rebased onto a
// teammate's edits before it is pushed, and that rebase can make it empty after all: refused at the push, its author
// told, the project as the teammate left it. Against a real sequencer (the in-process host of @carton/server).
import { test } from "node:test";
import assert from "node:assert/strict";
import { Carton, defineSchema, hashDoc, POS, type Actor, type CutRecord, type Doc } from "@carton/core";
import type { HostAdapter } from "@carton/core/plugins";
import { createMemoryStore } from "../src/index.ts";
import { schema as base } from "./fixture.ts";
import { until, world } from "./world.ts";

const none = (v: unknown) => !Array.isArray(v) || !v.length;
// Cardboard's rule, on the fixture's collections: no aspect ratio, tracks or clips
const schema = defineSchema({ collections: { tracks: { seq: true }, items: { parent: { field: "trackId", collection: "tracks" } } }, timeline: base.timeline, empty: (d) => !d.aspectRatio && none(d.tracks) && none(d.items) });
const adapter: HostAdapter<Doc> = { name: "test", schema, schemaVersion: 1, fromHost: (h) => h, toHost: (d) => d };
const alice: Actor = { kind: "human", id: "alice", group: "alice@laptop" };
const bob: Actor = { kind: "human", id: "bob", group: "bob@desk" };

test("a queued undo that a teammate's edit made empty is refused at the push, its author told; the project stays as the teammate left it", async () => {
  const w = world();
  // what the old bug left, named again: nothing of the project in it
  const a = await Carton.open({ adapter, store: createMemoryStore(), init: { doc: { name: "Film", tracks: [], items: [] } as Doc, projectId: "p" }, actor: alice, sync: w.sync("alice", false) });
  await a.sync!.connect({ nonce: "a1" });
  await a.share();
  await until(async () => (await a.cuts())[0]!.sequencer.kind === "server", 5000, "the hand-off");
  // Alice brings the project back (as a Restore does)
  const back = await a.commit({ doc: { name: "Film", aspectRatio: "16:9", tracks: [{ id: "t1", [POS]: "V" }], items: [] } as unknown as Doc, wait: 5000 });
  assert.equal(back.status, "confirmed");
  const cut = (await a.cuts())[0]! as CutRecord;
  const root = await a.checkout(`${cut.id}@0`);
  const b = await Carton.open({ adapter, store: createMemoryStore(), init: { join: { projectId: "p", cut, doc0: root, rootHash: hashDoc(root, schema) } }, actor: bob, sync: w.sync("bob") });
  await until(async () => (await b.head()).doc.aspectRatio === "16:9", 5000, "bob catches up");
  // Bob adds a track of his own
  assert.equal((await b.commit({ ops: [{ op: "insert", path: ["tracks", "t2"], value: { id: "t2", [POS]: "W" } }], wait: 5000 })).status, "confirmed");
  await until(async () => ((await a.head()).doc.tracks as unknown[]).length === 2, 5000, "alice sees bob's track");
  // Alice, offline, undoes her bringing it back: Bob's track is still there, so it isn't empty (History lets it)
  await a.sync!.disconnect();
  const u = await a.undo(undefined, { author: alice });
  assert.equal(u.status, "pending");
  // Bob removes his track meanwhile: Alice's undo, rebased onto that, would leave nothing
  assert.equal((await b.commit({ ops: [{ op: "remove", path: ["tracks", "t2"] }], wait: 5000 })).status, "confirmed");
  await a.sync!.connect({ nonce: "a2" });
  const o = await a.sync!.waitFor((u as { id: string }).id, 5000);
  assert.equal(o.status, "rejected", JSON.stringify(o));
  assert.match((o as { reason: string }).reason, /it would have left the project empty/);
  // the project is as Bob left it, on both
  await until(async () => (await a.head()).doc.aspectRatio === "16:9", 5000, "alice's head");
  assert.deepEqual(((await a.head()).doc.tracks as { id: string }[]).map((t) => t.id), ["t1"]);
  assert.equal((await b.head()).doc.aspectRatio, "16:9");
  const told = (await a.notices(alice)).find((n) => n.kind === "rejected");
  assert.ok(told && /left the project empty/.test(told.text), JSON.stringify(await a.notices(alice)));
  await a.close();
  await b.close();
});
