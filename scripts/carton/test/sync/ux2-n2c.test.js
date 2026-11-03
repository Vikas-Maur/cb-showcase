// Carton UX v2 N2c in Cardboard's real library worker: the History panel's `cutHistory`, another cut's versions read
// through the worker (carton.log({ cut })), a page at a time, newest first, each in History's words, for "Compare
// with…" a version on another cut. The editor stays on its cut while it reads.
//   CARDBOARD_PRISTINE=<Cardboard 1.4.0 unpacked> node --test --test-concurrency=1 scripts/carton/test/sync/ux2-n2c.test.js
const test = require("node:test");
const assert = require("node:assert/strict");
const S = require("./support.js");

const t = { skip: S.skip || S.noBuild, timeout: S.TEST_MS * 2 };
let b;
test.before(async () => { if (!t.skip) b = await S.build(); }, { timeout: S.SETUP_MS });
test.after(() => S.killHelpers(), { timeout: S.STOP_MS });

async function openPanel(pc, id, client) {
  const msgs = () => pc.events().filter((e) => e.change?.kind === "carton" && e.change.client === client).map((e) => e.change.message);
  const send = (message) => pc.call("carton.ui", { projectId: id, client, message });
  assert.equal((await send({ t: "hello" }))?.status, "ok", "the History panel opens");
  await S.until(() => msgs().some((x) => x.t === "init"), 20_000, "the panel's init");
  const cuts = () => {
    let c = [];
    for (const x of msgs()) {
      if (x.t === "init") c = x.topics.cuts ?? [];
      if (x.t === "topic" && x.topic === "cuts") c = x.value;
    }
    return c;
  };
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
  return { cuts, history, call };
}

test("N2c: cutHistory reads another cut's versions through the worker, newest first, in History's words, a page at a time", t, async () => {
  const pc = await S.computer("ux2-n2c", b);
  try {
    S.seed(pc, b);
    await pc.startWorker();
    const id = (await pc.call("projects.list"))[0]?.id;
    const panel = await openPanel(pc, id, "page-1");
    const main = panel.cuts().find((c) => c.current);
    // a new cut from Main's newest version, two edits on it, then back on Main
    const alt = await panel.call("newCut", "Alt cut", panel.history().at(-1).ref);
    await S.until(() => panel.cuts().find((c) => c.current)?.id === alt.id, 20_000, "the panel on the new cut");
    const n0 = panel.history().length;
    await S.guiSave(pc, id, (it) => (it.type === "text" ? { ...it, fontSize: 150 } : undefined));
    await S.until(() => panel.history().length > n0, 20_000, "the first edit on Alt cut");
    await S.guiSave(pc, id, (it) => (it.type === "text" ? { ...it, textContent: "Alt title" } : undefined));
    await S.until(() => panel.history().length > n0 + 1, 20_000, "the second edit on Alt cut");
    await panel.call("switchCut", main.id);
    await S.until(() => panel.cuts().find((c) => c.current)?.id === main.id, 20_000, "back on Main cut");
    const mainNewest = panel.history().at(-1)?.ref;

    // Alt cut's History, from Main: its two edits newest first, in History's words, then its start
    const all = await panel.call("cutHistory", alt.id);
    assert.equal(all.cutId, alt.id);
    assert.ok(all.versions.length >= 3, "its edits and its start: " + JSON.stringify(all.versions.map((v) => v.summary)));
    assert.ok(all.versions.every((v) => v.ref.startsWith(alt.id + "@") || v.ref.split("@")[0] === all.versions[0].ref.split("@")[0]), "versions of that cut: " + JSON.stringify(all.versions.map((v) => v.ref)));
    const seqs = all.versions.map((v) => v.seq);
    assert.deepEqual(seqs, [...seqs].sort((x, y) => y - x), "newest first");
    assert.match(all.versions[0].summary, /“Alt title”|title/i, "its newest edit in words: " + all.versions[0].summary);
    assert.ok(all.versions.every((v) => typeof v.at === "number" && v.author && typeof v.author.name === "string"), "who and when");
    assert.ok(!all.versions.some((v) => /[0-9a-f]{12,}/.test(v.summary)), "no ids in its words");
    assert.equal(all.before, undefined, "it reaches the cut's start");

    // a page at a time: one version, then the next from its cursor
    const p1 = await panel.call("cutHistory", alt.id, { limit: 1 });
    assert.equal(p1.versions.length, 1);
    assert.equal(p1.versions[0].ref, all.versions[0].ref);
    assert.equal(typeof p1.before, "number", "a cursor for the next page");
    const p2 = await panel.call("cutHistory", alt.id, { limit: 1, before: p1.before });
    assert.equal(p2.versions[0].ref, all.versions[1].ref, "the next page is the next older version");

    // the editor stayed on Main cut, its History unchanged by the read
    assert.equal(panel.cuts().find((c) => c.current)?.id, main.id);
    assert.equal(panel.history().at(-1)?.ref, mainNewest);
  } finally {
    await pc.stopWorker();
  }
});
