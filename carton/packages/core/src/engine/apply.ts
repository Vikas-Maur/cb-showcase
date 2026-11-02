// apply (PLAN §4.4): total and deterministic. A set or unset under a record or element that doesn't exist is a no-op
// (reported in `notes` as {op, lost: "missing"}); removing an absent record or unsetting an absent path is a no-op;
// an insert of an existing id replaces it (the sequencer rejects that case before apply); a remap op expands against
// the doc as it is at that point. Ownership: collection arrays are mutated in place, records are path-copied; what is
// written into a sealed array (doc.ts: a state Carton has handed out) is frozen with it.
import { POS } from "../types.ts";
import type { FieldSpec, Schema } from "../schema.ts";
import type { ApplyNote, Doc, Op, Path, Rec } from "../types.ts";
import { DEEP, freezeDeep, isSealed, ownIndex, posOf } from "./doc.ts";
import { isObj } from "./json.ts";
import { byPos } from "./keys.ts";
import { expandRemap } from "./remap.ts";

export function apply(doc: Doc, ops: readonly Op[], schema: Schema, notes: ApplyNote[] | null = null): Doc {
  for (const op of ops) {
    if (op.op === "remap") for (const x of expandRemap(schema, doc, op)) applyOne(doc, x, schema, notes);
    else applyOne(doc, op, schema, notes);
  }
  return doc;
}

const MISSING = Symbol("missing");
type Edited = unknown | typeof MISSING;

function applyOne(doc: Doc, op: Exclude<Op, { op: "remap" }>, schema: Schema, notes: ApplyNote[] | null): void {
  const p = op.path,
    head = p[0] as string,
    cs = schema.collections[head];
  if (!cs) {
    const spec = schema.root.fields[head] ?? DEEP;
    if (p.length > 1) {
      const r = edit(doc[head], spec, p, 1, op);
      if (r === MISSING) notes?.push({ op, lost: "missing" });
      else doc[head] = r;
    } else if (op.op === "set" || op.op === "insert") doc[head] = op.value;
    else delete doc[head];
    return;
  }
  const arr = (doc[head] ?? (doc[head] = [])) as Rec[];
  const key = cs.key,
    id = p[1];
  if (p.length === 2) {
    const i = posOf(arr, key, id);
    if (op.op === "insert" || op.op === "set") {
      if (i < 0) {
        ownIndex(arr, key).set(id, arr.length);
        arr.push(op.value as Rec);
      } else arr[i] = op.value as Rec;
      if (isSealed(arr)) freezeDeep(op.value);
    } else if (i >= 0) {
      // swap-remove: collections are unordered, so O(1)
      const m = ownIndex(arr, key);
      const last = arr.length - 1;
      if (i !== last) {
        arr[i] = arr[last]!;
        m.set(arr[i]![key], i);
      }
      arr.pop();
      m.delete(id);
    }
    return;
  }
  const i = posOf(arr, key, id);
  if (i < 0) return void notes?.push({ op, lost: "missing" });
  const r = edit(arr[i], cs.record, p, 2, op);
  if (r === MISSING) notes?.push({ op, lost: "missing" });
  else {
    arr[i] = r as Rec;
    if (isSealed(arr)) freezeDeep(r); // the path copy and the op's value; the record's untouched parts are frozen
  }
}

function sortedInsert(arr: Rec[], el: Rec, key: string): Rec[] {
  const c = byPos(key);
  let lo = 0,
    hi = arr.length;
  while (lo < hi) {
    const m = (lo + hi) >> 1;
    if (c(arr[m]!, el) < 0) lo = m + 1;
    else hi = m;
  }
  arr.splice(lo, 0, el);
  return arr;
}

// A path-copied node with op applied at path[i..] (MISSING if a sequence element is absent).
function edit(node: unknown, spec: FieldSpec, path: Path, i: number, op: Exclude<Op, { op: "remap" }>): Edited {
  const seg = path[i]!,
    last = i === path.length - 1;
  const value = op.op === "set" || op.op === "insert" ? op.value : undefined;
  if (spec.kind === "keyed" && (Array.isArray(node) || node === undefined)) {
    const list = (node ?? []) as Rec[];
    const key = spec.key,
      j = list.findIndex((e) => e?.[key] === seg);
    if (last) {
      if (op.op === "remove" || op.op === "unset") return j < 0 ? list : list.filter((_, x) => x !== j);
      const arr = j < 0 ? list.slice() : list.filter((_, x) => x !== j);
      return isObj(value) && POS in value ? sortedInsert(arr, value, key) : (arr.push(value as Rec), arr);
    }
    if (j < 0) return op.op === "remove" || op.op === "unset" ? list : MISSING;
    const el = edit(list[j], spec.elem, path, i + 1, op);
    if (el === MISSING) return MISSING;
    const arr = list.filter((_, x) => x !== j);
    return path[i + 1] === POS || (isObj(el) && POS in el) ? sortedInsert(arr, el as Rec, key) : (arr.splice(j, 0, el as Rec), arr);
  }
  if (!last && node !== undefined && !isObj(node) && op.op !== "set" && op.op !== "insert") return node;
  const out: Record<string, unknown> = isObj(node) ? { ...node } : {};
  const k = seg as string;
  if (last) {
    if (op.op === "set" || op.op === "insert") out[k] = value;
    else delete out[k];
    return out;
  }
  const cspec = (spec.kind === "object" || spec.kind === "keyed" ? spec.fields[k] : undefined) ?? DEEP;
  if (out[k] === undefined && (op.op === "unset" || op.op === "remove")) return out;
  const child = edit(out[k], cspec, path, i + 1, op);
  if (child === MISSING) return MISSING;
  out[k] = child;
  return out;
}
