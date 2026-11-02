// One editor action, one version and one undo step (laptop, merge/prod-2 N-1): deleting a title saves its timeline
// (debounced, 300 ms) and, on its own, the removal of the title's "Text: W6" media entry, in either order. Carton made a
// version of each; one Ctrl+Z took back only the newer one: the title stayed gone (media saved last), or came back with
// no media entry (media saved first). Adding a title saves twice the same way. Stock Cardboard's undo takes back both.
// Through Cardboard 1.4.0's real (patched) library worker, local and shared, with the real renderer bridge in a
// stand-in of the editor store's save path as patch-carton leaves it (installErrorTelemetry-*.js: Kx's media cleanup,
// the debounce de() and its flush cN(), Jt's scope slicing Kj, updateScoped's send; EditorRoute's iu for a title add).
// What only the real app shows: the editor's own timers and cr.remove's time (which order the saves come in), the
// stage repainting from the adopted project.
//   CARDBOARD_PRISTINE=<Cardboard 1.4.0 unpacked> node --test --test-concurrency=1 scripts/carton/test/sync/one-action.test.js
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs"), path = require("path");
const S = require("./support.js");

const t = { skip: S.skip || S.noBuild, timeout: S.TEST_MS };
const TIMELINE = ["tracks", "timelineItems"];
// The laptop's project (mkproj): one clip, then titles W1–W6 on their own track, made by a terminal's cb
const TSX = `export default (\n  <timeline aspect="16:9">\n    <track name="Mine">\n      <clip src="clip.mp4" start={0} end={3} />\n    </track>\n    <track name="Agents">\n${Array.from({ length: 6 }, (_, k) => `      <text name="W${k + 1}" start={${k}} end={${k + 1}} fontSize={100} textContent="W${k + 1}" />`).join("\n")}\n    </track>\n  </timeline>\n);\n`;
const NAMES = ["timeline-first", "media-first", "answered-first", "title-add", "cb-undo", "repeated-delete", "shared-timeline-first", "shared-media-first"];
const SHARED = new Set(["shared-timeline-first", "shared-media-first"]);
let b = null, host = null, pc = null, ids = null;

test.before(async () => {
  if (t.skip) return;
  b = await S.build();
  host = await S.startHost(path.join(S.TMP, "one-action-host"));
  pc = await S.computer("one-action", b);
  const must = (x, what) => assert.equal(x.code, 0, what + ": " + x.out + x.err);
  const file = path.join(pc.home, "t.tsx");
  fs.writeFileSync(file, TSX);
  for (const name of NAMES) {
    must(pc.cb(["project", "create", name]), "create " + name);
    must(pc.cb(["media", "add", name, b.clip]), "media add " + name);
    must(pc.cb(["source", "apply", name, file]), "apply " + name);
  }
  await pc.startWorker();
  ids = Object.fromEntries((await pc.call("projects.list")).map((p) => [p.name, p.id]));
  for (const name of SHARED) {
    const r = await pc.call("carton.liveShare", { projectId: ids[name], host: host.origin, adminToken: S.ADMIN, name: "Alice" });
    assert.equal(r.status, "shared", JSON.stringify(r));
    await S.until(async () => { const s = await pc.call("carton.liveStatus", { projectId: ids[name] }); return s.status === "up-to-date" && s.holder; }, 20_000, name + " shared, the worker holding the lease");
  }
}, { timeout: S.SETUP_MS });
test.after(async () => {
  await pc?.stopWorker();
  S.killHelpers();
  await host?.stop().catch(() => {});
}, { timeout: S.STOP_MS });

const iso = () => new Date().toISOString();
/** What a test saw against what it wants, said whole (node's diff skips lines) when they differ. */
const same = (name, got, want) => {
  if (!require("util").isDeepStrictEqual(got, want)) console.log(`[one-action] ${name} saw ${JSON.stringify(got)}`);
  assert.deepEqual(got, want);
};
const tick = () => new Promise((r) => setImmediate(r));

/**
 * The editor of project `id` as the patched bundle runs it, Carton on, its session starting now. Its saves go to the
 * worker as main sends them (the page's meta in the scope as `carton`, the person's). `sent`: every project:patch.
 */
async function editorOf(id) {
  const window = {};
  new Function("window", require("../../renderer-bridge.js"))(window);
  const B = window.__carton;
  const doc = await S.projectOf(pc, id);
  let project = structuredClone(doc); // the project store's record (De)
  let state = { projectId: id, cartonBase: doc.stateUpdatedAt ?? null, cartonPreview: null, cartonSince: Date.now(), cartonCanUndo: false, cartonCanRedo: false, tracks: doc.tracks, timelineItems: doc.timelineItems, aspectRatio: doc.aspectRatio };
  let timer = null, clock = Date.now(), step = null;
  const inflight = new Set(), sent = [];
  // main's project:patch (patch-carton's main hook): the page's meta joins the scope, the person's
  const On = (document, scope, carton) => {
    sent.push(scope);
    return pc.call("projects.updateScoped", document, carton ? { ...scope, carton: { ...carton, actor: "person" } } : scope).then((r) => r !== null);
  };
  // Ss.updateScoped, patched: updateScoped:(t,e)=>Zp(t.id,cK(e),window.__carton.send(t,e,()=>On("project:patch",…)))
  const updateScoped = (d, e) => (B.send ? B.send(d, e, () => On(d, e, B.saveMeta(d, e))) : On(d, e, B.saveMeta(d, e)));
  // Jt: qj copies the scope, Kj cuts the document down to it (its owned fields; only the media entries it owns)
  const Jt = (d, e) => {
    const n = { ownedMediaIds: e.ownedMediaIds ? [...e.ownedMediaIds] : undefined, removedMediaIds: e.removedMediaIds ? [...e.removedMediaIds] : undefined, ownedFields: e.ownedFields ? [...e.ownedFields] : undefined };
    const own = new Set(n.ownedMediaIds ?? []), out = {};
    for (const f of n.ownedFields ?? []) out[f] = d[f];
    return updateScoped({ ...out, id: d.id, updatedAt: d.updatedAt, stateUpdatedAt: d.stateUpdatedAt, media: (d.media ?? []).filter((m) => own.has(m.id)) }, n);
  };
  const board = (scope) => (B.board ? B.board(id, scope) : scope);
  // the timer's save (and cN's): Qy gives the record the editor's timeline and a new stateUpdatedAt, then Jt saves it
  const timelineSave = () => {
    project = { ...project, tracks: state.tracks, timelineItems: state.timelineItems, updatedAt: iso(), stateUpdatedAt: (clock = Math.max(clock + 1, Date.now())) };
    const p = Jt(project, board({ ownedFields: TIMELINE }));
    const q = p.catch(() => {}).finally(() => inflight.delete(q));
    inflight.add(q);
    return p;
  };
  const de = () => { clearTimeout(timer); timer = setTimeout(() => { timer = null; timelineSave(); }, 300); };
  const cN = () => { if (!timer) return { work: Promise.all([...inflight]) }; clearTimeout(timer); timer = null; return { work: timelineSave() }; };
  B.store({
    state: () => state,
    raw: (p) => (state = { ...state, ...p }),
    adopt: (p) => (state = { ...state, ...p }),
    armed: () => timer !== null,
    inflight: () => inflight.size > 0,
    flush: () => cN().work,
    invoke: async (channel, { method, args }) => {
      if (channel !== "carton:call") return null;
      if (method === "enabled") return true;
      const r = pc.call("carton." + method, ...args);
      if (method === "undo" || method === "redo") step = r;
      return r;
    },
    on: () => () => {},
    deserialize: (d) => d,
    projects: { getState: () => ({ projects: [project] }), setState: (s) => (project = s.projects.find((p) => p.id === id) ?? project) },
  });
  assert.equal(await B.ready, true);
  return {
    B, sent, state: () => state, record: () => project,
    // the Delete key on a selection: removeTimelineItems (a history entry, the timeline, de()), then Kx: each removed
    // item's own text or code media entry is dropped from the record at once (removeMediaFromProject), and saved once
    // its cached files are gone (cr.remove: `removed`, which the test resolves)
    remove(itemIds, removed) {
      const gone = new Set(itemIds), before = state.timelineItems;
      state = { ...state, timelineItems: before.filter((i) => !gone.has(i.id)) };
      de();
      const used = new Set(state.timelineItems.map((i) => i.mediaItemId));
      const own = new Set(before.filter((i) => gone.has(i.id)).map((i) => i.mediaItemId).filter((m) => m !== undefined && !used.has(m)));
      const saves = [];
      for (const m of project.media) {
        if (!own.has(m.id) || !["text", "code"].includes(m.data?.type)) continue;
        B.ride?.(id, { removedMediaIds: [m.id] });
        const u = { ...project, media: project.media.filter((x) => x.id !== m.id), updatedAt: iso() };
        project = { ...project, media: project.media.filter((x) => x.id !== m.id), updatedAt: iso() };
        saves.push(removed.then(() => Jt(u, { removedMediaIds: [m.id] })));
      }
      return saves;
    },
    // EditorRoute's iu: the title's "Text: …" entry into the record, addTimelineItem (history, timeline, de()), then the
    // entry's own save after a dynamic import's then
    addTitle(name, like, at) {
      const m = `media-${name}`, entry = { ...structuredClone(project.media.find((x) => x.id === like.mediaItemId)), id: m, createdAt: iso(), addedAt: iso() };
      entry.data = { ...entry.data, content: name, fileName: `Text: ${name}` };
      project = { ...project, media: [...project.media, entry], updatedAt: iso() };
      state = { ...state, timelineItems: [...state.timelineItems, { ...like, id: `item-${name}`, name, mediaItemId: m, textContent: name, startTime: at, endTime: at + 1 }] };
      de();
      const g = project;
      B.ride?.(id, { ownedMediaIds: [m] });
      return Promise.resolve().then(() => Jt(g, { ownedMediaIds: [m] }));
    },
    // Ctrl+Z / Ctrl+Shift+Z: the bridge takes it (true), and adopts the project its answer carries
    async press(which) {
      step = null;
      assert.equal(B[which](), true, which + " is Carton's");
      await S.until(() => step, 10_000, which + " sent");
      await step;
      for (let i = 0; i < 5; i++) await tick();
    },
  };
}

const versions = (name) => pc.cb(["history", name, "--json"]).json().versions;
const changesOf = (name, seq) => pc.cb(["compare", name, `main@${seq - 1}`, `main@${seq}`]).json().changes;
const titles = (doc) => doc.timelineItems.filter((i) => i.type === "text").map((i) => i.name).sort();
const textMedia = (doc) => doc.media.filter((m) => m.data?.type === "text").map((m) => m.data.fileName).sort();
const W = (...n) => n.map((k) => `W${k}`);
const shows = (...n) => ({ titles: W(...n), media: n.map((k) => `Text: W${k}`), editor: W(...n) });
const ALL = shows(1, 2, 3, 4, 5, 6), FIVE = shows(1, 2, 3, 4, 5);
/** The project as the worker holds it (project.json's document) and as the editor shows it, once it stops moving. */
async function seen(name, ed) {
  if (SHARED.has(name)) await S.until(async () => (await pc.call("carton.liveStatus", { projectId: ids[name] })).pending === 0, 20_000, "every edit confirmed");
  let last = null;
  for (let i = 0; i < 30; i++) {
    const d = await S.projectOf(pc, ids[name]);
    const now = { titles: titles(d), media: textMedia(d), editor: ed.state().timelineItems.filter((x) => x.type === "text").map((x) => x.name).sort() };
    if (last && JSON.stringify(last) === JSON.stringify(now)) return now;
    last = now;
    await S.sleep(100);
  }
  return last;
}
/** The versions made since `n0`, oldest first, each as `cb compare` words it. */
const made = (name, n0) => { const v = versions(name); return v.slice(0, v.length - n0).reverse().map((x) => changesOf(name, x.ref.seq)); };

/**
 * Delete W6 with its media entry's save in `order`, then Ctrl+Z, Ctrl+Shift+Z, Ctrl+Z as the person presses them. All
 * that is seen is compared at the end, so a run that fails shows the whole of what happened.
 */
async function deleteThenUndo(name, order) {
  const ed = await editorOf(ids[name]);
  const n0 = versions(name).length;
  const w6 = ed.state().timelineItems.find((i) => i.name === "W6");
  let free;
  const saves = ed.remove([w6.id], new Promise((r) => (free = r)));
  assert.equal(saves.length, 1, "W6 owns one media entry");
  // media-first: the entry's cached files gone before the debounce, its save first. timeline-first (the laptop's): a
  // moment after the timeline save went, after its 300 ms. answered-first: after that save was answered too.
  if (order !== "media-first") await S.until(() => ed.sent.length === 1, 5_000, "the timeline save, after its 300 ms");
  if (order === "answered-first") await S.until(async () => titles(await S.projectOf(pc, ids[name])).length === 5, 10_000, "the timeline save answered");
  free();
  await Promise.all(saves);
  await S.sleep(400); // no save left behind a debounce
  const got = { saves: ed.sent.length, afterDelete: await seen(name, ed), versions: made(name, n0) };
  await ed.press("undo");
  got.afterUndo = await seen(name, ed);
  got.undoVersions = versions(name).length - n0 - got.versions.length;
  await ed.press("redo");
  got.afterRedo = await seen(name, ed);
  await ed.press("undo");
  got.afterUndoAgain = await seen(name, ed);
  same(name, got, { saves: 1, afterDelete: FIVE, versions: [["Deleted title 'W6'"]], afterUndo: ALL, undoVersions: 1, afterRedo: FIVE, afterUndoAgain: ALL });
}

test("N-1: a title's delete with its media entry saved after the timeline save (the laptop's order): one version, one undo step", t, async () => {
  await deleteThenUndo("timeline-first", "timeline-first");
});

test("N-1: a title's delete with its media entry saved first: one version, and one Ctrl+Z brings back the title with its entry", t, async () => {
  await deleteThenUndo("media-first", "media-first");
});

test("N-1: the media entry's save after the timeline save was answered: still the one version, the one undo step", t, async () => {
  await deleteThenUndo("answered-first", "answered-first");
});

test("N-1: adding a title (its media entry saved on its own first): one version, and one Ctrl+Z takes both back", t, async () => {
  const ed = await editorOf(ids["title-add"]);
  const n0 = versions("title-add").length;
  const w1 = ed.state().timelineItems.find((i) => i.name === "W1");
  await ed.addTitle("W7", w1, 7);
  await S.sleep(400);
  const got = { saves: ed.sent.length, afterAdd: await seen("title-add", ed), versions: made("title-add", n0) };
  await ed.press("undo");
  got.afterUndo = await seen("title-add", ed);
  await ed.press("redo");
  got.afterRedo = await seen("title-add", ed);
  const seven = shows(1, 2, 3, 4, 5, 6, 7);
  same("title-add", got, { saves: 1, afterAdd: seven, versions: [["Added title 'W7' on 'Agents' at 7.0 s"]], afterUndo: ALL, afterRedo: seven });
});

test("N-1: cb undo from a terminal takes back the whole delete too", t, async () => {
  const ed = await editorOf(ids["cb-undo"]);
  const w5 = ed.state().timelineItems.find((i) => i.name === "W5");
  let free;
  const saves = ed.remove([w5.id], new Promise((r) => (free = r)));
  free();
  await Promise.all(saves);
  await S.sleep(400);
  const got = { afterDelete: await seen("cb-undo", ed) };
  const r = pc.cb(["undo", "cb-undo"]);
  assert.equal(r.code, 0, r.out + r.err);
  const d = await S.projectOf(pc, ids["cb-undo"]);
  got.afterCbUndo = { titles: titles(d), media: textMedia(d) };
  same("cb-undo", got, { afterDelete: shows(1, 2, 3, 4, 6), afterCbUndo: { titles: ALL.titles, media: ALL.media } });
});

test("N-1 (review #1): the same title deleted again after an undo, both entries' saves late: each delete takes back whole", t, async () => {
  const name = "repeated-delete", ed = await editorOf(ids[name]);
  const n0 = versions(name).length;
  const w6 = () => ed.state().timelineItems.find((i) => i.name === "W6");
  let freeFirst, freeSecond;
  const first = ed.remove([w6().id], new Promise((r) => (freeFirst = r)));
  await S.until(() => ed.sent.length === 1, 5_000, "the first delete's timeline save");
  await ed.press("undo");
  const got = { afterFirstUndo: await seen(name, ed) };
  // deleted again while the first delete's entry save still waits for its cached files
  const second = ed.remove([w6().id], new Promise((r) => (freeSecond = r)));
  await S.until(() => ed.sent.length === 2, 5_000, "the second delete's timeline save");
  freeFirst();
  await Promise.all(first);
  got.afterLateFirst = await seen(name, ed);
  await ed.press("undo");
  got.afterSecondUndo = await seen(name, ed);
  freeSecond();
  await Promise.all(second);
  await S.sleep(400);
  got.afterLateSecond = await seen(name, ed);
  got.saves = ed.sent.length;
  got.versions = made(name, n0);
  same(name, got, { afterFirstUndo: ALL, afterLateFirst: FIVE, afterSecondUndo: ALL, afterLateSecond: ALL, saves: 2, versions: [["Deleted title 'W6'"], ["Added title 'W6' on 'Agents' at 5.0 s"], ["Deleted title 'W6'"], ["Added title 'W6' on 'Agents' at 5.0 s"]] });
});

test("N-1, shared project: a title's delete (timeline saved first) is one change pushed, one version, one undo step", t, async () => {
  await deleteThenUndo("shared-timeline-first", "timeline-first");
});

test("N-1, shared project: a title's delete (media saved first) is one change pushed, one version, one undo step", t, async () => {
  await deleteThenUndo("shared-media-first", "media-first");
});
