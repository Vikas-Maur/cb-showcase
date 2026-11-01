// Loading rows from a keyframe (Stage F4, PLAN §5.4; contract in sequencer/index.ts by foundation-core): the local
// sequencer takes the rows up to a persisted keyframe without replaying them and starts its head there.
import test from "node:test";
import assert from "node:assert/strict";
import { defineSchema } from "../src/schema.ts";
import { apply, fork, hashDoc } from "../src/engine/index.ts";
import { createLocalSequencer } from "../src/sequencer/index.ts";
import type { ConfirmedChange, Doc } from "../src/types.ts";
import { TL, change, clip, doc, set } from "./sequencer/fixtures.ts";

const schema = defineSchema({ collections: { tracks: { key: "id", seq: true }, timelineItems: { key: "id", parent: { field: "trackId", collection: "tracks" } } }, timeline: TL });

function rowsOf(n: number): { rows: ConfirmedChange[]; states: Doc[] } {
  const d0 = doc([clip("c0", 0, 5)]) as unknown as Doc;
  const sq = createLocalSequencer(d0, schema);
  const states: Doc[] = [fork(d0, schema)];
  for (let i = 1; i <= n; i++) {
    const r = sq.push({ ...change(sq.head as never, [set("c0", "name", `v${i}`)], { base: { seq: i - 1, pending: [] }, id: `r.${i}` }) } as never);
    assert.ok(r.ok);
    states.push(fork(sq.head, schema));
  }
  return { rows: [...sq.log], states };
}

test("sequencer load from a keyframe: the head is the keyframe's state plus the rows after it, the log is whole", () => {
  const { rows, states } = rowsOf(10);
  const d0 = doc([clip("c0", 0, 5)]) as unknown as Doc;
  const sq = createLocalSequencer(d0, schema);
  sq.load(rows, { seq: 7, doc: states[7]! });
  assert.equal(sq.log.length, 10);
  assert.equal(hashDoc(sq.head, schema), hashDoc(states[10]!, schema));
  // a doctored keyframe shows through: the rows before it were not replayed
  const planted = createLocalSequencer(d0, schema);
  planted.load(rows, { seq: 7, doc: apply(fork(states[7]!, schema), [set("c0", "opacity", 0.5)], schema) });
  assert.equal((planted.head as { timelineItems: { opacity: number }[] }).timelineItems[0]!.opacity, 0.5);
  // the keyframe must be one of the rows loaded; one already behind the log is ignored
  assert.throws(() => createLocalSequencer(d0, schema).load(rows.slice(0, 5), { seq: 7, doc: states[7]! }), /past the rows/);
  const twice = createLocalSequencer(d0, schema);
  twice.load(rows.slice(0, 8));
  twice.load(rows.slice(8), { seq: 3, doc: states[3]! });
  assert.equal(hashDoc(twice.head, schema), hashDoc(states[10]!, schema));
});
