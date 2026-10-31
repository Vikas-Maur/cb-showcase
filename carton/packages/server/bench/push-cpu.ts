// CPU per push, @carton/server against the P5 prototype it ports (proofs/do-seq/src/seq-core.mjs), on the prototype's
// own scenarios: do-seq's generators (gen.mjs, tails.mjs) build a seeded room (8 tracks × 60 clips), a fixed tail of
// N filler changes after the base, and pools of measured pushes with a known outcome. Both sequencers run in this
// process on node:sqlite in memory, cell by cell, alternating which goes first; every accepted push is reverted
// (timed apart) so each push sees the same tail, as do-seq/cpu.mjs did.
//
// The timed region is what each host would run per message: JSON.parse of the push text, the sequencer, and
// JSON.stringify of every message it sends back (do-seq: its reply and broadcast strings; Carton: conn.send's messages).
// Carton's push goes through `await sequencer.handle(...)` (its per-project queue), so a microtask hop is included.
// Bodies are converted to Carton's change shape outside the timed region: spans as objects, base {seq, pending},
// the `#time` group path a trim declares (Carton's rule requires it), and a remap's recorded maps.
//
// Tails stop at 100: Carton rejects a push more than K = 100 behind ("behind", no scan), so tail 1,000 has no
// comparable cell. Usage (inside the CPU lock):
//   flock /tmp/gfv-race/cpu.lock node carton/packages/server/bench/push-cpu.ts <run#> [pushes] [cellFilter]
import { writeFileSync, mkdirSync } from "node:fs";
import { loadavg } from "node:os";
import { createSequencer, type HostConnection } from "../src/index.ts";
import { sqliteStorage } from "../../conformance/src/system/sqlite.ts";
import type { Change, TimelineConfig } from "@carton/core";

const P5 = "/home/ubuntu/.t3/projects/cardboard-showcase/_inspect/git-for-video/proofs/do-seq";
const { Room } = await import(`${P5}/src/seq-core.mjs`);
const { nodeDb } = await import(`${P5}/node-db.mjs`);
const { Replica, KINDS } = await import(`${P5}/gen.mjs`);
const { seedChange, tailBodies, measuredBodies } = await import(`${P5}/tails.mjs`);

const run = process.argv[2] ?? "0";
const N = Number(process.argv[3] ?? 3000), WARM = 300, POOL = 200;
const filter = process.argv[4] ? new RegExp(process.argv[4]) : null;
const TL: TimelineConfig = { collection: "items", lanes: "tracks", lane: "trackId", start: "startTime", end: "endTime", source: "trimStart", sourceEnd: "trimEnd", speed: "playbackSpeed" };
const TIME = new Set(["startTime", "endTime", "trimStart", "trimEnd", "playbackSpeed"]);

interface Body { ops: Change["ops"]; paths: string[]; reads: string[]; spans: [string, number, number | null][]; policy: "merge" | "lww"; intent?: { tracks: string[] } }
/** A do-seq wrapped change in Carton's shape, as Carton's client would declare it. */
// Carton's branch starts from the seeded state as its doc0 (seq 0), where do-seq pushes it as seq 1: bases shift by one,
// so every push is exactly as far behind head as in do-seq.
function toCarton(w: Body & { id: string; hash: string; author: unknown; base: number }, branchId: string): Change {
  const groups = new Set<string>();
  for (const op of w.ops) if (op.path.length === 3 && TIME.has(String(op.path[2]))) groups.add(`items/${op.path[1]}/#time`);
  return {
    id: w.id, hash: w.hash, author: w.author as Change["author"], branchId, base: { seq: w.base - 1, pending: [] }, ops: w.ops,
    intent: w.intent ? { maps: Object.fromEntries(w.intent.tracks.map((t) => [t, [{ d: [[0, 1]], i: [] }]])) } as Change["intent"] : null,
    kinds: null, policy: w.policy, at: 0, paths: [...w.paths, ...groups], reads: w.reads,
    spans: w.spans.map(([track, lo, hi]) => ({ track, lo, hi })), trackOrder: [],
  };
}

const pct = (s: Float64Array, p: number) => s[Math.min(s.length - 1, Math.floor(p * s.length))]!;
const summary = (a: Float64Array) => {
  const s = Float64Array.from(a).sort();
  return { mean: +(s.reduce((x, y) => x + y, 0) / s.length).toFixed(1), p50: pct(s, 0.5), p90: pct(s, 0.9), p99: pct(s, 0.99) };
};
const cpuNow = () => process.cpuUsage();

const cells: { kind: string; outcome: string; tail: number }[] = [];
for (const kind of KINDS as string[]) for (const tail of [0, 10, 100]) cells.push({ kind, outcome: "accepted", tail });
for (const kind of KINDS as string[]) for (const tail of [1, 10, 100]) cells.push({ kind, outcome: "rejected", tail });
for (const tail of [10, 100]) cells.push({ kind: "style", outcome: "lww", tail });

async function measureP5(cell: { kind: string; outcome: string; tail: number }, built: Built) {
  const db = nodeDb(":memory:"), room = new Room(db);
  room.handle(JSON.stringify({ type: "push", changes: [built.seed] }));
  for (let i = 0; i < built.tail.length; i += 100) room.handle(JSON.stringify({ type: "push", changes: built.tail.slice(i, i + 100) }));
  const texts = built.pool.map((c) => JSON.stringify({ type: "push", changes: [c] }));
  const cpu = new Float64Array(N);
  const expect = cell.outcome === "rejected" ? "reject" : "ack";
  for (let i = -WARM; i < N; i++) {
    const text = texts[(i + WARM) % texts.length]!;
    const c0 = cpuNow();
    const out = room.handle(text);
    const c = process.cpuUsage(c0);
    if (i >= 0) cpu[i] = c.user + c.system;
    const res = JSON.parse(out.replies[0]);
    if (res.type !== expect) throw new Error(`p5 ${JSON.stringify(cell)}: ${out.replies[0].slice(0, 200)}`);
    if (res.type === "ack") room.seq.benchRevert(JSON.parse(text).changes[0], res.seq);
  }
  db.raw.close();
  return summary(cpu);
}

async function cartonRoom(cell: { kind: string; outcome: string; tail: number }, built: Built) {
  const storage = sqliteStorage();
  const seq = createSequencer({ storage, auth: { kind: "bench", async verify() { return null; } }, timeline: TL });
  const B = "main";
  const sent: string[] = [];
  const conn: HostConnection = { id: "bench", auth: { account: "a", credential: "a/1", role: "editor", projectId: "p", expires: Number.MAX_SAFE_INTEGER }, send: (m) => void sent.push(JSON.stringify(m)) };
  await seq.createBranch({ id: B, name: "main", forkOf: null, owner: "a", kind: "main", sequencer: { kind: "server", since: 0 } }, { doc0: built.doc0 });
  await seq.handle(conn, { type: "hello", branchId: B, have: 0, pending: [], rids: [], schemaVersion: 1 });
  const push = async (changes: Change[], epoch: number) => {
    sent.length = 0;
    await seq.handle(conn, { type: "push", branchId: B, epoch, changes });
  };
  // each filler was made on the state after the previous one: its base is the head it saw (do-seq let a replica's own
  // earlier changes skip the overlap test by rid prefix; Carton needs the causal past stated, P5 finding 4)
  for (let i = 0; i < built.tail.length; i++) {
    const c = toCarton(built.tail[i]!, B);
    await push([{ ...c, base: { seq: i, pending: [] } }], 2 + i);
  }
  if (seq.tables.head(B) !== built.tail.length) throw new Error(`carton ${JSON.stringify(cell)}: head ${seq.tables.head(B)} (${sent.at(-1)?.slice(0, 200)})`);
  return { storage, seq, conn, sent, B };
}

/**
 * The pool entries Carton gives the cell's outcome too. do-seq's generator classifies with P5's span rule (any two
 * intersecting spans conflict); Carton's v11 rule lets plain trims of different clips through, so a few "rejected"
 * trims are accepted by Carton. Both sequencers are then timed on the entries they agree on.
 */
async function agreeing(cell: { kind: string; outcome: string; tail: number }, built: Built): Promise<Built["pool"]> {
  const { storage, seq, conn, sent, B } = await cartonRoom(cell, built);
  const expect = cell.outcome === "rejected" ? "reject" : "ack";
  const keep: Built["pool"] = [];
  let epoch = 1000;
  for (const c of built.pool) {
    sent.length = 0;
    conn.state!.deadEpoch = -1;
    await seq.handle(conn, { type: "push", branchId: B, epoch: ++epoch, changes: [toCarton(c, B)] });
    const answer = JSON.parse(sent.at(-1)!);
    if (answer.type === expect && (cell.outcome !== "lww" || sent.some((x) => x.includes('"overwritten"')))) keep.push(c);
    if (answer.type === "ack") seq.tables.benchRevert(B, answer.seq);
  }
  storage.close();
  return keep;
}

async function measureCarton(cell: { kind: string; outcome: string; tail: number }, built: Built) {
  const { storage, seq, conn, sent, B } = await cartonRoom(cell, built);
  const texts = built.pool.map((c) => JSON.stringify({ type: "push", branchId: B, epoch: 0, changes: [toCarton(c, B)] }));
  const cpu = new Float64Array(N);
  const expect = cell.outcome === "rejected" ? "reject" : "ack";
  let epoch = 10_000;
  for (let i = -WARM; i < N; i++) {
    const text = texts[(i + WARM) % texts.length]!;
    sent.length = 0;
    conn.state!.deadEpoch = -1; // a rejected push kills its epoch; every measured push starts a fresh one
    const c0 = cpuNow();
    const msg = JSON.parse(text);
    msg.epoch = ++epoch;
    await seq.handle(conn, msg);
    const c = process.cpuUsage(c0);
    if (i >= 0) cpu[i] = c.user + c.system;
    const answer = JSON.parse(sent.at(-1)!);
    if (answer.type !== expect || (cell.outcome === "lww" && !sent.some((s) => s.includes('"overwritten"')))) throw new Error(`carton ${JSON.stringify(cell)}: ${sent.join(" | ").slice(0, 400)}`);
    if (answer.type === "ack") seq.tables.benchRevert(B, answer.seq);
  }
  storage.close();
  return summary(cpu);
}

interface Built { doc0: Record<string, unknown>; seed: Body & { id: string; hash: string; author: unknown; base: number }; tail: (Body & { id: string; hash: string; author: unknown; base: number })[]; pool: (Body & { id: string; hash: string; author: unknown; base: number })[] }
function build(cell: { kind: string; outcome: string; tail: number }): Built {
  const { view, change } = seedChange(1);
  const F = new Replica("filler"), M = new Replica("measured", "agent");
  const tail = tailBodies(view, cell.tail, "mix", 7 + cell.tail, cell.outcome === "accepted" ? null : cell.outcome === "lww" ? "lww" : cell.kind);
  const pool = measuredBodies(view, cell.kind, cell.outcome, tail, POOL, 99 + cell.tail);
  const doc0 = { tracks: [...view.tracks.values()], items: [...view.items.values()] };
  return { doc0, seed: change, tail: tail.map((b: Body) => F.wrap(b, 1)), pool: pool.map((b: Body) => M.wrap(b, 1)) };
}

const results = [];
let flip = Number(run) % 2;
for (const cell of cells) {
  const name = `${cell.kind}/${cell.outcome}/tail${cell.tail}`;
  if (filter && !filter.test(name)) continue;
  const built = build(cell);
  const offered = built.pool.length;
  built.pool = await agreeing(cell, built);
  if (built.pool.length < 10) {
    console.log(`${name}: only ${built.pool.length} of ${offered} pushes have the same outcome in both rules; skipped`);
    continue;
  }
  const load0 = loadavg()[0]!;
  const order = flip++ % 2 ? ["carton", "p5"] : ["p5", "carton"];
  const r: Record<string, ReturnType<typeof summary>> = {};
  const only = process.env.ONLY; // profiling one side: ONLY=carton or ONLY=p5 (the other side reports zeros)
  for (const who of order) r[who] = only && only !== who ? summary(new Float64Array(1)) : who === "p5" ? await measureP5(cell, built) : await measureCarton(cell, built);
  if (only) {
    console.log(`${name} ${only}: ${JSON.stringify(r[only])}`);
    continue;
  }
  for (const who of order) r[who] = who === "p5" ? await measureP5(cell, built) : await measureCarton(cell, built);
  const row = { cell: name, ...cell, order, pool: built.pool.length, offered, load1m: [+load0.toFixed(2), +loadavg()[0]!.toFixed(2)], p5: r.p5!, carton: r.carton!, ratioMean: +(r.carton!.mean / r.p5!.mean).toFixed(2), ratioP50: +(r.carton!.p50 / r.p5!.p50).toFixed(2) };
  results.push(row);
  console.log(`${name.padEnd(26)} p5 µs mean ${String(row.p5.mean).padStart(7)} p50 ${String(row.p5.p50).padStart(5)} | carton mean ${String(row.carton.mean).padStart(7)} p50 ${String(row.carton.p50).padStart(5)} | ratio mean ${row.ratioMean} p50 ${row.ratioP50} | load ${row.load1m.join("→")}`);
}
const dir = new URL("./results/", import.meta.url).pathname;
mkdirSync(dir, { recursive: true });
const file = `${dir}push-cpu-run${run}${filter ? "-partial" : ""}.json`;
writeFileSync(file, JSON.stringify({ run, node: process.version, pushes: N, warmup: WARM, results }, null, 1));
console.log(`UNVERIFIED -> ${file}`);
