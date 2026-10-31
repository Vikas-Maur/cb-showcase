// Regressions found by review round 1 (GPT 6.1 Sol), on the real engine, history and materializer.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { POS } from "@carton/core";
import type { Rec } from "@carton/core";
import { fromHost, toHost, cardboardFilesHost } from "@carton/cardboard";
import { TIMELINE_FILE, PROJECT_FILE, exportCbproj, readCbproj } from "@carton/cardboard/node";
import { ZipReader } from "@carton/cardboard/node";
import { openWorld, clips, clip, find, render, BOB, type Item } from "./world.ts";

test("review 1 #1: a remote edit hidden by the freeze view is never overwritten silently by an agent's save from that view [real engine]", async (t) => {
  const w = await openWorld(t, { items: clips(10, "clip") });
  const A = w.agent("director/c/t1", { hooked: true, actor: { turn: "t1" } });
  await A.read(); // freeze
  await w.remote((its) => void (find(its, "clip9").name = "remote edit"));
  await w.tick(500);
  // an unrelated agent save regenerates the freeze file (a new pin of the freeze view)
  await A.editUntilDone(TIMELINE_FILE, (its) => void (find(its, "clip1").name = "unrelated"));
  await w.tick(500);
  const r = await A.read();
  assert.equal(find(r.items, "clip9").name, "clip9", "the remote edit is hidden from the agent");
  await A.editUntilDone(TIMELINE_FILE, (its) => void (find(its, "clip9").name = "agent edit"));
  await w.tick(1000);
  const head = await w.head();
  assert.equal(find(head, "clip9").name, "remote edit", "head's (the remote) value kept: the clash is a card, not a silent overwrite");
  assert.ok(w.mz.log.cards.some((c) => c.cards.some((x) => x.path.startsWith("timelineItems/clip9"))), "a card on clip9 for the human");
  const notices = await w.carton.notices(A.actor);
  // told once, with the card it can pick (`cb conflicts` / `cb resolve`, B5)
  assert.ok(notices.some((n) => n.kind === "late-conflict" && n.cards?.some((c) => c.path.startsWith("timelineItems/clip9"))), "the agent is told, with the card");
  await A.stop();
});

test("review 1 #2: a foreign project.json write is imported against Carton's last materialization (a ref core can resolve) [real engine]", async (t) => {
  const w = await openWorld(t, { items: clips(3) });
  await w.gui((its) => void (find(its, "c0").name = "gui"));
  await w.tick(100);
  const env = JSON.parse(fs.readFileSync(w.abs(PROJECT_FILE), "utf8"));
  env.project.timelineItems.find((i: Item) => i.id === "c1").opacity = 0.5;
  w.writeAtomic(PROJECT_FILE, JSON.stringify(env));
  await w.tick(500);
  const head = await w.head();
  assert.equal(find(head, "c1").opacity, 0.5, "applied, not 'state unknown'");
  assert.equal(find(head, "c0").name, "gui");
  assert.equal((await w.carton.log())[0]!.author?.id, "external:project.json");
});

test("review 1 #2: the freeze starts from what the shared file shows, not from head [real engine]", async (t) => {
  const w = await openWorld(t, { items: clips(3) });
  w.setShared(true);
  await w.remote((its) => void (find(its, "c0").name = "first remote")); // rewrites the shared file at once
  await w.tick(100);
  await w.remote((its) => void (find(its, "c1").name = "second remote")); // waits 30 s: not in the file yet
  await w.tick(100);
  assert.equal(find((await w.agent("probe").read()).items, "c1").name, "c1");
  const A = w.agent("director/c/t1", { hooked: true, actor: { turn: "t1" } });
  await A.read(); // the freeze starts here
  await A.editUntilDone(TIMELINE_FILE, (its) => void (find(its, "c2").name = "agent")); // regenerates the freeze view
  await w.tick(500);
  const r = await A.read();
  assert.equal(find(r.items, "c0").name, "first remote", "what the file showed");
  assert.equal(find(r.items, "c1").name, "c1", "the hidden remote change stays hidden");
  assert.equal(find(r.items, "c2").name, "agent");
  await A.stop();
});

test("review 1 #9: an author's run of inserts stays contiguous across file saves when another author inserts at the same place (M4) [real engine]", async (t) => {
  const w = await openWorld(t, { items: [], tracks: ["L", "R"] });
  const agent = w.agent("director/c/t1", { hooked: true, actor: { turn: "t1" } });
  const { path: rel } = await w.mz.printView("v", agent.actor, { hooked: true });
  const r0 = await w.carton.head();
  const track = (id: string, order: number): Rec => ({ id, name: id, order, locked: false, visible: true, muted: false });
  const v0 = await agent.read(rel);
  const save = async (tracks: Rec[]) => {
    const r = await agent.read(rel);
    await agent.write(rel, `${r.header}\n${JSON.stringify({ ...r.doc, tracks, timelineItems: [] })}\n`);
    await w.tick(500);
  };
  void v0;
  await save([track("L", 0), track("A1", 1), track("R", 2)]); // A inserts A1 after L
  // B inserts B1 after L, made on the state before A's save
  const h0 = toHost(r0.doc);
  const b = await w.carton.commit({ doc: fromHost({ ...h0, tracks: [track("L", 0), track("B1", 1), track("R", 2)] }, r0.doc), base: r0.ref, author: BOB });
  assert.equal(b.status, "confirmed");
  await save([track("L", 0), track("A1", 1), track("A2", 2), track("R", 3)]); // A inserts A2 right after its own A1
  const order = ((await w.headDoc()).tracks as Rec[]).slice().sort((x, y) => ((x[POS] as string) < (y[POS] as string) ? -1 : 1)).map((x) => x.id);
  const i = order.indexOf("A1");
  assert.equal(order[i + 1], "A2", `A's run is contiguous: ${order.join(" ")}`);
  assert.ok(order.includes("B1"));
});

test("review 1 #13: a .cbproj written right after a commit carries a manifest that matches the shallow export's head [real engine]", async (t) => {
  const w = await openWorld(t, { items: clips(2) });
  await w.carton.commit({ doc: fromHost({ ...toHost((await w.carton.head()).doc), timelineItems: [clip("c0", 0, 5, { name: "just now" }), clip("c1", 5, 10)] }, (await w.carton.head()).doc), author: BOB });
  // no tick: project.json on disk hasn't caught up
  const out = path.join(w.bundle, "..", `${path.basename(w.bundle)}-${Date.now()}.cbproj`);
  t.after(() => fs.rmSync(out, { force: true }));
  await exportCbproj({ bundle: w.bundle, out, shallow: await w.carton.exportShallow({ to: "bob" }), head: { doc: await w.headDoc(), toProject: cardboardFilesHost.toProject } });
  const c = await readCbproj(out);
  const items = (c.manifest.project as { timelineItems: Item[] }).timelineItems;
  assert.equal(find(items, "c0").name, "just now", "the manifest Cardboard opens is the head");
  const z = await ZipReader.open(out);
  t.after(() => z.close());
  assert.ok(z.has(".carton-export/shallow.json"));
});

test("review 1 #15: pins are recorded one key per ref (no growing list), and a turn's end releases every one of them [real engine]", async (t) => {
  const w = await openWorld(t, { items: clips(2) });
  const owner = "turn:t-pins";
  const docs = [];
  for (let k = 0; k < 5; k++) {
    await w.gui((its) => void (find(its, "c0").name = `v${k}`));
    const p = await w.engine.pin({ owner, ttlMs: 60_000 });
    docs.push(p);
    await w.engine.pin({ owner, ttlMs: 60_000 }); // the same state again: the same record
  }
  const rows = await w.carton.store.range("views", { prefix: ["pinned", owner] });
  assert.equal(rows.length, 5, "one record per distinct ref");
  await w.engine.release(owner);
  assert.equal((await w.carton.store.range("views", { prefix: ["pinned", owner] })).length, 0);
});
