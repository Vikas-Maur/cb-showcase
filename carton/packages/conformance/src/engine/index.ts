// Engine and history conformance (PLAN §4, §5, §7, §8, §9, §15): the 96 core-v5 engine tests (names kept for
// tracing), the DAG and apply-determinism fuzz (0 mismatches), and the card-rate check. Owner: foundation-core.
//
// Each suite registers node:test tests. Test names are the prototype's byte for byte with the default counts; the
// counts the prototype read from env (FUZZ, DAG, MULTI, DET, TP1) are options, and appear in the names they set.
import type { Schema } from "@carton/core";
import { cardboard } from "./fixtures/cardboard-schema.ts";
import { conformanceTests } from "./conformance.ts";
import { coreProtoTests } from "./core-proto.ts";
import { fuzzTests } from "./fuzz.ts";
import { cardRateTests } from "./cardrate.ts";

export { cardRate, cardRateRun } from "./cardrate.ts";
export type { CardRateOptions, CardRateTally } from "./cardrate.ts";

export interface EngineSuiteOptions {
  /**
   * Run against a host's schema (default: the Cardboard schema fixture the prototype was verified with). The tests are
   * written against Cardboard's fields and use the fixture's host projection, so the schema must describe them the
   * same way.
   */
  schema?: Schema;
  /** Fuzz iterations: overrides every count below (default as the prototype). */
  fuzzRuns?: number;
  /** Per-suite counts, the prototype's env names: FUZZ 2,000 (core-proto properties), DAG 400, MULTI 300, DET 1,000, TP1 20,000. */
  counts?: { fuzz?: number; dag?: number; multi?: number; det?: number; tp1?: number };
  /** Register only one part of the engine suite: the conformance scenarios, or core-proto's ported tests. */
  part?: "conformance" | "core-proto";
  /** Directory for temporary files (.cbproj zips). Default: $CARTON_TEST_TMP, else the OS temp dir. */
  tmpDir?: string;
  /** An unpacked Cardboard 1.4.0 for B10's real fm∘sv. Default: $CARTON_CARDBOARD_DIR, else the inspection copy. */
  cardboardDir?: string;
}

const count = (opts: EngineSuiteOptions, k: keyof NonNullable<EngineSuiteOptions["counts"]>) => opts.fuzzRuns ?? opts.counts?.[k];

/** Registers the engine conformance tests with node:test (core-v5 `conformance.test.mjs` and `test.mjs`). */
export function engineSuite(opts: EngineSuiteOptions = {}): void {
  const S = opts.schema ?? cardboard;
  if (opts.part !== "core-proto") conformanceTests(S, { tmpDir: opts.tmpDir, cardboardDir: opts.cardboardDir });
  if (opts.part !== "conformance") coreProtoTests(S, { cases: count(opts, "fuzz") });
}

/** Registers the DAG and apply-determinism fuzz tests, TP1 and the key properties (core-v5 `fuzz.test.mjs`). */
export function fuzzSuite(opts: EngineSuiteOptions = {}): void {
  fuzzTests(opts.schema ?? cardboard, { dag: count(opts, "dag"), multi: count(opts, "multi"), det: count(opts, "det"), tp1: count(opts, "tp1") });
}

/** Registers the card-rate check on the realistic concurrent-edit mix (core-v5 `cardrate.mjs`). */
export function cardRateSuite(opts: { schema?: Schema; rounds?: number; seeds?: number; maxRate?: number } = {}): void {
  cardRateTests(opts.schema ?? cardboard, opts);
}
