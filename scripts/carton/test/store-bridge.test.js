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

// A merged save's put-back: Carton's head, whose records core freezes, goes back into Cardboard's store, and
// Cardboard's code edits its store's documents in place. In sloppy code (as 1.4.0's bundles may run) a write to a
// frozen record is silently ignored: the edit would be lost with no error. The bridge hands the store a copy.
test("a merged save's put-back is Cardboard's own copy: an in-place edit sticks", async () => {
  const deepFreeze = (o) => { if (o && typeof o === "object" && !Object.isFrozen(o)) { Object.freeze(o); for (const v of Object.values(o)) deepFreeze(v); } return o; };
  // A facade whose commit merged someone else's change in: the document it hands back is head, frozen as core's are.
  const dir = path.join(ROOT, "facade");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "carton-node.cjs"), `
    const deepFreeze = ${deepFreeze.toString()};
    exports.cardboard14 = { commit: async ({ doc }) => ({ status: "confirmed", rebased: 1, merged: true,
      doc: deepFreeze({ ...doc, stateUpdatedAt: doc.stateUpdatedAt + 1, timelineItems: [{ id: "a", startTime: 0, endTime: 2 }, { id: "b", startTime: 2, endTime: 4 }] }) }) };
  `);
  const saved = process.env.CARTON_DIR;
  process.env.CARTON_DIR = dir;
  try {
    const c = load(true);
    const doc0 = { id: "p", stateUpdatedAt: 1, timelineItems: [{ id: "a", startTime: 0, endTime: 2 }] };
    const store = {
      options: { root: ROOT },
      byId: new Map([["p", { bundlePath: path.join(ROOT, "p.cardboard"), document: doc0 }]]),
      // 1.4.0's applyMutation: the mutation on the current document, the result kept as the entry's document.
      async __cartonApplyMutation(id, mutate) {
        const e = this.byId.get(id), next = mutate(e.document);
        this.byId.set(id, { ...e, document: next });
        return { document: next, changed: true };
      },
    };
    const res = await c.applyMutation(store, "p", (d) => ({ ...d, stateUpdatedAt: 2, timelineItems: d.timelineItems.map((i) => ({ ...i })) }));
    const kept = store.byId.get("p").document;
    assert.equal(kept, res.document, "the store and the caller continue from the same document");
    assert.equal(kept.timelineItems.length, 2, "head, with the merged change");
    // Cardboard's next edit, in place, in sloppy code (a Function body without "use strict").
    new Function("p", "p.timelineItems[1].startTime = 3; p.timelineItems.push({ id: 'c', startTime: 4, endTime: 5 }); p.name = 'Renamed';")(kept);
    assert.equal(kept.timelineItems[1].startTime, 3, "the edit to a merged record sticks");
    assert.equal(kept.timelineItems.length, 3, "and so does an added item");
    assert.equal(kept.name, "Renamed");
    assert.ok(!Object.isFrozen(kept) && !Object.isFrozen(kept.timelineItems[0]));
  } finally {
    if (saved === undefined) delete process.env.CARTON_DIR; else process.env.CARTON_DIR = saved;
  }
});
