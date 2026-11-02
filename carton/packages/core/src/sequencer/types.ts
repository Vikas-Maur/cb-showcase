// Shapes the sequencer rules read (PLAN §5.1, §6.1, §6.3). The same rules run in the local sequencer and in every
// SequencerHost, so nothing here knows about storage, sockets or a document.

import type { Change, Span } from "../types.ts";

/** The parts of a change the rule reads. A full `Change` fits; tests can pass less. */
export type Pushed = Pick<Change, "id" | "base" | "ops" | "intent" | "policy" | "paths" | "reads" | "spans" | "trackOrder"> & Partial<Pick<Change, "mergeOf" | "reverts">>;

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
