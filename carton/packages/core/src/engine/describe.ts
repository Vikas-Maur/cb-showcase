// describe (PLAN §9, layer 1): one short sentence per changed record (plus one per remap step), e.g.
// "Trimmed 'Intro' end 6.0 s → 5.0 s". Never prints more than four parts per record.
import { POS } from "../types.ts";
import type { FieldSpec, Schema } from "../schema.ts";
import type { ChangeRow, ConflictCard, Doc, Intent, Op, Path, PathKey, Rec, RemapMaps, RemapOp } from "../types.ts";
import { getIn, specAt } from "./doc.ts";
import { EMPTY, deepEqual, pathKey, unescapeSegment } from "./json.ts";
import { composeMaps, inferRemaps, near, remapSpan } from "./remap.ts";

type PlainOp = Exclude<Op, RemapOp>;
/**
 * A switch field (its phrase has `off`: CollectionDef.phrases) moved between off and absent, which mean the same: no
 * change to tell or count (muted false where it wasn't set, as an unmute after a mute leaves it).
 */
function quietSwitch(op: PlainOp, base: Doc, schema: Schema): boolean {
  if (op.path.length !== 3) return false;
  const p = schema.collections[op.path[0] as string]?.phrases?.[op.path[2] as string];
  if (!p?.off) return false;
  const was = getIn(base, op.path, schema);
  if (op.op === "set") return op.value === false && was === undefined;
  return (op.op === "unset" || op.op === "remove") && was === false;
}
/** The sentence a field's phrase says for `op` (CollectionDef.phrases): cleared, turned off (a switch), set or changed. */
function phraseFor(p: { set: string; changed?: string; cleared: string; off?: string }, op: PlainOp, doc: Doc, schema: Schema): string {
  const gone = op.path.length === 3 && (op.op === "unset" || op.op === "remove");
  if (gone) return p.cleared;
  if (p.off && op.path.length === 3 && op.op === "set" && op.value === false) return p.off;
  return op.path.length === 3 && getIn(doc, op.path, schema) === undefined ? p.set : (p.changed ?? p.set);
}
/** A field's words: its label (by dotted path, keyed-array element keys left out), else the path as before. */
function fieldWords(schema: Schema, path: Path): { words: string; labelled: boolean } {
  const cs = schema.collections[path[0] as string];
  const from = cs ? 2 : 0;
  const labels = cs ? cs.labels : schema.labels;
  if (labels) {
    let spec: FieldSpec | undefined = cs ? cs.record : schema.root;
    const parts: string[] = [];
    for (let i = from; i < path.length; i++) {
      if (spec?.kind === "keyed") {
        spec = spec.elem; // this segment is an element key: not part of the field's name
        continue;
      }
      parts.push(String(path[i]));
      spec = spec?.kind === "object" ? spec.fields[path[i] as string] : undefined;
    }
    const l = labels[parts.join(".")];
    if (l) return { words: l, labelled: true };
  }
  return { words: path.slice(from).join("."), labelled: false };
}

/** A root name field set for the first time: "Named the project 'Dragon short'" (its label is "<what> name"). */
function namedAs(f: { words: string; labelled: boolean }, v: unknown): string | null {
  if (!f.labelled || typeof v !== "string" || !f.words.endsWith(" name")) return null;
  return `Named the ${f.words.slice(0, -" name".length)} '${v.length > 40 ? v.slice(0, 37) + "…" : v}'`;
}

const fmtS = (x: number) => `${(+x).toFixed(1)} s`;
const fmtT = (x: number) => (x < 60 ? fmtS(x) : `${Math.floor(x / 60)}:${(x % 60).toFixed(1).padStart(4, "0")}`);
const short = (v: unknown): string => {
  const s = typeof v === "string" ? JSON.stringify(v.length > 40 ? v.slice(0, 37) + "…" : v) : JSON.stringify(v);
  return s === undefined ? "none" : s.length > 48 ? s.slice(0, 45) + "…" : s;
};

/**
 * One line of describe(), with what a version's summary needs (UI audit P1-5): its verb as a template (`%s` is the
 * record), the record's collection, and the record as named alone ("video 'clip.mp4'" for an add, "'Intro'" else).
 * A line that isn't about one record (a ripple, a project field) has no verb: a summary keeps it whole.
 */
interface Line {
  text: string;
  verb?: string;
  coll?: string;
  one?: string;
  /** The record (as it was; as added), for what the host calls it (`nounOf`). */
  rec?: Rec;
}

// A value no person reads (UI audit P1-2): a hash, a UUID, or a structure holding one. Shown by its field's name only.
const HASHY = /^(?:[0-9a-f]{16,}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;
const HASH_IN = /[0-9a-f]{16,}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-/i;
const opaque = (key: unknown, v: unknown): boolean =>
  isIdKey(String(key)) || /(?:^h|H)ash(?:es)?$/.test(String(key)) || (typeof v === "string" ? HASHY.test(v) : !!v && typeof v === "object" && HASH_IN.test(JSON.stringify(v) ?? ""));

/**
 * `names`: when these ops are only some of a larger set (one row of the Fold dialog), the doc records are named from,
 * `namingDoc(base, allOps)`, made once for all of them: a record the set adds is named ("to track 'Text 1'", a track
 * the same fold adds; regress prod3 P3-B read "another track").
 */
export function describe(ops: readonly Op[], base: Doc, schema: Schema, intent: Intent | null = null, names?: Doc): string[] {
  return lines(ops, base, schema, intent, names).map((l) => l.text);
}

/**
 * A version in words: every line describe() gives (`lines`), and one line that sums them up (`summary`): the line
 * itself when there is one, else the changes grouped by what was done ("Moved 'clip.mp4', changed 'W1' and 'W2'"),
 * a record by its name and several of a kind by their count ("Added 2 tracks, 4 clips and media 'intro.mp4'"), at
 * most three such groups ("…, and 2 more changes"). Empty when nothing is worded.
 */
export function describeVersion(ops: readonly Op[], base: Doc, schema: Schema, intent: Intent | null = null): { summary: string; lines: string[] } {
  const ls = lines(ops, base, schema, intent);
  return { summary: summaryOf(ls, schema), lines: ls.map((l) => l.text) };
}

const lower = (x: string) => (/^[A-Z][a-z]/.test(x) ? x[0]!.toLowerCase() + x.slice(1) : x);
const plural = (noun: string) => (noun.endsWith("s") ? noun : noun === "media" ? "media files" : `${noun}s`);
const and = (xs: readonly string[]) => (xs.length < 2 ? (xs[0] ?? "") : `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`);

function summaryOf(all: readonly Line[], schema: Schema): string {
  // each record by what it is (laptop re-check P3-8: titles were counted as clips, and their own media entries as
  // media files): the host's noun for it, and a record that is part of another left out
  const nounOf = (l: Line) => {
    const cs = l.coll === undefined ? undefined : schema.collections[l.coll];
    const own = cs?.nounOf && l.rec ? cs.nounOf(l.rec) : undefined;
    return own === null ? null : (own ?? cs?.noun ?? (l.coll === schema.timeline?.lanes ? "track" : "item"));
  };
  const kept = all.filter((l) => !l.verb || nounOf(l) !== null);
  const ls = kept.length ? kept : all;
  if (ls.length <= 1) return ls[0]?.text ?? "";
  const groups: { verb?: string; text?: string; n: number; byNoun: Map<string, string[]> }[] = [];
  for (const l of ls) {
    let g = l.verb ? groups.find((x) => x.verb === l.verb) : undefined;
    if (!g) groups.push((g = { ...(l.verb ? { verb: l.verb } : { text: l.text }), n: 0, byNoun: new Map() }));
    g.n++;
    const k = l.verb ? (nounOf(l) ?? "item") : "";
    if (l.verb) (g.byNoun.get(k) ?? g.byNoun.set(k, []).get(k)!).push(l.one!);
  }
  const words = groups.map((g) => {
    if (!g.verb) return g.text!;
    const one = g.byNoun.size === 1;
    const what = [...g.byNoun].map(([noun, xs]) => (xs.length === 1 ? xs[0]! : one && xs.length === 2 ? `${xs[0]} and ${xs[1]}` : `${xs.length} ${plural(noun)}`));
    return g.verb.replace("%s", and(what));
  });
  if (words.length > 3) {
    const rest = groups.slice(2).reduce((n, g) => n + g.n, 0);
    words.splice(2, words.length - 2, `and ${rest} more change${rest === 1 ? "" : "s"}`);
  }
  return words.map((w, i) => (i ? lower(w) : w)).join(", ");
}

type Group = { coll: string | null; id: unknown; ops: PlainOp[] };
/** The ops by record ("items/c1"), and root fields by name, in the order they come. */
function groupOps(plain: readonly PlainOp[], schema: Schema): Map<string, Group> {
  const groups = new Map<string, Group>();
  for (const op of plain) {
    const cs = schema.collections[op.path[0] as string];
    const k = cs ? op.path[0] + "/" + op.path[1] : String(op.path[0]);
    let g = groups.get(k);
    if (!g) groups.set(k, (g = { coll: cs ? (op.path[0] as string) : null, id: op.path[1], ops: [] }));
    g.ops.push(op);
  }
  return groups;
}
/**
 * `base` plus the records `ops` insert, as a new doc: the doc a label looks records up in (`describe`'s `names`, made
 * once for many rows, and read as it is then: who holds a part is indexed on it).
 */
export function namingDoc(base: Doc, ops: readonly Op[], schema: Schema): Doc {
  const added = new Map<string, Rec[]>();
  for (const op of ops) {
    if (op.op !== "insert" || op.path.length !== 2 || !schema.collections[op.path[0] as string]) continue;
    const c = op.path[0] as string;
    let l = added.get(c);
    if (!l) added.set(c, (l = []));
    l.push(op.value as Rec);
  }
  // a doc of its own even with nothing added: heldParts keys its index on it
  const named: Doc = { ...base };
  for (const [c, l] of added) named[c] = [...((base[c] as Rec[] | undefined) ?? EMPTY), ...l];
  return named;
}
function labeller(plain: readonly PlainOp[], base: Doc, schema: Schema, names?: Doc) {
  let named: Doc | null = names ?? null;
  const nameDoc = (): Doc => (named ??= namingDoc(base, plain, schema));
  return { nameDoc, label: (coll: string, rec: Rec | undefined) => schema.label?.(coll, rec, nameDoc()) ?? String(rec?.name ?? rec?.id ?? "?") };
}

/**
 * A clip split (the editor's Split at playhead): one clip removed, and in its place two or more of the same footage
 * (same kind, same references, same name) on its track, back to back over its range. Or two parts of which one is still
 * where the split left it and the other keeps the cut's source point (it was moved, or trimmed at its far end, after
 * the split in the same version). `parts` left to right, each with the record the split alone made of it (`ideal`), so
 * what was done to it afterwards can be told; `at`: the timeline times it was split at.
 */
interface Split {
  coll: string;
  key: string;
  rec: Rec;
  at: number[];
  parts: { key: string; rec: Rec; ideal: Rec }[];
}
const SRC_EPS = 1e-3;
const close = (a: unknown, b: unknown) => (typeof a === "number" && typeof b === "number" ? Math.abs(a - b) < SRC_EPS : a === b);
function findSplits(groups: ReadonlyMap<string, Group>, base: Doc, schema: Schema, label: (coll: string, rec: Rec | undefined) => string): Split[] {
  const tl = schema.timeline;
  if (!tl) return [];
  const K = schema.collections[tl.collection]!.key;
  const whole = (g: Group, kind: string) => g.coll === tl.collection && g.ops.length === 1 && g.ops[0]!.path.length === 2 && g.ops[0]!.op === kind;
  const added: { key: string; rec: Rec }[] = [],
    removed: { key: string; rec: Rec }[] = [];
  for (const [key, g] of groups) {
    if (whole(g, "insert")) added.push({ key, rec: (g.ops[0] as { value: Rec }).value });
    else if (whole(g, "remove")) {
      const rec = getIn(base, [tl.collection, g.id as string], schema) as Rec | undefined;
      if (rec) removed.push({ key, rec });
    }
  }
  const out: Split[] = [];
  if (!removed.length || added.length < 2) return out;
  const num = (r: Rec, f: string) => r[f] as number;
  // the same footage: every reference (a field named like an id) and the kind as they were, and the same name
  const names = new Map<Rec, string>();
  const named = (x: Rec) => names.get(x) ?? names.set(x, label(tl.collection, x)).get(x)!;
  const same = (r: Rec, x: Rec) => {
    for (const k of new Set([...Object.keys(r), ...Object.keys(x)])) if (k !== K && k !== tl.lane && (k === "type" || isIdKey(k)) && !deepEqual(r[k], x[k])) return false;
    return named(r) === named(x);
  };
  const used = new Set<string>();
  for (const R of removed) {
    const r = R.rec,
      s0 = num(r, tl.start),
      e0 = num(r, tl.end);
    if (!Number.isFinite(s0) || !Number.isFinite(e0)) continue;
    const speed = typeof r[tl.speed] === "number" ? num(r, tl.speed) : 1;
    const src = num(r, tl.source),
      srcEnd = num(r, tl.sourceEnd),
      hasSrc = Number.isFinite(src) && Number.isFinite(srcEnd);
    // the record the split alone makes of [s, e]: forwards the source runs from in-point to out-point, backwards the
    // other way; the outer sides keep the original's own values
    const ideal = (p: Rec, s: number, e: number, back: boolean): Rec => {
      const x: Rec = { ...r, [K]: p[K], [tl.start]: s, [tl.end]: e };
      if (hasSrc) {
        if (back) (x[tl.sourceEnd] = close(s, s0) ? srcEnd : srcEnd - (s - s0) * speed), (x[tl.source] = close(e, e0) ? src : srcEnd - (e - s0) * speed);
        else (x[tl.source] = close(s, s0) ? src : src + (s - s0) * speed), (x[tl.sourceEnd] = close(e, e0) ? srcEnd : src + (e - s0) * speed);
      }
      return x;
    };
    const cands = added.filter((a) => !used.has(a.key) && same(r, a.rec)).sort((a, b) => num(a.rec, tl.start) - num(b.rec, tl.start) || num(a.rec, tl.end) - num(b.rec, tl.end) || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
    if (cands.length < 2) continue;
    const take = (parts: { key: string; rec: Rec }[], at: number[], ideals: Rec[]) => {
      for (const p of parts) used.add(p.key);
      out.push({ coll: tl.collection, key: R.key, rec: r, at, parts: parts.map((p, i) => ({ ...p, ideal: ideals[i]! })) });
    };
    // back to back over its range, on its track
    const chain: { key: string; rec: Rec }[] = [];
    for (let at = s0; !close(at, e0); ) {
      const next = cands.find((a) => !chain.includes(a) && a.rec[tl.lane] === r[tl.lane] && close(num(a.rec, tl.start), at) && num(a.rec, tl.end) > at + SRC_EPS && num(a.rec, tl.end) < e0 + SRC_EPS);
      if (!next) break;
      chain.push(next);
      at = num(next.rec, tl.end);
    }
    if (chain.length >= 2 && close(num(chain.at(-1)!.rec, tl.end), e0)) {
      const p0 = chain[0]!.rec;
      // played backwards: the left part ends at the original's out-point
      const back = hasSrc && !close(p0[tl.source], src) && close(p0[tl.sourceEnd], srcEnd);
      take(chain, chain.slice(1).map((p) => num(p.rec, tl.start)), chain.map((p) => ideal(p.rec, num(p.rec, tl.start), num(p.rec, tl.end), back)));
      continue;
    }
    // two parts: one where the split left it (its anchor: from the start, or to the end, of the original on its track),
    // the other changed since (it keeps the cut's source point, or without source points its length). Only anchors are
    // paired (a bulk replacement with none costs nothing more), and a forward reading wins over a backward one whatever
    // order the ops come in: core doesn't know which way a clip plays, and the two can both fit one pair
    const inside = (t: number) => t > s0 + SRC_EPS && t < e0 - SRC_EPS;
    const onTrack = (a: { rec: Rec }) => a.rec[tl.lane] === r[tl.lane];
    const lefts = cands.filter((a) => onTrack(a) && close(num(a.rec, tl.start), s0) && inside(num(a.rec, tl.end)));
    const rights = cands.filter((b) => onTrack(b) && close(num(b.rec, tl.end), e0) && inside(num(b.rec, tl.start)));
    if (!lefts.length && !rights.length) continue;
    const keeps = (p: Rec, x: Rec, left: boolean, back: boolean) => (hasSrc ? close(p[left !== back ? tl.sourceEnd : tl.source], x[left !== back ? tl.sourceEnd : tl.source]) : close(num(p, tl.end) - num(p, tl.start), num(x, tl.end) - num(x, tl.start)));
    const pairs: [{ key: string; rec: Rec }, { key: string; rec: Rec }, number][] = [];
    for (const a of lefts) for (const b of cands) if (a !== b) pairs.push([a, b, num(a.rec, tl.end)]);
    for (const b of rights) for (const a of cands) if (a !== b) pairs.push([a, b, num(b.rec, tl.start)]);
    found: for (const back of hasSrc ? [false, true] : [false])
      for (const [a, b, t] of pairs) {
        const ia = ideal(a.rec, s0, t, back),
          ib = ideal(b.rec, t, e0, back);
        if (keeps(a.rec, ia, true, back) && keeps(b.rec, ib, false, back)) {
          take([a, b], [t], [ia, ib]);
          break found;
        }
      }
  }
  return out;
}

/**
 * The clips a version split (the editor's Split at playhead): the removed clip's id and its parts' ids, left to right.
 * A list of changes by record (the Fold dialog) keeps them together: one change, worded as the split.
 */
export function splits(ops: readonly Op[], base: Doc, schema: Schema): { collection: string; removed: string; parts: string[] }[] {
  const plain = ops.filter((op): op is PlainOp => op.op !== "remap");
  const K = schema.timeline ? schema.collections[schema.timeline.collection]?.key : undefined;
  if (!K) return [];
  return findSplits(groupOps(plain, schema), base, schema, labeller(plain, base, schema).label).map((s) => ({ collection: s.coll, removed: String(s.rec[K]), parts: s.parts.map((p) => String(p.rec[K])) }));
}

/**
 * How many changes `ops` make, counted one way everywhere (History's fold titles, `cb history`'s left out, Compare,
 * Watch the changes and the Fold dialog's rows; laptop re-check P3): one per record changed, one per root field, and
 * a split (its removed clip and its parts) one. A ripple's remap is no change of its own. `among` (a partial fold's
 * left-out paths): only the records those paths name, a split among them still one.
 */
export function countChanges(ops: readonly Op[], base: Doc, schema: Schema, among?: readonly PathKey[]): number {
  const plain = ops.filter((op): op is PlainOp => op.op !== "remap" && !quietSwitch(op, base, schema));
  const groups = groupOps(plain, schema);
  let keys: ReadonlySet<string> = new Set(groups.keys());
  if (among) {
    const ks = new Set<string>();
    for (const k of among) {
      const [c, id] = k.split("/").map(unescapeSegment);
      if (c) ks.add(schema.collections[c] && id !== undefined ? `${c}/${id}` : c);
    }
    keys = ks;
  }
  let n = keys.size;
  if (n < 2) return n;
  // a record part of another (a title's own media entry) is its holder's change
  for (const [k, holder] of heldParts(groups, base, schema)) if (keys.has(k) && keys.has(holder)) n--;
  if (keys.size < 3) return n; // a split is three records at least
  for (const sp of findSplits(groups, base, schema, labeller(plain, base, schema).label)) if (keys.has(sp.key) && sp.parts.every((p) => keys.has(p.key))) n -= sp.parts.length;
  return n;
}

/**
 * The records that are part of another (`nounOf` null: a title's own "Text: W6" media entry) whose change is their
 * holder's, as a split's parts are the split's (laptop, merge/prod-2 N-1: "Deleted title 'W6'" came with "Deleted
 * media 'Text: W6'"; regress prod3 P3-C: a setup row's "15 changes" listed every title's entry). The holder is the one
 * record of the part's `partOf` collection whose declared field names it, in base or among the records the change
 * inserts (never any equal value elsewhere). Held when the change touches that holder too, and adds or deletes the part
 * only as it adds or deletes the holder (or edits both: a title's text and its entry's). A part two records name (a
 * duplicated title's shared entry), or none, or whose holder the change leaves alone, or added or deleted on its own,
 * is still told. Who names what is read once per call (a restore of many titles stays linear), and once per `names`
 * doc (describe's, `namingDoc(base, allOps)`: base plus all of a larger set's inserts) for the rows of one Fold plan,
 * so a duplicate another row inserts counts too (review of the merge: each row rebuilt it). Part's key → holder's.
 */
// by `names` doc, then "collection\0field": the value → the keys of every record whose field holds it
const NAMERS = new WeakMap<Doc, Map<string, Map<unknown, Set<unknown>>>>();
function heldParts(groups: ReadonlyMap<string, Group>, base: Doc, schema: Schema, names?: Doc): Map<string, string> {
  const out = new Map<string, string>();
  const whole = (g: Group | undefined) => g?.ops.find((op) => op.path.length === 2);
  let index = names && NAMERS.get(names);
  if (!index) {
    index = new Map();
    if (names) NAMERS.set(names, index);
  }
  const namers = (coll: string, field: string, hk: string) => {
    const at = coll + "\0" + field;
    let m = index!.get(at);
    if (!m) {
      const add = (v: unknown, id: unknown) => (m!.get(v) ?? m!.set(v, new Set()).get(v)!).add(id);
      index!.set(at, (m = new Map()));
      // `names` holds base and every insert of the set; else base, then what these ops insert
      for (const h of ((names ?? base)[coll] as Rec[] | undefined) ?? EMPTY) add(h[field], h[hk]);
      if (!names) for (const [, g] of groups) {
        const w = g.coll === coll && whole(g);
        if (w && w.op === "insert") add((w.value as Rec)?.[field], g.id);
      }
    }
    return m;
  };
  for (const [k, g] of groups) {
    const cs = g.coll ? schema.collections[g.coll] : undefined, of = cs?.partOf;
    if (!of || !cs?.nounOf) continue;
    const w = whole(g);
    const r = (w?.op === "insert" ? w.value : getIn(base, [g.coll!, g.id as string], schema)) as Rec | undefined;
    if (!r || cs!.nounOf(r) !== null) continue;
    const hk = schema.collections[of.collection]?.key;
    const names = hk ? namers(of.collection, of.field, hk).get(r[cs!.key]) : undefined;
    if (names?.size !== 1) continue;
    const hkey = of.collection + "/" + [...names][0], hw = whole(groups.get(hkey));
    // the holder touched too; added or deleted together, or both edited
    if (groups.has(hkey) && (w || hw ? w?.op === hw?.op : true)) out.set(k, hkey);
  }
  return out;
}
/**
 * The records `ops` add or delete with the record that holds them (heldParts): one change with it, so a list by record
 * (the Fold dialog) joins each to its holder's row, as it joins a split's parts.
 */
export function heldBy(ops: readonly Op[], base: Doc, schema: Schema): { part: [string, string]; holder: [string, string] }[] {
  const groups = groupOps(ops.filter((op): op is PlainOp => op.op !== "remap"), schema);
  return [...heldParts(groups, base, schema)].map(([p, h]) => {
    const a = groups.get(p)!, b = groups.get(h)!;
    return { part: [a.coll!, String(a.id)], holder: [b.coll!, String(b.id)] };
  });
}

const PART = ["first", "second", "third", "fourth", "fifth"];

function lines(ops: readonly Op[], base: Doc, schema: Schema, intent: Intent | null, names?: Doc): Line[] {
  const tl = schema.timeline,
    out: Line[] = [];
  const plain = ops.filter((op): op is PlainOp => op.op !== "remap" && !quietSwitch(op, base, schema));
  const { nameDoc, label } = labeller(plain, base, schema, names);
  // a track made in the same change is named too (UI audit P1-6's drag onto a new track read "to track track 3f9a1c")
  const laneName = (id: unknown) => {
    const t = tl && (getIn(nameDoc(), [tl.lanes, id as string], schema) as Rec | undefined);
    return t ? `'${label(tl!.lanes, t)}'` : "another track";
  };
  // "to track 'Text 1'"; a track it can't name is "to another track", never "to track another track" (P3-B)
  const toTrack = (id: unknown) => {
    const n = laneName(id);
    return n[0] === "'" ? `track ${n}` : n;
  };
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
      for (const [a, b] of st.d) out.push({ text: `Removed ${fmtS(b - a)} from ${laneName(lane)} at ${fmtT(a)} (later items pulled left)` });
      for (const [p, len] of st.i) out.push({ text: `Inserted ${fmtS(len)} into ${laneName(lane)} at ${fmtT(p)} (later items pushed right)` });
    }
  }
  const groups = groupOps(plain, schema);
  const val = (op: PlainOp | undefined) => (op as { value?: unknown } | undefined)?.value as number;
  /** A record's changed fields in words; `before` and `doc` as they were, `called` its name when not its label. */
  const recordLine = (coll: string, id: unknown, ops: readonly PlainOp[], before: Rec | undefined, doc: Doc, called?: string): Line | null => {
  const name = called ?? `'${label(coll, before)}'`;
  const cs = schema.collections[coll]!;
  const noun = coll === tl?.lanes ? cs.noun ?? "track" : ((before?.type as string | undefined) ?? cs.noun ?? "item");
  const f = new Map<string, PlainOp>();
  for (const op of ops) if (op.path.length === 3) f.set(op.path[2] as string, op);
  const parts: string[] = [];
  let verb = "Changed %s";
  let rest = ops;
  // a field the host words as a phrase ("Linked %s for sharing"): one phrase for all its ops, never its values
  const phrases = cs.phrases;
  if (phrases) {
    const said = new Set<string>();
    for (const op of ops) {
      const p = phrases[op.path[2] as string];
      if (!p) continue;
      const t = phraseFor(p, op, doc, schema);
      if (!parts.length) verb = t;
      if (!said.has(t)) parts.push(t.replace("%s", name));
      said.add(t);
    }
    rest = rest.filter((op) => !phrases[op.path[2] as string]);
  }
  if (coll === tl?.lanes && f.get(POS)) {
    if (!parts.length) verb = "Reordered %s";
    parts.push(`Reordered ${noun} ${name}`);
    rest = rest.filter((op) => op !== f.get(POS));
  }
  if (tl && coll === tl.collection && before) {
    const s = f.get(tl.start),
      e = f.get(tl.end),
      ln = f.get(tl.lane);
    const used = new Set([s, e, ln, f.get(tl.source), f.get(tl.sourceEnd)].filter(Boolean));
    const os = before[tl.start] as number,
      oe = before[tl.end] as number;
    const n0 = parts.length;
    if (explained.has(id)) used.add(s).add(e);
    else if (s && e && Math.abs(val(s) - os - (val(e) - oe)) < 1e-4) parts.push(`Moved ${name} ${fmtT(os)} → ${fmtT(val(s))}`);
    else if (s && e) parts.push(`Retimed ${name} ${fmtT(os)}–${fmtT(oe)} → ${fmtT(val(s))}–${fmtT(val(e))}`);
    else if (e) parts.push(`Trimmed ${name} end ${fmtS(oe)} → ${fmtS(val(e))}`);
    else if (s) parts.push(`Trimmed ${name} start ${fmtS(os)} → ${fmtS(val(s))}`);
    else if (f.get(tl.source)) parts.push(`Slipped ${name} source in ${fmtS(before[tl.source] as number)} → ${fmtS(val(f.get(tl.source)))}`);
    if (ln) parts.push(parts.length ? `to ${toTrack(val(ln))}` : `Moved ${name} to ${toTrack(val(ln))}`);
    if (!n0 && parts.length) verb = `${parts[0]!.split(" ")[0]} %s`;
    rest = rest.filter((op) => !used.has(op));
  }
  // an element of a keyed list by its own name or type ("blur"), else its key when that isn't an id ("opacity"
  // keyframes), else nothing: never an effect's id (UI audit P1-2, review #3)
  const elem = (op: PlainOp) => {
    const v = (op.op === "insert" ? op.value : getIn(doc, op.path, schema)) as Rec | undefined;
    const own = v && typeof v === "object" ? [v.name, v.type, v.label].find((x) => typeof x === "string" && x) : undefined;
    if (own) return ` ${short(own)}`;
    const spec = specAt(schema, op.path.slice(0, 3)), k = op.path.at(-1);
    return (spec?.kind === "keyed" && isIdKey(spec.key)) || opaque("", k) ? "" : ` ${short(k)}`;
  };
  for (const op of rest) {
    const field = fieldWords(schema, op.path).words;
    const list = fieldWords(schema, op.path.slice(0, 3)).words;
    // a keyed list set whole where there was none (a clip's first effect: no effects field yet) is its elements added,
    // as an insert into a list that was there says it (regress 2026-11-02 P3-1: "Changed 'clip.mp4' effect")
    const spec = op.op === "set" && op.path.length === 3 && Array.isArray(op.value) && op.value.length ? specAt(schema, op.path) : undefined;
    const was = spec?.kind === "keyed" ? getIn(doc, op.path, schema) : null;
    if (spec?.kind === "keyed" && (was === undefined || (Array.isArray(was) && !was.length))) {
      for (const v of (op as { value: Rec[] }).value) parts.push(`added ${list}${elem({ op: "insert", path: [...op.path, String(v?.[spec.key] ?? "")], value: v } as PlainOp)}`);
      continue;
    }
    if (op.op === "insert") parts.push(`added ${list}${elem(op)}`);
    else if (op.op === "remove") parts.push(`removed ${list}${elem(op)}`);
    else if (op.path.at(-1) === POS) parts.push(`reordered ${list}`);
    else if (op.op === "unset") parts.push(`cleared ${field}`);
    else {
      const old = getIn(doc, op.path, schema);
      // never an id or a hash (UI audit P1-2): the field is named alone
      if (opaque(op.path[2], op.value) || opaque(op.path[2], old) || opaque(op.path.at(-1), op.value)) parts.push(`changed ${field}`);
      else parts.push(old === undefined ? `set ${field} to ${short(op.value)}` : `${field} ${short(old)} → ${short(op.value)}`);
    }
  }
  if (!parts.length) return null;
  if (parts.length > 4) parts.splice(3, parts.length - 3, `and ${parts.length - 3} more changes`);
  const p0 = parts[0]!;
  if (!/^[A-Z]/.test(p0))
    parts[0] = p0.startsWith("set ") ? `Set ${name} ${p0.slice(4)}` : p0.startsWith("changed ") ? `Changed ${name} ${p0.slice(8)}` : /^(added|removed|reordered|cleared) /.test(p0) ? `${p0[0]!.toUpperCase()}${p0.slice(1)} on ${name}` : `Changed ${name} ${p0}`;
  return { text: parts.map((p, i) => (i ? lower(p) : p)).join(", "), verb, coll, one: name, ...(before ? { rec: before } : {}) };
  };
  const split = new Map<string, Split | null>();
  for (const sp of findSplits(groups, base, schema, label)) {
    split.set(sp.key, sp);
    for (const p of sp.parts) split.set(p.key, null);
  }
  // a part with the record holding it: told with it (heldParts)
  for (const k of heldParts(groups, base, schema, names).keys()) split.set(k, null);
  for (const [key, g] of groups) {
    const sp = split.get(key);
    if (sp === null) continue; // a split's part, or a part held by another record: told with it
    if (sp) {
      // "Split 'clip.mp4' at 4.0 s", and what was done to a part after it, worded against what the split made of it:
      // its times, track, values set or cleared, plain values changed (a transition or a fade the split itself dropped,
      // a field the host's split leaves off its parts, `splitDrops`, keyframes it rescaled, are no change of their own)
      const name = `'${label(sp.coll, sp.rec)}'`;
      const said: string[] = [`Split ${name} at ${and(sp.at.map(fmtT))}`];
      // a field the host's split leaves off its parts (`splitDrops`), gone from every part: the split's own
      const drops = new Set((tl!.splitDrops ?? EMPTY).filter((f) => sp.rec[f] !== undefined && sp.parts.every((p) => p.rec[f] === undefined)));
      sp.parts.forEach(({ rec, ideal }, i) => {
        const id = rec[schema.collections[sp.coll]!.key] as string;
        const fs = new Set([...Object.keys(rec), ...Object.keys(ideal)]);
        const ops: PlainOp[] = [];
        for (const f of fs) {
          const v = rec[f],
            was = ideal[f];
          const timing = f === tl!.start || f === tl!.end || f === tl!.source || f === tl!.sourceEnd || f === tl!.lane;
          const plainV = (x: unknown) => x === null || typeof x !== "object";
          if (timing) {
            if (!close(v, was)) ops.push({ op: "set", path: [sp.coll, id, f], value: v });
          } else if (was === undefined) {
            if (v !== undefined) ops.push({ op: "set", path: [sp.coll, id, f], value: v }); // set on the part since
          } else if (v === undefined) {
            // a value cleared, unless the split dropped it from every part (Cardboard: autoReframe, laptop re-check P3)
            if (plainV(was) && !drops.has(f)) ops.push({ op: "unset", path: [sp.coll, id, f] });
          } else if (plainV(v) && plainV(was) && v !== was) ops.push({ op: "set", path: [sp.coll, id, f], value: v });
          // a structure in both that differs (keyframes): the split rescales those; not told as a change of the part
        }
        if (!ops.length) return;
        const doc = { ...base, [sp.coll]: [...((base[sp.coll] as Rec[] | undefined) ?? EMPTY), ideal] };
        const part = `its ${sp.parts.length === 2 ? (i ? "right" : "left") : (PART[i] ?? `${i + 1}th`)} part`;
        const l = recordLine(sp.coll, id, ops, ideal, doc, part);
        if (l) said.push(lower(l.text));
      });
      out.push({ text: said.join(", "), verb: "Split %s", coll: sp.coll, one: name, rec: sp.rec });
      continue;
    }
    if (!g.coll) {
      for (const op of g.ops) {
        const old = getIn(base, op.path, schema);
        const f = fieldWords(schema, op.path);
        const what = f.labelled ? `the ${f.words}` : f.words;
        const v = (op as { value?: unknown }).value;
        // never "none" as a value: a field set for the first time is named or set ("Named the project 'Dragon short'");
        // never an id or a hash: the field is named alone
        if (op.op === "unset") out.push({ text: `Cleared ${what}` });
        else if (opaque(op.path.at(-1), v) || opaque(op.path.at(-1), old)) out.push({ text: `${old === undefined ? "Set" : "Changed"} ${what}` });
        else if (old === undefined) out.push({ text: namedAs(f, v) ?? `Set ${what} to ${short(v)}` });
        else out.push({ text: `Changed ${what} ${short(old)} → ${short(v)}` });
      }
      continue;
    }
    const before = getIn(base, [g.coll, g.id as string], schema) as Rec | undefined;
    const whole = g.ops.find((op) => op.path.length === 2);
    const cs = schema.collections[g.coll]!;
    const rec = (before ?? (whole as { value?: Rec } | undefined)?.value) as Rec | undefined;
    // what the host calls it ("title"), else its kind ("video")
    const own = rec && cs.nounOf?.(rec);
    const noun = g.coll === tl?.lanes ? cs.noun ?? "track" : (own || ((rec?.type as string | undefined) ?? cs.noun ?? "item"));
    if (whole?.op === "insert") {
      const r = whole.value as Rec;
      const where = tl && g.coll === tl.collection ? ` on ${laneName(r[tl.lane])} at ${fmtT(r[tl.start] as number)}` : "";
      out.push({ text: `Added ${noun} '${label(g.coll, r)}'${where}`, verb: "Added %s", coll: g.coll, one: `${noun} '${label(g.coll, r)}'`, rec: r });
      continue;
    }
    if (whole) {
      out.push({ text: `Deleted ${noun} '${label(g.coll, before)}'`, verb: "Deleted %s", coll: g.coll, one: `${noun} '${label(g.coll, before)}'`, ...(before ? { rec: before } : {}) });
      continue;
    }
    const l = recordLine(g.coll, g.id, g.ops, before, base);
    if (l) out.push(l);
  }
  return out;
}

// ---------------------------------------------------------------- change rows in editor words (UX redesign 0.1, 0.2)
//
// The app's one sentence table (docs/carton-ux DESIGN §8 "Change sentences"): every History row, version card, Changes
// view, Fold dialog row and toast says a change this way. Verb first; the clip by its name in curly quotes; positions in
// the edit as the editor's timecodes ("0:09"), differences in whole or tenth seconds ("2 s later"); never an id or a
// hash. `describe()` keeps its exact, technical lines for `cb` and agents ("Trimmed 'Intro' end 6.0 s → 5.0 s").

/** A position in the edit as a timecode, to the nearest second: 9 → "0:09", 75.4 → "1:15", 3725 → "1:02:05". */
export function timecode(s: number): string {
  const t = Number.isFinite(s) && s > 0 ? Math.round(s) : 0;
  const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), x = t % 60;
  return h ? `${h}:${String(m).padStart(2, "0")}:${String(x).padStart(2, "0")}` : `${m}:${String(x).padStart(2, "0")}`;
}
const curly = (s: string) => `“${s}”`;
/**
 * A field in an editor's words: its label, else its own name spaced out ("fontSize" → "font size"), never a dotted
 * path or an element's key.
 */
function editorField(schema: Schema, path: Path): string {
  const f = fieldWords(schema, path);
  if (f.labelled) return f.words;
  const last = String(path.length > 2 ? path[2] : path[0] ?? "");
  return last.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/[_-]+/g, " ").toLowerCase();
}
/** A difference in seconds: 2 → "2 s", 0.45 → "0.5 s", 1.25 → "1.3 s". */
const secs = (d: number) => {
  const r = Math.round(Math.abs(d) * 10) / 10;
  return `${Number.isInteger(r) ? r : r.toFixed(1)} s`;
};
const cap = (x: string) => (x ? x[0]!.toUpperCase() + x.slice(1) : x);
// size-like fields read as bigger or smaller (DESIGN §8: "Made “W2” bigger (font size 100 → 222)")
const SIZE = /(?:^|\s)(?:size|scale|zoom|width|height)$/;

export interface ChangeWordsOptions {
  intent?: Intent | null;
  /** As describe()'s: the doc records are named from when these ops are one row of a larger set (`namingDoc`). */
  names?: Doc;
  /** A field's value in the host's words (as describeCard's): Cardboard's volume "80%", speed "2×", a media's file name. */
  value?: (key: string, value: unknown, doc: Doc | undefined) => string | undefined;
}

/**
 * Every change `ops` make to `base`, one row each as `countChanges` counts them, in editor words, with where each is in
 * the edit (PLAN 0.1, 0.2). A ripple's remap is no row of its own (the records it shifts have no ops); a record a docDiff
 * shifted (no remap recorded) is its own row, as `countChanges` counts it.
 */
export function changeList(ops: readonly Op[], base: Doc, schema: Schema, opts: ChangeWordsOptions = {}): ChangeRow[] {
  const tl = schema.timeline;
  const plain = ops.filter((op): op is PlainOp => op.op !== "remap" && !quietSwitch(op, base, schema));
  const { nameDoc, label } = labeller(plain, base, schema, opts.names);
  const groups = groupOps(plain, schema);
  const K = tl ? schema.collections[tl.collection]?.key : undefined;
  // tracks this change adds: a clip moved onto one went "to a new track"
  const addedLanes = new Set<unknown>();
  if (tl) for (const [, g] of groups) if (g.coll === tl.lanes && g.ops.some((op) => op.path.length === 2 && op.op === "insert")) addedLanes.add(g.id);
  const movedOnto = new Set<unknown>();
  const toTrack = (id: unknown) => {
    if (addedLanes.has(id)) {
      movedOnto.add(id);
      return "a new track";
    }
    const t = tl && (getIn(nameDoc(), [tl.lanes, id as string], schema) as Rec | undefined);
    return t ? `track ${quoted(tl!.lanes, t)}` : "another track";
  };
  const num = (x: number) => (Number.isInteger(x) ? String(x) : String(+x.toFixed(2)));
  const words = (key: string, v: unknown, doc: Doc): string | null => {
    const host = opts.value?.(key, v, doc);
    if (host !== undefined) return host.replace(/^'(.*)'$/, "“$1”");
    if (typeof v === "number") return num(v);
    if (typeof v === "string") return curly(v.length > 40 ? v.slice(0, 37) + "…" : v);
    if (typeof v === "boolean") return v ? "on" : "off";
    return null;
  };
  const nounOf = (coll: string, rec: Rec | undefined): string | undefined => {
    const cs = schema.collections[coll]!;
    if (tl && coll === tl.lanes) return cs.noun ?? "track";
    const own = rec ? cs.nounOf?.(rec) : undefined;
    // a clip is named alone ("Removed “B-roll 3”"); a title, caption or code graphic, a track or media by what it is
    if (tl && coll === tl.collection) return own || undefined;
    return own || cs.noun || undefined;
  };
  // a record by its name in curly quotes; one whose only name is its own id (a schema with no label for it) by what it
  // is ("a clip"): never an id (review of the UX data #11)
  const quoted = (coll: string, rec: Rec | undefined): string => {
    const l = label(coll, rec);
    const k = schema.collections[coll]?.key ?? "id";
    // its own id, when that is what an id looks like (a hex run, or a long token): a name that happens to be its key
    // ("W1") is still a name
    const idLike = !!rec && l === String(rec[k]) && (/[0-9a-f]{12,}/i.test(l) || (l.length >= 16 && !/\s/.test(l)));
    if (l !== "?" && !idLike && !HASHY.test(l)) return curly(l);
    const n = nounOf(coll, rec) ?? schema.collections[coll]?.noun ?? "item";
    return `${/^[aeiou]/i.test(n) ? "an" : "a"} ${n}`;
  };
  const called = (coll: string, rec: Rec | undefined) => {
    const n = nounOf(coll, rec);
    const q = quoted(coll, rec);
    return q.startsWith("“") && n ? `${n} ${q}` : q;
  };
  const place = (coll: string | null, rec: Rec | undefined): { at?: number; end?: number } => {
    if (!tl || coll !== tl.collection || !rec) return {};
    const s = rec[tl.start], e = rec[tl.end];
    return typeof s === "number" && Number.isFinite(s) ? { at: s, ...(typeof e === "number" && Number.isFinite(e) ? { end: e } : {}) } : {};
  };

  /**
   * A record's field changes as one sentence: the first part names it ("Moved “Intro” 2 s later (now starts at
   * 0:02)"), the others are its ("changed its volume to 80%"); `name` is how it is called (a split's part: "its right
   * part"). `after` gets the changed values.
   */
  const fieldSentence = (coll: string, ops: readonly PlainOp[], before: Rec | undefined, doc: Doc, name: string, after: Rec): { text: string; verb: string } | null => {
    const cs = schema.collections[coll]!;
    const f = new Map<string, PlainOp>();
    for (const op of ops) if (op.path.length === 3) f.set(op.path[2] as string, op);
    const first: string[] = [], rest: string[] = [];
    let verb = "Changed %s";
    const say = (whole: string, its: string, v?: string) => {
      if (!first.length) {
        first.push(whole);
        if (v) verb = v;
      } else rest.push(its);
    };
    let todo: readonly PlainOp[] = ops;
    const phrases = cs.phrases;
    if (phrases) {
      const said = new Set<string>();
      for (const op of ops) {
        const p = phrases[op.path[2] as string];
        if (!p) continue;
        const t = phraseFor(p, op, doc, schema);
        if (!said.has(t)) say(t.replace("%s", name), lower(t.replace("%s", "it")), t);
        said.add(t);
      }
      todo = todo.filter((op) => !phrases[op.path[2] as string]);
    }
    if (tl && coll === tl.lanes && f.get(POS)) {
      say(`Reordered ${name}`, "reordered it", "Reordered %s");
      todo = todo.filter((op) => op !== f.get(POS));
    }
    if (tl && coll === tl.collection && before) {
      const s = f.get(tl.start), e = f.get(tl.end), ln = f.get(tl.lane), src = f.get(tl.source);
      const used = new Set([s, e, ln, src, f.get(tl.sourceEnd)].filter(Boolean));
      const os = before[tl.start] as number, oe = before[tl.end] as number;
      const ns = s ? (s as { value: number }).value : os, ne = e ? (e as { value: number }).value : oe;
      const track = ln ? toTrack((ln as { value: unknown }).value) : "";
      if (s && e && Math.abs(ns - os - (ne - oe)) < 1e-4 && Math.abs(ns - os) > 1e-4) {
        const d = ns - os;
        say(`Moved ${name} ${secs(d)} ${d > 0 ? "later" : "earlier"}${track ? ` to ${track}` : ""} (now starts at ${timecode(ns)})`, `moved it ${secs(d)} ${d > 0 ? "later" : "earlier"}${track ? ` to ${track}` : ""}`, "Moved %s");
      } else {
        if (s && e) say(`Trimmed ${name}, now ${timecode(ns)} to ${timecode(ne)}`, `trimmed it to ${timecode(ns)}–${timecode(ne)}`, "Trimmed %s");
        else if (e) say(`Trimmed ${name}, now ends at ${timecode(ne)}`, `trimmed it to end at ${timecode(ne)}`, "Trimmed %s");
        else if (s) say(`Trimmed ${name}, now starts at ${timecode(ns)}`, `trimmed it to start at ${timecode(ns)}`, "Trimmed %s");
        else if (src && typeof before[tl.source] === "number") {
          const d = (src as { value: number }).value - (before[tl.source] as number);
          say(`Slipped ${name} ${secs(d)} ${d > 0 ? "later" : "earlier"} in its footage`, `slipped it ${secs(d)} ${d > 0 ? "later" : "earlier"} in its footage`, "Slipped %s");
        }
        if (track) say(`Moved ${name} to ${track}`, `moved it to ${track}`, "Moved %s");
      }
      todo = todo.filter((op) => !used.has(op));
    }
    // an element of a keyed list by its own name or type ("blur"), else its key when that isn't an id, else nothing
    const elem = (op: PlainOp) => {
      const v = (op.op === "insert" ? op.value : getIn(doc, op.path, schema)) as Rec | undefined;
      const own = v && typeof v === "object" ? [v.name, v.type, v.label].find((x) => typeof x === "string" && x) : undefined;
      if (typeof own === "string") return ` ${curly(own.length > 40 ? own.slice(0, 37) + "…" : own)}`;
      const spec = specAt(schema, op.path.slice(0, 3)), k = op.path.at(-1);
      return (spec?.kind === "keyed" && isIdKey(spec.key)) || opaque("", k) || typeof k !== "string" ? "" : ` ${curly(k)}`;
    };
    const isCaption = !!before && cs.nounOf?.(before) === "caption";
    for (const op of todo) {
      const field = editorField(schema, op.path);
      const list = editorField(schema, op.path.slice(0, 3));
      const key = op.path.slice(2).filter((x) => typeof x === "string").join(".");
      // a keyed list set whole where there was none: its elements added
      const spec = op.op === "set" && op.path.length === 3 && Array.isArray(op.value) && op.value.length ? specAt(schema, op.path) : undefined;
      const was = spec?.kind === "keyed" ? getIn(doc, op.path, schema) : null;
      if (spec?.kind === "keyed" && (was === undefined || (Array.isArray(was) && !was.length))) {
        for (const v of (op as { value: Rec[] }).value) {
          const e = elem({ op: "insert", path: [...op.path, String(v?.[spec.key] ?? "")], value: v } as PlainOp);
          say(`Added ${list}${e} to ${name}`, `added ${list}${e}`, "Changed %s");
        }
        continue;
      }
      if (op.op === "insert") say(`Added ${list}${elem(op)} to ${name}`, `added ${list}${elem(op)}`);
      else if (op.op === "remove") say(`Removed ${list}${elem(op)} from ${name}`, `removed ${list}${elem(op)}`);
      else if (op.path.at(-1) === POS) say(`Reordered the ${list} of ${name}`, `reordered its ${list}`);
      else if (op.op === "unset") say(`Cleared the ${field} of ${name}`, `cleared its ${field}`, `Cleared the ${field} of %s`);
      else {
        const old = getIn(doc, op.path, schema), v = op.value;
        if (opaque(op.path[2], v) || opaque(op.path[2], old) || opaque(op.path.at(-1), v)) {
          // an id or a hash is never shown: its field alone, or the host's words for it (a media's file name)
          const host = opts.value?.(key, v, doc);
          const to = host !== undefined ? ` to ${host.replace(/^'(.*)'$/, "“$1”")}` : "";
          say(`Changed the ${field} of ${name}${to}`, `changed its ${field}${to}`, `Changed the ${field} of %s`);
          continue;
        }
        // the field the record is named by (a title's text, a caption's, a name): "Changed “Hello” to “Hello world”"
        if (op.path.length === 3 && typeof v === "string" && before) {
          const now = label(coll, { ...before, [op.path[2] as string]: v }), then = label(coll, before);
          if (now !== then) {
            if (isCaption) say(`Changed caption to ${curly(now)}`, `changed it to ${curly(now)}`, "Changed %s");
            else if (op.path[2] === "name") say(`Renamed ${curly(then)} to ${curly(now)}`, `renamed it to ${curly(now)}`, "Renamed %s");
            else say(`Changed ${curly(then)} to ${curly(now)}`, `changed it to ${curly(now)}`, "Changed %s");
            continue;
          }
        }
        // a structure set whole (a clip's first color grade): its labelled leaves that changed, each in its own words
        if (isObj(v) && !Array.isArray(v)) {
          const was = leaves(old), now = leaves(v);
          const lbl = cs.labels ?? {};
          let any = false;
          for (const [k, x] of now) {
            const full = `${key}.${k}`, l = lbl[full.replace(/\.[^.]*~[^.]*/g, "")] ?? lbl[full];
            if (!l || deepEqual(was.get(k), x)) continue;
            const wx = words(full, x, doc);
            if (wx === null) continue;
            any = true;
            if (was.get(k) === undefined) say(`Set the ${l} of ${name} to ${wx}`, `set its ${l} to ${wx}`);
            else say(`Changed the ${l} of ${name} to ${wx}`, `changed its ${l} to ${wx}`);
          }
          if (any) continue;
        }
        const w = words(key, v, doc);
        if (typeof v === "number" && typeof old === "number" && SIZE.test(field) && v !== old) {
          const how = v > old ? "bigger" : "smaller", w0 = words(key, old, doc) ?? num(old);
          say(`Made ${name} ${how} (${field} ${w0} → ${w ?? num(v)})`, `made it ${how} (${field} ${w0} → ${w ?? num(v)})`, `Made %s ${how}`);
        } else if (old === undefined) say(w === null ? `Set the ${field} of ${name}` : `Set the ${field} of ${name} to ${w}`, w === null ? `set its ${field}` : `set its ${field} to ${w}`, `Set the ${field} of %s`);
        else say(w === null ? `Changed the ${field} of ${name}` : `Changed the ${field} of ${name} to ${w}`, w === null ? `changed its ${field}` : `changed its ${field} to ${w}`, `Changed the ${field} of %s`);
      }
    }
    if (!first.length) return null;
    if (rest.length > 3) rest.splice(2, rest.length - 2, `and ${rest.length - 2} more changes`);
    void after;
    return { text: [first[0]!, ...rest].join(", "), verb };
  };

  const out: ChangeRow[] = [];
  const split = new Map<string, Split | null>();
  for (const sp of findSplits(groups, base, schema, label)) {
    split.set(sp.key, sp);
    for (const p of sp.parts) split.set(p.key, null);
  }
  for (const k of heldParts(groups, base, schema, opts.names).keys()) split.set(k, null);
  for (const [gk, g] of groups) {
    const sp = split.get(gk);
    if (sp === null) continue; // a split's part, or a part held by another record: told with it
    // the record's path key, escaped as everywhere else (`touched`, cards, the Fold dialog's rows); a root field's too
    const key = g.coll ? pathKey([g.coll, g.id as string]) : pathKey([gk]);
    if (sp) {
      const name = quoted(sp.coll, sp.rec);
      const said: string[] = [`Split ${name} at ${and(sp.at.map(timecode))}`];
      const drops = new Set((tl!.splitDrops ?? EMPTY).filter((f) => sp.rec[f] !== undefined && sp.parts.every((p) => p.rec[f] === undefined)));
      sp.parts.forEach(({ rec, ideal }, i) => {
        const id = rec[schema.collections[sp.coll]!.key] as string;
        const ops: PlainOp[] = [];
        for (const f of new Set([...Object.keys(rec), ...Object.keys(ideal)])) {
          const v = rec[f], was = ideal[f];
          const timing = f === tl!.start || f === tl!.end || f === tl!.source || f === tl!.sourceEnd || f === tl!.lane;
          const plainV = (x: unknown) => x === null || typeof x !== "object";
          if (timing) {
            if (!close(v, was)) ops.push({ op: "set", path: [sp.coll, id, f], value: v });
          } else if (was === undefined) {
            if (v !== undefined) ops.push({ op: "set", path: [sp.coll, id, f], value: v });
          } else if (v === undefined) {
            if (plainV(was) && !drops.has(f)) ops.push({ op: "unset", path: [sp.coll, id, f] });
          } else if (plainV(v) && plainV(was) && v !== was) ops.push({ op: "set", path: [sp.coll, id, f], value: v });
        }
        if (!ops.length) return;
        const doc = { ...base, [sp.coll]: [...((base[sp.coll] as Rec[] | undefined) ?? EMPTY), ideal] };
        const part = `its ${sp.parts.length === 2 ? (i ? "right" : "left") : (PART[i] ?? `${i + 1}th`)} part`;
        const l = fieldSentence(sp.coll, ops, ideal, doc, part, rec);
        if (l) said.push(lower(l.text));
      });
      out.push({ key, text: said.join(", "), kind: "change", coll: sp.coll, id: String(sp.rec[K!]), rec: sp.rec, ...place(sp.coll, sp.rec), verb: "Split %s", one: name });
      continue;
    }
    if (!g.coll) {
      // a root field (the project's): "Changed the aspect ratio to 9:16", "Named the project “Dragon short”"
      const op = g.ops[0]!;
      const old = getIn(base, op.path, schema);
      const fw = fieldWords(schema, op.path);
      const what = `the ${editorField(schema, op.path)}`;
      const v = (op as { value?: unknown }).value;
      const w = words(op.path.join("."), v, base);
      let text: string;
      if (g.ops.length > 1 || op.op === "unset") text = op.op === "unset" && g.ops.length === 1 ? `Cleared ${what}` : `Changed ${what}`;
      else if (opaque(op.path.at(-1), v) || opaque(op.path.at(-1), old)) text = `${old === undefined ? "Set" : "Changed"} ${what}`;
      else if (old === undefined && fw.labelled && typeof v === "string" && fw.words.endsWith(" name")) text = `Named the ${fw.words.slice(0, -" name".length)} ${curly(v.length > 40 ? v.slice(0, 37) + "…" : v)}`;
      else text = w === null ? `${old === undefined ? "Set" : "Changed"} ${what}` : `${old === undefined ? "Set" : "Changed"} ${what} to ${w}`;
      out.push({ key, text, kind: "change", coll: null });
      continue;
    }
    const before = getIn(base, [g.coll, g.id as string], schema) as Rec | undefined;
    const whole = g.ops.find((op) => op.path.length === 2);
    const id = String(g.id);
    if (whole?.op === "insert") {
      const r = whole.value as Rec;
      out.push({ key, text: `Added ${called(g.coll, r)}`, kind: "add", coll: g.coll, id, rec: r, ...place(g.coll, r), verb: "Added %s", one: called(g.coll, r) });
      continue;
    }
    if (whole) {
      out.push({ key, text: `Removed ${called(g.coll, before)}`, kind: "remove", coll: g.coll, id, ...(before ? { rec: before } : {}), ...place(g.coll, before), verb: "Removed %s", one: called(g.coll, before) });
      continue;
    }
    // the record as it is after: its place in the edit is where it is now
    const after: Rec = { ...(before ?? {}) };
    for (const op of g.ops) if (op.path.length === 3 && (op.op === "set" || op.op === "unset")) after[op.path[2] as string] = op.op === "set" ? op.value : undefined;
    const name = tl && g.coll === tl.lanes ? called(g.coll, before) : quoted(g.coll, before);
    const l = fieldSentence(g.coll, g.ops, before, base, name, after);
    // a record whose ops say nothing an editor reads (a field nobody labels): still a change, so the counts agree
    out.push({ key, text: l?.text ?? `Changed ${name}`, kind: "change", coll: g.coll, id, rec: after, ...place(g.coll, after), verb: l?.verb ?? "Changed %s", one: name });
  }
  // a track added only for the clips moved onto it is said by their rows ("Moved “W6” to a new track")
  if (movedOnto.size) for (const r of out) if (r.kind === "add" && tl && r.coll === tl.lanes && movedOnto.has(r.id)) r.minor = true;
  return out;
}

/**
 * Several change rows in one line, a version's title in History: the row itself when there is one, else grouped by
 * what was done ("Moved “a” and “b”, trimmed “c”"; several of a kind by their count, "Added 3 captions"), at most three
 * groups ("…, and 2 more changes"). A minor row (a track made for the clips moved onto it) is said by theirs.
 */
export function changeSummary(rows: readonly ChangeRow[], schema: Schema): string {
  const ls = rows.some((r) => !r.minor) ? rows.filter((r) => !r.minor) : rows;
  if (ls.length <= 1) return ls[0]?.text ?? "";
  const nounOf = (r: ChangeRow) => {
    if (!r.coll) return "change";
    const cs = schema.collections[r.coll];
    const own = cs?.nounOf && r.rec ? cs.nounOf(r.rec) : undefined;
    return own ?? cs?.noun ?? (r.coll === schema.timeline?.lanes ? "track" : "item");
  };
  const groups: { verb?: string; text?: string; n: number; byNoun: Map<string, string[]> }[] = [];
  for (const r of ls) {
    const v = r.verb && r.one ? r.verb : undefined;
    let g = v ? groups.find((x) => x.verb === v) : undefined;
    if (!g) groups.push((g = { ...(v ? { verb: v } : { text: r.text }), n: 0, byNoun: new Map() }));
    g.n++;
    if (v) {
      const k = nounOf(r) ?? "item";
      (g.byNoun.get(k) ?? g.byNoun.set(k, []).get(k)!).push(r.one!);
    }
  }
  const parts = groups.map((g) => {
    if (!g.verb) return g.text!;
    const one = g.byNoun.size === 1;
    const what = [...g.byNoun].map(([noun, xs]) => (xs.length === 1 ? xs[0]! : one && xs.length === 2 ? `${xs[0]} and ${xs[1]}` : `${xs.length} ${plural(noun)}`));
    return g.verb.replace("%s", and(what));
  });
  if (parts.length > 3) {
    const rest = groups.slice(2).reduce((n, g) => n + g.n, 0);
    parts.splice(2, parts.length - 2, `and ${rest} more change${rest === 1 ? "" : "s"}`);
  }
  return cap(parts.map((w, i) => (i ? lower(w) : w)).join(", "));
}

// ---------------------------------------------------------------- conflict cards in words

/** A conflict card in plain words (§7): what it is about, and what each side did differently. */
export interface CardWords {
  /** "“Dragon-take2.mp4” timing", "“Intro” opacity", "Project name". */
  title: string;
  /** What core's `ours` side did, in the change sentences' words (UX redesign 0.2): "Moved it to start at 0:03", "Removed". */
  ours: string;
  theirs: string;
  /** The record's name ("Dragon-take2.mp4"), when it has one: a viewing label says "Claude Code's move of “…”". */
  name?: string;
  /** Why the two don't combine, when the engine's reason is words for an editor. */
  reason?: string;
}
export interface CardWordsOptions {
  /**
   * A field's value in the host's words (Cardboard: speed "2×", volume "80%", a media id as its file name); undefined
   * for the default. `key` is the field's dotted path in the record. An id field is shown only when this words it.
   */
  value?: (key: string, value: unknown, doc: Doc | undefined) => string | undefined;
}

// The time algebra's reasons are the engine's own terms, not an editor's: such a card says only that both are kept.
const ENGINE_REASONS = new Set(["same kind or incompatible", "unclassified", "ambiguous", "invalid"]);
const isIdKey = (k: string) => k === "id" || /Ids?$/.test(k.slice(k.lastIndexOf(".") + 1));
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const EPS = 1e-4;

/** The leaves of a record value, by dotted path (arrays are one leaf). */
function leaves(v: unknown, prefix = "", out = new Map<string, unknown>(), depth = 0): Map<string, unknown> {
  if (isObj(v) && depth < 4) for (const k in v) leaves(v[k], prefix ? `${prefix}.${k}` : k, out, depth + 1);
  else if (prefix) out.set(prefix, v);
  return out;
}

/**
 * A conflict card in plain words: the record's label (looked up in `doc` when given), and for each side only what
 * differs from the other side, worded with the schema's field labels and times in seconds as `describe` words them.
 * Never ids: an id field shows only when `opts.value` words it, and the timeline's lane is the lane's name.
 */
export function describeCard(card: ConflictCard, schema: Schema, doc?: Doc, opts: CardWordsOptions = {}): CardWords {
  const path: string[] = card.path.split("/").map(unescapeSegment);
  const coll = schema.collections[path[0]!] ? path[0]! : null;
  const cs = coll ? schema.collections[coll]! : null;
  const tl = schema.timeline;
  const whole = !!coll && path.length === 2;
  const rest = coll ? path.slice(2) : path;
  const group = rest.length === 1 && rest[0]!.startsWith("#") && rest[0] !== POS ? rest[0]!.slice(1) : null;
  const atDoc = coll && doc ? (getIn(doc, [coll, path[1]!], schema) as Rec | undefined) : undefined;
  const rec = (whole ? (card.ours ?? card.theirs ?? card.base ?? atDoc) : atDoc) as Rec | undefined;
  const noun = cs?.noun ?? "item";
  const name = coll && rec ? (schema.label?.(coll, rec, doc) ?? (typeof rec.name === "string" && rec.name ? rec.name : undefined)) : undefined;
  const part = group ? (group === "time" ? "timing" : group) : rest.length ? (rest.at(-1) === POS ? "order" : fieldWords(schema, path).words) : "";
  const cap = (x: string) => (x ? x[0]!.toUpperCase() + x.slice(1) : x);
  const title = coll ? `${name ? `“${name}”` : cap(noun)}${part ? ` ${part}` : ""}` : cap(part || card.path);

  const isTimeline = !!tl && coll === tl.collection;
  const laneName = (id: unknown) => {
    const t = tl && doc ? (getIn(doc, [tl.lanes, id as string], schema) as Rec | undefined) : undefined;
    return t ? `track “${schema.label?.(tl!.lanes, t, doc) ?? String(t.name ?? "")}”` : "another track";
  };
  // A field's words: its label (or its nearest labelled parent's), else its path when the collection labels nothing.
  const labelOf = (key: string): string | null => {
    const labels = cs ? cs.labels : schema.labels;
    const parts = key.split(".");
    for (let n = parts.length; n > 0; n--) {
      const l = labels?.[parts.slice(0, n).join(".")];
      if (l) return l;
    }
    return labels && Object.keys(labels).length ? null : key;
  };
  const num = (x: number) => (Number.isInteger(x) ? String(x) : String(+x.toFixed(2)));
  const valueWords = (key: string, v: unknown): string | null => {
    const host = opts.value?.(key, v, doc);
    if (host !== undefined) return host.replace(/^'(.*)'$/, "“$1”");
    if (typeof v === "number") return num(v);
    if (typeof v === "string") return `“${v.length > 40 ? v.slice(0, 37) + "…" : v}”`;
    if (typeof v === "boolean") return v ? "on" : "off";
    return null; // an object or a list: "changed"
  };
  const fieldPart = (key: string, v: unknown): string | null => {
    if (isIdKey(key)) {
      const host = opts.value?.(key, v, doc);
      return host === undefined ? null : `${labelOf(key) ?? key} ${host.replace(/^'(.*)'$/, "“$1”")}`;
    }
    const l = labelOf(key);
    if (!l) return null;
    if (v === undefined) return `no ${l}`;
    const w = valueWords(key, v);
    return w === null ? `${l} changed` : `${l} ${w}`;
  };
  // A clip's times on one side, against the base, as the change sentences say them (UX redesign 0.2): "Moved it to
  // start at 0:03", "Trimmed it to end at 0:06".
  const timeWords = (v: Record<string, unknown>, b: Record<string, unknown> | undefined): string | null => {
    if (!tl) return null;
    const s = v[tl.start], e = v[tl.end];
    const bs = b?.[tl.start], be = b?.[tl.end];
    if (typeof s !== "number" || typeof e !== "number") return null;
    if (typeof bs !== "number" || typeof be !== "number") return `${whole && !b ? "Added it at" : "At"} ${timecode(s)} to ${timecode(e)}`;
    const ds = s - bs, de = e - be;
    if (Math.abs(ds) < EPS && Math.abs(de) < EPS) {
      const src = v[tl.source], bsrc = b?.[tl.source];
      if (typeof src === "number" && typeof bsrc === "number" && Math.abs(src - bsrc) > EPS) return `Slipped its footage to start ${secs(src)} in`;
      return `Left it at ${timecode(s)} to ${timecode(e)}`;
    }
    if (Math.abs(ds - de) < EPS) return `Moved it to start at ${timecode(s)}`;
    if (Math.abs(ds) < EPS) return `Trimmed it to end at ${timecode(e)}`;
    if (Math.abs(de) < EPS) return `Trimmed it to start at ${timecode(s)}`;
    return `Set it to play ${timecode(s)} to ${timecode(e)}`;
  };
  const TIME = new Set(tl ? [tl.start, tl.end, tl.source, tl.sourceEnd] : []);
  // What one side holds, as far as it differs from the other side (else from the base). Against a removed side, what
  // this side changed.
  const fieldsWords = (v: Record<string, unknown>, other: unknown, b: unknown): string => {
    const lv = leaves(v), lo = leaves(isObj(other) ? other : b), lb = leaves(b);
    let keys = [...new Set([...lv.keys(), ...lo.keys()])].filter((k) => !deepEqual(lv.get(k), lo.get(k)) && !k.endsWith(POS) && k !== POS);
    if (!keys.length) keys = [...lv.keys()].filter((k) => !deepEqual(lv.get(k), lb.get(k)));
    const parts: string[] = [];
    if (isTimeline && keys.some((k) => TIME.has(k))) {
      const t = timeWords(v, isObj(b) ? b : undefined);
      if (t) parts.push(t);
    }
    if (isTimeline && tl && keys.includes(tl.lane)) parts.push(isObj(b) && b[tl.lane] !== undefined && b[tl.lane] !== v[tl.lane] ? `moved to ${laneName(v[tl.lane])}` : `on ${laneName(v[tl.lane])}`);
    for (const k of keys) {
      if (isTimeline && (TIME.has(k) || k === tl!.lane)) continue;
      const p = fieldPart(k, lv.get(k));
      if (p && !parts.includes(p)) parts.push(p);
    }
    if (!parts.length) return whole && !isObj(b) ? "Added it" : "Changed it";
    if (parts.length > 3) parts.splice(2, parts.length - 2, `and ${parts.length - 2} more changes`);
    return cap(parts.join(", "));
  };
  const side = (v: unknown, other: unknown): string => {
    if (v === undefined || v === null) return whole || card.kind === "parent" || card.kind === "record" ? "Removed" : "Cleared";
    if (rest.at(-1) === POS) return "Its own order";
    if (whole || group) return isObj(v) ? fieldsWords(v, other, card.base) : "Changed it";
    const key = rest.join(".");
    if (isTimeline && tl && key === tl.lane) return `On ${laneName(v)}`;
    const w = valueWords(key, v);
    return w === null ? "Changed it" : cap(w);
  };
  return {
    title,
    ours: side(card.ours, card.theirs),
    theirs: side(card.theirs, card.ours),
    ...(name ? { name } : {}),
    ...(card.reason && !ENGINE_REASONS.has(card.reason) ? { reason: card.reason } : {}),
  };
}
