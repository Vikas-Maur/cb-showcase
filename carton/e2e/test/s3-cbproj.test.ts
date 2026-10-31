// Scenario 3: `.cbproj` collaboration with no server (PLAN §13, §5.3, §16 H11, §21 L17). Two machines, two libraries;
// the teammate's machine gets the project only through the file. Real processes and files:
//   - machine A's app (its engine thread holds the lease; the materializer keeps project.json and timeline.tsx on head)
//     takes a person's GUI saves and an agent's edits through its per-agent view, then does Save As: Cardboard's zip
//     plus Carton's shallow export, written in A's app process (s3-factory.ts);
//   - machine B opens the file in a process of its own (s3-open.ts: only the bundle files are unpacked; Carton opens
//     from the shallow export, so A's cut is a tracking cut and B's own cut forks from it), then B's app runs on it;
//   - each side edits (a GUI save, an agent through its view) and "Brings in their changes" from the other's file:
//     dry run first, a same-field clash is a conflict card (nothing saved until it is picked), the other edits land.
//     Three exchanges, then a third merge on B: every later merge finds its base through the lineage, never re-raises a
//     card already settled, never duplicates or resurrects a record, never loses an edit; credits survive (L17), and
//     both machines end on the same state;
//   - H11: no `.carton/` or `.scratch/views/` member in any file (both exist in every bundle exported), a hostile file
//     carrying them (backslash and `./` aliases too) has them ignored on import, and "Include history" carries no local
//     table and no absolute path;
//   - §13's other cases: the three-machine diamond, ripples carried on lineage edges (applied once, composed), the same
//     project id with no shared lineage, an agent mid-turn across a bring-in, and a tampered file refused whole.
// Bugs found here are `todo` tests named S3-<n> (owner and one-line cause in the todo text).
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { LOCAL_TABLES } from "@carton/core";
import { findRev } from "@carton/cardboard";
import { extractFullHistory, readCbproj, ZipReader } from "@carton/cardboard/node";
import { makeMachine, itemNamed, items, SAMPLE, type Item, type Machine } from "../support/project.ts";
import { Procs, runOnce, type Proc } from "../support/procs.ts";
import { dataDirFor, scratch, support, until } from "../support/env.ts";
import { cbOk } from "../support/cb.ts";
import { writeRawZip, zipNames } from "../support/s3-zip.ts";

type FieldSet = { name: string; field: string; value: unknown };
const serve = async (app: Proc, req: Record<string, unknown>) => (await app.ask({ cmd: "serve", req }, 90_000)).result;
const head = (app: Proc) => serve(app, { e2e: "head" });
/**
 * A person's GUI save (project.json, temp file + rename), then wait until the engine has applied it: project.json on
 * disk shows the save at once, but head moves only when the materializer has read it.
 */
async function gui(app: Proc, who: string, set: FieldSet[]): Promise<void> {
  await app.ask({ cmd: "serve", req: { e2e: "gui", who, set } });
  await until(async () => {
    const its = (await head(app)).items as Item[];
    return set.every((s) => its.find((i) => i.name === s.name)?.[s.field] === s.value);
  }, 20_000, `the engine to apply ${who}'s GUI save ${JSON.stringify(set)}`);
}

async function runAgent(procs: Procs, m: Machine, actor: string, steps: unknown[]): Promise<any> {
  const out = await procs.start(actor, [support("agent.ts"), m.bundle, m.projectId, JSON.stringify({ steps })], { env: { CARDBOARD_ACTOR: actor } }).next((x) => Array.isArray(x.results), 120_000);
  for (const s of out.results) assert.equal(s.status, "confirmed", `${actor}: ${JSON.stringify(s)}`);
  return out;
}

/**
 * One scenario's processes. At the end each app quits as the app does (hands the lease over and removes its control
 * socket, which on a deep library path lives in the OS temp folder), then whatever is left is killed.
 */
function world(t: { after: (fn: () => Promise<void>) => void }) {
  const procs = new Procs();
  const apps: Proc[] = [];
  t.after(async () => {
    await Promise.all(apps.filter((a) => a.alive).map((a) => a.ask({ cmd: "exit" }, 15_000).catch(() => undefined)));
    await procs.close();
  });
  async function startApp(m: Machine, name: string): Promise<Proc> {
    procs.watchHelpers(m.dbDir);
    const app = procs.start(name, [support("s3-app.ts"), m.bundle, m.projectId, "{}"]);
    apps.push(app);
    await app.next((x) => x.ready);
    return app;
  }
  return { procs, startApp };
}

/** A machine whose library doesn't have the project yet: it gets it only by opening a `.cbproj`. */
function emptyMachine(name: string, projectId: string): Machine {
  const home = scratch(name);
  const bundle = join(home, "lib", "Sample.cardboard");
  return { home, lib: join(home, "lib"), bundle, projectId, dbDir: join(bundle, ".carton") };
}

async function openCbproj(file: string, m: Machine): Promise<any> {
  const r = await runOnce("open", [support("s3-open.ts"), file, m.bundle]);
  assert.equal(r.code, 0, `open ${file}: ${r.stdout}${r.stderr}`);
  return r.lines.at(-1);
}

const H11 = (n: string) => /^(\.[\\/])?\.carton[\\/]/i.test(n) || /^\.scratch[\\/](\.[\\/])?views[\\/]/i.test(n);
/** Every file under `dir`, `/`-separated, except carton.db and its -wal/-shm (the recipient's own database). */
function filesUnder(dir: string, rel = ""): string[] {
  const out: string[] = [];
  for (const d of readdirSync(join(dir, rel), { withFileTypes: true })) {
    const r = rel ? `${rel}/${d.name}` : d.name;
    if (d.isDirectory()) out.push(...filesUnder(dir, r));
    else if (!/^\.carton\/carton\.db(-wal|-shm)?$/.test(r)) out.push(r);
  }
  return out.sort();
}
const viewFiles = (m: Machine) => (existsSync(join(m.bundle, ".scratch", "views")) ? readdirSync(join(m.bundle, ".scratch", "views")).filter((f) => f.endsWith(".tsx")) : []);

/** How an absolute path can appear in a file: as is, JSON-escaped (Windows backslashes), or with forward slashes. */
const pathForms = (p: string): string[] => [...new Set([p, JSON.stringify(p).slice(1, -1), p.replace(/\\/g, "/")])];

/** Save As in the machine's app process; checks H11 on the file it wrote (the bundle does have both folders). */
async function saveAs(app: Proc, m: Machine, to: string, n: number, extra: Record<string, unknown> = {}): Promise<{ file: string; r: any }> {
  assert.ok(existsSync(join(m.bundle, ".carton", "carton.db")), "the bundle has .carton/carton.db");
  assert.ok(viewFiles(m).length > 0, "the bundle has view files under .scratch/views/");
  const file = join(m.home, `to-${to}-${n}.cbproj`);
  const r = await serve(app, { e2e: "saveAs", out: file, to, ...extra });
  const names = zipNames(file);
  assert.deepEqual(names, r.names, "the central directory lists exactly what the export wrote");
  assert.deepEqual(names.filter(H11), [], `H11: no .carton/ or .scratch/views/ member in ${file}`);
  for (const must of ["project.json", "timeline.tsx", ".carton-export/shallow.json"]) assert.ok(names.includes(must), `${file} has ${must}`);
  // nothing in the file names a folder of the sender's machine (Cardboard's manifest re-roots media; Carton's entry has none)
  const z = await ZipReader.open(file);
  try {
    for (const e of ["project.json", ".carton-export/shallow.json"]) {
      const text = (await z.readEntry(e)).toString("utf8");
      for (const f of pathForms(m.home)) assert.ok(!text.includes(f), `${e} has no absolute path of the sender's machine (${f})`);
    }
  } finally {
    await z.close();
  }
  return { file, r };
}

const bringIn = (app: Proc, file: string, who: string, opts: { check?: boolean; choices?: unknown } = {}) => serve(app, { e2e: "bringIn", file, who, ...opts });

/** Every record once, in project.json and in head. */
function noDuplicates(m: Machine, h: { items: Item[] }): void {
  for (const list of [items(m), h.items]) {
    const ids = list.map((i) => i.id);
    assert.equal(new Set(ids).size, ids.length, `no record twice: ${ids.join(",")}`);
  }
}

/** project.json caught up with head after a bring-in (the materializer was told; the GUI always shows head). */
async function filesShowHead(app: Proc, pred: () => boolean, what: string): Promise<any> {
  await until(pred, 20_000, `${what} in project.json`);
  return head(app);
}

/**
 * An agent on that machine prints its view after a bring-in (the shared timeline.tsx may be frozen while agents are
 * active, §6.4 R8-01, L16): the view is pinned at the fold's version and shows what came in.
 */
async function viewShowsHead(procs: Procs, m: Machine, h: { ref: { seq: number } }, actor: string, check: (its: Item[]) => void): Promise<void> {
  const out = await runAgent(procs, m, actor, []);
  assert.match(out.view.ref, new RegExp(`@${h.ref.seq}~`), `${actor}'s view is printed at head (${h.ref.seq}): ${out.view.ref}`);
  const text = readFileSync(join(m.bundle, ...out.view.path.split("/")), "utf8");
  check(JSON.parse(text.slice(text.indexOf("\n{") + 1)).timelineItems as Item[]);
}

const credit = async (m: Machine, clip: string) => (await cbOk(m, ["credits", clip])).by?.id ?? null;

test("S3 .cbproj with no server: A → B → A three times plus a third merge; clash as a card, base through the lineage, no re-raised card, no duplicate, credits kept (L17), both converge; H11 on every file", { timeout: 420_000 }, async (t) => {
  const { procs, startApp } = world(t);

  // --- machine A: history by a person and an agent through its view
  const A = makeMachine("s3-a");
  const appA = await startApp(A, "appA");
  const id = Object.fromEntries(Object.entries(SAMPLE).map(([k, n]) => [k, itemNamed(A, n)!.id])) as Record<keyof typeof SAMPLE, string>;
  await gui(appA, "alice", [{ name: SAMPLE.title, field: "fontSize", value: 150 }]);
  await until(() => itemNamed(A, SAMPLE.title)?.fontSize === 150, 20_000, "A's GUI save");
  await runAgent(procs, A, "director/chatA/turn1", [{ op: "set", name: SAMPLE.logo, set: { zIndex: 5 } }]);
  await until(() => itemNamed(A, SAMPLE.logo)?.zIndex === 5, 20_000, "A's agent edit in project.json");

  // --- A → B: Save As; B's library gets the project only from the file
  const f1 = await saveAs(appA, A, "bob", 1);
  const B = emptyMachine("s3-b", A.projectId);
  const opened = await openCbproj(f1.file, B);
  assert.deepEqual(opened.ignored, [], "a clean export has nothing to ignore");
  assert.deepEqual(filesUnder(B.bundle), ["project.json", "timeline.tsx"], "only the bundle files were unpacked (plus B's own carton.db)");
  const tracking = opened.cuts.find((c: any) => c.tracking);
  const mine = opened.cuts.find((c: any) => !c.tracking);
  assert.ok(tracking && mine, `A's cut is a tracking cut and B has a writable one: ${JSON.stringify(opened.cuts)}`);
  assert.equal(opened.cut, mine.id, "B's current cut is its own");
  assert.equal(mine.forkOf, f1.r.shallowHead, "B's cut forks from A's head as exported (§5.3)");
  assert.equal(opened.head.hash, f1.r.headHash, "B starts exactly at A's exported state");
  const appB = await startApp(B, "appB");
  let hB = await head(appB);
  assert.equal(hB.hash, f1.r.headHash);
  assert.equal(itemNamed(B, SAMPLE.title)!.fontSize, 150, "A's GUI edit is in B's project.json");
  assert.equal(itemNamed(B, SAMPLE.logo)!.zIndex, 5, "A's agent edit is in B's project.json");
  // the unpacked timeline.tsx carried A's header; B's app re-prints it for B's own cut
  const bRev = await until(() => { const r = findRev(readFileSync(join(B.bundle, "timeline.tsx"), "utf8"))?.rev as any; return r?.branch8 === mine.id.slice(0, 8) && r; }, 20_000, "B's timeline.tsx printed for B's cut");
  assert.match(bRev.ref, /@0~/);
  // L17: the shallow file carries the last author per record
  assert.equal(await credit(B, SAMPLE.title), "human:alice", "B sees who last changed the title on A");
  assert.equal(await credit(B, SAMPLE.logo), "director/chatA/turn1", "B sees A's agent on the logo");

  // --- exchange 1: B edits and sends; A edits meanwhile (another clip, and the same field B changed)
  await gui(appB, "bob", [{ name: SAMPLE.title, field: "textContent", value: "Bob's words" }]);
  await runAgent(procs, B, "director/chatB/turn1", [{ op: "set", name: SAMPLE.tone, set: { volume: 40 } }]);
  await until(() => itemNamed(B, SAMPLE.title)?.textContent === "Bob's words" && itemNamed(B, SAMPLE.tone)?.volume === 40, 20_000, "B's edits");
  const f2 = await saveAs(appB, B, "alice", 2);

  await gui(appA, "alice", [{ name: SAMPLE.clipFast, field: "playbackSpeed", value: 3 }]);
  await gui(appA, "alice", [{ name: SAMPLE.title, field: "textContent", value: "Alice's words" }]);
  await until(() => itemNamed(A, SAMPLE.title)?.textContent === "Alice's words" && itemNamed(A, SAMPLE.clipFast)?.playbackSpeed === 3, 20_000, "A's edits");
  const beforeA = await head(appA);

  // dry run (`cb fold --check`): the clash is listed, nothing is saved
  const dry = await bringIn(appA, f2.file, "alice", { check: true });
  assert.equal(dry.status, "folded", JSON.stringify(dry));
  assert.equal(dry.fold.status, "conflicts", `the dry run shows the clash: ${JSON.stringify(dry.fold)}`);
  assert.equal((await head(appA)).ref.seq, beforeA.ref.seq, "a dry run saves nothing");
  // the real thing without a pick: one card, on the title's text, both values kept; still nothing saved
  const r1 = await bringIn(appA, f2.file, "alice");
  assert.equal(r1.fold.status, "conflicts", JSON.stringify(r1));
  const cards = r1.fold.cards as any[];
  assert.equal(cards.length, 1, `one card: ${JSON.stringify(cards)}`);
  assert.ok(cards[0].path.includes(id.title), `the card is on the title: ${cards[0].path}`);
  assert.deepEqual([cards[0].ours, cards[0].theirs].map((v: any) => JSON.stringify(v).includes("Alice's words") ? "A" : JSON.stringify(v).includes("Bob's words") ? "B" : v), ["A", "B"], "both edits are on the card");
  assert.equal((await head(appA)).ref.seq, beforeA.ref.seq, "a fold with an unpicked card saves nothing (never silently lost)");
  // the person keeps theirs on the card; B's other edit lands, A's other edit stays
  const r1b = await bringIn(appA, f2.file, "alice", { choices: { [cards[0].path]: "ours" } });
  assert.equal(r1b.fold.status, "confirmed", JSON.stringify(r1b));
  let hA = await filesShowHead(appA, () => itemNamed(A, SAMPLE.tone)?.volume === 40, "B's agent edit on A");
  await viewShowsHead(procs, A, hA, "director/chatA/turn2", (its) => {
    assert.equal(its.find((i) => i.id === id.tone)?.volume, 40, "B's agent edit is in A's agent's view");
    assert.equal(its.find((i) => i.id === id.title)?.textContent, "Alice's words");
  });
  assert.equal(itemNamed(A, SAMPLE.title)!.textContent, "Alice's words", "A's pick");
  assert.equal(itemNamed(A, SAMPLE.title)!.fontSize, 150);
  assert.equal(itemNamed(A, SAMPLE.clipFast)!.playbackSpeed, 3, "A's edit on another clip stays");
  assert.equal(itemNamed(A, SAMPLE.logo)!.zIndex, 5);
  noDuplicates(A, hA);
  let histA = await cbOk(A, ["history"]);
  assert.equal(histA.versions[0].kind, "merge", JSON.stringify(histA.versions[0]));
  assert.equal(histA.versions[0].by?.id, "human:alice", "the fold is the person's");
  assert.equal(await credit(A, SAMPLE.tone), "director/chatB/turn1", "credits name B's agent for its edit (L17)");
  assert.equal(await credit(A, SAMPLE.title), "human:alice");
  // bringing in the same file again changes nothing
  const again = await bringIn(appA, f2.file, "alice");
  assert.equal(again.fold.status, "up-to-date", JSON.stringify(again));

  // --- exchange 2: A sends, B brings in (the settled card must not come back); B sends, A brings in
  await gui(appA, "alice", [{ name: SAMPLE.logo, field: "zIndex", value: 9 }]);
  await until(() => itemNamed(A, SAMPLE.logo)?.zIndex === 9, 20_000, "A's logo edit");
  const f3 = await saveAs(appA, A, "bob", 3);
  await gui(appB, "bob", [{ name: SAMPLE.clipA, field: "opacity", value: 0.3 }]);
  await runAgent(procs, B, "director/chatB/turn2", [{ op: "insert", like: SAMPLE.title, id: "bob-title-1", name: "Bob title", set: { textContent: "added by B", startTime: 3, endTime: 4, trimStart: 0, trimEnd: 1 } }]);
  await until(() => itemNamed(B, "Bob title") && itemNamed(B, SAMPLE.clipA)?.opacity === 0.3, 20_000, "B's edits");
  const dry2 = await bringIn(appB, f3.file, "bob", { check: true });
  assert.equal(dry2.fold.status, "confirmed", `no card on B: the title was settled on A: ${JSON.stringify(dry2.fold)}`);
  const r2 = await bringIn(appB, f3.file, "bob");
  assert.equal(r2.fold.status, "confirmed", JSON.stringify(r2));
  hB = await filesShowHead(appB, () => itemNamed(B, SAMPLE.logo)?.zIndex === 9, "A's logo on B");
  assert.equal(itemNamed(B, SAMPLE.title)!.textContent, "Alice's words", "A's pick reached B, with no card");
  assert.equal(itemNamed(B, SAMPLE.clipFast)!.playbackSpeed, 3);
  assert.equal(itemNamed(B, SAMPLE.clipA)!.opacity, 0.3, "B's own edit stays");
  assert.equal(itemNamed(B, SAMPLE.tone)!.volume, 40);
  noDuplicates(B, hB);
  assert.equal(await credit(B, SAMPLE.clipFast), "human:alice");
  assert.equal(await credit(B, SAMPLE.logo), "human:alice");
  assert.equal(await credit(B, "Bob title"), "director/chatB/turn2");
  const f4 = await saveAs(appB, B, "alice", 4);

  await gui(appA, "alice", [{ name: SAMPLE.tone, field: "volume", value: 20 }]);
  await until(() => itemNamed(A, SAMPLE.tone)?.volume === 20, 20_000, "A's tone edit");
  const r3 = await bringIn(appA, f4.file, "alice");
  assert.equal(r3.fold.status, "confirmed", `no card on A's second bring-in: ${JSON.stringify(r3)}`);
  hA = await filesShowHead(appA, () => itemNamed(A, SAMPLE.clipA)?.opacity === 0.3, "B's clip A edit on A");
  assert.equal(items(A).filter((i) => i.name === "Bob title").length, 1, "B's new clip once");
  assert.equal(itemNamed(A, SAMPLE.tone)!.volume, 20, "A's newer tone edit is kept (B's older one is the base now)");
  assert.equal(itemNamed(A, SAMPLE.title)!.textContent, "Alice's words");
  noDuplicates(A, hA);
  assert.equal(await credit(A, "Bob title"), "director/chatB/turn2", "B's agent credited for its clip on A");
  // B's older file arriving late is already in (its head is an export node in the newer file's lineage)
  const late = await bringIn(appA, f2.file, "alice");
  assert.equal(late.fold.status, "up-to-date", `an older file after a newer one changes nothing: ${JSON.stringify(late)}`);

  // --- the third merge: both edit again, B brings in A's file; then A brings in B's, and both machines agree
  await gui(appA, "alice", [{ name: "Bob title", field: "textContent", value: "Alice touched it" }]);
  await until(() => itemNamed(A, "Bob title")?.textContent === "Alice touched it", 20_000, "A edits B's clip");
  const f5 = await saveAs(appA, A, "bob", 5);
  await gui(appB, "bob", [{ name: SAMPLE.clipFast, field: "playbackSpeed", value: 1.5 }]);
  await runAgent(procs, B, "director/chatB/turn3", [{ op: "remove", name: SAMPLE.badge }]);
  await until(() => !itemNamed(B, SAMPLE.badge) && itemNamed(B, SAMPLE.clipFast)?.playbackSpeed === 1.5, 20_000, "B's edits");
  const r4 = await bringIn(appB, f5.file, "bob");
  assert.equal(r4.fold.status, "confirmed", `third merge: no card, nothing re-raised: ${JSON.stringify(r4)}`);
  hB = await filesShowHead(appB, () => itemNamed(B, "Bob title")?.textContent === "Alice touched it", "A's edit of B's clip on B");
  await viewShowsHead(procs, B, hB, "director/chatB/turn4", (its) => {
    assert.equal(its.find((i) => i.id === "bob-title-1")?.textContent, "Alice touched it", "the third merge is in B's agent's view");
    assert.equal(its.find((i) => i.id === id.badge), undefined);
  });
  assert.equal(itemNamed(B, SAMPLE.badge), undefined, "the clip B removed stays removed");
  assert.equal(itemNamed(B, SAMPLE.clipFast)!.playbackSpeed, 1.5, "B's newer edit stays");
  assert.equal(itemNamed(B, SAMPLE.tone)!.volume, 20, "A's tone edit lands");
  assert.equal(itemNamed(B, SAMPLE.title)!.textContent, "Alice's words");
  assert.equal(itemNamed(B, SAMPLE.title)!.fontSize, 150);
  assert.equal(items(B).filter((i) => i.name === "Bob title").length, 1);
  noDuplicates(B, hB);
  assert.equal(await credit(B, "Bob title"), "human:alice", "A's edit of B's clip is credited to A's person");
  assert.equal(await credit(B, SAMPLE.tone), "human:alice");

  const f6 = await saveAs(appB, B, "alice", 6);
  const r5 = await bringIn(appA, f6.file, "alice");
  assert.equal(r5.fold.status, "confirmed", JSON.stringify(r5));
  hA = await filesShowHead(appA, () => !itemNamed(A, SAMPLE.badge) && itemNamed(A, SAMPLE.clipFast)?.playbackSpeed === 1.5, "B's third round on A");
  hB = await head(appB);
  assert.equal(hA.hash, hB.hash, "both machines end on the same state");
  noDuplicates(A, hA);
  histA = await cbOk(A, ["history", "--limit", "100"]);
  assert.equal(histA.versions.filter((v: any) => v.kind === "merge").length, 3, "three folds on A (the dry runs and the unpicked try saved nothing)");
  assert.equal(await credit(A, SAMPLE.badge).catch(() => null), null, "no credits for a removed clip");
  assert.equal(await credit(A, SAMPLE.clipFast), "human:bob", "B's person credited on A");
  assert.equal(await credit(A, SAMPLE.logo), "human:alice");
});

test("S3 H11: a hostile .cbproj carrying .carton/ and .scratch/views/ members (aliases too) has them ignored, and opening it never unpacks them", { timeout: 180_000 }, async (t) => {
  const { procs, startApp } = world(t);
  const A = makeMachine("s3-h11");
  const appA = await startApp(A, "appA");
  await runAgent(procs, A, "director/chatH/turn1", [{ op: "set", name: SAMPLE.logo, set: { zIndex: 4 } }]);
  const { file } = await saveAs(appA, A, "carol", 1);
  // a sender without H11: the honest members plus Carton's database, view files, and the names 1.4.0's extraction
  // resolves into those folders
  const z = await ZipReader.open(file);
  const honest: { name: string; data: Buffer }[] = [];
  try {
    for (const e of z.entries) honest.push({ name: e.name, data: await z.readEntry(e.name) });
  } finally {
    await z.close();
  }
  const hostile = [".carton/carton.db", ".carton/displaced/1", ".scratch/views/director_x.tsx", ".scratch\\views\\x.tsx", "./.carton/carton.db", ".scratch/./views/y.tsx", ".carton\\carton.db"];
  const evil = join(A.home, "evil.cbproj");
  writeRawZip(evil, [...honest, ...hostile.map((name) => ({ name, data: "// cardboard:rev Main cut@3~deadbeef b:00000000\nnot a database" })), { name: "notes/readme.md", data: "kept" }]);
  assert.deepEqual(zipNames(evil).filter(H11).sort(), [...hostile].sort(), "the file does carry them");
  const c = await readCbproj(evil);
  assert.deepEqual([...c.ignored].sort(), [...hostile].sort(), "every one of them is ignored");
  assert.deepEqual([...c.files].sort(), ["notes/readme.md", "timeline.tsx"]);

  const C = emptyMachine("s3-carol", A.projectId);
  const o = await openCbproj(evil, C);
  assert.deepEqual([...o.ignored].sort(), [...hostile].sort());
  assert.equal(readFileSync(join(C.bundle, "notes", "readme.md"), "utf8"), "kept");
  assert.deepEqual(filesUnder(C.bundle), ["notes/readme.md", "project.json", "timeline.tsx"], "no view file and nothing of the sender's .carton/ unpacked");
  // the carton.db there is the one Carton made from the shallow export, not the sender's bytes
  assert.equal(readFileSync(join(C.bundle, ".carton", "carton.db")).subarray(0, 15).toString("latin1"), "SQLite format 3");
  assert.equal(o.head.hash, (await head(appA)).hash);
});

test("S3 Include history: the full copy travels as .carton-export/history.db with no local table and no absolute path", { timeout: 180_000 }, async (t) => {
  const { procs, startApp } = world(t);
  const A = makeMachine("s3-full");
  const appA = await startApp(A, "appA");
  await gui(appA, "alice", [{ name: SAMPLE.title, field: "fontSize", value: 120 }]);
  await runAgent(procs, A, "director/chatF/turn1", [{ op: "set", name: SAMPLE.logo, set: { zIndex: 6 } }]);
  // the local tables do hold rows in the live database (lease, views, pins), so dropping them is real
  const live = new DatabaseSync(join(A.dbDir, "carton.db"), { readOnly: true });
  const liveTables = (live.prepare("SELECT name FROM sqlite_schema WHERE type = 'table'").all() as { name: string }[]).map((r) => r.name);
  live.close();
  const localLive = liveTables.filter((n) => LOCAL_TABLES.has(n));
  assert.ok(localLive.includes("lease") && localLive.includes("views"), `the live database has local tables: ${liveTables.join(",")}`);

  // a received copy's Carton entries that an unpatched importer extracted into the bundle are never passed along
  mkdirSync(join(A.bundle, ".carton-export"), { recursive: true });
  writeFileSync(join(A.bundle, ".carton-export", "shallow.json"), "{\"stale\": true}");
  writeFileSync(join(A.bundle, ".carton-export", "history.db"), "stale");
  const { file, r } = await saveAs(appA, A, "carol", 1, { history: true });
  const names = zipNames(file);
  assert.equal(names.filter((n) => n === ".carton-export/history.db").length, 1, "one history entry");
  assert.equal(names.filter((n) => n === ".carton-export/shallow.json").length, 1, "one shallow entry");
  const c = await readCbproj(file);
  assert.equal(c.hasFullHistory, true);
  assert.equal(c.shallow?.head, r.shallowHead, "the shallow entry is this export's, not the stale one");
  assert.ok(!c.files.some((f) => f.startsWith(".carton-export")), "the history entry is never unpacked as a bundle file");
  const db = join(scratch("s3-full-out"), "history.db");
  assert.equal(await extractFullHistory(file, db), true);
  const bytes = readFileSync(db);
  for (const f of pathForms(A.home)) assert.ok(!bytes.includes(Buffer.from(f)), `no absolute path of the sender's machine in the copy (${f})`);
  const h = new DatabaseSync(db, { readOnly: true });
  try {
    const tables = (h.prepare("SELECT name FROM sqlite_schema WHERE type = 'table'").all() as { name: string }[]).map((r) => r.name);
    assert.deepEqual(tables.filter((n) => LOCAL_TABLES.has(n)), [], `no local table in the copy: ${tables.join(",")}`);
    for (const must of ["cuts", "changes"]) assert.ok(tables.some((n) => n === must), `the copy has ${must}: ${tables.join(",")}`);
    const rows = (h.prepare("SELECT count(*) AS n FROM changes").get() as { n: number }).n;
    assert.ok(rows >= 3, `every version is there (import, GUI save, agent edit): ${rows}`);
  } finally {
    h.close();
  }
  assert.ok(!existsSync(join(A.bundle, ".carton", "tmp")) || readdirSync(join(A.bundle, ".carton", "tmp")).length === 0, "the temporary copy is removed");
});

// §13 "the diamond" (the Criticiser's shallow-chain), across three machines, with each file opened or brought in by a
// real process: A (Bob in the plan) sends A@30 to C (Carol), then A@35 to B (Alice), whose lineage carries the export
// node A@30 with its state; C sends C@40 to B. B's merge base over the lineage is A@30, so the title A changed between
// the two exports is "Summer" with no card. Then B → A: A finds its own A@35 export as the base, and C's edit lands.
test("S3 the diamond: A → C, A → B, C → B finds the base A@30 through the lineage (no card); then B → A", { timeout: 300_000 }, async (t) => {
  const { procs, startApp } = world(t);
  const A = makeMachine("s3-dia-a");
  const appA = await startApp(A, "appA");
  await runAgent(procs, A, "director/chatD/turn1", [{ op: "set", name: SAMPLE.logo, set: { zIndex: 3 } }]);
  await gui(appA, "bob", [{ name: SAMPLE.title, field: "textContent", value: "Spring" }]);
  await until(() => itemNamed(A, SAMPLE.title)?.textContent === "Spring", 20_000, "A's first title");
  const toC = await saveAs(appA, A, "carol", 30);
  await gui(appA, "bob", [{ name: SAMPLE.title, field: "textContent", value: "Summer" }]);
  await until(() => itemNamed(A, SAMPLE.title)?.textContent === "Summer", 20_000, "A's second title");
  const toB = await saveAs(appA, A, "alice", 35);

  const C = emptyMachine("s3-dia-c", A.projectId);
  await openCbproj(toC.file, C);
  const appC = await startApp(C, "appC");
  const B = emptyMachine("s3-dia-b", A.projectId);
  const openedB = await openCbproj(toB.file, B);
  const appB = await startApp(B, "appB");
  assert.equal(itemNamed(B, SAMPLE.title)!.textContent, "Summer");

  await gui(appC, "carol", [{ name: SAMPLE.tone, field: "volume", value: 33 }]);
  await until(() => itemNamed(C, SAMPLE.tone)?.volume === 33, 20_000, "C's edit");
  await runAgent(procs, C, "director/chatC/turn1", [{ op: "set", name: SAMPLE.clipA, set: { opacity: 0.6 } }]);
  const fromC = await saveAs(appC, C, "alice", 40);
  await gui(appB, "alice", [{ name: SAMPLE.clipFast, field: "playbackSpeed", value: 4 }]);
  await runAgent(procs, B, "director/chatAl/turn1", [{ op: "set", name: SAMPLE.clipFast, set: { autoReframe: false } }]);

  const r = await bringIn(appB, fromC.file, "alice");
  assert.equal(r.status, "folded", JSON.stringify(r));
  assert.equal(r.fold.status, "confirmed", `the base is A@30 (carried in A@35's lineage): no card: ${JSON.stringify(r.fold)}`);
  const hB = await filesShowHead(appB, () => itemNamed(B, SAMPLE.tone)?.volume === 33, "C's edit on B");
  assert.equal(itemNamed(B, SAMPLE.title)!.textContent, "Summer", "A's newer title is kept (the base was A@30, not older)");
  assert.equal(itemNamed(B, SAMPLE.clipA)!.opacity, 0.6, "C's agent edit lands");
  assert.equal(itemNamed(B, SAMPLE.clipFast)!.playbackSpeed, 4, "B's own edit stays");
  assert.equal(itemNamed(B, SAMPLE.clipFast)!.autoReframe, false, "and B's agent's");
  assert.equal(itemNamed(B, SAMPLE.logo)!.zIndex, 3);
  noDuplicates(B, hB);
  assert.equal(await credit(B, SAMPLE.tone), "human:carol", "C's person credited on B");
  assert.equal(await credit(B, SAMPLE.clipA), "director/chatC/turn1");
  assert.equal(await credit(B, SAMPLE.title), "human:bob");
  assert.ok(openedB.cuts.length >= 2);

  // B → A: A's own export A@35 is in B's lineage; C's and B's edits land on A with no card
  const back = await saveAs(appB, B, "bob", 41);
  const r2 = await bringIn(appA, back.file, "bob");
  assert.equal(r2.fold.status, "confirmed", JSON.stringify(r2));
  const hA = await filesShowHead(appA, () => itemNamed(A, SAMPLE.tone)?.volume === 33 && itemNamed(A, SAMPLE.clipFast)?.playbackSpeed === 4, "C's and B's edits on A");
  assert.equal(hA.hash, (await head(appB)).hash, "A and B agree");
  assert.equal(await credit(A, SAMPLE.clipA), "director/chatC/turn1", "credits travel two hops (C → B → A)");
  assert.equal(itemNamed(A, SAMPLE.clipFast)!.autoReframe, false);
});

// §13: "A project with the same id and no shared lineage gets a new id". Two libraries that each turned the same
// Cardboard project (same project.id, e.g. copied before Carton was installed) into a Carton project on their own.
test("S3 the same project id with no shared lineage: bringing it in folds nothing and says so", { timeout: 180_000 }, async (t) => {
  const { procs, startApp } = world(t);
  const X = makeMachine("s3-nolin-x");
  const Y = makeMachine("s3-nolin-y");
  assert.equal(X.projectId, Y.projectId);
  const appX = await startApp(X, "appX");
  const appY = await startApp(Y, "appY");
  await runAgent(procs, Y, "director/chatY/turn1", [{ op: "set", name: SAMPLE.logo, set: { zIndex: 8 } }]);
  const fromY = await saveAs(appY, Y, "x", 1);
  const before = await head(appX);
  const r = await bringIn(appX, fromY.file, "x");
  assert.equal(r.status, "no-shared-lineage", JSON.stringify(r));
  assert.equal((await head(appX)).hash, before.hash, "nothing folded");
  assert.equal(itemNamed(X, SAMPLE.logo)!.zIndex, 2);
  assert.equal((await head(appX)).cuts.length, 1, "no tracking cut was added");
});

// S3-3 (fixed by foundation-core; was todo): "A project with the same id and no shared lineage gets a new id" (§13). History.importShallow answers
// `{status: "no-shared-lineage", newProjectId}`, and bringInTheirChanges passes `imp.newProjectId` on, but
// Carton.importShallow (core/src/carton.ts:916) returns only `{status, cut?}`: the new id (and the import's `head`) is
// dropped between core and the adapter, so the app has no id to open the copy under.
test("S3-3 bringing in a same-id project with no shared lineage offers a new project id", async () => {
  const { Carton } = await import("@carton/core");
  const { openSqliteStore } = await import("@carton/store-sqlite");
  const { cardboardAdapter } = await import("@carton/cardboard");
  const { bringInTheirChanges, readProjectForImport } = await import("@carton/cardboard/node");
  const X = makeMachine("s3-3-x");
  const doc = readProjectForImport(X.bundle).doc;
  const open = async (n: string) => Carton.open({ adapter: cardboardAdapter as any, store: await openSqliteStore(join(X.home, `${n}.db`)), init: { doc, projectId: X.projectId, asChange: true } });
  const x = await open("x");
  const y = await open("y");
  try {
    const r = await bringInTheirChanges(x, { shallow: await y.exportShallow({ to: "x" }) });
    assert.equal(r.status, "no-shared-lineage");
    assert.match(String((r as { newProjectId?: string }).newProjectId), /^[0-9a-f]{8,}$/, `a new id is offered: ${JSON.stringify(r)}`);
  } finally {
    await x.close();
    await y.close();
  }
});

// S3-1 (fixed by local-cli; was todo): every replica is called "replica". `Carton.open({name})` is "a display name for this replica in lineage
// and dialogs ("Bob")", but no product entry point can set it (`openLocal`'s LocalOptions, local's default factory,
// the Windows facade's openLocal call), so every cut's owner and every `.cbproj`'s sender is "replica": a recipient's
// two "Main cut"s can't be told apart ("Bob's main", §5.3), and the missing-base dialog reads "This copy builds on a
// version from replica… Ask replica for their copy" (§13).
test("S3-1 a .cbproj names its sender (not \"replica\"), a copied cut keeps its owner's name, and bringing it in keeps the recipient's", async () => {
  const { openLocal } = await import("@carton/local");
  const { cardboardAdapter } = await import("@carton/cardboard");
  const { bringInTheirChanges, readProjectForImport } = await import("@carton/cardboard/node");
  const person = (id: string, name: string, group: string) => ({ kind: "human", id: `human:${id}`, name, group }) as any;
  const open = (m: Machine, who: any, init?: unknown) => openLocal({ projectDir: m.bundle, projectId: m.projectId, dataDir: dataDirFor(m.bundle), adapter: cardboardAdapter as any, actor: who, ...(init ? { init } : {}) } as any);
  // Alice's project; Bob's copy of it (her carton.db without local tables, his own replica)
  const A = makeMachine("s3-1-a");
  const la = await open(A, person("alice", "Alice", "alice@laptop"), { doc: readProjectForImport(A.bundle).doc });
  try {
    const mine = await la.carton.exportShallow({ to: "bob" });
    assert.equal(mine.sender, "Alice", "Alice's file names her");
    assert.equal((await la.carton.cuts())[0]!.owner, "Alice", "her cut names her");
  } finally {
    await la.close();
  }
  const B = makeMachine("s3-1-b", A);
  const cl = await runOnce("clone", [support("clone.ts"), join(A.dbDir, "carton.db"), join(B.dbDir, "carton.db")]);
  assert.equal(cl.code, 0, cl.stderr);
  const lb = await open(B, person("bob", "Bob", "bob@desk"));
  let theirs;
  try {
    theirs = await lb.carton.exportShallow({ to: "alice" });
    assert.equal(theirs.sender, "Bob", "Bob's file names him, not the replica he copied");
    assert.equal((await lb.carton.cuts())[0]!.owner, "Alice", "the cut he copied stays Alice's");
  } finally {
    await lb.close();
  }
  // Alice brings in Bob's file: it is from Bob, and her own cut is still hers
  const la2 = await open(A, person("alice", "Alice", "alice@laptop"));
  try {
    const r = await bringInTheirChanges(la2.carton as any, { shallow: theirs });
    assert.notEqual(r.status, "no-shared-lineage", JSON.stringify(r));
    assert.deepEqual((await la2.carton.cuts()).map((c: any) => c.owner), ["Alice"]);
  } finally {
    await la2.close();
  }
});

// S3-2 (todo): "Include history so they can see every version" (§13, L17) has no recipient path. The file carries
// `.carton-export/history.db` and `extractFullHistory` writes it out ("to be opened read-only and imported as tracking
// cuts"), but nothing imports a carton.db copy: `Carton` has no such method (History.importFull takes a JSON
// FullExport, and Carton doesn't expose it), and `bringInTheirChanges` / an import with `init: {import}` read only the
// shallow export. So the recipient sees the sender's cut as a shallow tracking cut with no versions, and "Undo this
// agent turn" for the sender's agents (L17) can't work.
test("S3-2 opening a file with history shows the sender's versions", { todo: "S3-2, foundation-core + cardboard-adapter: no API imports .carton-export/history.db as tracking cuts", timeout: 180_000 }, async (t) => {
  const { procs, startApp } = world(t);
  const A = makeMachine("s3-2-a");
  const appA = await startApp(A, "appA");
  await gui(appA, "alice", [{ name: SAMPLE.title, field: "fontSize", value: 111 }]);
  await runAgent(procs, A, "director/chatS2/turn1", [{ op: "set", name: SAMPLE.logo, set: { zIndex: 7 } }]);
  const { file } = await saveAs(appA, A, "bob", 1, { history: true });
  const B = emptyMachine("s3-2-b", A.projectId);
  const opened = await openCbproj(file, B);
  const appB = await startApp(B, "appB");
  const theirs = opened.cuts.find((c: any) => c.tracking);
  const log = await cbOk(B, ["history", "--cut", theirs.id, "--limit", "50"]).catch((e) => ({ versions: [], error: String(e) }));
  assert.ok(log.versions.some((v: any) => v.by?.id === "director/chatS2/turn1"), `B lists A's agent's version: ${JSON.stringify(log).slice(0, 400)}`);
  void appB;
});

// §13 "remaps per lineage edge" through real files: a ripple made on one machine travels on the `.cbproj`'s lineage
// edge and moves the other machine's concurrent clip once, never twice, across three exchanges. The ripples are GUI
// saves of a trim with ripple (one save: the clip's end and every later clip on V1), whose remap is inferred at commit;
// the concurrent clips are agents' inserts later on V1.
test("S3 ripples travel in the .cbproj lineage: applied once to the other side's clips, never re-applied, composed over three exchanges", { timeout: 300_000 }, async (t) => {
  const { procs, startApp } = world(t);
  const A = makeMachine("s3-rip-a");
  const appA = await startApp(A, "appA");
  await runAgent(procs, A, "director/chatR/turn1", [{ op: "set", name: SAMPLE.tone, set: { volume: 50 } }]);
  const f1 = await saveAs(appA, A, "bob", 1);
  const B = emptyMachine("s3-rip-b", A.projectId);
  await openCbproj(f1.file, B);
  const appB = await startApp(B, "appB");
  const at = (its: Item[], name: string) => { const i = its.find((x) => x.name === name); return i ? [i.startTime, i.endTime] : null; };
  const V1 = (h: { items: Item[] }) => Object.fromEntries(h.items.filter((i) => i.trackId === itemNamed(A, SAMPLE.logo)?.trackId || i.name?.endsWith(" late")).map((i) => [i.name, [i.startTime, i.endTime]]));

  // 1. B trims Clip A's end by 1 s with ripple; A's agent meanwhile adds a clip at 6–7 on V1
  await gui(appB, "bob", [
    { name: SAMPLE.clipA, field: "endTime", value: 0.5 }, { name: SAMPLE.clipA, field: "trimEnd", value: 0.75 },
    { name: SAMPLE.clipFast, field: "startTime", value: 0.5 }, { name: SAMPLE.clipFast, field: "endTime", value: 1.5 },
    { name: SAMPLE.logo, field: "startTime", value: 1.5 }, { name: SAMPLE.logo, field: "endTime", value: 3 },
  ]);
  await runAgent(procs, B, "director/chatRB/turn1", [{ op: "set", name: SAMPLE.tone, set: { volume: 55 } }]);
  const f2 = await saveAs(appB, B, "alice", 2);
  await runAgent(procs, A, "director/chatR/turn2", [{ op: "insert", like: SAMPLE.logo, id: "a-late", name: "A late", set: { startTime: 6, endTime: 7, trimStart: 0, trimEnd: 1 } }]);
  const r1 = await bringIn(appA, f2.file, "alice");
  assert.equal(r1.fold.status, "confirmed", JSON.stringify(r1));
  let hA = await filesShowHead(appA, () => itemNamed(A, SAMPLE.logo)?.startTime === 1.5, "B's ripple on A");
  assert.deepEqual(at(hA.items, "A late"), [5, 6], `B's ripple moved A's concurrent clip by −1 s (carried on the lineage edge): ${JSON.stringify(V1(hA))}`);
  assert.deepEqual(at(hA.items, SAMPLE.clipFast), [0.5, 1.5]);

  // 2. A → B: B's own ripple is already in both; nothing moves twice
  const f3 = await saveAs(appA, A, "bob", 3);
  const r2 = await bringIn(appB, f3.file, "bob");
  assert.equal(r2.fold.status, "confirmed", JSON.stringify(r2));
  let hB = await filesShowHead(appB, () => !!itemNamed(B, "A late"), "A's clip on B");
  assert.deepEqual(at(hB.items, "A late"), [5, 6], `not moved twice: ${JSON.stringify(V1(hB))}`);
  assert.deepEqual([at(hB.items, SAMPLE.clipA), at(hB.items, SAMPLE.clipFast), at(hB.items, SAMPLE.logo)], [[0, 0.5], [0.5, 1.5], [1.5, 3]], "B's clips stay where B's ripple put them");
  assert.equal(hB.hash, (await head(appA)).hash, "B now matches A");

  // 3. a ripple in the other direction: A trims the logo's end by 0.5 s with ripple; B's agent meanwhile adds a clip at
  //    8–9. B brings in A's file: A's new ripple moves B's clip once; A's earlier clip moves with A's ripple, not again
  await gui(appA, "alice", [
    { name: SAMPLE.logo, field: "endTime", value: 2.5 }, { name: SAMPLE.logo, field: "trimEnd", value: 1 },
    { name: "A late", field: "startTime", value: 4.5 }, { name: "A late", field: "endTime", value: 5.5 },
  ]);
  const f4 = await saveAs(appA, A, "bob", 4);
  await runAgent(procs, B, "director/chatRB/turn2", [{ op: "insert", like: SAMPLE.logo, id: "b-late", name: "B late", set: { startTime: 8, endTime: 9, trimStart: 0, trimEnd: 1 } }]);
  const r3 = await bringIn(appB, f4.file, "bob");
  assert.equal(r3.fold.status, "confirmed", JSON.stringify(r3));
  hB = await filesShowHead(appB, () => itemNamed(B, SAMPLE.logo)?.endTime === 2.5, "A's second ripple on B");
  assert.deepEqual(at(hB.items, "B late"), [7.5, 8.5], `A's ripple moved B's concurrent clip by −0.5 s: ${JSON.stringify(V1(hB))}`);
  assert.deepEqual(at(hB.items, "A late"), [4.5, 5.5], "A's clip where A put it");
  assert.deepEqual(at(hB.items, SAMPLE.clipFast), [0.5, 1.5], "B's first ripple not applied again");

  // and back to A: the clip B added (already mapped on B) is not moved again on A; both agree
  const f5 = await saveAs(appB, B, "alice", 5);
  const r4 = await bringIn(appA, f5.file, "alice");
  assert.equal(r4.fold.status, "confirmed", JSON.stringify(r4));
  hA = await filesShowHead(appA, () => !!itemNamed(A, "B late"), "B's clip on A");
  assert.deepEqual(at(hA.items, "B late"), [7.5, 8.5], `not moved again on A: ${JSON.stringify(V1(hA))}`);
  assert.equal(hA.hash, (await head(appB)).hash, "A and B agree");
});

// An agent mid-turn on A while the person brings in a teammate's file: its view was printed before the fold, so its
// saves are based on a state without the teammate's edits. They must land without reverting what came in, and an edit
// of a field the teammate changed (from the agent's stale view) is a card that keeps head's value, never an overwrite.
test("S3 an agent's view printed before a bring-in: its later saves keep the teammate's edits; a stale clash is a card", { timeout: 240_000 }, async (t) => {
  const { procs, startApp } = world(t);
  const A = makeMachine("s3-mid-a");
  const appA = await startApp(A, "appA");
  await runAgent(procs, A, "director/chatM/turn1", [{ op: "set", name: SAMPLE.logo, set: { zIndex: 4 } }]);
  const f1 = await saveAs(appA, A, "bob", 1);
  const B = emptyMachine("s3-mid-b", A.projectId);
  await openCbproj(f1.file, B);
  const appB = await startApp(B, "appB");
  await gui(appB, "bob", [{ name: SAMPLE.tone, field: "volume", value: 40 }, { name: SAMPLE.title, field: "fontSize", value: 64 }]);
  await runAgent(procs, B, "director/chatMB/turn1", [{ op: "set", name: SAMPLE.clipA, set: { opacity: 0.2 } }]);
  const f2 = await saveAs(appB, B, "alice", 2);

  const actor = "director/chatM/turn2";
  const ag = procs.start(actor, [support("agent.ts"), A.bundle, A.projectId, JSON.stringify({ waitGo: true, steps: [
    { op: "set", name: SAMPLE.logo, set: { zIndex: 11 } },
    { op: "set", name: SAMPLE.tone, set: { volume: 77 } },
  ] })], { env: { CARDBOARD_ACTOR: actor } });
  const printed = (await ag.next((x) => x.printed, 60_000)).printed;
  const r = await bringIn(appA, f2.file, "alice");
  assert.equal(r.fold.status, "confirmed", JSON.stringify(r));
  await filesShowHead(appA, () => itemNamed(A, SAMPLE.tone)?.volume === 40, "B's edits on A");
  ag.p.stdin!.write("go\n");
  const out = await ag.next((x) => Array.isArray(x.results), 120_000);
  assert.equal(out.view.ref, printed.ref, "the agent kept its pre-fold print");
  assert.equal(out.results[0].status, "confirmed", `its edit of a clip B didn't touch lands: ${JSON.stringify(out.results[0])}`);
  assert.equal(out.results[1].status, "conflicts", `its stale edit of B's field is a card: ${JSON.stringify(out.results[1])}`);
  const h = await filesShowHead(appA, () => itemNamed(A, SAMPLE.logo)?.zIndex === 11, "the agent's edit on A");
  const its = h.items as Item[];
  assert.equal(its.find((i) => i.name === SAMPLE.tone)?.volume, 40, "head keeps B's value on the clash");
  assert.equal(its.find((i) => i.name === SAMPLE.clipA)?.opacity, 0.2, "B's agent edit was not reverted by the stale view");
  assert.equal(its.find((i) => i.name === SAMPLE.title)?.fontSize, 64, "B's GUI edit was not reverted by the stale view");
  noDuplicates(A, h);
});

// A file whose shallow export was tampered with (a carried state that doesn't match its hash) is refused whole: nothing
// imported, nothing folded, no tracking cut or lineage left behind in the running app (the next Save As carries none of
// it), and the honest file still comes in afterwards.
test("S3 a tampered shallow export is refused whole and leaves nothing behind", { timeout: 240_000 }, async (t) => {
  const { procs, startApp } = world(t);
  const A = makeMachine("s3-tamper-a");
  const appA = await startApp(A, "appA");
  await runAgent(procs, A, "director/chatT/turn1", [{ op: "set", name: SAMPLE.logo, set: { zIndex: 4 } }]);
  const f1 = await saveAs(appA, A, "bob", 1);
  const B = emptyMachine("s3-tamper-b", A.projectId);
  await openCbproj(f1.file, B);
  const appB = await startApp(B, "appB");
  await runAgent(procs, B, "director/chatTB/turn1", [{ op: "set", name: SAMPLE.tone, set: { volume: 12 } }]);
  const f2 = await saveAs(appB, B, "alice", 2);

  const z = await ZipReader.open(f2.file);
  const members: { name: string; data: Buffer }[] = [];
  try {
    for (const e of z.entries) members.push({ name: e.name, data: await z.readEntry(e.name) });
  } finally {
    await z.close();
  }
  const sh = members.find((m) => m.name === ".carton-export/shallow.json")!;
  const pkg = JSON.parse(sh.data.toString("utf8"));
  const tone = (pkg.states[pkg.headHash].doc.timelineItems as Item[]).find((i) => i.name === SAMPLE.tone)!;
  tone.volume = 99; // the head state no longer matches its hash
  sh.data = Buffer.from(JSON.stringify(pkg));
  const bad = join(B.home, "tampered.cbproj");
  writeRawZip(bad, members);

  const before = await head(appA);
  await assert.rejects(bringIn(appA, bad, "alice"), /does not match its hash/, "the tampered file is refused");
  const after = await head(appA);
  assert.equal(after.hash, before.hash, "nothing folded");
  assert.deepEqual(after.cuts.map((c: any) => c.id).sort(), before.cuts.map((c: any) => c.id).sort(), "no tracking cut left behind");
  const f3 = await saveAs(appA, A, "carol", 3);
  const c3 = await readCbproj(f3.file);
  const bCut = pkg.head.split("@")[0];
  assert.ok(!c3.shallow!.nodes.some((n) => n.branchId === bCut), "the next export carries no node of the refused file");
  // the honest file still comes in
  const ok = await bringIn(appA, f2.file, "alice");
  assert.equal(ok.fold.status, "confirmed", JSON.stringify(ok));
  await filesShowHead(appA, () => itemNamed(A, SAMPLE.tone)?.volume === 12, "B's edit on A");
});
