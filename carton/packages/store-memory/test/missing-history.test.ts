// A shared cut whose server lost blobs it refers to (stuck-sync, laptop run 2026-11-03: the lab purge deleted the
// project's keyframes; every replica that joined after stayed "syncing", the host's "internal: keyframe … is missing"
// its only word). Against a real sequencer (the in-process host) with a blob store:
// - the keyframes' blobs gone, a joiner (it holds the cut's root) catches up by rows and is up to date;
// - history only a blob held (archived segments) gone too, the joiner is told in words a status line can show.
import { test } from "node:test";
import assert from "node:assert/strict";
import { Carton, hashDoc, type Actor, type CutRecord } from "@carton/core";
import type { AuthContext, AuthProvider } from "@carton/core/plugins";
import { createInProcessHost } from "@carton/server";
import { createMemoryBlobStore } from "@carton/blob-memory";
import { sqliteStorage } from "../../conformance/src/system/sqlite.ts";
import { createMemoryStore } from "../src/index.ts";
import { adapter, schema, doc0, set, item } from "./fixture.ts";

const alice: Actor = { kind: "human", id: "alice", group: "alice@laptop" };
const bob: Actor = { kind: "human", id: "bob", group: "bob@desk" };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(pred: () => boolean | Promise<boolean>, ms = 5000, what = "condition"): Promise<void> {
  const end = Date.now() + ms;
  while (!(await pred())) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(10);
  }
}

// K = 5 and a keyframe asked for every 4 rows, so 12 edits make a joiner's catch-up a keyframe one
async function project() {
  const tokens = new Map<string, AuthContext>();
  const auth: AuthProvider = { kind: "table", async verify(t) { return tokens.get(t) ?? null; } };
  const blobs = createMemoryBlobStore();
  const host = createInProcessHost({ storage: sqliteStorage(), auth, blobs, maxBehind: 5, keyframeEvery: 4, timeline: schema.timeline!, groupOf: (c, f) => schema.collections[c]?.groupOf.get(f)?.name });
  const sync = (name: string) => {
    tokens.set(`tok-${name}`, { account: name, credential: `${name}/install`, role: "editor", projectId: "p", expires: Date.now() + 3600_000 });
    return { transport: host.transport, url: host.url, token: `tok-${name}` };
  };
  const a = await Carton.open({ adapter, store: createMemoryStore(), init: { doc: doc0(), projectId: "p" }, actor: alice, sync: sync("alice") });
  await a.share();
  await until(async () => (await a.cuts())[0]!.sequencer.kind === "server", 5000, "the hand-off");
  const cut = (await a.cuts())[0]!;
  const root = await a.checkout(`${cut.id}@0`);
  for (let i = 0; i < 12; i++) assert.equal((await a.commit({ ops: [set("a", "name", `v${i}`)], wait: 5000 })).status, "confirmed");
  await until(async () => (await blobs.list("keyframes/")).blobs.length >= 3, 5000, "keyframes uploaded");
  const drop = async (prefix: string) => {
    const keys = (await blobs.list(prefix)).blobs.map((b) => b.key);
    for (const k of keys) await blobs.delete(k);
    return keys.length;
  };
  return { a, host, sync, drop, join: { projectId: a.projectId, cut: cut as CutRecord, doc0: root, rootHash: hashDoc(root, schema) } };
}

test("stuck-sync: every keyframe's blob gone from the server, a joiner catches up by rows and is up to date", async () => {
  const { a, host, sync, drop, join } = await project();
  assert.ok((await drop("keyframes/")) >= 3);
  const b = await Carton.open({ adapter, store: createMemoryStore(), init: { join }, actor: bob, sync: sync("bob") });
  const states: string[] = [];
  b.on((e) => void (e.type === "sync" && states.push(e.status)));
  await until(async () => item((await b.head()).doc, "a")!.name === "v11", 5000, "bob catches up");
  await until(() => states.at(-1) === "up-to-date", 5000, `bob up to date (${states.join(", ")})`);
  assert.equal(b.sync!.error(), null, "no sync error");
  assert.ok(host.sequencer.stats.missingBlobs >= 1, "the host counted the miss");
  assert.equal((await b.commit({ ops: [set("b", "name", "from bob")], wait: 5000 })).status, "confirmed");
  for (const c of [a, b]) await c.close();
  host.close();
});

test("stuck-sync: archived history gone too, a joiner is told this project's history can't be loaded (no internal words)", async () => {
  const { a, host, sync, drop, join } = await project();
  assert.equal(await host.sequencer.archive(join.cut.id, { keep: 2, segmentRows: 4 }), 8, "rows 1..8 archived");
  await drop("keyframes/");
  assert.equal(await drop("segments/"), 2);
  const b = await Carton.open({ adapter, store: createMemoryStore(), init: { join }, actor: bob, sync: sync("bob") });
  await b.head(); // opens the shared cut's sync
  await until(() => b.sync!.error() !== null, 5000, "the sync error");
  const err = b.sync!.error()!;
  assert.equal(err.code, "server");
  assert.equal(err.message, "this project's history can't be loaded: part of it is missing from the server's storage");
  for (const c of [a, b]) await c.close();
  host.close();
});
