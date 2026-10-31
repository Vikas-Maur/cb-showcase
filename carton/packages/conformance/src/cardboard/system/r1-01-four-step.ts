// R1-01: the four-step scenario on the real engine, history and materializer (port of system-v11
// `r1-01-four-step.test.mjs`, in its single-sequencer form until the sync client lands: Bob's B1 is committed on the
// state before Alice's E1, so the local sequencer checks it against E1 and rebases it exactly as the server would).
// 1. Alice's GUI edit E1 lands; timeline.tsx shows it under its header ref.
// 2. Bob's B1, made on the state before E1, lands after it (variant b: same clip's time group, rejected and rebased).
// 3. The agent read the file when it showed E1 and not B1, and saves its edit after both landed.
// 4. The merge uses the header's state as base: E1 kept, B1 kept, the agent's edit applied, nothing re-attributed or
//    reverted.
import test from "node:test";
import assert from "node:assert/strict";
import { diff, merge3 } from "@carton/core";
import { TIMELINE_FILE } from "@carton/cardboard/node";
import { cardboardSchema, fromHost, toHost } from "@carton/cardboard";
import { openWorld, clips, find, BOB, HUMAN, opsTouch, type Item } from "./world.ts";

async function scenario(t: test.TestContext, overlap: boolean) {
  const w = await openWorld(t, { items: clips(5), tracks: ["V1"] });
  const r0 = await w.carton.head();
  // 1. E1 (Alice, GUI)
  if (overlap) await w.gui((its) => void Object.assign(find(its, "c1"), { endTime: 9.5, trimEnd: 4.5 }));
  else await w.gui((its) => void (find(its, "c1").opacity = 0.5));
  await w.tick(100);
  // 3a. the agent reads the file: E1, not B1
  const agent = w.agent("director/chat1/turn1", { hooked: true, actor: { turn: "turn1", chat: "chat1" } });
  const read = await agent.read();
  assert.equal(find(read.items, "c1")[overlap ? "endTime" : "opacity"], overlap ? 9.5 : 0.5, "the file shows E1");
  // 2. B1 (Bob) arrives, made on the state before E1
  const h0 = toHost(r0.doc);
  const b1Items = structuredClone(h0.timelineItems as Item[]);
  if (overlap) Object.assign(find(b1Items, "c1"), { startTime: 5.5, trimStart: 0.5 });
  else find(b1Items, "c2").name = "Bob's cut";
  const b1 = await w.carton.commit({ doc: fromHost({ ...h0, timelineItems: b1Items }, r0.doc), base: r0.ref, author: BOB });
  assert.equal(b1.status, "confirmed", "B1 confirmed after E1 (rebased in the overlap variant)");
  w.mz.onHeadChange("remote");
  await w.tick(100);
  assert.ok(find(read.items, "c2").name === "c2" && find(read.items, "c1").startTime === 5, "the agent's read doesn't show B1");
  // 3b. the agent edits c3 in the file it read, long after the log moved on (a stale writer: no re-read)
  await agent.write(TIMELINE_FILE, `// agent\n${read.header}\n${JSON.stringify({ ...read.doc, timelineItems: read.items.map((i) => (i.id === "c3" ? { ...i, endTime: 19, trimEnd: 4 } : i)) })}\n`);
  await w.tick(5000);
  await agent.stop();
  const log = await w.carton.log();
  return { w, final: await w.head(), log, agent, read };
}

for (const [label, overlap] of [["a: E1 and B1 touch different clips", false], ["b: E1 and B1 trim the same clip, B1 rebased", true]] as const) {
  test(`R1-01 four-step scenario, ${label} [real engine]`, async (t) => {
    const { w, final, log, agent } = await scenario(t, overlap);
    const changes = log.filter((v) => v.change);
    assert.equal(changes.length, 3, "E1, B1, the agent's change: three versions");
    assert.deepEqual(changes.map((v) => v.author?.id).reverse(), [HUMAN.id, BOB.id, agent.actor.id]);
    const agentV = changes.find((v) => v.author?.id === agent.actor.id)!;
    const before = changes[changes.indexOf(agentV) + 1]!;
    const d = await w.carton.diff(before.ref, agentV.ref);
    assert.deepEqual([...opsTouch(d.ops)], ["timelineItems/c3"], "the agent's change touches only the clip it edited");
    if (overlap) {
      assert.deepEqual([find(final, "c1").endTime, find(final, "c1").trimEnd], [9.5, 4.5], "E1 kept");
      assert.deepEqual([find(final, "c1").startTime, find(final, "c1").trimStart], [5.5, 0.5], "B1 kept (composed with E1)");
    } else {
      assert.equal(find(final, "c1").opacity, 0.5, "E1 kept");
      assert.equal(find(final, "c2").name, "Bob's cut", "B1 kept, not reverted");
      assert.equal((await w.carton.credits(["timelineItems", "c1"]))?.id, HUMAN.id, "E1 attributed to Alice, not the agent");
      assert.equal((await w.carton.credits(["timelineItems", "c2"]))?.id, BOB.id);
    }
    assert.deepEqual([find(final, "c3").endTime, find(final, "c3").trimEnd], [19, 4], "agent edit applied");
    assert.equal((await w.carton.credits(["timelineItems", "c3"]))?.id, agent.actor.id);
  });
}

test(`R1-01 control: with the state before E1 plus B1 as base (a wrong base), B1 is silently reverted [real engine]`, async (t) => {
  const { w, read } = await scenario(t, false);
  const log = (await w.carton.log()).filter((v) => v.change).reverse(); // E1, B1, agent
  const root = await w.carton.checkout((await w.carton.log()).at(-1)!.ref);
  const global1 = structuredClone(toHost(root));
  find(global1.timelineItems as Item[], "c2").name = "Bob's cut"; // B1 without E1
  const g1 = fromHost(global1, root);
  const headBefore = await w.carton.checkout(log[1]!.ref); // E1 + B1
  const agentFile = fromHost({ ...toHost(root), timelineItems: read.items.map((i) => (i.id === "c3" ? { ...i, endTime: 19, trimEnd: 4 } : i)) }, root);
  const wrong = merge3(g1, headBefore, agentFile, cardboardSchema);
  assert.equal((toHost(wrong.doc).timelineItems as Item[]).find((i) => i.id === "c2")!.name, "c2", "with the wrong base, B1 is silently reverted");
  assert.equal(wrong.conflicts.length, 0, "and no card says so");
  assert.ok(diff(headBefore, wrong.doc, cardboardSchema).some((o) => o.path.join("/") === "timelineItems/c2/name"), "the revert would be committed as the agent's edit");
});
