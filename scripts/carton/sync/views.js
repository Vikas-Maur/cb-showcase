// H8: per-agent views and the shared timeline.tsx's freeze in the library worker (PLAN §6.4; carton/docs/INTEGRATION-
// 1.4.0.md H8). build.js bundles this file into carton-node.cjs with the rest of scripts/carton/sync; it registers with
// the facade's extend() and only does anything in the library worker, with Carton on.
//
// For each project the worker opens with history (the library's own bundles, never Open Project's staging copy), a
// View runs cardboard-adapter's Materializer (@carton/cardboard/node) on the worker's own Carton handle:
// - timeline.tsx is the Materializer's from then on: it prints it from head under Carton's rev line
//   (`<cut>@<seq>~<hash8> b:<cut8> p:<nonce> by carton`) with Cardboard's own printer (the codec the store bridge puts
//   in globalThis.__cartonTimelineCodec), and freezes it while an agent works (§6.4): a hooked agent from its first read
//   or `cb` call until its Stop, a windowless agent until a minute after its last `cb` call or save. The person's GUI
//   edits, cb's writes and teammates' changes go on into head and project.json meanwhile; the agent's own saves are the
//   only ones the frozen file takes in (R8-01). Cardboard's own regeneration of it (its mirror) and its watcher's apply
//   are handed over to the Materializer (the facade's install and the watcher patch ask ownsTimeline/timelineEvent).
// - `cb source print --view <name>` (local-cli's printView write) prints an agent's own copy in .scratch/views/, and
//   each save of it (seen by polling the printed views: a watcher's handle inside the bundle would stop Cardboard
//   moving it to the trash or renaming it on Windows) is applied as that agent's change, with a `<name>.status` sidecar
//   the agent reads (confirmed,
//   conflicts, rejected, with the cards and the diagnostics). A clash is a card for the agent (`cb conflicts`, the Stop
//   hook) and for the person (onCards: the History panel's cards).
// - project.json stays the facade's (H1, through Cardboard's own store): the Materializer runs with writeProject off,
//   and every change that didn't come through the GUI's save (a view's save, a cb write, another process's or a
//   teammate's change) goes into it with the facade's materialize, so the pages adopt it.
// - The View's holder is the project's one Carton lease holder in this worker (@carton/local's keepLease around a
//   CartonHolderEngine with the Materializer as its printer), so cb's writes and hook events reach the Materializer.
//   Live sync (live.js) uses this holder for a shared project instead of keeping a lease of its own; the holder
//   connects sync only once Live runs (an unshared project has nothing to connect to).
// - An agent's own `cb` write during a freeze shows in the frozen timeline.tsx at once, as with 1.4.0 (the Materializer's
//   foldAgentChanges, whatever told it of head: this holder's write, local's follower, a confirmation); the person's
//   and remote changes stay out until the freeze ends. Read-your-writes (apply-ryw): the `cb` write answers only once
//   the file shows it: cb asks this holder (`carton.shown`), which looks at carton.db at once and answers with the
//   Materializer's print (`showChange`). A terminal's cb (`onCb(caller)`) reads its own writes in the file it holds.
// - The person's GUI save: head moves in the save, and the store writes project.json after it. The facade tells the
//   Materializer so (onHeadChange("gui", { after }), the extension's hostWrite): its rewrites wait for that write, and
//   take project.json's envelope and stamp from it instead of reading the file again.
// - Old prints: a timeline.tsx or view printed by Cardboard 1.4.0 carries a bare `stateUpdatedAt` rev. The facade
//   maps each one it wrote to its state (`views` table `["rev", ms]`); the engine wrapper resolves them there, so such
//   a file applies as an edit of that state instead of being refused ("state unknown: re-print").
import fs from "node:fs";
import path from "node:path";
import { extend } from "../carton-node.js";
import { cardboardFilesHost } from "@carton/cardboard";
import { Materializer, CARTON_DIR, VIEWS_DIR, TIMELINE_FILE } from "@carton/cardboard/node";
import { keepLease, holderSocketPath, CartonHolderEngine, cartonMaterializerEngine, preToolUse, parseActorId, fence, nextChangeId, localGroup } from "@carton/local";
import { caughtUp } from "./live.js";
import { cutOfChange } from "./view-cards.js";

const MATERIALIZE_MS = 40;
// How often the views Carton printed are checked for a save (a stat each; nothing when there are none).
const POLL_MS = 250;
// How long a view save on a shared cut waits for this worker to hold the lease again (#mayCommit).
const LEASE_WAIT_MS = 5000;
const errText = (e) => (e && e.message) || String(e);
const warned = new Set();
const warnOnce = (key, msg) => { if (!warned.has(key)) { warned.add(key); console.warn("[carton] " + msg); } };
// Bundle paths as keys: the file system's case on Windows and macOS.
const fold = process.platform === "win32" || process.platform === "darwin";
const keyOf = (p) => { const r = path.resolve(p); return fold ? r.toLowerCase() : r; };

const views = new Map(); // key → Promise<View | null>
const paths = new Map(); // key → the bundle path a View is for, from its start (release() reads it before it runs)
const running = new Map(); // key → View, once started (the facade asks synchronously)

/**
 * The engine the Materializer gets: cardboard-adapter's cartonMaterializerEngine (cards for invalid records, a shared
 * cut read as shared), plus 1.4.0's numbered revs through the facade's map. A save that landed is in project.json (so in the app)
 * before the Materializer answers it in the view's `.status`: an agent that reads "confirmed" finds it everywhere.
 * Anything else goes to the inner engine as it is.
 */
function engineFor(inner, lc, landed, mayCommit, failed) {
  const old = async (rev) => {
    const ref = await lc.store.get("views", ["rev", Number(rev)]);
    if (!ref) return null;
    const r = await lc.carton.resolve(ref);
    return { baseDoc: r.doc, baseSeq: r.seq, causal: r.causal ?? [] };
  };
  return new Proxy(inner, {
    get(t, k) {
      if (k === "resolve") return async (rev) => (rev?.kind === "legacy" && (await old(rev.rev))) || t.resolve(rev);
      if (k === "commit") {
        return async (input) => {
          await mayCommit(input.meta?.file);
          let r;
          try {
            r = await t.commit(input.base?.kind === "legacy" ? { ...input, base: (await old(input.base.rev)) ?? input.base } : input);
          } catch (e) {
            failed(input.meta?.file);
            throw e;
          }
          if (r?.status && r.status !== "rejected") await landed();
          return r;
        };
      }
      const v = t[k];
      return typeof v === "function" ? v.bind(t) : v;
    },
  });
}

/**
 * lc.carton as the Materializer's engine sees it: on a shared cut a commit carries the View's lease as a Store condition
 * (`fence(nonce)`, core's CommitInput.conditions), so core writes it only while this View still holds the lease. #mayCommit
 * checks before the save; another process can take the lease between that check and the write, and the save would then be
 * queued pending in a handle the new holder never reads (review H8 r2 #1). Now core refuses it whole, and the save waits
 * for the lease as #mayCommit's do. `nonceFor(cut)`: the nonce for a shared cut, null for a local one (any handle commits
 * there); it throws when the View doesn't hold the lease.
 */
function fencedCarton(carton, nonceFor) {
  return new Proxy(carton, {
    get(t, k) {
      if (k === "commit") {
        return async (input) => {
          const n = await nonceFor(input?.cut ?? t.cut);
          return t.commit(n ? { ...input, conditions: [...(input?.conditions ?? []), fence(n)] } : input);
        };
      }
      const v = t[k];
      return typeof v === "function" ? v.bind(t) : v;
    },
  });
}

export class View {
  constructor({ api, bundlePath, lc }) {
    this.api = api;
    this.bundlePath = bundlePath;
    this.lc = lc;
    this.projectId = lc.carton.projectId;
    this.mz = null;
    this.lease = null;
    this.holder = null;
    this.polling = null;
    this.stamps = new Map(); // printed view name → its file's stamp
    this.syncArgs = null; // the holder's sync start, kept until Live runs
    this.waiting = new Set(); // view files whose save waited for the lease in vain (#mayCommit)
    this.cutListeners = new Set(); // told of every switch of the current cut the holder serves or follows (live.js: Share's status)
    this.live = false;
    this.off = null;
    this.timer = null;
    this.stopped = false;
  }

  async start() {
    const { lc, bundlePath } = this;
    const codec = globalThis.__cartonTimelineCodec;
    if (!codec) throw new Error("this build has no timeline.tsx printer for Carton");
    const mz = new Materializer({
      bundle: bundlePath,
      engine: engineFor(cartonMaterializerEngine(fencedCarton(lc.carton, (cut) => this.#nonceFor(cut))), lc, () => this.materializeNow(), (file) => this.#mayCommit(file), (file) => {
        if (file && !this.holds()) this.waiting.add(file);
      }),
      host: cardboardFilesHost,
      codec,
      writeProject: false,
      // this machine's actor group (local's localGroup()): on a shared cut a windowless agent of this machine's `cb`
      // edit shows in the frozen timeline.tsx too, as a hooked agent's does; a teammate's agents stay out
      group: localGroup(),
      // `.carton/displaced` is the facade's (project.json's installs, its journal): the Materializer's start-up recovery
      // would take an untagged file there as a timeline.tsx save
      displacedDir: path.join(CARTON_DIR, "displaced-views"),
      // perf/apply-tail: a cb write that waited 500 ms or more for timeline.tsx to show it (the whole wait: the holder's
      // look at carton.db, beforeMs, and the materializer's part, ms), and where that time went (the queue, its rewrite
      // step by step, what answered it, the longest tasks meanwhile): into the worker's output, which the app's activity
      // log keeps (main's __cbPipeWorker). Timings, change ids and task names only.
      onSlowShow: (s) => console.warn("[carton] a cb write waited " + ((s.beforeMs ?? 0) + s.ms) + " ms for timeline.tsx (" + s.answer + "): " + JSON.stringify(s)),
      // a clash in an agent's save is a card for the person too (view-cards.js); open panels are found by the library's
      // own path string for the bundle
      // The cut: the one the save was committed on, as the Materializer reports it (its stored result's: also for a
      // save it resumes after a restart, and a retry core answered by id with its first attempt's, reviews H8 r2 #2 and
      // r3 #2). A result stored without one (an older build's) goes by the cut its change is on.
      onCards: (c) => {
        const lost = (e) => warnOnce("cards:" + bundlePath, "an agent's conflict cards didn't reach the History panel: " + errText(e));
        (async () => {
          const cut = c.cut ?? (await cutOfChange(lc.store, c.change)) ?? lc.carton.cut;
          await this.api.agentCards?.(this.api.bundleOf(this.projectId) ?? bundlePath, { ...c, cut });
        })().catch(lost);
      },
    });
    this.mz = mz;
    // Head moved in this handle: the shared file follows (unless frozen), project.json too.
    this.off = lc.carton.on((e) => this.#event(e));
    await mz.start();
    await this.#trackPrinted();

    // The holder. Its writes and its follower tell the Materializer who is working (local's tellBusy: a hooked agent's
    // `cb` call is hookRead, frozen until its Stop; anyone else's is onCb, frozen a while).
    const printer = {
      printView: async (name, owner, o) => {
        const v = await mz.printView(name, owner, o);
        this.#track(v.name);
        return v;
      },
      hookRead: (a) => mz.hookRead(a),
      hookWrite: (a, rel) => mz.hookWrite(a, rel),
      hookStop: (a) => mz.hookStop(a),
      // a terminal's cb (`caller`) reads its own writes in the frozen file (apply-ryw)
      onCb: (caller) => mz.onCb(caller),
      onHeadChange: (cause) => mz.onHeadChange(cause),
      // read-your-writes (apply-ryw): a cb write answers once timeline.tsx shows it (the holder's carton.shown)
      showChange: (c, ms, o) => mz.showChange(c, ms, o),
      onCutSwitch: (cut) => { for (const f of this.cutListeners) f(cut); return mz.onCutSwitch(cut); },
      // Carton UX v2 (N0): `cb compare … --show` opens Compare in the editor windows that show the project
      openView: (v, by) => (this.api.openView ? this.api.openView(this.projectId, v, by) : Promise.resolve({ opened: 0 })),
      onExternalHeadChange: () => mz.onExternalHeadChange(),
      onChangeUpdate: (v, id, u) => mz.onChangeUpdate(v, id, u),
    };
    const engine = new CartonHolderEngine(lc.carton, { materializer: printer, onExternal: () => this.materializeSoon() });
    const serve = engine.serve.bind(engine);
    // Before any print the holder pulls (§6.2); a write it served changes head, which project.json follows.
    engine.serve = async (req, ctx) => {
      await caughtUp(lc.carton);
      try {
        return await serve(req, ctx);
      } finally { this.materializeSoon(); }
    };
    // Sync connects once Live runs for the project (connectSync); the holder's later starts (a lease taken back) too.
    const startSync = engine.startSync.bind(engine);
    engine.startSync = async (...a) => {
      this.syncArgs = { start: startSync, args: a };
      if (this.live) return startSync(...a);
    };
    this.holder = engine;
    this.lease = keepLease(() => ({
      lease: lc.lease,
      engine,
      kind: "worker",
      socketPath: holderSocketPath(path.dirname(lc.dbPath), "worker"),
      log: () => {},
    }));
    await this.lease.start();
  }

  /** Live sync runs for the project (live.js): the holder connects (now, and whenever it takes the lease again). */
  async connectSync() {
    this.live = true;
    if (this.syncArgs && !this.stopped) await this.syncArgs.start(...this.syncArgs.args);
  }

  /**
   * PLAN §6.2: a save on a shared cut goes through the project's lease holder. This View's handle is it, unless
   * another process took the lease over (a cb helper, while this worker's loop stalled): a commit here would then be a
   * pending row that holder never reads, lost at its next settle (review H8 r1 #1). So a view save waits for keepLease to
   * take the lease back (a handover within ~2 s); failing that it throws, and the Materializer reads the file again
   * later (its retry with a growing delay). A local cut has no lease to respect: any handle commits there.
   */
  async #mayCommit(file) {
    const cut = (await this.lc.carton.cuts()).find((c) => c.id === this.lc.carton.cut);
    if (!cut || cut.sequencer?.kind === "local") return;
    for (const end = Date.now() + LEASE_WAIT_MS; !this.holds(); ) {
      if (this.stopped || Date.now() > end) {
        if (file) this.waiting.add(file);
        throw new Error("another process holds this shared project's sync just now; the save is applied once the app has it back");
      }
      await new Promise((r) => setTimeout(r, 50));
    }
  }

  /** The lease nonce a commit on `cut` is fenced on: null on a local cut; throws while another process holds the lease. */
  async #nonceFor(cut) {
    const c = (await this.lc.carton.cuts()).find((x) => x.id === cut);
    if (!c || c.sequencer?.kind === "local") return null;
    if (!this.holds()) throw new Error("another process holds this shared project's sync just now; the save is applied once the app has it back");
    return this.lease.current.nonce;
  }

  /** This handle holds the lease right now (not fenced, not stopped). */
  /** f(cut) at every switch of the current cut the holder serves or follows; returns its undo. */
  onCut(f) {
    this.cutListeners.add(f);
    return () => this.cutListeners.delete(f);
  }

  holds() {
    const h = this.lease?.current;
    return !this.stopped && !!h && !h.stopped && !!h.nonce;
  }

  #event(e) {
    if (this.stopped) return;
    const cut = this.lc.carton.cut;
    if ((e.type === "change" || e.type === "pending") && e.branchId === cut) {
      this.mz.onHeadChange(e.type === "change" && !e.local ? "remote" : "local");
      // The person's own GUI save wrote project.json itself (the facade's save path); anything else goes into it.
      if (!(e.type === "change" && e.local && e.change?.author?.id === "person")) this.materializeSoon();
    } else if (e.type === "notice" || (e.type === "absorbed" && e.branchId === cut)) {
      // a pending edit the server refused, or one a rebase emptied: head no longer has it
      this.mz.onHeadChange("local");
      this.materializeSoon();
    }
  }

  /** Head into project.json now (a view's save, before its `.status` says how it landed). */
  async materializeNow() {
    if (this.stopped) return;
    clearTimeout(this.timer);
    this.timer = null;
    await this.api.materialize(this.projectId).catch((e) => warnOnce("mz:" + this.bundlePath, `a change didn't reach ${path.basename(this.bundlePath)}'s project.json: ${errText(e)}`));
  }

  /** Head into project.json soon (coalesced); nothing is written when the file already shows head. */
  materializeSoon() {
    if (this.timer || this.stopped) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.api.materialize(this.projectId).catch((e) => warnOnce("mz:" + this.bundlePath, `a change didn't reach ${path.basename(this.bundlePath)}'s project.json: ${errText(e)}`));
    }, MATERIALIZE_MS);
  }

  // The views Carton printed, checked every POLL_MS by their files' stamps (stat only: no handle in the bundle). The
  // bundle's own files come from Cardboard's watcher (timelineEvent), which already watches it. A file in the views
  // folder Carton never printed is never applied (the Materializer's R5-03), so it isn't looked at.
  async #trackPrinted() {
    let names = [];
    try { names = fs.readdirSync(path.join(this.bundlePath, ...VIEWS_DIR.split("/"))).filter((n) => n.toLowerCase().endsWith(".tsx")); } catch {}
    for (const n of names) {
      const name = n.slice(0, -4), canon = fold ? name.toLowerCase() : name;
      if (await this.mz.engine.getMeta(["view", canon]).catch(() => null)) this.#track(canon);
    }
  }
  #stamp(name) {
    try {
      const st = fs.statSync(path.join(this.bundlePath, ...VIEWS_DIR.split("/"), name + ".tsx"), { bigint: true });
      return `${st.ino}:${st.size}:${st.mtimeNs}`;
    } catch {
      return null;
    }
  }
  #track(name) {
    if (this.stopped || this.stamps.has(name)) return;
    this.stamps.set(name, this.#stamp(name));
    if (this.polling) return;
    this.polling = setInterval(() => {
      if (this.stopped) return;
      // saves that waited for the lease in vain (#mayCommit): read again once this View holds it, whatever the
      // Materializer's own retries came to
      if (this.waiting.size && this.holds()) {
        for (const rel of this.waiting) this.mz.onFsEvent(rel);
        this.waiting.clear();
      }
      for (const [n, was] of this.stamps) {
        const now = this.#stamp(n);
        if (now === was) continue;
        this.stamps.set(n, now);
        this.mz.onFsEvent(`${VIEWS_DIR}/${n}.tsx`);
      }
    }, POLL_MS);
    this.polling.unref?.();
  }

  /** Cardboard's watcher saw timeline.tsx change. */
  timelineEvent() {
    if (!this.stopped) this.mz.onFsEvent(TIMELINE_FILE);
  }

  /** A hook event of a hooked agent ({event: "read" | "write" | "stop", file}). */
  async hook(actor, op) {
    if (op.event === "read") return this.mz.hookRead(actor);
    if (op.event === "write") return this.mz.hookWrite(actor, op.file);
    if (op.event === "stop") return this.mz.hookStop(actor);
  }

  /**
   * A write the app makes for the person (⌘Z), served by this View's holder in this process as its control socket would
   * serve it: the same engine.serve (local's runWrite on this handle, with the Materializer told, the person's notices
   * delivered, a retry on a lost append race), without the round trip through the socket to this same process (request
   * R4). A `gui` write (local-cli 3962f27): the person's own action starts no freeze. Only while this View holds the
   * lease; otherwise null, and the caller goes through @carton/local's write path, which finds whoever holds it.
   */
  /** A GUI save's project.json write is under way (the facade's hostWrite): see the extension's hook. */
  hostWrite(after) {
    if (this.stopped || !this.mz) return false;
    this.mz.onHeadChange("gui", { after });
    return true;
  }

  async serveHere(op, actor) {
    if (this.stopped || !this.holds()) return null;
    return this.holder.serve({ id: nextChangeId(), actor, op, gui: true });
  }

  /**
   * A Director turn ended: it and its subagents stop holding the freeze and let go of their pins (the turn's own Stop
   * does both for the whole turn, a subagent's SubagentStop only for itself).
   */
  async endTurn(id) {
    const a = parseActorId(id);
    if (a) await this.mz.hookStop(a);
  }

  async stop() {
    this.stopped = true;
    clearTimeout(this.timer);
    this.off?.();
    clearInterval(this.polling);
    await this.lease?.stop().catch(() => {});
    await this.mz?.close().catch(() => {});
  }
}

function startView(api, bundlePath, lc) {
  const key = keyOf(bundlePath);
  let p = views.get(key);
  if (p) return p;
  // Only the library's own bundles: a staged copy (Open Project) or a bundle of another library has none.
  const own = api.bundleOf(lc.carton.projectId);
  if (!own || keyOf(own) !== key) return Promise.resolve(null);
  const view = new View({ api, bundlePath, lc });
  paths.set(key, bundlePath);
  p = view.start().then(
    () => {
      if (views.get(key) !== p) return view.stop().then(() => null); // released while starting
      running.set(key, view);
      return view;
    },
    (e) => {
      warnOnce("view:" + bundlePath, `agents' views and the timeline.tsx freeze are off for ${path.basename(bundlePath)}: ${errText(e)}`);
      void view.stop();
      if (views.get(key) === p) views.delete(key), paths.delete(key);
      return null;
    },
  );
  views.set(key, p);
  return p;
}

/** The project's View once it has started, or null (none, or it failed); waits for one that is starting. */
export function viewOf(bundlePath) {
  return views.get(keyOf(bundlePath)) ?? Promise.resolve(null);
}

extend({
  name: "views",
  // The facade: timeline.tsx is the Materializer's here (its install and Cardboard's watcher hand over).
  ownsTimeline: (bundlePath) => running.has(keyOf(bundlePath)),
  timelineEvent: (bundlePath) => running.get(keyOf(bundlePath))?.timelineEvent(),
  // The facade's ⌘Z: served by the View's holder here when it holds the lease (null: the caller writes through local)
  serveHere: (bundlePath, op, actor) => running.get(keyOf(bundlePath))?.serveHere(op, actor) ?? null,
  // The facade's GUI save: head moves now and the store writes project.json after it; `after` resolves once that write
  // has landed, to project.json's envelope and stamp (the Materializer's HostWrite) or to nothing. The rewrites wait for
  // it and take the envelope from it instead of reading the file again. false: no View here (the facade drops it).
  hostWrite: (bundlePath, after) => running.get(keyOf(bundlePath))?.hostWrite(after) ?? false,
  async release(dir, inside) {
    const stops = [];
    // A View still starting goes too (review H8 r1): left out, its start would finish after the release, take the
    // lease and own timeline.tsx in a bundle Cardboard is moving or trashing. Its start sees it was released and stops.
    for (const [key, p] of views) {
      const bundlePath = running.get(key)?.bundlePath ?? paths.get(key);
      if (!bundlePath || !inside(bundlePath)) continue;
      views.delete(key);
      running.delete(key);
      paths.delete(key);
      stops.push(p.then((x) => x?.stop()));
    }
    await Promise.all(stops);
  },
  worker(api) {
    api.onOpen((bundlePath, lc) => startView(api, bundlePath, lc));
    return {
      /**
       * main (the Director's hooks): `pre-tool-use` with the tool call (a Read or Write/Edit of timeline.tsx is the
       * Materializer's event; a Write/Edit of project.json is refused, `output` being the hook's answer; local's
       * preToolUse), `stop` for a stop the late-conflict hook let through, `endTurn` when the turn ends. `actor` is
       * the id main exports for the agent's cb calls.
       */
      async agentHook({ bundlePath, actor, event, input }) {
        const v = bundlePath ? await viewOf(bundlePath) : null;
        const a = typeof actor === "string" ? parseActorId(actor) : null;
        if (!v || !a) return { delivered: false };
        if (event === "endTurn") return await v.endTurn(a.id), { delivered: true };
        if (event === "stop") return await v.hook(a, { event: "stop" }), { delivered: true };
        if (event !== "pre-tool-use") return { delivered: false };
        // @carton/local's rule for every hooked agent's file tools (as host Claude Code's cb carton-hook runs it): a
        // Write/Edit of project.json is refused with a pointer to the agent's own view (PLAN §6.4); a Read of
        // timeline.tsx, or a Write/Edit of it, is the Materializer's event
        const { output, event: h } = preToolUse(input ?? {}, { projectDir: v.bundlePath, turn: a.chat && a.turn ? { chat: a.chat, turn: a.turn } : null });
        if (output?.hookSpecificOutput?.permissionDecision === "deny") return { delivered: false, output };
        if (!h) return { delivered: false };
        await v.hook(a, h.op);
        return { delivered: true };
      },
    };
  },
});
