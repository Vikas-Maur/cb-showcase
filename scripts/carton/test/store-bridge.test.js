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

// A materialization whose head moved before its turn in the store's chain (the facade's commit answers "stale"): the
// bridge writes nothing and the store keeps the document it had, so a GUI save that went first stays in project.json
// (review P1 of the fold-author fix). Any other answer goes on as before.
test("a stale materialization writes nothing: the store keeps its document", async () => {
  const dir = path.join(ROOT, "facade-stale");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "carton-node.cjs"), `
    exports.cardboard14 = { commit: async ({ base, doc, meta }) => (meta?.head === "moved" ? { doc: base, status: "stale" } : { doc, status: "materialized" }) };
  `);
  const saved = process.env.CARTON_DIR;
  process.env.CARTON_DIR = dir;
  try {
    const c = load(true);
    const saved0 = { id: "p", stateUpdatedAt: 5, timelineItems: [{ id: "a", startTime: 0, endTime: 2, fontSize: 166 }] };
    const store = {
      options: { root: ROOT },
      byId: new Map([["p", { bundlePath: path.join(ROOT, "p.cardboard"), document: saved0 }]]),
      async __cartonApplyMutation(id, mutate) {
        const e = this.byId.get(id), next = mutate(e.document);
        this.byId.set(id, { ...e, document: next });
        return { document: next, changed: true };
      },
    };
    // the older head's document, merged in by the store's scope (as the patched updateScoped tells the bridge)
    const older = (head) => (d) => (c.scope({ ownedFields: ["timelineItems"], carton: { materialize: true, head } }), { ...d, stateUpdatedAt: 6, timelineItems: [{ id: "a", startTime: 0, endTime: 2, fontSize: 140 }] });
    const res = await c.applyMutation(store, "p", older("moved"));
    assert.deepEqual(res, { document: saved0, changed: false }, "nothing to write");
    assert.equal(store.byId.get("p").document, saved0, "the store keeps the save");
    const ok = await c.applyMutation(store, "p", older("same"));
    assert.equal(ok.changed, true);
    assert.equal(store.byId.get("p").document.timelineItems[0].fontSize, 140, "a materialization whose head is still head goes in");
  } finally {
    if (saved === undefined) delete process.env.CARTON_DIR; else process.env.CARTON_DIR = saved;
  }
});

// Laptop, final candidate P1-1: the loaders' project from a project.json whose media entries have no dates (an earlier
// restore wrote them so) goes to the facade (completeMedia); one whose entries have them never loads the facade.
test("loaded: a project with media Cardboard's editor can't save is completed by the facade; a complete one is left alone, the facade unloaded", () => {
  const dir = path.join(ROOT, "facade-loaded");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "carton-node.cjs"), `
    globalThis.__loadedFacade = (globalThis.__loadedFacade ?? 0) + 1;
    exports.cardboard14 = { completeMedia: (p, b) => ({ ...p, media: p.media.map((m) => ({ createdAt: "2026-11-02T00:00:00.000Z", addedAt: "2026-11-02T00:00:00.000Z", ...m })), bundle: b }) };
  `);
  const saved = process.env.CARTON_DIR;
  process.env.CARTON_DIR = dir;
  try {
    const c = load(true);
    const at = "2026-11-01T00:00:00.000Z";
    const whole = { project: { id: "p", media: [{ id: "m", createdAt: at, addedAt: at, data: { type: "video" } }, { id: "t", createdAt: at, addedAt: at, data: { type: "text", format: "text", size: 0, presetId: "custom" } }] }, media: [] };
    assert.equal(c.loaded("/b", whole), whole, "complete: as it was");
    assert.equal(c.loaded("/b", { project: { id: "p" }, media: [] }).project.id, "p", "no media list");
    assert.equal(globalThis.__loadedFacade, undefined, "carton-node.cjs isn't loaded for them");
    const recovered = { project: { id: "p", media: [{ id: "m", data: { type: "video" } }] }, media: [{ mediaId: "m" }] };
    const out = c.loaded("/b", recovered);
    assert.deepEqual(out.project.media[0], { createdAt: "2026-11-02T00:00:00.000Z", addedAt: "2026-11-02T00:00:00.000Z", id: "m", data: { type: "video" } });
    assert.equal(out.project.bundle, "/b");
    assert.equal(out.media, recovered.media, "the manifest as read");
    // an unreadable date, or a title without what Cardboard's own have, asks too
    const unreadable = { project: { id: "p", media: [{ id: "m", createdAt: "t", addedAt: at }] }, media: [] };
    assert.equal(c.loaded("/b", unreadable).project.bundle, "/b", "the facade was asked");
    const title = { project: { id: "p", media: [{ id: "t", createdAt: at, addedAt: at, data: { type: "text" } }] }, media: [] };
    assert.equal(c.loaded("/b", title).project.bundle, "/b");
  } finally {
    delete globalThis.__loadedFacade;
    if (saved === undefined) delete process.env.CARTON_DIR; else process.env.CARTON_DIR = saved;
  }
});
