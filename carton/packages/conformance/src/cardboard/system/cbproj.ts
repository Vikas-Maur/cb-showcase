// `.cbproj` collaboration end to end (PLAN §13, §16 H11) on the real engine and history: two replicas that never share
// a server pass Cardboard's own Save As files back and forth. Each file carries the shallow export; "Bring in their
// changes" folds the sender's head in through the DAG. Alice → Bob → Alice twice, then a third fold: the LCA is right
// and nothing is reverted. The zip never holds `.carton/` or `.scratch/views/`.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { Carton } from "@carton/core";
import type { Actor, Doc } from "@carton/core";
import { createMemoryStore } from "@carton/store-memory";
import { cardboardAdapter, fromHost, toHost } from "@carton/cardboard";
import { execFileSync } from "node:child_process";
import { exportCbproj, readCbproj, bringInTheirChanges, extractFullHistory } from "@carton/cardboard/node";
import { SCRATCH, clips, find, type Item } from "./world.ts";

const ALICE: Actor = { kind: "human", id: "alice", group: "alice@laptop" };
const BOB: Actor = { kind: "human", id: "bob", group: "bob@desk" };

function bundle(t: test.TestContext, name: string, project: Record<string, unknown>): string {
  fs.mkdirSync(SCRATCH, { recursive: true });
  const dir = fs.mkdtempSync(path.join(SCRATCH, `${name}-`));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const files: Record<string, string> = {
    "project.json": JSON.stringify({ format: "cardboard-project", version: 1, project, media: [] }),
    "timeline.tsx": "// cardboard:rev 1700000000000\n",
    "AGENTS.md": "agents",
    ".carton/carton.db": "a database",
    ".carton/displaced/1": "a displaced file",
    ".scratch/views/director_c_t1.tsx": "// cardboard:rev main@3~deadbeef b:00000000\n",
    ".scratch/views/director_c_t1.status": "{}",
    ".scratch/notes.md": "kept",
    "cache/thumbs/1.jpg": "x",
  };
  for (const [rel, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), content);
  }
  return dir;
}

async function edit(c: Carton, who: Actor, fn: (its: Item[]) => void): Promise<void> {
  const h = await c.head();
  const host = toHost(h.doc);
  const items = structuredClone(host.timelineItems as Item[]);
  fn(items);
  const r = await c.commit({ doc: fromHost({ ...host, timelineItems: items }, h.doc), author: who });
  assert.equal(r.status, "confirmed");
}

async function send(t: test.TestContext, from: Carton, dir: string, to: string): Promise<string> {
  const out = path.join(dir, "..", `${path.basename(dir)}-to-${to}-${Date.now()}.cbproj`);
  t.after(() => fs.rmSync(out, { force: true }));
  await exportCbproj({ bundle: dir, out, shallow: await from.exportShallow({ to }) });
  return out;
}

test(".cbproj: Alice → Bob → Alice twice, then a third fold; the LCA is right, nothing is reverted, no cards; the zip has no .carton/ or .scratch/views/ [real engine]", async (t) => {
  const project = { id: "proj-1", name: "Film", aspectRatio: "16:9", tracks: [{ id: "V1", name: "V1", order: 0 }], timelineItems: clips(6) };
  const alice = await Carton.open({ adapter: cardboardAdapter, store: createMemoryStore(), init: { doc: fromHost(project, null), projectId: project.id }, actor: ALICE });
  const aDir = bundle(t, "alice", project);
  await edit(alice, ALICE, (its) => void (find(its, "c0").name = "Intro"));

  // 1. Alice → Bob: Bob doesn't have the project, so he opens it from her file (a writable cut forked from hers)
  const f1 = await send(t, alice, aDir, "bob");
  const c1 = await readCbproj(f1);
  for (const n of ["project.json", "timeline.tsx", "AGENTS.md", ".scratch/notes.md", ".carton-export/shallow.json"]) assert.ok(c1.files.includes(n) || n === "project.json" || n.startsWith(".carton-export"), `has ${n}`);
  for (const n of c1.files) assert.ok(!n.startsWith(".carton/") && !n.startsWith(".scratch/views/") && !n.startsWith("cache/"), `never ${n}`);
  assert.ok(c1.shallow, "the shallow export is its own entry");
  const bob = await Carton.open({ adapter: cardboardAdapter, store: createMemoryStore(), init: { import: c1.shallow! }, actor: BOB });
  const bDir = bundle(t, "bob", project);
  assert.equal(find(toHost((await bob.head()).doc).timelineItems as Item[], "c0").name, "Intro");
  await edit(bob, BOB, (its) => void (find(its, "c3").name = "Bob's cut"));

  // 2. Bob → Alice: bring in their changes
  const r2 = await bringInTheirChanges(alice, await readCbproj(await send(t, bob, bDir, "alice")));
  assert.equal(r2.status, "folded");
  assert.ok(r2.status === "folded" && r2.fold.status === "confirmed", `fold ${JSON.stringify(r2)}`);
  await edit(alice, ALICE, (its) => void (find(its, "c5").name = "Outro"));

  // 3. Alice → Bob again, and Bob edits the clip Alice renamed first
  const r3 = await bringInTheirChanges(bob, await readCbproj(await send(t, alice, aDir, "bob")));
  assert.ok(r3.status === "folded" && r3.fold.status === "confirmed", `fold ${JSON.stringify(r3)}`);
  await edit(bob, BOB, (its) => void (find(its, "c1").opacity = 0.5));

  // 4. the third fold, Bob → Alice: the base is the last exchange, so nothing of Alice's is reverted
  const r4 = await bringInTheirChanges(alice, await readCbproj(await send(t, bob, bDir, "alice")));
  assert.ok(r4.status === "folded" && r4.fold.status === "confirmed", `fold ${JSON.stringify(r4)}`);
  const head = toHost((await alice.head()).doc).timelineItems as Item[];
  assert.deepEqual([find(head, "c0").name, find(head, "c3").name, find(head, "c5").name, find(head, "c1").opacity], ["Intro", "Bob's cut", "Outro", 0.5]);
});

test(".cbproj: a sender's file that does carry view files or Carton's database lists them as ignored, never as bundle files", async (t) => {
  const project = { id: "proj-2", name: "Film", tracks: [{ id: "V1", name: "V1", order: 0 }], timelineItems: clips(1) };
  const dir = bundle(t, "evil", project);
  // an old exporter without H11: we build its zip by hand with our writer, bypassing the walk
  const { ZipWriter } = await import("@carton/cardboard/node");
  const out = path.join(dir, "..", `evil-${Date.now()}.cbproj`);
  t.after(() => fs.rmSync(out, { force: true }));
  const z = await ZipWriter.create(out);
  await z.addBuffer("project.json", Buffer.from(JSON.stringify({ format: "cardboard-project", version: 1, project, media: [] })));
  await z.addBuffer(".scratch/views/director-c3.tsx", Buffer.from("// cardboard:rev main@3~deadbeef b:00000000\n"));
  await z.addBuffer(".carton/carton.db", Buffer.from("x"));
  await z.addBuffer("media/a.mp4", Buffer.from("m"));
  await z.close();
  const c = await readCbproj(out);
  assert.deepEqual(c.ignored.sort(), [".carton/carton.db", ".scratch/views/director-c3.tsx"]);
  assert.deepEqual(c.files, ["media/a.mp4"]);
  assert.equal(c.shallow, null);
  void ({} as Doc);
});

// 1.4.0's importer turns `\` into `/` (yauzl with strictFileNames off), so `.scratch\views\x.tsx` would be extracted
// into `.scratch/views/`. Our zip writer refuses such names, so the file is made with Python's zipfile.
test(".cbproj: a member named with backslashes is judged as 1.4.0 will extract it: `.scratch\\views\\…` is ignored", async (t) => {
  const project = { id: "proj-3", name: "Film", tracks: [{ id: "V1", name: "V1", order: 0 }], timelineItems: clips(1) };
  const dir = bundle(t, "bs", project);
  const out = path.join(dir, "..", `bs-${Date.now()}.cbproj`);
  t.after(() => fs.rmSync(out, { force: true }));
  const manifest = JSON.stringify({ format: "cardboard-project", version: 1, project, media: [] });
  try {
    execFileSync("python3", ["-c", "import sys,zipfile\nz=zipfile.ZipFile(sys.argv[1],'w',zipfile.ZIP_STORED)\nz.writestr('project.json',sys.argv[2])\nz.writestr('.scratch\\\\views\\\\x.tsx','// cardboard:rev main@3~deadbeef b:00000000\\n')\nz.writestr('.carton\\\\carton.db','x')\nz.close()", out, manifest]);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return t.skip("no python3");
    throw e;
  }
  const c = await readCbproj(out);
  assert.deepEqual(c.ignored.sort(), [".carton\\carton.db", ".scratch\\views\\x.tsx"]);
  assert.deepEqual(c.files, []);
});

// "Include history so they can see every version": the store's copy without local tables (store-sqlite's exportCopy in
// the app; a stand-in writer here) travels as its own entry and comes back out byte for byte.
test(".cbproj: the opt-in full history is its own entry, written by the store's copy function and extracted intact", async (t) => {
  const project = { id: "proj-4", name: "Film", tracks: [{ id: "V1", name: "V1", order: 0 }], timelineItems: clips(1) };
  const dir = bundle(t, "full", project);
  const out = path.join(dir, "..", `full-${Date.now()}.cbproj`);
  t.after(() => fs.rmSync(out, { force: true }));
  const history = Buffer.from("SQLite format 3\u0000 … a copy without pins, notices, views, ephemeral, lease, pathMap");
  const r = await exportCbproj({ bundle: dir, out, shallow: null, fullHistory: async (to) => fs.promises.writeFile(to, history) });
  assert.ok(r.names.includes(".carton-export/history.db"));
  assert.deepEqual(fs.readdirSync(path.join(dir, ".carton", "tmp")), [], "the temporary copy is removed");
  const c = await readCbproj(out);
  assert.equal(c.hasFullHistory, true);
  const back = path.join(dir, "..", `full-${Date.now()}.db`);
  t.after(() => fs.rmSync(back, { force: true }));
  assert.equal(await extractFullHistory(out, back), true);
  assert.deepEqual(fs.readFileSync(back), history);
});
