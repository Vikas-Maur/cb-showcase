// The shared timeline.tsx has several writers.
// R7-01: it is regenerated with a new header after every applied save, so a save's base is always its own header ref.
//   A writer that checks before writing saves titleY "B"; a writer that doesn't check then saves from an older read
//   (titleY still "b", plus its own titleX "A"). "B" must be kept (or carded), never silently reverted; "A" lands.
// R8-01: during a freeze the regenerated file is the freeze view: the freeze-start state plus every local agent's
//   applied saves, each merged with that save's own base. Two agents, one stale: after each re-read each sees the
//   other's applied edit; the remote change stays hidden until the freeze ends; head has no duplicate items.
// Port of system-v11 `test/r7-r8-shared-file.test.mjs`.
import test from "node:test";
import assert from "node:assert/strict";
import { doc, clips } from "../sim/world.ts";
import { Agent } from "../sim/agent.ts";
import { TIMELINE, type Materializer, type MaterializerOptions } from "../sim/replica.ts";
import { A, world, until, runFor, assertConverged, report, ENGINE } from "../helpers.ts";

const text = (id: string, s: string, track = "T2"): A.Item => ({ id, trackId: track, type: "text", name: id, textContent: s, startTime: 0, endTime: 3, trimStart: 0, trimEnd: 3, opacity: 1 });
const find = (d: A.SimDoc, id: string) => d.timelineItems!.find((i) => i.id === id)!;
// every foreign save applied at most once, and in the order it was written (Verification 4: "leaves the queue", order)
function assertOnceInOrder(mz: Materializer, writer?: string) {
  const mine = mz.applied.filter((a) => !writer || a.actor === writer);
  const hashes = mine.map((a) => a.hash);
  assert.equal(new Set(hashes).size, hashes.length, "no save applied twice");
  const times = mine.map((a) => a.writtenAt);
  assert.deepEqual(times, [...times].sort((x, y) => x - y), "applied in write order");
}

// B (checks) saves titleY "B"; A (no check) then writes the whole file from its older read R0, exactly gapMs later.
async function staleWriter({ v7 = false, gapMs = 5000, watch, seed }: { v7?: boolean; gapMs?: number; watch?: MaterializerOptions["watch"]; seed: number }) {
  const w = world({ seed });
  const m1 = w.replica({ name: "m1" });
  const b = w.shared(doc({ tracks: ["V1", "T2"], items: [...clips(3), text("titleX", "a"), text("titleY", "b")] }), [m1]);
  await m1.startApp({ materializer: { ...(v7 ? { sharedBase: "lastSave", regenerateAfterSave: false } : {}), ...(watch ? { watch } : {}) } });
  const B = new Agent(m1, { name: "writer-B (checks)", hooked: false, checks: true });
  const Aw = new Agent(m1, { name: "writer-A (no check)", hooked: false, checks: false });
  const r0 = await until(w, Aw.read(TIMELINE)); // A's read: R0
  await until(w, B.read(TIMELINE));
  await until(w, B.editUntilDone(TIMELINE, (d) => { find(d, "titleY").textContent = "B"; }));
  const tB = m1.fs.log.filter((e) => e.path === TIMELINE && e.writer === B.name).at(-1)!.t;
  const mine = A.clone(r0.doc);
  find(mine, "titleX").textContent = "A";
  w.sim.at(tB + gapMs, () => m1.fs.write(TIMELINE, `${r0.header}\n${A.snapshot(mine)}\n`, Aw)); // whole-file write from the old read
  await runFor(w, gapMs + 3000);
  const head = m1.store.optimistic(b).doc as A.SimDoc;
  return { w, b, m1, head, cards: m1.cards, mz: m1.worker!.materializer! };
}

// Displace, then install covers every Takes write (v10 §6.4): a `cb source print` lands 1 ms after a foreign save,
// before its watch event has read it. The save is held outside the path's queue and still applied; the same writer
// then writes again 0.5 ms later, and that save lands too.
async function printOverPending({ displace = true, second = true, seed }: { displace?: boolean; second?: boolean; seed: number }) {
  const w = world({ seed });
  const m1 = w.replica({ name: "m1" });
  const b = w.shared(doc({ tracks: ["V1", "T2"], items: [...clips(3), text("titleX", "a"), text("titleY", "b")] }), [m1]);
  await m1.startApp({ materializer: { displace } });
  await runFor(w, 1000);
  const r0 = m1.fs.read(TIMELINE)!.content;
  const hdr = r0.slice(0, r0.indexOf("\n"));
  const mk = (fn: (d: A.SimDoc) => void) => { const d = A.clone(JSON.parse(r0.slice(r0.indexOf("\n") + 1))); fn(d); return `${hdr}\n${A.snapshot(d)}\n`; };
  const Aw = { name: "writer-A", hooked: false };
  const t0 = w.sim.now + 10;
  w.sim.at(t0, () => m1.fs.write(TIMELINE, mk((d) => { find(d, "titleX").textContent = "A"; }), Aw));
  w.sim.at(t0 + 1, () => m1.worker!.materializer!.printShared()); // another agent's `cb source print`
  if (second) w.sim.at(t0 + 1.5, () => m1.fs.write(TIMELINE, mk((d) => { find(d, "titleX").textContent = "A"; find(d, "c0").name = "A2"; }), Aw));
  await runFor(w, 3000);
  return { w, b, m1, head: m1.store.optimistic(b).doc as A.SimDoc, mz: m1.worker!.materializer! };
}

// Verification 4, hole 3: with the app closed nobody watches the files. A foreign save made then must not be
// overwritten unseen by the next Takes write: a headless `cb source print`, a headless view re-print, or the app
// starting.
async function closedApp(seed: number) {
  const w = world({ seed });
  const m1 = w.replica({ name: "m1" });
  const b = w.shared(doc({ tracks: ["V1", "T2"], items: [...clips(3), text("titleX", "a"), text("titleY", "b")] }), [m1]);
  const agent = new Agent(m1, { name: "agent", hooked: false });
  await until(w, agent.cb({ kind: "print" })); // headless print: the helper writes timeline.tsx
  const r0 = await until(w, agent.read(TIMELINE));
  const mine = A.clone(r0.doc); find(mine, "titleX").textContent = "offline edit";
  await until(w, agent.write(TIMELINE, `${r0.header}\n${A.snapshot(mine)}\n`)); // nobody is watching
  return { w, b, m1, agent };
}

async function freezeView({ literal = false, seed }: { literal?: boolean; seed: number }) {
  const w = world({ seed });
  const m1 = w.replica({ name: "m1", link: w.net.link({ rtt: 100 }) });
  const m2 = w.replica({ name: "m2-bob", link: w.net.link({ rtt: 100 }) });
  const items = clips(10, { prefix: "clip" });
  const b = w.shared(doc({ tracks: ["V1", "T2"], items }), [m1, m2]);
  await m1.startApp({ materializer: literal ? { freezeView: "literal" } : {} });
  await m2.startApp();
  const Bag = new Agent(m1, { name: "director/c/t1", hooked: true, checks: true, actor: { window: m1.worker!.window, turn: "t1" } });
  const Aag = new Agent(m1, { name: "terminal (no check)", hooked: false, checks: false });
  const r0 = await until(w, Bag.read(TIMELINE)); // B's hooked read starts the freeze
  const a0 = await until(w, Aag.read(TIMELINE)); // A reads the same R0
  assert.ok(m1.worker!.materializer!.freeze.active);
  m2.worker!.gui!.edit((d) => { find(d, "clip9").name = "remote edit"; }, [["timelineItems/clip9/name", "remote edit"]]);
  await runFor(w, 2000);
  assert.equal(A.item(m1.store.optimistic(b).doc, "clip9")!.name, "remote edit", "the remote change reached M1's head");
  // B adds a title and saves; A saves from its R0 read (stale, no check) with its own trim of clip1
  await until(w, Bag.editUntilDone(TIMELINE, (d) => { d.timelineItems!.push(text("title_b7", "Title by B")); }));
  await runFor(w, 1000);
  const mine = A.clone(a0.doc);
  Object.assign(find(mine, "clip1"), { endTime: 9, trimEnd: 4 });
  await until(w, Aag.write(TIMELINE, `${a0.header}\n${A.snapshot(mine)}\n`));
  await runFor(w, 1000);
  // each re-reads
  const bSees = (await until(w, Bag.read(TIMELINE))).doc;
  const aSees = (await until(w, Aag.read(TIMELINE))).doc;
  // an agent that finds its title gone re-adds it, without an id (a new element), as agents do
  if (!bSees.timelineItems!.some((i) => i.textContent === "Title by B")) {
    await until(w, Bag.editUntilDone(TIMELINE, (d) => { d.timelineItems!.push(text(`title_${w.sim.hex(4)}`, "Title by B")); }));
    await runFor(w, 1000);
  }
  const duringFreeze = (await until(w, Bag.read(TIMELINE))).doc;
  Bag.stop();
  await runFor(w, 70000); // A's 60 s windowless freeze runs out
  const afterFreeze = (await until(w, Aag.read(TIMELINE))).doc;
  const head = m1.store.optimistic(b).doc as A.SimDoc;
  return { w, b, m1, m2, r0, bSees, aSees, duringFreeze, afterFreeze, head };
}

export function register(): void {
  test(`R7-01 stale writer on the shared file: "B" kept, the stale writer's "A" lands [${ENGINE}]`, async (t) => {
    const { w, b, m1, head, cards, mz } = await staleWriter({ seed: 140 });
    assert.equal(find(head, "titleY").textContent, "B", "B kept, not silently reverted");
    assert.equal(find(head, "titleX").textContent, "A", "the stale writer's own edit landed");
    assert.equal(cards.length, 0);
    assert.equal(mz.applied.length, 2, "both saves applied");
    assertConverged(w, b, [m1]);
    report(t, { titleY: find(head, "titleY").textContent, titleX: find(head, "titleX").textContent, cards: cards.length });
  });

  test(`R7-01 control: v7's last-save base without regeneration silently reverts "B" [${ENGINE}]`, async (t) => {
    const { head, cards } = await staleWriter({ v7: true, seed: 141 });
    assert.equal(find(head, "titleY").textContent, "b", "B silently reverted");
    assert.equal(cards.length, 0, "with no card");
    report(t, { titleY: find(head, "titleY").textContent, cards: cards.length });
  });

  test(`v10 reads on every watch event: a stale whole-file write 60 ms after B's save no longer replaces it; both land [${ENGINE}]`, async (t) => {
    const { head, mz } = await staleWriter({ gapMs: 60, seed: 142 });
    assert.equal(find(head, "titleY").textContent, "B", "B kept");
    assert.equal(find(head, "titleX").textContent, "A", "A landed");
    assert.equal(mz.superseded.length, 0);
    report(t, { gapMs: 60, titleY: "B", applied: mz.applied.length });
  });

  test(`v9 control (every save waits 150 ms of quiet): the same 60 ms gap loses B [${ENGINE}]`, async (t) => {
    const { head, mz } = await staleWriter({ gapMs: 60, watch: "quiesce", seed: 142 });
    assert.equal(find(head, "titleY").textContent, "b", "B's save was never applied: lost, with no card");
    assert.equal(mz.superseded.length, 1, "the model records it (one save replaced before it was read)");
    report(t, { gapMs: 60, titleY: "b", superseded: mz.superseded.length });
  });

  // L18: writer against writer inside the watcher's latency (2 ms here). A write that replaces another before the watch
  // event reads it loses the first save; that is outside Takes, and the model records it as superseded.
  test(`L18 window: a second foreign write inside the 2 ms watch latency replaces the first (recorded); from 2 ms on both land; A always lands [${ENGINE}]`, async (t) => {
    const out: { gapMs: number; keptB: boolean; superseded: number }[] = [];
    for (const gapMs of [0.5, 1, 1.99, 2.01, 3, 10]) {
      const { head, mz } = await staleWriter({ gapMs, seed: 146 });
      const keptB = find(head, "titleY").textContent === "B";
      assert.equal(find(head, "titleX").textContent, "A", `gap ${gapMs}: A landed`);
      assert.ok(keptB || mz.superseded.length === 1, `gap ${gapMs}: B lost without a record`);
      if (gapMs > 2) assert.ok(keptB, `gap ${gapMs}: B was read before A replaced it`);
      out.push({ gapMs, keptB, superseded: mz.superseded.length });
    }
    assert.ok(out.some((r) => !r.keptB), "the window exists");
    report(t, out);
  });

  test(`Displacement (v10): a cb print lands on a foreign save before its watch event; the save is held and applied, and the same writer's next save lands too [${ENGINE}]`, async (t) => {
    const { w, b, m1, head, mz } = await printOverPending({ seed: 147 });
    assert.equal(mz.displaced.length, 1, "the print displaced A's unread save");
    assert.equal(find(head, "titleX").textContent, "A", "A's displaced save applied");
    assert.equal(find(head, "c0").name, "A2", "A's second save applied");
    assert.equal(mz.superseded.length + mz.overwritten.length, 0);
    assert.equal(mz.applied.filter((a) => a.actor === "external:timeline.tsx").length, 2, "each save applied once");
    assertOnceInOrder(mz, "external:timeline.tsx");
    assertConverged(w, b, [m1]);
    report(t, { displaced: mz.displaced.length, applied: mz.applied.length });
  });
  test(`Displacement control: without displace-then-install the print destroys A's unread save [${ENGINE}]`, async (t) => {
    const { head, mz } = await printOverPending({ displace: false, second: false, seed: 147 });
    assert.equal(mz.overwritten.length, 1, "Takes overwrote a foreign save it never read");
    assert.equal(find(head, "titleX").textContent, "a", "A's save is gone");
    report(t, { overwritten: mz.overwritten.length, titleX: find(head, "titleX").textContent });
  });

  // An in-place writer (truncate, then write) leaves content that doesn't parse for a moment: it waits for quiet.
  test(`v10 in-place writer: a partial file is not applied; the complete file is applied once; a file that never parses is kept and reported [${ENGINE}]`, async (t) => {
    const w = world({ seed: 148 });
    const m1 = w.replica({ name: "m1" });
    const b = w.shared(doc({ tracks: ["V1", "T2"], items: [...clips(3), text("titleX", "a")] }), [m1]);
    await m1.startApp();
    await runFor(w, 1000);
    const r0 = m1.fs.read(TIMELINE)!.content;
    const d = A.clone(JSON.parse(r0.slice(r0.indexOf("\n") + 1)));
    find(d, "titleX").textContent = "A";
    const full = `${r0.slice(0, r0.indexOf("\n"))}\n${A.snapshot(d)}\n`;
    const W = { name: "in-place writer", hooked: false };
    const t0 = w.sim.now + 10;
    w.sim.at(t0, () => m1.fs.write(TIMELINE, full.slice(0, full.length >> 1), W));
    w.sim.at(t0 + 80, () => m1.fs.write(TIMELINE, full, W));
    await runFor(w, 3000);
    const mz = m1.worker!.materializer!;
    assert.equal(find(m1.store.optimistic(b).doc, "titleX").textContent, "A");
    assert.equal(mz.applied.length, 1, "applied once");
    assert.equal(mz.superseded.length, 0, "the writer's own completion isn't a loss");
    const Z = { name: "broken writer", hooked: false };
    w.sim.at(w.sim.now + 10, () => m1.fs.write(TIMELINE, "// cardboard:rev x by y\n{not json", Z));
    await runFor(w, 3000);
    assert.equal(mz.unparsed.length, 1, "kept and reported, never applied");
    assert.equal(mz.applied.length, 1);
    report(t, { applied: mz.applied.length, unparsed: mz.unparsed.length });
  });

  // The quiet-window path (v9's rule for every save; v10 keeps it only for content that doesn't parse yet), run with
  // watch: "quiesce". Two foreign whole-file saves around the 150 ms quiescence boundary: B at t0, A at t0+gap.
  // Orders at a tie: A's write event first, or B's quiescence timer first. "busy": the engine thread is busy from 149 to
  // 189 ms (a rebase), so B's apply and the regeneration after it land while A's save is still pending. Invariant: A's
  // save always lands; B's lands too unless A replaced it inside B's quiet window, and then that loss is recorded.
  test(`Quiet-window path (B2): both event orders at 150 ms and a busy engine; A always lands, B is kept or its loss recorded, never lost unrecorded [${ENGINE}]`, async (t) => {
    const out: Record<string, unknown>[] = [];
    const cases: { gap: number; order: "A first" | "timer first"; busy?: boolean }[] = [
      ...[149, 150, 151].map((gap) => ({ gap, order: "A first" as const })),
      ...[150, 151].map((gap) => ({ gap, order: "timer first" as const })),
      ...[140, 155, 170, 188, 190, 200].map((gap) => ({ gap, order: "timer first" as const, busy: true })),
    ];
    for (const c of cases) {
      const w = world({ seed: 143 });
      const m1 = w.replica({ name: "m1" });
      const b = w.shared(doc({ tracks: ["V1", "T2"], items: [...clips(3), text("titleX", "a"), text("titleY", "b")] }), [m1]);
      await m1.startApp({ materializer: { watch: "quiesce" } });
      await runFor(w, 1000);
      const r0 = m1.fs.read(TIMELINE)!.content;
      const p = (x: string) => x.slice(0, x.indexOf("\n"));
      const mk = (fn: (d: A.SimDoc) => void) => { const d = A.clone(JSON.parse(r0.slice(r0.indexOf("\n") + 1))); fn(d); return `${p(r0)}\n${A.snapshot(d)}\n`; };
      const B = { name: "writer-B", hooked: false }, Aw = { name: "writer-A", hooked: false };
      const writeA = () => m1.fs.write(TIMELINE, mk((d) => { find(d, "titleX").textContent = "A"; }), Aw);
      const t0 = w.sim.now + 10;
      if (c.order === "A first") w.sim.at(t0 + c.gap, writeA); // queued before B's timer exists
      w.sim.at(t0, () => {
        m1.fs.write(TIMELINE, mk((d) => { find(d, "titleY").textContent = "B"; }), B); // schedules B's quiescence timer
        if (c.order === "timer first") w.sim.at(t0 + c.gap, writeA); // queued after it
      });
      if (c.busy) w.sim.at(t0 + 149, () => m1.worker!.proc.engine.stall(40));
      await runFor(w, 3000);
      const head = m1.store.optimistic(b).doc as A.SimDoc, mz = m1.worker!.materializer!;
      const keptB = find(head, "titleY").textContent === "B", landedA = find(head, "titleX").textContent === "A";
      assert.ok(landedA, `${c.order} ${c.gap} ms${c.busy ? " busy" : ""}: A's save lost`);
      assert.ok(keptB || mz.superseded.length === 1, `${c.order} ${c.gap} ms${c.busy ? " busy" : ""}: B lost without a record`);
      if (c.gap > 150 || (c.gap === 150 && c.order === "timer first")) assert.ok(keptB, `${c.order} ${c.gap} ms: B was quiet for 150 ms and must be applied`);
      out.push({ ...c, keptB, landedA, superseded: mz.superseded.length, displaced: mz.displaced.length });
    }
    assert.ok(out.some((r) => (r.displaced as number) > 0), "some case had Takes install over a pending save (the window this test exists for)");
    report(t, out);
  });

  test(`Quiet-window path: a displaced save, then the same writer saves again inside its quiet window: both of that writer's saves apply [${ENGINE}]`, async (t) => {
    const w = world({ seed: 145 });
    const m1 = w.replica({ name: "m1" });
    const b = w.shared(doc({ tracks: ["V1", "T2"], items: [...clips(3), text("titleX", "a"), text("titleY", "b")] }), [m1]);
    await m1.startApp({ materializer: { watch: "quiesce" } });
    await runFor(w, 1000);
    const body = (c: string) => JSON.parse(c.slice(c.indexOf("\n") + 1));
    const hdr = (c: string) => c.slice(0, c.indexOf("\n"));
    const r0 = m1.fs.read(TIMELINE)!.content;
    const B = { name: "writer-B", hooked: false }, Aw = { name: "writer-A", hooked: false };
    const t0 = w.sim.now + 10;
    w.sim.at(t0, () => { const d = A.clone(body(r0)); find(d, "titleY").textContent = "B"; m1.fs.write(TIMELINE, `${hdr(r0)}\n${A.snapshot(d)}\n`, B); });
    w.sim.at(t0 + 149, () => m1.worker!.proc.engine.stall(40)); // B's apply and the regeneration land at ~189 ms
    w.sim.at(t0 + 170, () => { const d = A.clone(body(r0)); find(d, "titleX").textContent = "A"; m1.fs.write(TIMELINE, `${hdr(r0)}\n${A.snapshot(d)}\n`, Aw); });
    // A re-reads the regenerated file (B's title, not its own first edit) and saves a second edit 80 ms after its first
    w.sim.at(t0 + 250, () => { const cur = m1.fs.read(TIMELINE)!.content; const d = A.clone(body(cur)); find(d, "c0").name = "A2"; m1.fs.write(TIMELINE, `${hdr(cur)}\n${A.snapshot(d)}\n`, Aw); });
    await runFor(w, 3000);
    const head = m1.store.optimistic(b).doc as A.SimDoc, mz = m1.worker!.materializer!;
    assert.ok(mz.displaced.length >= 1, "A's first save was displaced by the regeneration");
    assert.equal(find(head, "titleY").textContent, "B");
    assert.equal(find(head, "titleX").textContent, "A", "A's displaced first save applied");
    assert.equal(find(head, "c0").name, "A2", "A's second save applied");
    assert.equal(mz.superseded.length, 0);
    assertOnceInOrder(mz);
    report(t, { displaced: mz.displaced.length, applied: mz.applied.length });
  });

  // Verification 4, hole 1: the writer saves again 0.5 ms after a print displaced its first save, inside the 2 ms watch
  // latency. The first save's stale watch event reads the second save; the held first save must still go first.
  test(`Displacement order: a same-writer save inside the watch latency after a displacement is applied after the displaced one, each once [${ENGINE}]`, async (t) => {
    const w = world({ seed: 149 });
    const m1 = w.replica({ name: "m1" });
    const b = w.shared(doc({ tracks: ["V1", "T2"], items: [...clips(3), text("titleX", "a")] }), [m1]);
    await m1.startApp();
    await runFor(w, 1000);
    const r0 = m1.fs.read(TIMELINE)!.content, hdr = r0.slice(0, r0.indexOf("\n"));
    const mk = (fn: (d: A.SimDoc) => void) => { const d = A.clone(JSON.parse(r0.slice(r0.indexOf("\n") + 1))); fn(d); return `${hdr}\n${A.snapshot(d)}\n`; };
    const Aw = { name: "writer-A", hooked: false };
    const t0 = w.sim.now + 10;
    w.sim.at(t0, () => m1.fs.write(TIMELINE, mk((d) => { find(d, "titleX").textContent = "v1"; }), Aw));
    w.sim.at(t0 + 1, () => m1.worker!.materializer!.printShared());
    // the writer kept editing its own buffer: v2 = v1 plus a rename of c0 (same header, the same old read)
    w.sim.at(t0 + 1.5, () => m1.fs.write(TIMELINE, mk((d) => { find(d, "titleX").textContent = "v1"; find(d, "c0").name = "v2"; }), Aw));
    await runFor(w, 3000);
    const mz = m1.worker!.materializer!;
    assert.equal(mz.displaced.length, 1);
    assert.deepEqual(mz.applied.map((a) => a.writtenAt - t0), [0, 1.5], "v1 then v2");
    assertOnceInOrder(mz);
    const head = m1.store.optimistic(b).doc as A.SimDoc;
    assert.deepEqual([find(head, "titleX").textContent, find(head, "c0").name], ["v1", "v2"]);
    assert.equal(m1.cards.length, 0);
    report(t, { applied: mz.applied.map((a) => a.writtenAt - t0) });
  });

  // Verification 4, hole 2: an in-place writer's partial file is displaced by a print mid-write. It is kept and
  // reported to its writer (a notice), never dropped silently; the writer's completed file is applied.
  test(`Displaced partial: a half-written file displaced by a print is reported to its writer, not dropped silently; the completed save lands [${ENGINE}]`, async (t) => {
    const w = world({ seed: 150 });
    const m1 = w.replica({ name: "m1" });
    const b = w.shared(doc({ tracks: ["V1", "T2"], items: [...clips(3), text("titleX", "a")] }), [m1]);
    await m1.startApp();
    await runFor(w, 1000);
    const r0 = m1.fs.read(TIMELINE)!.content;
    const d = A.clone(JSON.parse(r0.slice(r0.indexOf("\n") + 1)));
    find(d, "titleX").textContent = "A";
    const full = `${r0.slice(0, r0.indexOf("\n"))}\n${A.snapshot(d)}\n`;
    const W = { name: "in-place writer", hooked: false };
    const t0 = w.sim.now + 10;
    w.sim.at(t0, () => m1.fs.write(TIMELINE, full.slice(0, full.length >> 1), W));
    w.sim.at(t0 + 1, () => m1.worker!.materializer!.printShared());
    w.sim.at(t0 + 80, () => m1.fs.write(TIMELINE, full, W));
    await runFor(w, 3000);
    const mz = m1.worker!.materializer!;
    assert.equal(mz.displaced.length, 1);
    assert.equal(mz.unparsed.filter((u) => u.displaced).length, 1, "the displaced partial is recorded");
    assert.ok(m1.store.peekNotices("external:timeline.tsx").some((n) => /doesn't parse/.test(n.text)), "its writer is told");
    assert.equal(find(m1.store.optimistic(b).doc, "titleX").textContent, "A", "the completed save landed");
    report(t, { unparsed: mz.unparsed.length });
  });

  test(`Headless print (app closed): a foreign save nobody watched is imported before the print overwrites the file [${ENGINE}]`, async (t) => {
    const { w, b, m1, agent } = await closedApp(151);
    await runFor(w, 1000);
    assert.equal(find(m1.store.optimistic(b).doc, "titleX").textContent, "a", "not applied yet: nobody watches");
    await until(w, agent.cb({ kind: "print" }));
    await runFor(w, 3000);
    assert.equal(find(m1.store.optimistic(b).doc, "titleX").textContent, "offline edit", "imported, then printed");
    assert.equal(m1.helpers[0]!.mz!.imported.length, 1);
    assert.equal(w.server.branches.get(b)!.rows.length, 1, "confirmed once");
    report(t, { imported: m1.helpers[0]!.mz!.imported.length });
  });
  test(`App start: a foreign save made while the app was closed is imported before the start-up regeneration [${ENGINE}]`, async (t) => {
    const { w, b, m1 } = await closedApp(152);
    await until(w, m1.startApp());
    await runFor(w, 3000);
    assert.equal(find(m1.store.optimistic(b).doc, "titleX").textContent, "offline edit");
    assert.equal(m1.worker!.materializer!.imported.length, 1);
    assert.ok(m1.fs.read(TIMELINE)!.content.includes("offline edit"), "the regenerated file shows it");
    report(t, { imported: m1.worker!.materializer!.imported.length });
  });
  test(`Headless view re-print (app closed): the agent's unseen view save is applied before the re-print [${ENGINE}]`, async (t) => {
    const w = world({ seed: 153 });
    const m1 = w.replica({ name: "m1" });
    const b = w.shared(doc({ tracks: ["V1", "T2"], items: [...clips(3), text("titleX", "a")] }), [m1]);
    const agent = new Agent(m1, { name: "agent", hooked: false });
    const { path, name } = await until(w, agent.cb({ kind: "printView" }));
    await until(w, agent.read(path));
    await until(w, agent.editUntilDone(path, (d) => { find(d, "titleX").textContent = "view edit"; }));
    await until(w, agent.cb({ kind: "printView", name }));
    await runFor(w, 3000);
    assert.equal(find(m1.store.optimistic(b).doc, "titleX").textContent, "view edit");
    assert.ok(m1.fs.read(path)!.content.includes("view edit"), "the re-print shows it");
    report(t, { imported: m1.helpers[0]!.mz!.imported.length });
  });

  test(`R7-01 with B1: a hooked turn that pinned the shared file's state ends; a legacy writer's save from that header still applies [${ENGINE}]`, async (t) => {
    const w = world({ seed: 144 });
    const m1 = w.replica({ name: "m1" });
    const b = w.shared(doc({ tracks: ["V1", "T2"], items: [...clips(3), text("titleX", "a")] }), [m1]);
    await m1.startApp();
    const legacy = new Agent(m1, { name: "legacy (no check)", hooked: false, checks: false });
    const r0 = await until(w, legacy.read(TIMELINE));
    const hooked = new Agent(m1, { name: "director/c/t1", hooked: true, actor: { window: m1.worker!.window, turn: "t1" } });
    const pr = await until(w, hooked.cb({ kind: "printView" }));
    assert.equal(pr.ref, r0.ref, "the turn pinned the same state the shared file's header names");
    hooked.stop();
    const mine = A.clone(r0.doc);
    find(mine, "titleX").textContent = "A";
    await until(w, legacy.write(TIMELINE, `${r0.header}\n${A.snapshot(mine)}\n`));
    await runFor(w, 2000);
    assert.equal(find(m1.store.optimistic(b).doc, "titleX").textContent, "A", "applied: the shared file's own pin outlives the turn's");
    assert.equal(m1.store.peekNotices("external:timeline.tsx").length, 0, "no re-print error");
    report(t, { applied: true });
  });

  test(`R8-01 freeze view: two agents (one stale) see each other's applied edits; the remote change waits for the freeze to end; no duplicates [${ENGINE}]`, async (t) => {
    const { w, b, m1, m2, bSees, aSees, duringFreeze, afterFreeze, head } = await freezeView({ seed: 150 });
    assert.equal(find(bSees, "clip1").endTime, 9, "B sees A's applied edit");
    assert.ok(find(aSees, "title_b7"), "A sees B's applied edit");
    for (const d of [bSees, aSees, duringFreeze]) assert.equal(find(d, "clip9").name, "clip9", "the remote change stays hidden during the freeze");
    assert.equal(find(afterFreeze, "clip9").name, "remote edit", "after the freeze the file is head");
    assert.equal(head.timelineItems!.filter((i) => i.textContent === "Title by B").length, 1, "no duplicate title in head");
    assert.equal(find(head, "clip1").endTime, 9);
    assertConverged(w, b, [m1, m2]);
    report(t, { titlesInHead: head.timelineItems!.filter((i) => i.textContent === "Title by B").length });
  });

  test(`R8-01 control: v8's literal "state of that save" hides B's title from B, which re-adds it: a duplicate in head [${ENGINE}]`, async (t) => {
    const { bSees, head } = await freezeView({ literal: true, seed: 151 });
    assert.ok(!bSees.timelineItems!.some((i) => i.textContent === "Title by B"), "B's applied title vanished from the file");
    assert.equal(head.timelineItems!.filter((i) => i.textContent === "Title by B").length, 2, "duplicate title in head");
    report(t, { titlesInHead: 2 });
  });
}
