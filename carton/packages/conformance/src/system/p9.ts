// P9 contention (PLAN §6.1, §20 P9), the Criticiser's single-track scenario, through the full system: replicas, workers
// holding the sync lease, the real pipelined SyncClient, the real sequencer core and its overlap rule, real merges on
// real documents (port of system-v11 `p9.mjs`):
//   5 editors, each Poisson at 0.5 commits/s for 600 s; 60% timing edits (move / trim-in / trim-out, frame-accurate,
//   within ±0.5 s of the clip's nominal edges) and 40% style edits (opacity, lww); 40 clips butted on one track (5 s
//   each); RTT 300 ms and 50 ms; a rebase costs 20 ms of the pusher's engine thread per pending change.
// Keying: v2 per-track layout key, v3 interval spans (the plan's rule), per-item paths, and v10's span rule (sensitivity).
// Latency = from the commit in carton.db to the confirmed row reaching the committing replica (virtual time).
// S2: a recorded ripple at 5 s against a concurrent append at 15 s, both orders, per keying: is it forced through merge3,
// and where does the appended clip end up?
// Target (§6.1): v3 spans within 1.5× of per-item paths at p99, while still catching S2.

import type { sequencer as rules } from "@carton/core";
import * as A from "./sim/adapter.ts";
import type { Sim } from "./sim/kernel.ts";
import { doc } from "./sim/world.ts";
import { world } from "./helpers.ts";

const q = (t: number) => Math.round(t * 30) / 30;

function p9Edit(sim: Sim, headDoc: A.SimDoc, nominal: Map<string, { s: number; e: number }>) {
  const items = headDoc.timelineItems!;
  const it = items[Math.floor(sim.rand() * items.length)]!;
  if (sim.rand() >= 0.6) {
    let v: number;
    do v = Math.round(sim.rand() * 100) / 100;
    while (v === it.opacity);
    return { ops: [{ op: "set" as const, path: [A.ITEMS, it.id, "opacity"], value: v }], policy: "lww" as const };
  }
  // starts never go below 0 (the hard validator; a GUI can't make one). Clamping touches only c0's start.
  const n = nominal.get(it.id)!, k = sim.rand(), jit = (x: number) => Math.max(0, q(x + sim.uni(-0.5, 0.5)));
  const set = (f: string, v: number) => ({ op: "set" as const, path: [A.ITEMS, it.id, f], value: v });
  let ops: ReturnType<typeof set>[] = [];
  if (k < 1 / 3) {
    const s = jit(n.s), d = s - it.startTime;
    ops = [set("startTime", s), set("endTime", q(it.endTime + d))];
  }
  // a trim-in never takes trimStart below 0 (the hard validator; Verification 4, M2): such an edit is skipped
  else if (k < 2 / 3) {
    const s = jit(n.s);
    if (s < it.endTime - 0.5 && it.trimStart + s - it.startTime >= 0) ops = [set("startTime", s), set("trimStart", q(it.trimStart + s - it.startTime))];
  } else {
    const e = jit(n.e);
    if (e > it.startTime + 0.5) ops = [set("endTime", e), set("trimEnd", q(it.trimEnd + e - it.endTime))];
  }
  ops = ops.filter((o) => A.item(headDoc, it.id)![o.path[2]!] !== o.value);
  return ops.length ? { ops, policy: "merge" as const } : null;
}

export const pct = (sorted: readonly number[], p: number): number => sorted[Math.max(0, Math.ceil(p * sorted.length) - 1)]!;

export interface P9Config {
  keying: rules.Keying;
  rtt: number;
  seed: number;
  pipeline?: boolean;
  jitter?: number;
  editors?: number;
  rate?: number;
  durS?: number;
}
export interface P9Run {
  keying: rules.Keying;
  rtt: number;
  seed: number;
  pipeline: boolean;
  jitter: number;
  edits: number;
  confirmed: number;
  absorbed: number;
  absorbedCarded: number;
  /** Absorbed edits whose id the server spent with a withdraw row (H1). */
  withdrawn: number;
  pending: number;
  duplicateIdsInLog: number;
  converged: boolean;
  p50: number;
  p90: number;
  p99: number;
  max: number;
  mean: number;
  pushes: number;
  rejects: number;
  rejectRate: number;
  editsRejected: number;
  maxRejectsOneChange: number;
  maxResends: number;
  lat: number[];
}

export async function runOnce({ keying, rtt, seed, pipeline = true, jitter = 0, editors = 5, rate = 0.5, durS = 600 }: P9Config): Promise<P9Run> {
  const w = world({ seed, keying });
  const reps = Array.from({ length: editors }, (_, i) => w.replica({ name: `ed${i}`, link: w.net.link({ rtt, jitter }) }));
  for (const r of reps) {
    r.rebaseMs = 20;
    r.pipeline = pipeline;
  }
  const clipsList = Array.from({ length: 40 }, (_, i) => ({ id: `c${i}`, trackId: "V1", type: "video", name: `c${i}`, startTime: i * 5, endTime: (i + 1) * 5, trimStart: 1, trimEnd: 6, opacity: 1 }));
  const nominal = new Map(clipsList.map((c) => [c.id, { s: c.startTime, e: c.endTime }]));
  const b = w.shared(doc({ items: clipsList }), reps);
  let started = false;
  void Promise.all(reps.map((r) => r.startApp({ gui: false, materialize: false }))).then(() => (started = true));
  await w.sim.runUntil(() => started, 60000);
  await w.sim.run(w.sim.now + 5000); // all connected and caught up
  const t0 = w.sim.now, T = t0 + durS * 1000;
  const lat: number[] = [], sends: number[] = [];
  let edits = 0, absorbed = 0, absorbedCarded = 0, withdrawn = 0;
  for (const r of reps) {
    const human = `human:${r.name}`;
    r.listeners.push((e) => {
      if (e.type === "confirmed" && e.author?.id === human) {
        lat.push(e.latency);
        sends.push(e.sends);
      }
      if (e.type === "absorbed" && e.author?.id === human) {
        // nothing to push: no latency
        absorbed++;
        if (e.cards) absorbedCarded++;
        if (e.withdrawn) withdrawn++;
      }
    });
    const who = r.newActor({ kind: "human", id: human, name: r.name });
    const tick = () => {
      if (w.sim.now > T) return;
      r.worker!.proc.engine.post(() => {
        const e = p9Edit(w.sim, r.store.optimistic(b).doc as A.SimDoc, nominal);
        if (!e) return;
        r.store.commit(b, { id: r.worker!.proc.nextId(), author: who, ops: e.ops, policy: e.policy, at: w.sim.now });
        edits++;
      });
      w.sim.after(w.sim.exp(1000 / rate), tick);
    };
    w.sim.after(w.sim.exp(1000 / rate), tick);
  }
  await w.sim.run(T + 60000);
  const st = w.server.stats;
  const pending = reps.reduce((s, r) => s + r.store.pending(b).length, 0);
  const rows = w.server.rows(b);
  const ids = new Set(rows.map((r) => r.id));
  let d = w.server.branches.get(b)!.doc0!;
  for (const r of rows) if (r.ops.length) d = A.applyOps(d, r.ops);
  const sd = A.snapshot(d);
  const converged = reps.every((r) => r.store.rows(b).length === rows.length && A.snapshot(r.store.confirmedState(b, rows.length)) === sd);
  lat.sort((x, y) => x - y);
  const rejectsPerChange = [...w.server.rejectsById.values()];
  return {
    keying, rtt, seed, pipeline, jitter, edits, confirmed: lat.length, absorbed, absorbedCarded, withdrawn, pending,
    duplicateIdsInLog: rows.length - ids.size, converged,
    p50: pct(lat, 0.5), p90: pct(lat, 0.9), p99: pct(lat, 0.99), max: lat.at(-1)!, mean: lat.reduce((s, x) => s + x, 0) / lat.length,
    pushes: st.pushes, rejects: st.rejects, rejectRate: st.rejects / st.pushes, editsRejected: rejectsPerChange.length / lat.length,
    maxRejectsOneChange: Math.max(0, ...rejectsPerChange), maxResends: Math.max(0, ...sends) - 1, lat,
  };
}

/**
 * S2 through the system: replica A records a ripple (delete i1 [0,5], everything from 5 moves −5); replica B appends
 * i4 right after i3 at [15,20] from the same base. Both orders of arrival.
 */
export async function s2({ keying, first }: { keying: rules.Keying; first: "ripple" | "append" }) {
  const w = world({ seed: 7, keying });
  const ra = w.replica({ name: "agent", link: w.net.link({ rtt: first === "ripple" ? 100 : 900 }) });
  const rb = w.replica({ name: "bob", link: w.net.link({ rtt: first === "ripple" ? 900 : 100 }) });
  const mk = (id: string, s: number, e: number) => ({ id, trackId: "T", type: "video", name: id, startTime: s, endTime: e, trimStart: 0, trimEnd: e - s, opacity: 1 });
  const b = w.shared(doc({ tracks: ["T"], items: [mk("i1", 0, 5), mk("i2", 5, 10), mk("i3", 10, 15)] }), [ra, rb]);
  let ok = false;
  void Promise.all([ra.startApp({ gui: false, materialize: false }), rb.startApp({ gui: false, materialize: false })]).then(() => (ok = true));
  await w.sim.runUntil(() => ok, 60000);
  await w.sim.run(w.sim.now + 3000);
  ra.worker!.proc.engine.post(() => {
    const a = A.rippleAction(ra.store.optimistic(b).doc, { track: "T", at: 5, delta: -5, removeId: "i1" });
    ra.store.commit(b, { id: "ripple.1", author: { kind: "agent", id: "agent" }, ops: a.ops, intent: a.intent, at: w.sim.now });
  });
  rb.worker!.proc.engine.post(() => {
    rb.store.commit(b, { id: "append.1", author: { kind: "human", id: "bob" }, ops: [{ op: "insert", path: [A.ITEMS, "i4"], value: mk("i4", 15, 20) }], at: w.sim.now });
  });
  await w.sim.run(w.sim.now + 10000);
  const rows = w.server.rows(b);
  const fin = A.applyOps(w.server.branches.get(b)!.doc0!, rows.flatMap((r) => r.ops));
  const i3 = A.item(fin, "i3")!, i4 = A.item(fin, "i4")!;
  return { keying, first, rejects: w.server.stats.rejects, forcedThroughMerge3: w.server.stats.rejects > 0, i3: [i3.startTime, i3.endTime], i4: [i4.startTime, i4.endTime], gap: i4.startTime - i3.endTime };
}

export interface P9Row {
  name: string;
  rtt: number;
  seeds: number;
  edits: number;
  p50: number;
  p90: number;
  p99: number;
  p999: number;
  max: number;
  mean: number;
  overOneRtt: number;
  medSeedP99: number;
  maxSeedP99: number;
  seedsOver: number;
  rejectRate: number;
  editsRejected: number;
  maxRejectsOneChange: number;
  maxResends: number;
  absorbed: number;
  withdrawn: number;
  allConverged: boolean;
}

/** Pooled rows per (keying, variant, RTT), as the prototype's tables. */
export function summarize(runs: readonly P9Run[]): P9Row[] {
  const groups = new Map<string, P9Run[]>();
  for (const r of runs) {
    const k = `${r.keying}${r.pipeline ? "" : " (one push in flight)"}${r.jitter ? ` (jitter 0–${r.jitter} ms one way)` : ""}|${r.rtt}`;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k)!.push(r);
  }
  const rows: P9Row[] = [];
  for (const [k, rs] of groups) {
    const [name, rtt] = k.split("|") as [string, string];
    const all = rs.flatMap((r) => r.lat).sort((x, y) => x - y);
    const med = (f: (r: P9Run) => number) => {
      const v = rs.map(f).sort((x, y) => x - y);
      return v[Math.floor(v.length / 2)]!;
    };
    rows.push({
      name, rtt: Number(rtt), seeds: rs.length, edits: all.length,
      p50: pct(all, 0.5), p90: pct(all, 0.9), p99: pct(all, 0.99), p999: pct(all, 0.999), max: all.at(-1)!, mean: all.reduce((s, x) => s + x, 0) / all.length,
      overOneRtt: all.filter((x) => x > Number(rtt) * 1.05 + (rs[0]!.jitter ?? 0) * 2).length / all.length,
      medSeedP99: med((r) => r.p99), maxSeedP99: Math.max(...rs.map((r) => r.p99)), seedsOver: rs.filter((r) => r.p99 > 1.5 * Number(rtt) + (r.jitter ?? 0) * 2).length,
      rejectRate: rs.reduce((s, r) => s + r.rejects, 0) / rs.reduce((s, r) => s + r.pushes, 0),
      editsRejected: rs.reduce((s, r) => s + r.editsRejected * r.confirmed, 0) / all.length,
      maxRejectsOneChange: Math.max(...rs.map((r) => r.maxRejectsOneChange)), maxResends: Math.max(...rs.map((r) => r.maxResends)),
      absorbed: rs.reduce((s, r) => s + r.absorbed, 0), withdrawn: rs.reduce((s, r) => s + r.withdrawn, 0),
      allConverged: rs.every((r) => r.converged && r.pending === 0 && r.duplicateIdsInLog === 0 && r.confirmed + r.absorbed === r.edits),
    });
  }
  return rows;
}
const fmt = (x: number | undefined) => (x === undefined ? "–" : String(Math.round(x)));
export function table(rows: readonly P9Row[]): string {
  const h = "| keying | RTT ms | seeds | edits | p50 | p90 | p99 (pooled) | median of per-seed p99 | seeds with p99 > 1.5×RTT | max per-seed p99 | p99.9 | max | mean | edits slower than 1 RTT | rejected pushes | edits rejected ≥1× | max rejects of one change | max resends of one change | absorbed (withdrawn) | converged, exactly once |\n|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|";
  return [
    h,
    ...rows.map((r) => `| ${r.name} | ${r.rtt} | ${r.seeds} | ${r.edits} | ${fmt(r.p50)} | ${fmt(r.p90)} | ${fmt(r.p99)} | ${fmt(r.medSeedP99)} | ${r.seedsOver} | ${fmt(r.maxSeedP99)} | ${fmt(r.p999)} | ${fmt(r.max)} | ${r.mean.toFixed(1)} | ${(r.overOneRtt * 100).toFixed(2)}% | ${(r.rejectRate * 100).toFixed(2)}% | ${(r.editsRejected * 100).toFixed(2)}% | ${r.maxRejectsOneChange} | ${r.maxResends} | ${r.absorbed} (${r.withdrawn}) | ${r.allConverged ? "yes" : "NO"} |`),
  ].join("\n");
}
