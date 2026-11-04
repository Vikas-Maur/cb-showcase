// Who made a cut: its fork version's author ("Made this cut" in History, `cb history`), laptop #2's fold-author fix.
// Codex's review of it (fix/lap2-fold-author 717916d) found the maker, kept as `by` on the cut record, broke writes from
// a client without it (its record CAS compares the whole record), broke History when malformed, and was lost by a
// full-history import. The maker is kept beside the cut record, never in it; read only when it is a well-formed actor;
// and carried by every way a cut's history travels (the store, importHistory, exportFull/importFull).
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Carton, History, LOCAL_TABLES, type Actor, type CutRecord } from "@carton/core";
import type { Store } from "@carton/core/plugins";
import { createMemoryStore } from "../src/index.ts";
import { adapter, doc0, item, schema, set } from "./fixture.ts";
import { copyStore } from "./world.ts";

const alice: Actor = { kind: "human", id: "alice", name: "Alice" };
const terminal: Actor = { kind: "external", id: "terminal:alice@laptop", name: "Terminal" };
const by = (v: { author: Actor | null } | undefined) => (v?.author ? `${v.author.kind}/${v.author.id}` : "nobody");
const madeBy = async (c: Carton, cut: string) => by((await c.log({ cut })).find((v) => v.kind === "fork"));

// The fields a cut record has in a client from before the maker was recorded (core at feature/carton 755ff50): its
// loader rebuilds each record from exactly these (History.addCut, then updateCut), and every write on the cut is
// conditioned on that record being the one stored, whole.
const OLDER_CLIENT_FIELDS = ["id", "name", "forkOf", "owner", "kind", "tracking", "shallow", "sequencer", "at", "protected", "source"];
const asOlderClientHasIt = (rec: CutRecord) => Object.fromEntries(Object.entries(rec).filter(([k]) => OLDER_CLIENT_FIELDS.includes(k)));

test("review P2: a cut made with its maker recorded is still writable by a client that doesn't know makers", async () => {
  const store = createMemoryStore();
  const a = await Carton.open({ adapter, store, init: { doc: doc0() }, actor: terminal });
  const alt = await a.fork("Alt", { author: alice });
  assert.equal(await madeBy(a, alt.id), "human/alice", "Made this cut is the maker's");
  const stored = (await store.get<CutRecord>("cuts", [alt.id]))!;
  // the older client's edit on the cut: its rows, conditioned on the cut record it rebuilt (as its #flush does)
  const ok = await store.write([{ table: "changes", key: [alt.id, 1], value: { probe: true } }], [{ table: "cuts", key: [alt.id], expect: { equals: asOlderClientHasIt(stored) } }]);
  assert.equal(ok, true, "the older client's record is the stored one: " + JSON.stringify(stored));
  await store.write([{ table: "changes", key: [alt.id, 1], value: undefined }]);
  // and this client's own writes on it, a rename (conditioned on its record), an edit, go through as before
  await a.renameCut(alt.id, "Alt 2");
  assert.equal((await a.commit({ cut: alt.id, ops: [set("a", "name", "x")], author: alice })).status, "confirmed");
  await a.close();
  // another handle (another process: cb history) reads the maker from the store
  const again = await Carton.open({ adapter, store, actor: terminal });
  assert.equal(await madeBy(again, alt.id), "human/alice", "read again");
  assert.equal((await again.commit({ cut: alt.id, ops: [set("b", "name", "y")], author: alice })).status, "confirmed");
  await again.close();
});

// The older client itself: @carton/core as feature/carton had it before the maker was recorded (755ff50), taken from
// git into a scratch folder (its 35 files import nothing outside it). Skipped where git or that commit isn't there (a
// shallow checkout: CI's).
const OLDER_CORE = "755ff50";
function olderCore(): string | null {
  const git = (args: string[], cwd: string) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], maxBuffer: 64 << 20 });
  const here = path.dirname(fileURLToPath(import.meta.url));
  let top: string;
  try {
    top = git(["rev-parse", "--show-toplevel"], here).trim();
    git(["rev-parse", "--verify", "--quiet", `${OLDER_CORE}^{commit}`], top);
  } catch {
    return null;
  }
  const dir = fs.mkdtempSync(path.join(process.env.CARTON_TEST_DIR ?? os.tmpdir(), "carton-older-core-"));
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ type: "module" }));
  for (const f of git(["ls-tree", "-r", "--name-only", OLDER_CORE, "--", "carton/packages/core/src"], top).split("\n").filter(Boolean)) {
    const to = path.join(dir, path.relative("carton/packages/core", f));
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.writeFileSync(to, git(["show", `${OLDER_CORE}:${f}`], top));
  }
  return dir;
}

test("review P2: an older client (core at 755ff50) edits and renames a cut made with its maker recorded", async (t) => {
  const dir = olderCore();
  if (!dir) return t.skip(`git can't show ${OLDER_CORE} here`);
  try {
    const Older = (await import(pathToFileURL(path.join(dir, "src", "index.ts")).href)) as typeof import("@carton/core");
    const store = createMemoryStore();
    const a = await Carton.open({ adapter, store, init: { doc: doc0() }, actor: terminal });
    const alt = await a.fork("Alt", { author: alice });
    await a.close();
    // its loader rebuilds the cut record from the fields it knows, and every write on the cut is conditioned on that
    // record being the stored one, whole: with the maker in the record it never was (its edit failed after a minute of
    // retries, "a store condition that never holds")
    const old = await Older.Carton.open({ adapter, store, actor: alice });
    const r = await old.commit({ cut: alt.id, ops: [set("a", "name", "older")], author: alice });
    assert.equal(r.status, "confirmed", JSON.stringify(r));
    await old.renameCut(alt.id, "Alt (older)");
    await old.close();
    // its writes leave the maker where it is
    const again = await Carton.open({ adapter, store, actor: terminal });
    assert.equal(await madeBy(again, alt.id), "human/alice");
    assert.equal((await again.cuts()).find((c) => c.id === alt.id)?.name, "Alt (older)");
    assert.equal(item((await again.head(alt.id)).doc, "a")?.name, "older");
    await again.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("review P2: a fork another process made is credited to its maker here once this handle sees it", async () => {
  const store = createMemoryStore();
  const a = await Carton.open({ adapter, store, init: { doc: doc0() }, actor: terminal });
  const b = await Carton.open({ adapter, store, actor: terminal });
  const alt = await a.fork("Alt", { author: alice });
  assert.equal(await madeBy(b, alt.id), "human/alice");
  for (const c of [a, b]) await c.close();
});

test("review P3: a malformed maker is ignored, never shown (History reads ids as strings)", async () => {
  for (const bad of [{ kind: "agent", id: 42 }, { kind: "agent" }, { kind: "robot", id: "x" }, { kind: "agent", id: "director", name: 7 }, "alice", null, { kind: "agent", id: "director", agentId: ["a"] }]) {
    const store = createMemoryStore();
    const a = await Carton.open({ adapter, store, init: { doc: doc0() }, actor: terminal });
    const alt = await a.fork("Alt", { author: alice });
    await a.close();
    // a maker as a broken writer (or a hand edit) left it, wherever a maker could be read from
    const rec = (await store.get<CutRecord>("cuts", [alt.id]))!;
    await store.write([
      { table: "cuts", key: [alt.id], value: { ...rec, by: bad } },
      ...(await store.range("meta")).filter((e) => e.key[0] === "maker").map((e) => ({ table: "meta", key: e.key, value: bad })),
    ]);
    const again = await Carton.open({ adapter, store, actor: terminal });
    const fork = (await again.log({ cut: alt.id })).find((v) => v.kind === "fork");
    assert.equal(fork?.author ?? null, null, `${JSON.stringify(bad)}: no one, not ${JSON.stringify(fork?.author)}`);
    await again.close();
  }
  // nor from a full export
  const h = History.create(schema, doc0());
  const alt = h.fork(h.current, "Alt", { by: alice });
  const pkg = h.exportFull();
  for (const b of pkg.branches) if (b.id === alt) (b as { by?: unknown }).by = { kind: "agent", id: 42 };
  const k = new History(schema);
  k.importFull(pkg);
  assert.equal(k.log(alt).find((v) => v.kind === "fork")?.author ?? null, null, "a malformed maker in a full export");
});

/** A full-history copy as `.cbproj` "Include history" carries it: the store with the local tables dropped. */
async function historyCopy(from: Store): Promise<Store> {
  const to = await copyStore(from);
  for (const t of LOCAL_TABLES) {
    const rows = await to.range(t);
    if (rows.length) await to.write(rows.map((r) => ({ table: t, key: r.key, value: undefined })));
  }
  return to;
}

test("review P4: a full-history import keeps who made each cut", async () => {
  const sa = createMemoryStore();
  const a = await Carton.open({ adapter, store: sa, init: { doc: doc0(), projectId: "proj-maker" }, actor: terminal });
  const alt = await a.fork("Alt", { author: alice });
  await a.commit({ cut: alt.id, ops: [set("a", "name", "Alice's title")], author: alice });
  const file = { shallow: await a.exportShallow({ to: "bob" }), history: await historyCopy(sa) };
  // a .cbproj with history opened as its own project: the copy is the store
  const opened = await Carton.open({ adapter, store: file.history, actor: { kind: "human", id: "bob" } });
  assert.equal(await madeBy(opened, alt.id), "human/alice", "the copy opened");
  await opened.close();
  // brought into a teammate's project: importHistory
  const sb = createMemoryStore();
  const b = await Carton.open({ adapter, store: sb, init: { import: file.shallow }, actor: { kind: "human", id: "bob" } });
  const took = await b.importHistory(await historyCopy(sa));
  assert.ok(took.cuts.includes(alt.id), "Alt comes in: " + JSON.stringify(took));
  assert.equal(await madeBy(b, alt.id), "human/alice", "importHistory");
  await b.close();
  const again = await Carton.open({ adapter, store: sb, actor: { kind: "human", id: "bob" } });
  assert.equal(await madeBy(again, alt.id), "human/alice", "importHistory, read again");
  await again.close();
  // History's own full export
  const h = History.create(schema, doc0());
  const hAlt = h.fork(h.current, "Alt", { by: alice });
  const k = new History(schema);
  k.importFull(h.exportFull());
  assert.equal(by(k.log(hAlt).find((v) => v.kind === "fork")), "human/alice", "exportFull/importFull");
  await a.close();
});
