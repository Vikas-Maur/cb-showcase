// `.cbproj` collaboration end to end (PLAN §13, §16 H11) on the real engine and history: two replicas that never share
// a server pass Cardboard's own Save As files back and forth. Each file carries the shallow export; "Bring in their
// changes" folds the sender's head in through the DAG. Alice → Bob → Alice twice, then a third fold: the LCA is right
// and nothing is reverted. The zip never holds `.carton/` or `.scratch/views/`.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { Carton, LOCAL_TABLES, STORE_TABLES } from "@carton/core";
import type { Actor, Doc, ShallowExport } from "@carton/core";
import type { Store } from "@carton/core/plugins";
import { createMemoryStore } from "@carton/store-memory";
import { cardboardAdapter, fromHost, toHost } from "@carton/cardboard";
import zlib from "node:zlib";
import { exportCbproj, readCbproj, bringInTheirChanges, extractFullHistory, importFullHistory } from "@carton/cardboard/node";
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

/**
 * A zip of STORED members with exactly these names, written byte by byte: a sender's file our writer would refuse. No
 * zip library is used, because they rewrite names (Python's zipfile turns `\` into `/` on Windows), so the archive is
 * the same on every OS.
 */
function rawZip(entries: [name: string, data: string][]): Buffer {
  const parts: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const [name, text] of entries) {
    const n = Buffer.from(name, "utf8");
    const data = Buffer.from(text, "utf8");
    const crc = zlib.crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed: 2.0
    local.writeUInt16LE(0x0800, 6); // UTF-8 name
    local.writeUInt16LE(0x21, 12); // date 1980-01-01 (method 0, stored, and time 0 stay zero)
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(n.length, 26);
    parts.push(local, n, data);
    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4); // made by: MS-DOS, 2.0
    cd.writeUInt16LE(20, 6);
    cd.writeUInt16LE(0x0800, 8);
    cd.writeUInt16LE(0x21, 14);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(data.length, 20);
    cd.writeUInt32LE(data.length, 24);
    cd.writeUInt16LE(n.length, 28);
    cd.writeUInt32LE(offset, 42);
    central.push(cd, n);
    offset += local.length + n.length + data.length;
  }
  const dir = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(dir.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, dir, end]);
}

// 1.4.0's importer turns `\` into `/` (yauzl with strictFileNames off), so `.scratch\views\x.tsx` would be extracted
// into `.scratch/views/`. Our zip writer refuses such names, so the file is written by `rawZip`.
test(".cbproj: a member named with backslashes is judged as 1.4.0 will extract it: `.scratch\\views\\…` is ignored", async (t) => {
  const project = { id: "proj-3", name: "Film", tracks: [{ id: "V1", name: "V1", order: 0 }], timelineItems: clips(1) };
  const dir = bundle(t, "bs", project);
  const out = path.join(dir, "..", `bs-${Date.now()}.cbproj`);
  t.after(() => fs.rmSync(out, { force: true }));
  const manifest = JSON.stringify({ format: "cardboard-project", version: 1, project, media: [] });
  fs.writeFileSync(out, rawZip([["project.json", manifest], [".scratch\\views\\x.tsx", "// cardboard:rev main@3~deadbeef b:00000000\n"], [".carton\\carton.db", "x"]]));
  const c = await readCbproj(out);
  assert.deepEqual(c.ignored.sort(), [".carton\\carton.db", ".scratch\\views\\x.tsx"]);
  assert.deepEqual(c.files, []);
});

// A Save As while Carton installs timeline.tsx (displace, then link) can list the bundle in the moment the file is
// missing, or open it then: the export rides out that window instead of leaving the shared file out.
test(".cbproj: an export during an install of timeline.tsx still carries it", async (t) => {
  const project = { id: "proj-6", name: "Film", tracks: [{ id: "V1", name: "V1", order: 0 }], timelineItems: clips(1) };
  const dir = bundle(t, "window", project);
  const out = path.join(dir, "..", `window-${Date.now()}.cbproj`);
  t.after(() => fs.rmSync(out, { force: true }));
  const shared = path.join(dir, "timeline.tsx");
  const aside = path.join(dir, ".carton", "displaced", "1-install");
  fs.renameSync(shared, aside); // displaced: the name is missing until the link
  setTimeout(() => fs.copyFileSync(aside, shared), 15);
  const r = await exportCbproj({ bundle: dir, out, shallow: null });
  assert.ok(r.names.includes("timeline.tsx"), r.names.join(", "));
  const c = await readCbproj(out);
  assert.ok(c.files.includes("timeline.tsx"));
});

test(".cbproj: a timeline.tsx that is a symlink is never followed out of the bundle (review 6)", async (t) => {
  const project = { id: "proj-7", name: "Film", tracks: [{ id: "V1", name: "V1", order: 0 }], timelineItems: clips(1) };
  const dir = bundle(t, "symlink", project);
  const out = path.join(dir, "..", `symlink-${Date.now()}.cbproj`);
  const secret = path.join(dir, "..", `outside-${Date.now()}.txt`);
  t.after(() => fs.rmSync(out, { force: true }));
  t.after(() => fs.rmSync(secret, { force: true }));
  fs.writeFileSync(secret, "not the bundle's");
  fs.rmSync(path.join(dir, "timeline.tsx"), { force: true });
  try {
    fs.symlinkSync(secret, path.join(dir, "timeline.tsx"));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "EPERM") return t.skip("no symlink privilege (Windows without developer mode)");
    throw e;
  }
  const r = await exportCbproj({ bundle: dir, out, shallow: null });
  assert.ok(!r.names.includes("timeline.tsx"), r.names.join(", "));
  assert.ok(!fs.readFileSync(out).includes("not the bundle's"), "the outside file's bytes aren't in the archive");
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

// Review 1 #8: names that 1.4.0's extraction resolves into an excluded folder (`./.carton/…`, `.scratch/./views/…`),
// unsafe names, and a second member landing on a path already taken are all ignored.
test(".cbproj: aliases of excluded paths, unsafe names and colliding members are ignored", async (t) => {
  const project = { id: "proj-5", name: "Film", tracks: [{ id: "V1", name: "V1", order: 0 }], timelineItems: clips(1) };
  const dir = bundle(t, "alias", project);
  const out = path.join(dir, "..", `alias-${Date.now()}.cbproj`);
  t.after(() => fs.rmSync(out, { force: true }));
  const manifest = JSON.stringify({ format: "cardboard-project", version: 1, project, media: [] });
  const names = ["./.carton/carton.db", ".scratch/./views/x.tsx", "media//a.mp4", "media/a.mp4", "../escape.txt", "./.carton-export/shallow.json", "notes.md"];
  fs.writeFileSync(out, rawZip([["project.json", manifest], ...names.map((n): [string, string] => [n, "x"])]));
  const c = await readCbproj(out);
  assert.deepEqual(c.files, ["media//a.mp4", "notes.md"], "only one member per extracted path, and nothing excluded");
  assert.deepEqual(c.ignored.sort(), ["../escape.txt", "./.carton-export/shallow.json", "./.carton/carton.db", ".scratch/./views/x.tsx", "media/a.mp4"].sort());
});

// S3-2: "Include history so they can see every version" read back. The app copies carton.db without the local tables
// (store-sqlite's `exportCopy`) and opens the extracted copy read-only (`openSqliteStore`); here a JSON file of the
// sender's store rows stands in for both, so the whole path runs through a real `.cbproj` on the real engine.
async function writeHistory(from: Store, to: string): Promise<void> {
  const rows: [string, unknown, unknown][] = [];
  for (const table of Object.values(STORE_TABLES)) {
    if (LOCAL_TABLES.has(table)) continue;
    for (const r of await from.range(table)) rows.push([table, r.key, r.value]);
  }
  await fs.promises.writeFile(to, JSON.stringify(rows));
}
async function openHistory(p: string): Promise<Store> {
  const store = createMemoryStore();
  const rows = JSON.parse(await fs.promises.readFile(p, "utf8")) as [string, unknown, unknown][];
  if (rows.length) await store.write(rows.map(([table, key, value]) => ({ table, key: key as string[], value })));
  return store;
}
const DIRECTOR: Actor = { kind: "agent", id: "director/chatS2/turn1", name: "Director", group: "alice@laptop/director", turn: "turn1" };

test(".cbproj S3-2: a file sent with history shows the sender's versions, authors and names on the recipient [real engine]", async (t) => {
  const project = { id: "proj-8", name: "Film", aspectRatio: "16:9", tracks: [{ id: "V1", name: "V1", order: 0 }], timelineItems: clips(3) };
  const sa = createMemoryStore();
  const alice = await Carton.open({ adapter: cardboardAdapter, store: sa, init: { doc: fromHost(project, null), projectId: project.id }, actor: ALICE });
  const theirs = alice.cut;
  await edit(alice, ALICE, (its) => void (find(its, "c0").name = "Alice's title"));
  await edit(alice, DIRECTOR, (its) => void (find(its, "c1").name = "the Director's cut"));
  await alice.name((await alice.log({ limit: 1 }))[0]!.ref, "Sent to Bob");
  const dir = bundle(t, "history", project);
  const out = path.join(dir, "..", `history-${Date.now()}.cbproj`);
  t.after(() => fs.rmSync(out, { force: true }));
  await exportCbproj({ bundle: dir, out, shallow: await alice.exportShallow({ to: "bob" }), fullHistory: (to) => writeHistory(sa, to) });

  // Bob opens it (Open Project: init from the shallow export), then takes its history
  const c = await readCbproj(out);
  assert.equal(c.hasFullHistory, true);
  const bob = await Carton.open({ adapter: cardboardAdapter, store: createMemoryStore(), init: { import: c.shallow! }, actor: BOB });
  t.after(async () => {
    await alice.close();
    await bob.close();
  });
  const tmpDir = fs.mkdtempSync(path.join(SCRATCH, "history-tmp-"));
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));
  assert.deepEqual(await importFullHistory(bob, out, { openStore: openHistory, tmpDir }), { status: "imported", cuts: [theirs] });
  assert.deepEqual(fs.readdirSync(tmpDir), [], "the extracted copy is removed");
  const log = await bob.log({ cut: theirs });
  assert.deepEqual(log.map((v) => [v.author?.id ?? null, v.name ?? null]).slice(0, 2), [["director/chatS2/turn1", "Sent to Bob"], ["alice", null]], JSON.stringify(log.map((v) => [v.ref, v.author?.id])));
  assert.ok((await bob.cuts()).find((x) => x.id === theirs)?.tracking, "read-only: theirs");
  assert.deepEqual(await importFullHistory(bob, out, { openStore: openHistory, tmpDir }), { status: "imported", cuts: [] }, "a second time takes nothing");

  // a file without history, and another project's history
  const plain = await send(t, alice, dir, "carol");
  assert.deepEqual(await importFullHistory(bob, plain, { openStore: openHistory, tmpDir }), { status: "no-history" });
  const other = await Carton.open({ adapter: cardboardAdapter, store: createMemoryStore(), init: { doc: fromHost({ ...project, id: "proj-9" }, null), projectId: "proj-9" }, actor: ALICE });
  t.after(() => other.close());
  const so = (other as unknown as { store: Store }).store;
  const foreign = path.join(dir, "..", `foreign-${Date.now()}.cbproj`);
  t.after(() => fs.rmSync(foreign, { force: true }));
  await exportCbproj({ bundle: dir, out: foreign, shallow: await other.exportShallow({ to: "bob" }), fullHistory: (to) => writeHistory(so, to) });
  const refused = await importFullHistory(bob, foreign, { openStore: openHistory, tmpDir });
  assert.equal(refused.status, "refused");
  assert.match(refused.status === "refused" ? refused.reason : "", /another project/);
});

test(".cbproj S3-2: Bring in their changes takes a file's history too, then folds their head in [real engine]", async (t) => {
  const project = { id: "proj-10", name: "Film", aspectRatio: "16:9", tracks: [{ id: "V1", name: "V1", order: 0 }], timelineItems: clips(3) };
  const sa = createMemoryStore();
  const alice = await Carton.open({ adapter: cardboardAdapter, store: sa, init: { doc: fromHost(project, null), projectId: project.id }, actor: ALICE });
  const dir = bundle(t, "bring-history", project);
  const bob = await Carton.open({ adapter: cardboardAdapter, store: createMemoryStore(), init: { import: await alice.exportShallow({ to: "bob" }) }, actor: BOB });
  t.after(async () => {
    await alice.close();
    await bob.close();
  });
  await edit(alice, DIRECTOR, (its) => void (find(its, "c2").name = "the Director's edit"));
  const out = path.join(dir, "..", `bring-history-${Date.now()}.cbproj`);
  t.after(() => fs.rmSync(out, { force: true }));
  await exportCbproj({ bundle: dir, out, shallow: await alice.exportShallow({ to: "bob" }), fullHistory: (to) => writeHistory(sa, to) });
  const tmpDir = fs.mkdtempSync(path.join(SCRATCH, "history-tmp-"));
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));
  const r = await bringInTheirChanges(bob, await readCbproj(out), { history: { file: out, openStore: openHistory, tmpDir } });
  assert.equal(r.status, "folded", JSON.stringify(r));
  assert.deepEqual(r.history, { status: "imported", cuts: [alice.cut] });
  assert.equal(find(toHost((await bob.head()).doc).timelineItems as Item[], "c2").name, "the Director's edit");
  assert.ok((await bob.log({ cut: alice.cut })).some((v) => v.author?.id === "director/chatS2/turn1"), "and the version that made it, with its author");
});

// S3-4: a teammate whose project is a copy of yours (the bundle folder copied with its `.carton`: the same "Main cut"
// id, the same log up to the copy) edits and sends a .cbproj. Core read past this replica's log for the sender's node on
// that cut id and crashed (`TypeError … 'mergeOf'`), or took their states for ours ("up-to-date"). Core (foundation
// 6e47903) now takes such a cut in as a cut of its own, "<name> (<sender>)", whose lineage reaches the versions both
// share, and the fold brings the edit in; the adapter's diverged-copy answer stays a fallback (tested below).
async function copyAll(from: Store): Promise<Store> {
  const to = createMemoryStore();
  for (const table of Object.values(STORE_TABLES)) {
    const rows = await from.range(table);
    if (rows.length) await to.write(rows.map((r) => ({ table, key: r.key, value: JSON.parse(JSON.stringify(r.value)) })));
  }
  return to;
}

for (const bothEdited of [false, true])
  test(`.cbproj S3-4: a file from a copy of this project that ${bothEdited ? "both sides" : "only the sender"} edited folds in, their cut a cut of its own [real engine]`, async (t) => {
    const project = { id: "proj-11", name: "Film", aspectRatio: "16:9", tracks: [{ id: "V1", name: "V1", order: 0 }], timelineItems: clips(3) };
    const sa = createMemoryStore();
    const alice = await Carton.open({ adapter: cardboardAdapter, store: sa, init: { doc: fromHost(project, null), projectId: project.id }, actor: ALICE });
    const bob = await Carton.open({ adapter: cardboardAdapter, store: await copyAll(sa), actor: BOB });
    t.after(async () => {
      await alice.close();
      await bob.close();
    });
    assert.equal(bob.cut, alice.cut, "the copy holds the same cut id");
    await edit(bob, BOB, (its) => void (find(its, "c1").name = "Bob's edit"));
    if (bothEdited) await edit(alice, ALICE, (its) => void (find(its, "c2").name = "Alice's edit"));
    const mine = alice.cut;
    const file = await bob.exportShallow({ to: "alice" });
    const r = await bringInTheirChanges(alice, { shallow: file });
    assert.equal(r.status, "folded", JSON.stringify(r));
    assert.equal(r.status === "folded" ? r.fold.status : "", "confirmed");
    const items = toHost((await alice.head()).doc).timelineItems as Item[];
    assert.equal(find(items, "c1").name, "Bob's edit", "Bob's edit came in");
    if (bothEdited) assert.equal(find(items, "c2").name, "Alice's edit", "and Alice's stays");
    assert.equal(alice.cut, mine, "on Alice's own cut");
    const theirs = (await alice.cuts()).filter((c) => c.id !== mine && c.id.startsWith(mine));
    assert.equal(theirs.length, 1, "their same-id cut came in as a cut of its own");
    assert.ok(theirs[0]!.tracking || theirs[0]!.shallow, "read-only: theirs");
    // review 9 #3: the same file brought in again is up to date, not a failed copy
    const again = await bringInTheirChanges(alice, { shallow: file });
    assert.deepEqual([again.status, again.status === "folded" ? again.fold.status : null], ["folded", "up-to-date"], JSON.stringify(again));
  });

// The fallback is only a fallback: with a file that clashes with one of this replica's own cuts, it answers only when
// core refuses (a status it doesn't know) or throws; a core that brings the copy in (as a cut of its own) is left to do
// so, and its "up-to-date" stands (the same file a second time). Without a clash, core's errors are core's.
test(".cbproj S3-4: the diverged-copy answer is only a fallback for when core refuses or fails", async () => {
  const pkg = { format: "carton-shallow/1", projectId: "p", sender: "s", head: "c1@3", headHash: "theirs", branches: {}, states: {}, lastAuthor: {}, nodes: [{ id: "c1@3", branchId: "c1", seq: 3, hash: "theirs", kinds: ["head"], parents: [] }] } as unknown as ShallowExport;
  const target = (fold: () => Promise<{ status: string }>, clash = true) => ({
    importShallow: async () => ({ status: "imported", head: "c1 (s)@3" }),
    fold,
    cuts: async () => [{ id: clash ? "c1" : "other", name: "Main cut", sequencer: { kind: "local" } }],
    head: async () => ({ ref: { seq: 3 } }),
    resolve: async () => ({ doc: {} }),
    schema: cardboardAdapter.schema,
  });
  const ok = await bringInTheirChanges(target(async () => ({ status: "confirmed" })), { shallow: pkg });
  assert.deepEqual(ok, { status: "folded", fold: { status: "confirmed" } }, "core brought the copy in: no fallback");
  const threw = await bringInTheirChanges(target(async () => Promise.reject(new TypeError("Cannot read properties of undefined (reading 'mergeOf')"))), { shallow: pkg });
  assert.equal(threw.status, "diverged-copy");
  assert.match(threw.status === "diverged-copy" ? threw.reason : "", /copy of this project.*mergeOf/);
  assert.deepEqual(await bringInTheirChanges(target(async () => ({ status: "up-to-date" })), { shallow: pkg }), { status: "folded", fold: { status: "up-to-date" } }, "core's up-to-date stands");
  await assert.rejects(bringInTheirChanges(target(async () => Promise.reject(new Error("database is locked")), false), { shallow: pkg }), /database is locked/, "no clash: core's error is core's");
});

test(".cbproj S3-4: a file naming newer versions of a shared cut than this replica has asks to sync first", async () => {
  const pkg = { format: "carton-shallow/1", projectId: "p", sender: "s", head: "c1@5", headHash: "h", branches: {}, states: {}, lastAuthor: {}, nodes: [{ id: "c1@5", branchId: "c1", seq: 5, hash: "h", kinds: ["head"], parents: [] }] } as unknown as ShallowExport;
  let imported = false;
  const target = {
    importShallow: async () => ((imported = true), { status: "imported", head: "c1@5" }),
    fold: async () => ({ status: "confirmed" }),
    cuts: async () => [{ id: "c1", name: "Main cut", sequencer: { kind: "server" } }],
    head: async () => ({ ref: { seq: 2 } }),
    resolve: async () => ({ doc: {} }),
    schema: cardboardAdapter.schema,
  };
  const r = await bringInTheirChanges(target, { shallow: pkg });
  assert.equal(r.status, "behind", JSON.stringify(r));
  assert.equal(imported, false);
});

test(".cbproj review 8 #5: a damaged history entry is reported, and the rest of the file still comes in [real engine]", async (t) => {
  const project = { id: "proj-12", name: "Film", aspectRatio: "16:9", tracks: [{ id: "V1", name: "V1", order: 0 }], timelineItems: clips(3) };
  const alice = await Carton.open({ adapter: cardboardAdapter, store: createMemoryStore(), init: { doc: fromHost(project, null), projectId: project.id }, actor: ALICE });
  const bob = await Carton.open({ adapter: cardboardAdapter, store: createMemoryStore(), init: { import: await alice.exportShallow({ to: "bob" }) }, actor: BOB });
  t.after(async () => {
    await alice.close();
    await bob.close();
  });
  await edit(alice, DIRECTOR, (its) => void (find(its, "c1").name = "the Director's edit"));
  const dir = bundle(t, "damaged-history", project);
  const out = path.join(dir, "..", `damaged-history-${Date.now()}.cbproj`);
  t.after(() => fs.rmSync(out, { force: true }));
  const MARK = "HISTORY-COPY-MARKER-7f3a9c";
  await exportCbproj({ bundle: dir, out, shallow: await alice.exportShallow({ to: "bob" }), fullHistory: (to) => fs.promises.writeFile(to, `${MARK} a copy of carton.db`) });
  // one byte of the stored history entry flips in transit: its CRC no longer matches
  const zip = fs.readFileSync(out);
  const at = zip.indexOf(MARK);
  assert.ok(at > 0);
  zip[at] = zip[at]! ^ 0x20;
  fs.writeFileSync(out, zip);
  const tmpDir = fs.mkdtempSync(path.join(SCRATCH, "history-tmp-"));
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));
  const r = await bringInTheirChanges(bob, await readCbproj(out), { history: { file: out, openStore: openHistory, tmpDir } });
  assert.equal(r.status, "folded", JSON.stringify(r));
  assert.equal(r.history?.status, "refused");
  assert.match(r.history?.status === "refused" ? r.history.reason : "", /history can't be read/);
  assert.equal(find(toHost((await bob.head()).doc).timelineItems as Item[], "c1").name, "the Director's edit", "their changes came in");
  assert.deepEqual(fs.readdirSync(tmpDir), [], "nothing left behind");
});
