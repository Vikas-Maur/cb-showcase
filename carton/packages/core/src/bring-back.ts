// Bring back one clip (Carton UX v2, N0): a clip as it was in an earlier version, saved as a new version on top that
// changes nothing else, undoable as any change. Outside the history bundle: it is a restore of a state built here
// (head with that clip's records as they were then).
import type { Actor, ChangeId, NodeId, PathKey, RemapMaps } from "./types.ts";

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
  /**
   * The clip as the person was shown it (`BringBackChoice.token`, N0b): if it changed again since (an agent, a
   * teammate), the call throws `ChangedSince` and nothing changes; the panel asks again ("“Intro” just changed again.
   * Bring back the 10:20 am one anyway?") and calls without it, or with the new token.
   */
  expect?: string;
}

/**
 * Where a brought-back clip went (DESIGN-V2 §3.2, N0b). `same`: its own place, free now. `new-track`: its place was
 * taken now (`takenBy`), so it went on a new track (`track`, made beside its own) at the same time: it never lands on
 * top of another clip.
 */
export interface BroughtPlace {
  placed: "same" | "new-track";
  /** The new track (`new-track`). */
  track?: string;
  /** The clips that hold its place now (`new-track`), by path and name. */
  takenBy?: { record: PathKey; name: string }[];
}
/**
 * The rest of its track moved with it (DESIGN-V2 §3.2, N0b): it was deleted with a ripple (the rest moved up), so the
 * rest moves back (`later`); or it was added with one, so taking it out moves the rest `earlier`. By `by` seconds from
 * `at`, on `tracks`; `moved`: how many clips. Null when nothing else moved.
 */
export interface BroughtRipple {
  direction: "later" | "earlier";
  by: number;
  at: number;
  tracks: string[];
  moved: number;
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
  /** Where it went (N0b): absent for a record off the timeline, a removal, or nothing done. */
  place?: BroughtPlace;
  /** What else moved (N0b): null when nothing else did ("Nothing else moves"). */
  ripple?: BroughtRipple | null;
}

/**
 * One row of "Choose a clip…" (DESIGN-V2 §3.2): a clip that differs between a version and now. `then` and `now`: where
 * it is (seconds) and its text, on each side it is on.
 */
export interface BringBackChoice {
  record: PathKey;
  name: string;
  /** Its noun when not a clip ("title", "caption"). */
  noun?: string;
  then?: { start?: number; end?: number; text?: string; track?: string };
  now?: { start?: number; end?: number; text?: string; track?: string };
  /** Deleted since: who deleted it and when; not there then: who added it and when (the newest such version). */
  by?: Actor | null;
  at?: number;
  /**
   * The clip as it is now (N0b), to pass back as `restoreClip`'s `expect`: if it changed again before the bring-back
   * runs, it is refused (`ChangedSince`).
   */
  token: string;
  /**
   * What the bring-back would do with the rest (N0b), for the confirmation's line: where it would go and what would
   * move ("Its place is taken by “Drone shot”, so it goes on a new track above", "Everything after it moves 3 s later").
   */
  place?: BroughtPlace;
  ripple?: BroughtRipple | null;
}
/** The clips that differ between a version and now, in DESIGN-V2 §3.2's three groups, and how many are the same. */
export interface BringBackChoices {
  /** Changed since: on both sides, different. Bring back. */
  changed: BringBackChoice[];
  /** Deleted since: there then, gone now. Bring back. */
  deleted: BringBackChoice[];
  /** Not there yet then: added since. Take out (`remove: true`). */
  added: BringBackChoice[];
  /** "14 other clips are the same as now." */
  same: number;
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

/** The clip changed again since the person was shown it (`expect`): nothing changed. */
export class ChangedSince extends Error {
  readonly code = "CHANGED_SINCE";
  readonly record: PathKey;
  /** Its token now, for asking again. */
  readonly token: string;
  constructor(record: PathKey, name: string, token: string) {
    super(`“${name}” just changed again. Nothing was brought back.`);
    this.record = record;
    this.token = token;
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

import { POS, type Doc, type Op, type Rec } from "./types.ts";
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

/** How many records of `coll` name `id` by `field` (`but`: leaving that record out). */
function holders(doc: Doc, coll: string, field: string, id: unknown, but?: { key: string; id: string }): number {
  let n = 0;
  for (const r of (doc[coll] as Rec[] | undefined) ?? []) if (r[field] === id && !(but && String(r[but.key]) === but.id)) n++;
  return n;
}
/** A new record id, as the host makes them (a UUID). */
const newId = (): string => globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(16)}-${Math.random().toString(16).slice(2, 10)}`;
/**
 * A record's own parts (`partOf` naming its collection, held by it alone) differ between two states: what a bring-back
 * of it covers beside the record itself.
 */
export function partsDiffer(schema: Schema, coll: string, a: Rec, da: Doc, b: Rec, db: Doc): boolean {
  for (const [pc, ps] of Object.entries(schema.collections)) {
    if (ps.partOf?.collection !== coll) continue;
    const f = ps.partOf.field;
    const pa = a[f] != null ? (E.getIn(da, [pc, a[f] as string], schema) as Rec | undefined) : undefined;
    const pb = b[f] != null ? (E.getIn(db, [pc, b[f] as string], schema) as Rec | undefined) : undefined;
    const own = (p: Rec | undefined) => !!p && ps.nounOf?.(p) === null;
    if ((own(pa) || own(pb)) && !E.deepEqual(pa, pb)) return true;
  }
  return false;
}

/**
 * A clip as it is in `doc` (N0b): a short hash of its record and its own parts, the token `bringBackChoices` gives and
 * `restoreClip({ expect })` checks. "absent" when it isn't there.
 */
export function clipToken(schema: Schema, coll: string, id: string, doc: Doc): string {
  const rec = E.getIn(doc, [coll, id], schema) as Rec | undefined;
  if (!rec) return "absent";
  const parts: Rec[] = [];
  for (const [pc, ps] of Object.entries(schema.collections)) {
    if (ps.partOf?.collection !== coll || rec[ps.partOf.field] == null) continue;
    const p = E.getIn(doc, [pc, rec[ps.partOf.field] as string], schema) as Rec | undefined;
    if (p && ps.nounOf?.(p) === null) parts.push(p);
  }
  return E.sha256Hex(E.canonical({ rec, parts })).slice(0, 16);
}

/** What the change that deleted the clip, or added it, did to the rest of its track (its ripple, as a remap). */
export interface BringBackHistory {
  /** The change that deleted it (it is gone now): its recorded or inferred remap. */
  deletedWith?: RemapMaps | null;
  /** The change that added it (it wasn't there then). */
  addedWith?: RemapMaps | null;
}

const EPS = 0.05;
/**
 * Head with one record as it was in `then`: the record itself (every field: keyframes, captions, effects), its own parts
 * (`partOf`, held by it alone: a title's text entry) as they were then, and what it needs that is gone from head (its
 * parent: the track; a part it shares: the media file), as it was then. A record that wasn't there then is removed
 * with its own parts, only when `remove` says so. Nothing else changes, but for DESIGN-V2 §3.2's placement (N0b):
 * - a clip deleted with a ripple (the rest of its track moved up) comes back with the rest moved back, later; a clip
 *   added with one, taken out, moves the rest earlier (`ripple`; `intent`: that remap, for the commit). Otherwise
 *   nothing else moves (`ripple: null`).
 * - a clip never lands on top of another: if its place on its track is taken now, it goes on a new track made just
 *   above its own (after it in the track order), at the same time (`place`).
 */
export function bringBack(head: Doc, then: Doc, coll: string, id: string, schema: Schema, o: { remove: boolean; history?: BringBackHistory }): { doc: Doc; brought: Omit<BroughtBack, "of">; intent?: { kind: string; maps: RemapMaps } } {
  const spec = schema.collections[coll]!;
  const tl = schema.timeline && schema.timeline.collection === coll ? schema.timeline : null;
  const get = (d: Doc, c: string, k: unknown) => E.getIn(d, [c, k as string], schema) as Rec | undefined;
  const was = get(then, coll, id), now = get(head, coll, id);
  const record = E.pathKey([coll, id]);
  if (!was && !now) throw new NoSuchClip(id);
  const name = recordName(schema, coll, was ?? now, was ? then : head);
  if (!was && !o.remove) throw new NotInVersion(record, name);
  const ops: Op[] = [];
  const parts: PathKey[] = [];
  const put = (c: string, rec: Rec) => ops.push({ op: "insert", path: [c, String(rec[schema.collections[c]!.key])], value: rec });
  // the clip as it was then (a part it shares now with another clip becomes a copy of its own, below)
  let clip: Rec | undefined = was;
  if (!was) ops.push({ op: "remove", path: [coll, id] });
  // its parts: a record of another collection that this one names by `partOf.field`
  for (const [pc, ps] of Object.entries(schema.collections)) {
    if (ps.partOf?.collection !== coll) continue;
    const f = ps.partOf.field;
    const own = (d: Doc, rec: Rec | undefined, pid: unknown) => !!rec && ps.nounOf?.(rec) === null && holders(d, coll, f, pid) <= 1;
    const pidThen = was?.[f], pidNow = now?.[f];
    if (pidThen != null) {
      const pThen = get(then, pc, pidThen), pNow = get(head, pc, pidThen);
      if (pThen && !pNow) {
        // gone since: it needs it, as it was then
        put(pc, pThen);
        parts.push(E.pathKey([pc, String(pidThen)]));
      } else if (pThen && pNow && own(then, pThen, pidThen) && !E.deepEqual(pThen, pNow)) {
        // its own then, and changed: as it was then. If another clip names it now (a title duplicated since), that
        // clip keeps it as it is, and this one gets a copy of its own (review N0 #1)
        if (holders(head, coll, f, pidThen, { key: spec.key, id }) > 0) {
          const copy = newId(), pk = schema.collections[pc]!.key;
          put(pc, { ...pThen, [pk]: copy });
          clip = { ...clip!, [f]: copy };
          parts.push(E.pathKey([pc, copy]));
        } else {
          put(pc, pThen);
          parts.push(E.pathKey([pc, String(pidThen)]));
        }
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
  // the rest of its track (DESIGN-V2 §3.2): moved back where a ripple delete took it out, earlier where a ripple insert
  // made room for it; else left alone
  let ripple: BroughtRipple | null = null;
  let maps: RemapMaps | null = null;
  const extent = (r: Rec | undefined) => (tl && r && typeof r[tl.start] === "number" && typeof r[tl.end] === "number" ? { lane: String(r[tl.lane]), start: r[tl.start] as number, end: r[tl.end] as number } : null);
  if (tl && was && !now && o.history?.deletedWith) {
    // the deletion's own lane took out a range holding the clip: that range comes back (and on every lane its ripple
    // took the same range from)
    const x = extent(was)!, w = o.history.deletedWith;
    const d = (w[x.lane] ?? []).flatMap((st) => st.d).find(([a, b]) => a <= x.start + EPS && b >= x.end - EPS);
    if (d) {
      const same = (r: [number, number]) => Math.abs(r[0] - d[0]) < EPS && Math.abs(r[1] - d[1]) < EPS;
      const lanes = Object.keys(w).filter((lane) => lane === x.lane || w[lane]!.some((st) => st.d.some(same)));
      maps = Object.fromEntries(lanes.map((lane) => [lane, [{ d: [], i: [[d[0], d[1] - d[0]]] }]]));
      ripple = { direction: "later", by: d[1] - d[0], at: d[0], tracks: lanes, moved: 0 };
    }
  } else if (tl && !was && now && o.history?.addedWith) {
    // the addition made room for it (a gap inserted where it starts): taking it out closes that room again
    const x = extent(now)!, w = o.history.addedWith;
    const i = (w[x.lane] ?? []).flatMap((st) => st.i).find(([at, len]) => Math.abs(at - x.start) <= EPS && len >= x.end - x.start - EPS);
    if (i) {
      const same = (r: [number, number]) => Math.abs(r[0] - i[0]) < EPS && Math.abs(r[1] - i[1]) < EPS;
      const lanes = Object.keys(w).filter((lane) => lane === x.lane || w[lane]!.some((st) => st.i.some(same)));
      maps = Object.fromEntries(lanes.map((lane) => [lane, [{ d: [[i[0], i[0] + i[1]]], i: [] }]]));
      ripple = { direction: "earlier", by: i[1], at: i[0], tracks: lanes, moved: 0 };
    }
  }
  // the remap first, so the clip brought back (inserted after it) stays where it was then
  const remap: Op[] = maps ? [{ op: "remap", path: ["#remap"], maps }] : [];
  const build = () => {
    const all = [...remap, ...ops, ...(clip && (!now || !E.deepEqual(clip, now)) ? [{ op: "insert", path: [coll, id], value: clip } as Op] : [])];
    return all.length ? E.apply(E.fork(head, schema), all, schema) : head;
  };
  let doc = build();
  // never on top of another clip: its place taken now, it goes on a new track just above its own, at the same time
  let place: BroughtPlace | undefined;
  const at = extent(clip);
  if (tl && clip && at) {
    // on top of a clip that wasn't on top of it then (one that already overlapped it then, as a title over a video on
    // one track, is no place taken since)
    const over = (r: Rec | undefined, x: { lane: string; start: number; end: number }) => {
      const e = extent(r);
      return !!r && String(r[spec.key]) !== id && !!e && e.lane === x.lane && e.start < x.end - EPS && e.end > x.start + EPS;
    };
    const thenAt = extent(was);
    const taken = ((doc[coll] as Rec[] | undefined) ?? []).filter((r) => over(r, at) && !(thenAt && over(get(then, coll, r[spec.key]), thenAt)));
    if (!taken.length) place = { placed: "same" };
    else {
      const lanes = schema.collections[tl.lanes]!;
      const tracks = [...((doc[tl.lanes] as Rec[] | undefined) ?? [])].sort(E.byPos(POS));
      const k = tracks.findIndex((t) => String(t[lanes.key]) === at.lane);
      const own = tracks[k];
      if (own) {
        const track = newId();
        const nm = typeof own.name === "string" && own.name ? { name: `${own.name} 2` } : {};
        const pos = lanes.seq ? { [POS]: E.keyBetween((own[POS] as string | undefined) ?? null, (tracks[k + 1]?.[POS] as string | undefined) ?? null) } : {};
        put(tl.lanes, { ...own, [lanes.key]: track, ...nm, ...pos });
        parts.push(E.pathKey([tl.lanes, track]));
        clip = { ...clip, [tl.lane]: track };
        doc = build();
        place = { placed: "new-track", track, takenBy: taken.map((r) => ({ record: E.pathKey([coll, String(r[spec.key])]), name: recordName(schema, coll, r, doc) })) };
      }
    }
  }
  if (ripple) {
    let n = 0;
    for (const r of (head[coll] as Rec[] | undefined) ?? []) {
      if (String(r[spec.key]) === id) continue;
      const e = extent(r), after = extent(get(doc, coll, r[spec.key]));
      if (e && after && Math.abs(e.start - after.start) > 1e-9) n++;
    }
    ripple = { ...ripple, moved: n };
  }
  const how: BroughtBack["how"] = !was ? "removed" : !now ? "added" : doc !== head ? "changed" : "same";
  return {
    doc,
    brought: { record, name, how, parts, ...(place && how !== "same" ? { place } : {}), ...(how === "same" ? {} : { ripple }) },
    ...(maps ? { intent: { kind: ripple!.direction === "later" ? "ripple-insert" : "ripple-delete", maps } } : {}),
  };
}
