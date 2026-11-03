// Carton UX v2 (N0) at a long history: Find's index (built lazily, then kept), its queries, landmarks, bring-back's
// choices and a bring-back, on a 12,000-version Cardboard project in a real carton.db (store-sqlite).
//
//   node --expose-gc carton/bench/core/recall.ts [versions=12000] [scratch dir]
//
// Phases: 1) make the project (untimed: 12k commits through Carton.commit, as the app's saves are); 2) close it, open
// it again in this process as the app would after a restart; 3) time, each with every run printed and the median:
//   - load: the whole history read in (core's own background load, before this feature; reported apart);
//   - build: the first `find("")` (the index's one forward walk over every row), RUNS fresh opens;
//   - query: `find(text)` on the kept index, per text, RUNS × 20 calls;
//   - grow: one more version saved, then `find` (the index reads the new row only), RUNS times;
//   - landmarks(), bringBackChoices(an old version), restoreClip(an old version);
//   - heap: the index's size (heapUsed after gc, before and after the build).
// The load gate and the CPU lock are the caller's (run it under `flock /tmp/gfv-race/cpu.lock`); `uptime` is printed.
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { execSync } from "node:child_process";
import { performance } from "node:perf_hooks";
import { Carton, POS, type Actor, type Doc, type Op, type Rec } from "../../packages/core/src/index.ts";
import { cardboardAdapter } from "../../packages/cardboard/src/index.ts";
import { openSqliteStore } from "../../packages/store-sqlite/src/index.ts";

const N = Number(process.argv[2] ?? 12000);
const DIR = process.argv[3] ?? "/home/ubuntu/gfv-scratch/carton/ux2-n0/bench";
const RUNS = Number(process.env.RUNS ?? 7);
const gc = (globalThis as { gc?: () => void }).gc ?? (() => {});
const median = (xs: number[]) => { const s = [...xs].sort((a, b) => a - b); return s.length % 2 ? s[(s.length - 1) / 2]! : (s[s.length / 2 - 1]! + s[s.length / 2]!) / 2; };
const fmt = (xs: number[]) => `median ${median(xs).toFixed(2)} ms  runs [${xs.map((x) => x.toFixed(2)).join(", ")}]`;
const load = () => execSync("uptime").toString().trim();

const person: Actor = { kind: "human", id: "person" };
const leo: Actor = { kind: "human", id: "leo", name: "Leo" };
const turn = (k: number): Actor => ({ kind: "agent", id: `director/chat-1/turn-${k}`, name: "Director", chat: "chat-1", turn: `turn-${k}` });
const CLIPS = 40, TITLES = 10;
const SHOT = ["Intro", "Interview A", "Interview B", "B-roll pier", "Drone shot", "Logo", "Outro", "Founder", "Street", "Office"];
function doc0(): Doc {
  const items: Rec[] = [];
  for (let i = 0; i < CLIPS; i++) items.push({ id: `v${i}`, type: "video", trackId: "t-v", mediaItemId: "m-clip", name: `${SHOT[i % SHOT.length]} ${Math.floor(i / SHOT.length) + 1}`, startTime: i * 3, endTime: i * 3 + 3, trimStart: 0, trimEnd: 3, playbackSpeed: 1 });
  for (let i = 0; i < TITLES; i++) items.push({ id: `w${i}`, type: "text", trackId: "t-t", mediaItemId: `x${i}`, textContent: `Title ${i} summer sale`, startTime: i * 10, endTime: i * 10 + 3, trimStart: 0, trimEnd: 3, playbackSpeed: 1, fontSize: 100 });
  items.push({ id: "cap", type: "caption", trackId: "t-c", startTime: 0, endTime: 120, trimStart: 0, trimEnd: 120, playbackSpeed: 1, captionSegments: Array.from({ length: 20 }, (_, k) => ({ id: `s${k}`, start: k * 6, end: k * 6 + 5, text: `we cut costs in half part ${k}` })) });
  const media: Rec[] = [{ id: "m-clip", data: { fileName: "clip.mp4", type: "video" } }, ...Array.from({ length: TITLES }, (_, i) => ({ id: `x${i}`, data: { type: "text", content: `Title ${i} summer sale` } }))];
  return { name: "Bench", aspectRatio: "16:9", tracks: [{ id: "t-v", type: "video", name: "Video 1", [POS]: "a" }, { id: "t-t", type: "video", name: "Text 1", [POS]: "b" }, { id: "t-c", type: "caption", name: "Captions", [POS]: "c" }], timelineItems: items, media } as unknown as Doc;
}
const set = (id: string, f: string, v: unknown): Op => ({ op: "set", path: ["timelineItems", id, f], value: v });

async function make(file: string): Promise<void> {
  rmSync(DIR, { recursive: true, force: true });
  mkdirSync(DIR, { recursive: true });
  const store = await openSqliteStore(file);
  const c = await Carton.open({ adapter: cardboardAdapter, store, init: { doc: doc0(), cutName: "Main cut" }, actor: person });
  const t0 = performance.now();
  let k = 0;
  for (let i = 1; i <= N; i++) {
    const a = i % 50 < 5 ? turn(Math.floor(i / 50)) : i % 7 === 0 ? leo : person;
    const v = `v${i % CLIPS}`, w = `w${i % TITLES}`;
    const r = i % 10;
    const ops: Op[] = r < 4 ? [set(v, "endTime", (i % CLIPS) * 3 + 2 + (i % 3) * 0.25), set(v, "trimEnd", 2 + (i % 3) * 0.25)]
      : r < 6 ? [set(v, "fontSize", 90 + (i % 30))]
      : r < 8 ? [set(w, "textContent", `Title ${i % TITLES} take ${i}`), { op: "set", path: ["media", `x${i % TITLES}`, "data", "content"], value: `Title ${i % TITLES} take ${i}` }]
      : r < 9 ? [{ op: "set", path: ["timelineItems", "cap", "captionSegments", `s${i % 20}`, "text"], value: `caption ${i} in half` }]
      : [set(v, "name", `${SHOT[i % SHOT.length]} take ${i}`)];
    await c.commit({ ops, author: a });
    if (i % 300 === 0) await c.name({ branchId: c.cut, seq: i, pending: [] } as never, `Review ${++k}`);
    if (i % 1000 === 0) await c.mark("exported", { label: "1080p" });
    if (i % 4000 === 0) await c.restore(`${c.cut}@${i - 1500}`, { author: person });
  }
  console.log(`made ${N} versions in ${((performance.now() - t0) / 1000).toFixed(1)} s (untimed setup)`);
  await c.close();
  await store.close();
}

async function main() {
  const file = join(DIR, "carton.db");
  await make(file);
  console.log(`load before: ${load()}`);
  const open = async () => {
    const store = await openSqliteStore(file);
    const c = await Carton.open({ adapter: cardboardAdapter, store, actor: person });
    return { c, close: async () => { await c.close(); await store.close(); } };
  };
  // load (core's own) and build (the index), each on a fresh open
  const loads: number[] = [], builds: number[] = [];
  let heap = 0, versions = 0;
  for (let r = 0; r < RUNS; r++) {
    const o = await open();
    let t = performance.now();
    await o.c.log({ limit: 1 });
    loads.push(performance.now() - t);
    gc();
    const h0 = process.memoryUsage().heapUsed;
    t = performance.now();
    const f = await o.c.find("");
    builds.push(performance.now() - t);
    gc();
    heap = process.memoryUsage().heapUsed - h0;
    versions = f.versions;
    await o.close();
  }
  console.log(`versions indexed: ${versions}`);
  console.log(`load (whole history read in, core's own, not this feature): ${fmt(loads)}`);
  console.log(`build (first find: the index's walk over ${N} rows):         ${fmt(builds)}`);
  console.log(`index heap after gc: ${(heap / 1048576).toFixed(1)} MiB (last run)`);
  const o = await open();
  await o.c.find("");
  for (const q of ["intro", "intr cap", "summer", "leo", "half", "review 7", "exported", "zzz nothing"]) {
    const runs: number[] = [];
    let total = 0;
    for (let r = 0; r < RUNS; r++) {
      const t = performance.now();
      for (let k = 0; k < 20; k++) total = (await o.c.find(q)).total;
      runs.push((performance.now() - t) / 20);
    }
    console.log(`query ${JSON.stringify(q).padEnd(14)} ${String(total).padStart(6)} matches  ${fmt(runs)}`);
  }
  const grows: number[] = [], saves: number[] = [];
  for (let r = 0; r < RUNS; r++) {
    let t = performance.now();
    await o.c.commit({ ops: [set("v1", "endTime", 4 + r * 0.01)], author: person });
    saves.push(performance.now() - t);
    t = performance.now();
    await o.c.find("intro");
    grows.push(performance.now() - t);
  }
  console.log(`save (one version; the index isn't touched):            ${fmt(saves)}`);
  console.log(`grow (find after one more version: reads that row only): ${fmt(grows)}`);
  const lm: number[] = [];
  let nl = 0;
  for (let r = 0; r < RUNS; r++) { const t = performance.now(); nl = (await o.c.landmarks({ limit: 5000 })).length; lm.push(performance.now() - t); }
  console.log(`landmarks() (${nl}):                                       ${fmt(lm)}`);
  const ch: number[] = [];
  for (let r = 0; r < RUNS; r++) { const t = performance.now(); await o.c.bringBackChoices(`${o.c.cut}@${Math.floor(N / 3)}`); ch.push(performance.now() - t); }
  console.log(`bringBackChoices(@${Math.floor(N / 3)}):                              ${fmt(ch)}`);
  const bb: number[] = [];
  for (let r = 0; r < RUNS; r++) { const t = performance.now(); await o.c.restoreClip(`${o.c.cut}@${Math.floor(N / 3) + r}`, "timelineItems/v3"); bb.push(performance.now() - t); }
  console.log(`restoreClip(an old version):                             ${fmt(bb)}`);
  await o.close();
  console.log(`load after: ${load()}`);
}
await main();
