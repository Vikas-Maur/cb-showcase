// Template: copy it into your repo and swap the lines marked "← your …" for your own.
// Run the engine scenarios, the DAG/apply fuzz and the card-rate bound against your schema. The scenarios are
// written in Cardboard's terms (tracks, timelineItems, the time group…), so the schema must describe those fields the
// way the plan does; this checks that @carton/cardboard's shipped schema (or your edit of it) keeps every engine
// guarantee. Without `schema`, the suites use the pinned fixture they were verified with.
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after } from "node:test";
import { engineSuite, fuzzSuite, cardRateSuite } from "@carton/conformance";
import { cardboardSchema } from "@carton/cardboard"; // ← your schema

const root = process.env.CARTON_SCRATCH ?? join(tmpdir(), "carton-conformance");
mkdirSync(root, { recursive: true });
const tmpDir = mkdtempSync(join(root, "engine-"));
after(() => rmSync(tmpDir, { recursive: true, force: true }));

const quick = process.env.FULL !== "1";
engineSuite({
  schema: cardboardSchema,
  tmpDir, // .cbproj zips go here (default $CARTON_TEST_TMP, else the OS temp dir)
  // cardboardDir: "…/Cardboard 1.4.0 unpacked", // B10 uses Cardboard's real fm∘sv from here; it skips without it
  ...(quick ? { counts: { fuzz: 200 } } : {}), // core-proto's property fuzz; default 2,000 cases each
});
fuzzSuite({ schema: cardboardSchema, ...(quick ? { counts: { dag: 40, multi: 30, det: 100, tp1: 2000 } } : {}) });
cardRateSuite({ schema: cardboardSchema, ...(quick ? { seeds: 2, rounds: 200 } : {}) });
