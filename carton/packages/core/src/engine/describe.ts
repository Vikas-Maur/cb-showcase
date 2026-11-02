// describe (PLAN §9, layer 1): one short sentence per changed record (plus one per remap step), e.g.
// "Trimmed 'Intro' end 6.0 s → 5.0 s". Never prints more than four parts per record.
import { POS } from "../types.ts";
import type { FieldSpec, Schema } from "../schema.ts";
import type { ConflictCard, Doc, Intent, Op, Path, Rec, RemapMaps, RemapOp } from "../types.ts";
import { getIn } from "./doc.ts";
import { EMPTY, deepEqual, unescapeSegment } from "./json.ts";
import { composeMaps, inferRemaps, near, remapSpan } from "./remap.ts";

type PlainOp = Exclude<Op, RemapOp>;
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
}

// A value no person reads (UI audit P1-2): a hash, a UUID, or a structure holding one. Shown by its field's name only.
const HASHY = /^(?:[0-9a-f]{16,}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;
const HASH_IN = /[0-9a-f]{16,}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-/i;
const opaque = (key: unknown, v: unknown): boolean =>
  isIdKey(String(key)) || /(?:^h|H)ash(?:es)?$/.test(String(key)) || (typeof v === "string" ? HASHY.test(v) : !!v && typeof v === "object" && HASH_IN.test(JSON.stringify(v) ?? ""));

export function describe(ops: readonly Op[], base: Doc, schema: Schema, intent: Intent | null = null): string[] {
  return lines(ops, base, schema, intent).map((l) => l.text);
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

function summaryOf(ls: readonly Line[], schema: Schema): string {
  if (ls.length <= 1) return ls[0]?.text ?? "";
  const groups: { verb?: string; text?: string; n: number; byColl: Map<string, string[]> }[] = [];
  for (const l of ls) {
    let g = l.verb ? groups.find((x) => x.verb === l.verb) : undefined;
    if (!g) groups.push((g = { ...(l.verb ? { verb: l.verb } : { text: l.text }), n: 0, byColl: new Map() }));
    g.n++;
    if (l.verb) (g.byColl.get(l.coll!) ?? g.byColl.set(l.coll!, []).get(l.coll!)!).push(l.one!);
  }
  const noun = (coll: string) => schema.collections[coll]?.noun ?? (coll === schema.timeline?.lanes ? "track" : "item");
  const words = groups.map((g) => {
    if (!g.verb) return g.text!;
    const one = g.byColl.size === 1;
    const what = [...g.byColl].map(([coll, xs]) => (xs.length === 1 ? xs[0]! : one && xs.length === 2 ? `${xs[0]} and ${xs[1]}` : `${xs.length} ${plural(noun(coll))}`));
    return g.verb.replace("%s", and(what));
  });
  if (words.length > 3) {
    const rest = groups.slice(2).reduce((n, g) => n + g.n, 0);
    words.splice(2, words.length - 2, `and ${rest} more change${rest === 1 ? "" : "s"}`);
  }
  return words.map((w, i) => (i ? lower(w) : w)).join(", ");
}

function lines(ops: readonly Op[], base: Doc, schema: Schema, intent: Intent | null): Line[] {
  const tl = schema.timeline,
    out: Line[] = [];
  const plain = ops.filter((op): op is PlainOp => op.op !== "remap");
  // The doc a label looks names up in (a clip is named after its media's file name): base, plus the records this
  // change inserts, so a clip added with its media is named after it. Built once, only when a label asks.
  let named: Doc | null = null;
  const nameDoc = (): Doc => {
    if (named) return named;
    const added = new Map<string, Rec[]>();
    for (const op of plain) {
      if (op.op !== "insert" || op.path.length !== 2 || !schema.collections[op.path[0] as string]) continue;
      const c = op.path[0] as string;
      let l = added.get(c);
      if (!l) added.set(c, (l = []));
      l.push(op.value as Rec);
    }
    named = base;
    if (added.size) {
      named = { ...base };
      for (const [c, l] of added) named[c] = [...((base[c] as Rec[] | undefined) ?? EMPTY), ...l];
    }
    return named;
  };
  const label = (coll: string, rec: Rec | undefined) => schema.label?.(coll, rec, nameDoc()) ?? String(rec?.name ?? rec?.id ?? "?");
  // a track made in the same change is named too (UI audit P1-6's drag onto a new track read "to track track 3f9a1c")
  const laneName = (id: unknown) => {
    const t = tl && (getIn(nameDoc(), [tl.lanes, id as string], schema) as Rec | undefined);
    return t ? `'${label(tl!.lanes, t)}'` : "another track";
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
    const noun = g.coll === tl?.lanes ? cs.noun ?? "track" : ((((before ?? (whole as { value?: Rec } | undefined)?.value) as Rec | undefined)?.type as string | undefined) ?? cs.noun ?? "item");
    if (whole?.op === "insert") {
      const r = whole.value as Rec;
      const where = tl && g.coll === tl.collection ? ` on ${laneName(r[tl.lane])} at ${fmtT(r[tl.start] as number)}` : "";
      out.push({ text: `Added ${noun} '${label(g.coll, r)}'${where}`, verb: "Added %s", coll: g.coll, one: `${noun} '${label(g.coll, r)}'` });
      continue;
    }
    if (whole) {
      out.push({ text: `Deleted ${noun} '${label(g.coll, before)}'`, verb: "Deleted %s", coll: g.coll, one: `${noun} '${label(g.coll, before)}'` });
      continue;
    }
    const name = `'${label(g.coll, before)}'`;
    const f = new Map<string, PlainOp>();
    for (const op of g.ops) if (op.path.length === 3) f.set(op.path[2] as string, op);
    const parts: string[] = [];
    let verb = "Changed %s";
    let rest = g.ops;
    // a field the host words as a phrase ("Linked %s for sharing"): one phrase for all its ops, never its values
    const phrases = cs.phrases;
    if (phrases) {
      const said = new Set<string>();
      for (const op of g.ops) {
        const p = phrases[op.path[2] as string];
        if (!p) continue;
        const gone = op.path.length === 3 && (op.op === "unset" || op.op === "remove");
        const fresh = op.path.length === 3 && op.op !== "unset" && op.op !== "remove" && getIn(base, op.path, schema) === undefined;
        const t = gone ? p.cleared : fresh ? p.set : (p.changed ?? p.set);
        if (!parts.length) verb = t;
        if (!said.has(t)) parts.push(t.replace("%s", name));
        said.add(t);
      }
      rest = rest.filter((op) => !phrases[op.path[2] as string]);
    }
    if (g.coll === tl?.lanes && f.get(POS)) {
      if (!parts.length) verb = "Reordered %s";
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
      const n0 = parts.length;
      if (explained.has(g.id)) used.add(s).add(e);
      else if (s && e && Math.abs(val(s) - os - (val(e) - oe)) < 1e-4) parts.push(`Moved ${name} ${fmtT(os)} → ${fmtT(val(s))}`);
      else if (s && e) parts.push(`Retimed ${name} ${fmtT(os)}–${fmtT(oe)} → ${fmtT(val(s))}–${fmtT(val(e))}`);
      else if (e) parts.push(`Trimmed ${name} end ${fmtS(oe)} → ${fmtS(val(e))}`);
      else if (s) parts.push(`Trimmed ${name} start ${fmtS(os)} → ${fmtS(val(s))}`);
      else if (f.get(tl.source)) parts.push(`Slipped ${name} source in ${fmtS(before[tl.source] as number)} → ${fmtS(val(f.get(tl.source)))}`);
      if (ln) parts.push(parts.length ? `to track ${laneName(val(ln))}` : `Moved ${name} to track ${laneName(val(ln))}`);
      if (!n0 && parts.length) verb = `${parts[0]!.split(" ")[0]} %s`;
      rest = rest.filter((op) => !used.has(op));
    }
    for (const op of rest) {
      const field = fieldWords(schema, op.path).words;
      const list = fieldWords(schema, op.path.slice(0, 3)).words;
      if (op.op === "insert") parts.push(`added ${list} ${short(op.path.at(-1))}`);
      else if (op.op === "remove") parts.push(`removed ${list} ${short(op.path.at(-1))}`);
      else if (op.path.at(-1) === POS) parts.push(`reordered ${list}`);
      else if (op.op === "unset") parts.push(`cleared ${field}`);
      else {
        const old = getIn(base, op.path, schema);
        // never an id or a hash (UI audit P1-2): the field is named alone
        if (opaque(op.path[2], op.value) || opaque(op.path[2], old) || opaque(op.path.at(-1), op.value)) parts.push(`changed ${field}`);
        else parts.push(old === undefined ? `set ${field} to ${short(op.value)}` : `${field} ${short(old)} → ${short(op.value)}`);
      }
    }
    if (!parts.length) continue;
    if (parts.length > 4) parts.splice(3, parts.length - 3, `and ${parts.length - 3} more changes`);
    const p0 = parts[0]!;
    if (!/^[A-Z]/.test(p0))
      parts[0] = p0.startsWith("set ") ? `Set ${name} ${p0.slice(4)}` : p0.startsWith("changed ") ? `Changed ${name} ${p0.slice(8)}` : /^(added|removed|reordered|cleared) /.test(p0) ? `${p0[0]!.toUpperCase()}${p0.slice(1)} on ${name}` : `Changed ${name} ${p0}`;
    out.push({ text: parts.map((p, i) => (i ? lower(p) : p)).join(", "), verb, coll: g.coll, one: name });
  }
  return out;
}

// ---------------------------------------------------------------- conflict cards in words

/** A conflict card in plain words (§7): what it is about, and what each side did differently. */
export interface CardWords {
  /** "'Dragon-take2.mp4' timing", "'Intro' opacity", "Project name". */
  title: string;
  /** What core's `ours` side did: "Moved 1.5 s → 3.0 s", "Removed". */
  ours: string;
  theirs: string;
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
  const title = coll ? `${name ? `'${name}'` : cap(noun)}${part ? ` ${part}` : ""}` : cap(part || card.path);

  const isTimeline = !!tl && coll === tl.collection;
  const laneName = (id: unknown) => {
    const t = tl && doc ? (getIn(doc, [tl.lanes, id as string], schema) as Rec | undefined) : undefined;
    return t ? `'${schema.label?.(tl!.lanes, t, doc) ?? String(t.name ?? "")}'` : "another track";
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
    if (host !== undefined) return host;
    if (typeof v === "number") return num(v);
    if (typeof v === "string") return JSON.stringify(v.length > 40 ? v.slice(0, 37) + "…" : v);
    if (typeof v === "boolean") return v ? "on" : "off";
    return null; // an object or a list: "changed"
  };
  const fieldPart = (key: string, v: unknown): string | null => {
    if (isIdKey(key)) {
      const host = opts.value?.(key, v, doc);
      return host === undefined ? null : `${labelOf(key) ?? key} ${host}`;
    }
    const l = labelOf(key);
    if (!l) return null;
    if (v === undefined) return `no ${l}`;
    const w = valueWords(key, v);
    return w === null ? `${l} changed` : `${l} ${w}`;
  };
  // A clip's times on one side, against the base: "Moved 1.5 s → 3.0 s", "Trimmed end 4.5 s → 6.0 s".
  const timeWords = (v: Record<string, unknown>, b: Record<string, unknown> | undefined): string | null => {
    if (!tl) return null;
    const s = v[tl.start], e = v[tl.end];
    const bs = b?.[tl.start], be = b?.[tl.end];
    if (typeof s !== "number" || typeof e !== "number") return null;
    if (typeof bs !== "number" || typeof be !== "number") return `${whole && !b ? "Added at" : "At"} ${fmtT(s)}–${fmtT(e)}`;
    const ds = s - bs, de = e - be;
    if (Math.abs(ds) < EPS && Math.abs(de) < EPS) {
      const src = v[tl.source], bsrc = b?.[tl.source];
      if (typeof src === "number" && typeof bsrc === "number" && Math.abs(src - bsrc) > EPS) return `Slipped source in ${fmtS(bsrc)} → ${fmtS(src)}`;
      return `Left at ${fmtT(s)}–${fmtT(e)}`;
    }
    if (Math.abs(ds - de) < EPS) return `Moved ${fmtT(bs)} → ${fmtT(s)}`;
    if (Math.abs(ds) < EPS) return `Trimmed end ${fmtS(be)} → ${fmtS(e)}`;
    if (Math.abs(de) < EPS) return `Trimmed start ${fmtS(bs)} → ${fmtS(s)}`;
    return `Retimed ${fmtT(bs)}–${fmtT(be)} → ${fmtT(s)}–${fmtT(e)}`;
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
    if (isTimeline && tl && keys.includes(tl.lane)) parts.push(isObj(b) && b[tl.lane] !== undefined && b[tl.lane] !== v[tl.lane] ? `moved to track ${laneName(v[tl.lane])}` : `on track ${laneName(v[tl.lane])}`);
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
    if (isTimeline && tl && key === tl.lane) return `On track ${laneName(v)}`;
    const w = valueWords(key, v);
    return w === null ? "Changed it" : cap(w);
  };
  return {
    title,
    ours: side(card.ours, card.theirs),
    theirs: side(card.theirs, card.ours),
    ...(card.reason && !ENGINE_REASONS.has(card.reason) ? { reason: card.reason } : {}),
  };
}
