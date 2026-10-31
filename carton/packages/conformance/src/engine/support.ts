// Helpers shared by the engine suites: result narrowing, the few prototype members the contract spells differently,
// and changes built for direct sequencer pushes.
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import * as E from "@carton/core";
import type { Actor, Change, CommitResult, Declaration, Doc, FoldResult, History, Intent, NodeId, Op, Policy, Schema, StateRef } from "@carton/core";

/** Loose JSON the tests poke at (records, host docs, export packages): a type would only be noise. */
export type Json = any;

export type Confirmed = Extract<CommitResult, { status: "confirmed" }>;
export type PushResult = E.sequencer.PushResult;
export type Accepted = Extract<PushResult, { ok: true }>;
export type Rejected = Extract<PushResult, { ok: false }>;

export const once = <T>(make: () => T): (() => T) => {
  let v: { value: T } | undefined;
  return () => (v ??= { value: make() }).value;
};

/** Where tests write files (.cbproj zips): `dir`, else $CARTON_TEST_TMP, else the OS temp dir. */
export const tmpRoot = (dir?: string): string => dir ?? process.env.CARTON_TEST_TMP ?? tmpdir();

export const confirmed = (res: CommitResult | FoldResult, msg?: string): Confirmed => {
  assert.equal(res.status, "confirmed", msg);
  return res as Confirmed;
};
export const accepted = (res: PushResult, msg?: string): Accepted => {
  assert.ok(res.ok, msg ?? `rejected: ${JSON.stringify({ reason: (res as Rejected).reason, overlap: (res as Rejected).overlap, invalid: (res as Rejected).invalid })}`);
  return res;
};
export const rejected = (res: PushResult, msg?: string): Rejected => {
  assert.equal(res.ok, false, msg);
  return res as Rejected;
};

/** An op that re-keys a sequence element without moving it (a rebalance). */
export const isRk = (o: Op): boolean => o.op === "set" && !!o.rk;

/**
 * The merge base a fold used: `{node, nodes, doc, virtual?}`, as `History.mergeBase` returns it.
 * port: `fold()` returns it as `base`, typed `unknown` (reported), so it is read through this shape.
 */
export interface FoldBase {
  node?: NodeId | null;
  nodes?: NodeId[];
  doc?: Doc;
  virtual?: boolean;
}
export const baseOf = (res: FoldResult): FoldBase => {
  const b = (res as { base?: FoldBase }).base;
  assert.ok(b, `no merge base on the ${res.status} fold result (FoldResult.base)`);
  return b;
};

/**
 * A ref to `b@seq` (a writer that hasn't caught up).
 * port: the prototype overrode `seq` and `hash` on `ref(b)`; the contract's StateRef may also carry `hash8`, which must
 * follow the hash.
 */
export const refAt = (r: History, b: string, seq: number): StateRef => {
  const hash = r.hashOf(`${b}@${seq}`) ?? undefined;
  return { ...r.ref(b), seq, hash, hash8: hash?.slice(0, 8) };
};

/** The head node of an imported shallow export. */
export const importedHead = (res: ReturnType<History["importShallow"]>): NodeId => {
  assert.ok("head" in res, `import: ${res.status}`);
  return res.head;
};

export interface PushInput {
  id: string;
  base: number;
  ops: Op[];
  author?: Actor;
  baseDoc?: Doc;
  intent?: Intent | null;
  policy?: Policy;
  /** An explicit declaration (default: declared from `baseDoc`, else the sequencer's head, as the prototype's push did). */
  decl?: Declaration;
}

/**
 * A change for a direct sequencer push, as a replica would make it.
 * port: the prototype pushed bare `{id, base, ops, baseDoc}` and its sequencer declared the change itself; the contract's
 * Change carries its declaration (paths, reads, spans, trackOrder), its base as `{seq, pending}`, an author and a hash.
 */
export function toChange(S: Schema, sq: E.sequencer.LocalSequencer, c: PushInput): Change & { baseDoc?: Doc } {
  const author: Actor = c.author ?? { kind: "human", id: "test" };
  const base = { seq: c.base, pending: [] };
  const intent = c.intent ?? null;
  const decl = c.decl ?? E.declare(S, c.baseDoc ?? sq.head, c.ops, intent);
  const hash = E.sha256Hex(E.canonical({ author, base, ops: c.ops, intent, mergeOf: null }));
  return { ...decl, id: c.id, hash, author, branchId: "b", base, ops: c.ops, intent, kinds: null, policy: c.policy ?? "merge", at: 0, ...(c.baseDoc ? { baseDoc: c.baseDoc } : {}) };
}
