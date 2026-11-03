// Landmarks (Carton UX v2, N0): the versions people remember, marked as they happen, so History can show them and
// `cb history --landmarks` and Find can reach them in a long history.
//
// Two sources, one list:
// - recorded: what History can't know by itself, kept outside the history bundle in this store's local `ephemeral`
//   table (key `["landmark", cut, seq, kind, at]`), never exported with history and never synced yet: an export of the
//   video (`exported`), a version shared, sent for review or published (`sent`), and how it was when the project was
//   opened or after an hour away (`start`). The app records them (`Carton.mark`), off the save path.
// - derived from the history itself, so nothing is written: named versions (`named`), agent turns (`turn`, a turn's
//   newest version), a Published cut's version (`sent`), and `before`: the version just before a restore, a fold in,
//   an undo of a turn or a bring-back made on this replica.
//
// DESIGN-V2 §2.1: Start and Before are personal (only their person sees them: `personal`); the rest are everyone's.
// Exported and Sent are recorded on this computer (`local`) until the sync server carries landmarks.
import type { Actor, NodeId, StateRef } from "./types.ts";

export type LandmarkKind = "exported" | "sent" | "named" | "turn" | "start" | "before";
/** The kinds the app records (`Carton.mark`); the others are read from the history. */
export type RecordedLandmarkKind = "exported" | "sent" | "start";
export const RECORDED_KINDS: readonly RecordedLandmarkKind[] = ["exported", "sent", "start"];
export const LANDMARK_KINDS: readonly LandmarkKind[] = ["exported", "sent", "named", "turn", "start", "before"];
/** Which one a row shows when a version is several (DESIGN-V2 §2.1): Named, Sent, Exported, Before, Start, then a turn. */
export const LANDMARK_ORDER: readonly LandmarkKind[] = ["named", "sent", "exported", "before", "start", "turn"];

/** What came right after a `before` landmark. */
export type BeforeWhat = "restore" | "fold" | "undo-turn" | "bring-back";
/** @deprecated the contract's first name for `BeforeWhat`. */
export type SafetyBefore = BeforeWhat;

export interface Landmark {
  /** Stable key: `<kind>:<cut>@<seq>`, and `:<at>` for a recorded one (a version exported twice is two landmarks). */
  id: string;
  kind: LandmarkKind;
  /** The version, and its change (null: a cut's start). */
  ref: StateRef;
  change?: string | null;
  /** When it happened (an export's time; a derived one's: its version's). */
  at: number;
  /** Who did it: exported, sent, named, made the turn, the restore. */
  by: Actor | null;
  /**
   * Words the app may show with it, as they were given: an export's preset or file ("1080p for the client"), whom it
   * was sent to ("Leo"), a Published cut's name, a turn's prompt label, a named version's name. Never an id.
   */
  label?: string;
  /** A `before` landmark: what came right after it, and that version. */
  before?: BeforeWhat;
  after?: NodeId;
  /** Recorded by the app (`mark`), not read from the history. */
  recorded: boolean;
  /**
   * Only the person it belongs to sees it (DESIGN-V2 §2.1: Start and Before). "Only you see this" in its meta line.
   */
  personal: boolean;
  /**
   * Kept on this computer only. Start and Before always (they are personal). Exported and Sent are everyone's, but
   * until the sync server carries landmarks a teammate doesn't have them yet; named, turns and Published versions come
   * from what syncs (false).
   */
  local: boolean;
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
   * `"version"`: only if this kind doesn't mark that version yet (a Start at each open, once per version); `"day"`: only
   * if this kind has no landmark yet today (local time) on this cut. Answers null when one exists.
   */
  once?: "day" | "version";
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
