// Carton UX v2 (N0) in the view model, over the real engine and across the remote bridge: find, landmarks, bringing
// back one clip and its choices, the clip-by-clip match of two versions, two cuts' differences, landmark pictures.
import { test } from "node:test";
import assert from "node:assert/strict";
import { Carton, POS, defineSchema, timeAlgebra, type Actor, type Doc, type Rec } from "@carton/core";
import type { HostAdapter } from "@carton/core/plugins";
import { createMemoryStore } from "@carton/store-memory";
import { fromCarton } from "../src/from-carton.ts";
import { remoteUi, serveUi, type ClientMessage, type ServerMessage } from "../src/remote.ts";
import type { CartonUi } from "../src/model.ts";

const TL = { collection: "items", lanes: "tracks", lane: "trackId", start: "startTime", end: "endTime", source: "trimStart", sourceEnd: "trimEnd", speed: "playbackSpeed" };
const schema = defineSchema({
  collections: {
    tracks: { seq: true, noun: "track" },
    items: {
      parent: { field: "trackId", collection: "tracks" },
      noun: "clip",
      nounOf: (r) => (r.type === "text" ? "title" : undefined),
      words: (r) => (typeof r.text === "string" ? [r.text] : []),
      groups: [{ name: "time", fields: ["startTime", "endTime", "trimStart", "trimEnd", "playbackSpeed"], algebra: timeAlgebra(TL) }],
    },
  },
  timeline: TL,
  label: (coll, r) => String((r as Rec | undefined)?.name ?? (r as Rec | undefined)?.text ?? (r as Rec | undefined)?.id ?? coll),
});
const adapter: HostAdapter<Doc> = { name: "test", schema, schemaVersion: 1, fromHost: (h) => h, toHost: (d) => d };
const clip = (id: string, s: number, e: number, more: Rec = {}): Rec => ({ id, type: "video", trackId: "t1", startTime: s, endTime: e, trimStart: 0, trimEnd: e - s, name: id === "a" ? "Intro" : id.toUpperCase(), ...more });
const doc0 = (): Doc => ({ name: "Film", tracks: [{ id: "t1", [POS]: "V" }], items: [clip("a", 0, 5), clip("b", 5, 10), clip("c", 10, 15), clip("t", 2, 7, { type: "text", name: undefined, text: "Summer sale" })] });
const alice: Actor = { kind: "human", id: "alice", name: "Alice", group: "alice@laptop" };
const set = (id: string, f: string, v: unknown) => ({ op: "set" as const, path: ["items", id, f], value: v });

function pipe(served: CartonUi) {
  let client!: ReturnType<typeof remoteUi>;
  const server = serveUi(served, (m: ServerMessage) => queueMicrotask(() => client.receive(structuredClone(m))));
  client = remoteUi((m: ClientMessage) => queueMicrotask(() => server.receive(structuredClone(m))));
  return { client, server };
}

test("view model: find, landmarks, bring back one clip, its choices, align and two cuts' differences; through the bridge too", async () => {
  const pics = new Map<string, string>();
  const carton = await Carton.open({ adapter, store: createMemoryStore(), init: { doc: doc0(), cutName: "Main cut" }, actor: alice });
  const ui = fromCarton(carton, { me: alice, pictures: { get: async (k) => pics.get(k) ?? null, put: async (k, v) => void pics.set(k, v) } });
  await ui.ready;
  const { client, server } = pipe(ui);
  await client.ready;
  try {
    await carton.commit({ ops: [set("a", "endTime", 4)], author: alice }); // @1
    await carton.commit({ ops: [set("t", "text", "Summer launch")], author: alice }); // @2
    await carton.name({ branchId: carton.cut, seq: 2, pending: [] } as never, "Sent to client");
    await carton.mark("exported", { label: "1080p" });
    await ui.settled();
    for (const u of [ui, client.ui]) {
      const f = await u.find!("intro");
      assert.deepEqual(f.hits.map((h) => [h.ref, h.field, h.clipName, h.itemId]), [[`${carton.cut}@1`, "clip", "Intro", "a"]]);
      assert.deepEqual(f.clips, [{ itemId: "a", name: "Intro", cutId: carton.cut }]);
      assert.equal(f.hits[0]!.versionId, (await carton.log({ limit: 2 }))[1]!.change);
      const l = await u.landmarks!();
      assert.deepEqual(l.map((x) => [x.kind, x.ref, x.label, x.personal]), [["exported", `${carton.cut}@2`, "1080p", false], ["named", `${carton.cut}@2`, "Sent to client", false]]);
      // the bring-back choices against @0: a changed clip and a changed title
      const ch = await u.bringBackChoices!(`${carton.cut}@0`);
      assert.deepEqual(ch.changed.map((c) => [c.itemId, c.name, c.then?.end, c.now?.end]), [["a", "Intro", 5, 4], ["t", "Summer launch", 7, 7]]);
      assert.equal(ch.same, 2);
      // align: clip by clip
      const al = await u.align!(`${carton.cut}@0`, `${carton.cut}@1`);
      assert.deepEqual(al.find((e) => e.item === "a"), { item: "a", name: "Intro", aStart: 0, aEnd: 5, bStart: 0, bEnd: 4, track: "t1" });
    }
    // bring back one clip, through the bridge; its version is made, and Ctrl+Z (the stack) has it
    const r = await client.ui.restoreClip!(`${carton.cut}@0`, "a");
    assert.equal(r.how, "changed");
    assert.equal(r.clipName, "Intro");
    assert.ok(r.made?.changes.length === 1);
    assert.equal((await carton.head()).doc.items && ((await carton.head()).doc.items as Rec[]).find((x) => x.id === "a")!.endTime, 5);
    // two cuts: their differences, said as where a clip is
    const insta = await carton.fork("30s Instagram cut");
    await carton.commit({ cut: insta.id, ops: [{ op: "remove", path: ["items", "c"] }, set("b", "endTime", 8)], author: alice });
    await ui.settled();
    const diffs = await client.ui.changes(insta.id, carton.cut, { between: "cuts" });
    assert.deepEqual(diffs.map((d) => d.text).sort(), ["Only in Main cut: “C”", "“B” ends at 0:10 here, 0:08 in “30s Instagram cut”"].sort());
    const plain = await client.ui.changes(insta.id, carton.cut);
    assert.equal(plain.length, 2, "the same count");
    // pictures: kept by the app, a small JPEG
    await client.ui.saveLandmarkPicture!("k@2", "data:image/jpeg;base64,AAAA");
    assert.equal(await client.ui.landmarkPicture!("k@2"), "data:image/jpeg;base64,AAAA");
    await assert.rejects(client.ui.saveLandmarkPicture!("k@2", "data:image/png;base64,AAAA"));
  } finally {
    server.close();
    ui.close?.();
    await carton.close();
  }
});
