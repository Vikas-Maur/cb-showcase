// The editor's Ctrl+Z and redo with Carton on, through Cardboard's real library worker and bundles (support.js), as the
// renderer bridge calls them (carton.undo / carton.redo with the editor session's start). Laptop report 90c4127:
//   bug 3: Ctrl+Z undoes the person's own edits and the agent turns they started in the app, in this session; never a
//          terminal's cb, never back past the session (the timeline a cb apply built stays);
//   bug 4: redo re-applies what the last undo took back, and clears on a new edit; the answer says what is left;
//   bug 6: an undo whose inverse clashes with a later change says why, as a card in the person's conflict stack.
// Run alone or through slot.sh:
//   CARDBOARD_PRISTINE=<Cardboard 1.4.0 unpacked> node --test --test-concurrency=1 scripts/carton/test/sync/undo.test.js
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs"), path = require("path");
const S = require("./support.js");

const t = { skip: S.skip || S.noBuild, timeout: S.TEST_MS };
const N = 6;
const timeline = (n) => `export default (\n  <timeline aspect="16:9">\n    <track name="V1">\n      <clip src="clip.mp4" start={0} end={2} />\n    </track>\n    <track name="Titles">\n${Array.from({ length: n }, (_, i) => `      <text name="T${i}" start={${i}} end={${i + 0.8}} fontSize={100} textContent="Title ${i}" />`).join("\n")}\n    </track>\n  </timeline>\n);\n`;
const size = (doc, name) => doc.timelineItems.find((i) => i.type === "text" && i.name === name)?.fontSize;

/** A computer with a project a terminal's cb built (before the editor's session), its worker started. */
async function project(b, name) {
  const pc = await S.computer(name, b);
  const must = (x, what) => assert.equal(x.code, 0, what + ": " + x.out + x.err);
  must(pc.cb(["project", "create", "Demo"]), "create");
  must(pc.cb(["media", "add", "Demo", b.clip]), "media add");
  const file = path.join(pc.home, "t.tsx");
  fs.writeFileSync(file, timeline(N));
  must(pc.cb(["source", "apply", "Demo", file]), "apply");
  await pc.startWorker();
  const id = (await pc.call("projects.list"))[0].id;
  const tsx = path.join(pc.root, "Demo.cardboard", "timeline.tsx");
  // a cb apply of the printed file with one title's size changed: CARDBOARD_ACTOR as main sets it for an agent the app
  // started, or empty for a terminal's cb
  const apply = async (title, value, actor = "") => {
    // head printed into timeline.tsx (as the writer's own `cb source print` does), then the title's element edited
    must(pc.cb(["source", "print", "Demo"], { CARDBOARD_ACTOR: actor }), "print");
    // the printer puts each attribute on its own line: the title's element, whole
    const text = fs.readFileSync(tsx, "utf8").replace(/<text\b[\s\S]*?\/>/g, (el) => (el.includes(`name="${title}"`) ? el.replace(/fontSize=\{\d+\}/, `fontSize={${value}}`) : el));
    assert.ok(text.includes(`fontSize={${value}}`), `the print has ${title}'s size`);
    const edit = path.join(pc.home, "edit.tsx");
    fs.writeFileSync(edit, text);
    must(pc.cb(["source", "apply", "Demo", edit], { CARDBOARD_ACTOR: actor }), `apply ${title}=${value}`);
  };
  const save = (title, value) => S.guiSave(pc, id, (it) => (it.type === "text" && it.name === title ? { ...it, fontSize: value } : undefined));
  return { pc, id, apply, save, must };
}

test("bug 3: Ctrl+Z undoes the person's edits and the app's agent turn in this session, never a terminal's cb, never past the session", t, async () => {
  const b = await S.build();
  const { pc, id, apply, save } = await project(b, "undo-scope");
  try {
    const since = Date.now(); // the editor opened the project (the bridge's cartonSince)
    await save("T0", 150); // the person
    await apply("T1", 160); // a terminal's cb
    await apply("T2", 170, "director/chat1/turn1"); // the Director, a turn the person started in the app
    await apply("T3", 180); // the terminal again
    const z = () => pc.call("carton.undo", { projectId: id, since });
    const z1 = await z();
    assert.equal(z1.status, "confirmed");
    let doc = await S.projectOf(pc, id);
    assert.deepEqual(["T0", "T1", "T2", "T3"].map((n) => size(doc, n)), [150, 160, 100, 180], "first the app's agent turn; the terminal's edits stay");
    assert.equal(size(z1.project, "T2"), 100, "the answer carries the project it wrote, for the editor to adopt");
    const z2 = await z();
    doc = await S.projectOf(pc, id);
    assert.deepEqual(["T0", "T1", "T2", "T3"].map((n) => size(doc, n)), [100, 160, 100, 180], "then the person's own edit");
    assert.deepEqual(z2.can, { undo: false, redo: true }, "nothing left to undo in this session");
    const z3 = await z();
    assert.equal(z3.status === "confirmed" && z3.empty, true, "a third Ctrl+Z changes nothing");
    doc = await S.projectOf(pc, id);
    assert.equal(doc.timelineItems.filter((i) => i.type === "text").length, N, "the timeline the terminal's cb built before the session stays");
    assert.deepEqual(["T1", "T3"].map((n) => size(doc, n)), [160, 180], "never a terminal's cb edit");
    assert.deepEqual(await pc.call("carton.undoState", { projectId: id, since }), { undo: false, redo: true });
  } finally {
    await pc.stopWorker();
    S.killHelpers();
  }
});

test("bug 4: redo re-applies what the last undo took back, as a new change, and clears on the person's next edit", t, async () => {
  const b = await S.build();
  const { pc, id, save } = await project(b, "undo-redo");
  try {
    const since = Date.now();
    await save("T0", 150);
    await save("T0", 160);
    assert.deepEqual(await pc.call("carton.undoState", { projectId: id, since }), { undo: true, redo: false });
    const u = await pc.call("carton.undo", { projectId: id, since });
    assert.equal(size(await S.projectOf(pc, id), "T0"), 150);
    assert.deepEqual(u.can, { undo: true, redo: true }, "the redo button is enabled after an undo");
    const r = await pc.call("carton.redo", { projectId: id, since });
    assert.equal(r.status, "confirmed", "redo is Carton's, not 'unavailable'");
    assert.equal(size(await S.projectOf(pc, id), "T0"), 160, "redone: the value the undo took back");
    assert.equal(size(r.project, "T0"), 160);
    assert.deepEqual(r.can, { undo: true, redo: false });
    // undo again, then a new edit: redo has nothing left
    await pc.call("carton.undo", { projectId: id, since });
    await save("T1", 130);
    assert.deepEqual(await pc.call("carton.undoState", { projectId: id, since }), { undo: true, redo: false }, "a new edit clears redo");
    const none = await pc.call("carton.redo", { projectId: id, since });
    assert.equal(none.status === "confirmed" && none.empty, true);
    const doc = await S.projectOf(pc, id);
    assert.deepEqual([size(doc, "T0"), size(doc, "T1")], [150, 130]);
  } finally {
    await pc.stopWorker();
    S.killHelpers();
  }
});

test("bug 6: undoing a split that a later edit changed says why, as a card in the person's conflict stack, and changes nothing", t, async () => {
  const b = await S.build();
  const { pc, id, apply } = await project(b, "undo-split");
  const client = "undo-split-panel";
  const msgs = () => pc.events().filter((e) => e.change?.kind === "carton" && e.change.client === client).map((e) => e.change.message);
  try {
    const since = Date.now();
    assert.equal((await pc.call("carton.ui", { projectId: id, client, message: { t: "hello" } }))?.status, "ok");
    const init = await S.until(() => msgs().find((x) => x.t === "init"), 20_000, "the panel");
    const cards = () => { const last = msgs().filter((x) => x.t === "topic" && x.topic === "conflicts").pop(); return (last ? last.value : init.topics.conflicts) ?? []; };
    // the person splits T4 in two: one save, the title shortened and its right half added (as the editor saves a split)
    const doc0 = await S.projectOf(pc, id);
    const t4 = doc0.timelineItems.find((i) => i.name === "T4");
    const half = { ...t4, id: t4.id + "b", name: "T4b", startTime: t4.startTime + 0.4, endTime: t4.endTime };
    const items = [...doc0.timelineItems.map((i) => (i.id === t4.id ? { ...i, endTime: t4.startTime + 0.4 } : i)), half];
    await pc.call("projects.updateScoped", { ...doc0, timelineItems: items, stateUpdatedAt: Date.now() }, { ownedFields: ["tracks", "timelineItems"], carton: { base: doc0.stateUpdatedAt, actor: "person", intents: [{ kind: "split", id: t4.id, at: t4.startTime + 0.4, into: [t4.id, half.id] }] } });
    // a terminal's cb then changes the right half
    await apply("T4b", 190);
    const before = await S.projectOf(pc, id);
    const r = await pc.call("carton.undo", { projectId: id, since });
    assert.equal(r.status, "conflicts", "the undo clashes with the later edit");
    assert.deepEqual((await S.projectOf(pc, id)).timelineItems, before.timelineItems, "nothing changed");
    await S.until(() => cards().length > 0, 20_000, "the card in the person's conflict stack");
    assert.match(cards()[0].reason ?? "", /^Not undone: this changed after your edit/, "it says why, in plain words");
    const kept = await pc.call("carton.notices", { bundlePath: path.join(pc.root, "Demo.cardboard"), actor: "person" });
    assert.ok(kept.some((n) => (n.cards ?? []).length), "kept for the person (cb conflicts, History)");
    // pressed again: the same card, kept once
    await pc.call("carton.undo", { projectId: id, since });
    const again = await pc.call("carton.notices", { bundlePath: path.join(pc.root, "Demo.cardboard"), actor: "person" });
    assert.equal(again.flatMap((n) => n.cards ?? []).length, kept.flatMap((n) => n.cards ?? []).length, "not kept twice");
  } finally {
    await pc.stopWorker();
    S.killHelpers();
  }
});
