// The materializer with Cardboard's real timeline.tsx printer and parser (1.4.0's CLI as a subprocess), on the real
// engine: the shared file is Cardboard's own JSX under Carton's header, an agent's edit of it is parsed by Cardboard's
// parser and lands as one change, and the regenerated file is Cardboard's print of the new head. Skipped without the CLI.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { TIMELINE_FILE } from "@carton/cardboard/node";
import { findRev, toHost } from "@carton/cardboard";
import { cardboardCli, editElement } from "../cli-codec.ts";
import { cliTimelineCodec } from "../cli-timeline-codec.ts";
import { openWorld, type Item } from "./world.ts";

const cli = cardboardCli();
const sample = JSON.parse(fs.readFileSync(fileURLToPath(new URL("../fixtures/sample/project.json", import.meta.url)), "utf8")) as { project: Record<string, unknown> & { id: string } };

test("real codec: the shared timeline.tsx is Cardboard's own print under Carton's header; an agent's JSX edit is parsed by Cardboard and lands as one change", { skip: cli ? false : "Cardboard 1.4.0's CLI isn't on this machine", timeout: 180_000 }, async (t) => {
  t.after(() => cli!.dispose());
  const w = await openWorld(t, { project: sample.project, codec: cliTimelineCodec(cli!) });
  const printed = fs.readFileSync(w.abs(TIMELINE_FILE), "utf8");
  const lines = printed.split("\n");
  assert.match(lines[0]!, /^\/\/ Cardboard timeline for "/, "Cardboard's printer wrote it");
  assert.match(lines[3]!, /^\/\/ cardboard:rev Main cut@0~[0-9a-f]{8} b:[0-9a-f]{8} p:[0-9a-f]{8} by carton$/, "Carton's header on Cardboard's rev line");
  const before = await w.headDoc();
  // an agent edits Cardboard's JSX in place of the title's text, keeping the header it read
  w.writeAtomic(TIMELINE_FILE, editElement(printed, "Title", 'textContent="Carton fixture"', 'textContent="Edited through Carton"'));
  await w.tick(5000);
  const head = toHost(await w.headDoc());
  const title = (head.timelineItems as Item[]).find((i) => i.name === "Title")!;
  assert.equal(title.textContent, "Edited through Carton");
  const d = await w.carton.diff((await w.carton.log()).at(-1)!.ref);
  assert.deepEqual([...new Set(d.ops.map((o) => o.path.slice(0, 2).join("/")))], [`timelineItems/${title.id}`], "only the title changed");
  const again = fs.readFileSync(w.abs(TIMELINE_FILE), "utf8");
  assert.ok(again.includes('textContent="Edited through Carton"'), "the regenerated file is Cardboard's print of the new head");
  assert.notEqual(findRev(again)?.line, lines[3], "with a new header");
  void before;
});
