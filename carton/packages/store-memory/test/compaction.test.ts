// Optional compaction (Stage F4, PLAN §5.4): the micro-changes of auto-versions older than 90 days are squashed into
// each auto-version's last change. What a person can still reach is unchanged (the head, every remaining version's
// state, credits, an agent turn's undo, dedup by id); a squashed version's state is gone ("state unknown").
import { test } from "node:test";
import assert from "node:assert/strict";
import { Carton, hashDoc, type Actor, type ConfirmedChange } from "@carton/core";
import type { Store } from "@carton/core/plugins";
import { createMemoryStore } from "../src/index.ts";
import { adapter, doc0, schema, set } from "./fixture.ts";
import { copyStore, until, world } from "./world.ts";

const alice: Actor = { kind: "human", id: "alice", group: "alice@laptop" };
const DIRECTOR = "alice@laptop/director";
const director = (turn: string): Actor => ({ kind: "agent", id: "director", name: "Director", group: DIRECTOR, turn });
const DAY = 864e5;
const opsBytes = async (s: Store) => (await s.range<ConfirmedChange>("changes")).reduce((n, e) => n + JSON.stringify(e.value.ops).length, 0);

test("F4 compaction: old auto-versions keep their last change; the head, kept versions, credits, undo and ids are unchanged", async () => {
  let now = Date.UTC(2026, 0, 5);
  const store = createMemoryStore();
  const c = await Carton.open({ adapter, store, init: { doc: doc0() }, actor: alice, clock: () => now, keyframeEvery: 4 });
  const main = c.cut;
  const commit = async (ops: ReturnType<typeof set>[], author: Actor = alice) => {
    now += 1000;
    const r = await c.commit({ ops, author });
    assert.equal(r.status, "confirmed");
    return r.status === "confirmed" ? r.change!.id : "";
  };
  // January: alice drags 'a' (5 micro-changes), a Director turn (3), alice renames 'e' four times and names that
  // version, then trims 'f' (3)
  const drags: string[] = [];
  for (let i = 1; i <= 5; i++) drags.push(await commit([set("a", "startTime", i), set("a", "endTime", 5 + i)]));
  for (const id of ["b", "c", "d"]) await commit([set(id, "name", `Director's ${id}`)], director("t1"));
  for (let i = 1; i <= 4; i++) await commit([set("e", "name", `e take ${i}`)]);
  await c.name((await c.log({ limit: 1 }))[0]!.ref, "Client cut");
  for (let i = 1; i <= 3; i++) await commit([set("f", "trimStart", i * 0.5)]);
  // a hundred days later: recent work, never compacted
  now += 100 * DAY;
  for (let i = 1; i <= 6; i++) await commit([set("a", "name", `recent ${i}`)]);

  const before = await copyStore(store); // the project as it was, to compare against
  const old = await Carton.open({ adapter, store: before, actor: alice, clock: () => now });
  const oldLog = await old.log();
  const states = new Map<number, string>();
  for (const v of oldLog) states.set(v.ref.seq, hashDoc(await old.checkout(`${main}@${v.ref.seq}`), schema));
  const bytesBefore = await opsBytes(store);

  assert.deepEqual(await c.compact({ olderThanDays: 90 }), { squashed: 4 + 2 + 2 + 2 });
  // what is left of January: each auto-version's last change, and the named version
  const log = await c.log();
  assert.equal(log.length, oldLog.length - 10);
  assert.deepEqual(log.filter((v) => v.at < now - 90 * DAY).map((v) => [v.ref.seq, v.author?.id ?? null, v.name ?? null]), [
    [15, "alice", null],
    [12, "alice", "Client cut"],
    [11, "alice", null],
    [8, "director", null],
    [5, "alice", null],
    [0, null, null],
  ]);
  for (const v of log) assert.equal(hashDoc(await c.checkout(`${main}@${v.ref.seq}`), schema), states.get(v.ref.seq), `the state at ${v.ref.seq} is unchanged`);
  await assert.rejects(c.checkout(`${main}@3`), /state unknown|not held/i, "a squashed version's state is gone");
  assert.equal(hashDoc((await c.head()).doc, schema), hashDoc((await old.head()).doc, schema));
  for (const id of ["a", "b", "c", "d", "e", "f"]) assert.deepEqual(await c.credits(["items", id]), await old.credits(["items", id]), `credits of ${id}`);
  // the Director's turn is now one change: undoing it gives what undoing the three did
  const u1 = await old.undo(DIRECTOR, { author: alice });
  const u2 = await c.undo(DIRECTOR, { author: alice });
  assert.equal(u1.status, "confirmed");
  assert.equal(u2.status, "confirmed");
  assert.equal(hashDoc((await c.head()).doc, schema), hashDoc((await old.head()).doc, schema));
  // a squashed change's id still deduplicates: retried, it is that change, never a second one
  const n = (await c.log()).length;
  const again = await c.commit({ id: drags[1]!, ops: [set("a", "name", "retry")] });
  assert.equal(again.status, "confirmed");
  assert.equal((await c.log()).length, n);
  assert.ok((await opsBytes(store)) < bytesBefore, "the squashed micro-changes' ops are gone");
  // nothing is left to squash, and the result is what the store holds
  assert.deepEqual(await c.compact({ olderThanDays: 90 }), { squashed: 0 });
  const reopened = await Carton.open({ adapter, store, actor: alice, clock: () => now });
  assert.deepEqual((await reopened.log()).map((v) => v.ref.seq), (await c.log()).map((v) => v.ref.seq));
  assert.equal(hashDoc((await reopened.head()).doc, schema), hashDoc((await c.head()).doc, schema));
  for (const x of [c, old, reopened]) await x.close();
});

test("F4 compaction leaves recent changes and pinned, forked-from, undone and undoing versions alone", async () => {
  let now = Date.UTC(2026, 0, 5);
  const store = createMemoryStore();
  const c = await Carton.open({ adapter, store, init: { doc: doc0() }, actor: alice, clock: () => now, keyframeEvery: 4 });
  const main = c.cut;
  for (let i = 1; i <= 9; i++) {
    now += 1000;
    await c.commit({ ops: [set(["a", "b", "c", "d", "e", "f"][i % 6]!, "name", `n${i}`)] });
  }
  await c.pin({ owner: "turn-7", cut: main }); // pins the head (9)
  const v = await c.fork("v", { from: `${main}@3` });
  assert.equal((await c.revert((await c.log())[3]!.change!)).status, "confirmed"); // reverts seq 6, as seq 10
  await c.switchTo(main);
  now += 100 * DAY;
  for (let i = 1; i <= 4; i++) await c.commit({ ops: [set("b", "name", `r${i}`)] });
  await c.compact();
  const kept = (await c.log()).map((x) => x.ref.seq).filter((s) => s > 0 && s <= 10);
  // kept: 3 (forked from), 6 (reverted), 9 (pinned), 10 (the revert); each ends a run: 1 into 2, 4 into 5, 7 into 8
  assert.deepEqual(kept.sort((x, y) => x - y), [2, 3, 5, 6, 8, 9, 10]);
  assert.ok((await c.cuts()).some((x) => x.id === v.id));
  await c.close();
});

test("F4 compaction never touches a shared cut: its rows are its server's", async () => {
  let now = Date.UTC(2026, 0, 5);
  const w = world();
  const c = await Carton.open({ adapter, store: createMemoryStore(), init: { doc: doc0() }, actor: alice, clock: () => now, keyframeEvery: 4, sync: w.sync("alice") });
  for (let i = 1; i <= 8; i++) {
    now += 1000;
    await c.commit({ ops: [set("a", "name", `n${i}`)] });
  }
  await c.share();
  await until(async () => (await c.cuts())[0]!.sequencer.kind === "server", 5000, "the hand-off");
  now += 100 * DAY;
  for (let i = 1; i <= 5; i++) assert.equal((await c.commit({ ops: [set("b", "name", `r${i}`)], wait: 5000 })).status, "confirmed");
  assert.deepEqual(await c.compact(), { squashed: 0 });
  assert.equal((await c.log()).length, 14);
  await c.close();
  w.host.close();
});
