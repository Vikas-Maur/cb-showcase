// Shapes the sequencer rules read (PLAN §5.1, §6.1, §6.3). The same rules run in the local sequencer and in every
// SequencerHost, so nothing here knows about storage, sockets or a document.

import type { Change, Span } from "../types.ts";

/** The parts of a change the rule reads. A full `Change` fits; tests can pass less. */
export type Pushed = Pick<Change, "id" | "base" | "ops" | "intent" | "policy" | "paths" | "reads" | "spans" | "trackOrder">;

/** What the overlap test reads of each confirmed row in the tail since a base. */
export interface TailRow {
  seq: number;
  id: string;
  /** A withdraw row: it spends an id and writes nothing (H1). */
  withdrawn: boolean;
  /** Paths with `#trackOrder/<track>` folded in, so a reorder clash is a path clash. */
  paths: readonly string[];
  reads: readonly string[];
  spans: readonly Span[];
  structural: boolean;
}

/** A record's existence at some seq, from the append-only records history (§6.3). */
export interface RecordState {
  alive: boolean;
  /** The seq of the row that set this state (in that branch's own numbering). */
  seq: number;
  /** For a timeline item, its lane (track) as of that row. */
  lane?: string;
}

/**
 * Which rule decides an overlap. Only `"v3-spans"` is the plan's rule (§6.1); the others exist so the P9 load test
 * can compare against them, as the prototype did:
 * - `"v3-spans-v10"`: any two intersecting spans conflict, and there are no group paths;
 * - `"v2-layout"`: any two span-bearing changes on one track conflict (v2's per-track key);
 * - `"per-item"`: leaf paths and reads only, no spans, no group paths, no track order (the critic's baseline).
 */
export type Keying = "v3-spans" | "v3-spans-v10" | "v2-layout" | "per-item";
