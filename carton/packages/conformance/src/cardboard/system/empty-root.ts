// Laptop, build 915eb36 (Restore of "Started the cut" wrote a project.json with no name), the materializer's part on the
// real engine: a project Cardboard reads is never replaced by one it can't. Review of fix/restore-root, finding 1: the
// state checked must be the state written. Here another handle empties head after the materializer read it and before
// it pins what it writes; that pinned state is the one refused, and the file keeps its own state pinned.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { Carton } from "@carton/core";
import { cardboardAdapter, findRev, fromHost, toHost } from "@carton/cardboard";
import { PROJECT_FILE } from "@carton/cardboard/node";
import { openWorld, clip, BOB } from "./world.ts";

test("a head emptied between the materializer's read and its pin is never written; the file's state stays pinned [real engine]", async (t) => {
  const w = await openWorld(t, { items: [clip("X", 0, 10)], tracks: ["V1"] });
  const other = await Carton.open({ adapter: cardboardAdapter, store: w.carton.store, actor: BOB });
  t.after(() => other.close());
  const file = w.abs(PROJECT_FILE);
  const before = fs.readFileSync(file, "utf8");
  const good = (await w.carton.head()).ref;
  // a change to write: the name, by another process
  const h = await other.head();
  await other.commit({ doc: fromHost({ ...toHost(h.doc), name: "Renamed" }, h.doc), author: BOB });
  // ... and, as the materializer pins what it is about to write, the empty root's state lands (an older build's
  // restore of "Started the cut", synced in)
  const pin = w.engine.pin.bind(w.engine);
  let emptied = false;
  w.engine.pin = async (o) => {
    if (o.owner === "project-file" && !emptied) {
      emptied = true;
      await other.commit({ doc: { tracks: [], timelineItems: [], media: [] }, author: BOB });
    }
    return pin(o);
  };
  w.mz.onHeadChange("remote");
  await w.tick(200);
  assert.equal(emptied, true, "the empty state landed between the read and the pin");
  assert.equal(fs.readFileSync(file, "utf8"), before, "project.json as it was");
  assert.deepEqual(w.mz.log.refused.map((r) => r.problems), [["no name"]]);
  assert.deepEqual(w.mz.log.errors, []);
  // the state the file shows is still pinned for it (a foreign save of the file merges against it exactly)
  const body = await w.engine.getMeta<string>(["file", PROJECT_FILE, "pin"]);
  const shown = await w.engine.resolve(findRev("// cardboard:rev " + body)!.rev!).catch(() => null);
  assert.ok(shown, "the file's pin resolves: " + body);
  assert.equal((shown!.baseDoc as { name?: string }).name, "Fixture");
  // a good version restored: the file follows head again
  w.engine.pin = pin;
  await w.carton.restore(good);
  w.mz.onHeadChange("local");
  await w.tick(200);
  const env = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.deepEqual([env.project.name, env.project.timelineItems.map((i: { id: string }) => i.id)], ["Fixture", ["X"]]);
});
