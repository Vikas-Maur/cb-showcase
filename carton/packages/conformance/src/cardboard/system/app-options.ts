// The Materializer options the app's H8 wiring sets (windows-sync, via the orchestrator). The app's facade keeps its
// own files in `.carton/displaced` (a journal and untagged slots of project.json) and writes project.json itself:
//   - `displacedDir`: the materializer holds what it moves aside in a folder of its own, and its start-up recovery never
//     takes the facade's files for saves (an untagged file was read as a timeline.tsx save);
//   - `writeProject: false`: project.json is the host's. The materializer neither imports its saves (with no pin they
//     were refused, with a notice, on every GUI save) nor recovers displaced copies of it, and adopts only timeline.tsx.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { DisplacedFiles, PROJECT_FILE, TIMELINE_FILE } from "@carton/cardboard/node";
import { openWorld, clip, find, parseFile, render } from "./world.ts";

const FACADE = ".carton/displaced";
/** A file another user of `.carton/displaced` left there (the facade: untagged), or an earlier run (tagged). */
function plant(bundle: string, name: string | ((dir: string) => string), edit: string): { file: string; bytes: string } {
  const dir = path.join(bundle, FACADE);
  fs.mkdirSync(dir, { recursive: true });
  const file = typeof name === "string" ? path.join(dir, name) : name(dir);
  const env = JSON.parse(fs.readFileSync(path.join(bundle, PROJECT_FILE), "utf8")) as { project: { timelineItems: { id: string; name: string }[] } };
  env.project.timelineItems.find((i) => i.id === "a")!.name = edit;
  const bytes = JSON.stringify(env, null, 2);
  fs.writeFileSync(file, bytes);
  return { file, bytes };
}

test("app options: with its own displacedDir, the materializer holds what it moves aside there and leaves the facade's files in .carton/displaced alone [real engine]", async (t) => {
  let facade: { file: string; bytes: string } | null = null;
  const w = await openWorld(t, {
    items: [clip("a", 0, 10), clip("c", 15, 25)],
    materializer: { displacedDir: ".carton/displaced-views" },
    beforeStart: (b) => void (facade = plant(b, "facade-slot-1", "the facade's copy")),
  });
  assert.equal(fs.readFileSync(facade!.file, "utf8"), facade!.bytes, "the facade's file is where it was");
  assert.deepEqual(w.mz.log.recovered, [], "not taken for a save");
  // a foreign timeline.tsx save that no event announced, moved aside by Carton's next rewrite of the file
  const shown = parseFile(fs.readFileSync(w.abs(TIMELINE_FILE), "utf8"));
  const its = structuredClone(shown.items);
  find(its, "c").name = "foreign save";
  fs.writeFileSync(w.abs(TIMELINE_FILE), render(shown, its));
  await w.gui((items) => void (find(items, "a").opacity = 0.5));
  await w.tick(50);
  assert.ok(fs.readdirSync(w.abs(".carton/displaced-views")).length > 0, "held in the materializer's own folder");
  assert.deepEqual(fs.readdirSync(w.abs(FACADE)), ["facade-slot-1"], "nothing of the materializer's in the facade's folder");
  await w.tick(2000);
  const head = await w.head();
  assert.deepEqual([find(head, "a").name, find(head, "a").opacity, find(head, "c").name], ["a", 0.5, "foreign save"], "the foreign save, reviewed from there, landed");
  assert.equal(fs.readFileSync(facade!.file, "utf8"), facade!.bytes);
});

test("app options: with writeProject false, project.json is the host's: its saves, its displaced copies and the facade's untagged files are left alone; timeline.tsx and views work [real engine]", async (t) => {
  const planted: { file: string; bytes: string }[] = [];
  const w = await openWorld(t, {
    items: [clip("a", 0, 10), clip("c", 15, 25)],
    materializer: { writeProject: false },
    beforeStart: (b) => {
      planted.push(plant(b, "facade-slot-1", "the facade's copy")); // untagged
      planted.push(plant(b, (dir) => new DisplacedFiles(dir).next(PROJECT_FILE), "an earlier run's copy")); // tagged project.json
    },
  });
  for (const p of planted) assert.equal(fs.readFileSync(p.file, "utf8"), p.bytes, `left where it was: ${path.basename(p.file)}`);
  assert.deepEqual(w.mz.log.recovered, [], "neither is taken for a save");
  assert.equal(await w.engine.getMeta(["file", PROJECT_FILE, "state"]), undefined, "project.json isn't adopted");
  // the GUI saves project.json: the host's to apply
  const env = JSON.parse(fs.readFileSync(w.abs(PROJECT_FILE), "utf8")) as { project: { timelineItems: { id: string; name: string }[] } };
  env.project.timelineItems.find((i) => i.id === "a")!.name = "the host applies this";
  const saved = JSON.stringify(env, null, 2);
  w.writeAtomic(PROJECT_FILE, saved);
  await w.tick(2000);
  assert.equal(find(await w.head(), "a").name, "a", "not imported here");
  assert.equal(fs.readFileSync(w.abs(PROJECT_FILE), "utf8"), saved, "nor rewritten");
  const touched = [...w.mz.log.applied, ...w.mz.log.ignored, ...w.mz.log.errors].filter((x) => x.path === PROJECT_FILE);
  assert.deepEqual(touched, [], "no apply, refusal or error for it");
  // the shared file and the views are the materializer's as ever
  const B = w.agent("director/c/t1", { hooked: true, actor: { turn: "t1" } });
  const { path: vb } = await w.mz.printView("vb", B.actor, { hooked: true });
  await B.editUntilDone(vb, (its) => void (find(its, "c").name = "view save"));
  await w.tick(1000);
  assert.equal(find(await w.head(), "c").name, "view save");
  for (const p of planted) assert.equal(fs.readFileSync(p.file, "utf8"), p.bytes);
  await B.stop();
});
