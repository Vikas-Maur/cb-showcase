// A conflict card's words (docs/carton-ux PLAN 7.1, DESIGN §8): each side's change sentence about the card's clip
// (cardSentences), and the card's title, lead, side names, Keep names and viewing labels (conflictWords). Never an id;
// the two sides never read the same; the view model's sides carry them, and `summary` stays core's describeCard.
import { test } from "node:test";
import assert from "node:assert/strict";
import { Carton, POS, defineSchema, object, timeAlgebra, type Actor as CoreActor, type ConflictCard, type Doc, type Rec } from "@carton/core";
import type { HostAdapter } from "@carton/core/plugins";
import { createMemoryStore } from "@carton/store-memory";
import { cardSentences, conflictWords, keptText } from "../src/conflict-words.ts";
import { fromCarton } from "../src/from-carton.ts";
import { people } from "../src/mock.ts";
import type { Actor, Conflict } from "../src/model.ts";

const TL = { collection: "items", lanes: "tracks", lane: "trackId", start: "startTime", end: "endTime", source: "trimStart", sourceEnd: "trimEnd", speed: "playbackSpeed" };
const schema = defineSchema({
  labels: { aspectRatio: "aspect ratio", name: "project name" },
  collections: {
    tracks: { seq: true, labels: { name: "name" } },
    items: {
      parent: { field: "trackId", collection: "tracks" },
      groups: [{ name: "time", fields: ["startTime", "endTime", "trimStart", "trimEnd", "playbackSpeed"], algebra: timeAlgebra(TL) }],
      fields: { style: object() },
      labels: { name: "name", trackId: "track", mediaItemId: "media", fontSize: "font size", opacity: "opacity", startTime: "start", endTime: "end", trimStart: "in point", trimEnd: "out point", playbackSpeed: "speed" },
    },
    media: { partOf: { collection: "items", field: "mediaItemId" }, labels: { "data.content": "text", "data.fileName": "file name" } },
  },
  timeline: TL,
  label: (coll, r) => (coll === "media" ? String((r as Rec | undefined)?.data && ((r as Rec).data as Rec).fileName) : String((r as Rec | undefined)?.name ?? coll)),
});
const clip = (id: string, s: number, e: number, extra: Rec = {}): Rec => ({ id, trackId: "t1", startTime: s, endTime: e, trimStart: 0, trimEnd: e - s, name: id === "ib" ? "Interview B" : id.toUpperCase(), ...extra });
const doc0 = (): Doc => ({
  name: "Film",
  aspectRatio: "16:9",
  tracks: [{ id: "t1", [POS]: "V", name: "Track 1" }, { id: "t2xYz9", [POS]: "W", name: "Titles" }],
  items: [clip("ib", 5, 9), clip("w6", 2, 4, { fontSize: 100, mediaItemId: "m-title-7f3" })],
  media: [{ id: "m-title-7f3", data: { content: "Summer launch", fileName: "Text: W6" } }, { id: "m-tone-1a2", data: { fileName: "Tone.mp3" } }],
});
const pct = (key: string, v: unknown) => (key === "opacity" && typeof v === "number" ? `${Math.round(v * 100)}%` : key === "mediaItemId" ? `'${v === "m-tone-1a2" ? "Tone.mp3" : "Upbeat.wav"}'` : undefined);
const S = (card: Omit<ConflictCard, "kind"> & { kind?: ConflictCard["kind"] }, doc: Doc | undefined = doc0()) => cardSentences({ kind: "field", ...card } as ConflictCard, schema, doc, pct);
const ID = /m-title|m-tone|t2xYz9|\bib\b|w6\b|[0-9a-f]{12,}/;

test("cardSentences: a move and a move, by where each put it, with the clip's name", () => {
  const s = S({ kind: "group", path: "items/ib/#time", base: { startTime: 5, endTime: 9 }, ours: { startTime: 18, endTime: 22 }, theirs: { startTime: 20, endTime: 24 } });
  assert.deepEqual(s, { clip: "Interview B", ours: { text: "Moved it to start at 0:18", did: "moved it", what: "move" }, theirs: { text: "Moved it to start at 0:20", did: "moved it", what: "move" } });
});

test("cardSentences: trims and retimes, a slip, a speed; each with its own noun", () => {
  const t = S({ kind: "group", path: "items/ib/#time", base: { startTime: 1.5, endTime: 6 }, ours: { startTime: 1.5, endTime: 5 }, theirs: { startTime: 2, endTime: 8 } });
  assert.deepEqual([t.ours.text, t.ours.what, t.theirs.text, t.theirs.did, t.theirs.what], ["Trimmed it to end at 0:05", "trim", "Set it to play 0:02–0:08", "changed when it plays", "timing"]);
  const start = S({ kind: "group", path: "items/ib/#time", base: { startTime: 0, endTime: 6 }, ours: { startTime: 1, endTime: 6 }, theirs: { startTime: 2, endTime: 6 } });
  assert.deepEqual([start.ours.text, start.theirs.text], ["Trimmed it to start at 0:01", "Trimmed it to start at 0:02"]);
  const slip = S({ kind: "group", path: "items/ib/#time", base: { startTime: 5, endTime: 9, trimStart: 0 }, ours: { startTime: 5, endTime: 9, trimStart: 3 }, theirs: { startTime: 7, endTime: 11, trimStart: 0 } });
  assert.deepEqual([slip.ours.text, slip.ours.what, slip.theirs.text], ["Slipped it to play its media from 0:03", "slip", "Moved it to start at 0:07"]);
});

test("cardSentences: two sides that would read the same are worded closer (0:05.0 and 0:05.3), never alike", () => {
  const s = S({ kind: "group", path: "items/ib/#time", base: { startTime: 1, endTime: 6 }, ours: { startTime: 5, endTime: 10 }, theirs: { startTime: 5.3, endTime: 10.3 } });
  assert.deepEqual([s.ours.text, s.theirs.text], ["Moved it to start at 0:05.0", "Moved it to start at 0:05.3"]);
  const t = S({ kind: "group", path: "items/ib/#time", base: { startTime: 1, endTime: 6 }, ours: { startTime: 5.01, endTime: 10.01 }, theirs: { startTime: 5.04, endTime: 10.04 } });
  assert.notEqual(t.ours.text, t.theirs.text);
});

test("cardSentences: a size made bigger and smaller; a value in the host's units; a title's text by its title", () => {
  const f = S({ path: "items/w6/fontSize", base: 100, ours: 80, theirs: 120 });
  assert.deepEqual(f, { clip: "W6", ours: { text: "Made it smaller (font size 80)", did: "changed its font size", what: "edit" }, theirs: { text: "Made it bigger (font size 120)", did: "changed its font size", what: "edit" } });
  const o = S({ path: "items/ib/opacity", base: 1, ours: 0.5, theirs: 0.7 });
  assert.deepEqual([o.ours.text, o.theirs.text, o.ours.did], ["Set its opacity to 50%", "Set its opacity to 70%", "changed its opacity"]);
  // a title's text lives in its own media entry: the card names the title, not "Text: W6"
  const text = S({ path: "media/m-title-7f3/data/content", base: "Hello", ours: "Summer launch", theirs: "Summer sale" });
  assert.deepEqual([text.clip, text.ours.text, text.theirs.text, text.ours.did], ["W6", "Changed it to “Summer launch”", "Changed it to “Summer sale”", "changed its text"]);
  // an id field the host words: its file name in curly quotes, never the id
  const media = S({ path: "items/ib/mediaItemId", base: "m-tone-1a2", ours: "m-tone-1a2", theirs: "m-up-9" });
  assert.deepEqual([media.ours.text, media.theirs.text], ["Set its media to “Tone.mp3”", "Set its media to “Upbeat.wav”"]);
});

test("cardSentences: removed, moved to a track by its name, renamed, a project setting; never an id", () => {
  const b = clip("ib", 5, 9);
  const rec = S({ kind: "record", path: "items/ib", base: b, ours: { ...b, opacity: 0.4 }, theirs: undefined });
  assert.deepEqual([rec.ours.text, rec.theirs.text, rec.theirs.did, rec.theirs.what], ["Set its opacity to 40%", "Removed it", "removed it", "removal"]);
  const lane = S({ path: "items/ib/trackId", base: "t1", ours: "t2xYz9", theirs: "t-gone" });
  assert.deepEqual([lane.ours.text, lane.theirs.text, lane.ours.what], ["Moved it to “Titles”", "Moved it to another track", "move"]);
  const name = S({ path: "items/ib/name", base: "B", ours: "Interview Bee", theirs: "Int. B" });
  assert.deepEqual([name.ours.text, name.theirs.did], ["Renamed it “Interview Bee”", "renamed it"]);
  const root = S({ path: "aspectRatio", base: "16:9", ours: "9:16", theirs: "1:1" });
  assert.deepEqual(root, { ours: { text: "Changed it to 9:16", did: "changed it", what: "aspect ratio" }, theirs: { text: "Changed it to 1:1", did: "changed it", what: "aspect ratio" } });
  const added = S({ kind: "record", path: "items/nw", base: undefined, ours: clip("nw", 10, 12), theirs: clip("nw", 11, 13) }, undefined);
  assert.deepEqual([added.clip, added.ours.text, added.theirs.text], ["NW", "Added it at 0:10", "Added it at 0:11"]);
  for (const s of [rec, lane, name, root, added]) for (const side of [s.ours, s.theirs]) assert.doesNotMatch(side.text, ID, side.text);
});

const side = (author: Actor, over: Partial<Conflict["mine"]> = {}) => ({ author, summary: "x", ...over });
const card = (over: Partial<Conflict>): Conflict => ({ id: "c", title: "'Interview B' timing", mine: side(people.alice), theirs: side(people.terminal), canKeepBoth: false, provisional: "mine", ...over });
const nameOf = (a: Actor) => (a.isYou && a.kind === "human" ? "You" : a.name);

test("conflictWords: the title says what both did, or what each did; the lead says which side the timeline shows", () => {
  const both = conflictWords(card({ clip: "Interview B", mine: side(people.alice, { did: "moved it", what: "move" }), theirs: side(people.terminal, { did: "moved it", what: "move" }) }), nameOf);
  assert.equal(both.title, "“Interview B”: you and Claude Code both moved it");
  assert.equal(both.lead, "Pick the one to keep. Until you pick, yours is in the timeline.");
  assert.deepEqual(both.name, { mine: "Yours", theirs: "Claude Code's", both: "Both" });
  assert.deepEqual(both.keep, { mine: "Keep yours", theirs: "Keep Claude Code's", both: "Keep both" });
  assert.deepEqual(both.label, { mine: "Your move of “Interview B”", theirs: "Claude Code's move of “Interview B”", both: "Both changes to “Interview B”" });
  assert.deepEqual(both.see, { mine: "See yours", theirs: "See Claude Code's" });
  const each = conflictWords(card({ clip: "Intro", mine: side(people.alice, { did: "trimmed it" }), theirs: side(people.director, { did: "changed when it plays" }), provisional: "theirs" }), nameOf);
  assert.equal(each.title, "“Intro”: you trimmed it and Director changed when it plays");
  assert.equal(each.lead, "Pick the one to keep. Until you pick, Director's is in the timeline.");
  const reason = conflictWords(card({ reason: "Doing both would end it before it starts." }), nameOf);
  assert.equal(reason.lead, "Doing both would end it before it starts.");
  const kb = conflictWords(card({ canKeepBoth: true, provisional: "both" }), nameOf);
  assert.equal(kb.lead, "Pick one to keep, or keep both. Until you pick, both are in the timeline.");
});

test("conflictWords: a host that gives no sentences keeps core's title; a project setting has no clip", () => {
  assert.equal(conflictWords(card({}), nameOf).title, "'Interview B' timing");
  const root = conflictWords(card({ title: "Aspect ratio", mine: side(people.alice, { did: "changed it", what: "aspect ratio" }), theirs: side(people.director, { did: "changed it", what: "aspect ratio" }) }), nameOf);
  assert.equal(root.title, "Aspect ratio: you and Director both changed it");
  assert.deepEqual([root.label.mine, root.label.theirs], ["Your aspect ratio", "Director's aspect ratio"]);
});

test("conflictWords: one person's two changes read as earlier and later; a teammate's too", () => {
  const at = (h: number, m: number) => new Date(2026, 10, 3, h, m).getTime();
  const you = conflictWords(card({ clip: "Summer launch", mine: side(people.alice, { at: at(10, 5), did: "changed its text" }), theirs: side(people.alice, { at: at(10, 4), did: "changed its text" }), provisional: "theirs" }), nameOf);
  assert.equal(you.title, "“Summer launch”: two of your changes disagree");
  assert.equal(you.lead, "You changed its text twice, from two places, at nearly the same time.");
  assert.deepEqual(you.name, { mine: "Your later change", theirs: "Your earlier change", both: "Both" });
  assert.deepEqual(you.keep, { mine: "Keep later", theirs: "Keep earlier", both: "Keep both" });
  assert.equal(you.label.theirs, "Your earlier change to “Summer launch”");
  assert.equal(you.ordered, true);
  assert.equal(you.first, "theirs", "the earlier change is listed first");
  const far = conflictWords(card({ clip: "X", mine: side(people.alice, { at: at(9, 0), did: "moved it" }), theirs: side(people.alice, { at: at(11, 0), did: "moved it" }) }), nameOf);
  assert.equal(far.lead, "You moved it twice, from two places.", "no 'nearly the same time' hours apart");
  const bob = conflictWords(card({ clip: "Intro", mine: side(people.bob, { at: 2000 }), theirs: side(people.bob, { at: 1000 }) }), nameOf);
  assert.deepEqual([bob.name.mine, bob.name.theirs, bob.title], ["Bob Okafor's later change", "Bob Okafor's earlier change", "“Intro”: two of Bob Okafor's changes disagree"]);
});

test("keptText: the toast names what was kept, as the card did", () => {
  const c = card({ clip: "Interview B", mine: side(people.alice, { what: "move" }), theirs: side(people.terminal, { what: "move" }) });
  assert.equal(keptText(c, "theirs"), "Kept Claude Code's move of “Interview B”.");
  assert.equal(keptText(c, "mine"), "Kept your move of “Interview B”.");
  assert.equal(keptText(c, "both"), "Kept both changes to “Interview B”.");
});

test("fromCarton: a reported card's sides carry their sentences, the clip's name and core's summary as before", async () => {
  const adapter: HostAdapter<Doc> = { name: "test", schema, schemaVersion: 1, fromHost: (x) => x, toHost: (d) => d };
  const alice: CoreActor = { kind: "human", id: "alice", name: "Alice", group: "alice@laptop" };
  const carton = await Carton.open({ adapter, store: createMemoryStore(), init: { doc: doc0(), cutName: "Main cut" }, actor: alice });
  const ui = fromCarton(carton, { me: alice, cardValue: pct });
  await ui.ready;
  // a stale save's clash, core's convention: ours = head (kept), theirs = the person's own edit
  ui.reportConflicts([{ kind: "field", path: "items/w6/fontSize", base: 100, ours: 80, theirs: 120 }]);
  for (let i = 0; i < 3; i++) await ui.settled();
  const [c] = ui.conflicts();
  assert.ok(c);
  assert.deepEqual([c.mine.summary, c.theirs.summary], ["120", "80"], "summary stays core's describeCard");
  assert.deepEqual([c.mine.text, c.mine.did, c.mine.what], ["Made it bigger (font size 120)", "changed its font size", "edit"]);
  assert.equal(c.theirs.text, "Made it smaller (font size 80)");
  assert.equal(c.clip, "W6", "the head names the clip");
  ui.dispose();
});
