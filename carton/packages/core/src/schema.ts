// The document schema (PLAN §4.1): root scalars and keyed collections, each field with a kind that decides how it is
// diffed and merged. A schema is plain data plus a few host callbacks (validators, labels, shot rules); the engine
// never hard-codes a host's field names. Format and semantics follow the core-v5 prototype (`engine.mjs`).

import type { Doc, Rec } from "./types.ts";

/**
 * How one field is versioned and merged.
 * - `scalar` (`leaf`): replaced as a value; both sides changing it differently is a card.
 * - `object`: merged by key, recursively (`deep`); `only: true` versions just the declared fields and treats the rest
 *   as ephemeral (a versioned subset, e.g. Cardboard's media records).
 * - `atomic` (`leaf` + `atomic`): arrays and objects replaced whole.
 * - `text` (`leaf` + `text`): strings merged with a line diff3; overlapping or adjacent line edits are a card.
 * - `ephemeral`: not versioned (never diffed, never in a change).
 * - `blobRef` (`leaf` + `atomic` + `blob`): replaced whole; values over 4 KB are stored once by content hash and ops
 *   carry `{$blob: hash}`.
 * - `keyed`: an array of objects identified by `key`, merged per element and ordered by `#pos` (a sequence).
 */
export type FieldSpec = LeafSpec | ObjectSpec | KeyedSpec | EphemeralSpec;

export interface LeafSpec {
  readonly kind: "leaf";
  readonly atomic?: boolean;
  readonly text?: boolean;
  readonly blob?: boolean;
}
export interface ObjectSpec {
  readonly kind: "object";
  readonly fields: Readonly<Record<string, FieldSpec>>;
  /** Undeclared object-valued children are merged recursively too. */
  readonly deep: boolean;
  /** Only the declared fields are versioned; the rest are ephemeral. */
  readonly only: boolean;
}
export interface KeyedSpec {
  readonly kind: "keyed";
  readonly key: string;
  readonly fields: Readonly<Record<string, FieldSpec>>;
  readonly elem: ObjectSpec;
}
export interface EphemeralSpec {
  readonly kind: "ephemeral";
}

export const scalar: LeafSpec = Object.freeze({ kind: "leaf" });
export const atomic: LeafSpec = Object.freeze({ kind: "leaf", atomic: true });
export const text: LeafSpec = Object.freeze({ kind: "leaf", text: true });
export const ephemeral: EphemeralSpec = Object.freeze({ kind: "ephemeral" });
export const blobRef: LeafSpec = Object.freeze({ kind: "leaf", atomic: true, blob: true });
export const object = (fields: Record<string, FieldSpec> = {}, { deep = true, only = false } = {}): ObjectSpec => ({ kind: "object", fields, deep, only });
export const keyed = (key = "id", fields: Record<string, FieldSpec> = {}): KeyedSpec => ({ kind: "keyed", key, fields, elem: { kind: "object", fields, deep: true, only: false } });

/** A recorded or inferred time-group edit, as deltas per edit kind (§4.1). `speed` is the new speed, not a delta. */
export interface TimeEdit {
  move?: number;
  /** trim-in δ: start +δ, trimStart +δ·speed */
  tin?: number;
  /** trim-out δ: end +δ, trimEnd +δ·speed */
  tout?: number;
  /** slip σ: trimStart and trimEnd +σ */
  slip?: number;
  speed?: number;
}

/** Outcome of merging one record's field group with its edit algebra. */
export type AlgebraMerge =
  | { ok: true; vals: Record<string, number>; how: "equal" | "composed"; kinds?: [TimeEdit[], TimeEdit[]] }
  | { ok: false; reason: string; kinds?: [TimeEdit[], TimeEdit[]]; vals?: Record<string, number> };

/**
 * The edit algebra of a field group: classifies each side's change against the base and composes compatible edits
 * (Cardboard's time group, §4.1 table). Built by `timeAlgebra(fields)`.
 */
export interface GroupAlgebra {
  merge(base: Rec, ours: Rec, theirs: Rec, recordedOurs?: TimeEdit, recordedTheirs?: TimeEdit): AlgebraMerge;
  /** Every minimal decomposition of `x` against `base` (empty: unclassifiable). */
  decompositions?(base: unknown, x: unknown): TimeEdit[];
}

/** Coupled fields that merge as one unit (R2-07, B13). Its path in declarations and cards is `<coll>/<id>/#<name>`. */
export interface FieldGroup {
  readonly name: string;
  readonly fields: readonly string[];
  readonly algebra?: GroupAlgebra;
}

export interface CollectionDef {
  /** Record id field (default `id`). */
  key?: string;
  /** Declared record fields; undeclared ones are atomic leaves (unknown fields from newer clients pass through). */
  fields?: Record<string, FieldSpec>;
  /** Child records point at a parent record (`items.trackId -> tracks`): parent delete vs child add is a card. */
  parent?: { field: string; collection: string };
  /** An ordered collection: records carry a fractional-index `#pos` key (B12). */
  seq?: boolean;
  groups?: FieldGroup[];
  /** Only declared fields are versioned. */
  only?: boolean;
  /** What one record is called in descriptions ("clip"); default "item" ("track" for the timeline's lanes). */
  noun?: string;
  /**
   * Editors' words for fields in descriptions, by their dotted path in the record with keyed-array element keys left
   * out: `{"colorGrade.saturation": "saturation", "effects": "effect"}`. Unlabelled fields print their path.
   */
  labels?: Record<string, string>;
}

/** A collection after `defineSchema`: groups indexed by field and the record spec built. */
export interface CollectionSpec extends Required<Pick<CollectionDef, "key">> {
  readonly fields?: Record<string, FieldSpec>;
  readonly noun?: string;
  readonly labels?: Readonly<Record<string, string>>;
  readonly parent?: { field: string; collection: string };
  readonly seq?: boolean;
  readonly only?: boolean;
  readonly groups: readonly (FieldGroup & { set: ReadonlySet<string> })[];
  readonly groupOf: ReadonlyMap<string, FieldGroup>;
  readonly record: ObjectSpec;
}

/** One time-varying window of an item (fade, transition, keyframe range), in item-local seconds. */
export interface ShotWindow {
  a: number;
  b: number;
  from: "start" | "end";
  sig?: string;
}

/** Host rules for the shot diff (§9): what is visible, stacking order, and which fields don't change the picture. */
export interface ShotRules {
  ignore?: readonly string[];
  edgeFields?: readonly string[];
  visible?(item: Rec, lane: Rec | undefined): boolean;
  rank?(item: Rec, lane: Rec | undefined): number;
  windows?(item: Rec, duration: number): ShotWindow[];
}

/**
 * Which collection is the timeline and which fields carry placement. Enables the time group, remaps, spans,
 * placement-aware validators and the shot diff.
 */
export interface TimelineConfig {
  /** Items collection (Cardboard: `timelineItems`). */
  collection: string;
  /** Lanes collection (Cardboard: `tracks`). */
  lanes: string;
  /** Item field naming its lane (`trackId`). */
  lane: string;
  start: string;
  end: string;
  /** Source in-point (`trimStart`). */
  source: string;
  /** Source out-point (`trimEnd`). */
  sourceEnd: string;
  speed: string;
  shots?: ShotRules;
}

/** A soft-validator finding: a warning on a merge or after a confirmed change, never a card (§4.1). */
export interface SoftWarning {
  kind: string;
  items?: string[];
  item?: string;
  [extra: string]: unknown;
}

/**
 * Hard validator: the host's schema invariants for one record (`endTime > startTime`, the track exists...). Returns
 * the problems (empty when valid). A failure blocks with a card in a merge, and is rejected by the sequencer.
 */
export type HardValidator = (collection: string, record: Rec, doc: Doc) => string[];

/**
 * Soft validators, run on the records a merge or a confirmed change touched.
 * `touched`: collection -> record ids; `placed`: items whose lane or times changed or that were inserted;
 * `fresh`: items whose times the merge composed or mapped.
 */
export type SoftValidator = (doc: Doc, touched: ReadonlyMap<string, ReadonlySet<string>>, sides: readonly Doc[], placed: ReadonlySet<string>, fresh: ReadonlySet<string>) => SoftWarning[];

export interface SchemaDef {
  root?: Record<string, FieldSpec>;
  collections?: Record<string, CollectionDef>;
  timeline?: TimelineConfig | null;
  hard?: HardValidator | null;
  soft?: SoftValidator | null;
  /**
   * A human label for a record in descriptions and cards ("'Intro'"). `doc` is the state the record is in, when the
   * caller has it: a record named after another (a clip after its media's file name) looks it up there.
   */
  label?: ((collection: string, record: Rec | undefined, doc?: Doc) => string) | null;
  /** Editors' words for root fields in descriptions (`{aspectRatio: "aspect ratio"}`). */
  labels?: Record<string, string> | null;
}

export interface Schema {
  readonly root: ObjectSpec;
  readonly collections: Readonly<Record<string, CollectionSpec>>;
  readonly timeline: TimelineConfig | null;
  readonly hard: HardValidator | null;
  readonly soft: SoftValidator | null;
  readonly label: ((collection: string, record: Rec | undefined, doc?: Doc) => string) | null;
  readonly labels: Readonly<Record<string, string>> | null;
}

/** Builds a schema: indexes field groups and the record spec of every collection. Undeclared fields are atomic. */
export function defineSchema({ root = {}, collections = {}, timeline = null, hard = null, soft = null, label = null, labels = null }: SchemaDef): Schema {
  const colls: Record<string, CollectionSpec> = {};
  for (const [name, c] of Object.entries(collections)) {
    const groups = (c.groups ?? []).map((g) => ({ ...g, set: new Set(g.fields) }));
    const groupOf = new Map<string, FieldGroup>();
    for (const g of groups) for (const f of g.fields) groupOf.set(f, g);
    const key = c.key ?? "id";
    colls[name] = { ...c, key, groups, groupOf, record: { kind: "object", fields: { [key]: scalar, ...(c.fields ?? {}) }, deep: false, only: !!c.only } };
  }
  return { root: { kind: "object", fields: root, deep: false, only: false }, collections: colls, timeline, hard, soft, label, labels };
}
