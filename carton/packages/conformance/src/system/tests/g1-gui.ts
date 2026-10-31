// G1-style logic check (the real gate runs on the Windows build): 3 remote writers at 1 change/s for 10 virtual
// minutes against a local human editing through the GUI (projection with 0.1 s rounding, 300 ms debounce, H5 adopt).
// Expect 0 lost local GUI edits and 0 remote changes re-committed under the local human's name; the undo stack holds
// only the actor group. Controls: 1.4.0's adopt (cancelPendingSave) loses edits; an adopt that doesn't move the
// save base re-commits remote changes under the human's name. Port of system-v11 `test/g1-gui.test.mjs`.
import test from "node:test";
import assert from "node:assert/strict";
import { doc, clips, type World } from "../sim/world.ts";
import type { Gui, SimActor, WorkerOptions } from "../sim/replica.ts";
import { A, world, runFor, botWriter, assertConverged, report, ENGINE } from "../helpers.ts";

const r1 = (x: number) => Math.round(x * 10) / 10;
function humanEdit(w: World, gui: Gui): [string, unknown][] | null {
  const sim = w.sim, it = sim.pick(gui.doc.timelineItems!);
  const id = it.id as string, P = (f: string) => `timelineItems/${id}/${f}`;
  const touched: [string, unknown][] = [];
  if (sim.rand() < 0.6) {
    const d = r1((sim.rand() < 0.5 ? -1 : 1) * sim.uni(0.1, 1)) || 0.1;
    const k = sim.rand();
    const upd = k < 1 / 3 ? { startTime: r1(it.startTime + d), endTime: r1(it.endTime + d) }
      : k < 2 / 3 ? (it.startTime + d < it.endTime - 0.3 && it.trimStart + d >= 0 ? { startTime: r1(it.startTime + d), trimStart: r1(it.trimStart + d) } : null)
      : (it.endTime + d > it.startTime + 0.3 ? { endTime: r1(it.endTime + d), trimEnd: r1(it.trimEnd + d) } : null);
    if (!upd) return null;
    for (const [f, v] of Object.entries(upd)) touched.push([P(f), v]);
    gui.edit((doc) => { Object.assign(doc.timelineItems!.find((i) => i.id === id)!, upd); }, touched);
  } else {
    let v: number;
    do v = Math.round(sim.rand() * 20) / 20; while (v === it.opacity);
    touched.push([P("opacity"), v]);
    gui.edit((doc) => { doc.timelineItems!.find((i) => i.id === id)!.opacity = v; }, touched);
  }
  return touched;
}

async function scenario({ adoptMode, minutes, seed }: { adoptMode: WorkerOptions["adoptMode"]; minutes: number; seed: number }) {
  const w = world({ seed });
  const m1 = w.replica({ name: "m1-human", link: w.net.link({ rtt: 100 }) });
  const remotes = [1, 2, 3].map((i) => w.replica({ name: `remote${i}`, link: w.net.link({ rtt: 100 }) }));
  const b = w.shared(doc({ items: clips(40) }), [m1, ...remotes]);
  await m1.startApp({ adoptMode });
  for (const r of remotes) await r.startApp({ gui: false, materialize: false });
  const T = minutes * 60e3;
  for (const r of remotes) botWriter(r, { rate: 1, untilT: T, fps: 30 }); // frame-accurate times
  const gui = m1.worker!.gui!;
  let humanEdits = 0;
  const human = () => { if (w.sim.now > T) return; if (humanEdit(w, gui)) humanEdits++; w.sim.after(w.sim.exp(2000), human); };
  w.sim.after(1000, human);
  await runFor(w, T + 30e3);

  // v14 (H1): a save absorbed after it was sent is withdrawn first, so the log holds a withdraw row (no ops) with its
  // id where the prototype had none. It is still an absorbed save (m1.absorbed has it), not a confirmed one: leave
  // withdraw rows out, or its carded fields count as lost (seed 160: change .61, a late #time card) and the bots'
  // withdraw rows as remote changes
  const rows = new Map(w.server.branches.get(b)!.rows.filter((r) => !r.withdrawn).map((r) => [r.id, r]));
  const carded = new Map<string, boolean>();
  for (const c of m1.cards) for (const x of c.cards) for (const p of [x.path, ...((x.related as string[] | undefined) ?? [])]) carded.set(`${c.changeId}|${p}`, true);
  let lost = gui.lost.length, recommitted = 0, cardedEdits = 0, valueTransformed = 0, savedPaths = 0, absorbedSame = 0, emptySaves = 0;
  for (const s of gui.saves) {
    const row = rows.get(s.id);
    if (!row && !s.ops.length) { emptySaves++; continue; } // its merge left no ops: head already held the values
    if (!row) {
      // absorbed: its rebase left nothing to push. With cards, the human's values are on a card; without, head already
      // held them. Anything else is lost.
      const ab = m1.absorbed.find((a) => a.id === s.id);
      if (ab?.cards) { cardedEdits += s.saved.size; continue; }
      if (ab) { const h = m1.store.optimistic(b).doc; absorbedSame += [...s.saved].filter(([p, v]) => A.getIn(h, p.split("/")) === v).length; continue; }
      lost += s.saved.size;
      continue;
    }
    const opPaths = new Map(row.ops.map((o) => [A.pathKey(o.path), (o as { value?: unknown }).value]));
    for (const [p, v] of s.saved) {
      savedPaths++;
      if (opPaths.has(p)) { if (opPaths.get(p) !== v) valueTransformed++; continue; }
      if ([...carded.keys()].some((k) => k.startsWith(`${s.id}|`) && (k.endsWith(`|${p}`) || p.startsWith(k.split("|")[1] + "/")))) { cardedEdits++; continue; }
      lost++;
    }
    for (const p of opPaths.keys()) if (!s.saved.has(p)) recommitted++;
  }
  // any other confirmed row in the human's name that isn't one of its saves or undos
  const saveIds = new Set(gui.saves.map((s) => s.id));
  for (const r of rows.values()) if (r.author.id === gui.human.id && !saveIds.has(r.id) && !(r.author as SimActor).undoOf) recommitted += r.ops.length;
  cardedEdits += gui.carded.size; // clashes found when a remote change was adopted under an unsaved edit: cards
  const remoteRows = [...rows.values()].filter((r) => r.author.id !== gui.human.id).length;
  return { w, b, m1, remotes, gui, humanEdits, saves: gui.saves.length, savedPaths, lost, recommitted, cardedEdits, valueTransformed, remoteRows, absorbedSaves: m1.absorbed.filter((a) => a.author?.id === gui.human.id).length, emptySaves };
}

export function register(): void {
  test(`G1 logic: 3 remote writers × 1/s × 10 min: 0 local GUI edits lost silently (clashes become cards), 0 remote changes re-committed as the human's (3 seeds) [${ENGINE}]`, async (t) => {
    for (const seed of [160, 163, 164]) {
      const s = await scenario({ adoptMode: "h5", minutes: 10, seed });
      assert.equal(s.lost, 0, "local edits lost without a card");
      assert.equal(s.recommitted, 0, "remote values re-committed under the human's name");
      assert.ok(s.gui.undo.every((e) => e.actor === s.gui.human.id), "the undo stack holds only the actor group");
      assert.ok(s.remoteRows > 1600, "about 1,800 remote changes arrived");
      assertConverged(s.w, s.b, [s.m1, ...s.remotes]);
      // v14 (H1): `adopts` is 1 above the prototype's on each seed: a bot's withdraw row reaches M1 as a remote row
      // (no ops), and the GUI adopts the unchanged state once more
      report(t, { seed, humanEdits: s.humanEdits, guiSaves: s.saves, savedPaths: s.savedPaths, remoteChanges: s.remoteRows, adopts: s.gui.adopts, lost: s.lost, recommitted: s.recommitted, cardedEdits: s.cardedEdits, absorbedSaves: s.absorbedSaves, emptySaves: s.emptySaves, valueTransformed: s.valueTransformed, serverRejects: s.w.server.stats.rejects, lwwAccepts: s.w.server.stats.lww });
    }
  });

  test(`G1 control: 1.4.0's adopt (cancelPendingSave + whole-timeline adopt) loses local edits [${ENGINE}]`, async (t) => {
    const s = await scenario({ adoptMode: "stock", minutes: 2, seed: 161 });
    assert.ok(s.lost > 0);
    report(t, { humanEdits: s.humanEdits, lost: s.lost, undoEntriesFromDisk: s.gui.undo.filter((e) => e.actor === "disk").length });
  });

  test(`G1 control: an adopt that doesn't move the save base re-commits remote changes as the human's [${ENGINE}]`, async (t) => {
    const s = await scenario({ adoptMode: "no-base-move", minutes: 2, seed: 162 });
    assert.ok(s.recommitted > 0);
    report(t, { humanEdits: s.humanEdits, recommittedOps: s.recommitted });
  });
}
