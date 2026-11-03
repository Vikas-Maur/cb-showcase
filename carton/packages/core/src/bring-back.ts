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
  readonly what: string;
  constructor(what: string) {
    super("That clip isn't in that version or in the edit now");
    this.what = what;
  }
}

// ------------------------------------------------------------------ the state it saves

import type { Doc, Op, Rec } from "./types.ts";
import type { Schema } from "./schema.ts";
import * as E from "./engine/index.ts";

/** A record's name for people, as History and cards name it; never an id. */
export function recordName(schema: Schema, coll: string, rec: Rec | undefined, doc?: Doc): string {
  const spec = schema.collections[coll];
  if (!rec) return spec?.noun ?? "clip";
  const l = schema.label?.(coll, rec, doc);
  const id = String(rec[spec?.key ?? "id"] ?? "");
  if (l && l !== "?" && !(id && l.includes(id.slice(0, 6)))) return l;
  return typeof rec.name === "string" && rec.name.trim() ? rec.name.trim() : spec?.nounOf?.(rec) ?? spec?.noun ?? "clip";
}

/** How many records of `coll` name `id` by `field`. */
function holders(doc: Doc, coll: string, field: string, id: unknown): number {
  let n = 0;
  for (const r of (doc[coll] as Rec[] | undefined) ?? []) if (r[field] === id) n++;
  return n;
}

/**
 * Head with one record as it was in `then`: the record itself (every field: keyframes, captions, effects), its own parts
 * (`partOf`, held by it alone: a title's text entry) as they were then, and what it needs that is gone from head (its
 * parent: the track; a part it shares: the media file), as it was then. A record that wasn't there then is removed
 * with its own parts, only when `remove` says so. Nothing else changes.
 */
export function bringBack(head: Doc, then: Doc, coll: string, id: string, schema: Schema, o: { remove: boolean }): { doc: Doc; brought: Omit<BroughtBack, "of"> } {
  const spec = schema.collections[coll]!;
  const get = (d: Doc, c: string, k: unknown) => E.getIn(d, [c, k as string], schema) as Rec | undefined;
  const was = get(then, coll, id), now = get(head, coll, id);
  const record = E.pathKey([coll, id]);
  if (!was && !now) throw new NoSuchClip(id);
  const name = recordName(schema, coll, was ?? now, was ? then : head);
  if (!was && !o.remove) throw new NotInVersion(record, name);
  const ops: Op[] = [];
  const parts: PathKey[] = [];
  const put = (c: string, rec: Rec) => ops.push({ op: "insert", path: [c, String(rec[schema.collections[c]!.key])], value: rec });
  if (was) {
    if (!now || !E.deepEqual(was, now)) put(coll, was);
  } else ops.push({ op: "remove", path: [coll, id] });
  // its parts: a record of another collection that this one names by `partOf.field`
  for (const [pc, ps] of Object.entries(schema.collections)) {
    if (ps.partOf?.collection !== coll) continue;
    const f = ps.partOf.field;
    const own = (d: Doc, rec: Rec | undefined, pid: unknown) => !!rec && ps.nounOf?.(rec) === null && holders(d, coll, f, pid) <= 1;
    const pidThen = was?.[f], pidNow = now?.[f];
    if (pidThen != null) {
      const pThen = get(then, pc, pidThen), pNow = get(head, pc, pidThen);
      // gone since (it needs it), or its own and changed: as it was then
      if (pThen && (!pNow || (own(then, pThen, pidThen) && !E.deepEqual(pThen, pNow)))) {
        put(pc, pThen);
        parts.push(E.pathKey([pc, String(pidThen)]));
      }
    }
    // the part it holds now that it didn't then, its own alone: it goes with the clip as it is now
    if (pidNow != null && pidNow !== pidThen) {
      const pNow = get(head, pc, pidNow);
      if (own(head, pNow, pidNow)) {
        ops.push({ op: "remove", path: [pc, String(pidNow)] });
        parts.push(E.pathKey([pc, String(pidNow)]));
      }
    }
  }
  // what it sits on (its track), gone since: as it was then
  if (was && spec.parent) {
    const pid = was[spec.parent.field];
    if (pid != null && !get(head, spec.parent.collection, pid)) {
      const p = get(then, spec.parent.collection, pid);
      if (p) {
        put(spec.parent.collection, p);
        parts.push(E.pathKey([spec.parent.collection, String(pid)]));
      }
    }
  }
  const how: BroughtBack["how"] = !was ? "removed" : !now ? "added" : ops.length ? "changed" : "same";
  const doc = ops.length ? E.apply(E.fork(head, schema), ops, schema) : head;
  return { doc, brought: { record, name, how, parts } };
}
