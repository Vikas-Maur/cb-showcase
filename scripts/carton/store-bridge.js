// The bridge between Cardboard's project store and timeline mirror and Carton. It is injected into both copies of
// them: the CLI's (chunk-LL26E55H.mjs) and the library worker's (library-worker.js). patch-carton.js places the hooks;
// carton/docs/INTEGRATION-1.4.0.md §4.1–4.2 says what each one does and why.
// With Carton off (CARDBOARD_CARTON is not "1"), every hook runs Cardboard's own code and nothing of Carton is
// loaded. Only the .cbproj exclusions (H11: .carton/ and Carton's own view files) apply either way.
// Usage: require("./carton/store-bridge")({ dir, slice, who }) → the preamble's text. `dir` is a JS expression for the
// folder that holds carton-node.cjs. `slice` names the bundle's own function that cuts a project down to what `.revs`
// keeps: tracks, items and aspect ratio, with code sources inlined. `who` is the actor when nothing else says:
// "cli" for a terminal cb, "app" for the worker's own bookkeeping.
module.exports = ({ dir, slice, who }) => String.raw`var __carton = (() => {
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
  // read as one of them, or can't be read, is not Carton's: it is kept.
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
      if (status) return st.size <= 16 * 1024 * 1024 && cartonStatus(JSON.parse(fs.readFileSync(file, "utf8")));
      // the header block is at the top of a print
      fd = fs.openSync(file, "r");
      const head = Buffer.alloc(Math.min(st.size, 64 * 1024));
      const m = REV_LINE.exec(head.toString("utf8", 0, fs.readSync(fd, head, 0, head.length, 0)));
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
  // Who is acting: the caller that started this write (as(), below), else CARDBOARD_ACTOR, which main sets for the
  // agents it starts, else the default. The context follows the write through the store's own promise chain.
  const acting = new (require("node:async_hooks").AsyncLocalStorage)();
  const actor = () => acting.getStore() || process.env.CARDBOARD_ACTOR || ${JSON.stringify(who)};
  // The Carton part of the scope of the mutation being applied: set by the patched updateScoped while the mutation
  // runs (synchronously, inside applyMutation), read right after it.
  let scoped = null;
  // The last commit's result per project, for the apply's status.
  const last = new Map();
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
    // H1, H3: displace-then-install in place of rename(tmp, file).
    install: (tmp, file, seenStamp) => (carton() ? carton().install(tmp, file, seenStamp) : require("node:fs/promises").rename(tmp, file)),
    // H8 (worker): the bundle's timeline.tsx is the Materializer's (sync/views.js): Cardboard's watcher hands a change
    // of it over instead of applying it.
    // (a facade without them never owns it: Cardboard's own apply runs)
    timelineOwned: (dir) => { const c = carton(); return typeof c?.timelineOwned === "function" && !!c.timelineOwned(dir); },
    timelineEvent: (dir) => carton()?.timelineEvent?.(dir),
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
    history: (mirror, id, rows) => (carton() ? carton().history({ bundlePath: mirror.options.bundles.bundlePathFor(id), rows }) : rows),
    // H3: a header rev nothing can rebuild is an error, never a 2-way merge. No header keeps 1.4.0's meaning, and so
    // does a project without history (Carton then answers as 1.4.0 does).
    async missingRev(rev, current, bundlePath) {
      if (rev === undefined || !carton() || !(await carton().hasHistory(bundlePath))) return current;
      throw new Error("This timeline was printed from version " + rev + ", which is no longer available. Print it again (cb source print) and redo the edit.");
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
  return self;
})();
`;
