// Laptop, final candidate P1-1: a project recovered through History couldn't save any GUI edit. Its project.json had
// seven media entries with only {id, data}: no createdAt or addedAt, which Cardboard's editor reads into Dates at load
// and writes back at every save (installErrorTelemetry `P2`, `p9`: `.toISOString()`), so every save threw "Invalid time
// value". History never versions those dates, and nothing had kept them: the entries came back from history alone.
// Cardboard's renderer can't run here, so these assert what `p9` needs of every entry a writer makes: createdAt and
// addedAt that `new Date(x).toISOString()` takes.
// P2-1: the schema's own rule for a state Cardboard can't open as a project (`emptyProject`, core's `Schema.empty`).
import test from "node:test";
import assert from "node:assert/strict";
import { isBlank } from "@carton/core";
import type { Rec } from "@carton/core";
import { cardboardSchema, completeMedia, emptyProject, fromHost, materializeProject, mediaDetails, projectProblems, undatedMedia } from "../src/index.ts";

/** What Cardboard's editor does with an entry's dates at every save (`p9` after `P2`): throws when it can't. */
const p9 = (m: Rec) => ({ createdAt: new Date(m.createdAt as string).toISOString(), addedAt: new Date(m.addedAt as string).toISOString() });

const CREATED = "2026-11-02T03:29:40.796Z";
// The laptop's recovered project, its shape (ids and kinds as in docs/regress/final/restore/project-json): a clip and
// six titles, each back from history with only what history holds.
const titles = ["W1", "W2", "W3", "W4", "W5", "W6"].map((w, i) => ({ id: `t${i}`, data: { type: "text", fileName: `Text: ${w}`, content: w } }));
const recoveredMedia = [{ id: "v0", data: { type: "video", fileName: "clip.mp4", src: "cardboard-media://media/v0", format: "mp4", size: 18_900_000, duration: 24 } }, ...titles];
const recovered = { id: "p", name: "Oldest restore", createdAt: CREATED, updatedAt: "2026-11-02T16:18:34.592Z", stateUpdatedAt: 5, aspectRatio: "16:9", tracks: [], timelineItems: [], media: recoveredMedia };
// what the old bug left: no name, no aspect ratio, nothing in it (its host fields kept)
const broken = { id: "p", createdAt: CREATED, updatedAt: "2026-11-02T09:00:00.000Z", stateUpdatedAt: 4, tracks: [], timelineItems: [], media: [] };

test("P1-1: a restore of entries history alone holds writes each with the dates Cardboard's editor saves (the project's own date), and a title as Cardboard makes one", () => {
  const out = materializeProject(fromHost(recovered), broken).media as Rec[];
  assert.equal(out.length, 7);
  for (const m of out) {
    assert.doesNotThrow(() => p9(m), `${m.id}: ${JSON.stringify(m)}`);
    assert.deepEqual([m.createdAt, m.addedAt], [CREATED, CREATED], "nothing kept its date: the project's, when it was made");
  }
  for (const m of out.slice(1)) assert.deepEqual(m.data, { type: "text", fileName: (m.data as Rec).fileName, content: (m.data as Rec).content, format: "text", size: 0, presetId: "custom" }, "as library-worker.js's ZZ makes a title's media");
  // a project with no createdAt: when it was last saved; neither: Cardboard's own rule for a date it can't read (the epoch)
  const { createdAt: _c, ...noCreated } = broken;
  assert.equal((materializeProject(fromHost(recovered), noCreated).media as Rec[])[0]!.createdAt, broken.updatedAt);
  const { updatedAt: _u, ...noDates } = noCreated;
  assert.equal((materializeProject(fromHost(recovered), noDates).media as Rec[])[0]!.createdAt, "1970-01-01T00:00:00.000Z");
  assert.equal((materializeProject(fromHost(recovered), null).media as Rec[])[0]!.addedAt, "1970-01-01T00:00:00.000Z");
});

test("P1-1: real dates wherever something has them: the file's own entry, then what was kept of that media; addedAt follows createdAt", () => {
  const clip = { id: "v0", createdAt: "2026-11-01T10:00:00.000Z", addedAt: "2026-11-01T10:05:00.000Z", data: { type: "video", fileName: "clip.mp4", src: "cardboard-media://media/v0", size: 1, duration: 3 } };
  const doc = fromHost({ ...recovered, media: [clip] });
  // the file has it
  assert.deepEqual((materializeProject(doc, { ...broken, media: [clip] }).media as Rec[])[0], clip);
  // the file lost it, its details were kept (.carton/media.json)
  assert.deepEqual((materializeProject(doc, broken, () => mediaDetails(clip)).media as Rec[])[0], clip);
  // only one of them (an older writer's): the other is filled from it; an unreadable one is replaced, a readable one kept
  const only = (e: Rec) => (materializeProject(doc, { ...broken, media: [{ ...clip, ...e }] }).media as Rec[])[0]!;
  assert.deepEqual([only({ createdAt: undefined }).createdAt, only({ createdAt: undefined }).addedAt], [clip.addedAt, clip.addedAt]);
  assert.deepEqual([only({ addedAt: undefined }).createdAt, only({ addedAt: undefined }).addedAt], [clip.createdAt, clip.createdAt]);
  assert.deepEqual([only({ createdAt: "t" }).createdAt, only({ addedAt: "soon" }).addedAt], [clip.addedAt, clip.createdAt]);
  for (const e of [{ createdAt: undefined }, { addedAt: undefined }, { createdAt: "t" }, { addedAt: "soon" }, { createdAt: 7 }]) assert.doesNotThrow(() => p9(only(e)), JSON.stringify(e));
});

test("P1-1: completeMedia (the loaders' repair of a file already on disk) fills what the editor needs, the same object when nothing is missing", () => {
  const fixed = completeMedia(recovered);
  assert.notEqual(fixed, recovered);
  assert.deepEqual(undatedMedia(recovered), [0, 1, 2, 3, 4, 5, 6]);
  assert.deepEqual(undatedMedia(fixed), []);
  for (const m of fixed.media as Rec[]) assert.doesNotThrow(() => p9(m));
  assert.equal(recovered.media[0]!.data.type, "video", "the file's own object isn't changed");
  assert.equal((recovered.media[0] as Rec).createdAt, undefined);
  // complete already: no copy (a project that has them costs one look)
  assert.equal(completeMedia(fixed), fixed);
  const none = { ...recovered, media: [] };
  assert.equal(completeMedia(none), none);
  const noList = { id: "p", name: "x" };
  assert.equal(completeMedia(noList), noList);
  // everything else in the entry is as it was
  assert.deepEqual((fixed.media as Rec[])[0]!.data, recovered.media[0]!.data);
});

test("P1-1: date-less media isn't a problem for the write guard (it would lift the guard from such projects, refuse their history and their recovery); undatedMedia finds them", () => {
  const env = { format: "cardboard-project", version: 1, project: recovered, media: [] };
  assert.deepEqual(projectProblems(env), [], "Cardboard's reader takes it (createdAt and addedAt are optional there)");
  assert.equal(undatedMedia(recovered).length, 7);
  // every writer completes them: what materializeProject writes is never date-less
  assert.deepEqual(undatedMedia(materializeProject(fromHost(recovered), recovered)), []);
});

test("P2-1: a name with no aspect ratio, tracks, clips or media holds nothing of the project (Schema.empty); a project just made is never that", () => {
  const named = { name: "Oldest restore", tracks: [], timelineItems: [], media: [] };
  assert.equal(emptyProject(fromHost(named)), true, "what the old bug left, named again");
  assert.equal(isBlank(fromHost(named), cardboardSchema), true, "core's isBlank takes the schema's rule");
  assert.equal(emptyProject(fromHost({ ...named, description: "notes" })), true);
  assert.equal(emptyProject({ tracks: [], timelineItems: [], media: [] }), true, "the empty root");
  assert.equal(emptyProject(fromHost({ ...named, aspectRatio: "16:9" })), false, "main@1 of a project just made");
  assert.equal(emptyProject(fromHost({ ...named, aspectRatio: "" })), true);
  assert.equal(emptyProject(fromHost({ ...named, tracks: [{ id: "V1", order: 0 }] })), false);
  assert.equal(emptyProject(fromHost({ ...named, media: [{ id: "m", data: { type: "video" } }] })), false);
  assert.equal(emptyProject(fromHost(recovered)), false);
});

test("P1-1: the loaders' completion takes the dates kept for that media before the project's (a date filled in at load reads as the file's own to every later write)", () => {
  const kept = { createdAt: "2026-10-30T08:00:00.000Z", addedAt: "2026-10-30T08:01:00.000Z", data: { size: 1 } };
  const known = (id: string) => (id === "v0" ? kept : undefined);
  const out = completeMedia(recovered, known).media as Rec[];
  assert.deepEqual([out[0]!.createdAt, out[0]!.addedAt], [kept.createdAt, kept.addedAt], "the clip's real dates");
  assert.deepEqual([out[1]!.createdAt, out[1]!.addedAt], [CREATED, CREATED], "nothing kept for a title: the project's");
  assert.equal((out[0]!.data as Rec).size, recovered.media[0]!.data.size, "only the dates: its other details are the materializer's business");
  // an entry with its own dates never asks
  let asked = 0;
  completeMedia(completeMedia(recovered), () => (asked++, kept));
  assert.equal(asked, 0);
});
