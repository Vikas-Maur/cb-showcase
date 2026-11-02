// The facade the bridges call (scripts/carton/*-bridge.js), bundled by scripts/carton/build.js into
// resources/carton/carton-node.cjs. It maps what Cardboard 1.4.0's hooks need (carton/docs/INTEGRATION-1.4.0.md §5)
// onto the @carton packages, so a package API change touches only this file.
// - History: one Carton (@carton/local, openLocal) per bundle, opened on first use; a project with no history yet
//   starts from its document on disk as main@1.
// - Revs: 1.4.0 names a version by the stateUpdatedAt it was written with (`// cardboard:rev <ms>`, `cb undo <rev>`).
//   Carton doesn't, so every state that reaches project.json records its rev against its Carton ref, in carton.db's
//   local `views` table: then the header, the revision readers, `cb history` and `cb undo <rev>` work unchanged.
// - Files: Carton's writes to project.json and timeline.tsx are displace-then-install (@carton/cardboard/node). What
//   it moves aside is Carton's own (deleted) or a foreign save (imported as an outside change, then released).
// - When history can't be opened for a project, every call answers as Cardboard 1.4.0 would: no commit, .revs
//   history, a plain rename. It says so once in the log.
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { openSqliteStore, isThisMachine } from "@carton/store-sqlite";
import { displaceThenInstall, hardLinksWork, statStamp, DisplacedFiles, retryBusy, cartonViewFile, MediaDetails, droppedMedia } from "@carton/cardboard/node";
import { describeCardboardCard, fromHost, materializeProject, lacksDetails, projectGuiSave, projectProblems, branchToken } from "@carton/cardboard";
import { hashDoc } from "@carton/core";
import * as cardboardHost from "@carton/cardboard";
import { openLocal, identify, localGroup, parseActorId, runHook, sendHookEvent, openExistingProjectStore, existingCartonDbs, StoreNoticeBox, stopHook, stopOutput, actorIdForHook, safePart, defaultFactory, helperEntry, spawnHelper, pingWhy, showOnHolder } from "@carton/local";
import { register, registerMcp } from "@carton/cli-mcp";
import { fromCarton, serveUi, commentsUi, serveComments } from "@carton/react";
import { Comments } from "@carton/comments";
import { viewCards, canon, sameCard } from "./sync/view-cards.js";

const warned = new Set();
const warnOnce = (key, msg) => {
  if (warned.has(key)) return;
  warned.add(key);
  console.warn("[carton] " + msg);
};
const errText = (e) => (e && e.message) || String(e);

// ---------------------------------------------------------------- never a project Cardboard can't read
// Laptop, build 915eb36: Restore of "Started the cut" wrote a project.json with no name and empty tracks and media, and
// the project left Cardboard's library. Every project.json this process writes is checked first (@carton/cardboard's
// projectProblems: what Cardboard 1.4.0's reader needs, and a name): one that fails is not written, the old file stays,
// and the refusal is logged, in the console (at most once every 10 s per project) and in the bundle's
// .carton/refused.log (one JSON line each: when, which writer, what was wrong; never the project's own text).
const REFUSED_LOG = "refused.log", REFUSED_LOG_MAX = 256 * 1024;
const refusedSaid = new Map();
function refuseProject(bundlePath, projectId, problems, where) {
  const at = Date.now(), key = (bundlePath ?? projectId) + "\0" + where;
  if (!(at - (refusedSaid.get(key) ?? 0) < 10_000)) {
    refusedSaid.set(key, at);
    console.warn(`[carton] kept project.json of project ${projectId ?? "?"}: the ${where} would have written one Cardboard can't read (${problems.join("; ")})`);
  }
  if (!bundlePath) return;
  try {
    const dir = path.join(bundlePath, ".carton");
    if (!fs.existsSync(dir)) return;
    const file = path.join(dir, REFUSED_LOG);
    if ((fs.statSync(file, { throwIfNoEntry: false })?.size ?? 0) > REFUSED_LOG_MAX) fs.rmSync(file, { force: true });
    fs.appendFileSync(file, JSON.stringify({ at, where, projectId: projectId ?? null, problems }) + "\n");
  } catch {}
}

// Cardboard's own GUI save projection, cut out of the editor bundle at build time (scripts/carton/fmsv.js).
let gui = null;
const P = () => (gui ??= remembered((() => {
  try { return require(path.join(__dirname, "fmsv.cjs")); }
  catch (e) { warnOnce("fmsv", "the editor's save projection is missing; GUI saves are diffed as they are: " + errText(e)); return (i) => i; }
})()));
// projectGuiSave projects every item of the save's base through P, on every GUI save: with a few hundred items that was
// most of the save's work (P copies each item through JSON). P is a pure function of the item's values, and the base's
// items are Carton's own records, deep-frozen and kept by identity while they don't change, so each one's projection
// is computed once and reused: a save then projects only the items changed since the base it was made on. Only a
// deep-frozen item is remembered (one that can never change); anything else is projected each time, as before. The
// projection kept is frozen too, so nothing that reads it can change what the next save compares against.
const frozenDeep = new WeakSet(), projections = new WeakMap();
const isFrozenDeep = (v) => {
  if (v === null || typeof v !== "object" || frozenDeep.has(v)) return true;
  if (!Object.isFrozen(v)) return false;
  for (const x of Object.values(v)) if (!isFrozenDeep(x)) return false;
  frozenDeep.add(v); // its values can't change, so neither can the answer
  return true;
};
const freezeAll = (v) => {
  if (v !== null && typeof v === "object" && !Object.isFrozen(v)) { Object.freeze(v); for (const x of Object.values(v)) freezeAll(x); }
  return v;
};
function remembered(p) {
  return (item) => {
    if (item === null || typeof item !== "object" || !isFrozenDeep(item)) return p(item);
    let out = projections.get(item);
    if (out === undefined) projections.set(item, (out = freezeAll(p(item))));
    return out;
  };
}

// ---------------------------------------------------------------- one Carton per bundle
const opened = new Map(); // bundlePath → Promise<LocalCarton | null>
const startable = (project) => !projectProblems({ format: "cardboard-project", project }).length;
function open(bundlePath, { projectId, doc } = {}) {
  if (!bundlePath) return Promise.resolve(null);
  let p = opened.get(bundlePath);
  if (!p) {
    p = (async () => {
      const id = projectId ?? doc?.id ?? readProject(bundlePath)?.id;
      // (in the bundle, or in app data where a synced, network or FAT folder keeps it: L15)
      const exists = fs.existsSync(path.join(bundlePath, ".carton", "carton.db")) || (!!id && existingCartonDbs({ projectDir: bundlePath, projectId: id }).length > 0);
      // A project without history yet starts from its document on disk (§16, main@1), never from one Cardboard can't
      // read (laptop, build 915eb36: its first version would be a project with no name).
      let first = exists ? null : doc ?? readProject(bundlePath);
      if (first && !startable(first)) throw new Error("its project.json can't be read by Cardboard, so its history doesn't start from it");
      // R1: extensions add openLocal options (live sync: the worker's handle gets the project's sync connection, the
      // person's actor and the replica's name; cb gets the helper that syncs headlessly).
      const more = await extOpenOptions({ bundlePath, projectId: id });
      const openWith = (start) => openLocal({ projectDir: bundlePath, projectId: id, init: start ? { doc: fromHost(start, null) } : undefined, ...more });
      let lc;
      try { lc = await openWith(first); } catch (e) {
        // A carton.db another machine made (a folder copied from another computer, or one a sync client brought) is
        // never adopted as this machine's replica: the stores set it aside (carton.from-<host>-<t>.db, kept for its
        // history) and open an empty one (L15). That project then starts its own history from project.json, as a
        // project without one does; without this its history stayed off for good ("holds no project").
        if (first || !/holds no project/.test(errText(e))) throw e;
        first = doc ?? readProject(bundlePath);
        if (!first || !startable(first)) throw e;
        lc = await openWith(first);
      }
      if (first) await setRev(lc, first.stateUpdatedAt, (await lc.carton.head()).ref);
      return lc;
    })().catch((e) => (warnOnce("open:" + bundlePath, `history is off for ${path.basename(bundlePath)}: ${errText(e)}`), opened.delete(bundlePath), null));
    opened.set(bundlePath, p);
    p.then((lc) => {
      if (!lc) return;
      ready.set(bundlePath, lc);
      for (const f of openers) tell(f, bundlePath, lc);
    });
  }
  return p;
}
const readProject = (bundlePath) => { try { return JSON.parse(fs.readFileSync(path.join(bundlePath, "project.json"), "utf8")).project ?? null; } catch { return null; } };
// recover(): bundlePath → {text, out} for the damaged file last read through its history
const recovered = new Map();
// Whose a carton.db is, read without opening it as a history (nothing is moved, set aside or written): its project id
// and whether this computer made it. null: it can't be read.
async function historyOwner(dbPath) {
  let machine;
  try {
    const raw = new DatabaseSync(dbPath, { readOnly: true, timeout: 2000 });
    try { machine = JSON.parse(raw.prepare(`SELECT v FROM "_carton" WHERE k = ?`).get("machine")?.v ?? "null") ?? undefined; } catch { machine = undefined; } finally { raw.close(); }
  } catch { return null; }
  let store;
  try { store = await openSqliteStore(dbPath, { readOnly: true }); } catch { return null; }
  try { return { projectId: (await store.get("meta", ["project"]))?.projectId ?? null, mine: isThisMachine(machine) }; }
  catch { return null; }
  finally { await store.close().catch(() => {}); }
}
// The name a project last had in its history: the newest version that has one, on the current cut, then the others
// (at most 256 versions looked at). null: none.
async function lastName(lc) {
  const c = lc.carton;
  const cuts = [c.cut, ...(await c.cuts()).filter((x) => x.id !== c.cut && !x.shallow).map((x) => x.id)];
  let looked = 0;
  for (const cut of cuts) {
    for (const v of await c.log({ cut, limit: 64 }).catch(() => [])) {
      if (++looked > 256) return null;
      const doc = await c.checkout(v.ref).catch(() => null);
      if (typeof doc?.name === "string" && doc.name.trim()) return doc.name;
    }
  }
  return null;
}

// A folder Cardboard is done with: Open Project's staging folder (`.opening-<id>`), which it removes once the staged
// project is copied into the library. Everything Carton holds under it is let go first: each Carton opened there is
// closed (its carton.db and files), a pending review of a displaced file there is dropped, the staging library's
// store is forgotten, and each extension's `release` hook lets go of its own (sync: host media clients). On Windows an
// open file can't be removed, so Cardboard's own clean-up failed with EBUSY (CI route 35). Called whether the staged
// import worked or not.
const under = (dir, p) => {
  const rel = path.relative(path.resolve(dir), path.resolve(p));
  return rel === "" || (!!rel && !rel.startsWith("..") && !path.isAbsolute(rel));
};
async function release(dir) {
  const inside = (p) => under(dir, p) || (process.platform === "win32" && under(dir.toLowerCase(), p.toLowerCase()));
  for (const [file, s] of installs) if (inside(file)) { clearTimeout(s.timer); installs.delete(file); }
  for (const [key, d] of mediaMemory) if (inside(d.bundle)) mediaMemory.delete(key);
  for (let i = hosts.length - 1; i >= 0; i--) if (inside(hosts[i].root)) hosts.splice(i, 1);
  // The extensions let go first: what they run on a handle (a View's Materializer and holder) stops while it is open.
  for (const e of extensions) {
    if (typeof e.release !== "function") continue;
    try { await e.release(dir, inside); } catch (err) { warnOnce("release:" + (e.name ?? "?"), "an extension's release failed: " + errText(err)); }
  }
  const closing = [];
  for (const [bundlePath, p] of opened) {
    if (!inside(bundlePath)) continue;
    opened.delete(bundlePath);
    ready.delete(bundlePath);
    panels.delete(bundlePath);
    closing.push(p.then((lc) => lc?.close()).catch((e) => warnOnce("close:" + bundlePath, `couldn't close the history of ${path.basename(bundlePath)}: ${errText(e)}`)));
  }
  await Promise.all(closing);
}

// ---------------------------------------------------------------- extensions
// The live-sync and sharing half (scripts/carton/sync, windows-sync) is bundled into this file by build.js and
// registers here with `extend({worker(api)})`. In the library worker, worker(api) returns services that join the
// worker's `carton` namespace beside the facade's own (never replacing one): main's carton:call and the pages reach
// them as carton.<name> (letters only). api:
//   library, emit(change)   the worker's library, and its channel to main and the pages ({kind: "carton", …} changes)
//   bundleOf(projectId)     the project's bundle folder
//   open(bundlePath), carton(projectId)
//                           the project's LocalCarton ({carton, store, …}), opened on first use; null when history is off
//                           for it
//   onOpen(fn)              fn(bundlePath, lc) for each Carton this process opens, the ones open already included;
//                           returns a function that stops it
//   materialize(projectId)  head into project.json, and the pages adopt it
//   actorOf(id)             an actor id ("person", "director/<chat>/<turn>", "external:project.json") as an Actor
//   agentCards(bundlePath, saveCards)
//                           the Materializer's onCards: an agent's view-save cards go to the person's History panels
// Hooks an extension may also have (each optional; one that throws is skipped, logged once):
//   openOptions({bundlePath, projectId})        more openLocal options for the project's handle (R1)
//   commitShared(lc, {doc, base, author, intent, gui})
//                                               a commit on a shared cut, in place of Carton.commit (R2): a CommitResult,
//                                               `pending` counting as a confirmation (`rebased` too), and `head`
//                                               ({ref, doc}) the state to write when the handle can't read it itself;
//                                               `conflicts` with `cards` (the rest landed), `kept` when they are
//                                               already a notice for the author. Foreign-save imports go through it too.
//   materializeDoc(next, {bundlePath, projectId, current})
//                                               fills in a record before head goes into project.json (R6)
//   serveHere(bundlePath, op, actor)            (worker) ⌘Z served by the project's holder in this process, or null
//   hostWrite(bundlePath, after)                (worker) a GUI save is committing and the store writes project.json
//                                               next; `after` resolves once it has landed, to {project: {envelope,
//                                               stamp}} or to nothing. true if the extension took it (views.js)
//   release(dir, inside)                        a folder Cardboard is done with (Open Project's staging folder): let go
//                                               of what is kept for bundles in it (`inside(bundlePath)` says which),
//                                               before the facade closes their handles
//   ownsTimeline(bundlePath), timelineEvent(bundlePath)
//                                               (worker) the bundle's timeline.tsx is the extension's (H8, views.js):
//                                               the facade doesn't install Cardboard's print of it, and Cardboard's
//                                               watcher hands its changes over instead of applying them
// An extension that throws is left out (logged once); Carton and the save path go on without it.
const extensions = [], openers = new Set(), ready = new Map(); // ready: bundlePath → LocalCarton
export function extend(ext) { extensions.push(ext); }

// H8: timeline.tsx is the library worker's Materializer's while one runs for the bundle (sync/views.js): Cardboard's
// own regeneration of it (its mirror's write) and its watcher's apply hand over to it. In the worker an extension says
// so; in any other process (cb), the worker holding the project's lease means one runs there (it prints the file from
// head once cb's change lands, and keeps it frozen while an agent works).
let inWorker = false;
// The library worker's channel to main and the pages (worker()): a change made after the call that caused it returned.
let workerEmit = null;
function timelineOwned(bundlePath) {
  for (const e of extensions) {
    if (typeof e.ownsTimeline !== "function") continue;
    try { if (e.ownsTimeline(bundlePath)) return true; } catch (err) { warnOnce("owns:" + (e.name ?? "?"), "an extension's ownsTimeline failed: " + errText(err)); }
  }
  return false;
}
function timelineEvent(bundlePath) {
  for (const e of extensions) {
    if (typeof e.timelineEvent !== "function") continue;
    try { e.timelineEvent(bundlePath); } catch (err) { warnOnce("tevent:" + (e.name ?? "?"), "an extension's timelineEvent failed: " + errText(err)); }
  }
}
// The `views` row (local table) naming a worker lease whose holder prints no timeline.tsx: Live's own holder, where the
// View didn't start (sync/live.js writes it each time that holder takes the lease).
export const LEASE_PRINTS = ["leasePrints"];
// Whether the worker prints this bundle's timeline.tsx: it holds the lease now, and that lease isn't one Live's own
// holder recorded as printing nothing (review H8 r2 #6). Told the other way round on purpose (r3 #3): a record that
// is late or failed leaves the file to the worker, as before r2, so cb never writes over a frozen timeline.tsx; only
// a View-less worker, already a degraded state, can then go without the file's update.
async function workerWritesTimeline(lc) {
  return !!(await timelineWorker(lc));
}
// The worker's lease row when the worker prints this bundle's timeline.tsx (workerWritesTimeline), else null. A worker
// that is gone (the app quit or crashed without letting go of the lease: its row stays live until it expires, up to 6 s)
// prints nothing: its socket refuses at once, and then cb prints the file itself, as with the app closed. Before
// (apply-ryw), a cb write in those seconds left timeline.tsx to nobody until a later write. A worker that is only slow
// to answer the ping still prints it. One ping per cb process and bundle, kept for a second.
const pings = new Map(); // bundlePath → {nonce, at, gone}
async function timelineWorker(lc) {
  if (inWorker) return null;
  try {
    const row = await lc.lease.read();
    if (row?.kind !== "worker" || !(row.expires > Date.now())) return null;
    const r = await lc.store.get("views", LEASE_PRINTS);
    if (r && r.prints === false && r.nonce === row.nonce) return null;
    let p = pings.get(lc.projectDir);
    if (!p || p.nonce !== row.nonce || Date.now() - p.at > 1000) {
      p = { nonce: row.nonce, at: Date.now(), gone: "gone" in (await pingWhy(row.socketPath)) };
      pings.set(lc.projectDir, p);
    }
    return p.gone ? null : row;
  } catch { return null; }
}

// ---------------------------------------------------------------- read-your-writes (apply-ryw)
// A `cb` write answers once timeline.tsx shows it. With the app open, the worker's Materializer prints the file, and it
// heard of a write cb committed in its own process only at its next poll of carton.db (250 ms), then rewrote the file
// 20 ms later, after cb had answered: on the laptop an agent read timeline.tsx right after its `cb source apply`, saw
// the old value, and told the user the file showed its turn's start. Now cb asks the worker's lease holder
// (`carton.shown`), which looks at carton.db at once, makes its rewrite, and answers with the print that shows the
// write: no poll, at most SHOW_MS. The result says how it went: `timeline` ("shown", "held": the file is frozen for
// someone else's work and holds this change back, "elsewhere": another cut than the file's, "later": not within the
// wait), and anything but "shown" with a sentence for the agent (`timelineNote`). With the app closed cb prints the file
// itself before it answers, as Cardboard does, so there is nothing to wait for.
const SHOW_MS = 2000;
const TIMELINE_NOTES = {
  held: "timeline.tsx doesn't show this change yet: it is held while an agent works on the project, and holds back everyone else's changes until that work ends. The change is saved (`cb history` lists it).",
  elsewhere: "timeline.tsx shows the current cut, not the one this change was made on.",
  later: "timeline.tsx will show this in a moment: the app hasn't rewritten it yet. The change is saved.",
};
// The writes this process committed through the store bridge (commit()), by the result it handed back: what to show.
const toShow = new WeakMap();
/** The write a commit's result made, as `carton.shown` names it: its change, cut, seq once confirmed, and author. */
function showTarget(r, author) {
  if (!r || !(r.status === "confirmed" || r.status === "pending" || r.status === "conflicts") || r.empty) return null;
  const id = r.change?.id ?? (typeof r.id === "string" ? r.id : null);
  if (!id) return null;
  const cut = r.head?.ref?.branchId ?? r.ref?.branchId;
  const seq = r.status === "pending" || (r.status === "conflicts" && r.landed === "pending") ? undefined : r.change?.seq ?? r.seq;
  return { id, ...(typeof cut === "string" ? { cut } : {}), ...(typeof seq === "number" ? { seq } : {}), ...(author ? { author } : {}) };
}
/**
 * Waits (at most SHOW_MS) for the app's timeline.tsx to show a write this cb process made; null when there is nothing to
 * wait for (no change, the worker doesn't print the file here: cb printed it itself). `{timeline, timelineNote?}`.
 */
async function showWrite(lc, target) {
  if (inWorker || !target) return null;
  const row = await timelineWorker(lc);
  if (!row) return null;
  const timeline = (await showOnHolder(row.socketPath, target, SHOW_MS)) ?? "later";
  return timeline === "shown" ? { timeline } : { timeline, timelineNote: TIMELINE_NOTES[timeline] ?? TIMELINE_NOTES.later };
}
/** The store bridge's apply result (`status`): how its write shows in timeline.tsx, once (an MCP server asks again). */
async function showCommitted(bundlePath, r) {
  const t = toShow.get(r);
  if (!t || !bundlePath) return null;
  if (!t.answer) t.answer = (async () => { const lc = await open(bundlePath); return lc ? showWrite(lc, t.target) : null; })().catch(() => null);
  return t.answer;
}
// Whether Cardboard's mirror leaves timeline.tsx to Carton after a save (the store bridge's mirrorOwned): the same test
// install() makes before it drops Cardboard's print of the file, made before the print, so the print isn't made at all.
// In the worker that is the Materializer running for the bundle; in cb, the worker holding the lease.
async function mirrorOwned(bundlePath) {
  if (timelineOwned(bundlePath)) return true;
  if (inWorker) return false;
  const lc = await open(bundlePath);
  return !!lc && (await workerWritesTimeline(lc));
}
async function extOpenOptions(o) {
  let out = {};
  for (const e of extensions) {
    if (typeof e.openOptions !== "function") continue;
    try { out = { ...out, ...((await e.openOptions(o)) ?? {}) }; } catch (err) { warnOnce("openOptions:" + (e.name ?? "?"), "an extension's openOptions failed: " + errText(err)); }
  }
  return out;
}
function tell(f, bundlePath, lc) {
  try { Promise.resolve(f(bundlePath, lc)).catch((e) => warnOnce("onOpen:" + bundlePath, "an extension failed on open: " + errText(e))); }
  catch (e) { warnOnce("onOpen:" + bundlePath, "an extension failed on open: " + errText(e)); }
}
function onOpen(f) {
  openers.add(f);
  for (const [bundlePath, lc] of ready) tell(f, bundlePath, lc);
  return () => openers.delete(f);
}
function extensionServices(api, own) {
  const out = {};
  for (const ext of extensions) {
    let more;
    try { more = ext.worker?.(api) ?? {}; } catch (e) { warnOnce("ext:" + (ext.name ?? "?"), "an extension failed to start: " + errText(e)); continue; }
    for (const [name, f] of Object.entries(more)) {
      if (name in own || name in out || !/^[a-zA-Z]+$/.test(name) || typeof f !== "function") warnOnce("ext:" + name, `an extension's service ${name} was left out (taken, or not a function with a letters-only name)`);
      else out[name] = f;
    }
  }
  return out;
}

// The rev map (carton.db's local `views` table): ["rev", ms] → ref; ["ref", branch, seq] → ms.
const REVS = "views";
const refKey = (ref) => ["ref", ref.branchId, ref.seq];
async function setRev(lc, rev, ref) {
  if (typeof rev !== "number" || !ref) return;
  await lc.store.write([{ table: REVS, key: ["rev", rev], value: ref }, { table: REVS, key: refKey(ref), value: rev }]);
}
// A string is a Carton header ref (what the apply reads off a file the Materializer printed: "Main cut@3~3f9a1c0e
// b:… p:… by …"): its exact version when core can rebuild it, as the string core's commit and checkout take; else
// undefined, never a guess (H3).
const refOf = async (lc, rev) => {
  if (typeof rev === "number") return lc.store.get(REVS, ["rev", rev]);
  const ref = typeof rev === "string" ? rev.trim() : "";
  if (!ref) return undefined;
  try { await lc.carton.resolve(ref); } catch (e) { if (e?.code === "STATE_UNKNOWN") return sameState(lc, ref); throw e; }
  return ref;
};
const revOf = (lc, ref) => lc.store.get(REVS, refKey(ref));
// Laptop #5: a header that names another library's cut (a .cbproj's timeline.tsx, printed where it was saved: here
// only a shallow cut of theirs, never rebuilt) names a state by its hash. The version of this project's current cut
// with that state (an Open Project's history starts from the sender's head: the same state, on a cut of its own) is
// exactly what was printed; its header here, else undefined. Only for a cut that isn't this library's own: on one of
// ours an unknown version stays unknown ("print it again").
const HEADER = /^(.+)@(\d+)~([0-9a-f]{8}) b:([0-9a-f]{8})(?: p:\S+)?(?: by .*)?$/;
async function sameState(lc, header) {
  const m = HEADER.exec(header);
  if (!m) return undefined;
  const cuts = await lc.carton.cuts();
  if (cuts.some((c) => !c.shallow && branchToken(c.id) === m[4])) return undefined;
  const cut = cuts.find((c) => c.id === lc.carton.cut);
  if (!cut) return undefined;
  // core says whether a version has that state: a header with its seq and the printed hash resolves only then (the
  // newest first; a file from another library is opened, or brought in, near where its history began here)
  for (const v of (await lc.carton.log({ limit: SAME_STATE_SCAN })).map((x) => x.ref.seq).concat(0)) {
    const here = `${cut.name}@${v}~${m[3]} b:${branchToken(cut.id)}`;
    if (await lc.carton.resolve(here).then(() => true, () => false)) return here;
  }
  return undefined;
}
const SAME_STATE_SCAN = 256;
// A rev map entry for a version that holds changes still pending in the lease holder, with no state hash to check it by:
// core would resolve it as the confirmed state it was built on (review P1).
const pendingRef = (ref) => !!ref && typeof ref === "object" && !!ref.pending?.length && !ref.hash;
// Review P1: a print of a version still pending in a shared cut's lease holder (offline): this process holds only the
// confirmed rows, so the document project.json shows (the holder's state) is pinned here as a held state on the
// confirmed seq it was built on, with the pending changes it holds. The print carries that pin's header: the apply's
// preview and the holder's commit both resolve exactly the printed document (core reloads pins another process writes).
// null (1.4.0's print, which no apply takes as exact) if it can't be pinned.
const PRINT_OWNER = "cb-print", PRINT_PIN_MS = 7 * 24 * 3600_000;
// `project` (the document project.json shows) pinned as a held state on `ref`'s confirmed seq with its pending changes:
// {header, doc}, or null if it can't be pinned or read back here.
async function pinHeld(lc, ref, project) {
  const c = lc.carton;
  const at = await c.resolve({ branchId: ref.branchId, seq: ref.seq }).catch(() => null);
  if (!at) return null;
  const p = await c.pin({ owner: PRINT_OWNER, cut: ref.branchId, seq: ref.seq, causal: [...(ref.pending ?? [])], doc: fromHost(project, at.doc), ttlMs: PRINT_PIN_MS }).catch((e) => (warnOnce("pin:" + ref.branchId, "an edit still waiting to sync can't be named exactly: " + errText(e)), null));
  const held = p?.header ? await c.resolve(p.header).catch(() => null) : null;
  return held ? { header: p.header, doc: held.doc } : null;
}
async function pendingPrint(lc, ref, project) {
  const held = await pinHeld(lc, ref, project);
  return held ? { project: forCardboard({ ...materializeProject(held.doc, project), stateUpdatedAt: project.stateUpdatedAt }), rev: held.header } : null;
}
// The header a print carries for a version (core's ref token: "<cut name>@<seq>~<hash8> b:<cut8>"), which the apply
// resolves back to exactly that version; null if its cut is unknown here.
async function headerOf(lc, ref) {
  if (!ref || typeof ref !== "object" || typeof ref.seq !== "number" || !(ref.hash8 ?? ref.hash)) return null;
  const cut = (await lc.carton.cuts()).find((x) => x.id === ref.branchId);
  return cut ? `${cut.name}@${ref.seq}~${(ref.hash8 ?? ref.hash).slice(0, 8)} b:${branchToken(ref.branchId)}` : null;
}

// Who an actor id is (CARDBOARD_ACTOR's form). Every local actor is in the machine's undo group (§8: `cb undo`, History's
// Undo). The person at the app and an agent the app started (main names it in CARDBOARD_ACTOR, which the store bridge
// passes as the id) are the app's own (`app`): the app's Ctrl+Z sees only those, in the editor's session (laptop
// report 90c4127, bug 3). "cli" is the store bridge's word for a `cb` that nothing named (no CARDBOARD_ACTOR): who it
// is comes from @carton/local's identity chain, as for Carton's own cb (Claude Code, Codex, Gemini from their
// environment, a declared agent, else the person at this terminal), never an agent called "cli" (ui-words #4), and
// never the app's. Nor are the worker's own bookkeeping ("app") and a save Carton didn't write ("external:…").
const appNamed = (id) => id !== "app" && !id.startsWith("external:");
const actorOf = (id) => {
  if (id === "person") return { id: "person", kind: "human", group: localGroup(), app: true };
  if (id === "cli") return identify();
  const a = parseActorId(id, appNamed(id) ? { app: true } : {});
  return a ?? identify({ declared: id });
};
// "You" in the History panel (R3): in a shared project, this replica's identity (live sync sets it from the host
// session at share and join), as core tells the person's GUI saves there; before a share, the generic person they are
// recorded as. GUI saves stay recorded as "person" either way.
const meOf = (lc) => {
  const who = lc.carton.identity?.();
  return who ? { kind: "human", id: who.id, name: who.name, group: localGroup(), app: true } : actorOf("person");
};

// The app's Ctrl+Z and redo (H6): the person's undo group in the editor's session (`since`, the bridge's), only what was
// made from the app (`app`). An undo whose inverse clashes with a later change of the same thing changes nothing
// (core): its cards are kept for the person and shown in the open History panels' conflict stack, each saying why in
// plain words (laptop report 90c4127, bug 6), so the person can keep the newer value or take theirs back. An undo or
// redo records only the inverse of what its change recorded (core never infers a ripple for it), so the undo of a drag
// isn't a "closed gap" that the undo of the split before it clashes with (laptop report #2, bug 6:
// test/sync/undo-split.test.js).
const STEP_REASON = {
  undo: "Not undone: this changed after your edit. Keep yours to undo it here anyway.",
  redo: "Not redone: this changed after your undo. Keep yours to redo it here anyway.",
};
const cardKey = (c) => `${c.path}|${canon(c.ours)}|${canon(c.theirs)}`;
async function keepStepCards(lc, bundlePath, author, which, cards) {
  const worded = cards.map((c) => ({ ...c, reason: STEP_REASON[which] }));
  // pressed again with nothing changed: the same cards, kept once
  const kept = new Set((await lc.carton.notices(author)).flatMap((n) => n.cards ?? []).map(cardKey));
  const fresh = worded.filter((c) => !kept.has(cardKey(c)));
  if (fresh.length) {
    const to = keyOf(author), at = Date.now(), rand = () => Math.random().toString(16).slice(2, 10);
    const n = fresh.length, text = `${which === "undo" ? "Your undo" : "Your redo"} didn't change anything: ${n === 1 ? "something it changes was" : `${n} things it changes were`} changed since. Choose in History or with cb conflicts / cb resolve.`;
    await lc.store.write([{ table: "notices", key: [to, at, 0, rand()], value: { to, kind: "late-conflict", text, cards: fresh, at } }]);
  }
  for (const panel of panels.get(bundlePath) ?? []) panel.reportConflicts(worded);
  return worded;
}

// The History panels open in this process, per bundle (fromCarton handles): a person's GUI save's cards show in them at
// once. Cards go to @carton/react as core returns them: core merges merge3(base, head, mine), so `ours` is head and
// `theirs` the person's edit, which fromCarton shows as "mine". It shows identical cards (same field and values, as
// `sameCard` tells them apart) once, so resolving a card removes every kept card identical to it, and no other. An
// agent's view-save cards are the other way round; sync/view-cards.js shows them to the person (`agentCards`).
const panels = new Map();

// Cards a commit raised, as a notice for its author in carton.db's notices table, where `cb conflicts`, the Stop hook
// and the History panel read them (core keeps notices only for confirmed and pending commits).
const keyOf = (a) => [a.kind, a.id, a.agentId].filter(Boolean).join("/");
async function keepCards(lc, author, cards) {
  const to = keyOf(author), at = Date.now(), rand = () => Math.random().toString(16).slice(2, 10);
  const text = `${cards.length} of your edits clashed with a change made meanwhile; the other change was kept. Choose with cb conflicts / cb resolve, or in History.`;
  await lc.store.write([{ table: "notices", key: [to, at, 0, rand()], value: { to, kind: "late-conflict", text, cards, at } }]);
}

// An agent's view save that clashed with the person's edit (the Materializer's onCards, which the sync half wires in the
// library worker): its cards are kept for the person and shown at once in the project's open History panels, the
// person's way round. The agent's own card is the engine's (cb conflicts, the .status sidecar); a pick on either side
// closes both (sync/view-cards.js).
const views = viewCards({ actorOf, keyOf, me: actorOf("person") });
export async function agentCards(bundlePath, saveCards) {
  const lc = await open(bundlePath);
  if (!lc) return { status: "off" };
  if (!saveCards?.cards?.length) return { status: "none" };
  const { by, cards, person } = await views.keep(lc, saveCards);
  for (const panel of panels.get(bundlePath) ?? []) panel.reportConflicts(cards, by);
  return { status: person ? "shown" : "kept", cards: cards.length };
}

// A Director turn's name in History, from the user's prompt: its first sentence, at most six words ("tighter intro").
// The adapter's helper wins when it has one. It is the user's own text, so it goes into the project's history only.
const turnLabel = (prompt) => {
  if (typeof cardboardHost.turnLabel === "function") return cardboardHost.turnLabel(prompt);
  const t = String(prompt ?? "").replace(/\s+/g, " ").trim();
  if (!t) return null;
  const words = t.split(/(?<=[.!?])\s/)[0].replace(/[.!?]+$/, "").split(" ");
  const label = words.slice(0, 6).join(" ");
  return label.length > 48 ? label.slice(0, 47).trimEnd() + "…" : words.length > 6 ? label + "…" : label;
};

// ---------------------------------------------------------------- H1: one change per mutation
// A commit into the project's current cut. R2: a shared cut's goes through the extension that syncs it (the lease
// holder commits; anyone else hands it to the holder), never straight into this handle: a non-holder's pending row is
// lost at the holder's next settle, and a handle without sync can't commit there at all. A clash keeps head's value
// and the rest of the edit lands (choices "ours", as cb's own writes do); the writer's side comes back as cards
// (`conflicts`, with `landed`). `kept`: the cards are already kept as a notice for the author (the holder's write did).
async function commitIn(lc, { doc, base, author, intent, gui }) {
  const c = lc.carton, ext = extensions.find((e) => typeof e.commitShared === "function");
  if (ext && (await c.cuts()).find((x) => x.id === c.cut)?.sequencer.kind !== "local") return ext.commitShared(lc, { doc, base, author, intent, gui });
  const r = await c.commit({ doc, ...(base ? { base } : {}), author, ...(intent ? { intent } : {}), choices: () => "ours" });
  return (r.status === "confirmed" || r.status === "pending") && r.resolved?.length ? { ...r, status: "conflicts", cards: r.resolved, landed: r.status } : r;
}

// A save Carton didn't write (an old cb, an editor, another program), committed as one and attributed to it. Returns
// the state it made, {ref, doc}: on a shared cut the holder's, which this handle may not be able to read.
async function importForeign(lc, project) {
  const r = await commitIn(lc, { doc: fromHost(project, (await lc.carton.head()).doc), author: actorOf("external:project.json") });
  if (r.status === "rejected") throw new Error("Carton rejected the outside save: " + r.reason);
  return r.head?.doc ? r.head : lc.carton.head();
}

// ui-words #3: the person's GUI saves whose answer the editor hadn't yet (a save made before the previous one's echo
// says so: meta.after). A save that landed as it was is a ref (setRev); one merged with someone else's change has no
// ref for the person's document, so it is held here, per bundle, as core's HeldBase: the person's document as it was
// saved, on the version it was made on, with that save in its causal past. Kept for the last few saves of a bundle.
const heldSaves = new Map();
const HELD_PER_BUNDLE = 4;
function holdSave(bundlePath, rev, held) {
  let m = heldSaves.get(bundlePath);
  if (!m) heldSaves.set(bundlePath, (m = new Map()));
  m.set(rev, held);
  while (m.size > HELD_PER_BUNDLE) m.delete(m.keys().next().value);
}
/**
 * The version a GUI save made right after the editor's previous save (its echo not back) builds on: that save's state.
 * Null when it isn't known here (a shared cut, a restart): the save is then made on its base, as before.
 */
async function afterSave(lc, bundlePath, after) {
  if (typeof after !== "number") return null;
  const held = heldSaves.get(bundlePath)?.get(after);
  if (held) return { base: held, doc: held.baseDoc };
  const ref = await refOf(lc, after);
  if (!ref) return null;
  try { return { base: ref, doc: await lc.carton.checkout(ref) }; } catch { return null; }
}

async function commit({ bundlePath, base, doc, actor, meta }) {
  // P2-1: a media entry this mutation removes keeps its details for a later restore or fold that brings it back
  await keepDropped(bundlePath, base, doc);
  if (meta?.materialize) {
    // materializeIn's: head checked again here, in the store's chain, where GUI saves are serialized. One that went
    // first moved head, and this document (made from the head before it) would put the older timeline over that save:
    // "stale", so nothing is written and the store keeps the document it had; materializeIn makes it again.
    if (meta.head && bundlePath) {
      const lc = await open(bundlePath, { projectId: doc.id });
      if (lc && !sameRef((await lc.carton.head()).ref, meta.head)) {
        staleMaterializations.add(meta.token);
        return { doc: base, status: "stale" };
      }
    }
    return { doc, status: "materialized" };
  }
  // A save Cardboard couldn't read back (no name: laptop, build 915eb36) is never a version either: history keeps no
  // such state, so the next saves still land. The store's write of it is refused at the install; the old file stays.
  const problems = projectProblems({ format: "cardboard-project", project: doc }, () => base);
  if (problems.length) {
    refuseProject(bundlePath, doc?.id, problems, "change");
    return { doc, status: "rejected", reason: "the project would have " + problems.join("; ") };
  }
  const lc = await open(bundlePath, { projectId: doc.id, doc: base ?? doc });
  if (!lc) return { doc, status: "off" };
  const c = lc.carton;
  // The version the edit was made on: the GUI's (its editor's), the apply's header, else what the writer read.
  const rev = meta?.base ?? meta?.rev ?? base?.stateUpdatedAt;
  let baseRef = await refOf(lc, rev), imported = null;
  // A GUI save made before the editor's previous save was answered holds that save too: made on it, so the two never
  // clash (ui-words #3). Unknown here: made on its base, as before.
  const chained = meta?.base !== undefined && baseRef ? await afterSave(lc, bundlePath, meta.after) : null;
  // A Carton header names its version exactly: one that can't be rebuilt any more (the apply checked it a moment ago)
  // is never committed as an edit of head.
  if (typeof rev === "string" && !baseRef) throw new Error(`the version ${rev} the edit was made on is no longer available`);
  if (!baseRef && base && rev === base.stateUpdatedAt) {
    // What the writer read isn't a state Carton wrote: a foreign save. Import it first, attributed as one.
    imported = await importForeign(lc, base);
    baseRef = imported.ref;
    await setRev(lc, base.stateUpdatedAt, baseRef);
  }
  if (chained) baseRef = chained.base;
  // Review P1: a cb write's base still pending in the lease holder resolves here (and in the holder, from a ref without
  // its hash) as the confirmed state it was built on, where an edit back to that state's value reads as no change. Its
  // document is what the store's base shows when that is its rev: pinned, the commit merges against exactly it; else
  // refused ("print it again"). (A GUI save's base is the editor's: its path is unchanged.)
  if (meta?.base === undefined && pendingRef(baseRef)) {
    const held = base && base.stateUpdatedAt === rev ? await pinHeld(lc, baseRef, base) : null;
    if (!held) throw new Error(`the version ${rev} the edit was made on is no longer available`);
    baseRef = held.header;
  }
  const baseDoc = chained?.doc ?? imported?.doc ?? (baseRef ? await c.checkout(baseRef) : (await c.head()).doc);
  const gui = meta?.base !== undefined && !!baseRef;
  const mine = gui ? projectGuiSave(baseDoc, doc, P()) : fromHost(doc, baseDoc);
  const intent = meta?.intents?.length ? { gui: meta.intents } : undefined;
  // A GUI save: the store writes project.json once this returns. The worker's Materializer is told before head moves,
  // so its rewrites wait for that write and take the file from it (hostWrite).
  const landing = gui ? hostWrite(bundlePath) : null;
  try {
    const out = await committed(lc, { bundlePath, doc, mine, baseRef, actor, meta, intent, gui });
    landing?.expect(out.doc);
    // apply-ryw: a cb write (`cb source apply`, MCP's apply_timeline) answers once the app's timeline.tsx shows it (the
    // store bridge's status asks, after the write and its project.json have landed)
    if (!inWorker && !gui) {
      const target = showTarget(out, actorOf(actor));
      if (target) toShow.set(out, { target });
    }
    return out;
  } catch (e) {
    landing?.settle();
    throw e;
  }
}
async function committed(lc, { bundlePath, doc, mine, baseRef, actor, meta, intent, gui }) {
  const c = lc.carton;
  const r = await commitIn(lc, { doc: mine, base: baseRef, author: actorOf(actor), intent, gui });
  if (r.status === "rejected") throw new Error("Carton rejected the change: " + r.reason);
  // Past changes its base didn't hold (they touched other records, so core took it without a rebase): head has them
  // and the writer's document doesn't, so the file gets head, below (laptop #2: a cb writer's document went into
  // project.json under head's rev, the next print showed the older values as that version, and its apply put them back)
  const passed = passedOthers(r, await knownOf(lc, baseRef));
  // Nothing of its own, and nothing else merged in: the writer's document is head. (Empty but rebased, or past others:
  // the writer's document is older than head in other fields, so the file gets head, below.)
  if (r.status === "confirmed" && r.empty && !gui && !r.rebased && !passed) return { ...r, doc, merged: false };
  // A pending save (shared cut, offline or the server slow) is the optimistic head: as a confirmation. The extension's
  // `head` is the holder's state when this handle can't read it (cb's handle has the confirmed rows only).
  const head = r.head?.doc ? r.head : await c.head();
  if ((r.status === "confirmed" || r.status === "pending") && !r.rebased && !passed) {
    // Nothing else was merged in. An agent's or the CLI's document is head as it stands. A GUI save is not: the
    // editor rounds times and drops fields it can't show, which Carton kept (B10), so the file gets head, under the
    // editor's own rev (its save's echo then only moves its base).
    if (!gui) {
      await setRev(lc, doc.stateUpdatedAt, r.ref);
      return { ...r, doc, merged: false };
    }
    const out = { ...(await projectFor(bundlePath, head.doc, doc)), stateUpdatedAt: doc.stateUpdatedAt };
    await setRev(lc, out.stateUpdatedAt, head.ref);
    return { ...r, doc: out, merged: false };
  }
  // A clash keeps head's value; the writer's side is a conflict card, kept as a notice for its author until it is
  // resolved (`cb conflicts`, the History panel), never dropped.
  if (r.status === "conflicts" && r.cards?.length) {
    const author = actorOf(meta?.actor ?? actor);
    if (!r.kept) await keepCards(lc, author, r.cards);
    // Only the person's own cards go to the person's panel: an agent's are its own (the Stop hook, cb conflicts).
    if (author.id === "person") for (const panel of panels.get(bundlePath) ?? []) panel.reportConflicts(r.cards);
  }
  // Merged (or carded): the file gets head, with a newer rev the next reader can name.
  const out = { ...(await projectFor(bundlePath, head.doc, doc)), stateUpdatedAt: Math.max(Date.now(), (doc.stateUpdatedAt ?? 0) + 1) };
  await setRev(lc, out.stateUpdatedAt, head.ref);
  // The person's document isn't head: held, so the editor's next save made before this one's answer builds on it. Its
  // change: a local cut's (`change`), or a shared cut's queued edit (`id`, pending or confirmed: the lease holder's
  // answer, this worker's or another process's). Before, a shared cut's was never held, and a quick second save after a
  // merged one went back to its base and clashed with the first at head ("You vs You"; ui-words follow-up). A base this
  // handle can't read (a shared cut's edit still pending in another process's holder) holds nothing: as before.
  const own = r.change?.id ?? (typeof r.id === "string" ? r.id : null);
  if (gui && typeof doc.stateUpdatedAt === "number" && own) {
    const on = baseRef && typeof baseRef === "object" && "baseDoc" in baseRef ? { seq: baseRef.baseSeq, causal: baseRef.causal ?? [] } : await lc.carton.resolve(baseRef).catch(() => null);
    if (on) holdSave(bundlePath, doc.stateUpdatedAt, { baseDoc: mine, baseSeq: on.seq, causal: [...on.causal, own] });
  }
  return { ...r, doc: out, merged: true };
}

/**
 * A change confirmed past others its base didn't hold. They touched other records, so core confirmed it without a
 * rebase (`rebased` 0), but they are in head and not in the writer's document: head is then not what the writer's
 * document shows, and must be written with a new rev. For a GUI save the editor then adopts it (else its echo moved
 * only the base, and the person's next save, made on head, undid the other change: ui-words #3); for cb's, the next
 * print shows head (laptop #2). Counted from seqs: no document is hashed. Wrong only towards "passed" (an extra write
 * of head), never towards losing the other change. `known`: how many changes the base holds (knownOf).
 */
function passedOthers(r, known) {
  if (r.status !== "confirmed" || typeof r.seq !== "number" || known === null) return false;
  return (r.empty ? r.seq : r.seq - 1) > known;
}
// The changes a commit's base holds, as a seq on its cut: a held state's, a rev's StateRef, or a Carton header's (cb's
// apply of a print). null when there is no base (the commit was made on head) or it can't be read.
async function knownOf(lc, base) {
  if (!base) return null;
  if (typeof base === "object") return "baseDoc" in base ? base.baseSeq + (base.causal?.length ?? 0) : typeof base.seq === "number" ? base.seq + (base.pending?.length ?? 0) : null;
  const on = await lc.carton.resolve(base).catch(() => null);
  return on ? on.seq + (on.causal?.length ?? 0) : null;
}

/**
 * The machine's current cut, as another process stored it (cb cut switch): adopted by this handle when it differs and is
 * a cut this handle knows. True when it moved.
 */
async function followCurrent(lc) {
  const stored = await lc.store.get("meta", ["current"]);
  if (typeof stored !== "string" || stored === lc.carton.cut) return false;
  if (!(await lc.carton.cuts()).some((c) => c.id === stored)) return false;
  await lc.carton.switchTo(stored, { persist: false });
  return true;
}

// What Cardboard's own code gets from a Carton state: a copy. Core's records are frozen, and Cardboard edits the
// documents its store holds in place, which on a frozen record is silently ignored in sloppy code (the edit is lost,
// with no error). The store bridge copies a merged save's put-back itself.
const forCardboard = (project) => structuredClone(project);

// The project to write for head, with a fresh rev recorded against it: after a Carton command changed head. null when
// project.json already shows head. (Through Cardboard's store: materializeIn, cb's `after`, sync's bring-in and pull.)
// `given`: the state a write just made when this handle can't read it (a write still pending on a shared cut, which the
// holder answered with its head: WriteOp `head`); the file never shows it yet.
// The bundles whose head was last refused for project.json (headProject), with what was wrong: the History panel and cb
// say so after a write, which otherwise looks done (Review of fix/restore-root, finding 3).
const headRefusals = new Map();
const HEAD_REFUSED = "This is saved in History, but the project file wasn't changed: Cardboard couldn't have opened it that way. Restore another version.";
async function headProject(bundlePath, current, given) {
  return (await headAt(bundlePath, current, given))?.project ?? null;
}
// headProject, with the version it was made from (`ref`).
async function headAt(bundlePath, current, given) {
  headRefusals.delete(bundlePath);
  const lc = await open(bundlePath, { projectId: current?.id });
  if (!lc) return null;
  const head = given?.doc ? given : await lc.carton.head();
  const known = given?.doc ? undefined : await revOf(lc, head.ref);
  if (known !== undefined && known === current?.stateUpdatedAt) return null;
  // A Carton write is an edit like any other: the library's "Updated" time moves with it (laptop, merge/prod-2 P3: a
  // restore left it as it was). Cardboard's scoped merge keeps the newer of the store's and this one.
  const at = Math.max(Date.now(), (current?.stateUpdatedAt ?? 0) + 1);
  const out = forCardboard({ ...(await projectFor(bundlePath, head.doc, current)), stateUpdatedAt: at, updatedAt: new Date(at).toISOString() });
  // a head Cardboard couldn't read is never handed on (the pages adopt an undo's project at once): nothing to write
  const problems = projectProblems({ format: "cardboard-project", project: out }, () => current);
  if (problems.length) return headRefusals.set(bundlePath, problems), refuseProject(bundlePath, current?.id, problems, "head"), null;
  await setRev(lc, out.stateUpdatedAt, head.ref);
  return { project: out, ref: head.ref };
}
// The same version: a cut, a seq and the pending changes on it.
const sameRef = (a, b) => !!a && !!b && a.branchId === b.branchId && a.seq === b.seq && (a.pending ?? []).join() === (b.pending ?? []).join();

// ---------------------------------------------------------------- a GUI save's project.json, for the Materializer
// The worker's Materializer prints timeline.tsx from head and project.json's unversioned fields. After a GUI save the
// store writes project.json itself (writeProject off): the Materializer is told the save is the host's (an extension's
// hostWrite: onHeadChange("gui", {after})), so its rewrites wait for the write, and `after` gives it the envelope the
// store wrote with the file's stamp, so it doesn't read and parse the file again. The store writes a project's
// documents one at a time, and a document queued behind a running write may be replaced by a newer one (which holds
// the save: it is made from head after it). So a save is resolved by the first project.json install that starts once
// commit() has returned it to the store (`queued`): its own write, or the one that replaced it. An earlier write still
// running then doesn't count. A save whose write never comes (the store's write failed before the install) is let go
// after LANDING_MS with nothing, which the Materializer takes as "read the file" (it waits 5 s at most itself).
const LANDING_MS = 6000;
const landings = new Map(); // landingKey(bundle) → [{queued, settle}] in save order
// the bundle as the file system names it: case-insensitively on Windows and macOS (the save's bundle path and the
// write's folder come from different calls of Cardboard's store)
const landingKey = (dir) => { const r = path.resolve(dir); return process.platform === "win32" || process.platform === "darwin" ? r.toLowerCase() : r; };
function hostWrite(bundlePath) {
  const ext = extensions.filter((e) => typeof e.hostWrite === "function");
  if (!bundlePath || !ext.length) return null;
  const key = landingKey(bundlePath);
  let resolve;
  const after = new Promise((r) => (resolve = r));
  const l = { queued: false };
  const timer = setTimeout(() => l.settle(), LANDING_MS);
  timer.unref?.();
  l.settle = (w) => {
    clearTimeout(timer);
    const list = landings.get(key);
    if (list?.includes(l)) list.length === 1 ? landings.delete(key) : list.splice(list.indexOf(l), 1);
    resolve(w);
  };
  // its document goes to the store's write queue now (commit() returns it); nothing to write: let go
  l.expect = (doc) => (doc ? (l.queued = true) : l.settle());
  let told = false;
  for (const e of ext) {
    try { told = !!e.hostWrite(bundlePath, after) || told; } catch (err) { warnOnce("hostWrite:" + (e.name ?? "?"), "an extension's hostWrite failed: " + errText(err)); }
  }
  if (!told) return clearTimeout(timer), null;
  landings.set(key, [...(landings.get(key) ?? []), l]);
  return l;
}

// ---------------------------------------------------------------- media details (laptop, merge/prod-2 P2-1, P2-2)
// What Cardboard knows about a media file and Carton doesn't version (its size, duration and dimensions, where it plays
// from, thumbnail and waveform ids, when it was added) lived only in project.json. A restore to a version without a clip
// (main@1) dropped its entry, and restoring the clip's version brought back only what history holds (its id, kind and
// file name): no duration, size or thumbnail (`cb media list` showed "-"), and with no `src` the editor played it black
// until a restart, whose load fills `src` in. Now:
// 1. A write that drops a media entry from project.json keeps the entry's details first, in the bundle's
//    .carton/media.json (@carton/cardboard/node's MediaDetails): a store mutation (commit: the document it was applied
//    to against the one it made) and a materialization (the file it replaces against what it writes). A write that
//    drops nothing does no I/O for this.
// 2. A materialization carries each entry's details over: from the file it replaces, else as last kept for its id.
// 3. What neither has (a project an earlier build's restore, or the root-restore bug, left without them) Cardboard finds
//    again as its import does (reprobeMedia: its own probe of the file), and in the app its derive fills in thumbnails
//    and waveforms (deriveMedia; cb leaves that to the app, so two processes never derive one file at once). Nothing is
//    guessed: a detail none of these gives stays unset.
const mediaMemory = new Map(); // landingKey(bundle) → MediaDetails (with its bundle)
function detailsOf(bundle) {
  const key = landingKey(bundle);
  let d = mediaMemory.get(key);
  if (!d) mediaMemory.set(key, (d = Object.assign(new MediaDetails(bundle, BUSY), { bundle })));
  return d;
}
// The details of the media entries `before` has and `after` doesn't, kept before a write of `after` replaces `before`:
// under the bundle's install lock (every writer of media.json holds it). A failure never stops the write.
async function keepDropped(bundle, before, after) {
  if (!bundle) return;
  const gone = droppedMedia(before, after);
  if (!gone.length) return;
  try {
    const d = detailsOf(bundle), ch = d.changes(gone);
    if (ch && (await withInstallLock(bundle, () => d.save(ch))) === LOCK_BUSY) warnOnce("media-details-busy:" + bundle, "a media entry's details weren't kept: another process held " + path.basename(bundle) + "'s install lock");
  } catch (e) {
    warnOnce("media-details:" + bundle, "a media entry's details couldn't be kept: " + errText(e));
  }
}
// materializeProject for a bundle: each media entry's details from `current`, else as last kept for its id (media.json
// read only when `current` lacks an entry). `keep` (a project that is written): what it drops from `current` is kept
// first.
async function projectFor(bundle, doc, current, { keep = true } = {}) {
  if (!bundle) return materializeProject(doc, current);
  let look;
  const known = (id, versioned) => {
    try { return (look ??= detailsOf(bundle).known())(id, versioned); } catch (e) {
      look = () => undefined;
      warnOnce("media-details:" + bundle, "the media details kept for " + path.basename(bundle) + " couldn't be read: " + errText(e));
    }
  };
  const out = materializeProject(doc, current, known);
  if (keep) await keepDropped(bundle, current, out);
  return out;
}

// Cardboard 1.4.0's import gives a file's media entry (library-worker.js `j4`; the CLI's copy is the same): where it
// plays from, its format (the file name's extension), its size on disk, the probe's facts, and "metadata complete".
// Its thumbnails, waveform and album art come from the derive steps, which ensureDerived runs (deriveMedia).
const mediaUrl = (id) => "cardboard-media://media/" + encodeURIComponent(id);
const extOf = (name) => {
  const t = name.lastIndexOf("."), r = Math.max(name.lastIndexOf("/"), name.lastIndexOf("\\"));
  return t <= r + 1 ? "" : name.slice(t + 1).toLowerCase();
};
function importFacts(id, fileName, size, p) {
  const o = { src: mediaUrl(id), format: extOf(fileName), size, metadataStatus: "complete" };
  if (p.kind !== "image" || p.isAnimated) o.duration = p.duration;
  if (p.width !== undefined) o.width = p.width;
  if (p.height !== undefined) o.height = p.height;
  if (p.kind === "video") {
    o.hasAudio = p.hasAudio;
    if (p.codec) o.codec = p.codec;
    if (p.frameRate !== undefined) o.frameRate = p.frameRate;
  }
  if (p.kind === "audio" && p.codecName) o.codec = p.codecName;
  if (p.kind === "image" && p.isAnimated) o.isAnimated = true;
  return o;
}
// The file media entries of `project` that lack what Cardboard's import gives (`lacksDetails`: where it plays from, its
// size, its duration), and that play from a file of this library (no `src` yet, or Cardboard's own URL for the id: not a
// cloud project's signed URL).
const lackingDetails = (project) => (Array.isArray(project?.media) ? project.media : []).filter((m) => m && typeof m.id === "string" && lacksDetails(m) && (m.data.src === undefined || m.data.src === mediaUrl(m.id)));
// The bundle's media/ folder as last listed, until it changes (Cardboard's recovery of unlisted media looks there).
const mediaDirs = new Map(); // landingKey(bundle) → {stamp, names}
async function mediaNames(bundlePath) {
  const dir = path.join(bundlePath, "media"), st = await fs.promises.stat(dir).catch(() => null);
  if (!st) return [];
  const key = landingKey(bundlePath), stamp = `${st.mtimeMs}:${st.ino}`, hit = mediaDirs.get(key);
  if (hit?.stamp === stamp) return hit.names;
  const names = await fs.promises.readdir(dir).catch(() => []);
  mediaDirs.set(key, { stamp, names });
  return names;
}
// A file whose probe failed, with its stamp then: not probed again until it changes (every Ctrl+Z materializes).
const failedProbes = new Map(); // `${bundle}|${id}` → "<size>:<mtime>"
const PROBES_AT_ONCE = 4;
/**
 * Cardboard's own probe of each file whose entry in `project` lacks what its import gives: {project, ids}, the project
 * with those entries filled in as the import fills them (only the fields they don't have), or null when none lacks them
 * or none could be found. The file is the one Cardboard's library has for the id, else the one its loader's recovery of
 * unlisted media finds (the bundle's media/<id>.<ext>), registered with the library as that recovery does, so the app
 * serves it at once. The probe is of the file as it is now (`inspect.probePath`, as the import probes; review of
 * fix/media-meta #2: the probe Cardboard cached for the id may be of a file since replaced). A file not there now is
 * looked for again next time; one whose probe failed, or isn't of the entry's kind, once it changes (review #4).
 */
async function reprobeMedia(lib, bundlePath, project) {
  const want = lackingDetails(project);
  if (!want.length || typeof lib?.inspect?.probePath !== "function" || !lib.media) return null;
  const key = (id) => landingKey(bundlePath ?? "") + "|" + id;
  const filled = new Map();
  let names = null; // the media/ folder, listed (or its cached list checked) once per call
  const one = async (m) => {
    try {
      let file = lib.media.resolvePath?.(m.id) ?? null, found = false;
      if (!file && bundlePath && typeof lib.media.register === "function") {
        const name = (await (names ??= mediaNames(bundlePath))).find((n) => path.basename(n, path.extname(n)) === m.id);
        if (name) file = path.join(bundlePath, "media", name), (found = true);
      }
      const st = file ? await fs.promises.stat(file).catch(() => null) : null;
      if (!st?.isFile()) return;
      const stamp = `${st.size}:${st.mtimeMs}`;
      if (failedProbes.get(key(m.id)) === stamp) return;
      if (found) lib.media.register([{ mediaId: m.id, nativePath: file, ownedByBundle: true }]);
      let probe = null;
      try { probe = await lib.inspect.probePath(file); } catch (e) { warnOnce("reprobe:" + bundlePath, "a media file couldn't be probed again: " + errText(e)); }
      if (!probe || probe.kind !== m.data.type) return void failedProbes.set(key(m.id), stamp);
      failedProbes.delete(key(m.id));
      filled.set(m.id, importFacts(m.id, m.data.fileName ?? path.basename(file), st.size, probe));
    } catch (e) {
      warnOnce("reprobe:" + bundlePath, "a media file's details couldn't be read again: " + errText(e));
    }
  };
  for (let i = 0; i < want.length; i += PROBES_AT_ONCE) await Promise.all(want.slice(i, i + PROBES_AT_ONCE).map(one));
  if (!filled.size) return null;
  const media = project.media.map((m) => {
    const f = filled.get(m?.id);
    if (!f) return m;
    const data = { ...m.data };
    for (const [k, v] of Object.entries(f)) if (data[k] === undefined) data[k] = v;
    return { ...m, data };
  });
  return { project: { ...project, media }, ids: [...filled.keys()] };
}
// Cardboard's derive for a project (ensureDerived: thumbnails, waveforms, album art, from its cache or made again), after
// reprobeMedia's entries are in project.json. True when it changed the project.
async function deriveMedia(lib, projectId) {
  if (typeof lib?.ensureDerived !== "function") return false;
  try { return !!(await lib.ensureDerived(projectId))?.documentUpdated; } catch (e) {
    warnOnce("derive:" + projectId, "a media file's thumbnails couldn't be made again: " + errText(e));
    return false;
  }
}

// ---------------------------------------------------------------- files: displace, then install
const installs = new Map(); // target path → { files: DisplacedFiles, own, noLinks, timer }
const SEEN_KEEP = 256;
// Busy files (Windows: another process holds one open) are waited out on timers by @carton/cardboard/node, never by
// blocking this thread; every call is awaited, so a failure reaches the install's caller as before. Counted here.
const busy = { busy: 0 }, BUSY = { counter: busy };
const seenFile = (file) => path.join(path.dirname(file), ".carton", "seen.json");
const sha = (b) => createHash("sha256").update(b).digest("hex");
const readSeen = (file) => { try { return JSON.parse(fs.readFileSync(seenFile(file), "utf8")); } catch { return {}; } };
// What Carton wrote at each path, shared by every process on the machine: a displaced file with one of these hashes is
// Carton's own and goes; anything else is held as a foreign save. Losing an entry to a race only keeps a file.
// `held`: the install's own copy of seen.json, read once when it took the bundle's install lock (every writer of the
// file holds that lock, so the copy stays current while it is held; it is updated here and written whole, as before).
// Under the lock .carton/ exists (the lock is a folder in it). Without one, the file is read and the folder made here.
const markSeen = async (file, hash, held) => {
  const all = held ?? readSeen(file), name = path.basename(file);
  all[name] = [hash, ...(all[name] ?? []).filter((h) => h !== hash)].slice(0, SEEN_KEEP);
  if (!held) fs.mkdirSync(path.dirname(seenFile(file)), { recursive: true });
  const tmp = seenFile(file) + "." + process.pid + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(all));
  // On Windows a reader (another process, an indexer) holding the old file makes the rename fail busy for a moment.
  await retryBusy(() => fs.renameSync(tmp, seenFile(file)), BUSY);
};

// One install at a time per bundle, across processes (mkdir is atomic on NTFS too): the check that a file is still
// head and its install happen together, so two writers can't leave an older state on disk after a newer one.
// The holder writes who it is and beats every second. Another process takes the lock over from a holder silent for 10 s
// whose pid no longer runs, or from any holder silent for 60 s (Windows reuses pids, so a running pid may be someone
// else); it moves the folder aside (one rename, so only one taker wins). A holder that finds after its install that it
// lost the lock (it was stalled that long) puts back the newer file it displaced. A writer that waits 30 s skips its
// install (its commit is in history; the next install brings the file to head).
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const LOCK_BUSY = Symbol("busy");
// Test seams (scripts/carton/test): `between` runs between the displace and the link, as displaceThenInstall's does;
// `materialize` runs in materializeIn once it has made the project from head, before the store has it.
const testHooks = { between: null, installed: null, lockWaitMs: null, materialize: null };
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === "EPERM"; } };
function takeOverIfAbandoned(dir) {
  const owner = path.join(dir, "owner");
  let who = null, beat;
  try { who = JSON.parse(fs.readFileSync(owner, "utf8")); beat = fs.statSync(owner).mtimeMs; } catch { try { beat = fs.statSync(dir).mtimeMs; } catch { return; } }
  const silent = Date.now() - beat;
  if (!(silent > 60_000 || (silent > 10_000 && !(who && alive(who.pid))))) return;
  const aside = dir + ".abandoned." + process.pid + "." + Math.random().toString(16).slice(2);
  try { fs.renameSync(dir, aside); fs.rmSync(aside, { recursive: true, force: true }); } catch {}
}
async function withInstallLock(bundle, fn) {
  const dir = path.join(bundle, ".carton", "install.lock"), owner = path.join(dir, "owner"), t0 = Date.now();
  const me = process.pid + "." + Math.random().toString(16).slice(2);
  // A bundle whose history is kept in app data (a synced, network or FAT folder: L15) may have no .carton/ yet: without
  // it no project could be made there with Carton on (cb project create failed: ENOENT on the lock).
  fs.mkdirSync(path.dirname(dir), { recursive: true });
  for (;;) {
    try { fs.mkdirSync(dir); fs.writeFileSync(owner, JSON.stringify({ pid: process.pid, me })); break; } catch (e) {
      if (e.code !== "EEXIST") throw e;
      takeOverIfAbandoned(dir);
      if (Date.now() - t0 > (testHooks.lockWaitMs ?? 30_000)) return LOCK_BUSY;
      await sleep(5);
    }
  }
  const mine = () => { try { return JSON.parse(fs.readFileSync(owner, "utf8")).me === me; } catch { return false; } };
  const beat = setInterval(() => { try { const t = new Date(); fs.utimesSync(owner, t, t); } catch {} }, 1000);
  beat.unref?.();
  try { return await fn(mine); } finally {
    clearInterval(beat);
    if (mine()) fs.rmSync(dir, { recursive: true, force: true });
  }
}
// The rev a file being installed was written from: project.json's stateUpdatedAt, timeline.tsx's header.
const revIn = (file, bytes) => {
  const text = bytes.toString("utf8");
  if (path.basename(file) === "project.json") { try { return JSON.parse(text).project?.stateUpdatedAt; } catch { return undefined; } }
  const m = /^\s*\/\/\s*cardboard:rev\s+(\d+)\s*$/m.exec(text);
  return m ? Number(m[1]) : undefined;
};

// `rev`: the rev the caller wrote into the file (the store's writeNow passes project.json's stateUpdatedAt), so a large
// project.json isn't parsed again on every save just to read it back; without one, it is read from the file.
// `envelope`: the object writeNow stringified into it, for the GUI saves this write lands (hostWrite, above): with the
// file's stamp once the install put those bytes there (`own`, checked under the install lock), else nothing.
async function install(tmp, file, seenStamp, rev, envelope) {
  const due = path.basename(file) === "project.json" ? (landings.get(landingKey(path.dirname(file))) ?? []).filter((l) => l.queued) : [];
  let out = false;
  try { return (out = await installFile(tmp, file, seenStamp, rev, envelope)); } finally {
    if (due.length) {
      const stamp = out === true && envelope ? installs.get(file)?.own?.stamp : null;
      for (const l of due) l.settle(stamp ? { project: { envelope, stamp } } : undefined);
    }
  }
}
async function installFile(tmp, file, seenStamp, rev, envelope) {
  const bundle = path.dirname(file);
  // A project.json Cardboard couldn't read back is never installed, whoever wrote it: the old file stays (false: the store
  // reads the disk again). The envelope writeNow stringified is checked as it is (no parse); a file without one is read.
  if (path.basename(file) === "project.json") {
    let env = envelope;
    if (env === undefined) try { env = JSON.parse(fs.readFileSync(tmp, "utf8")); } catch { env = null; }
    const problems = projectProblems(env, () => readProject(bundle));
    if (problems.length) {
      refuseProject(bundle, env?.project?.id, problems, "save");
      fs.rmSync(tmp, { force: true });
      return false;
    }
  }
  // Without history for this project there is nothing to import a foreign save into: write as 1.4.0 does.
  // (A new project's first write: project.json isn't there yet, so its id and first state come from what the store is
  // writing, and history starts with it. Laptop #9: opened without them, cb's `project create` said history was off
  // because "project.json has none", though the next call started it.)
  const first = path.basename(file) === "project.json" && envelope?.project?.id ? { projectId: envelope.project.id, doc: envelope.project } : {};
  const lc = await open(bundle, first);
  if (!lc) return fs.promises.rename(tmp, file);
  // H8: Cardboard's print of timeline.tsx isn't installed where the worker's Materializer writes it.
  if (path.basename(file) === "timeline.tsx" && (timelineOwned(bundle) || (await workerWritesTimeline(lc)))) return fs.rmSync(tmp, { force: true }), true;
  let installed = true, recover = null;
  const done = await withInstallLock(bundle, async (mine) => {
    const bytes = fs.readFileSync(tmp);
    // A writer whose state is no longer head (another process committed and installed after it) doesn't install: the
    // newer state is, or is about to be, on disk. It returns false, so the store reads the disk again.
    const ref = await refOf(lc, Number.isFinite(rev) && path.basename(file) === "project.json" ? rev : revIn(file, bytes));
    if (ref) {
      const head = (await lc.carton.head()).ref;
      if (ref.branchId !== head.branchId || ref.seq < head.seq) return fs.rmSync(tmp, { force: true }), false;
    }
    let s = installs.get(file);
    if (!s) {
      s = { files: new DisplacedFiles(path.join(bundle, ".carton", "displaced"), BUSY), own: null, noLinks: !hardLinksWork(bundle), timer: null, mine: new Set(), foreign: false };
      installs.set(file, s);
    }
    const journal = readJournal(bundle);
    // seen.json once per install, not once per step (sweep, markSeen, settle each read it): a save's install reads it
    // once and writes it once
    const seen = readSeen(file);
    await sweep(file, s, journal, seen);
    // Taken over while waiting (this process was stalled): the new holder installs.
    if (!mine()) return fs.rmSync(tmp, { force: true }), false;
    const r = await displaceThenInstall(file, tmp, s.files.next, { ...BUSY, noLinks: s.noLinks, lastStamp: s.own?.stamp ?? null, ...(testHooks.between ? { between: testHooks.between } : {}) });
    // Taken over while installing (stalled for a minute): the last file displaced may be the successor's, newer than
    // ours. It is put back below, under the lock taken again, only if it is still newer than what is on disk then.
    if (!mine()) recover = r.displaced.at(-1) ?? null, installed = false;
    await markSeen(file, sha(bytes), seen);
    // The file to put back isn't held yet: a review before the put-back would delete it as Carton's own. It is
    // journaled now, so a later sweep finds it if this process exits before the put-back decides.
    await settle(file, s, r.displaced.filter((p) => p !== recover), journal, { seenStamp, held: seen });
    if (recover) s.mine.add(recover), (journal[path.basename(recover)] = { at: Date.now(), stamp: await statStamp(recover, BUSY) });
    await writeJournal(bundle, journal);
    if (testHooks.installed) await testHooks.installed(file);
    s.own = await ownAfter(file, bytes);
    s.files.endRound();
    reviewLater(file, s);
    return installed;
  });
  if (recover) await putBack(lc, file, recover);
  if (done !== LOCK_BUSY) return done;
  warnOnce("busy:" + bundle, "another process kept the install lock of " + path.basename(bundle) + "; its file catches up at the next save");
  fs.rmSync(tmp, { force: true });
  return false;
}

// What an install moved aside is held, never deleted at once: the file the writer read (its stamp unchanged) or one
// Carton wrote (its hash in seen.json) goes only if its bytes and stamp are still the same after the hold. An in-place
// writer that opened it just before and writes after is caught then (P10 settle-2); anything else is a foreign save,
// imported by the review. Each is journaled with when it was moved and its stamp then, for the sweep.
async function settle(file, s, paths, journal, { seenStamp = null, firstOwn = s.own, held } = {}) {
  const seen = new Set((held ?? readSeen(file))[path.basename(file)] ?? []);
  for (const [i, p] of paths.entries()) {
    s.mine.add(p);
    const b = fs.readFileSync(p), st = await statStamp(p, BUSY);
    journal[path.basename(p)] = { at: Date.now(), stamp: st };
    const h = sha(b), mine = (i === 0 && seenStamp && st === seenStamp) || seen.has(h);
    if (!mine) s.foreign = true;
    // The file the writer read is known from now on, so a later process can sweep it if this one exits first.
    else if (!seen.has(h)) await markSeen(file, h, held);
    s.files.hold([p], mine ? { bytes: b, stamp: st } : i === 0 ? firstOwn : null);
  }
}
// The review runs after the hold (never inside a write: applying a foreign timeline.tsx writes the project again). A
// foreign file keeps the process alive until it is applied, so a short cb call doesn't exit with it unapplied.
function reviewLater(file, s) {
  if (!s.files.size) return;
  clearTimeout(s.timer);
  s.timer = setTimeout(() => {
    s.foreign = false;
    review(file, s).catch((e) => warnOnce("review:" + file, "review of displaced files failed: " + errText(e)));
  }, 300);
  if (!s.foreign) s.timer.unref?.();
}

// After losing the lock in the middle of an install: with the lock held again, the displaced file goes back only if its
// state is on head's cut and newer than the state on disk now (a third writer may have installed since). What the
// put-back moves aside is held as an install's is (a save made while this waited is someone's, and is imported), and
// the file it took back from goes after the hold like any of Carton's.
async function putBack(lc, file, from) {
  const bundle = path.dirname(file), s = installs.get(file);
  const done = await withInstallLock(bundle, async (mine) => {
    const journal = readJournal(bundle);
    try {
      let back, now, bytes;
      try { bytes = fs.readFileSync(from), (back = await refOf(lc, revIn(file, bytes))); } catch { return; }
      try { now = await refOf(lc, revIn(file, fs.readFileSync(file))); } catch {}
      const head = (await lc.carton.head()).ref;
      if (!back || back.branchId !== head.branchId || (now && now.branchId === head.branchId && now.seq >= back.seq) || !mine()) return;
      const tmp = from + ".back";
      fs.copyFileSync(from, tmp);
      const r = await displaceThenInstall(file, tmp, s.files.next, { ...BUSY, noLinks: s.noLinks });
      await settle(file, s, r.displaced, journal);
      s.own = await ownAfter(file, bytes);
    } finally {
      if (fs.existsSync(from)) await settle(file, s, [from], journal, { firstOwn: null });
      await writeJournal(bundle, journal);
      s.files.endRound();
      reviewLater(file, s);
    }
  });
  // The lock stayed busy (its holder is installing): no put-back. The file is held and reviewed as any displaced file
  // is (Carton's goes after the hold, someone's save is imported); its journal entry is the install's.
  if (done === LOCK_BUSY && fs.existsSync(from)) {
    await settle(file, s, [from], {}, { firstOwn: null });
    s.files.endRound();
    reviewLater(file, s);
  }
}

// What Carton just installed, as the proof a later hold compares with: the file's stamp and bytes, kept only if those
// bytes are the ones installed. A save that landed since (an await may have let one in) is someone's, never Carton's.
async function ownAfter(file, bytes) {
  const stamp = await statStamp(file, BUSY), b = fs.readFileSync(file);
  return b.equals(bytes) ? { bytes: b, stamp } : null;
}

// When each displaced file was moved aside and its stamp then (.carton/displaced.json), written under the install
// lock. A file's own mtime says nothing: a rename keeps it.
const journalFile = (bundle) => path.join(bundle, ".carton", "displaced.json");
const readJournal = (bundle) => { try { return JSON.parse(fs.readFileSync(journalFile(bundle), "utf8")); } catch { return {}; } };
const writeJournal = async (bundle, j) => {
  const tmp = journalFile(bundle) + "." + process.pid + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(j));
  await retryBusy(() => fs.renameSync(tmp, journalFile(bundle)), BUSY);
};

// Files an earlier process displaced and exited before its hold ended: one moved aside over 10 s ago, untouched since
// (its stamp is the one journaled then) and holding a state Carton wrote, goes; anything else stays for a person to
// look at (importing an old file now would revert newer changes). Runs under the install lock.
async function sweep(file, s, journal, held) {
  const dir = path.join(path.dirname(file), ".carton", "displaced");
  let names;
  try { names = fs.readdirSync(dir); } catch { return; }
  const seen = new Set((held ?? readSeen(file))[path.basename(file)] ?? []), now = Date.now();
  // (a set: a burst of saves leaves hundreds of files here until their review, and this runs at every install)
  const present = new Set(names);
  for (const n of Object.keys(journal)) if (!present.has(n)) delete journal[n];
  for (const n of names) {
    const p = path.join(dir, n), j = journal[n];
    if (s.mine.has(p) || !j || now - j.at < 10_000) continue;
    try {
      if ((await statStamp(p, BUSY)) === j.stamp && seen.has(sha(fs.readFileSync(p)))) fs.rmSync(p, { force: true }), delete journal[n];
    } catch {}
  }
}

// A displaced file Carton didn't write is someone's save: a project.json is imported as an outside change, a
// timeline.tsx is applied through Cardboard's own mirror (as its watcher would have), and only then is it deleted.
// One that can't be applied yet stays in .carton/displaced/ and is reported: never lost, never silently dropped.
async function review(file, s) {
  const bundle = path.dirname(file), isProject = path.basename(file) === "project.json";
  const parse = (b) => { try { return JSON.parse(b.toString("utf8")); } catch { return null; } };
  const out = await s.files.review((b) => (isProject ? parse(b)?.project != null : b.length > 0));
  for (const f of out.foreign) {
    try {
      if (isProject) {
        const lc = await open(bundle);
        if (!lc) throw new Error("no history for the project");
        await importForeign(lc, parse(f.bytes).project);
      } else {
        const h = hostOf(bundle), id = h?.store.idForBundlePath?.(path.resolve(bundle));
        if (!id) throw new Error("no mirror for the project in this process");
        const r = await h.mirror.apply(id, f.bytes.toString("utf8"), { cartonActor: "external:timeline.tsx" });
        if (!r?.applied) throw new Error("it doesn't apply: " + (r?.diagnostics?.[0]?.message ?? "unknown"));
      }
      await s.files.release(f.path);
    } catch (e) {
      console.warn(`[carton] a save of ${path.basename(file)} by another program was moved aside and kept at ${f.path}: ${errText(e)}`);
    }
  }
  for (const f of out.partial) console.warn(`[carton] a save of ${path.basename(file)} that never finished was kept at ${f.path}`);
}

// ---------------------------------------------------------------- what the bridges call
// A project.json Cardboard can't read, said once per process. cb reads every project of the library before each command,
// so it came with every cb command while any project was damaged (laptop, merge/prod-2 P3): cb says it only when its
// command line names that project (its id, its name, its folder or its path). The library worker says it once, in the
// app's log.
function warnDamaged(key, { bundlePath, id, name }, msg) {
  if (!inWorker && !namedOnCommandLine({ bundlePath, id, name })) return;
  warnOnce(key, msg);
}
function namedOnCommandLine({ bundlePath, id, name }) {
  const folder = path.basename(bundlePath ?? "");
  const lower = (x) => (typeof x === "string" ? x.trim().toLowerCase() : null);
  const names = new Set([lower(name), lower(folder), lower(folder.replace(/\.cardboard$/i, ""))].filter(Boolean));
  return process.argv.slice(2).some((a) => {
    const t = a.trim();
    if (!t) return false;
    if (t === id || names.has(t.toLowerCase())) return true;
    try { return !!bundlePath && landingKey(t) === landingKey(bundlePath); } catch { return false; }
  });
}
// The stores and mirrors of this process (one per library), for applying a foreign timeline.tsx Carton displaced.
const hosts = [];
const hostOf = (bundlePath) => hosts.find((h) => path.resolve(bundlePath).toLowerCase().startsWith(path.resolve(h.root).toLowerCase()));

export const cardboard14 = {
  headScope,
  release,
  attach({ root, store, mirror }) {
    hosts.push({ root, store, mirror });
  },
  commit,
  install,
  timelineOwned,
  timelineEvent,
  mirrorOwned,
  // apply-ryw: how a cb apply's write shows in the app's timeline.tsx, once it does (the store bridge's status)
  showCommitted,
  // H11: which files in .scratch/views/ are Carton's (the store bridge's Save As walk and Open Project scrub)
  cartonViewFile,
  headProject,
  hasHistory: async (bundlePath) => !!(await open(bundlePath)),
  // cb's `after` (cli-bridge.js): Cardboard's own probe of a media file whose entry head brought back without details,
  // before head goes into project.json (P2-1). cb doesn't derive (thumbnails, waveforms): the app does, one at a time.
  reprobeMedia,
  // What was wrong with the head last refused for this bundle's project.json, else null (cb's `after`).
  headRefused: (bundlePath) => headRefusals.get(bundlePath) ?? null,
  // Laptop, build 915eb36: Restore of "Started the cut" wrote a project.json with no name, which Cardboard's reader
  // refuses, so the project left the library and cb found nothing. When the reader refuses a bundle's project.json and
  // the bundle's history is in .carton/carton.db, the reader gets the file with the name the project last had in that
  // history (else its folder's): the library lists it again, cb finds it (history, cut list, restore), and the editor
  // opens it with its History, where Restore of a good version brings the rest back. Nothing is written here, and
  // history never starts from such a file (an existing carton.db only). Only a JSON file with the project's id; any other
  // damage stays as it was. The answer is kept per bundle while the file is the same.
  async recover({ bundlePath, text }) {
    if (!bundlePath || typeof text !== "string") return null;
    const hit = recovered.get(bundlePath);
    if (hit?.text === text) return hit.out;
    let env;
    try { env = JSON.parse(text); } catch { return null; }
    const p = env?.project;
    if (!p || typeof p !== "object" || typeof p.id !== "string" || !p.id) return null;
    // The history, wherever it is kept (the bundle, or app data for a synced, network or FAT folder), read before
    // anything opens it: every carton.db there must be this project's and made on this computer. Another project's
    // (a stale or copied .carton) would put its versions into this one; another computer's would be set aside on open,
    // and a new history started.
    const dbs = existingCartonDbs({ projectDir: bundlePath, projectId: p.id });
    if (!dbs.length) return null;
    for (const db of dbs) {
      const owner = await historyOwner(db);
      if (owner?.projectId === p.id && owner.mine) continue;
      return warnDamaged("recover-owner:" + bundlePath, { bundlePath, id: p.id, name: p.name }, `project ${p.id}'s project.json can't be read by Cardboard, and its history there is ${owner ? (owner.mine ? "another project's" : "another computer's") : "unreadable"}: not used`), null;
    }
    const lc = await open(bundlePath, { projectId: p.id });
    if (!lc || lc.carton.projectId !== p.id) return null;
    const name = (typeof p.name === "string" && p.name.trim()) ? p.name : (await lastName(lc)) ?? (path.basename(bundlePath, ".cardboard").trim() || "Untitled Project");
    const out = { ...env, format: "cardboard-project", project: { ...p, name, ...(typeof p.updatedAt === "string" ? {} : { updatedAt: new Date(typeof p.stateUpdatedAt === "number" ? p.stateUpdatedAt : Date.now()).toISOString() }) }, media: Array.isArray(env.media) ? env.media : [] };
    const left = projectProblems(out);
    if (left.length) return warnDamaged("recover:" + bundlePath, { bundlePath, id: p.id, name }, `project ${p.id}'s project.json can't be read, even through its history (${left.join("; ")})`), null;
    warnDamaged("recovered:" + bundlePath, { bundlePath, id: p.id, name }, `project ${p.id}'s project.json can't be read by Cardboard (${projectProblems(env).join("; ")}); it is listed through its history: restore a version in History to bring it back`);
    const json = JSON.stringify(out);
    recovered.set(bundlePath, { text, out: json });
    return json;
  },
  async sawDisk({ bundlePath, doc }) {
    const lc = await open(bundlePath, { projectId: doc.id, doc });
    if (!lc || (await refOf(lc, doc.stateUpdatedAt))) return;
    // A save Carton didn't write (an old cb, an editor): imported now, so it is attributed when it lands.
    await setRev(lc, doc.stateUpdatedAt, (await importForeign(lc, doc)).ref);
  },
  // H2/H3: Carton's versions that reached project.json, newest first, then the older .revs.
  async revisions({ bundlePath, files }) {
    const older = await files();
    const lc = await open(bundlePath);
    if (!lc) return older;
    const revs = [];
    for (const v of await lc.carton.log({})) {
      const r = await revOf(lc, v.ref);
      if (typeof r === "number") revs.push(r);
    }
    const first = revs.length ? Math.min(...revs) : Infinity;
    return [...revs, ...older.filter((r) => r < first)];
  },
  // Laptop #2: what a print of the project shows (cb source print, MCP's print_timeline, the mirror's timeline.tsx),
  // under Carton's exact header: the version project.json's rev names, its records from Carton. Header and records
  // come from one version, so the apply merges against exactly what was printed. (A numeric header went through 1.4.0's
  // revisionAtOrBefore, whose "first at or before" over several writers' revs could be a newer version: the print's
  // older values then read as the agent's edits.) null, and 1.4.0's print of project.json under its numeric rev (which
  // revisionAtOrBefore now takes exactly): no history, or a version this process can't rebuild (on a shared cut, one
  // still pending in the lease holder, which project.json shows: never this process's older confirmed head instead).
  async printed({ bundlePath, project }) {
    const lc = bundlePath && project ? await open(bundlePath, { projectId: project.id }) : null;
    if (!lc) return null;
    const c = lc.carton, ref = await refOf(lc, project.stateUpdatedAt).catch(() => undefined);
    if (!ref || typeof ref !== "object") return null;
    // a version still pending in a shared cut's lease holder (offline): what project.json shows, pinned (pendingPrint)
    if (ref.pending?.length) return pendingPrint(lc, ref, project);
    // a confirmed version, its state hash computed if the ref lacks it, and the header checked as the apply resolves it
    const doc = (await c.resolve({ branchId: ref.branchId, seq: ref.seq }).catch(() => null))?.doc;
    const header = doc ? await headerOf(lc, { ...ref, hash: ref.hash ?? hashDoc(doc, c.schema) }) : null;
    if (!header || !(await c.resolve(header).then(() => true, () => false))) return null;
    return { project: forCardboard({ ...materializeProject(doc, project), stateUpdatedAt: project.stateUpdatedAt }), rev: header };
  },
  // Laptop #2 (review P1): a numeric rev naming a version still pending in the lease holder, which this process can
  // only rebuild as its confirmed prefix: no base here (null), so the apply says "print it again" (the new print is
  // pinned, printed). Never that prefix as the version: an edit back to the confirmed value read as no change.
  // Laptop #2: 1.4.0's revisionAtOrBefore (a numeric header's base, MCP's edit at a rev) with history: the exact
  // version the rev names (the rev map), never the first one at or before it in history order, which over several
  // writers' revs (each process's clock, not save order) can be a newer version. A rev older than every version
  // Carton recorded is a print from before history began: 1.4.0's .revs (`files`, `readFile`), as before. Any other
  // rev names nothing Carton or .revs can rebuild: null (the apply's "print it again", never a guess).
  async revisionAtOrBefore({ bundlePath, rev, slice, files, readFile }) {
    if (rev === undefined || rev === null) return null;
    const lc = await open(bundlePath);
    const older = async () => {
      for (const n of await files()) if (n <= rev) { const r = await readFile(n); if (r) return r.doc; }
      return null;
    };
    if (!lc) return older();
    const exact = await this.revision({ bundlePath, rev, slice, file: () => null }).catch(() => null);
    if (exact) return exact.doc;
    // a version this process can't rebuild (pending in the lease holder, or an outside save not recorded yet) that
    // project.json still shows: the file is exactly what was printed (the commit pins it as its base: commit())
    const onDisk = readProject(bundlePath);
    if (onDisk && onDisk.stateUpdatedAt === rev) return slice ? slice(onDisk) : { tracks: onDisk.tracks ?? [], timelineItems: onDisk.timelineItems ?? [], aspectRatio: onDisk.aspectRatio };
    if (pendingRef(await refOf(lc, Number(rev)).catch(() => undefined))) return null;
    for (const v of await lc.carton.log({})) {
      const r = await revOf(lc, v.ref);
      if (typeof r === "number" && r <= rev) return null;
    }
    return older();
  },
  // `ref` in place of `rev`: a Carton header ref (H3, the apply's base), {ref, doc} if Carton rebuilds it exactly.
  async revision({ bundlePath, rev, ref: header, slice, file }) {
    const lc = await open(bundlePath);
    const ref = lc ? await refOf(lc, header ?? Number(rev)) : undefined;
    // (a pending version's ref, without its state hash, would check out as its confirmed prefix: not this version)
    if (!ref || pendingRef(ref)) return file();
    // (the mirror's revision readers hand it to Cardboard's restore and diff code: a copy, as for head)
    const p = forCardboard(materializeProject(await lc.carton.checkout(ref), readProject(bundlePath)));
    const doc = slice ? slice(p) : { tracks: p.tracks ?? [], timelineItems: p.timelineItems ?? [], aspectRatio: p.aspectRatio };
    return header !== undefined ? { ref, doc } : { rev: Number(rev), at: new Date(Number(rev)).toISOString(), doc };
  },
  async history({ bundlePath, rows }) {
    const lc = await open(bundlePath);
    if (!lc) return rows;
    const byRev = new Map();
    for (const v of await lc.carton.log({})) {
      const r = await revOf(lc, v.ref);
      if (typeof r === "number") byRev.set(r, v);
    }
    return rows.map((row) => (byRev.has(row.rev) ? { ...row, who: byRev.get(row.rev).author?.id ?? "", cut: lc.carton.cut } : row));
  },
  // Cardboard's own merge for the apply's preview; the commit that follows (H1) merges with Carton.
  async merge3({ base, current, file, prefer, rn }) {
    return rn(base, current, file, { prefer });
  },
  async undoTurn({ bundlePath, turn, actor }) {
    const lc = await open(bundlePath);
    if (!lc) throw new Error("History isn't available for this project yet");
    return lc.write({ kind: "undoTurn", turn }, { actor: actorOf(actor) });
  },
  // cb: the Carton commands and MCP tools (@carton/cli-mcp) on Cardboard's own program and tool table. `open` names
  // the project for one call ({id, bundlePath}); `after` writes head into project.json once a write changed it.
  registerCommands(program, { open: target, out, after }) {
    register(program, { open: async (project, { as }) => context(await target(project), as, after), out });
  },
  registerMcp(tool, { z, projectParam, open: target, result, after, skip }) {
    registerMcp(tool, { z, projectParam, result, skip, open: async (project) => context(await target(project), null, after) });
  },
  // H8: host Claude Code's hooks also tell the project's lease holder (the worker's Materializer) what the agent does:
  // a Read of timeline.tsx freezes it, a Write/Edit of it or project.json is credited to the agent, and a stop the
  // late-conflict hook lets through lets go (@carton/local's runHook and sendHookEvent: carton.db read-only for the
  // lease row, then the holder's socket; never a helper). runHook also refuses an agent's Write/Edit of project.json
  // (PLAN §6.4). The Stop hook's notices come from the carton.db that exists (in the bundle or app data, where the
  // facade's handles open it), never one made or moved for a hook.
  async hook({ event, input, env, bundlePath }) {
    return runHook(event === "subagent-stop" ? "stop" : event, input, {
      env,
      openStore: async () => (bundlePath ? openExistingProjectStore({ projectDir: bundlePath }) : null),
      projectDir: bundlePath ?? null,
      ...(bundlePath ? { send: (e) => sendHookEvent({ projectDir: bundlePath, ...e }) } : {}),
    });
  },
  worker({ library, emit }) {
    inWorker = true;
    workerEmit = emit;
    // Cardboard's derive (ensureDerived) runs for one project at a time in this process: main asks for it once a
    // session, at the project's first save, and the re-probe after it fills in an entry (deriveMedia). Two at once on a
    // file whose artefacts aren't cached both make its cache folder again, and Cardboard's cache write then fails with
    // an ENOENT nothing catches, which ends the process (cbproj.test.js caught cb's and the worker's derives doing it).
    // Main's call reads `ensureDerived` from the library at each call, so it waits here too.
    const derive = library.ensureDerived;
    if (typeof derive === "function") {
      const chains = new Map();
      library.ensureDerived = (projectId, ...rest) => {
        const run = (chains.get(projectId) ?? Promise.resolve()).catch(() => {}).then(() => derive.call(library, projectId, ...rest));
        chains.set(projectId, run);
        run.finally(() => chains.get(projectId) === run && chains.delete(projectId)).catch(() => {});
        return run;
      };
    }
    const bundleOf = (projectId) => library.projects.bundlePathFor?.(projectId) ?? null;
    const lcOf = async (projectId) => open(bundleOf(projectId), { projectId });
    const servers = new Map(); // client → serveUi
    const own = cardboard14.workerServices({ library, emit, bundleOf, lcOf, servers });
    const materialize = async (projectId) => { if (await materializeIn(library, projectId)) emit({ kind: "changed", id: projectId, bundlePath: bundleOf(projectId) }); };
    return { ...own, ...extensionServices({ library, emit, bundleOf, open: (b) => open(b), carton: lcOf, onOpen, materialize, actorOf, agentCards }, own) };
  },
  workerServices({ library, emit, bundleOf, lcOf, servers }) {
    // A page's History panel: a fromCarton handle on the project's Carton, served to that page (serveUi).
    const servePanel = async (projectId, client) => {
      const lc = await lcOf(projectId);
      if (!lc) return null;
      const me = meOf(lc);
      // Cards in the editor's words: what each side did differently, a clip by its media's file name, never ids.
      const handle = fromCarton(lc.carton, { me, describeCard: describeCardboardCard });
      const ui = handle.ui ?? handle;
      const bundlePath = bundleOf(projectId);
      if (!panels.has(bundlePath)) panels.set(bundlePath, new Set());
      panels.get(bundlePath).add(handle);
      // Cards kept from earlier GUI saves are shown too, until resolved: each on the cut its change was made on (core's
      // notice says which). fromCarton files a reported card under the cut it is on, so a notice is reported only while
      // the panel is on its cut: at the start, and again after the panel switches cut (review H8 r2 #3: one from cut A
      // showed on B, and "Keep yours" committed it there). A notice from before core said its cut counts as this one's.
      const person = keyOf(actorOf("person"));
      const kept = async () => (await lc.store.range("notices", { prefix: [person] })).filter((x) => x.value?.cards?.length);
      const keptHere = async () => (await kept()).filter((x) => !x.value.cut || x.value.cut === lc.carton.cut);
      // And agents' view-save cards still open on this cut, shown the person's way round (views.shown). fromCarton files
      // a reported card under its own current cut, which follows the handle's only at its refresh (review H8 r3 #5: after
      // another panel's switch its cuts topic already showed the new cut while a report still went under the old one):
      // so it refreshes first, and nothing is reported if the handle's cut moved meanwhile (that switch reports again).
      const reportHere = async () => {
        const cut = lc.carton.cut;
        await handle.refresh?.();
        const keptNow = (await keptHere()).flatMap((x) => x.value.cards), agentsNow = await views.shown(lc);
        if (lc.carton.cut !== cut) return;
        handle.reportConflicts(keptNow);
        for (const x of agentsNow) handle.reportConflicts(x.cards, x.by);
      };
      views.present(ui, handle, lc, () => panels.get(bundlePath) ?? []); // (before the methods are wrapped)
      await reportHere();
      // The cut this panel shows changes (its own switch, another panel's on the same handle, cb's): that cut's kept
      // cards then (review H8 r3 #5: compared with the panel's own cut, from its cuts topic, not the shared handle's).
      let shownCut = lc.carton.cut;
      const cutShown = (m) => (m?.t === "topic" && m.topic === "cuts" ? m.value : m?.t === "init" ? m.topics?.cuts : null)?.find?.((x) => x.current)?.id ?? null;
      // The panel's writes (restore, fold, switching cut…) go into project.json, and the pages adopt them. "Fold in the
      // rest" too: it writes the cut the panel shows (only that cut's partial folds offer it), so without this the editor
      // kept the version before it (laptop #2). materializeIn never puts one over an editor save made while it ran (it
      // is made again from the version that save made). Each is the person's: fromCarton records its writes as `me`,
      // never as this handle's own actor, which for a project that isn't shared is the worker process's identity chain.
      for (const m of ["switchCut", "newCut", "renameCut", "fold", "foldRest", "resolve", "restore", "nameVersion", "undo", "publish"]) {
        const f = ui[m];
        if (typeof f === "function") ui[m] = async (...a) => {
          // The card behind a conflict, as reported (fromCarton forgets it once resolved).
          const card = m === "resolve" ? handle.cardFor?.(a[0]) : undefined;
          // An agent's card: the person's pick mapped back, and its card closed on both sides (view-cards.js).
          const agents = views.isAgent(card);
          const r = agents ? void (await views.resolve(lc, handle, a[0], a[1])) : await f.apply(ui, a);
          if (await materializeIn(library, projectId)) emit({ kind: "changed", id: projectId, bundlePath: bundleOf(projectId) });
          else if (headRefusals.has(bundlePath)) throw new Error(HEAD_REFUSED);
          // The kept cards it stood for go (their notice with them, once empty), and nothing else: if another panel
          // resolved them first, they are already gone.
          if (card && !agents) for (const x of await keptHere()) {
            const cards = x.value.cards.filter((c) => !sameCard(c, card));
            if (cards.length < x.value.cards.length) await lc.store.write([{ table: "notices", key: x.key, value: cards.length ? { ...x.value, cards } : undefined }]);
          }
          return r;
        };
      }
      // R3: "You" is told by this replica's identity once the project is shared (meOf, with the GUI saves' group, so
      // Undo finds them). A GUI save's late-conflict or rejected notice is addressed to the generic person, as core
      // recorded the save; fromCarton takes those itself with a resolved me (ui 879da20), on the notice's own cut.
      const offs = [];
      // The identity set or changed while the panel is open (a share, a join): it starts again with it (the page's
      // remoteUi takes the fresh init in place of what it showed).
      offs.push(lc.carton.on((e) => {
        if (e.type !== "people" || keyOf(meOf(lc)) === keyOf(me) || servers.get(client) !== s) return;
        close();
        void servePanel(projectId, client).then((n) => n?.receive({ t: "hello" })).catch((err) => warnOnce("panel:" + bundlePath, "the History panel didn't start again: " + errText(err)));
      }));
      // A cut switch made elsewhere (cb cut switch, another window) is stored as the machine's current cut. The handle
      // takes it (@carton/local's follower, or here when no follower runs: persist false, so a third switch in between
      // is never overwritten), but a switch on the handle tells its view model nothing: while a page shows the panel,
      // a handle on another cut than the one the panel last showed refreshes it (laptop report 90c4127, bug 7). One
      // small read a second.
      // Versions another process adds to the cut shown (a cb apply, a helper that held the lease) tell this handle's view
      // model nothing either: a newer version on that cut than the panel last saw refreshes it too (laptop report
      // follow-up: a cb edit never showed in the open panel).
      let following = false, seenSeq = null;
      const headSeq = async () => (await lc.carton.log({ cut: lc.carton.cut, limit: 1 }))[0]?.ref.seq ?? 0;
      const follow = setInterval(() => {
        if (following) return;
        following = true;
        followCurrent(lc)
          .then(async () => {
            if (lc.carton.cut !== shownCut) {
              seenSeq = null;
              return reportHere();
            }
            const seq = await headSeq();
            if (seenSeq !== null && seq !== seenSeq) await handle.refresh?.();
            seenSeq = seq;
          })
          .catch(() => {})
          .finally(() => { following = false; });
      }, 1000);
      follow.unref?.();
      offs.push(() => clearInterval(follow));
      const close = () => {
        for (const off of offs) off();
        servers.delete(client);
        panels.get(bundlePath)?.delete(handle);
        s.close();
        handle.dispose?.();
      };
      const s = serveUi(ui, (m) => {
        emit({ kind: "carton", id: projectId, client, message: m });
        const now = cutShown(m);
        if (now && now !== shownCut) {
          shownCut = now;
          // fromCarton drops repeats; its cut follows the handle's, which keptHere and views.shown read
          reportHere().catch((err) => warnOnce("panel:" + bundlePath, "kept conflict cards didn't show after a cut switch: " + errText(err)));
        }
      });
      servers.set(client, s);
      return s;
    };
    // Comments per project, opened on first ask and kept while the worker runs (comment servers per page client).
    const commentServers = new Map();
    const commentsOpen = new Map();
    const commentsOf = (projectId) => {
      let p = commentsOpen.get(projectId);
      if (!p) {
        p = (async () => {
          const lc = await lcOf(projectId);
          if (!lc) return null;
          const comments = await Comments.open({ carton: lc.carton, anchor: { media: "mediaItemId" }, cut: () => lc.carton.cut });
          // Kept with the project and not shared through a host here: nothing is waiting to sync, so no comment says so.
          const source = new Proxy(comments, { get: (t, k) => (k === "isPending" ? (id) => (t.syncStatus() ? t.isPending(id) : false) : typeof t[k] === "function" ? t[k].bind(t) : t[k]) });
          // threads are placed again whenever the cut's head moves
          return { comments, ui: commentsUi(source, { versions: { on: (l) => lc.carton.on((e) => { if (e.type === "change" || e.type === "cut") l(); }) } }) };
        })();
        p.catch(() => commentsOpen.delete(projectId));
        commentsOpen.set(projectId, p);
      }
      return p;
    };
    const scopeOf = (since) => ({ group: localGroup(), app: true, ...(typeof since === "number" ? { since } : {}) });
    const canStep = async (lc, since) => {
      const { group, ...scope } = scopeOf(since);
      const [u, r] = await Promise.all([lc.carton.undoStack(group, { ...scope, limit: 1 }), lc.carton.redoStack(group, { ...scope, limit: 1 })]);
      return { undo: u.length > 0, redo: r.length > 0 };
    };
    const step = async (which, projectId, since) => {
      const lc = await lcOf(projectId);
      if (!lc) return { status: "unavailable" };
      const op = { kind: which, ...scopeOf(since) }, actor = actorOf("person");
      const here = extensions.find((e) => typeof e.serveHere === "function");
      const bundlePath = bundleOf(projectId);
      // the person's own action in the app (local's `gui`): it starts no timeline.tsx freeze, as a `cb` call would
      let r = (bundlePath && (await here?.serveHere(bundlePath, op, actor))) ?? (await lc.write(op, { actor, gui: true }));
      // local's write path answers a clash as `conflicts` (the cards)
      if (r?.status === "conflicts" && r.conflicts?.length && bundlePath) r = { ...r, conflicts: await keepStepCards(lc, bundlePath, actor, which, r.conflicts) };
      // what is left to undo and redo, read while head goes into project.json
      const [project, can] = await Promise.all([materializeIn(library, projectId), canStep(lc, since).catch(() => null)]);
      if (project) emit({ kind: "changed", id: projectId, bundlePath: bundleOf(projectId) });
      return { ...r, ...(project ? { project } : {}), ...(can ? { can } : {}) };
    };
    return {
      ping: async () => "pong",
      head: async ({ projectId }) => library.projects.read(projectId),
      checkout: async ({ projectId, ref }) => {
        const lc = await lcOf(projectId);
        const current = await library.projects.read(projectId);
        if (!lc) return current;
        const r = /^\d{13}$/.test(String(ref)) ? await refOf(lc, Number(ref)) : ref;
        return projectFor(bundleOf(projectId), await lc.carton.checkout(r), current, { keep: false });
      },
      // ⌘Z and ⇧⌘Z for the person's group (H6), then head goes into project.json through the store; the answer carries
      // that project, which the page adopts at once (the pages' change event follows as usual). The page waits for it,
      // so where this worker's View holds the project's lease its holder serves the step here, in this process (request
      // R4: local's write path would reach that same holder through its control socket); anywhere else (another
      // process holds the lease, no View runs) it goes through local's write path as before. `since`: when the editor's
      // session began (the bridge's); the answer says what is left to undo and redo (`can`).
      undo: ({ projectId, since }) => step("undo", projectId, since),
      redo: ({ projectId, since }) => step("redo", projectId, since),
      // What Ctrl+Z and redo can do now, for the editor's buttons and shortcuts.
      undoState: async ({ projectId, since }) => {
        const lc = await lcOf(projectId);
        return lc ? canStep(lc, since) : null;
      },
      // An in-app agent's turn ended: its last version on the current cut takes the turn's label, unless it has a name.
      // The Director's versions name their turn; another provider's (laptop #8: the person's own Claude Code, Codex)
      // are told by who made them (`actors`, a subagent's as its agent's) and when: from `since`, the turn's start, to
      // `until`, its end. Review P2 (lap2): those actors are the same in every turn of a session, and the request can
      // reach this worker after the next turn's edits; bounded by the turn's end, it never takes the next turn's version
      // (a request without `until` has no end, as before).
      nameTurn: async ({ projectId, chat, turn, prompt, actors, since, until }) => {
        const lc = await lcOf(projectId), label = turnLabel(prompt);
        if (!lc || !label) return { status: "unavailable" };
        const want = { turn: safePart(String(turn)), chat: chat ? safePart(String(chat)) : null };
        const by = Array.isArray(actors) ? new Set(actors.map(String)) : null;
        const end = typeof until === "number" && Number.isFinite(until) ? until : Infinity;
        const ours = (v) => {
          if (!by) return v.author?.turn === want.turn && (!want.chat || v.author?.chat === want.chat);
          const who = String((v.authoredAs ?? v.author)?.id ?? "").replace(/\/sub-[^/]*$/, "");
          return by.has(who) && typeof v.at === "number" && v.at >= (Number(since) || 0) && v.at <= end;
        };
        for (const v of await lc.carton.log({ limit: 200 })) {
          if (!ours(v)) continue;
          if (!v.name) {
            await lc.carton.name(v.ref, label);
            // Core tells no one of a name: the History panels open on this project show it through their own
            // nameVersion (a row keyed as fromCarton keys it; core's name is idempotent, so the repeat writes nothing new).
            const row = v.change ?? `${v.ref.branchId}@${v.ref.seq}`;
            for (const h of panels.get(bundleOf(projectId)) ?? []) await h.nameVersion?.(row, label).catch(() => {});
          }
          return { status: "named" };
        }
        return { status: "none" };
      },
      notices: async ({ bundlePath, actor, take }) => {
        const lc = await open(bundlePath);
        if (!lc) return [];
        // The Director's Stop hook takes its notices as its turn ends: what it left of its view saves' cards stays the
        // person's (R3-09).
        if (take) await views.detach(lc, actorOf(actor));
        return lc.carton.notices(actorOf(actor), { take });
      },
      // The Director's Stop and SubagentStop (main): @carton/local's late-conflict hook, as host Claude Code's runs it
      // (cb carton-hook): a stop with cards the agent hasn't been held on yet (its view saves' clashes too) blocks once;
      // the next one lets it stop and hands what it left to the person (a copy under `@human`, R3-09), keeping the
      // agent's own row, so `cb conflicts` and `cb resolve` still have it. `actor` is the id main gives the turn's cb
      // calls ("director/<chat>/<turn>"), `input` the hook's (a subagent's id and type).
      stopHook: async ({ bundlePath, actor, input }) => {
        const lc = await open(bundlePath);
        const a = typeof actor === "string" ? parseActorId(actor) : null;
        if (!lc || !a) return {};
        const turn = a.chat && a.turn ? { chat: a.chat, turn: a.turn } : null;
        const id = actorIdForHook(input ?? {}, turn);
        const d = await new StoreNoticeBox(lc.store).run(id, (box) => stopHook(input ?? {}, box, turn));
        // the turn (or subagent) ends: the person's copies of its cards stand on their own (view-cards.js)
        if (d.decision === "allow") await views.detach(lc, actorOf(id)).catch(() => {});
        return stopOutput(d);
      },
      // The panel's Comments tab: @carton/comments on the project's own Carton (kept beside its history), served to
      // each page that asks (remoteComments there), as the History panel is.
      comments: async ({ projectId, client, message }) => {
        let s = commentServers.get(client);
        if (!s) {
          const c = await commentsOf(projectId);
          if (!c) return { status: "unavailable" };
          s = serveComments(c.ui, (m) => emit({ kind: "carton", id: projectId, client, message: m }));
          commentServers.set(client, s);
        }
        s.receive(message);
        return { status: "ok" };
      },
      // The History panel: @carton/react's view model, served to each page that asks (remoteUi there).
      ui: async ({ projectId, client, message }) => {
        let s = servers.get(client);
        if (!s) {
          s = await servePanel(projectId, client);
          if (!s) return { status: "unavailable" };
        }
        s.receive(message);
        return { status: "ok" };
      },
    };
  },
};

// For the tests (scripts/carton/test): the install lock, the sweep and its journal.
export const internals = {
  testHooks,
  // A notice as written by another process or an earlier build.
  writeNotice: async (bundlePath, actorId, cards) => {
    const lc = await open(bundlePath), to = keyOf(actorOf(actorId));
    await lc.store.write([{ table: "notices", key: [to, Date.now(), 0, "old"], value: { to, kind: "late-conflict", text: "kept", cards, at: Date.now() } }]);
  },
  withInstallLock, sweep, readJournal, writeJournal, install, busy, sameCard, markSeen, sha,
  headProject: async (bundlePath) => { const lc = await open(bundlePath); return lc ? projectFor(bundlePath, (await lc.carton.head()).doc, readProject(bundlePath), { keep: false }) : null; },
  // The helper @carton/local starts as a project's lease holder: the files it runs and its spawn. And what this process
  // opened carton.db with, for comparing a helper's open to it.
  helper: { entry: helperEntry(), factory: defaultFactory(), spawn: spawnHelper },
  local: async (bundlePath) => {
    const lc = await open(bundlePath);
    if (!lc) return null;
    const head = await lc.carton.head();
    return { dbPath: lc.dbPath, schema: sha(canon(lc.carton.schema)), ref: canon(head.ref), doc: sha(canon(head.doc)) };
  }, setRevFor: async (bundlePath, rev, ref) => setRev(await open(bundlePath), rev, ref), refOfRev: async (bundlePath, rev) => refOf(await open(bundlePath), rev),
  // The bundles this process has a Carton open for (a staging folder's must be gone once Open Project returns).
  openBundles: () => [...opened.keys()],
  // A bundle's LocalCarton, as this process opens it (tests that make a project's history as an older build left it).
  open: (bundlePath) => open(bundlePath) };

// The Carton writes that change the timeline a cb call shows (apply-ryw); the others change no timeline (a name, a pin, a
// new cut, a view's print), or are shown before the holder answers (a cut switch).
const SHOWN_WRITES = new Set(["commit", "fold", "restore", "revert", "undo", "redo", "undoTurn"]);
// A cb call's context: the project's Carton, who is acting, and its writes followed by head going into project.json.
async function context(target, as, after) {
  const lc = await open(target.bundlePath, { projectId: target.id });
  if (!lc) throw new Error(`History isn't available for ${path.basename(target.bundlePath)} yet`);
  // A 1.4.0 rev (`cb undo <rev>`, the number `cb history` printed before Carton, a timeline header) is a ref the rev
  // map knows; core has no state for a bare timestamp.
  const ref = async (x) => {
    if (typeof x !== "string" && typeof x !== "number") return x;
    if (!/^\d{13}$/.test(String(x))) return x;
    const r = await refOf(lc, Number(x));
    return r ? `${r.branchId}@${r.seq}` : x;
  };
  const REFS = new Set(["checkout", "resolve", "diff", "shots", "restore", "name", "preview", "fold", "foldSome"]);
  const carton = new Proxy(lc.carton, {
    get(t, k) {
      const v = Reflect.get(t, k, t);
      if (typeof v !== "function") return v;
      if (k === "fork") return async (name, o) => v.call(t, name, o?.from !== undefined ? { ...o, from: await ref(o.from) } : o);
      if (!REFS.has(k)) return v.bind(t);
      return async (...a) => v.apply(t, await Promise.all(a.map((x, i) => (i < 2 ? ref(x) : x))));
    },
  });
  const project = {
    carton,
    // the bundle: `source print --view` answers the view's file and status file as absolute paths
    projectDir: target.bundlePath,
    async write(op, o) {
      for (const k of ["ref", "from"]) if (op && op[k] !== undefined) op = { ...op, [k]: await ref(op[k]) };
      // A write left pending (a shared cut: offline, or the server slow) changed the holder's head, which this handle
      // can't read (confirmed rows only): the holder hands it back (WriteOp `head`) for project.json, never printed.
      const { head, ...r } = await lc.write(op && typeof op === "object" ? { ...op, head: true } : op, o);
      if (r.status === "confirmed" || r.status === "pending" || r.status === "conflicts") await after(target, head);
      // apply-ryw: a write that changed the timeline answers once the app's timeline.tsx shows it (with the app closed,
      // `after` printed it already); a cut switch is shown before the holder answers it
      const shows = SHOWN_WRITES.has(op?.kind) ? await showWrite(lc, showTarget({ ...r, head }, o?.actor ?? lc.actor)) : null;
      return shows ? { ...r, ...shows } : r;
    },
  };
  return { project, actor: as ? identify({ declared: as }) : identify() };
}

// How head goes into project.json through Cardboard 1.4.0's own store (`projects.updateScoped`), without committing it
// again (`carton.materialize`). R4: its scoped merge takes root fields from `ownedFields` but never `media`: a media
// record comes in only through `ownedMediaIds` (added or replaced whole) and goes only through `removedMediaIds`. So a
// teammate's new clip, a removed clip, or a record Carton changed needs those, computed against the document head was
// materialized from (`current`). The store applies the scope to the newest document in its chain, so a clip added
// after `current` was read is never removed.
export const HEAD_FIELDS = ["tracks", "timelineItems", "aspectRatio", "name", "description"];
export function headScope(current, next) {
  const had = new Map((current?.media ?? []).map((m) => [m.id, JSON.stringify(m)]));
  const keep = new Set((next?.media ?? []).map((m) => m.id));
  return {
    ownedFields: HEAD_FIELDS,
    ownedMediaIds: (next?.media ?? []).filter((m) => had.get(m.id) !== JSON.stringify(m)).map((m) => m.id),
    removedMediaIds: [...had.keys()].filter((id) => !keep.has(id)),
    carton: { materialize: true },
  };
}

// Head into project.json through the worker's store (the store bridge writes without committing a second change).
// Head into project.json through Cardboard's store: the project it wrote, or null when the file already showed head.
// The project as the store has it: `latest` hands back the store's own document when project.json is as the worker
// last saw it (no second parse of a large project), and reads the file when anything else wrote it.
// Head is read here, outside the store's chain of mutations. A GUI save that goes into the chain first moves head, and
// the document made from the head before it would put the older timeline over that save, unseen: the scoped merge keeps
// the newer timestamp, so the install doesn't take it for stale (review P1 of the fold-author fix: "Fold in the rest",
// held after it read head while the editor saved). So the version it was made from goes with it (`carton.head`), commit
// checks it in the chain, and a document whose head moved is not written ("stale"): it is made again from the new head.
// Usually once: a save that moved head wrote head itself, and then there is nothing left to write.
const MATERIALIZE_TRIES = 5;
const staleMaterializations = new Set();
let materializations = 0;
async function materializeIn(library, projectId) {
  const projects = library.projects;
  const bundlePath = projects.bundlePathFor(projectId);
  for (let tries = 1; ; tries++) {
    const current = typeof projects.latest === "function" ? await projects.latest(projectId) : await projects.read(projectId);
    const made = await headAt(bundlePath, current);
    if (!made) return null;
    let next = made.project;
    // R6: extensions fill in what only they know first (a teammate's new clip: where it plays from, its size, duration).
    for (const e of extensions) {
      if (typeof e.materializeDoc !== "function") continue;
      try { next = (await e.materializeDoc(next, { bundlePath, projectId, current })) ?? next; } catch (err) { warnOnce("materializeDoc:" + (e.name ?? "?"), "an extension's materializeDoc failed: " + errText(err)); }
    }
    // P2-1, P2-2: an entry with nothing but what history holds (no details kept anywhere): Cardboard's own probe of its
    // file, as its import, and its file registered so the app serves it at once; its thumbnails come after (below)
    const reprobed = await reprobeMedia(library, bundlePath, next);
    if (reprobed) next = reprobed.project;
    if (testHooks.materialize) await testHooks.materialize(projectId);
    const scope = headScope(current, next), token = ++materializations;
    await projects.updateScoped(next, { ...scope, carton: { ...scope.carton, head: made.ref, token } });
    if (!staleMaterializations.delete(token)) {
      // the derive writes project.json itself, after this write (the worker's own writes aren't announced: the pages are
      // told here, as main tells them after its own ensureDerived)
      if (reprobed) void deriveMedia(library, projectId).then((changed) => changed && workerEmit?.({ kind: "changed", id: projectId, bundlePath }));
      return next;
    }
    if (tries >= MATERIALIZE_TRIES) {
      warnOnce("materialize:" + bundlePath, "project.json didn't catch up with history: it kept changing while it was written (the next change brings it up to date)");
      return null;
    }
  }
}
