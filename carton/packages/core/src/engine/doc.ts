// Documents: field specs by path, the per-collection id index, fork and getIn.
import { scalar, ephemeral } from "../schema.ts";
import type { FieldSpec, ObjectSpec, Schema } from "../schema.ts";
import type { Doc, Path, Rec } from "../types.ts";
import { isObj, EMPTY } from "./json.ts";

export const LEAF: FieldSpec = scalar;
export const DEEP: ObjectSpec = Object.freeze({ kind: "object", fields: {}, deep: true, only: false });

/** The spec of child `k` of an object spec (undeclared: ephemeral under `only`, deep objects, else a leaf). */
export const childSpec = (spec: FieldSpec, k: string, a?: unknown, b?: unknown): FieldSpec => {
  const f = spec.kind === "object" || spec.kind === "keyed" ? spec.fields[k] : undefined;
  if (f) return f;
  if (spec.kind === "object" && spec.only) return ephemeral;
  return spec.kind === "object" && spec.deep && isObj(a) && isObj(b) ? DEEP : LEAF;
};

const fieldOf = (spec: FieldSpec, seg: unknown): FieldSpec | undefined => (spec.kind === "object" || spec.kind === "keyed" ? spec.fields[seg as string] : undefined);

/** The field spec at `path` (null for a bare collection name). */
export function specAt(schema: Schema, path: Path): FieldSpec | null {
  const cs = schema.collections[path[0] as string];
  let spec: FieldSpec, i: number;
  if (cs) {
    if (path.length < 2) return null;
    spec = cs.record;
    i = 2;
  } else {
    spec = schema.root.fields[path[0] as string] ?? LEAF;
    i = 1;
  }
  for (; i < path.length; i++)
    spec = spec.kind === "keyed" ? spec.elem : fieldOf(spec, path[i]) ?? (spec.kind === "object" && spec.only ? ephemeral : spec.kind === "object" && spec.deep ? DEEP : LEAF);
  return spec;
}

// id -> index per collection array, cached on the array; apply() keeps it current. fork() shares the map with the
// copy (both marked not owned) and whoever changes membership first copies it.
type IndexEntry = { map: Map<unknown, number>; owned: boolean };
const INDEX = new WeakMap<readonly Rec[], IndexEntry>();
export function indexOf(arr: readonly Rec[], key: string): Map<unknown, number> {
  const e = INDEX.get(arr);
  if (e && e.map.size === arr.length) return e.map;
  const map = new Map<unknown, number>();
  for (let i = 0; i < arr.length; i++) map.set(arr[i]![key], i);
  INDEX.set(arr, { map, owned: true });
  return map;
}
export function ownIndex(arr: Rec[], key: string): Map<unknown, number> {
  indexOf(arr, key);
  const e = INDEX.get(arr)!;
  if (!e.owned) (e.map = new Map(e.map)), (e.owned = true);
  return e.map;
}
export function posOf(arr: readonly Rec[], key: string, id: unknown): number {
  let i = indexOf(arr, key).get(id);
  if (i !== undefined && arr[i]?.[key] !== id) {
    INDEX.delete(arr); // the array was changed behind our back
    i = indexOf(arr, key).get(id);
  }
  return i ?? -1;
}

/** An owned shallow copy: collection arrays copied (index maps shared copy-on-write), records shared. */
export function fork(doc: Doc, schema: Schema): Doc {
  const out: Doc = { ...doc };
  for (const name in schema.collections) {
    const a = doc[name] as Rec[] | undefined;
    if (!Array.isArray(a)) continue;
    const c = (out[name] = a.slice());
    const e = INDEX.get(a);
    if (e && e.map.size === a.length) {
      e.owned = false;
      INDEX.set(c, { map: e.map, owned: false });
    }
  }
  return out;
}

export function walk(node: unknown, spec: FieldSpec, segs: Path, from = 0): unknown {
  for (let i = from; i < segs.length && node !== undefined; i++) {
    const seg = segs[i];
    if (spec.kind === "keyed" && Array.isArray(node)) {
      const key = spec.key;
      node = node.find((e) => (e as Rec | null)?.[key] === seg);
      spec = spec.elem;
    } else {
      node = isObj(node) ? node[seg as string] : undefined;
      spec = fieldOf(spec, seg) ?? DEEP;
    }
  }
  return node;
}

/** The value at `path` (records by id through a cached index; keyed arrays by key). */
export function getIn(doc: Doc, path: Path, schema: Schema): unknown {
  const cs = schema.collections[path[0] as string];
  if (!cs) return walk(doc[path[0] as string], schema.root.fields[path[0] as string] ?? DEEP, path, 1);
  if (path.length === 1) return doc[path[0] as string];
  const arr = (doc[path[0] as string] as Rec[] | undefined) ?? EMPTY;
  const i = posOf(arr, cs.key, path[1]);
  return i < 0 ? undefined : walk(arr[i], cs.record, path, 2);
}

/** Strip ephemeral fields from a record value, recursively by spec. Returns the same object when nothing changes. */
export function stripEphemeral<T>(v: T, spec: FieldSpec): T {
  if (!isObj(v) || spec.kind !== "object") return v;
  let out: Record<string, unknown> | null = null;
  for (const k in v) {
    const cs = childSpec(spec, k, v[k], v[k]);
    if (cs.kind === "ephemeral") (out ??= { ...v }), delete out[k];
    else if (cs.kind === "object" && isObj(v[k])) {
      const s = stripEphemeral(v[k], cs);
      if (s !== v[k]) (out ??= { ...v })[k] = s;
    }
  }
  return (out ?? v) as T;
}
