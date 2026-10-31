// windows-sync R3: Cardboard's GUI saves are the generic person `{kind: "human", id: "person"}` on every computer. A
// change by it is told as the person behind its replica: this store's replicas as `setIdentity`'s person, a teammate's
// as the server's people say (every replica id their device credential used). Agents and named humans stay as
// recorded, the recorded actor stays in `authoredAs`, and hashes and history are untouched.
import { test } from "node:test";
import assert from "node:assert/strict";
import { Carton, PERSON, hashDoc, type Actor } from "@carton/core";
import { createMemoryStore } from "../src/index.ts";
import { adapter, doc0, schema, set } from "./fixture.ts";
import { until, world } from "./world.ts";

const person = (group: string): Actor => ({ kind: "human", id: PERSON, group });
const director: Actor = { kind: "agent", id: "director", name: "Director", group: "alice@laptop/director" };
const carol: Actor = { kind: "human", id: "carol", name: "Carol", group: "carol@studio" };
/** Who log() says made the version that set a name to `v`, and as whom it was recorded. */
async function byName(c: Carton, v: string) {
  for (const x of await c.log()) {
    if (!x.change) continue;
    const { ops } = await c.diff(`${x.ref.branchId}@${x.ref.seq - 1}`, `${x.ref.branchId}@${x.ref.seq}`);
    if (ops.some((o) => (o as { value?: unknown }).value === v)) return { author: x.author, as: x.authoredAs };
  }
  return null;
}

test("people: this store's generic person is told as setIdentity's person, in log and credits; agents and named humans as recorded; kept across a restart", async () => {
  const store = createMemoryStore();
  const me = person("alice@laptop");
  const a = await Carton.open({ adapter, store, init: { doc: doc0() }, actor: me });
  await a.commit({ ops: [set("a", "name", "gui edit")] });
  await a.commit({ ops: [set("b", "name", "agent edit")], author: director });
  await a.commit({ ops: [set("c", "name", "carol's")], author: carol });
  // before an identity: as recorded
  assert.deepEqual((await byName(a, "gui edit"))?.author, me);
  assert.equal((await byName(a, "gui edit"))?.as, undefined);
  let told = 0;
  a.on((e) => void (e.type === "people" && told++));
  await assert.rejects(a.setIdentity({ id: "alice", name: " " }), /a name/);
  await a.setIdentity({ id: "alice", name: "Alice" });
  assert.equal(told, 1, "a `people` event: authors read differently now");
  assert.deepEqual(a.identity(), { id: "alice", name: "Alice" });
  const alice = { kind: "human", id: "alice", name: "Alice", group: "alice@laptop" };
  assert.deepEqual(await byName(a, "gui edit"), { author: alice, as: me }, "told as the person, recorded as the generic one");
  assert.deepEqual(await byName(a, "agent edit"), { author: director, as: undefined }, "an agent as recorded");
  assert.deepEqual(await byName(a, "carol's"), { author: carol, as: undefined }, "a named human as recorded");
  assert.deepEqual(await a.credits(["items", "a"]), alice);
  assert.deepEqual(await a.credits(["items", "a"], { detail: true }), { actor: alice, at: (await a.credits(["items", "a"], { detail: true }))!.at, change: (await a.credits(["items", "a"], { detail: true }))!.change, authoredAs: me });
  assert.deepEqual(await a.credits(["items", "b"]), director);
  // another process on this machine (its own replica id): its GUI edits are this person's too, once its rows load
  const b = await Carton.open({ adapter, store, actor: me });
  await b.commit({ ops: [set("d", "name", "other process")] });
  assert.deepEqual((await byName(a, "other process"))?.author, alice);
  assert.deepEqual((await byName(b, "gui edit"))?.author, alice, "the other process tells this one's edits too");
  // the hashes are the recorded ones: a restart reads the same, offline
  const head = (await a.log())[0]!.ref.hash;
  await Promise.all([a.close(), b.close()]);
  const c = await Carton.open({ adapter, store, actor: me });
  assert.deepEqual(c.identity(), { id: "alice", name: "Alice" });
  assert.deepEqual((await byName(c, "gui edit"))?.author, alice);
  assert.equal((await c.log())[0]!.ref.hash, head);
  await c.close();
});

/** Until hosts-plugins' half of the people (the server's record) is merged here: run, but not counted. */
const SERVER_HALF = { todo: "needs hosts-plugins' half (the server's people, notes/foundation-core.md); a normal test once merged", timeout: 30_000 };

test(
  "people: two replicas share a cut; each one's GUI edits, before the share (from two processes), after it and from a process started later, are told as its person at both ends",
  SERVER_HALF,
  async () => {
    const w = world();
    const meA = person("alice@laptop"),
      meB = person("bob@desk");
    // Alice's edits before the share, from two processes (two replica ids)
    const store = createMemoryStore();
    const a1 = await Carton.open({ adapter, store, init: { doc: doc0(), projectId: "p" }, actor: meA });
    await a1.commit({ ops: [set("a", "name", "alice before 1")] });
    await a1.close();
    const a = await Carton.open({ adapter, store, actor: meA, sync: w.sync("alice") });
    await a.commit({ ops: [set("b", "name", "alice before 2")] });
    await a.setIdentity({ id: "alice", name: "Alice" });
    await a.share();
    await until(async () => (await a.cuts())[0]!.sequencer.kind === "server", 5000, "the hand-off");
    const cut = (await a.cuts())[0]!;
    const root = await a.checkout(`${cut.id}@0`);
    // Bob joins, then says who he is (on the live connection)
    const b = await Carton.open({ adapter, store: createMemoryStore(), init: { join: { projectId: "p", cut, doc0: root, rootHash: hashDoc(root, schema) } }, actor: meB, sync: w.sync("bob") });
    await b.setIdentity({ id: "bob", name: "Bob" });
    // after the share: one edit each
    assert.equal((await b.commit({ ops: [set("c", "name", "bob after")], wait: 5000 })).status, "confirmed");
    assert.equal((await a.commit({ ops: [set("d", "name", "alice after")], wait: 5000 })).status, "confirmed");
    const alice = { kind: "human", id: "alice", name: "Alice" },
      bob = { kind: "human", id: "bob", name: "Bob" };
    const who = async (c: Carton, v: string) => {
      const x = await byName(c, v);
      return x && { kind: x.author!.kind, id: x.author!.id, name: x.author!.name };
    };
    // Alice's app restarts: a new process, a new replica id on the same device, told to Bob before its row
    await a.close();
    const a2 = await Carton.open({ adapter, store, actor: meA, sync: w.sync("alice") });
    assert.deepEqual(a2.identity(), { id: "alice", name: "Alice" }, "kept in the store");
    assert.equal((await a2.commit({ ops: [set("e", "name", "alice restarted")], wait: 5000 })).status, "confirmed");
    for (const [c, where] of [[a2, "at Alice's"], [b, "at Bob's"]] as const) {
      await until(async () => (await c.log()).length >= 6, 5000, `the rows ${where}`);
      await until(async () => (await who(c, "bob after"))?.id === "bob" && (await who(c, "alice before 1"))?.id === "alice", 5000, `people ${where}`);
      for (const v of ["alice before 1", "alice before 2", "alice after", "alice restarted"]) assert.deepEqual(await who(c, v), alice, `${v} ${where}`);
      assert.deepEqual(await who(c, "bob after"), bob, `bob after ${where}`);
      assert.equal((await c.credits(["items", "c"]))?.id, "bob", `credits ${where}`);
      assert.equal((await c.credits(["items", "a"]))?.id, "alice", `credits ${where}`);
      assert.equal((await c.log()).find((x) => x.authoredAs)?.authoredAs?.id, PERSON, `recorded as the generic person ${where}`);
    }
    // presence goes out as the person too: teammates' cursors are told apart, not all "person"
    const seen: Actor[] = [];
    b.on((e) => void (e.type === "presence" && seen.push(e.actor)));
    a2.sync!.presence({ at: 1 });
    await until(() => seen.length > 0, 5000, "Alice's presence at Bob's");
    assert.deepEqual({ id: seen[0]!.id, name: seen[0]!.name }, { id: "alice", name: "Alice" });
    await Promise.all([a2.close(), b.close()]);
    w.host.close();
  },
);

test("people: a replica can't take another account's name: refused, and its edits stay its own", SERVER_HALF, async () => {
  const w = world();
  const a = await Carton.open({ adapter, store: createMemoryStore(), init: { doc: doc0(), projectId: "p" }, actor: person("alice@laptop"), sync: w.sync("alice") });
  await a.setIdentity({ id: "alice", name: "Alice" });
  await a.share();
  await until(async () => (await a.cuts())[0]!.sequencer.kind === "server", 5000, "the hand-off");
  const cut = (await a.cuts())[0]!;
  const root = await a.checkout(`${cut.id}@0`);
  const m = await Carton.open({ adapter, store: createMemoryStore(), init: { join: { projectId: "p", cut, doc0: root, rootHash: hashDoc(root, schema) } }, actor: person("mallory@box"), sync: w.sync("mallory") });
  const errors: string[] = [];
  m.on((e) => void (e.type === "sync-error" && e.error && errors.push(e.error.message)));
  await m.setIdentity({ id: "alice", name: "Alice" }); // not this session's account
  assert.equal((await m.commit({ ops: [set("a", "name", "mallory's")], wait: 5000 })).status, "confirmed");
  await until(() => errors.some((x) => /identity/.test(x)), 5000, "the refusal");
  await until(async () => (await byName(a, "mallory's")) !== null, 5000, "the row at Alice's");
  assert.equal((await byName(a, "mallory's"))?.author?.id, PERSON, "never told as Alice");
  await Promise.all([a.close(), m.close()]);
  w.host.close();
});
