// B3 (routed to local-cli): the app is open and holds the lease, but its engine thread misses one 100 ms ping (busy
// or preempted; seen at load 11-12 on the shared box in 2 of 4 runs of s1). The `cb` call then takes the lease over
// at once (R4-04) with a detached helper started from `@carton/local`'s default factory, which runs no materializer,
// so an agent's `cb source print --view` (the documented flow, §6.4) answers "views need the app open (or a helper that
// materializes)" while the app is open, until the app takes the lease back.
// Expected: a print --view is served by a holder that can print views, whoever holds the lease.
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeMachine, SAMPLE } from "../support/project.ts";
import { Procs } from "../support/procs.ts";
import { support } from "../support/env.ts";

test("B3: an agent's print --view while the app's engine thread is briefly busy is served (not 'views need the app open')", { timeout: 120_000, todo: "B3, local-cli: a takeover helper has no materializer" }, async (t) => {
  const procs = new Procs();
  t.after(() => procs.close());
  const m = makeMachine("s1-takeover");
  procs.watchHelpers(m.dbDir);
  const app = procs.start("app", [support("app.ts"), m.bundle, m.projectId, "{}"]);
  await app.next((x) => x.ready);
  // the engine thread is busy for 4 s (under the 6 s lease expiry: its holder is fresh, just not answering)
  const stalled = app.ask({ cmd: "serve", req: { e2e: "stall", ms: 4000 } });
  const actor = "director/chat9/turn1/sub-editor-Z";
  const agent = procs.start(actor, [support("agent.ts"), m.bundle, m.projectId, JSON.stringify({ noRetry: true, steps: [{ op: "set", name: SAMPLE.logo, set: { zIndex: 3 } }] })], { env: { CARDBOARD_ACTOR: actor } });
  const [out] = await Promise.all([agent.next((x) => Array.isArray(x.results), 60_000), stalled]);
  assert.equal(out.results[0].status, "confirmed");
  t.diagnostic(JSON.stringify({ helpers: procs.helperPids().length }));
});
