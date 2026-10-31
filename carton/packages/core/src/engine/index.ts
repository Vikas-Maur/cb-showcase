// The document engine (PLAN §4, §7, §9): schema-driven diff and apply (total and deterministic), merge3 with field
// groups and the time-group algebra, fractional-index sequences (M4), remap intents, validators, the change
// declaration, shot diff and describe. Pure and synchronous. Port of the verified core-v5 prototype
// (`proofs/core-v5/engine.mjs`). Owner: foundation-core.
export { deepEqual, pathKey, prefixKeys, canonical } from "./json.ts";
export { sha256Hex, setSyncHash, portableSha256Hex, hashRecord, hashDoc, snapshot } from "./hash.ts";
export { fork, getIn, specAt, stripEphemeral } from "./doc.ts";
export { diff } from "./diff.ts";
export { apply } from "./apply.ts";
export { MAX_KEY, keyBetween, keyUp, keyAfter, keysBetween, assignKeys, byPos } from "./keys.ts";
export { EPS, step, rippleDelete, rippleInsert, remapPoint, remapSpan, transformChain, composeChain, composeMaps, inferRemaps, expandRemap, isEmptyMap, intentRemap, invertChain, invertMaps } from "./remap.ts";
export { timeAlgebra } from "./algebra.ts";
export type { TimeAlgebra, TimeVals } from "./algebra.ts";
export { diff3 } from "./diff3.ts";
export { merge3, resolve, compare2 } from "./merge.ts";
export { validateHard } from "./validate.ts";
export { declare } from "./declare.ts";
export { shots, shotDiff } from "./shots.ts";
export { describe } from "./describe.ts";
export { lcs } from "./lcs.ts";
