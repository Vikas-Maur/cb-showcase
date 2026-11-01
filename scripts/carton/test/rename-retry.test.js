// The Windows busy-file retry (scripts/rename-retry.js) that the worker and the CLI get: the rename behind every save,
// and Open Project's removal of its staging folder (patch-worker.js 6, patch-cli-media.js 6; CI route 35 failed with
// EBUSY there). Run as Windows would run it, in a context that says win32, with a stand-in fs/promises. Runs anywhere.
//   node --test scripts/carton/test/rename-retry.test.js
const test = require("node:test");
const assert = require("node:assert/strict");
const vm = require("vm");

function load(platform) {
  const calls = [];
  const fsp = { rename: async (from, to) => { calls.push([from, to]); return "renamed"; } };
  const ctx = { process: { platform }, setTimeout, require: (m) => (m === "fs/promises" ? fsp : m === "module" ? { syncBuiltinESMExports() {} } : require(m)) };
  ctx.globalThis = ctx;
  vm.runInNewContext(require("../../rename-retry.js"), ctx);
  return { g: ctx, fsp, calls };
}
const busy = (code) => Object.assign(new Error(code), { code });

test("Windows: a busy file is retried until it frees up; the result comes back", async () => {
  const { g } = load("win32");
  let n = 0;
  const r = await g.__cbRetryBusy(async () => { if (++n < 3) throw busy("EBUSY"); return "removed"; }, ["EPERM", "EBUSY", "EACCES", "ENOTEMPTY"]);
  assert.deepEqual([r, n], ["removed", 3]);
});

test("Windows: any other error fails at once; a file that stays busy fails after about 1.3 s", async () => {
  const { g } = load("win32");
  let n = 0;
  await assert.rejects(g.__cbRetryBusy(async () => { n++; throw busy("ENOENT"); }), { code: "ENOENT" });
  assert.equal(n, 1);
  n = 0;
  const t0 = Date.now();
  await assert.rejects(g.__cbRetryBusy(async () => { n++; throw busy("ENOTEMPTY"); }, ["EBUSY", "ENOTEMPTY"]), { code: "ENOTEMPTY" });
  assert.equal(n, 9, "the first try and 8 retries");
  assert.ok(Date.now() - t0 >= 1200, "10, 20, 40 … 320 ms between them");
});

test("Windows: the rename still goes through it, with its own codes", async () => {
  const { fsp, calls } = load("win32");
  assert.equal(await fsp.rename("a", "b"), "renamed");
  assert.deepEqual(calls, [["a", "b"]]);
});

test("elsewhere: nothing is defined, and the patched calls run once, as Cardboard's own", () => {
  const { g, fsp } = load("darwin");
  assert.equal(g.__cbRetryBusy, undefined);
  assert.equal(g.__cbRenameRetry, undefined);
  assert.equal(typeof fsp.rename, "function");
});
