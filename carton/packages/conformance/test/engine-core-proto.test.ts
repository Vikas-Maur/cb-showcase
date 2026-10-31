// core-v5 test.mjs: core-proto's 31 tests ported to the v5 engine, and its four property fuzz tests (FUZZ cases).
import { engineSuite } from "../src/engine/index.ts";
import { counts } from "./engine-env.ts";

engineSuite({ part: "core-proto", counts });
