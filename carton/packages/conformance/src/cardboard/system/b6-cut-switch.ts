// B6 (e2e-qa, s2-cuts "S2 cut switch"), the materializer's part, on the real engine: `cb cut switch` while the shared
// file is frozen (any `cb` call freezes it for a minute). The freeze view and its seq belong to the cut it started on;
// on the new cut that seq is another state or none, so the R7-01 rewrite after an agent's view save pinned it there and
// threw "state unknown" after the commit, and the agent's sidecar was never written.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { findRev } from "@carton/cardboard";
import { PROJECT_FILE, TIMELINE_FILE, statusPath } from "@carton/cardboard/node";
import { openWorld, clip, find } from "./world.ts";

async function switched(t: test.TestContext, tell: boolean) {
  const w = await openWorld(t, { items: [clip("X", 0, 10), clip("Y", 10, 20)], tracks: ["V1"] });
  // main moves on: its head seq is one the new cut doesn't have yet
  await w.gui((its) => void (find(its, "X").opacity = 0.7));
  await w.gui((its) => void (find(its, "X").opacity = 0.6));
  await w.tick(1000);
  await w.mz.onCb(); // `cb cut new` / `cb cut switch` freeze the shared file
  const cut = await w.carton.fork("Cut B");
  await w.carton.switchTo(cut.id);
  if (tell) await w.mz.onCutSwitch(cut.id);
  const agent = w.agent("director/c2/t2", { hooked: true, actor: { turn: "t2", chat: "c2" } });
  const { path: rel, name } = await w.mz.printView("director_c2_t2", agent.actor, { hooked: true });
  await agent.read(rel);
  await agent.editUntilDone(rel, (its) => void (find(its, "Y").name = "on cut B"));
  await w.tick(2000);
  return { w, cut, name };
}

for (const tell of [true, false]) {
  test(`B6: after a cut switch${tell ? "" : " the materializer wasn't told of"}, an agent's view save on the new cut gets its sidecar [real engine]`, async (t) => {
    const { w, cut, name } = await switched(t, tell);
    assert.equal(find(await w.head(), "Y").name, "on cut B", "the save landed on the new cut");
    assert.equal(w.carton.cut, cut.id);
    const status = JSON.parse(fs.readFileSync(w.abs(statusPath(name)), "utf8"));
    assert.equal(status.status, "confirmed", JSON.stringify(status));
    assert.deepEqual(w.mz.log.errors, [], "nothing failed after the commit");
    // the frozen shared file now shows the new cut's state, with the agent's save
    const shared = fs.readFileSync(w.abs(TIMELINE_FILE), "utf8");
    assert.ok(findRev(shared)?.line.includes("Cut B@"), findRev(shared)?.line);
  });
}

test("B6a: onCutSwitch rewrites project.json and the shared file from the new cut at once [real engine]", async (t) => {
  const w = await openWorld(t, { items: [clip("X", 0, 10)], tracks: ["V1"] });
  const cut = await w.carton.fork("Cut B");
  await w.carton.switchTo(cut.id);
  await w.mz.onCutSwitch(cut.id);
  const shared = fs.readFileSync(w.abs(TIMELINE_FILE), "utf8");
  assert.ok(findRev(shared)?.line.includes("Cut B@"), findRev(shared)?.line);
  const pin = await w.engine.getMeta<string>(["file", PROJECT_FILE, "pin"]);
  assert.ok(pin?.startsWith("Cut B@"), `project.json's base is on the new cut: ${pin}`);
});
