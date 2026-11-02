// Test-only (CARTON_TEST_FREEZE=1: support.js has build.js bundle it into carton-node.cjs, ahead of the facade): every document Carton's handle returns
// (head, checkout, resolve) comes back deep-frozen, as core will return them (foundation-core, after fd07cc8). The E2E
// then runs Cardboard's real store over them: a place that hands Cardboard Carton's records without a copy loses
// Cardboard's in-place edits (sloppy code) or throws (strict code). Frozen copies, so core's own states are untouched.
import { Carton } from "@carton/core";
import { extend } from "../../carton-node.js";

const deepFreeze = (o) => {
  if (o && typeof o === "object" && !Object.isFrozen(o)) {
    Object.freeze(o);
    for (const v of Object.values(o)) deepFreeze(v);
  }
  return o;
};
const frozen = (doc) => deepFreeze(structuredClone(doc));

// Core exports `Carton` as a factory ({open}); the handle's class is private, so its prototype is patched once, from
// the first handle opened.
let patched = false;
const patch = (proto) => {
  for (const m of ["head", "resolve"]) {
    const f = proto[m];
    proto[m] = async function (...a) {
      const r = await f.apply(this, a);
      return r && r.doc ? { ...r, doc: frozen(r.doc) } : r;
    };
  }
  const checkout = proto.checkout;
  proto.checkout = async function (...a) {
    return frozen(await checkout.apply(this, a));
  };
  patched = true;
};
const open = Carton.open;
Carton.open = async function (...a) {
  const c = await open.apply(this, a);
  if (!patched) patch(Object.getPrototypeOf(c));
  return c;
};
globalThis.__cartonTestFrozen = true;
// So the mode can't quietly stop testing anything: live.test.js asks the worker whether a doc its facade's handle
// returns is frozen (carton.testFrozen), and fails if not, or if this module isn't in the build.
extend({ name: "test-freeze", worker: (api) => ({ testFrozen: async ({ projectId }) => Object.isFrozen((await (await api.carton(projectId)).carton.head()).doc) }) });
