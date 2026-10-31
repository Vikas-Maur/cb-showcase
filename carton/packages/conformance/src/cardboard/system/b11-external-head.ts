// B11 (e2e-qa, s1-takeover-views "B11"), the materializer's part, on the real engine: a write committed to carton.db
// by another handle (another process: a `cb` that committed in its own process, a takeover helper) never went through
// this materializer. `onExternalHeadChange` (called by local's store follower, a nudge, or the worker) brings the
// files up to carton.db's head, and does nothing when the head is the one already seen.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { Carton } from "@carton/core";
import { cardboardAdapter, findRev, fromHost, toHost } from "@carton/cardboard";
import { PROJECT_FILE, TIMELINE_FILE } from "@carton/cardboard/node";
import { openWorld, clip, find, parseFile, BOB, type Item } from "./world.ts";

test("B11: a commit by another handle on the same store reaches project.json and timeline.tsx through onExternalHeadChange [real engine]", async (t) => {
  const w = await openWorld(t, { items: [clip("X", 0, 10)], tracks: ["V1"] });
  const other = await Carton.open({ adapter: cardboardAdapter, store: w.carton.store, actor: BOB });
  t.after(() => other.close());
  assert.equal(await w.mz.onExternalHeadChange(), "unchanged");
  const h = await other.head();
  const host = toHost(h.doc);
  const items = structuredClone(host.timelineItems as Item[]);
  find(items, "X").name = "from another process";
  const r = await other.commit({ doc: fromHost({ ...host, timelineItems: items }, h.doc), author: BOB });
  assert.equal(r.status, "confirmed");
  assert.equal(await w.mz.onExternalHeadChange(), "head");
  await w.tick(100);
  assert.equal(find(parseFile(fs.readFileSync(w.abs(TIMELINE_FILE), "utf8")).items, "X").name, "from another process");
  assert.equal(find(JSON.parse(fs.readFileSync(w.abs(PROJECT_FILE), "utf8")).project.timelineItems, "X").name, "from another process");
  const rewrites = w.mz.log.rewrites.length;
  assert.equal(await w.mz.onExternalHeadChange(), "unchanged");
  await w.tick(100);
  assert.equal(w.mz.log.rewrites.length, rewrites, "seen once");
  assert.deepEqual(w.mz.log.errors, []);
});

test("B11: a cut the handle switched to without telling the materializer is found by onExternalHeadChange [real engine]", async (t) => {
  const w = await openWorld(t, { items: [clip("X", 0, 10)], tracks: ["V1"] });
  const cut = await w.carton.fork("Cut C");
  await w.carton.switchTo(cut.id); // local's follower switches the handle when another process switched the cut
  assert.equal(await w.mz.onExternalHeadChange(), "cut");
  const shared = fs.readFileSync(w.abs(TIMELINE_FILE), "utf8");
  assert.ok(findRev(shared)?.line.includes("Cut C@"), findRev(shared)?.line);
  const pin = await w.engine.getMeta<string>(["file", PROJECT_FILE, "pin"]);
  assert.ok(pin?.startsWith("Cut C@"), `project.json's base is on the new cut: ${pin}`);
  assert.equal(await w.mz.onExternalHeadChange(), "unchanged");
});
