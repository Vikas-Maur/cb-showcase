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
import * as cardboardHost from "@carton/cardboard";
import { openLocal, identify, localGroup, parseActorId, runHook, safePart } from "@carton/local";
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

// Cards a commit raised, as a notice for its author in carton.db's notices table, where `cb conflicts`, the Stop hook
// and the History panel read them (core keeps notices only for confirmed and pending commits).
const keyOf = (a) => [a.kind, a.id, a.agentId].filter(Boolean).join("/");
async function keepCards(lc, author, cards) {
  const to = keyOf(author), at = Date.now();
  const text = `${cards.length} of your edits clashed with a change made meanwhile; the other change was kept. Choose with cb conflicts / cb resolve, or in History.`;
  await lc.store.write([{ table: "notices", key: [to, at, 0, Math.random().toString(16).slice(2, 10)], value: { to, kind: "late-conflict", text, cards, at } }]);
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
  const gui = meta?.base !== undefined && baseRef;
  if (r.status === "confirmed" && r.empty && !gui) return { ...r, doc, merged: false };
  const head = await c.head();
  if (r.status === "confirmed" && !r.rebased) {
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
  if (r.status === "conflicts" && r.cards?.length) await keepCards(lc, actorOf(meta?.actor ?? actor), r.cards);
  // Merged (or carded): the file gets head, with a newer rev the next reader can name.
  const out = { ...materializeProject(head.doc, doc), stateUpdatedAt: Math.max(Date.now(), (doc.stateUpdatedAt ?? 0) + 1) };
  await setRev(lc, out.stateUpdatedAt, head.ref);
  return { ...r, doc: out, merged: true };
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
const SEEN_KEEP = 256;
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

// One install at a time per bundle, across processes (mkdir is atomic on NTFS too): the check that a file is still
// head and its install happen together, so two writers can't leave an older state on disk after a newer one.
async function withInstallLock(bundle, fn) {
  const dir = path.join(bundle, ".carton", "install.lock"), t0 = Date.now();
  for (;;) {
    try { fs.mkdirSync(dir); break; } catch (e) {
      if (e.code !== "EEXIST") throw e;
      // A holder that died leaves the folder: after 10 s it is taken over.
      try { if (Date.now() - fs.statSync(dir).mtimeMs > 10_000) fs.rmSync(dir, { recursive: true, force: true }); } catch {}
      if (Date.now() - t0 > 20_000) throw new Error("the install lock stayed held");
      await new Promise((r) => setTimeout(r, 5));
    }
  }
  try { return await fn(); } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}
// The rev a file being installed was written from: project.json's stateUpdatedAt, timeline.tsx's header.
const revIn = (file, bytes) => {
  const text = bytes.toString("utf8");
  if (path.basename(file) === "project.json") { try { return JSON.parse(text).project?.stateUpdatedAt; } catch { return undefined; } }
  const m = /^\s*\/\/\s*cardboard:rev\s+(\d+)\s*$/m.exec(text);
  return m ? Number(m[1]) : undefined;
};

async function install(tmp, file, seenStamp) {
  const bundle = path.dirname(file);
  // Without history for this project there is nothing to import a foreign save into: write as 1.4.0 does.
  const lc = await open(bundle);
  if (!lc) return fs.promises.rename(tmp, file);
  return withInstallLock(bundle, async () => {
    const bytes = fs.readFileSync(tmp);
    // A writer whose state is no longer head (another process committed and installed after it) doesn't install: the
    // newer state is, or is about to be, on disk.
    const ref = await refOf(lc, revIn(file, bytes));
    if (ref) {
      const head = (await lc.carton.head()).ref;
      if (ref.branchId !== head.branchId || ref.seq < head.seq) return void fs.rmSync(tmp, { force: true });
    }
    let s = installs.get(file);
    if (!s) {
      s = { files: new DisplacedFiles(path.join(bundle, ".carton", "displaced")), own: null, noLinks: !hardLinksWork(bundle), timer: null, mine: new Set() };
      installs.set(file, s);
    }
    sweep(file, s);
    const r = displaceThenInstall(file, tmp, s.files.next, { noLinks: s.noLinks, lastStamp: s.own?.stamp ?? null });
    markSeen(file, sha(bytes));
    // What was at the path is held, never deleted at once: the file the writer read (its stamp unchanged) or one
    // Carton wrote goes only if its bytes and stamp are still the same after the hold. An in-place writer that opened
    // it just before and writes after is caught then (P10 settle-2); anything else is a foreign save.
    const seen = new Set(readSeen(file)[path.basename(file)] ?? []);
    let foreign = false;
    r.displaced.forEach((p, i) => {
      s.mine.add(p);
      const b = fs.readFileSync(p), st = statStamp(p);
      const h = sha(b), mine = (i === 0 && seenStamp && st === seenStamp) || seen.has(h);
      if (!mine) foreign = true;
      // The file the writer read is known from now on, so a later process can sweep it if this one exits first.
      else if (!seen.has(h)) markSeen(file, h);
      s.files.hold([p], mine ? { bytes: b, stamp: st } : i === 0 ? s.own : null);
    });
    s.own = { bytes, stamp: statStamp(file) };
    s.files.endRound();
    if (!s.files.size) return;
    // Review after the hold (never inside this write: applying a foreign timeline.tsx writes the project again). A
    // foreign file keeps the process alive until it is applied, so a short cb call doesn't exit with it unapplied.
    clearTimeout(s.timer);
    s.timer = setTimeout(() => review(file, s).catch((e) => warnOnce("review:" + file, "review of displaced files failed: " + errText(e))), 300);
    if (!foreign) s.timer.unref?.();
  });
}

// Files an earlier process displaced and exited before its hold ended: one still holding a state Carton wrote, untouched
// for 10 s, goes; anything else stays for a person to look at (importing an old file now would revert newer changes).
function sweep(file, s) {
  const dir = path.join(path.dirname(file), ".carton", "displaced");
  let names;
  try { names = fs.readdirSync(dir); } catch { return; }
  const seen = new Set(readSeen(file)[path.basename(file)] ?? []), now = Date.now();
  for (const n of names) {
    const p = path.join(dir, n);
    if (s.mine.has(p)) continue;
    try {
      const st = fs.statSync(p);
      if (now - st.mtimeMs > 10_000 && seen.has(sha(fs.readFileSync(p)))) fs.rmSync(p, { force: true });
    } catch {}
  }
}

// A displaced file Carton didn't write is someone's save: a project.json is imported as an outside change, a
// timeline.tsx is applied through Cardboard's own mirror (as its watcher would have), and only then is it deleted.
// One that can't be applied yet stays in .carton/displaced/ and is reported: never lost, never silently dropped.
async function review(file, s) {
  const bundle = path.dirname(file), isProject = path.basename(file) === "project.json";
  const parse = (b) => { try { return JSON.parse(b.toString("utf8")); } catch { return null; } };
  const out = s.files.review((b) => (isProject ? parse(b)?.project != null : b.length > 0));
  for (const f of out.foreign) {
    try {
      if (isProject) {
        const lc = await open(bundle);
        if (!lc) throw new Error("no history for the project");
        await lc.carton.commit({ doc: fromHost(parse(f.bytes).project, (await lc.carton.head()).doc), author: actorOf("external:project.json") });
      } else {
        const h = hostOf(bundle), id = h?.store.idForBundlePath?.(path.resolve(bundle));
        if (!id) throw new Error("no mirror for the project in this process");
        const r = await h.mirror.apply(id, f.bytes.toString("utf8"), { cartonActor: "external:timeline.tsx" });
        if (!r?.applied) throw new Error("it doesn't apply: " + (r?.diagnostics?.[0]?.message ?? "unknown"));
      }
      s.files.release(f.path);
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
  attach({ root, store, mirror }) {
    hosts.push({ root, store, mirror });
  },
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
          if (!v.name) await lc.carton.name(v.ref, label);
          return { status: "named" };
        }
        return { status: "none" };
      },
      notices: async ({ bundlePath, actor, take }) => ((await open(bundlePath))?.carton.notices(actorOf(actor), { take }) ?? []),
      // The History panel: @carton/react's view model, served to each page that asks (remoteUi there).
      ui: async ({ projectId, client, message }) => {
        let s = servers.get(client);
        if (!s) {
          const lc = await lcOf(projectId);
          if (!lc) return { status: "unavailable" };
          const handle = fromCarton(lc.carton, { me: actorOf("person") });
          const ui = handle.ui ?? handle;
          // The panel's writes (restore, fold, switching cut…) go into project.json, and the pages adopt them.
          for (const m of ["switchCut", "newCut", "renameCut", "fold", "resolve", "restore", "nameVersion", "undo", "publish"]) {
            const f = ui[m];
            if (typeof f === "function") ui[m] = async (...a) => {
              const r = await f.apply(ui, a);
              if (await materializeIn(library, projectId)) emit({ kind: "changed", id: projectId, bundlePath: bundleOf(projectId) });
              return r;
            };
          }
          s = serveUi(ui, (m) => emit({ kind: "carton", id: projectId, client, message: m }));
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
    async write(op, o) {
      for (const k of ["ref", "from"]) if (op && op[k] !== undefined) op = { ...op, [k]: await ref(op[k]) };
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
  if (!next) return false;
  await library.projects.updateScoped(next, { ownedFields: ["tracks", "timelineItems", "aspectRatio", "name"], carton: { materialize: true } });
  return true;
}
