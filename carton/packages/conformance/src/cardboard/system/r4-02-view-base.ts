// R4-02 end to end through a per-agent view file, on the real engine, history and materializer (port of system-v11
// `r4-02-view-base.test.mjs`). The base of a save is the state of the view's last applied save while its print nonce
// is unchanged. Both cases have a non-agent change between the two agent saves.
//  - trim: the agent trims X's end −1 (save 1); the human trims X's end a further −0.5; the agent's save 2 edits Y.
//  - ripple: the agent closes 5 s of a gap (save 1, a file edit: the remap is inferred at commit); the human inserts h
//    at 45; save 2 renames a.
// Expected: no card, the human's values stay (X ends at 18.5; h stays at 45).
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { statusPath, type ViewRow } from "@carton/cardboard/node";
import { openWorld, clip, find, render, type Item } from "./world.ts";

async function scenario(t: test.TestContext, { kind, viewBase = "lastSave", insertBefore = false }: { kind: "trim" | "ripple"; viewBase?: "lastSave" | "header"; insertBefore?: boolean }) {
  const items = kind === "trim" ? [clip("X", 10, 20), clip("Y", 20, 30)] : [clip("a", 0, 30), clip("c", 40, 50), clip("d", 60, 70)];
  const w = await openWorld(t, { items, tracks: ["V1"] });
  const agent = w.agent("director/c/t1", { hooked: true, actor: { turn: "t1", chat: "c" } });
  const { path: rel, name } = await w.mz.printView("director_c_t1", agent.actor, { hooked: true });
  await agent.read(rel);
  const insertH = (s: number) => w.gui((its) => void its.push(clip("h", s, s + 5)));
  if (insertBefore) {
    await insertH(50); // the critic's original order: h lands before save 1
    await w.tick(1000);
  }
  if (kind === "trim") await agent.editUntilDone(rel, (its) => void Object.assign(find(its, "X"), { endTime: 19, trimEnd: 9 }));
  else await agent.editUntilDone(rel, (its) => void (Object.assign(find(its, "c"), { startTime: 35, endTime: 45 }), Object.assign(find(its, "d"), { startTime: 55, endTime: 65 })));
  await w.tick(2000);
  if (kind === "trim") await w.gui((its) => void Object.assign(find(its, "X"), { endTime: 18.5, trimEnd: 8.5 }));
  else if (!insertBefore) await insertH(45);
  await w.tick(2000);
  if (viewBase === "header") {
    // control (v4): forget the last applied save, so the header ref is the base
    const row = (await w.engine.getMeta<ViewRow>(["view", name]))!;
    await w.engine.putMeta(["view", name], { ...row, last: null });
  }
  // save 2: the agent edits something else; its file still shows its own save 1
  const target = kind === "trim" ? "Y" : "a";
  await agent.editUntilDone(rel, (its) => void (find(its, target).name = "renamed"));
  await w.tick(3000);
  const status = JSON.parse(fs.readFileSync(w.abs(statusPath(name)), "utf8"));
  const head = await w.head();
  const cards = w.mz.log.applied.filter((a) => a.actor === agent.actor.id).reduce((n, a) => n + Number(a.cards ?? 0), 0);
  return { w, head, cards, status, target };
}

test("R4-02 trim-out, human trim between saves: no card, X keeps the human's 18.5 [real engine]", async (t) => {
  const { head, cards, status } = await scenario(t, { kind: "trim" });
  assert.equal(cards, 0, "no card");
  assert.equal(status.status, "confirmed");
  assert.deepEqual([find(head, "X").endTime, find(head, "X").trimEnd], [18.5, 8.5]);
  assert.equal(find(head, "Y").name, "renamed");
});

test("R4-02 control: with the header ref as base (v4), the same saves raise a spurious card on X's time group [real engine]", async (t) => {
  const { cards, status } = await scenario(t, { kind: "trim", viewBase: "header" });
  assert.ok(cards >= 1, "a card about the agent's own earlier trim");
  assert.ok(status.conflicts.some((c: { path: string }) => c.path === "timelineItems/X/#time"), "a time-group card on X (core names the group)");
});

test("R4-02 ripple, human insert between saves: no card, h stays at 45 [real engine]", async (t) => {
  const { head, cards } = await scenario(t, { kind: "ripple" });
  assert.equal(cards, 0);
  assert.deepEqual(["c", "d", "h"].map((x) => find(head, x).startTime), [35, 55, 45]);
  assert.equal(find(head, "a").name, "renamed");
});

test("R4-02 ripple, the critic's order (h inserted at 50 before save 1): mapped once to 45, stays 45 after save 2 [real engine]", async (t) => {
  const { head, cards } = await scenario(t, { kind: "ripple", insertBefore: true });
  assert.equal(cards, 0);
  assert.equal(find(head, "h").startTime, 45);
});

test("R4-02 ripple control (Finding 8): with the header ref as base, h still stays 45 (recorded remap + identical deletions counted once) [real engine]", async (t) => {
  const { head, cards } = await scenario(t, { kind: "ripple", viewBase: "header" });
  assert.equal(find(head, "h").startTime, 45);
  assert.equal(cards, 0);
});

// Finding 3 (§5.2 print nonce): an agent saves its view and, before Carton has read that save, the view is re-printed
// (same state). The save is displaced and applied; the agent then saves again from the re-print. Keyed on the print
// nonce, the first save stays.
test("R4-02 edge (Finding 3): a view saved, re-printed before the save was read (same state), saved again from the re-print: the first save is kept [real engine]", async (t) => {
  const w = await openWorld(t, { items: [clip("X", 10, 20), clip("Y", 20, 30)], tracks: ["V1"] });
  const agent = w.agent("director/c/t1", { hooked: true, actor: { turn: "t1" } });
  const { path: rel } = await w.mz.printView("v", agent.actor, { hooked: true });
  await agent.read(rel);
  const r = await agent.read(rel);
  fs.writeFileSync(w.abs(rel), render(r, r.items.map((i) => (i.id === "X" ? { ...i, name: "first" } : i)))); // no watch event yet
  await w.mz.printView("v", agent.actor, { hooked: true });
  await w.tick(400);
  await agent.read(rel);
  await agent.editUntilDone(rel, (its) => void (find(its, "Y").name = "second"));
  await w.tick(3000);
  const head = await w.head();
  assert.deepEqual([find(head, "X").name, find(head, "Y").name], ["first", "second"]);
});

// §4.4 on the real engine: a ref to a confirmed state never expires (core rebuilds it from the log); what can expire is
// a pinned optimistic or held state. The save below names such a state whose pin is gone (hash of no state Carton
// holds): it must fail loudly in the status sidecar, never fall back to a 2-way merge.
test("§4.4 expired ref: a view save whose header names a pinned state that is gone fails loudly (\"re-print\") in its status sidecar, never a 2-way merge [real engine]", async (t) => {
  const w = await openWorld(t, { items: [clip("c0", 0, 5), clip("c1", 5, 10)], tracks: ["V1"] });
  const agent = w.agent("director/c/t9", { hooked: true, actor: { turn: "t9" } });
  const { path: rel, name } = await w.mz.printView("t9", agent.actor, { hooked: true });
  const r = await agent.read(rel);
  await w.remote((its) => void (find(its, "c1").name = "moved on"));
  await w.tick(100);
  await agent.stop(); // turn ends: its pins are released
  const gone = { ...r, header: r.header.replace(/~[0-9a-f]{8}/, "~deadbeef") };
  await agent.write(rel, render(gone, r.items.map((i) => (i.id === "c0" ? { ...i, name: "late" } : i))));
  await w.tick(2000);
  const status = JSON.parse(fs.readFileSync(w.abs(statusPath(name)), "utf8"));
  const head = await w.head();
  assert.equal(status.status, "error");
  assert.match(status.error, /state unknown: re-print/);
  assert.equal(find(head, "c0").name, "c0", "nothing applied");
  assert.equal(find(head, "c1").name, "moved on");
});

export {};
void ({} as Item);
