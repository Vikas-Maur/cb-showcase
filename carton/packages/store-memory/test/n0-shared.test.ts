// Carton UX v2 (N0) on shared cuts, against a real sequencer (the in-process host of @carton/server): comparing a
// shared cut's version with another cut's and with a teammate's cut (a full-history import's tracking cut), shots
// lined up as for one cut; bringing back one clip on a shared cut, queued like any change, a teammate's newer edit of
// it a card; find and landmarks over a shared cut's confirmed rows.
import { test } from "node:test";
import assert from "node:assert/strict";
import { Carton, LOCAL_TABLES, hashDoc, type Actor, type CutRecord } from "@carton/core";
import type { Store } from "@carton/core/plugins";
import { createMemoryStore } from "../src/index.ts";
import { adapter, doc0, item, schema, set } from "./fixture.ts";
import { copyStore, until, world } from "./world.ts";

const alice: Actor = { kind: "human", id: "alice", name: "Alice", group: "alice@laptop" };
const bob: Actor = { kind: "human", id: "bob", name: "Bob", group: "bob@desk" };

async function historyCopy(from: Store): Promise<Store> {
  const to = await copyStore(from);
  for (const t of LOCAL_TABLES) {
    const rows = await to.range(t);
    if (rows.length) await to.write(rows.map((r) => ({ table: t, key: r.key, value: undefined })));
  }
  return to;
}

test("compare across cuts on a shared cut: its version against a local cut's head, rows and shots as for one cut", async () => {
  const w = world();
  const a = await Carton.open({ adapter, store: createMemoryStore(), init: { doc: doc0(), projectId: "p" }, actor: alice, sync: w.sync("alice", false) });
  try {
    await a.sync!.connect({ nonce: "a1" });
    await a.share();
    await until(async () => (await a.cuts())[0]!.sequencer.kind === "server", 5000, "the hand-off");
    const main = a.cut;
    assert.equal((await a.commit({ ops: [set("a", "endTime", 4)], wait: 5000 })).status, "confirmed");
    const seq = (await a.head()).ref.seq;
    const insta = await a.fork("30s Instagram cut");
    await a.commit({ cut: insta.id, ops: [{ op: "remove", path: ["items", "b"] }, set("c", "name", "Hook")] });
    const d = await a.diff(`${main}@${seq}`, insta.id, { rows: true, shots: true });
    assert.equal(d.count, 2);
    assert.ok(d.shots && d.shots.shotsB > 0, "shots line up");
    const s = await a.shots(insta.id, main);
    assert.ok(s.changed.length > 0);
  } finally {
    await a.close();
  }
});

test("compare with a teammate's cut (a full-history import's tracking cut); find and landmarks read it too", async () => {
  const sa = createMemoryStore();
  const a = await Carton.open({ adapter, store: sa, init: { doc: doc0(), projectId: "proj-n0" }, actor: alice });
  const alt = await a.fork("Alice's alt", { author: alice });
  await a.commit({ cut: alt.id, ops: [set("a", "name", "Opening"), set("b", "endTime", 8)], author: alice });
  await a.name({ branchId: alt.id, seq: 1, pending: [] } as never, "Sent to client");
  const file = { shallow: await a.exportShallow({ to: "bob" }), history: await historyCopy(sa) };
  await a.close();
  const b = await Carton.open({ adapter, store: createMemoryStore(), init: { import: file.shallow }, actor: bob });
  try {
    const took = await b.importHistory(file.history);
    assert.ok(took.cuts.includes(alt.id));
    assert.equal((await b.cuts()).find((c) => c.id === alt.id)?.tracking, true, "a teammate's cut: read-only here");
    await b.commit({ ops: [set("c", "endTime", 14)] });
    const d = await b.diff(b.cut, alt.id, { rows: true, shots: true });
    assert.equal(d.count, 3, JSON.stringify(d.rows?.map((r) => r.text)));
    assert.ok(d.shots);
    // and a version of it against our head
    const v = await b.diff(`${alt.id}@1`, b.cut, { rows: true });
    assert.equal(v.count, 3);
    // find and landmarks over the teammate's cut
    assert.deepEqual((await b.find("opening", { cut: alt.id })).matches.map((m) => m.field), ["clip"]);
    assert.deepEqual((await b.find("client", { cut: alt.id })).matches.map((m) => m.field), ["name"]);
    assert.deepEqual((await b.landmarks({ cut: alt.id, kinds: ["named"] })).map((l) => [l.label, l.personal]), [["Sent to client", false]]);
  } finally {
    await b.close();
  }
});

test("bring back one clip on a shared cut: queued like any change; a teammate's newer edit of it becomes a card", async () => {
  const w = world();
  const a = await Carton.open({ adapter, store: createMemoryStore(), init: { doc: doc0(), projectId: "p" }, actor: alice, sync: w.sync("alice", false) });
  await a.sync!.connect({ nonce: "a1" });
  await a.share();
  await until(async () => (await a.cuts())[0]!.sequencer.kind === "server", 5000, "the hand-off");
  assert.equal((await a.commit({ ops: [set("a", "name", "Intro v2"), set("a", "endTime", 4)], wait: 5000 })).status, "confirmed");
  const cut = (await a.cuts())[0]! as CutRecord;
  const root = await a.checkout(`${cut.id}@0`);
  const b = await Carton.open({ adapter, store: createMemoryStore(), init: { join: { projectId: "p", cut, doc0: root, rootHash: hashDoc(root, schema) } }, actor: bob, sync: w.sync("bob") });
  try {
    await until(async () => item((await b.head()).doc, "a")?.name === "Intro v2", 5000, "bob catches up");
    // online: confirmed by the server, and the clip is as it was at @0 on both
    const r = await a.restoreClip(`${cut.id}@0`, "items/a", { author: alice });
    assert.equal(r.brought.how, "changed");
    const o = await a.sync!.waitFor((r as { id: string }).id, 5000);
    assert.equal(o.status, "confirmed", JSON.stringify(o));
    await until(async () => item((await b.head()).doc, "a")?.name === "a", 5000, "bob sees it");
    assert.equal(item((await b.head()).doc, "a")?.endTime, 5);
    // offline, Alice brings back b's end; Bob trims b meanwhile: hers, rebased, meets his as a card
    assert.equal((await a.commit({ ops: [set("b", "endTime", 9)], wait: 5000 })).status, "confirmed");
    const at = (await a.head()).ref.seq;
    await until(async () => item((await b.head()).doc, "b")?.endTime === 9, 5000, "bob sees the trim");
    await a.sync!.disconnect();
    const q = await a.restoreClip(`${cut.id}@0`, "items/b", { author: alice });
    assert.equal(q.status, "pending");
    assert.equal(item((await a.head()).doc, "b")?.endTime, 10, "shown at once, optimistic");
    assert.equal((await b.commit({ ops: [set("b", "endTime", 8)], wait: 5000 })).status, "confirmed");
    await a.sync!.connect({ nonce: "a2" });
    const out = await a.sync!.waitFor((q as { id: string }).id, 5000);
    assert.ok(out.status === "conflicts" || out.status === "confirmed", JSON.stringify(out));
    const cards = (await a.notices(alice)).flatMap((n) => n.cards ?? []);
    assert.ok(cards.some((c) => c.path.startsWith("items/b")), "a card for b: " + JSON.stringify(cards.map((c) => c.path)));
    assert.ok((await a.head()).ref.seq > at);
    // landmarks over the shared cut: the bring-backs made here have their safety points
    const safety = (await a.landmarks({ kinds: ["before"] })).map((l) => l.before);
    assert.ok(safety.length >= 1 && safety.every((x) => x === "restore" || x === "bring-back"), JSON.stringify(safety));
  } finally {
    await a.close();
    await b.close();
  }
});
