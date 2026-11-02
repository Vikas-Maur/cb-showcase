// The check every writer of project.json makes first (laptop, build 915eb36: Restore of "Started the cut" wrote a
// project with no name and empty tracks and media, and Cardboard's library dropped it). It holds a write to what
// Cardboard 1.4.0's reader (library-worker.js `ti`) needs, plus a name.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { projectProblems } from "../src/valid.ts";
import { fromHost, materializeProject } from "../src/host.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const demo = () => JSON.parse(fs.readFileSync(path.join(here, "..", "..", "..", "kit", "quickstart", "Demo.cardboard", "project.json"), "utf8"));

test("a real project, and what Carton writes for it, pass", () => {
  const env = demo();
  assert.deepEqual(projectProblems(env), []);
  // round trip through Carton's document and back over the file (what the materializer writes)
  assert.deepEqual(projectProblems({ ...env, project: { ...materializeProject(fromHost(env.project), env.project), stateUpdatedAt: Date.now() } }), []);
  // a project as Cardboard creates it: no tracks or items yet
  assert.deepEqual(projectProblems({ format: "cardboard-project", version: 1, project: { id: "p", name: "New", createdAt: "x", updatedAt: "x", stateUpdatedAt: 1, aspectRatio: "16:9", media: [] }, media: [] }), []);
  // no manifest at all: the reader defaults it
  assert.deepEqual(projectProblems({ format: "cardboard-project", project: { id: "p", name: "New", updatedAt: "x" } }), []);
});

test("the file restoring \"Started the cut\" wrote is refused: no name", () => {
  const env = demo();
  // the empty root an imported project starts from (core's emptyDoc), laid over the file
  const broken = { ...env, project: { ...materializeProject({ tracks: [], timelineItems: [], media: [] }, env.project), stateUpdatedAt: Date.now() } };
  assert.equal(broken.project.name, undefined, "this is what was written");
  assert.deepEqual(broken.project.media, []);
  assert.deepEqual(projectProblems(broken), ["no name"]);
});

test("a name is never removed; a project made with a blank one keeps saving", () => {
  const env = demo();
  const blank = { ...env, project: { ...env.project, name: "  " } };
  assert.deepEqual(projectProblems(blank, () => env.project), ["its name was removed"]);
  assert.deepEqual(projectProblems(blank, () => ({ ...env.project, name: "" })), []);
  assert.deepEqual(projectProblems(blank), [], "nothing to compare with: Cardboard's reader takes it");
  let read = 0;
  projectProblems(env, () => (read++, env.project));
  assert.equal(read, 0, "the old project is read only for a blank name");
});

test("what Cardboard's reader can't take is refused, in words for the log", () => {
  const env = demo();
  const p = env.project;
  const with_ = (project: Record<string, unknown>, rest: Record<string, unknown> = {}) => projectProblems({ ...env, ...rest, project: { ...p, ...project } });
  assert.deepEqual(projectProblems(null), ["not a project file"]);
  assert.deepEqual(projectProblems({ ...env, project: undefined }), ["no project"]);
  assert.deepEqual(with_({}, { format: "x" }), ["not a cardboard-project file"]);
  assert.deepEqual(with_({}, { media: {} }), ["the media manifest isn't a list"]);
  assert.deepEqual(with_({ id: "" }), ["no id"]);
  assert.deepEqual(with_({ id: 7 }), ["no id"]);
  assert.deepEqual(with_({ name: null }), ["no name"]);
  assert.deepEqual(with_({ updatedAt: undefined }), ["no updatedAt"]);
  assert.deepEqual(with_({ aspectRatio: null }), ["aspectRatio isn't text"]);
  assert.deepEqual(with_({ stateUpdatedAt: "1" }), ["stateUpdatedAt isn't a number"]);
  assert.deepEqual(with_({ media: {} }), ["media isn't a list"]);
  assert.deepEqual(with_({ tracks: null }), ["tracks isn't a list"]);
  assert.deepEqual(with_({ timelineItems: [null] }), ["timelineItems[0] isn't an object"]);
  assert.deepEqual(with_({ media: [{ data: { type: "video" } }] }), ["media[0] has no id"]);
  assert.deepEqual(with_({ media: [{ id: "m", data: {} }] }), ["media[0].data has no type"]);
  assert.deepEqual(with_({ media: [{ id: "m", data: { type: "code", code: { source: "x" } } }] }), ["media[0].data.code needs its source, width and height"]);
  assert.deepEqual(with_({ timelineItems: [{ ...p.timelineItems[0], endTime: null }] }), ["timelineItems[0].endTime isn't a number"]);
  assert.deepEqual(with_({ timelineItems: [{ ...p.timelineItems[0], codeComposition: { source: "x" } }] }), ["timelineItems[0].codeComposition needs its width and height"]);
  assert.deepEqual(with_({ tracks: [{ name: "V1" }] }), ["tracks[0] has no id"]);
  // never the project's own text
  assert.ok(!with_({ name: 3, timelineItems: [{ id: 1 }] }).some((x) => x.includes(p.name)));
});

test("breaks: a write never turns a project Cardboard reads into one it can't; over anything else, nothing to lose", async () => {
  const { breaks } = await import("../src/valid.ts");
  const env = demo();
  const nameless = { ...env, project: { ...env.project, name: undefined } };
  assert.deepEqual(breaks(nameless, env), ["no name"], "a listed project losing its name");
  assert.deepEqual(breaks(env, nameless), [], "the write that mends it");
  assert.deepEqual(breaks(nameless, null), [], "no file yet");
  assert.deepEqual(breaks(nameless, { id: "p", name: "bare" }), [], "a file Cardboard can't read already (a host's own shape)");
  assert.deepEqual(breaks({ ...env, project: { ...env.project, name: "" } }, env), ["its name was removed"]);
});
