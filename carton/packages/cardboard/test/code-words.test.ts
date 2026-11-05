// History's words for program code, and where a part of a clip plays (laptop, 2026-11-05). A Claude Code turn's card
// read "Changed the code of “Cardboard on Windows” to “export default function Graphic({ tim…”", its time "—", and Play
// all did nothing: a code graphic's source is its own media entry (Cardboard's OWN_MEDIA), which had no place. Now the
// row names the graphic, says how many lines changed (never the code), and sits where the graphic is on the timeline,
// so ▶ and Play all play it. The same for a shader's and an inline code graphic's source, and in cb's words.
import { test } from "node:test";
import assert from "node:assert/strict";
import { changeList, changeSummary, codeLines, countChanges, describe, diff, nameShown, type Doc } from "@carton/core";
import { cardboardSchema, cardboardValue, fromHost, PROMPT_PREAMBLE } from "../src/index.ts";

const lines = (n: number, f = (i: number) => `  line ${i};`) => Array.from({ length: n }, (_, i) => f(i)).join("\n");
const SOURCE = `export default function Graphic({ time }) {\n${lines(20)}\n}`;
type Item = Record<string, unknown>;
const project = (o: { source?: string; items?: Item[]; media?: Item[] } = {}): Doc =>
  fromHost({
    name: "P",
    aspectRatio: "16:9",
    tracks: [{ id: "V1", name: "V1", order: 0, locked: false, visible: true, muted: false }],
    timelineItems: o.items ?? [{ id: "g1", trackId: "V1", type: "code", startTime: 4, endTime: 9, trimStart: 0, trimEnd: 5, mediaItemId: "m1", codeComposition: { width: 1920, height: 1080 } }],
    media: o.media ?? [{ id: "m1", data: { type: "code", fileName: "Cardboard on Windows", ...(o.source !== undefined ? { code: { source: o.source } } : {}) } }],
  }, null);
const rows = (a: Doc, b: Doc) => changeList(diff(a, b, cardboardSchema), a, cardboardSchema, { value: cardboardValue });
const noCode = (text: string) => assert.doesNotMatch(text, /export|function|Graphic|line \d|void main/, `no code in "${text}"`);

test("a code graphic's code changed: the graphic named, how many lines, never the code; at the graphic's place", () => {
  const a = project({ source: SOURCE });
  const b = project({ source: SOURCE.replace("line 3;", "line three;").replace("line 5;", "LINE 5;") });
  const r = rows(a, b);
  assert.equal(r.length, 1);
  assert.equal(r[0]!.text, "Changed the code of code graphic “Cardboard on Windows” (3 lines)");
  assert.equal(r[0]!.at, 4, "where the graphic starts");
  assert.equal(r[0]!.end, 9, "and ends");
  assert.equal(r[0]!.of?.id, "g1", "the graphic it is part of");
  assert.equal(r[0]!.key, "media/m1", "still the entry's change (its key, as cards and touched have it)");
  assert.equal(changeSummary(r, cardboardSchema), r[0]!.text);
  assert.equal(countChanges(diff(a, b, cardboardSchema), a, cardboardSchema), 1);
  // cb's own lines (`describe`, `cb history`'s details) say it the same way
  const cb = describe(diff(a, b, cardboardSchema), a, cardboardSchema);
  assert.deepEqual(cb, ["Changed 'Cardboard on Windows' code (3 lines)"]);
  for (const t of [...r.map((x) => x.text), ...cb]) noCode(t);
});

test("code set for the first time, one line changed, and a whole new source", () => {
  const empty = project(), first = project({ source: SOURCE });
  const set = rows(empty, first);
  assert.equal(set[0]!.text, "Set the code of code graphic “Cardboard on Windows” (22 lines)", "a structure holding the code, set whole");
  assert.equal(set[0]!.at, 4);
  noCode(describe(diff(empty, first, cardboardSchema), empty, cardboardSchema)[0]!);
  assert.equal(rows(first, project({ source: SOURCE.replace("line 7;", "line 7 ;") }))[0]!.text, "Changed the code of code graphic “Cardboard on Windows” (1 line)");
  const other = `export const X = 1;\n${lines(4, (i) => `// ${i}`)}`;
  assert.equal(rows(first, project({ source: other }))[0]!.text, "Changed the code of code graphic “Cardboard on Windows” (22 lines)", "the longer side's lines");
});

test("codeLines: one pass over the lines, their common first and last lines left out", () => {
  assert.equal(codeLines("a\nb\nc", "a\nB\nc"), 1);
  assert.equal(codeLines("a\nb\nc", "a\nb\nx\ny\nc"), 2, "two lines added");
  assert.equal(codeLines("a\nb\nc\nd", "a\nd"), 2, "two removed");
  assert.equal(codeLines(undefined, "a\nb"), 2, "set from nothing");
  assert.equal(codeLines("a\nb", "a\nb"), 0);
  assert.equal(codeLines("a\nb\nc\nd\ne", "A\nb\nc\nd\nE"), 5, "two edits far apart: the lines from the first to the last");
});

test("a shader's or a code graphic's own source on its item: never quoted either", () => {
  const shader = (src: string) => project({ items: [{ id: "s1", trackId: "V1", type: "shader", name: "Glow", startTime: 2, endTime: 6, trimStart: 0, trimEnd: 4, shaderComposition: { source: src, params: { amount: 1 } } }], media: [] });
  const glsl = "void main() {\n  fragColor = texture(u_input, v_uv);\n}";
  const r = rows(shader(glsl), shader(glsl.replace("texture(u_input, v_uv)", "vec4(1.0)")));
  assert.equal(r[0]!.text, "Changed the shader code of “Glow” (1 line)");
  assert.equal(r[0]!.at, 2);
  noCode(r[0]!.text);
  noCode(describe(diff(shader(glsl), shader(glsl + "\n// more"), cardboardSchema), shader(glsl), cardboardSchema)[0]!);
  const inline = (src: string) => project({ items: [{ id: "g2", trackId: "V1", type: "code", name: "Lower third", startTime: 1, endTime: 3, trimStart: 0, trimEnd: 2, codeComposition: { source: src, width: 1920, height: 1080 } }], media: [] });
  const ri = rows(inline(SOURCE), inline(SOURCE.replace("line 9;", "line nine;")));
  assert.equal(ri[0]!.text, "Changed the code of code graphic “Lower third” (1 line)");
  // its other fields still read as before this change (the size's words are older than it)
  assert.equal(rows(inline(SOURCE), project({ items: [{ id: "g2", trackId: "V1", type: "code", name: "Lower third", startTime: 1, endTime: 3, trimStart: 0, trimEnd: 2, codeComposition: { source: SOURCE, width: 1280, height: 1080 } }], media: [] }))[0]!.text, "Changed the code composition of “Lower third” to 1280");
});

test("a part told on its own takes its holder's place: a title's text entry; with two holders, the earliest, named as itself", () => {
  const title = (content: string) => project({
    items: [{ id: "w1", trackId: "V1", type: "text", name: "W1", textContent: "Hello", startTime: 7, endTime: 9, trimStart: 0, trimEnd: 2, mediaItemId: "t1" }],
    media: [{ id: "t1", data: { type: "text", fileName: "Text: W1", content } }],
  });
  const r = rows(title("Hello"), title("Hello there"));
  assert.equal(r.length, 1);
  assert.equal(r[0]!.at, 7, "the title's place");
  assert.equal(r[0]!.of?.id, "w1");
  // two graphics sharing one entry (a duplicate): no one holder to name it by, the earliest place
  const two = (source: string) => project({
    source,
    items: [
      { id: "g1", trackId: "V1", type: "code", startTime: 10, endTime: 12, trimStart: 0, trimEnd: 2, mediaItemId: "m1", codeComposition: { width: 1, height: 1 } },
      { id: "g2", trackId: "V1", type: "code", startTime: 3, endTime: 5, trimStart: 0, trimEnd: 2, mediaItemId: "m1", codeComposition: { width: 1, height: 1 } },
    ],
  });
  const d = rows(two(SOURCE), two(SOURCE.replace("line 1;", "line one;")));
  assert.equal(d[0]!.at, 3, "the earliest of its holders");
  assert.equal(d[0]!.end, 5);
  assert.equal(d[0]!.of, undefined);
  assert.equal(d[0]!.text, "Changed the code of “Cardboard on Windows” (1 line)");
  // a media file is no part: no place, as before
  const file = (name: string) => project({ items: [{ id: "c1", trackId: "V1", type: "video", startTime: 0, endTime: 4, trimStart: 0, trimEnd: 4, mediaItemId: "v1" }], media: [{ id: "v1", data: { type: "video", fileName: name } }] });
  assert.equal(rows(file("a.mp4"), file("b.mp4"))[0]!.at, undefined);
});

test("code graphics' code in one version: summed up by what holds them", () => {
  const p = (s1: string, s2: string) => project({
    items: [
      { id: "g1", trackId: "V1", type: "code", startTime: 0, endTime: 2, trimStart: 0, trimEnd: 2, mediaItemId: "m1", codeComposition: { width: 1, height: 1 } },
      { id: "g2", trackId: "V1", type: "code", startTime: 3, endTime: 5, trimStart: 0, trimEnd: 2, mediaItemId: "m2", codeComposition: { width: 1, height: 1 } },
    ],
    media: [{ id: "m1", data: { type: "code", fileName: "Intro card", code: { source: s1 } } }, { id: "m2", data: { type: "code", fileName: "Outro card", code: { source: s2 } } }],
  });
  const r = rows(p("a\nb", "c\nd"), p("a\nB", "C\nd"));
  assert.deepEqual(r.map((x) => [x.text, x.at]), [["Changed the code of code graphic “Intro card” (1 line)", 0], ["Changed the code of code graphic “Outro card” (1 line)", 3]]);
  assert.equal(changeSummary(r, cardboardSchema), "Changed the code of code graphic “Intro card” and code graphic “Outro card”", "two of a kind: both named, as for clips");
  // three: counted by what holds them, never "3 media files"
  const three = [...r, { ...r[1]!, key: "media/m3", one: "code graphic “Logo”" }];
  assert.equal(changeSummary(three, cardboardSchema), "Changed the code of 3 code graphics");
});

test("a turn named from Cardboard's composed prompt shows as unnamed; any other name as it is", () => {
  for (const n of ["[Earlier messages in this conversation did…", "[The user is switching to you…", "[This is a fresh agent session", "[Earlier messages in this conver…"]) {
    assert.ok(PROMPT_PREAMBLE.test(n), n);
    assert.equal(nameShown(cardboardSchema, n), undefined, n);
  }
  for (const n of ["Sent to client", "[Draft] intro", "Earlier messages in this conversation", "Split audio for J/L cuts"]) assert.equal(nameShown(cardboardSchema, n), n, n);
  assert.equal(nameShown(cardboardSchema, undefined), undefined);
});
