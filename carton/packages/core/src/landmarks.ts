// Landmarks (Carton UX v2, N0): the versions people remember, marked as they happen, so History can show them and
// `cb history --landmarks` and Find can reach them in a long history.
//
// Two sources, one list:
// - recorded: what History can't know by itself, kept outside the history bundle in this store's local `ephemeral`
//   table (key `["landmark", cut, seq, kind, at]`), never exported with history and never synced: an export of the
//   video (`exported`), a version sent or shared with someone (`sent`, `shared`), and the first open of the project
//   each day (`session`). The app records them (`Carton.mark`), off the save path.
// - derived from the history itself, so every replica has them and nothing is written: named versions (`named`),
//   agent turns (`turn`, a turn's newest version), Published versions (`published`), and safety points (`safety`):
//   the version just before a restore, a fold in, an undo of a turn or a bring-back, made on this replica.
//
// Which a teammate sees (`team`): named versions, turns and Published versions come from what syncs, so teammates have
// them too. The recorded ones and safety points are this person's own: they stay on this machine.
import type { Actor, NodeId, StateRef } from "./types.ts";

export type LandmarkKind = "exported" | "sent" | "shared" | "published" | "session" | "safety" | "turn" | "named";
/** The kinds the app records (`Carton.mark`); the others are read from the history. */
export type RecordedLandmarkKind = "exported" | "sent" | "shared" | "session";
export const RECORDED_KINDS: readonly RecordedLandmarkKind[] = ["exported", "sent", "shared", "session"];
export const LANDMARK_KINDS: readonly LandmarkKind[] = ["exported", "sent", "shared", "published", "session", "safety", "turn", "named"];

/** What came right after a safety point. */
export type SafetyBefore = "restore" | "fold" | "undo-turn" | "bring-back";

export interface Landmark {
  /** Stable key: `<kind>:<cut>@<seq>`, and `:<at>` for a recorded one (a version exported twice is two landmarks). */
  id: string;
  kind: LandmarkKind;
  /** The version. */
  ref: StateRef;
  /** When it happened (an export's time; a derived one's: its version's). */
  at: number;
  /** Who did it: exported, sent, named, made the turn or the restore. */
  by: Actor | null;
  /**
   * Words the app may show with it, as they were given: an export's preset ("1080p"), whom it was sent or shared with
   * ("Leo"), a turn's prompt label, a named version's name. Never an id.
   */
  label?: string;
  /** A safety point: what came right after it, and that version. */
  before?: SafetyBefore;
  after?: NodeId;
  /** Recorded by the app (`mark`), not read from the history. */
  recorded: boolean;
  /** Teammates have it too (it comes from what syncs); false: this person's own, on this machine only. */
  team: boolean;
  /** Its picture's key (`pictureKey`): one per version, so two landmarks on one version share a picture. */
  picture: string;
}

export interface LandmarkOptions {
  /** The cut (default: the current cut). */
  cut?: string;
  /** Only these kinds (default: all). */
  kinds?: readonly LandmarkKind[];
  /** Only versions before this seq. */
  before?: number;
  /** At most this many, newest first (default 200). */
  limit?: number;
}

export interface MarkOptions {
  /** The version (default: the cut's head now). */
  ref?: StateRef | string;
  /** The cut, when `ref` isn't given (default: the current cut). */
  cut?: string;
  label?: string;
  /** Who (default: the handle's actor). */
  by?: Actor;
  at?: number;
  /**
   * `"day"`: only if this kind has no landmark yet today (local time) on this cut: the session start. Answers null
   * when one exists.
   */
  once?: "day";
}

/** A version's picture key: `<cut>@<seq>`, safe as a file name (anything else in a cut id becomes `_`). */
export function pictureKey(ref: { branchId: string; seq: number }): string {
  return `${ref.branchId.replace(/[^A-Za-z0-9._-]/g, "_")}@${ref.seq}`;
}

/** The store row of a recorded landmark (local table `ephemeral`, key `["landmark", cut, seq, kind, at]`). */
export interface LandmarkRow {
  kind: RecordedLandmarkKind;
  at: number;
  by: Actor | null;
  label?: string;
}
export const LANDMARK_TABLE = "ephemeral";
export const LANDMARK_PREFIX = "landmark";
