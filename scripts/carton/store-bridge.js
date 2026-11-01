// The bridge between Cardboard's project store and timeline mirror and Carton. It is injected into both copies of
// them: the CLI's (chunk-LL26E55H.mjs) and the library worker's (library-worker.js). patch-carton.js places the hooks;
// carton/docs/INTEGRATION-1.4.0.md §4.1–4.2 says what each one does and why.
// With Carton off (CARDBOARD_CARTON is not "1"), every hook runs Cardboard's own code and nothing of Carton is
// loaded. Only the .cbproj exclusions (H11: .carton/ and Carton's own view files) apply either way.
// Usage: require("./carton/store-bridge")({ dir, slice, who, codec }) → the preamble's text. `dir` is a JS expression
// for the folder that holds carton-node.cjs. `slice` names the bundle's own function that cuts a project down to what
// `.revs` keeps: tracks, items and aspect ratio, with code sources inlined. `who` is the actor when nothing else says:
// "cli" for a terminal cb, "app" for the worker's own bookkeeping. `codec.names` names the bundle's own functions the
// timeline codec calls (patch-carton.js proves each one where Cardboard's apply calls it); without it (unit tests of
// the bridge alone) the codec's parse throws.
const NO_CODEC = new Proxy({}, { get: () => "__cartonNoCodec" });
module.exports = ({ dir, slice, who, codec }) => {
  const N = codec?.names ?? NO_CODEC;
  return String.raw`var __carton = (() => {${codec ? "" : `
  const __cartonNoCodec = () => { throw new Error("this bundle has no timeline parser"); };`}
  // H11: a .cbproj never carries Carton's database, which holds local paths and the device's pins, or the view files
  // Carton writes for agents in .scratch/views/. Only Carton's own: anything else there is a person's or an agent's
  // (stock Cardboard tells agents to keep their working files in .scratch/) and goes into the file as in Cardboard
  // 1.4.0. Cardboard's walk compares only top-level names, so the nested files are checked here, by name and content
  // (cartonView); the walk passes the folder it reads. Carton's names compare case-insensitively where the file system
  // does (Windows, macOS), as the Open Project scrub compares them (sync/patches/cbproj.js).
  const fold = process.platform === "win32" || process.platform === "darwin";
  const folded = (name) => (fold ? name.toLowerCase() : name);
  // A file Carton wrote in .scratch/views/: a view, "<view>.tsx" whose first cardboard:rev line is Carton's
  // ("<cut>@<seq>~<hash8> b:<cut8>", as core's refString prints it; Cardboard 1.4.0's is a bare number), or its status
  // sidecar "<view>.status", Carton's JSON with exactly its fields (the materializer's StatusBody). A file that doesn't
  // read as one of them, or can't be read, is not Carton's: it is kept. The rule is cardboard-adapter's cartonViewFile,
  // which its .cbproj export and reader use: with Carton on, the facade's (viewRule, set below). With Carton off
  // Carton's code isn't loaded, so this copy of it tells the files (views.test.js holds it to the adapter's, file for
  // file); only the files are read here.
  let viewRule = () => null;
  const VIEW_TSX = /^[a-z0-9._-]+\.tsx$/i, VIEW_STATUS = /^[a-z0-9._-]+\.status$/i;
  const REV_LINE = /^[ \t]*\/\/[ \t]*cardboard:rev[ \t]+([^\r\n]*?)[ \t]*\r?$/m;
  const CARTON_REV = /^.+@\d+~[0-9a-f]{8} b:[0-9A-Za-z_-]+(?: p:[0-9A-Za-z]+)?(?: by .*)?$/;
  const STATUS_FIELDS = ["status", "ref", "seq", "conflicts", "diagnostics", "change", "at", "error"];
  const cartonStatus = (o) => !!o && typeof o === "object" && !Array.isArray(o)
    && Object.keys(o).every((k) => STATUS_FIELDS.includes(k))
    && ["confirmed", "pending", "conflicts", "rejected", "error"].includes(o.status)
    && "ref" in o && "seq" in o && "change" in o && Array.isArray(o.conflicts) && Array.isArray(o.diagnostics) && typeof o.at === "number";
  const cartonView = (file) => {
    const fs = require("node:fs"), name = require("node:path").basename(file);
    const tsx = VIEW_TSX.test(name), status = !tsx && VIEW_STATUS.test(name);
    if (!tsx && !status) return false;
    let fd = null;
    try {
      const st = fs.lstatSync(file);
      if (!st.isFile()) return false;
      const rule = viewRule();
      if (status) {
        if (st.size > 16 * 1024 * 1024) return false;
        const bytes = fs.readFileSync(file);
        return rule ? !!rule(name, bytes) : cartonStatus(JSON.parse(bytes.toString("utf8")));
      }
      // the header block is at the top of a print
      fd = fs.openSync(file, "r");
      const head = Buffer.alloc(Math.min(st.size, 64 * 1024));
      const read = fs.readSync(fd, head, 0, head.length, 0);
      if (rule) return !!rule(name, head.subarray(0, read));
      const m = REV_LINE.exec(head.toString("utf8", 0, read));
      return !!m && CARTON_REV.test(m[1]);
    } catch { return false; } finally { if (fd !== null) try { fs.closeSync(fd); } catch {} }
  };
  const skipInArchive = (dirRel, name, dir) => dirRel === ""
    ? folded(name) === ".carton"
    : folded(dirRel) === ".scratch/views" && cartonView(require("node:path").join(dir, name));
  // H8 (item 4): AGENTS.md, which Cardboard writes into each bundle for agents, gains Carton's view flow with Carton on.
  // With Carton off it is Cardboard's text, byte for byte.
  const q = (x) => "\x60" + x + "\x60";
  const VIEWS_MD = "\n## Others may edit while you work (Carton)\n\n" +
    "- Every save is a version, and the person (or a teammate) may be editing this project at the same time.\n" +
    "- Edit your own copy of the timeline: " + q("cb source print <project> --view <name>") + " prints it into " + q(".scratch/views/") + "\n" +
    "  and answers with the file to edit and its status file. Save it as you would " + q("timeline.tsx") + "; each save is\n" +
    "  applied as your change, and the status file says how it landed: " + q("confirmed") + ", " + q("conflicts") + " (someone else\n" +
    "  changed the same thing: what is there was kept, and the cards say what) or " + q("rejected") + " (with why). Read it\n" +
    "  after each save.\n" +
    "- " + q("timeline.tsx") + " keeps showing the state you started from while you work, so it never changes under you; it\n" +
    "  catches up once you are done.\n" +
    "- " + q("cb conflicts <project>") + " lists your cards and " + q("cb resolve") + " picks one; the ones you leave go to the person.\n";
  const agentsMd = (text) => (process.env.CARDBOARD_CARTON === "1" ? text + VIEWS_MD : text);
  if (process.env.CARDBOARD_CARTON !== "1") return { on: false, skipInArchive, cartonView, agentsMd };
  const path = require("node:path");
  // H3: Carton's header form on Cardboard's rev line, read with @carton/cardboard's grammar (header.ts: findRev,
  // parseRevBody): the first "// cardboard:rev" line counts; a body of digits is 1.4.0's rev (ms), any other body is
  // a Carton ref, "<cut name>@<seq>~<hash8> b:<cut token> p:<nonce> by <who>". Its ref is read as core reads it (up to
  // the last "@<seq>~<hash8> b:<8 hex>"), else up to the first " b:"; core resolves the whole body.
  const CORE_BODY = /^(.+@\d+~[0-9a-f]{8}) b:([0-9a-f]{8})(?: p:([0-9A-Za-z]+))?(?: by (.*))?$/;
  const REV_BODY = /^(.+?)(?: b:([0-9A-Za-z_-]+))?(?: p:([0-9A-Za-z]+))?(?: by (.*))?$/;
  const cartonRevOf = (text) => {
    const b = REV_LINE.exec(text)?.[1].trim();
    return b && !/^\d+$/.test(b) ? b : null;
  };
  let api;
  // carton-node.cjs is loaded on first use, so a cb command that never touches a project pays nothing for it. If it
  // can't load, every hook runs Cardboard's own code, as with Carton off.
  const carton = () => {
    if (api === undefined) {
      try { api = require(path.join(process.env.CARTON_DIR || ${dir}, "carton-node.cjs")).cardboard14; }
      catch (e) { api = null; console.warn("[carton] Carton didn't load; Cardboard runs without it:", e?.message ?? e); }
    }
    return api;
  };
  viewRule = () => carton()?.cartonViewFile ?? null;
  // Who is acting: the caller that started this write (as(), below), else CARDBOARD_ACTOR, which main sets for the
  // agents it starts, else the default. The context follows the write through the store's own promise chain.
  const acting = new (require("node:async_hooks").AsyncLocalStorage)();
  const actor = () => acting.getStore() || process.env.CARDBOARD_ACTOR || ${JSON.stringify(who)};
  // The Carton part of the scope of the mutation being applied: set by the patched updateScoped while the mutation
  // runs (synchronously, inside applyMutation), read right after it.
  let scoped = null;
  // The last commit's result per project, for the apply's status.
  const last = new Map();

  // Cardboard's own timeline.tsx printer and parser as Carton's TimelineCodec (carton/packages/cardboard/src/codec.ts),
  // for the Materializer's views and the shared file: globalThis.__cartonTimelineCodec, set below at bundle load. They
  // need the library's timeline mirror (its media table, LUTs, proxies, ids and bundle folders): attach() records each
  // one; a project is printed by the mirror whose library holds it, else by the first.
  const mirrors = [];
  const mirrorFor = (project) => {
    let first = null;
    for (const r of mirrors) {
      const m = r.deref();
      if (!m) continue;
      first ??= m;
      if (project?.id !== undefined && m.options.bundles.bundlePathFor(project.id) !== undefined) return m;
    }
    if (!first) throw new Error("Cardboard's timeline codec isn't ready: no project library is open in this process");
    return first;
  };
  // What Cardboard reports as an error diagnostic, as one error (the diagnostics ride along).
  const refused = (diagnostics) => {
    const errors = diagnostics.filter((d) => d.severity === "error");
    const e = new SyntaxError("The timeline doesn't apply: " + errors.map((d) => d.message + (d.position?.line ? " (line " + d.position.line + ")" : "")).join("; "));
    e.diagnostics = diagnostics;
    return e;
  };
  const cardboardError = (e, before = []) => (typeof e?.toDiagnostic === "function" ? refused([...before, e.toDiagnostic()]) : e);
  const timelineCodec = {
    // What cb source print and the mirror write for the project (mirror.print), with rev on the rev line in place of
    // the project's stateUpdatedAt.
    print(project, rev) {
      return mirrorFor(project).printTimeline(project, ${slice}(project), rev, []);
    },
    // Cardboard's apply of the file onto a copy of project, as it is with no earlier version to merge against (as an
    // apply with base = current): its literal-only parse, media names resolved against project.media, a text or code
    // item's media made as the apply makes it, a new clip reframed as the apply reframes it, then writeTimeline's
    // document through the store's own scoped merge (code sources move into media[].data.code.source). Never writes:
    // what the apply would ingest or import (a path to a new file, a .cube outside luts/, colorGrade.match) is an
    // error here, as is any error diagnostic and any text that doesn't parse. project is never changed.
    async parse(text, project) {
      if (typeof text !== "string") throw new TypeError("parse(text, project): text must be a string");
      const m = mirrorFor(project), cur = structuredClone(project ?? {}), newId = m.options.newId;
      const bundle = cur.id === undefined ? undefined : m.options.bundles.bundlePathFor(cur.id);
      let g;
      try { g = ${N.parse}(text); } catch (e) { throw cardboardError(e); }
      const resolve = m.mediaResolver(cur), byId = new Map((cur.media ?? []).map((x) => [x.id, x]));
      const resolveMedia = (ref) => {
        const id = resolve(ref);
        if (id === null) return null;
        const d = byId.get(id)?.data, out = { id };
        if (d?.type !== undefined) out.type = d.type;
        if (d?.duration !== undefined) out.duration = d.duration;
        if (d?.frameRate !== undefined) out.frameRate = d.frameRate;
        return out;
      };
      const grades = m.options.grades;
      const luts = grades ? await ${N.luts}(grades, g, { projectId: cur.id, dryRun: true, newId, pathOf: (p) => (bundle !== undefined && ${N.isPath}(p) ? ${N.resolvePath}(p, bundle) : null), mediaIdOf: resolve, mediaNameOf: (id) => byId.get(id)?.data?.fileName ?? null }) : null;
      const templates = bundle !== undefined ? await ${N.templates}(g, bundle) : new Map();
      // (the apply slices the project again after reading it again; this one doesn't change)
      const now = ${slice}(cur);
      let q;
      try { q = ${N.toDoc}(g, { resolveMedia, readTemplate: (p) => templates.get(p) ?? null, storedItem: ${N.stored}(now), newId }); }
      catch (e) { throw cardboardError(e, luts?.diagnostics); }
      const diagnostics = [...(luts?.diagnostics ?? []), ...q.diagnostics];
      for (const f of luts?.wouldImportLuts ?? []) diagnostics.push({ severity: "error", code: "lut-import", message: "colorGrade.lut.file " + f + " isn't in the project yet: cb source apply imports it" });
      if (luts?.requests.length) diagnostics.push({ severity: "error", code: "color-match", message: "colorGrade.match is measured by cb source apply, not by a parse" });
      if (diagnostics.some((d) => d.severity === "error")) throw refused(diagnostics);
      const framed = await ${N.reframe}(now, now, q.doc, (id) => { const x = byId.get(id); return (x && ${N.mediaInfo}(x)) ?? undefined; });
      const made = ${N.synth}(${N.keepIds}(framed, now), cur, newId);
      const doc = { ...${N.withSlice}(cur, ${N.merge}(now, now, made.doc, {}).doc), media: [...(cur.media ?? []), ...made.added] };
      return ${N.codeToMedia}(${N.keepDone}(cur, ${N.scoped}(cur, ${N.dropOrphans}(doc), { ownedFields: [...${N.owned}], ownedMediaIds: made.added.map((x) => x.id), removedMediaIds: ${N.orphans}(doc).map((x) => x.id) })));
    },
  };

  const self = {
    on: true,
    skipInArchive,
    cartonView,
    agentsMd,
    // A read of project.json or timeline.tsx can find the name missing for a moment while Carton installs the file
    // (displace, then link; in CI's NTFS race about a quarter of a tight loop's reads did). 1.4.0's saves never left a
    // gap, and its readers take a missing project.json for a removed project: the watcher tells the pages so, and the
    // store drops it from the library. In a bundle Carton tracks, a read that finds the file missing waits for it:
    // while an install holds the bundle's lock (a busy file on Windows can stretch one to seconds), else a moment,
    // for an installer without the lock. A file that stays missing fails as before.
    async readFile(file) {
      const fs = require("node:fs"), fsp = require("node:fs/promises");
      const dir = path.join(path.dirname(file), ".carton"), t0 = Date.now();
      let last = false;
      for (let i = 0; ; i++) {
        try { return await fsp.readFile(file, "utf8"); } catch (e) {
          if (e?.code !== "ENOENT" || !fs.existsSync(dir)) throw e;
          if (Date.now() - t0 > (fs.existsSync(path.join(dir, "install.lock")) ? 6000 : 50)) {
            // Past the wait. The install may have ended while this read was failing: read once more before giving up.
            if (last) throw e;
            last = true;
            continue;
          }
          last = false;
          await new Promise((r) => setTimeout(r, Math.min(1 + i, 10)));
        }
      }
    },
    attach(store, mirror, root) {
      // (weakly: Open Project's staging library goes when Cardboard is done with it)
      mirrors.push(new WeakRef(mirror));
      carton()?.attach({ root, store, mirror, slice: (d) => ${slice}(d) });
    },
    scope(scope) {
      scoped = scope?.carton ? { ...scope.carton, ownedFields: scope.ownedFields ?? [] } : null;
    },
    // H1: one Carton change per mutation, against the exact document it was applied to.
    async applyMutation(store, id, mutate, force) {
      let base = null, meta = null;
      const res = await store.__cartonApplyMutation(id, (d) => {
        base = d;
        scoped = null;
        try { return mutate(d); } finally { meta = scoped; scoped = null; }
      }, force);
      if (!res?.changed || !carton()) return res;
      const entry = store.byId.get(id);
      let out;
      try {
        out = await carton().commit({ bundlePath: entry?.bundlePath ?? null, root: store.options.root, base, doc: res.document, actor: meta?.actor ?? actor(), meta });
      } catch (e) {
        // A Carton failure never stops a save: the file is written as in 1.4.0, and the next commit imports it
        // as an outside change.
        console.warn("[carton] commit failed; saving without history:", e?.message ?? e);
        return res;
      }
      last.set(id, out);
      if (!out?.doc || out.doc === res.document) return res;
      // The file gets head: the store and the queued write continue from it. When someone else's change was merged
      // in, the pages are told too (main broadcasts it as a project change, which the editor adopts).
      // Cardboard gets a copy: head's records are Carton's own, frozen (core), and Cardboard's code edits its store's
      // documents in place, which on a frozen record is silently ignored in sloppy code, losing the edit. Once per
      // merged save.
      const doc = structuredClone(out.doc);
      if (entry && entry.document === res.document) store.byId.set(id, { ...entry, document: doc });
      if (out.merged) self.emit?.({ kind: "changed", id, bundlePath: entry?.bundlePath });
      return { document: doc, changed: true };
    },
    // H1, H3: displace-then-install in place of rename(tmp, file). rev: project.json's stateUpdatedAt as writeNow wrote
    // it (the install then needn't parse the file for it); envelope: what writeNow stringified, which a GUI save's
    // Materializer takes with the file's stamp instead of reading project.json again (H8).
    install: (tmp, file, seenStamp, rev, envelope) => (carton() ? carton().install(tmp, file, seenStamp, rev, envelope) : require("node:fs/promises").rename(tmp, file)),
    // H8 (worker): the bundle's timeline.tsx is the Materializer's (sync/views.js): Cardboard's watcher hands a change
    // of it over instead of applying it.
    // (a facade without them never owns it: Cardboard's own apply runs)
    timelineOwned: (dir) => { const c = carton(); return typeof c?.timelineOwned === "function" && !!c.timelineOwned(dir); },
    timelineEvent: (dir) => carton()?.timelineEvent?.(dir),
    // H8: after a save, Cardboard's mirror prints timeline.tsx and writes it (sync) only where the file is its own. Where
    // the Materializer prints it, the facade's install dropped that print unread; now it isn't made. (A facade without
    // mirrorOwned never owns it: Cardboard's own sync runs.)
    mirrorOwned: async (dir) => { const c = carton(); return typeof c?.mirrorOwned === "function" && !!(await c.mirrorOwned(dir)); },
    // H3: timeline.tsx is written the same way, from a temp file next to it (not at all where the Materializer writes
    // it: the facade's install drops it).
    async writeFile(file, text) {
      const fsp = require("node:fs/promises"), tmp = path.join(path.dirname(file), "." + path.basename(file) + "." + require("node:crypto").randomUUID() + ".tmp");
      if (!carton()) return fsp.writeFile(file, text, "utf8");
      await fsp.writeFile(tmp, text, "utf8");
      try { await carton().install(tmp, file); } catch (e) { await fsp.rm(tmp, { force: true }); throw e; }
    },
    // H1: a document on disk that Carton never wrote is a foreign write, imported when it is read.
    async sawDisk(store, id, doc) {
      const bundlePath = store.byId.get(id)?.bundlePath;
      if (!bundlePath || !carton()) return;
      try { await carton().sawDisk({ bundlePath, root: store.options.root, doc }); }
      catch (e) { console.warn("[carton] import of an outside save failed:", e?.message ?? e); }
    },
    // H2, H3: the mirror's revision readers read Carton's history, newest first, then any older .revs.
    listRevisions: (mirror, bundlePath) => (carton() ? carton().revisions({ bundlePath, files: () => mirror.__cartonListRevisions(bundlePath) }) : mirror.__cartonListRevisions(bundlePath)),
    readRevision: (mirror, bundlePath, rev) => (carton() ? carton().revision({ bundlePath, rev, file: () => mirror.__cartonReadRevision(bundlePath, rev) }) : mirror.__cartonReadRevision(bundlePath, rev)),
    // Laptop #2: a numeric rev's version exactly (the rev map), 1.4.0's .revs only for a rev older than Carton's history.
    revisionAtOrBefore: (mirror, bundlePath, rev) => (carton() ? carton().revisionAtOrBefore({ bundlePath, rev, slice: (d) => ${slice}(d), files: () => mirror.__cartonListRevisions(bundlePath), readFile: (n) => mirror.__cartonReadRevision(bundlePath, n) }) : mirror.__cartonRevisionAtOrBefore(bundlePath, rev)),
    // Laptop #2: a print under Carton's exact header, the version it names as Carton has it; null: 1.4.0's print.
    printed: async (mirror, project) => {
      const c = carton();
      if (!c?.printed) return null;
      try { return await c.printed({ bundlePath: mirror.options.bundles.bundlePathFor(project?.id), project }); }
      catch (e) { console.warn("[carton] print without Carton's header:", e?.message ?? e); return null; }
    },
    history: (mirror, id, rows) => (carton() ? carton().history({ bundlePath: mirror.options.bundles.bundlePathFor(id), rows }) : rows),
    // H3: a header rev nothing can rebuild is an error, never a 2-way merge. No header keeps 1.4.0's meaning, and so
    // does a project without history (Carton then answers as 1.4.0 does).
    async missingRev(rev, current, bundlePath) {
      if (rev === undefined || !carton() || !(await carton().hasHistory(bundlePath))) return current;
      const version = typeof rev === "string" ? (CORE_BODY.exec(rev) ?? REV_BODY.exec(rev))?.[1] ?? rev : rev;
      throw new Error("This timeline was printed from version " + version + ", which is no longer available. Print it again (cb source print) and redo the edit.");
    },
    // H3: the apply's parse of a file whose first rev line is Carton's (a view's, or the shared file the Materializer
    // printed) carries that ref as its rev, in place of 1.4.0's number (which only reads a line of digits, so it found
    // none, or a later one): the apply then takes its base from Carton (cartonBase), and its write's scope names that
    // version as the commit's base. Any other file keeps 1.4.0's rev.
    headerRev(parsed, text) {
      const rev = cartonRevOf(text);
      if (rev !== null) parsed.rev = rev;
      return parsed;
    },
    // H3: the exact version a Carton header names, as the bundle's slice (the .revs form the apply merges with); null
    // when Carton can't rebuild it exactly (missingRev then says so).
    async cartonBase(rev, bundlePath) {
      if (!carton()) return null;
      return (await carton().revision({ bundlePath, ref: rev, slice: (d) => ${slice}(d), file: () => null }))?.doc ?? null;
    },
    // H3: Carton's merge3 in place of Cardboard's item-level 3-way merge; same result shape.
    merge3: (base, current, file, opts, rn) => (carton() ? carton().merge3({ base, current, file, prefer: opts?.prefer, rn }) : rn(base, current, file, opts)),
    // The apply's result gains carton: {status, ref, conflicts} when its write was committed; nothing when history
    // is off for the project.
    status: (id) => { const r = last.get(id); return r && r.status !== "off" && r.status !== "materialized" ? { carton: { status: r.status, ref: r.ref, conflicts: r.cards?.length ?? 0 } } : {}; },
    // Runs fn with every write it starts attributed to who.
    as: (who, fn) => acting.run(who, fn),
    // H8 (worker only): the worker's carton RPC namespace, and who the worker's own RPC writers are. A full project
    // write through library:call is the editor's (createProject, updateProject), so the person's; a generation's
    // fill is the generation's. emit sends a {kind:"carton"} change to main, which passes it to the tabs.
    worker(library, emit) {
      self.emit = emit;
      const tag = (ns, method, who) => {
        const f = library[ns]?.[method];
        if (typeof f === "function") library[ns][method] = (...a) => acting.run(who, () => f.apply(library[ns], a));
      };
      tag("projects", "write", "person");
      tag("timeline", "finishGeneration", "generation");
      tag("timeline", "retireGenerationKey", "generation");
      return carton()?.worker({ library, emit }) ?? {};
    },
  };
  // The contract with the Materializer's wiring (carton-node.cjs, loaded later): this process's TimelineCodec.
  globalThis.__cartonTimelineCodec = timelineCodec;
  return self;
})();
`;
};
