// An agent's view-save cards on both sides (scripts/carton/sync/view-cards.js, the facade's `agentCards`): the facade as
// esbuild bundles it, on a real carton.db, in a child process (Carton's handles stay open in the process that opens
// them). The person edits a field while an agent's save from the same version sets it otherwise: the adapter's engine
// (`cartonMaterializerEngine`, as the Materializer commits a view save) keeps the person's value and keeps the agent's
// side as the agent's notice; the cards go through `api.agentCards`, as the sync half's Materializer `onCards` hands
// them over. The person's History panels are the facade's real `ui` service (serveUi messages, as a page gets them).
//   node --test --test-concurrency=1 scripts/carton/test/sync/view-cards.test.js
// Runs anywhere (no Cardboard bundles needed): the project is the conformance fixture Cardboard's CLI made.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs"), os = require("os"), path = require("path"), { spawnSync } = require("child_process");

const ROOT = path.join(__dirname, "..", "..", "..", "..");
const CARTON = path.join(ROOT, "carton");
const FIXTURE = path.join(CARTON, "packages", "conformance", "src", "cardboard", "fixtures", "sample", "project.json");
const noBuild = !fs.existsSync(path.join(CARTON, "node_modules", "esbuild")) && "run `pnpm install` in carton/ to build the facade";

const RUN = String.raw`
const fs = require("fs"), path = require("path");
const [file, bundle] = process.argv.slice(1);
const F = require(file);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const envelope = JSON.parse(fs.readFileSync(path.join(bundle, "project.json"), "utf8"));
const readProject = () => JSON.parse(fs.readFileSync(path.join(bundle, "project.json"), "utf8")).project;
const projectId = envelope.project.id;
const TEXT = envelope.project.timelineItems.find((i) => i.type === "text").id, VIDEO = envelope.project.timelineItems.find((i) => i.type === "video").id;
const library = { projects: {
  bundlePathFor: () => bundle,
  read: async () => readProject(),
  // what the store bridge does with a materialize: head into project.json
  updateScoped: async (next) => fs.writeFileSync(path.join(bundle, "project.json"), JSON.stringify({ ...envelope, project: next })),
} };
const messages = [];
let api = null;
F.extend({ name: "test", worker(a) { api = a; return {}; } });
const services = F.cardboard14.worker({ library, emit: (e) => e.kind === "carton" && messages.push(e) });
// A page's panel: hello, then the conflicts topic as it changes; calls answered by "ret".
const open = async (client) => { await services.ui({ projectId, client, message: { t: "hello" } }); await sleep(50); };
const shown = (client) => {
  let list = [];
  for (const e of messages) if (e.client === client) {
    const m = e.message;
    if (m.t === "init") list = m.topics.conflicts ?? [];
    if (m.t === "topic" && m.topic === "conflicts") list = m.value ?? [];
  }
  return list;
};
let callId = 0;
const call = async (client, method, ...args) => {
  const id = ++callId;
  await services.ui({ projectId, client, message: { t: "call", id, method, args } });
  for (let i = 0; i < 400; i++) {
    const r = messages.find((e) => e.client === client && e.message.t === "ret" && e.message.id === id);
    if (r) { if (!r.message.ok) throw new Error(r.message.error); return r.message.value; }
    await sleep(10);
  }
  throw new Error("no answer to " + method);
};
const view = (c) => c && { mine: c.mine.summary, theirs: c.theirs.summary, mineYou: !!c.mine.author.isYou, mineKind: c.mine.author.kind, theirsName: c.theirs.author.name, theirsKind: c.theirs.author.kind, provisional: c.provisional };
// each side's change sentence and noun (docs/carton-ux PLAN 7.1), which go round with the side's value
const sentences = (c) => c && { mine: c.mine.text, theirs: c.theirs.text, mineWhat: c.mine.what, theirsWhat: c.theirs.what };
const fieldAt = async (lc, id, f) => (await lc.carton.head()).doc.timelineItems.find((r) => r.id === id)?.[f];
const agentNotices = async (actor) => (await services.notices({ bundlePath: bundle, actor })).flatMap((n) => (n.cards ?? []).map((c) => ({ path: c.path, ours: c.ours, theirs: c.theirs })));
const humanRows = async (lc) => (await lc.store.range("notices", { prefix: ["@human"] })).flatMap((r) => r.value.cards ?? []);

// The person sets a field; an agent's view save from the version before sets it otherwise (and, in the first, another
// field that lands). The engine commits it as the Materializer does (an id first); its cards go to agentCards.
async function clash(lc, actorId, item, field, mine, theirs, extra = {}) {
  const base = await lc.carton.head();
  const person = await lc.carton.commit({ ops: [{ op: "set", path: ["timelineItems", item, field], value: mine }], author: api.actorOf("person") });
  if (person.status !== "confirmed") throw new Error("person: " + JSON.stringify(person));
  const doc = structuredClone(base.doc);
  doc.timelineItems = doc.timelineItems.map((r) => (r.id === item ? { ...r, [field]: theirs, ...extra } : r));
  const engine = F.cartonMaterializerEngine(lc.carton), actor = api.actorOf(actorId), id = engine.newChangeId();
  const res = await engine.commit({ doc, base: { baseDoc: base.doc, baseSeq: base.ref.seq, causal: [] }, author: actor, id });
  const saveCards = { batch: res.id ?? "save-" + id, change: res.id ?? null, request: id, file: ".scratch/views/" + actorId.replace(/\W/g, "-") + ".tsx", actor, cards: res.cards ?? [], at: Date.now() };
  const r = await api.agentCards(bundle, saveCards);
  await sleep(50);
  return { res: { status: res.status, cards: (res.cards ?? []).map((c) => ({ path: c.path, ours: c.ours, theirs: c.theirs })) }, agentCards: r, path: "timelineItems/" + item + "/" + field };
}

(async () => {
  const out = {};
  await services.ping();
  const lc = await api.carton(projectId);
  await open("before");

  // 1. Take the agent's value. Director's save also retitles the text (lands); its size clashes with the person's.
  const a = await clash(lc, "director/c1/t1", TEXT, "fontSize", 150, 170, { textContent: "From the agent" });
  out.one = { res: a.res, agentCards: a.agentCards, head: { fontSize: await fieldAt(lc, TEXT, "fontSize"), text: await fieldAt(lc, TEXT, "textContent") } };
  out.one.agentNotice = await agentNotices("director/c1/t1");
  out.one.live = view(shown("before").find((c) => c.path === a.path));
  out.one.sentences = sentences(shown("before").find((c) => c.path === a.path));
  await open("later");
  const card = shown("later").find((c) => c.path === a.path);
  out.one.later = view(card);
  const versions = (await lc.carton.log({})).length;
  await call("later", "resolve", card.id, "theirs");
  const top = (await lc.carton.log({ limit: 1 }))[0];
  out.one.taken = { fontSize: await fieldAt(lc, TEXT, "fontSize"), file: readProject().timelineItems.find((i) => i.id === TEXT).fontSize, author: top.author?.id, kind: top.author?.kind, newVersions: (await lc.carton.log({})).length - versions };
  out.one.agentAfter = await agentNotices("director/c1/t1");
  out.one.humanAfter = (await humanRows(lc)).filter((c) => c.path === a.path).length;
  await sleep(700); // the other panel drops it once the change lands (re-checked 300 ms after it)
  out.one.otherPanel = shown("before").filter((c) => c.path === a.path).length;

  // 2. Keep yours: nothing committed, the person's value stays, the agent's card is closed too.
  const b = await clash(lc, "director/c1/t1", VIDEO, "opacity", 0.5, 0.7);
  await open("p2");
  const card2 = shown("p2").find((c) => c.path === b.path);
  const v2 = (await lc.carton.log({})).length;
  await call("p2", "resolve", card2.id, "mine");
  out.two = { shown: view(card2), opacity: await fieldAt(lc, VIDEO, "opacity"), newVersions: (await lc.carton.log({})).length - v2, agentAfter: (await agentNotices("director/c1/t1")).filter((c) => c.path === b.path).length, humanAfter: (await humanRows(lc)).filter((c) => c.path === b.path).length };

  // 3. The agent decides first, as cb resolve does: --keep mine commits its value, then closes its card. A panel that
  //    shows the card and is picked on before it re-reads: "Keep yours" puts the person's value back. A panel open
  //    meanwhile drops it; one opened later never shows it.
  const c = await clash(lc, "director/c1/t1", TEXT, "fontSize", 120, 130);
  await open("p3"); await open("p3b");
  const card3 = shown("p3").find((x) => x.path === c.path);
  const agent = api.actorOf("director/c1/t1"), notice = (await services.notices({ bundlePath: bundle, actor: "director/c1/t1" })).find((n) => (n.cards ?? []).some((x) => x.path === c.path));
  const w = await lc.write({ kind: "commit", ops: [{ op: "set", path: ["timelineItems", TEXT, "fontSize"], value: 130 }] }, { actor: agent });
  const closed = await lc.write({ kind: "closeCard", change: notice.change ?? null, path: c.path }, { actor: agent });
  out.three = { agentWrite: w.status, closed: closed.closed, afterAgent: await fieldAt(lc, TEXT, "fontSize") };
  // another panel opening meanwhile prunes the person's copy of the decided card; p3 hasn't re-read yet
  await open("p3d");
  out.three.prunedFirst = (await humanRows(lc)).filter((x) => x.path === c.path && x.theirs === 130).length;
  await call("p3", "resolve", card3.id, "mine");
  out.three.picked = await fieldAt(lc, TEXT, "fontSize");
  out.three.pickedBy = (await lc.carton.log({ limit: 1 }))[0].author?.id;
  await sleep(2500);
  out.three.openPanel = shown("p3b").filter((x) => x.path === c.path).length;
  out.three.laterPanel = shown("p3d").filter((x) => x.path === c.path).length; // opened after the agent decided
  // The agent keeps the person's value (cb resolve --keep theirs: its card closed, nothing committed), and the person
  // picks "Keep yours" on a panel that still shows it (before any re-check): no new version.
  const c2 = await clash(lc, "director/c1/t1", VIDEO, "opacity", 0.2, 0.25);
  await open("p3e");
  const card3e = shown("p3e").find((x) => x.path === c2.path);
  const n2 = (await services.notices({ bundlePath: bundle, actor: "director/c1/t1" })).find((n) => (n.cards ?? []).some((x) => x.path === c2.path));
  await lc.write({ kind: "closeCard", change: n2.change ?? null, path: c2.path }, { actor: agent });
  const v3 = (await lc.carton.log({})).length;
  out.three.stillShown = !!shown("p3e").find((x) => x.path === c2.path);
  await call("p3e", "resolve", card3e.id, "mine");
  out.three.keepYoursAgain = { opacity: await fieldAt(lc, VIDEO, "opacity"), newVersions: (await lc.carton.log({})).length - v3 };
  // The agent takes its own value (--keep mine) and the person, on a panel that still shows the card, takes the agent's
  // too: nothing new to commit, no version.
  const c3 = await clash(lc, "director/c1/t1", VIDEO, "opacity", 0.35, 0.45);
  await open("p3f");
  const card3f = shown("p3f").find((x) => x.path === c3.path);
  const n3 = (await services.notices({ bundlePath: bundle, actor: "director/c1/t1" })).find((n) => (n.cards ?? []).some((x) => x.path === c3.path));
  await lc.write({ kind: "commit", ops: [{ op: "set", path: ["timelineItems", VIDEO, "opacity"], value: 0.45 }] }, { actor: agent });
  await lc.write({ kind: "closeCard", change: n3.change ?? null, path: c3.path }, { actor: agent });
  const v4 = (await lc.carton.log({})).length;
  out.three.stillShown2 = !!shown("p3f").find((x) => x.path === c3.path);
  await call("p3f", "resolve", card3f.id, "theirs");
  out.three.takeAgain = { opacity: await fieldAt(lc, VIDEO, "opacity"), newVersions: (await lc.carton.log({})).length - v4 };

  // 4. The Director's Stop hook takes its notices (main's in-process hook, through this service): the card it left is
  //    the person's from then on, shown in a panel opened later; the agent's own is gone with the take.
  const d = await clash(lc, "director/c1/t2", VIDEO, "opacity", 0.3, 0.4);
  const taken = (await services.notices({ bundlePath: bundle, actor: "director/c1/t2", take: true })).flatMap((n) => (n.cards ?? []).map((x) => x.path));
  await open("p4");
  const card4 = shown("p4").find((x) => x.path === d.path);
  out.four = { path: d.path, taken, agentAfterTake: (await agentNotices("director/c1/t2")).length, shown: view(card4) };
  if (card4) await call("p4", "resolve", card4.id, "theirs");
  out.four.opacity = await fieldAt(lc, VIDEO, "opacity");
  out.four.humanAfter = (await humanRows(lc)).filter((x) => x.path === d.path).length;

  // 5. @carton/local's hand-over (host Claude Code's Stop hook, the second time): the agent's row is marked and copied
  //    under @human. The copy and the person's own row show one card; picking closes both and the agent's handed row.
  const e = await clash(lc, "codex/h1", TEXT, "fontSize", 111, 112);
  const key = api.actorOf("codex/h1"), rows = await lc.store.range("notices", { prefix: [[key.kind, key.id].join("/")] });
  await new F.StoreNoticeBox(lc.store).handToHumanAsync("codex/h1", rows.map((r) => JSON.stringify(r.key)));
  out.five = { humanRows: (await lc.store.range("notices", { prefix: ["@human"] })).filter((r) => r.value.cards?.some((x) => x.path === e.path)).length };
  await open("p5");
  const card5 = shown("p5").filter((x) => x.path === e.path);
  out.five.shown = card5.length;
  out.five.view = view(card5[0]);
  await call("p5", "resolve", card5[0].id, "theirs");
  out.five.fontSize = await fieldAt(lc, TEXT, "fontSize");
  out.five.left = (await lc.store.range("notices", {})).filter((r) => r.value?.cards?.some((x) => x.path === e.path)).length;

  // 6. UI audit 2026-11-02 P1-6: a card's "Preview" of each side shows that side. The person drags the title 2 s later and
  //    onto a new track (the audit's drag made "Text 1"); Claude Code's view save moves it 4 s later. Preview of Claude
  //    Code's side showed the person's (head), and the person's showed Claude Code's.
  {
    const base = await lc.carton.head();
    const t0 = base.doc.timelineItems.find((r) => r.id === TEXT), len = t0.endTime - t0.startTime;
    const lane = "p16-text-1", tracks = base.doc.tracks;
    const person = await lc.carton.commit({ ops: [
      { op: "insert", path: ["tracks", lane], value: { ...tracks.find((t) => t.id === t0.trackId), id: lane, name: "Text 1", "#pos": "zz" } },
      { op: "set", path: ["timelineItems", TEXT, "trackId"], value: lane },
      { op: "set", path: ["timelineItems", TEXT, "startTime"], value: t0.startTime + 2 },
      { op: "set", path: ["timelineItems", TEXT, "endTime"], value: t0.startTime + 2 + len },
    ], author: api.actorOf("person") });
    const doc = structuredClone(base.doc);
    doc.timelineItems = doc.timelineItems.map((r) => (r.id === TEXT ? { ...r, startTime: t0.startTime + 4, endTime: t0.startTime + 4 + len } : r));
    const engine = F.cartonMaterializerEngine(lc.carton), actor = api.actorOf("claude-code/ab12cd34"), id = engine.newChangeId();
    const res = await engine.commit({ doc, base: { baseDoc: base.doc, baseSeq: base.ref.seq, causal: [] }, author: actor, id });
    await api.agentCards(bundle, { batch: res.id ?? "save-" + id, change: res.id ?? null, request: id, file: ".scratch/views/claude.tsx", actor, cards: res.cards ?? [], at: Date.now() });
    await sleep(50);
    await open("p6");
    const card6 = shown("p6").find((x) => x.path.startsWith("timelineItems/" + TEXT));
    const at = async (side) => {
      const ref = await call("p6", "conflictRef", card6.id, side);
      const it = (await lc.carton.checkout(ref)).timelineItems.find((r) => r.id === TEXT);
      return { start: +(it.startTime - t0.startTime).toFixed(3), track: it.trackId === lane ? "Text 1" : "its own" };
    };
    out.six = { person: person.status, saved: res.status, card: card6 && { path: card6.path, mine: card6.mine.summary, theirs: card6.theirs.summary, theirsName: card6.theirs.author.name, provisional: card6.provisional }, mine: await at("mine"), theirs: await at("theirs") };
    out.six.headAfter = +((await lc.carton.head()).doc.timelineItems.find((r) => r.id === TEXT).startTime - t0.startTime).toFixed(3);
    await call("p6", "resolve", card6.id, "mine");
  }

  // A person's own carded view save (a hand edit of a view): theirs already, nothing kept under @human.
  out.person = await F.agentCards(bundle, { batch: "p", change: null, file: "timeline.tsx", actor: api.actorOf("person"), cards: [{ kind: "field", path: e.path, base: 1, ours: 2, theirs: 3 }], at: Date.now() });
  out.none = await F.agentCards(bundle, { batch: "x", actor: api.actorOf("codex/h1"), cards: [] });
  process.stdout.write(JSON.stringify(out) + "\n");
  process.exit(0);
})().catch((e) => { process.stdout.write(JSON.stringify({ error: String(e?.stack ?? e) }) + "\n"); process.exit(1); });
`;

let out;
test.before(async () => {
  if (noBuild) return;
  const dir = path.join(process.env.CARTON_TEST_DIR ?? path.join(os.homedir(), "gfv-scratch", "carton", "windows-sync"), "view-cards-test");
  fs.rmSync(dir, { recursive: true, force: true });
  const bundle = path.join(dir, "library", "Sample.cardboard");
  fs.mkdirSync(bundle, { recursive: true });
  fs.copyFileSync(FIXTURE, path.join(bundle, "project.json"));
  const esbuild = require(require.resolve("esbuild", { paths: [CARTON] }));
  const file = path.join(dir, "facade.cjs");
  await esbuild.build({
    stdin: { contents: 'export { cardboard14, agentCards, extend } from "./carton-node.js";\nexport { cartonMaterializerEngine } from "@carton/cardboard/node";\nexport { StoreNoticeBox } from "@carton/local";\n', resolveDir: path.join(ROOT, "scripts/carton"), sourcefile: "view-cards-entry.js", loader: "js" },
    bundle: true, platform: "node", format: "cjs", target: "node24", outfile: file, absWorkingDir: CARTON, nodePaths: [path.join(CARTON, "node_modules")], logLevel: "error",
    banner: { js: 'const __cartonUrl = require("node:url").pathToFileURL(__filename).href;' }, define: { "import.meta.url": "__cartonUrl" },
  });
  const home = path.join(dir, "home");
  const r = spawnSync(process.execPath, ["-e", RUN, file, bundle], {
    env: { ...process.env, HOME: home, USERPROFILE: home, XDG_DATA_HOME: path.join(home, "appdata"), LOCALAPPDATA: path.join(home, "appdata"), CARDBOARD_CARTON: "1", CARDBOARD_ACTOR: "", CLAUDECODE: "" },
    encoding: "utf8",
    timeout: 120_000,
  });
  out = JSON.parse(r.stdout.trim().split("\n").pop() || "{}");
  if (out.error || r.status !== 0) throw new Error("view-cards run: " + (out.error ?? r.stdout + r.stderr));
}, { timeout: 600_000 });

const opt = { skip: noBuild };

test("the agent's save lands but for the clash; its card is kept for it as the engine keeps it", opt, () => {
  assert.equal(out.one.res.status, "conflicts", JSON.stringify(out.one));
  assert.deepEqual(out.one.res.cards.map((c) => [c.ours, c.theirs]), [[150, 170]], "core's card: ours is head (the person's), theirs the agent's");
  assert.deepEqual(out.one.head, { fontSize: 150, text: "From the agent" }, "head keeps the person's size; the agent's other edit landed");
  assert.deepEqual(out.one.agentNotice, out.one.res.cards, "the agent's notice (cb conflicts, the Stop hook) holds the engine's cards");
  assert.deepEqual(out.one.agentCards, { status: "kept", cards: 1 });
});

test("the person's panel shows it at once and when opened later, the person's way round", opt, () => {
  const want = { mine: "150", theirs: "170", mineYou: true, mineKind: "human", theirsName: "Director", theirsKind: "agent", provisional: "mine" };
  assert.deepEqual(out.one.live, want, "an open panel, at once: yours is 150 and showing; Director's is 170");
  assert.deepEqual(out.one.later, want, "a panel opened later: the same");
  // each side's sentence is its own value's: yours 150, the Director's 170 (they went round with the summaries)
  const s = out.one.sentences;
  assert.match(s?.mine ?? "", /\bfont size 150\b/, JSON.stringify(s));
  assert.match(s?.theirs ?? "", /\bfont size 170\b/, JSON.stringify(s));
});

test("taking the agent's value commits it as the person's choice; the card closes on both sides", opt, () => {
  assert.deepEqual(out.one.taken, { fontSize: 170, file: 170, author: "person", kind: "human", newVersions: 1 }, JSON.stringify(out.one.taken));
  assert.deepEqual(out.one.agentAfter, [], "cb conflicts no longer lists it");
  assert.equal(out.one.humanAfter, 0);
  assert.equal(out.one.otherPanel, 0, "another open panel drops it once the change lands");
});

test("keeping yours commits nothing; the agent's card closes too", opt, () => {
  // the panel words cards in Cardboard's units (ui-words: describeCardboardCard): opacity in percent
  assert.deepEqual(out.two.shown, { mine: "50%", theirs: "70%", mineYou: true, mineKind: "human", theirsName: "Director", theirsKind: "agent", provisional: "mine" });
  assert.deepEqual([out.two.opacity, out.two.newVersions, out.two.agentAfter, out.two.humanAfter], [0.5, 0, 0, 0]);
});

test("the agent decides first: a pick made on the card still holds, an open panel drops it, a later one never shows it", opt, () => {
  assert.deepEqual([out.three.agentWrite, out.three.closed, out.three.afterAgent], ["confirmed", true, 130], JSON.stringify(out.three));
  assert.equal(out.three.prunedFirst, 0, "a panel opened meanwhile pruned the person's copy");
  assert.deepEqual([out.three.picked, out.three.pickedBy], [120, "person"], "Keep yours puts the person's value back over the agent's");
  assert.equal(out.three.openPanel, 0);
  assert.equal(out.three.laterPanel, 0);
  assert.equal(out.three.stillShown, true, "picked while still on screen");
  assert.deepEqual(out.three.keepYoursAgain, { opacity: 0.2, newVersions: 0 }, "Keep yours after the agent kept it: an empty commit, no version");
  assert.equal(out.three.stillShown2, true, "picked while still on screen");
  assert.deepEqual(out.three.takeAgain, { opacity: 0.45, newVersions: 0 }, "Keep Director's after the agent took it: no version");
});

test("the Director's Stop hook takes its notices: what it left stays the person's", opt, () => {
  assert.ok(out.four.taken.includes(out.four.path), "the hook got the card: " + JSON.stringify(out.four));
  assert.equal(out.four.agentAfterTake, 0, "taken: the agent's rows are gone");
  assert.deepEqual(out.four.shown, { mine: "30%", theirs: "40%", mineYou: true, mineKind: "human", theirsName: "Director", theirsKind: "agent", provisional: "mine" });
  assert.deepEqual([out.four.opacity, out.four.humanAfter], [0.4, 0]);
});

test("@carton/local's hand-over copy and the person's row show one card; a pick closes every copy", opt, () => {
  assert.equal(out.five.humanRows, 2, "the person's row and the hand-over copy");
  assert.equal(out.five.shown, 1);
  assert.deepEqual(out.five.view, { mine: "111", theirs: "112", mineYou: true, mineKind: "human", theirsName: "Codex", theirsKind: "agent", provisional: "mine" });
  assert.deepEqual([out.five.fontSize, out.five.left], [112, 0]);
});

test("P1-6: a card's Preview of each side shows that side: Claude Code's is its time, yours is yours (on your new track)", opt, () => {
  assert.deepEqual([out.six.person, out.six.saved], ["confirmed", "conflicts"], JSON.stringify(out.six));
  assert.equal(out.six.card?.theirsName, "Claude Code", JSON.stringify(out.six.card));
  assert.equal(out.six.card?.provisional, "mine", "yours is showing now");
  assert.deepEqual(out.six.mine, { start: 2, track: "Text 1" }, "Preview of yours: your drag, on the track it made");
  assert.deepEqual(out.six.theirs, { start: 4, track: "Text 1" }, "Preview of Claude Code's: its time (the track is yours: the card is about timing)");
  assert.equal(out.six.headAfter, 2, "previewing changes nothing");
});

test("a person's own carded view save is theirs already; no cards, nothing to do", opt, () => {
  assert.deepEqual(out.person, { status: "shown", cards: 1 });
  assert.deepEqual(out.none, { status: "none" });
});
