// R4-02 end to end through a per-agent view file: the base of a save is the pinned state of the view's last applied
// save while its header is unchanged. Both cases have a non-agent change between the two agent saves.
//  - trim: the agent trims X's end −1 (save 1); the human trims X's end a further −0.5; the agent's save 2 edits Y.
//  - ripple: the agent closes 5 s of a gap (save 1, a file edit); the human inserts h at 45; save 2 renames a.
// Expected: no card, the human's values stay (X ends at 18.5; h stays at 45).
// Port of system-v11 `test/r4-02-view-base.test.mjs`.
import test from "node:test";
import assert from "node:assert/strict";
import { doc, clip } from "../sim/world.ts";
import { Agent } from "../sim/agent.ts";
import { parse, type MaterializerOptions } from "../sim/replica.ts";
import { A, world, until, runFor, assertConverged, report, ENGINE } from "../helpers.ts";

const find = (d: A.SimDoc, id: string) => d.timelineItems!.find((i) => i.id === id)!;

async function scenario({ kind, viewBase = "lastSave", insertBefore = false, trimD = false, passRecorded = true, seed }: { kind: "trim" | "ripple"; viewBase?: MaterializerOptions["viewBase"]; insertBefore?: boolean; trimD?: boolean; passRecorded?: boolean; seed: number }) {
  const w = world({ seed });
  const m1 = w.replica({ name: "m1", link: w.net.link({ rtt: 100 }) });
  const items = kind === "trim" ? [clip("X", 10, 20), clip("Y", 20, 30)] : [clip("a", 0, 30), clip("c", 40, 50), clip("d", 60, 70)];
  const b = w.shared(doc({ items }), [m1]);
  await m1.startApp({ materializer: { viewBase, passRecorded } });
  const gui = m1.worker!.gui!;
  const agent = new Agent(m1, { name: "director/c/t1", hooked: true, actor: { window: m1.worker!.window, turn: "t1" } });
  const { path } = await until(w, agent.cb({ kind: "printView" }));
  await until(w, agent.read(path));
  const insertH = (s: number) => gui.edit((d) => { d.timelineItems!.push({ id: "h", trackId: "V1", type: "video", name: "h", startTime: s, endTime: s + 5, trimStart: 0, trimEnd: 5, opacity: 1 }); }, [["timelineItems/h", "insert"]]);
  if (insertBefore) { insertH(50); await runFor(w, 1000); } // the critic's original order: h lands before save 1
  // save 1
  if (kind === "trim") await until(w, agent.editUntilDone(path, (d) => { Object.assign(find(d, "X"), { endTime: 19, trimEnd: 9 }); }));
  else await until(w, agent.editUntilDone(path, (d) => { Object.assign(find(d, "c"), { startTime: 35, endTime: 45 }); Object.assign(find(d, "d"), { startTime: 55, endTime: 65 }); }));
  await runFor(w, 2000);
  // the non-agent change between the saves
  if (kind === "trim") gui.edit((d) => { Object.assign(find(d, "X"), { endTime: 18.5, trimEnd: 8.5 }); }, [["timelineItems/X/endTime", 18.5]]);
  else if (!insertBefore) insertH(45);
  if (trimD) { await runFor(w, 1000); gui.edit((d) => { Object.assign(find(d, "d"), { endTime: 64, trimEnd: 9 }); }, [["timelineItems/d/endTime", 64]]); }
  await runFor(w, 2000);
  // save 2: the agent edits something else; its file still shows its own save 1
  const target = kind === "trim" ? "Y" : "a";
  await until(w, agent.editUntilDone(path, (d) => { find(d, target).name = "renamed"; }));
  await runFor(w, 3000);
  const status = JSON.parse(m1.fs.read(path.replace(".tsx", ".status"))!.content);
  const head = m1.store.optimistic(b).doc;
  const cards = m1.cards.filter((c) => c.author.id === agent.actor.id);
  return { w, b, m1, head, cards, status, target };
}

// Finding 3 (v10 §5.2 print nonce): an agent saves its view and, 1 ms later, before Takes has read that save, the view
// is re-printed (same state, so the same ref). The save is displaced and applied; the agent then saves again from the
// re-print. Keyed on the print nonce, the first save stays; keyed on the ref alone, the second save reverts it.
async function reprint({ viewKey = "nonce", seed }: { viewKey?: MaterializerOptions["viewKey"]; seed: number }) {
  const w = world({ seed });
  const m1 = w.replica({ name: "m1" });
  const b = w.shared(doc({ items: [clip("X", 10, 20), clip("Y", 20, 30)] }), [m1]);
  await m1.startApp({ materializer: { viewKey } });
  const actor = m1.newActor({ kind: "agent", id: "director/c/t1", name: "director/c/t1", hooked: true, window: m1.worker!.window, turn: "t1" });
  const print = () => m1.serveCb(m1.worker!, { req: { kind: "printView" }, actor });
  const { path } = await until(w, print());
  const edit = (fn: (d: A.SimDoc) => void) => { const f = parse(m1.fs.read(path)!.content); const d = A.clone(f.doc); fn(d); m1.fs.write(path, `${f.header}\n${A.snapshot(d)}\n`, { name: actor.name!, hooked: true, actor }); };
  await runFor(w, 100);
  const t0 = w.sim.now;
  edit((d) => { find(d, "X").name = "first"; });
  let reprinted: Record<string, any> | null = null;
  w.sim.at(t0 + 1, () => { void print().then((r) => (reprinted = r)); });
  await runFor(w, 50);
  assert.equal(find(parse(m1.fs.read(path)!.content).doc, "X").name, "X", "the re-print came before save 1 was applied");
  edit((d) => { find(d, "Y").name = "second"; });
  await runFor(w, 3000);
  return { head: m1.store.optimistic(b).doc, mz: m1.worker!.materializer!, reprinted };
}

export function register(): void {
  test(`R4-02 trim-out, human trim between saves: no card, X keeps the human's 18.5 [${ENGINE}]`, async (t) => {
    const { w, b, m1, head, cards, status } = await scenario({ kind: "trim", seed: 90 });
    assert.equal(cards.length, 0, "no card");
    assert.equal(status.status, "confirmed");
    assert.deepEqual([A.item(head, "X")!.endTime, A.item(head, "X")!.trimEnd], [18.5, 8.5]);
    assert.equal(A.item(head, "Y")!.name, "renamed");
    assertConverged(w, b, [m1]);
    report(t, { X: [A.item(head, "X")!.startTime, A.item(head, "X")!.endTime], cards: 0 });
  });

  test(`R4-02 control: with the header ref as base (v4), the same saves raise a spurious card [${ENGINE}]`, async (t) => {
    const { cards, head } = await scenario({ kind: "trim", viewBase: "header", seed: 91 });
    assert.ok(cards.length >= 1, "a card about the agent's own earlier trim");
    assert.ok(cards[0]!.cards.some((c) => c.path === "timelineItems/X/#time"), "a time-group card on X (core-v5 names the group)");
    report(t, { spuriousCards: cards.length, X_end: A.item(head, "X")!.endTime });
  });

  test(`R4-02 ripple, human insert between saves: no card, h stays at 45 [${ENGINE}]`, async (t) => {
    const { w, b, m1, head, cards } = await scenario({ kind: "ripple", seed: 92 });
    assert.equal(cards.length, 0);
    assert.deepEqual(["c", "d", "h"].map((x) => A.item(head, x)!.startTime), [35, 55, 45]);
    assert.equal(A.item(head, "a")!.name, "renamed");
    assertConverged(w, b, [m1]);
    report(t, { h: A.item(head, "h")!.startTime });
  });

  test(`R4-02 ripple, the critic's order (h inserted at 50 before save 1): mapped once to 45, stays 45 after save 2 [${ENGINE}]`, async (t) => {
    const { head, cards } = await scenario({ kind: "ripple", insertBefore: true, seed: 93 });
    assert.equal(cards.length, 0);
    assert.equal(A.item(head, "h")!.startTime, 45);
    report(t, { h: A.item(head, "h")!.startTime });
  });

  // Finding 8 on core-v5. The plain ripple case can't tell the base rules apart: with the header ref as base, head's
  // side carries the save-1 ripple as a recorded remap, and core-v5 counts identical deletions once, so h stays 45.
  test(`R4-02 ripple control (Finding 8): with the header ref as base, h still stays 45 on core-v5 (recorded remap + identical deletions counted once) [${ENGINE}]`, async (t) => {
    const { head, cards } = await scenario({ kind: "ripple", viewBase: "header", seed: 94 });
    assert.equal(A.item(head, "h")!.startTime, 45);
    assert.equal(cards.length, 0);
    report(t, { h: A.item(head, "h")!.startTime, cards: cards.length });
  });
  // A harder variant: the human also trims d after the ripple, so head's side no longer looks like a ripple and can't be
  // inferred. With recorded remaps (the plan's pipeline) every base rule keeps h at 45; with inference only, the header
  // base maps h a second time. The v10 last-save base is safe either way.
  test(`R4-02 ripple + a later trim of a shifted clip (Finding 8 ablation): h = 45 with recorded remaps under either base; inference-only + header base shifts h twice [${ENGINE}]`, async (t) => {
    const out: Record<string, number> = {};
    const cardsOf: Record<string, string[]> = {};
    for (const [label, o] of [["lastSave+recorded", {}], ["header+recorded", { viewBase: "header" }], ["lastSave+inferOnly", { passRecorded: false }], ["header+inferOnly", { viewBase: "header", passRecorded: false }]] as const) {
      const { head, cards } = await scenario({ kind: "ripple", trimD: true, seed: 96, ...o });
      out[label] = A.item(head, "h")!.startTime;
      cardsOf[label] = cards.flatMap((c) => c.cards.map((x) => x.path));
    }
    t.diagnostic(JSON.stringify({ cards: cardsOf }));
    assert.equal(out["lastSave+recorded"], 45);
    assert.equal(out["header+recorded"], 45);
    assert.equal(out["lastSave+inferOnly"], 45);
    assert.equal(out["header+inferOnly"], 40, "mapped twice");
    report(t, out);
  });
  // Verification 4, M6: on the plain ripple (no later trim), inference alone is enough too, because head's side still
  // looks like the same ripple and identical deletions count once. So the recorded remap is what protects the trimmed
  // variant above; on the plain ripple both defences work. Cards are reported for every combination.
  test(`R4-02 plain ripple (Finding 8, M6): h = 45 under every base and with or without recorded remaps; cards reported [${ENGINE}]`, async (t) => {
    const out: Record<string, { h: number; cards: string[] }> = {};
    for (const [label, o] of [["lastSave+recorded", {}], ["header+recorded", { viewBase: "header" }], ["lastSave+inferOnly", { passRecorded: false }], ["header+inferOnly", { viewBase: "header", passRecorded: false }]] as const) {
      const { head, cards } = await scenario({ kind: "ripple", seed: 97, ...o });
      out[label] = { h: A.item(head, "h")!.startTime, cards: cards.flatMap((c) => c.cards.map((x) => x.path)) };
      assert.equal(out[label]!.h, 45, label);
    }
    report(t, out);
  });

  test(`R4-02 edge (Finding 3): a view saved, re-printed 1 ms later (same state), saved again from the re-print: the first save is kept [${ENGINE}]`, async (t) => {
    const { head, mz } = await reprint({ seed: 95 });
    assert.equal(mz.displaced.length, 1, "the re-print displaced the unread save");
    assert.equal(A.item(head, "X")!.name, "first", "save 1 kept");
    assert.equal(A.item(head, "Y")!.name, "second", "save 2 applied");
    report(t, { X: A.item(head, "X")!.name, Y: A.item(head, "Y")!.name });
  });
  test(`R4-02 edge control: keyed on the ref alone (no print nonce), the second save reverts the first [${ENGINE}]`, async (t) => {
    const { head } = await reprint({ viewKey: "ref", seed: 95 });
    assert.equal(A.item(head, "X")!.name, "X", "save 1 silently reverted");
    assert.equal(A.item(head, "Y")!.name, "second");
    report(t, { X: A.item(head, "X")!.name });
  });
}
