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
import { displaceThenInstall, hardLinksWork, statStamp, DisplacedFiles, retryBusy, cartonViewFile } from "@carton/cardboard/node";
import { describeCardboardCard, fromHost, materializeProject, projectGuiSave, branchToken } from "@carton/cardboard";
import * as cardboardHost from "@carton/cardboard";
import { openLocal, identify, localGroup, parseActorId, runHook, sendHookEvent, openExistingProjectStore, StoreNoticeBox, stopHook, stopOutput, actorIdForHook, safePart, defaultFactory, helperEntry, spawnHelper } from "@carton/local";
import { register, registerMcp } from "@carton/cli-mcp";
import { fromCarton, serveUi } from "@carton/react";
import { viewCards, canon, sameCard } from "./sync/view-cards.js";

const warned = new Set();
const warnOnce = (key, msg) => {
  if (warned.has(key)) return;
  warned.add(key);
  console.warn("[carton] " + msg);
};
const errText = (e) => (e && e.message) || String(e);

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
function open(bundlePath, { projectId, doc } = {}) {
  if (!bundlePath) return Promise.resolve(null);
  let p = opened.get(bundlePath);
  if (!p) {
    p = (async () => {
      const id = projectId ?? doc?.id ?? readProject(bundlePath)?.id;
      const exists = fs.existsSync(path.join(bundlePath, ".carton", "carton.db"));
      // A project without history yet starts from its document on disk (§16, main@1).
      let first = exists ? null : doc ?? readProject(bundlePath);
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
        if (!first) throw e;
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
  if (inWorker) return false;
  try {
    const row = await lc.lease.read();
    if (row?.kind !== "worker" || !(row.expires > Date.now())) return false;
    const r = await lc.store.get("views", LEASE_PRINTS);
    return !(r && r.prints === false && r.nonce === row.nonce);
  } catch { return false; }
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
  try { await lc.carton.resolve(ref); } catch (e) { if (e?.code === "STATE_UNKNOWN") return undefined; throw e; }
  return ref;
};
const revOf = (lc, ref) => lc.store.get(REVS, refKey(ref));
// The header a print carries for a version (core's ref token: "<cut name>@<seq>~<hash8> b:<cut8>"), which the apply
// resolves back to exactly that version; null if its cut is unknown here.
async function headerOf(lc, ref) {
  if (!ref || typeof ref !== "object" || typeof ref.seq !== "number" || !(ref.hash8 ?? ref.hash)) return null;
  const cut = (await lc.carton.cuts()).find((x) => x.id === ref.branchId);
  return cut ? `${cut.name}@${ref.seq}~${(ref.hash8 ?? ref.hash).slice(0, 8)} b:${branchToken(ref.branchId)}` : null;
}

// Who an actor id is (CARDBOARD_ACTOR's form). The person at the app shares the machine's undo group with windowless
// agents (§8). "cli" is the store bridge's word for a `cb` that nothing named (no CARDBOARD_ACTOR): who it is comes
// from @carton/local's identity chain, as for Carton's own cb (Claude Code, Codex, Gemini from their environment, a
// declared agent, else the person at this terminal), never an agent called "cli" (ui-words #4).
const actorOf = (id) => (id === "person" ? { id: "person", kind: "human", group: localGroup() } : id === "cli" ? identify() : parseActorId(id) ?? identify({ declared: id }));
// "You" in the History panel (R3): in a shared project, this replica's identity (live sync sets it from the host
// session at share and join), as core tells the person's GUI saves there; before a share, the generic person they are
// recorded as. GUI saves stay recorded as "person" either way.
const meOf = (lc) => {
  const who = lc.carton.identity?.();
  return who ? { kind: "human", id: who.id, name: who.name, group: localGroup() } : actorOf("person");
};

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
  if (meta?.materialize) return { doc, status: "materialized" };
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
    const out = { ...materializeProject(head.doc, doc), stateUpdatedAt: doc.stateUpdatedAt };
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
  const out = { ...materializeProject(head.doc, doc), stateUpdatedAt: Math.max(Date.now(), (doc.stateUpdatedAt ?? 0) + 1) };
  await setRev(lc, out.stateUpdatedAt, head.ref);
  // The person's document isn't head: held, so the editor's next save made before this one's answer builds on it.
  // Only on a cut this handle commits to itself (the change is known); a shared cut's next save uses its base.
  if (gui && typeof doc.stateUpdatedAt === "number" && r.change?.id && (await c.cuts()).find((x) => x.id === c.cut)?.sequencer.kind === "local") {
    const on = baseRef && typeof baseRef === "object" && "baseDoc" in baseRef ? { seq: baseRef.baseSeq, causal: baseRef.causal ?? [] } : await lc.carton.resolve(baseRef).catch(() => null);
    if (on) holdSave(bundlePath, doc.stateUpdatedAt, { baseDoc: mine, baseSeq: on.seq, causal: [...on.causal, r.change.id] });
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

// What Cardboard's own code gets from a Carton state: a copy. Core's records are frozen, and Cardboard edits the
// documents its store holds in place, which on a frozen record is silently ignored in sloppy code (the edit is lost,
// with no error). The store bridge copies a merged save's put-back itself.
const forCardboard = (project) => structuredClone(project);

// The project to write for head, with a fresh rev recorded against it: after a Carton command changed head. null when
// project.json already shows head. (Through Cardboard's store: materializeIn, cb's `after`, sync's bring-in and pull.)
// `given`: the state a write just made when this handle can't read it (a write still pending on a shared cut, which the
// holder answered with its head: WriteOp `head`); the file never shows it yet.
async function headProject(bundlePath, current, given) {
  const lc = await open(bundlePath, { projectId: current?.id });
  if (!lc) return null;
  const head = given?.doc ? given : await lc.carton.head();
  const known = given?.doc ? undefined : await revOf(lc, head.ref);
  if (known !== undefined && known === current?.stateUpdatedAt) return null;
  const out = forCardboard({ ...materializeProject(head.doc, current), stateUpdatedAt: Math.max(Date.now(), (current?.stateUpdatedAt ?? 0) + 1) });
  await setRev(lc, out.stateUpdatedAt, head.ref);
  return out;
}

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
// Test seams (scripts/carton/test): `between` runs between the displace and the link, as displaceThenInstall's does.
const testHooks = { between: null, installed: null, lockWaitMs: null };
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
  try { return (out = await installFile(tmp, file, seenStamp, rev)); } finally {
    if (due.length) {
      const stamp = out === true && envelope ? installs.get(file)?.own?.stamp : null;
      for (const l of due) l.settle(stamp ? { project: { envelope, stamp } } : undefined);
    }
  }
}
async function installFile(tmp, file, seenStamp, rev) {
  const bundle = path.dirname(file);
  // Without history for this project there is nothing to import a foreign save into: write as 1.4.0 does.
  const lc = await open(bundle);
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
  // H11: which files in .scratch/views/ are Carton's (the store bridge's Save As walk and Open Project scrub)
  cartonViewFile,
  headProject,
  hasHistory: async (bundlePath) => !!(await open(bundlePath)),
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
  // under Carton's exact header: the version project.json's rev names, its records from Carton, or head when the rev
  // names none Carton can rebuild. Header and records come from one version, so the apply merges against exactly what
  // was printed. (A numeric header went through 1.4.0's revisionAtOrBefore, whose "first at or before" over several
  // writers' revs could be a newer version: the print's older values then read as the agent's edits.) null: no history.
  async printed({ bundlePath, project }) {
    const lc = bundlePath && project ? await open(bundlePath, { projectId: project.id }) : null;
    if (!lc) return null;
    const c = lc.carton;
    let header = await headerOf(lc, await refOf(lc, project.stateUpdatedAt).catch(() => undefined));
    let doc = header ? (await c.resolve(header).catch(() => null))?.doc : null;
    if (!doc) {
      const h = await c.head();
      [header, doc] = [await headerOf(lc, h.ref), h.doc];
    }
    if (!header) return null;
    return { project: forCardboard({ ...materializeProject(doc, project), stateUpdatedAt: project.stateUpdatedAt }), rev: header };
  },
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
    const exact = await this.revision({ bundlePath, rev, slice, file: () => null });
    if (exact) return exact.doc;
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
    if (!ref) return file();
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
      // The panel's writes (restore, fold, switching cut…) go into project.json, and the pages adopt them.
      for (const m of ["switchCut", "newCut", "renameCut", "fold", "resolve", "restore", "nameVersion", "undo", "publish"]) {
        const f = ui[m];
        if (typeof f === "function") ui[m] = async (...a) => {
          // The card behind a conflict, as reported (fromCarton forgets it once resolved).
          const card = m === "resolve" ? handle.cardFor?.(a[0]) : undefined;
          // An agent's card: the person's pick mapped back, and its card closed on both sides (view-cards.js).
          const agents = views.isAgent(card);
          const r = agents ? void (await views.resolve(lc, handle, a[0], a[1])) : await f.apply(ui, a);
          if (await materializeIn(library, projectId)) emit({ kind: "changed", id: projectId, bundlePath: bundleOf(projectId) });
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
    return {
      ping: async () => "pong",
      head: async ({ projectId }) => library.projects.read(projectId),
      checkout: async ({ projectId, ref }) => {
        const lc = await lcOf(projectId);
        const current = await library.projects.read(projectId);
        if (!lc) return current;
        const r = /^\d{13}$/.test(String(ref)) ? await refOf(lc, Number(ref)) : ref;
        return materializeProject(await lc.carton.checkout(r), current);
      },
      // ⌘Z for the person's group, then head goes into project.json through the store (the pages adopt it). The page
      // waits for it, so where this worker's View holds the project's lease its holder serves the undo here, in this
      // process (request R4: local's write path would reach that same holder through its control socket); anywhere
      // else (another process holds the lease, no View runs) it goes through local's write path as before.
      undo: async ({ projectId }) => {
        const lc = await lcOf(projectId);
        if (!lc) return { status: "unavailable" };
        const op = { kind: "undo", group: localGroup() }, actor = actorOf("person");
        const here = extensions.find((e) => typeof e.serveHere === "function");
        const bundlePath = bundleOf(projectId);
        // the person's own action in the app (local's `gui`): it starts no timeline.tsx freeze, as a `cb` call would
        const r = (bundlePath && (await here?.serveHere(bundlePath, op, actor))) ?? (await lc.write(op, { actor, gui: true }));
        if (await materializeIn(library, projectId)) emit({ kind: "changed", id: projectId, bundlePath: bundleOf(projectId) });
        return r;
      },
      redo: async () => ({ status: "unavailable" }),
      // A Director turn ended: its last version on the current cut takes the turn's label, unless it has a name.
      nameTurn: async ({ projectId, chat, turn, prompt }) => {
        const lc = await lcOf(projectId), label = turnLabel(prompt);
        if (!lc || !label) return { status: "unavailable" };
        const want = { turn: safePart(String(turn)), chat: chat ? safePart(String(chat)) : null };
        for (const v of await lc.carton.log({ limit: 200 })) {
          if (v.author?.turn !== want.turn || (want.chat && v.author?.chat !== want.chat)) continue;
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
  headProject: async (bundlePath) => { const lc = await open(bundlePath); return lc ? materializeProject((await lc.carton.head()).doc, readProject(bundlePath)) : null; },
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
  openBundles: () => [...opened.keys()] };

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
      return r;
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
async function materializeIn(library, projectId) {
  const current = await library.projects.read(projectId);
  const bundlePath = library.projects.bundlePathFor(projectId);
  let next = await headProject(bundlePath, current);
  if (!next) return false;
  // R6: extensions fill in what only they know first (a teammate's new clip: where it plays from, its size, duration).
  for (const e of extensions) {
    if (typeof e.materializeDoc !== "function") continue;
    try { next = (await e.materializeDoc(next, { bundlePath, projectId, current })) ?? next; } catch (err) { warnOnce("materializeDoc:" + (e.name ?? "?"), "an extension's materializeDoc failed: " + errText(err)); }
  }
  await library.projects.updateScoped(next, headScope(current, next));
  return true;
}
