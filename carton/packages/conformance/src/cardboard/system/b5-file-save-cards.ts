// B5 (e2e-qa, s2-cuts "S2 conflict cards"), the engine's part, on the real engine: a file save whose merge raises cards
// keeps them for its author as a `cb` commit's are (`@carton/local`'s `cardsRow`: one notices row per save, key
// [actor, 0, 0, "req:<change>"], delivered), so `cb conflicts` lists them and `cb resolve` picks one. Before, the
// author got a text-only notice (cli-mcp's `openCards` keeps only notices with cards), and a view save none at all.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { actorKey, type Doc, type Notice } from "@carton/core";
import { fromHost, toHost } from "@carton/cardboard";
import { TIMELINE_FILE, statusPath } from "@carton/cardboard/node";
import { openWorld, clip, clips, find, type Item } from "./world.ts";

type Row = Notice & { deliveredAt?: number };
const cardsOf = (ns: Row[]) => ns.filter((n) => n.kind === "late-conflict" && n.cards?.length);

test("B5: a view save's cards are its author's notice with the cards, delivered; no text-only notice besides [real engine]", async (t) => {
  const w = await openWorld(t, { items: [clip("a", 0, 10), clip("b", 10, 20)], tracks: ["V1"] });
  const agent = w.agent("director/c3/t1", { hooked: true, actor: { turn: "t1", chat: "c3" } });
  const { path: rel, name } = await w.mz.printView("director_c3_t1", agent.actor, { hooked: true });
  await agent.read(rel);
  await w.gui((its) => void (find(its, "a").opacity = 0.6)); // the person, after the agent read
  await w.tick(100);
  await agent.editUntilDone(rel, (its) => void ((find(its, "a").opacity = 0.33), (find(its, "b").name = "agent")));
  await w.tick(2000);
  const status = JSON.parse(fs.readFileSync(w.abs(statusPath(name)), "utf8"));
  assert.equal(status.status, "conflicts", JSON.stringify(status));
  const head = await w.head();
  assert.equal(find(head, "a").opacity, 0.6, "head kept the person's newer value");
  assert.equal(find(head, "b").name, "agent", "the save's other edit landed");
  const ns = (await w.carton.notices(agent.actor)) as Row[];
  const carded = cardsOf(ns);
  assert.equal(carded.length, 1, JSON.stringify(ns));
  assert.deepEqual(carded[0]!.cards!.map((c) => c.path), ["timelineItems/a/opacity"]);
  assert.equal(carded[0]!.to, actorKey(agent.actor));
  assert.ok(carded[0]!.change, "the change it belongs to");
  assert.ok(carded[0]!.deliveredAt, "delivered: the sidecar showed them");
  assert.equal(ns.length, 1, "no text-only notice for the same save");
  const row = await w.carton.store.get("notices", [actorKey(agent.actor), 0, 0, `req:${carded[0]!.change}`]);
  assert.ok(row, "under the key @carton/local's cardsRow uses (one row whichever writes it)");
});

test("B5: a save of the shared timeline.tsx whose every edit carded: the cards are the author's notice, told once [real engine]", async (t) => {
  const w = await openWorld(t, { items: clips(10, "clip") });
  const A = w.agent("director/c/t1", { hooked: true, actor: { turn: "t1" } });
  const r0 = await A.read();
  await w.remote((its) => void (find(its, "clip9").name = "remote edit"));
  await w.tick(200);
  await A.write(TIMELINE_FILE, `// a\n${r0.header}\n${JSON.stringify({ ...r0.doc, timelineItems: r0.items.map((i) => (i.id === "clip9" ? { ...i, name: "agent edit" } : i)) })}\n`);
  await w.tick(1000);
  assert.equal(find(await w.head(), "clip9").name, "remote edit");
  const ns = (await w.carton.notices(A.actor)) as Row[];
  assert.deepEqual(cardsOf(ns).flatMap((n) => n.cards!.map((c) => c.path)), ["timelineItems/clip9/name"], JSON.stringify(ns));
  assert.equal(ns.length, 1, `the text notice isn't stored as well: ${JSON.stringify(ns)}`);
  await A.stop();
});

test("B5: a retried save gets its cards back by id but doesn't bring back a card resolved meanwhile [real engine]", async (t) => {
  const w = await openWorld(t, { items: [clip("a", 0, 10)], tracks: ["V1"] });
  const base = await w.carton.head();
  await w.gui((its) => void (find(its, "a").opacity = 0.6));
  const author = { kind: "agent" as const, id: "director/c/t9", name: "director/c/t9" };
  const id = w.engine.newChangeId!();
  const h = toHost(base.doc);
  const its = structuredClone(h.timelineItems as Item[]);
  find(its, "a").opacity = 0.33;
  const mine: Doc = fromHost({ ...h, timelineItems: its }, base.doc);
  const first = await w.engine.commit({ doc: mine, base: { baseDoc: base.doc, baseSeq: base.ref.seq, causal: [] }, author, id, meta: { file: TIMELINE_FILE } });
  assert.equal(first.status, "conflicts");
  assert.equal(cardsOf((await w.carton.notices(author)) as Row[]).length, 1);
  await w.carton.notices(author, { take: true }); // `cb resolve` closed the card: its row is gone
  const again = await w.engine.commit({ doc: mine, base: { baseDoc: base.doc, baseSeq: base.ref.seq, causal: [] }, author, id, meta: { file: TIMELINE_FILE } });
  assert.equal(again.status, "conflicts", "the retry still reports the cards (sidecar)");
  assert.deepEqual(await w.carton.notices(author), [], "the resolved card stays resolved");
});
