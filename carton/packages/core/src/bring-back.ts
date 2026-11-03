// Bring back one clip (Carton UX v2, N0): a clip as it was in an earlier version, saved as a new version on top that
// changes nothing else, undoable as any change. Outside the history bundle: it is a restore of a state built here
// (head with that clip's records as they were then).
import type { Actor, ChangeId, NodeId, PathKey } from "./types.ts";

export interface BringBackOptions {
  /** The cut to save on (default: the current cut). */
  cut?: string;
  author?: Actor;
  /** A stable id, as restore takes: a retried call returns the first answer. */
  id?: ChangeId;
  /**
   * The clip wasn't in that version: bringing it back as it was removes it. Only with `remove: true`; without it the
   * call throws `NotInVersion` and nothing changes.
   */
  remove?: boolean;
}

/** What a bring-back did (beside the commit's result). */
export interface BroughtBack {
  /** The clip (`timelineItems/c1`) and its name as it was then (or now, for a removal). */
  record: PathKey;
  name: string;
  /**
   * `changed`: it is as it was then; `added`: it was deleted since and is back; `removed`: it wasn't there then
   * (`remove: true`); `same`: it was already as it was then, nothing saved.
   */
  how: "changed" | "added" | "removed" | "same";
  /**
   * Every record it covered beside the clip, by path: its own parts (`partOf`: a title's text entry), and what it needs
   * that is gone now (its track, its media file), brought back as they were then.
   */
  parts: PathKey[];
  /** The version it came from (a node id). */
  of: NodeId;
}

/** The clip wasn't in that version, and `remove` wasn't asked. Its message says so in the editor's words. */
export class NotInVersion extends Error {
  readonly code = "NOT_IN_VERSION";
  readonly record: PathKey;
  constructor(record: PathKey, name: string) {
    super(`“${name}” wasn't in that version: bringing it back as it was would remove it. Ask to remove it to do that.`);
    this.record = record;
  }
}

/** No such clip, then or now. */
export class NoSuchClip extends Error {
  readonly code = "NO_SUCH_CLIP";
  constructor(what: string) {
    super(`No clip “${what}” in that version or in the edit now`);
  }
}
