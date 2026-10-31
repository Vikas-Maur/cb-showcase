// Engine conformance scenarios (port of core-v5 `conformance.test.mjs`): every engine-level scenario, named after its
// source id. Sources: PLAN.md v7 §1 (B1–B13), critique/experiments/seqsim.mjs (S1–S7), coupled-times.sh, round-4 R4-06,
// fi-interleave.mjs / verify2/fi-jitter.mjs (M4), R4-05, shallow-chain.mjs (R4-01), freeze-reapply.mjs (R4-02),
// net-remap.mjs (R5-01), round-5 R5-02/R5-03, remap-dag.cjs (R6-01), export-walk.cjs (R6-02), PLAN §4.4, §5.2, §5.3,
// §7, §13.
//
// Test names are the prototype's, byte for byte (they are traced by name). Where the contract changed a shape or a rule
// the prototype asserted, the assertion is adapted to check the same property and says so in a `port:` comment.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import * as E from "@carton/core";
import { History, StateUnknown } from "@carton/core";
import type { Actor, Doc, Intent, Lineage, Op, RemapMaps, Schema, TimeAlgebra } from "@carton/core";
import { fromHost, toHost, withKeys, projectGuiSave } from "./fixtures/cardboard-schema.ts";
import { exportCbproj, importCbproj, zip, SHALLOW_ENTRY } from "./cbproj.ts";
import { realProjection } from "./fmsv.ts";
import { rng } from "./gen.ts";
import { accepted, baseOf, confirmed, importedHead, isRk, rejected, tmpRoot, toChange } from "./support.ts";
import type { Json } from "./support.ts";

export interface ConformanceOptions {
  /** Directory for the .cbproj zips (default: $CARTON_TEST_TMP or the OS temp dir). */
  tmpDir?: string;
  /** An unpacked Cardboard 1.4.0 for B10's real fm∘sv (default: $CARTON_CARDBOARD_DIR, else the inspection copy). */
  cardboardDir?: string;
}

export function conformanceTests(S: Schema, opts: ConformanceOptions = {}): void {
  const snap = (d: Doc) => E.snapshot(d, S);
  const it = (doc: Doc | null, id: string): Json => (doc!.timelineItems as Json[]).find((i) => i.id === id);
  const setItem = (doc: Doc, id: string, patch: Json): Doc => ({ ...doc, timelineItems: (doc.timelineItems as Json[]).map((i) => (i.id === id ? { ...i, ...patch } : i)) });
  const addItem = (doc: Doc, rec: Json): Doc => ({ ...doc, timelineItems: [...(doc.timelineItems as Json[]), rec] });
  const dropItem = (doc: Doc, id: string): Doc => ({ ...doc, timelineItems: (doc.timelineItems as Json[]).filter((i) => i.id !== id) });
  const clip = (id: string, trackId: string, s: number, e: number, x: Json = {}): Json => ({ id, trackId, type: "video", name: id, startTime: s, endTime: e, trimStart: 0, trimEnd: e - s, ...x });
  const doc = (tracks: (string | Json)[], items: Json[], root: Json = {}): Doc => withKeys({ name: "P", aspectRatio: "16:9", ...root, tracks: tracks.map((t, i) => (typeof t === "string" ? { id: t, name: t, order: i } : t)), timelineItems: items });
  const HUMAN: Actor = { kind: "human", id: "alice", name: "Alice" };
  const BOB: Actor = { kind: "human", id: "bob", name: "Bob" };
  const AGENT: Actor = { kind: "agent", id: "director", name: "Director", chat: "c1", turn: "t3", agentId: "a7f3", agentType: "general-purpose", provider: "anthropic", model: "claude" };
  const H = (d: Doc, mutate: (h: Json) => unknown): Doc => {
    const h = structuredClone(toHost(d));
    mutate(h);
    return fromHost(h, d);
  };
  // ripple delete [at, at+len) on one track, done by the host (shift later items), with its recorded intent
  function ripple(d: Doc, track: string, at: number, len: number): { doc: Doc; intent: Intent } {
    const out = { ...d, timelineItems: (d.timelineItems as Json[]).filter((i) => !(i.trackId === track && i.startTime >= at - 1e-9 && i.endTime <= at + len + 1e-9)).map((i) => (i.trackId === track && i.startTime >= at + len - 1e-9 ? { ...i, startTime: i.startTime - len, endTime: i.endTime - len } : i)) };
    return { doc: out, intent: { maps: { [track]: E.rippleDelete(at, len) } } };
  }
  const ship = <T>(pkg: T): T => JSON.parse(JSON.stringify(pkg)); // the .cbproj file
  const set = (path: (string | number)[], value: unknown): Op => ({ op: "set", path, value });

  // ------------------------------------------------------------------ B1–B13 (PLAN §1)

  test("B1 lost update: a stale write to the same leaf is rejected and rebased to a card, never silently overwritten; lww accepts with a notice", () => {
    const d0 = doc(["V"], [clip("x", "V", 0, 5, { opacity: 1 })]);
    const r = History.create(S, d0);
    const b = r.current;
    const base = r.ref(b);
    assert.equal(r.commit(b, { doc: setItem(d0, "x", { opacity: 0.5 }), author: HUMAN, base }).status, "confirmed");
    const second = r.commit(b, { doc: setItem(d0, "x", { opacity: 0.8 }), author: AGENT, base });
    assert.equal(second.status, "conflicts");
    assert.equal(second.cards[0]!.path, "timelineItems/x/opacity");
    assert.deepEqual([second.cards[0]!.ours, second.cards[0]!.theirs], [0.5, 0.8]);
    assert.equal(it(r.stateOf(r.head(b)), "x").opacity, 0.5, "nothing applied until the card is resolved");
    // policy lww: accepted, the overwritten author is told
    const r2 = History.create(S, d0);
    const b2 = r2.current,
      base2 = r2.ref(b2);
    r2.commit(b2, { doc: setItem(d0, "x", { opacity: 0.5 }), author: HUMAN, base: base2 });
    const l = r2.commit(b2, { doc: setItem(d0, "x", { opacity: 0.8 }), author: AGENT, base: base2, policy: "lww" });
    assert.equal(l.status, "confirmed");
    // port: a notice is addressed to an actor key (`kind/id[/agentId]`), not the actor object
    assert.equal(l.notices[0]!.to, E.sequencer.actorKey(HUMAN));
    assert.equal(it(r2.stateOf(r2.head(b2)), "x").opacity, 0.8);
  });

  test("B2 pruned base: an expired or unknown base ref is the 're-print' error, never a 2-way fallback (no silent revert)", () => {
    const d0 = doc(["V"], [clip("x", "V", 0, 5)]);
    const r = History.create(S, d0, { clock: () => 100 });
    const b = r.current;
    const pending = { id: "p.1", ops: [set(["timelineItems", "x", "name"], "draft")] };
    // port: pin({branchId, holder}) is pin({cutId, owner})
    const pin = r.pin({ cutId: b, pending: [pending], owner: "agent", expires: 200 });
    r.commit(b, { doc: setItem(d0, "x", { opacity: 0.3 }), author: HUMAN });
    r.expirePins(250);
    const before = snap(r.stateOf(r.head(b))!);
    assert.throws(
      () => r.commit(b, { doc: setItem(d0, "x", { name: "agent" }), author: AGENT, base: pin }),
      (e) => e instanceof StateUnknown && /re-print/.test(e.message),
    );
    assert.equal(snap(r.stateOf(r.head(b))!), before, "nothing was merged against a guessed base");
    // an unknown ref (a branch this replica never had) is the same error
    assert.throws(
      () => r.commit(b, { doc: setItem(d0, "x", { name: "agent" }), author: AGENT, base: { branchId: "ffffffffffffffff", seq: 3, hash8: "deadbeef" } }),
      (e) => e instanceof StateUnknown && /re-print \(unknown branch/.test(e.message),
    );
    assert.equal(snap(r.stateOf(r.head(b))!), before);
  });

  test("B3 GUI save of the whole doc: the change touches only the edited record; a concurrent agent edit on another record survives", () => {
    const d0 = doc(["V"], Array.from({ length: 20 }, (_, i) => clip(`c${i}`, "V", i * 2, i * 2 + 2)));
    const r = History.create(S, d0);
    const b = r.current,
      base = r.ref(b);
    r.commit(b, { doc: setItem(d0, "c3", { name: "agent rename" }), author: AGENT, base });
    const gui = fromHost(toHost(setItem(d0, "c9", { opacity: 0.4 })), d0); // the GUI writes every array whole
    const ops = E.diff(d0, gui, S);
    assert.deepEqual(
      ops.map((o) => E.pathKey(o.path)),
      ["timelineItems/c9/opacity"],
    );
    const res = r.commit(b, { doc: gui, author: HUMAN, base });
    assert.equal(res.status, "confirmed");
    const h = r.stateOf(r.head(b));
    assert.equal(it(h, "c3").name, "agent rename");
    assert.equal(it(h, "c9").opacity, 0.4);
  });

  test("B4 nested values: colorGrade keys and nested wheels merge per key, not as one whole", () => {
    const b = doc(["V"], [clip("x", "V", 0, 5, { colorGrade: { saturation: 1, contrast: 1, wheels: { lift: { r: 0, g: 0 } } } })]);
    const o = setItem(b, "x", { colorGrade: { saturation: 1.3, contrast: 1, wheels: { lift: { r: 0.1, g: 0 } } } });
    const t = setItem(b, "x", { colorGrade: { saturation: 1, contrast: 1.2, wheels: { lift: { r: 0, g: 0.2 } } } });
    const m = E.merge3(b, o, t, S);
    assert.deepEqual(m.conflicts, []);
    assert.deepEqual(it(m.doc, "x").colorGrade, { saturation: 1.3, contrast: 1.2, wheels: { lift: { r: 0.1, g: 0.2 } } });
  });

  test("B5 deleting a track vs an item just added to it: rejected at the sequencer (read of the track) and a parent card on rebase, never silently dropped", () => {
    const d0 = doc(["V", "T"], [clip("x", "V", 0, 5), clip("t1", "T", 0, 2)]);
    const r = History.create(S, d0);
    const b = r.current,
      base = r.ref(b);
    r.commit(b, { doc: addItem(d0, clip("new", "T", 3, 4)), author: HUMAN, base });
    const del = { ...d0, tracks: (d0.tracks as Json[]).filter((t) => t.id !== "T"), timelineItems: (d0.timelineItems as Json[]).filter((i) => i.trackId !== "T") };
    // port: `overlap` is the sequencer's (`E.sequencer.overlap`)
    const why = E.sequencer.overlap(E.declare(S, d0, E.diff(d0, del, S)), E.declare(S, d0, E.diff(d0, addItem(d0, clip("new", "T", 3, 4)), S)));
    assert.deepEqual(Object.keys(why), ["read"], "the overlap is the insert's read of tracks/T");
    assert.equal(why.read, "tracks/T");
    const res = r.commit(b, { doc: del, author: AGENT, base });
    assert.equal(res.status, "conflicts");
    assert.ok(res.merge, "the card comes from the rebase's merge3 after the sequencer rejected the push");
    assert.equal(res.cards[0]!.kind, "parent");
    assert.ok(res.cards[0]!.related!.includes("timelineItems/new"));
    assert.ok(it(r.stateOf(r.head(b)), "new"), "the added item is still there");
  });

  test("B6 (engine part) history is not 20 snapshots: 300 commits, every state reconstructs to its recorded hash; an old change reverts as an inverse change at head", () => {
    let d = doc(["V"], Array.from({ length: 10 }, (_, i) => clip(`c${i}`, "V", i * 3, i * 3 + 2)));
    const r = History.create(S, d, { keyframeEvery: 32 });
    const b = r.current;
    const hashes = [E.hashDoc(d, S)];
    for (let i = 0; i < 300; i++) {
      d = setItem(d, `c${i % 10}`, { opacity: (i % 7) / 10 });
      r.commit(b, { doc: d, author: HUMAN });
      hashes.push(E.hashDoc(d, S));
    }
    for (let s = 0; s <= 300; s++) assert.equal(E.hashDoc(r.stateOf(`${b}@${s}`)!, S), hashes[s], `state @${s}`);
    // port: r.branches.get(b).log is r.changes(b)
    const third = r.changes(b)[2]!;
    const rv = r.revert(b, third.id, { author: HUMAN });
    assert.equal(rv.status, "conflicts", "a later change to the same field becomes a card, not a silent revert");
    r.commit(b, { doc: { ...r.stateOf(r.head(b))!, description: "x" }, author: HUMAN });
    const id = r.changes(b).at(-1)!.id;
    const n = r.changes(b).length;
    r.revert(b, id, { author: HUMAN });
    assert.equal(r.changes(b).length, n + 1, "the inverse is a new change at the head; history is not rewritten");
    assert.equal(r.changes(b).at(-1)!.kind, "revert");
    assert.equal(r.stateOf(r.head(b))!.description, undefined, "the inverse change undid it");
  });

  test("B7 authorship: every confirmed change carries its author down to the subagent; blame names it per record", () => {
    const d0 = doc(["V"], [clip("x", "V", 0, 5), clip("y", "V", 5, 9)]);
    const r = History.create(S, d0);
    const b = r.current;
    r.commit(b, { doc: setItem(d0, "x", { name: "by agent" }), author: AGENT });
    r.commit(b, { doc: setItem(r.stateOf(r.head(b))!, "y", { name: "by human" }), author: HUMAN });
    for (const c of r.changes(b)) assert.ok(c.author && c.id.startsWith(r.rid + "."));
    // port: blame is credits
    assert.deepEqual(r.credits(b, "timelineItems/x"), AGENT);
    assert.equal(r.credits(b, "timelineItems/x")?.agentId, "a7f3");
    assert.deepEqual(r.credits(b, "timelineItems/y"), HUMAN);
  });

  test("B8 media content id: system-level (media package, proofs/media); not in the core engine", { skip: "system-level: PLAN §11 mediaHash, measured in proofs/media" }, () => {});

  test("B9 no '(recovered conflict)' copies: a stale push whose span overlaps is rejected, rebased by merge3 and confirmed on the one branch; different leaves commute", () => {
    const d0 = doc(["V"], [clip("x", "V", 0, 5), clip("y", "V", 5, 9)]);
    const r = History.create(S, d0);
    const b = r.current,
      base = r.ref(b);
    r.commit(b, { doc: setItem(d0, "x", { startTime: 1, endTime: 6, name: "mine" }), author: HUMAN, base }); // span [0, 6] on V
    const res = r.commit(b, { doc: setItem(d0, "y", { startTime: 5.5, trimStart: 0.5 }), author: BOB, base }); // span [5, 9] on V
    assert.equal(res.status, "confirmed");
    // port: the contract's rule is v11's (PLAN v14 §6.1): intersecting spans conflict only when one of the two changes
    // is structural, so these two plain timing edits of different clips commute (v5 rejected and rebased this push,
    // `rebased >= 1`). The rejected-and-rebased path is checked with a structural stale push at the end.
    assert.equal(res.rebased, 0, "two plain timing edits of different clips never overlap by span alone");
    // port: r.branches.size is r.cuts().length
    assert.equal(r.cuts().length, 1, "no copy branch or project");
    const h = r.stateOf(r.head(b));
    assert.deepEqual([it(h, "x").startTime, it(h, "x").name, it(h, "y").startTime], [1, "mine", 5.5]);
    const c = r.commit(b, { doc: setItem(d0, "x", { opacity: 0.2 }), author: BOB, base });
    assert.equal(c.status, "confirmed");
    assert.equal(c.rebased, 0, "a different leaf of the same clip commutes");
    // port (v11): a stale insert on V whose span [5.5, 7) meets the moved x [0, 6) is structural: rejected, rebased by
    // merge3 and confirmed on the one branch
    const ins = r.commit(b, { doc: addItem(d0, clip("z", "V", 5.5, 7)), author: BOB, base });
    assert.equal(ins.status, "confirmed");
    assert.ok(ins.rebased >= 1, "the CAS failed (spans intersect) and was rebased, not copied");
    assert.equal(r.cuts().length, 1, "no copy branch or project");
    const h2 = r.stateOf(r.head(b));
    assert.deepEqual([it(h2, "x").startTime, it(h2, "x").opacity, it(h2, "y").startTime, it(h2, "z").startTime], [1, 0.2, 5.5, 5.5]);
  });

  const realP = realProjection(opts.cardboardDir);
  test("B10/S6 lossy GUI serializer: with Cardboard's real fm∘sv, an agent's 60 frame-accurate clips plus a human edit of one other clip gives a change that touches exactly that clip", { skip: realP ? false : "renderer bundle not present" }, () => {
    const P = realP!;
    const items = Array.from({ length: 60 }, (_, k) => {
      const s = (k * 47) / 30,
        e = s + 41 / 30;
      return clip(`a${k}`, "T", s, e);
    });
    const d0 = doc(["T"], [...items, clip("h", "T", 200, 203)]);
    // what the GUI saves after the human sets opacity on h: every item through P = fm∘sv
    const save = { ...toHost(d0), timelineItems: (toHost(d0).timelineItems as Json[]).map((i) => P(i.id === "h" ? { ...i, opacity: 0.5 } : i)) };
    const naive = E.diff(d0, fromHost(save, d0), S);
    const projected = E.diff(d0, projectGuiSave(d0, save, P), S);
    assert.ok(new Set(naive.map((o) => o.path[1])).size >= 59, `without the projection, phantom time writes on ${new Set(naive.map((o) => o.path[1])).size} items`);
    assert.deepEqual(
      projected.map((o) => E.pathKey(o.path)),
      ["timelineItems/h/opacity"],
    );
  });

  test("B11 adopt cancels the pending save and floods undo: system-level (renderer store, gate G1)", { skip: "system-level: renderer hook H5, gate G1 on the Windows build" }, () => {});

  test("B12 track order is a sequence: adding a track is one insert (no renumbering); concurrent inserts keep their intended places whatever the new ids", () => {
    for (const [nId, mId] of [
      ["tN", "tM"],
      ["tN", "tAA"],
      ["tN", "tZ"],
    ] as const) {
      const d0 = doc(["tA", "tB", "tC"], []);
      const top = H(d0, (h) => h.tracks.forEach((t: Json) => t.order++) || h.tracks.push({ id: nId, name: nId, order: 0 }));
      const mid = H(d0, (h) => {
        h.tracks.find((t: Json) => t.id === "tC").order = 3;
        h.tracks.push({ id: mId, name: mId, order: 2 });
      });
      assert.deepEqual(
        E.diff(d0, top, S).map((o) => o.op + " " + E.pathKey(o.path)),
        [`insert tracks/${nId}`],
        "one op, no renumbering",
      );
      const r = History.create(S, d0);
      const b = r.current,
        base = r.ref(b);
      assert.equal(r.commit(b, { doc: top, author: HUMAN, base }).status, "confirmed");
      const res = r.commit(b, { doc: mid, author: BOB, base });
      assert.equal(res.status, "confirmed");
      assert.equal(res.rebased, 0, "different places: no overlap, both accepted");
      assert.deepEqual(
        (toHost(r.stateOf(r.head(b))!).tracks as Json[]).sort((a, c) => a.order - c.order).map((t) => t.id),
        [nId, "tA", "tB", mId, "tC"],
      );
    }
  });

  test("B13 / coupled-times: two clean-looking edge trims that cross (4.5–4) become a card, never an invalid clip", () => {
    const b = doc(["tA"], [{ id: "x1", trackId: "tA", type: "text", startTime: 3, endTime: 5, trimStart: 0, trimEnd: 2, textContent: "one" }]);
    const alice = setItem(b, "x1", { startTime: 4.5, trimStart: 1.5 });
    const bob = setItem(b, "x1", { endTime: 4, trimEnd: 1 });
    const m = E.merge3(b, alice, bob, S);
    assert.equal(m.conflicts.length, 1);
    assert.equal(m.conflicts[0]!.kind, "group");
    assert.equal(m.conflicts[0]!.reason, "invalid");
    for (const c of ["ours", "theirs"] as const) {
      const x = it(E.resolve(m, [c]), "x1");
      assert.ok(x.endTime > x.startTime && x.trimEnd > x.trimStart, `${c} is valid`);
    }
  });

  // ------------------------------------------------------------------ time-group algebra (§4.1, R3-05, R4-06)

  test("R3-05 move ∘ trim-out composes: Alice drags +2, Bob trims the end −0.5 → moved and shortened", () => {
    const b = doc(["V"], [clip("x", "V", 10, 20)]);
    const m = E.merge3(b, setItem(b, "x", { startTime: 12, endTime: 22 }), setItem(b, "x", { endTime: 19.5, trimEnd: 9.5 }), S);
    assert.deepEqual(m.conflicts, []);
    const x = it(m.doc, "x");
    assert.deepEqual([x.startTime, x.endTime, x.trimStart, x.trimEnd], [12, 21.5, 0, 9.5]);
  });

  test("R4-06 ambiguous decomposition: (+1,+1,+1,+1) vs trim-out −0.5 is a card when unrecorded, and composes when recorded as move+slip", () => {
    const b = doc(["V"], [clip("x", "V", 10, 20)]);
    const o = setItem(b, "x", { startTime: 11, endTime: 21, trimStart: 1, trimEnd: 11 });
    const t = setItem(b, "x", { endTime: 19.5, trimEnd: 9.5 });
    // port: the contract's GroupAlgebra has no `get`; the engine's time algebra is a TimeAlgebra, which has
    const alg = S.collections.timelineItems!.groups[0]!.algebra as TimeAlgebra;
    assert.equal(alg.decompositions(alg.get(it(b, "x")), alg.get(it(o, "x"))).length, 2, "two minimal readings: move+slip and trim-in+trim-out");
    const un = E.merge3(b, o, t, S);
    assert.equal(un.conflicts.length, 1);
    assert.equal(un.conflicts[0]!.reason, "same kind or incompatible");
    const rec = E.merge3(b, o, t, S, { kinds: { ours: { x: { move: 1, slip: 1 } } } });
    assert.deepEqual(rec.conflicts, []);
    const x = it(rec.doc, "x");
    assert.deepEqual([x.startTime, x.endTime, x.trimStart, x.trimEnd], [11, 20.5, 1, 10.5]);
  });

  test("time algebra table: slip∘trim-in composes; trim-out vs speed is a card; equal edits apply once", () => {
    const b = doc(["V"], [clip("x", "V", 10, 20, { trimStart: 2, trimEnd: 12 })]);
    const slip = setItem(b, "x", { trimStart: 3, trimEnd: 13 });
    const tin = setItem(b, "x", { startTime: 11, trimStart: 3 });
    const m1 = E.merge3(b, slip, tin, S);
    assert.deepEqual(m1.conflicts, []);
    assert.deepEqual([it(m1.doc, "x").startTime, it(m1.doc, "x").trimStart, it(m1.doc, "x").trimEnd], [11, 4, 13]);
    const speed = setItem(b, "x", { playbackSpeed: 2, endTime: 15 });
    const tout = setItem(b, "x", { endTime: 19, trimEnd: 11 });
    assert.equal(E.merge3(b, speed, tout, S).conflicts.length, 1);
    const once = E.merge3(b, tout, tout, S);
    assert.deepEqual(once.conflicts, []);
    assert.deepEqual([it(once.doc, "x").endTime, it(once.doc, "x").trimEnd], [19, 11], "applied once, not twice");
  });

  // ------------------------------------------------------------------ S1–S7 (seqsim.mjs)

  test("S1 delete vs edit gives a card in both arrival orders", () => {
    const d0 = doc(["T"], [clip("X", "T", 0, 5, { transform: { x: 0, y: 0, scale: 1 } })]);
    const edit = setItem(d0, "X", { transform: { x: 120, y: 0, scale: 1 } });
    const del = dropItem(d0, "X");
    for (const [first, second] of [
      [edit, del],
      [del, edit],
    ] as const) {
      const r = History.create(S, d0);
      const b = r.current,
        base = r.ref(b);
      assert.equal(r.commit(b, { doc: first, author: HUMAN, base }).status, "confirmed");
      const res = r.commit(b, { doc: second, author: AGENT, base });
      assert.equal(res.status, "conflicts", `${first === edit ? "edit first" : "delete first"}`);
      assert.equal(res.cards[0]!.kind, "record");
      assert.equal(res.cards[0]!.path, "timelineItems/X");
    }
  });

  test("S2 ripple delete vs a concurrent append on the same track: the span rejects it and the rebase maps the append next to i3, in both orders", () => {
    const d0 = doc(["T"], [clip("i1", "T", 0, 5), clip("i2", "T", 5, 10), clip("i3", "T", 10, 15)]);
    const rp = ripple(d0, "T", 0, 5);
    const app = addItem(d0, clip("i4", "T", 15, 20));
    const why = E.sequencer.overlap(E.declare(S, d0, E.diff(d0, rp.doc, S), rp.intent), E.declare(S, d0, E.diff(d0, app, S)));
    assert.deepEqual(Object.keys(why), ["span"], "only the spans overlap: the remap's [0, ∞) meets the append's [15, 20] on T");
    for (const order of ["ripple first", "append first"]) {
      const r = History.create(S, d0);
      const b = r.current,
        base = r.ref(b);
      const [a1, a2]: { doc: Doc; intent?: Intent }[] = order === "ripple first" ? [{ doc: rp.doc, intent: rp.intent }, { doc: app }] : [{ doc: app }, { doc: rp.doc, intent: rp.intent }];
      r.commit(b, { ...a1!, author: AGENT, base });
      const res = r.commit(b, { ...a2!, author: BOB, base });
      assert.equal(res.status, "confirmed");
      assert.ok(res.rebased >= 1, "spans [0, ∞) and [15, 20] on T intersect: rejected, then rebased");
      const h = r.stateOf(r.head(b));
      assert.deepEqual([it(h, "i3").startTime, it(h, "i3").endTime, it(h, "i4").startTime, it(h, "i4").endTime], [5, 10, 10, 15], order);
    }
  });

  test("S3 two concurrent track inserts (top and between B and C): both kept in place, orders 0..4, no duplicate", () => {
    const d0 = doc(["tA", "tB", "tC"], []);
    const top = H(d0, (h) => h.tracks.forEach((t: Json) => t.order++) || h.tracks.push({ id: "tN", name: "tN", order: 0 }));
    const mid = H(d0, (h) => (h.tracks.find((t: Json) => t.id === "tC").order = 3) && h.tracks.push({ id: "tM", name: "tM", order: 2 }));
    const m = E.merge3(d0, top, mid, S);
    assert.deepEqual(m.conflicts, []);
    const orders = (toHost(m.doc).tracks as Json[]).map((t) => [t.id, t.order]).sort((a, b) => a[1] - b[1]);
    assert.deepEqual(orders, [
      ["tN", 0],
      ["tA", 1],
      ["tB", 2],
      ["tM", 3],
      ["tC", 4],
    ]);
  });

  test("S4 repeated merges use the last merge as base (DAG): no phantom card; a revert on main after the first merge is kept", () => {
    for (const mainReverts of [false, true]) {
      const d0 = withKeys({ name: "P", aspectRatio: "16:9", tracks: [], timelineItems: [], description: "x0" });
      const r = History.create(S, d0);
      const main = r.current;
      const v = r.fork(r.head(main), "V");
      r.commit(v, { doc: { ...d0, description: "x1" }, author: AGENT });
      // port: merge is fold
      assert.equal(r.fold(main, r.head(v), { author: HUMAN }).status, "confirmed");
      r.commit(main, { doc: { ...r.stateOf(r.head(main))!, description: mainReverts ? "x0" : "x2" }, author: HUMAN });
      r.commit(v, { doc: { ...r.stateOf(r.head(v))!, name: "y7" }, author: AGENT });
      const m2 = r.fold(main, r.head(v), { author: HUMAN });
      assert.equal(m2.status, "confirmed", "no card");
      const h = r.stateOf(r.head(main))!;
      assert.deepEqual([h.description, h.name], [mainReverts ? "x0" : "x2", "y7"]);
    }
  });

  test("S5 an lww set after a concurrent delete is not accepted on a dead record (card on rebase); apply of a set on a missing record is a no-op with 'lost to delete by X'", () => {
    const d0 = doc(["T"], [clip("X", "T", 0, 5, { transform: { x: 0 } })]);
    const r = History.create(S, d0);
    const b = r.current,
      base = r.ref(b);
    r.commit(b, { doc: dropItem(d0, "X"), author: AGENT, base });
    const res = r.commit(b, { doc: setItem(d0, "X", { transform: { x: 40 } }), author: HUMAN, base, policy: "lww" });
    assert.equal(res.status, "conflicts");
    assert.equal(it(r.stateOf(r.head(b)), "X"), undefined, "no half record was created");
    // port: History doesn't expose a cut's sequencer (`r.branches.get(b).sq`): a local sequencer reloaded from the cut's
    // confirmed log, as from the Store, stands in for it. And v14 rejects an op its declaration doesn't cover
    // ("undeclared path"), so the late change declares itself at head (nothing to overlap) instead of an empty
    // declaration.
    const sq = E.sequencer.createLocalSequencer(d0, S);
    sq.load(r.changes(b));
    const p = accepted(sq.push(toChange(S, sq, { id: "late.1", base: sq.seq, ops: [set(["timelineItems", "X", "transform", "x"], 40)], author: HUMAN })));
    assert.ok(p.ok);
    assert.equal(p.notices[0]!.text, "lost to delete by Director");
    assert.equal(it(sq.head, "X"), undefined);
  });

  test("S7 change ids are <rid>.<n> per process: two processes with the same actor never collide; a re-push of one id is acked once", () => {
    const d0 = doc(["T"], [clip("X", "T", 0, 5), clip("Y", "T", 5, 9)]);
    const p1 = History.create(S, d0),
      p2 = new History(S, { name: "p2" });
    assert.notEqual(p1.rid, p2.rid);
    assert.equal(p1.rid.length, 24, "96 bits");
    // port: the cut's own sequencer isn't exposed; a fresh local sequencer at the cut's root is the same (it has no changes)
    const sq = E.sequencer.createLocalSequencer(d0, S);
    const c1 = toChange(S, sq, { id: `${p1.rid}.1`, base: 0, ops: [set(["timelineItems", "X", "textContent"], "Hello")], author: AGENT, baseDoc: d0 });
    const c2 = toChange(S, sq, { id: `${p2.rid}.1`, base: 0, ops: [set(["timelineItems", "Y", "volume"], 80)], author: AGENT, baseDoc: d0 });
    assert.equal(accepted(sq.push(c1)).seq, 1);
    assert.equal(accepted(sq.push(c2)).seq, 2);
    const again = accepted(sq.push({ ...c1, ops: [] }));
    assert.deepEqual([again.duplicate, again.seq, sq.seq], [true, 1, 2]);
  });

  // ------------------------------------------------------------------ §4.4 apply table, §5.2 refs and pins

  test("§4.4 apply table: intermediates created; set on a missing record is a no-op with a note; remove/unset of absent is a no-op; insert of an existing id is rejected by the sequencer", () => {
    const d0 = doc(["T"], [clip("X", "T", 0, 5)]);
    const notes: E.ApplyNote[] = [];
    const d = E.apply(E.fork(d0, S), [set(["timelineItems", "X", "colorGrade", "wheels", "lift", "r"], 0.1)], S, notes);
    assert.equal(it(d, "X").colorGrade.wheels.lift.r, 0.1);
    E.apply(d, [set(["timelineItems", "nope", "name"], "x")], S, notes);
    assert.equal(notes[0]!.lost, "missing");
    const before = snap(d);
    E.apply(
      d,
      [
        { op: "remove", path: ["timelineItems", "nope"] },
        { op: "unset", path: ["timelineItems", "X", "missingField"] },
      ],
      S,
    );
    assert.equal(snap(d), before);
    // port: `new E.Sequencer(doc, schema)` is `createLocalSequencer(doc, schema)`
    const sq = E.sequencer.createLocalSequencer(d0, S);
    const r = rejected(sq.push(toChange(S, sq, { id: "t.i", base: 0, ops: [{ op: "insert", path: ["timelineItems", "X"], value: clip("X", "T", 9, 10) }], baseDoc: d0 })));
    // port: v14 names this validation reject `exists` (the prototype's sequencer said `invalid` for every validation)
    assert.equal(r.reason, "exists");
    assert.ok(E.sync.VALIDATION_REASONS.has(r.reason));
    const bad = rejected(sq.push(toChange(S, sq, { id: "t.j", base: 0, ops: [set(["timelineItems", "X", "endTime"], -1)], baseDoc: d0 })));
    assert.equal(bad.reason, "invalid", "a hard-invariant break is rejected");
  });

  test("expired ref → error: released, expired, unknown-branch, legacy timestamp and tampered pins all throw 're-print'; nothing is applied", () => {
    const d0 = doc(["T"], [clip("X", "T", 0, 5)]);
    let now = 0;
    const r = History.create(S, d0, { clock: () => now });
    const b = r.current;
    const pend = [{ id: "p.1", ops: [set(["timelineItems", "X", "name"], "agent draft")] }];
    const pin = r.pin({ cutId: b, pending: pend, owner: "mcp", expires: 7 * 86400 });
    assert.equal(it(r.resolve(pin).doc, "X").name, "agent draft", "a live pin resolves");
    now = 7 * 86400 + 1;
    assert.throws(() => r.resolve(pin), /re-print \(pin expired\)/);
    now = 0;
    // port: release takes the owner releasing (a row goes when its last owner releases)
    r.release(pin, "mcp");
    assert.throws(() => r.resolve(pin), /re-print \(pin released/);
    assert.throws(() => r.resolve("1793382560192"), /re-print \(a 1.4.0 timestamp rev/);
    assert.throws(() => r.resolve({ branchId: "ffffffff", seq: 0, hash8: "00000000" }), /re-print \(unknown branch/);
    // a row under the right key whose rebuilt state does not match the stored full hash (a stateHash8 collision)
    // port: `r.pins` is `pinRow`, which returns a copy (pending ids, their ops as `delta`); the tampered row goes back
    // through `loadPin`, as a row read from the Store would
    const p2 = r.pin({ cutId: b, pending: pend, owner: "test" });
    const row = r.pinRow(b, 0, p2.hash8!)!;
    r.loadPin({ ...row, pending: ["p.2"], delta: [set(["timelineItems", "X", "name"], "other")] });
    assert.throws(() => r.resolve(p2), /re-print \(rebuilt state does not match the full stateHash\)/);
    const before = snap(r.stateOf(r.head(b))!);
    assert.throws(() => r.commit(b, { doc: setItem(d0, "X", { name: "z" }), base: p2, author: AGENT }), StateUnknown);
    assert.equal(snap(r.stateOf(r.head(b))!), before);
  });

  test("§5.2 pin rows are keyed (branchId, seq, stateHash8): two pending states at one seq resolve separately; the header string round-trips", () => {
    const d0 = doc(["T"], [clip("X", "T", 0, 5)]);
    const r = History.create(S, d0);
    const b = r.current;
    const a = r.pin({ cutId: b, pending: [{ id: "a.1", ops: [set(["timelineItems", "X", "name"], "A")] }], owner: "test" });
    const c = r.pin({ cutId: b, pending: [{ id: "c.1", ops: [set(["timelineItems", "X", "name"], "C")] }], owner: "test" });
    assert.notEqual(a.hash8, c.hash8);
    assert.equal(it(r.resolve(a).doc, "X").name, "A");
    assert.equal(it(r.resolve(c).doc, "X").name, "C");
    const hdr = r.refString(b, 0, r.hashOf(`${b}@0`)!);
    assert.match(hdr, /^main@0~[0-9a-f]{8} b:[0-9a-f]{8}$/);
    assert.equal(r.resolve(hdr).seq, 0);
  });

  // ------------------------------------------------------------------ text kind (line diff3)

  test("text kind: code-graphic source merges by line; overlapping line edits are a text card with the hunk", () => {
    const src = ["export default () => (", "  <div>", "    <h1>Title</h1>", "    <p>Body</p>", "  </div>", ");"];
    const mk = (lines: string[]) => withKeys({ name: "P", aspectRatio: "16:9", tracks: [], timelineItems: [], media: [{ id: "g", data: { type: "code", code: { source: lines.join("\n") } } }] });
    const b = mk(src);
    const o = mk(src.map((l, i) => (i === 2 ? "    <h1>Launch</h1>" : l)));
    const t = mk(src.map((l, i) => (i === 4 ? "  </section>" : l))); // a stable line (3) between the two edits
    const m = E.merge3(b, o, t, S);
    assert.deepEqual(m.conflicts, []);
    assert.equal((m.doc.media as Json[])[0].data.code.source, src.map((l, i) => (i === 2 ? "    <h1>Launch</h1>" : i === 4 ? "  </section>" : l)).join("\n"));
    const adj = E.merge3(b, o, mk(src.map((l, i) => (i === 3 ? "    <p>New body</p>" : l))), S);
    assert.equal(adj.conflicts.length, 1, "adjacent-line edits conflict, as in diff3 and git");
    const t2 = mk(src.map((l, i) => (i === 2 ? "    <h1>Summer</h1>" : l)));
    const c = E.merge3(b, o, t2, S);
    assert.equal(c.conflicts.length, 1);
    assert.equal(c.conflicts[0]!.kind, "text");
    assert.deepEqual(
      c.conflicts[0]!.hunks!.map((h) => [h.ours, h.theirs]),
      [["    <h1>Launch</h1>", "    <h1>Summer</h1>"]],
    );
  });

  // ------------------------------------------------------------------ sequences: M4, rebalancing (R3-04, R4-05)

  function fiTrial(place: "append" | "between", shape: "batch" | "one-by-one", seed: number) {
    const R = rng(seed);
    const id = (p: string) => `${p}-${Math.floor(R() * 2 ** 32).toString(16)}${Math.floor(R() * 2 ** 32).toString(16)}`;
    const fxA = { id: id("fxA"), type: "blur", amount: 1 },
      fxB = { id: id("fxB"), type: "glow", amount: 1 };
    const d0 = withKeys({ name: "P", aspectRatio: "16:9", tracks: [{ id: "T", name: "T", order: 0 }], timelineItems: [clip("X", "T", 0, 5, { effects: [fxA, fxB] })] });
    const rep = History.create(S, d0);
    const main = rep.current;
    const branches: Record<string, string> = { alice: rep.fork(rep.head(main), "alice"), bob: rep.fork(rep.head(main), "bob") };
    const run = (who: string, n: number) => {
      const b = branches[who]!;
      const author: Actor = { kind: "human", id: who };
      const mine = Array.from({ length: n }, () => ({ id: id(who), type: "sharpen", amount: 0.5 }));
      const insertAt = (list: Json[], k: number, els: Json[]) => (place === "append" ? [...list, ...els] : [...list.slice(0, k), ...els, ...list.slice(k)]);
      if (shape === "batch") {
        const cur = rep.stateOf(rep.head(b))!;
        const h = toHost(cur);
        h.timelineItems[0].effects = insertAt(h.timelineItems[0].effects, 1, mine);
        rep.commit(b, { doc: fromHost(h, cur, rep.own(author)), author });
      } else
        mine.forEach((el, k) => {
          const cur = rep.stateOf(rep.head(b))!;
          const h = toHost(cur);
          const list: Json[] = h.timelineItems[0].effects;
          const after = k === 0 ? (place === "append" ? list.length : 1) : list.findIndex((e) => e.id === mine[k - 1]!.id) + 1;
          h.timelineItems[0].effects = [...list.slice(0, after), el, ...list.slice(after)];
          rep.commit(b, { doc: fromHost(h, cur, rep.own(author)), author });
        });
      return mine.map((m) => m.id);
    };
    const A = run("alice", 3),
      B = run("bob", 2);
    rep.fold(main, rep.head(branches.alice!), { author: HUMAN });
    const res = rep.fold(main, rep.head(branches.bob!), { author: HUMAN });
    const fx: Json[] = it(rep.stateOf(rep.head(main)), "X").effects;
    const order = fx.map((e) => (A.includes(e.id) ? "A" : B.includes(e.id) ? "B" : "-")).join("");
    const contiguous = (c: string) => {
      const ix = [...order].flatMap((x, i) => (x === c ? [i] : []));
      return ix.at(-1)! - ix[0]! === ix.length - 1;
    };
    const sorted = fx.every((e, i) => i === 0 || fx[i - 1]["#pos"] < e["#pos"] || (fx[i - 1]["#pos"] === e["#pos"] && fx[i - 1].id < e.id));
    const placeOk = place === "append" ? order.startsWith("--") : order[0] === "-" && order.at(-1) === "-";
    return { interleaved: !(contiguous("A") && contiguous("B")), bad: !sorted || !placeOk, cards: res.status === "conflicts" ? res.cards.length : 0, order };
  }

  for (const shape of ["batch", "one-by-one"] as const)
    for (const place of ["append", "between"] as const)
      test(`fi-interleave M4, ${shape}, ${place === "append" ? "append after fxB" : "insert between fxA and fxB"}: 1,000 trials, 0 interleaved runs, 0 misplaced`, () => {
        let inter = 0,
          bad = 0,
          cards = 0;
        for (let t = 0; t < 1000; t++) {
          const r = fiTrial(place, shape, 7000 + t);
          inter += +r.interleaved;
          bad += +r.bad;
          cards += r.cards;
        }
        assert.deepEqual({ inter, bad, cards }, { inter: 0, bad: 0, cards: 0 });
      });

  test("M4 key length: 100 one-by-one appends by one author grow keys 1 char each; the commit that passes 64 rebalances; every key stays ≤ 64", () => {
    const d0 = withKeys({ name: "P", aspectRatio: "16:9", tracks: [{ id: "T", name: "T", order: 0 }], timelineItems: [clip("X", "T", 0, 5, { effects: [{ id: "fxA", type: "blur" }, { id: "fxB", type: "glow" }] })] });
    const rep = History.create(S, d0);
    const b = rep.current;
    const lens: number[] = [];
    let rebalances = 0;
    for (let k = 0; k < 100; k++) {
      const cur = rep.stateOf(rep.head(b))!;
      const h = toHost(cur);
      h.timelineItems[0].effects.push({ id: `e${k}`, type: "sharpen" });
      const res = confirmed(rep.commit(b, { doc: fromHost(h, cur, rep.own(HUMAN)), author: HUMAN }));
      const rb = res.change!.ops.some(isRk);
      if (rb) rebalances++;
      const fx: Json[] = it(rep.stateOf(rep.head(b)), "X").effects;
      lens.push(fx.find((e) => e.id === `e${k}`)["#pos"].length);
      assert.ok(fx.every((e) => e["#pos"].length <= E.MAX_KEY));
      // every append grows the key by exactly 1 char, except the one commit whose key would pass 64: it rebalances
      if (k > 0 && !rb) assert.equal(lens[k]! - lens[k - 1]!, 1, `append ${k}: +1 char`);
      if (k > 0 && rb) assert.ok(lens[k - 1]! + 1 > E.MAX_KEY, `the rebalance at append ${k} is the commit that would pass ${E.MAX_KEY}`);
    }
    assert.ok(rebalances >= 1, `rebalances ${rebalances}`);
    console.log(`  # M4 key lengths at the 1st, 10th, 100th append: ${lens[0]}, ${lens[9]}, ${lens[99]}; rebalances: ${rebalances}`);
    assert.deepEqual(
      (toHost(rep.stateOf(rep.head(b))!).timelineItems[0].effects as Json[]).map((e) => e.id),
      ["fxA", "fxB", ...Array.from({ length: 100 }, (_, k) => `e${k}`)],
    );
  });

  // neighbours whose keys differ only at depth 63: any insert between them passes 64 characters
  function tightSeq(): Doc {
    const L = "V".repeat(62) + "1",
      R = "V".repeat(62) + "2";
    const fx = [
      { id: "p", type: "blur", "#pos": "1" },
      { id: "L", type: "glow", "#pos": L },
      { id: "R", type: "sharpen", "#pos": R },
      { id: "q", type: "vignette", "#pos": "z" },
    ];
    return { name: "P", aspectRatio: "16:9", tracks: [{ id: "T", name: "T", "#pos": "V" }], timelineItems: [clip("X", "T", 0, 5, { effects: fx })] };
  }
  const insertBetween = (cur: Doc, id: string) => {
    const h = toHost(cur);
    const fx: Json[] = h.timelineItems[0].effects;
    fx.splice(fx.findIndex((e) => e.id === "L") + 1, 0, { id, type: "new" });
    return fromHost(h, cur, () => false);
  };

  test("R4-05 concurrent rebalances: both inserts crossed 64 chars; the later one's rebalance is dropped on rebase, no card, order kept, keys ≤ 64", () => {
    const d0 = tightSeq();
    const rep = History.create(S, d0);
    const b = rep.current,
      base = rep.ref(b);
    const xa = insertBetween(d0, "A1"),
      xb = insertBetween(d0, "B1");
    assert.ok(E.diff(d0, xa, S).some(isRk) && E.diff(d0, xb, S).some(isRk), "each change rebalances (its insert passed 64)");
    assert.equal(rep.commit(b, { doc: xa, author: HUMAN, base }).status, "confirmed");
    const res = rep.commit(b, { doc: xb, author: BOB, base });
    assert.equal(res.status, "confirmed");
    assert.ok(res.rebased >= 1);
    assert.equal(res.change!.ops.filter(isRk).length, 0, "the second rebalance was dropped (no key over the limit any more)");
    const fx: Json[] = it(rep.stateOf(rep.head(b)), "X").effects;
    assert.deepEqual(
      fx.map((e) => e.id).filter((x) => x !== "A1" && x !== "B1"),
      ["p", "L", "R", "q"],
    );
    const at = (x: string) => fx.findIndex((e) => e.id === x);
    assert.ok(at("L") < at("A1") && at("A1") < at("R") && at("L") < at("B1") && at("B1") < at("R"));
    assert.ok(fx.every((e) => e["#pos"].length <= E.MAX_KEY));
    // and as a symmetric state merge: no card, same result either way round
    const m1 = E.merge3(d0, xa, xb, S),
      m2 = E.merge3(d0, xb, xa, S);
    assert.deepEqual([m1.conflicts.length, m2.conflicts.length], [0, 0]);
    assert.equal(snap(m1.doc), snap(m2.doc));
  });

  test("R4-05 an insert made across a rebalance is re-keyed from its neighbour ids on rebase", () => {
    const d0 = tightSeq();
    const rep = History.create(S, d0);
    const b = rep.current,
      base = rep.ref(b);
    rep.commit(b, { doc: insertBetween(d0, "A1"), author: HUMAN, base }); // rebalances everything
    const h = toHost(d0);
    h.timelineItems[0].effects.splice(0, 0, { id: "Z", type: "first" }); // stale: keyed against old keys, before p
    const res = rep.commit(b, { doc: fromHost(h, d0), author: BOB, base });
    assert.equal(res.status, "confirmed");
    assert.ok(res.rebased >= 1, "its neighbour p's key was rewritten: rejected (read of p/#pos), then rebased");
    assert.deepEqual(
      (it(rep.stateOf(rep.head(b)), "X").effects as Json[]).map((e) => e.id),
      ["Z", "p", "L", "A1", "R", "q"],
    );
  });

  // ------------------------------------------------------------------ §6.1 rule details

  test("§6.1 overlap rule: spans on different tracks or disjoint ranges commute; a lane change spans both tracks; #trackOrder moves of one track overlap", () => {
    const d0 = doc(["V", "W"], [clip("a", "V", 0, 5), clip("b", "V", 10, 15), clip("w", "W", 0, 5)]);
    const D = (d: Doc, intent?: Intent) => E.declare(S, d0, E.diff(d0, d, S), intent);
    const ov = (x: E.Declaration, y: E.Declaration) => Object.keys(E.sequencer.overlap(x, y));
    assert.deepEqual(ov(D(setItem(d0, "a", { endTime: 4, trimEnd: 4 })), D(setItem(d0, "b", { startTime: 11, endTime: 16 }))), [], "disjoint ranges on V");
    // port: the contract's rule is v11's (PLAN v14 §6.1): intersecting spans meet only when one change is structural, so
    // the prototype's case (two plain timing edits, ["span"] in v5) now commutes; a structural one (an insert) meets them
    assert.deepEqual(ov(D(setItem(d0, "a", { endTime: 12, trimEnd: 12 })), D(setItem(d0, "b", { startTime: 11, endTime: 16 }))), [], "two plain timing edits never overlap by span alone");
    assert.deepEqual(ov(D(setItem(d0, "a", { endTime: 12, trimEnd: 12 })), D(addItem(d0, clip("n", "V", 11, 12)))), ["span"]);
    assert.deepEqual(ov(D(addItem(d0, clip("n", "V", 6, 9))), D(setItem(d0, "b", { startTime: 11, endTime: 16 }))), [], "disjoint ranges on V, one side structural");
    assert.deepEqual(ov(D(addItem(d0, clip("n", "W", 6, 9))), D(setItem(d0, "b", { startTime: 5, endTime: 16 }))), [], "different tracks, one side structural");
    assert.deepEqual(ov(D(setItem(d0, "w", { trackId: "V" })), D(setItem(d0, "a", { endTime: 4.5, trimEnd: 4.5 }))), ["span"], "lane change spans V too");
    const rp = ripple(d0, "V", 0, 5);
    assert.deepEqual(ov(D(addItem(d0, clip("n", "W", 30, 31))), D(rp.doc, rp.intent)), [], "a remap on V does not touch W");
    const d4 = doc(["V", "W", "X", "Y"], []);
    const mv = (d: Doc, id: string, ord: number) => H(d, (h) => (h.tracks.find((t: Json) => t.id === id).order = ord));
    const D4 = (d: Doc) => E.declare(S, d4, E.diff(d4, d, S));
    assert.deepEqual(D4(mv(d4, "V", 9)).trackOrder, ["V"]);
    assert.ok(ov(D4(mv(d4, "V", 9)), D4(mv(d4, "V", 2.5))).includes("order"), "both moved V");
    assert.ok(!ov(D4(mv(d4, "V", 9)), D4(mv(d4, "Y", -1))).includes("order"), "different tracks moved");
  });

  // ------------------------------------------------------------------ R4-02 view-save base (§6.4)

  // R4-02. rule "v5": the base of a save is the pinned state of the last applied save of that view;
  // rule "v4": every save rebases from the header ref (applied through the same commit/rebase path).
  function saveWith(r: History, rule: "v4" | "v5", name: string, header: string, d: Doc, author: Actor) {
    return rule === "v5" ? r.saveView(name, header, d, { author }) : r.commit(r.current, { doc: d, base: header, author });
  }
  function r402case1(rule: "v4" | "v5") {
    const d0 = doc(["V"], [clip("X", "V", 10, 20), clip("Y", "V", 30, 40)]);
    const r = History.create(S, d0);
    const b = r.current;
    const { header, doc: view } = r.printView(b, "agent-1");
    r.commit(b, { doc: setItem(r.stateOf(r.head(b))!, "X", { startTime: 12, endTime: 22 }), author: HUMAN, kinds: { X: { move: 2 } } });
    const F1 = setItem(view, "X", { endTime: 19, trimEnd: 9 });
    const s1 = saveWith(r, rule, "agent-1", header, F1, AGENT);
    const afterS1 = it(r.stateOf(r.head(b)), "X");
    r.commit(b, { doc: setItem(r.stateOf(r.head(b))!, "X", { endTime: 20.5, trimEnd: 8.5 }), author: HUMAN }); // the non-agent change
    const s2 = saveWith(r, rule, "agent-1", header, setItem(F1, "Y", { name: "agent's second edit" }), AGENT);
    return { r, b, s1, s2, afterS1, h: r.stateOf(r.head(b)) };
  }

  test("R4-02 case 1 (algebra): agent trim-out, human drag and trim between saves, agent's second save edits another clip → no spurious card; the v4 header base through the same commit path gives the card", () => {
    const v5 = r402case1("v5");
    assert.equal(v5.s1.status, "confirmed");
    assert.deepEqual([v5.afterS1.startTime, v5.afterS1.endTime], [12, 21], "move ∘ trim-out");
    assert.equal(v5.s2.status, "confirmed", "no card");
    const x = it(v5.h, "X");
    assert.deepEqual([x.startTime, x.endTime, x.trimEnd, it(v5.h, "Y").name], [12, 20.5, 8.5, "agent's second edit"]);
    const v4 = r402case1("v4");
    assert.equal(v4.s2.status, "conflicts", "control: the header base re-merges the earlier trim-out (−1 vs −1.5)");
    assert.equal(v4.s2.cards[0]!.path, "timelineItems/X/#time");
  });

  function r402case2(nudge: boolean, rule: "v4" | "v5" = "v5") {
    const d0 = doc(["V"], [clip("a", "V", 0, 30), clip("c", "V", 40, 45), clip("d", "V", 60, 65)]);
    const r = History.create(S, d0);
    const b = r.current;
    const { header, doc: view } = r.printView(b, "agent-1");
    r.commit(b, { doc: addItem(r.stateOf(r.head(b))!, clip("h", "V", 50, 52)), author: HUMAN });
    const F1 = setItem(setItem(view, "c", { startTime: 35, endTime: 40 }), "d", { startTime: 55, endTime: 60 }); // delete 5 s of the 30..40 gap (unrecorded)
    const s1 = saveWith(r, rule, "agent-1", header, F1, AGENT);
    // the non-agent change(s) between the agent's saves
    r.commit(b, { doc: addItem(r.stateOf(r.head(b))!, clip("k", "V", 70, 72)), author: HUMAN });
    if (nudge) r.commit(b, { doc: setItem(r.stateOf(r.head(b))!, "d", { startTime: 56, endTime: 61 }), author: HUMAN });
    const F2 = setItem(F1, "a", { name: "agent's second edit" });
    const bare = E.merge3(r.resolve(header).doc, r.stateOf(r.head(b))!, F2, S); // a bare state merge on the header base
    const s2 = saveWith(r, rule, "agent-1", header, F2, AGENT);
    return { s1, s2, h: r.stateOf(r.head(b)), bare };
  }

  test("R4-02 case 2 (remap): agent deletes a gap, human inserts h at 50 (→ 45), then inserts k between the saves; the second save leaves h at 45 (and so does the v4 rule: the recorded inferred ripples dedupe)", () => {
    const { s1, s2, h } = r402case2(false);
    assert.equal(s1.status, "confirmed");
    assert.ok(s1.rebased >= 1, "the inferred ripple declared [35, ∞) on V, so the save was rebased over h");
    assert.equal(s2.status, "confirmed", "no card");
    assert.deepEqual([it(h, "h").startTime, it(h, "k").startTime, it(h, "c").startTime, it(h, "a").name], [45, 70, 35, "agent's second edit"]);
    const v4 = r402case2(false, "v4");
    assert.equal(v4.s2.status, "confirmed");
    assert.equal(it(v4.h, "h").startTime, 45, "with the header base too: save 1's ripple is recorded on its change and identical deletions count once");
  });

  test("R4-02 case 2b (remap, sensitivity): plus a human nudge of d between the saves; v5 base: h stays 45; a bare state merge on the header base (no recorded remaps) maps h again or raises a card, while the commit path still gives 45", () => {
    const { s2, h, bare } = r402case2(true);
    assert.equal(s2.status, "confirmed", "no card");
    assert.deepEqual([it(h, "h").startTime, it(h, "d").startTime, it(h, "a").name], [45, 56, "agent's second edit"]);
    assert.ok(bare.conflicts.length > 0 || it(bare.doc, "h").startTime !== 45, `a bare merge3 on the header base: cards ${bare.conflicts.length}, h at ${it(bare.doc, "h").startTime}`);
    const v4 = r402case2(true, "v4");
    assert.deepEqual([v4.s2.status, it(v4.h, "h").startTime], ["confirmed", 45], "through commit/rebase the recorded ripples protect h even with the v4 base");
  });

  test("§6.4 a re-print resets the view base to the new header: the human's later edit of a field the agent saw only in the re-print is kept, no card", () => {
    const d0 = doc(["V"], [clip("X", "V", 10, 20), clip("Y", "V", 30, 40)]);
    const r = History.create(S, d0);
    const b = r.current;
    const v1 = r.printView(b, "agent-1");
    assert.equal(r.saveView("agent-1", v1.header, setItem(v1.doc, "X", { opacity: 0.5 }), { author: AGENT }).status, "confirmed");
    r.commit(b, { doc: setItem(r.stateOf(r.head(b))!, "Y", { name: "b" }), author: HUMAN });
    const v2 = r.printView(b, "agent-1"); // the re-print shows Y.name = "b"
    assert.notEqual(v2.header, v1.header);
    r.commit(b, { doc: setItem(r.stateOf(r.head(b))!, "Y", { name: "c" }), author: HUMAN });
    // the agent edits X only; its file still says Y.name = "b". With the old save's state as base (Y.name "Y"),
    // that would read as the agent setting Y.name to "b", against the human's "c": a spurious card.
    const res = r.saveView("agent-1", v2.header, setItem(v2.doc, "X", { opacity: 0.7 }), { author: AGENT });
    assert.equal(res.status, "confirmed", "no card");
    assert.deepEqual([it(r.stateOf(r.head(b)), "Y").name, it(r.stateOf(r.head(b)), "X").opacity], ["c", 0.7]);
  });

  // ------------------------------------------------------------------ §5.3 DAG, branches, partial accept

  test("§5.3 branch ids: two replicas' branches both named 'main' have different ids; tracking branches are read-only", () => {
    const d0 = doc(["V"], [clip("X", "V", 0, 5)]);
    const a = History.create(S, d0, { name: "alice" });
    const pkg = ship(a.exportFull());
    const b = History.create(S, d0, { name: "bob" });
    // port: r.branches.get(id) is r.cut(id)
    assert.equal(a.cut(a.current)!.name, b.cut(b.current)!.name);
    assert.notEqual(a.current, b.current);
    b.importFull(pkg);
    assert.throws(() => b.commit(a.current, { doc: setItem(d0, "X", { name: "z" }), author: BOB }), /read-only/);
  });

  test("§5.3 criss-cross merges get a recursive virtual base: no phantom cards, both sides' edits kept", () => {
    const d0 = withKeys({ name: "P", aspectRatio: "16:9", tracks: [{ id: "V", name: "V", order: 0 }], timelineItems: [clip("a", "V", 0, 5), clip("b", "V", 5, 9), clip("c", "V", 9, 12)] });
    const r = History.create(S, d0);
    const A = r.current,
      B = r.fork(r.head(A), "B");
    r.commit(A, { doc: setItem(d0, "a", { name: "A1" }), author: HUMAN });
    r.commit(B, { doc: setItem(d0, "b", { name: "B1" }), author: BOB });
    const a1 = r.head(A),
      b1 = r.head(B);
    r.fold(A, b1, { author: HUMAN });
    r.fold(B, a1, { author: BOB });
    r.commit(A, { doc: setItem(r.stateOf(r.head(A))!, "c", { name: "A2" }), author: HUMAN });
    r.commit(B, { doc: setItem(r.stateOf(r.head(B))!, "a", { opacity: 0.5 }), author: BOB });
    assert.equal(r.lca(r.head(A), r.head(B)).length, 2, "two lowest common ancestors");
    const res = r.fold(A, r.head(B), { author: HUMAN });
    assert.equal(res.status, "confirmed");
    assert.ok(baseOf(res).virtual);
    const h = r.stateOf(r.head(A));
    assert.deepEqual([it(h, "a").name, it(h, "a").opacity, it(h, "b").name, it(h, "c").name], ["A1", 0.5, "B1", "A2"]);
  });

  test("§5.3 partial accept: a full merge plus an inverse change listing the rejected parts; a later merge doesn't re-raise them; 'accept the rest' brings them in", () => {
    const d0 = doc(["V"], [clip("A", "V", 0, 5), clip("B", "V", 5, 9, { textContent: "old" }), clip("C", "V", 9, 15), clip("D", "V", 15, 20)]);
    const r = History.create(S, d0);
    const main = r.current,
      v = r.fork(r.head(main), "review");
    let x = setItem(d0, "A", { colorGrade: { saturation: 1.4 } });
    x = setItem(x, "B", { textContent: "agent's new text" });
    x = setItem(x, "C", { endTime: 14, trimEnd: 5 });
    r.commit(v, { doc: x, author: AGENT });
    // port: partialAccept is foldSome
    const pa = r.foldSome(main, r.head(v), { reject: ["timelineItems/B"], author: HUMAN });
    assert.equal(pa.status, "confirmed");
    let h = r.stateOf(r.head(main));
    assert.deepEqual([it(h, "A").colorGrade.saturation, it(h, "B").textContent, it(h, "C").endTime], [1.4, "old", 14]);
    const inv = r.changes(main).at(-1)!;
    assert.deepEqual([inv.kind, inv.rejected], ["partial-revert", ["timelineItems/B"]]);
    r.commit(v, { doc: setItem(r.stateOf(r.head(v))!, "D", { name: "later" }), author: AGENT });
    const again = r.fold(main, r.head(v), { author: HUMAN });
    assert.equal(again.status, "confirmed", "no card");
    h = r.stateOf(r.head(main));
    assert.deepEqual([it(h, "D").name, it(h, "B").textContent], ["later", "old"], "the rejected part stays rejected");
    assert.equal(r.acceptRest(main, inv.id, { author: HUMAN }).status, "confirmed");
    assert.equal(it(r.stateOf(r.head(main)), "B").textContent, "agent's new text");
  });

  // ------------------------------------------------------------------ §7 remap intents

  // Voice track V and captions C; remove-silences removes [5,7) and [20,23) from both, splitting v2.
  function silencesFixture() {
    const d0 = doc(["V", "C"], [clip("v1", "V", 0, 5), clip("v2", "V", 7, 20, { colorGrade: { saturation: 1 } }), clip("v3", "V", 23, 30), clip("v4", "V", 30, 40), { id: "c1", trackId: "C", type: "caption", startTime: 1, endTime: 4, trimStart: 0, trimEnd: 3, captionText: "hello" }, { id: "c2", trackId: "C", type: "caption", startTime: 24, endTime: 28, trimStart: 0, trimEnd: 4, captionText: "world" }]);
    // v2 [7, 20) gets split at 12 by the action into v2 [7,12) and v2b [12,20) (lineage), then shifted by −2
    let after = setItem(d0, "v2", { startTime: 5, endTime: 10, trimEnd: 5 });
    after = addItem(after, clip("v2b", "V", 10, 18, { trimStart: 5, trimEnd: 13, colorGrade: { saturation: 1 } }));
    after = setItem(setItem(after, "v3", { startTime: 18, endTime: 25 }), "v4", { startTime: 25, endTime: 35 });
    after = setItem(after, "c2", { startTime: 19, endTime: 23 });
    const ranges: [number, number][] = [
      [5, 7],
      [20, 23],
    ];
    // port: a split's lineage lists the pieces' ids (`Lineage`: old id -> string[]), not `{id}` objects
    const intent: { maps: RemapMaps; lineage: Lineage } = { maps: { V: [E.step(ranges)], C: [E.step(ranges)] }, lineage: { v2: ["v2", "v2b"] } };
    return { d0, after, intent };
  }

  test("§7 remove-silences vs a later trim: the trimmed clip is shifted and keeps the trim", () => {
    const { d0, after, intent } = silencesFixture();
    const human = setItem(d0, "v4", { endTime: 39, trimEnd: 9 });
    const m = E.merge3(d0, after, human, S, { remaps: { ours: intent } });
    assert.deepEqual(m.conflicts, []);
    const v4 = it(m.doc, "v4");
    assert.deepEqual([v4.startTime, v4.endTime, v4.trimEnd], [25, 34, 9]);
  });

  test("§7 remove-silences vs a caption edit: the text is kept and the caption follows the map", () => {
    const { d0, after, intent } = silencesFixture();
    const human = setItem(d0, "c2", { captionText: "world, fixed" });
    const m = E.merge3(d0, after, human, S, { remaps: { ours: intent } });
    assert.deepEqual(m.conflicts, []);
    assert.deepEqual([it(m.doc, "c2").captionText, it(m.doc, "c2").startTime, it(m.doc, "c2").endTime], ["world, fixed", 19, 23]);
  });

  test("§7 remove-silences vs an insert: an insert after the silences is mapped; one inside a removed range is a card", () => {
    const { d0, after, intent } = silencesFixture();
    const m = E.merge3(d0, after, addItem(d0, clip("h", "V", 41, 44)), S, { remaps: { ours: intent } });
    assert.deepEqual(m.conflicts, []);
    assert.deepEqual([it(m.doc, "h").startTime, it(m.doc, "h").endTime], [36, 39]);
    const bad = E.merge3(d0, after, addItem(d0, clip("h", "C", 20.5, 22)), S, { remaps: { ours: intent } });
    assert.equal(bad.conflicts.length, 1);
    assert.equal(bad.conflicts[0]!.kind, "remap");
  });

  test("§7 lineage: a grade edit on a clip the other side split follows to every piece; a retime of the split clip is a card", () => {
    const { d0, after, intent } = silencesFixture();
    const m = E.merge3(d0, after, setItem(d0, "v2", { colorGrade: { saturation: 1.5 } }), S, { remaps: { ours: intent } });
    assert.deepEqual(m.conflicts, []);
    assert.deepEqual([it(m.doc, "v2").colorGrade.saturation, it(m.doc, "v2b").colorGrade.saturation], [1.5, 1.5]);
    const t = E.merge3(d0, after, setItem(d0, "v2", { endTime: 19, trimEnd: 12 }), S, { remaps: { ours: intent } });
    assert.equal(t.conflicts.length, 1);
    assert.deepEqual([t.conflicts[0]!.kind, t.conflicts[0]!.path, t.conflicts[0]!.reason], ["group", "timelineItems/v2/#time", "a remap and a retime of the same clip"]);
  });

  test("§7 inference only when unambiguous: one clip moved left by its gap is a move, not a remap; two shifted clips after a deleted one are", () => {
    const d0 = doc(["V"], [clip("a", "V", 0, 5), clip("b", "V", 8, 10), clip("c", "V", 10, 12)]);
    const one = setItem(d0, "c", { startTime: 6, endTime: 8 });
    const e1 = E.diff(d0, one, S).map((op) => ({ path: op.path, op }));
    assert.deepEqual(E.inferRemaps(S, d0, e1), {}, "a single moved clip with no explanation");
    const rp = ripple(d0, "V", 5, 3);
    const e2 = E.diff(d0, rp.doc, S).map((op) => ({ path: op.path, op }));
    assert.deepEqual(E.inferRemaps(S, d0, e2), { V: [{ d: [[5, 8]], i: [] }] });
  });

  // ------------------------------------------------------------------ §13 shallow .cbproj exchanges

  type Carry = "fork-merge-export" | "export-only" | "head-only";
  // Alice main@20 → Bob; Bob@30 (title Winter) → Carol; Bob@35 (title back, new music) → Alice; Carol@40 → Alice.
  function diamond({ carry = "fork-merge-export" }: { carry?: Carry } = {}) {
    const d0 = doc(["V", "M"], [clip("music", "M", 0, 60, { type: "audio", mediaItemId: "track1" }), clip("outro", "V", 50, 60, { type: "text", textContent: "v1" }), clip("tmp", "V", 0, 5)], { name: "Summer" });
    const alice = History.create(S, d0, { name: "alice" }),
      bob = new History(S, { name: "bob" }),
      carol = new History(S, { name: "carol" });
    const A = alice.current;
    bob.importShallow(ship(alice.exportShallow(A, { to: "bob", carry })));
    const B = bob.current;
    bob.commit(B, { doc: { ...bob.stateOf(bob.head(B))!, name: "Winter" }, author: BOB });
    carol.importShallow(ship(bob.exportShallow(B, { to: "carol", carry })));
    const C = carol.current;
    let b35: Doc = { ...bob.stateOf(bob.head(B))!, name: "Summer" };
    b35 = dropItem(setItem(b35, "music", { mediaItemId: "track2" }), "tmp");
    bob.commit(B, { doc: b35, author: BOB });
    const imp = alice.importShallow(ship(bob.exportShallow(B, { to: "alice", carry })));
    const first = alice.fold(A, importedHead(imp), { author: HUMAN });
    alice.commit(A, { doc: setItem(alice.stateOf(alice.head(A))!, "outro", { textContent: "v2" }), author: HUMAN });
    carol.commit(C, { doc: addItem(carol.stateOf(carol.head(C))!, clip("credits", "V", 60, 65, { type: "text", textContent: "Credits: Carol" })), author: { kind: "human", id: "carol" } });
    const imp2 = alice.importShallow(ship(carol.exportShallow(C, { to: "alice", carry })));
    return { alice, bob, carol, A, B, C, first, carolHead: importedHead(imp2) };
  }

  test("R4-01 diamond: Carol's copy merges on Bob@30 (a carried export-node state) → title 'Summer', 0 cards, the deleted temp clip stays deleted", () => {
    const { alice, A, B, first, carolHead } = diamond();
    assert.equal(first.status, "confirmed");
    const res = alice.fold(A, carolHead, { author: HUMAN });
    assert.equal(res.status, "confirmed", "0 cards");
    assert.equal(baseOf(res).node, `${B}@1`, "the LCA is Bob's export node Bob@30");
    const h = alice.stateOf(alice.head(A))!;
    assert.deepEqual([h.name, it(h, "music").mediaItemId, it(h, "outro").textContent, it(h, "credits").textContent, it(h, "tmp")], ["Summer", "track2", "v2", "Credits: Carol", undefined]);
  });

  test("missing LCA state → the explicit dialog, never an older base; 'bring it in with every difference as a card' is a 2-way compare", () => {
    const { alice, A, carolHead } = diamond({ carry: "head-only" });
    const before = alice.head(A);
    const res = alice.fold(A, carolHead, { author: HUMAN });
    assert.equal(res.status, "missing-base");
    assert.match(res.dialog.text, /This copy builds on a version from bob that you don't have\. Ask bob for their copy, or bring it in with every difference shown as a card\./);
    assert.equal(alice.head(A), before, "nothing merged against an older base");
    const cmp = alice.fold(A, carolHead, { author: HUMAN, missingBase: "all-cards" });
    assert.equal(cmp.status, "compare");
    const paths = cmp.cards.map((c) => c.path).sort();
    assert.deepEqual(paths, ["name", "timelineItems/credits", "timelineItems/music", "timelineItems/outro", "timelineItems/tmp"], "every difference is a card");
  });

  test("missing LCA, every difference decided: an all-cards fold commits as a recorded merge, so the next fold is up to date (ui review c)", () => {
    const { alice, A, carolHead } = diamond({ carry: "head-only" });
    const cmp = alice.fold(A, carolHead, { author: HUMAN, missingBase: "all-cards" });
    assert.equal(cmp.status, "compare");
    const cards = cmp.status === "compare" ? cmp.cards : [];
    const partial = alice.fold(A, carolHead, { author: HUMAN, missingBase: "all-cards", choices: { [cards[0]!.path]: "theirs" } });
    assert.equal(partial.status, "compare", "a difference left undecided commits nothing");
    const r = alice.fold(A, carolHead, { author: HUMAN, missingBase: "all-cards", choices: Object.fromEntries(cards.map((c) => [c.path, "theirs"])) });
    assert.equal(r.status, "confirmed");
    assert.deepEqual(alice.changes(A).at(-1)!.mergeOf, { branchId: carolHead.slice(0, carolHead.lastIndexOf("@")), seq: Number(carolHead.slice(carolHead.lastIndexOf("@") + 1)) });
    assert.equal(alice.fold(A, carolHead, { author: HUMAN }).status, "up-to-date", "the merge is recorded: no missing base the second time");
  });

  test(".cbproj Alice → Bob → Alice twice, then a third merge: each LCA is the last exchanged node and nothing is reverted", () => {
    const d0 = doc(
      ["V"],
      ["a", "b", "c", "d"].map((x, i) => clip(x, "V", i * 5, i * 5 + 4)),
    );
    const alice = History.create(S, d0, { name: "alice" }),
      bob = new History(S, { name: "bob" });
    const A = alice.current;
    const edit = (r: History, br: string, id: string, patch: Json, who: Actor) => r.commit(br, { doc: setItem(r.stateOf(r.head(br))!, id, patch), author: who });
    edit(alice, A, "a", { name: "A1" }, HUMAN);
    const e1 = alice.head(A);
    bob.importShallow(ship(alice.exportShallow(A, { to: "bob" })));
    const B = bob.current;
    edit(bob, B, "b", { name: "B1" }, BOB);
    edit(alice, A, "c", { name: "A2" }, HUMAN);
    const r1 = alice.fold(A, importedHead(alice.importShallow(ship(bob.exportShallow(B, { to: "alice" })))), { author: HUMAN });
    assert.equal(baseOf(r1).node, e1);
    edit(alice, A, "a", { name: "A3" }, HUMAN);
    const e2 = alice.head(A);
    const b2 = bob.importShallow(ship(alice.exportShallow(A, { to: "bob" })));
    const r2 = bob.fold(B, importedHead(b2), { author: BOB });
    assert.equal(r2.status, "confirmed");
    assert.equal(baseOf(r2).node, `${B}@1`, "Bob's export node");
    edit(bob, B, "d", { name: "B2" }, BOB);
    edit(alice, A, "b", { opacity: 0.5 }, HUMAN);
    const r3 = alice.fold(A, importedHead(alice.importShallow(ship(bob.exportShallow(B, { to: "alice" })))), { author: HUMAN });
    assert.equal(r3.status, "confirmed");
    assert.equal(baseOf(r3).node, e2, "third merge: Alice's second export node");
    const h = alice.stateOf(alice.head(A));
    assert.deepEqual(
      ["a", "b", "c", "d"].map((x) => it(h, x).name),
      ["A3", "B1", "A2", "B2"],
    );
    assert.equal(it(h, "b").opacity, 0.5);
  });

  test(".cbproj Alice → Bob → Carol → Alice: merges on Alice's own export node, all edits, 0 cards", () => {
    const d0 = doc(
      ["V"],
      ["a", "b", "c"].map((x, i) => clip(x, "V", i * 5, i * 5 + 4)),
      { name: "T" },
    );
    const alice = History.create(S, d0, { name: "alice" }),
      bob = new History(S, { name: "bob" }),
      carol = new History(S, { name: "carol" });
    const A = alice.current;
    const sent = alice.head(A);
    bob.importShallow(ship(alice.exportShallow(A, { to: "bob" })));
    bob.commit(bob.current, { doc: { ...bob.stateOf(bob.head(bob.current))!, name: "Winter" }, author: BOB });
    carol.importShallow(ship(bob.exportShallow(bob.current, { to: "carol" })));
    carol.commit(carol.current, { doc: setItem(carol.stateOf(carol.head(carol.current))!, "b", { name: "credits" }), author: BOB });
    alice.commit(A, { doc: setItem(d0, "c", { opacity: 0.3 }), author: HUMAN });
    const res = alice.fold(A, importedHead(alice.importShallow(ship(carol.exportShallow(carol.current, { to: "alice" })))), { author: HUMAN });
    assert.equal(res.status, "confirmed");
    assert.equal(baseOf(res).node, sent);
    const h = alice.stateOf(alice.head(A))!;
    assert.deepEqual([h.name, it(h, "b").name, it(h, "c").opacity], ["Winter", "credits", 0.3]);
  });

  test("shallow export carries no history and no local tables: no scrapped titles, no change log, no path map, pins or notices; last authors per record are carried", () => {
    const d0 = doc(["V"], [clip("a", "V", 0, 5)]);
    const r = History.create(S, d0, { name: "alice" });
    const b = r.current;
    r.local.pathMap["m1"] = "/Users/alice/Footage/secret-interview.mov";
    // port: a Notice has a kind
    r.local.notices.push({ to: "agent", kind: "other-changes", text: "NOTICE-TEXT" });
    r.commit(b, { doc: addItem(d0, clip("draft", "V", 6, 8, { type: "text", textContent: "SCRAPPED-DRAFT-TITLE" })), author: AGENT });
    r.commit(b, { doc: dropItem(r.stateOf(r.head(b))!, "draft"), author: HUMAN });
    r.commit(b, { doc: setItem(r.stateOf(r.head(b))!, "a", { name: "kept" }), author: AGENT });
    r.pin({ cutId: b, pending: [], owner: "mcp" });
    const pkg = r.exportShallow(b, { to: "bob" });
    const bytes = JSON.stringify(pkg);
    for (const s of ["SCRAPPED-DRAFT-TITLE", "/Users/alice", "NOTICE-TEXT", '"log"', '"pins"', '"ops"', '"pathMap"']) assert.ok(!bytes.includes(s), `no ${s}`);
    assert.equal(pkg.nodes.length, 2, "head and root only");
    assert.deepEqual(pkg.lastAuthor["timelineItems/a"], AGENT, "per-record last author");
    const full = JSON.stringify(r.exportFull());
    assert.ok(full.includes("SCRAPPED-DRAFT-TITLE"), "the full-history export (opt-in) does carry history");
    for (const s of ["/Users/alice", "NOTICE-TEXT", '"pins"']) assert.ok(!full.includes(s), `full history still drops local table ${s}`);
  });

  test("R5-01 remaps per lineage edge: Carol → Alice twice with a ripple in each copy; Alice's h goes 50 → 45 → 42 (R2∘R1 would give 37)", () => {
    const d0 = doc(["V1"], [clip("a", "V1", 0, 10), clip("y", "V1", 10, 13), clip("b", "V1", 13, 35), clip("x", "V1", 35, 40), clip("c", "V1", 40, 48)]);
    const alice = History.create(S, d0, { name: "alice" }),
      carol = new History(S, { name: "carol" });
    const A = alice.current;
    carol.importShallow(ship(alice.exportShallow(A, { to: "carol" })));
    const C = carol.current;
    alice.commit(A, { doc: addItem(d0, clip("h", "V1", 50, 52)), author: HUMAN });
    const R1 = ripple(carol.stateOf(carol.head(C))!, "V1", 35, 5);
    carol.commit(C, { doc: R1.doc, intent: R1.intent, author: { kind: "human", id: "carol" } });
    const m1 = alice.fold(A, importedHead(alice.importShallow(ship(carol.exportShallow(C, { to: "alice" })))), { author: HUMAN });
    assert.equal(m1.status, "confirmed");
    assert.equal(it(alice.stateOf(alice.head(A)), "h").startTime, 45);
    const R2 = ripple(carol.stateOf(carol.head(C))!, "V1", 10, 3);
    carol.commit(C, { doc: R2.doc, intent: R2.intent, author: { kind: "human", id: "carol" } });
    const pkg = ship(carol.exportShallow(C, { to: "alice" }));
    const m2 = alice.fold(A, importedHead(alice.importShallow(pkg)), { author: HUMAN });
    assert.equal(m2.status, "confirmed");
    assert.equal(baseOf(m2).node, `${C}@1`, "the LCA is Carol's first export node");
    const h = alice.stateOf(alice.head(A));
    assert.deepEqual([it(h, "h").startTime, it(h, "h").endTime, it(h, "c").startTime], [42, 44, 32]);
    assert.notEqual(E.remapPoint([...E.rippleDelete(35, 5), ...E.rippleDelete(10, 3)], 45), 42, "the single net remap R2∘R1 would be wrong");
  });

  test("R5-02 fork-node base: Alice forks V from main@62, sends main@70 to Bob and V@5 to Carol; Carol → Bob merges on main@62 (carried), no dialog", () => {
    const d0 = doc(
      ["V"],
      ["a", "b", "c", "d"].map((x, i) => clip(x, "V", i * 5, i * 5 + 4)),
      { name: "T" },
    );
    for (const carry of ["fork-merge-export", "export-only"] as const) {
      const alice = History.create(S, d0, { name: "alice" }),
        bob = new History(S, { name: "bob" }),
        carol = new History(S, { name: "carol" });
      const main = alice.current;
      alice.commit(main, { doc: setItem(d0, "a", { name: "m62" }), author: HUMAN });
      const m62 = alice.head(main);
      const V = alice.fork(m62, "variant");
      alice.commit(main, { doc: setItem(alice.stateOf(alice.head(main))!, "b", { name: "m70" }), author: HUMAN });
      alice.commit(V, { doc: setItem(alice.stateOf(alice.head(V))!, "c", { name: "v5" }), author: AGENT });
      bob.importShallow(ship(alice.exportShallow(main, { to: "bob", carry })));
      carol.importShallow(ship(alice.exportShallow(V, { to: "carol", carry })));
      carol.commit(carol.current, { doc: setItem(carol.stateOf(carol.head(carol.current))!, "d", { name: "carol" }), author: BOB });
      bob.commit(bob.current, { doc: { ...bob.stateOf(bob.head(bob.current))!, name: "bob" }, author: BOB });
      const res = bob.fold(bob.current, importedHead(bob.importShallow(ship(carol.exportShallow(carol.current, { to: "bob", carry })))), { author: BOB });
      if (carry === "export-only") {
        assert.equal(res.status, "missing-base", "ablation: without fork-node states the LCA main@62 is missing");
        continue;
      }
      assert.equal(res.status, "confirmed", "no dialog, no card");
      assert.equal(baseOf(res).node, m62);
      const h = bob.stateOf(bob.head(bob.current))!;
      assert.deepEqual([h.name, ...["a", "b", "c", "d"].map((x) => it(h, x).name)], ["bob", "m62", "m70", "v5", "carol"]);
    }
  });

  test("R6-01 remaps per lineage edge through a merge node: the sender merged two rippled branches; the recipient's clips at 41 and 50 land at 33 and 42 via either parent", () => {
    const d0 = doc(["V1"], [clip("p", "V1", 0, 10), clip("q", "V1", 10, 13), clip("r", "V1", 13, 35), clip("s", "V1", 35, 40), clip("u", "V1", 60, 70)]);
    const alice = History.create(S, d0, { name: "alice" }),
      bob = new History(S, { name: "bob" }),
      dave = new History(S, { name: "dave" });
    const A = alice.current;
    const L = alice.head(A);
    bob.importShallow(ship(alice.exportShallow(A, { to: "bob" })));
    dave.importShallow(ship(alice.exportShallow(A, { to: "dave" })));
    let ad = addItem(d0, clip("h1", "V1", 41, 45));
    ad = addItem(ad, clip("h2", "V1", 50, 55));
    alice.commit(A, { doc: ad, author: HUMAN });
    const Ra = ripple(bob.stateOf(bob.head(bob.current))!, "V1", 10, 3);
    bob.commit(bob.current, { doc: Ra.doc, intent: Ra.intent, author: BOB });
    const Rb = ripple(dave.stateOf(dave.head(dave.current))!, "V1", 35, 5);
    dave.commit(dave.current, { doc: Rb.doc, intent: Rb.intent, author: { kind: "human", id: "dave" } });
    const bm = bob.fold(bob.current, importedHead(bob.importShallow(ship(dave.exportShallow(dave.current, { to: "bob" })))), { author: BOB });
    assert.equal(bm.status, "confirmed");
    assert.deepEqual(bm.change!.mergeEdges!.first.V1, [{ d: [[32, 37]], i: [] }], "Dave's ripple at 35 seen from Bob's coordinates starts at 32");
    assert.deepEqual(it(bob.stateOf(bob.head(bob.current)), "u").startTime, 52);
    const M = importedHead(alice.importShallow(ship(bob.exportShallow(bob.current, { to: "alice" }))));
    for (const prefer of ["first", "second"] as const) {
      const map = alice.pathRemap(L, M, { prefer }).V1;
      assert.deepEqual([E.remapPoint(map, 41), E.remapPoint(map, 50)], [33, 42], `via the ${prefer} parent`);
    }
    const res = alice.fold(A, M, { author: HUMAN });
    assert.equal(res.status, "confirmed");
    assert.equal(baseOf(res).node, L);
    const h = alice.stateOf(alice.head(A));
    assert.deepEqual([it(h, "h1").startTime, it(h, "h2").startTime, it(h, "u").startTime], [33, 42, 52]);
  });

  // ------------------------------------------------------------------ R5-03 / R6-02 the .cbproj zip

  test("R5-03/R6-02 .cbproj zip: no .takes/ and no .scratch/views/ entry; the rest of .scratch/ is kept; the shallow export is its own entry; imported view files are never applied", async () => {
    // port: Takes is Carton (PLAN v14 §0.1): the store folder is `.carton/` (`.carton/carton.db`), the shallow entry
    // `carton-shallow.json` and its format `carton-shallow/1`
    const root = tmpRoot(opts.tmpDir);
    await mkdir(root, { recursive: true });
    const dir = await mkdtemp(join(root, "gfv-v5-bundle-"));
    const out = join(dir, "..", `gfv-v5-${process.pid}-${Date.now()}.cbproj`);
    const evil = join(dir, "..", `gfv-v5-evil-${process.pid}-${Date.now()}.cbproj`);
    try {
      const files = ["project.json", "timeline.tsx", ".carton/carton.db", ".carton/carton.db-wal", ".carton/carton.db-shm", ".carton/displaced/1", ".scratch/gen.tsx", ".scratch/notes/plan.md", ".scratch/views/director-c3.tsx", ".scratch/views/agent-x7k2.status", "cache/a/thumb.jpg", "converted/x.mp4", "proxies/p.mp4", ".revs/1.json", ".project.json.tmp", "media/clip.mp4", "AGENTS.md"];
      for (const f of files) {
        await mkdir(join(dir, f, ".."), { recursive: true });
        await writeFile(join(dir, f), `content of ${f}`);
      }
      const d0 = doc(["V"], [clip("a", "V", 0, 5)]);
      const r = History.create(S, d0, { name: "alice" });
      const res = await exportCbproj(dir, out, { project: toHost(d0), shallow: r.exportShallow(r.current, { to: "bob" }) });
      const opened = await importCbproj(out);
      const names = opened.entries;
      assert.ok(!names.some((n) => n.startsWith(".carton/") || n === ".carton"), "no .carton/");
      assert.ok(!names.some((n) => n.startsWith(".scratch/views/")), "no .scratch/views/");
      for (const n of [".scratch/gen.tsx", ".scratch/notes/plan.md", "timeline.tsx", "media/clip.mp4", "AGENTS.md", "project.json", SHALLOW_ENTRY]) assert.ok(names.includes(n), `has ${n}`);
      for (const n of ["cache/a/thumb.jpg", "converted/x.mp4", "proxies/p.mp4", ".revs/1.json", ".project.json.tmp"]) assert.ok(!names.includes(n), `1.4.0 exclusion kept: ${n}`);
      assert.equal(opened.shallow!.format, "carton-shallow/1");
      // an independent zip reader agrees (Python's zipfile, CRCs checked)
      try {
        const py = execFileSync("python3", ["-c", "import sys,zipfile;z=zipfile.ZipFile(sys.argv[1]);assert z.testzip() is None;print('\\n'.join(z.namelist()))", out], { encoding: "utf8" });
        assert.deepEqual(py.trim().split("\n").sort(), [...names].sort());
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
      }
      // a .cbproj from a sender without the exclusion (or tampered): view files are listed, never applied
      await writeFile(
        evil,
        zip([
          { name: "project.json", data: JSON.stringify({ project: toHost(d0) }) },
          { name: ".scratch/views/director-c3.tsx", data: "// cardboard:rev main@3~deadbeef b:00000000\n" },
          { name: ".carton/carton.db", data: "x" },
        ]),
      );
      const o2 = await importCbproj(evil);
      assert.deepEqual(o2.ignoredViews.sort(), [".carton/carton.db", ".scratch/views/director-c3.tsx"]);
      assert.ok(!o2.files.includes(".scratch/views/director-c3.tsx"));
      assert.ok(res.size > 0);
    } finally {
      await rm(out, { force: true });
      await rm(evil, { force: true });
      await rm(dir, { recursive: true, force: true });
    }
  });

  // ------------------------------------------------------------------ §4.1 field kinds and validators

  test("§4.1 unknown fields from newer clients pass through as atomic leaves (replaced whole; both changed = a card)", () => {
    const b = doc(["V"], [clip("x", "V", 0, 5, { futureThing: { a: 1, b: 1 } })]);
    const one = E.merge3(b, setItem(b, "x", { futureThing: { a: 2, b: 1 } }), b, S);
    assert.deepEqual([one.conflicts.length, it(one.doc, "x").futureThing], [0, { a: 2, b: 1 }]);
    const both = E.merge3(b, setItem(b, "x", { futureThing: { a: 2, b: 1 } }), setItem(b, "x", { futureThing: { a: 1, b: 2 } }), S);
    assert.equal(both.conflicts.length, 1, "not merged per key: an unknown object is one leaf");
    assert.equal(both.conflicts[0]!.path, "timelineItems/x/futureThing");
  });

  test("§4.1 ephemeral: Cardboard's local-only fields (annotations, autoReframeSegmentationStatus, borderDrawProgress) and non-versioned media fields are never versioned", () => {
    const host = { name: "P", aspectRatio: "16:9", tracks: [{ id: "V", name: "V", order: 0 }], timelineItems: [clip("x", "V", 0, 5, { annotations: [{ a: 1 }], borderDrawProgress: 0.4, autoReframeSegmentationStatus: "pending" })], media: [{ id: "m", contentHash: "h", data: { type: "video", fileName: "a.mp4", src: "/Users/alice/a.mp4" }, thumbnail: "blob:..." }] };
    const d = fromHost(host);
    for (const f of ["annotations", "borderDrawProgress", "autoReframeSegmentationStatus"]) assert.equal(it(d, "x")[f], undefined, `${f} not versioned`);
    assert.deepEqual((d.media as Json[])[0], { id: "m", contentHash: "h", data: { type: "video", fileName: "a.mp4" } });
    const changed = fromHost({ ...host, timelineItems: [clip("x", "V", 0, 5, { annotations: [{ a: 2 }], borderDrawProgress: 0.9, autoReframeSegmentationStatus: "done" })] }, d);
    assert.deepEqual(E.diff(d, changed, S), [], "changing local-only state is not a change");
  });

  test("§4.1 soft validators: an overlap that only the merge creates is a warning on the merge, not a card", () => {
    const b = doc(["V"], [clip("a", "V", 0, 5), clip("b", "V", 10, 15)]);
    // ours: a [0, 9] (no overlap with b at [10, 15]); theirs: b moved to [8, 13] (no overlap with a at [0, 5])
    const m = E.merge3(b, setItem(b, "a", { endTime: 9, trimEnd: 9 }), setItem(b, "b", { startTime: 8, endTime: 13 }), S);
    assert.deepEqual(m.conflicts, []);
    assert.deepEqual(m.warnings, [{ kind: "overlap", items: ["a", "b"] }]);
  });

  test("§13 a .cbproj with the same project id but no shared lineage gets a new id (never merged against nothing)", () => {
    const d0 = doc(["V"], [clip("x", "V", 0, 5)]);
    const a = History.create(S, d0, { name: "alice", projectId: "same-id" }),
      b = History.create(S, d0, { name: "bob", projectId: "same-id" });
    const res = b.importShallow(ship(a.exportShallow(a.current, { to: "bob" })));
    assert.equal(res.status, "no-shared-lineage");
    assert.ok(res.newProjectId && res.newProjectId !== "same-id");
  });
}
