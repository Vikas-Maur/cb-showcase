// Shared landmarks (Carton UX v2, DESIGN-V2 §2.1): the versions a team remembers that the history can't know by itself,
// an export of the video (`exported`) and a version shared, sent for review or published (`sent`), kept for every
// teammate. Never a change: no row in `changes`, no seq, no version, no undo step. Their own table beside the
// sequencer's, created on first use (as comments' are), so a deployed server takes it with no migration and archiving
// the cut's rows (§6.3 segments) never touches them.
//
//   landmarks (branch TEXT, n INTEGER, id TEXT, row TEXT, PRIMARY KEY (branch, n)) WITHOUT ROWID
//
// `n` is the landmark's place in its cut's stream (1, 2, …): a client asks for the ones after the last it stored. Row
// n = 0 holds the stream's generation (`gen`, random, written with its first landmark): a client that read another
// generation knows the stream started over (storage lost or replaced) and offers its own again. A
// landmark costs 1 row written (its row; P5-style accounting). A retry of one already kept (the same id) is found by a
// scan of the cut's rows, at most MAX_PER_CUT: no secondary index (§6.3's tables have none on their hot paths, and a
// landmark is rare: an export, a link made). A cut keeps its newest MAX_PER_CUT; the oldest go.

import type { SequencerStorage } from "@carton/core/plugins";
import type { sync } from "@carton/core";

type SharedLandmark = sync.SharedLandmark;

/** The most landmarks a cut keeps (the oldest go first). */
export const MAX_PER_CUT = 1000;
/** Landmarks per catch-up page. */
export const PAGE = 200;
/** The longest label kept, in characters (the client cuts at 120). */
export const LABEL_MAX = 120;
/** The largest `by` kept, in bytes of JSON (an Actor: kind, id, name, its agent's turn…). */
export const BY_MAX = 1024;
const KINDS: ReadonlySet<string> = new Set(["exported", "sent"]);
const ID = /^[0-9A-Za-z_-]{1,64}\.L[0-9A-Za-z]{1,32}$/;
const DDL = "CREATE TABLE IF NOT EXISTS landmarks (branch TEXT NOT NULL, n INTEGER NOT NULL, id TEXT NOT NULL, row TEXT NOT NULL, PRIMARY KEY (branch, n)) WITHOUT ROWID";

export interface LandmarkStore {
  /** The cut's stream head: its newest landmark's place (0: none). */
  head(branch: string): number;
  /** Up to PAGE landmarks after `since`, oldest first, and whether more follow. */
  after(branch: string, since: number): { rows: SharedLandmark[]; more: boolean };
  /** Keep one (checked: `check`), or find the one kept under its id. `fresh`: it wasn't kept before. */
  keep(branch: string, mark: SharedLandmark): { row: SharedLandmark; fresh: boolean };
  /** A share cancelled: the cut's landmarks go with its rows. */
  drop(branch: string): void;
  /** The cut's stream generation (null: no landmark kept yet). */
  gen(branch: string): string | null;
}

/**
 * What's wrong with a landmark a client sent, in words for a log (null: nothing). Its version must exist (`head`: the
 * cut's confirmed head); the rest is shape and size.
 */
export function landmarkProblem(m: unknown, head: number): string | null {
  const x = (m && typeof m === "object" ? m : {}) as Partial<SharedLandmark>;
  if (typeof x.id !== "string" || !ID.test(x.id)) return "a landmark's id is <rid>.L<letters and digits>";
  if (typeof x.kind !== "string" || !KINDS.has(x.kind)) return "a shared landmark is exported or sent";
  if (!Number.isInteger(x.seq) || x.seq! < 0 || x.seq! > head) return "a landmark marks a version the cut has";
  if (typeof x.at !== "number" || !Number.isFinite(x.at) || x.at < 0 || x.at > 8.64e15) return "a landmark has a time a date can say";
  const by = x.by as { kind?: unknown; id?: unknown } | undefined;
  if (!by || typeof by !== "object" || typeof by.kind !== "string" || typeof by.id !== "string") return "a landmark says who made it";
  if (JSON.stringify(by).length > BY_MAX) return "a landmark's author is too long";
  if (x.label !== undefined && (typeof x.label !== "string" || [...x.label].length > LABEL_MAX)) return `a landmark's label is at most ${LABEL_MAX} characters`;
  return null;
}

/** A stream generation: 64 random bits, hex. */
const newGen = () => Array.from(crypto.getRandomValues(new Uint8Array(8)), (b) => b.toString(16).padStart(2, "0")).join("");

export function landmarkStore(db: SequencerStorage): LandmarkStore {
  let ready = false;
  const init = () => {
    if (ready) return;
    db.exec(DDL);
    ready = true;
  };
  const num = (v: unknown): number => (typeof v === "bigint" ? Number(v) : typeof v === "number" ? v : 0);
  const head = (branch: string): number => {
    init();
    return num(db.exec<{ m: number | null }>("SELECT MAX(n) AS m FROM landmarks WHERE branch = ?", branch)[0]?.m ?? 0);
  };
  const parse = (r: { row: unknown; n: unknown }): SharedLandmark => ({ ...(JSON.parse(String(r.row)) as SharedLandmark), n: num(r.n) });
  return {
    head,
    after(branch, since) {
      init();
      const got = db.exec<{ n: number; row: string }>("SELECT n, row FROM landmarks WHERE branch = ? AND n > ? ORDER BY n LIMIT ?", branch, Math.max(0, Math.floor(since) || 0), PAGE + 1);
      return { rows: got.slice(0, PAGE).map(parse), more: got.length > PAGE };
    },
    keep(branch, mark) {
      init();
      const had = db.exec<{ n: number; row: string }>("SELECT n, row FROM landmarks WHERE branch = ? AND id = ?", branch, mark.id)[0];
      if (had) return { row: parse(had), fresh: false };
      const n = head(branch) + 1;
      // only what a landmark is: nothing else a client put in it is kept or told
      const row: SharedLandmark = { id: mark.id, kind: mark.kind, seq: mark.seq, at: mark.at, by: mark.by, ...(mark.label ? { label: mark.label } : {}) };
      db.transaction(() => {
        // a stream's first landmark: its generation too (one row more, once)
        if (n === 1) db.exec("INSERT OR IGNORE INTO landmarks (branch, n, id, row) VALUES (?, 0, '', ?)", branch, newGen());
        db.exec("INSERT INTO landmarks (branch, n, id, row) VALUES (?, ?, ?, ?)", branch, n, mark.id, JSON.stringify(row));
        if (n > MAX_PER_CUT) db.exec("DELETE FROM landmarks WHERE branch = ? AND n > 0 AND n <= ?", branch, n - MAX_PER_CUT);
      });
      return { row: { ...row, n }, fresh: true };
    },
    drop(branch) {
      init();
      db.exec("DELETE FROM landmarks WHERE branch = ?", branch);
    },
    gen(branch) {
      init();
      const r = db.exec<{ row: string }>("SELECT row FROM landmarks WHERE branch = ? AND n = 0", branch)[0];
      return r ? String(r.row) : null;
    },
  };
}
