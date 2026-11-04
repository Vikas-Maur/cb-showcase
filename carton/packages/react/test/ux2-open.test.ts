// fix/ux2-open on the real engine and the pure grouping: a landmark's time is when it happened (a Named one after a
// restart too: History stamped names with the load's clock), a group of edits is titled by what it came to (a track
// removed and put back says nothing of the track), and the newest day reads as a story below its newest rows when
// nothing happened today.
import { test } from "node:test";
import assert from "node:assert/strict";
import { Carton, POS, defineSchema, timeAlgebra, type Actor, type Doc, type Rec } from "@carton/core";
import type { HostAdapter } from "@carton/core/plugins";
import { createMemoryStore } from "@carton/store-memory";
import { fromCarton } from "../src/from-carton.ts";
import { dayNumber, groupHistory } from "../src/history-groups.ts";
import type { Version } from "../src/model.ts";

const TL = { collection: "items", lanes: "tracks", lane: "trackId", start: "startTime", end: "endTime", source: "trimStart", sourceEnd: "trimEnd", speed: "playbackSpeed" };
const schema = defineSchema({
  collections: {
    tracks: { seq: true, noun: "track" },
    items: { parent: { field: "trackId", collection: "tracks" }, noun: "clip", groups: [{ name: "time", fields: ["startTime", "endTime", "trimStart", "trimEnd", "playbackSpeed"], algebra: timeAlgebra(TL) }] },
  },
  timeline: TL,
  label: (coll, r) => String((r as Rec | undefined)?.name ?? (r as Rec | undefined)?.id ?? coll),
});
const adapter: HostAdapter<Doc> = { name: "test", schema, schemaVersion: 1, fromHost: (h) => h, toHost: (d) => d };
const clip = (id: string, s: number, name: string): Rec => ({ id, trackId: "t1", startTime: s, endTime: s + 2, trimStart: 0, trimEnd: 2, name });
const doc0 = (): Doc => ({ tracks: [{ id: "t1", name: "Main", [POS]: "V" }], items: [clip("a", 0, "Intro"), clip("b", 2, "B-roll pier")] });
const set = (id: string, f: string, v: unknown) => ({ op: "set" as const, path: ["items", id, f], value: v });
const alice: Actor = { kind: "human", id: "alice", name: "Alice", group: "alice@laptop" };

test("a landmark's time is when it happened: an export's, a name's, after a restart too (History stamped names with the load's clock)", async () => {
  let now = Date.UTC(2026, 10, 3, 10, 0);
  const store = createMemoryStore();
  const c = await Carton.open({ adapter, store, init: { doc: doc0(), projectId: "p" }, actor: alice, clock: () => now });
  now += 60_000;
  await c.commit({ ops: [set("a", "endTime", 1.5)] });
  const v = (await c.head()).ref;
  const made = now;
  now += 10 * 60_000;
  await c.mark("exported", { by: alice, label: "1080p" });
  const exportedAt = now;
  now += 20 * 60_000;
  await c.name(v, "Sent to client");
  const namedAt = now;
  const times = async (k: Carton) => Object.fromEntries((await k.landmarks()).filter((l) => l.kind === "exported" || l.kind === "named").map((l) => [l.kind, l.at]));
  assert.deepEqual(await times(c), { exported: exportedAt, named: namedAt });
  assert.ok(namedAt > made && exportedAt > made, "neither is the version's own time");
  await c.close();
  // three hours later the project opens again
  now += 3 * 3_600_000;
  const again = await Carton.open({ adapter, store, actor: alice, clock: () => now });
  try {
    assert.deepEqual(await times(again), { exported: exportedAt, named: namedAt }, "the name's time is when it was named, not when the project opened");
    // the view model's landmark rows say the same (History's time column, like cb history --landmarks)
    const ui = fromCarton(again, { me: alice });
    await ui.ready;
    const marks = await ui.landmarks!();
    assert.deepEqual(Object.fromEntries(marks.filter((l) => l.kind === "exported" || l.kind === "named").map((l) => [l.kind, l.at])), { exported: exportedAt, named: namedAt });
  } finally {
    await again.close();
  }
});

test("a group's words are what it came to: a track removed and put back again says nothing of the track; nothing at all says so", async () => {
  const c = await Carton.open({ adapter, store: createMemoryStore(), init: { doc: doc0(), projectId: "p" }, actor: alice });
  try {
    await c.commit({ ops: [{ op: "insert", path: ["tracks", "top"], value: { id: "top", name: "Top", [POS]: "W" } }] });
    const base = (await c.head()).ref;
    await c.commit({ ops: [{ op: "remove", path: ["tracks", "top"] }] });
    const removed = (await c.head()).ref;
    await c.commit({ ops: [{ op: "insert", path: ["tracks", "top"], value: { id: "top", name: "Top", [POS]: "W" } }] });
    await c.commit({ ops: [set("b", "startTime", 3), set("b", "endTime", 5)] });
    const end = (await c.head()).ref;
    const ui = fromCarton(c, { me: alice });
    await ui.ready;
    const ref = (r: { branchId: string; seq: number }) => `${r.branchId}@${r.seq}`;
    // one step said "Removed track “Top”"; the group, from before it to its end, moved a clip
    const one = await ui.netWords!(ref(base), ref(removed));
    assert.match(one.summary, /Removed track “Top”/);
    const all = await ui.netWords!(ref(base), ref(end));
    assert.doesNotMatch(all.summary, /Top/, all.summary);
    assert.match(all.summary, /“B-roll pier”/);
    assert.equal(all.changes, 1);
    // removed and put back, nothing else: no change in the end
    const none = await ui.netWords!(ref(base), `${end.branchId}@${end.seq - 1}`);
    assert.deepEqual(none, { summary: "", changes: 0 });
  } finally {
    await c.close();
  }
});

// ---------------------------------------------------------------- the newest day as a story (item 3)
const H = 3_600_000;
const me = { key: "human/me", kind: "human", name: "You", isYou: true } as const;
const ver = (id: string, at: number, o: Partial<Version> = {}): Version => ({ id, ref: `main@${id}`, seq: 1, at, author: me, kind: "edit", summary: id, changes: 1, ...o }) as unknown as Version;

test("nothing today: the newest day reads as a story below its newest three versions (rows, grouped as any day's); Today never does", () => {
  const today = dayNumber(Date.now());
  const y = new Date();
  y.setDate(y.getDate() - 1);
  y.setHours(15, 0, 0, 0);
  const t = y.getTime();
  // yesterday: an export (landmark) early, 4 plain edits, a send (landmark), 6 plain edits up to 3 pm
  const all = [
    ver("x", t - 6 * H), ...[1, 2, 3, 4].map((i) => ver(`e${i}`, t - 5 * H + i * 60_000)), ver("s", t - 3 * H),
    ...[1, 2, 3, 4, 5, 6].map((i) => ver(`f${i}`, t - 2 * H + i * 15 * 60_000)),
  ];
  const marked = new Set(["x", "s"]);
  const opts = { group: true, open: () => false, anchor: (v: Version) => marked.has(v.id), alone: (v: Version) => marked.has(v.id), runs: (day: number) => day !== today, keepNewest: 3 };
  const rows = groupHistory(all, () => false, opts);
  const keys = rows.map((r) => r.key);
  // (f4–f6 are 15 min apart: no group; the three newest are rows, the newest reads Now; then the story)
  assert.deepEqual(keys, [`day:${today - 1}`, "f6", "f5", "f4", "run:f1", "s", "run:e1", "x"]);
  assert.equal((rows[1] as { now?: true }).now, true, "its newest still reads Now");
  // today has something: as before, every row
  const withToday = [...all, ver("n1", Date.now() - 60_000), ver("n2", Date.now())];
  const keys2 = groupHistory(withToday, () => false, opts).map((r) => r.key);
  assert.deepEqual(keys2.slice(0, 2), [`day:${today}`, "group:n1"]);
  assert.deepEqual(keys2.slice(2), [`day:${today - 1}`, "run:f1", "s", "run:e1", "x"], "a past day, all of it a story");
  // without keepNewest the newest day folds whole, as a past day does
  assert.deepEqual(groupHistory(all, () => false, { ...opts, keepNewest: 0 }).map((r) => r.key), [`day:${today - 1}`, "run:f1", "s", "run:e1", "x"]);
});
