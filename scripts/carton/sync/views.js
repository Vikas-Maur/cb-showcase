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
//   each save of it is applied as that agent's change, with a `<name>.status` sidecar the agent reads (confirmed,
//   conflicts, rejected, with the cards and the diagnostics). A clash is a card for the agent (`cb conflicts`, the Stop
//   hook) and for the person (onCards: the History panel's cards).
// - project.json stays the facade's (H1, through Cardboard's own store): the Materializer runs with writeProject off,
//   and every change that didn't come through the GUI's save (a view's save, a cb write, another process's or a
//   teammate's change) goes into it with the facade's materialize, so the pages adopt it.
// - The View's holder is the project's one Carton lease holder in this worker (@carton/local's keepLease around a
//   CartonHolderEngine with the Materializer as its printer), so cb's writes and hook events reach the Materializer.
//   Live sync (live.js) uses this holder for a shared project instead of keeping a lease of its own.
// - Old prints: a timeline.tsx or view printed by Cardboard 1.4.0 carries a bare `stateUpdatedAt` rev. The facade
//   maps each one it wrote to its state (`views` table `["rev", ms]`); the engine wrapper resolves them there, so such
//   a file applies as an edit of that state instead of being refused ("state unknown: re-print").
import fs from "node:fs";
import path from "node:path";
import { AsyncLocalStorage } from "node:async_hooks";
import { extend } from "../carton-node.js";
import { cardboardFilesHost } from "@carton/cardboard";
import { Materializer, DisplacedFiles, CARTON_DIR, VIEWS_DIR, TIMELINE_FILE } from "@carton/cardboard/node";
import { keepLease, holderSocketPath, CartonHolderEngine, CartonMaterializerEngine, hookDelivered, hookEventFor, parseActorId } from "@carton/local";
import { caughtUp } from "./live.js";

const MATERIALIZE_MS = 40;
const errText = (e) => (e && e.message) || String(e);
const warned = new Set();
const warnOnce = (key, msg) => { if (!warned.has(key)) { warned.add(key); console.warn("[carton] " + msg); } };
// Bundle paths as keys: the file system's case on Windows and macOS.
const fold = process.platform === "win32" || process.platform === "darwin";
const keyOf = (p) => { const r = path.resolve(p); return fold ? r.toLowerCase() : r; };

const views = new Map(); // key → Promise<View | null>
const running = new Map(); // key → View, once started (the facade asks synchronously)

/**
 * The engine the Materializer gets: local's CartonMaterializerEngine (cards kept for the save's author, a shared cut's
 * spacing), plus 1.4.0's numbered revs through the facade's map. A save that landed is in project.json (so in the app)
 * before the Materializer answers it in the view's `.status`: an agent that reads "confirmed" finds it everywhere.
 * Anything else goes to the inner engine as it is.
 */
function engineFor(inner, lc, landed) {
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
          const r = await t.commit(input.base?.kind === "legacy" ? { ...input, base: (await old(input.base.rev)) ?? input.base } : input);
          if (r?.status && r.status !== "rejected") await landed();
          return r;
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
    this.watcher = null;
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
      engine: engineFor(new CartonMaterializerEngine(lc.carton), lc, () => this.materializeNow()),
      host: cardboardFilesHost,
      codec,
      writeProject: false,
      // a clash in an agent's save is a card for the person too (view-cards.js); open panels are found by the library's
      // own path string for the bundle
      onCards: (c) => {
        const lost = (e) => warnOnce("cards:" + bundlePath, "an agent's conflict cards didn't reach the History panel: " + errText(e));
        try { Promise.resolve(this.api.agentCards?.(this.api.bundleOf(this.projectId) ?? bundlePath, c)).catch(lost); } catch (e) { lost(e); }
      },
    });
    // Stopgap until cardboard-adapter's `displacedDir` option: the Materializer's displaced files get a folder of their
    // own. `.carton/displaced` is the facade's (project.json's installs and its journal), and the Materializer's
    // recovery at start takes an untagged file there as a timeline.tsx save.
    mz.held = new DisplacedFiles(path.join(bundlePath, CARTON_DIR, "displaced-views"), { now: () => mz.clock.now(), quietMs: mz.opts.quietMs, holdMs: mz.opts.quietMs, ...mz.busy });
    this.mz = mz;
    // Head moved in this handle: the shared file follows (unless frozen), project.json too.
    this.off = lc.carton.on((e) => this.#event(e));
    await mz.start();
    this.#watchViews();

    // The holder. A hooked agent's own `cb` call is that agent working: it freezes timeline.tsx until the agent's Stop
    // (hookRead), not for a minute after it as a windowless agent's call does (onCb), which would keep the file frozen
    // after the turn ended.
    const scope = new AsyncLocalStorage();
    const busy = async (author) => (author && hookDelivered(author) ? mz.hookRead(author) : mz.onCb());
    const printer = {
      printView: (name, owner, o) => mz.printView(name, owner, o),
      hookRead: (a) => mz.hookRead(a),
      hookWrite: (a, rel) => mz.hookWrite(a, rel),
      hookStop: (a) => mz.hookStop(a),
      onCb: async () => {
        const s = scope.getStore();
        if (s) return busy(s.actor);
        // the holder's follower: another process committed (cb in its own process, a helper); whose change it was
        const last = await lc.carton.log({ limit: 1 }).catch(() => []);
        return busy(last[0]?.author ?? null);
      },
      onHeadChange: (cause) => mz.onHeadChange(cause),
      onCutSwitch: (cut) => mz.onCutSwitch(cut),
      onExternalHeadChange: () => mz.onExternalHeadChange(),
      onChangeUpdate: (v, id, u) => mz.onChangeUpdate(v, id, u),
    };
    const engine = new CartonHolderEngine(lc.carton, { materializer: printer, onExternal: () => this.materializeSoon() });
    const serve = engine.serve.bind(engine);
    // Before any print the holder pulls (§6.2); a write it served changes head, which project.json follows.
    engine.serve = async (req, ctx) => {
      await caughtUp(lc.carton);
      try { return await scope.run({ actor: req?.actor ?? null }, () => serve(req, ctx)); } finally { this.materializeSoon(); }
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

  /** This handle holds the lease right now (not fenced, not stopped). */
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

  // The views folder; the bundle's own files come from Cardboard's watcher (timelineEvent), which already watches it.
  #watchViews() {
    const dir = path.join(this.bundlePath, ...VIEWS_DIR.split("/"));
    try {
      this.watcher = fs.watch(dir, { persistent: false }, (_ev, name) => {
        if (name && !this.stopped) this.mz.onFsEvent(VIEWS_DIR + "/" + String(name).replace(/\\/g, "/"));
      });
      this.watcher.on("error", () => {});
    } catch (e) {
      warnOnce("watch:" + this.bundlePath, `agents' views in ${path.basename(this.bundlePath)} aren't watched: ${errText(e)}`);
    }
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

  /** A Director turn ended: it and its subagents stop holding the freeze. */
  async endTurn(id) {
    const ids = [...this.mz.freeze.hooked.keys()].filter((k) => k === id || k.startsWith(id + "/"));
    for (const k of ids) await this.mz.hookStop(this.mz.freeze.hooked.get(k));
    // a turn that never got into `hooked` (no read, no cb call) still lets go of its pins
    if (!ids.includes(id)) { const a = parseActorId(id); if (a) await this.mz.hookStop(a); }
  }

  async stop() {
    this.stopped = true;
    clearTimeout(this.timer);
    this.off?.();
    this.watcher?.close();
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
  p = view.start().then(
    () => {
      if (views.get(key) !== p) return view.stop().then(() => null); // released while starting
      running.set(key, view);
      return view;
    },
    (e) => {
      warnOnce("view:" + bundlePath, `agents' views and the timeline.tsx freeze are off for ${path.basename(bundlePath)}: ${errText(e)}`);
      void view.stop();
      if (views.get(key) === p) views.delete(key);
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
  async release(dir, inside) {
    const stops = [];
    for (const [key, p] of views) {
      const v = running.get(key);
      if (!v || !inside(v.bundlePath)) continue;
      views.delete(key);
      running.delete(key);
      stops.push(p.then((x) => x?.stop()));
    }
    await Promise.all(stops);
  },
  worker(api) {
    api.onOpen((bundlePath, lc) => startView(api, bundlePath, lc));
    return {
      /**
       * main (the Director's hooks): `pre-tool-use` with the tool call (a Read of timeline.tsx, a Write/Edit of it or
       * project.json; local's hookEventFor), `stop` for a stop the late-conflict hook let through, `endTurn` when the
       * turn ends. `actor` is the id main exports for the agent's cb calls.
       */
      async agentHook({ bundlePath, actor, event, input }) {
        const v = bundlePath ? await viewOf(bundlePath) : null;
        const a = typeof actor === "string" ? parseActorId(actor) : null;
        if (!v || !a) return { delivered: false };
        if (event === "endTurn") return await v.endTurn(a.id), { delivered: true };
        if (event === "stop") return await v.hook(a, { event: "stop" }), { delivered: true };
        const h = event === "pre-tool-use" ? hookEventFor("pre-tool-use", input ?? {}, { projectDir: v.bundlePath }) : null;
        if (!h) return { delivered: false };
        await v.hook(a, h.op);
        return { delivered: true };
      },
    };
  },
});
