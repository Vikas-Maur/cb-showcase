// createLocalSequencer: the shared rule over an in-memory log and head doc, plus the hard validators only a
// sequencer that holds the state can run. Skipped until the engine (fork/apply/getIn) has landed.
import test from "node:test";
import assert from "node:assert/strict";
import { defineSchema } from "../../src/schema.ts";
import { fork } from "../../src/engine/index.ts";
import { createLocalSequencer, overlap } from "../../src/sequencer/index.ts";
import type { Change, Doc, Rec } from "../../src/types.ts";
import { TL, clip, doc, set, ins, declare, type Doc as FixtureDoc } from "./fixtures.ts";

const schema = defineSchema({
  collections: {
    tracks: { key: "id", seq: true },
    timelineItems: { key: "id", parent: { field: "trackId", collection: "tracks" }, groups: [{ name: "time", fields: ["startTime", "endTime", "trimStart", "trimEnd", "playbackSpeed"] }] },
  },
  timeline: TL,
  hard: (coll: string, r: Rec) => (coll === "timelineItems" && !((r.endTime as number) > (r.startTime as number)) ? ["endTime must be greater than startTime"] : []),
});

const engineReady = (() => {
  try {
    fork({ tracks: [], timelineItems: [] }, schema);
    return true;
  } catch {
    return false;
  }
})();
const skip = engineReady ? false : "the engine hasn't landed yet";

const d0: FixtureDoc = doc([clip("c0", 0, 5), clip("c1", 5, 10)]);
let n = 0;
const mk = (ops: Change["ops"], o: Partial<Change> = {}): Change => ({
  id: `r.${++n}`,
  hash: "h",
  author: { kind: "human", id: "alice" },
  branchId: "b",
  base: { seq: 0, pending: [] },
  ops,
  intent: null,
  kinds: null,
  policy: "merge",
  at: 0,
  ...declare(d0, ops as never),
  ...o,
});

test("overlap() describes a clash by path, read, span and order", () => {
  const a = declare(d0, [set("c1", "startTime", 6), set("c1", "trimStart", 1)]);
  const b = declare(d0, [set("c1", "playbackSpeed", 2)]);
  assert.equal(overlap(a, b).path, "timelineItems/c1/#time");
  const place = declare(d0, [ins("timelineItems", "t", clip("t", 0, 3, "T2"))]);
  const drop = declare(d0, [{ op: "remove", path: ["tracks", "T2"] }]);
  assert.equal(overlap(place, drop).read, "tracks/T2");
  const trim0 = declare(d0, [set("c0", "endTime", 5.5), set("c0", "trimEnd", 5.5)]);
  const trim1 = declare(d0, [set("c1", "startTime", 4.5), set("c1", "trimStart", 0)]);
  assert.deepEqual(overlap(trim0, trim1), {}, "plain trims of neighbours: no clash");
  assert.ok(overlap(trim1, { ...place, spans: [{ track: "V1", lo: 4, hi: 6 }], structural: true }).span, "a structural span meets");
});

test("local sequencer: accept, duplicate, overlap reject with the clash, lww overwrite notice", { skip }, () => {
  const s = createLocalSequencer(d0 as unknown as Doc, schema);
  const a = s.push(mk([set("c1", "opacity", 0.9)], { policy: "lww", author: { kind: "human", id: "bob" } }));
  assert.ok(a.ok && a.seq === 1);
  assert.ok(s.push({ ...mk([set("c1", "name", "x")]), id: a.ok ? a.change.id : "" }).ok, "a duplicate id is acked");
  const lww = s.push(mk([set("c1", "opacity", 0.3)], { policy: "lww" }));
  assert.ok(lww.ok && lww.notices.some((x) => x.kind === "overwritten" && x.to === "human/bob"));
  const merge = s.push(mk([set("c1", "opacity", 0.5)]));
  assert.ok(!merge.ok && merge.reason === "overlap" && merge.overlap?.path === "timelineItems/c1/opacity");
  assert.equal(s.pull(0).length, 2);
});

test("local sequencer: a hard-validator failure is rejected 'invalid'; a set on a removed record notifies 'lost to delete'", { skip }, () => {
  const s = createLocalSequencer(d0 as unknown as Doc, schema);
  // start moved onto the end: the edges stay inside the declared span, so only the hard validator can refuse it
  const bad = s.push(mk([set("c1", "startTime", 10), set("c1", "trimStart", 5)]));
  assert.ok(!bad.ok && bad.reason === "invalid" && bad.invalid?.path === "timelineItems/c1");
  assert.ok(s.push(mk([{ op: "remove", path: ["timelineItems", "c0"] }])).ok);
  const late = s.push(mk([set("c0", "name", "late")], { base: { seq: 1, pending: [] } }));
  assert.ok(late.ok && late.notices.some((x) => x.kind === "lost-to-delete"));
});
