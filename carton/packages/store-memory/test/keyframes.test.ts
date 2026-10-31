// Keyframes and retention (Stage F4, PLAN §5.4): a cut persists a keyframe every K changes (and at named, fold, export
// and Published versions) and opens from its newest one instead of replaying every row. Reopened at 10,000 changes,
// the project is identical with and without its keyframes; a planted keyframe shows the open really starts there; and
// superseded periodic keyframes are dropped, so storage holds one per cut plus the milestones.
import { test } from "node:test";
import assert from "node:assert/strict";
import { Carton, hashDoc, type Actor, type Version } from "@carton/core";
import type { Store } from "@carton/core/plugins";
import { createMemoryStore } from "../src/index.ts";
import { adapter, clip, doc0, schema, set } from "./fixture.ts";
import { copyStore } from "./world.ts";

const N = Number(process.env.CARTON_KF_CHANGES ?? 10_000);
const alice: Actor = { kind: "human", id: "alice", group: "alice@laptop" };
const director = (turn: string): Actor => ({ kind: "agent", id: "director", name: "Director", group: "alice@laptop/director", turn });
const ITEMS = ["a", "b", "c", "d", "e", "f"];
const versions = (vs: Version[]) => vs.map((v) => [v.ref.branchId, v.ref.seq, v.change, v.author?.id ?? null, v.name ?? null, v.kind]);

/** A project with `n` changes on its main cut: names, moves, trims, clips added and removed, agent turns, named versions and a fold. */
async function build(store: Store, n: number) {
  const c = await Carton.open({ adapter, store, init: { doc: doc0() }, actor: alice });
  const main = c.cut;
  let variant: string | null = null;
  for (let i = 1; i <= n; i++) {
    const id = ITEMS[i % ITEMS.length]!;
    const author = i % 3 === 0 ? director(`t${Math.floor(i / 9)}`) : alice;
    const k = i % 5;
    const ops =
      k === 0 ? [set(id, "name", `${id} #${i}`)]
      : k === 1 ? [set(id, "trimStart", (i % 4) * 0.25)]
      : k === 2 ? [{ op: "insert" as const, path: ["items", `x${i}`], value: clip(`x${i}`, 30 + (i % 50), 31 + (i % 50), "t2") }]
      : k === 3 ? [{ op: "remove" as const, path: ["items", `x${i - 1}`] }]
      : [set(id, "style", { color: `#${(i % 4096).toString(16).padStart(3, "0")}` })];
    assert.equal((await c.commit({ ops, author })).status, "confirmed", `change ${i}`);
    if (i % 1000 === 0) await c.name((await c.log({ limit: 1 }))[0]!.ref, `Checkpoint ${i / 1000}`);
    if (i === Math.floor(n * 0.3)) {
      variant = (await c.fork("Variant")).id;
      for (let j = 0; j < 40; j++) await c.commit({ cut: variant, ops: [set("f", "note", `variant ${j}`)], author: director("v") });
      await c.switchTo(main);
    }
    if (variant && i === Math.floor(n * 0.3) + 50) assert.equal((await c.fold(variant, { into: main })).status, "confirmed");
  }
  await c.close();
  return { main, variant: variant! };
}

/** Everything a reopened project answers that depends on replaying its rows. */
async function snapshot(store: Store, main: string, variant: string) {
  const c = await Carton.open({ adapter, store, actor: alice });
  const head = (await c.head(main)).doc;
  const at: Record<number, string> = {};
  for (const s of [1, 63, 64, 65, 1000, Math.floor(N / 2), N - 1, N]) at[s] = hashDoc(await c.checkout(`${main}@${s}`), schema);
  const credits: unknown[] = [];
  for (const id of ITEMS) credits.push(await c.credits(["items", id], { cut: main, detail: true }));
  const out = {
    head: hashDoc(head, schema),
    variantHead: hashDoc((await c.head(variant)).doc, schema),
    log: versions(await c.log({ cut: main })),
    at,
    credits,
    undo: (await c.undoStack("alice@laptop/director", { cut: main })).slice(0, 20).map((e) => [e.changeId, e.label]),
  };
  return { c, out };
}

const dropKeyframes = async (s: Store) => {
  const kfs = (await s.range("keyframes")).filter((e) => (e.key[1] as number) > 0);
  if (kfs.length) await s.write(kfs.map((e) => ({ table: "keyframes", key: e.key, value: undefined })));
  return kfs.length;
};

test(`F4: reopened at ${N} changes, a project is identical with and without its keyframes; opening starts from the newest`, { timeout: 600_000 }, async () => {
  const store = createMemoryStore();
  const { main, variant } = await build(store, N);

  // what is kept: per cut the newest periodic keyframe, plus the named, fold and export versions' (and the roots)
  const kept = (await store.range("keyframes")).map((e) => [e.key[0], e.key[1]] as [string, number]);
  const mainKf = kept.filter(([b, s]) => b === main && s > 0).map(([, s]) => s);
  const rows = N + 1; // the fold is a row of its own
  assert.ok(mainKf.includes(rows - (rows % 64)), `the newest periodic keyframe (${rows - (rows % 64)}) is kept: ${mainKf.join(",")}`);

  const withKf = await snapshot(store, main, variant);
  const milestones = withKf.out.log.filter((v) => v[4] !== null || v[5] === "merge").map((v) => v[1] as number);
  assert.equal(milestones.length, Math.floor(N / 1000) + 1, "the named versions and the fold");
  for (const s of milestones) assert.ok(mainKf.includes(s), `the named or fold version at ${s} keeps its keyframe`);
  assert.ok(mainKf.length <= milestones.length + 2, `superseded periodic keyframes are dropped (${mainKf.length} kept for ${N} changes)`);

  const bare = await copyStore(store);
  assert.ok((await dropKeyframes(bare)) > 0);
  const without = await snapshot(bare, main, variant);
  assert.deepEqual(withKf.out, without.out, "identical with and without keyframes");
  assert.equal(withKf.out.log.length, N + 2, "every version (and the root and the fold's own row)");

  // both keep working the same way: the next change lands on the same state
  const next = { ops: [set("a", "name", "after reopen")], author: alice };
  assert.equal((await withKf.c.commit(next)).status, "confirmed");
  assert.equal((await without.c.commit(next)).status, "confirmed");
  assert.equal(hashDoc((await withKf.c.head(main)).doc, schema), hashDoc((await without.c.head(main)).doc, schema));
  await withKf.c.close();
  await without.c.close();

  // proof that the open starts from the newest keyframe: a doctored one (a root field no change touches) shows through
  const planted = await copyStore(store);
  const newest = (await planted.range<Record<string, unknown>>("keyframes", { prefix: [main], reverse: true, limit: 1 }))[0]!;
  await planted.write([{ table: "keyframes", key: newest.key, value: { ...newest.value, name: "PLANTED" } }]);
  const p = await Carton.open({ adapter, store: planted, actor: alice });
  assert.equal((await p.head(main)).doc.name, "PLANTED", "rows before the keyframe were not replayed");
  await p.close();
});

test("F4: a keyframe is written with its rows, never without them; a named version and a fold keep theirs", async () => {
  const store = createMemoryStore();
  const c = await Carton.open({ adapter, store, init: { doc: doc0() }, actor: alice, keyframeEvery: 4 });
  const main = c.cut;
  for (let i = 1; i <= 9; i++) await c.commit({ ops: [set("a", "name", `n${i}`)] });
  const seqs = async () => (await store.range("keyframes", { prefix: [main] })).map((e) => e.key[1] as number);
  assert.deepEqual(await seqs(), [0, 8], "the newest periodic one (4 was replaced by 8)");
  await c.name(`${main}@6`, "Picked");
  const v = await c.fork("v");
  await c.commit({ cut: v.id, ops: [set("b", "name", "from v")] });
  await c.switchTo(main);
  await c.fold(v.id, { into: main });
  assert.deepEqual(await seqs(), [0, 6, 8, 10], "the named version (6) and the fold (10) keep theirs");
  for (const s of await seqs()) assert.equal(hashDoc((await store.get("keyframes", [main, s]))!, schema), hashDoc(await c.checkout(`${main}@${s}`), schema), `keyframe ${s} is the state at ${s}`);
  await c.close();
});
