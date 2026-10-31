// diff(a, b): the ops that turn a into b, schema-driven (PLAN §4.1). Sequence inserts and moves carry their intended
// neighbour ids; a `#pos` change that keeps the relative order (a rebalance) is flagged `rk`.
import { POS } from "../types.ts";
import type { FieldSpec, KeyedSpec, ObjectSpec, Schema, CollectionSpec } from "../schema.ts";
import type { Doc, InsertOp, Op, Path, Rec, SetOp } from "../types.ts";
import { deepEqual, isObj, EMPTY } from "./json.ts";
import { childSpec, LEAF } from "./doc.ts";
import { byPos } from "./keys.ts";
import { lcs } from "./lcs.ts";

export function diff(a: Doc, b: Doc, schema: Schema): Op[] {
  const ops: Op[] = [];
  for (const k of keysUnion(a, b)) if (!schema.collections[k]) diffValue(ops, [k], a[k], b[k], schema.root.fields[k] ?? LEAF);
  for (const name in schema.collections) diffColl(ops, name, (a[name] as Rec[] | undefined) ?? EMPTY, (b[name] as Rec[] | undefined) ?? EMPTY, schema.collections[name]!);
  return ops;
}

function keysUnion(a: Doc, b: Doc): string[] {
  const ks = Object.keys(a);
  for (const k in b) if (!(k in a)) ks.push(k);
  return ks;
}

function diffValue(ops: Op[], path: Path, x: unknown, y: unknown, spec: FieldSpec): void {
  if (x === y || spec.kind === "ephemeral") return;
  if (y === undefined) return void ops.push({ op: "unset", path });
  if (x === undefined) return void ops.push({ op: "set", path, value: y });
  if (spec.kind === "object" && isObj(x) && isObj(y)) return diffObject(ops, path, x, y, spec);
  if (spec.kind === "keyed" && keyedOk(x, spec.key) && keyedOk(y, spec.key)) return diffKeyed(ops, path, x, y, spec);
  if (!deepEqual(x, y)) ops.push({ op: "set", path, value: y });
}

function diffObject(ops: Op[], path: Path, x: Rec, y: Rec, spec: ObjectSpec, skip: string | null = null): void {
  for (const k in x) {
    if (k === skip) continue;
    const xv = x[k],
      yv = y[k];
    if (xv !== yv) diffValue(ops, [...path, k], xv, yv, childSpec(spec, k, xv, yv));
  }
  for (const k in y) if (!(k in x) && y[k] !== undefined && k !== skip && childSpec(spec, k).kind !== "ephemeral") diffValue(ops, [...path, k], undefined, y[k], LEAF);
}

function keyedOk(arr: unknown, key: string): arr is Rec[] {
  if (!Array.isArray(arr)) return false;
  const seen = new Set<unknown>();
  for (const e of arr) {
    if (!isObj(e) || (typeof e[key] !== "string" && typeof e[key] !== "number") || seen.has(e[key])) return false;
    seen.add(e[key]);
  }
  return true;
}

// ids whose relative order among common elements changed (not on the LCS): real moves; a `#pos` change of any other
// element is an order-preserving re-key.
function movedIds(oldOrder: readonly unknown[], newOrder: readonly unknown[]): Set<unknown> {
  const inNew = new Set(newOrder),
    inOld = new Set(oldOrder);
  const a = oldOrder.filter((x) => inNew.has(x)),
    b = newOrder.filter((x) => inOld.has(x));
  const keep = new Set(lcs(a, b).map(([i]) => a[i]));
  return new Set(a.filter((x) => !keep.has(x)));
}

function diffKeyed(ops: Op[], path: Path, xa: Rec[], ya: Rec[], spec: KeyedSpec): void {
  const key = spec.key;
  const xm = new Map(xa.map((e) => [e[key], e]));
  const ym = new Set(ya.map((e) => e[key]));
  for (const e of xa) if (!ym.has(e[key])) ops.push({ op: "remove", path: [...path, e[key] as string] });
  let moved: Set<unknown> | null = null;
  for (let i = 0; i < ya.length; i++) {
    const e = ya[i]!,
      id = e[key] as string,
      old = xm.get(id);
    if (old === e) continue;
    const nb = (): [string | null, string | null] => [i > 0 ? (ya[i - 1]![key] as string) : null, i + 1 < ya.length ? (ya[i + 1]![key] as string) : null];
    if (old === undefined) {
      ops.push({ op: "insert", path: [...path, id], value: e, nb: nb() });
      continue;
    }
    diffObject(ops, [...path, id], old, e, spec.elem, POS);
    if (old[POS] !== e[POS]) {
      moved ??= movedIds(xa.map((x) => x[key]), ya.map((x) => x[key]));
      const op: SetOp = { op: "set", path: [...path, id, POS], value: e[POS], nb: nb() };
      if (!moved.has(id)) op.rk = true;
      ops.push(op);
    }
  }
}

// Forks and parsed copies keep records at the same positions, so compare position by position and fall back to
// matching by key only for the records that are not aligned (inserted, removed, moved).
function diffColl(ops: Op[], name: string, xa: readonly Rec[], ya: readonly Rec[], cs: CollectionSpec): void {
  const key = cs.key,
    n = Math.min(xa.length, ya.length);
  let xm: Rec[] | null = null,
    ym: Rec[] | null = null;
  const seqOps: (InsertOp | SetOp)[] | null = cs.seq ? [] : null;
  const rec = (x: Rec, y: Rec): void => {
    if (!seqOps) return diffObject(ops, [name, y[key] as string], x, y, cs.record);
    diffObject(ops, [name, y[key] as string], x, y, cs.record, POS);
    if (x[POS] !== y[POS]) seqOps.push({ op: "set", path: [name, y[key] as string, POS], value: y[POS] });
  };
  for (let j = 0; j < n; j++) {
    const x = xa[j]!,
      y = ya[j]!;
    if (x === y) continue;
    if (x[key] === y[key]) rec(x, y);
    else (xm ??= []).push(x), (ym ??= []).push(y);
  }
  for (let j = n; j < xa.length; j++) (xm ??= []).push(xa[j]!);
  for (let j = n; j < ya.length; j++) (ym ??= []).push(ya[j]!);
  const xi = new Map((xm ?? EMPTY).map((r: Rec) => [r[key], r]));
  const yi = new Set((ym ?? EMPTY).map((r: Rec) => r[key]));
  for (const y of ym ?? EMPTY) {
    const x = xi.get(y[key]);
    if (x === undefined) {
      const op: InsertOp = { op: "insert", path: [name, y[key] as string], value: y };
      if (seqOps) seqOps.push(op);
      else ops.push(op);
    } else if (x !== y) rec(x, y);
  }
  for (const x of xm ?? EMPTY) if (!yi.has(x[key])) ops.push({ op: "remove", path: [name, x[key] as string] });
  if (seqOps?.length) {
    // neighbour ids from the new order; re-keys (order unchanged) are flagged rk
    const order = [...ya].sort(byPos(key)).map((r) => r[key] as string);
    const at = new Map(order.map((id, i) => [id, i]));
    let moved: Set<unknown> | null = null;
    for (const op of seqOps) {
      const id = op.path[1] as string,
        i = at.get(id)!;
      op.nb = [i > 0 ? order[i - 1]! : null, i + 1 < order.length ? order[i + 1]! : null];
      if (op.op === "set") {
        moved ??= movedIds([...xa].sort(byPos(key)).map((r) => r[key]), order);
        if (!moved.has(id)) op.rk = true;
      }
      ops.push(op);
    }
  }
}
