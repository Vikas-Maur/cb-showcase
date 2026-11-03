// The design QA's word and colour gaps (docs/carton-ux/qa/QA.md, fix/ux2-c): credits' verbs (G7), the new-cut toast and
// labels ending in "…" (G21), Comments' screen-reader labels (G22), cut dots far apart (G25), first names (G27), the
// retired words (G28) and the fallbacks (G30). Pure, no DOM.
import { test } from "node:test";
import assert from "node:assert/strict";
import { actorDetail, actorLabel, firstName } from "../src/actors.ts";
import { commentWords } from "../src/comments/words.ts";
import { conflictWords, sideText, tidySummary } from "../src/conflict-words.ts";
import { clipCredits, creditVerbOf } from "../src/credits.ts";
import { CUT_COLORS, cutColors } from "../src/cuts.ts";
import { createMockUi, people } from "../src/mock.ts";
import { words } from "../src/words.ts";
import type { Actor, Conflict } from "../src/model.ts";

test("G7: a credit's verb is what its change did to the clip: trimmed, moved, both; never retimed", async () => {
  assert.equal(creditVerbOf("Trimmed “Interview B”, now ends at 0:27"), "Trim");
  assert.equal(creditVerbOf("Moved “Interview B” 2 s later"), "Move");
  assert.equal(creditVerbOf("Trimmed “Interview B”, now 0:01 to 0:05, moved it to Track 2"), "TrimMove");
  assert.equal(creditVerbOf("Added “Interview B”"), "Added");
  assert.equal(creditVerbOf("Changed the saturation of “Interview B” to 120%"), null);
  assert.deepEqual(Object.values(words.creditVerb).filter((v) => /retime/.test(v)), [], "no credit says retimed");

  const ui = createMockUi({ versions: 0 });
  const v = (summary: string, author: Actor, text: string) => {
    return ui.addVersion({ author, kind: "edit", summary }, [{ key: "timelineItems/ib", itemId: "ib", clip: "video", kind: "change", text }]).id;
  };
  const trim = v("Trimmed", people.director, "Trimmed “Interview B”, now ends at 0:27");
  const move = v("Moved", people.alice, "Moved “Interview B” 2 s later");
  ui.credits = async () => ({
    clip: "ib",
    lines: [
      { what: "Added", author: people.alice, at: 1 },
      { what: "Timing", author: people.director, at: 2, versionId: trim },
      { what: "Timing", author: people.alice, at: 3, versionId: move },
      { what: "Timing", author: people.alice, at: 4 },
      // a host's own part ("Last change", fromCarton's default): the change says what it did
      { what: "Last change", author: people.alice, at: 5, versionId: move },
    ],
  });
  const c = await clipCredits(ui, "ib", words);
  assert.deepEqual(c.parts.map((p) => p.verb), ["added", "trimmed", "moved", "timing changed", "moved"]);
  assert.equal(c.kind, "video", "the clip's kind, for its chip");
});

test("G21: the new-cut toast is DESIGN's one line, and a label ending in an ellipsis takes no full stop", () => {
  assert.equal(`${words.onCutMadeFrom("30s Instagram cut", "Director's “Add captions…”")} ${words.cutUnchanged("Main cut")}`, "You're on “30s Instagram cut” now. Main cut is unchanged.");
  const label = "Director's “Add captions…”";
  for (const s of [words.lookingAt(label), words.keptToast(label), words.restoredToast(label), words.tookOut(label), words.sameAs(label), words.lookingAtAnnounce(label), words.teammateCut(label)])
    assert.doesNotMatch(s, /…”\./, s);
  assert.equal(words.lookingAt(label), "You're looking at Director's “Add captions…”");
  assert.equal(words.lookingAt("“Sent to client”"), "You're looking at “Sent to client”.");
  assert.equal(words.restoredToast(label), "Restored Director's “Add captions…” Later changes are in History.");
});

test("G22: Comments' screen-reader labels read as sentences", () => {
  assert.equal(commentWords.threadLabel(null, "0:47"), "Your comment at 0:47");
  assert.equal(commentWords.threadLabel("Bob", null), "Bob's comment on the whole video");
  assert.equal(commentWords.forAgent(null, "Director"), "Director");
  assert.equal(commentWords.forAgent("Leo", "Director"), "Leo's Director");
});

test("G25: cut dots are hues far apart, and a teammate's cut never takes one of yours", () => {
  assert.deepEqual(CUT_COLORS, ["#f59e0b", "#22d3ee", "#a78bfa", "#f472b6", "#a3e635", "#14a9ff"]);
  const leo: Actor = { key: "human/leo", kind: "human", name: "Leo Park" };
  const cuts = [
    { id: "main", kind: "main" as const, readOnly: false },
    { id: "ig", kind: "cut" as const, readOnly: false },
    { id: "leo-main", kind: "main" as const, readOnly: true },
    { id: "leo-30", kind: "cut" as const, readOnly: true },
  ];
  for (let mine = 0; mine < 5; mine++) {
    const list = [...cuts, ...Array.from({ length: mine }, (_, i) => ({ id: `c${i}`, kind: "cut" as const, readOnly: false }))];
    const colors = cutColors(list, (id) => (id.startsWith("leo") ? leo : undefined));
    assert.equal(colors.has("main"), false, "Main cut has no dot");
    assert.equal(colors.get("leo-main"), colors.get("leo-30"), "one teammate, one colour");
    const yours = list.filter((c) => !c.readOnly && c.id !== "main").map((c) => colors.get(c.id));
    assert.ok(!yours.includes(colors.get("leo-main")), `${mine + 1} cuts of yours: Leo's dot is none of them`);
    assert.equal(new Set(yours).size, yours.length, "yours all differ");
  }
});

test("G27, G30: a teammate is their first name everywhere, a person with no name is Teammate, never an id", () => {
  const leo: Actor = { key: "human/leo", kind: "human", name: "Leo Park" };
  const leosDirector: Actor = { key: "agent/d", kind: "agent", name: "Director", parent: "human/leo" };
  const byKey = (k: string) => (k === leo.key ? leo : undefined);
  assert.equal(actorLabel(leo, byKey, "You"), "Leo");
  assert.equal(actorLabel(leosDirector, byKey, "You"), "Leo's Director");
  assert.equal(actorDetail(leo, byKey, "You"), "Leo Park", "the whole name on hover");
  assert.equal(actorDetail({ ...leo, name: "Leo" }, byKey, "You"), undefined, "nothing more to say");
  assert.equal(actorLabel({ key: "human/x-7f3a", kind: "human", name: "" }, byKey, "You"), "Teammate");
  assert.equal(firstName("  Mia   Chen "), "Mia");
  assert.equal(actorLabel({ ...leo, isYou: true }, byKey, "You"), "You");
});

test("G28: the retired words are gone from the table", () => {
  for (const k of ["hideConflicts", "setAsideHint", "setAsideList", "showAgain", "seePreview", "seePreviewOf", "conflictsWaiting"]) assert.equal(k in words, false, k);
  const all = JSON.stringify(Object.values(words).map((v) => (typeof v === "function" ? (v as (...a: unknown[]) => string)("x", 1, 2) : v)));
  for (const w of ["Hide conflicts", "Set aside", "Show again", "Preview:", "retimed"]) assert.ok(!all.includes(w), w);
});

test("review: two teammates with one first name are two authors on a card; Both stays reachable; quoted names aren't verbs", async () => {
  const park: Actor = { key: "human/leo-park", kind: "human", name: "Leo Park" };
  const chen: Actor = { key: "human/leo-chen", kind: "human", name: "Leo Chen" };
  const side = (author: Actor) => ({ author, summary: "starts at 0:18", text: "Moved it to start at 0:18", did: "moved it", what: "move" });
  const cw = conflictWords({ id: "c", path: "items/i", title: "'Intro' timing", clip: "Intro", mine: side(park), theirs: side(chen), canKeepBoth: false, provisional: "mine" }, (a) => actorLabel(a, undefined, "You"));
  assert.equal(cw.ordered, false, "not one person's two changes");
  assert.equal(cw.title, "“Intro”: Leo Park and Leo Chen both moved it");
  assert.notEqual(cw.keep.mine, cw.keep.theirs, "two buttons never read the same");
  // a clip's own name says nothing about what was done to it
  assert.equal(creditVerbOf("Moved “I trimmed it yesterday” 2 s later"), "Move");
  // core's title with an apostrophe in the name
  assert.equal(conflictWords({ id: "c", path: "items/i", title: "'Bob's intro' timing", mine: { author: people.alice, summary: "x" }, theirs: { author: people.director, summary: "y" }, canKeepBoth: false, provisional: "mine" }, (a) => actorLabel(a, undefined, "You")).title, "“Bob's intro”: you and Director both changed it");
  assert.equal(tidySummary("Renamed 'Bob's intro' to 'Outro'"), "Renamed “Bob's intro” to “Outro”");
  // a turn's row says what the turn did together: its credit keeps "timing changed"
  const ui = createMockUi({ versions: 0 });
  const turn = ui.addVersion({ author: people.director, kind: "turn", turn: { label: "Tighten", edits: 2 } }, [{ key: "timelineItems/ib", itemId: "ib", clip: "video", kind: "change", text: "Trimmed “Interview B”, now 0:01 to 0:05" }]).id;
  ui.credits = async () => ({ clip: "ib", lines: [{ what: "Timing", author: people.director, at: 1, versionId: turn }] });
  assert.deepEqual((await clipCredits(ui, "ib", words)).parts.map((p) => p.verb), ["timing changed"]);
});

test("G30: a card without its sentences reads as the others do", () => {
  const side = (author: Actor, summary: string) => ({ author, summary });
  const c: Conflict = { id: "c", path: "items/i", title: "'Intro' timing", mine: side(people.alice, "Trimmed the end to 0:05.0"), theirs: side(people.director, "starts at 0:18.0"), canKeepBoth: false, provisional: "mine" };
  const cw = conflictWords(c, (a) => actorLabel(a, undefined, "You"));
  assert.equal(cw.title, "“Intro”: you and Director both changed it");
  assert.equal(sideText(c.mine), "Trimmed the end to 0:05");
  assert.equal(tidySummary("Moved 'W6' 0:02.0 → 0:04.0"), "Moved “W6” 0:02 → 0:04");
  // a project setting keeps its title as the subject
  assert.equal(conflictWords({ ...c, title: "Aspect ratio" }, (a) => actorLabel(a, undefined, "You")).title, "Aspect ratio: you and Director both changed it");
  // one person's two changes
  const twice = conflictWords({ ...c, theirs: side(people.alice, "starts at 0:18.0") }, (a) => actorLabel(a, undefined, "You"));
  assert.equal(twice.title, "“Intro”: two of your changes disagree");
});
