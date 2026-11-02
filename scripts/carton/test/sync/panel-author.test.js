// Laptop #2 (fold author): every version the person makes from the History panel is the person's, whatever the
// app's own environment says. The panel's writes run in the library worker on the project's Carton handle, which a
// project that isn't shared opens with the worker process's identity (@carton/local's chain: CARDBOARD_ACTOR, then the
// agent CLI or terminal its environment shows). A write that named no author fell back to it: a Fold in from the panel
// was "Terminal" in `cb history` when the app was started from the Start menu, and "Claude Code" when it was started
// from a shell with CLAUDECODE=1. Each worker here runs Cardboard's real (patched) library worker under Node; one with
// no agent environment, one with CLAUDECODE=1. The panel is driven as a page drives it (remoteUi over `carton.ui`).
//   CARDBOARD_PRISTINE=<Cardboard 1.4.0 unpacked> node --test --test-concurrency=1 scripts/carton/test/sync/panel-author.test.js
const test = require("node:test");
const assert = require("node:assert/strict");
const S = require("./support.js");

const t = { skip: S.skip || S.noBuild, timeout: S.TEST_MS * 2 };
let b;
test.before(async () => { if (!t.skip) b = await S.build(); }, { timeout: S.SETUP_MS });
test.after(() => S.killHelpers(), { timeout: S.STOP_MS });

/** The editor's History panel on a computer, as a page reads it (remoteUi's protocol over the worker's `carton.ui`). */
async function openPanel(pc, id, client) {
  let calls = 0;
  const msgs = () => pc.events().filter((e) => e.change?.kind === "carton" && e.change.client === client).map((e) => e.change.message);
  const state = () => {
    const s = { topics: {}, history: [] };
    for (const x of msgs()) {
      if (x.t === "init") { s.topics = { ...x.topics }; s.history = x.history.slice(); }
      if (x.t === "topic") s.topics[x.topic] = x.value;
      if (x.t === "history") { for (const [i, v] of x.rows) s.history[i] = v; s.history.length = x.length; }
    }
    return s;
  };
  const send = (message) => pc.call("carton.ui", { projectId: id, client, message });
  assert.equal((await send({ t: "hello" }))?.status, "ok", "the History panel opens");
  await S.until(() => msgs().some((x) => x.t === "init"), 20_000, "the panel's init");
  return {
    state,
    call: async (method, ...args) => {
      const n = ++calls;
      await send({ t: "call", id: n, method, args });
      const ret = await S.until(() => msgs().find((x) => x.t === "ret" && x.id === n), 30_000, "the panel's " + method);
      if (!ret.ok) throw new Error(`panel ${method}: ${ret.error}`);
      return ret.value;
    },
  };
}

/** The Comments tab, as a page reads it (remoteComments over the worker's `carton.comments`). */
async function openComments(pc, id, client) {
  let calls = 0;
  const msgs = () => pc.events().filter((e) => e.change?.kind === "carton" && e.change.client === client).map((e) => e.change.message);
  const send = (message) => pc.call("carton.comments", { projectId: id, client, message });
  assert.equal((await send({ t: "c-hello" }))?.status, "ok", "the Comments tab opens");
  await S.until(() => msgs().some((x) => x.t === "c-init"), 20_000, "the comments' init");
  return {
    threads: () => {
      const byId = new Map();
      for (const x of msgs()) {
        if (x.t === "c-init") { byId.clear(); for (const th of x.threads) byId.set(th.id, th); }
        if (x.t === "c-threads") for (const th of x.changed) byId.set(th.id, th);
      }
      return [...byId.values()];
    },
    call: async (method, ...args) => {
      const n = ++calls;
      await send({ t: "c-call", id: n, method, args });
      const ret = await S.until(() => msgs().find((x) => x.t === "c-ret" && x.id === n), 30_000, "the comments' " + method);
      if (!ret.ok) throw new Error(`comments ${method}: ${ret.error}`);
    },
  };
}

// `cb history` of a cut (read again if it caught project.json in an install's gap: "No project matches")
const history = (pc, cut) => {
  let r;
  for (let i = 0; i < 5; i++) {
    r = pc.cb(["history", "Demo", "--cut", cut, "--limit", "100"]);
    if (r.code === 0) return r.json().versions;
  }
  assert.fail(r.out + r.err);
};
// how many versions a cut has now, 0 while cb can't read the project (an install's gap)
const count = (pc, cut) => { const r = pc.cb(["history", "Demo", "--cut", cut, "--limit", "100"]); return r.code === 0 ? r.json().versions.length : 0; };
const who = (v) => `${v.kind} ${v.version} by ${JSON.stringify(v.by)}`;
const newest = (pc, cut) => history(pc, cut)[0];
const isPerson = (v) => v.by?.kind === "human" && v.by?.id === "person";

for (const [name, env] of [["no agent environment (the Start menu)", {}], ["CLAUDECODE=1 (started from Claude Code's shell)", { CLAUDECODE: "1" }]]) {
  test(`the History panel's writes are the person's: worker with ${name}`, t, async () => {
    const pc = await S.computer("panel-author-" + (env.CLAUDECODE ? "claude" : "plain"), b);
    try {
      S.seed(pc, b);
      await pc.startWorker(env);
      const id = (await pc.call("projects.list"))[0]?.id;
      assert.ok(id, "the library lists the project");
      const panel = await openPanel(pc, id, "page-1");
      const cuts = () => panel.state().topics.cuts ?? [];
      const main = cuts().find((c) => c.current);
      assert.ok(main, "the panel shows the current cut: " + JSON.stringify(cuts()));
      const mainSeen = history(pc, main.id).length;

      // New cut from here: the fork's own version ("Made this cut") is the person's.
      // (the panel lists versions oldest first: the newest is the last row)
      const head = panel.state().history.at(-1);
      const alt = await panel.call("newCut", "Alt cut", head.ref);
      assert.ok(alt?.id && alt.id !== main.id, "a new cut: " + JSON.stringify(alt));
      await S.until(() => cuts().find((c) => c.current)?.id === alt.id, 20_000, "the panel on the new cut");
      const fork = history(pc, alt.id).find((v) => v.kind === "fork");
      assert.ok(fork && isPerson(fork), "Made this cut is the person's: " + history(pc, alt.id).map(who).join("; "));

      // Rename cut: a label, no version.
      await panel.call("renameCut", alt.id, "Alt cut");
      // An edit on the new cut (the editor's save, on the cut it shows).
      await S.guiSave(pc, id, (it) => (it.type === "text" ? { ...it, fontSize: 150 } : undefined));
      await S.until(() => count(pc, alt.id) >= 2, 20_000, "the edit on the new cut");

      // Name this version.
      await S.until(() => panel.state().history.at(-1)?.kind === "edit", 20_000, "the edit in the panel");
      await panel.call("nameVersion", panel.state().history.at(-1).id, "Rough cut");

      // Fold into Main cut, the Fold dialog's "Fold in".
      const plan = await panel.call("planFold", alt.id, main.id);
      assert.ok(plan.changes.length >= 1, "the fold brings the edit in: " + JSON.stringify(plan));
      assert.deepEqual(await panel.call("fold", alt.id, main.id, { choices: {}, leaveOut: [] }), { ok: true });
      const folded = newest(pc, main.id);
      assert.equal(folded.kind, "merge", "Main cut gets the fold: " + who(folded));
      assert.ok(isPerson(folded), "the Fold in is the person's: " + who(folded));

      // A partial fold (one change left out), then "Fold in the rest" on Main.
      await S.guiSave(pc, id, (it) => (it.type === "text" ? { ...it, textContent: "Alt words" } : it.type === "video" ? { ...it, opacity: 0.5 } : undefined));
      await S.until(() => count(pc, alt.id) >= 3, 20_000, "the second edit on the new cut");
      const plan2 = await panel.call("planFold", alt.id, main.id);
      assert.ok(plan2.changes.length >= 2, "two records to fold: " + JSON.stringify(plan2.changes));
      const left = plan2.changes.find((c) => /opacity|0\.5/i.test(c.summary)) ?? plan2.changes[1];
      assert.deepEqual(await panel.call("fold", alt.id, main.id, { choices: {}, leaveOut: [left.id] }), { ok: true });
      assert.ok(isPerson(newest(pc, main.id)), "the partial fold is the person's: " + who(newest(pc, main.id)));
      await panel.call("switchCut", main.id);
      const rest = await S.until(() => panel.state().history.find((v) => v.foldRest), 20_000, "Fold in the rest offered");
      assert.equal(S.videoOf(await S.projectOf(pc, id)).opacity ?? 1, 1, "the left-out change isn't in Main yet");
      assert.deepEqual(await panel.call("foldRest", rest.id), { ok: true });
      // "Fold in the rest" reaches the project the editor shows (Main is the cut shown)
      assert.ok(isPerson(newest(pc, main.id)), "Fold in the rest is the person's: " + who(newest(pc, main.id)));
      await S.until(async () => S.videoOf(await S.projectOf(pc, id)).opacity === 0.5, 20_000, "the rest in project.json");

      // Restore an earlier version of Main: the one before the folds (main@0 is the empty start).
      await panel.call("restore", `${main.id}@${mainSeen - 1}`);
      assert.deepEqual([newest(pc, main.id).kind, isPerson(newest(pc, main.id))], ["restore", true], "the restore is the person's: " + who(newest(pc, main.id)));

      // Undo (the panel's Undo of the person's newest change).
      const undo = await S.until(() => panel.state().topics.undo, 20_000, "the panel's Undo");
      assert.deepEqual(await panel.call("undo", undo.id), { ok: true });
      assert.ok(isPerson(newest(pc, main.id)), "the panel's Undo is the person's: " + who(newest(pc, main.id)));

      // A conflict card's "Keep yours": a GUI save made on an older version clashes with the undo's change since.
      const older = await S.projectOf(pc, id);
      await S.guiSave(pc, id, (it) => (it.type === "text" ? { ...it, fontSize: 171 } : undefined));
      await pc.call("projects.updateScoped", { ...older, timelineItems: older.timelineItems.map((it) => (it.type === "text" ? { ...it, fontSize: 172 } : it)), stateUpdatedAt: Date.now() }, { ownedFields: ["tracks", "timelineItems"], carton: { base: older.stateUpdatedAt, actor: "person" } });
      const card = await S.until(() => (panel.state().topics.conflicts ?? [])[0], 20_000, "the conflict card in the panel");
      const before = history(pc, main.id).length;
      await panel.call("resolve", card.id, "mine");
      assert.equal(history(pc, main.id).length, before + 1, "Keep yours is a version");
      assert.ok(isPerson(newest(pc, main.id)), "Keep yours is the person's: " + who(newest(pc, main.id)));

      // A comment, from the Comments tab.
      const comments = await openComments(pc, id, "page-1-comments");
      await comments.call("add", "Tighter here", undefined);
      const thread = await S.until(() => comments.threads()[0], 20_000, "the comment's thread");

      // Every version the panel made, on both cuts, is the person's; none is the worker's own identity.
      const altVs = history(pc, alt.id), mainVs = history(pc, main.id);
      const made = [altVs.find((v) => v.kind === "fork"), ...mainVs.slice(0, mainVs.length - mainSeen)];
      assert.ok(made.length >= 7, "fork, fold, partial fold, rest, restore, undo, keep yours: " + made.map(who).join("; "));
      for (const v of made) assert.ok(isPerson(v), "the person's: " + who(v));
      for (const kind of ["merge", "restore"]) assert.ok(made.some((v) => v.kind === kind), `a ${kind}: ` + made.map(who).join("; "));
      // the version named in the panel keeps its name, and was named by the person (cb history's raw rows say so)
      assert.ok(altVs.some((v) => v.name === "Rough cut"), "the named version: " + altVs.map(who).join("; "));
      // the comment is the person's ("You"), never the worker's identity
      assert.equal(thread.root.author.id, "person", "the comment's author: " + JSON.stringify(thread.root));
      assert.ok(thread.root.mine, "the comment is the person's own");
      // "Keep yours" put the person's value back
      assert.equal(S.textOf(await S.projectOf(pc, id)).fontSize, 172, "the person's kept value is in the project");
    } finally {
      await pc.stopWorker();
    }
  });
}
