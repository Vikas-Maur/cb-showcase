// The materializer (PLAN §6.4): Carton's side of the files other processes also write. Port of the system-v11
// prototype's `Materializer` onto real files.
//
// Files, all inside the project bundle:
//   project.json              the H1 view of head (with every unversioned field kept from the file)
//   timeline.tsx              the shared file: 1.4.0's header contract, regenerated after every applied save (R7-01),
//                             a freeze view while a local agent is active (R8-01), remote rewrites ≥ 30 s apart (R5-05)
//   .scratch/views/<n>.tsx    per-agent views, the documented flow: applied live, never rewritten except on an
//                             explicit print by their owner; the base of a save is the last applied save of the same
//                             print (same print nonce), else the header ref (R4-02)
//   .scratch/views/<n>.status the status sidecar after each apply (R5-04)
//   .carton/displaced/        what Carton moved off a path; held until reviewed (P10 settle-2). Each name carries the
//                             path it came from, so a restart finds and finishes what an earlier process held. Another
//                             folder with `displacedDir` (a host whose own files are there, the app's facade).
//
// With `writeProject: false` project.json is the host's: never watched, imported, recovered or written here.
//
// Every Carton write to a watched path goes through `displaceThenInstall`, so Carton never destroys a file it hasn't
// seen, under the bundle's install lock (`.carton/install.lock/`, shared with the app's facade): the path is missing for
// a moment between the displace and the link on every OS, and stock 1.4.0 takes a missing project.json for a removed
// project, so the app's readers wait while the lock is held (see ./displace.ts). A foreign save is read on every watch event and applied at once when it parses; content that doesn't parse
// yet (an in-place writer mid-write) waits for 150 ms of quiet, and a file that never parses is kept and reported.
// A displaced save is deleted only once its change is stored; one that can't be applied stays in `.carton/displaced`.
//
// All work runs one task at a time (the engine thread's order), so two saves never interleave.
import fs from "node:fs";
import path from "node:path";
import { createHash, randomBytes } from "node:crypto";
import type { Actor, ConflictCard, Doc } from "@carton/core";
import type { OwnFn } from "@carton/core/plugins";
import { BUSY_BUDGET_MS, displaceThenInstall, hardLinksWork, retryBusy, stampOf, statStamp, type BusyOptions } from "./displace.ts";
import { withInstallLock } from "./install-lock.ts";
import { DisplacedFiles, type OwnInstall } from "./displaced.ts";
import { findRev, renderRev, printNonce, REV_TAG, type Rev } from "../header.ts";
import type { Project, TimelineCodec } from "../codec.ts";
import { breaks } from "../valid.ts";

export const PROJECT_FILE = "project.json";
export const TIMELINE_FILE = "timeline.tsx";
export const VIEWS_DIR = ".scratch/views";
export const CARTON_DIR = ".carton";
export const viewPath = (name: string): string => `${VIEWS_DIR}/${name}.tsx`;
export const statusPath = (name: string): string => `${VIEWS_DIR}/${name}.status`;
const DAY = 86_400_000;
const REV_PREFIX = `// ${REV_TAG} `;

/** A commit's base when Carton holds the doc: a view's last applied save, with its causal past. */
export interface HeldBase {
  baseDoc: Doc;
  baseSeq: number;
  causal: string[];
  /** The cut this state was pinned on, when known: a freeze view belongs to it (B6). */
  cut?: string;
}

export interface SaveResult {
  /** `conflicts`: committed, with cards that kept head's value; the human and the actor are told. */
  status: "confirmed" | "pending" | "conflicts" | "rejected";
  id?: string;
  seq?: number;
  cards?: ConflictCard[];
  reason?: string;
  /** The cut the commit went to (read once for it): a state built on the save belongs to that cut. */
  cut?: string;
}

/** A pinned state: the ref token core prints (`<cut>@<seq>~<hash8>`), its cut, its seq, and its doc. */
export interface Pinned {
  ref: string;
  branchId: string;
  seq: number;
  doc: Doc;
  /** The cut pinned on (`MaterializerEngine.cut` when the pin was asked for). */
  cut?: string;
  /** With `deferRecord`: the engine's record of the pin, for the caller to store with its next meta write. */
  record?: MetaRow;
  /** The changes past `seq` the pinned state holds (head's pending changes on a shared cut), when the engine says. */
  pending?: string[];
}

/**
 * A write whose author waits to read it in the shared timeline.tsx (`showChange`, read-your-writes): its change id, the
 * cut it went to, its confirmed seq (none while it is pending on a shared cut), and who made it.
 */
export interface ShowTarget {
  id: string;
  cut?: string;
  seq?: number;
  author?: Actor | null;
}
/**
 * Whether timeline.tsx shows a write (`showChange`): `shown`; `held`: the file is frozen for someone else's work and
 * holds this change back until that ends (the person's own `cb` during an agent's turn); `elsewhere`: the change is on
 * another cut than the one the file shows; `later`: not within the wait (a host write still landing, a rewrite that
 * failed and is tried again), and it shows once that is done.
 */
export type Showing = "shown" | "held" | "elsewhere" | "later";

/** A row of local metadata (`MaterializerEngine.putMeta`). */
export interface MetaRow {
  key: readonly string[];
  value: unknown;
}

/**
 * Which of an owner's pins outlive later ones: the newest `count`, every pin younger than `ms`, and the pins in `hold`
 * (states as `Pinned` gives them or as a header names them: `branchId` a cut id or its `b:` token). `hold` can be a
 * function, asked when the prune runs (what a file on disk shows then, whoever printed it); if it fails, nothing is
 * released.
 */
export interface PinKeep {
  count: number;
  ms: number;
  hold?: readonly PinHold[] | (() => Promise<readonly PinHold[]>);
}
/** A state a prune must not release (see `PinKeep`). */
export interface PinHold {
  branchId: string;
  ref: string;
}

/** A pending change of this replica's on a shared cut, with the optimistic states just before and after it. */
export interface PendingChange {
  id: string;
  author: Actor;
  before: Doc;
  after: Doc;
  /** How many times it was rebased (0: as committed; core's `pendingChanges`). */
  rebases?: number;
  /** Whether a rebase changed its edits from those it was committed with. */
  edited?: boolean;
}

/**
 * A save applied during a freeze, its commit pending: its base and content, and its change's edits as committed
 * (`editsKey`; "" when they can't be told: a rebase changed them, or it was confirmed, before they were read; it then
 * shows by its edits as they are, and joins the view by what was confirmed).
 */
interface FrozenSave {
  base: Doc;
  saved: Doc;
  key: string;
}

/** What the materializer needs from the engine. `cartonMaterializerEngine` implements it over `Carton`. */
export interface MaterializerEngine {
  /** The current cut's optimistic head. */
  head(): Promise<Doc>;
  /**
   * Pins the head, or `doc` (a state not in the log: the freeze view) for `owner`. `seq` is the confirmed seq `doc`
   * was derived from, so a commit on it is checked against everything confirmed since (default: head); `causal`: the
   * changes after `seq` that `doc` already holds (agent saves merged into a freeze view), never met again. `cut`: the
   * cut to pin on (default: the current one). `keep`: this owner's older pins may be released past it (the shared
   * file's prints); once given it holds for the owner's later pins in this process too. `deferRecord`: the engine's own record of the pin comes back in `record`, for the caller to store
   * with its next meta write (`putMetas`), instead of being stored on its own.
   */
  pin(opts: { owner: string; cut?: string; doc?: Doc; seq?: number; causal?: string[]; ttlMs: number; keep?: PinKeep; deferRecord?: boolean }): Promise<Pinned>;
  /** Releases every pin `owner` holds (a turn ended). */
  release(owner: string): Promise<void>;
  /** A printed ref -> its exact state and causal past. Throws "state unknown: re-print" when it can't (§4.4). */
  resolve(rev: Rev): Promise<HeldBase>;
  /**
   * Commits `doc` made on `base`; cards keep head's value and are reported (late conflicts arrive as notices). With
   * `id`, a commit whose id is already confirmed returns that confirmation (and its cards), never a second change.
   */
  commit(input: { doc: Doc; base: Rev | HeldBase; author: Actor; meta: { file: string; view?: string }; id?: string }): Promise<SaveResult>;
  /**
   * The confirmed changes on `cut` (default: the current one) after `seq` and before `until`, outside `skip`, newest
   * first, read as they are asked for (a caller can stop early), each with the states just before and after it: whether
   * a save repeated an edit of a change it never saw (rounds 13-15); and who made it, when known (an agent's `cb` change
   * joins a frozen shared file's view).
   */
  changesSince?(seq: number, o?: { cut?: string; until?: number; skip?: ReadonlySet<string> }): AsyncIterable<{ id: string; seq: number; before: Doc; after: Doc; author?: Actor | null }>;
  /**
   * This replica's pending changes on a shared cut (default: the current one), in queue order, on the confirmed `seq`
   * the queue is on: a local agent's offline edit shows in a frozen shared file before its confirmation.
   */
  pendingChanges?(cut?: string): Promise<{ seq: number; changes: PendingChange[] }>;
  /** A fresh change id, recorded before committing so a retry commits with the same id (dedup by id). */
  newChangeId?(): string;
  /** Where a confirmed change is (its cut and seq), or null while it isn't confirmed (pending, withdrawn, unknown). */
  changeAt?(id: string): Promise<{ cut: string; seq: number } | null>;
  notice(to: Actor, notice: { kind: "error" | "conflicts"; text: string; change?: string }): Promise<void>;
  /** M4: did `author` create sequence element `id`? Keeps one author's run of inserts contiguous across saves. */
  own?(author: Actor): OwnFn;
  /** Local metadata (carton.db's `views` table), shared by every process on this machine. */
  getMeta<T>(key: readonly string[]): Promise<T | undefined>;
  putMeta(key: readonly string[], value: unknown): Promise<void>;
  /** Several rows in one store write (without it, one `putMeta` each). */
  putMetas?(rows: readonly MetaRow[]): Promise<void>;
  /** Whether the current cut is shared (remote rewrites of the shared file are rate-limited). */
  shared(): boolean;
  /** The current cut's id: pins and commits go to it. The freeze view belongs to the cut it started on (B6). */
  cut?(): string;
  /**
   * The current cut's optimistic head as a short key (cut, branch, seq, pending change ids), read fresh from the store:
   * another process may have moved it (B11). Without it, `onExternalHeadChange` always rewrites (still idempotent: unchanged files stay).
   */
  headRef?(): Promise<string>;
}

/** The host's document conversions the materializer needs (Cardboard's are in `@carton/cardboard`). */
export interface MaterializerHost {
  /** A parsed project -> engine doc, keyed against `base` (LCS move recovery; `own` keeps an author's run together). */
  fromProject(project: Project, base: Doc | null, own?: OwnFn): Doc;
  /** Engine doc -> the project to print or write, keeping `current`'s unversioned fields. */
  toProject(doc: Doc, current: Project | null): Project;
  /** Three-way merge of docs; used to gather agents' saves into the freeze view (R8-01). */
  merge3(base: Doc, ours: Doc, theirs: Doc): Doc;
  /**
   * The changes from one doc to another, each as a comparable string (the same edit made from either side gives the
   * same string). Finds a save that took in part of what the freeze hides; without it, such a save is merged as any.
   */
  changes?(from: Doc, to: Doc): string[];
  /** Hard and soft findings for the status sidecar, as 1.4.0's `// diagnostics:` lists them. */
  diagnose(saved: Doc, head: Doc): string[];
}

export interface Clock {
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}
const realClock: Clock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => {
    const t = setTimeout(fn, ms);
    t.unref?.();
    return t;
  },
  clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
};

/** Cards a save raised (head's value kept): data for the human's conflict cards, and stored under `["cards", id]`. */
export interface SaveCards {
  /** This save's cards' own id (stored at `["cards", batch]`), whether or not the save made a change. */
  batch: string;
  change: string | null;
  /** The id the save was committed under (the engine keeps the author's cards under it, even when no change was made). */
  request?: string;
  file: string;
  actor: Actor;
  cards: ConflictCard[];
  at: number;
  /** The cut the save was committed on (its stored result's, also for a save finished after a restart). */
  cut?: string;
}

/**
 * What a host's own write that caused a head change leaves (`onHeadChange`'s `after` resolves to it): project.json as
 * the host has just written it (`writeProject: false`), its envelope and its stamp (`statStamp`, taken
 * right after the write). The materializer then takes the envelope from it instead of reading the file again, while the
 * file's stamp is that one. The envelope is kept as given: the host doesn't change it afterwards.
 */
export interface HostWrite {
  project?: { envelope: Record<string, unknown>; stamp: string };
}

export interface MaterializerOptions {
  bundle: string;
  engine: MaterializerEngine;
  host: MaterializerHost;
  codec: TimelineCodec;
  clock?: Clock;
  /** Who Carton's prints say printed them. */
  printedBy?: string;
  /** Quiet window for content that doesn't parse yet, and the hold for Carton's own displaced files. */
  quietMs?: number;
  /** Local (GUI) changes rewrite the shared file this soon (coalesced). */
  localRewriteMs?: number;
  /** Remote changes rewrite the shared file at most this often while the cut is shared (R5-05). */
  remoteRewriteMs?: number;
  /**
   * A windowless agent counts as active until this long after its last save or `cb` call; a hooked one until its Stop,
   * or this long after its last hook event (a Stop can be lost: Claude Code sends none when the user interrupts a turn).
   */
  freezeIdleMs?: number;
  /** How long a hooked agent's announced write (`hookWrite`) waits for its save to land. */
  attributeMs?: number;
  /**
   * Write project.json as a view of head (H1). Off when the host writes it itself: then project.json is the host's, and
   * the materializer leaves it alone (no watch events, no imports of its saves, no recovery of displaced copies).
   */
  writeProject?: boolean;
  /**
   * Where displaced files are held, absolute or relative to the bundle (default `.carton/displaced`). It must be on the
   * bundle's volume (files are renamed into it), and this materializer's alone: at start every file in it is taken as
   * one this materializer moved aside. A host with files of its own in `.carton/displaced` (the app's facade) gives
   * another folder.
   */
  displacedDir?: string;
  /** Treat file names case-insensitively (default: on Windows and macOS, whose file systems fold case). */
  foldCase?: boolean;
  /**
   * On Windows, how long a file another process has open (EPERM, EBUSY, EACCES) is retried in all, in ms (default 5 s).
   * The retries wait on timers: the worker's thread keeps serving everything else meanwhile.
   */
  busyBudgetMs?: number;
  /** Cards a save raised, for the human (conflict cards). */
  onCards?: (c: SaveCards) => void;
  /**
   * How long superseded prints of the shared timeline.tsx (head's and the freeze views') stay pinned: while among the
   * newest `count` (default 256) or younger than `ms` (default a day); older ones are released. A save on such a print
   * (a writer that read it long ago, R7-01) still applies exactly when its state is a confirmed version (no pin needed);
   * one on a freeze view or on edits still pending is refused "state unknown: re-print" once its pin is released.
   */
  keepPrints?: Partial<PinKeep>;
  /**
   * This machine's actor group (`@carton/local`'s `localGroup()`, e.g. `local:me@m1`). On a shared cut an agent's
   * change in it is this machine's: a windowless local agent's `cb` edit shows in a frozen shared file, as a hooked
   * agent's does. Without it, only hooked agents' changes there.
   */
  group?: string;
}

export interface ViewRow {
  /** Who printed it: the turn's actor for hooked agents, otherwise the view's own name. */
  owner: Actor;
  pinOwner: string;
  header: string;
  nonce: string;
  printedAt: number;
  /** Counts this view's prints: a displaced view file remembers the print it belonged to. */
  printGen?: number;
  /** The last applied save of this print: its parsed state, the base of the next save with the same nonce. */
  last?: { contentHash: string; nonce: string; held: HeldBase } | null;
  /** The change behind the sidecar now; a later update for another change (or after a print or an error) is stale. */
  lastChange?: string | null;
  /** The print generation of the save the sidecar shows (none since this print: unset). */
  savedGen?: number;
}

export interface StatusBody {
  status: "confirmed" | "pending" | "conflicts" | "rejected" | "error";
  ref: string | null;
  seq: number | null;
  conflicts: ConflictCard[];
  diagnostics: string[];
  change: string | null;
  at: number;
  error?: string;
}

/**
 * What Carton knows about one watched path, kept in carton.db so every process (worker, helper) agrees:
 * - `last`: the content now considered current at the path (Carton's install, or the foreign save last applied or
 *   tried). A watch event or an unread-save check only acts on content that differs from it: an undo back to an
 *   earlier text is a new save, never "seen before".
 * - `written`: Carton's recent installs (content hash and install stamp), so a restart can tell its own displaced
 *   files from foreign ones.
 * - `applied`, `failed`: stamps of foreign files whose save was stored, or tried and refused; a displaced file with one
 *   of those stamps is that same file, moved.
 *
 * What has happened at a path is a row of its own, `["file", rel, "seen"]`: a random token, written anew (never read
 * from a cache) by whatever makes an earlier save's bytes, written again, a save of their own (see `finishes`).
 */
interface PathState {
  last: string | null;
  written: { hash: string; stamp: string }[];
  applied: string[];
  failed: string[];
}
const KEEP_WRITTEN = 8;
/** At most this many changes a save didn't see are read for it; past them it takes the exact path (round 15 #1). */
const HIDDEN_SCAN = 256;
/** The longest a rewrite waits for a host write told with its head change (`onHeadChange`'s `after`). */
const LAND_WAIT_MS = 5_000;
const KEEP_STAMPS = 32;

type Record_ = { t: number; path: string; [k: string]: unknown };
/**
 * One save of a path in progress, recorded before its commit: which file generation (stamp and bytes) on which base,
 * the change id it commits with, and once committed, the result. A retry of that same save reuses the id (and the
 * result) instead of committing again; a different save of the path takes the slot over.
 */
/** A save's attempt slot (`["attempt", rel]`): its change id before the commit, its result after, until it is settled. */
type Attempt = { gen: string; base: string; hash?: string; id?: string; result?: SaveResult; seen?: string };
/**
 * Whether a save's recorded result finishes this file instead of a commit: the same file (its generation, at the path
 * or displaced), or its bytes written again while nothing has happened at the path since its attempt started (round
 * 19 #3): the path's `seen` token is still the one the slot was made with (the token its own review wrote; round 22
 * #2). It is written anew, before the event's own writes (so an event whose token can't be stored fails and is
 * retried), by Carton installing a file there (outside a save of the path), by every review of a file there but this
 * save's own (whatever its outcome: committed, head-equal, refused, failed; content that doesn't parse too), by a late
 * update of a view's sidecar, and by a finished save whose slot couldn't be cleared. After any of them the same bytes
 * are a save of their own: a GUI saving an earlier state again after a later one, a stale buffer after a remote change
 * (rounds 20-22). The token is shared by every process (a takeover helper's install counts) and never cached.
 */
const finishes = (slot: Attempt | undefined, seen: string, gen: string, hash: string): boolean =>
  !!slot?.result && slot.hash === hash && (slot.gen === gen || (slot.seen !== undefined && slot.seen === seen));
/** A foreign project.json's envelope, kept for its unversioned fields until Carton's next write consumes it. */
type Overlay = { id: string; envelope: Record<string, unknown>; mtimeNs?: string };
type Found = { path: string; bytes: Buffer; rel: string; mtimeNs: bigint; stamp: string | null; viewGen?: number };
/** `fromDisplaced`: from `.carton/displaced`; `viewGen`: the view's print generation the displaced file was moved off in. */
type ApplyOptions = { fromDisplaced?: boolean; viewGen?: number };
/**
 * A view print replaced at a save's commit (`["reprinted", view, nonce]`): `hash` is that save's file, `change` its
 * change and `gen` its print generation, as the view row records them while it is the view's latest save.
 */
interface Replaced {
  hash: string;
  at: number;
  change: string | null;
  gen: number;
}
type Origin = { rel: string; mtimeNs: bigint; viewGen?: number };
/** A file as read: its bytes, content hash and stamp. */
type FileRead = { bytes: Buffer; hash: string; stamp: string };

const sha = (b: Uint8Array | string): string => createHash("sha256").update(b).digest("hex");
/** `headRef` keys are JSON [cut, branch, seq]. */
const cutOfKey = (key: string): unknown => (JSON.parse(key) as unknown[])[0];
/** Structural equality of two documents (key order aside). */
function sameDoc(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) return a.length === (b as unknown[]).length && a.every((x, i) => sameDoc(x, (b as unknown[])[i]));
  const ka = Object.keys(a as object).filter((k) => (a as Record<string, unknown>)[k] !== undefined);
  const kb = Object.keys(b as object).filter((k) => (b as Record<string, unknown>)[k] !== undefined);
  return ka.length === kb.length && ka.every((k) => sameDoc((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]));
}
const push = <T>(list: T[], x: T, keep: number): void => {
  list.push(x);
  if (list.length > keep) list.splice(0, list.length - keep);
};
/** The ref string core resolves (`<cut>@<seq>~<hash8> b:<branch8>`) for a pin. */
const refBodyOf = (p: { ref: string; branchId: string }): string => renderRev({ ref: p.ref, branchId: p.branchId }).slice(REV_PREFIX.length);
const revOf = (body: string): Rev | null => findRev(REV_PREFIX + body)?.rev ?? null;
/** Core's `StateUnknown` (code STATE_UNKNOWN), or the materializer's own "no exact base" refusals. */
/**
 * The changes a save could have repeated end at its commit's seq (inclusive: a commit that made no change, a save equal
 * to what was already confirmed, returns the seq it found); its own change is skipped by id. Pending: no bound.
 */
const upTo = (res: SaveResult): number | undefined => (res.seq === undefined ? undefined : res.seq + 1);
/** Whether a view save of print generation `gen` shows in the sidecar: no save of a later print does (round 18 #2). */
const shows = (row: ViewRow, gen: number): boolean => row.savedGen === undefined || gen >= row.savedGen;
const isStateUnknown = (e: unknown): boolean => (e as { code?: string })?.code === "STATE_UNKNOWN" || /state unknown/i.test((e as Error)?.message ?? "");

export class Materializer {
  readonly bundle: string;
  private readonly engine: MaterializerEngine;
  private readonly host: MaterializerHost;
  private readonly codec: TimelineCodec;
  private readonly clock: Clock;
  private readonly opts: Required<Omit<MaterializerOptions, "bundle" | "engine" | "host" | "codec" | "clock" | "onCards" | "keepPrints" | "group">>;
  private readonly onCards: ((c: SaveCards) => void) | null;
  /** How long the shared file's superseded prints stay pinned (`keepPrints`). */
  private readonly keepPrints: PinKeep;
  private readonly group: string | null;
  private readonly held: DisplacedFiles;
  private readonly tmpDir: string;
  private readonly noLinks: boolean;
  private readonly busy: BusyOptions;
  private queue: Promise<unknown> = Promise.resolve();
  private tmpSeq = 0;
  private readonly tmpTag = randomBytes(4).toString("hex");
  /** project.json's envelope for its stamp; `hash` null when the host gave it (`HostWrite`) and the file wasn't read. */
  private envelopeCache: { stamp: string; env: Record<string, unknown> | null; hash: string | null } | null = null;
  private readonly state = new Map<string, PathState>();
  private readonly lastInstall = new Map<string, OwnInstall & { hash: string }>();
  /** Displaced foreign files that don't parse (yet): re-read when their stamp changes. */
  private readonly partials = new Map<string, { rel: string; stamp: string | null; mtimeNs: bigint; viewGen?: number }>();
  /** Half-written displaced files already reported to their writer. */
  private readonly reportedPartials = new Set<string>();
  /** Displaced files kept because their save was refused (state unknown, never printed, rejected). */
  private readonly keptFiles = new Set<string>();
  /** Writes hooked agents announced, per path, oldest first (see `hookWrite`). */
  private readonly announced = new Map<string, { actor: Actor; at: number }[]>();
  /** Where each held displaced file came from. */
  private readonly origin = new Map<string, Origin>();
  private readonly quietTimers = new Map<string, unknown>();
  /** The head (`headRef`) the files were last brought up to, or were scheduled to be (B11). */
  private knownHead: string | null = null;
  /** Whether the files show `knownHead` (false while a failed rewrite waits for its retry). */
  private headShown = true;
  private readonly writeRetryTimers = new Map<"shared" | "project", unknown>();
  /** Paths whose save is being applied right now (its finishing steps read the path again: R7-01). */
  private readonly applying = new Set<string>();
  private readonly retryTimers = new Map<string, unknown>();
  private reviewTimer: unknown = null;
  private watchers: fs.FSWatcher[] = [];
  private closed = false;

  // freeze (§6.4): the shared file isn't rewritten for non-agent changes while a local agent is active. `baseSeq` is
  // the confirmed seq the freeze view was derived from and `causal` the agent saves merged into it since: its pin
  // carries both, so a save from it meets every other change since, and never those saves a second time.
  // `saves`: saves applied in a freeze whose commit is still pending on a shared cut, by change id: they show on top of
  // the view (`withPending`) and join it once confirmed (`foldAgentChanges`), so a rebase that changes one shows; one
  // no longer pending on the freeze's cut (confirmed, withdrawn, another cut's) is let go at the next print
  // `callers`: windowless `cb` callers whose call holds the freeze (`onCb(actor)`: a terminal's cb, which nothing tells
  // apart from a windowless agent): their own changes join the view as a local agent's do (read-your-writes, apply-ryw)
  readonly freeze = { hooked: new Map<string, Actor>(), heard: new Map<string, number>(), callers: new Map<string, Actor>(), lastForeign: -Infinity, lastCb: -Infinity, active: false, view: null as Doc | null, baseSeq: 0, causal: [] as string[], cut: null as string | null, timer: null as unknown, scanned: 0, pending: "", saves: new Map<string, FrozenSave>() };
  /**
   * What the installed timeline.tsx print holds (read-your-writes, `showChange`): the cut it shows, the confirmed seq it
   * was made from, the changes past that seq it holds (a freeze view's causal past and the pending changes shown on it,
   * or head's pending changes), and the hash of the print's bytes: a write is shown only while the file on disk has
   * exactly those bytes (review #1: a stamp taken after the install could name a foreign file that replaced the print
   * in between). Null until this materializer prints or checks it.
   */
  private printed: { cut: string | undefined; seq: number; ids: ReadonlySet<string>; hash: string } | null = null;
  /** Writes waiting to show in timeline.tsx (`showChange`). */
  private readonly showing = new Set<{ c: ShowTarget; done: (s: Showing) => void }>();
  /** The cause the coalesced local rewrite (`localTimer`) was armed for. */
  private localCause: "local" | "gui" | "remote" = "local";
  /** The shared file's current ref, as core resolves it (`<cut>@<seq>~<hash8> b:<branch8>`). */
  private sharedRef: string | null = null;
  /** The cut `sharedRef` was pinned on. */
  private sharedCut: string | undefined = undefined;
  /** The project.json the shared file was printed from (`projectSource`'s key). */
  private sharedEnv: string | null = null;
  /** The header of the print installed last (an unchanged print is told by printing it again with it). */
  private sharedHeader: string | null = null;
  /** The pin of the print the shared file shows (held through the prune). */
  private shownPin: PinHold | null = null;
  /**
   * The shared file was printed while a host write was landing, or such a write landed after the wait for it ended:
   * the print may be from project.json before it. The next rewrite timer checks it, frozen or not.
   */
  private printedLanding = false;
  /** Host writes landed so far (a print made while one landed is checked: `printedLanding`). */
  private landedWrites = 0;
  private lastRemoteRewrite = -Infinity;
  private remoteTimer: unknown = null;
  private localTimer: unknown = null;
  private projectTimer: unknown = null;
  private projectPin: string | null = null;

  /** What happened, for tests and the activity log (never file contents). */
  readonly log = { eexist: 0, errors: [] as Record_[], kept: [] as Record_[], applied: [] as Record_[], displaced: [] as Record_[], unparsed: [] as Record_[], imported: [] as Record_[], rewrites: [] as Record_[], ignored: [] as Record_[], recovered: [] as Record_[], refused: [] as Record_[], cards: [] as SaveCards[] };

  constructor(o: MaterializerOptions) {
    this.bundle = path.resolve(o.bundle);
    this.engine = o.engine;
    this.host = o.host;
    this.codec = o.codec;
    this.clock = o.clock ?? realClock;
    this.onCards = o.onCards ?? null;
    this.keepPrints = { count: o.keepPrints?.count ?? 256, ms: o.keepPrints?.ms ?? DAY };
    this.group = o.group ?? null;
    this.opts = {
      printedBy: o.printedBy ?? "carton",
      quietMs: o.quietMs ?? 150,
      localRewriteMs: o.localRewriteMs ?? 20,
      remoteRewriteMs: o.remoteRewriteMs ?? 30_000,
      freezeIdleMs: o.freezeIdleMs ?? 60_000,
      attributeMs: o.attributeMs ?? 30_000,
      writeProject: o.writeProject ?? true,
      displacedDir: path.resolve(o.bundle, o.displacedDir ?? path.join(CARTON_DIR, "displaced")),
      foldCase: o.foldCase ?? (process.platform === "win32" || process.platform === "darwin"),
      busyBudgetMs: o.busyBudgetMs ?? BUSY_BUDGET_MS,
    };
    this.busy = { counter: {}, budgetMs: this.opts.busyBudgetMs };
    const carton = path.join(this.bundle, CARTON_DIR);
    this.tmpDir = path.join(carton, "tmp");
    fs.mkdirSync(this.tmpDir, { recursive: true });
    fs.mkdirSync(path.join(this.bundle, VIEWS_DIR), { recursive: true });
    this.held = new DisplacedFiles(this.opts.displacedDir, { now: () => this.clock.now(), quietMs: this.opts.quietMs, holdMs: this.opts.quietMs, ...this.busy });
    this.noLinks = !hardLinksWork(this.bundle);
  }

  // ------------------------------------------------------------------ lifecycle

  /**
   * Finishes what an earlier process left in `.carton/displaced`, imports saves made while nobody watched (per-agent
   * views too: their agents wait on the sidecar), then writes project.json and the shared file from head.
   */
  start(): Promise<void> {
    return this.run(async () => {
      this.knownHead = await this.headKey(); // before the writes, which show this head or a newer one
      this.headShown = true;
      await this.recoverDisplaced();
      await this.reviewDisplaced();
      await this.importUnseenViews();
      if (this.opts.writeProject) await this.writeProjectNow("start");
      await this.writeSharedNow("start");
    });
  }

  /**
   * Marks what is on disk now as current without applying it: after importing an existing project as `main@1` (§16),
   * its project.json and timeline.tsx are that state, not foreign saves.
   */
  adoptCurrentFiles(): Promise<void> {
    return this.run(async () => {
      for (const rel of this.opts.writeProject ? [PROJECT_FILE, TIMELINE_FILE] : [TIMELINE_FILE]) {
        const f = await this.readFile(rel);
        if (!f) continue;
        // that file's content is in the engine already: once an install moves it aside, it is a copy, not a save
        const ps = await this.pathState(rel);
        ps.last = f.hash;
        push(ps.applied, f.stamp, KEEP_STAMPS);
        await this.saveState(rel);
      }
    });
  }

  /** Watches the bundle and the views folder with fs.watch; every event reads the file it names. */
  watch(): void {
    const on = (dir: string, prefix: string) => {
      const w = fs.watch(dir, { persistent: false }, (_ev, name) => {
        if (name) this.onFsEvent(prefix + String(name).replace(/\\/g, "/"));
      });
      w.on("error", () => undefined); // a removed folder: the next start re-creates it
      this.watchers.push(w);
    };
    on(this.bundle, "");
    on(path.join(this.bundle, VIEWS_DIR), `${VIEWS_DIR}/`);
  }

  /**
   * Stops watching, applies the displaced saves that are ready, and stops the timers. Files still in their hold stay in
   * `.carton/displaced` for the next start to finish.
   */
  async close(): Promise<void> {
    if (this.closed) return this.queue.then(() => undefined);
    for (const w of this.watchers) w.close();
    this.watchers = [];
    await this.run(() => this.reviewDisplaced()).catch(() => undefined);
    this.closed = true;
    for (const t of [this.reviewTimer, this.remoteTimer, this.localTimer, this.projectTimer, ...this.writeRetryTimers.values(), this.freeze.timer, ...this.quietTimers.values(), ...this.retryTimers.values()]) if (t) this.clock.clearTimeout(t);
    for (const w of [...this.showing]) w.done("later");
    await this.queue;
  }

  /** What is held right now (displaced files under review, their origins, half-written and refused files). */
  stats(): { held: number; origins: number; partials: number; kept: number } {
    return { held: this.held.size, origins: this.origin.size, partials: this.partials.size, kept: this.keptFiles.size };
  }

  /** Resolves when every task queued so far has finished. */
  idle(): Promise<void> {
    return this.queue.then(() => undefined);
  }

  private run<T>(task: () => Promise<T>): Promise<T> {
    const p = this.queue.then(task, task);
    this.queue = p.catch(() => undefined);
    return p;
  }
  /** A background task (a timer, a watch event): its failure is logged, never an unhandled rejection. */
  private fire(task: () => Promise<unknown>): void {
    this.run(task).catch((e: unknown) => {
      this.log.errors.push({ t: this.clock.now(), path: "", error: e instanceof Error ? e.message : String(e) });
    });
  }

  private abs(rel: string): string {
    return path.join(this.bundle, ...rel.split("/"));
  }

  // ------------------------------------------------------------------ hooks and head changes

  /** A hooked agent read the shared file (PreToolUse; `@carton/local` sends a hooked agent's `cb` call so too): the freeze starts. */
  hookRead(actor: Actor): Promise<void> {
    return this.run(async () => {
      this.hold(actor);
      await this.updateFreeze();
    });
  }
  /** `actor` holds the freeze until its Stop, or until it has been quiet for `freezeIdleMs`. */
  private hold(actor: Actor): void {
    this.freeze.hooked.set(actor.id, actor);
    this.freeze.heard.set(actor.id, this.clock.now());
  }
  /** Any hook event or call from a hooked actor: it is still there, its hold runs on (a quiet one's ends). */
  private async heardFrom(actor: Actor): Promise<void> {
    if (!this.freeze.hooked.has(actor.id)) return;
    this.freeze.heard.set(actor.id, this.clock.now());
    await this.updateFreeze();
  }
  private unhold(id: string): boolean {
    this.freeze.heard.delete(id);
    return this.freeze.hooked.delete(id);
  }
  /**
   * A hooked agent stopped (Stop/SubagentStop): its pins go, and the freeze may end. A subagent releases only what it
   * pinned (its parent's turn runs on: the Director's view and freeze stay). The turn's own Stop releases everything the
   * turn's actors pinned or hooked, its subagents' too: a SubagentStop can be lost (the late-conflict hook holds it).
   */
  hookStop(actor: Actor): Promise<void> {
    return this.run(async () => {
      let left = false;
      if (isSubagent(actor)) {
        await this.engine.release(turnOwner(actor));
        left = this.unhold(actor.id);
      } else {
        const turn = turnOf(actor);
        const subs = (await this.engine.getMeta<string[]>(turnPinsKey(turn))) ?? [];
        for (const owner of [turnOwner(actor), ...subs]) await this.engine.release(owner);
        if (subs.length) await this.engine.putMeta(turnPinsKey(turn), undefined);
        for (const [id, a] of this.freeze.hooked) if (id === actor.id || turnOf(a) === turn) left = this.unhold(id) || left;
      }
      if (left) await this.updateFreeze();
    });
  }
  /** The turn's own Stop releases `pinOwner` too (see `hookStop`). */
  private async noteSubagentPins(owner: Actor, pinOwner: string): Promise<void> {
    const key = turnPinsKey(turnOf(owner));
    const subs = (await this.engine.getMeta<string[]>(key)) ?? [];
    if (!subs.includes(pinOwner)) await this.engine.putMeta(key, [...subs, pinOwner]);
  }
  /**
   * A hooked agent is about to write a watched file (PreToolUse on Write/Edit/MultiEdit). Files carry no writer, so the
   * next foreign save of `rel` within `attributeMs` is credited to this actor, down to the subagent (Credits); saves no
   * hook announced stay `external:<file>`. Per-agent views are credited to their owner without this.
   */
  hookWrite(actor: Actor, rel: string): Promise<void> {
    return this.run(async () => {
      const canon = this.watched(rel);
      if (canon !== TIMELINE_FILE) await this.heardFrom(actor);
      if (canon === null) return; // no save of it is ever attributed: an entry would stay forever
      const list = this.announced.get(canon) ?? [];
      list.push({ actor, at: this.clock.now() });
      this.announced.set(canon, list);
      if (canon === TIMELINE_FILE) {
        this.hold(actor); // a hooked agent writing the shared file is active, as when it reads
        await this.updateFreeze();
      }
    });
  }

  /**
   * The current cut changed (`cb cut switch`; `@carton/local`'s `ViewPrinter.onCutSwitch`): the files show the new cut
   * from now on. A freeze restarts from the new cut's head, and project.json and the shared file are rewritten at once
   * (B6). `cut` is for the caller's log; the engine says which cut is current.
   */
  onCutSwitch(_cut?: string): Promise<void> {
    return this.run(async () => {
      this.knownHead = await this.headKey();
      this.headShown = true;
      await this.cutSwitchNow();
    });
  }
  private async cutSwitchNow(): Promise<void> {
    await this.freezeOnCurrentCut(true);
    this.projectPin = null; // project.json's pin was on the old cut
    if (this.opts.writeProject) await this.writeProjectNow("cut");
    await this.writeSharedNow("cut", true);
  }

  /**
   * carton.db may have moved under this materializer (B11): a `cb` write committed in its own process or by a helper
   * that took the lease over, or a cut another process switched. Call it whenever the store may have changed (local's
   * data_version poll, a nudge, the worker after its own commits); it is idempotent and cheap: one head read, and
   * nothing else when the head is the one already seen. A moved head is handled as a local change (files follow,
   * under the install lock as every install), a switched cut as `onCutSwitch`.
   */
  onExternalHeadChange(): Promise<"unchanged" | "head" | "cut"> {
    return this.run(async () => {
      const key = await this.headKey();
      if (key !== null && key === this.knownHead && this.headShown) return "unchanged";
      const was = this.knownHead;
      this.knownHead = key; // read before the rewrite, which shows this head or a newer one
      this.headShown = true;
      if (key !== null && was !== null && cutOfKey(key) !== cutOfKey(was)) {
        await this.cutSwitchNow();
        return "cut";
      }
      this.onHeadChange("local");
      return "head";
    });
  }
  private async headKey(): Promise<string | null> {
    return this.engine.headRef ? await this.engine.headRef() : null;
  }

  /**
   * The freeze view and its seq belong to the cut the freeze started on; on another cut that seq is another state or
   * none. Once the cut has moved (told, or found here), the freeze restarts from the current cut's head.
   */
  private async freezeOnCurrentCut(moved = false, pinned?: HeldBase): Promise<void> {
    const cut = this.engine.cut?.() ?? null;
    if (!this.freeze.active || (!moved && cut === this.freeze.cut)) return;
    this.restartFreeze(await this.currentHead(pinned));
  }
  /** The freeze view restarts from `h`; it belongs to the cut `h` was pinned on (review 11 #1). */
  private restartFreeze(h: HeldBase): void {
    this.freeze.view = h.baseDoc;
    this.freeze.baseSeq = h.baseSeq;
    this.freeze.scanned = h.baseSeq;
    this.freeze.causal = [...h.causal];
    this.freeze.cut = h.cut ?? this.engine.cut?.() ?? null;
  }
  /**
   * Whether a save repeated an edit of a change its base doesn't hold: a confirmed change on `cut` after `seq`, outside
   * `causal`, up to the save's own commit (`until`, exclusive), with an edit the save also made from its base (an agent saving the
   * ripple a remote made, alone or with edits of its own). No causal past describes such a save's content exactly: it
   * may hold all of such a change, part of it, or the net of several (a ripple made in two steps, undone and redone), and
   * naming too few changes maps later saves through one again, too many skips a remap or a card (rounds 13-15). So a
   * state built on such a save is the commit's own state instead (`commitState`), which core describes exactly. Past
   * HIDDEN_SCAN changes, or when they can't be read, the answer is yes: the exact path is always safe.
   */
  private async repeatsHidden(base: Doc, saved: Doc, seq: number, causal: readonly string[], cut: string | undefined, until: number | undefined): Promise<boolean> {
    if (!this.engine.changesSince || !this.host.changes) return false;
    const own = new Set(this.host.changes(base, saved));
    if (!own.size) return false;
    let n = 0;
    try {
      for await (const c of this.engine.changesSince(seq, { ...(cut !== undefined ? { cut } : {}), ...(until !== undefined ? { until } : {}), skip: new Set(causal) })) {
        if (++n > HIDDEN_SCAN) return true;
        if (this.host.changes(c.before, c.after).some((e) => own.has(e))) return true;
      }
    } catch (e) {
      this.log.errors.push({ t: this.clock.now(), path: TIMELINE_FILE, error: `reading the changes a save didn't see (taken as repeated): ${e instanceof Error ? e.message : String(e)}` });
      return true;
    }
    return false;
  }
  /**
   * The state a commit made, pinned for `owner` on the cut the commit went to (not the current one: another process may
   * have switched since, round 15 #4); for a commit still pending (a shared cut offline), the optimistic head.
   */
  private async commitState(res: SaveResult, owner: string): Promise<Pinned> {
    return this.engine.pin({ owner, ttlMs: 7 * DAY, ...(res.seq !== undefined ? { seq: res.seq } : {}), ...(res.cut !== undefined ? { cut: res.cut } : {}) });
  }
  /** Whether `h` was pinned on the current cut (or the engine has no cuts). */
  private onCurrentCut(h: HeldBase): boolean {
    return h.cut === undefined || h.cut === this.engine.cut?.();
  }
  /**
   * Head pinned for the shared file on the cut that is current once pinned (`pinned`, if it is): a pin refreshes from
   * the store and can find a cut another process switched to, so the head it returns is the old cut's (review 11 #1).
   * Re-pinned a few times; a pin still behind is labelled with its own cut, so the next check restarts the freeze.
   */
  private async currentHead(pinned?: HeldBase): Promise<HeldBase> {
    let h = pinned ?? (await this.pinnedHead("shared-file"));
    for (let i = 0; i < 3 && !this.onCurrentCut(h); i++) h = await this.pinnedHead("shared-file");
    return h;
  }

  /**
   * Any `cb` call: windowless agents count as active for a while after it. `caller`: who made the call, when it is a
   * windowless caller nothing else names as an agent (a terminal's `cb`, `@carton/local`'s fallback actor): its own
   * changes show in the frozen file as a local agent's do, so the caller reads what it just wrote (apply-ryw). Before,
   * its call froze the file against its own write for a minute.
   */
  onCb(caller?: Actor | null): Promise<void> {
    return this.run(async () => {
      this.freeze.lastCb = this.clock.now();
      if (caller?.id) this.freeze.callers.set(caller.id, caller);
      await this.updateFreeze();
    });
  }

  /**
   * Head moved. `local` and `gui`: rewrite promptly (coalesced). `remote`: at most every 30 s while shared. While a
   * freeze is active, only local agents' changes reach the shared file, promptly, whatever told of them (a `cb` commit
   * here or in another local process, or on a shared cut its confirmation): `foldAgentChanges`; nothing for non-agent
   * changes. project.json follows head promptly either way.
   *
   * `after`: the change is the host's own and it is still writing for it (the app's GUI save: the commit's change event
   * fires inside the save, before its project.json is written). The rewrites wait for it: they are scheduled once it
   * settles (at most LAND_WAIT_MS), and a rewrite due meanwhile for another change waits too, so none runs in the middle
   * of the host's write. What it resolves to (`HostWrite`) spares a read of what the host just wrote.
   */
  onHeadChange(cause: "local" | "gui" | "remote", o: { after?: PromiseLike<HostWrite | void | undefined> } = {}): void {
    if (this.closed) return;
    if (o.after) return this.afterLanding(cause, o.after);
    this.scheduleProjectWrite(cause);
    if (cause === "remote" && this.engine.shared() && !this.freeze.active) {
      if (this.remoteTimer) return;
      const at = Math.max(this.clock.now(), this.lastRemoteRewrite + this.opts.remoteRewriteMs);
      this.remoteTimer = this.clock.setTimeout(() => {
        this.remoteTimer = null;
        if (this.landing.size) return; // the host's write still landing: its own call rewrites once it has
        this.fire(() => this.orRetry("shared", async () => {
          if (!this.freeze.active) await this.writeSharedNow("remote");
        }));
      }, at - this.clock.now());
      return;
    }
    if (this.localTimer) return;
    this.localCause = cause;
    this.localTimer = this.clock.setTimeout(() => {
      this.localTimer = null;
      if (this.landing.size) return;
      this.fire(() => this.orRetry("shared", () => this.localRewrite(cause)));
    }, this.opts.localRewriteMs);
  }
  /** The coalesced local rewrite of the shared file (`onHeadChange`'s timer, or `showChange` at once). */
  private async localRewrite(cause: "local" | "gui" | "remote"): Promise<void> {
    // a print made while a host write landed: checked against what it wrote (`writeSharedNow` prints again only if the
    // print would show something new), also in a freeze, where nothing else would rewrite the file
    const landed = this.printedLanding;
    this.printedLanding = false;
    if (!this.freeze.active) await this.writeSharedNow(cause);
    // during a freeze: local agents' confirmed changes, and on a shared cut their pending ones (`withPending`)
    else if ((await this.foldAgentChanges()) || (await this.pendingMoved()) || landed) await this.writeSharedNow("cb");
  }

  /**
   * Read-your-writes (apply-ryw): resolves once the shared timeline.tsx shows the write `c`, or says why it doesn't, at
   * most `ms` later. A `cb` write calls it (through the lease holder) before it answers, so an agent that reads
   * timeline.tsx right after its `cb source apply` reads its own change. On the laptop it read the file before this
   * materializer had even heard of the change (another process's commit is found by a poll of carton.db, then
   * rewritten 20 ms later), and took the old value for a freeze of the turn's start.
   * - `shown`: the installed print holds the change: its confirmed seq is at or below the print's, or the print holds
   *   it past that seq (a freeze view's causal past, a shared cut's pending change).
   * - `held`: the file is frozen for someone else's work, and the freeze holds this change back (it isn't a local
   *   agent's, a windowless `cb` caller's or a save's): it shows when that work ends.
   * - `elsewhere`: the change is on another cut than the current one, which the file shows.
   * - `later`: none of these within `ms` (a host write still landing, a rewrite that failed and is retried).
   * No polling: a rewrite waiting on its coalescing timer is made at once, and every print that lands (or is found
   * unchanged) tells the waiting writes (`wakeShowing`).
   */
  showChange(c: ShowTarget, ms: number): Promise<Showing> {
    if (this.closed) return Promise.resolve("later");
    return new Promise<Showing>((resolve) => {
      let timer: unknown = null;
      const w = {
        c,
        done: (s: Showing) => {
          if (!this.showing.delete(w)) return;
          if (timer !== null) this.clock.clearTimeout(timer);
          resolve(s);
        },
      };
      this.showing.add(w);
      timer = this.clock.setTimeout(() => w.done("later"), Math.max(0, ms));
      // the head this write moved, if nobody has told this materializer yet (B11: its holder's follower normally has)
      this.onExternalHeadChange()
        .catch(() => undefined)
        .then(() => this.run(async () => {
          if (!this.showing.has(w)) return;
          if (await this.holdsChange(c)) return w.done("shown");
          const cut = this.engine.cut?.();
          if (c.cut !== undefined && cut !== undefined && c.cut !== cut) return w.done("elsewhere");
          // the rewrite this write is waiting for, coalescing on its timer: made now (a host write landing goes first)
          if (this.localTimer && !this.landing.size) {
            this.clock.clearTimeout(this.localTimer);
            this.localTimer = null;
            await this.orRetry("shared", () => this.localRewrite(this.localCause)).catch((e: unknown) => {
              this.log.errors.push({ t: this.clock.now(), path: TIMELINE_FILE, error: e instanceof Error ? e.message : String(e) });
            });
            if (!this.showing.has(w)) return; // the print told it (`wakeShowing`)
            if (await this.holdsChange(c)) return w.done("shown");
          }
          if (this.holdsBack(c)) w.done("held");
        }))
        .catch(() => undefined);
    });
  }
  /** Whether the installed print holds `c` (see `showChange`). */
  private async holdsChange(c: ShowTarget): Promise<boolean> {
    const p = this.printed;
    if (!p) return false;
    // the file on disk is that print, byte for byte (a foreign save since is imported, and the file printed again); one
    // that can't be read shows nothing
    let bytes: Buffer;
    try {
      bytes = await retryBusy(() => fs.readFileSync(this.abs(TIMELINE_FILE)), this.busy);
    } catch {
      return false;
    }
    if (sha(bytes) !== p.hash) return false;
    if (p.ids.has(c.id)) return true;
    const at = c.seq !== undefined && c.cut !== undefined ? { cut: c.cut, seq: c.seq } : ((await this.engine.changeAt?.(c.id).catch(() => null)) ?? (c.seq !== undefined ? { cut: c.cut, seq: c.seq } : null));
    return !!at && at.seq <= p.seq && (at.cut === undefined || p.cut === undefined || at.cut === p.cut);
  }
  /** The freeze holds `c` back: a change the frozen file doesn't take in (see `foldAgentChanges`). */
  private holdsBack(c: ShowTarget): boolean {
    if (!this.freeze.active || !this.freeze.view) return false;
    return !this.localAgent(c.author) && !this.freeze.saves.has(c.id);
  }
  /** A print landed (or was found unchanged): the writes it shows are told. */
  private async wakeShowing(): Promise<void> {
    for (const w of [...this.showing]) if (await this.holdsChange(w.c)) w.done("shown");
  }

  /** Host writes told with a head change (`onHeadChange`'s `after`) that haven't landed yet. */
  private readonly landing = new Set<object>();
  private afterLanding(cause: "local" | "gui" | "remote", after: PromiseLike<HostWrite | void | undefined>): void {
    const id = {};
    this.landing.add(id);
    let late = false;
    let settled = false;
    // waited long enough: the rewrites go on, from project.json as it is; the host's completion still counts when it comes
    const cap = this.clock.setTimeout(() => {
      late = true;
      this.landing.delete(id);
      this.onHeadChange(cause);
    }, LAND_WAIT_MS);
    const landed = (w?: HostWrite | void) => {
      if (settled) return;
      settled = true;
      this.landedWrites++;
      if (late) this.printedLanding = true; // printed meanwhile from project.json before this write (with no watcher on it)
      else {
        this.landing.delete(id);
        this.clock.clearTimeout(cap);
      }
      // what the host wrote, taken while the file still has that stamp
      if (w?.project) this.envelopeCache = { stamp: w.project.stamp, env: w.project.envelope, hash: null };
      this.onHeadChange(cause);
    };
    Promise.resolve(after).then(landed, () => landed()).catch((e: unknown) => this.log.errors.push({ t: this.clock.now(), path: TIMELINE_FILE, error: `after a host write: ${e instanceof Error ? e.message : String(e)}` }));
  }

  /**
   * During a freeze, local agents' own `cb` changes join the freeze view as their file saves do (R8-01, windows-sync
   * H8): an agent reads its own `cb` edit in the frozen timeline.tsx at once, as in 1.4.0, while the person's and remote
   * changes stay out until the freeze ends. Each confirmed change on the freeze's cut not read yet (a change pending on
   * a shared cut joins once confirmed), made by an agent or a
   * subagent, is merged into the view with the state just before it as its base, oldest first. On a shared cut only an
   * agent of this machine counts: one hooked here, or one in this machine's group (`group`: a windowless local agent);
   * an agent of a remote teammate is a remote change. This replica's agents' changes still pending there show on top of
   * the view at each print (`withPending`). The view then holds exactly that change (its id joins the view's causal past) only
   * if the merge gained exactly its edits; a change that overwrote or built on a change still hidden (the person's edit
   * of the same clip) doesn't merge so: the freeze restarts at that change's own state, which shows what was confirmed
   * up to it, as for a save (rounds 13-15), and what the view held past that state (saves applied in this freeze, `cb`
   * changes folded earlier) is folded in again on top, oldest first (round 23 #1). Returns whether the view changed.
   */
  private async foldAgentChanges(): Promise<boolean> {
    if (!this.freeze.view || !this.engine.changesSince) return false;
    const cut = this.freeze.cut ?? undefined;
    const found: { id: string; seq: number; before: Doc; after: Doc; author?: Actor | null }[] = [];
    let top = this.freeze.scanned;
    for await (const c of this.engine.changesSince(this.freeze.scanned, { ...(cut !== undefined ? { cut } : {}), skip: new Set(this.freeze.causal) })) {
      top = Math.max(top, c.seq);
      if (this.localAgent(c.author) || this.freeze.saves.has(c.id)) found.push(c);
    }
    let changed = false;
    const queue = found.reverse();
    for (let i = 0; i < queue.length; i++) {
      const c = queue[i]!;
      const view = this.freeze.view!;
      const save = this.freeze.saves.get(c.id);
      this.freeze.saves.delete(c.id);
      if (save && save.key === this.editsKey(c)) {
        // a save applied in this freeze, confirmed with the edits it was applied with: joins the view as it showed
        this.freeze.view = this.host.merge3(save.base, view, save.saved);
        this.freeze.causal.push(c.id);
        changed = true;
        continue;
      }
      // (one rebased before its confirmation: as any agent change, by what was confirmed)
      const merged = this.host.merge3(c.before, view, c.after);
      if (this.host.changes && sameEdits(this.host.changes(view, merged), this.host.changes(c.before, c.after))) {
        this.freeze.view = merged;
        this.freeze.causal.push(c.id);
      } else {
        const held = new Set(this.freeze.causal);
        const p = await this.engine.pin({ owner: "shared-view", ttlMs: 7 * DAY, seq: c.seq, ...(cut !== undefined ? { cut } : {}) });
        this.restartFreeze({ baseDoc: p.doc, baseSeq: p.seq, causal: [], ...(p.cut !== undefined ? { cut: p.cut } : {}) });
        const again: typeof found = [];
        for await (const d of this.engine.changesSince(c.seq, cut !== undefined ? { cut } : {})) if (held.has(d.id)) again.push(d);
        queue.splice(i + 1, queue.length, ...[...queue.slice(i + 1), ...again].sort((a, b) => a.seq - b.seq));
      }
      changed = true;
    }
    this.freeze.scanned = Math.max(this.freeze.scanned, top);
    return changed;
  }
  /** Whether a change by `a` is a local agent's (see `foldAgentChanges`). */
  private localAgent(a: Actor | null | undefined): boolean {
    // an agent, or a windowless `cb` caller whose call holds the freeze (`onCb`): its own changes show (apply-ryw)
    if (!isAgent(a) && !(a?.id && this.freeze.callers.has(a.id))) return false;
    if (!this.engine.shared()) return true; // a cut only this replica writes: every agent on it is local
    // on a shared cut: an agent of this machine's group (windowless ones too, windows-sync round 2), or one hooked here
    if (this.group !== null && a!.group === this.group) return true;
    const h = this.freeze.hooked.get(a!.id);
    return !!h && (h.group ?? null) === (a!.group ?? null);
  }

  /** Runs a rewrite; if it fails, it is tried again (`retryWrite`) and the failure still reaches the caller's log. */
  private async orRetry(which: "shared" | "project", fn: () => Promise<void>): Promise<void> {
    try {
      await fn();
    } catch (e) {
      this.retryWrite(which);
      throw e;
    }
  }

  /**
   * A rewrite of the shared file or project.json failed (a locked database, a printer error): tried again with a
   * growing delay. Meanwhile the head it was for counts as not shown yet, so `onExternalHeadChange` acts on it again.
   */
  private retryWrite(which: "shared" | "project", attempt = 0): void {
    this.headShown = false; // the cut it was on is kept: a cut switched meanwhile is still told apart
    if (this.closed || this.writeRetryTimers.has(which) || attempt >= 12) return;
    this.writeRetryTimers.set(
      which,
      this.clock.setTimeout(() => {
        this.writeRetryTimers.delete(which);
        this.fire(async () => {
          try {
            if (which === "shared") {
              // a failed fold too: the agents' changes it missed are read again before the view is printed (round 23 #3)
              if (this.freeze.active) await this.foldAgentChanges();
              await this.writeSharedNow("retry");
            }
            else if (this.opts.writeProject) await this.writeProjectNow("retry");
          } catch (e) {
            this.log.errors.push({ t: this.clock.now(), path: which === "shared" ? TIMELINE_FILE : PROJECT_FILE, error: `rewrite retry: ${e instanceof Error ? e.message : String(e)}` });
            this.retryWrite(which, attempt + 1);
          }
        });
      }, Math.min(30_000, 250 * 2 ** attempt)),
    );
  }

  /** project.json follows head promptly (coalesced). */
  private scheduleProjectWrite(cause: string): void {
    if (this.closed || !this.opts.writeProject || this.projectTimer) return;
    this.projectTimer = this.clock.setTimeout(() => {
      this.projectTimer = null;
      if (this.landing.size) return; // the host's write still landing: its own call writes once it has
      this.fire(() => this.orRetry("project", () => this.writeProjectNow(cause)));
    }, this.opts.localRewriteMs);
  }

  /** When the freeze ends if nothing else happens: the latest of the windowless window and each hooked actor's. */
  private freezeEnd(): number {
    return Math.max(this.freeze.lastForeign, this.freeze.lastCb, ...this.freeze.heard.values()) + this.opts.freezeIdleMs;
  }
  private frozenNow(): boolean {
    return this.clock.now() < this.freezeEnd();
  }
  private async updateFreeze(): Promise<void> {
    // a hooked actor quiet for `freezeIdleMs` holds the freeze no longer: its Stop may never come (an interrupted
    // turn, a Stop sent while a helper held the lease); its next hook event holds it again
    for (const [id, at] of this.freeze.heard) if (this.clock.now() >= at + this.opts.freezeIdleMs) this.unhold(id);
    const f = this.frozenNow();
    if (f && !this.freeze.active) {
      // the freeze starts from what the shared file shows, and remembers the seq that state was derived from
      // (only if it shows the current cut: a cut switched without telling this materializer starts from its head)
      const cut = this.engine.cut?.();
      const shown = this.sharedRef && this.sharedCut === cut ? await this.resolveOrNull(this.sharedRef) : null;
      this.freeze.active = true;
      this.restartFreeze(shown ? { ...shown, ...(cut !== undefined ? { cut } : {}) } : await this.currentHead());
    } else if (!f && this.freeze.active) {
      this.freeze.active = false;
      this.freeze.view = null;
      this.freeze.callers.clear();
      // a host write still landing: its own call rewrites the file once it has (from head now)
      if (!this.landing.size) await this.writeSharedNow("freeze-end");
    }
    if (this.freeze.timer) this.clock.clearTimeout(this.freeze.timer);
    this.freeze.timer = null;
    if (this.freeze.active) {
      const end = this.freezeEnd();
      this.freeze.timer = this.clock.setTimeout(() => {
        this.freeze.timer = null;
        this.fire(() => this.updateFreeze());
      }, end - this.clock.now() + 1);
    }
  }
  private async resolveOrNull(body: string): Promise<HeldBase | null> {
    const rev = revOf(body);
    if (!rev) return null;
    try {
      return await this.engine.resolve(rev);
    } catch {
      return null;
    }
  }
  /** Head, pinned for `owner`, as a held state with its seq. */
  private async pinnedHead(owner: string): Promise<HeldBase> {
    const p = await this.engine.pin({ owner, ttlMs: 7 * DAY });
    return { baseDoc: p.doc, baseSeq: p.seq, causal: [], ...(p.cut !== undefined ? { cut: p.cut } : {}) };
  }

  // ------------------------------------------------------------------ Carton's writes

  /** `cb source print` with the app open: the shared file shows head; a freeze view restarts from it. */
  printShared(): Promise<string> {
    return this.run(async () => {
      if (this.freeze.active) this.restartFreeze(await this.currentHead());
      await this.writeSharedNow("print", true);
      return this.sharedRef!;
    });
  }

  /** A view's canonical name: the same file on a case-insensitive file system is the same view. */
  private canonView(name: string): string {
    return this.opts.foldCase ? name.toLowerCase() : name;
  }

  /**
   * `cb source print --view <name>`: pins head for its owner, prints the view with a new nonce (displacing an unapplied
   * save, which is applied first), and records the print. `ref` is the header's ref as core resolves it.
   */
  printView(name: string, owner: Actor, opts: { hooked?: boolean } = {}): Promise<{ name: string; path: string; ref: string }> {
    return this.run(async () => {
      if (!/^[A-Za-z0-9._-]+$/.test(name)) throw new Error(`invalid view name ${JSON.stringify(name)}`);
      const view = this.canonView(name);
      const rel = viewPath(view);
      await this.importUnseen(rel);
      if (opts.hooked) await this.heardFrom(owner); // a hooked agent's `cb` call
      const pinOwner = opts.hooked ? turnOwner(owner) : `view:${view}`;
      if (opts.hooked && isSubagent(owner)) await this.noteSubagentPins(owner, pinOwner);
      const prev = await this.engine.getMeta<ViewRow>(["view", view]);
      const p = await this.engine.pin({ owner: pinOwner, ttlMs: 7 * DAY });
      const nonce = printNonce();
      const header = renderRev({ ref: p.ref, branchId: p.branchId, nonce, by: this.opts.printedBy });
      const text = await this.codec.print(this.host.toProject(p.doc, await this.currentProject()), header.slice(REV_PREFIX.length));
      // the next generation is stored before the install (as a reprint's: round 20 #2)
      if (prev) await this.engine.putMeta(["view", view], { ...prev, printGen: (prev.printGen ?? 0) + 1 });
      await this.install(rel, text, prev?.printGen ?? 0);
      // a print starts a new generation: late updates for an earlier save never reach this print's sidecar
      const row: ViewRow = { owner, pinOwner, header, nonce, printedAt: this.clock.now(), printGen: (prev?.printGen ?? 0) + 1, last: null, lastChange: null };
      await this.engine.putMeta(["view", view], row);
      return { name: view, path: rel, ref: refBodyOf(p) };
    });
  }

  /**
   * A view whose save repeated an edit of a change its print didn't hold is printed again at the save's own commit (see
   * `repeatsHidden`), with a new nonce: its next save's base is that exact state. The same sidecar and latest change: a
   * late update for this save still reaches the sidecar. A new print generation: a save displaced by its install (written
   * on the replaced print) is older than any save on the reprint (round 19 #1). An agent's edit after it re-reads the file.
   * A later save written on the print it replaces (the agent's own buffer, or a save landing while this renders, which
   * the install displaces) is refused "state unknown: re-print": no base describes it. Its saved content holds part of a
   * change it never saw whole, so taking it as seen loses the rest without a card (round 17 #1), and taking the print's
   * state counts the agent's own saved edits again (round 16 #2). The replaced print is marked (`["reprinted", view,
   * nonce]`, one row each, never dropped) before the reprint, in the save's view block: a reprint that fails leaves it
   * marked (round 18 #3, #4).
   */
  private async reprintView(view: string, row: ViewRow, res: SaveResult): Promise<void> {
    const p = await this.commitState(res, row.pinOwner);
    const nonce = printNonce();
    const header = renderRev({ ref: p.ref, branchId: p.branchId, nonce, by: this.opts.printedBy });
    const text = await this.codec.print(this.host.toProject(p.doc, await this.currentProject()), header.slice(REV_PREFIX.length));
    const gen = row.printGen ?? 0;
    // the next generation is stored before the install: a save on the installed print is never as old as the saves it
    // displaced, even if storing the print's row below fails (round 20 #2)
    await this.engine.putMeta(["view", view], { ...row, printGen: gen + 1 });
    await this.install(viewPath(view), text, gen);
    Object.assign(row, { header, nonce, last: null, printGen: gen + 1 });
    await this.engine.putMeta(["view", view], row);
  }

  private async writeSharedNow(cause: string, force = false): Promise<void> {
    // the path is read once: what the import found there (current, not parsing yet, or nothing) is what the "unchanged"
    // check below compares, and a write landing in between is read at its own event; after an import it is read again
    const seen = await this.importUnseen(TIMELINE_FILE);
    await this.freezeOnCurrentCut();
    // the freeze view only on the cut it belongs to (if the cut moved since, head until the next check restarts it)
    const frozen = this.freeze.active && !!this.freeze.view && this.freeze.cut === (this.engine.cut?.() ?? null);
    const shown = frozen ? await this.withPending() : null;
    // superseded prints are released past `keepPrints` (R7-01's bound); the pin's record goes with the next meta write
    // (the path's token before the install, or its state after it) instead of one write of its own
    // the print the file shows is never released, whatever was pinned since (a print that failed, a restart point),
    // whoever printed it (another process, this one before a restart): told when the prune runs (`shownPrints`)
    const keep: PinKeep = { ...this.keepPrints, hold: () => this.shownPrints() };
    const pinned = shown
      ? await this.engine.pin({ owner: "shared-view", doc: shown.doc, seq: this.freeze.baseSeq, causal: [...this.freeze.causal, ...shown.ids], ttlMs: 7 * DAY, keep, deferRecord: true })
      : await this.engine.pin({ owner: "shared-file", ttlMs: 7 * DAY, keep, deferRecord: true });
    const carry = { rows: pinned.record ? [pinned.record] : [] };
    // what the file shows once this print is there (read-your-writes, `showChange`): told to the writes waiting for it
    const holds = { cut: pinned.cut, seq: pinned.seq, ids: new Set(shown ? [...this.freeze.causal, ...shown.ids] : (pinned.pending ?? [])) };
    const showed = async (hash: string): Promise<void> => {
      this.printed = { ...holds, hash };
      if (this.showing.size) await this.wakeShowing();
    };
    let landedBefore: number | null = null;
    try {
      if (shown) this.freeze.pending = shown.key;
      if (cause === "remote") this.lastRemoteRewrite = this.clock.now();
      const body = refBodyOf(pinned);
      const cur = seen === undefined ? await this.readFile(TIMELINE_FILE) : seen;
      // unchanged: the file is Carton's print of this state, made from the same project.json (a print made from an
      // older one, while the host was still writing its save, is made again)
      // a host write landed while this print (or the check that it is unchanged) is made, or still landing once it is
      // installed or found unchanged: it may be from project.json before that write (one whose wait ended earlier is
      // checked when it lands)
      landedBefore = this.landedWrites;
      const src = await this.projectSource();
      const same = !force && !!cur && cur.hash === this.lastInstall.get(TIMELINE_FILE)?.hash && this.sharedRef === body;
      if (same && this.sharedEnv === src.key) return await showed(cur!.hash);
      const project = (src.env?.project as Project | undefined) ?? null;
      if (same && this.sharedHeader) {
        // only project.json changed since (written again for fields the print doesn't show, `lastOpenedAt`): printed
        // again only if the print would show something new, as the same bytes tell. A new print's nonce makes an agent
        // read the file again before its next Edit
        const again = await this.codec.print(this.host.toProject(pinned.doc, project), this.sharedHeader.slice(REV_PREFIX.length));
        if (sha(Buffer.from(again, "utf8")) === cur!.hash) {
          this.sharedEnv = src.key;
          return await showed(cur!.hash);
        }
      }
      const header = renderRev({ ref: pinned.ref, branchId: pinned.branchId, nonce: printNonce(), by: this.opts.printedBy });
      const text = await this.codec.print(this.host.toProject(pinned.doc, project), header.slice(REV_PREFIX.length));
      await this.install(TIMELINE_FILE, text, undefined, carry);
      this.sharedRef = body; // only once installed: a failed rewrite must not read as done
      this.sharedCut = pinned.cut;
      this.sharedEnv = src.key;
      this.sharedHeader = header;
      this.shownPin = { branchId: pinned.branchId, ref: pinned.ref };
      this.log.rewrites.push({ t: this.clock.now(), path: TIMELINE_FILE, cause, ref: body, frozen: this.freeze.active });
      await showed(sha(Buffer.from(text, "utf8")));
    } finally {
      if (landedBefore !== null && (this.landedWrites !== landedBefore || this.landing.size)) this.printedLanding = true;
      // not stored with another write (unchanged, or a failure before it): on its own, so the pin can be released early
      if (carry.rows.length) await this.writeMeta(carry.rows).catch((e) => void this.log.errors.push({ t: this.clock.now(), path: TIMELINE_FILE, error: `the shared file's pin record: ${e instanceof Error ? e.message : String(e)}` }));
    }
  }

  /**
   * The prints the shared file shows, which a prune must keep: the one timeline.tsx names on disk now (whoever printed
   * it: another process, this one before a restart; an agent's save there names the print it was written on) and the
   * last one installed here. A file that names none (missing mid-install, cut short by a writer still writing it, or
   * unreadable) fails the prune, which then releases nothing: the print its writer started from is unknown.
   */
  private async shownPrints(): Promise<PinHold[]> {
    const text = (await retryBusy(() => fs.readFileSync(this.abs(TIMELINE_FILE)), this.busy)).toString("utf8");
    const rev = findRev(text)?.rev;
    if (rev?.kind !== "carton" || !rev.branch8) throw new Error("timeline.tsx names no print");
    return [...(this.shownPin ? [this.shownPin] : []), { branchId: rev.branch8, ref: rev.ref }];
  }

  /**
   * The freeze view to print on a shared cut: with this replica's pending changes by its agents on top (a hooked or
   * windowless agent's `cb` edit while offline, windows-sync round 2), each merged in with the optimistic states just
   * before and after it, in queue order, while they wait for the server. They aren't the view's own: each print takes
   * the queue as it is then (a change withdrawn or rebased since shows as it is now; a confirmed one joins the view
   * through `foldAgentChanges`). Only a change the merge takes exactly (its edits, no more, no fewer) shows: one that
   * overwrote or built on an edit the freeze hides never shows in part, but whole once confirmed, when the freeze
   * restarts at its state (one the view holds already, a save of the shared file, gains nothing and is passed over). The person's
   * pending edits stay out. `key`: the agents' changes the queue held (shown or not) and their edits, to tell when it
   * moved.
   */
  private async withPending(): Promise<{ doc: Doc; ids: string[]; key: string }> {
    const saves = this.freeze.saves;
    if (!this.engine.pendingChanges || !this.engine.shared()) return { doc: this.freeze.view!, ids: [], key: "" };
    const { changes } = await this.engine.pendingChanges(this.freeze.cut ?? undefined);
    // a save applied in this freeze that is no longer pending joins the view by what was confirmed (`foldAgentChanges`:
    // as applied only with the edits it was applied with) before the view is printed; one neither pending nor confirmed
    // (withdrawn, refused) is gone
    const waiting = new Set(changes.map((p) => p.id));
    if ([...saves.keys()].some((id) => !waiting.has(id))) {
      await this.foldAgentChanges();
      for (const id of [...saves.keys()]) if (!waiting.has(id)) saves.delete(id);
    }
    const mine = changes.filter((p) => this.showsPending(p));
    let doc = this.freeze.view!;
    const ids: string[] = [];
    for (const p of mine) {
      const s = saves.get(p.id);
      if (s && s.key === this.editsKey(p)) {
        // still the edits it was applied with: merged with its own base, as an applied save is
        doc = this.host.merge3(s.base, doc, s.saved);
        ids.push(p.id);
        continue;
      }
      const merged = this.host.merge3(p.before, doc, p.after);
      if (!this.host.changes || !sameEdits(this.host.changes(doc, merged), this.host.changes(p.before, p.after))) continue;
      doc = merged;
      ids.push(p.id);
    }
    return { doc, ids, key: this.pendingKey(mine) };
  }
  /** A change's edits, as one string (`host.changes`; a rebase keeps a change's id and can change its edits). */
  private editsKey(c: { before: Doc; after: Doc }): string {
    return sha((this.host.changes?.(c.before, c.after) ?? []).sort().join("\n"));
  }
  /** The agents' pending changes as printed: each one's id and edits. */
  private pendingKey(changes: readonly PendingChange[]): string {
    return changes.map((p) => `${p.id}:${this.editsKey(p)}`).join(" ");
  }
  /** Whether this replica's pending agent changes moved since the frozen file was printed (see `withPending`). */
  private async pendingMoved(): Promise<boolean> {
    if (!this.engine.pendingChanges || !this.engine.shared() || !this.freeze.view) return false;
    const { changes } = await this.engine.pendingChanges(this.freeze.cut ?? undefined);
    return this.pendingKey(changes.filter((p) => this.showsPending(p))) !== this.freeze.pending;
  }
  /**
   * The pending changes a frozen file shows (`withPending`) and whose moves rewrite it (`pendingMoved`): this replica's
   * agents', a windowless `cb` caller's whose call holds the freeze (apply-ryw review #2: one predicate for both, so an
   * offline terminal's edit rewrites the file), and saves applied in the freeze.
   */
  private showsPending(p: PendingChange): boolean {
    return isAgent(p.author) || this.freeze.callers.has(p.author?.id ?? "") || this.freeze.saves.has(p.id);
  }

  /** The project.json envelope of the file on disk (null if absent or unreadable). */
  private async readEnvelope(): Promise<Record<string, unknown> | null> {
    return (await this.envelopeFile())?.env ?? null;
  }
  /**
   * The file on disk: its envelope, content hash and stamp. project.json can be large (thumbnail id lists grow with
   * footage), so it is read, hashed and parsed again only when its stamp changed.
   */
  private async envelopeFile(): Promise<{ env: Record<string, unknown> | null; hash: string | null; stamp: string } | null> {
    const stamp = await statStamp(this.abs(PROJECT_FILE), this.busy);
    if (stamp === null) return null;
    if (this.envelopeCache?.stamp === stamp) return this.envelopeCache;
    const f = await this.readFile(PROJECT_FILE);
    if (!f) return null;
    let env: Record<string, unknown> | null = null;
    try {
      const v = JSON.parse(f.bytes.toString("utf8")) as Record<string, unknown>;
      env = v && typeof v === "object" ? v : null;
    } catch {
      env = null;
    }
    this.envelopeCache = { stamp: f.stamp, env, hash: f.hash };
    return this.envelopeCache;
  }
  private async currentProject(): Promise<Project | null> {
    return ((await this.projectSource()).env?.project as Project | undefined) ?? null;
  }

  /**
   * Where the unversioned fields of the next project.json come from (§6.4's ephemeral side: Cardboard's own data,
   * which the engine doesn't version). The overlay is the newest foreign envelope applied, by its file's mtime (an
   * older one never replaces it), and each Carton install records which overlay it was built from. The overlay is the
   * source while Carton hasn't consumed it yet, and whenever the file on disk is a foreign one older than it (a late
   * save that must not bring back older fields); otherwise the file on disk is.
   */
  private async projectSource(): Promise<{ env: Record<string, unknown> | null; overlay: Overlay | null; key: string }> {
    const overlay = (await this.engine.getMeta<Overlay>(["file", PROJECT_FILE, "overlay"])) ?? null;
    const f = await this.envelopeFile();
    const fileEnv = f?.env ?? null;
    // `key`: which envelope it is (the file's by its stamp, or an overlay by its id)
    const file = { env: fileEnv, overlay, key: `file:${f?.stamp ?? ""}` };
    const over = { env: overlay?.envelope ?? null, overlay, key: `overlay:${overlay?.id ?? ""}` };
    if (!overlay) return file;
    const consumed = await this.engine.getMeta<string>(["file", PROJECT_FILE, "consumed"]);
    if (consumed !== overlay.id) return over;
    const ps = await this.pathState(PROJECT_FILE);
    const own = !!f && ps.written.some((w) => w.hash === f.hash && w.stamp === f.stamp);
    if (f && !own && BigInt(f.stamp.split(":")[2] ?? "0") < BigInt(overlay.mtimeNs ?? "0")) return over;
    return fileEnv ? file : over;
  }

  private async writeProjectNow(cause: string): Promise<void> {
    await this.importUnseen(PROJECT_FILE);
    const { env: source, overlay } = await this.projectSource();
    const env = source ?? { format: "cardboard-project", version: 1, media: [] };
    const fresh = !!overlay && (await this.engine.getMeta<string>(["file", PROJECT_FILE, "consumed"])) !== overlay.id;
    const cur = (env.project as Project | undefined) ?? null;
    // project.json has one base: Carton's latest materialization of it. Only that state stays pinned for it (the
    // shared timeline.tsx keeps every print's pin for its stale writers, R7-01; project.json's foreign writers are
    // unpatched tools, rare, and get the latest view as their base).
    const on = this.engine.cut?.();
    const head = await this.engine.head();
    const onDisk = await this.readEnvelope();
    const same = (x: unknown) => onDisk !== null && JSON.stringify(x) === JSON.stringify(onDisk);
    // (not when the head read found a cut switch: that head is the old cut's, review 12 #1's class)
    if (!fresh && this.projectPin && cur && on === this.engine.cut?.() && same({ ...env, project: this.host.toProject(head, cur) })) return;
    await this.engine.release("project-file");
    const p = await this.engine.pin({ owner: "project-file", ttlMs: 7 * DAY });
    const body = refBodyOf(p);
    const next = this.host.toProject(p.doc, cur);
    // A project Cardboard reads is never replaced by one it can't (no name: laptop, build 915eb36, Restore of "Started
    // the cut"). Checked on the state just pinned, which is what would be written (head may have moved since it was
    // read): refused, the old file stays, the state it shows is pinned for it again, and the refusal is logged. Head's
    // next change tries again.
    const problems = breaks({ ...env, project: { ...next, updatedAt: "", stateUpdatedAt: 0 } }, onDisk);
    if (problems.length) {
      await this.engine.release("project-file");
      const shown = this.projectPin ? await this.resolveOrNull(this.projectPin) : null;
      if (shown) {
        const again = await this.engine.pin({ owner: "project-file", doc: shown.baseDoc, seq: shown.baseSeq, causal: shown.causal, ...(shown.cut ? { cut: shown.cut } : {}), ttlMs: 7 * DAY });
        this.projectPin = refBodyOf(again);
        await this.engine.putMeta(["file", PROJECT_FILE, "pin"], this.projectPin);
      }
      this.log.refused.push({ t: this.clock.now(), path: PROJECT_FILE, cause, ref: body, problems });
      return;
    }
    if (cur && same({ ...env, project: next })) {
      // the file already says this (also when it is a fresh foreign envelope: another materializer's install of the
      // same head, B11/B3; rewriting it would answer that install with one of ours, back and forth)
      this.projectPin = body;
      await this.engine.putMeta(["file", PROJECT_FILE, "pin"], body);
      if (fresh && overlay) await this.engine.putMeta(["file", PROJECT_FILE, "consumed"], overlay.id);
      return;
    }
    // 1.4.0's rev: stateUpdatedAt is forced monotonic, max(now, prev + 1) (writeTimeline)
    const prevRev = Math.max(typeof cur?.stateUpdatedAt === "number" ? cur.stateUpdatedAt : 0, typeof (onDisk?.project as Project | undefined)?.stateUpdatedAt === "number" ? ((onDisk!.project as Project).stateUpdatedAt as number) : 0);
    const now = this.clock.now();
    const project = { ...next, stateUpdatedAt: Math.max(now, prevRev + 1), updatedAt: new Date(now).toISOString() };
    await this.install(PROJECT_FILE, JSON.stringify({ ...env, project }, null, 2));
    this.projectPin = body;
    await this.engine.putMeta(["file", PROJECT_FILE, "pin"], body);
    // this install holds that overlay's fields; one applied during the install (newer) stays unconsumed for the next
    if (overlay) await this.engine.putMeta(["file", PROJECT_FILE, "consumed"], overlay.id);
    this.log.rewrites.push({ t: now, path: PROJECT_FILE, cause, ref: body });
  }

  /**
   * A foreign project.json's unversioned fields (Cardboard's own data) are the source for the next project.json Carton
   * writes; stored before the save's receipt, so a failure in between retries the save instead of deleting its file.
   * An older file (a displaced save reviewed late) never replaces a newer one's fields: overlays keep write order, and
   * the overlay is never deleted, so it is also the watermark.
   */
  private async storeOverlay(text: string, stamp: string | null): Promise<void> {
    const mtimeNs = stamp ? (stamp.split(":")[2] ?? "0") : "0";
    const cur = await this.engine.getMeta<Overlay>(["file", PROJECT_FILE, "overlay"]);
    if (!cur || BigInt(cur.mtimeNs ?? "0") <= BigInt(mtimeNs)) {
      const ov: Overlay = { id: randomBytes(6).toString("hex"), envelope: JSON.parse(text) as Record<string, unknown>, mtimeNs };
      await this.engine.putMeta(["file", PROJECT_FILE, "overlay"], ov);
    }
  }

  /** Displace, then install: never replaces a name, so a foreign save at `rel` is moved aside and imported. */
  private async install(rel: string, content: string, viewGen?: number, carry: { rows: MetaRow[] } = { rows: [] }): Promise<void> {
    // a file of Carton's at the path: an earlier save's bytes written after it are a save of their own (`finishes`).
    // Before the install, so a token that can't be stored stops it. Not while a save of this path installs its own
    // consequences (the regenerated shared file, a view's reprint). `carry`: rows to store with it (else with the
    // path's state after the install)
    if (!this.applying.has(rel)) {
      await this.writeMeta([this.tokenRow(rel), ...carry.rows]);
      carry.rows = [];
    }
    const target = this.abs(rel);
    const bytes = Buffer.from(content, "utf8");
    const hash = sha(bytes);
    const tmp = path.join(this.tmpDir, `${path.basename(rel)}.${this.tmpTag}.${this.tmpSeq++}`);
    fs.writeFileSync(tmp, bytes, { flag: "wx" });
    let r;
    try {
      // under the bundle's install lock, shared with the app's facade: the app's readers wait while it is held
      // `mine`: a holder taken over while it stalled stops rather than install its (older) file over a newer one
      r = await withInstallLock(this.bundle, (mine) => displaceThenInstall(target, tmp, () => this.held.next(rel), { ...this.busy, noLinks: this.noLinks, lastStamp: this.lastInstall.get(rel)?.stamp ?? null, mine }), this.busy);
    } catch (e) {
      // a rename may have moved a file aside before the failure: hold whatever is in the folder unreviewed
      await this.recoverDisplaced();
      try {
        fs.unlinkSync(tmp);
      } catch {
        // not created, or already linked and removed
      }
      throw e;
    }
    const stamp = await statStamp(target, this.busy);
    for (const d of r.displaced) {
      let mtimeNs = 0n;
      try {
        mtimeNs = fs.statSync(d, { bigint: true }).mtimeNs;
      } catch {
        // already gone: reviewed by an earlier round
      }
      this.origin.set(d, { rel, mtimeNs, ...(viewGen !== undefined ? { viewGen } : {}) });
    }
    this.held.hold(r.displaced, this.lastInstall.get(rel) ?? null);
    if (r.eexist) this.log.eexist += r.eexist;
    if (stamp) {
      this.lastInstall.set(rel, { bytes, stamp, hash });
      const st = await this.pathState(rel);
      push(st.written, { hash, stamp }, KEEP_WRITTEN);
    }
    await this.setLast(rel, hash, carry);
    this.held.endRound();
    await this.reviewDisplaced();
  }

  // ------------------------------------------------------------------ what Carton knows about each path

  /** Something happened at `rel` (see `finishes`): a new token, read by every process. Returns it. */
  private async touch(rel: string): Promise<string> {
    const row = this.tokenRow(rel);
    await this.engine.putMeta(row.key, row.value);
    return row.value;
  }
  private tokenRow(rel: string): { key: string[]; value: string } {
    return { key: ["file", rel, "seen"], value: randomBytes(8).toString("hex") };
  }
  /** Rows of local metadata in one store write when the engine can (`putMetas`). */
  private async writeMeta(rows: readonly MetaRow[]): Promise<void> {
    if (rows.length > 1 && this.engine.putMetas) await this.engine.putMetas(rows);
    else for (const r of rows) await this.engine.putMeta(r.key, r.value);
  }
  private async seen(rel: string): Promise<string> {
    return (await this.engine.getMeta<string>(["file", rel, "seen"])) ?? "";
  }

  private async pathState(rel: string): Promise<PathState> {
    let s = this.state.get(rel);
    if (!s) {
      s = (await this.engine.getMeta<PathState>(["file", rel, "state"])) ?? { last: null, written: [], applied: [], failed: [] };
      this.state.set(rel, s);
    }
    return s;
  }
  private async saveState(rel: string): Promise<void> {
    await this.engine.putMeta(["file", rel, "state"], await this.pathState(rel));
  }
  /** `carry`: rows stored with the path's state (and taken). */
  private async setLast(rel: string, hash: string, carry: { rows: MetaRow[] } = { rows: [] }): Promise<void> {
    const s = await this.pathState(rel);
    s.last = hash;
    await this.writeMeta([{ key: ["file", rel, "state"], value: s }, ...carry.rows]);
    carry.rows = [];
  }
  /** Content at the path that is the current generation already (installed, applied or tried): nothing to do. */
  private async isCurrent(rel: string, hash: string, stamp: string): Promise<boolean> {
    if ((await this.pathState(rel)).last !== hash) return false;
    return !(await this.unfinished(rel, hash, stamp));
  }
  /**
   * A save stored but not finished (it failed, or the process died, after its receipt): its attempt slot still holds
   * its result for these bytes, so a view's base and sidecar are still to be written. Such a save is read again (at
   * its path, or displaced) and finished from its recorded result. Not while it is being finished now (R7-01 reads the
   * path again).
   */
  private async unfinished(rel: string, hash: string, stamp: string): Promise<boolean> {
    if (this.applying.has(rel)) return false;
    const slot = await this.engine.getMeta<Attempt>(["attempt", rel]);
    if (!slot?.result || slot.hash !== hash) return false;
    return finishes(slot, await this.seen(rel), sha(`${stamp}\n${hash}`).slice(0, 24), hash);
  }

  // ------------------------------------------------------------------ foreign saves

  /** A watch event for `rel` (relative, `/`-separated). Reads whatever is at the path now. */
  onFsEvent(name: string): void {
    const rel = this.watched(name);
    if (this.closed || !rel) return;
    this.fire(() => this.readWithRetry(rel));
  }

  /**
   * Reads and applies the save at `rel`; if the engine fails (a locked database), retries with a growing delay until
   * it is applied, refused, or replaced, so a valid save never waits for another event or print.
   */
  private async readWithRetry(rel: string, attempt = 0): Promise<void> {
    try {
      await this.readEvent(rel);
      // done: a retry still pending for this path has nothing left to do
      const pending = this.retryTimers.get(rel);
      if (pending) this.clock.clearTimeout(pending);
      this.retryTimers.delete(rel);
    } catch (e) {
      this.scheduleRead(rel, attempt);
      throw e;
    }
  }
  /** Reads `rel` again after a failure, with a growing delay (one pending retry per path). */
  private scheduleRead(rel: string, attempt: number): void {
    if (this.closed || this.retryTimers.has(rel) || attempt >= 12) return;
    const timer: unknown = this.clock.setTimeout(() => {
      if (this.retryTimers.get(rel) !== timer) return; // cancelled, or replaced
      this.retryTimers.delete(rel);
      if (!this.closed) this.fire(() => this.readWithRetry(rel, attempt + 1));
    }, Math.min(30_000, 250 * 2 ** attempt));
    this.retryTimers.set(rel, timer);
  }

  /** The canonical relative path of a watched file, or null. project.json only while Carton writes it (`writeProject`). */
  private watched(name: string): string | null {
    const n = this.opts.foldCase ? name.toLowerCase() : name;
    if (n === TIMELINE_FILE || (n === PROJECT_FILE && this.opts.writeProject)) return n;
    if (!n.startsWith(`${VIEWS_DIR}/`) || !n.endsWith(".tsx")) return null;
    const view = n.slice(VIEWS_DIR.length + 1, -4);
    return view && !view.includes("/") ? viewPath(view) : null;
  }

  private async readFile(rel: string): Promise<FileRead | null> {
    const p = this.abs(rel);
    try {
      const bytes = await retryBusy(() => fs.readFileSync(p), this.busy);
      const stamp = stampOf(await retryBusy(() => fs.statSync(p, { bigint: true }), this.busy));
      return { bytes, hash: sha(bytes), stamp };
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code === "ENOENT" || code === "EISDIR") return null; // mid-install, or gone
      throw e;
    }
  }

  private async parses(rel: string, bytes: Buffer): Promise<boolean> {
    try {
      await this.parseSave(rel, bytes.toString("utf8"));
      return true;
    } catch {
      return false;
    }
  }
  private async parseSave(rel: string, text: string): Promise<Project> {
    if (rel === PROJECT_FILE) {
      const env = JSON.parse(text) as { project?: Project };
      if (!env || typeof env !== "object" || !env.project || typeof env.project !== "object") throw new SyntaxError("not a project.json envelope");
      return env.project;
    }
    return this.codec.parse(text, (await this.currentProject()) ?? {});
  }

  private async readEvent(rel: string): Promise<void> {
    const f = await this.readFile(rel);
    if (!f || (await this.isCurrent(rel, f.hash, f.stamp))) return;
    if (rel === TIMELINE_FILE) {
      this.freeze.lastForeign = this.clock.now();
      await this.updateFreeze();
    }
    await this.flushHeld(rel); // displaced saves of this path were written earlier: they go first
    if (await this.parses(rel, f.bytes)) {
      await this.applySave(rel, f.bytes, f.hash, f.stamp);
      return;
    }
    this.waitForQuiet(rel, f.stamp);
  }

  // Content that doesn't parse yet: an in-place writer mid-write. Re-read once the file has been quiet (same stamp)
  // for `quietMs`; a later write restarts the wait through its own event.
  private waitForQuiet(rel: string, stamp: string): void {
    const prev = this.quietTimers.get(rel);
    if (prev) this.clock.clearTimeout(prev);
    this.quietTimers.set(
      rel,
      this.clock.setTimeout(() => {
        this.quietTimers.delete(rel);
        this.fire(async () => {
          const f = await this.readFile(rel);
          if (!f || (await this.isCurrent(rel, f.hash, f.stamp))) return;
          if (f.stamp !== stamp) return this.waitForQuiet(rel, f.stamp);
          if (await this.parses(rel, f.bytes)) return void (await this.readWithRetry(rel));
          // something happened at the path: stored before the file counts as current, so a token that can't be stored
          // leaves it to be refused again at its next event (round 22 #1)
          await this.touch(rel);
          await this.setLast(rel, f.hash); // reported once; the file stays where its writer put it
          this.log.unparsed.push({ t: this.clock.now(), path: rel });
          await this.engine.notice(await this.actorOf(rel), { kind: "error", text: `${rel} doesn't parse; kept, not applied` });
          await this.refuseUnparsed(rel, `${rel} doesn't parse; kept, not applied`);
        });
      }, this.opts.quietMs),
    );
  }

  /**
   * A foreign save at `rel` that no watcher saw (written while the app was closed): applied before Carton writes it.
   * Returns the file it read when it applied nothing (null: none there), undefined when it applied it.
   */
  private async importUnseen(rel: string, o: { unparsed?: "wait" } = {}): Promise<FileRead | null | undefined> {
    const f = await this.readFile(rel);
    if (!f || (await this.isCurrent(rel, f.hash, f.stamp))) return f;
    if (!(await this.parses(rel, f.bytes))) {
      // a view: as at a watch event (re-read once quiet, then refused with its sidecar saying why). project.json and
      // the shared file are displaced by the install, then kept and reported if they never parse
      if (o.unparsed === "wait") this.waitForQuiet(rel, f.stamp);
      return f;
    }
    this.log.imported.push({ t: this.clock.now(), path: rel });
    await this.applySave(rel, f.bytes, f.hash, f.stamp);
    return undefined;
  }

  /**
   * View saves written while no materializer watched (the app crashed or closed before applying them): each printed
   * view's file is read as at a watch event, so the save is applied, credited to its owner, and its sidecar written
   * (B8). One view that fails doesn't stop the others.
   */
  private async importUnseenViews(): Promise<void> {
    let names: string[];
    try {
      names = fs.readdirSync(this.abs(VIEWS_DIR)).sort();
    } catch {
      return;
    }
    for (const n of names) {
      const rel = this.watched(`${VIEWS_DIR}/${n}`);
      const name = rel ? viewName(rel) : null;
      if (!rel || !name || !(await this.engine.getMeta<ViewRow>(["view", name]))) continue;
      try {
        await this.importUnseen(rel, { unparsed: "wait" });
      } catch (e) {
        // a transient failure (a locked database): read again later, as a watch event's would be; no event will come
        this.log.errors.push({ t: this.clock.now(), path: rel, error: e instanceof Error ? e.message : String(e) });
        this.scheduleRead(rel, 0);
      }
    }
  }

  /**
   * Picks up files in `.carton/displaced` that no review holds: left by an earlier process (a crash, or a close during
   * a hold), or moved aside by an install that failed half-way. Carton's own installs (content and stamp it recorded)
   * are deleted; the rest are reviewed as foreign saves of the path their name carries.
   */
  private async recoverDisplaced(): Promise<void> {
    let names: string[];
    try {
      names = fs.readdirSync(this.held.dir);
    } catch {
      return;
    }
    for (const n of names) {
      const file = path.join(this.held.dir, n);
      if (this.held.holds(file) || this.partials.has(file) || this.keptFiles.has(file)) continue;
      const tag = DisplacedFiles.tagOf(file);
      // every install here tags its slot with the path: with project.json the host's, an untagged file, or one moved off
      // project.json by an earlier run that wrote it, is left where it is
      if (!this.opts.writeProject && (tag === null || (this.opts.foldCase ? tag.toLowerCase() : tag) === PROJECT_FILE)) continue;
      const rel = this.watched(tag ?? "") ?? TIMELINE_FILE;
      let bytes: Buffer;
      let st: fs.BigIntStats;
      try {
        bytes = await retryBusy(() => fs.readFileSync(file), this.busy);
        st = await retryBusy(() => fs.statSync(file, { bigint: true }), this.busy);
      } catch {
        continue;
      }
      const ps = await this.pathState(rel);
      const stamp = stampOf(st);
      const hash = sha(bytes);
      if (ps.written.some((w) => w.hash === hash && w.stamp === stamp) || (ps.applied.includes(stamp) && !(await this.unfinished(rel, hash, stamp)))) {
        await this.held.release(file); // Carton's own install, or a copy of a save already stored (and finished)
        continue;
      }
      if (ps.failed.includes(stamp)) {
        this.keptFiles.add(file); // tried and refused before: kept, not retried
        continue;
      }
      this.origin.set(file, { rel, mtimeNs: st.mtimeNs });
      this.held.holdForeign(file);
      this.log.recovered.push({ t: this.clock.now(), path: rel, file: n });
    }
  }

  /**
   * Reviews held displaced files: deletes Carton's own (bytes and stamp unchanged after the hold), applies foreign
   * saves in the order they were written, and keeps foreign files that don't parse, telling their writer once. A file
   * leaves the hold only when its change is stored, it is known, or it was refused; if applying throws (a locked
   * database), it and every file after it are held again and retried.
   */
  private async reviewDisplaced(): Promise<void> {
    const r = await this.held.review(() => true); // parsing may be async (an injected codec): checked below
    for (const p of r.retired) this.origin.delete(p);
    const found: Found[] = [];
    for (const d of r.foreign) {
      const o = this.origin.get(d.path);
      found.push({ path: d.path, bytes: d.bytes, rel: o?.rel ?? TIMELINE_FILE, mtimeNs: o?.mtimeNs ?? 0n, stamp: await statStamp(d.path, this.busy), ...(o?.viewGen !== undefined ? { viewGen: o.viewGen } : {}) });
    }
    for (const [p, q] of this.partials) {
      const stamp = await statStamp(p, this.busy);
      if (stamp === null) this.partials.delete(p);
      else if (stamp !== q.stamp) {
        this.partials.delete(p);
        found.push({ path: p, bytes: await retryBusy(() => fs.readFileSync(p), this.busy), rel: q.rel, mtimeNs: q.mtimeNs, stamp, ...(q.viewGen !== undefined ? { viewGen: q.viewGen } : {}) });
      }
    }
    found.sort((a, b) => (a.mtimeNs < b.mtimeNs ? -1 : a.mtimeNs > b.mtimeNs ? 1 : 0));
    for (let i = 0; i < found.length; i++) {
      const d = found[i]!;
      try {
        await this.reviewOne(d);
      } catch (e) {
        for (const rest of found.slice(i)) {
          this.origin.set(rest.path, { rel: rest.rel, mtimeNs: rest.mtimeNs, ...(rest.viewGen !== undefined ? { viewGen: rest.viewGen } : {}) });
          this.held.holdForeign(rest.path);
        }
        this.log.errors.push({ t: this.clock.now(), path: d.rel, error: e instanceof Error ? e.message : String(e) });
        break;
      }
    }
    // own installs wait out their hold; failed imports retry soon; partials are only re-checked now and then
    const delay = this.held.size ? this.opts.quietMs : this.partials.size ? 5_000 : 0;
    if (delay && !this.reviewTimer && !this.closed)
      this.reviewTimer = this.clock.setTimeout(() => {
        this.reviewTimer = null;
        this.fire(() => this.reviewDisplaced());
      }, delay);
  }
  private async reviewOne(d: Found): Promise<void> {
    const hash = sha(d.bytes);
    const ps = await this.pathState(d.rel);
    const done = async () => {
      this.origin.delete(d.path);
      await this.held.release(d.path);
    };
    // a copy: that save is stored (and finished; an unfinished one is applied again, from its recorded result)
    if ((d.stamp && ps.applied.includes(d.stamp) && !(await this.unfinished(d.rel, hash, d.stamp))) || ps.written.some((w) => w.hash === hash && w.stamp === d.stamp)) return done();
    if (d.stamp && ps.failed.includes(d.stamp)) {
      this.origin.delete(d.path);
      this.keptFiles.add(d.path);
      this.log.kept.push({ t: this.clock.now(), path: d.rel, file: path.basename(d.path) }); // tried and refused: kept
      return;
    }
    if (!this.partials.has(d.path)) this.log.displaced.push({ t: this.clock.now(), path: d.rel });
    if (!(await this.parses(d.rel, d.bytes))) {
      // the in-place writer's half-written file: kept on disk; its writer is told once; imported if it completes
      this.origin.delete(d.path);
      this.partials.set(d.path, { rel: d.rel, stamp: d.stamp, mtimeNs: d.mtimeNs, ...(d.viewGen !== undefined ? { viewGen: d.viewGen } : {}) });
      if (!this.reportedPartials.has(d.path)) {
        this.log.unparsed.push({ t: this.clock.now(), path: d.rel, displaced: true });
        // something happened at the path: the install that displaced it wrote no token if it was a save's own
        // regeneration (round 23 #2)
        await this.touch(d.rel);
        const text = `${d.rel} (a save Carton moved aside) doesn't parse; kept in ${CARTON_DIR}/displaced, not applied`;
        await this.engine.notice(await this.actorOf(d.rel), { kind: "error", text });
        await this.refuseUnparsed(d.rel, text, d.viewGen);
        // only now: if the notice or the refusal failed (and threw), the next review reports it again
        this.reportedPartials.add(d.path);
      }
      return;
    }
    if (await this.applySave(d.rel, d.bytes, hash, d.stamp, { fromDisplaced: true, ...(d.viewGen !== undefined ? { viewGen: d.viewGen } : {}) })) return done();
    // a save that couldn't be applied (unknown base, never printed, rejected) stays in .carton/displaced
    this.origin.delete(d.path);
    this.keptFiles.add(d.path);
    this.log.kept.push({ t: this.clock.now(), path: d.rel, file: path.basename(d.path) });
  }
  private async flushHeld(rel: string): Promise<void> {
    if (![...this.origin.values()].some((o) => o.rel === rel) && ![...this.partials.values()].some((o) => o.rel === rel)) return;
    await this.reviewDisplaced();
  }

  private async actorOf(rel: string, consume = false): Promise<Actor> {
    const name = viewName(rel);
    if (name) {
      const row = await this.engine.getMeta<ViewRow>(["view", name]);
      if (row) return row.owner;
    }
    const list = (this.announced.get(rel) ?? []).filter((a) => this.clock.now() - a.at <= this.opts.attributeMs);
    const who = list[0]?.actor;
    if (consume && who) list.shift();
    this.announced.set(rel, list);
    return who ?? { kind: "external", id: `external:${rel}`, name: rel };
  }

  /**
   * Applies a foreign save. Returns false when it couldn't be (no print, unknown base, doesn't parse, rejected): its
   * bytes are kept. Throws when the engine fails (the caller retries).
   */
  private async applySave(rel: string, bytes: Buffer, hash: string, stamp: string | null, o: ApplyOptions = {}): Promise<boolean> {
    const outer = !this.applying.has(rel);
    if (outer) this.applying.add(rel);
    try {
      return await this.applySaveNow(rel, bytes, hash, stamp, o);
    } finally {
      if (outer) this.applying.delete(rel);
    }
  }
  private async applySaveNow(rel: string, bytes: Buffer, hash: string, stamp: string | null, o: ApplyOptions): Promise<boolean> {
    const ps = await this.pathState(rel);
    const failed = async () => {
      // tried and refused: the current generation at the path (if it is still there), and this file is never retried
      if (!o.fromDisplaced) ps.last = hash;
      if (stamp) push(ps.failed, stamp, KEEP_STAMPS);
      await this.saveState(rel);
      return false;
    };
    // a save already committed by an earlier attempt of this same file (a failure, or a crash, after its commit) is
    // finished below from its recorded result, even though its content now equals head, or its print was replaced since
    // (this file, or its bytes written again while nothing has happened at the path since: `finishes`)
    const gen = sha(`${stamp ?? ""}\n${hash}`).slice(0, 24);
    const earlier = await this.engine.getMeta<Attempt>(["attempt", rel]);
    const resumed = !!earlier && (earlier.gen === gen || (!!earlier.result && earlier.hash === hash && finishes(earlier, await this.seen(rel), gen, hash)));
    // any other file reviewed here is something happening at the path, whatever its outcome (committed, head-equal,
    // refused, failed): from now on an earlier save's bytes are a save of their own (round 21 #1)
    // The token this attempt starts from is the one it wrote: its slot keeps it, so whatever happens at the path while
    // it commits (another process's install) still counts (round 22 #2). A resumed save that needs a new slot has none:
    // only its own file finishes from it
    const started = resumed ? null : await this.touch(rel);
    const text = bytes.toString("utf8");
    const actor = await this.actorOf(rel, true);
    const name = viewName(rel);
    const row = name ? await this.engine.getMeta<ViewRow>(["view", name]) : undefined;
    if (name && !row) {
      this.log.ignored.push({ t: this.clock.now(), path: rel, why: "never printed" }); // never applied without a print (R5-03)
      return failed();
    }
    // a displaced view save from an earlier print generation (the agent printed again since), refused or applied, shows
    // in the sidecar and the row only while no save of a later print does: the latest save of the view, displaced by the
    // print, still finishes there (R7-02); an older one never replaces a newer save's outcome or stops its late updates
    // (round 18 #2). A file of unknown generation (not displaced, or recovered after a restart) counts as the latest.
    const fileGen = o.viewGen ?? row?.printGen ?? 0;
    const current = !row || shows(row, fileGen);
    const viewFailed = async (s: Partial<StatusBody> & { status: StatusBody["status"] }) => {
      if (name && row && current) await this.failView(name, row, s, fileGen);
    };
    const rev = rel === PROJECT_FILE ? null : (findRev(text)?.rev ?? null);
    // written on a print replaced at a save's commit (see reprintView): refused, unless it is that save itself, finished
    // from its attempt, or its bytes written again while it is still the view's latest save (round 18 #1; after a later
    // save, restoring it is a save on the replaced print like any other: round 19 #4)
    const replaced = name && rev?.kind === "carton" && rev.nonce && !resumed ? await this.engine.getMeta<Replaced>(["reprinted", name, rev.nonce]) : undefined;
    if (replaced && replaced.hash === hash && row && row.lastChange === replaced.change && row.savedGen === replaced.gen) {
      if (!o.fromDisplaced) ps.last = hash;
      if (stamp) push(ps.applied, stamp, KEEP_STAMPS);
      await this.saveState(rel);
      this.log.applied.push({ t: this.clock.now(), path: rel, id: null, status: "unchanged", cards: 0, actor: actor.id, hash });
      return true;
    }
    let base: Rev | HeldBase;
    let held: HeldBase;
    try {
      if (rel === PROJECT_FILE) {
        // project.json carries no header: its writer read Carton's last materialization of it
        const pin = await this.engine.getMeta<string>(["file", PROJECT_FILE, "pin"]);
        const prev = pin ? revOf(pin) : null;
        if (!prev) throw new Error("state unknown: re-print (project.json was never written by Carton)");
        base = prev;
        held = await this.engine.resolve(prev);
      } else if (replaced) {
        // no base describes it (rounds 16-18, see reprintView)
        throw new Error(`state unknown: re-print (${rel} was written on a print of it replaced at the commit of a save that repeated a change made after that print; print it again, cb source print --view ${name}, and redo this save's edits)`);
      } else if (row?.last && rev?.kind === "carton" && rev.nonce === row.nonce && row.last.nonce === row.nonce) {
        // R4-02: the same print as the last applied save: only the agent's new edits count
        base = held = row.last.held;
      } else {
        if (!rev) throw new Error("state unknown: re-print (the file has no cardboard:rev header)");
        base = rev;
        held = await this.engine.resolve(rev);
      }
    } catch (e) {
      // only "state unknown" refuses the save; a store or engine failure is thrown, and the caller retries the file
      if (!isStateUnknown(e)) throw e;
      const msg = (e as Error).message;
      await this.engine.notice(actor, { kind: "error", text: msg });
      await viewFailed({ status: "error", error: msg, ref: rev?.kind === "carton" ? rev.ref : null });
      this.log.applied.push({ t: this.clock.now(), path: rel, error: msg });
      return failed();
    }
    const baseDoc = held.baseDoc;
    let parsed: Project;
    let saved: Doc;
    try {
      parsed = await this.parseSave(rel, text);
      saved = this.host.fromProject(parsed, baseDoc, this.engine.own?.(actor));
    } catch (e) {
      this.log.unparsed.push({ t: this.clock.now(), path: rel });
      const msg = `${rel} doesn't parse; kept, not applied: ${(e as Error).message}`;
      await this.engine.notice(actor, { kind: "error", text: msg });
      await viewFailed({ status: "error", error: msg, ref: rev?.kind === "carton" ? rev.ref : null });
      return failed();
    }
    const asBase = !name && !resumed && sameDoc(saved, baseDoc);
    // during a freeze, head is pinned once: the save is compared with, and the freeze restarted from, the same state
    // (a commit from another process landing in between must stay hidden, R8-01)
    const frozenHead = !name && !resumed && !asBase && rel === TIMELINE_FILE && this.freeze.active ? await this.currentHead() : null;
    // a head-equal save is a no-op only against the current cut's head: if the cut is found switched while head is
    // read (a pin or a read refreshes from the store; `currentHead` gave up re-pinning), the save is committed on the
    // cut it lands on, as when the switch is seen a moment earlier (review 12 #1)
    let asHead = false;
    if (!name && !resumed && !asBase) {
      const on = this.engine.cut?.();
      const head = frozenHead ? frozenHead.baseDoc : await this.engine.head();
      asHead = (frozenHead ? this.onCurrentCut(frozenHead) : on === this.engine.cut?.()) && sameDoc(saved, head);
    }
    if (asBase || asHead) {
      // nothing to version: the file shows the state its header names, or head itself (another materializer's install
      // of carton.db's state, a takeover helper's while it held the lease, B11/B3; or a save that changed nothing). No
      // commit, and no regeneration, which would answer one materializer's install with another's, back and forth.
      // project.json's own fields are still kept (its overlay). An agent saving head's content into a frozen shared
      // file has taken in what the freeze hid: the freeze view restarts from head, with head's whole causal past (a
      // merge into the old view without those changes' ids would map later saves through them again)
      if (asHead && frozenHead) await this.freezeOnCurrentCut(true, frozenHead);
      if (rel === PROJECT_FILE) {
        await this.storeOverlay(text, stamp);
        this.scheduleProjectWrite("overlay"); // its fields reach the file (nothing to write if the file has them)
      }
      if (!o.fromDisplaced) ps.last = hash;
      if (stamp) push(ps.applied, stamp, KEEP_STAMPS);
      await this.saveState(rel);
      this.log.applied.push({ t: this.clock.now(), path: rel, id: null, status: "unchanged", cards: 0, actor: actor.id, hash });
      return true;
    }
    // A retry of this same save after a failure below (or a crash) must not commit again: the engine would confirm it
    // as empty, without the change's id that a view's causal past and the freeze view need. So the save records its
    // change id before committing, and its result right after; a retry commits with the same id (dedup by id) or reuses
    // the result. The slot is per path: with a result, it finishes any file with that content (that save); without one, it
    // is bound to the file generation and the base, so it never answers for another save.
    const attemptKey = ["attempt", rel] as const;
    const baseKey = "baseDoc" in base ? `held:${base.baseSeq}:${base.causal.join(",")}:${row?.last?.contentHash ?? ""}` : base.kind === "carton" ? `ref:${base.ref} b:${base.branch8 ?? ""}` : `legacy:${base.rev}`;
    let slot = await this.engine.getMeta<Attempt>(attemptKey);
    // finishing a save stored before a failure (or crash): its result is this content's commit, whatever base the lookup
    // finds now (the view row may already name the save itself as the base, or a reprint may have replaced its print;
    // round 19 #2), for this file or its bytes written again before anything else happened at the path (`finishes`)
    const finishing = !!slot?.result && slot.hash === hash && finishes(slot, await this.seen(rel), gen, hash);
    if (!slot || (!finishing && (slot.gen !== gen || slot.base !== baseKey))) {
      const id = this.engine.newChangeId?.();
      slot = { gen, base: baseKey, hash, ...(id ? { id } : {}), ...(started !== null ? { seen: started } : {}) };
      await this.engine.putMeta(attemptKey, slot);
    }
    const res = slot.result ?? (await this.engine.commit({ doc: saved, base, author: actor, meta: { file: rel, ...(name ? { view: name } : {}) }, ...(slot.id ? { id: slot.id } : {}) }));
    if (!slot.result && res.status !== "rejected") await this.engine.putMeta(attemptKey, { ...slot, result: res });
    const settle = async () => {
      // the save is finished: its slot (and the engine's record of its cards) can go. Never fatal: a leftover slot is
      // taken over by the path's next save, and finishes only this same file from now on (round 20 #1: the same bytes
      // written later are a save of their own)
      try {
        await this.engine.putMeta(attemptKey, undefined);
        if (slot.id) await this.engine.putMeta(["attempt-cards", slot.id], undefined);
      } catch (e) {
        this.log.errors.push({ t: this.clock.now(), path: rel, error: `attempt cleanup: ${e instanceof Error ? e.message : String(e)}` });
        // the save is finished: its bytes written again are a save of their own. If even that can't be stored, the
        // file is retried (finished again from its result), not left looking unfinished (round 21 #2)
        await this.touch(rel);
      }
    };
    if (res.status === "rejected") {
      await this.engine.notice(actor, { kind: "error", text: `${rel}: rejected${res.reason ? `: ${res.reason}` : ""}; kept, not applied` });
      await viewFailed({ status: "rejected", error: res.reason ?? "rejected", ref: rev?.kind === "carton" ? rev.ref : null });
      await settle();
      return failed();
    }
    if (rel === PROJECT_FILE) await this.storeOverlay(text, stamp);
    // Cards are data too: stored before the receipt, so a failure in between retries this file instead of deleting the
    // only copy of a save whose every edit carded. The id is stable for the same file, so a retry rewrites the same key.
    const cards = res.cards ?? [];
    const batch: SaveCards | null = cards.length ? { batch: res.id ?? `save-${sha(`${rel}\n${stamp ?? ""}\n${hash}`).slice(0, 20)}`, change: res.id ?? null, ...(slot.id ? { request: slot.id } : {}), file: rel, actor, cards, at: this.clock.now(), ...(res.cut !== undefined ? { cut: res.cut } : {}) } : null;
    if (batch) await this.engine.putMeta(["cards", batch.batch], batch);
    // the receipt: stored. Written before the regeneration below reads the path again
    if (!o.fromDisplaced) ps.last = hash;
    if (stamp) push(ps.applied, stamp, KEEP_STAMPS);
    await this.saveState(rel);
    this.log.applied.push({ t: this.clock.now(), path: rel, id: res.id ?? null, status: res.status, cards: cards.length, actor: actor.id, hash });
    if (batch) await this.reportCards(batch, !name);
    if (this.freeze.active && this.freeze.view && rel !== PROJECT_FILE) {
      // R8-01: the freeze view gathers every local agent's applied saves (shared file and views), each merged with
      // that save's own base (on the freeze's own cut: a cut switch restarts it from the new head, which has the save)
      const cut = this.freeze.cut;
      await this.freezeOnCurrentCut();
      if (cut === this.freeze.cut) {
        // a save that repeated an edit the freeze hides (an agent saving the ripple a remote made, alone or with edits of
        // its own) holds that change, all of it, part of it or its net with others, which no causal past can say: the
        // freeze restarts at this save's own commit, so it shows what was confirmed up to it and still hides what came
        // after (R8-01; rounds 13-15). Read after the commit, so a retry and a change landing just before it are alike.
        // A commit that went to another cut than the freeze's (a switch between them) restarts it there too; the next
        // rewrite moves it to the current cut.
        const own = res.id ? [res.id] : [];
        const elsewhere = res.cut !== undefined && this.freeze.cut !== null && res.cut !== this.freeze.cut;
        if (elsewhere || (await this.repeatsHidden(baseDoc, saved, this.freeze.baseSeq, [...this.freeze.causal, ...this.freeze.saves.keys(), ...own], this.freeze.cut ?? undefined, upTo(res)))) {
          const p = await this.commitState(res, "shared-view");
          this.restartFreeze({ baseDoc: p.doc, baseSeq: p.seq, causal: [], ...(p.cut !== undefined ? { cut: p.cut } : {}) });
        } else {
          // a change on a shared cut can be rebased before it is confirmed (a remote edit takes one of its edits away):
          // it shows on top of the view as it is at each print, and joins the view once confirmed. As applied only
          // while its edits are those it was committed with (a rebase that changed them, or a confirmation, before this
          // read: by what is). A save absorbed at its commit (no change of its own) joins the view as saved. A retry of the
          // save (answered from its stored result) keeps what its first attempt recorded, read before any confirmation
          if (res.id && this.engine.pendingChanges && this.engine.shared()) {
            if (!this.freeze.saves.has(res.id)) {
              const pending = (await this.engine.pendingChanges(this.freeze.cut ?? undefined)).changes.find((p) => p.id === res.id);
              this.freeze.saves.set(res.id, { base: baseDoc, saved, key: pending && !pending.edited ? this.editsKey(pending) : "" });
            }
          } else {
            this.freeze.view = this.host.merge3(baseDoc, this.freeze.view!, saved);
            for (const id of own) if (!this.freeze.causal.includes(id)) this.freeze.causal.push(id);
          }
        }
      }
    }
    if (rel === TIMELINE_FILE || (name && this.freeze.active)) {
      // R7-01: regenerate after every applied save, so the base of any later save is that save's own header ref. The
      // save is stored: a failure here is logged (the next rewrite catches up) and never keeps its sidecar from it.
      try {
        await this.writeSharedNow("save");
      } catch (e) {
        this.log.errors.push({ t: this.clock.now(), path: TIMELINE_FILE, error: `regenerate after a save: ${e instanceof Error ? e.message : String(e)}` });
        this.retryWrite("shared"); // during a freeze nothing else would rewrite it until the turn ends
      }
    }
    let reprint = false;
    if (name && row && current) {
      // the saved content's causal past: its base's, plus this save's own change
      if (rev?.kind === "carton" && rev.nonce === row.nonce) {
        // the next save's base is this save: its base's causal past and its own change. A save that repeated an edit of
        // a change its print didn't hold has no such past (see repeatsHidden): the view is printed again at the save's
        // own commit below, and the next save's base is that exact state (review 14 #4, round 15 #2, #3); a save still
        // written on this print is refused (rounds 16-17, see reprintView)
        const causal = res.id && !held.causal.includes(res.id) ? [...held.causal, res.id] : held.causal;
        reprint = await this.repeatsHidden(baseDoc, saved, held.baseSeq, causal, res.cut, upTo(res));
        // the print is marked replaced before anything below can fail (round 18 #3)
        if (reprint) await this.engine.putMeta(["reprinted", name, row.nonce], { hash, at: this.clock.now(), change: res.id ?? null, gen: fileGen } satisfies Replaced);
        row.last = reprint ? null : { contentHash: hash, nonce: row.nonce, held: { baseDoc: saved, baseSeq: held.baseSeq, causal } };
      }
      row.lastChange = res.id ?? null;
      row.savedGen = fileGen;
      await this.engine.putMeta(["view", name], row);
      const head = await this.engine.head();
      const status: StatusBody["status"] = cards.length ? "conflicts" : res.status;
      const pinned = await this.engine.pin({ owner: row.pinOwner, ttlMs: 7 * DAY });
      await this.writeStatus(name, { status, seq: res.seq ?? null, conflicts: cards, diagnostics: this.host.diagnose(saved, head), ref: refBodyOf(pinned), ...(res.reason ? { error: res.reason } : {}) }, res.id ?? null, { immediate: true });
      if (reprint) await this.reprintView(name, row, res);
    }
    this.onHeadChange("local");
    await settle();
    return true;
  }

  /** Cards are data: stored, given to the human, and told to the actor when it has no sidecar to read them in. */
  private async reportCards(c: SaveCards, notifyActor: boolean): Promise<void> {
    this.log.cards.push(c); // already stored under ["cards", c.batch]
    this.onCards?.(c);
    if (notifyActor)
      await this.engine.notice(c.actor, {
        kind: "conflicts",
        text: `Your save of ${c.file} conflicted with changes made since you read it; the newer values were kept, yours are in the cards: ${c.cards.map((x) => x.path).join(", ")}`,
        ...(c.change || c.request ? { change: (c.change ?? c.request)! } : {}),
      });
  }

  /**
   * A file at `rel` that doesn't parse, in place or displaced, refused before any save was attempted (the caller has
   * written the path's token): a view's latest save refuses the view, unless a newer print has already started over (a
   * file of unknown print, in place or recovered after a restart, counts as the latest).
   */
  private async refuseUnparsed(rel: string, error: string, viewGen?: number): Promise<void> {
    const name = viewName(rel);
    const row = name ? await this.engine.getMeta<ViewRow>(["view", name]) : undefined;
    const gen = viewGen ?? row?.printGen ?? 0;
    if (name && row && shows(row, gen)) await this.failView(name, row, { status: "error", error }, gen);
  }

  /** A refused view save: its sidecar says so, and late updates for any earlier save no longer reach it. */
  private async failView(name: string, row: ViewRow, s: Partial<StatusBody> & { status: StatusBody["status"] }, gen = row.printGen ?? 0): Promise<void> {
    row.lastChange = null;
    row.savedGen = gen;
    await this.engine.putMeta(["view", name], row);
    await this.writeStatus(name, s, null, { immediate: true });
  }

  // ------------------------------------------------------------------ status sidecar (R5-04)

  /**
   * Writes `.scratch/views/<name>.status`. Immediate writes follow an apply or a refusal; a later update (confirmed,
   * late conflicts: `onChangeUpdate`) is written only while its change is still the view's latest save.
   */
  private async writeStatus(name: string, s: Partial<StatusBody> & { status: StatusBody["status"] }, changeId: string | null, o: { immediate?: boolean } = {}): Promise<void> {
    if (!o.immediate) {
      const row = await this.engine.getMeta<ViewRow>(["view", name]);
      if (!changeId || row?.lastChange !== changeId) return;
      // a late update: the save's recorded result no longer says it all (`finishes`, round 21 #2)
      await this.touch(viewPath(name));
    }
    const file = this.abs(statusPath(name));
    let prev: Partial<StatusBody> | null = null;
    try {
      prev = JSON.parse(fs.readFileSync(file, "utf8")) as StatusBody;
    } catch {
      prev = null;
    }
    const body: StatusBody = { status: s.status, ref: s.ref ?? null, seq: s.seq ?? null, conflicts: s.conflicts ?? [], diagnostics: s.diagnostics ?? prev?.diagnostics ?? [], change: changeId, at: this.clock.now() };
    if (s.error) body.error = s.error;
    // the sidecar is Carton's alone (agents only read it): temp + rename is enough
    const tmp = path.join(this.tmpDir, `${name}.status.${this.tmpTag}.${this.tmpSeq++}`);
    fs.writeFileSync(tmp, JSON.stringify(body));
    await retryBusy(() => fs.renameSync(tmp, file), this.busy);
  }

  /** A view's change was confirmed, or came back with late conflicts: its sidecar follows. */
  onChangeUpdate(view: string, changeId: string, s: { status: "confirmed" | "conflicts" | "rejected"; seq?: number; conflicts?: ConflictCard[]; ref?: string; reason?: string }): Promise<void> {
    return this.run(() => this.writeStatus(this.canonView(view), { status: s.status, seq: s.seq ?? null, conflicts: s.conflicts ?? [], ref: s.ref ?? null, ...(s.reason ? { error: s.reason } : {}) }, changeId));
  }
}

/**
 * The pin owner of a hooked actor's prints: the turn's own agent pins as `turn:<turn>`, a subagent as
 * `turn:<turn>/sub:<id>`, so a subagent's Stop releases only what it pinned while its parent's turn runs on (local-cli H8).
 */
export const turnOwner = (a: Actor): string => (isSubagent(a) ? `turn:${turnOf(a)}/sub:${a.id}` : `turn:${turnOf(a)}`);
const isSubagent = (a: Actor): boolean => a.kind === "subagent" || !!a.agentId;
/** The turn an actor acts in: its `turn`; without one its own id, or a subagent's parent's (`<parent id>/sub-…`, §10). */
const turnOf = (a: Actor): string => a.turn ?? (isSubagent(a) && a.id.includes("/") ? a.id.slice(0, a.id.lastIndexOf("/")) : a.id);
/** Meta row: the pin owners a turn's subagents printed with, released when the turn itself stops. */
const turnPinsKey = (turn: string): string[] => ["turn-pins", turn];

const isAgent = (a: Actor | null | undefined): boolean => !!a && (a.kind === "agent" || a.kind === "subagent");
/** Whether two lists of edits (`MaterializerHost.changes`) are the same edits. */
const sameEdits = (a: string[], b: string[]): boolean => a.length === b.length && [...a].sort().join("\n") === [...b].sort().join("\n");

/** `.scratch/views/<name>.tsx` -> name. */
export function viewName(rel: string): string | null {
  if (!rel.startsWith(`${VIEWS_DIR}/`) || !rel.endsWith(".tsx")) return null;
  const n = rel.slice(VIEWS_DIR.length + 1, -4);
  return n && !n.includes("/") ? n : null;
}

/**
 * A view name for an actor (§6.4 "Distinct names"): a hooked agent's actor id with `/` made safe; otherwise the name it
 * asked for, or a fresh `agent-<4 random chars>` that no view uses yet.
 */
export function viewNameFor(actor: Actor | null, opts: { hooked: boolean; wanted?: string | null; taken: (name: string) => boolean; random: () => string }): string {
  const { hooked, wanted, taken, random } = opts;
  if (hooked && actor?.id) return actor.id.replace(/[^A-Za-z0-9._-]/g, "_");
  if (wanted) return wanted;
  for (;;) {
    const n = `agent-${random()}`;
    if (!taken(n)) return n;
  }
}
