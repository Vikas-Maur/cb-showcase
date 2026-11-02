// ui-words #4: a `cb` that nothing names (no CARDBOARD_ACTOR) is recorded through @carton/local's identity chain, never
// as an agent called "cli" (History showed "cli" as the author of the person's own `cb media add`). A person at a
// terminal is the terminal user (History tells it as "You"); Claude Code, Codex or Gemini are recognised from their
// environment and named by their product.
//   CARDBOARD_PRISTINE=<Cardboard 1.4.0 unpacked> node --test --test-concurrency=1 scripts/carton/test/sync/cb-authors.test.js
const test = require("node:test");
const assert = require("node:assert/strict");
const S = require("./support.js");

const t = { skip: S.skip || S.noBuild, timeout: S.TEST_MS };
let b, pc;

test.before(async () => {
  if (t.skip) return;
  b = await S.build();
  pc = await S.computer("cb-authors", b);
}, { timeout: S.SETUP_MS });
test.after(() => S.killHelpers(), { timeout: S.STOP_MS });

const authors = () => {
  const r = pc.cb(["history", "Demo"]);
  assert.equal(r.code, 0, r.out + r.err);
  return r.json().versions.map((v) => v.by).filter(Boolean);
};

test("a cb with no actor is the person at the terminal, or the agent CLI its environment says; never 'cli'", t, () => {
  const must = (r, what) => assert.equal(r.code, 0, `${what}: ${r.out}${r.err}`);
  must(pc.cb(["project", "create", "Demo"]), "create");
  must(pc.cb(["media", "add", "Demo", b.clip]), "media add by the person");
  const person = authors().find((a) => a.id !== "import");
  assert.ok(person, "the media add has an author");
  assert.equal(person.kind, "external");
  assert.match(person.id, /^terminal:/);
  for (const a of authors()) assert.notEqual(a.id, "cli");
  // the same command from Claude Code's terminal
  must(pc.cb(["media", "add", "Demo", b.clip2], { CLAUDECODE: "1" }), "media add by Claude Code");
  const claude = authors().find((a) => a.provider === "claude-code");
  assert.ok(claude, JSON.stringify(authors()));
  assert.deepEqual([claude.kind, claude.name], ["agent", "Claude Code"]);
});

// Regress 2026-11-02 #1: Claude Code from a terminal with no Carton hook (CLAUDECODE=1, nothing in CARDBOARD_ACTOR) edits
// its own view of the project while the person edits in the app. Its view saves are credited to the view (`external:
// .scratch/views/<name>.tsx`, so two such agents on one machine stay apart), which the History panel and the conflict
// card read as the person's: "You", and "Keep later" on Claude Code's side toasted "Kept yours". `cb history` named it.
// Cardboard's real library worker (started from the Start menu: no agent environment), its History panel as a page
// reads it (remoteUi's protocol over `carton.ui`).
const fs = require("fs"), path = require("path");
const ACTORS = path.join(__dirname, "..", "..", "..", "..", "carton", "packages", "react", "src", "actors.ts");

async function openPanel(pc, id, client) {
  let calls = 0;
  const msgs = () => pc.events().filter((e) => e.change?.kind === "carton" && e.change.client === client).map((e) => e.change.message);
  const state = () => {
    const s = { topics: {}, history: [], actors: new Map() };
    const learn = (list) => { for (const a of list ?? []) s.actors.set(a.key, a); };
    for (const x of msgs()) {
      if (x.t === "init") { s.topics = { ...x.topics }; s.history = x.history.slice(); learn([x.me]); learn(x.actors); }
      if (x.t === "topic") { s.topics[x.topic] = x.value; learn(x.actors); }
      if (x.t === "history") { for (const [i, v] of x.rows) s.history[i] = v; s.history.length = x.length; learn(x.actors); }
    }
    return s;
  };
  const send = (message) => pc.call("carton.ui", { projectId: id, client, message });
  assert.equal((await send({ t: "hello" }))?.status, "ok", "the History panel opens");
  await S.until(() => msgs().some((x) => x.t === "init"), 20_000, "the panel's init");
  return {
    state,
    actor: (a) => (typeof a === "string" ? state().actors.get(a) : a),
    call: async (method, ...args) => {
      const n = ++calls;
      await send({ t: "call", id: n, method, args });
      const ret = await S.until(() => msgs().find((x) => x.t === "ret" && x.id === n), 30_000, "the panel's " + method);
      if (!ret.ok) throw new Error(`panel ${method}: ${ret.error}`);
      return ret.value;
    },
  };
}

test("Claude Code's view saves from a terminal (CLAUDECODE=1) are Claude Code's in History and on the conflict card, never You", t, async () => {
  const { actorLabel } = await import(require("url").pathToFileURL(ACTORS).href);
  const cc = await S.computer("cb-authors-view", b);
  try {
    S.seed(cc, b);
    await cc.startWorker();
    const id = (await cc.call("projects.list"))[0]?.id;
    assert.ok(id, "the library lists the project");
    const panel = await openPanel(cc, id, "page-1");
    // Claude Code prints its own view (no hook: it is known by its environment only)
    const pr = cc.cb(["source", "print", "Demo", "--view", "cc"], { CLAUDECODE: "1" });
    assert.equal(pr.code, 0, "print --view: " + pr.out + pr.err);
    const view = path.join(cc.root, "Demo.cardboard", ".scratch", "views", "cc.tsx"), status = view.replace(/\.tsx$/, ".status");
    const printed = fs.readFileSync(view, "utf8");
    assert.match(printed, /fontSize=\{140\}/, "the view is at head");
    // the person changes the title's size in the app; Claude Code, on its print from before, changes it otherwise and
    // moves the title (which lands)
    await S.guiSave(cc, id, (it) => (it.type === "text" ? { ...it, fontSize: 150 } : undefined));
    const saved = Date.now();
    fs.writeFileSync(view, printed.replace("fontSize={140}", "fontSize={170}").replace("start={0.5}", "start={0.75}"));
    const st = await S.until(() => { try { const s = JSON.parse(fs.readFileSync(status, "utf8")); return s.at >= saved - 1000 && s.status !== "pending" && s; } catch { return null; } }, 30_000, "the view's .status");
    assert.equal(st.status, "conflicts", "the size clashes: " + JSON.stringify(st));
    // cb history names it (as it did)
    const top = historyOf(cc)[0];
    assert.match(top.by?.name ?? "", /^Claude Code/, "cb history: " + JSON.stringify(top.by));

    // The History panel: Claude Code's save is Claude Code's, the person's GUI save is You
    const v = await S.until(() => panel.state().history.find((x) => x.change === top.change || x.id === top.change), 20_000, "the view save in the panel");
    const by = panel.actor(v.author);
    const label = (a) => actorLabel(a, (k) => panel.state().actors.get(k), "You");
    assert.deepEqual({ kind: by?.kind, label: label(by) }, { kind: "agent", label: "Claude Code" }, "the view save's author in History: " + JSON.stringify(by));
    // The conflict card: yours (the app's 150) against Claude Code's (170), never "your earlier / later edit"
    const card = await S.until(() => (panel.state().topics.conflicts ?? []).find((c) => /fontSize|size/i.test(c.path)), 20_000, "the card in the panel");
    const mine = panel.actor(card.mine.author), theirs = panel.actor(card.theirs.author);
    assert.deepEqual({ mine: label(mine), mineYou: !!mine?.isYou, theirs: label(theirs), theirsKind: theirs?.kind }, { mine: "You", mineYou: true, theirs: "Claude Code", theirsKind: "agent" }, JSON.stringify(card));
    // Its pick on Claude Code's side is "Kept Claude Code's" (ui.js's toast reads the side's label), and takes 170
    await panel.call("resolve", card.id, "theirs");
    await S.until(async () => S.textOf(await S.projectOf(cc, id)).fontSize === 170, 20_000, "Claude Code's size in the project");
  } finally {
    await cc.stopWorker();
  }
});
// `cb history` of the project, newest first
function historyOf(pc) {
  const r = pc.cb(["history", "Demo", "--limit", "20"]);
  assert.equal(r.code, 0, r.out + r.err);
  return r.json().versions;
}
