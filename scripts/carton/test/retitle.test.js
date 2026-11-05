// Review of a2725f9c #4: a turn's name and its short title never write over a name someone gave meanwhile. The
// worker's own handlers (carton-node.js's nameTurn and retitleTurn, read out of the file) run on real core with a real
// History panel (@carton/react's fromCarton on the same Carton, as the worker opens one), and the person's rename lands
// in the gap each one had: after the handler read the version's name, before it wrote; and after its write, before
// the panels were told.
//   node --test scripts/carton/test/retitle.test.js
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs"), path = require("path");

const CARTON = path.join(__dirname, "..", "..", "..", "carton", "packages");
const handler = (name) => {
  const src = fs.readFileSync(path.join(__dirname, "..", "carton-node.js"), "utf8");
  const a = src.indexOf(`      ${name}: async `), b = src.indexOf("\n      },\n", a);
  assert.ok(a > 0 && b > a, `the worker's ${name}`);
  return src.slice(a + `      ${name}: `.length, b + "\n      }".length);
};
const make = (name, deps) => new Function(...Object.keys(deps), "return " + handler(name))(...Object.values(deps));

async function setup() {
  const { Carton, defineSchema } = await import(path.join(CARTON, "core", "src", "index.ts"));
  const { createMemoryStore } = await import(path.join(CARTON, "store-memory", "src", "index.ts"));
  const { fromCarton } = await import(path.join(CARTON, "react", "src", "from-carton.ts"));
  const schema = defineSchema({ collections: { items: { key: "id" } } });
  const adapter = { name: "t", schema, schemaVersion: 1, fromHost: (d) => d, toHost: (d) => d };
  const me = { kind: "human", id: "person", name: "Vikas" };
  const director = { kind: "agent", id: "director/c1/t1", name: "Director", chat: "c1", turn: "t1" };
  const c = await Carton.open({ adapter, store: createMemoryStore(), init: { doc: { items: [{ id: "a", x: 0 }] }, cutName: "Main" }, actor: me });
  await c.commit({ ops: [{ op: "set", path: ["items", "a", "x"], value: 1 }], author: director });
  const ui = fromCarton(c, { me });
  await ui.ready;
  const v = (await c.log({ limit: 1 }))[0];
  const row = v.change ?? `${v.ref.branchId}@${v.ref.seq}`;
  const ref = `${v.ref.branchId}@${v.ref.seq}`;
  const nameNow = async () => (await c.log({ limit: 1 }))[0].name;
  const panelName = () => ui.history().all().at(-1).name;
  return { c, ui, row, ref, nameNow, panelName, close: async () => { ui.dispose?.(); await c.close(); } };
}
// a Carton whose first log() (the handler's read) waits for `gate`, and whose first name() (the handler's write) runs
// `after` once it is done, before the handler goes on to tell the panels
const gated = (c, o = {}) => {
  let entered, release, wrote = false;
  const ready = new Promise((r) => (entered = r)), gate = new Promise((r) => (release = r));
  return {
    ready, release,
    carton: {
      log: async (...a) => { const v = await c.log(...a); if (o.gateRead) { o.gateRead = false; entered(); await gate; } return v; },
      name: async (...a) => { const r = await c.name(...a); if (!wrote && o.after) { wrote = true; await o.after(); } return r; },
      diff: (...a) => c.diff(...a),
    },
  };
};
const deps = (lc, ui) => ({ lcOf: async () => lc, panels: new Map([["/b", new Set([ui])]]), bundleOf: () => "/b", turnLabel: (p) => String(p).split(". ")[0], safePart: (x) => x });

test("retitleTurn: a rename between its read and its write is kept (the title never writes over it)", async () => {
  const s = await setup();
  try {
    await s.c.name(s.ref, "Make intro bigger");
    const g = gated(s.c, { gateRead: true });
    const retitle = make("retitleTurn", deps({ carton: g.carton }, s.ui));
    const pending = retitle({ projectId: "p", ref: s.ref, was: "Make intro bigger", title: "Larger intro", asked: "Make intro bigger please" });
    await g.ready;
    await s.ui.nameVersion(s.row, "My final intro"); // the person, in the panel
    g.release();
    assert.equal((await pending).status, "kept");
    assert.equal(await s.nameNow(), "My final intro", "the person's name stays");
    assert.equal(s.panelName(), "My final intro");
  } finally { await s.close(); }
});

test("retitleTurn: a rename between its write and the panels being told is kept (the panel never writes the title back)", async () => {
  const s = await setup();
  try {
    await s.c.name(s.ref, "Make intro bigger");
    const g = gated(s.c, { after: () => s.ui.nameVersion(s.row, "My final intro") });
    const retitle = make("retitleTurn", deps({ carton: g.carton }, s.ui));
    assert.equal((await retitle({ projectId: "p", ref: s.ref, was: "Make intro bigger", title: "Larger intro", asked: "Make intro bigger please" })).status, "named");
    assert.equal(await s.nameNow(), "My final intro", "the person's later name stays in the project");
    assert.equal(s.panelName(), "My final intro", "and in History");
    // with no rename meanwhile, the title shows in the panel, with the request beside it
    const t = await setup();
    try {
      await t.c.name(t.ref, "Make intro bigger");
      const retitle2 = make("retitleTurn", deps({ carton: t.c }, t.ui));
      assert.equal((await retitle2({ projectId: "p", ref: t.ref, was: "Make intro bigger", title: "Larger intro", asked: "Make intro bigger please" })).status, "named");
      assert.equal(t.panelName(), "Larger intro");
      assert.equal(t.ui.history().all().at(-1).asked, "Make intro bigger please");
    } finally { await t.close(); }
  } finally { await s.close(); }
});

test("nameTurn: a name the person gave between its read and its write is kept; no title asked for it", async () => {
  const s = await setup();
  try {
    const g = gated(s.c, { gateRead: true });
    const nameTurn = make("nameTurn", deps({ carton: g.carton }, s.ui));
    const pending = nameTurn({ projectId: "p", chat: "c1", turn: "t1", prompt: "Make the intro bigger. Then stop", changes: true });
    await g.ready;
    await s.ui.nameVersion(s.row, "Intro, final");
    g.release();
    const r = await pending;
    assert.equal(r.status, "named");
    assert.equal(r.changes, undefined, "someone named it: no title to make");
    assert.equal(await s.nameNow(), "Intro, final");
    assert.equal(s.panelName(), "Intro, final");
  } finally { await s.close(); }
});
