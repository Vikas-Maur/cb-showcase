// P4 benchmarks on @carton/core, with Cardboard 1.4.0's own merge (rn) on the same inputs. Port of core-v5 `bench.mjs`:
// the same cells (labels byte for byte), sizes, inputs, RUNS and load gate, so the numbers compare with the
// prototype's (ab.ts runs both alternately).
// node --expose-gc carton/bench/core/bench.ts [sizes...]   (RUNS=n, default 7; LOAD_MAX, LOAD_WAIT: the load gate)
// Prints a table (every run + median + the 1-minute load average before the row) and writes
// $CARTON_BENCH_SCRATCH/raw/bench-carton[-sizes][-TAG].json (or OUT=<file>).
//
// Where the port differs, and why:
// - The sequencer rows push to `sequencer.createLocalSequencer` (the redesigned sequencer, PLAN v14), so a change
//   carries its declaration fields and `base: {seq, pending}`, and ids have the `<cut>.<n>` shape it checks. Its notes
//   say how many pushes were accepted, so a row can't silently measure the wrong verdict.
// - Module sizes: the engine is many files, so it is bundled; "core" is engine + history (the P4 budget's entry).
import { writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as E from "@carton/core";
import { History, sequencer } from "@carton/core";
import type { Doc, Op, Intent } from "@carton/core";
import { cardboard as S, toHost, withKeys } from "../../packages/conformance/src/engine/fixtures/cardboard-schema.ts";
import type { HostDoc } from "../../packages/conformance/src/engine/fixtures/cardboard-schema.ts";
import { genDoc, rng, pick, rippleCut } from "../../packages/conformance/src/engine/gen.ts";
import type { Rng } from "../../packages/conformance/src/engine/gen.ts";
import { measure, callsOf, gz, bytes, fmtMs, fmtB, machine, loadCardboard, slice, RUNS, loadGate, SCRATCH } from "./util.ts";
import type { Load, MeasureOpts, Measured } from "./util.ts";

type Item = Record<string, any>;
const SIZES = process.argv.slice(2).map(Number).filter(Boolean);
const sizes = SIZES.length ? SIZES : [100, 1000, 10000];
const { rn } = await loadCardboard();
const r3 = (x: number) => Math.round(x * 1000) / 1000;
const out: Record<string, any> = { machine: machine(), runs: RUNS, started: new Date().toISOString(), sizes: {}, sizesOnly: {}, shots: null };
const P = (s: string): Doc => JSON.parse(s);

// Cardboard's rn sees project.json-shaped docs (no "#pos"); converted once per record object, so the
// three inputs share unchanged records exactly as the engine docs do (same "shared" condition for both).
const HOST = new WeakMap<object, Item>();
const hostRec = (r: Item): Item => {
  let h = HOST.get(r);
  if (!h) {
    h = toHost({ tracks: [], timelineItems: [r] }).timelineItems[0] as Item;
    HOST.set(r, h);
  }
  return h;
};
const hostShared = (d: Doc): HostDoc => ({ tracks: toHost({ tracks: d.tracks, timelineItems: [] }).tracks, timelineItems: (d.timelineItems as Item[]).map(hostRec), aspectRatio: d.aspectRatio });

function sample<T>(r: Rng, arr: readonly T[], k: number): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(r() * (i + 1));
    [a[i], a[j]] = [a[j]!, a[i]!];
  }
  return a.slice(0, k);
}
const trim = (it: Item): Op[] => [
  { op: "set", path: ["timelineItems", it.id, "endTime"], value: r3(it.endTime - 0.5) },
  { op: "set", path: ["timelineItems", it.id, "trimEnd"], value: r3(it.trimEnd - 0.5) },
];
const humanEdit = (it: Item, k: number): Op[] => {
  const p = ["timelineItems", it.id];
  if (it.type === "video") return k % 3 === 0 ? trim(it) : [{ op: "set", path: [...p, "colorGrade", "saturation"], value: 1.25 }];
  if (it.type === "text") return [{ op: "set", path: [...p, "fontSize"], value: 96 }];
  if (it.type === "caption") return [{ op: "set", path: [...p, "captionColor"], value: "#ffee00" }];
  if (it.type === "audio") return [{ op: "set", path: [...p, "volume"], value: 0.7 }];
  if (it.type === "adjustment") return [{ op: "set", path: [...p, "colorGrading", "exposure"], value: 0.1 }];
  return [{ op: "set", path: [...p, "name"], value: "Edited" }];
};
const agentEdit = (it: Item): Op[] => {
  const p = ["timelineItems", it.id];
  if (it.type === "video") return [{ op: "set", path: [...p, "transform", "x"], value: 40 }];
  if (it.type === "text") return [{ op: "set", path: [...p, "textContent"], value: "Rewritten by the agent" }];
  if (it.type === "caption") return [{ op: "set", path: [...p, "captionSegments", it.captionSegments[0].id, "text"], value: "fixed words" }];
  if (it.type === "audio") return [{ op: "set", path: [...p, "audioFadeIn"], value: { duration: 0.5, easing: "linear" } }];
  if (it.type === "adjustment") return [{ op: "set", path: [...p, "lutIntensity"], value: 0.5 }];
  return [{ op: "set", path: [...p, "name"], value: "Agent" }];
};

const rows: Record<string, unknown>[] = [];
function row<T>(n: number, label: string, fn: (x: T) => unknown, opts: MeasureOpts<T> = {}, extra: string | ((m: Measured) => string) = ""): Measured {
  const load: Load = loadGate();
  const m = measure(fn, opts);
  const note = typeof extra === "function" ? extra(m) : extra;
  rows.push({ n, label, ...m, load, extra: note });
  console.log(`| ${n} | ${label} | ${fmtMs(m.median)} | ${m.runs.map(fmtMs).join(" ")} | ${m.reps} | ${load.before}${load.waitedS ? `→${load.after} (waited ${load.waitedS} s)` : ""} | ${note} |`);
  return m;
}

console.log(`machine: ${JSON.stringify(out.machine)}  runs=${RUNS}\n`);
console.log("| items | measurement | median ms | every run (ms per call) | calls/run | load 1-min before | notes |\n|---|---|---|---|---|---|---|");

for (const N of sizes) {
  const base = withKeys(genDoc(N, 42));
  const baseJSON = JSON.stringify(base);
  const r = rng(N);
  const items = base.timelineItems as Item[];
  const video = items.filter((i) => i.type === "video");
  const text = items.filter((i) => i.type === "text");
  const k10 = Math.round(N / 10);
  const ops1 = trim(video[Math.floor(video.length / 2)]!);
  const ours1 = E.apply(E.fork(base, S), ops1, S);
  const theirs1 = E.apply(E.fork(base, S), agentEdit(text[Math.floor(text.length / 3)]!), S);
  const ops10o = sample(r, items, k10).flatMap((it, k) => humanEdit(it, k));
  const ops10t = sample(r, items, k10).flatMap((it) => agentEdit(it));
  const ours10 = E.apply(E.fork(base, S), ops10o, S);
  const theirs10 = E.apply(E.fork(base, S), ops10t, S);
  const J = { ours1: JSON.stringify(ours1), theirs1: JSON.stringify(theirs1), ours10: JSON.stringify(ours10), theirs10: JSON.stringify(theirs10) };
  const H = { base: hostShared(base), ours1: hostShared(ours1), theirs1: hostShared(theirs1), ours10: hostShared(ours10), theirs10: hostShared(theirs10) };
  const HJ = { base: JSON.stringify(H.base), ours1: JSON.stringify(H.ours1), theirs1: JSON.stringify(H.theirs1), ours10: JSON.stringify(H.ours10), theirs10: JSON.stringify(H.theirs10) };
  E.diff(base, base, S); // build base's id index once, as a long-lived store would have

  row(N, "diff, 1-item edit (shared records)", () => E.diff(base, ours1, S), {}, `${E.diff(base, ours1, S).length} ops`);
  row(N, "diff, 1-item edit (both parsed from JSON)", (x: Doc[]) => E.diff(x[0]!, x[1]!, S), { setup: () => [P(baseJSON), P(J.ours1)] });
  row(N, `diff, 10% edit = ${k10} items (shared)`, () => E.diff(base, ours10, S), {}, `${ops10o.length} ops`);
  row(N, "diff, 10% edit (both parsed)", (x: Doc[]) => E.diff(x[0]!, x[1]!, S), { setup: () => [P(baseJSON), P(J.ours10)] });
  const live = E.fork(base, S);
  E.apply(live, ops1, S);
  row(N, "apply one change (2 set ops), in place", () => E.apply(live, ops1, S));
  row(N, `apply 10% change (${ops10o.length} ops), in place`, () => E.apply(live, ops10o, S));
  row(N, "fork (owned copy: arrays + id index)", () => E.fork(base, S));
  const m1 = E.merge3(base, ours1, theirs1, S);
  const c1 = rn(slice(H.base), slice(H.ours1), slice(H.theirs1), { prefer: "file" });
  row(N, "merge3, 1 edit per side (shared)", () => E.merge3(base, ours1, theirs1, S), {}, `${m1.conflicts.length} cards`);
  row(N, "Cardboard rn, 1 edit per side (shared)", () => rn(slice(H.base), slice(H.ours1), slice(H.theirs1), { prefer: "file" }), {}, `${c1.conflicts.length} conflicts`);
  row(N, "merge3, 1 edit per side (parsed)", (x: Doc[]) => E.merge3(x[0]!, x[1]!, x[2]!, S), { setup: () => [P(baseJSON), P(J.ours1), P(J.theirs1)] });
  row(N, "Cardboard rn, 1 edit per side (parsed)", (x: HostDoc[]) => rn(slice(x[0]!), slice(x[1]!), slice(x[2]!), { prefer: "file" }), { setup: () => [P(HJ.base), P(HJ.ours1), P(HJ.theirs1)] });
  const m10 = E.merge3(base, ours10, theirs10, S);
  const c10 = rn(slice(H.base), slice(H.ours10), slice(H.theirs10), { prefer: "file" });
  row(N, "merge3, 10% edited per side (shared)", () => E.merge3(base, ours10, theirs10, S), {}, `${m10.conflicts.length} cards, ${m10.ops.length} ops`);
  row(N, "Cardboard rn, 10% per side (shared)", () => rn(slice(H.base), slice(H.ours10), slice(H.theirs10), { prefer: "file" }), {}, `${c10.conflicts.length} item conflicts`);
  row(N, "merge3, 10% per side (parsed)", (x: Doc[]) => E.merge3(x[0]!, x[1]!, x[2]!, S), { setup: () => [P(baseJSON), P(J.ours10), P(J.theirs10)] });
  row(N, "Cardboard rn, 10% per side (parsed)", (x: HostDoc[]) => rn(slice(x[0]!), slice(x[1]!), slice(x[2]!), { prefer: "file" }), { setup: () => [P(HJ.base), P(HJ.ours10), P(HJ.theirs10)] });
  // same result on what both keep (sanity, not timing)
  const all = E.resolve(m10, m10.conflicts.map(() => "theirs" as const));
  const sameish = JSON.stringify((toHost(all).timelineItems as Item[]).map((i) => JSON.stringify(i)).sort()) === JSON.stringify((c10.doc.timelineItems as Item[]).map((i) => JSON.stringify(i)).sort());

  // --- sequencer: the client declares (paths, reads, spans), the server checks overlap + validates
  const sq = sequencer.createLocalSequencer(base, S);
  const change = (id: string, baseSeq: number, ops: Op[], decl: E.Declaration, author: E.Actor) => ({ id, hash: "", author, branchId: "main", base: { seq: baseSeq, pending: [] }, ops, intent: null, kinds: null, policy: "merge" as const, at: 0, ...decl });
  const human: E.Actor = { kind: "human", id: "human" },
    agent: E.Actor = { kind: "agent", id: "a" };
  const touched = new Set<string>();
  for (let i = 0; i < 50; i++) {
    const it = pick(r, items);
    touched.add(it.id);
    const ops = humanEdit(it, 1);
    sq.push(change(`warm.${i}`, sq.seq, ops, E.declare(S, sq.head, ops), human));
  }
  let cid = 0;
  const fresh = () => {
    let it;
    do it = pick(r, items);
    while (touched.has(it.id));
    return it;
  };
  const decl = (ops: Op[]) => E.declare(S, base, ops);
  // accepted pushes over the row's calls (callsOf), from the log's growth: the verdict each row is meant to time
  const accepted = (seq0: number) => (m: Measured) => `accepted ${sq.seq - seq0}/${callsOf(m)}`;
  row(N, "client: declare a change (paths, reads, spans)", (o: Op[]) => E.declare(S, base, o), { setup: () => humanEdit(fresh(), 1) });
  let seq0 = sq.seq;
  row(N, "sequencer push, accepted (fast-forward)", (c: ReturnType<typeof change>) => sq.push(c), { setup: () => { const ops = humanEdit(fresh(), 1); return change(`ff.${cid++}`, sq.seq, ops, decl(ops), agent); } }, accepted(seq0));
  seq0 = sq.seq;
  row(N, "sequencer push, accepted (20 behind, disjoint)", (c: ReturnType<typeof change>) => sq.push(c), { setup: () => { const ops = agentEdit(fresh()); return change(`nf.${cid++}`, sq.seq - 20, ops, decl(ops), agent); } }, accepted(seq0));
  const recent = () => sq.log.at(-5)!.ops[0]!.path;
  seq0 = sq.seq;
  row(N, "sequencer push, rejected (20 behind, same leaf)", (c: ReturnType<typeof change>) => sq.push(c), { setup: () => { const ops: Op[] = [{ op: "set", path: [...recent()], value: 1 }]; return change(`rj.${cid++}`, sq.seq - 20, ops, decl(ops), agent); } }, (m) => `returns the 20 missing changes; ${accepted(seq0)(m)}`);

  // --- bytes: the stored change row (what the store / the DO keeps per change)
  const rep = History.create(S, base);
  const changeRow = (ops: Op[], intent: Intent | null = null) => {
    const d = E.declare(S, base, ops, intent);
    return JSON.stringify({ id: `${"3f9a6c1e6b1d4c559a510d8f"}.1234`, hash: "9".repeat(64), author: { kind: "agent", id: "director", chat: "c1", turn: "t3", agentId: "a7f3" }, branchId: "1a2b3c4d5e6f7a8b", base: { seq: 1234, pending: [] }, ops, intent, ...d, policy: "merge", at: 1793375738452 });
  };
  const mainId = (base.tracks as Item[]).find((t) => t.name === "Main")!.id;
  const midMain = video.filter((v) => v.trackId === mainId).sort((a, b) => a.startTime - b.startTime)[Math.floor(video.filter((v) => v.trackId === mainId).length / 2)]!;
  const cut = rippleCut(base, midMain.startTime, midMain.endTime);
  const ripple = E.diff(base, cut, S);
  const rippleIntent: Intent = { maps: Object.fromEntries((base.tracks as Item[]).map((t) => [t.id, E.rippleDelete(midMain.startTime, r3(midMain.endTime - midMain.startTime))])) };
  const tItem = { ...text[0], id: "8c0d5d2e-1f7a-4b5e-9b2b-5a7c3d1e9f00", startTime: 12, endTime: 15, textContent: "New title" };
  const sizesRow = {
    "trim (2 sets)": changeRow(ops1),
    "grade tweak (1 nested set)": changeRow(humanEdit(video[1]!, 1)),
    "text edit": changeRow(agentEdit(text[0]!)),
    "add a text item": changeRow([{ op: "insert", path: ["timelineItems", tItem.id], value: tItem }]),
    "move item to another track": changeRow([{ op: "set", path: ["timelineItems", video[2]!.id, "trackId"], value: (base.tracks as Item[])[0]!.id }]),
    [`global ripple cut mid-timeline (${ripple.length} ops + recorded intent)`]: changeRow(ripple, rippleIntent),
    [`10% bulk edit (${ops10o.length} ops)`]: changeRow(ops10o),
  };
  const snap = E.snapshot(base, S);
  const revs = JSON.stringify({ rev: 1793375738452, at: 1793375738452, doc: slice(toHost(base)) });
  out.sizesOnly[N] = {
    change: Object.fromEntries(Object.entries(sizesRow).map(([k, v]) => [k, { json: bytes(v), gzip: gz(v) }])),
    snapshotCanonical: { json: bytes(snap), gzip: gz(snap) },
    cardboardRevsPerWrite: { json: bytes(revs), gzip: gz(revs) },
  };
  row(N, "hash all records + doc, cold (fresh parse)", (d: Doc) => E.hashDoc(d, S), { setup: () => P(baseJSON) }, `${items.length + (base.tracks as Item[]).length} records`);
  row(N, "hash doc after a 1-item edit (cache warm)", (d: Doc) => E.hashDoc(d, S), { setup: () => { const d = P(baseJSON); E.hashDoc(d, S); return E.apply(E.fork(d, S), ops1, S); } });
  row(N, "canonical snapshot (serialize)", () => E.snapshot(base, S));
  out.sizes[N] = { cards1: m1.conflicts.length, cards10: m10.conflicts.length, cardboardConflicts10: c10.conflicts.length, sameResultWhenTheirsWins: sameish };
  void rep;
}

// --- shot diff on a 30-minute timeline
{
  const a = withKeys(genDoc(0, 11, { seconds: 1800 }));
  const aItems = a.timelineItems as Item[];
  const main = (a.tracks as Item[]).find((t) => t.name === "Main")!.id;
  const cut = aItems.filter((i) => i.trackId === main && i.startTime > 900).sort((x, y) => x.startTime - y.startTime)[0]!;
  let b: Doc = rippleCut(a, cut.startTime, cut.endTime);
  const g = (b.timelineItems as Item[]).find((i) => i.trackId === main && i.startTime > 1200)!;
  b = { ...b, timelineItems: (b.timelineItems as Item[]).map((i) => (i === g ? { ...i, colorGrade: { ...(i.colorGrade ?? {}), saturation: 0.3 } } : i)) };
  const res = E.shotDiff(a, b, S);
  console.log(`\n30-min timeline: ${aItems.length} items; cut ${cut.startTime}–${cut.endTime}; grade change on clip at ${g.startTime}`);
  row(aItems.length, "shot diff, 30-min timeline (segment both + align), repeat call", () => E.shotDiff(a, b, S), {}, `${res.shotsA}/${res.shotsB} shots, ${res.changed.length} changed ranges, ${res.shifted} shifted-unchanged`);
  row(aItems.length, "segment one 30-min timeline into shots", () => E.shots(a, S), {}, "repeat call: serializations cached");
  row(aItems.length, "shot diff, 30-min, first call on freshly parsed versions", (x: Doc[]) => E.shotDiff(x[0]!, x[1]!, S), { setup: () => [JSON.parse(JSON.stringify(a)), JSON.parse(JSON.stringify(b))], minMs: 0 }, "cold");
  out.shots = { items: aItems.length, cut: [cut.startTime, cut.endTime], graded: [g.startTime, g.endTime], ...res };
}

// --- module sizes, the prototype's method (esbuild --minify, ESM, platform node; gzip level 6): the engine alone, the
// core (engine + history: the P4 budget's entry, as scripts/size.mjs bundles it), and the .cbproj zip helpers
const CARTON = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const esb = join(CARTON, "node_modules", ".bin", "esbuild");
const size = (entry: string, files: string[]) => {
  const min = execFileSync(esb, ["--bundle", "--minify", "--format=esm", "--platform=node", "--external:node:*", "--loader=ts", "--sourcefile=size-entry.ts"], { input: entry, cwd: CARTON, encoding: "utf8" });
  const src = files.map((f) => readFileSync(join(CARTON, f), "utf8")).join("");
  return { source: bytes(src), sourceGzip: gz(src), minified: bytes(min), minifiedGzip: gz(min) };
};
const ENGINE = "packages/core/src/engine/index.ts",
  HISTORY = "packages/core/src/history/index.ts",
  CBPROJ = "packages/conformance/src/engine/cbproj.ts";
const srcFiles = (dir: string) => (execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", dir], { cwd: CARTON, encoding: "utf8" }).trim().split("\n").filter((f) => f.endsWith(".ts")));
out.engineSize = {
  esbuild: execFileSync(esb, ["--version"], { encoding: "utf8" }).trim(),
  engine: size(`export * from "./${ENGINE}";`, srcFiles("packages/core/src/engine")),
  core: size(`export * from "./${ENGINE}"; export * from "./${HISTORY}";`, [...srcFiles("packages/core/src/engine"), ...srcFiles("packages/core/src/history"), ...srcFiles("packages/core/src/sequencer")]),
  cbproj: size(`export * from "./${CBPROJ}";`, [CBPROJ]),
};

console.log("\nBytes:");
for (const [N, s] of Object.entries(out.sizesOnly) as [string, any][]) {
  console.log(`\n${N} items: canonical snapshot ${fmtB(s.snapshotCanonical.json)} (gzip ${fmtB(s.snapshotCanonical.gzip)}); Cardboard .revs entry per write ${fmtB(s.cardboardRevsPerWrite.json)} (gzip ${fmtB(s.cardboardRevsPerWrite.gzip)})`);
  for (const [k, v] of Object.entries(s.change) as [string, any][]) console.log(`  change row: ${k}: ${fmtB(v.json)} JSON, ${fmtB(v.gzip)} gzip`);
}
for (const [k, v] of Object.entries(out.engineSize) as [string, any][]) if (typeof v === "object") console.log(`${k}: ${fmtB(v.source)} source (${fmtB(v.sourceGzip)} gzip); minified ${fmtB(v.minified)}, ${fmtB(v.minifiedGzip)} gzip`);
console.log(`esbuild ${out.engineSize.esbuild}`);
console.log("sanity:", JSON.stringify(out.sizes));
out.rows = rows;
out.finished = new Date().toISOString();
const file = process.env.OUT || join(SCRATCH, "raw", `bench-carton${SIZES.length ? "-" + sizes.join("-") : ""}${process.env.TAG ? "-" + process.env.TAG : ""}.json`);
mkdirSync(dirname(file), { recursive: true });
writeFileSync(file, JSON.stringify(out, null, 1));
