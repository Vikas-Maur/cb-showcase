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
//                             path it came from, so a restart finds and finishes what an earlier process held.
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
}

export interface SaveResult {
  /** `conflicts`: committed, with cards that kept head's value; the human and the actor are told. */
  status: "confirmed" | "pending" | "conflicts" | "rejected";
  id?: string;
  seq?: number;
  cards?: ConflictCard[];
  reason?: string;
}

/** A pinned state: the ref token core prints (`<cut>@<seq>~<hash8>`), its cut, its seq, and its doc. */
export interface Pinned {
  ref: string;
  branchId: string;
  seq: number;
  doc: Doc;
}

/** What the materializer needs from the engine. `cartonMaterializerEngine` implements it over `Carton`. */
export interface MaterializerEngine {
  /** The current cut's optimistic head. */
  head(): Promise<Doc>;
  /**
   * Pins the head, or `doc` (a state not in the log: the freeze view) for `owner`. `seq` is the confirmed seq `doc`
   * was derived from, so a commit on it is checked against everything confirmed since (default: head); `causal`: the
   * changes after `seq` that `doc` already holds (agent saves merged into a freeze view), never met again.
   */
  pin(opts: { owner: string; doc?: Doc; seq?: number; causal?: string[]; ttlMs: number }): Promise<Pinned>;
  /** Releases every pin `owner` holds (a turn ended). */
  release(owner: string): Promise<void>;
  /** A printed ref -> its exact state and causal past. Throws "state unknown: re-print" when it can't (§4.4). */
  resolve(rev: Rev): Promise<HeldBase>;
  /**
   * Commits `doc` made on `base`; cards keep head's value and are reported (late conflicts arrive as notices). With
   * `id`, a commit whose id is already confirmed returns that confirmation (and its cards), never a second change.
   */
  commit(input: { doc: Doc; base: Rev | HeldBase; author: Actor; meta: { file: string; view?: string }; id?: string }): Promise<SaveResult>;
  /** A fresh change id, recorded before committing so a retry commits with the same id (dedup by id). */
  newChangeId?(): string;
  notice(to: Actor, notice: { kind: "error" | "conflicts"; text: string; change?: string }): Promise<void>;
  /** M4: did `author` create sequence element `id`? Keeps one author's run of inserts contiguous across saves. */
  own?(author: Actor): OwnFn;
  /** Local metadata (carton.db's `views` table), shared by every process on this machine. */
  getMeta<T>(key: readonly string[]): Promise<T | undefined>;
  putMeta(key: readonly string[], value: unknown): Promise<void>;
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
  /** A windowless agent counts as active until this long after its last save or `cb` call. */
  freezeIdleMs?: number;
  /** How long a hooked agent's announced write (`hookWrite`) waits for its save to land. */
  attributeMs?: number;
  /** Write project.json as a view of head (H1). Off when the host writes it itself. */
  writeProject?: boolean;
  /** Treat file names case-insensitively (default: on Windows and macOS, whose file systems fold case). */
  foldCase?: boolean;
  /**
   * On Windows, how long a file another process has open (EPERM, EBUSY, EACCES) is retried in all, in ms (default 5 s).
   * The retries wait on timers: the worker's thread keeps serving everything else meanwhile.
   */
  busyBudgetMs?: number;
  /** Cards a save raised, for the human (conflict cards). */
  onCards?: (c: SaveCards) => void;
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
 */
interface PathState {
  last: string | null;
  written: { hash: string; stamp: string }[];
  applied: string[];
  failed: string[];
}
const KEEP_WRITTEN = 8;
const KEEP_STAMPS = 32;

type Record_ = { t: number; path: string; [k: string]: unknown };
/**
 * One save of a path in progress, recorded before its commit: which file generation (stamp and bytes) on which base,
 * the change id it commits with, and once committed, the result. A retry of that same save reuses the id (and the
 * result) instead of committing again; a different save of the path takes the slot over.
 */
/** A save's attempt slot (`["attempt", rel]`): its change id before the commit, its result after, until it is settled. */
type Attempt = { gen: string; base: string; hash?: string; id?: string; result?: SaveResult };
/** A foreign project.json's envelope, kept for its unversioned fields until Carton's next write consumes it. */
type Overlay = { id: string; envelope: Record<string, unknown>; mtimeNs?: string };
type Found = { path: string; bytes: Buffer; rel: string; mtimeNs: bigint; stamp: string | null; viewGen?: number };
type Origin = { rel: string; mtimeNs: bigint; viewGen?: number };

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
const isStateUnknown = (e: unknown): boolean => (e as { code?: string })?.code === "STATE_UNKNOWN" || /state unknown/i.test((e as Error)?.message ?? "");

export class Materializer {
  readonly bundle: string;
  private readonly engine: MaterializerEngine;
  private readonly host: MaterializerHost;
  private readonly codec: TimelineCodec;
  private readonly clock: Clock;
  private readonly opts: Required<Omit<MaterializerOptions, "bundle" | "engine" | "host" | "codec" | "clock" | "onCards">>;
  private readonly onCards: ((c: SaveCards) => void) | null;
  private readonly held: DisplacedFiles;
  private readonly tmpDir: string;
  private readonly noLinks: boolean;
  private readonly busy: BusyOptions;
  private queue: Promise<unknown> = Promise.resolve();
  private tmpSeq = 0;
  private readonly tmpTag = randomBytes(4).toString("hex");
  private envelopeCache: { stamp: string; env: Record<string, unknown> | null; hash: string } | null = null;
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
  readonly freeze = { hooked: new Map<string, Actor>(), lastForeign: -Infinity, lastCb: -Infinity, active: false, view: null as Doc | null, baseSeq: 0, causal: [] as string[], cut: null as string | null, timer: null as unknown };
  /** The shared file's current ref, as core resolves it (`<cut>@<seq>~<hash8> b:<branch8>`). */
  private sharedRef: string | null = null;
  private lastRemoteRewrite = -Infinity;
  private remoteTimer: unknown = null;
  private localTimer: unknown = null;
  private projectTimer: unknown = null;
  private projectPin: string | null = null;

  /** What happened, for tests and the activity log (never file contents). */
  readonly log = { eexist: 0, errors: [] as Record_[], kept: [] as Record_[], applied: [] as Record_[], displaced: [] as Record_[], unparsed: [] as Record_[], imported: [] as Record_[], rewrites: [] as Record_[], ignored: [] as Record_[], recovered: [] as Record_[], cards: [] as SaveCards[] };

  constructor(o: MaterializerOptions) {
    this.bundle = path.resolve(o.bundle);
    this.engine = o.engine;
    this.host = o.host;
    this.codec = o.codec;
    this.clock = o.clock ?? realClock;
    this.onCards = o.onCards ?? null;
    this.opts = {
      printedBy: o.printedBy ?? "carton",
      quietMs: o.quietMs ?? 150,
      localRewriteMs: o.localRewriteMs ?? 20,
      remoteRewriteMs: o.remoteRewriteMs ?? 30_000,
      freezeIdleMs: o.freezeIdleMs ?? 60_000,
      attributeMs: o.attributeMs ?? 30_000,
      writeProject: o.writeProject ?? true,
      foldCase: o.foldCase ?? (process.platform === "win32" || process.platform === "darwin"),
      busyBudgetMs: o.busyBudgetMs ?? BUSY_BUDGET_MS,
    };
    this.busy = { counter: {}, budgetMs: this.opts.busyBudgetMs };
    const carton = path.join(this.bundle, CARTON_DIR);
    this.tmpDir = path.join(carton, "tmp");
    fs.mkdirSync(this.tmpDir, { recursive: true });
    fs.mkdirSync(path.join(this.bundle, VIEWS_DIR), { recursive: true });
    this.held = new DisplacedFiles(path.join(carton, "displaced"), { now: () => this.clock.now(), quietMs: this.opts.quietMs, holdMs: this.opts.quietMs, ...this.busy });
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
      for (const rel of [PROJECT_FILE, TIMELINE_FILE]) {
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

  /** A hooked agent read the shared file (PreToolUse): the freeze starts. */
  hookRead(actor: Actor): Promise<void> {
    return this.run(async () => {
      this.freeze.hooked.set(actor.id, actor);
      await this.updateFreeze();
    });
  }
  /** A hooked agent's turn ended (Stop/SubagentStop): its pins go, and the freeze may end. */
  hookStop(actor: Actor): Promise<void> {
    return this.run(async () => {
      await this.engine.release(turnOwner(actor));
      if (this.freeze.hooked.delete(actor.id)) await this.updateFreeze();
    });
  }
  /**
   * A hooked agent is about to write a watched file (PreToolUse on Write/Edit/MultiEdit). Files carry no writer, so the
   * next foreign save of `rel` within `attributeMs` is credited to this actor, down to the subagent (Credits); saves no
   * hook announced stay `external:<file>`. Per-agent views are credited to their owner without this.
   */
  hookWrite(actor: Actor, rel: string): Promise<void> {
    return this.run(async () => {
      const canon = this.watched(rel) ?? rel;
      const list = this.announced.get(canon) ?? [];
      list.push({ actor, at: this.clock.now() });
      this.announced.set(canon, list);
      if (canon === TIMELINE_FILE) {
        this.freeze.hooked.set(actor.id, actor); // a hooked agent writing the shared file is active, as when it reads
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
  private async freezeOnCurrentCut(moved = false): Promise<void> {
    const cut = this.engine.cut?.() ?? null;
    if (!this.freeze.active || (!moved && cut === this.freeze.cut)) return;
    const h = await this.pinnedHead("shared-file");
    this.freeze.view = h.baseDoc;
    this.freeze.baseSeq = h.baseSeq;
    this.freeze.causal = [];
    this.freeze.cut = cut;
  }

  /** Any `cb` call: windowless agents count as active for a while after it. */
  onCb(): Promise<void> {
    return this.run(async () => {
      this.freeze.lastCb = this.clock.now();
      await this.updateFreeze();
    });
  }

  /**
   * Head moved. `local` and `gui`: rewrite promptly (coalesced). `remote`: at most every 30 s while shared. Nothing for
   * non-agent changes while a freeze is active. project.json follows head promptly either way.
   */
  onHeadChange(cause: "local" | "gui" | "remote"): void {
    if (this.closed) return;
    this.scheduleProjectWrite(cause);
    if (this.freeze.active) return;
    if (cause === "remote" && this.engine.shared()) {
      if (this.remoteTimer) return;
      const at = Math.max(this.clock.now(), this.lastRemoteRewrite + this.opts.remoteRewriteMs);
      this.remoteTimer = this.clock.setTimeout(() => {
        this.remoteTimer = null;
        this.fire(() => this.orRetry("shared", async () => {
          if (!this.freeze.active) await this.writeSharedNow("remote");
        }));
      }, at - this.clock.now());
      return;
    }
    if (this.localTimer) return;
    this.localTimer = this.clock.setTimeout(() => {
      this.localTimer = null;
      this.fire(() => this.orRetry("shared", async () => {
        if (!this.freeze.active) await this.writeSharedNow(cause);
      }));
    }, this.opts.localRewriteMs);
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
            if (which === "shared") await this.writeSharedNow("retry");
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
      this.fire(() => this.orRetry("project", () => this.writeProjectNow(cause)));
    }, this.opts.localRewriteMs);
  }

  private frozenNow(): boolean {
    return this.freeze.hooked.size > 0 || this.clock.now() < Math.max(this.freeze.lastForeign, this.freeze.lastCb) + this.opts.freezeIdleMs;
  }
  private async updateFreeze(): Promise<void> {
    const f = this.frozenNow();
    if (f && !this.freeze.active) {
      // the freeze starts from what the shared file shows, and remembers the seq that state was derived from
      const shown = this.sharedRef ? await this.resolveOrNull(this.sharedRef) : null;
      const start = shown ?? (await this.pinnedHead("shared-file"));
      this.freeze.active = true;
      this.freeze.view = start.baseDoc;
      this.freeze.baseSeq = start.baseSeq;
      this.freeze.causal = [...start.causal];
      this.freeze.cut = this.engine.cut?.() ?? null;
    } else if (!f && this.freeze.active) {
      this.freeze.active = false;
      this.freeze.view = null;
      await this.writeSharedNow("freeze-end");
    }
    if (this.freeze.timer) this.clock.clearTimeout(this.freeze.timer);
    this.freeze.timer = null;
    if (this.freeze.active && this.freeze.hooked.size === 0) {
      const end = Math.max(this.freeze.lastForeign, this.freeze.lastCb) + this.opts.freezeIdleMs;
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
    return { baseDoc: p.doc, baseSeq: p.seq, causal: [] };
  }

  // ------------------------------------------------------------------ Carton's writes

  /** `cb source print` with the app open: the shared file shows head; a freeze view restarts from it. */
  printShared(): Promise<string> {
    return this.run(async () => {
      if (this.freeze.active) {
        const h = await this.pinnedHead("shared-file");
        this.freeze.view = h.baseDoc;
        this.freeze.baseSeq = h.baseSeq;
        this.freeze.causal = [];
      }
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
      const pinOwner = opts.hooked ? turnOwner(owner) : `view:${view}`;
      const prev = await this.engine.getMeta<ViewRow>(["view", view]);
      const p = await this.engine.pin({ owner: pinOwner, ttlMs: 7 * DAY });
      const nonce = printNonce();
      const header = renderRev({ ref: p.ref, branchId: p.branchId, nonce, by: this.opts.printedBy });
      const text = await this.codec.print(this.host.toProject(p.doc, await this.currentProject()), header.slice(REV_PREFIX.length));
      await this.install(rel, text, prev?.printGen ?? 0);
      // a print starts a new generation: late updates for an earlier save never reach this print's sidecar
      const row: ViewRow = { owner, pinOwner, header, nonce, printedAt: this.clock.now(), printGen: (prev?.printGen ?? 0) + 1, last: null, lastChange: null };
      await this.engine.putMeta(["view", view], row);
      return { name: view, path: rel, ref: refBodyOf(p) };
    });
  }

  private async writeSharedNow(cause: string, force = false): Promise<void> {
    await this.importUnseen(TIMELINE_FILE);
    await this.freezeOnCurrentCut();
    const pinned = this.freeze.active && this.freeze.view ? await this.engine.pin({ owner: "shared-view", doc: this.freeze.view, seq: this.freeze.baseSeq, causal: this.freeze.causal, ttlMs: 7 * DAY }) : await this.engine.pin({ owner: "shared-file", ttlMs: 7 * DAY });
    if (cause === "remote") this.lastRemoteRewrite = this.clock.now();
    const body = refBodyOf(pinned);
    const cur = await this.readFile(TIMELINE_FILE);
    if (!force && cur && cur.hash === this.lastInstall.get(TIMELINE_FILE)?.hash && this.sharedRef === body) return; // unchanged
    const header = renderRev({ ref: pinned.ref, branchId: pinned.branchId, nonce: printNonce(), by: this.opts.printedBy });
    const text = await this.codec.print(this.host.toProject(pinned.doc, await this.currentProject()), header.slice(REV_PREFIX.length));
    await this.install(TIMELINE_FILE, text);
    this.sharedRef = body; // only once installed: a failed rewrite must not read as done

    this.log.rewrites.push({ t: this.clock.now(), path: TIMELINE_FILE, cause, ref: body, frozen: this.freeze.active });
  }

  /** The project.json envelope of the file on disk (null if absent or unreadable). */
  private async readEnvelope(): Promise<Record<string, unknown> | null> {
    return (await this.envelopeFile())?.env ?? null;
  }
  /**
   * The file on disk: its envelope, content hash and stamp. project.json can be large (thumbnail id lists grow with
   * footage), so it is read, hashed and parsed again only when its stamp changed.
   */
  private async envelopeFile(): Promise<{ env: Record<string, unknown> | null; hash: string; stamp: string } | null> {
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
  private async projectSource(): Promise<{ env: Record<string, unknown> | null; overlay: Overlay | null }> {
    const overlay = (await this.engine.getMeta<Overlay>(["file", PROJECT_FILE, "overlay"])) ?? null;
    const f = await this.envelopeFile();
    const fileEnv = f?.env ?? null;
    if (!overlay) return { env: fileEnv, overlay: null };
    const consumed = await this.engine.getMeta<string>(["file", PROJECT_FILE, "consumed"]);
    if (consumed !== overlay.id) return { env: overlay.envelope, overlay };
    const ps = await this.pathState(PROJECT_FILE);
    const own = !!f && ps.written.some((w) => w.hash === f.hash && w.stamp === f.stamp);
    if (f && !own && BigInt(f.stamp.split(":")[2] ?? "0") < BigInt(overlay.mtimeNs ?? "0")) return { env: overlay.envelope, overlay };
    return { env: fileEnv ?? overlay.envelope, overlay };
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
    const head = await this.engine.head();
    const onDisk = await this.readEnvelope();
    const same = (x: unknown) => onDisk !== null && JSON.stringify(x) === JSON.stringify(onDisk);
    if (!fresh && this.projectPin && cur && same({ ...env, project: this.host.toProject(head, cur) })) return;
    await this.engine.release("project-file");
    const p = await this.engine.pin({ owner: "project-file", ttlMs: 7 * DAY });
    const body = refBodyOf(p);
    const next = this.host.toProject(p.doc, cur);
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
  private async install(rel: string, content: string, viewGen?: number): Promise<void> {
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
    await this.setLast(rel, hash);
    this.held.endRound();
    await this.reviewDisplaced();
  }

  // ------------------------------------------------------------------ what Carton knows about each path

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
  private async setLast(rel: string, hash: string): Promise<void> {
    const s = await this.pathState(rel);
    s.last = hash;
    await this.saveState(rel);
  }
  /** Content at the path that is the current generation already (installed, applied or tried): nothing to do. */
  private async isCurrent(rel: string, hash: string): Promise<boolean> {
    if ((await this.pathState(rel)).last !== hash) return false;
    return !(await this.unfinished(rel, hash));
  }
  /**
   * A save stored but not finished (it failed, or the process died, after its receipt): its attempt slot still holds
   * its result for these bytes, so a view's base and sidecar are still to be written. Such a save is read again (at
   * its path, or displaced) and finished from its recorded result. Not while it is being finished now (R7-01 reads the
   * path again).
   */
  private async unfinished(rel: string, hash: string): Promise<boolean> {
    if (this.applying.has(rel)) return false;
    const slot = await this.engine.getMeta<Attempt>(["attempt", rel]);
    return !!slot?.result && slot.hash === hash;
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

  /** The canonical relative path of a watched file, or null. */
  private watched(name: string): string | null {
    const n = this.opts.foldCase ? name.toLowerCase() : name;
    if (n === TIMELINE_FILE || n === PROJECT_FILE) return n;
    if (!n.startsWith(`${VIEWS_DIR}/`) || !n.endsWith(".tsx")) return null;
    const view = n.slice(VIEWS_DIR.length + 1, -4);
    return view && !view.includes("/") ? viewPath(view) : null;
  }

  private async readFile(rel: string): Promise<{ bytes: Buffer; hash: string; stamp: string } | null> {
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
    if (!f || (await this.isCurrent(rel, f.hash))) return;
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
          if (!f || (await this.isCurrent(rel, f.hash))) return;
          if (f.stamp !== stamp) return this.waitForQuiet(rel, f.stamp);
          if (await this.parses(rel, f.bytes)) return void (await this.readWithRetry(rel));
          await this.setLast(rel, f.hash); // reported once; the file stays where its writer put it
          this.log.unparsed.push({ t: this.clock.now(), path: rel });
          await this.engine.notice(await this.actorOf(rel), { kind: "error", text: `${rel} doesn't parse; kept, not applied` });
          await this.refuseView(rel, `${rel} doesn't parse; kept, not applied`);
        });
      }, this.opts.quietMs),
    );
  }

  /** A foreign save at `rel` that no watcher saw (written while the app was closed): applied before Carton writes it. */
  private async importUnseen(rel: string, o: { unparsed?: "wait" } = {}): Promise<void> {
    const f = await this.readFile(rel);
    if (!f || (await this.isCurrent(rel, f.hash))) return;
    if (!(await this.parses(rel, f.bytes))) {
      // a view: as at a watch event (re-read once quiet, then refused with its sidecar saying why). project.json and
      // the shared file are displaced by the install, then kept and reported if they never parse
      if (o.unparsed === "wait") this.waitForQuiet(rel, f.stamp);
      return;
    }
    this.log.imported.push({ t: this.clock.now(), path: rel });
    await this.applySave(rel, f.bytes, f.hash, f.stamp);
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
      const rel = this.watched(DisplacedFiles.tagOf(file) ?? "") ?? TIMELINE_FILE;
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
      if (ps.written.some((w) => w.hash === hash && w.stamp === stamp) || (ps.applied.includes(stamp) && !(await this.unfinished(rel, hash)))) {
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
    if ((d.stamp && ps.applied.includes(d.stamp) && !(await this.unfinished(d.rel, hash))) || ps.written.some((w) => w.hash === hash && w.stamp === d.stamp)) return done();
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
        const text = `${d.rel} (a save Carton moved aside) doesn't parse; kept in ${CARTON_DIR}/displaced, not applied`;
        await this.engine.notice(await this.actorOf(d.rel), { kind: "error", text });
        // a view's latest save that doesn't parse refuses the view, unless a newer print has already started over
        // (a file from an unknown print, recovered after a restart, counts as the latest)
        const name = viewName(d.rel);
        const row = name ? await this.engine.getMeta<ViewRow>(["view", name]) : undefined;
        if (name && row && (d.viewGen === undefined || d.viewGen === (row.printGen ?? 0))) await this.failView(name, row, { status: "error", error: text });
        // only now: if the notice or the refusal failed (and threw), the next review reports it again
        this.reportedPartials.add(d.path);
      }
      return;
    }
    if (await this.applySave(d.rel, d.bytes, hash, d.stamp, { fromDisplaced: true })) return done();
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
  private async applySave(rel: string, bytes: Buffer, hash: string, stamp: string | null, o: { fromDisplaced?: boolean } = {}): Promise<boolean> {
    const outer = !this.applying.has(rel);
    if (outer) this.applying.add(rel);
    try {
      return await this.applySaveNow(rel, bytes, hash, stamp, o);
    } finally {
      if (outer) this.applying.delete(rel);
    }
  }
  private async applySaveNow(rel: string, bytes: Buffer, hash: string, stamp: string | null, o: { fromDisplaced?: boolean }): Promise<boolean> {
    const ps = await this.pathState(rel);
    const failed = async () => {
      // tried and refused: the current generation at the path (if it is still there), and this file is never retried
      if (!o.fromDisplaced) ps.last = hash;
      if (stamp) push(ps.failed, stamp, KEEP_STAMPS);
      await this.saveState(rel);
      return false;
    };
    const text = bytes.toString("utf8");
    const actor = await this.actorOf(rel, true);
    const name = viewName(rel);
    const row = name ? await this.engine.getMeta<ViewRow>(["view", name]) : undefined;
    if (name && !row) {
      this.log.ignored.push({ t: this.clock.now(), path: rel, why: "never printed" }); // never applied without a print (R5-03)
      return failed();
    }
    const rev = rel === PROJECT_FILE ? null : (findRev(text)?.rev ?? null);
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
      if (name && row) await this.failView(name, row, { status: "error", error: msg, ref: rev?.kind === "carton" ? rev.ref : null });
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
      if (name && row) await this.failView(name, row, { status: "error", error: msg, ref: rev?.kind === "carton" ? rev.ref : null });
      return failed();
    }
    // a save already committed by an earlier attempt of this same file (a failure, or a crash, after its commit) is
    // finished below from its recorded result, even though its content now equals head
    const earlier = await this.engine.getMeta<Attempt>(["attempt", rel]);
    const resumed = !!earlier && earlier.gen === sha(`${stamp ?? ""}\n${hash}`).slice(0, 24);
    const asBase = !name && !resumed && sameDoc(saved, baseDoc);
    const asHead = !name && !resumed && !asBase && sameDoc(saved, await this.engine.head());
    if (asBase || asHead) {
      // nothing to version: the file shows the state its header names, or head itself (another materializer's install
      // of carton.db's state, a takeover helper's while it held the lease, B11/B3; or a save that changed nothing). No
      // commit, and no regeneration, which would answer one materializer's install with another's, back and forth.
      // project.json's own fields are still kept (its overlay). An agent saving head's content into a frozen shared
      // file has taken in what the freeze hid: the freeze view restarts from head, with head's whole causal past (a
      // merge into the old view without those changes' ids would map later saves through them again)
      if (rel === TIMELINE_FILE && asHead && this.freeze.active) await this.freezeOnCurrentCut(true);
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
    // the result. The slot is per path and bound to the file generation and the base, so it never answers for another save.
    const attemptKey = ["attempt", rel] as const;
    const gen = sha(`${stamp ?? ""}\n${hash}`).slice(0, 24);
    const baseKey = "baseDoc" in base ? `held:${base.baseSeq}:${base.causal.join(",")}:${row?.last?.contentHash ?? ""}` : base.kind === "carton" ? `ref:${base.ref} b:${base.branch8 ?? ""}` : `legacy:${base.rev}`;
    let slot = await this.engine.getMeta<Attempt>(attemptKey);
    // finishing a save stored before a failure (or crash): its view row may already name the save itself as the base
    const finishing = !!slot?.result && slot.gen === gen && slot.hash === hash && row?.last?.contentHash === hash;
    if (!slot || slot.gen !== gen || (slot.base !== baseKey && !finishing)) {
      const id = this.engine.newChangeId?.();
      slot = { gen, base: baseKey, hash, ...(id ? { id } : {}) };
      await this.engine.putMeta(attemptKey, slot);
    }
    const res = slot.result ?? (await this.engine.commit({ doc: saved, base, author: actor, meta: { file: rel, ...(name ? { view: name } : {}) }, ...(slot.id ? { id: slot.id } : {}) }));
    if (!slot.result && res.status !== "rejected") await this.engine.putMeta(attemptKey, { ...slot, result: res });
    const settle = async () => {
      // the save is finished: its slot (and the engine's record of its cards) can go. Never fatal: a leftover slot is
      // taken over by the path's next save
      try {
        await this.engine.putMeta(attemptKey, undefined);
        if (slot.id) await this.engine.putMeta(["attempt-cards", slot.id], undefined);
      } catch (e) {
        this.log.errors.push({ t: this.clock.now(), path: rel, error: `attempt cleanup: ${e instanceof Error ? e.message : String(e)}` });
      }
    };
    if (res.status === "rejected") {
      await this.engine.notice(actor, { kind: "error", text: `${rel}: rejected${res.reason ? `: ${res.reason}` : ""}; kept, not applied` });
      if (name && row) await this.failView(name, row, { status: "rejected", error: res.reason ?? "rejected", ref: rev?.kind === "carton" ? rev.ref : null });
      await settle();
      return failed();
    }
    if (rel === PROJECT_FILE) await this.storeOverlay(text, stamp);
    // Cards are data too: stored before the receipt, so a failure in between retries this file instead of deleting the
    // only copy of a save whose every edit carded. The id is stable for the same file, so a retry rewrites the same key.
    const cards = res.cards ?? [];
    const batch = cards.length ? { batch: res.id ?? `save-${sha(`${rel}\n${stamp ?? ""}\n${hash}`).slice(0, 20)}`, change: res.id ?? null, ...(slot.id ? { request: slot.id } : {}), file: rel, actor, cards, at: this.clock.now() } : null;
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
        this.freeze.view = this.host.merge3(baseDoc, this.freeze.view!, saved);
        if (res.id && !this.freeze.causal.includes(res.id)) this.freeze.causal.push(res.id);
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
    if (name && row) {
      // the saved content's causal past: its base's, plus this save's own change
      if (rev?.kind === "carton" && rev.nonce === row.nonce) row.last = { contentHash: hash, nonce: row.nonce, held: { baseDoc: saved, baseSeq: held.baseSeq, causal: res.id && !held.causal.includes(res.id) ? [...held.causal, res.id] : held.causal } };
      row.lastChange = res.id ?? null;
      await this.engine.putMeta(["view", name], row);
      const head = await this.engine.head();
      const status: StatusBody["status"] = cards.length ? "conflicts" : res.status;
      const pinned = await this.engine.pin({ owner: row.pinOwner, ttlMs: 7 * DAY });
      await this.writeStatus(name, { status, seq: res.seq ?? null, conflicts: cards, diagnostics: this.host.diagnose(saved, head), ref: refBodyOf(pinned), ...(res.reason ? { error: res.reason } : {}) }, res.id ?? null, { immediate: true });
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

  /** A view file's content was refused before any save was attempted (it never parsed). */
  private async refuseView(rel: string, error: string): Promise<void> {
    const name = viewName(rel);
    const row = name ? await this.engine.getMeta<ViewRow>(["view", name]) : undefined;
    if (name && row) await this.failView(name, row, { status: "error", error });
  }

  /** A refused view save: its sidecar says so, and late updates for any earlier save no longer reach it. */
  private async failView(name: string, row: ViewRow, s: Partial<StatusBody> & { status: StatusBody["status"] }): Promise<void> {
    row.lastChange = null;
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

/** The pin owner of a hooked agent's turn. */
export const turnOwner = (a: Actor): string => `turn:${a.turn ?? a.id}`;

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
