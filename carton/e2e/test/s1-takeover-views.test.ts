// B3 (fixed by local-cli f9a656c; was routed to local-cli): the app is open and holds the lease, but its engine thread misses one 100 ms ping (busy
// or preempted; seen at load 11-12 on the shared box in 2 of 4 runs of s1). The `cb` call then takes the lease over
// at once (R4-04) with a detached helper started from `@carton/local`'s default factory, which runs no materializer,
// so an agent's `cb source print --view` (the documented flow, §6.4) answers "views need the app open (or a helper that
// materializes)" while the app is open, until the app takes the lease back.
// Expected: a print --view is served by a holder that can print views, whoever holds the lease.
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeMachine, itemNamed, SAMPLE } from "../support/project.ts";
import { Procs } from "../support/procs.ts";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { support, until } from "../support/env.ts";
import { helperTookLeaseSince } from "../support/head.ts";
import { cbWrite, setOp } from "../support/cb.ts";

test("B3: an agent's print --view while the app's engine thread is briefly busy is served (not 'views need the app open')", { timeout: 120_000 }, async (t) => {
  const procs = new Procs();
  t.after(() => procs.close());
  const m = makeMachine("s1-takeover");
  procs.watchHelpers(m.dbDir);
  const app = procs.start("app", [support("app.ts"), m.bundle, m.projectId, "{}"]);
  await app.next((x) => x.ready);
  // the engine thread is busy for 5 s (under the 6 s lease expiry: its holder is fresh, just not answering); the agent
  // starts once the stall is certainly on, and the test then checks a helper took the lease (so its print was served
  // by a takeover helper, B3's condition, not by the app after the stall)
  const marker = join(m.home, "stalled"), since = Date.now();
  const stalled = app.ask({ cmd: "serve", req: { e2e: "stall", ms: 5000, marker } });
  await until(() => existsSync(marker), 30_000, "the engine thread to be stalled");
  const actor = "director/chat9/turn1/sub-editor-Z";
  const agent = procs.start(actor, [support("agent.ts"), m.bundle, m.projectId, JSON.stringify({ noRetry: true, steps: [{ op: "set", name: SAMPLE.logo, set: { zIndex: 3 } }] })], { env: { CARDBOARD_ACTOR: actor } });
  const [out] = await Promise.all([agent.next((x) => Array.isArray(x.results), 60_000), stalled]);
  assert.equal(out.results[0].status, "confirmed");
  assert.ok(helperTookLeaseSince(m, since), "a helper took the lease while the app was stalled (otherwise this run didn't reach B3's condition)");
});

// B11 (fixed by local-cli 38814d9; was routed to local-cli + cardboard-adapter): a `cb` write that doesn't go through the app's lease holder (a helper
// that took the lease over after one missed ping, B3, or an in-process commit when no holder answered) lands in
// carton.db, but the app's materializer never hears of it: project.json and the shared timeline.tsx keep showing the
// old head (the editor too) until something else moves head through the app. Seen in CI (run 41201619463, s1: "timed out
// waiting for the restore in project.json").
test("B11: a cb write served while the app's engine thread is briefly busy still reaches the app's project.json", { timeout: 120_000 }, async (t) => {
  const procs = new Procs();
  t.after(() => procs.close());
  const m = makeMachine("s1-takeover-files");
  procs.watchHelpers(m.dbDir);
  const app = procs.start("app", [support("app.ts"), m.bundle, m.projectId, "{}"]);
  await app.next((x) => x.ready);
  const logo = itemNamed(m, SAMPLE.logo)!;
  // the write starts only once the engine thread is certainly stalled, and the test then checks it was served by a
  // takeover helper (B11's condition), so a write the app served normally can't pass it
  const marker = join(m.home, "stalled"), since = Date.now();
  const stalled = app.ask({ cmd: "serve", req: { e2e: "stall", ms: 4000, marker } });
  await until(() => existsSync(marker), 30_000, "the engine thread to be stalled");
  const r = await cbWrite(m, { kind: "commit", ops: [setOp("timelineItems", logo.id, "zIndex", 6)] }, { actor: "codex/busy-app" });
  assert.equal(r.status, "confirmed", JSON.stringify(r));
  await stalled;
  assert.ok(helperTookLeaseSince(m, since), "a helper took the lease and served the write (otherwise this run didn't reach B11's condition)");
  await until(() => itemNamed(m, SAMPLE.logo)?.zIndex === 6, 15_000, "project.json to show the write");
});
