// Correctness: Cardboard 1.4.0's own merge rn(base, editor, incoming, {prefer}) vs merge3 on the same inputs. Port of
// core-v5 `compare.mjs`. editor = the human in the app (merge3's "ours"), incoming = the agent's file ("theirs").
// node carton/bench/core/compare.ts [--engine carton|proto]   (CASES=n fuzz cases, default 2000)
// Prints markdown tables; writes $CARTON_BENCH_SCRATCH/raw/compare-<engine>.json (or OUT=<file>).
//
// --engine proto runs this same harness on the prototype's engine, schema and generators (CARTON_PROTO_DIR, default
// the core-v5 inspection copy; imported, never written), so ab.ts can check the two engines give identical tables.
// One adaptation: compare.mjs excused ripple-shifted start/end times when `merge3(...).shifts` was non-empty, a field
// the v5 engine no longer returns (compare.mjs predates v5 and throws there). The v5 equivalent used here: either
// side's remap map (inferred, as no remaps are passed) is non-empty. And v5's time algebra composes both sides' edits
// to one item's time group (a trim on each side: both deltas apply), so neither side's exact value survives; those
// changes are counted as "composed" (the merge's stats.composed names the group), not as lost.
import { writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { pathToFileURL } from "node:url";
import { loadCardboard, slice, SCRATCH } from "./util.ts";

type Item = Record<string, any>;
type Doc = Record<string, any>;
type Path = (string | number)[];
interface Card {
  kind: string;
  path: string;
  related?: string[];
}
// the engine surface this harness uses, the same in @carton/core and the prototype's engine.mjs
interface Engine {
  merge3(base: Doc, ours: Doc, theirs: Doc, schema: unknown): { doc: Doc; conflicts: Card[]; remaps: { ours: object; theirs: object }; stats: { composed: string[] } };
  diff(a: Doc, b: Doc, schema: unknown): { op: string; path: Path; value?: unknown }[];
  getIn(doc: Doc, path: Path, schema: unknown): unknown;
  deepEqual(a: unknown, b: unknown): boolean;
  pathKey(path: Path): string;
}
interface Gen {
  rng(seed: number): () => number;
  fuzzDoc(r: () => number): Doc;
  fuzzEdit(r: () => number, doc: Doc): Doc;
}

const arg = (k: string) => {
  const i = process.argv.indexOf(k);
  return i < 0 ? undefined : process.argv[i + 1];
};
const ENGINE = arg("--engine") ?? "carton";
const PROTO_DIR = process.env.CARTON_PROTO_DIR || "/home/ubuntu/.t3/projects/cardboard-showcase/_inspect/git-for-video/proofs/core-v5";
let E: Engine, S: unknown, G: Gen;
if (ENGINE === "carton") {
  E = (await import("@carton/core")) as unknown as Engine;
  S = (await import("../../packages/conformance/src/engine/fixtures/cardboard-schema.ts")).cardboard;
  G = (await import("../../packages/conformance/src/engine/gen.ts")) as unknown as Gen;
} else if (ENGINE === "proto") {
  const at = (f: string) => pathToFileURL(join(PROTO_DIR, f)).href;
  E = (await import(at("engine.mjs"))) as Engine;
  S = (await import(at("cardboard-schema.mjs"))).cardboard;
  G = (await import(at("gen.mjs"))) as Gen;
} else throw new Error(`--engine carton|proto, not ${ENGINE}`);
const { rng, fuzzDoc, fuzzEdit } = G;

const { rn } = await loadCardboard();
const json = (x: unknown): Doc => JSON.parse(JSON.stringify(x)); // Cardboard leaves unset keys as undefined
const item = (d: Doc, id: string): Item | undefined => d.timelineItems.find((i: Item) => i.id === id);
const edit = (doc: Doc, id: string, patch: Item): Doc => ({ ...doc, timelineItems: doc.timelineItems.map((i: Item) => (i.id === id ? { ...i, ...patch } : i)) });
const without = (doc: Doc, id: string): Doc => ({ ...doc, timelineItems: doc.timelineItems.filter((i: Item) => i.id !== id) });
const add = (doc: Doc, it: Item): Doc => ({ ...doc, timelineItems: [...doc.timelineItems, it] });
const dropTrack = (doc: Doc, tid: string): Doc => ({ ...doc, tracks: doc.tracks.filter((t: Item) => t.id !== tid), timelineItems: doc.timelineItems.filter((i: Item) => i.trackId !== tid) });
const valid = (d: Doc) => d.timelineItems.every((i: Item) => d.tracks.some((t: Item) => t.id === i.trackId));

// ------------------------------------------------------------------ scenarios

const base: Doc = {
  aspectRatio: "16:9",
  tracks: [
    { id: "titles", name: "Titles", order: 0, visible: true },
    { id: "main", name: "Main", order: 1, visible: true },
  ],
  timelineItems: [
    { id: "a1", trackId: "main", type: "video", name: "Intro", startTime: 0, endTime: 6, trimStart: 0, trimEnd: 6 },
    { id: "a2", trackId: "main", type: "video", name: "Problem", startTime: 6, endTime: 16, trimStart: 0, trimEnd: 10 },
    {
      id: "a3", trackId: "main", type: "video", name: "CTA", startTime: 16, endTime: 24, trimStart: 0, trimEnd: 8,
      colorGrade: { saturation: 1.1, contrast: 1 },
      effects: [{ id: "e1", type: "blur", amount: 1 }],
      keyframeTracks: [{ property: "opacity", keyframes: [{ time: 0, value: 0 }] }, { property: "scale", keyframes: [{ time: 0, value: 1 }] }],
    },
    {
      id: "t1", trackId: "titles", type: "caption", startTime: 0.5, endTime: 3, trimStart: 0, trimEnd: 2.5, captionText: "we cut editing time",
      captionSegments: [{ id: "s1", text: "we cut", startTime: 0, endTime: 1 }, { id: "s2", text: "editing time", startTime: 1, endTime: 2.5 }],
    },
  ],
};
const clips: [string, number, number][] = [["c1", 0, 6], ["c2", 6, 9], ["c3", 9, 14], ["c4", 14, 18], ["c5", 18, 22], ["c6", 22, 27], ["c7", 27, 33], ["c8", 33, 40]];
const rbase: Doc = {
  aspectRatio: "16:9",
  tracks: [{ id: "titles", name: "Titles", order: 0 }, { id: "v1", name: "V1", order: 1 }],
  timelineItems: clips.map(([id, s, e]) => ({ id, trackId: "v1", type: "video", name: id, startTime: s, endTime: e, trimStart: 1, trimEnd: 1 + e - s })),
};
const rippleDelete = (doc: Doc, id: string): Doc => {
  const x = item(doc, id)!, d = x.endTime - x.startTime;
  return { ...doc, timelineItems: doc.timelineItems.filter((i: Item) => i.id !== id).map((i: Item) => (i.trackId === x.trackId && i.startTime >= x.endTime ? { ...i, startTime: i.startTime - d, endTime: i.endTime - d } : i)) };
};
const title = { id: "ti", trackId: "titles", type: "text", startTime: 30, endTime: 32.5, trimStart: 0, trimEnd: 2.5, textContent: "Over clip 7" };
const t2 = { id: "t2", trackId: "titles", type: "text", startTime: 10, endTime: 12, trimStart: 0, trimEnd: 2, textContent: "New" };
const ripTrim = edit(edit(edit(base, "a1", { endTime: 4, trimEnd: 4 }), "a2", { startTime: 4, endTime: 14 }), "a3", { startTime: 14, endTime: 22 });

type Want = [who: string, what: string, ok: (d: Doc) => boolean, rec: string];
interface Scenario {
  name: string;
  base: Doc;
  editor: Doc;
  incoming: Doc;
  prefer?: string;
  exclusive?: boolean;
  want: Want[];
}
// want: [who, description, (doc) => kept?, record the change is about]
const scenarios: Scenario[] = [
  { name: "1 different items", base, editor: edit(base, "a1", { endTime: 5, trimEnd: 5 }), incoming: edit(base, "t1", { captionText: "10x faster" }),
    want: [["human", "trim Intro", (d) => item(d, "a1")?.endTime === 5, "timelineItems/a1"], ["agent", "caption text", (d) => item(d, "t1")?.captionText === "10x faster", "timelineItems/t1"]] },
  { name: "2 same item, different fields", base, editor: edit(base, "a2", { endTime: 14, trimEnd: 8 }), incoming: edit(base, "a2", { name: "The problem" }),
    want: [["human", "trim", (d) => item(d, "a2")?.endTime === 14, "timelineItems/a2"], ["agent", "rename", (d) => item(d, "a2")?.name === "The problem", "timelineItems/a2"]] },
  { name: "3 same field, different values", base, editor: edit(base, "a2", { endTime: 14 }), incoming: edit(base, "a2", { endTime: 15 }), exclusive: true,
    want: [["human", "end 14", (d) => item(d, "a2")?.endTime === 14, "timelineItems/a2"], ["agent", "end 15", (d) => item(d, "a2")?.endTime === 15, "timelineItems/a2"]] },
  { name: "4 as 2, Cardboard --prefer editor", base, prefer: "editor", editor: edit(base, "a2", { endTime: 14, trimEnd: 8 }), incoming: edit(base, "a2", { name: "The problem" }),
    want: [["human", "trim", (d) => item(d, "a2")?.endTime === 14, "timelineItems/a2"], ["agent", "rename", (d) => item(d, "a2")?.name === "The problem", "timelineItems/a2"]] },
  { name: "5 nested colorGrade keys", base, editor: edit(base, "a3", { colorGrade: { saturation: 1.3, contrast: 1 } }), incoming: edit(base, "a3", { colorGrade: { saturation: 1.1, contrast: 1.2 } }),
    want: [["human", "saturation 1.3", (d) => item(d, "a3")?.colorGrade?.saturation === 1.3, "timelineItems/a3"], ["agent", "contrast 1.2", (d) => item(d, "a3")?.colorGrade?.contrast === 1.2, "timelineItems/a3"]] },
  { name: "6 ripple trim vs trim of a later clip", base, editor: edit(base, "a2", { endTime: 14, trimEnd: 8 }), incoming: ripTrim,
    want: [["human", "Problem 2 s shorter (ends 12 after ripple)", (d) => item(d, "a2")?.endTime === 12 && item(d, "a2")?.startTime === 4, "timelineItems/a2"], ["agent", "ripple: CTA at 14", (d) => item(d, "a3")?.startTime === 14, "timelineItems/a3"]] },
  { name: "7 delete vs edit", base, editor: edit(base, "t1", { endTime: 4, trimEnd: 3.5 }), incoming: without(base, "t1"), exclusive: true,
    want: [["human", "extend caption", (d) => item(d, "t1")?.endTime === 4, "timelineItems/t1"], ["agent", "delete caption", (d) => !item(d, "t1"), "timelineItems/t1"]] },
  { name: "8 agent deletes track, human added item on it", base, editor: add(base, t2), incoming: dropTrack(base, "titles"), exclusive: true,
    want: [["human", "new title t2", (d) => !!item(d, "t2"), "timelineItems/t2"], ["agent", "track gone", (d) => !d.tracks.some((t: Item) => t.id === "titles"), "tracks/titles"]] },
  { name: "8b human deletes track, agent added item on it", base, editor: dropTrack(base, "titles"), incoming: add(base, t2), exclusive: true,
    want: [["human", "track gone", (d) => !d.tracks.some((t: Item) => t.id === "titles"), "tracks/titles"], ["agent", "new title t2", (d) => !!item(d, "t2"), "timelineItems/t2"]] },
  { name: "9 ripple delete vs retime + title over clip 7", base: rbase, editor: rippleDelete(rbase, "c2"), incoming: add(edit(rbase, "c7", { endTime: 32, trimEnd: 6 }), title),
    want: [["human", "ripple: c8 at 30", (d) => item(d, "c8")?.startTime === 30, "timelineItems/c8"], ["agent", "clip 7 = 24–29", (d) => item(d, "c7")?.startTime === 24 && item(d, "c7")?.endTime === 29, "timelineItems/c7"], ["agent", "title over clip 7 (27)", (d) => item(d, "ti")?.startTime === 27, "timelineItems/ti"]] },
  { name: "10 both add an effect to one clip", base, editor: edit(base, "a3", { effects: [...item(base, "a3")!.effects, { id: "e2", type: "glow", amount: 1 }] }), incoming: edit(base, "a3", { effects: [...item(base, "a3")!.effects, { id: "e3", type: "vignette", amount: 0.4 }] }),
    want: [["human", "glow", (d) => !!item(d, "a3")?.effects?.some((e: Item) => e.id === "e2"), "timelineItems/a3"], ["agent", "vignette", (d) => !!item(d, "a3")?.effects?.some((e: Item) => e.id === "e3"), "timelineItems/a3"]] },
  { name: "11 different keyframe tracks of one clip", base,
    editor: edit(base, "a3", { keyframeTracks: [{ property: "opacity", keyframes: [{ time: 0, value: 0.5 }] }, { property: "scale", keyframes: [{ time: 0, value: 1 }] }] }),
    incoming: edit(base, "a3", { keyframeTracks: [{ property: "opacity", keyframes: [{ time: 0, value: 0 }] }, { property: "scale", keyframes: [{ time: 0, value: 2 }] }] }),
    want: [["human", "opacity kf", (d) => item(d, "a3")?.keyframeTracks?.find((k: Item) => k.property === "opacity")?.keyframes[0].value === 0.5, "timelineItems/a3"], ["agent", "scale kf", (d) => item(d, "a3")?.keyframeTracks?.find((k: Item) => k.property === "scale")?.keyframes[0].value === 2, "timelineItems/a3"]] },
  { name: "12 different caption segments", base,
    editor: edit(base, "t1", { captionSegments: [{ id: "s1", text: "We cut", startTime: 0, endTime: 1 }, item(base, "t1")!.captionSegments[1]] }),
    incoming: edit(base, "t1", { captionSegments: [item(base, "t1")!.captionSegments[0], { id: "s2", text: "editing time 10x", startTime: 1, endTime: 2.5 }] }),
    want: [["human", "segment 1 fix", (d) => item(d, "t1")?.captionSegments?.[0]?.text === "We cut", "timelineItems/t1"], ["agent", "segment 2 edit", (d) => item(d, "t1")?.captionSegments?.[1]?.text === "editing time 10x", "timelineItems/t1"]] },
];

interface Judged {
  who: string;
  what: string;
  kept: boolean;
  flagged: boolean;
}
interface Side {
  conflicts: string[];
  valid: boolean;
  changes: Judged[];
}
const rows: { name: string; exclusive: boolean; cardboard: Side; engine: Side }[] = [];
for (const sc of scenarios) {
  const cb = rn(slice(sc.base), slice(sc.editor), slice(sc.incoming), { prefer: sc.prefer ?? "file" });
  const cbDoc = json(cb.doc);
  const tk = E.merge3(sc.base, sc.editor, sc.incoming, S);
  const judge = (doc: Doc, covers: (rec: string) => boolean): Judged[] =>
    sc.want.map(([who, what, ok, rec]) => {
      const kept = ok(doc);
      return { who, what, kept, flagged: !kept && covers(rec) };
    });
  // a lost change counts as flagged only if a reported conflict is about its record
  const cbFlag = (rec: string) => cb.conflicts.some((c) => rec === `${c.kind === "item" ? "timelineItems" : "tracks"}/${c.id}`);
  const tkFlag = (rec: string) => tk.conflicts.some((c) => [c.path, ...(c.related ?? [])].some((p) => p === rec || p.startsWith(rec + "/") || rec.startsWith(p + "/")));
  rows.push({
    name: sc.name,
    exclusive: !!sc.exclusive,
    cardboard: { conflicts: cb.conflicts.map((c) => `${c.kind}:${c.id}`), valid: valid(cbDoc), changes: judge(cbDoc, cbFlag) },
    engine: { conflicts: tk.conflicts.map((c) => `${c.kind}:${c.path}`), valid: valid(tk.doc), changes: judge(tk.doc, tkFlag) },
  });
}

const cell = (r: Side) => {
  const lost = r.changes.filter((c) => !c.kept);
  const parts = lost.map((c) => `${c.who} "${c.what}" ${c.flagged ? "lost (its record flagged)" : "**lost silently**"}`);
  const out = lost.length ? parts.join("; ") : "all kept";
  return `${out}${r.conflicts.length ? ` · conflicts: ${r.conflicts.join(", ")}` : ""}${r.valid ? "" : " · **invalid doc (item on missing track)**"}`;
};
console.log(`| Scenario | Cardboard rn (prefer file unless noted) | ${ENGINE === "proto" ? "prototype" : "Carton"} merge3 (provisional = human) |\n|---|---|---|`);
for (const r of rows) {
  // for exclusive scenarios one side must give way; with a conflict that is a pending choice, not a loss
  const tk = r.exclusive && r.engine.conflicts.length ? `conflict for the user: ${r.engine.conflicts.join(", ")}${r.engine.valid ? "" : " · invalid"}` : cell(r.engine);
  console.log(`| ${r.name} | ${cell(r.cardboard)} | ${tk} |`);
}

// ------------------------------------------------------------------ fuzz corpus: who loses what

const CASES = Number(process.env.CASES ?? 2000);
const tally = () => ({ changes: 0, kept: 0, flaggedLost: 0, composed: 0, silentLost: 0, invalid: 0, conflicts: 0, casesWithSilentLoss: 0, casesConflictNothingLost: 0, silentKinds: {} as Record<string, number> });
const T = { cardboard: tally(), engine: tally() };
const nonEmpty = (m: object) => Object.keys(m).length > 0;
const TIME = /^(startTime|endTime|trimStart|trimEnd|playbackSpeed)$/;
for (let c = 0; c < CASES; c++) {
  const r = rng(9000 + c); // same corpus as test.mjs's concurrent fuzz
  const strip = (d: Doc) => slice(d) as Doc;
  const b = strip(fuzzDoc(r)),
    x = strip(fuzzEdit(r, b)),
    y = strip(fuzzEdit(r, b));
  const cb = rn(b as never, x as never, y as never, { prefer: "file" });
  const cbDoc = json(cb.doc);
  const tk = E.merge3(b, x, y, S);
  const ripple = nonEmpty(tk.remaps.ours) || nonEmpty(tk.remaps.theirs); // compare.mjs: tk.shifts.length > 0 (pre-v5)
  const cbIds = new Set(cb.conflicts.map((k) => `${k.kind === "item" ? "timelineItems" : k.kind === "track" ? "tracks" : "aspectRatio"}/${k.id}`));
  const cbCovered = (p: Path) => (p[0] === "aspectRatio" ? cbIds.has("aspectRatio/aspectRatio") : cbIds.has(`${p[0]}/${p[1]}`));
  const tkKeys = tk.conflicts.flatMap((k) => [k.path, ...(k.related ?? [])]);
  const composedRecs = new Set(tk.stats.composed.map((k) => k.split("/").slice(0, 2).join("/")));
  const isComposed = (p: Path) => p[0] === "timelineItems" && TIME.test(String(p[2] ?? "")) && composedRecs.has(E.pathKey(p.slice(0, 2)));
  const tkCovered = (p: Path) => {
    const k = E.pathKey(p);
    return tkKeys.some((q) => k === q || k.startsWith(q + "/") || q.startsWith(k + "/"));
  };
  for (const [name, doc, covered, n, composed] of [["cardboard", cbDoc, cbCovered, cb.conflicts.length, () => false], ["engine", tk.doc, tkCovered, tk.conflicts.length, isComposed]] as const) {
    const t = T[name];
    t.conflicts += n;
    if (!valid(doc)) t.invalid++;
    let silent = 0,
      lost = 0;
    for (const side of [x, y])
      for (const op of E.diff(b, side, S)) {
        if (op.op === "order") continue;
        if (op.path[0] === "tracks" && op.path[2] === "order") continue; // both renumber track order
        if (ripple && op.path[0] === "timelineItems" && /^(startTime|endTime)$/.test(String(op.path[2] ?? ""))) continue;
        t.changes++;
        const v = E.getIn(doc, op.path, S);
        const kept = op.op === "set" ? E.deepEqual(v, op.value) : op.op === "insert" ? v !== undefined : v === undefined;
        if (kept) t.kept++;
        else if ((lost++, covered(op.path))) t.flaggedLost++;
        else if (composed(op.path)) t.composed++;
        else {
          t.silentLost++, silent++;
          const kind = `${op.op} ${op.path[0]}${op.path.length > 2 ? "." + op.path[2] : ""}`;
          t.silentKinds[kind] = (t.silentKinds[kind] ?? 0) + 1;
        }
      }
    if (silent) t.casesWithSilentLoss++;
    if (n && !lost) t.casesConflictNothingLost++;
  }
}
console.log(`\nRandom concurrent edits (${CASES} cases, seeds 9000+, 1–3 edits per side; changes = leaf/record ops of both sides):`);
console.log("| Engine | changes | kept | lost, flagged | composed (time algebra) | lost silently | cases with silent loss | invalid docs | conflicts reported | cases flagged with nothing lost |\n|---|---|---|---|---|---|---|---|---|---|");
for (const [n, t] of Object.entries(T)) console.log(`| ${n === "engine" ? ENGINE : n} | ${t.changes} | ${t.kept} | ${t.flaggedLost} | ${t.composed} | ${t.silentLost} | ${t.casesWithSilentLoss} | ${t.invalid} | ${t.conflicts} | ${t.casesConflictNothingLost} |`);
console.log("Cardboard silent losses by kind:", JSON.stringify(T.cardboard.silentKinds));
console.log(`(${ENGINE}: 'lost, flagged' = inside a reported conflict whose provisional choice is the human side; one resolve() call restores it.)`);

const file = process.env.OUT || join(SCRATCH, "raw", `compare-${ENGINE}.json`);
mkdirSync(dirname(file), { recursive: true });
writeFileSync(file, JSON.stringify({ engine: ENGINE, scenarios: rows, fuzz: { cases: CASES, ...T } }, null, 1));
