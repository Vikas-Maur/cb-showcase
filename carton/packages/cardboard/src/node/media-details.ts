// The details of a project's media entries (laptop, merge/prod-2 P2-1): what Cardboard knows about a file and Carton
// doesn't version (its size, duration and dimensions, where it plays from, thumbnail and waveform ids, when it was
// added). project.json was the only place they lived, so a restore to a version without a clip (main@1, "Started the
// project's history") wrote the file without its entry, and restoring the clip's version brought back only what
// history holds: its id, kind and file name. The clip had no duration, size or thumbnail, and played black until the
// app restarted. So every write that drops an entry from project.json keeps the entry's details here first, and an
// entry the current file doesn't have takes the details last kept for its id (`materializeProject`'s `known`).
//
// Kept per bundle in `.carton/media.json` ({v: 1, media: {<id>: details}}): beside seen.json and displaced/, never in a
// .cbproj (H11 leaves `.carton` out), never in a log. Details only, without what history versions (the file name, a
// text's content, a code graphic's source), so the project's own text isn't copied here.
import fs from "node:fs";
import path from "node:path";
import { deepEqual } from "@carton/core";
import type { Rec } from "@carton/core";
import { mediaDetails, type KnownMedia } from "../host.ts";
import { retryBusy, type BusyOptions } from "./displace.ts";

export const MEDIA_DETAILS_FILE = path.join(".carton", "media.json");

/** Each id's newer details, and the entries they came from (not looked at again once kept). */
export interface MediaDetailsChanges {
  readonly details: ReadonlyMap<string, Rec>;
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
  #kept = new Map<string, Rec>();
  #stamp: string | null | undefined = undefined; // the file's stamp when last read; undefined: never read
  readonly #busy: BusyOptions;

  constructor(bundle: string, busy: BusyOptions = {}) {
    this.file = path.join(bundle, MEDIA_DETAILS_FILE);
    this.#busy = busy;
  }

  /** The details last kept for each media id, for `materializeProject` (the file read again if it changed). */
  known(): KnownMedia {
    this.#load();
    const kept = this.#kept;
    return (id) => kept.get(id);
  }

  /** What `entries` say that isn't kept yet: null when nothing. An entry with nothing new isn't looked at again. */
  changes(entries: Iterable<unknown>): MediaDetailsChanges | null {
    let details: Map<string, Rec> | null = null;
    const from: object[] = [];
    let loaded = false;
    for (const m of entries) {
      if (!isObj(m) || this.#seen.has(m)) continue;
      const d = typeof m.id === "string" && m.id ? mediaDetails(m) : null;
      if (!d) { this.#seen.add(m); continue; }
      if (!loaded) this.#load(), (loaded = true);
      if (!newerDetails(this.#kept.get(m.id as string), d)) { this.#seen.add(m); continue; }
      (details ??= new Map()).set(m.id as string, d);
      from.push(m);
    }
    return details ? { details, entries: from } : null;
  }

  /**
   * Keeps `changes` in the file, merged with what another process wrote since (the newer rule applied again). The
   * caller holds the bundle's install lock, which every writer of this file takes, so two processes don't lose each
   * other's.
   */
  async save(changes: MediaDetailsChanges): Promise<void> {
    this.#load();
    let wrote = false;
    for (const [id, d] of changes.details) if (newerDetails(this.#kept.get(id), d)) this.#kept.set(id, d), (wrote = true);
    if (wrote) {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify({ v: 1, media: Object.fromEntries(this.#kept) }));
      try { await retryBusy(() => fs.renameSync(tmp, this.file), this.#busy); } catch (e) { fs.rmSync(tmp, { force: true }); throw e; }
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
      if (isObj(j?.media)) for (const [id, d] of Object.entries(j.media)) if (isObj(d)) this.#kept.set(id, d);
    } catch {
      // unreadable (half-written by hand, or damaged): nothing is known; the next save replaces it
    }
  }
}
