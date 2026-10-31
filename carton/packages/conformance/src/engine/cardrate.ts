// Card rate on a realistic concurrent-edit mix (port of core-v5 `cardrate.mjs`, without its core-proto v1 comparison):
// PLAN §4.1 / R3-05, "report the card rate on a realistic concurrent-edit mix".
//
// THE MIX (the prototype's definition; the probabilities are in mix.ts):
// - Timeline: genDoc(300 items, Cardboard-like: Titles, Captions, B-roll, Main, Grade, Voiceover, Music tracks; ~2.6 min
//   of captions over ~8 min).
// - Two writers on the same timeline at the same time: a human in the GUI and an agent (Director) saving its view file.
//   Each round both start from the same confirmed state; the human makes one change of 1 edit, the agent one change of
//   1-4 edits; the pair is merged with merge3 as the sequencer's rebase would (pairs that don't overlap merge clean
//   anyway). The merged result (cards resolved "ours") is the next round's base.
// - Locality: both work on the same scene: 70% of edits pick an item overlapping a 60 s window that moves every 25
//   rounds, 30% pick any item.
// - Human (GUI, edit kinds recorded on the change): trim-out 20%, move 15%, grade 15%, trim-in 10%, text 10%, volume 8%,
//   slip 5%, add effect 5%, delete clip 4%, add clip 4%, speed 2%, ripple delete 2% (a recorded remap).
// - Agent (file edits, kinds NOT recorded): caption text 25%, title rewrite 15%, tighten (trim-out) 15%, retime a
//   caption (start and end) 10%, add title 10%, grade 8%, close a gap (unrecorded ripple, inferred when unambiguous) 7%,
//   transform 5%, delete clip 3%, reorder effects 2%.
//
// The prototype recorded, and an independent re-run reproduced (core-v5 RESULTS.md, results/cardrate-realistic.json):
// realistic mix, 5 seeds x 500 rounds, algebra on: 15 of 2,472 merges with a card (0.6%), 0 invalid results.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as E from "@carton/core";
import type { Schema } from "@carton/core";
import { fromHost, toHost, withKeys } from "./fixtures/cardboard-schema.ts";
import { genDoc, rng, int } from "./gen.ts";
import { REALISTIC, r3, W, roll, HUMAN, AGENT, editOnce } from "./mix.ts";
import type { Mix, MixEdit, MixState } from "./mix.ts";
import { valid } from "./props.ts";

export interface CardRateTally {
  rounds: number;
  edits: number;
  merges: number;
  withCard: number;
  cards: number;
  sameClipPairs: number;
  sameClipCards: number;
  byKind: Record<string, number>;
  byReason: Record<string, number>;
  invalid: number;
  composed: number;
  mapped: number;
  remapsRecorded: number;
  remapsInferred: number;
}

export interface CardRateOptions {
  mix?: Mix;
  /** Rounds per seed (default 500). */
  rounds?: number;
  /** Seeds 1000, 1001, … (default 5). */
  seeds?: number;
  /** false: every both-sides retime is a card (the prototype's "algebra off" control). */
  algebra?: boolean;
}

/** One seed of the mix. */
export function cardRateRun(S: Schema, seed: number, { mix = REALISTIC, rounds = 500, algebra = true }: CardRateOptions = {}): CardRateTally {
  const r = rng(seed);
  let base = withKeys(genDoc(300, seed));
  const n: MixState = { win: 0, k: 0 };
  const t: CardRateTally = { rounds: 0, edits: 0, merges: 0, withCard: 0, cards: 0, sameClipPairs: 0, sameClipCards: 0, byKind: {}, byReason: {}, invalid: 0, composed: 0, mapped: 0, remapsRecorded: 0, remapsInferred: 0 };
  for (let round = 0; round < rounds; round++) {
    if (round % 25 === 0) n.win = r3(r() * 400);
    const hb = structuredClone(toHost(base)),
      ab = structuredClone(toHost(base));
    const hc = W(mix, r, hb, n),
      ac = W(mix, r, ab, n);
    const he: MixEdit[] = [],
      ae: MixEdit[] = [];
    const h1 = editOnce(mix, r, hb, roll(r, HUMAN), hc, "human", n);
    if (h1) he.push(h1);
    for (let k = int(r, 1, 4); k > 0; k--) {
      const a = editOnce(mix, r, ab, roll(r, AGENT), ac, "agent", n);
      if (a) ae.push(a);
    }
    if (!he.length || !ae.length) continue;
    const ours = fromHost(hb, base),
      theirs = fromHost(ab, base);
    const kinds = { ours: Object.fromEntries(he.filter((e) => e.rec).map((e) => [e.id, e.rec!])) };
    const remap = he.find((e) => e.remap);
    const m = E.merge3(base, ours, theirs, S, { kinds, remaps: remap ? { ours: { maps: remap.remap! } } : undefined, algebra });
    t.rounds++;
    t.edits += he.length + ae.length;
    t.merges++;
    t.composed += m.stats.composed.length;
    t.mapped += m.stats.mapped.length;
    if (remap) t.remapsRecorded++;
    if (m.remaps.inferred[1]) t.remapsInferred++;
    if (m.conflicts.length) t.withCard++;
    t.cards += m.conflicts.length;
    for (const c of m.conflicts) {
      t.byKind[c.kind] = (t.byKind[c.kind] ?? 0) + 1;
      const why = `${c.kind}: ${c.reason ?? (c.kind === "record" ? "delete vs edit" : c.kind === "field" ? "same field, different values" : c.kind)}`;
      t.byReason[why] = (t.byReason[why] ?? 0) + 1;
    }
    const hids = new Set(he.map((e) => e.id));
    const same = ae.some((e) => hids.has(e.id));
    if (same) {
      t.sameClipPairs++;
      if (m.conflicts.length) t.sameClipCards++;
    }
    const resolved = E.resolve(
      m,
      m.conflicts.map(() => "ours" as const),
    );
    if (valid(resolved, S)) t.invalid++;
    base = resolved;
  }
  return t;
}

/** Every seed of the mix, summed. */
export function cardRate(S: Schema, opts: CardRateOptions = {}): { total: CardRateTally; perSeed: CardRateTally[] } {
  const perSeed = Array.from({ length: opts.seeds ?? 5 }, (_, s) => cardRateRun(S, 1000 + s, opts));
  const total = perSeed.reduce((a, x) => {
    for (const [k, v] of Object.entries(x) as [keyof CardRateTally, number | Record<string, number>][]) {
      if (typeof v === "number") (a[k] as number) = ((a[k] as number | undefined) ?? 0) + v;
      else {
        const into = ((a[k] as Record<string, number> | undefined) ??= {});
        for (const [k2, v2] of Object.entries(v)) into[k2] = (into[k2] ?? 0) + v2;
      }
    }
    return a;
  }, {} as CardRateTally);
  return { total, perSeed };
}

export interface CardRateSuiteOptions {
  rounds?: number;
  seeds?: number;
  /** The share of merges allowed to raise a card (default 0.015: 2.5x the prototype's 0.6%). */
  maxRate?: number;
}

/** Registers the card-rate check: the realistic mix stays under `maxRate` merges with a card, with 0 invalid results. */
export function cardRateTests(S: Schema, opts: CardRateSuiteOptions = {}): void {
  const rounds = opts.rounds ?? 500,
    seeds = opts.seeds ?? 5,
    maxRate = opts.maxRate ?? 0.015;
  test(`card rate, realistic mix (${seeds} seeds x ${rounds} rounds, algebra on): at most ${(maxRate * 100).toFixed(1)}% of concurrent merges raise a card (prototype: 15 of 2,472, 0.6%), 0 invalid results`, () => {
    const { total: t, perSeed } = cardRate(S, { mix: REALISTIC, rounds, seeds });
    const rate = t.withCard / t.merges;
    console.log(
      `  # card rate (realistic): merges ${t.merges}, edits ${t.edits}; with >=1 card ${t.withCard} (${(100 * rate).toFixed(1)}%); cards ${t.cards} (${((100 * t.cards) / t.edits).toFixed(2)} per 100 edits); same-clip pairs ${t.sameClipPairs} (${t.sameClipCards} with a card); composed ${t.composed}, mapped ${t.mapped}; remaps recorded ${t.remapsRecorded}, inferred ${t.remapsInferred}; invalid ${t.invalid}; by reason ${JSON.stringify(t.byReason)}; per seed (merges/with card/cards) ${perSeed.map((x) => `${x.merges}/${x.withCard}/${x.cards}`).join(" ")}`,
    );
    assert.ok(t.merges >= rounds * seeds * 0.9, `the mix ran: ${t.merges} merges`);
    assert.equal(t.invalid, 0, "every merge resolved all-ours is valid");
    assert.ok(rate <= maxRate, `${t.withCard} of ${t.merges} merges raised a card (${(100 * rate).toFixed(2)}%)`);
  });
}
