// The store bridge's reads of project.json and timeline.tsx (scripts/carton/store-bridge.js): in a bundle Carton
// tracks, a file caught in an install's gap (missing for a moment) is waited for, not taken for a removed project;
// in any other bundle, for any other error, and once it stays missing, the read fails as Cardboard's own does.
//   node --test scripts/carton/test/store-bridge.test.js
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs"), os = require("os"), path = require("path");

const load = (on) => {
  const saved = process.env.CARDBOARD_CARTON;
  process.env.CARDBOARD_CARTON = on ? "1" : "";
  try { return new Function("require", require("../store-bridge.js")({ dir: '"unused"', slice: "((d) => d)", who: "cli" }) + "return __carton;")(require); }
  finally { process.env.CARDBOARD_CARTON = saved ?? ""; if (saved === undefined) delete process.env.CARDBOARD_CARTON; }
};
const ROOT = path.join(process.env.CARTON_TEST_DIR ?? os.tmpdir(), "store-bridge-" + process.pid);
const bundle = (name, { tracked = false, installing = false } = {}) => {
  const b = path.join(ROOT, name + ".cardboard");
  fs.rmSync(b, { recursive: true, force: true });
  fs.mkdirSync(b, { recursive: true });
  if (tracked) fs.mkdirSync(path.join(b, ".carton"));
  if (installing) fs.mkdirSync(path.join(b, ".carton", "install.lock"));
  return b;
};
test.after(() => fs.rmSync(ROOT, { recursive: true, force: true }));

test("off: no read of Carton's", () => {
  assert.equal(load(false).readFile, undefined);
});

test("a project.json caught while Carton installs it is waited for", async () => {
  const c = load(true), b = bundle("installing", { tracked: true, installing: true }), f = path.join(b, "project.json");
  // The install: the name is missing for a while, then the new file is linked in and the lock goes.
  setTimeout(() => { fs.writeFileSync(f, '{"project":{"id":"p"}}'); fs.rmSync(path.join(b, ".carton", "install.lock"), { recursive: true }); }, 120);
  assert.equal(await c.readFile(f), '{"project":{"id":"p"}}');
});

test("a read that fails just as the install ends reads again before giving up", async () => {
  const c = load(true), b = bundle("late", { tracked: true, installing: true }), f = path.join(b, "project.json");
  const fsp = require("fs/promises"), real = fsp.readFile;
  let calls = 0;
  // The first read fails late: by the time its error arrives, the file is in place and the lock is gone.
  fsp.readFile = async (...a) => {
    if (calls++ > 0) return real(...a);
    await new Promise((r) => setTimeout(r, 80));
    fs.writeFileSync(f, "{}");
    fs.rmSync(path.join(b, ".carton", "install.lock"), { recursive: true });
    throw Object.assign(new Error("ENOENT: no such file"), { code: "ENOENT" });
  };
  try { assert.equal(await c.readFile(f), "{}"); } finally { fsp.readFile = real; }
});

test("a file that stays missing fails as before: at once outside Carton's bundles, after a moment in them", async () => {
  const c = load(true);
  await assert.rejects(c.readFile(path.join(bundle("untracked"), "project.json")), { code: "ENOENT" });
  await assert.rejects(c.readFile(path.join(bundle("tracked", { tracked: true }), "timeline.tsx")), { code: "ENOENT" });
});

test("any other error fails at once", async () => {
  const c = load(true), b = bundle("folder", { tracked: true, installing: true });
  fs.mkdirSync(path.join(b, "project.json"));
  const t0 = Date.now();
  await assert.rejects(c.readFile(path.join(b, "project.json")), (e) => e.code !== "ENOENT");
  assert.ok(Date.now() - t0 < 3000, "it didn't wait for the install");
});
