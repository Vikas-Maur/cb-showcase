// The engine's last two jobs from `@carton/local`'s wrapper, now `cartonMaterializerEngine`'s own (agreed with local-cli,
// so the app's holder uses this engine as it is: one engine surface, no forwards to miss):
//   - a record that breaks a hard validator blocks with a card (§4.1): it keeps head's value, the rest of the save lands,
//     and the sidecar's diagnostics name the failure. The sequencer refuses such a change as a whole ("invalid") when
//     nothing concurrent forced a merge, so the engine puts the record back and commits the save again;
//   - whether the current cut is shared, read from the cut at each `head()` unless the caller says.
// local-cli's own tests (`materializer-engine.test.ts`, R5-04) were the acceptance tests for the move; these keep it here.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import type { Doc } from "@carton/core";
import { cartonMaterializerEngine, statusPath } from "@carton/cardboard/node";
import { openWorld, clip, find, render, type Item } from "./world.ts";

type Status = { status: string; error?: string; conflicts: { kind: string; path: string }[]; diagnostics: string[] };

test("invalid records: a save whose only edit breaks a hard validator is answered with its card, nothing committed, on the engine's cut [real engine]", async (t) => {
  const w = await openWorld(t, { items: [clip("a", 0, 10), clip("c", 15, 25)] });
  const at = await w.carton.head();
  const doc = structuredClone(at.doc) as Doc & { timelineItems: Item[] };
  find(doc.timelineItems, "a").endTime = 0; // ends where it starts
  const r = await w.engine.commit({ doc, base: { baseDoc: structuredClone(at.doc), baseSeq: at.ref.seq, causal: [] }, author: { kind: "agent", id: "director/c/t1" }, meta: { file: ".scratch/views/x.tsx", view: "x" }, id: w.carton.newChangeId() });
  assert.equal(r.status, "conflicts", JSON.stringify(r));
  assert.deepEqual(r.cards?.map((c) => [c.kind, c.path]), [["invalid", "timelineItems/a"]]);
  assert.match(r.cards![0]!.reason ?? "", /endTime must be greater than startTime/);
  assert.equal(r.cut, w.carton.cut);
  assert.equal(r.seq, at.ref.seq, "nothing committed");
  assert.equal((await w.carton.head()).ref.seq, at.ref.seq);
});

test("invalid records: a sequencer that calls a save with its broken records put back \"no ops\" still gets it answered with its cards at head's seq [real engine]", async (t) => {
  const w = await openWorld(t, { items: [clip("a", 0, 10), clip("c", 15, 25)] });
  const at = await w.carton.head();
  const commit = w.carton.commit.bind(w.carton);
  let calls = 0;
  // a sequencer that refuses an empty change (core here confirms it without a new seq)
  w.carton.commit = (async (i: Parameters<typeof commit>[0]) => (++calls === 1 ? commit(i) : { status: "rejected", reason: "no ops" })) as typeof commit;
  const doc = structuredClone(at.doc) as Doc & { timelineItems: Item[] };
  find(doc.timelineItems, "a").endTime = 0;
  const r = await w.engine.commit({ doc, base: { baseDoc: structuredClone(at.doc), baseSeq: at.ref.seq, causal: [] }, author: { kind: "agent", id: "director/c/t1" }, meta: { file: ".scratch/views/x.tsx", view: "x" }, id: w.carton.newChangeId() });
  assert.equal(calls, 2);
  assert.deepEqual([r.status, r.seq, r.cut], ["conflicts", at.ref.seq, w.carton.cut], JSON.stringify(r));
  assert.deepEqual(r.cards?.map((c) => [c.kind, c.path]), [["invalid", "timelineItems/a"]]);
});

test("invalid records: a view save with a broken clip, a new broken clip and a valid edit lands the edit; the broken ones keep head's value, carded and named in the sidecar [real engine]", async (t) => {
  const w = await openWorld(t, { items: [clip("a", 0, 10), clip("c", 15, 25)] });
  const B = w.agent("director/c/t1", { hooked: true, actor: { turn: "t1" } });
  const { path: vb, name } = await w.mz.printView("vb", B.actor, { hooked: true });
  const v0 = await B.read(vb);
  const its = structuredClone(v0.items);
  find(its, "a").name = "kept edit";
  find(its, "c").endTime = 10; // before it starts
  its.push(clip("n", 30, 30)); // a new clip that ends where it starts
  w.writeAtomic(vb, render(v0, its));
  await w.tick(1000);
  const head = await w.head();
  assert.equal(find(head, "a").name, "kept edit", "the valid edit landed");
  assert.equal(find(head, "c").endTime, 25, "the broken clip keeps head's value");
  assert.equal(head.find((i) => i.id === "n"), undefined, "the broken new clip isn't added");
  const s = JSON.parse(fs.readFileSync(w.abs(statusPath(name)), "utf8")) as Status;
  assert.equal(s.status, "conflicts", JSON.stringify(s));
  assert.deepEqual(s.conflicts.map((c) => [c.kind, c.path]).sort(), [["invalid", "timelineItems/c"], ["invalid", "timelineItems/n"]]);
  assert.ok(s.diagnostics.some((d) => /\bc: endTime must be greater than startTime/.test(d)), JSON.stringify(s.diagnostics));
  assert.ok(s.diagnostics.some((d) => /\bn: endTime must be greater than startTime/.test(d)), JSON.stringify(s.diagnostics));
  await B.stop();
});

test("invalid records: whether the cut is shared is read from it at head(), unless the caller says [real engine]", async (t) => {
  const w = await openWorld(t, { items: [clip("a", 0, 10)] });
  const cuts = w.carton.cuts.bind(w.carton);
  let reads = 0;
  let kind: string | null = null;
  w.carton.cuts = async () => {
    reads++;
    const all = await cuts();
    return kind ? all.map((c) => (c.id === w.carton.cut ? { ...c, sequencer: { ...c.sequencer, kind } } : c)) as typeof all : all;
  };
  const eng = cartonMaterializerEngine(w.carton);
  await eng.head();
  assert.equal(eng.shared?.(), false, "a local cut");
  kind = "server";
  assert.equal(eng.shared?.(), false, "read at head(), not at each call");
  await eng.head();
  assert.equal(eng.shared?.(), true, "a cut with a server sequencer is shared");
  const given = cartonMaterializerEngine(w.carton, { shared: () => false });
  const before = reads;
  await given.head();
  assert.equal(given.shared?.(), false, "the caller's answer");
  assert.equal(reads, before, "the cuts aren't read when the caller says");
});
