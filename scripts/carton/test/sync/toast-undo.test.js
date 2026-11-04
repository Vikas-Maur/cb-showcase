// UX redesign PLAN 5.3 in Cardboard's real (patched) library worker under Node, the History panel driven as a page
// drives it and the toast's Undo and Redo sent as the renderer bridge sends them (carton.undo / carton.redo with
// `only`, Ctrl+Z's own path): Undo takes back exactly what the action made, and a second Ctrl+Z still works; Redo puts
// it back; something on top since, and the toast's Undo does nothing ("moved"); Ctrl+Z of a restore says so ("told").
//   CARDBOARD_PRISTINE=<Cardboard 1.4.0 unpacked> node --test --test-concurrency=1 scripts/carton/test/sync/toast-undo.test.js
const test = require("node:test");
const assert = require("node:assert/strict");
const S = require("./support.js");

const t = { skip: S.skip || S.noBuild, timeout: S.TEST_MS * 2 };
let b;
test.before(async () => { if (!t.skip) b = await S.build(); }, { timeout: S.SETUP_MS });
test.after(() => S.killHelpers(), { timeout: S.STOP_MS });

/** The History panel on a computer, as a page reads it (fold-undo.test.js): History's rows and its calls. */
async function openPanel(pc, id, client) {
  const msgs = () => pc.events().filter((e) => e.change?.kind === "carton" && e.change.client === client).map((e) => e.change.message);
  const send = (message) => pc.call("carton.ui", { projectId: id, client, message });
  assert.equal((await send({ t: "hello" }))?.status, "ok", "the History panel opens");
  await S.until(() => msgs().some((x) => x.t === "init"), 20_000, "the panel's init");
  const history = () => {
    let h = [];
    for (const x of msgs()) {
      if (x.t === "init") h = x.history.slice();
      if (x.t === "history") { for (const [i, v] of x.rows) h[i] = v; h.length = x.length; }
    }
    return h;
  };
  let calls = 0;
  const call = async (method, ...args) => {
    const n = ++calls;
    await send({ t: "call", id: n, method, args });
    const ret = await S.until(() => msgs().find((x) => x.t === "ret" && x.id === n), 30_000, "the panel's " + method);
    if (!ret.ok) throw new Error(`panel ${method}: ${ret.error}`);
    return ret.value;
  };
  return { history, call };
}

test("PLAN 5.3: a restore's toast Undo takes back exactly the restore; Redo; something on top since: nothing; Ctrl+Z still works", t, async () => {
  const pc = await S.computer("toast-undo-app", b);
  try {
    S.seed(pc, b);
    await pc.startWorker();
    const id = (await pc.call("projects.list"))[0]?.id;
    const panel = await openPanel(pc, id, "page-1");
    const since = Date.now(); // the editor opened the project (the bridge's cartonSince)
    const step = (which, only) => pc.call(`carton.${which}`, { projectId: id, since, ...(only ? { only } : {}) });
    const font = async () => S.textOf(await S.projectOf(pc, id)).fontSize;
    const f0 = await font();
    // the person's edit, then a restore of the version before it (the panel's, as History's Restore makes it)
    const n0 = panel.history().length;
    await S.guiSave(pc, id, (it) => (it.type === "text" ? { ...it, fontSize: f0 + 10 } : undefined));
    await S.until(() => panel.history().length > n0, 20_000, "the edit's row");
    const before = panel.history().at(-2);
    const restored = await panel.call("restore", before.ref);
    assert.equal(restored?.made?.changes?.length, 1, "the restore says the version it made: " + JSON.stringify(restored));
    assert.equal(await font(), f0, "restored");

    // the toast's Undo: exactly the restore; the edit before it stays
    const u = await step("undo", restored.made);
    assert.deepEqual([u.status, u.told, u.made?.changes?.length], ["confirmed", "undo-restore", 1], JSON.stringify(u));
    assert.equal(await font(), f0 + 10, "the restore taken back, your edit kept");
    assert.ok(u.project, "the project it wrote, for the editor to adopt at once (Ctrl+Z's path)");
    // its Redo, by the undo's own version
    const r = await step("redo", u.made);
    // (a redo says nothing of what it was: the toast's own Redo knows it; only an undo reads it, cheaply)
    assert.deepEqual([r.status, r.told], ["confirmed", undefined], JSON.stringify(r));
    assert.equal(await font(), f0);

    // an edit since: the toast's Undo now would take that back instead, so it does nothing
    await S.guiSave(pc, id, (it) => (it.type === "text" ? { ...it, fontSize: f0 + 20 } : undefined));
    await S.until(async () => (await font()) === f0 + 20, 20_000, "the later edit");
    const moved = await step("undo", r.made);
    assert.equal(moved.status, "moved", JSON.stringify(moved));
    assert.equal(await font(), f0 + 20, "nothing changed");
    assert.deepEqual(moved.can, { undo: true, redo: false }, "what is left, for the buttons");
    // a stale redo too
    assert.equal((await step("redo", u.made)).status, "moved");
    // Ctrl+Z still takes the newest back, then the restore (its redo), and says it was the restore's
    const z1 = await step("undo");
    assert.equal(z1.status, "confirmed");
    assert.equal(z1.told, undefined, "an edit's undo: nothing to tell");
    assert.equal(await font(), f0);
    const z2 = await step("undo");
    assert.deepEqual([z2.status, z2.told, z2.made?.changes?.length], ["confirmed", "undo-restore", 1], JSON.stringify(z2));
    assert.equal(await font(), f0 + 10);
    // nonsense asked for: nothing done
    assert.equal((await step("undo", { cut: 7, changes: [] })).status, "moved");
    assert.equal(await font(), f0 + 10);
  } finally {
    await pc.stopWorker();
  }
});

test("PLAN 5.3: one Undo takes back every version an action made, newest first, and only those", t, async () => {
  const pc = await S.computer("toast-undo-two", b);
  try {
    S.seed(pc, b);
    await pc.startWorker();
    const id = (await pc.call("projects.list"))[0]?.id;
    const panel = await openPanel(pc, id, "page-1");
    const since = Date.now();
    const step = (which, only) => pc.call(`carton.${which}`, { projectId: id, since, ...(only ? { only } : {}) });
    const font = async () => S.textOf(await S.projectOf(pc, id)).fontSize;
    const f0 = await font();
    const n0 = panel.history().length;
    await S.guiSave(pc, id, (it) => (it.type === "text" ? { ...it, fontSize: f0 + 10 } : undefined));
    await S.until(() => panel.history().length > n0, 20_000, "the edit's row");
    const start = panel.history().at(-2), edit = panel.history().at(-1);
    // two versions in a row (as a fold with an earlier partial fold's rest makes): two restores, one after the other
    const one = await panel.call("restore", start.ref);
    const two = await panel.call("restore", edit.ref);
    const made = { cut: one.made.cut, changes: [...one.made.changes, ...two.made.changes] };
    assert.equal(await font(), f0 + 10);
    // in the wrong order, or with one that isn't on top: nothing
    assert.equal((await step("undo", { cut: made.cut, changes: [...made.changes].reverse() })).status, "moved");
    assert.equal((await step("undo", { cut: made.cut, changes: [one.made.changes[0]] })).status, "moved", "the older alone isn't on top");
    assert.equal(await font(), f0 + 10, "nothing changed");
    // both, newest first, in one Undo
    const u = await step("undo", made);
    assert.equal(u.status, "confirmed", JSON.stringify(u));
    assert.equal(u.made?.changes?.length, 2, "two undo versions, which the Redo takes back: " + JSON.stringify(u.made));
    assert.equal(await font(), f0 + 10, "back to the edit, before both restores");
    const r = await step("redo", u.made);
    assert.equal(r.status, "confirmed", JSON.stringify(r));
    assert.equal(await font(), f0 + 10, "both restores again: the second one's state");
    assert.deepEqual(r.can, { undo: true, redo: false });
    // and the edit before them is still Ctrl+Z's, after the two
    await step("undo", r.made);
    const z = await step("undo");
    assert.equal(z.status, "confirmed");
    assert.equal(await font(), f0, "a second Ctrl+Z still works: the edit taken back");
  } finally {
    await pc.stopWorker();
  }
});
