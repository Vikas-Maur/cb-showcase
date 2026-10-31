// The clip time group through the system on the real engine (§4.1: {startTime, endTime, trimStart, trimEnd,
// playbackSpeed} merged as one unit by the edit algebra). Port of system-v11 `test/time-group.test.mjs`.
// - Finding 6 re-check: core-proto half-applied a GUI move that clashed with a remote end trim (G1, seed 163: the new
//   start kept, the end carded). On core-v5 a move and a trim-out compose: the clip is moved and shortened, no card.
// - Same clip, different fields (v11 §6.1): a trim-in and a speed change on one clip share no leaf path and, in v11,
//   spans of plain timing edits don't conflict. The per-clip group path `timelineItems/<id>/#time` makes them overlap,
//   so they meet in merge3, where the §4.1 table makes that pair a card.
// - Neighbours (v11 §4.1): two plain trims of neighbouring clips that end up overlapping are accepted without a merge;
//   every replica's incremental soft validator warns. A warning, not a card.
import test from "node:test";
import assert from "node:assert/strict";
import { declare } from "@carton/core";
import type { Op } from "@carton/core";
import { doc, clips, set } from "../sim/world.ts";
import type { Replica, SimActor } from "../sim/replica.ts";
import { A, world, runFor, assertConverged, report, ENGINE } from "../helpers.ts";

const commit = (r: Replica, ops: Op[]) =>
  r.worker!.proc.engine.post(() => {
    const id = `${r.worker!.proc.rid}.${++r.worker!.proc.n}`;
    r.store.commit(r.b, { id, author: r.newActor({ kind: "human", id: `human:${r.name}`, name: r.name }), ops, at: r.sim.now });
  });

// Two plain trims of neighbouring clips cross: c0 [0, 5] extends its end to 5.4 while c1 [5, 10] trims its start in to
// 5.2. Neither is structural and they touch different clips, so both are accepted without a merge; the clips now
// overlap on [5.2, 5.4], and every replica's soft validator warns.
async function neighbourTrims(keying: "v3-spans" | "v3-spans-v10") {
  const w = world({ seed: 172, keying });
  const m1 = w.replica({ name: "m1", link: w.net.link({ rtt: 1000 }) });
  const m2 = w.replica({ name: "m2", link: w.net.link({ rtt: 100 }) });
  const b = w.shared(doc({ items: clips(3).map((c) => ({ ...c, trimEnd: 6 })) }), [m1, m2]); // 1 s of spare source
  await m1.startApp({ gui: false, materialize: false });
  await m2.startApp({ gui: false, materialize: false });
  await runFor(w, 3000);
  commit(m1, [set("c0", "endTime", 5.4), set("c0", "trimEnd", 5.4)]);
  commit(m2, [set("c1", "startTime", 5.2), set("c1", "trimStart", 0.2)]);
  await runFor(w, 8000);
  return { w, b, m1, m2 };
}

// R11-01: the B13 crossing trims, both pushed as lww. Clip c0 [3, 5] (trims [0, 2]): Alice trims its start to 4.5,
// Bob its end to 4. Together they make start 4.5 / end 4, an invalid clip.
// v14 (H2): the client now commits a change that declares a span or a group path as `merge` even when asked for lww,
// so to push them as lww (as the prototype's client did) each sync client rewrites a change's first push to lww.
// A "lww on structure" reject is resubmitted as merge (H2), so later pushes keep the queue's policy.
async function crossingLww(server: Record<string, unknown>, seed: number) {
  const w = world({ seed, server });
  const m1 = w.replica({ name: "alice", link: w.net.link({ rtt: 400 }) });
  const m2 = w.replica({ name: "bob", link: w.net.link({ rtt: 100 }) });
  const b = w.shared(doc({ items: [{ ...clips(1)[0], startTime: 3, endTime: 5, trimStart: 0, trimEnd: 2 }] }), [m1, m2]);
  await m1.startApp({ gui: false, materialize: false });
  await m2.startApp({ gui: false, materialize: false });
  await runFor(w, 2000);
  const committedAs: string[] = [];
  for (const r of [m1, m2]) {
    const first = new Set<string>();
    r.worker!.sync!.tamper = (ch) => (first.has(ch.id) ? ch : (first.add(ch.id), { ...ch, policy: "lww" })); // v14: a pre-H2 client's first push
  }
  const lww = (r: Replica, ops: Op[]) =>
    r.worker!.proc.engine.post(() => {
      const id = `${r.worker!.proc.rid}.${++r.worker!.proc.n}`;
      r.store.commit(b, { id, author: { kind: "human", id: `human:${r.name}` } as SimActor, ops, policy: "lww", at: w.sim.now });
      committedAs.push(r.store.pending(b).find((p) => p.id === id)!.versions[0]!.policy);
    });
  lww(m1, [set("c0", "startTime", 4.5), set("c0", "trimStart", 1.5)]);
  lww(m2, [set("c0", "endTime", 4), set("c0", "trimEnd", 1)]);
  await runFor(w, 8000);
  const c0 = A.item(w.server.rows(b).reduce((d, r) => A.applyOps(d, r.ops), w.server.branches.get(b)!.doc0!), "c0")!;
  return { w, b, m1, m2, c0, valid: c0.endTime > c0.startTime && c0.trimEnd > c0.trimStart, cards: [...m1.cards, ...m2.cards], committedAs };
}
const span = (c0: A.Item) => [c0.startTime, c0.endTime, c0.trimStart, c0.trimEnd];

export function register(): void {
  test(`Finding 6 on core-v5: a GUI move crossing a remote end trim composes (moved and shortened), never half-applied [${ENGINE}]`, async (t) => {
    const w = world({ seed: 170 });
    const m1 = w.replica({ name: "m1-human", link: w.net.link({ rtt: 1000 }) });
    const m2 = w.replica({ name: "m2-remote", link: w.net.link({ rtt: 100 }) });
    const b = w.shared(doc({ items: clips(4) }), [m1, m2]); // c1 is [5, 10], trims [0, 5]
    await m1.startApp();
    await m2.startApp({ gui: false, materialize: false });
    await runFor(w, 3000);
    m1.worker!.gui!.edit((d) => Object.assign(d.timelineItems!.find((i) => i.id === "c1")!, { startTime: 5.3, endTime: 10.3 }), [["timelineItems/c1/startTime", 5.3], ["timelineItems/c1/endTime", 10.3]]);
    commit(m2, [set("c1", "endTime", 9.6), set("c1", "trimEnd", 4.6)]);
    await runFor(w, 8000);
    const c1 = A.item(m1.store.optimistic(b).doc, "c1")!;
    assert.ok(w.server.stats.rejects >= 1, "the two crossed: one was rejected and rebased");
    assert.deepEqual(span(c1), [5.3, 9.9, 0, 4.6], "move ∘ trim-out composed");
    assert.equal(m1.cards.length + m1.worker!.gui!.cards.length, 0, "no card");
    assertConverged(w, b, [m1, m2]);
    report(t, { c1: span(c1), rejects: w.server.stats.rejects });
  });

  test(`Group path: a trim-in and a speed change on one clip overlap through timelineItems/<id>/#time, meet in merge3 and become a card [${ENGINE}]`, async (t) => {
    const w = world({ seed: 171 });
    const m1 = w.replica({ name: "m1", link: w.net.link({ rtt: 1000 }) });
    const m2 = w.replica({ name: "m2", link: w.net.link({ rtt: 100 }) });
    const b = w.shared(doc({ items: [{ ...clips(1)[0], startTime: 10, endTime: 15, trimStart: 0, trimEnd: 5, playbackSpeed: 1 }] }), [m1, m2]);
    await m1.startApp({ gui: false, materialize: false });
    await m2.startApp({ gui: false, materialize: false });
    await runFor(w, 3000);
    const base = m1.store.optimistic(b).doc;
    const trimIn = [set("c0", "startTime", 10.5), set("c0", "trimStart", 0.5)];
    const speed = [set("c0", "playbackSpeed", 2), set("c0", "endTime", 12.5)];
    const d1 = declare(A.S, base, trimIn, null), d2 = declare(A.S, base, speed, null);
    const shared = d1.paths.filter((p) => d2.paths.includes(p));
    assert.deepEqual(shared, ["timelineItems/c0/#time"], "the only shared path is the time group");
    assert.ok(!d1.structural && !d2.structural, "neither is structural, so spans alone wouldn't conflict");
    commit(m1, trimIn);
    commit(m2, speed);
    await runFor(w, 8000);
    assert.ok(w.server.stats.rejects >= 1, "rejected: the group path overlaps");
    assert.ok(m1.cards.some((c) => c.cards.some((x) => x.path === "timelineItems/c0/#time")), "trim-in vs speed is a card (§4.1 table)");
    assertConverged(w, b, [m1, m2]);
    report(t, { rejects: w.server.stats.rejects, cards: m1.cards.map((c) => c.cards.map((x) => x.path)) });
  });

  test(`v11 neighbours: two plain trims that make neighbouring clips overlap are both accepted without a merge; each replica warns, no card [${ENGINE}]`, async (t) => {
    const { w, b, m1, m2 } = await neighbourTrims("v3-spans");
    const head = m1.store.optimistic(b).doc;
    assert.deepEqual([A.item(head, "c0")!.endTime, A.item(head, "c1")!.startTime], [5.4, 5.2], "both trims landed");
    assert.equal(w.server.stats.rejects, 0, "no overlap by the v11 rule: no reject, no merge");
    assert.equal(m1.cards.length + m2.cards.length, 0, "no card");
    for (const r of [m1, m2]) assert.ok(r.warnings.some((x) => x.kind === "overlap" && x.pair.join() === "c0,c1"), `${r.name} warns about c0/c1`);
    assertConverged(w, b, [m1, m2]);
    report(t, { warnings: [m1, m2].map((r) => r.warnings.length), rejects: w.server.stats.rejects });
  });
  test(`v10 rule for comparison: the same trims are rejected and merged (whole-clip spans intersect); still only a warning, no card [${ENGINE}]`, async (t) => {
    const { w, b, m1, m2 } = await neighbourTrims("v3-spans-v10");
    assert.ok(w.server.stats.rejects >= 1, "rejected and rebased");
    assert.equal(m1.cards.length + m2.cards.length, 0, "the merge also gives no card");
    for (const r of [m1, m2]) assert.ok(r.warnings.some((x) => x.pair.join() === "c0,c1"));
    assertConverged(w, b, [m1, m2]);
    report(t, { rejects: w.server.stats.rejects });
  });

  test(`R11-01: crossing trims both pushed as lww are refused as lww (a span and a group path are structure): cards, never an invalid confirmed clip [${ENGINE}]`, async (t) => {
    const { w, b, m1, m2, c0, valid, cards, committedAs } = await crossingLww({}, 173);
    assert.deepEqual(committedAs, ["merge", "merge"], "v14 (H2): the client commits a change with a span or a group path as merge");
    assert.equal(w.server.stats.rejectReasons["lww on structure"], 2, "the server rejects lww on both");
    assert.ok(valid, "the confirmed clip is valid");
    // v14 (H2): a "lww on structure" reject is resubmitted as merge, never dropped, so one trim lands and the other
    // meets it in merge3 and becomes a card (the prototype dropped both, and both writers got a card)
    assert.equal(cards.length, 1, "the writer whose trim lost gets a card");
    assert.ok([[3, 4, 0, 1], [4.5, 5, 1.5, 2]].some((x) => x.join() === span(c0).join()), "one trim landed");
    assertConverged(w, b, [m1, m2]);
    report(t, { c0: span(c0), cards: cards.length });
  });
  test(`R11-01 rule alone (no server check): the group path counts as structure, so the second trim meets merge3 and the invalid composition is a card [${ENGINE}]`, async (t) => {
    const { w, b, m1, m2, c0, valid, cards } = await crossingLww({ lwwCheck: false }, 174);
    assert.ok(w.server.stats.rejectReasons.overlap! >= 1, "the second was rejected for overlap");
    assert.ok(valid, "the confirmed clip is valid");
    assert.ok(cards.some((c) => c.cards.some((x) => x.path.startsWith("timelineItems/c0"))), "a card on c0");
    assertConverged(w, b, [m1, m2]);
    report(t, { c0: span(c0), cards: cards.length });
  });
  test(`R11-01 control: the pre-v12 classifier (group path as a leaf, no check) accepts both as lww and confirms an invalid clip [${ENGINE}]`, async (t) => {
    const { w, c0, valid } = await crossingLww({ lwwCheck: false, groupIsLeaf: true }, 175);
    assert.ok(!valid, "invalid clip confirmed");
    assert.deepEqual([c0.startTime, c0.endTime], [4.5, 4]);
    assert.ok(w.server.stats.lww >= 1, "accepted on the lww path");
    report(t, { c0: span(c0) });
  });
}
