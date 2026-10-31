// Fuzz suites with stated counts (port of core-v5 `fuzz.test.mjs`; the prototype's env overrides DAG, MULTI, DET and
// TP1 are options here).
// - DAG fuzz: random fork / commit / fold (incl. criss-cross) histories on one replica, and three replicas exchanging
//   shallow .cbproj exports, against a reference that keeps every node's full state in a graph and finds LCAs by brute
//   force. Zero mismatches required.
// - Apply determinism: replicas applying the same confirmed log in different ways produce identical canonical bytes and
//   hashes.
// - Remap transform (TP1): b ; t(a, b) == a ; t(b, a) on random steps, pointwise.
// - Keys: keyBetween order and validity; assignKeys keeps the intended order.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as E from "@carton/core";
import { History } from "@carton/core";
import type { Doc, FoldResult, NodeId, RemapMaps, RemapStep, Schema } from "@carton/core";
import { fromHost, toHost, withKeys } from "./fixtures/cardboard-schema.ts";
import { rng, fuzzDoc, fuzzEdit, pick, int } from "./gen.ts";
import type { Rng } from "./gen.ts";
import { valid } from "./props.ts";
import { baseOf, importedHead, refAt } from "./support.ts";
import type { Json } from "./support.ts";

export interface FuzzOptions {
  /** One-replica DAG histories (default 400). */
  dag?: number;
  /** Three-replica histories per carry mode (default 300). */
  multi?: number;
  /** Apply-determinism logs (default 1,000). */
  det?: number;
  /** TP1 step pairs (default 20,000). */
  tp1?: number;
}

interface RefNode {
  parents: NodeId[];
  state: Doc;
  edges: RemapMaps[];
}

export function fuzzTests(S: Schema, opts: FuzzOptions = {}): void {
  const N_DAG = opts.dag ?? 400,
    N_MULTI = opts.multi ?? 300,
    N_DET = opts.det ?? 1000,
    N_TP1 = opts.tp1 ?? 20000;
  const snap = (d: Doc | null) => E.snapshot(d!, S);
  const ed = (r: Rng, d: Doc) => fromHost(fuzzEdit(r, toHost(d)), d);

  // ------------------------------------------------------------------ the reference: full state graph
  class Ref {
    nodes = new Map<NodeId, RefNode>(); // id -> {parents: [ids], state, edges: [maps per parent]}
    add(id: NodeId, parents: NodeId[], state: Doc, edges: RemapMaps[]) {
      this.nodes.set(id, { parents, state: JSON.parse(snap(state)), edges });
    }
    anc(id: NodeId, acc = new Set<NodeId>()): Set<NodeId> {
      if (acc.has(id)) return acc;
      acc.add(id);
      for (const p of this.nodes.get(id)!.parents) this.anc(p, acc);
      return acc;
    }
    lowest(common: Set<NodeId>): NodeId[] {
      return [...common].filter((c) => ![...common].some((d) => d !== c && this.anc(d).has(c))).sort();
    }
    // the recursive merge base, by brute force over full ancestor sets
    base(setX: Set<NodeId>, setY: Set<NodeId>): { nodes: NodeId[]; doc: Doc } {
      const common = new Set([...setX].filter((n) => setY.has(n)));
      const L = this.lowest(common);
      if (L.length === 1) return { nodes: L, doc: this.nodes.get(L[0]!)!.state };
      let acc = { set: this.anc(L[0]!), doc: this.nodes.get(L[0]!)!.state };
      for (let i = 1; i < L.length; i++) {
        const si = this.anc(L[i]!);
        const inner = this.base(acc.set, si);
        const m = E.merge3(inner.doc, acc.doc, this.nodes.get(L[i]!)!.state, S, { infer: false });
        acc = { set: new Set([...acc.set, ...si]), doc: E.resolve(m, m.conflicts.map(() => "base" as const)) };
      }
      return { nodes: L, doc: acc.doc };
    }
    // compose edge maps along a path the reference finds itself (depth-first, first parent first)
    path(from: NodeId, to: NodeId): RemapMaps {
      const go = (id: NodeId, seen: Set<NodeId>): RemapMaps[] | null => {
        if (id === from) return [];
        if (seen.has(id)) return null;
        seen.add(id);
        const n = this.nodes.get(id)!;
        for (let k = 0; k < n.parents.length; k++) {
          if (!this.anc(n.parents[k]!).has(from)) continue;
          const rest = go(n.parents[k]!, seen);
          if (rest) return [...rest, n.edges[k] ?? {}];
        }
        return null;
      };
      return E.composeMaps(...go(to, new Set())!);
    }
  }
  const emptyMaps = (m: RemapMaps) => Object.values(m).every((c) => !c.length);
  const refMerge = (ref: Ref, x: NodeId, y: NodeId) => {
    const b = ref.base(ref.anc(x), ref.anc(y));
    const Mo = ref.path(b.nodes[0]!, x),
      Mt = ref.path(b.nodes[0]!, y);
    const m = E.merge3(b.doc, ref.nodes.get(x)!.state, ref.nodes.get(y)!.state, S, { remaps: { ours: emptyMaps(Mo) ? undefined : { maps: Mo }, theirs: emptyMaps(Mt) ? undefined : { maps: Mt } } });
    return { base: b, doc: E.resolve(m, m.conflicts.map(() => "ours" as const)), cards: m.conflicts.length };
  };
  const status = (res: FoldResult) => res.status + ("reason" in res ? ` (${res.reason})` : "");
  const nodeEdges = (rep: History, id: NodeId): RemapMaps[] => {
    const c = rep.changeAt(id);
    if (!c) return [];
    return c.mergeOf ? [c.mergeEdges?.first ?? {}, c.mergeEdges?.second ?? {}] : [c.intent?.maps ?? {}];
  };

  test(`DAG fuzz, one replica: ${N_DAG} random fork/commit/merge histories (criss-cross included) vs a full-state reference, zero mismatches`, () => {
    const t = { histories: 0, ops: 0, merges: 0, crissCross: 0, upToDate: 0, cards: 0, statesChecked: 0 };
    for (let h = 0; h < N_DAG; h++) {
      const r = rng(40000 + h);
      const d0 = withKeys(fuzzDoc(r));
      const rep = History.create(S, d0, { keyframeEvery: int(r, 2, 5) });
      const ref = new Ref();
      const heads = new Map([[rep.current, rep.head(rep.current)]]);
      ref.add(rep.head(rep.current), [], d0, []);
      for (let step = int(r, 8, 24); step > 0; step--) {
        t.ops++;
        const k = r(),
          b = pick(r, [...heads.keys()]);
        if (k < 0.45) {
          const prev = heads.get(b)!;
          const nd = ed(r, ref.nodes.get(prev)!.state);
          const res = rep.commit(b, { doc: nd, author: { kind: "human", id: "u" } });
          if (res.status !== "confirmed" || res.empty) continue;
          const id = rep.head(b);
          ref.add(id, [prev], nd, nodeEdges(rep, id));
          heads.set(b, id);
        } else if (k < 0.6) {
          const from = pick(r, [...ref.nodes.keys()]);
          const nb = rep.fork(from, `b${heads.size}`);
          heads.set(nb, rep.canon(`${nb}@0`));
        } else {
          const into = b,
            x = heads.get(into)!;
          const y = pick(r, [...heads.values()].filter((v) => v !== x).concat([pick(r, [...ref.nodes.keys()])]));
          const refUp = ref.anc(x).has(y);
          // port: merge is fold
          const res = rep.fold(into, y, { author: { kind: "human", id: "u" }, choices: () => "ours" });
          if (refUp) {
            assert.equal(res.status, "up-to-date", `history ${h}: up-to-date disagrees`);
            t.upToDate++;
            continue;
          }
          assert.equal(res.status, "confirmed", `history ${h}: merge status ${status(res)}`);
          const exp = refMerge(ref, x, y);
          t.merges++;
          t.cards += exp.cards;
          if (exp.base.nodes.length > 1) t.crissCross++;
          assert.deepEqual(baseOf(res).nodes, exp.base.nodes, `history ${h}: merge base nodes`);
          assert.equal(snap(baseOf(res).doc!), snap(exp.base.doc), `history ${h}: merge base state`);
          const id = rep.head(into);
          assert.equal(snap(rep.stateOf(id)), snap(exp.doc), `history ${h}: merged state`);
          assert.equal(valid(rep.stateOf(id)!, S), null, `history ${h}: merged state valid`);
          ref.add(id, [x, y], exp.doc, nodeEdges(rep, id));
          heads.set(into, id);
        }
      }
      for (const [id, n] of ref.nodes) {
        assert.equal(snap(rep.stateOf(id)), snap(n.state), `history ${h}: state of ${id}`);
        t.statesChecked++;
      }
      t.histories++;
    }
    console.log(`  # DAG fuzz (one replica): ${JSON.stringify(t)}`);
    assert.ok(t.crissCross > 0, "the corpus includes criss-cross merges");
  });

  for (const carry of ["fork-merge-export", "export-only", "head-only"] as const)
    test(`DAG fuzz, three replicas exchanging shallow .cbproj exports (carry ${carry}): ${N_MULTI} histories; every recipient merge base equals the true global LCA${carry === "fork-merge-export" ? ", never a missing-base dialog" : " or is reported missing (ablation)"}`, () => {
      const t = { histories: 0, exchanges: 0, merges: 0, missing: 0, crissCross: 0, cards: 0 };
      for (let h = 0; h < N_MULTI; h++) {
        const r = rng(60000 + h);
        const d0 = withKeys(fuzzDoc(r));
        // port: History has no `name`; the replicas' names are kept here
        const names = ["r0", "r1", "r2"];
        const reps = [History.create(S, d0, { name: "r0" }), new History(S, { name: "r1" }), new History(S, { name: "r2" })];
        const ref = new Ref();
        ref.add(reps[0]!.head(reps[0]!.current), [], d0, []);
        const live = [0];
        const headOf = (i: number) => reps[i]!.head(reps[i]!.current);
        for (let step = int(r, 10, 30); step > 0; step--) {
          const i = pick(r, live);
          const rep = reps[i]!;
          const k = r();
          if (k < 0.45) {
            const prev = headOf(i);
            const nd = ed(r, ref.nodes.get(rep.canon(prev))!.state);
            const res = rep.commit(rep.current, { doc: nd, author: { kind: "human", id: names[i]! } });
            if (res.status !== "confirmed" || res.empty) continue;
            ref.add(headOf(i), [rep.canon(prev)], nd, nodeEdges(rep, headOf(i)));
          } else if (k < 0.55 && rep.cuts().length) {
            // a local variant: fork, edit, fold back later
            const vb = rep.fork(headOf(i), "variant");
            const prev = rep.canon(`${vb}@0`);
            const nd = ed(r, ref.nodes.get(prev)!.state);
            // port: an edit that changes nothing is confirmed empty and makes no node (v14: the sequencer refuses empty
            // changes; system-v11's store did the same); the prototype recorded an empty change here
            const vres = rep.commit(vb, { doc: nd, author: { kind: "agent", id: names[i]! } });
            if (vres.status !== "confirmed" || vres.empty) continue;
            const vid = rep.head(vb);
            ref.add(vid, [prev], nd, nodeEdges(rep, vid));
            const x = headOf(i);
            rep.fold(rep.current, vid, { choices: () => "ours" });
            const exp = refMerge(ref, rep.canon(x), vid);
            assert.equal(snap(rep.stateOf(headOf(i))), snap(exp.doc), `history ${h}: local variant merge`);
            ref.add(headOf(i), [rep.canon(x), vid], exp.doc, nodeEdges(rep, headOf(i)));
          } else {
            // export the current branch, or (R5-02's topology) a variant that stays unmerged at the sender
            let src = rep.current;
            if (k < 0.62) {
              src = rep.fork(headOf(i), "sent-variant");
              const prev = rep.canon(`${src}@0`);
              const nd = ed(r, ref.nodes.get(prev)!.state);
              // port: as above, an empty edit makes no node; the variant is then exported at its fork node
              const sres = rep.commit(src, { doc: nd, author: { kind: "agent", id: names[i]! } });
              if (sres.status === "confirmed" && !sres.empty) ref.add(rep.head(src), [prev], nd, nodeEdges(rep, rep.head(src)));
            }
            const j = pick(
              r,
              [0, 1, 2].filter((q) => q !== i),
            );
            const pkg = JSON.parse(JSON.stringify(rep.exportShallow(src, { to: names[j], carry })));
            t.exchanges++;
            const imp = reps[j]!.importShallow(pkg);
            assert.ok("head" in imp && imp.head, `history ${h}: import ${JSON.stringify(imp)} into ${names[j]} (branches ${reps[j]!.cuts().length}, project ${reps[j]!.projectId} vs ${pkg.projectId})`);
            if (imp.status === "forked") {
              live.push(j);
              continue;
            }
            const x = reps[j]!.canon(headOf(j)),
              y = importedHead(imp);
            if (ref.anc(x).has(y)) continue;
            const res = reps[j]!.fold(reps[j]!.current, y, { choices: () => "ours" });
            const exp = refMerge(ref, x, y);
            if (res.status === "missing-base") {
              t.missing++;
              const L = res.dialog.lca!;
              assert.ok(ref.anc(x).has(L) && ref.anc(y).has(L), `history ${h}: the missing node ${L} is a common ancestor of both heads`);
              if (exp.base.nodes.length === 1) assert.equal(L, exp.base.nodes[0], `history ${h}: the missing node is the true LCA`);
              assert.notEqual(carry, "fork-merge-export", `history ${h}: missing base with full carriage`);
              continue;
            }
            assert.equal(res.status, "confirmed", `history ${h}: ${status(res)}`);
            t.merges++;
            t.cards += exp.cards;
            if (exp.base.nodes.length > 1) t.crissCross++;
            assert.deepEqual(baseOf(res).nodes, exp.base.nodes, `history ${h}: recipient LCA != true global LCA`);
            assert.equal(snap(reps[j]!.stateOf(headOf(j))), snap(exp.doc), `history ${h}: merged state`);
            ref.add(headOf(j), [x, y], exp.doc, nodeEdges(reps[j]!, headOf(j)));
          }
        }
        t.histories++;
      }
      console.log(`  # DAG fuzz (three replicas, carry ${carry}): ${JSON.stringify(t)}`);
      if (carry === "fork-merge-export") assert.equal(t.missing, 0);
    });

  // ------------------------------------------------------------------ apply determinism

  test(`apply determinism: ${N_DET} random confirmed logs (rebased concurrent writers) applied four ways give identical canonical bytes and hashes`, () => {
    let changes = 0,
      ops = 0;
    for (let h = 0; h < N_DET; h++) {
      const r = rng(80000 + h);
      const d0 = withKeys(fuzzDoc(r));
      const rep = History.create(S, d0);
      const b = rep.current;
      const writers = Array.from({ length: int(r, 2, 4) }, () => ({ seq: 0 }));
      for (let s = int(r, 4, 14); s > 0; s--) {
        const w = pick(r, writers);
        const base = refAt(rep, b, w.seq);
        const cur = rep.stateOf(`${b}@${w.seq}`)!;
        const res = rep.commit(b, { doc: ed(r, cur), base, author: { kind: "human", id: "w" }, choices: () => pick(r, ["ours", "theirs"] as const) });
        if (res.status === "confirmed") w.seq = rep.headSeq(b);
        if (r() < 0.3) w.seq = rep.headSeq(b);
      }
      // port: r.branches.get(b).log is r.changes(b)
      const log = rep.changes(b);
      changes += log.length;
      ops += log.reduce((n, c) => n + c.ops.length, 0);
      const a = E.apply(
        E.fork(d0, S),
        log.flatMap((c) => c.ops),
        S,
      );
      const wire: Json = JSON.parse(JSON.stringify({ d0, log: log.map(({ ops }) => ({ ops })) }));
      const bj = (wire.log as Json[]).reduce((d, c) => E.apply(d, c.ops, S), wire.d0);
      let c = E.fork(d0, S);
      log.forEach((ch, i) => {
        E.apply(c, ch.ops, S);
        if (i % 3 === 1) c = JSON.parse(snap(c)); // a keyframe written and read back
      });
      const full = new History(S, { name: "copy" });
      full.importFull(JSON.parse(JSON.stringify(rep.exportFull())));
      const dd = full.stateOf(`${b}@${log.length}`)!;
      const bytes = [a, bj, c, dd].map(snap);
      assert.ok(
        bytes.every((x) => x === bytes[0]),
        `history ${h}: canonical bytes differ`,
      );
      const hashes = [a, bj, c, dd].map((d) => E.hashDoc(d, S));
      assert.ok(
        hashes.every((x) => x === hashes[0]),
        `history ${h}: hashes differ`,
      );
      assert.equal(hashes[0], rep.hashOf(rep.head(b)));
    }
    console.log(`  # apply determinism: ${N_DET} histories, ${changes} confirmed changes, ${ops} ops, 4 replicas each, 0 mismatches`);
  });

  // ------------------------------------------------------------------ remap transform property (TP1)

  test(`remap transform TP1: b ; t(a,b) and a ; t(b,a) map ${N_TP1} random step pairs identically (start and end edges, deleted points agree)`, () => {
    const r = rng(99);
    const randStep = (): RemapStep => {
      const d: [number, number][] = [],
        i: [number, number][] = [];
      for (let k = int(r, 0, 3); k > 0; k--) {
        const a = int(r, 0, 90);
        d.push([a, a + int(r, 1, 8)]);
      }
      // ranges inside one step are disjoint
      d.sort((x, y) => x[0] - y[0]);
      const dj: [number, number][] = [];
      for (const x of d) if (!dj.length || x[0] >= dj.at(-1)![1]) dj.push(x);
      for (let k = int(r, 0, 2); k > 0; k--) i.push([int(r, 0, 100), int(r, 1, 6)]);
      return E.step(dj, i);
    };
    let points = 0;
    for (let c = 0; c < N_TP1; c++) {
      const a = randStep(),
        b = randStep();
      const p1 = E.composeChain([b], E.transformChain([a], [b])),
        p2 = E.composeChain([a], E.transformChain([b], [a]));
      for (let x = -1; x <= 110; x += 0.5)
        for (const edge of ["s", "e"] as const) {
          assert.equal(E.remapPoint(p1, x, edge), E.remapPoint(p2, x, edge), `case ${c} x=${x} ${edge}: ${JSON.stringify([a, b])}`);
          points++;
        }
    }
    console.log(`  # TP1: ${N_TP1} step pairs, ${points} point checks, 0 mismatches`);
  });

  // ------------------------------------------------------------------ keys

  test("keys: keyBetween is strictly between, never ends in 0, never a prefix of the upper key; assignKeys preserves the intended order (20,000 cases)", () => {
    const r = rng(5);
    const D = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
    for (let c = 0; c < 20000; c++) {
      const rk = () => {
        let s = "";
        for (let n = int(r, 1, 6); n > 0; n--) s += D[int(r, 0, 61)];
        return s.replace(/0+$/, "") || "V";
      };
      let a = r() < 0.2 ? "" : rk(),
        b: string | null = r() < 0.2 ? null : rk();
      if (b !== null && !(a < b)) [a, b] = b < a ? [b, a] : [a, null];
      const k = E.keyBetween(a, b);
      assert.ok(k > a && (b === null || k < b) && !k.endsWith("0") && (b === null || !b.startsWith(k)), `${a} < ${k} < ${b}`);
    }
    for (let c = 0; c < 2000; c++) {
      let els: { id: string; "#pos": string }[] = [];
      let ids: string[] = [];
      for (let s = 0; s < 12; s++) {
        const next = [...ids];
        if (r() < 0.6 || !next.length) next.splice(int(r, 0, next.length), 0, `e${c}-${s}`);
        else if (r() < 0.5) next.splice(int(r, 0, next.length - 1), 1);
        else {
          const [m] = next.splice(int(r, 0, next.length - 1), 1);
          next.splice(int(r, 0, next.length), 0, m!);
        }
        const { keys } = E.assignKeys(els, next, "id", () => r() < 0.5);
        els = next.map((id) => ({ id, "#pos": keys.get(id)! }));
        const sorted = [...els].sort((x, y) => (x["#pos"] < y["#pos"] ? -1 : x["#pos"] > y["#pos"] ? 1 : x.id < y.id ? -1 : 1)).map((e) => e.id);
        assert.deepEqual(sorted, next);
        assert.ok(els.every((e) => e["#pos"].length <= E.MAX_KEY));
        ids = next;
      }
    }
  });
}
