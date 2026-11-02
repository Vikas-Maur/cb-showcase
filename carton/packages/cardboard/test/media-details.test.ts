// A media entry's details across a restore or fold (laptop, merge/prod-2 P2-1): Restore of main@1 and back to the newest
// version brought clip.mp4 back without its duration, size and thumbnail. mediaDetails (what Carton doesn't version),
// materializeProject's `known` (the details for an entry the current file doesn't have), and MediaDetails, the bundle's
// .carton/media.json of what writes dropped.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fromHost, materializeProject, mediaDetails } from "../src/index.ts";
import { MediaDetails, droppedMedia, newerDetails, MEDIA_DETAILS_FILE } from "../src/node/media-details.ts";

const SCRATCH = process.env.CARTON_SCRATCH ?? path.join(os.homedir(), "gfv-scratch", "carton", "cardboard-adapter", "test");
const scratch = (t: test.TestContext) => {
  fs.mkdirSync(SCRATCH, { recursive: true });
  const dir = fs.mkdtempSync(path.join(SCRATCH, "media-details-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
};

// As Cardboard 1.4.0's import writes them (cb media add, a text clip)
const clip = {
  id: "m-clip",
  createdAt: "2026-11-02T12:09:44.095Z",
  addedAt: "2026-11-02T12:09:44.095Z",
  data: {
    type: "video", src: "cardboard-media://media/m-clip", fileName: "clip.mp4", format: "mp4", size: 43902, duration: 3, width: 320, height: 180, frameRate: 30, hasAudio: true,
    thumbnailIds: ["m-clip:poster", "m-clip:timeline:0.0"], thumbnailGenerationStatus: "complete", waveformId: "m-clip", waveformGenerationStatus: "complete", metadataStatus: "complete", codec: "avc1.64000d",
  },
};
const text = { id: "m-text", createdAt: "2026-11-02T12:09:45.256Z", addedAt: "2026-11-02T12:09:45.256Z", data: { type: "text", fileName: "Text: Hello", format: "text", size: 0, presetId: "custom", content: "Hello" } };
const graphic = { id: "m-code", data: { type: "code", fileName: "Graphic", code: { source: "export default () => null;", width: 1920, height: 1080 } } };
const project = (media: unknown[]) => ({ id: "p1", name: "Demo", updatedAt: "2026-11-02T00:00:00.000Z", stateUpdatedAt: 1, tracks: [], timelineItems: [], media });

test("mediaDetails: what Carton doesn't version, without the id, the file name, a text's content or a code graphic's source", () => {
  assert.deepEqual(mediaDetails(clip), { createdAt: clip.createdAt, addedAt: clip.addedAt, data: (({ type: _t, fileName: _f, ...d }) => d)(clip.data) });
  assert.deepEqual(mediaDetails(text), { createdAt: text.createdAt, addedAt: text.addedAt, data: { format: "text", size: 0, presetId: "custom" } });
  assert.deepEqual(mediaDetails(graphic), { data: { code: { width: 1920, height: 1080 } } });
  // an entry made from history alone has none
  assert.equal(mediaDetails({ id: "m-clip", data: { type: "video", fileName: "clip.mp4" } }), null);
  assert.equal(mediaDetails({ id: "m-clip", contentHash: "ab", shared: { size: 3 } }), null);
});

test("materializeProject: an entry the current file doesn't have takes its known details; the current file's come first; none: history's only", () => {
  const doc = fromHost(project([clip, text]));
  const known = new Map([["m-clip", mediaDetails(clip)!], ["m-text", mediaDetails(text)!]]);
  // a restore over a file without the clip (main@1's): back as Cardboard had it
  const back = materializeProject(doc, project([]), (id) => known.get(id));
  assert.deepEqual(back.media, [clip, text]);
  // without known details: what history holds, as before
  assert.deepEqual((materializeProject(doc, project([])).media as unknown[])[0], { id: "m-clip", data: { type: "video", fileName: "clip.mp4" } });
  // the file's entry wins over what is known (a newer probe there)
  const newer = { ...clip, data: { ...clip.data, duration: 3.04 } };
  assert.equal(((materializeProject(doc, project([newer, text]), (id) => known.get(id)).media as any[])[0]).data.duration, 3.04);
  // history's versioned fields win over the known details (a rename since)
  const renamed = fromHost(project([{ ...clip, data: { ...clip.data, fileName: "intro.mp4" } }]));
  assert.equal(((materializeProject(renamed, project([]), (id) => known.get(id)).media as any[])[0]).data.fileName, "intro.mp4");
  // a code graphic's size from its known details (a graphic no clip shows: codeSize had nothing to take it from)
  const g = materializeProject(fromHost(project([graphic])), project([]), () => mediaDetails(graphic));
  assert.deepEqual((g.media as any[])[0], graphic);
});

test("droppedMedia: the entries a write removes, by id; nothing for the same list or nothing removed", () => {
  const before = project([clip, text]);
  assert.deepEqual(droppedMedia(before, project([text])), [clip]);
  assert.deepEqual(droppedMedia(before, project([])), [clip, text]);
  assert.deepEqual(droppedMedia(before, { ...before }), []);
  assert.deepEqual(droppedMedia(before, project([{ id: "m-clip" }, { id: "m-text" }])), []);
  assert.deepEqual(droppedMedia(null, project([])), []);
  assert.deepEqual(droppedMedia(before, { id: "p1" }), [clip, text], "a write with no media list drops them all");
});

test("newerDetails: what says something new replaces; an entry that only lost fields never does", () => {
  const d = mediaDetails(clip)!;
  assert.equal(newerDetails(undefined, d), true);
  assert.equal(newerDetails(d, d), false);
  assert.equal(newerDetails(d, { data: { size: 43902 } }), false, "a subset");
  assert.equal(newerDetails(d, { ...d, data: { ...(d.data as object), duration: 3.04 } }), true);
  assert.equal(newerDetails(d, { ...d, data: { ...(d.data as object), thumbnailIds: ["m-clip:poster"] } }), true, "a list compares whole");
});

test("MediaDetails: kept in .carton/media.json when dropped, read back by another process's instance, never replaced by less", async (t) => {
  const bundle = scratch(t);
  const a = new MediaDetails(bundle), b = new MediaDetails(bundle);
  const v = (m: any) => ({ id: m.id, ...(m.contentHash ? { contentHash: m.contentHash } : {}), data: { type: m.data.type } });
  assert.equal(a.known()("m-clip", v(clip)), undefined, "no file yet");
  const ch = a.changes(droppedMedia(project([clip, text]), project([])));
  assert.deepEqual([...ch!.details.keys()], ["m-clip", "m-text"]);
  await a.save(ch!);
  const file = path.join(bundle, MEDIA_DETAILS_FILE);
  const kept = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.equal(kept.v, 1);
  assert.deepEqual(kept.media["m-clip"], { details: mediaDetails(clip), type: "video" });
  assert.ok(!JSON.stringify(kept).includes("Hello"), "a text's content isn't copied");
  // the same entries again: nothing to write (by identity, then by content)
  assert.equal(a.changes([clip, text]), null);
  assert.equal(a.changes([structuredClone(clip)]), null);
  // another process sees them, and keeps its own beside them
  assert.deepEqual(b.known()("m-clip", v(clip)), mediaDetails(clip));
  await b.save(b.changes([graphic])!);
  assert.deepEqual(a.known()("m-code", v(graphic)), mediaDetails(graphic), "read again once the file changed");
  assert.deepEqual(a.known()("m-text", v(text)), mediaDetails(text));
  // an entry made from history alone, or one that only lost fields, says nothing new
  assert.equal(a.changes([{ id: "m-clip", data: { type: "video", fileName: "clip.mp4" } }]), null);
  assert.equal(a.changes([{ ...clip, data: { type: "video", size: 43902 } }]), null);
  // a newer probe replaces
  const newer = { ...clip, data: { ...clip.data, duration: 3.04 } };
  await a.save(a.changes([newer])!);
  assert.equal((b.known()("m-clip", v(clip)) as any).data.duration, 3.04);
  // a damaged file is read as nothing known, and the next save replaces it
  fs.writeFileSync(file, "{not json");
  assert.equal(a.known()("m-clip", v(clip)), undefined);
  await a.save(a.changes([structuredClone(clip)])!);
  assert.deepEqual(b.known()("m-clip", v(clip)), mediaDetails(clip));
  assert.deepEqual(fs.readdirSync(path.dirname(file)).filter((n) => n.endsWith(".tmp")), [], "no temp file left");
});

test("MediaDetails: details go back only to the same media (its kind, its content id where both have one)", async (t) => {
  const bundle = scratch(t);
  const d = new MediaDetails(bundle);
  const shared = { ...clip, contentHash: "a".repeat(64) };
  await d.save(d.changes([shared])!);
  const known = d.known();
  assert.deepEqual(known("m-clip", { id: "m-clip", contentHash: "a".repeat(64), data: { type: "video" } }), mediaDetails(clip));
  assert.deepEqual(known("m-clip", { id: "m-clip", data: { type: "video" } }), mediaDetails(clip), "unlinked from sharing since: still its file");
  assert.equal(known("m-clip", { id: "m-clip", contentHash: "b".repeat(64), data: { type: "video" } }), undefined, "other content under the id");
  assert.equal(known("m-clip", { id: "m-clip", data: { type: "audio" } }), undefined, "another kind");
  // and through materializeProject: an id brought back with other content has history's fields only
  const other = { id: "m-clip", contentHash: "b".repeat(64), data: { type: "video", fileName: "clip.mp4" } };
  assert.deepEqual((materializeProject(fromHost(project([other])), project([]), known).media as unknown[])[0], other);
  // the same id seen again with other content replaces what was kept
  const relinked = { ...clip, contentHash: "b".repeat(64), data: { ...clip.data, duration: 9 } };
  await d.save(d.changes([relinked])!);
  assert.equal((d.known()("m-clip", other) as any).data.duration, 9);
});

test("MediaDetails: a save that fails keeps nothing in memory either, so the next drop of the same details tries again", async (t) => {
  const bundle = scratch(t);
  const d = new MediaDetails(bundle);
  // .carton is a file: nothing can be written under it
  fs.writeFileSync(path.join(bundle, ".carton"), "");
  await assert.rejects(d.save(d.changes([clip])!));
  assert.equal(d.known()("m-clip", { id: "m-clip", data: { type: "video" } }), undefined);
  fs.rmSync(path.join(bundle, ".carton"));
  const again = d.changes([structuredClone(clip)]);
  assert.ok(again, "tried again");
  await d.save(again!);
  assert.deepEqual(new MediaDetails(bundle).known()("m-clip", { id: "m-clip", data: { type: "video" } }), mediaDetails(clip));
});

test("materializeProject: a file's entry the current file holds without its details (src only) takes what is known of that media, its own fields first", () => {
  const doc = fromHost(project([clip]));
  const known = (id: string) => (id === "m-clip" ? mediaDetails(clip) : undefined);
  const partial = { id: "m-clip", data: { type: "video", fileName: "clip.mp4", src: "cardboard-media://media/m-clip", duration: 3.04 } };
  const out = (materializeProject(doc, project([partial]), known).media as any[])[0];
  assert.deepEqual(out, { ...clip, data: { ...clip.data, duration: 3.04 } }, "the file's own duration stays; the rest is filled in");
  // an entry with its details is the file's as it is, and nothing is looked up for it
  let asked = 0;
  materializeProject(doc, project([clip]), (id) => (asked++, known(id)));
  assert.equal(asked, 0);
  // a text's entry has no src: never looked up
  materializeProject(fromHost(project([text])), project([text]), (id) => (asked++, known(id)));
  assert.equal(asked, 0);
});
