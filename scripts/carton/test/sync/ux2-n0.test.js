// Carton UX v2 (N0) in Cardboard's real library worker and its real `cb`: `cb history --find`, `cb history
// --landmarks` (a Start when the editor opened the project, an export the page saw), `cb restore <version> --clip`, and
// `cb compare … --show`, whose Compare event reaches the pages through the worker's change channel (the one main hands
// to every tab as `carton:event`, as `cb cut switch`'s changes go), and whose answer the page gives back.
//   CARDBOARD_PRISTINE=<Cardboard 1.4.0 unpacked> node --test --test-concurrency=1 scripts/carton/test/sync/ux2-n0.test.js
const test = require("node:test");
const assert = require("node:assert/strict");
const S = require("./support.js");

const t = { skip: S.skip || S.noBuild, timeout: S.TEST_MS };
let b, pc, id, panel;

test.before(async () => {
  if (t.skip) return;
  b = await S.build();
  pc = await S.computer("ux2-n0", b);
  S.seed(pc, b);
  await pc.startWorker();
  id = (await pc.call("projects.list"))[0]?.id;
  // the editor opens the project: its History panel connects (this is the page Compare goes to)
  panel = await openPanel(pc, id, "page-1");
}, { timeout: S.SETUP_MS });
test.after(async () => {
  await pc?.stopWorker();
  S.killHelpers();
}, { timeout: S.STOP_MS });

async function openPanel(pc, id, client) {
  let calls = 0;
  const msgs = () => pc.events().filter((e) => e.change?.kind === "carton" && e.change.client === client).map((e) => e.change.message);
  const send = (message) => pc.call("carton.ui", { projectId: id, client, message });
  assert.equal((await send({ t: "hello" }))?.status, "ok", "the History panel opens");
  await S.until(() => msgs().some((x) => x.t === "init"), 20_000, "the panel's init");
  return {
    call: async (method, ...args) => {
      const n = ++calls;
      await send({ t: "call", id: n, method, args });
      const ret = await S.until(() => msgs().find((x) => x.t === "ret" && x.id === n), 30_000, "the panel's " + method);
      if (!ret.ok) throw new Error(`panel ${method}: ${ret.error}`);
      return ret.value;
    },
  };
}
const cbJson = (args, env) => {
  const r = pc.cb(args, env);
  assert.equal(r.code, 0, args.join(" ") + ": " + r.out + r.err);
  return r.json();
};
const title = async () => (await S.projectOf(pc, id)).timelineItems.find((x) => x.type === "text");

test("cb history --find and --landmarks: a title by its name and its text, a Start from the editor's open, an export the page saw", t, async () => {
  // the person retypes the title in the app
  await S.guiSave(pc, id, (it) => (it.type === "text" ? { ...it, textContent: "Summer launch" } : undefined));
  await S.until(async () => (await title()).textContent === "Summer launch", 20_000, "the save");
  // an export finished (the page's export_completed, through the renderer bridge's call)
  assert.equal((await pc.call("carton.mark", { projectId: id, kind: "exported", label: "1080p" })).status, "ok");
  // the text it set (the title keeps its name, "Hello": Cardboard names a title by its name before its text)
  const f = await S.until(() => { const j = cbJson(["history", "Demo", "--find", "summer"]); return j.total ? j : null; }, 20_000, "find");
  assert.deepEqual([f.matches[0].field, f.matches[0].snippet, f.matches[0].recordName], ["text", "Summer launch", "Hello"], JSON.stringify(f.matches[0]));
  assert.match(f.matches[0].version, /^main@\d+$/);
  assert.deepEqual(f.matches[0].landmarks, ["exported"], "the version exported");
  // the title by its name: every version that touched it, and the clip first
  const hello = cbJson(["history", "Demo", "--find", "hello"]);
  assert.ok(hello.total >= 2, "the title by its name: " + JSON.stringify(hello.matches.map((m) => [m.version, m.field])));
  assert.equal(hello.matches[0].field, "clip");
  assert.equal(hello.clips[0]?.name, "Hello", JSON.stringify(hello.clips));
  // the panel finds the same
  const ph = await panel.call("find", "summer");
  assert.equal(ph.hits[0]?.field, "text");
  assert.equal(ph.hits[0]?.clipName, "Hello");
  const l = cbJson(["history", "Demo", "--landmarks"]).landmarks;
  const kinds = l.map((x) => x.kind);
  assert.ok(kinds.includes("start"), "the editor's open: " + JSON.stringify(kinds));
  assert.ok(kinds.includes("turn"), "the agent's turns");
  const ex = l.find((x) => x.kind === "exported");
  assert.deepEqual([ex?.label, ex?.personal, ex?.local], ["1080p", false, true]);
  assert.equal(l.find((x) => x.kind === "start").personal, true);
  // the plain words, as an agent reads them
  const plain = pc.cb(["history", "Demo", "--landmarks"]);
  assert.equal(plain.code, 0);
});

test("cb restore <version> --clip: the title as it was, through the worker's holder; one that wasn't there is refused in words", t, async () => {
  const versions = cbJson(["history", "Demo", "--limit", "50"]).versions;
  // the version before the person's retyping (the agent's last)
  const before = versions.find((v) => v.by?.kind === "agent" || v.by?.kind === "subagent");
  assert.ok(before, JSON.stringify(versions.map((v) => [v.version, v.by?.kind])));
  const r = cbJson(["restore", "Demo", before.version, "--clip", "Hello"]);
  assert.equal(r.status, "confirmed", JSON.stringify(r));
  assert.equal(r.brought?.how, "changed");
  await S.until(async () => (await title()).textContent === "Hello", 20_000, "the title back in project.json");
  const top = cbJson(["history", "Demo", "--limit", "1"]).versions[0];
  assert.equal(top.kind, "restore");
  // the History panel's Bring back (through the worker, which writes project.json after it, as for restore)
  await S.guiSave(pc, id, (it) => (it.type === "text" ? { ...it, textContent: "Retyped" } : undefined));
  await S.until(async () => (await title()).textContent === "Retyped", 20_000, "the second save");
  const t0 = await title();
  const back = await panel.call("restoreClip", `${before.ref.branchId}@${before.ref.seq}`, t0.id);
  assert.equal(back.how, "changed", JSON.stringify(back));
  assert.ok(back.made?.changes?.length === 1, "its toast's Undo has the version: " + JSON.stringify(back));
  await S.until(async () => (await title()).textContent === "Hello", 20_000, "the panel's bring-back in project.json");
  // the project's start has no title: bringing it back means taking it out, said, nothing changed
  const first = versions[versions.length - 1].version;
  const no = pc.cb(["restore", "Demo", first, "--clip", "Hello"]);
  assert.equal(no.code, 1, no.out + no.err);
  assert.equal(no.json().status, "not-in-version", no.out);
  assert.equal((await title()).textContent, "Hello", "nothing changed");
});

test("cb compare --show: the Compare event reaches the editor's pages with who asked; the page's answer is what cb says", t, async () => {
  const mcp = await pc.mcp({ CARDBOARD_ACTOR: "director/chat9/turn1" });
  try {
    const versions = cbJson(["history", "Demo", "--limit", "50"]).versions;
    const from = versions[versions.length - 2].version;
    const seen = pc.events().length;
    let early = null;
    const call = mcp.tool("timeline_compare", { project: "Demo", left: from, show: true }).then((x) => (early = x), (e) => (early = { text: "error: " + e.message }));
    const ev = await S.until(() => { if (early) throw new Error("cb answered before any Compare event: " + early.text + "\n" + mcp.stderr().slice(-2000)); return pc.events().slice(seen).map((e) => e.change).find((c) => c?.kind === "carton" && c.topic === "compare"); }, 30_000, "the Compare event");
    assert.equal(ev.id, id);
    const c = ev.compare;
    assert.match(c.from, /@\d+$/);
    assert.equal(c.between, "versions");
    assert.equal(c.byName, "Director", JSON.stringify(c.by));
    assert.equal(typeof c.request, "string");
    assert.equal((await pc.call("carton.compareAnswer", { projectId: id, request: c.request, status: "opened" })).status, "ok");
    const out = await call;
    assert.match(out.text, /^Opened in the editor: .* with the user's edit now\. \d+ changes?[:.]/, out.text);
    assert.match(out.text, /The user can press Esc to go back to their edit\.$/);
    // busy: the page offers it instead, and cb says so
    const seen2 = pc.events().length;
    const call2 = mcp.tool("timeline_compare", { project: "Demo", left: from, show: true });
    const ev2 = await S.until(() => pc.events().slice(seen2).map((e) => e.change).find((x) => x?.kind === "carton" && x.topic === "compare"), 30_000, "the second Compare event");
    await pc.call("carton.compareAnswer", { projectId: id, request: ev2.compare.request, status: "offered", why: "busy" });
    assert.match((await call2).text, /^The user is busy editing, so the comparison didn't open\. They have a note in the editor with Open\./);
  } finally {
    await mcp.close();
  }
});

test("cb compare --show typed in the person's own terminal: the editor is told it's You, never “Terminal” (laptop P3-12)", t, async () => {
  const versions = cbJson(["history", "Demo", "--limit", "50"]).versions;
  const from = versions[versions.length - 2].version;
  const seen = pc.events().length;
  // (nobody answers here: cb waits out the page's answer, then says it was sent)
  const r = pc.cb(["compare", "Demo", from, "--show"]);
  assert.equal(r.code, 0, r.out + r.err);
  assert.equal(r.json().opened, 1, "the page has the project open");
  const ev = await S.until(() => pc.events().slice(seen).map((e) => e.change).find((c) => c?.kind === "carton" && c.topic === "compare"), 10_000, "the Compare event");
  assert.equal(ev.compare.by.kind, "external", JSON.stringify(ev.compare.by));
  assert.equal(ev.compare.byName, "You");
});
