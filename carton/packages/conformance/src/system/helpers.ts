// Shared helpers for the system tests (port of system-v11 `test/helpers.mjs`): drive the virtual clock until promises
// settle, remote writers, blame, convergence.
import assert from "node:assert/strict";
import type { TestContext } from "node:test";
import type { SequencerStorage } from "@carton/core/plugins";
import type { sync } from "@carton/core";
import * as A from "./sim/adapter.ts";
import type { Sim } from "./sim/kernel.ts";
import type { Replica, SimActor } from "./sim/replica.ts";
import { World, type WorldOptions } from "./sim/world.ts";
import { sqliteStorage } from "./sqlite.ts";

export { A };
export const ENGINE = A.ENGINE;

let storageFactory: () => SequencerStorage = () => sqliteStorage();
/** The sequencer storage every world in this process uses (a host's conformance run passes its own). */
export function useStorage(f: () => SequencerStorage): void {
  storageFactory = f;
}
/** A world on the suite's storage. */
export function world(opts: Omit<WorldOptions, "storage"> = {}): World {
  return new World({ ...opts, storage: storageFactory });
}

/** Run the simulation until `promise` settles (or the virtual clock passes now + limit). */
export async function until<T>(w: World, promise: Promise<T>, limit = 3600e3): Promise<T> {
  let done = false, val: T | undefined, err: unknown;
  promise.then((v) => ((done = true), (val = v)), (e) => ((done = true), (err = e)));
  await w.sim.runUntil(() => done, w.sim.now + limit);
  if (err) throw err;
  if (!done) throw new Error(`timed out at ${w.sim.now}`);
  return val as T;
}
export const runFor = (w: World, ms: number) => w.sim.run(w.sim.now + ms);

const q = (t: number, fps: number) => Math.round(t * fps) / fps;
/** One edit by a remote writer: 60% timing (move / trim-in / trim-out, frame-accurate), 40% style (opacity, lww). */
export function genEdit(sim: Sim, head: A.SimDoc, { timingFrac = 0.6, fps = 30, ids = null }: { timingFrac?: number; fps?: number; ids?: string[] | null } = {}) {
  const items = (head[A.ITEMS] ?? []).filter((i) => !ids || ids.includes(i.id));
  const it = sim.pick(items);
  if (sim.rand() >= timingFrac) return { ops: [{ op: "set" as const, path: [A.ITEMS, it.id, "opacity"], value: Math.round(sim.rand() * 100) / 100 }], policy: "lww" as const, item: it.id };
  const k = sim.rand(), sign = sim.rand() < 0.5 ? -1 : 1;
  const ops: { op: "set"; path: string[]; value: number }[] = [];
  const set = (f: string, v: number) => ops.push({ op: "set", path: [A.ITEMS, it.id, f], value: v });
  // starts never go below 0 (the hard validator; a GUI can't make one): such an edit is skipped
  if (k < 1 / 3) {
    const d = q(sign * sim.uni(0.1, 1), fps);
    if (it.startTime + d >= 0) (set("startTime", q(it.startTime + d, fps)), set("endTime", q(it.endTime + d, fps)));
  } else if (k < 2 / 3) {
    const d = q(sign * sim.uni(0.1, 0.5), fps);
    if (it.startTime + d >= 0 && it.startTime + d < it.endTime - 0.3 && it.trimStart + d >= 0) (set("startTime", q(it.startTime + d, fps)), set("trimStart", q(it.trimStart + d, fps)));
  } else {
    const d = q(sign * sim.uni(0.1, 0.5), fps);
    if (it.endTime + d > it.startTime + 0.3) (set("endTime", q(it.endTime + d, fps)), set("trimEnd", q(it.trimEnd + d, fps)));
  }
  return { ops, policy: "merge" as const, item: it.id };
}

/** A remote writer on replica r (its worker holds the lease): Poisson commits at `rate`/s until `untilT`. */
export function botWriter(r: Replica, { rate = 1, untilT, actor, ...gen }: { rate?: number; untilT: number; actor?: SimActor; timingFrac?: number; fps?: number; ids?: string[] | null }) {
  const sim = r.sim;
  const who = actor ?? r.newActor({ kind: "human", id: `human:${r.name}`, name: r.name });
  const out = { commits: 0 };
  const tick = () => {
    if (sim.now > untilT) return;
    r.worker!.proc.engine.post(() => {
      const head = r.store.optimistic(r.b).doc as A.SimDoc;
      const e = genEdit(sim, head, gen);
      if (!e.ops.length) return;
      const id = r.worker!.proc.nextId();
      r.store.commit(r.b, { id, author: who, ops: e.ops, policy: e.policy, at: sim.now });
      r.worker!.onLocalCommit(id, who, {});
      out.commits++;
    });
    sim.after(sim.exp(1000 / rate), tick);
  };
  sim.after(sim.exp(1000 / rate), tick);
  return out;
}

/** Who last set this path, by the confirmed log. */
export function blame(r: Replica, path: (string | number)[]): sync.QueueRow | null {
  const key = A.pathKey(path);
  let who: sync.QueueRow | null = null;
  for (const row of r.store.rows(r.b))
    for (const op of row.ops) {
      const k = A.pathKey(op.path);
      if (k === key || key.startsWith(k + "/")) who = row;
    }
  return who;
}
export const head = (r: Replica) => r.store.optimistic(r.b).doc as A.SimDoc;
export const confirmedHead = (r: Replica) => r.store.confirmedState(r.b, r.store.headSeq(r.b)) as A.SimDoc;
export const it = (doc: A.SimDoc, id: string) => A.item(doc, id);
export function serverDoc(w: World, b: string): A.SimDoc {
  let d = w.server.branches.get(b)!.doc0 as A.SimDoc;
  for (const row of w.server.rows(b)) if (row.ops.length) d = A.applyOps(d, row.ops);
  return d;
}
/** Every replica's confirmed log equals the server's, row by row, and their states are identical. */
export function assertConverged(w: World, b: string, replicas: Replica[]) {
  const srv = w.server.rows(b);
  const sd = A.snapshot(serverDoc(w, b));
  for (const r of replicas) {
    assert.equal(r.store.pending(b).length, 0, `${r.name} still has pending changes`);
    // rows a replica learned only through a keyframe are placeholders (no id); every other row must match
    assert.equal(r.store.rows(b).length, srv.length, `${r.name} log length differs from the server's`);
    assert.deepEqual(r.store.rows(b).map((x, i) => (x.placeholder ? srv[i]!.id : x.id)), srv.map((x) => x.id), `${r.name} log differs from the server's`);
    assert.equal(A.snapshot(confirmedHead(r)), sd, `${r.name} state differs from the server's`);
  }
  const ids = srv.map((x) => x.id);
  assert.equal(new Set(ids).size, ids.length, "a change id appears twice in the server log");
}
export const countId = (w: World, b: string, id: string) => w.server.rows(b).filter((r) => r.id === id).length;
export function report(t: TestContext, obj: unknown) {
  t.diagnostic(JSON.stringify(obj));
}
