// merge3 (PLAN §7): leaf-level conflicts; objects merged recursively; field groups merged as units with their edit
// algebra (B13); record delete vs edit and parent delete vs child add/move as cards; sequences by `#pos` (concurrent
// rebalances never raise cards); `text` by diff3; remaps through the other side's map with split lineage followed;
// hard-validator failures as cards, soft ones as warnings. Conflicts are data: every card keeps both sides' edits.
//
// How it works: each side's diff against base becomes a list of entries; detection pairs entries on the same path or
// on nested paths; conflicting entries are unioned into groups (a choice takes one side's whole subtree); the result
// is replayed on a fork of base with every group provisionally on `prefer`'s side.
import { POS } from "../types.ts";
import type { Schema, CollectionSpec, FieldGroup } from "../schema.ts";
import type {
  Choice,
  Choices,
  ConflictCard,
  ConflictKind,
  Doc,
  EditKinds,
  Lineage,
  MergeOptions,
  MergeResult,
  Op,
  Path,
  PathKey,
  Rec,
  RemapMaps,
  RemapOp,
  TextHunk,
} from "../types.ts";
import type { SoftWarning } from "../schema.ts";
import { apply } from "./apply.ts";
import { diff } from "./diff.ts";
import { diff3 } from "./diff3.ts";
import { DEEP, fork, getIn, indexOf, specAt, walk } from "./doc.ts";
import { canonical, cmp, deepEqual, isObj, pathKey, prefixKeys, EMPTY } from "./json.ts";
import { byPos, keyAfter, keysBetween, MAX_KEY } from "./keys.ts";
import { composeChain, inferRemaps, isIdentity, near, remapSpan, transformChain } from "./remap.ts";
import type { TimeAlgebra } from "./algebra.ts";

type PlainOp = Exclude<Op, RemapOp>;
const RANK: Record<ConflictKind, number> = { parent: 6, record: 5, invalid: 4, remap: 3, group: 2, text: 1, field: 1, order: 0, compare: 0 };

interface Entry {
  side: 0 | 1;
  op: PlainOp;
  path: Path;
  uf: Entry | null;
  g: Group | null;
  drop: boolean;
  dup: boolean;
  k: PathKey;
  pk: PathKey[];
}
interface Side {
  n: 0 | 1;
  entries: Entry[];
  byKey: Map<PathKey, Entry>;
  under: Map<PathKey, Entry[]>;
}
type GroupValues = { base: unknown; ours: unknown; theirs: unknown };
interface Seed {
  a: Entry;
  b?: Entry;
  path: Path;
  kind: ConflictKind;
  reason?: string;
  hunks?: TextHunk[];
  values?: () => GroupValues;
}
interface Synth {
  op: PlainOp;
  rec: PathKey;
  skip?: boolean;
}
interface Group {
  entries: Entry[];
  seeds: Seed[];
  kind: ConflictKind;
  path: Path | null;
  seed?: Seed;
  conflict?: ConflictCard;
}
interface SideRemap {
  maps: RemapMaps;
  lineage: Lineage;
  recorded: boolean;
  inferred?: boolean;
}
interface Ctx {
  schema: Schema;
  base: Doc;
  docs: [Doc, Doc];
  sides: [Side, Side];
  opts: MergeOptions;
  remaps: [SideRemap, SideRemap];
  seeds: Seed[];
  synth: Synth[];
  follow: Synth[];
  composed: PathKey[];
  mapped: PathKey[];
  warnings: SoftWarning[];
  edges: { ours: RemapMaps; theirs: RemapMaps };
}
interface MergeState {
  schema: Schema;
  base: Doc;
  ours: Doc;
  theirs: Doc;
  groups: Group[];
  ctx: Ctx;
  prefer: "ours" | "theirs";
}
const STATE = new WeakMap<MergeResult, MergeState>();

function makeSide(n: 0 | 1, base: Doc, doc: Doc, schema: Schema): Side {
  const entries: Entry[] = [];
  const byKey = new Map<PathKey, Entry>();
  const under = new Map<PathKey, Entry[]>();
  for (const op of diff(base, doc, schema) as PlainOp[]) {
    const pks = prefixKeys(op.path);
    const k = pks.pop()!;
    const e: Entry = { side: n, op, path: op.path, uf: null, g: null, drop: false, dup: false, k, pk: pks };
    entries.push(e);
    byKey.set(k, e);
    for (const pk of pks) {
      const l = under.get(pk);
      if (l) l.push(e);
      else under.set(pk, [e]);
    }
  }
  return { n, entries, byKey, under };
}

export function merge3(base: Doc, ours: Doc, theirs: Doc, schema: Schema, opts: MergeOptions = {}): MergeResult {
  const prefer = opts.prefer ?? "ours";
  const docs: [Doc, Doc] = [ours, theirs];
  const sides: [Side, Side] = [makeSide(0, base, ours, schema), makeSide(1, base, theirs, schema)];
  const sideRemap = (n: 0 | 1): SideRemap => {
    const rec = n ? opts.remaps?.theirs : opts.remaps?.ours;
    if (rec) return { maps: rec.maps ?? (rec as unknown as RemapMaps), lineage: rec.lineage ?? {}, recorded: true };
    if (opts.infer === false || !schema.timeline) return { maps: {}, lineage: {}, recorded: false };
    return { maps: inferRemaps(schema, base, sides[n].entries), lineage: {}, recorded: false, inferred: true };
  };
  const remaps: [SideRemap, SideRemap] = [sideRemap(0), sideRemap(1)];
  const ctx: Ctx = { schema, base, docs, sides, opts, remaps, seeds: [], synth: [], follow: [], composed: [], mapped: [], warnings: [], edges: { ours: {}, theirs: {} } };
  remapStage(ctx);
  groupStage(ctx);
  detect(ctx);
  parentRule(ctx);
  let { groups } = buildGroups(ctx);
  sequenceStage(ctx);
  lineageStage(ctx);
  const m: MergeState = { schema, base, ours, theirs, groups, ctx, prefer };
  // the result is replayed on a fork of base: index base once (cached on its arrays, shared by forks)
  for (const name in schema.collections) if (Array.isArray(base[name])) indexOf(base[name] as Rec[], schema.collections[name]!.key);
  let doc = apply(fork(base, schema), replayOps(m, () => prefer), schema);
  // hard validators on every touched record of the provisional doc: a failure becomes a card
  const bad = validateTouched(ctx, doc);
  if (bad.length) {
    for (const s of sides) for (const e of s.entries) (e.uf = null), (e.g = null);
    const badKeys = new Set(bad.map(pathKey));
    for (const s of ctx.synth) if (badKeys.has(s.rec)) s.skip = true;
    for (const s of ctx.follow) if (badKeys.has(s.rec)) s.skip = true;
    for (const path of bad) {
      const k = pathKey(path);
      const es = sides.flatMap((s) => [s.byKey.get(k), ...(s.under.get(k) ?? [])]).filter((e): e is Entry => !!e && !e.dup);
      if (es.length) for (const e of es) ctx.seeds.push({ a: es[0]!, b: e, path, kind: "invalid" });
    }
    ({ groups } = buildGroups(ctx));
    m.groups = groups;
    doc = apply(fork(base, schema), replayOps(m, () => prefer), schema);
  }
  if (schema.soft) ctx.warnings.push(...schema.soft(doc, touchedIds(ctx), docs, placedIds(ctx), new Set([...ctx.composed, ...ctx.mapped].map((k) => k.split("/")[1]!))));
  let ops: Op[] | null = null;
  const res: MergeResult = {
    doc,
    conflicts: groups.map((g) => g.conflict!),
    warnings: ctx.warnings,
    remaps: {
      ours: remaps[0].maps,
      theirs: remaps[1].maps,
      inferred: [!!remaps[0].inferred && Object.keys(remaps[0].maps).length > 0, !!remaps[1].inferred && Object.keys(remaps[1].maps).length > 0],
    },
    edges: ctx.edges,
    stats: { ours: sides[0].entries.length, theirs: sides[1].entries.length, composed: ctx.composed, mapped: ctx.mapped, followed: ctx.follow.length },
    // the ops that turn ours into the merge, computed on first use (commit paths diff against their own head)
    get ops() {
      return (ops ??= diff(ours, doc, schema));
    },
  };
  STATE.set(res, m);
  return res;
}

// --- remaps: per track, the merged map and each side's edge map (the other side's map in its coordinates)
function remapStage(ctx: Ctx): void {
  const { schema, remaps } = ctx;
  const [Mo, Mt] = [remaps[0].maps, remaps[1].maps];
  for (const t of new Set([...Object.keys(Mo), ...Object.keys(Mt)])) {
    const o = Mo[t] ?? [],
      th = Mt[t] ?? [];
    if (!isIdentity(th)) ctx.edges.ours[t] = transformChain(th, o);
    if (!isIdentity(o)) ctx.edges.theirs[t] = transformChain(o, th);
  }
  const tl = schema.timeline;
  if (!tl) return;
  // inserts on a remapped track go through the other side's map, expressed in their side's coordinates
  for (const s of ctx.sides) {
    const edges = s.n ? ctx.edges.theirs : ctx.edges.ours;
    for (const e of s.entries) {
      if (e.path[0] !== tl.collection || e.path.length !== 2 || e.op.op !== "insert") continue;
      const rec = e.op.value as Rec,
        chain = edges[rec[tl.lane] as string];
      if (!chain) continue;
      const span = remapSpan(chain, rec[tl.start] as number, rec[tl.end] as number);
      if (!span) ctx.seeds.push({ a: e, path: e.path, kind: "remap", reason: "inserted inside a range the other side removed" });
      else if (!near(span[0], rec[tl.start] as number) || !near(span[1], rec[tl.end] as number)) {
        e.op = { ...e.op, value: { ...rec, [tl.start]: span[0], [tl.end]: span[1] } };
        ctx.mapped.push(pathKey(e.path));
      }
    }
  }
}

// --- field groups (B13, §4.1): coupled fields merge as one unit
function groupStage(ctx: Ctx): void {
  const { schema, base, docs, sides, remaps, opts } = ctx;
  const tl = schema.timeline;
  for (const cname in schema.collections) {
    const cs = schema.collections[cname]!;
    if (!cs.groups.length) continue;
    // record id -> group name -> [ours entries, theirs entries]; plus records whose lane changed
    const touched = new Map<unknown, Map<string, [Entry[], Entry[]]>>();
    for (const s of sides)
      for (const e of s.entries) {
        if (e.path[0] !== cname || e.path.length !== 3) continue;
        const g = cs.groupOf.get(e.path[2] as string);
        const laneMove = !!tl && cname === tl.collection && e.path[2] === tl.lane;
        if (!g && !laneMove) continue;
        let t = touched.get(e.path[1]);
        if (!t) touched.set(e.path[1], (t = new Map()));
        const gname = g ? g.name : "#lane";
        let x = t.get(gname);
        if (!x) t.set(gname, (x = [[], []]));
        x[s.n].push(e);
      }
    for (const [id, byGroup] of touched) {
      const path: Path = [cname, id as string];
      const b = getIn(base, path, schema) as Rec | undefined;
      if (!b) continue;
      const recs = docs.map((d) => getIn(d, path, schema) as Rec | undefined) as [Rec | undefined, Rec | undefined];
      for (const g of cs.groups) {
        const es = byGroup.get(g.name);
        const lane = byGroup.get("#lane");
        if (!es && !lane) continue;
        const [eo, et] = es ?? [[], []];
        const isTime = !!tl && cname === tl.collection && !!g.algebra;
        const alg = g.algebra as TimeAlgebra;
        const laneOf = (n: 0 | 1): unknown => (tl ? recs[n]?.[tl.lane] ?? b[tl.lane] : undefined);
        const map = (n: 0 | 1) => remaps[n].maps[b[tl!.lane] as string];
        const edge = (n: 0 | 1) => (n ? ctx.edges.theirs : ctx.edges.ours)[laneOf(n) as string];
        const remapOnly = (n: 0 | 1): boolean => {
          if (!isTime || !recs[n] || laneOf(n) !== b[tl!.lane]) return false;
          const c = map(n);
          if (isIdentity(c)) return false;
          const span = remapSpan(c, b[tl!.start] as number, b[tl!.end] as number);
          const B = alg.get(b),
            X = alg.get(recs[n]!);
          return !!span && near(X.s, span[0]) && near(X.e, span[1]) && near(X.a, B.a) && near(X.b, B.b) && near(X.v, B.v) && !(near(X.s, B.s) && near(X.e, B.e));
        };
        const emit = (vals: Record<string, unknown>): void => {
          for (const f of g.fields) {
            let v = vals[f];
            if (f === tl?.speed && v === 1 && b[f] === undefined && recs.every((r) => r?.[f] === undefined)) v = undefined;
            if (v !== undefined) ctx.synth.push({ op: { op: "set", path: [cname, id as string, f], value: v }, rec: pathKey(path) });
            else if (b[f] !== undefined) ctx.synth.push({ op: { op: "unset", path: [cname, id as string, f] }, rec: pathKey(path) });
          }
        };
        const consume = (vals: Parameters<TimeAlgebra["put"]>[0], how: "mapped" | "composed"): void => {
          for (const e of [...eo, ...et]) e.drop = true;
          emit(alg.put(vals));
          (how === "mapped" ? ctx.mapped : ctx.composed).push(pathKey(path));
        };
        const card = (kind: ConflictKind, reason: string): void => {
          const all = [...eo, ...et];
          const vpath: Path = [cname, id as string, "#" + g.name];
          for (const e of all) ctx.seeds.push({ a: all[0]!, b: e, path: vpath, kind, reason, values: () => groupValues(ctx, path, g) });
        };
        // a side that removed the record: the other side's pure remap shift is explained (clean delete)
        if (!recs[0] || !recs[1]) {
          for (const n of [0, 1] as const) if (!recs[1 - n] && recs[n] && remapOnly(n)) for (const e of n ? et : eo) e.drop = true;
          continue;
        }
        const r0 = recs[0],
          r1 = recs[1];
        if (!isTime) {
          if (eo.length && et.length) {
            const same = g.fields.every((f) => deepEqual(r0[f], r1[f]));
            if (same) for (const e of et) e.dup = true;
            else card("group", "both sides changed coupled fields");
          }
          continue;
        }
        const T = tl!;
        const changed = [eo.length > 0, et.length > 0];
        if (changed[0] !== changed[1]) {
          // one side changed the clip's times (or moved it to another lane): bring its values through the other
          // side's map, expressed in its coordinates
          const n: 0 | 1 = changed[0] ? 0 : 1;
          const c = edge(n);
          if (isIdentity(c) || remapOnly(n)) continue;
          const X = alg.get(recs[n]!);
          const span = remapSpan(c, X.s, X.e);
          if (!span) {
            card("remap", "the clip's new times fall inside a range the other side removed");
            continue;
          }
          if (near(span[0], X.s) && near(span[1], X.e)) continue;
          for (const e of n ? et : eo) e.drop = true;
          emit({ ...Object.fromEntries(g.fields.map((f) => [f, recs[n]![f]])), [T.start]: span[0], [T.end]: span[1] });
          ctx.mapped.push(pathKey(path));
          continue;
        }
        if (!changed[0]) {
          // only the lane changed (on one or both sides): map that side's times onto the new lane
          for (const n of [0, 1] as const) {
            if (!lane?.[n]?.length || recs[n]![T.lane] === b[T.lane]) continue;
            const c = edge(n);
            if (isIdentity(c)) continue;
            const span = remapSpan(c, b[T.start] as number, b[T.end] as number);
            if (!span) card("remap", "the clip moved into a range the other side removed");
            else if (!near(span[0], b[T.start] as number) || !near(span[1], b[T.end] as number)) {
              ctx.synth.push(
                { op: { op: "set", path: [cname, id as string, T.start], value: span[0] }, rec: pathKey(path) },
                { op: { op: "set", path: [cname, id as string, T.end], value: span[1] }, rec: pathKey(path) },
              );
              ctx.mapped.push(pathKey(path));
            }
          }
          continue;
        }
        // both sides changed the time group
        const ro = remapOnly(0),
          rt = remapOnly(1);
        if (ro && rt) {
          const merged = composeChain(map(0), ctx.edges.ours[b[T.lane] as string]);
          const span = remapSpan(merged, b[T.start] as number, b[T.end] as number);
          if (!span) card("remap", "both remaps disagree on this clip");
          else consume({ ...alg.get(b), s: span[0], e: span[1] }, "mapped");
          continue;
        }
        if (ro || rt) {
          const n: 0 | 1 = ro ? 1 : 0; // the side with a real edit, chosen in its own coordinates
          const X = alg.get(recs[n]!);
          const c = edge(n);
          const span = isIdentity(c) ? ([X.s, X.e] as [number, number]) : remapSpan(c, X.s, X.e);
          if (!span) card("remap", "the edited clip falls inside a range the other side removed");
          else consume({ ...X, s: span[0], e: span[1] }, "mapped");
          continue;
        }
        if (!isIdentity(map(0)) || !isIdentity(map(1))) {
          if (deepEqual(g.fields.map((f) => r0[f]), g.fields.map((f) => r1[f]))) for (const e of et) e.dup = true;
          else card("group", "a remap and a retime of the same clip");
          continue;
        }
        if (opts.algebra === false) {
          if (g.fields.every((f) => deepEqual(r0[f], r1[f]))) for (const e of et) e.dup = true;
          else card("group", "both sides changed the clip's times");
          continue;
        }
        const r = alg.merge(b, r0, r1, (opts.kinds?.ours as EditKinds | undefined)?.[id as string], (opts.kinds?.theirs as EditKinds | undefined)?.[id as string]);
        if (r.ok && r.how === "equal") for (const e of et) e.dup = true;
        // §7: a retime of a clip the other side split raises a card rather than move or trim one piece
        else if (remaps.some((x) => (x.lineage[id as string]?.length ?? 0) > 1)) card("group", "a retime of a clip the other side split");
        else if (r.ok) consume(r.vals as Parameters<TimeAlgebra["put"]>[0], "composed");
        else card("group", r.reason);
      }
    }
  }
}

function groupValues(ctx: Ctx, path: Path, g: FieldGroup): GroupValues {
  const v = (d: Doc) => {
    const r = getIn(d, path, ctx.schema) as Rec | undefined;
    return r ? Object.fromEntries(g.fields.filter((f) => r[f] !== undefined).map((f) => [f, r[f]])) : null;
  };
  return { base: v(ctx.base), ours: v(ctx.docs[0]), theirs: v(ctx.docs[1]) };
}

function sameOp(a: PlainOp, b: PlainOp): boolean {
  if (a.op !== b.op) return false;
  return a.op === "remove" || a.op === "unset" || deepEqual((a as { value: unknown }).value, (b as { value: unknown }).value);
}

function detect(ctx: Ctx): void {
  const [O, T] = ctx.sides,
    seeds = ctx.seeds;
  const isRecord = (p: Path) => p.length === 2 && !!ctx.schema.collections[p[0] as string];
  const rk = (e: Entry) => e.op.op === "set" && !!e.op.rk;
  const pair = (o: Entry, t: Entry): void => {
    if (o.drop || t.drop) return;
    if (rk(o) || rk(t)) {
      if (rk(o) && rk(t)) return; // concurrent rebalances: the sequence stage picks one
      return void ((rk(o) ? o : t).drop = true); // a move beats a re-key
    }
    if (sameOp(o.op, t.op)) return void (t.dup = true);
    if (o.path.at(-1) === POS && o.op.op === "set" && t.op.op === "set" && o.op.nb && deepEqual(o.op.nb, t.op.nb)) {
      // the same move made twice: keep one key (the smaller, so the result is side-independent)
      if ((t.op.value as string) < (o.op.value as string)) o.op = { ...o.op, value: t.op.value };
      return void (t.dup = true);
    }
    const spec = specAt(ctx.schema, o.path);
    if (spec?.kind === "leaf" && spec.text && o.op.op === "set" && t.op.op === "set" && typeof o.op.value === "string" && typeof t.op.value === "string") {
      const b = getIn(ctx.base, o.path, ctx.schema);
      const r = diff3(typeof b === "string" ? b : "", o.op.value, t.op.value);
      if (!r.hunks.length) {
        o.op = { ...o.op, value: r.text };
        return void (t.dup = true);
      }
      return void seeds.push({ a: o, b: t, path: o.path, kind: "text", hunks: r.hunks });
    }
    seeds.push({ a: o, b: t, path: o.path, kind: o.path.at(-1) === POS ? "order" : isRecord(o.path) ? "record" : "field" });
  };
  const nest = (anc: Entry, desc: Entry): void => {
    if (anc.drop || desc.drop) return;
    if (rk(desc)) return void (desc.drop = true); // re-key of an element the other side removed or replaced
    if (consistent(ctx.schema, anc, desc)) return void (desc.dup = true);
    seeds.push({ a: anc, b: desc, path: anc.path, kind: anc.op.op === "remove" && isRecord(anc.path) ? "record" : "field" });
  };
  for (const t of T.entries) {
    const o = O.byKey.get(t.k);
    if (o) pair(o, t);
    for (const pk of t.pk) {
      const a = O.byKey.get(pk);
      if (a) nest(a, t);
    }
    const ds = O.under.get(t.k);
    if (ds) for (const d of ds) nest(t, d);
  }
}

// is desc's change already implied by its ancestor anc's change?
function consistent(schema: Schema, anc: Entry, desc: Entry): boolean {
  const a = anc.op,
    d = desc.op;
  if (a.op === "remove" || a.op === "unset") return d.op === "remove" || d.op === "unset";
  const v = walk(a.value, specAt(schema, anc.path) ?? DEEP, desc.path, anc.path.length);
  if (d.op === "remove" || d.op === "unset") return v === undefined;
  return deepEqual(v, d.value);
}

// Removing a parent (track) while the other side inserts a child onto it or moves one there.
function parentRule(ctx: Ctx): void {
  const { schema, sides, base, seeds } = ctx;
  for (const cname in schema.collections) {
    const cs = schema.collections[cname]!;
    if (!cs.parent) continue;
    const { field, collection: pc } = cs.parent;
    const removedBy = sides.map((s) => {
      const m = new Map<unknown, Entry>();
      for (const e of s.entries) if (e.path.length === 2 && e.path[0] === pc && e.op.op === "remove") m.set(e.path[1], e);
      return m;
    });
    for (const [x, y] of [
      [0, 1],
      [1, 0],
    ] as const) {
      if (!removedBy[x]!.size) continue;
      for (const f of sides[y].entries) {
        if (f.path[0] !== cname) continue;
        let target: unknown,
          move = false;
        if (f.path.length === 2 && f.op.op === "insert") target = (f.op.value as Rec | undefined)?.[field];
        else if (f.path.length === 3 && f.path[2] === field && f.op.op === "set") (target = f.op.value), (move = true);
        const r = target !== undefined && removedBy[x]!.get(target);
        if (!r) continue;
        seeds.push({ a: r, b: f, path: r.path, kind: "parent" });
        const old = move && (getIn(base, [cname, f.path[1]!], schema) as Rec | undefined)?.[field];
        const or = old !== undefined && old !== false && removedBy[y]!.get(old);
        if (or) seeds.push({ a: or, b: f, path: or.path, kind: "parent" });
      }
    }
  }
}

const ufInit = (e: Entry): Entry => (e.uf ??= e);
function ufFind(e: Entry): Entry {
  let r = e;
  while (r.uf !== r) r = r.uf!;
  while (e.uf !== r) {
    const n = e.uf!;
    e.uf = r;
    e = n;
  }
  return r;
}
function ufUnion(a: Entry, b: Entry): void {
  const ra = ufFind(ufInit(a)),
    rb = ufFind(ufInit(b));
  if (ra !== rb) rb.uf = ra;
}

function buildGroups(ctx: Ctx): { groups: Group[] } {
  const { schema, base, sides, seeds } = ctx;
  for (const s of seeds) {
    ufInit(s.a);
    if (s.b) ufUnion(s.a, s.b);
  }
  // Every op at or under a conflicting path joins its group, so a choice takes one side's whole subtree.
  const roots = new Map<PathKey, { path: Path; entry: Entry }>();
  const addRoot = (path: Path, entry: Entry): boolean => {
    const k = pathKey(path),
      r = roots.get(k);
    if (r) ufUnion(r.entry, entry);
    else roots.set(k, { path, entry });
    return !r;
  };
  for (const s of seeds) addRoot(s.path, s.a);
  // A removed parent in a group drags in the children its remover removed with it, and a removed child whose remover
  // also removed its parent joins the parent's group (else a choice could dangle).
  const work = [...roots.values()];
  const kids = new Map<string, Map<unknown, unknown[]>>();
  while (work.length) {
    const { path, entry } = work.pop()!;
    if (path.length !== 2) continue;
    for (const cname in schema.collections) {
      const cs = schema.collections[cname]!;
      if (!cs.parent) continue;
      const { field, collection: pc } = cs.parent;
      for (const s of sides) {
        const e = s.byKey.get(pathKey(path));
        if (e?.op.op !== "remove") continue;
        if (path[0] === pc) {
          if (!kids.has(cname)) kids.set(cname, childIndex(base, cname, cs));
          for (const cid of kids.get(cname)!.get(path[1]) ?? []) {
            const cp: Path = [cname, cid as string],
              ce = s.byKey.get(pathKey(cp));
            if (ce?.op.op !== "remove") continue;
            ufUnion(entry, ce);
            if (addRoot(cp, ce)) work.push(roots.get(pathKey(cp))!);
          }
        } else if (path[0] === cname) {
          const rec = getIn(base, path, schema) as Rec | undefined;
          const pp: Path = [pc, rec?.[field] as string],
            pe = rec && s.byKey.get(pathKey(pp));
          if (!pe || pe.op.op !== "remove") continue;
          ufUnion(entry, pe);
          if (addRoot(pp, pe)) work.push(roots.get(pathKey(pp))!);
        }
      }
    }
  }
  for (const s of sides)
    for (const e of s.entries) {
      let r = roots.get(e.k);
      if (r) ufUnion(r.entry, e);
      for (const pk of e.pk) if ((r = roots.get(pk))) ufUnion(r.entry, e);
    }
  const byRoot = new Map<Entry, Group>();
  for (const s of sides)
    for (const e of s.entries) {
      if (!e.uf) continue;
      const r = ufFind(e);
      let g = byRoot.get(r);
      if (!g) byRoot.set(r, (g = { entries: [], seeds: [], kind: "field", path: null }));
      g.entries.push(e);
      e.g = g;
    }
  for (const s of seeds) {
    const g = s.a.g!;
    g.seeds.push(s);
    if (!g.path || RANK[s.kind] > RANK[g.kind] || (RANK[s.kind] === RANK[g.kind] && s.path.length < g.path.length)) {
      g.kind = s.kind;
      g.path = s.path;
      g.seed = s;
    }
  }
  const groups = [...byRoot.values()];
  for (const g of groups) g.conflict = conflictOf(g, ctx);
  return { groups };
}

function childIndex(base: Doc, cname: string, cs: CollectionSpec): Map<unknown, unknown[]> {
  const m = new Map<unknown, unknown[]>(),
    f = cs.parent!.field;
  for (const r of (base[cname] as Rec[] | undefined) ?? EMPTY) {
    const l = m.get(r[f]);
    if (l) l.push(r[cs.key]);
    else m.set(r[f], [r[cs.key]]);
  }
  return m;
}

const nul = (v: unknown): unknown => (v === undefined ? null : v);
function conflictOf(g: Group, { base, docs, schema }: Ctx): ConflictCard {
  const path = g.path!;
  const vals = g.seed?.values?.();
  const c: ConflictCard = {
    kind: g.kind,
    path: pathKey(path),
    base: vals ? vals.base : nul(getIn(base, path, schema)),
    ours: vals ? vals.ours : nul(getIn(docs[0], path, schema)),
    theirs: vals ? vals.theirs : nul(getIn(docs[1], path, schema)),
  };
  if (g.seed?.reason) c.reason = g.seed.reason;
  if (g.seed?.hunks) c.hunks = g.seed.hunks;
  const related = [...new Set(g.entries.map((e) => pathKey(e.path)))].filter((k) => k !== c.path);
  if (related.length) c.related = related;
  return c;
}

// --- sequences: when one side re-keyed (rebalanced) a sequence, the other side's inserts and moves were keyed against
// keys that no longer exist, so they are re-keyed from their neighbour ids. Concurrent rebalances never raise cards:
// one wins (opts.rekeys, or by content), the other drops.
function sequenceStage(ctx: Ctx): void {
  const { schema, sides, base, docs, opts } = ctx;
  type SeqSide = { rk: Map<unknown, Entry>; movers: Entry[] };
  const seqs = new Map<PathKey, { path: Path; sides: [SeqSide, SeqSide] }>();
  const elemId = (e: Entry): unknown => (e.op.op === "insert" ? e.path.at(-1) : e.path.at(-2));
  for (const s of sides)
    for (const e of s.entries) {
      let sp: Path, id: unknown;
      const last = e.path.at(-1);
      if (e.op.op === "set" && last === POS) (sp = e.path.slice(0, -2)), (id = e.path.at(-2));
      else if (e.op.op === "insert" && e.op.nb) (sp = e.path.slice(0, -1)), (id = e.path.at(-1));
      else continue;
      const k = pathKey(sp);
      let x = seqs.get(k);
      if (!x)
        seqs.set(
          k,
          (x = {
            path: sp,
            sides: [
              { rk: new Map(), movers: [] },
              { rk: new Map(), movers: [] },
            ],
          }),
        );
      if (e.op.op === "set" && e.op.rk) x.sides[s.n].rk.set(id, e);
      else x.sides[s.n].movers.push(e);
    }
  for (const x of seqs.values()) {
    const [so, st] = x.sides;
    const live = (m: Map<unknown, Entry>) => [...m.values()].filter((e) => !e.drop && !e.g);
    const rkO = live(so.rk),
      rkT = live(st.rk);
    if (!rkO.length && !rkT.length) continue;
    const key = x.path.length === 1 ? schema.collections[x.path[0] as string]!.key : (specAt(schema, x.path) as { key: string }).key;
    let win: 0 | 1 | null = rkO.length && !rkT.length ? 0 : rkT.length && !rkO.length ? 1 : null;
    if (win === null) {
      if (opts.rekeys === "ours") win = 0;
      else if (opts.rekeys === "theirs") win = 1;
      else {
        const sig = (l: Entry[]) => canonical(l.map((e) => [e.path.at(-2), (e.op as { value: unknown }).value]).sort((a, b) => cmp(a[0], b[0])));
        const so2 = sig(rkO),
          st2 = sig(rkT);
        // identical rebalances: both sides keyed against the same new keys, nothing to re-key
        if (so2 === st2) continue;
        win = so2 < st2 ? 0 : 1;
      }
      for (const e of win ? rkO : rkT) e.drop = true;
    }
    const lose: 0 | 1 = win ? 0 : 1;
    // final keys: base, overridden by surviving ops of both sides
    const elems = (d: Doc): Rec[] => ((x.path.length === 1 ? d[x.path[0] as string] : getIn(d, x.path, schema)) as Rec[] | undefined) ?? [];
    const keyOf = new Map<unknown, string>(elems(base).map((el) => [el[key], el[POS] as string]));
    const present = new Set<unknown>(keyOf.keys());
    const xk = pathKey(x.path);
    const inSeq = (e: Entry) => e.path.length === x.path.length + 1 && pathKey(e.path.slice(0, -1)) === xk;
    for (const s of sides)
      for (const e of s.entries) {
        if (!inSeq(e)) continue;
        if (e.op.op === "remove" && !e.g) present.delete(e.path.at(-1));
      }
    const finalOps: Synth[] = [];
    for (const n of [win, lose])
      for (const e of [...x.sides[n].rk.values(), ...x.sides[n].movers]) {
        if (e.drop || e.dup || e.g) continue;
        const id = elemId(e);
        keyOf.set(id, e.op.op === "insert" ? ((e.op.value as Rec)[POS] as string) : ((e.op as { value: unknown }).value as string));
        present.add(id);
      }
    // re-key the losing side's movers in that side's own order
    const loseOrder = [...elems(docs[lose])].sort(byPos(key)).map((el) => el[key]);
    const movers = new Map(x.sides[lose].movers.filter((e) => !e.drop && !e.dup && !e.g).map((e) => [elemId(e), e]));
    const inserted = new Set([...movers.values()].filter((e) => e.op.op === "insert").map((e) => e.path.at(-1)));
    const done = new Set<unknown>();
    loseOrder.forEach((id, i) => {
      const e = movers.get(id);
      if (!e) return;
      let l: unknown = null,
        r: unknown = null;
      for (let j = i - 1; j >= 0; j--)
        if (present.has(loseOrder[j]) && (!movers.has(loseOrder[j]) || done.has(loseOrder[j]))) {
          l = loseOrder[j];
          break;
        }
      for (let j = i + 1; j < loseOrder.length; j++)
        if (present.has(loseOrder[j]) && !movers.has(loseOrder[j])) {
          r = loseOrder[j];
          break;
        }
      const kl = l === null ? null : keyOf.get(l) ?? null;
      let kr = r === null ? null : keyOf.get(r) ?? null;
      if (kl != null && kr != null && !(kl < kr)) {
        // the neighbours were reordered by the other side: place right after the left neighbour
        const after = [...present]
          .map((p) => keyOf.get(p))
          .filter((k): k is string => k !== undefined && k > kl)
          .sort();
        kr = after[0] ?? null;
      }
      const nk = keyAfter(kl, kr, id, l !== null && inserted.has(l as string));
      keyOf.set(id, nk);
      done.add(id);
      e.op = e.op.op === "insert" ? { ...e.op, value: { ...(e.op.value as Rec), [POS]: nk } } : ({ ...e.op, value: nk } as PlainOp);
    });
    // still too long anywhere? rebalance the merged order (deterministic, order-preserving)
    const order = [...present].sort((a, b) => cmp(keyOf.get(a), keyOf.get(b)) || cmp(a, b));
    if (order.some((id) => (keyOf.get(id) ?? "").length > MAX_KEY)) {
      const ks = keysBetween("", null, order.length);
      const ins = new Map<unknown, Entry>();
      for (const s of sides) for (const e of s.entries) if (e.op.op === "insert" && inSeq(e) && !e.drop && !e.dup) ins.set(e.path.at(-1), e);
      order.forEach((id, n) => {
        const e = ins.get(id);
        if (e) e.op = { ...(e.op as { op: "insert"; path: Path; value: unknown }), value: { ...((e.op as { value: Rec }).value), [POS]: ks[n] } };
        else finalOps.push({ op: { op: "set", path: [...x.path, id as string, POS], value: ks[n], rk: true }, rec: xk });
      });
    }
    ctx.synth.push(...finalOps);
  }
}

// --- lineage: a side that split a clip recorded old id -> pieces; the other side's clean edits of that clip's other
// fields follow to every piece (its time edits on the split clip are cards above).
function lineageStage(ctx: Ctx): void {
  const { schema, sides, remaps, docs } = ctx;
  const tl = schema.timeline;
  if (!tl) return;
  for (const n of [0, 1] as const) {
    const lin = remaps[n].lineage ?? {};
    for (const [oldId, pieces] of Object.entries(lin)) {
      const other = sides[n ? 0 : 1];
      for (const e of other.under.get(pathKey([tl.collection, oldId])) ?? []) {
        if (e.g || e.drop || e.dup || e.path.length < 3) continue;
        const f = e.path[2] as string;
        if (schema.collections[tl.collection]!.groupOf.get(f)) continue;
        for (const pc of pieces as (string | { id: string })[]) {
          const pid = typeof pc === "string" ? pc : pc.id;
          if (pid === oldId || !getIn(docs[n], [tl.collection, pid], schema)) continue;
          ctx.follow.push({ op: { ...e.op, path: [tl.collection, pid, ...e.path.slice(2)] } as PlainOp, rec: pathKey([tl.collection, pid]) });
        }
      }
    }
  }
}

function touchedIds(ctx: Ctx): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  const add = (p: Path) => {
    let set = out.get(p[0] as string);
    if (!set) out.set(p[0] as string, (set = new Set()));
    set.add(p[1] as string);
  };
  for (const s of ctx.sides)
    for (const e of s.entries) {
      if (!ctx.schema.collections[e.path[0] as string] || e.path.length < 2) continue;
      add(e.path);
    }
  for (const s of ctx.synth) if (ctx.schema.collections[s.op.path[0] as string]) add(s.op.path);
  return out;
}

// items whose placement (lane or times) changed or that were inserted: only these can create overlaps
function placedIds(ctx: Ctx): Set<string> {
  const tl = ctx.schema.timeline;
  const out = new Set<string>();
  if (!tl) return out;
  const placing = (p: Path) => p[0] === tl.collection && (p.length === 2 || (p.length === 3 && (p[2] === tl.start || p[2] === tl.end || p[2] === tl.lane)));
  for (const s of ctx.sides) for (const e of s.entries) if (placing(e.path) && e.op.op !== "remove") out.add(e.path[1] as string);
  for (const s of ctx.synth) if (placing(s.op.path)) out.add(s.op.path[1] as string);
  return out;
}

function validateTouched(ctx: Ctx, doc: Doc): Path[] {
  const { schema } = ctx;
  if (!schema.hard) return [];
  const bad: Path[] = [];
  for (const [cname, ids] of touchedIds(ctx))
    for (const id of ids) {
      const rec = getIn(doc, [cname, id], schema) as Rec | undefined;
      if (!rec) continue;
      const issues = schema.hard(cname, rec, doc);
      if (!issues.length) continue;
      // a record already inside a card keeps that card (its choices are each side's own valid values)
      const k = pathKey([cname, id]);
      const inCard = ctx.sides.some((s) => [s.byKey.get(k), ...(s.under.get(k) ?? [])].some((e) => e?.g));
      if (!inCard) bad.push([cname, id]);
    }
  return bad;
}

type Pick = (g: Group, i: number) => Choice | "base" | undefined;
function replayOps(m: MergeState, pick: Pick): PlainOp[] {
  const ops: PlainOp[] = [];
  const { ctx } = m;
  for (const s of ctx.sides) for (const e of s.entries) if (!e.g && !e.drop && !e.dup) ops.push(e.op);
  m.groups.forEach((g, i) => {
    const c = pick(g, i);
    if (c === "base") return;
    if (c === "ours" || c === "theirs") {
      const side = c === "ours" ? 0 : 1;
      for (const e of g.entries) if (e.side === side) ops.push(e.op); // its duplicates too: they are that side's change
    } else if (c && typeof c === "object" && "value" in c) {
      const gp = g.path!;
      // a custom value for a field group ({field: value, ...}) sets each field of the group
      if (String(gp.at(-1)).startsWith("#") && isObj(c.value)) for (const [f, v] of Object.entries(c.value)) ops.push({ op: "set", path: [...gp.slice(0, -1), f], value: v });
      else ops.push(c.value === undefined ? { op: "unset", path: gp } : { op: "set", path: gp, value: c.value });
    } else throw new Error(`resolve: bad choice for ${g.conflict!.path}`);
  });
  for (const s of ctx.synth) if (!s.skip) ops.push(s.op);
  for (const s of ctx.follow) if (!s.skip) ops.push(s.op);
  return ops;
}

/** The merge with every card decided: by index, by card path, or a function (default: the merge's `prefer` side). */
export function resolve(merged: MergeResult, choices: Choices = {}): Doc {
  const m = STATE.get(merged);
  if (!m) throw new Error("resolve: not a merge3 result");
  const pick: Pick = (g, i) => {
    const c = typeof choices === "function" ? choices(g.conflict!, i) : Array.isArray(choices) ? choices[i] : (choices as Record<PathKey, Choice>)[g.conflict!.path];
    return c ?? m.prefer;
  };
  return apply(fork(m.base, m.schema), replayOps(m, pick), m.schema);
}

/**
 * Two-way compare when no merge base exists: every difference is a card (nothing decided silently). Each card is one
 * record (or root field); resolving takes "theirs" (its ops), keeps "ours" ("base" too: there is none), or sets a
 * `{value}` (undefined removes it). A card the choices don't name takes `prefer` (default "ours").
 */
export function compare2(ours: Doc, theirs: Doc, schema: Schema): { doc: Doc; conflicts: ConflictCard[]; resolve(choices?: Choices, prefer?: "ours" | "theirs"): Doc } {
  const ops = diff(ours, theirs, schema);
  const byRec = new Map<PathKey, Op[]>();
  const recPath = (op: Op): Path => (schema.collections[op.path[0] as string] ? op.path.slice(0, 2) : op.path.slice(0, 1));
  for (const op of ops) {
    const k = pathKey(recPath(op));
    if (!byRec.has(k)) byRec.set(k, []);
    byRec.get(k)!.push(op);
  }
  const conflicts: ConflictCard[] = [...byRec].map(([k, list]) => {
    const p = recPath(list[0]!);
    return { kind: "compare", path: k, base: null, ours: nul(getIn(ours, p, schema)), theirs: nul(getIn(theirs, p, schema)), ops: list };
  });
  const pick = (c: ConflictCard, i: number, choices: Choices): Choice | undefined =>
    typeof choices === "function" ? choices(c, i) : Array.isArray(choices) ? choices[i] : (choices as Record<PathKey, Choice>)[c.path];
  return {
    doc: ours,
    conflicts,
    resolve: (choices: Choices = {}, prefer: "ours" | "theirs" = "ours") => {
      const out: Op[] = [];
      conflicts.forEach((c, i) => {
        const ch = pick(c, i, choices) ?? prefer;
        if (ch === "theirs") out.push(...c.ops!);
        else if (typeof ch === "object") {
          const path = recPath(c.ops![0]!);
          const record = path.length === 2;
          out.push(ch.value === undefined ? (record ? { op: "remove", path } : { op: "unset", path }) : { op: "set", path, value: ch.value });
        }
      });
      return apply(fork(ours, schema), out, schema);
    },
  };
}
