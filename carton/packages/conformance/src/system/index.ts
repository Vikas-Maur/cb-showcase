// System conformance (PLAN §6, §12, §15): system-v11's 97 tests (names kept) on the real code, H1–H4, the four v12
// rules no prototype test pinned (list on the "behind" reject and scan from the oldest pending base: server-level in
// @carton/server's tests; drop before rebase and the hello rid claim: core's client tests and server tests), and P9.
// The tests run in a deterministic virtual-time simulation (./sim) around the real ReplicaQueue, SyncClient and
// createSequencer; the sequencer's SequencerStorage is the one plug-in point (node:sqlite by default). The behaviour a
// SequencerHost must show over its own transport, in real time, is `hostSuite`. Owner: sync-sequencer.
import { describe } from "node:test";
import type { SequencerStorage } from "@carton/core/plugins";
import { useStorage } from "./helpers.ts";
import * as chaos from "./tests/chaos.ts";
import * as g1 from "./tests/g1-gui.ts";
import * as p9 from "./tests/p9-contention.ts";
import * as r101 from "./tests/r1-01-four-step.ts";
import * as r202 from "./tests/r2-02-cb-status.ts";
import * as r203 from "./tests/r2-03-subagents.ts";
import * as r208 from "./tests/r2-08-undo.ts";
import * as r301 from "./tests/r3-01-ripple-once.ts";
import * as r303 from "./tests/r3-03-handoff.ts";
import * as r402 from "./tests/r4-02-view-base.ts";
import * as r403 from "./tests/r4-03-edit-loop.ts";
import * as r404 from "./tests/r4-04-helper.ts";
import * as r504 from "./tests/r5-04-status.ts";
import * as r505 from "./tests/r5-05-rewrite-spacing.ts";
import * as r506 from "./tests/r5-06-fencing.ts";
import * as r78 from "./tests/r7-r8-shared-file.ts";
import * as timeGroup from "./tests/time-group.ts";
import * as v11 from "./tests/v11-server.ts";
import * as v14 from "./tests/v14-holes.ts";

export { hostSuite } from "./host-suite.ts";
export { runOnce as p9RunOnce, s2 as p9S2, summarize as p9Summarize } from "./p9.ts";
export { sqliteStorage } from "./sqlite.ts";

/** Every file of the suite, in the prototype's order, then the v14 holes. */
export const SYSTEM_FILES = { chaos, g1, p9, r101, r202, r203, r208, r301, r303, r402, r403, r404, r504, r505, r506, r78, timeGroup, v11, v14 } as const;

export interface SystemSuiteOptions {
  /** The sequencer's storage for every simulated world (default: node:sqlite in memory). */
  storage?: () => SequencerStorage;
  /** Leave out the slow files (P9's 160 simulated runs, chaos, G1): a quick run for a storage plug-in. */
  quick?: boolean;
}

/** Register the whole system suite (node:test) under `name`. */
export function systemSuite(name: string, opts: SystemSuiteOptions = {}): void {
  if (opts.storage) useStorage(opts.storage);
  const slow = new Set<unknown>([p9, chaos, g1]);
  describe(`System conformance: ${name}`, () => {
    for (const f of Object.values(SYSTEM_FILES)) if (!opts.quick || !slow.has(f)) f.register();
  });
}
