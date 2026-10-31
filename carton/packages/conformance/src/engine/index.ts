// Engine and history conformance (PLAN §4, §5, §7, §8, §9, §15): the 96 core-v5 engine tests (names kept for
// tracing), the DAG and apply-determinism fuzz (0 mismatches), and the card-rate check. Owner: foundation-core.
import type { Schema } from "@carton/core";

const todo = (what: string): never => {
  throw new Error(`not implemented: ${what}`);
};

export interface EngineSuiteOptions {
  /** Run against a host's schema (default: the Cardboard schema fixture the prototype was verified with). */
  schema?: Schema;
  /** Fuzz iterations (default as the prototype). */
  fuzzRuns?: number;
}

/** Registers the engine conformance tests with node:test. */
export function engineSuite(opts: EngineSuiteOptions = {}): void {
  todo("engineSuite");
}
/** Registers the DAG and apply-determinism fuzz tests. */
export function fuzzSuite(opts: EngineSuiteOptions = {}): void {
  todo("fuzzSuite");
}
