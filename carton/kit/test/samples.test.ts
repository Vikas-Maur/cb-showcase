// The Carton calls INTEGRATION.md shows, run for real on this machine (Linux, Node 24). Cardboard's own functions are
// stand-ins here: readProjectJson reads a file, the GUI projection is the prototype's stand-in for the editor's
// (whitelist + 0.1 s rounding), and commander is the small stand-in cli-mcp's own tests use.
//   cd carton && node --test kit/test/samples.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Carton, StateUnknown, type Actor, type Doc, type Rec } from "@carton/core";
import type { AuthContext, AuthProvider } from "@carton/core/plugins";
import { cardboardAdapter, createCardboardAdapter, fromHost, materializeProject, projectGuiSave, standInProjection } from "@carton/cardboard";
import { excludedFromExport } from "@carton/cardboard/node";
import { register } from "@carton/cli-mcp";
import { authProviderSuite } from "@carton/conformance";
import { hookSettings, identify, nodeHasher, openLocal, readProjectId } from "@carton/local";
import { prefixCommand, preToolUseOutput } from "@carton/local/hooks";
import { createFsBlobStore } from "@carton/blob-fs";
import { createHmacAuth, newSecret } from "@carton/server";
import { startNodeHost } from "@carton/server-node";
import { importProject } from "@carton/store-sqlite";

const kit = join(dirname(fileURLToPath(import.meta.url)), "..");
function scratch(name: string): string {
  const root = process.env.CARTON_SCRATCH ?? join(homedir(), "gfv-scratch", "carton", "kit-docs", "test");
  mkdirSync(root, { recursive: true });
  return mkdtempSync(join(root, `${name}-`));
}
function bundle(name: string): string {
  const dir = join(scratch(name), "Demo.cardboard");
  cpSync(join(kit, "quickstart", "Demo.cardboard"), dir, { recursive: true });
  return dir;
}
const readProjectJson = (dir: string) => JSON.parse(readFileSync(join(dir, "project.json"), "utf8"));
const clip = (doc: Doc, id: string) => (doc.timelineItems as Rec[]).find((i) => i.id === id)!;
// documents are values: replace the record you change
const withClip = (doc: Doc, id: string, fields: Record<string, unknown>): Doc => ({ ...doc, timelineItems: (doc.timelineItems as Rec[]).map((i) => (i.id === id ? { ...i, ...fields } : i)) });
const agent = (id: string): Actor => ({ kind: "agent", id, name: id, group: "local:me@box" });

test("desktop: importProject makes the document main@1 once; app data keys the placement", async () => {
  const bundleDir = bundle("open");
  const appDataDir = scratch("userData");
  const projectId = readProjectId(bundleDir);
  const adapter = createCardboardAdapter({ projection: standInProjection });
  const open = () => importProject({ bundleDir, projectId, appDataDir, adapter, hasher: nodeHasher, host: () => readProjectJson(bundleDir).project });
  const first = await open();
  assert.equal(first.imported, true);
  assert.equal(first.location.inBundle, true);
  const log = await first.carton.log();
  assert.deepEqual([log[0]!.ref.seq, log[0]!.kind, log[0]!.author?.id], [1, "import", "import"]);
  await first.carton.close();
  await first.store.close();
  const again = await open();
  assert.equal(again.imported, false);
  assert.equal((await again.carton.head()).ref.seq, 1);
  await again.carton.close();
  await again.store.close();
});

test("H1: each mutation commits against its own base; a stale base is rebased, a clash is a card, never an overwrite", async () => {
  const bundleDir = bundle("h1");
  const { carton, store } = await importProject({ bundleDir, projectId: readProjectId(bundleDir), adapter: cardboardAdapter, hasher: nodeHasher, host: () => readProjectJson(bundleDir).project });
  try {
    const { ref: baseRef, doc: baseDoc } = await carton.head();
    const project = readProjectJson(bundleDir).project;
    // writer A: the mutation's result, as the host's document, converted with the base it was applied to
    const a = materializeProject(withClip(baseDoc, "intro", { textContent: "A" }), project);
    assert.equal((await carton.commit({ doc: fromHost(a, baseDoc), base: baseRef, author: agent("a"), id: "sample.a" })).status, "confirmed");
    // writer B read the same base and changed another clip: rebased onto A, both land
    const rb = await carton.commit({ doc: withClip(baseDoc, "outro", { textContent: "B" }), base: baseRef, author: agent("b") });
    assert.equal(rb.status, "confirmed");
    // writer C read the same base and changed A's clip the other way: a card; A's value stays
    const rc = await carton.commit({ doc: withClip(baseDoc, "intro", { textContent: "C" }), base: baseRef, author: agent("c") });
    assert.equal(rc.status, "conflicts");
    const head = (await carton.head()).doc;
    assert.deepEqual([clip(head, "intro").textContent, clip(head, "outro").textContent], ["A", "B"]);
    // the same id again is the same change, never a second one
    const again = await carton.commit({ doc: fromHost(a, baseDoc), base: baseRef, author: agent("a"), id: "sample.a" });
    assert.deepEqual([again.status, again.status === "confirmed" && again.seq], ["confirmed", 2]);
    // the file is a view of head: unversioned fields come from the current project.json
    const file = materializeProject(head, project);
    assert.equal(file.id, "demo-project");
    assert.equal((file.timelineItems as Rec[]).find((i) => i.id === "outro")!.textContent, "B");
    // in-place edits are invisible: the record is shared with the base
    const shared = (await carton.head()).doc;
    (shared.timelineItems as Rec[])[0]!.textContent = "edited in place";
    const r = await carton.commit({ doc: shared });
    assert.equal(r.status === "confirmed" && r.empty, true, "an in-place edit is not a change (copy the record)");
  } finally {
    await carton.close();
    await store.close();
  }
});

test("H4: a GUI save through the lossy projection carries only the person's edit", async () => {
  const bundleDir = bundle("h4");
  const projection = standInProjection;
  const { carton, store } = await importProject({ bundleDir, projectId: readProjectId(bundleDir), adapter: createCardboardAdapter({ projection }), hasher: nodeHasher, host: () => readProjectJson(bundleDir).project });
  try {
    // an agent sets frame-accurate times the GUI can't show (it rounds to 0.1 s)
    await carton.commit({ doc: withClip((await carton.head()).doc, "middle", { endTime: 6.04, trimEnd: 3.04 }), author: agent("director/c/t") });
    const { ref: base, doc: baseDoc } = await carton.head();
    // the GUI saves the whole timeline through its projection, with the person's change to the intro's text
    const guiDoc = { ...materializeProject(baseDoc, null), timelineItems: (materializeProject(baseDoc, null).timelineItems as Rec[]).map((i) => projection(i.id === "intro" ? { ...i, textContent: "Hi" } : i)) };
    const r = await carton.commit({ doc: projectGuiSave(baseDoc, guiDoc, projection), base, author: { kind: "human", id: "person", group: "local:me@box" } });
    assert.equal(r.status, "confirmed");
    const d = await carton.diff(base);
    assert.deepEqual(d.describe, ["Changed 'Intro' text \"Intro\" → \"Hi\""]);
    assert.equal(clip((await carton.head()).doc, "middle").endTime, 6.04, "the agent's precise time survives the rounded save");
  } finally {
    await carton.close();
    await store.close();
  }
});

test("H2: history with authors, restore as a new version, undo by actor group", async () => {
  const bundleDir = bundle("h2");
  const { carton, store } = await importProject({ bundleDir, projectId: readProjectId(bundleDir), adapter: cardboardAdapter, hasher: nodeHasher, host: () => readProjectJson(bundleDir).project });
  try {
    const me: Actor = { kind: "human", id: "person", group: "local:me@box" };
    const teammate: Actor = { kind: "human", id: "bob", group: "bob@desk" };
    await carton.commit({ doc: withClip((await carton.head()).doc, "intro", { textContent: "mine" }), author: me });
    await carton.commit({ doc: withClip((await carton.head()).doc, "outro", { textContent: "bob's" }), author: teammate });
    const log = await carton.log({ limit: 10 });
    assert.deepEqual(log.slice(0, 3).map((v) => [v.ref.seq, v.author?.id]), [[3, "bob"], [2, "person"], [1, "import"]]);
    const u = await carton.undo(me.group, { author: me });
    assert.equal(u.status, "confirmed");
    let head = (await carton.head()).doc;
    assert.deepEqual([clip(head, "intro").textContent, clip(head, "outro").textContent], ["Intro", "bob's"], "⌘Z undid my edit, not the teammate's");
    const r = await carton.restore(log[2]!.ref, { author: me });
    assert.equal(r.status, "confirmed");
    head = (await carton.head()).doc;
    assert.equal(clip(head, "outro").textContent, "Outro", "restore brings back main@1 as a new version");
    assert.equal((await carton.checkout(log[0]!.ref)).timelineItems !== undefined, true, "every version can still be read");
  } finally {
    await carton.close();
    await store.close();
  }
});

test("H3: print pins a version; an apply commits on the header's version; a header nothing can rebuild is an error", async () => {
  const bundleDir = bundle("h3");
  const { carton, store } = await importProject({ bundleDir, projectId: readProjectId(bundleDir), adapter: cardboardAdapter, hasher: nodeHasher, host: () => readProjectJson(bundleDir).project });
  try {
    const pin = await carton.pin({ owner: "turn-1", by: "director/c/t1" });
    assert.match(pin.header, /^Main cut@1~[0-9a-f]{8} b:[0-9a-f]{8} p:\S+ by director\/c\/t1$/);
    const printed = await carton.checkout(pin.header);
    await carton.commit({ doc: withClip((await carton.head()).doc, "outro", { textContent: "meanwhile" }), author: agent("other") });
    const r = await carton.commit({ doc: withClip(printed, "intro", { textContent: "from the file" }), base: pin.header, author: agent("director/c/t1") });
    assert.equal(r.status, "confirmed");
    const head = (await carton.head()).doc;
    assert.deepEqual([clip(head, "intro").textContent, clip(head, "outro").textContent], ["from the file", "meanwhile"]);
    await assert.rejects(carton.commit({ doc: printed, base: "Main cut@1~00000000 b:00000000 p:none by nobody" }), (e: unknown) => e instanceof StateUnknown && /re-print/.test((e as Error).message));
  } finally {
    await carton.close();
    await store.close();
  }
});

test("CLI: register() adds Carton's commands to the cb program and extends history and undo", async () => {
  class Cmd {
    _name: string; args: string[] = []; options: string[] = []; commands: Cmd[] = []; _action: ((...a: any[]) => unknown) | null = null; _opts: Record<string, unknown> = {};
    constructor(name: string) { this._name = name; }
    name() { return this._name; }
    command(n: string) { const c = new Cmd(n); this.commands.push(c); return c; }
    description() { return this; }
    argument(a: string) { this.args.push(a); return this; }
    option(flags: string) { this.options.push(flags); return this; }
    action(f: (...a: any[]) => unknown) { this._action = f; return this; }
    opts() { return this._opts; }
    async run(positional: unknown[], opts: Record<string, unknown> = {}) { this._opts = opts; return this._action!(...positional, opts, this); }
  }
  const bundleDir = bundle("cli");
  const pre = await importProject({ bundleDir, projectId: readProjectId(bundleDir), adapter: cardboardAdapter, hasher: nodeHasher, host: () => readProjectJson(bundleDir).project });
  await pre.carton.close();
  await pre.store.close();
  const program = new Cmd("cb");
  program.command("history").argument("<project>");     // 1.4.0's own
  const printed: string[] = [];
  const opened: { close(): Promise<void> }[] = [];
  register(program, {
    open: async (_project, { as }) => {
      const project = await openLocal({ projectDir: bundleDir, actor: identify({ declared: as ?? null }) });
      opened.push(project);
      return { project, actor: identify({ declared: as ?? null }) };
    },
    out: (_json, text) => printed.push(text()),
  });
  const names = program.commands.map((c) => c.name());
  for (const n of ["history", "cut", "fold", "credits", "restore", "undo", "compare", "publish", "conflicts", "resolve", "branch", "merge", "log", "blame"]) assert.ok(names.includes(n), n);
  await program.commands.find((c) => c.name() === "history")!.run(["Demo"], {});
  assert.match(printed.at(-1)!, /^VERSION\s+SAVED\s+BY\s+WHAT\nmain@1\s+just now\s+Import/);
  for (const p of opened) await p.close();
});

test("H9: the hooks' settings for host Claude Code, and the Director's command prefix", () => {
  const s = hookSettings({ command: "node /opt/carton/bin.js", projectDir: "/projects/My film.cardboard" }) as any;
  assert.equal(s.hooks.PreToolUse[0].matcher, "Bash");
  assert.equal(s.hooks.Stop[0].hooks[0].command, "node /opt/carton/bin.js hook stop --project '/projects/My film.cardboard'");
  const input = { hook_event_name: "PreToolUse", tool_name: "Bash", agent_id: "a-1", agent_type: "general-purpose", tool_input: { command: "cb source apply Demo" } };
  const out = preToolUseOutput(input, prefixCommand(input, { chat: "c1", turn: "t7" })) as any;
  assert.equal(out.hookSpecificOutput.updatedInput.command, "export CARDBOARD_ACTOR='director/c1/t7/sub-general-purpose-a_1'; cb source apply Demo");
});

test("H11: .carton/ and .scratch/views/ never go into a .cbproj", () => {
  assert.equal(excludedFromExport(".carton/carton.db"), true);
  assert.equal(excludedFromExport(".scratch/views/director.tsx"), true);
  assert.equal(excludedFromExport("timeline.tsx"), false);
  assert.equal(excludedFromExport("media/clip.mp4"), false);
});

test("a host: the Node host with blobs on disk answers health and serves a project's socket URL", async () => {
  const dir = scratch("host");
  const secret = newSecret();
  const host = await startNodeHost({ dataDir: join(dir, "rooms"), auth: createHmacAuth({ secret }), secret, blobs: createFsBlobStore({ root: join(dir, "blobs") }), adminToken: newSecret(), host: "127.0.0.1", port: 0 });
  try {
    assert.equal((await fetch(`${host.httpUrl}/api/health`)).status, 200);
    assert.equal(host.urlFor("demo-project"), `${host.httpUrl.replace(/^http/, "ws")}/api/projects/demo-project/ws`);
  } finally {
    await host.close();
  }
});

// A verify-only provider over your own sessions: the suite checks what it can (unknown tokens give null, never an
// exception); add `issue` (for tests) and it also checks round trips, tampering and expiry.
const sessions = new Map<string, { userId: string; deviceId: string; role: AuthContext["role"]; projectId: string; expiresAt: number }>();
const lookupSession = async (token: string) => (typeof token === "string" ? sessions.get(token) ?? null : null);
const cardboardAuth: AuthProvider = {
  kind: "cardboard",
  async verify(token): Promise<AuthContext | null> {
    const s = await lookupSession(token);
    if (!s || s.expiresAt <= Date.now()) return null;
    return { account: s.userId, credential: `${s.userId}/${s.deviceId}`, role: s.role, projectId: s.projectId, expires: s.expiresAt };
  },
};
authProviderSuite("a Cardboard-accounts sample", async () => cardboardAuth);
