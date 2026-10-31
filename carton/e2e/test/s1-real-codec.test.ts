// Scenario 1 with Cardboard 1.4.0's own timeline.tsx printer and parser in the app's materializer (run as the 1.4.0
// CLI, conformance's test codec; the Windows build injects the same functions from the app's bundle): the shared file
// and the per-agent view are Cardboard's JSX under Carton's header, and an agent's Edit of its view is parsed by
// Cardboard and lands as one change, credited to the agent. Skipped where the 1.4.0 CLI isn't present
// (CARTON_CARDBOARD_CLI, or the unpacked app under ~/.t3/projects/cardboard-showcase/_inspect).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { findRev } from "@carton/cardboard";
import { DEFAULT_CLI } from "../../packages/conformance/src/cardboard/cli-codec.ts";
import { existsSync } from "node:fs";
import { makeMachine, itemNamed, SAMPLE } from "../support/project.ts";
import { Procs } from "../support/procs.ts";
import { support, until } from "../support/env.ts";
import { cbOk } from "../support/cb.ts";

const skip = existsSync(DEFAULT_CLI) ? false : `Cardboard 1.4.0's CLI isn't at ${DEFAULT_CLI}`;

test("S1 with Cardboard's real printer and parser: an agent's JSX edit of its view lands as one change, credited to it", { timeout: 300_000, skip }, async (t) => {
  const procs = new Procs();
  t.after(() => procs.close());
  const m = makeMachine("s1-real");
  procs.watchHelpers(m.dbDir);
  const app = procs.start("app", [support("app.ts"), m.bundle, m.projectId, JSON.stringify({ codec: "cli" })]);
  await app.next((x) => x.ready, 120_000);
  const shared = readFileSync(join(m.bundle, "timeline.tsx"), "utf8");
  assert.match(shared.split("\n")[0]!, /^\/\/ Cardboard timeline for "/, "Cardboard's printer wrote the shared file");
  assert.equal((findRev(shared)?.rev as any)?.kind, "carton", "under Carton's header");
  const actor = "director/chatR/turn1/sub-editor-j1";
  const out = await procs.start(actor, [support("agent.ts"), m.bundle, m.projectId, JSON.stringify({ statusMs: 120_000, steps: [{ op: "text", find: 'textContent="Carton fixture"', replace: 'textContent="Edited in Cardboard JSX"' }] })], { env: { CARDBOARD_ACTOR: actor } }).next((x) => Array.isArray(x.results), 240_000);
  assert.equal(out.results[0].status, "confirmed", JSON.stringify(out.results[0]));
  const view = readFileSync(join(m.bundle, out.view.path), "utf8");
  assert.match(view, /<timeline /, "the view is Cardboard's JSX");
  await until(() => itemNamed(m, SAMPLE.title)?.textContent === "Edited in Cardboard JSX", 60_000, "project.json to show the agent's edit");
  const h = await cbOk(m, ["history"]);
  assert.equal(h.versions[0].by.id, actor);
  const d = await cbOk(m, ["compare", `main@${h.versions[1].ref.seq}`, `main@${h.versions[0].ref.seq}`]);
  t.diagnostic(JSON.stringify(d.changes));
  assert.equal(d.ops, 1, `only the title's text changed: ${JSON.stringify(d.changes)}`);
  assert.equal((await cbOk(m, ["credits", SAMPLE.title])).by.id, actor);
});
