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
//   .carton/displaced/        what Carton moved off a path; held until reviewed (P10 settle-2)
//
// Every Carton write to a watched path goes through `displaceThenInstall`, so Carton never destroys a file it hasn't
// seen. A foreign save is read on every watch event and applied at once when it parses; content that doesn't parse
// yet (an in-place writer mid-write) waits for 150 ms of quiet, and a file that never parses is kept and reported.
//
// All work runs one task at a time (the engine thread's order), so two saves never interleave.
import fs from "node:fs";
import path from "node:path";
import { createHash, randomBytes } from "node:crypto";
import type { Actor, ConflictCard, Doc } from "@carton/core";
import { displaceThenInstall, hardLinksWork, retryBusy, stampOf, statStamp, type BusyCounter } from "./displace.ts";
import { DisplacedFiles, type OwnInstall } from "./displaced.ts";
import { findRev, renderRev, printNonce, type Rev } from "../header.ts";
import type { Project, TimelineCodec } from "../codec.ts";

export const PROJECT_FILE = "project.json";
export const TIMELINE_FILE = "timeline.tsx";
export const VIEWS_DIR = ".scratch/views";
export const CARTON_DIR = ".carton";
export const viewPath = (name: string): string => `${VIEWS_DIR}/${name}.tsx`;
export const statusPath = (name: string): string => `${VIEWS_DIR}/${name}.status`;
const DAY = 86_400_000;

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

/** What the materializer needs from the engine. `@carton/local` implements it over `Carton` and carton.db. */
export interface MaterializerEngine {
  /** The current cut's optimistic head. */
  head(): Promise<Doc>;
  /** Pins the head, or `doc` (a state not in the log: the freeze view), for `owner`. `ref` is the printable token. */
  pin(opts: { owner: string; doc?: Doc; ttlMs: number }): Promise<{ ref: string; branchId: string; doc: Doc }>;
  /** Releases every pin `owner` holds (a turn ended). */
  release(owner: string): Promise<void>;
  /** A printed ref -> its exact state and causal past. Throws "state unknown: re-print" when it can't (§4.4). */
  resolve(rev: Rev): Promise<HeldBase>;
  /** Commits `doc` made on `base`; cards keep head's value and are reported (late conflicts arrive as notices). */
  commit(input: { doc: Doc; base: Rev | HeldBase; author: Actor; meta: { file: string; view?: string } }): Promise<SaveResult>;
  notice(to: Actor, notice: { kind: "error" | "conflicts"; text: string; change?: string }): Promise<void>;
  /** Local metadata (carton.db's `views` table), shared by every process on this machine. */
  getMeta<T>(key: readonly string[]): Promise<T | undefined>;
  putMeta(key: readonly string[], value: unknown): Promise<void>;
  /** Whether the current cut is shared (remote rewrites of the shared file are rate-limited). */
  shared(): boolean;
}

/** The host's document conversions the materializer needs (Cardboard's are in `@carton/cardboard`). */
export interface MaterializerHost {
  /** A parsed project -> engine doc, keyed against `base` (LCS move recovery). */
  fromProject(project: Project, base: Doc | null): Doc;
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
  /** Write project.json as a view of head (H1). Off when the host writes it itself. */
  writeProject?: boolean;
}

export interface ViewRow {
  /** Who printed it: the turn's actor for hooked agents, otherwise the view's own name. */
  owner: Actor;
  pinOwner: string;
  header: string;
  nonce: string;
  printedAt: number;
  /** The last applied save of this print: its parsed state, the base of the next save with the same nonce. */
  last?: { contentHash: string; nonce: string; held: HeldBase } | null;
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

type Record_ = { t: number; path: string; [k: string]: unknown };

const sha = (b: Uint8Array | string): string => createHash("sha256").update(b).digest("hex");
// Windows and macOS file systems are case-insensitive: an agent's `Timeline.tsx` is our `timeline.tsx`.
const FOLD_CASE = process.platform === "win32" || process.platform === "darwin";
const SEEN_KEEP = 32;

export class Materializer {
  readonly bundle: string;
  private readonly engine: MaterializerEngine;
  private readonly host: MaterializerHost;
  private readonly codec: TimelineCodec;
  private readonly clock: Clock;
  private readonly opts: Required<Omit<MaterializerOptions, "bundle" | "engine" | "host" | "codec" | "clock">>;
  private readonly held: DisplacedFiles;
  private readonly tmpDir: string;
  private readonly noLinks: boolean;
  private readonly busy: BusyCounter = {};
  private queue: Promise<unknown> = Promise.resolve();
  private tmpSeq = 0;
  private readonly tmpTag = randomBytes(4).toString("hex");
  private envelopeCache: { stamp: string; env: Record<string, unknown> | null } | null = null;
  /** Content hashes Carton wrote or applied, per path: anything else at a watched path is an unseen foreign save. */
  private readonly seen = new Map<string, string[]>();
  private readonly lastInstall = new Map<string, OwnInstall & { hash: string }>();
  /** Displaced foreign files that don't parse (yet): re-read when their stamp changes. */
  private readonly partials = new Map<string, { rel: string; stamp: string | null; mtimeNs: bigint }>();
  /** Where each held displaced file came from. */
  private readonly origin = new Map<string, { rel: string; mtimeNs: bigint }>();
  private readonly quietTimers = new Map<string, unknown>();
  private reviewTimer: unknown = null;
  private watchers: fs.FSWatcher[] = [];
  private closed = false;

  // freeze (§6.4): the shared file isn't rewritten for non-agent changes while a local agent is active
  readonly freeze = { hooked: new Map<string, Actor>(), lastForeign: -Infinity, lastCb: -Infinity, active: false, view: null as Doc | null, timer: null as unknown };
  private sharedRef: string | null = null;
  private lastRemoteRewrite = -Infinity;
  private remoteTimer: unknown = null;
  private localTimer: unknown = null;
  private projectTimer: unknown = null;
  private projectPin: string | null = null;

  /** What happened, for tests and the activity log (never file contents). */
  readonly log = { eexist: 0, errors: [] as Record_[], kept: [] as Record_[], applied: [] as Record_[], displaced: [] as Record_[], unparsed: [] as Record_[], imported: [] as Record_[], rewrites: [] as Record_[], ignored: [] as Record_[] };

  constructor(o: MaterializerOptions) {
    this.bundle = path.resolve(o.bundle);
    this.engine = o.engine;
    this.host = o.host;
    this.codec = o.codec;
    this.clock = o.clock ?? realClock;
    this.opts = {
      printedBy: o.printedBy ?? "carton",
      quietMs: o.quietMs ?? 150,
      localRewriteMs: o.localRewriteMs ?? 20,
      remoteRewriteMs: o.remoteRewriteMs ?? 30_000,
      freezeIdleMs: o.freezeIdleMs ?? 60_000,
      writeProject: o.writeProject ?? true,
    };
    const carton = path.join(this.bundle, CARTON_DIR);
    this.tmpDir = path.join(carton, "tmp");
    fs.mkdirSync(this.tmpDir, { recursive: true });
    fs.mkdirSync(path.join(this.bundle, VIEWS_DIR), { recursive: true });
    this.held = new DisplacedFiles(path.join(carton, "displaced"), { now: () => this.clock.now(), quietMs: this.opts.quietMs, holdMs: this.opts.quietMs, counter: this.busy });
    this.noLinks = !hardLinksWork(this.bundle);
  }

  // ------------------------------------------------------------------ lifecycle

  /** Imports saves made while nobody watched, then writes the shared file (and project.json) from head. */
  start(): Promise<void> {
    return this.run(async () => {
      if (this.opts.writeProject) await this.writeProjectNow("start");
      await this.writeSharedNow("start");
    });
  }

  /**
   * Marks what is on disk now as seen without applying it: after importing an existing project as `main@1` (§16), its
   * project.json and timeline.tsx are that state, not foreign saves.
   */
  adoptCurrentFiles(): Promise<void> {
    return this.run(async () => {
      for (const rel of [PROJECT_FILE, TIMELINE_FILE]) {
        const f = this.readFile(rel);
        if (f) await this.markSeen(rel, f.hash);
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

  /** Waits for queued work, final review of displaced files, stops timers and watchers. */
  async close(): Promise<void> {
    this.closed = true;
    for (const w of this.watchers) w.close();
    this.watchers = [];
    for (const t of [this.reviewTimer, this.remoteTimer, this.localTimer, this.projectTimer, this.freeze.timer, ...this.quietTimers.values()]) if (t) this.clock.clearTimeout(t);
    await this.queue;
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
    if (this.opts.writeProject && !this.projectTimer)
      this.projectTimer = this.clock.setTimeout(() => {
        this.projectTimer = null;
        this.fire(() => this.writeProjectNow(cause));
      }, this.opts.localRewriteMs);
    if (this.freeze.active) return;
    if (cause === "remote" && this.engine.shared()) {
      if (this.remoteTimer) return;
      const at = Math.max(this.clock.now(), this.lastRemoteRewrite + this.opts.remoteRewriteMs);
      this.remoteTimer = this.clock.setTimeout(() => {
        this.remoteTimer = null;
        this.fire(async () => {
          if (!this.freeze.active) await this.writeSharedNow("remote");
        });
      }, at - this.clock.now());
      return;
    }
    if (this.localTimer) return;
    this.localTimer = this.clock.setTimeout(() => {
      this.localTimer = null;
      this.fire(async () => {
        if (!this.freeze.active) await this.writeSharedNow(cause);
      });
    }, this.opts.localRewriteMs);
  }

  private frozenNow(): boolean {
    return this.freeze.hooked.size > 0 || this.clock.now() < Math.max(this.freeze.lastForeign, this.freeze.lastCb) + this.opts.freezeIdleMs;
  }
  private async updateFreeze(): Promise<void> {
    const f = this.frozenNow();
    if (f && !this.freeze.active) {
      this.freeze.active = true;
      this.freeze.view = this.sharedRef ? (await this.resolveOrNull(this.sharedRef)) ?? (await this.engine.head()) : await this.engine.head();
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
  private async resolveOrNull(ref: string): Promise<Doc | null> {
    const rev = findRev(`// cardboard:rev ${ref}`)?.rev;
    if (!rev) return null;
    try {
      return (await this.engine.resolve(rev)).baseDoc;
    } catch {
      return null;
    }
  }

  // ------------------------------------------------------------------ Carton's writes

  /** `cb source print` with the app open: the shared file shows head; a freeze view restarts from it. */
  printShared(): Promise<string> {
    return this.run(async () => {
      if (this.freeze.active) this.freeze.view = await this.engine.head();
      await this.writeSharedNow("print", true);
      return this.sharedRef!;
    });
  }

  /**
   * `cb source print --view <name>`: pins head for its owner, prints the view with a new nonce (displacing an unapplied
   * save, which is applied first), and records the print.
   */
  printView(name: string, owner: Actor, opts: { hooked?: boolean } = {}): Promise<{ name: string; path: string; ref: string }> {
    return this.run(async () => {
      if (!/^[A-Za-z0-9._-]+$/.test(name)) throw new Error(`invalid view name ${JSON.stringify(name)}`);
      const rel = viewPath(name);
      await this.importUnseen(rel);
      const pinOwner = opts.hooked ? turnOwner(owner) : `view:${name}`;
      const { ref, branchId, doc } = await this.engine.pin({ owner: pinOwner, ttlMs: 7 * DAY });
      const nonce = printNonce();
      const header = renderRev({ ref, branchId, nonce, by: this.opts.printedBy });
      const text = await this.codec.print(this.host.toProject(doc, await this.currentProject()), header.slice("// cardboard:rev ".length));
      await this.install(rel, text);
      const row: ViewRow = { owner, pinOwner, header, nonce, printedAt: this.clock.now(), last: null, lastChange: null };
      await this.engine.putMeta(["view", name], row);
      return { name, path: rel, ref };
    });
  }

  private async writeSharedNow(cause: string, force = false): Promise<void> {
    await this.importUnseen(TIMELINE_FILE);
    const pinned = this.freeze.active && this.freeze.view ? await this.engine.pin({ owner: "shared-view", doc: this.freeze.view, ttlMs: 7 * DAY }) : await this.engine.pin({ owner: "shared-file", ttlMs: 7 * DAY });
    if (cause === "remote") this.lastRemoteRewrite = this.clock.now();
    const cur = this.readFile(TIMELINE_FILE);
    if (!force && cur && cur.hash === this.lastInstall.get(TIMELINE_FILE)?.hash && this.sharedRef === pinned.ref) return; // unchanged
    const header = renderRev({ ref: pinned.ref, branchId: pinned.branchId, nonce: printNonce(), by: this.opts.printedBy });
    const text = await this.codec.print(this.host.toProject(pinned.doc, await this.currentProject()), header.slice("// cardboard:rev ".length));
    this.sharedRef = pinned.ref;
    await this.install(TIMELINE_FILE, text);
    this.log.rewrites.push({ t: this.clock.now(), path: TIMELINE_FILE, cause, ref: pinned.ref, frozen: this.freeze.active });
  }

  /** The project.json envelope of the file on disk (null if absent or unreadable). */
  private readEnvelope(): Record<string, unknown> | null {
    // project.json can be large (thumbnail id lists grow with footage): parse it again only when its stamp changed
    const stamp = statStamp(this.abs(PROJECT_FILE));
    if (stamp === null) return null;
    if (this.envelopeCache?.stamp === stamp) return this.envelopeCache.env;
    const f = this.readFile(PROJECT_FILE);
    if (!f) return null;
    let env: Record<string, unknown> | null = null;
    try {
      const v = JSON.parse(f.bytes.toString("utf8")) as Record<string, unknown>;
      env = v && typeof v === "object" ? v : null;
    } catch {
      env = null;
    }
    this.envelopeCache = { stamp: f.stamp, env };
    return env;
  }
  private async currentProject(): Promise<Project | null> {
    return (this.readEnvelope()?.project as Project | undefined) ?? null;
  }

  private async writeProjectNow(cause: string): Promise<void> {
    await this.importUnseen(PROJECT_FILE);
    const env = this.readEnvelope() ?? { format: "cardboard-project", version: 1, media: [] };
    const cur = (env.project as Project | undefined) ?? null;
    const { ref, doc } = await this.engine.pin({ owner: "project-file", ttlMs: 7 * DAY });
    if (this.projectPin === ref && cur) return;
    const next = this.host.toProject(doc, cur);
    if (cur && JSON.stringify(next) === JSON.stringify(cur)) {
      this.projectPin = ref;
      return;
    }
    // 1.4.0's rev: stateUpdatedAt is forced monotonic, max(now, prev + 1) (writeTimeline)
    const prev = typeof cur?.stateUpdatedAt === "number" ? cur.stateUpdatedAt : 0;
    const now = this.clock.now();
    const project = { ...next, stateUpdatedAt: Math.max(now, prev + 1), updatedAt: new Date(now).toISOString() };
    await this.install(PROJECT_FILE, JSON.stringify({ ...env, project }, null, 2));
    this.projectPin = ref;
    await this.engine.putMeta(["file", PROJECT_FILE, "pin"], ref);
    this.log.rewrites.push({ t: now, path: PROJECT_FILE, cause, ref });
  }

  /** Displace, then install: never replaces a name, so a foreign save at `rel` is moved aside and imported. */
  private async install(rel: string, content: string): Promise<void> {
    const target = this.abs(rel);
    const bytes = Buffer.from(content, "utf8");
    const tmp = path.join(this.tmpDir, `${path.basename(rel)}.${this.tmpTag}.${this.tmpSeq++}`);
    fs.writeFileSync(tmp, bytes, { flag: "wx" });
    const r = displaceThenInstall(target, tmp, this.held.next, { counter: this.busy, noLinks: this.noLinks, lastStamp: this.lastInstall.get(rel)?.stamp ?? null });
    const stamp = statStamp(target);
    for (const d of r.displaced) {
      let mtimeNs = 0n;
      try {
        mtimeNs = fs.statSync(d, { bigint: true }).mtimeNs;
      } catch {
        // already gone: reviewed by an earlier round
      }
      this.origin.set(d, { rel, mtimeNs });
    }
    this.held.hold(r.displaced, this.lastInstall.get(rel) ?? null);
    if (r.eexist) this.log.eexist += r.eexist;
    if (stamp) this.lastInstall.set(rel, { bytes, stamp, hash: sha(bytes) });
    await this.markSeen(rel, sha(bytes));
    this.held.endRound();
    await this.reviewDisplaced();
  }

  // ------------------------------------------------------------------ foreign saves

  /** A watch event for `rel` (relative, `/`-separated). Reads whatever is at the path now. */
  onFsEvent(name: string): void {
    const rel = this.watched(name);
    if (this.closed || !rel) return;
    this.fire(() => this.readEvent(rel));
  }

  /** The canonical relative path of a watched file, or null. */
  private watched(name: string): string | null {
    const n = FOLD_CASE ? name.toLowerCase() : name;
    if (n === TIMELINE_FILE || n === PROJECT_FILE) return n;
    if (!n.startsWith(`${VIEWS_DIR}/`) || !n.endsWith(".tsx")) return null;
    const view = name.slice(VIEWS_DIR.length + 1, -4);
    return view && !view.includes("/") ? viewPath(view) : null;
  }

  private readFile(rel: string): { bytes: Buffer; hash: string; stamp: string } | null {
    const p = this.abs(rel);
    try {
      const bytes = retryBusy(() => fs.readFileSync(p), this.busy);
      const stamp = stampOf(fs.statSync(p, { bigint: true }));
      return { bytes, hash: sha(bytes), stamp };
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code === "ENOENT" || code === "EISDIR") return null; // mid-install, or gone
      throw e;
    }
  }

  private isSeen(rel: string, hash: string): boolean {
    return this.seen.get(rel)?.includes(hash) ?? false;
  }
  /** Applied, written by Carton, or already tried and reported: nothing more to do for this content at `rel`. */
  private isKnown(rel: string, hash: string): boolean {
    return this.isSeen(rel, hash) || this.isSeen(rel, `failed:${hash}`);
  }
  private async loadSeen(rel: string): Promise<string[]> {
    let s = this.seen.get(rel);
    if (!s) {
      s = (await this.engine.getMeta<string[]>(["file", rel, "seen"])) ?? [];
      this.seen.set(rel, s);
    }
    return s;
  }
  private async markSeen(rel: string, hash: string): Promise<void> {
    const s = await this.loadSeen(rel);
    if (s.includes(hash)) return;
    s.push(hash);
    if (s.length > SEEN_KEEP) s.splice(0, s.length - SEEN_KEEP);
    await this.engine.putMeta(["file", rel, "seen"], s);
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
    await this.loadSeen(rel);
    const f = this.readFile(rel);
    if (!f || this.isKnown(rel, f.hash)) return;
    if (rel === TIMELINE_FILE) {
      this.freeze.lastForeign = this.clock.now();
      await this.updateFreeze();
    }
    await this.flushHeld(rel); // displaced saves of this path were written earlier: they go first
    if (await this.parses(rel, f.bytes)) {
      await this.applySave(rel, f.bytes, f.hash);
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
          const f = this.readFile(rel);
          if (!f || this.isKnown(rel, f.hash)) return;
          if (f.stamp !== stamp) return this.waitForQuiet(rel, f.stamp);
          if (await this.parses(rel, f.bytes)) return void (await this.applySave(rel, f.bytes, f.hash));
          await this.markSeen(rel, `failed:${f.hash}`); // reported once; the file stays where its writer put it
          this.log.unparsed.push({ t: this.clock.now(), path: rel });
          await this.engine.notice(await this.actorOf(rel), { kind: "error", text: `${rel} doesn't parse; kept, not applied` });
        });
      }, this.opts.quietMs),
    );
  }

  /** A foreign save at `rel` that no watcher saw (written while the app was closed): applied before Carton writes it. */
  private async importUnseen(rel: string): Promise<void> {
    await this.loadSeen(rel);
    const f = this.readFile(rel);
    if (!f || this.isKnown(rel, f.hash)) return;
    if (!(await this.parses(rel, f.bytes))) return; // displaced by the install, then kept and reported if it never parses
    this.log.imported.push({ t: this.clock.now(), path: rel });
    await this.applySave(rel, f.bytes, f.hash);
  }

  /**
   * Reviews held displaced files: deletes Carton's own (bytes and stamp unchanged after the hold), applies foreign
   * saves in the order they were written, and keeps foreign files that don't parse, telling their writer once.
   */
  private async reviewDisplaced(): Promise<void> {
    const r = this.held.review(() => true); // parsing may be async (an injected codec): checked below
    const found: { path: string; bytes: Buffer; rel: string; mtimeNs: bigint }[] = r.foreign.map((d) => {
      const o = this.origin.get(d.path);
      this.origin.delete(d.path);
      return { path: d.path, bytes: d.bytes, rel: o?.rel ?? TIMELINE_FILE, mtimeNs: o?.mtimeNs ?? 0n };
    });
    for (const [p, q] of this.partials) {
      const stamp = statStamp(p);
      if (stamp === null) this.partials.delete(p);
      else if (stamp !== q.stamp) {
        this.partials.delete(p);
        found.push({ path: p, bytes: retryBusy(() => fs.readFileSync(p), this.busy), rel: q.rel, mtimeNs: q.mtimeNs });
      }
    }
    found.sort((a, b) => (a.mtimeNs < b.mtimeNs ? -1 : a.mtimeNs > b.mtimeNs ? 1 : 0));
    for (const d of found) {
      const hash = sha(d.bytes);
      if (!this.partials.has(d.path) && !this.isKnown(d.rel, hash)) this.log.displaced.push({ t: this.clock.now(), path: d.rel });
      if (this.isSeen(d.rel, hash)) {
        this.held.release(d.path); // already applied (or Carton's own bytes): a copy
        continue;
      }
      if (this.isSeen(d.rel, `failed:${hash}`)) {
        this.log.kept.push({ t: this.clock.now(), path: d.rel, file: path.basename(d.path) }); // tried and reported: kept
        continue;
      }
      if (!(await this.parses(d.rel, d.bytes))) {
        // the in-place writer's half-written file: kept on disk; its writer is told once; imported if it completes
        const first = !this.partials.has(d.path);
        this.partials.set(d.path, { rel: d.rel, stamp: statStamp(d.path), mtimeNs: d.mtimeNs });
        if (first && !this.isSeen(d.rel, `partial:${hash}`)) {
          await this.markSeen(d.rel, `partial:${hash}`);
          this.log.unparsed.push({ t: this.clock.now(), path: d.rel, displaced: true });
          await this.engine.notice(await this.actorOf(d.rel), { kind: "error", text: `${d.rel} (a save Carton moved aside) doesn't parse; kept in ${CARTON_DIR}/displaced, not applied` });
        }
        continue;
      }
      // a save that couldn't be applied (unknown base, never printed) stays in .carton/displaced: never destroyed
      if (await this.applySave(d.rel, d.bytes, hash)) this.held.release(d.path);
      else this.log.kept.push({ t: this.clock.now(), path: d.rel, file: path.basename(d.path) });
    }
    // own installs wait out their hold; partials are only re-checked now and then
    const delay = this.held.size ? this.opts.quietMs : this.partials.size ? 5_000 : 0;
    if (delay && !this.reviewTimer && !this.closed)
      this.reviewTimer = this.clock.setTimeout(() => {
        this.reviewTimer = null;
        this.fire(() => this.reviewDisplaced());
      }, delay);
  }
  private async flushHeld(rel: string): Promise<void> {
    if (![...this.origin.values()].some((o) => o.rel === rel) && ![...this.partials.values()].some((o) => o.rel === rel)) return;
    await this.reviewDisplaced();
  }

  private async actorOf(rel: string): Promise<Actor> {
    const name = viewName(rel);
    if (name) {
      const row = await this.engine.getMeta<ViewRow>(["view", name]);
      if (row) return row.owner;
    }
    return { kind: "external", id: `external:${rel}`, name: rel };
  }

  /** Applies a foreign save. Returns false when it couldn't be (no print, unknown base, doesn't parse): keep its bytes. */
  private async applySave(rel: string, bytes: Buffer, hash: string): Promise<boolean> {
    const failed = async () => {
      await this.markSeen(rel, `failed:${hash}`);
      return false;
    };
    const text = bytes.toString("utf8");
    const actor = await this.actorOf(rel);
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
        const prev = pin ? findRev(`// cardboard:rev ${pin}`)?.rev : null;
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
      const msg = (e as Error).message;
      await this.engine.notice(actor, { kind: "error", text: msg });
      if (name) await this.writeStatus(name, { status: "error", error: msg, ref: rev?.kind === "carton" ? rev.ref : null }, null);
      this.log.applied.push({ t: this.clock.now(), path: rel, error: msg });
      return failed();
    }
    const baseDoc = held.baseDoc;
    let saved: Doc;
    try {
      saved = this.host.fromProject(await this.parseSave(rel, text), baseDoc);
    } catch (e) {
      this.log.unparsed.push({ t: this.clock.now(), path: rel });
      await this.engine.notice(actor, { kind: "error", text: `${rel} doesn't parse; kept, not applied: ${(e as Error).message}` });
      return failed();
    }
    const res = await this.engine.commit({ doc: saved, base, author: actor, meta: { file: rel, ...(name ? { view: name } : {}) } });
    if (res.status === "rejected") {
      await this.engine.notice(actor, { kind: "error", text: `${rel}: rejected${res.reason ? `: ${res.reason}` : ""}; kept, not applied` });
      if (name) await this.writeStatus(name, { status: "rejected", error: res.reason ?? "rejected", ref: rev?.kind === "carton" ? rev.ref : null }, null);
      return failed();
    }
    await this.markSeen(rel, hash); // before the regeneration below reads the path again
    const cards = res.cards ?? [];
    this.log.applied.push({ t: this.clock.now(), path: rel, id: res.id ?? null, status: res.status, cards: cards.length, actor: actor.id, hash });
    if (rel === TIMELINE_FILE) {
      if (this.freeze.active && this.freeze.view) {
        // R8-01: the freeze view gathers every local agent's applied saves, each merged with that save's own base
        this.freeze.view = this.host.merge3(baseDoc, this.freeze.view, saved);
      }
      // R7-01: regenerate after every applied save, so the base of any later save is that save's own header ref
      await this.writeSharedNow("save");
    } else if (name && row) {
      // the saved content's causal past: its base's, plus this save's own change
      if (rev?.kind === "carton" && rev.nonce === row.nonce) row.last = { contentHash: hash, nonce: row.nonce, held: { baseDoc: saved, baseSeq: held.baseSeq, causal: res.id ? [...held.causal, res.id] : held.causal } };
      row.lastChange = res.id ?? null;
      await this.engine.putMeta(["view", name], row);
      const head = await this.engine.head();
      const status: StatusBody["status"] = cards.length ? "conflicts" : res.status;
      const pinned = await this.engine.pin({ owner: row.pinOwner, ttlMs: 7 * DAY });
      await this.writeStatus(name, { status, seq: res.seq ?? null, conflicts: cards, diagnostics: this.host.diagnose(saved, head), ref: pinned.ref, ...(res.reason ? { error: res.reason } : {}) }, res.id ?? null);
    }
    this.onHeadChange("local");
    return true;
  }

  // ------------------------------------------------------------------ status sidecar (R5-04)

  /**
   * Writes `.scratch/views/<name>.status` after each apply, and when that change's state changes later (confirmed,
   * late conflicts: call `onChangeUpdate`). An update for an older save of the view never overwrites a newer one.
   */
  private async writeStatus(name: string, s: Partial<StatusBody> & { status: StatusBody["status"] }, changeId: string | null): Promise<void> {
    const row = await this.engine.getMeta<ViewRow>(["view", name]);
    if (changeId && row?.lastChange && row.lastChange !== changeId) return;
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
    retryBusy(() => fs.renameSync(tmp, file), this.busy);
  }

  /** A view's change was confirmed, or came back with late conflicts: its sidecar follows. */
  onChangeUpdate(view: string, changeId: string, s: { status: "confirmed" | "conflicts" | "rejected"; seq?: number; conflicts?: ConflictCard[]; ref?: string; reason?: string }): Promise<void> {
    return this.run(() => this.writeStatus(view, { status: s.status, seq: s.seq ?? null, conflicts: s.conflicts ?? [], ref: s.ref ?? null, ...(s.reason ? { error: s.reason } : {}) }, changeId));
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
