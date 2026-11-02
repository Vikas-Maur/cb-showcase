// The details of a project's media entries (laptop, merge/prod-2 P2-1): what Cardboard knows about a file and Carton
// doesn't version (its size, duration and dimensions, where it plays from, thumbnail and waveform ids, when it was
// added). project.json was the only place they lived, so a restore to a version without a clip (main@1, "Started the
// project's history") wrote the file without its entry, and restoring the clip's version brought back only what
// history holds: its id, kind and file name. The clip had no duration, size or thumbnail, and played black until the
// app restarted. So every write that drops an entry from project.json keeps the entry's details here first, and an
// entry the current file doesn't have takes the details last kept for its id (`materializeProject`'s `known`).
//
// Kept per bundle in `.carton/media.json` ({v: 1, media: {<id>: {details, type, contentHash?}}}): beside seen.json and
// displaced/, never in a .cbproj (H11 leaves `.carton` out), never in a log. Details only, without what history
// versions (the file name, a text's content, a code graphic's source), so the project's own text isn't copied here; with
// the entry's kind and content id (shared media's), so details are only ever given back to the same media (review of
// fix/media-meta #1: an id brought back with other content never takes the old file's facts).
import fs from "node:fs";
import path from "node:path";
import { deepEqual } from "@carton/core";
import type { Rec } from "@carton/core";
import { mediaDetails, type KnownMedia } from "../host.ts";
import { retryBusy, type BusyOptions } from "./displace.ts";

export const MEDIA_DETAILS_FILE = path.join(".carton", "media.json");

/** What is kept for a media id: its details, and what they were seen with (its kind, its content id when shared). */
export interface KeptMedia {
  readonly details: Rec;
  readonly type?: string;
  readonly contentHash?: string;
}
/** Each id's newer details, and the entries they came from (not looked at again once kept). */
export interface MediaDetailsChanges {
  readonly details: ReadonlyMap<string, KeptMedia>;
  readonly entries: readonly object[];
}

const isObj = (v: unknown): v is Rec => !!v && typeof v === "object" && !Array.isArray(v);
/** Every value `a` has, `b` has too (objects compared key by key, anything else whole). */
function within(a: unknown, b: unknown): boolean {
  if (isObj(a) && isObj(b)) return Object.keys(a).every((k) => a[k] === undefined || within(a[k], b[k]));
  return deepEqual(a, b);
}
/**
 * Whether `next` replaces the details kept for an id: when they say anything the kept ones don't. An entry that only
 * lost fields (one made from history alone, or from a file that lost them) never replaces what was known.
 */
export const newerDetails = (kept: Rec | undefined, next: Rec): boolean => !kept || !within(next, kept);
const str = (v: unknown): string | undefined => (typeof v === "string" && v ? v : undefined);
const keptOf = (m: Rec, details: Rec): KeptMedia => {
  const type = str((m.data as Rec | undefined)?.type), contentHash = str(m.contentHash);
  return { details, ...(type ? { type } : {}), ...(contentHash ? { contentHash } : {}) };
};
/** The same media: of the same kind, and of the same content where both say which (an entry shared later, or unlinked from sharing, is still its file). */
const sameMedia = (kept: KeptMedia, m: Readonly<Rec> | undefined): boolean => {
  if (!isObj(m)) return false;
  const type = str((m.data as Rec | undefined)?.type), hash = str(m.contentHash);
  return (!kept.type || !type || kept.type === type) && (!kept.contentHash || !hash || kept.contentHash === hash);
};
/** Whether `next` replaces what is kept: other media, or details saying anything the kept ones don't. */
const replaces = (kept: KeptMedia | undefined, next: KeptMedia): boolean =>
  !kept || kept.type !== next.type || kept.contentHash !== next.contentHash || newerDetails(kept.details, next.details);

/**
 * The media entries of `before` that `after` doesn't have (by id): what a write of `after` over `before` drops from
 * project.json. Without allocating anything when the media list is the same array or nothing is dropped.
 */
export function droppedMedia(before: Readonly<Record<string, unknown>> | null | undefined, after: Readonly<Record<string, unknown>> | null | undefined): Rec[] {
  const was = before?.media;
  if (!Array.isArray(was) || !was.length || was === after?.media) return [];
  const list = Array.isArray(after?.media) ? (after!.media as unknown[]) : [];
  const now = new Set<unknown>();
  for (const m of list) if (isObj(m)) now.add(m.id);
  const out: Rec[] = [];
  for (const m of was) if (isObj(m) && !now.has(m.id)) out.push(m);
  return out;
}

/**
 * One bundle's media details. An entry object already looked at is skipped by identity, and the file is written only
 * when an entry says something new. Another process's writes are read again when the file changed (its stamp).
 */
export class MediaDetails {
  readonly file: string;
  #seen = new WeakSet<object>();
  #kept = new Map<string, KeptMedia>();
  #stamp: string | null | undefined = undefined; // the file's stamp when last read; undefined: never read
  readonly #busy: BusyOptions;

  constructor(bundle: string, busy: BusyOptions = {}) {
    this.file = path.join(bundle, MEDIA_DETAILS_FILE);
    this.#busy = busy;
  }

  /**
   * The details last kept for each media id, for `materializeProject` (the file read again if it changed): only for the
   * same media (its kind, and its content id where both have one), else none.
   */
  known(): KnownMedia {
    this.#load();
    const kept = this.#kept;
    return (id, versioned) => {
      const k = kept.get(id);
      return k && sameMedia(k, versioned) ? k.details : undefined;
    };
  }

  /** What `entries` say that isn't kept yet: null when nothing. An entry with nothing new isn't looked at again. */
  changes(entries: Iterable<unknown>): MediaDetailsChanges | null {
    let details: Map<string, KeptMedia> | null = null;
    const from: object[] = [];
    let loaded = false;
    for (const m of entries) {
      if (!isObj(m) || this.#seen.has(m)) continue;
      const d = typeof m.id === "string" && m.id ? mediaDetails(m) : null;
      if (!d) { this.#seen.add(m); continue; }
      if (!loaded) this.#load(), (loaded = true);
      const next = keptOf(m, d);
      if (!replaces(this.#kept.get(m.id as string), next)) { this.#seen.add(m); continue; }
      (details ??= new Map()).set(m.id as string, next);
      from.push(m);
    }
    return details ? { details, entries: from } : null;
  }

  /**
   * Keeps `changes` in the file, merged with what another process wrote since (the newer rule applied again). The
   * caller holds the bundle's install lock, which every writer of this file takes, so two processes don't lose each
   * other's.
   */
  // What is kept in memory changes only once the file says so (review of fix/media-meta #5: a failed write left this
  // process believing them kept, so it never tried again): a failure throws, and the next drop of them tries again.
  async save(changes: MediaDetailsChanges): Promise<void> {
    this.#load();
    const next = new Map(this.#kept);
    let wrote = false;
    for (const [id, k] of changes.details) if (replaces(next.get(id), k)) next.set(id, k), (wrote = true);
    if (wrote) {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`;
      try {
        fs.writeFileSync(tmp, JSON.stringify({ v: 1, media: Object.fromEntries(next) }));
        await retryBusy(() => fs.renameSync(tmp, this.file), this.#busy);
      } catch (e) {
        fs.rmSync(tmp, { force: true });
        throw e;
      }
      this.#kept = next;
      this.#stamp = this.#stampNow();
    }
    for (const e of changes.entries) this.#seen.add(e);
  }

  #stampNow(): string | null {
    try { const s = fs.statSync(this.file); return `${s.size}:${s.mtimeMs}:${s.ino}`; } catch { return null; }
  }
  #load(): void {
    const stamp = this.#stampNow();
    if (stamp === this.#stamp) return;
    this.#stamp = stamp;
    this.#kept = new Map();
    if (stamp === null) return;
    try {
      const j = JSON.parse(fs.readFileSync(this.file, "utf8"));
      if (isObj(j?.media)) {
        for (const [id, k] of Object.entries(j.media)) {
          if (!isObj(k) || !isObj(k.details)) continue;
          this.#kept.set(id, { details: k.details, ...(str(k.type) ? { type: k.type as string } : {}), ...(str(k.contentHash) ? { contentHash: k.contentHash as string } : {}) });
        }
      }
    } catch {
      // unreadable (half-written by hand, or damaged): nothing is known; the next save replaces it
    }
  }
}
