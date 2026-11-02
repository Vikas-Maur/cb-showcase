// project.json <-> engine doc (PLAN §4.2, §4.3, §6.4). Port of core-v5 `cardboard-schema.mjs` (fromHost, toHost,
// projectGuiSave), plus what the prototype left to the materializer: picking the versioned slice out of a whole
// project, and writing a project back with every field Carton doesn't version kept from the file on disk.
import { assignKeys, stripEphemeral, deepEqual, POS } from "@carton/core";
import type { Doc, Rec, ObjectSpec, FieldSpec } from "@carton/core";
import type { OwnFn } from "@carton/core/plugins";
import { cardboardSchema as S, ITEMS, TRACKS, MEDIA, LOCAL_ONLY, CARTON_MEDIA_FIELDS } from "./schema.ts";

/** The slice of a Cardboard `project.json` `project` object that Carton versions. */
export interface CardboardProject {
  name?: string;
  description?: string | null;
  aspectRatio?: string;
  tracks?: Rec[];
  timelineItems?: Rec[];
  media?: Rec[];
  [other: string]: unknown;
}

/** The versioned root fields. Everything else on `project` (id, uid, createdAt, updatedAt, stateUpdatedAt, cast,
 * mediaBaseDirectory, temp, lastOpenedAt…) is the host's own and never becomes a change: stateUpdatedAt alone moves on
 * every write. */
export const ROOT_FIELDS = ["name", "description", "aspectRatio"] as const;
const SLICE_FIELDS = new Set<string>([...ROOT_FIELDS, TRACKS, ITEMS, MEDIA]);

export function sliceOf(project: Readonly<Record<string, unknown>>): CardboardProject {
  const out: CardboardProject = {};
  for (const k of SLICE_FIELDS) if (project[k] !== undefined) out[k] = project[k];
  return out;
}

/** Keyed arrays inside an item: ordered by `#pos` in the engine, plain arrays in project.json. */
export const SEQ_FIELDS: readonly (readonly [string, string])[] = [
  ["effects", "id"],
  ["keyframeTracks", "property"],
  ["captionSegments", "id"],
];

const byOrder = (a: Rec, b: Rec) => ((a.order as number) ?? 0) - ((b.order as number) ?? 0) || (a.id! < b.id! ? -1 : a.id! > b.id! ? 1 : 0);
const orderOf = (tracks: readonly Rec[]): string[] => [...tracks].sort(byOrder).map((t) => t.id as string);
const posCmp = (a: Rec, b: Rec): number => {
  const x = a[POS] as string;
  const y = b[POS] as string;
  return x < y ? -1 : x > y ? 1 : 0;
};
const never: OwnFn = () => false;

/**
 * A project (or its slice) -> engine doc. `base` (an engine doc) supplies existing keys; host order (track `order`,
 * array order) becomes keys by LCS move recovery. `own(seqKey, id)`: the committing author created that element (M4
 * nesting). Records equal to their base record keep the base object, so unchanged records are shared (P4's fast path).
 */
export function fromHost(host: Readonly<Record<string, unknown>>, base: Doc | null = null, own: OwnFn = never): Doc {
  return fromHostKeeping(host, base, own, NONE);
}
const NONE: ReadonlySet<unknown> = new Set();
/** `fromHost`, with the ids of items known to equal their base record (`same`): those keep it as is, uncompared. */
function fromHostKeeping(host: Readonly<Record<string, unknown>>, base: Doc | null, own: OwnFn, same: ReadonlySet<unknown>): Doc {
  const h = sliceOf(host);
  const out: Doc = { ...h };
  const hostTracks = h.tracks ?? [];
  const bt = new Map(((base?.[TRACKS] ?? []) as Rec[]).map((t) => [t.id, t]));
  const hostIds = new Set(hostTracks.map((t) => t.id));
  const tk = assignKeys(
    ((base?.[TRACKS] ?? []) as Rec[]).filter((t) => hostIds.has(t.id)),
    orderOf(hostTracks),
    "id",
    (id) => own(TRACKS, id),
  ).keys;
  out[TRACKS] = hostTracks.map((t) => {
    const { order: _order, ...rest } = t;
    const r = { ...stripEphemeral(rest, S.collections[TRACKS]!.record), [POS]: tk.get(t.id as string) };
    const b = bt.get(t.id);
    return b && deepEqual(b, r) ? b : r;
  });
  const bi = new Map(((base?.[ITEMS] ?? []) as Rec[]).map((i) => [i.id, i]));
  out[ITEMS] = (h.timelineItems ?? []).map((it) => {
    const b = bi.get(it.id);
    if (b && same.has(it.id)) return b;
    let r = stripEphemeral(it, S.collections[ITEMS]!.record) as Rec;
    for (const [f, key] of SEQ_FIELDS) {
      const list = r[f];
      if (!Array.isArray(list)) continue;
      const bl = (b?.[f] ?? []) as Rec[];
      const ids = new Set((list as Rec[]).map((x) => x[key]));
      const ks = assignKeys(
        bl.filter((e) => ids.has(e[key])),
        (list as Rec[]).map((e) => e[key] as string),
        key,
        (id) => own(`${it.id as string}/${f}`, id),
      ).keys;
      const oldBy = new Map(bl.map((e) => [e[key], e]));
      r = {
        ...r,
        [f]: (list as Rec[])
          .map((e): Rec => {
            const x: Rec = { ...e, [POS]: ks.get(e[key] as string) };
            const o = oldBy.get(e[key]);
            return o && deepEqual(o, x) ? o : x;
          })
          .sort((x, y) => posCmp(x, y) || ((x[key] as string) < (y[key] as string) ? -1 : 1)),
      };
    }
    return b && deepEqual(b, r) ? b : r;
  });
  if (h.media) {
    const bm = new Map(((base?.[MEDIA] ?? []) as Rec[]).map((m) => [m.id, m]));
    out[MEDIA] = h.media.map((m) => {
      let r = stripEphemeral(m, S.collections[MEDIA]!.record);
      const b = bm.get(m.id);
      // Fields 1.4.0's project store strips (its media schema drops unknown keys: contentHash, shared, and data.content
      // on media types that don't declare it): an entry without them keeps the base's, so a GUI save never unsets them
      if (b) {
        for (const f of CARTON_MEDIA_FIELDS) if (r[f] === undefined && b[f] !== undefined) r = { ...r, [f]: b[f] };
        const bc = (b.data as Rec | undefined)?.content;
        const rd = r.data as Rec | undefined;
        if (bc !== undefined && rd && typeof rd === "object" && rd.content === undefined) r = { ...r, data: { ...rd, content: bc } };
      }
      return b && deepEqual(b, r) ? b : r;
    });
  }
  return out;
}

/** Engine doc -> the project.json slice: track `order` materialized 0..n-1, `#pos` stripped. */
export function toHost(doc: Doc): CardboardProject {
  const strip = (e: Rec): Rec => {
    const { [POS]: _p, ...r } = e;
    return r;
  };
  const tracks = [...((doc[TRACKS] ?? []) as Rec[])].sort((a, b) => posCmp(a, b) || (a.id! < b.id! ? -1 : 1));
  const out: CardboardProject = { ...(doc as CardboardProject) };
  out.tracks = tracks.map((t, i) => ({ ...strip(t), order: i }));
  out.timelineItems = ((doc[ITEMS] ?? []) as Rec[]).map((it) => {
    let r = it;
    for (const [f] of SEQ_FIELDS) if (Array.isArray(it[f])) r = { ...r, [f]: (it[f] as Rec[]).map(strip) };
    return r;
  });
  return out;
}

/** P: the item as the GUI would save it (Cardboard's `fm∘sv`; see ./projection.ts). */
export type ItemProjection = (item: Rec) => Rec;

/**
 * A GUI save through the renderer's lossy projection P (B10, §4.3): only fields P writes are compared, and a value
 * equal to P(base value) is not a change. The result is an engine doc on `base`'s keys.
 */
export function projectGuiSave(base: Doc, save: Readonly<Record<string, unknown>>, P: ItemProjection): Doc {
  const saveHost = sliceOf(save);
  const baseHost = toHost(base);
  const bItems = new Map((baseHost.timelineItems ?? []).map((i) => [i.id, i]));
  // an item whose every field equals P(base) is its base record: no change, and not compared again below
  const same = new Set<unknown>();
  const items = (saveHost.timelineItems ?? []).map((it) => {
    const b = bItems.get(it.id);
    if (!b) return it;
    const pb = P(b);
    const out: Rec = { ...b };
    let changed = false;
    for (const k of new Set([...Object.keys(pb), ...Object.keys(it)])) {
      if (deepEqual(it[k], pb[k])) continue; // equal to P(base): not a change
      changed = true;
      if (it[k] === undefined) delete out[k];
      else out[k] = it[k];
    }
    if (!changed) same.add(it.id);
    return out;
  });
  return fromHostKeeping({ ...saveHost, timelineItems: items }, base, never, same);
}

/** P applied to every item of an engine doc. */
export function projectDoc(doc: Doc, P: ItemProjection): Doc {
  return { ...doc, [ITEMS]: ((doc[ITEMS] ?? []) as Rec[]).map(P) };
}

// ------------------------------------------------------------------ materializing project.json (§6.4)

/**
 * Lays the versioned values of `ver` over `cur`, keeping `cur`'s unversioned fields: for an `only` object, the declared
 * fields come from `ver` (missing there = removed) and every other field stays; for an ephemeral field, `cur` wins.
 */
function overlay(spec: ObjectSpec, cur: Rec | undefined, ver: Rec): Rec {
  if (!cur) return ver;
  if (!spec.only) {
    const out: Rec = { ...ver };
    for (const [f, fs] of Object.entries(spec.fields)) if (fs.kind === "ephemeral" && cur[f] !== undefined) out[f] = cur[f];
    return out;
  }
  const out: Rec = { ...cur };
  for (const [f, fs] of Object.entries(spec.fields) as [string, FieldSpec][]) {
    if (fs.kind === "ephemeral") continue;
    const v = ver[f];
    if (v === undefined) {
      if (fs.kind === "object" && fs.only && cur[f] && typeof cur[f] === "object") {
        // a versioned subset that is empty in the engine still keeps the host's own fields
        const kept = overlay(fs, cur[f] as Rec, {});
        if (Object.keys(kept).length) out[f] = kept;
        else delete out[f];
      } else delete out[f];
    } else if (fs.kind === "object" && fs.only && v && typeof v === "object" && !Array.isArray(v)) {
      out[f] = overlay(fs, cur[f] as Rec | undefined, v as Rec);
    } else out[f] = v;
  }
  return out;
}

/**
 * A media entry's details: everything on it that Carton doesn't version (its probe's facts, size, where it plays from,
 * thumbnails, when it was added…), without its id. null when it has none (an entry made from history alone).
 */
export function mediaDetails(entry: Readonly<Rec>): Rec | null {
  if (!entry || typeof entry !== "object") return null;
  const { id: _id, ...rest } = overlay(S.collections[MEDIA]!.record, entry as Rec, {});
  return Object.keys(rest).length ? rest : null;
}

/**
 * Where a media entry's details come from when the current file doesn't have the entry (`materializeProject`): given
 * its id and what history holds of it (its kind, its content id when shared), the details last seen for that same
 * media, or nothing.
 */
export type KnownMedia = (id: string, versioned: Readonly<Rec>) => Readonly<Rec> | null | undefined;

/**
 * The `project` object to write to project.json for engine state `doc`: the current file's project with the
 * versioned slice replaced, every record's unversioned fields kept from the current file (matched by id), and the
 * host's own root fields untouched. Track `order` comes from the engine (B12). A media entry the current file doesn't
 * have (a restore after a version without it, a fold that brings it back) takes its details from `known` (the details
 * last seen for that id: `mediaDetails` of an earlier file's entry), else it has only what history versions.
 */
export function materializeProject(doc: Doc, current: Readonly<Record<string, unknown>> | null, known?: KnownMedia): Record<string, unknown> {
  const slice = toHost(doc);
  const cur = (current ?? {}) as CardboardProject;
  const out: Record<string, unknown> = { ...cur };
  for (const k of SLICE_FIELDS) {
    // A doc without a media array never versioned media (an old import): the file's media stay. A doc whose media
    // were all removed has an empty array.
    if (slice[k] === undefined) {
      if (k !== MEDIA) delete out[k];
    } else out[k] = slice[k];
  }
  const curItems = new Map((cur.timelineItems ?? []).map((i) => [i.id, i]));
  out[ITEMS] = (slice.timelineItems ?? []).map((it) => {
    const c = curItems.get(it.id);
    if (!c) return it;
    let r = it;
    for (const f of LOCAL_ONLY) if (c[f] !== undefined) r = { ...r, [f]: c[f] };
    return r;
  });
  if (slice.media) {
    const curMedia = new Map((cur.media ?? []).map((m) => [m.id, m]));
    const had = (m: Rec): Rec | undefined => {
      const c = curMedia.get(m.id);
      // a file's entry the current file holds without what Cardboard's import gives it (review of fix/media-meta #3:
      // one an older writer left with its src only): what is known of that media fills in what it lacks, its own first
      if (c && !(known && lacksDetails(c))) return c;
      const d = known?.(m.id as string, m);
      if (!d || typeof d !== "object") return c;
      return c ? { ...d, ...c, data: { ...((d.data as Rec | undefined) ?? {}), ...((c.data as Rec | undefined) ?? {}) } } : { ...d, id: m.id };
    };
    out[MEDIA] = slice.media.map((m) => codeSize(overlay(S.collections[MEDIA]!.record, had(m), m), out[ITEMS] as Rec[]));
  }
  return out;
}

const num = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const FILE_MEDIA: ReadonlySet<unknown> = new Set(["video", "audio", "image"]);
/** A file's media entry without what Cardboard's import always gives it: where it plays from and its size. */
export function lacksDetails(m: Readonly<Rec>): boolean {
  const d = m.data as Rec | undefined;
  return !!d && typeof d === "object" && FILE_MEDIA.has(d.type) && (d.src === undefined || d.size === undefined || ((d.type === "video" || d.type === "audio") && d.duration === undefined));
}
/**
 * A code graphic's size, which Cardboard's reader requires and Carton doesn't version (only its source), for an entry the
 * current file doesn't have (a restore after the file lost its media, a teammate's new graphic): the composition size of
 * a clip that shows it, which is versioned. None: left as it is (a writer's check then refuses the file).
 */
function codeSize(m: Rec, items: readonly Rec[]): Rec {
  const d = m.data as Rec | undefined;
  const code = d?.code as Rec | undefined;
  if (!code || typeof code !== "object" || (num(code.width) && num(code.height))) return m;
  const c = items.find((it) => it.mediaItemId === m.id && num((it.codeComposition as Rec | undefined)?.width) && num((it.codeComposition as Rec | undefined)?.height))?.codeComposition as Rec | undefined;
  return c ? { ...m, data: { ...d, code: { ...code, width: c.width, height: c.height } } } : m;
}
