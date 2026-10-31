// core-v5 conformance.test.mjs: the engine scenarios B1–B13, S1–S7, M4, R4-*, R5-*, R6-*, §4–§13.
import { engineSuite } from "../src/engine/index.ts";
import { tmpDir } from "./engine-env.ts";

engineSuite({ part: "conformance", tmpDir });
