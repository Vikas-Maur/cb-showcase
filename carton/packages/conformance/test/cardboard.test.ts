// Runs the Cardboard conformance suite (`src/cardboard/`) on @carton/cardboard, the system scenarios ported from
// system-v11 (r4-02, r7-r8, r1-01, time-group, r3-01) and the .cbproj round trip on the real engine, history and
// materializer, and the checks against Cardboard 1.4.0's own CLI (skipped where the CLI isn't present).
import { cardboardSuite } from "../src/cardboard/index.ts";
import "../src/cardboard/system/r4-02-view-base.ts";
import "../src/cardboard/system/r7-r8-shared-file.ts";
import "../src/cardboard/system/r1-01-four-step.ts";
import "../src/cardboard/system/time-group.ts";
import "../src/cardboard/system/r3-01-ripple-once.ts";
import "../src/cardboard/system/cbproj.ts";
import "../src/cardboard/system/real-codec.ts";
import "../src/cardboard/system/review1.ts";
import "../src/cardboard/system/review2.ts";
import "../src/cardboard/system/review4.ts";
import "../src/cardboard/system/wording.ts";
import "../src/cardboard/system/b6-cut-switch.ts";
import "../src/cardboard/system/b5-file-save-cards.ts";
import "../src/cardboard/system/b11-external-head.ts";
import "../src/cardboard/system/review7.ts";
import "../src/cardboard/system/review8.ts";
import "../src/cardboard/system/review9.ts";
import "../src/cardboard/system/review11.ts";
import "../src/cardboard/system/cut-ids.ts";
import "../src/cardboard/system/review13.ts";
import "../src/cardboard/system/review14.ts";
import "../src/cardboard/system/review15.ts";
import "../src/cardboard/system/review16.ts";
import "../src/cardboard/system/review17.ts";
import "../src/cardboard/system/review18.ts";
import "../src/cardboard/system/review19.ts";
import "../src/cardboard/system/review20.ts";
import "../src/cardboard/system/invalid-records.ts";
import "../src/cardboard/system/app-options.ts";
import "../src/cardboard/system/hosts-schema.ts";
import "../src/cardboard/cli-codec.test.ts";

await cardboardSuite();
