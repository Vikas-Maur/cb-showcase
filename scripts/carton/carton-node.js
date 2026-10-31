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
import { displaceThenInstall, hardLinksWork, statStamp, DisplacedFiles } from "@carton/cardboard/node";
import { fromHost, materializeProject, projectGuiSave } from "@carton/cardboard";
import { openLocal, identify, localGroup, parseActorId, runHook } from "@carton/local";
import { register, registerMcp } from "@carton/cli-mcp";
import { fromCarton, serveUi } from "@carton/react";

const warned = new Set();
const warnOnce = (key, msg) => {
  if (warned.has(key)) return;
  warned.add(key);
  console.warn("[carton] " + msg);
};
const errText = (e) => (e && e.message) || String(e);

// Cardboard's own GUI save projection, cut out of the editor bundle at build time (scripts/carton/fmsv.js).
let gui = null;
const P = () => (gui ??= (() => {
  try { return require(path.join(__dirname, "fmsv.cjs")); }
  catch (e) { warnOnce("fmsv", "the editor's save projection is missing; GUI saves are diffed as they are: " + errText(e)); return (i) => i; }
})());

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
      const first = exists ? null : doc ?? readProject(bundlePath);
      const lc = await openLocal({ projectDir: bundlePath, projectId: id, init: first ? { doc: fromHost(first, null) } : undefined });
      if (first) await setRev(lc, first.stateUpdatedAt, (await lc.carton.head()).ref);
      return lc;
    })().catch((e) => (warnOnce("open:" + bundlePath, `history is off for ${path.basename(bundlePath)}: ${errText(e)}`), opened.delete(bundlePath), null));
    opened.set(bundlePath, p);
  }
  return p;
}
const readProject = (bundlePath) => { try { return JSON.parse(fs.readFileSync(path.join(bundlePath, "project.json"), "utf8")).project ?? null; } catch { return null; } };

// The rev map (carton.db's local `views` table): ["rev", ms] → ref; ["ref", branch, seq] → ms.
const REVS = "views";
const refKey = (ref) => ["ref", ref.branchId, ref.seq];
async function setRev(lc, rev, ref) {
  if (typeof rev !== "number" || !ref) return;
  await lc.store.write([{ table: REVS, key: ["rev", rev], value: ref }, { table: REVS, key: refKey(ref), value: rev }]);
}
const refOf = (lc, rev) => (typeof rev === "number" ? lc.store.get(REVS, ["rev", rev]) : Promise.resolve(undefined));
const revOf = (lc, ref) => lc.store.get(REVS, refKey(ref));

// Who an actor id is (CARDBOARD_ACTOR's form). The person at the app shares the machine's undo group with windowless
// agents (§8).
const actorOf = (id) => (id === "person" ? { id: "person", kind: "human", group: localGroup() } : parseActorId(id) ?? identify({ declared: id }));

// ---------------------------------------------------------------- H1: one change per mutation
async function commit({ bundlePath, base, doc, actor, meta }) {
  if (meta?.materialize) return { doc, status: "materialized" };
  const lc = await open(bundlePath, { projectId: doc.id, doc: base ?? doc });
  if (!lc) return { doc, status: "off" };
  const c = lc.carton;
  // The version the edit was made on: the GUI's (its editor's), the apply's header, else what the writer read.
  const rev = meta?.base ?? meta?.rev ?? base?.stateUpdatedAt;
  let baseRef = await refOf(lc, rev);
  if (!baseRef && base && rev === base.stateUpdatedAt) {
    // What the writer read isn't a state Carton wrote: a foreign save. Import it first, attributed as one.
    await c.commit({ doc: fromHost(base, (await c.head()).doc), author: actorOf("external:project.json") });
    baseRef = (await c.head()).ref;
    await setRev(lc, base.stateUpdatedAt, baseRef);
  }
  const baseDoc = baseRef ? await c.checkout(baseRef) : (await c.head()).doc;
  const mine = meta?.base !== undefined && baseRef ? projectGuiSave(baseDoc, doc, P()) : fromHost(doc, baseDoc);
  const intent = meta?.intents?.length ? { gui: meta.intents } : undefined;
  const r = await c.commit({ doc: mine, ...(baseRef ? { base: baseRef } : {}), author: actorOf(actor), ...(intent ? { intent } : {}) });
  if (r.status === "rejected") throw new Error("Carton rejected the change: " + r.reason);
  if (r.status === "confirmed" && r.empty) return { ...r, doc };
  const head = await c.head();
  // Nothing else was merged in: the writer's document is head.
  if (r.status === "confirmed" && !r.rebased) {
    await setRev(lc, doc.stateUpdatedAt, r.ref);
    return { ...r, doc };
  }
  // Merged (or carded): the file gets head, with a newer rev the next reader can name.
  const out = { ...materializeProject(head.doc, doc), stateUpdatedAt: Math.max(Date.now(), (doc.stateUpdatedAt ?? 0) + 1) };
  await setRev(lc, out.stateUpdatedAt, head.ref);
  return { ...r, doc: out };
}

// The project to write for head, with a fresh rev recorded against it: after a Carton command changed head. null when
// project.json already shows head.
async function headProject(bundlePath, current) {
  const lc = await open(bundlePath, { projectId: current?.id });
  if (!lc) return null;
  const head = await lc.carton.head();
  const known = await revOf(lc, head.ref);
  if (known !== undefined && known === current?.stateUpdatedAt) return null;
  const out = { ...materializeProject(head.doc, current), stateUpdatedAt: Math.max(Date.now(), (current?.stateUpdatedAt ?? 0) + 1) };
  await setRev(lc, out.stateUpdatedAt, head.ref);
  return out;
}

// ---------------------------------------------------------------- files: displace, then install
const installs = new Map(); // target path → { files: DisplacedFiles, own, noLinks, timer }
const SEEN_KEEP = 32;
const seenFile = (file) => path.join(path.dirname(file), ".carton", "seen.json");
const sha = (b) => createHash("sha256").update(b).digest("hex");
const readSeen = (file) => { try { return JSON.parse(fs.readFileSync(seenFile(file), "utf8")); } catch { return {}; } };
// What Carton wrote at each path, shared by every process on the machine: a displaced file with one of these hashes is
// Carton's own and goes; anything else is held as a foreign save. Losing an entry to a race only keeps a file.
const markSeen = (file, hash) => {
  const all = readSeen(file), name = path.basename(file);
  all[name] = [hash, ...(all[name] ?? []).filter((h) => h !== hash)].slice(0, SEEN_KEEP);
  fs.mkdirSync(path.dirname(seenFile(file)), { recursive: true });
  const tmp = seenFile(file) + "." + process.pid + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(all));
  fs.renameSync(tmp, seenFile(file));
};

async function install(tmp, file, seenStamp) {
  // Without history for this project there is nothing to import a foreign save into: write as 1.4.0 does.
  if (!(await open(path.dirname(file)))) return fs.promises.rename(tmp, file);
  let s = installs.get(file);
  if (!s) {
    const bundle = path.dirname(file);
    s = { files: new DisplacedFiles(path.join(bundle, ".carton", "displaced")), own: null, noLinks: !hardLinksWork(bundle), timer: null };
    installs.set(file, s);
  }
  const bytes = fs.readFileSync(tmp);
  const r = displaceThenInstall(file, tmp, s.files.next, { noLinks: s.noLinks, lastStamp: s.own?.stamp ?? null });
  markSeen(file, sha(bytes));
  // The file the writer read (its stamp unchanged since), or one Carton wrote, isn't a foreign save.
  const seen = new Set(readSeen(file)[path.basename(file)] ?? []);
  const rest = r.displaced.filter((p, i) => {
    const mine = (i === 0 && seenStamp && statStamp(p) === seenStamp) || seen.has(sha(fs.readFileSync(p)));
    if (mine) fs.rmSync(p, { force: true });
    return !mine;
  });
  s.files.hold(rest, s.own);
  s.own = { bytes, stamp: statStamp(file) };
  s.files.endRound();
  if (!s.files.size) return;
  clearTimeout(s.timer);
  s.timer = setTimeout(() => review(file, s).catch((e) => warnOnce("review:" + file, "review of displaced files failed: " + errText(e))), 300);
  s.timer.unref?.();
}

async function review(file, s) {
  const isProject = path.basename(file) === "project.json";
  const parse = (b) => { try { return JSON.parse(b.toString("utf8")); } catch { return null; } };
  const out = s.files.review((b) => (isProject ? parse(b) !== null : b.length > 0));
  for (const f of out.foreign) {
    const project = isProject ? parse(f.bytes)?.project : null;
    const lc = project ? await open(path.dirname(file)) : null;
    // A foreign save stays where it is until it is imported: never lost.
    if (!lc) continue;
    await lc.carton.commit({ doc: fromHost(project, (await lc.carton.head()).doc), author: actorOf("external:project.json") });
    fs.rmSync(f.path, { force: true });
  }
}

// ---------------------------------------------------------------- what the bridges call
export const cardboard14 = {
  attach() {},
  commit,
  install,
  headProject,
  hasHistory: async (bundlePath) => !!(await open(bundlePath)),
  async sawDisk({ bundlePath, doc }) {
    const lc = await open(bundlePath, { projectId: doc.id, doc });
    if (!lc || (await refOf(lc, doc.stateUpdatedAt))) return;
    // A save Carton didn't write (an old cb, an editor): imported now, so it is attributed when it lands.
    await lc.carton.commit({ doc: fromHost(doc, (await lc.carton.head()).doc), author: actorOf("external:project.json") });
    await setRev(lc, doc.stateUpdatedAt, (await lc.carton.head()).ref);
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
  async revision({ bundlePath, rev, slice, file }) {
    const lc = await open(bundlePath);
    const ref = lc ? await refOf(lc, Number(rev)) : undefined;
    if (!ref) return file();
    const p = materializeProject(await lc.carton.checkout(ref), readProject(bundlePath));
    return { rev: Number(rev), at: new Date(Number(rev)).toISOString(), doc: slice ? slice(p) : { tracks: p.tracks ?? [], timelineItems: p.timelineItems ?? [], aspectRatio: p.aspectRatio } };
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
  async hook({ event, input, env, bundlePath }) {
    return runHook(event === "subagent-stop" ? "stop" : event, input, { env, openStore: async () => (bundlePath ? (await open(bundlePath))?.store ?? null : null) });
  },
  worker({ library, emit }) {
    const bundleOf = (projectId) => library.projects.bundlePathFor?.(projectId) ?? null;
    const lcOf = async (projectId) => open(bundleOf(projectId), { projectId });
    const servers = new Map(); // client → serveUi
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
      // ⌘Z for the person's group, then head goes into project.json through the store (the pages adopt it).
      undo: async ({ projectId }) => {
        const lc = await lcOf(projectId);
        if (!lc) return { status: "unavailable" };
        const r = await lc.write({ kind: "undo", group: localGroup() }, { actor: actorOf("person") });
        await materializeIn(library, projectId);
        return r;
      },
      redo: async () => ({ status: "unavailable" }),
      notices: async ({ bundlePath, actor, take }) => ((await open(bundlePath))?.carton.notices(actorOf(actor), { take }) ?? []),
      // The History panel: @carton/react's view model, served to each page that asks (remoteUi there).
      ui: async ({ projectId, client, message }) => {
        let s = servers.get(client);
        if (!s) {
          const lc = await lcOf(projectId);
          if (!lc) return { status: "unavailable" };
          const handle = fromCarton(lc.carton, { me: actorOf("person") });
          s = serveUi(handle.ui ?? handle, (m) => emit({ kind: "carton", id: projectId, client, message: m }));
          servers.set(client, s);
        }
        s.receive(message);
        return { status: "ok" };
      },
    };
  },
};

// A cb call's context: the project's Carton, who is acting, and its writes followed by head going into project.json.
async function context(target, as, after) {
  const lc = await open(target.bundlePath, { projectId: target.id });
  if (!lc) throw new Error(`History isn't available for ${path.basename(target.bundlePath)} yet`);
  const project = {
    carton: lc.carton,
    async write(op, o) {
      const r = await lc.write(op, o);
      if (r.status === "confirmed" || r.status === "pending" || r.status === "conflicts") await after(target);
      return r;
    },
  };
  return { project, actor: as ? identify({ declared: as }) : identify() };
}

// Head into project.json through the worker's store (the store bridge writes without committing a second change).
async function materializeIn(library, projectId) {
  const current = await library.projects.read(projectId);
  const next = await headProject(library.projects.bundlePathFor(projectId), current);
  if (next) await library.projects.updateScoped(next, { ownedFields: ["tracks", "timelineItems", "aspectRatio", "name"], carton: { materialize: true } });
}
