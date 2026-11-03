// Carton UX v2 (N0): find a version by text, the landmarks people remember, bringing back one clip, and comparing two
// cuts. On a local cut, with a small schema that has what Cardboard's has: clips on tracks (`parent`), a title's own
// text entry (`partOf`), labels and the words a person typed (`words`).
import test from "node:test";
import assert from "node:assert/strict";
import { defineSchema } from "../src/schema.ts";
import { Carton, NotInVersion, pictureKey } from "../src/index.ts";
import type { Actor, Doc, Op, Rec } from "../src/types.ts";
import { createMemoryStore } from "../../store-memory/src/index.ts";

const POS = "#pos";
const schema = defineSchema({
  collections: {
    tracks: { key: "id", seq: true, noun: "track" },
    items: {
      key: "id",
      noun: "clip",
      parent: { field: "trackId", collection: "tracks" },
      nounOf: (r) => (r.type === "text" ? "title" : undefined),
      words: (r) => [r.text, ...((r.captions as Rec[] | undefined) ?? []).map((c) => c.text)].filter((x): x is string => typeof x === "string"),
    },
    media: {
      key: "id",
      noun: "media",
      nounOf: (r) => (r.own ? null : undefined),
      partOf: { collection: "items", field: "mediaId" },
      words: (r) => (typeof r.content === "string" ? [r.content] : []),
    },
  },
  label: (coll, r) => (r ? String(r.name ?? r.text ?? r.file ?? "?") : "?"),
  hard: (coll, r, doc) => (coll === "items" && !((doc.tracks as Rec[]) ?? []).some((t) => t.id === r.trackId) ? ["trackId must exist"] : []),
});
const adapter = { name: "t", schema, schemaVersion: 1, fromHost: (d: Doc) => d, toHost: (d: Doc) => d };
const me: Actor = { kind: "human", id: "me", name: "Vikas" };
const leo: Actor = { kind: "human", id: "leo", name: "Léo" };
const director: Actor = { kind: "agent", id: "director/chat-1/turn-1", name: "Director", chat: "chat-1", turn: "turn-1" };
const film = (): Doc => ({
  name: "Film",
  tracks: [{ id: "v1", name: "Video 1", [POS]: "V" }, { id: "t1", name: "Text 1", [POS]: "W" }],
  items: [
    { id: "c1", trackId: "v1", name: "Intro", start: 0, end: 6, mediaId: "m1" },
    { id: "c2", trackId: "v1", name: "Interview A", start: 6, end: 12, mediaId: "m1" },
    { id: "w1", trackId: "t1", type: "text", text: "Summer launch", start: 0, end: 3, mediaId: "x1" },
  ],
  media: [{ id: "m1", file: "clip.mp4" }, { id: "x1", own: true, content: "Summer launch" }],
}) as unknown as Doc;
const set = (coll: string, id: string, f: string, value: unknown): Op => ({ op: "set", path: [coll, id, f], value });
const open = (store = createMemoryStore(), clock?: () => number) => Carton.open({ adapter, store, init: { doc: film(), cutName: "Main cut" }, actor: me, ...(clock ? { clock } : {}) });
const items = (d: Doc) => Object.fromEntries((d.items as Rec[]).map((r) => [r.id, r]));

test("find: names, prompts, clips by their names then and after, text set, people; newest first, any case and accents", async () => {
  const c = await open();
  try {
    await c.commit({ ops: [set("items", "c1", "end", 4)] }); // @1 trims Intro
    await c.commit({ ops: [set("items", "c1", "name", "Opening")] }); // @2 renames it
    const sent = await c.commit({ ops: [set("items", "c2", "end", 11)] }); // @3
    await c.name((sent as { ref: { branchId: string; seq: number } }).ref, "Sent to client");
    await c.commit({ ops: [set("items", "w1", "text", "Summer ’26"), set("media", "x1", "content", "Summer ’26")], author: director }); // @4
    await c.name({ branchId: c.cut, seq: 4, pending: [] } as never, "Add captions to the intro");
    await c.commit({ ops: [set("items", "c2", "start", 7)], author: leo }); // @5

    // a clip by its name: the versions that touched it, by the name it had then or after
    const intro = await c.find("intro");
    assert.deepEqual(intro.matches.map((m) => [m.ref.seq, m.field]), [[4, "prompt"], [2, "clip"], [1, "clip"]]);
    assert.equal(intro.matches[1]!.recordName, "Intro", "the rename matches its old name");
    assert.equal(intro.matches[1]!.record, "items/c1");
    assert.deepEqual((await c.find("OPENING")).matches.map((m) => m.ref.seq), [2]);
    // a version's name, whole and as a snippet with the hit
    const s = (await c.find("client")).matches[0]!;
    assert.equal(s.field, "name");
    assert.equal(s.snippet, "Sent to client");
    assert.deepEqual(s.hit, [8, 14]);
    // text a version set (the title's), and the person: accents ignored
    const t = (await c.find("’26", { fields: ["clip", "text"] })).matches;
    // (a title's name is its text: it matches as the clip first, and as text too)
    assert.deepEqual(t.map((m) => [m.ref.seq, m.field, m.fields]), [[4, "clip", ["clip", "text"]]]);
    assert.equal(t[0]!.recordName, "Summer ’26");
    assert.deepEqual((await c.find("leo")).matches.map((m) => [m.ref.seq, m.field, m.snippet]), [[5, "person", "Léo"]]);
    // every word starts a word, in any order (DESIGN-V2 §2.3): "intr cap" finds the turn's request
    const ic = (await c.find("intr cap")).matches;
    assert.deepEqual(ic.map((m) => [m.ref.seq, m.field]), [[4, "prompt"]]);
    assert.equal(ic[0]!.snippet, "Add captions to the intro");
    assert.deepEqual(ic[0]!.hits, [[20, 24], [4, 7]]);
    assert.equal((await c.find("tro")).total, 0, "from a word's start only");
    // a clip first: the one the words name, by any name it had
    assert.deepEqual((await c.find("intro")).clips, [{ record: "items/c1", name: "Opening", cut: c.cut }]);
    // you, and the day
    assert.deepEqual((await c.find("you")).matches.map((m) => m.ref.seq), [3, 2, 1]);
    assert.equal((await c.find("today")).total, 5);
    // only some fields; a limit counts the rest in total
    assert.deepEqual((await c.find("intro", { fields: ["clip"] })).matches.map((m) => m.ref.seq), [2, 1]);
    const one = await c.find("intro", { limit: 1 });
    assert.equal(one.matches.length, 1);
    assert.equal(one.total, 3);
    assert.deepEqual((await c.find("intro", { before: 2 })).matches.map((m) => m.ref.seq), [1]);
    // an empty text builds the index and finds nothing
    assert.deepEqual(await c.find("  "), { clips: [], matches: [], total: 0, versions: 5 });
    // new versions are found by the next call (the index grows by the rows since)
    await c.commit({ ops: [{ op: "insert", path: ["items", "c9"], value: { id: "c9", trackId: "v1", name: "Drone shot", start: 12, end: 14, mediaId: "m1" } }] });
    assert.deepEqual((await c.find("drone")).matches.map((m) => [m.ref.seq, m.field]), [[6, "clip"]]);
    // a deleted clip is found by the name it had
    await c.commit({ ops: [{ op: "remove", path: ["items", "c9"] }] });
    assert.deepEqual((await c.find("drone")).matches.map((m) => m.ref.seq), [7, 6]);
    // never an id
    assert.equal((await c.find("c9")).total, 0);
  } finally {
    await c.close();
  }
});

test("landmarks: recorded (exported, a session start once a day), named, turns, safety points before a restore and a bring-back; newest first", async () => {
  let now = Date.UTC(2026, 10, 2, 9, 0);
  const c = await open(createMemoryStore(), () => now);
  try {
    assert.ok(await c.mark("start", { once: "day" }));
    assert.equal(await c.mark("start", { once: "day" }), null, "once a day");
    now += 60_000;
    await c.commit({ ops: [set("items", "c1", "end", 4)] }); // @1
    const ex = await c.mark("exported", { label: "1080p" });
    assert.equal(ex!.ref.seq, 1);
    assert.equal(ex!.picture, pictureKey(ex!.ref));
    await c.name({ branchId: c.cut, seq: 1, pending: [] } as never, "1080p for the client");
    now += 60_000;
    await c.commit({ ops: [set("items", "c2", "end", 11)], author: director }); // @2, a turn
    await c.commit({ ops: [set("items", "c2", "end", 10)], author: director }); // @3, the same turn
    await c.restore(`${c.cut}@1`); // @4: safety point @3
    await c.restoreClip(`${c.cut}@0`, "items/c1"); // @5: safety point @4
    const all = await c.landmarks();
    assert.deepEqual(all.map((l) => [l.kind, l.ref.seq, l.before ?? l.label ?? null]), [
      ["before", 4, "bring-back"],
      ["before", 3, "restore"],
      ["turn", 3, null],
      ["exported", 1, "1080p"],
      ["named", 1, "1080p for the client"],
      ["start", 0, null],
    ]);
    const kinds = Object.fromEntries(all.map((l) => [l.kind, [l.personal, l.local]]));
    assert.deepEqual(kinds, { before: [true, true], turn: [false, false], exported: [false, true], named: [false, false], start: [true, true] });
    assert.equal(all.find((l) => l.kind === "before" && l.before === "restore")!.after, `${c.cut}@4`);
    assert.deepEqual((await c.landmarks({ kinds: ["exported", "start"] })).map((l) => l.kind), ["exported", "start"]);
    // a new day: another session start
    now += 86_400_000;
    assert.ok(await c.mark("start", { once: "day" }));
    // recorded ones are this machine's: they stay in the local ephemeral table
    const rows = await c.store.range("ephemeral", { prefix: ["landmark"] });
    assert.equal(rows.length, 3);
  } finally {
    await c.close();
  }
});

test("bring back one clip: as it was then, everything else as it is now; deleted since comes back with its track; one undo", async () => {
  const c = await open();
  try {
    await c.commit({ ops: [set("items", "c1", "end", 4), set("items", "c1", "name", "Intro v2")] }); // @1
    await c.commit({ ops: [set("items", "c2", "end", 11)] }); // @2 (stays)
    const r = await c.restoreClip(`${c.cut}@0`, "items/c1");
    assert.equal(r.status, "confirmed");
    assert.deepEqual({ how: r.brought.how, name: r.brought.name, of: r.brought.of }, { how: "changed", name: "Intro", of: `${c.cut}@0` });
    let head = items((await c.head()).doc);
    assert.equal(head.c1!.end, 6);
    assert.equal(head.c1!.name, "Intro");
    assert.equal(head.c2!.end, 11, "everything else stays");
    const v = (await c.log({ limit: 1, summary: true, rows: true }))[0]!;
    assert.equal(v.kind, "restore");
    assert.equal(v.summary, "Brought back 'Intro' from an earlier version");
    assert.deepEqual(v.title, { kind: "bring-back", of: `${c.cut}@0`, record: "items/c1", name: "Intro" });
    assert.equal(v.restoreRecord, "items/c1");
    // one undo takes it back
    await c.undo();
    assert.equal(items((await c.head()).doc).c1!.end, 4);

    // a title deleted since (with its own text entry) and its track: they come back as they were
    await c.commit({ ops: [{ op: "remove", path: ["items", "w1"] }, { op: "remove", path: ["media", "x1"] }, { op: "remove", path: ["tracks", "t1"] }] });
    const back = await c.restoreClip(`${c.cut}@0`, ["items", "w1"]);
    assert.equal(back.brought.how, "added");
    assert.deepEqual(back.brought.parts.sort(), ["media/x1", "tracks/t1"]);
    const d = (await c.head()).doc;
    assert.equal(items(d).w1!.text, "Summer launch");
    assert.ok((d.media as Rec[]).some((m) => m.id === "x1"));
    assert.ok((d.tracks as Rec[]).some((t) => t.id === "t1"));

    // a clip that wasn't there then: removed only when asked, in words that say so
    await c.commit({ ops: [{ op: "insert", path: ["items", "c9"], value: { id: "c9", trackId: "v1", name: "Drone shot", start: 12, end: 14, mediaId: "m1" } }] });
    const seq = (await c.head()).ref.seq;
    await assert.rejects(c.restoreClip(`${c.cut}@0`, "items/c9"), (e: Error) => e instanceof NotInVersion && /“Drone shot” wasn't in that version/.test(e.message));
    assert.equal((await c.head()).ref.seq, seq, "nothing written");
    const gone = await c.restoreClip(`${c.cut}@0`, "items/c9", { remove: true });
    assert.equal(gone.brought.how, "removed");
    assert.equal(items((await c.head()).doc).c9, undefined);
    assert.ok((await c.head()).doc.media && ((await c.head()).doc.media as Rec[]).some((m) => m.id === "m1"), "a shared media file stays");

    // already as it was: nothing saved
    const same = await c.restoreClip(`${c.cut}@0`, "items/c2");
    assert.equal(same.brought.how, "changed");
    const again = await c.restoreClip(`${c.cut}@0`, "items/c2");
    assert.equal(again.brought.how, "same");
    assert.equal(again.status === "confirmed" && again.empty, true);

    // "Choose a clip…": what differs from @0, in three groups (DESIGN-V2 §3.2)
    const ch = await c.bringBackChoices(`${c.cut}@0`);
    assert.deepEqual({ changed: ch.changed.map((x) => x.name), deleted: ch.deleted.map((x) => x.name), added: ch.added.map((x) => x.name), same: ch.same }, { changed: ["Intro v2"], deleted: [], added: [], same: 2 });
    await c.commit({ ops: [set("items", "c1", "end", 2), { op: "remove", path: ["items", "c2"] }, { op: "insert", path: ["items", "c8"], value: { id: "c8", trackId: "v1", name: "Logo", start: 20, end: 22, mediaId: "m1" } }], author: leo });
    const ch2 = await c.bringBackChoices(`${c.cut}@0`);
    assert.deepEqual(ch2.changed.map((x) => [x.name, x.then?.text, x.now?.text]), [["Intro v2", undefined, undefined]]);
    assert.deepEqual(ch2.deleted.map((x) => [x.name, x.by?.name]), [["Interview A", "Léo"]]);
    assert.deepEqual(ch2.added.map((x) => [x.name, x.by?.name]), [["Logo", "Léo"]]);
    assert.equal(ch2.same, 1);
    // a retried id answers the first time and makes nothing more
    await c.commit({ ops: [set("items", "c1", "end", 3)] });
    const id = c.newChangeId();
    const first = await c.restoreClip(`${c.cut}@0`, "items/c1", { id });
    const n = (await c.head()).ref.seq;
    const retry = await c.restoreClip(`${c.cut}@0`, "items/c1", { id });
    assert.equal((await c.head()).ref.seq, n);
    assert.equal(first.status === "confirmed" && retry.status === "confirmed" && first.seq === retry.seq, true);
  } finally {
    await c.close();
  }
});

test("compare across cuts: a version of one cut against another cut's (a cut id is its head), with change rows and a count", async () => {
  const c = await open();
  try {
    await c.commit({ ops: [set("items", "c1", "end", 4)] }); // main@1
    const insta = await c.fork("30s Instagram cut");
    await c.commit({ cut: insta.id, ops: [{ op: "remove", path: ["items", "c2"] }, set("items", "c1", "name", "Hook")] });
    const d = await c.diff(`${c.cut}@1`, insta.id, { rows: true });
    assert.equal(d.count, 2);
    assert.deepEqual(d.rows!.map((r) => r.kind).sort(), ["change", "remove"]);
    // and the other way, from the cut's head to a version of the main cut
    const back = await c.diff(insta.id, `${c.cut}@1`, { rows: true });
    assert.equal(back.count, 2);
    assert.deepEqual(back.rows!.map((r) => r.kind).sort(), ["add", "change"]);
  } finally {
    await c.close();
  }
});
