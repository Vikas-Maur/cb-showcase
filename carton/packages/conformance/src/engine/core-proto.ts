// core-proto's 31 tests as ported to the v5 engine (port of core-v5 `test.mjs`), and its four property fuzz tests
// (2,000 cases each by default).
//
// Docs are engine docs (tracks and keyed arrays carry "#pos"; fromHost/toHost convert), and a few expectations changed
// on purpose with the v5 design. Each such test says "v5:" and why:
// - time fields are one field group: a both-sides retime is one "group" card, not a leaf conflict;
// - remaps are per track (PLAN §7: "the other side's concurrent times on the remapped tracks go through the map");
//   core-proto's cross-track "connected clip" anchoring is gone, so an inferred ripple on V1 no longer moves a title on
//   another track (a recorded remap listing both tracks does);
// - sequences are ordered by keys, so moves of different elements merge instead of an "order" card;
// - the sequencer uses the §6.1 overlap rule (paths, reads, spans), not v1's per-change shift flag.
// Where the contract changed a shape the prototype asserted, a `port:` comment says how the assertion was adapted.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as E from "@carton/core";
import type { Actor, Doc, MergeOptions, Op, Schema } from "@carton/core";
import { fromHost, toHost, withKeys } from "./fixtures/cardboard-schema.ts";
import type { HostDoc } from "./fixtures/cardboard-schema.ts";
import { rng, fuzzDoc, fuzzEdit, pick, int, rippleCut, genDoc } from "./gen.ts";
import type { EditKind, Rng } from "./gen.ts";
import { checkMerge } from "./props.ts";
import type { MergeTally } from "./props.ts";
import { accepted, once, rejected, toChange } from "./support.ts";
import type { Json, PushInput, PushResult } from "./support.ts";

export interface CoreProtoOptions {
  /** Cases per property fuzz test (default 2,000, the prototype's FUZZ). */
  cases?: number;
}

export function coreProtoTests(S: Schema, opts: CoreProtoOptions = {}): void {
  const CASES = opts.cases ?? 2000;
  const snap = (d: Doc) => E.snapshot(d, S);
  const same = (a: Doc, b: Doc, msg?: string) => assert.equal(snap(a), snap(b), msg);
  const item = (doc: Doc, id: string): Json => (doc.timelineItems as Json[]).find((i) => i.id === id);
  // edit with structural sharing, like the app's store
  const edit = (doc: Doc, id: string, patch: Json): Doc => ({ ...doc, timelineItems: (doc.timelineItems as Json[]).map((i) => (i.id === id ? { ...i, ...patch } : i)) });
  const without = (doc: Doc, id: string): Doc => ({ ...doc, timelineItems: (doc.timelineItems as Json[]).filter((i) => i.id !== id) });
  // a host-side edit (project.json shape), re-imported through the projection
  const H = (doc: Doc, mutate: (h: Json) => unknown): Doc => {
    const h = structuredClone(toHost(doc));
    mutate(h);
    return fromHost(h, doc);
  };
  // port: the prototype's direct pushes passed a bare author string; a Change's author is an Actor
  const actor = (id: string): Actor => ({ kind: "human", id });

  // ------------------------------------------------------------------ merge-demo.mjs scenarios
  // (fixtures are built on first use, so an engine failure fails the tests that use them, not the file)

  const T = (id: string, name: string) => ({ id, name, order: id === "titles" ? 0 : 1, visible: true });
  const F = once(() => {
    const base = withKeys({
      name: "Demo",
      aspectRatio: "16:9",
      tracks: [T("titles", "Titles"), T("main", "Main")],
      timelineItems: [
        { id: "a1", trackId: "main", type: "video", name: "Intro", startTime: 0, endTime: 6, trimStart: 0, trimEnd: 6 },
        { id: "a2", trackId: "main", type: "video", name: "Problem", startTime: 6, endTime: 16, trimStart: 0, trimEnd: 10 },
        { id: "a3", trackId: "main", type: "video", name: "CTA", startTime: 16, endTime: 24, trimStart: 0, trimEnd: 8, colorGrade: { saturation: 1.1, contrast: 1 } },
        { id: "t1", trackId: "titles", type: "text", startTime: 0.5, endTime: 3, trimStart: 0, trimEnd: 2.5, textContent: "We cut editing time by 10x" },
      ],
    });
    return { base };
  });
  const merge = (o: Doc, t: Doc, mopts?: MergeOptions) => E.merge3(F().base, o, t, S, mopts);

  test("1. different items: clean merge, both edits", () => {
    const { base } = F();
    const m = merge(edit(base, "a1", { endTime: 5, trimEnd: 5 }), edit(base, "t1", { textContent: "10x faster edits" }));
    assert.deepEqual(m.conflicts, []);
    assert.equal(item(m.doc, "a1").endTime, 5);
    assert.equal(item(m.doc, "t1").textContent, "10x faster edits");
  });

  test("2. same item, different fields: both kept, no conflict", () => {
    const { base } = F();
    const m = merge(edit(base, "a2", { endTime: 14, trimEnd: 8 }), edit(base, "a2", { name: "The problem" }));
    assert.deepEqual(m.conflicts, []);
    assert.equal(item(m.doc, "a2").endTime, 14);
    assert.equal(item(m.doc, "a2").name, "The problem");
  });

  test("3. (v5: time group) same edge trimmed to different values: one group card with both values, nothing overwritten silently", () => {
    const { base } = F();
    const m = merge(edit(base, "a2", { endTime: 14, trimEnd: 8 }), edit(base, "a2", { endTime: 15, trimEnd: 9 }));
    assert.equal(m.conflicts.length, 1);
    const c = m.conflicts[0]!;
    assert.equal(c.kind, "group");
    assert.equal(c.path, "timelineItems/a2/#time");
    assert.deepEqual([(c.base as Json).endTime, (c.ours as Json).endTime, (c.theirs as Json).endTime], [16, 14, 15]);
    assert.equal(item(m.doc, "a2").endTime, 14, "provisional = ours");
    const t = item(E.resolve(m, ["theirs"]), "a2");
    assert.deepEqual([t.endTime, t.trimEnd], [15, 9], "a choice takes that side's whole group");
    const v = item(E.resolve(m, { "timelineItems/a2/#time": { value: { endTime: 14.5, trimEnd: 8.5 } } }), "a2");
    assert.deepEqual([v.endTime, v.trimEnd], [14.5, 8.5]);
  });

  test("3c. coupled fields: a trim conflict on endTime + trimEnd is one card, resolved together", () => {
    const { base } = F();
    const m = merge(edit(base, "a2", { endTime: 14, trimEnd: 8 }), edit(base, "a2", { endTime: 15, trimEnd: 9 }));
    assert.equal(m.conflicts.length, 1);
    assert.ok(m.conflicts[0]!.related!.includes("timelineItems/a2/trimEnd") && m.conflicts[0]!.related!.includes("timelineItems/a2/endTime"));
  });

  test("3b. same field, same value: no conflict", () => {
    const { base } = F();
    const m = merge(edit(base, "a2", { endTime: 14, trimEnd: 8 }), edit(base, "a2", { endTime: 14, trimEnd: 8 }));
    assert.deepEqual(m.conflicts, []);
    assert.equal(item(m.doc, "a2").endTime, 14);
  });

  test("4. (Cardboard --prefer editor dropped all of the file's changes) here: both kept, prefer only picks provisional side", () => {
    const { base } = F();
    for (const prefer of ["ours", "theirs"] as const) {
      const m = merge(edit(base, "a2", { endTime: 14, trimEnd: 8 }), edit(base, "a2", { name: "The problem" }), { prefer });
      assert.deepEqual(m.conflicts, []);
      assert.equal(item(m.doc, "a2").endTime, 14);
      assert.equal(item(m.doc, "a2").name, "The problem");
    }
  });

  test("5. nested colorGrade: different keys both kept", () => {
    const { base } = F();
    const m = merge(edit(base, "a3", { colorGrade: { saturation: 1.3, contrast: 1 } }), edit(base, "a3", { colorGrade: { saturation: 1.1, contrast: 1.2 } }));
    assert.deepEqual(m.conflicts, []);
    assert.deepEqual(item(m.doc, "a3").colorGrade, { saturation: 1.3, contrast: 1.2 });
  });

  test("5b. nested colorGrade: same key differently is a conflict at that key only", () => {
    const { base } = F();
    const m = merge(edit(base, "a3", { colorGrade: { saturation: 1.3, contrast: 1.2 } }), edit(base, "a3", { colorGrade: { saturation: 1.5, contrast: 1 } }));
    assert.equal(m.conflicts.length, 1);
    assert.equal(m.conflicts[0]!.path, "timelineItems/a3/colorGrade/saturation");
    assert.deepEqual(item(m.doc, "a3").colorGrade, { saturation: 1.3, contrast: 1.2 });
  });

  test("6a. a plain trim (no ripple) on one side is applied as written: gap, no shifting", () => {
    const { base } = F();
    const m = merge(base, edit(base, "a1", { endTime: 4, trimEnd: 4 }));
    assert.deepEqual(m.conflicts, []);
    assert.equal(item(m.doc, "a1").endTime, 4);
    assert.equal(item(m.doc, "a2").startTime, 6);
  });

  test("6b. ripple trim vs concurrent trim of a later clip: inferred remap, trims compose, no conflict", () => {
    const { base } = F();
    // theirs: ripple-trim Intro by 2 s (a2, a3 pulled left); ours (human): trimmed Problem's end 16 -> 14
    let rip = edit(base, "a1", { endTime: 4, trimEnd: 4 });
    rip = edit(rip, "a2", { startTime: 4, endTime: 14 });
    rip = edit(rip, "a3", { startTime: 14, endTime: 22 });
    const human = edit(base, "a2", { endTime: 14, trimEnd: 8 });
    for (const [o, t] of [
      [human, rip],
      [rip, human],
    ] as const) {
      const m = merge(o, t);
      assert.deepEqual(m.conflicts, []);
      assert.deepEqual(m.remaps.inferred.filter(Boolean).length, 1);
      assert.deepEqual([item(m.doc, "a2").startTime, item(m.doc, "a2").endTime, item(m.doc, "a2").trimEnd], [4, 12, 8]);
      assert.deepEqual([item(m.doc, "a3").startTime, item(m.doc, "a3").endTime], [14, 22]);
    }
  });

  test("7. delete vs edit: a record conflict, both sides recoverable", () => {
    const { base } = F();
    const m = merge(edit(base, "t1", { textContent: "x" }), without(base, "t1"));
    assert.equal(m.conflicts.length, 1);
    assert.equal(m.conflicts[0]!.kind, "record");
    assert.equal(m.conflicts[0]!.path, "timelineItems/t1");
    assert.equal(m.conflicts[0]!.theirs, null);
    assert.equal(item(m.doc, "t1").textContent, "x", "provisional keeps ours (the edit)");
    assert.equal(item(E.resolve(m, ["theirs"]), "t1"), undefined);
  });

  test("track delete vs concurrent add onto it: flagged, resolvable both ways", () => {
    const { base } = F();
    const removeTitles = { ...base, tracks: (base.tracks as Json[]).filter((t) => t.id !== "titles"), timelineItems: (base.timelineItems as Json[]).filter((i) => i.trackId !== "titles") };
    const t2 = { id: "t2", trackId: "titles", type: "text", startTime: 10, endTime: 12, trimStart: 0, trimEnd: 2, textContent: "New" };
    const addTitle = { ...base, timelineItems: [...(base.timelineItems as Json[]), t2] };
    const m = merge(removeTitles, addTitle);
    assert.equal(m.conflicts.length, 1);
    assert.equal(m.conflicts[0]!.kind, "parent");
    assert.equal(m.conflicts[0]!.path, "tracks/titles");
    assert.ok(m.conflicts[0]!.related!.includes("timelineItems/t2"));
    assert.equal(item(m.doc, "t2"), undefined);
    const keep = E.resolve(m, ["theirs"]);
    assert.ok((keep.tracks as Json[]).some((t) => t.id === "titles"));
    assert.ok(item(keep, "t2") && item(keep, "t1"), "track restored with its old and new items");
    const m2 = merge(addTitle, removeTitles);
    assert.equal(m2.conflicts[0]!.kind, "parent");
    assert.ok(item(m2.doc, "t2") && (m2.doc.tracks as Json[]).some((t) => t.id === "titles"));
  });

  test("track delete vs concurrent move of an item onto it: flagged", () => {
    const { base } = F();
    const removeTitles = { ...base, tracks: (base.tracks as Json[]).filter((t) => t.id !== "titles"), timelineItems: (base.timelineItems as Json[]).filter((i) => i.trackId !== "titles") };
    const m = merge(removeTitles, edit(base, "a3", { trackId: "titles" }));
    assert.equal(m.conflicts.length, 1);
    assert.equal(m.conflicts[0]!.kind, "parent");
    assert.equal(item(m.doc, "a3").trackId, "main");
    assert.equal(item(E.resolve(m, ["theirs"]), "a3").trackId, "titles");
  });

  // ------------------------------------------------------------------ ripple-aware merge (task scenario)

  const V1 = "v1",
    TT = "titles";
  const clips: [string, number, number][] = [
    ["c1", 0, 6],
    ["c2", 6, 9],
    ["c3", 9, 14],
    ["c4", 14, 18],
    ["c5", 18, 22],
    ["c6", 22, 27],
    ["c7", 27, 33],
    ["c8", 33, 40],
  ];
  const rippleDelete = (doc: Doc, id: string): Doc => {
    const x = item(doc, id),
      d = x.endTime - x.startTime;
    return {
      ...doc,
      timelineItems: (doc.timelineItems as Json[]).filter((i) => i.id !== id).map((i) => (i.trackId === x.trackId && i.startTime >= x.endTime ? { ...i, startTime: i.startTime - d, endTime: i.endTime - d } : i)),
    };
  };
  const title = { id: "ti", trackId: TT, type: "text", startTime: 30, endTime: 32.5, trimStart: 0, trimEnd: 2.5, textContent: "Over clip 7" };
  const overlay = { ...title, id: "ov", trackId: V1, type: "video", startTime: 40, endTime: 42, textContent: undefined };
  const R = once(() => {
    const rbase = withKeys({
      name: "R",
      aspectRatio: "16:9",
      tracks: [
        { id: TT, name: "Titles", order: 0 },
        { id: V1, name: "V1", order: 1 },
      ],
      timelineItems: clips.map(([id, s, e]) => ({ id, trackId: V1, type: "video", name: id, startTime: s, endTime: e, trimStart: 1, trimEnd: 1 + e - s })),
    });
    const human = rippleDelete(rbase, "c2"); // 3 s clip at 0:06 on V1
    let agent = edit(rbase, "c7", { endTime: 32, trimEnd: 6 }); // retime clip 7: trim 1 s off its end
    agent = { ...agent, timelineItems: [...(agent.timelineItems as Json[]), title, overlay] };
    return { rbase, human, agent };
  });

  test("ripple (v5: per-track remap): human ripple-delete + agent retime of clip 7 and an append on V1 land shifted, no conflicts", () => {
    const { rbase, human, agent } = R();
    for (const [o, t] of [
      [human, agent],
      [agent, human],
    ] as const) {
      const m = E.merge3(rbase, o, t, S);
      assert.deepEqual(m.conflicts, []);
      const maps = m.remaps.ours[V1] ? m.remaps.ours : m.remaps.theirs;
      assert.deepEqual(maps[V1], [{ d: [[6, 9]], i: [] }]);
      const c7 = item(m.doc, "c7");
      assert.deepEqual([c7.startTime, c7.endTime, c7.trimEnd], [24, 29, 6]);
      assert.deepEqual([item(m.doc, "ov").startTime, item(m.doc, "ov").endTime], [37, 39], "the append on V1 follows the ripple");
      assert.deepEqual([item(m.doc, "ti").startTime, item(m.doc, "ti").endTime], [30, 32.5], "v5: the Titles track was not remapped");
      assert.equal(item(m.doc, "c2"), undefined);
      assert.deepEqual([item(m.doc, "c8").startTime, item(m.doc, "c8").endTime], [30, 37]);
    }
    same(E.merge3(rbase, human, agent, S).doc, E.merge3(rbase, agent, human, S).doc);
  });

  test("ripple (v5): a recorded remap listing both tracks moves the title too (27–29.5)", () => {
    const { rbase, human, agent } = R();
    const remap = { maps: { [V1]: E.rippleDelete(6, 3), [TT]: E.rippleDelete(6, 3) } };
    const m = E.merge3(rbase, human, agent, S, { remaps: { ours: remap } });
    assert.deepEqual(m.conflicts, []);
    assert.deepEqual([item(m.doc, "ti").startTime, item(m.doc, "ti").endTime], [27, 29.5]);
  });

  test("ripple off (v5: infer:false): the algebra still composes move∘trim-out for clip 7, but the append is not mapped", () => {
    const { rbase, human, agent } = R();
    const m = E.merge3(rbase, human, agent, S, { infer: false });
    assert.deepEqual(m.conflicts, []);
    const c7 = item(m.doc, "c7");
    assert.deepEqual([c7.startTime, c7.endTime], [24, 29]);
    assert.equal(item(m.doc, "ov").startTime, 40);
  });

  test("ripple: an agent clip placed over the clip the human deleted (on V1) is flagged", () => {
    const { rbase, human } = R();
    const over = { ...overlay, id: "tx", startTime: 7, endTime: 8 };
    const m = E.merge3(rbase, human, { ...rbase, timelineItems: [...(rbase.timelineItems as Json[]), over] }, S);
    assert.equal(m.conflicts.length, 1);
    assert.equal(m.conflicts[0]!.kind, "remap");
    assert.equal(m.conflicts[0]!.path, "timelineItems/tx");
  });

  test("ripple: agent removing a clip the human only shifted is clean", () => {
    const { rbase, human } = R();
    const m = E.merge3(rbase, human, without(rbase, "c5"), S);
    assert.deepEqual(m.conflicts, []);
    assert.equal(item(m.doc, "c5"), undefined);
  });

  // ------------------------------------------------------------------ keyed arrays (sequences)

  const FX = once(() => ({ fxBase: H(F().base, (h) => (h.timelineItems.find((i: Json) => i.id === "a1").effects = [{ id: "e1", type: "blur", amount: 1 }, { id: "e2", type: "glow", amount: 1 }])) }));
  const fx = (doc: Doc, list: Json[]) => H(doc, (h) => (h.timelineItems.find((i: Json) => i.id === "a1").effects = list));
  const e1 = { id: "e1", type: "blur", amount: 1 },
    e2 = { id: "e2", type: "glow", amount: 1 };
  const e3 = { id: "e3", type: "vignette", amount: 0.5 },
    e4 = { id: "e4", type: "sharpen", amount: 0.2 };
  const ids = (doc: Doc) => (item(doc, "a1").effects as Json[]).map((e) => e.id);

  test("effects: concurrent adds both kept, order independent of side", () => {
    const { fxBase } = FX();
    const o = fx(fxBase, [e1, e3, e2]),
      t = fx(fxBase, [e1, e2, e4]);
    const m = E.merge3(fxBase, o, t, S),
      m2 = E.merge3(fxBase, t, o, S);
    assert.deepEqual(m.conflicts, []);
    assert.deepEqual(ids(m.doc), ["e1", "e3", "e2", "e4"]);
    same(m.doc, m2.doc);
  });

  test("effects (v5: keys): a reorder on one side + an add and an edit on the other merge", () => {
    const { fxBase } = FX();
    const o = fx(fxBase, [e2, e1]),
      t = fx(fxBase, [e1, { ...e2, amount: 0.3 }, e4]);
    const m = E.merge3(fxBase, o, t, S);
    assert.deepEqual(m.conflicts, []);
    const got: Json[] = item(m.doc, "a1").effects;
    assert.deepEqual(got.map((e) => e.id).sort(), ["e1", "e2", "e4"]);
    const at = (id: string) => got.findIndex((e) => e.id === id);
    assert.ok(at("e2") < at("e1"), "ours' reorder kept");
    assert.ok(at("e2") < at("e4"), "theirs' add stays after e2");
    assert.equal(got[at("e2")].amount, 0.3, "edit inside the moved element kept");
  });

  test("effects (v5): moves of different elements merge; the same element moved to two places is an order card", () => {
    const { fxBase } = FX();
    const ebase = fx(fxBase, [e1, e2, e3, e4]);
    const m = E.merge3(ebase, fx(ebase, [e4, e1, e2, e3]), fx(ebase, [e1, e4, e2, e3]), S);
    assert.equal(m.conflicts.length, 1, "e4 moved by both, to different places");
    assert.equal(m.conflicts[0]!.kind, "order");
    assert.deepEqual(ids(E.resolve(m, ["theirs"])), ["e1", "e4", "e2", "e3"]);
    assert.deepEqual(ids(E.resolve(m, ["ours"])), ["e4", "e1", "e2", "e3"]);
    const m2 = E.merge3(ebase, fx(ebase, [e4, e1, e2, e3]), fx(ebase, [e2, e3, e4, e1]), S);
    assert.deepEqual(m2.conflicts, []);
    assert.deepEqual(ids(m2.doc), ["e4", "e2", "e3", "e1"], "ours moved e4 to the front, theirs moved e1 to the end");
  });

  test("effects: remove vs edit of one effect is a conflict at that effect", () => {
    const { fxBase } = FX();
    const m = E.merge3(fxBase, fx(fxBase, [e1]), fx(fxBase, [e1, { ...e2, amount: 0.1 }]), S);
    assert.equal(m.conflicts.length, 1);
    assert.equal(m.conflicts[0]!.path, "timelineItems/a1/effects/e2");
  });

  test("keyframes are atomic per keyframe track: concurrent edits of one track conflict", () => {
    const { base } = F();
    const kb = H(base, (h) => (h.timelineItems.find((i: Json) => i.id === "a1").keyframeTracks = [{ property: "opacity", keyframes: [{ time: 0, value: 0 }] }, { property: "scale", keyframes: [{ time: 0, value: 1 }] }]));
    const set = (doc: Doc, prop: string, kf: Json[]) => H(doc, (h) => (h.timelineItems.find((i: Json) => i.id === "a1").keyframeTracks.find((k: Json) => k.property === prop).keyframes = kf));
    const m = E.merge3(kb, set(kb, "opacity", [{ time: 0, value: 0.5 }]), set(kb, "opacity", [{ time: 1, value: 1 }]), S);
    assert.equal(m.conflicts[0]!.path, "timelineItems/a1/keyframeTracks/opacity/keyframes");
    const ok = E.merge3(kb, set(kb, "opacity", [{ time: 0, value: 0.5 }]), set(kb, "scale", [{ time: 0, value: 2 }]), S);
    assert.deepEqual(ok.conflicts, []);
  });

  // ------------------------------------------------------------------ describe

  test("describe: short human sentences", () => {
    const { base } = F();
    const { rbase, human } = R();
    const ops = E.diff(base, edit(base, "a1", { endTime: 5, trimEnd: 5 }), S);
    assert.deepEqual(E.describe(ops, base, S), ["Trimmed 'Intro' end 6.0 s → 5.0 s"]);
    const ag = { ...edit(rbase, "c7", { endTime: 32, trimEnd: 6 }), timelineItems: [...(edit(rbase, "c7", { endTime: 32, trimEnd: 6 }).timelineItems as Json[]), title] };
    assert.deepEqual(E.describe(E.diff(rbase, ag, S), rbase, S), ["Trimmed 'c7' end 33.0 s → 32.0 s", "Added text 'Over clip 7' on 'Titles' at 30.0 s"]);
    assert.deepEqual(E.describe(E.diff(rbase, human, S), rbase, S), ["Removed 3.0 s from 'V1' at 6.0 s (later items pulled left)", "Deleted video 'c2'"]);
    const g = E.describe(E.diff(base, edit(base, "a3", { colorGrade: { saturation: 1.3, contrast: 1 }, trackId: "titles" }), S), base, S);
    // a schema may give the field an editor's word (`labels`); unlabelled, it prints its path
    const sat = S.collections.timelineItems?.labels?.["colorGrade.saturation"] ?? "colorGrade.saturation";
    assert.deepEqual(g, [`Moved 'CTA' to track 'Titles', ${sat} 1.1 → 1.3`]);
  });

  // ------------------------------------------------------------------ sequencer

  // port: `new E.Sequencer(doc, schema)` is `createLocalSequencer(doc, schema)`, and a push is a full Change (see
  // toChange). Ids are `<rid>.<n>`, which the v14 sequencer checks: the prototype's "c1" is "t.c1".
  // port: the local sequencer no longer describes the clash on a reject (sync-sequencer e36b6b4: History reads only the
  // reason); the description these tests check is the exported overlap() against the first concurrent change it meets
  const described = (ch: Parameters<E.sequencer.LocalSequencer["push"]>[0], r: PushResult): PushResult => {
    if (r.ok || r.overlap || r.reason !== "overlap") return r;
    const past = new Set(ch.base.pending);
    for (const c of r.missing) {
      if (past.has(c.id)) continue;
      const o = E.sequencer.overlap(ch, c);
      if (o.path || o.read || o.span || o.order) return { ...r, overlap: o };
    }
    return r;
  };
  const push = (sq: E.sequencer.LocalSequencer, id: string, baseSeq: number, baseDoc: Doc, doc: Doc, extra: Partial<PushInput> = {}): PushResult => {
    const ch = toChange(S, sq, { id: `t.${id}`, base: baseSeq, ops: E.diff(baseDoc, doc, S), baseDoc, author: extra.author ?? actor(id), ...extra });
    return described(ch, sq.push(ch));
  };
  const raw = (sq: E.sequencer.LocalSequencer, c: Omit<PushInput, "id"> & { id: string }): PushResult => {
    const ch = toChange(S, sq, { ...c, id: `t.${c.id}` });
    return described(ch, sq.push(ch));
  };

  test("sequencer (v5 overlap rule): fast-forward, concurrent disjoint accept, overlap reject, idempotent ids, read deps", () => {
    const { base } = F();
    const sq = E.sequencer.createLocalSequencer(base, S);
    assert.equal(accepted(push(sq, "c1", 0, base, edit(base, "a1", { name: "I" }))).seq, 1);
    const r2 = push(sq, "c2", 0, base, edit(base, "a2", { name: "P" }));
    assert.ok(r2.ok);
    assert.equal(r2.missing.length, 1);
    const r3 = rejected(push(sq, "c3", 0, base, edit(base, "a1", { name: "J" })));
    assert.equal(r3.ok, false);
    assert.equal(r3.missing.length, 2);
    assert.equal(r3.overlap!.path, "timelineItems/a1/name");
    assert.equal(accepted(raw(sq, { id: "c2", base: 0, ops: [] })).duplicate, true);
    // remove record vs stale edit of a field inside it
    raw(sq, { id: "c4", base: 2, ops: [{ op: "remove", path: ["timelineItems", "a3"] }], baseDoc: sq.head });
    assert.equal(raw(sq, { id: "c5", base: 2, ops: [{ op: "set", path: ["timelineItems", "a3", "name"], value: "x" }], baseDoc: base }).ok, false);
    // track removed after base: a stale insert onto it is rejected (read of tracks/titles)
    const h3 = E.fork(sq.head, S);
    raw(sq, {
      id: "c6",
      base: 3,
      ops: [
        { op: "remove", path: ["tracks", "titles"] },
        { op: "remove", path: ["timelineItems", "t1"] },
      ],
      baseDoc: h3,
    });
    const t2 = { id: "t2", trackId: "titles", type: "text", startTime: 9, endTime: 10, trimStart: 0, trimEnd: 1 };
    const r7 = rejected(raw(sq, { id: "c7", base: 3, ops: [{ op: "insert", path: ["timelineItems", "t2"], value: t2 }], baseDoc: h3 }));
    assert.equal(r7.ok, false);
    assert.equal(r7.overlap!.read, "tracks/titles");
    const replay = E.apply(
      E.fork(base, S),
      sq.log.flatMap((c) => c.ops),
      S,
    );
    same(replay, sq.head);
  });

  test("sequencer (v5: spans): a ripple's span [6, ∞) on V1 rejects a stale append on V1; a client rebase through merge3 with the recorded remap maps it to 37", () => {
    const { rbase, human } = R();
    const sq = E.sequencer.createLocalSequencer(rbase, S);
    const remap = { maps: { [V1]: E.rippleDelete(6, 3) } };
    assert.ok(raw(sq, { id: "h", base: 0, ops: E.diff(rbase, human, S), baseDoc: rbase, intent: remap }).ok);
    const mine = { ...rbase, timelineItems: [...(rbase.timelineItems as Json[]), overlay] };
    const r = rejected(raw(sq, { id: "a", base: 0, ops: E.diff(rbase, mine, S), baseDoc: rbase }));
    assert.equal(r.ok, false);
    assert.equal(r.overlap!.span!.track, V1);
    // port: an open-ended span's `hi` is null (JSON has no Infinity), so [6, ∞) is [6, null]
    assert.deepEqual(r.overlap!.span!.b, [6, null], "the logged ripple's span is [6, ∞)");
    // a title on another track does not overlap the V1 span
    assert.ok(raw(sq, { id: "t", base: 0, ops: [{ op: "insert", path: ["timelineItems", "ti"], value: title }], baseDoc: rbase }).ok);
    const server = E.apply(
      E.fork(rbase, S),
      r.missing.flatMap((c) => c.ops),
      S,
    );
    const m = E.merge3(rbase, server, mine, S, { remaps: { ours: remap } });
    assert.deepEqual(m.conflicts, []);
    const head = E.fork(sq.head, S);
    assert.ok(raw(sq, { id: "a", base: sq.seq, ops: E.diff(head, E.apply(E.fork(head, S), E.diff(server, m.doc, S), S), S), baseDoc: head }).ok === true);
    assert.equal(item(sq.head, "ov").startTime, 37);
  });

  // ------------------------------------------------------------------ shot diff

  test("shot diff: a global ripple cut reports only the cut; shifted shots are unchanged; a split is no change", () => {
    const a = withKeys(genDoc(0, 7, { seconds: 600 }));
    const main = (a.tracks as Json[]).find((t) => t.name === "Main").id;
    const cut = (a.timelineItems as Json[]).filter((i) => i.trackId === main && i.startTime > 250).sort((x, y) => x.startTime - y.startTime)[0];
    const [s, e] = [cut.startTime, cut.endTime];
    const b = rippleCut(a, s, e);
    const r = E.shotDiff(a, b, S);
    assert.ok(r.changed.length >= 1 && r.changed.length <= 3, JSON.stringify(r.changed));
    for (const c of r.changed) {
      if (c.a) assert.ok(c.a[0] >= s - 6 && c.a[1] <= e + 6, `A range ${c.a} should sit on the cut ${[s, e]}`);
      if (c.b) assert.ok(c.b[0] >= s - 6 && c.b[1] <= s + 6, `B range ${c.b} should sit at ${s}`);
    }
    assert.ok(r.shifted > r.shotsA / 3, `most shots after the cut are shifted, not changed (${r.shifted}/${r.shotsA})`);
    const split = (a.timelineItems as Json[]).find((i) => i.trackId === main && i.endTime - i.startTime > 3 && !i.keyframeTracks && !i.transitionIn);
    const mid = split.startTime + 1.5;
    const halves = [
      { ...split, endTime: mid, trimEnd: split.trimStart + 1.5 },
      { ...split, id: "split-2", startTime: mid, trimStart: split.trimStart + 1.5 },
    ];
    const c = { ...a, timelineItems: (a.timelineItems as Json[]).flatMap((i) => (i === split ? halves : [i])) };
    assert.deepEqual(E.shotDiff(a, c, S).changed, []);
    const g = (a.timelineItems as Json[]).find((i) => i.trackId === main && i.startTime > 400);
    const graded = edit(a, g.id, { colorGrade: { saturation: 0.2 } });
    const rg = E.shotDiff(a, graded, S);
    assert.equal(rg.changed.length, 1);
    assert.deepEqual(rg.changed[0]!.a, rg.changed[0]!.b);
    assert.ok(rg.changed[0]!.a![0] >= g.startTime - 1e-6 && rg.changed[0]!.a![1] <= g.endTime + 1e-6);
  });

  test("fork shares the id index copy-on-write: parent and fork can both insert/remove afterwards", () => {
    const { base } = F();
    const a0 = { ...base, timelineItems: [...(base.timelineItems as Json[])] };
    E.getIn(a0, ["timelineItems", "a1"], S);
    const b0 = E.fork(a0, S);
    E.apply(
      a0,
      [
        { op: "remove", path: ["timelineItems", "a2"] },
        { op: "insert", path: ["timelineItems", "n1"], value: { ...(base.timelineItems as Json[])[0], id: "n1" } },
      ],
      S,
    );
    assert.equal(E.getIn(b0, ["timelineItems", "a2", "name"], S), "Problem", "fork still sees a2");
    assert.equal(E.getIn(b0, ["timelineItems", "n1"], S), undefined, "fork does not see n1");
    assert.equal(E.getIn(a0, ["timelineItems", "a2"], S), undefined);
    const r = rng(77);
    for (let c = 0; c < 300; c++) {
      const a = withKeys(fuzzDoc(r));
      E.getIn(a, ["timelineItems", "x"], S);
      const b = E.fork(a, S),
        ref = [structuredClone(a), structuredClone(b)];
      for (let k = 0; k < 6; k++) {
        const which = k % 2,
          doc = [a, b][which]!,
          d2 = fromHost(fuzzEdit(r, toHost(ref[which]!), 1, ["add", "remove", "trackAdd", "trackRemove", "field"]), ref[which]!);
        E.apply(doc, E.diff(ref[which]!, d2, S), S);
        ref[which] = d2;
        for (const [x, y] of [
          [a, ref[0]!],
          [b, ref[1]!],
        ] as const) {
          same(x, y, `case ${c} step ${k}`);
          for (const it of y.timelineItems as Json[]) assert.equal(E.getIn(x, ["timelineItems", it.id, "id"], S), it.id);
        }
      }
    }
  });

  // ------------------------------------------------------------------ property-based fuzz (core-proto's properties)

  const K = (r: Rng): Doc => {
    const d = withKeys(fuzzDoc(r));
    return r() < 0.5 ? d : JSON.parse(JSON.stringify(d));
  };
  const ed = (r: Rng, d: Doc, k?: number, kinds?: readonly EditKind[]) => fromHost(fuzzEdit(r, toHost(d) as HostDoc, k, kinds), d);

  test(`fuzz: apply(a, diff(a, b)) == b  (${CASES} cases)`, () => {
    for (let c = 0; c < CASES; c++) {
      const r = rng(1000 + c);
      const a = K(r),
        b = ed(r, a, int(r, 1, 4));
      const ops = E.diff(a, b, S);
      same(E.apply(E.fork(a, S), ops, S), b, `case ${c}`);
      same(E.apply(JSON.parse(JSON.stringify(a)), JSON.parse(JSON.stringify(ops)) as Op[], S), b, `case ${c} json`);
    }
  });

  test(`fuzz: merge3(base, x, x) == x and merge3(base, base, x) == merge3(base, x, base) == x  (${CASES} cases)`, () => {
    for (let c = 0; c < CASES; c++) {
      const r = rng(5000 + c);
      const b = K(r),
        x = ed(r, b);
      const mxx = E.merge3(b, x, x, S);
      assert.deepEqual(mxx.conflicts, [], `case ${c}`);
      same(mxx.doc, x, `case ${c} x,x`);
      same(E.merge3(b, b, x, S).doc, x, `case ${c} base,x`);
      same(E.merge3(b, x, b, S).doc, x, `case ${c} x,base`);
    }
  });

  test(`fuzz: concurrent edits — symmetric, resolvable, no silent loss, valid  (${CASES} cases)`, () => {
    const tally: Required<MergeTally> = { conflicts: 0, remaps: 0, composed: 0, mapped: 0, text: 0 };
    for (let c = 0; c < CASES; c++) {
      const r = rng(9000 + c);
      const b = K(r),
        x = ed(r, b),
        y = ed(r, b);
      checkMerge(S, b, x, y, r, `case ${c}`, tally);
    }
    console.log(`  # concurrent fuzz: ${tally.conflicts} cards across ${CASES} cases; ${tally.remaps} with a remap; ${tally.composed} time groups composed, ${tally.mapped} mapped; ${tally.text} text merges`);
  });

  test(`fuzz: sequencer — clients pushing concurrent changes with rebase converge  (${CASES} cases)`, () => {
    let pushes = 0,
      rejects = 0,
      nonFF = 0;
    for (let c = 0; c < CASES; c++) {
      const r = rng(20000 + c);
      const doc0 = K(r);
      const sq = E.sequencer.createLocalSequencer(doc0, S);
      const clients = Array.from({ length: int(r, 2, 4) }, (_, i) => ({ name: `c${i}`, doc: E.fork(doc0, S), seq: 0 }));
      const catchUp = (cl: (typeof clients)[number], to: number) => {
        E.apply(
          cl.doc,
          sq
            .pull(cl.seq)
            .slice(0, to - cl.seq)
            .flatMap((ch) => ch.ops),
          S,
        );
        cl.seq = to;
      };
      for (let step = int(r, 3, 8); step > 0; step--) {
        const cl = pick(r, clients);
        if (r() < 0.2) {
          catchUp(cl, sq.seq);
          continue;
        }
        const local = ed(r, cl.doc);
        let baseDoc = cl.doc,
          baseSeq = cl.seq,
          mine = local,
          ops = E.diff(baseDoc, local, S);
        for (let attempt = 0; ; attempt++) {
          assert.ok(attempt < 10, "rebase loop");
          const headBefore = E.fork(sq.head, S);
          // port: ids are `<rid>.<n>`-shaped; the author is an Actor
          const res = sq.push(toChange(S, sq, { id: `${c}-${cl.name}-${step}.${attempt}`, base: baseSeq, ops, author: actor(cl.name), baseDoc }));
          pushes++;
          if (res.ok) {
            if (res.missing.length) {
              nonFF++;
              // an accepted concurrent push must equal a clean 3-way merge of what it overlapped with nothing
              const m = E.merge3(baseDoc, headBefore, mine, S, { infer: false });
              assert.deepEqual(m.conflicts, [], `case ${c} accepted but merge3 conflicts`);
              same(m.doc, sq.head, `case ${c} accepted != merge3`);
            }
            cl.doc = E.apply(E.fork(baseDoc, S), [...res.missing.flatMap((ch) => ch.ops), ...res.change.ops], S);
            cl.seq = res.seq;
            break;
          }
          rejects++;
          // a change the server refuses is dropped (its author is told)
          // port: v14 names its validation rejects (`invalid`, `exists`, `no ops`, ...): the prototype's "invalid" is any of them
          if (E.sync.VALIDATION_REASONS.has(res.reason)) break;
          const server = E.apply(
            E.fork(baseDoc, S),
            res.missing.flatMap((ch) => ch.ops),
            S,
          );
          const m = E.merge3(baseDoc, server, mine, S, { rekeys: "ours" });
          mine = E.resolve(
            m,
            m.conflicts.map(() => pick(r, ["ours", "theirs"] as const)),
          );
          ops = E.diff(server, mine, S);
          baseDoc = server;
          baseSeq = res.head;
        }
      }
      for (const cl of clients) {
        catchUp(cl, sq.seq);
        same(cl.doc, sq.head, `case ${c} client ${cl.name} diverged`);
      }
      same(
        E.apply(
          E.fork(doc0, S),
          sq.log.flatMap((ch) => ch.ops),
          S,
        ),
        sq.head,
        `case ${c} replay`,
      );
    }
    console.log(`  # sequencer fuzz: ${pushes} pushes, ${rejects} rejected+rebased, ${nonFF} accepted non-fast-forward`);
  });
}
