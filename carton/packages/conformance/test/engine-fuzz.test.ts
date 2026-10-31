// core-v5 fuzz.test.mjs: DAG fuzz (DAG, MULTI), apply determinism (DET), remap TP1 (TP1), keys.
import { fuzzSuite } from "../src/engine/index.ts";
import { counts } from "./engine-env.ts";

fuzzSuite({ counts });
