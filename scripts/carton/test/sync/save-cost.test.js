// What a GUI save costs the library worker with Carton on, as counts that don't depend on the machine's speed or load
// (count-calls.cjs in the worker), so the per-save cost can't grow without a test failing. Cardboard's real worker and
// bundles, as the other sync tests (support.js). Run alone or through slot.sh:
//   CARDBOARD_PRISTINE=<Cardboard 1.4.0 unpacked> node --test --test-concurrency=1 scripts/carton/test/sync/save-cost.test.js
// The bounds are generous on purpose (about 1.5x what a save measured when they were set, Linux; see each), so only
// a real change of the save path trips them, and the message says what grew. Timings are save-bench.js's job.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs"), path = require("path");
const S = require("./support.js");

const ITEMS = 60, SAVES = 10;
const t = { skip: S.skip || S.noBuild, timeout: 300_000 };

/** A timeline with a clip and `n` titles. */
const timeline = (n) => `export default (\n  <timeline aspect="16:9">\n    <track name="V1">\n      <clip src="clip.mp4" start={0} end={2} />\n    </track>\n    <track name="Titles">\n${Array.from({ length: n }, (_, i) => `      <text name="T${i}" start={${(i * 0.5).toFixed(1)}} end={${(i * 0.5 + 0.4).toFixed(1)}} fontSize={100} textContent="Title ${i}" />`).join("\n")}\n    </track>\n  </timeline>\n);\n`;

test("a GUI save with Carton on: no discarded print, one projection per changed item, a bounded number of file calls", t, async (tc) => {
  const b = await S.build();
  const pc = await S.computer("save-cost", b);
  const must = (x, what) => assert.equal(x.code, 0, what + ": " + x.out + x.err);
  must(pc.cb(["project", "create", "Demo"]), "create");
  must(pc.cb(["media", "add", "Demo", b.clip]), "media add");
  const file = path.join(pc.home, "t.tsx");
  fs.writeFileSync(file, timeline(ITEMS));
  must(pc.cb(["source", "apply", "Demo", file]), "apply");
  const tsx = path.join(pc.root, "Demo.cardboard", "timeline.tsx");
  try {
    await pc.startWorker({ NODE_OPTIONS: [process.env.NODE_OPTIONS, "--require", path.join(__dirname, "count-calls.cjs")].filter(Boolean).join(" ") });
    const id = (await pc.call("projects.list"))[0].id;
    // One edit per save, as the editor saves it, then until timeline.tsx (the Materializer's) shows it, then a pause as
    // long as the editor's own save debounce (300 ms), so the work a save leaves for later (the review of what its
    // install moved aside) is counted with it.
    const save = async (i) => {
      const size = 101 + i;
      await S.guiSave(pc, id, (it) => (it.type === "text" && it.name === "T0" ? { ...it, fontSize: size } : null));
      await S.until(() => fs.readFileSync(tsx, "utf8").includes(`fontSize={${size}}`), 10_000, "timeline.tsx to show save " + i);
      await S.sleep(400);
    };
    for (let i = 0; i < 3; i++) await save(i); // the first saves open Carton and start the Materializer
    assert.notEqual(await pc.call("test.counters"), null, "count-calls.cjs is loaded in the worker");
    for (let i = 3; i < 3 + SAVES; i++) await save(i);
    const c = await pc.call("test.counters");
    const per = (n) => n / SAVES;
    const calls = Object.entries(c.byCall).sort((x, y) => y[1] - x[1]).map(([k, n]) => `${k} ${per(n)}`).join(", ");
    // every count, whichever assertion fails (and in the output when none does)
    const all = `per save: ${per(c.fs)} file system calls, ${per(c.mirror)} discarded prints, ${per(c.project)} projections; ${calls}`;
    tc.diagnostic(all);
    // Cardboard's mirror prints the whole timeline after each save; where the Materializer owns timeline.tsx that print
    // was written to a temp file and deleted unread (store bridge mirrorOwned).
    assert.equal(c.mirror, 0, "Cardboard's print of timeline.tsx is skipped while the Materializer owns the file; " + all);
    // P (the editor's save projection) runs only for items changed since the base: 1 per save here, plus the odd
    // record core rebuilt; without the facade's cache it ran for all ITEMS on every save.
    assert.ok(per(c.project) <= 3, `P ran ${per(c.project)} times per save (bound 3, ${ITEMS} items); ` + all);
    // File system calls per save in the worker: Cardboard's own save (project.json, .revs, its scaffold), Carton's
    // install of project.json (lock, displace, journal, seen hashes), the Materializer's rewrite of timeline.tsx, and
    // the review of displaced files. Bound: ~1.5x the 86 counted when it was set (Linux, 60 items); each is a round
    // trip through NTFS on Windows.
    assert.ok(per(c.fs) <= 130, `${per(c.fs)} file system calls per save (bound 130); ` + all);
  } finally {
    await pc.stopWorker();
    S.killHelpers();
  }
});

// ⌘Z with Carton on (the facade's undo, as the editor calls it through carton:call): the undo goes through
// @carton/local's write path, which told the Materializer a `cb` call happened, and the shared timeline.tsx then stayed
// frozen for a minute as if an agent were working: any agent reading it saw the state before the undo, and none of the
// person's edits that followed. The person in the app is no agent; their undo shows at once, as their saves do.
test("the person's ⌘Z shows in timeline.tsx at once, and so do the edits after it (the app's undo freezes nothing)", t, async () => {
  const b = await S.build();
  const pc = await S.computer("undo-shows", b);
  const must = (x, what) => assert.equal(x.code, 0, what + ": " + x.out + x.err);
  must(pc.cb(["project", "create", "Demo"]), "create");
  must(pc.cb(["media", "add", "Demo", b.clip]), "media add");
  const file = path.join(pc.home, "t.tsx");
  fs.writeFileSync(file, timeline(1));
  must(pc.cb(["source", "apply", "Demo", file]), "apply");
  const tsx = path.join(pc.root, "Demo.cardboard", "timeline.tsx");
  const shows = (size, what) => S.until(() => fs.readFileSync(tsx, "utf8").includes(`fontSize={${size}}`), 5_000, what);
  try {
    await pc.startWorker();
    const id = (await pc.call("projects.list"))[0].id;
    const save = (size) => S.guiSave(pc, id, (it) => (it.type === "text" ? { ...it, fontSize: size } : null));
    await save(111);
    await shows(111, "timeline.tsx to show the first save");
    await save(122);
    await shows(122, "timeline.tsx to show the second save");
    const r = await pc.call("carton.undo", { projectId: id });
    assert.equal(r.status, "confirmed", JSON.stringify(r));
    assert.equal((await S.projectOf(pc, id)).timelineItems.find((i) => i.type === "text").fontSize, 111, "project.json has the undo");
    await shows(111, "timeline.tsx to show the undo (it stayed frozen for a minute)");
    await save(133);
    await shows(133, "timeline.tsx to show the save after the undo");
  } finally {
    await pc.stopWorker();
    S.killHelpers();
  }
});
