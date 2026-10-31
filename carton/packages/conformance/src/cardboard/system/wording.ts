// History in editors' words (Cardboard's labels in the schema) and Director turns as named versions, on the real
// engine and history.
import test from "node:test";
import assert from "node:assert/strict";
import { fromHost, toHost, nameTurn, turnName } from "@carton/cardboard";
import type { Actor } from "@carton/core";
import { openWorld, clip, find, type Item } from "./world.ts";

test("History says what changed in Cardboard's words: aspect ratio, speed, volume, grade saturation, exposure, caption text [real engine]", async (t) => {
  const w = await openWorld(t, { items: [clip("x", 0, 5, { name: "Intro", playbackSpeed: 1, volume: 1, colorGrade: { saturation: 0.8 }, colorGrading: { exposure: 0 } }), clip("cap", 5, 8, { type: "caption", name: "Caption", captionText: "Hello" })] });
  const commit = async (fn: (p: Record<string, unknown>, its: Item[]) => void) => {
    const h = await w.carton.head();
    const p = structuredClone(toHost(h.doc)) as Record<string, unknown>;
    fn(p, p.timelineItems as Item[]);
    const r = await w.carton.commit({ doc: fromHost(p, h.doc), author: { kind: "human", id: "me" } });
    assert.equal(r.status, "confirmed");
  };
  await commit((p) => void (p.aspectRatio = "9:16"));
  await commit((_, its) => void Object.assign(find(its, "x"), { playbackSpeed: 2, endTime: 2.5 }));
  await commit((_, its) => void (find(its, "x").volume = 0.5));
  await commit((_, its) => void ((find(its, "x").colorGrade as Record<string, number>).saturation = 1));
  await commit((_, its) => void ((find(its, "x").colorGrading as Record<string, number>).exposure = 0.3));
  await commit((_, its) => void (find(its, "cap").captionText = "Hi there"));
  const words = (await w.carton.log({ summary: true, limit: 6 })).map((v) => v.summary ?? "").reverse();
  const expect = [/aspect ratio/, /speed 1 → 2/, /volume 1 → 0\.5/, /grade saturation 0\.8 → 1/, /exposure 0 → 0\.3/, /caption text/];
  expect.forEach((re, i) => assert.match(words[i]!, re, `version ${i + 1}: ${words[i]}`));
  for (const s of words) assert.doesNotMatch(s, /colorGrade|colorGrading|playbackSpeed|aspectRatio|captionText|timelineItems/, `no field paths: ${s}`);
});

test("a Director turn's last version is named with the turn's label; the other turn's versions keep theirs [real engine]", async (t) => {
  const w = await openWorld(t, { items: [clip("a", 0, 5), clip("b", 5, 10)] });
  const turn1: Actor = { kind: "agent", id: "director/c1/t1", name: "Director", chat: "c1", turn: "t1" };
  const sub: Actor = { kind: "subagent", id: "director/c1/t1/sub-Explore-x1", name: "Director › Explore", chat: "c1", turn: "t1", agentType: "Explore", agentId: "x1" };
  const turn2: Actor = { kind: "agent", id: "director/c1/t2", name: "Director", chat: "c1", turn: "t2" };
  const edit = async (who: Actor, id: string, name: string) => {
    const h = await w.carton.head();
    const p = structuredClone(toHost(h.doc));
    find(p.timelineItems as Item[], id).name = name;
    await w.carton.commit({ doc: fromHost(p, h.doc), author: who });
  };
  await edit(turn1, "a", "one");
  await edit(sub, "b", "two"); // the turn's subagent: still that turn
  await edit(turn2, "a", "three");
  const named = await nameTurn(w.carton, { chat: "c1", turn: "t1" }, "  tighter\nintro  ");
  assert.equal(named?.name, "tighter intro");
  const log = await w.carton.log();
  const v = log.find((x) => x.change && x.author?.turn === "t1");
  assert.equal(v?.author?.id, sub.id, "the turn's last version is its subagent's change");
  assert.equal(log.find((x) => x.ref.seq === v!.ref.seq)?.name, "tighter intro");
  assert.equal(log.find((x) => x.author?.turn === "t2")?.name, undefined);
  assert.equal(await nameTurn(w.carton, { chat: "c1", turn: "nope" }, "x"), null);
  assert.equal(turnName("x".repeat(200)).length, 120);
});
