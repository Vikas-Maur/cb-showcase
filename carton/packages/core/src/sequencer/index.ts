// The sequencer rule (PLAN §6.1), the same for the local SQLite sequencer and the server: a change is accepted if it
// overlaps no change confirmed after its base that isn't in its causal past; `lww` changes also when every overlap is
// between leaf sets on live records; otherwise rejected with the concurrent changes, and the client rebases.
// Owner: sync-sequencer. The foundation wrote these signatures from core-v5 `engine.mjs` (`overlap`, `Sequencer`)
// and system-v11 `server.mjs` (v11 rules: group paths, structural spans, lww-on-structure).

import type { Schema } from "../schema.ts";
import type { Change, ConfirmedChange, Declaration, Doc, Notice, Overlap } from "../types.ts";
import type { RejectReason } from "../sync/messages.ts";
import { notImplemented } from "../todo.ts";

/** How two declarations overlap (empty object: they don't). Spans meet only if one side is structural (v11). */
export function overlap(x: Declaration, y: Declaration): Overlap {
  return notImplemented("overlap");
}

export type PushResult =
  | { ok: true; seq: number; change: ConfirmedChange; duplicate?: boolean; notices: Notice[]; missing: ConfirmedChange[] }
  | { ok: false; reason: RejectReason; overlap?: Overlap; invalid?: { path?: string; error: string }; head: number; missing: ConfirmedChange[] };

/**
 * One branch's sequencer over an in-memory log and head doc: what a replica runs for a cut it sequences itself
 * (persisted by its Store), and what the conformance suite runs against. The server variant keeps no document
 * (records table instead) and lives in `@carton/server`.
 */
export interface LocalSequencer {
  readonly seq: number;
  readonly head: Doc;
  readonly log: readonly ConfirmedChange[];
  /** Validate and order one change. A duplicate id is acked with its existing seq whatever its hash. */
  push(change: Change & { baseDoc?: Doc }): PushResult;
  pull(since: number): ConfirmedChange[];
  /** Adopt rows confirmed elsewhere (a reload from the Store). */
  load(rows: readonly ConfirmedChange[]): void;
}

export function createLocalSequencer(doc: Doc, schema: Schema): LocalSequencer {
  return notImplemented("createLocalSequencer");
}
