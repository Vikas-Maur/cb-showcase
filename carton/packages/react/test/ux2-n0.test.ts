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
    // N0b: a choice's token, passed back as expect; a stale one is refused in words, nothing written
    const tok = (await client.ui.bringBackChoices!(`${carton.cut}@0`)).changed.find((c) => c.itemId === "a")!;
    assert.equal(typeof tok.token, "string");
    assert.deepEqual(tok.place, { placed: "same" });
    await assert.rejects(client.ui.restoreClip!(`${carton.cut}@0`, "a", { expect: "stale" }), /just changed again/);
    // bring back one clip, through the bridge; its version is made, and Ctrl+Z (the stack) has it
    const r = await client.ui.restoreClip!(`${carton.cut}@0`, "a", { expect: tok.token });
    assert.deepEqual([r.place, r.ripple], [{ placed: "same" }, null]);
    assert.equal(r.how, "changed");
    assert.equal(r.clipName, "Intro");
    assert.ok(r.made?.changes.length === 1);
    assert.equal((await carton.head()).doc.items && ((await carton.head()).doc.items as Rec[]).find((x) => x.id === "a")!.endTime, 5);
    // its row says what it was, as its toast does: "Brought back “Intro” from 10:20 am", not the plain change (QA v2)
    await ui.settled();
    const h = ui.history();
    h.at("all", 0);
    await ui.settled();
    await new Promise((r) => setTimeout(r, 20));
    assert.match(h.at("all", 0)!.summary, /^Brought back “Intro” from \d{1,2}:\d{2} [ap]m$/);
    // a row viewed with its own words keeps them (a peek: "… · holding", QA v2 G19); without, its version's label
    const older = h.at("all", 1)!;
    await ui.view({ kind: "version", versionId: older.id, label: "Exported 1080p · holding" });
    assert.equal(ui.viewing()?.label, "Exported 1080p · holding");
    await ui.view({ kind: "version", versionId: older.id });
    assert.notEqual(ui.viewing()?.label, "Exported 1080p · holding");
    await ui.view(null);
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
    ui.dispose();
    await carton.close();
  }
});

test("a bring-back that took a clip out is named so in History and in cb history's words, also when the clips after it moved back (demo rehearsal FINDINGS §4.4)", async () => {
  // one track of clips (a title over them would stop the ripple: bring-back-place.test.ts's layout)
  const one = (id: string, s: number, e: number) => clip(id, s, e, { playbackSpeed: 1 });
  const carton = await Carton.open({ adapter, store: createMemoryStore(), init: { doc: { name: "Film", tracks: [{ id: "t1", [POS]: "V" }], items: [one("a", 0, 5), one("b", 5, 10), one("c", 10, 15)] }, cutName: "Main cut" }, actor: alice });
  const ui = fromCarton(carton, { me: alice });
  await ui.ready;
  try {
    // D inserted at 5 with a ripple: B and C moved 3 s later
    await carton.commit({ ops: [{ op: "insert", path: ["items", "d"], value: one("d", 5, 8) }, set("b", "startTime", 8), set("b", "endTime", 13), set("c", "startTime", 13), set("c", "endTime", 18)], intent: { kind: "ripple-insert", maps: { t1: [{ d: [], i: [[5, 3]] }] } }, author: alice });
    // taken out as it was at @0 (it wasn't there): B and C move back
    const r = await ui.restoreClip!(`${carton.cut}@0`, "d", { remove: true });
    assert.deepEqual([r.how, r.ripple?.moved], ["removed", 2]);
    const v = (await carton.log({ limit: 1, summary: true, rows: true }))[0]!;
    assert.equal(v.summary, "Took out 'D'", "cb history's words (it read “Brought back 'D' from an earlier version”)");
    assert.equal(v.title?.removed, true);
    await ui.settled();
    const h = ui.history();
    h.at("all", 0);
    await ui.settled();
    await new Promise((res) => setTimeout(res, 20));
    assert.equal(h.at("all", 0)!.summary, "Took out “D”", "History's words");
  } finally {
    ui.dispose();
    await carton.close();
  }
});
