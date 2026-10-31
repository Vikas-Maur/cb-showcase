// describe (PLAN §9, layer 1): one short sentence per changed record (plus one per remap step), e.g.
// "Trimmed 'Intro' end 6.0 s → 5.0 s". Never prints more than four parts per record.
import { POS } from "../types.ts";
import type { Schema } from "../schema.ts";
import type { Doc, Intent, Op, Rec, RemapMaps, RemapOp } from "../types.ts";
import { getIn } from "./doc.ts";
import { EMPTY } from "./json.ts";
import { composeMaps, inferRemaps, near, remapSpan } from "./remap.ts";

type PlainOp = Exclude<Op, RemapOp>;
const fmtS = (x: number) => `${(+x).toFixed(1)} s`;
const fmtT = (x: number) => (x < 60 ? fmtS(x) : `${Math.floor(x / 60)}:${(x % 60).toFixed(1).padStart(4, "0")}`);
const short = (v: unknown): string => {
  const s = typeof v === "string" ? JSON.stringify(v.length > 40 ? v.slice(0, 37) + "…" : v) : JSON.stringify(v);
  return s === undefined ? "none" : s.length > 48 ? s.slice(0, 45) + "…" : s;
};

export function describe(ops: readonly Op[], base: Doc, schema: Schema, intent: Intent | null = null): string[] {
  const tl = schema.timeline,
    out: string[] = [];
  const label = (coll: string, rec: Rec | undefined) => schema.label?.(coll, rec) ?? String(rec?.name ?? rec?.id ?? "?");
  const laneName = (id: unknown) => {
    const t = tl && (getIn(base, [tl.lanes, id as string], schema) as Rec | undefined);
    return t ? `'${label(tl!.lanes, t)}'` : `track ${String(id).slice(0, 6)}`;
  };
  const plain = ops.filter((op): op is PlainOp => op.op !== "remap");
  const remapOps = ops.filter((op): op is RemapOp => op.op === "remap");
  let maps: RemapMaps = intent?.maps ?? (tl && !remapOps.length ? inferRemaps(schema, base, plain.map((op) => ({ path: op.path, op }))) : {});
  if (remapOps.length && !intent?.maps) maps = composeMaps(...remapOps.map((op) => op.maps));
  const explained = new Set<unknown>();
  for (const [lane, chain] of Object.entries(maps)) {
    if (!tl) break;
    for (const it of (base[tl.collection] as Rec[] | undefined) ?? EMPTY) {
      if (it[tl.lane] !== lane) continue;
      const sp = remapSpan(chain, it[tl.start] as number, it[tl.end] as number);
      if (sp && !near(sp[0], it[tl.start] as number)) explained.add(it[schema.collections[tl.collection]!.key]);
    }
    for (const st of chain) {
      for (const [a, b] of st.d) out.push(`Removed ${fmtS(b - a)} from ${laneName(lane)} at ${fmtT(a)} (later items pulled left)`);
      for (const [p, len] of st.i) out.push(`Inserted ${fmtS(len)} into ${laneName(lane)} at ${fmtT(p)} (later items pushed right)`);
    }
  }
  const groups = new Map<string, { coll: string | null; id: unknown; ops: PlainOp[] }>();
  for (const op of plain) {
    const cs = schema.collections[op.path[0] as string];
    const k = cs ? op.path[0] + "/" + op.path[1] : String(op.path[0]);
    let g = groups.get(k);
    if (!g) groups.set(k, (g = { coll: cs ? (op.path[0] as string) : null, id: op.path[1], ops: [] }));
    g.ops.push(op);
  }
  const val = (op: PlainOp | undefined) => (op as { value?: unknown } | undefined)?.value as number;
  for (const g of groups.values()) {
    if (!g.coll) {
      for (const op of g.ops) {
        const old = getIn(base, op.path, schema);
        out.push(op.op === "unset" ? `Cleared ${op.path.join(".")}` : `Changed ${op.path.join(".")} ${short(old)} → ${short((op as { value: unknown }).value)}`);
      }
      continue;
    }
    const before = getIn(base, [g.coll, g.id as string], schema) as Rec | undefined;
    const whole = g.ops.find((op) => op.path.length === 2);
    const noun = g.coll === tl?.lanes ? "track" : (((before ?? (whole as { value?: Rec } | undefined)?.value) as Rec | undefined)?.type as string | undefined) ?? "item";
    if (whole?.op === "insert") {
      const r = whole.value as Rec;
      const where = tl && g.coll === tl.collection ? ` on ${laneName(r[tl.lane])} at ${fmtT(r[tl.start] as number)}` : "";
      out.push(`Added ${noun} '${label(g.coll, r)}'${where}`);
      continue;
    }
    if (whole) {
      out.push(`Deleted ${noun} '${label(g.coll, before)}'`);
      continue;
    }
    const name = `'${label(g.coll, before)}'`;
    const f = new Map<string, PlainOp>();
    for (const op of g.ops) if (op.path.length === 3) f.set(op.path[2] as string, op);
    const parts: string[] = [];
    let rest = g.ops;
    if (g.coll === tl?.lanes && f.get(POS)) {
      parts.push(`Reordered ${noun} ${name}`);
      rest = rest.filter((op) => op !== f.get(POS));
    }
    if (tl && g.coll === tl.collection && before) {
      const s = f.get(tl.start),
        e = f.get(tl.end),
        ln = f.get(tl.lane);
      const used = new Set([s, e, ln, f.get(tl.source), f.get(tl.sourceEnd)].filter(Boolean));
      const os = before[tl.start] as number,
        oe = before[tl.end] as number;
      if (explained.has(g.id)) used.add(s).add(e);
      else if (s && e && Math.abs(val(s) - os - (val(e) - oe)) < 1e-4) parts.push(`Moved ${name} ${fmtT(os)} → ${fmtT(val(s))}`);
      else if (s && e) parts.push(`Retimed ${name} ${fmtT(os)}–${fmtT(oe)} → ${fmtT(val(s))}–${fmtT(val(e))}`);
      else if (e) parts.push(`Trimmed ${name} end ${fmtS(oe)} → ${fmtS(val(e))}`);
      else if (s) parts.push(`Trimmed ${name} start ${fmtS(os)} → ${fmtS(val(s))}`);
      else if (f.get(tl.source)) parts.push(`Slipped ${name} source in ${fmtS(before[tl.source] as number)} → ${fmtS(val(f.get(tl.source)))}`);
      if (ln) parts.push(parts.length ? `to track ${laneName(val(ln))}` : `Moved ${name} to track ${laneName(val(ln))}`);
      rest = g.ops.filter((op) => !used.has(op));
    }
    for (const op of rest) {
      const field = op.path.slice(2).join(".");
      if (op.op === "insert") parts.push(`added ${op.path[2]} ${short(op.path.at(-1))}`);
      else if (op.op === "remove") parts.push(`removed ${op.path[2]} ${short(op.path.at(-1))}`);
      else if (op.path.at(-1) === POS) parts.push(`reordered ${op.path[2]}`);
      else if (op.op === "unset") parts.push(`cleared ${field}`);
      else parts.push(`${field} ${short(getIn(base, op.path, schema))} → ${short(op.value)}`);
    }
    if (!parts.length) continue;
    if (parts.length > 4) parts.splice(3, parts.length - 3, `and ${parts.length - 3} more changes`);
    const p0 = parts[0]!;
    if (!/^[A-Z]/.test(p0)) parts[0] = /^(added|removed|reordered|cleared) /.test(p0) ? `${p0[0]!.toUpperCase()}${p0.slice(1)} on ${name}` : `Changed ${name} ${p0}`;
    out.push(parts.join(", "));
  }
  return out;
}
