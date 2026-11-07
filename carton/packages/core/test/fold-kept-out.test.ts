// Fold in some of it, with a track kept out (laptop rehearsal, 2026-11-07): `cb fold "Main cut" --into "<cut>" --reject
// tracks/<Talk> …` kept the Talk track out but brought in a clip added on it after the reject list was made, pointing at
// no track; Cardboard printed it on a made-up "Missing track". A record whose parent is kept out and isn't in the cut
// folded into stays out too, and so does a part the fold would add that only kept-out records name (a title's own text
// entry). Each counts as left out, and the result says which (`keptOut`). A clip on a track that comes in still comes.
import test from "node:test";
import assert from "node:assert/strict";
import { defineSchema } from "../src/schema.ts";
import { Carton } from "../src/index.ts";
import type { Actor, Doc, Rec } from "../src/types.ts";
import { createMemoryStore } from "../../store-memory/src/index.ts";

const schema = defineSchema({
  collections: {
    tracks: { key: "id", seq: true, noun: "track" },
    items: { key: "id", noun: "clip", parent: { field: "trackId", collection: "tracks" } },
    media: { key: "id", noun: "media", nounOf: (r) => (r.own ? null : undefined), partOf: { collection: "items", field: "mediaId" } },
  },
  label: (_c, r) => String(r?.name ?? "?"),
});
const adapter = { name: "t", schema, schemaVersion: 1, fromHost: (d: Doc) => d, toHost: (d: Doc) => d };
const me: Actor = { kind: "human", id: "me", name: "Vikas" };
const film = (): Doc => ({ tracks: [{ id: "v1", name: "Footage", "#pos": "a" }], items: [{ id: "a", trackId: "v1", name: "Opening shot", mediaId: "clip" }], media: [{ id: "clip", name: "clip.mp4" }] }) as unknown as Doc;
const ins = (coll: string, value: Rec) => ({ op: "insert" as const, path: [coll, String(value.id)], value });
const ids = (d: Doc, coll: string) => ((d[coll] as Rec[] | undefined) ?? []).map((r) => r.id).sort();

test("a clip added on a kept-out track after the reject list was made stays out with its own entry; the rest comes in", async () => {
  const c = await Carton.open({ adapter, store: createMemoryStore(), init: { doc: film(), cutName: "Main cut" }, actor: me });
  try {
    const main = c.cut;
    const hide = await c.fork("Hide", { from: `${main}@0` });
    // on Main: the chat's track, a title on it with its own text entry
    await c.commit({ cut: main, ops: [ins("tracks", { id: "talk", name: "Talk", "#pos": "b" }), ins("items", { id: "c1", trackId: "talk", name: "Psst", mediaId: "m1" }), ins("media", { id: "m1", name: "Text: Psst", own: true })] });
    // the agent's reject list, made now
    const reject = ["tracks/talk", "items/c1", "media/m1"];
    // then a newer title on Talk (not in the list), and real work on Footage and on a new track that comes in
    await c.commit({ cut: main, ops: [ins("items", { id: "c2", trackId: "talk", name: "Hello again", mediaId: "m2" }), ins("media", { id: "m2", name: "Text: Hello again", own: true }), ins("items", { id: "e", trackId: "v1", name: "B-roll", mediaId: "clip" }), ins("tracks", { id: "t2", name: "Titles", "#pos": "c" }), ins("items", { id: "f", trackId: "t2", name: "Opening title", mediaId: "m3" }), ins("media", { id: "m3", name: "Text: Opening title", own: true })] });
    const r = await c.foldSome(`${main}@2`, { into: hide.id, reject });
    assert.equal(r.status, "confirmed", JSON.stringify(r));
    const d = (await c.head(hide.id)).doc;
    const tracks = new Set(ids(d, "tracks"));
    assert.deepEqual(((d.items as Rec[]) ?? []).filter((i) => !tracks.has(i.trackId as string)).map((i) => i.id), [], "every clip on a track the cut has: none on a made-up one");
    assert.deepEqual(ids(d, "tracks"), ["t2", "v1"], "no Talk track");
    assert.deepEqual(ids(d, "items"), ["a", "e", "f"], "the chat's clips kept out; the work on Footage and Titles came in");
    assert.deepEqual(ids(d, "media"), ["clip", "m3"], "no chat entry in the bin");
    assert.deepEqual([...(r.keptOut ?? [])].sort(), [...reject, "items/c2", "media/m2"].sort(), "the clip on Talk and its own entry kept out with the list");
    // History's "(N left out)": the fold's version lists everything kept out
    const v = (await c.log({ cut: hide.id, limit: 1 }))[0]!;
    assert.deepEqual([...(v.rejected ?? [])].sort(), [...reject, "items/c2", "media/m2"].sort());
    // a list that needs nothing more is used as given (no keptOut)
    const again = await c.fork("Hide 2", { from: `${main}@0` });
    const plain = await c.foldSome(`${main}@1`, { into: again.id, reject });
    assert.equal(plain.status, "confirmed");
    assert.equal(plain.keptOut, undefined);
  } finally {
    await c.close();
  }
});
