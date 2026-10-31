// The bridge between Cardboard's project store and timeline mirror and Carton. It is injected into both copies of
// them: the CLI's (chunk-LL26E55H.mjs) and the library worker's (library-worker.js). patch-carton.js places the hooks;
// carton/docs/INTEGRATION-1.4.0.md §4.1–4.2 says what each one does and why.
// With Carton off (CARDBOARD_CARTON is not "1"), every hook runs Cardboard's own code and nothing of Carton is
// loaded. Only the .cbproj exclusions (H11) apply either way.
// Usage: require("./carton/store-bridge")({ dir, slice, who }) → the preamble's text. `dir` is a JS expression for the
// folder that holds carton-node.cjs. `slice` names the bundle's own function that cuts a project down to what `.revs`
// keeps: tracks, items and aspect ratio, with code sources inlined. `who` is the actor when nothing else says:
// "cli" for a terminal cb, "app" for the worker's own bookkeeping.
module.exports = ({ dir, slice, who }) => String.raw`var __carton = (() => {
  // H11: a .cbproj never carries Carton's database, which holds local paths and the device's pins, or the per-agent
  // view files. Cardboard's walk compares only top-level names, so the nested folder is checked here.
  const skipInArchive = (dirRel, name) => dirRel === "" ? name === ".carton" : dirRel === ".scratch" && name === "views";
  if (process.env.CARDBOARD_CARTON !== "1") return { on: false, skipInArchive };
  const path = require("node:path");
  let api = null;
  // carton-node.cjs is loaded on first use, so a cb command that never touches a project pays nothing for it.
  const carton = () => (api ??= require(path.join(process.env.CARTON_DIR || ${dir}, "carton-node.cjs")).cardboard14);
  // Who is acting. Main sets CARDBOARD_ACTOR for the agents it starts.
  const actor = () => process.env.CARDBOARD_ACTOR || ${JSON.stringify(who)};
  // The Carton part of the scope of the mutation being applied: set by the patched updateScoped while the mutation
  // runs (synchronously, inside applyMutation), read right after it.
  let scoped = null;
  // The last commit's result per project, for the apply's status.
  const last = new Map();
  const self = {
    on: true,
    skipInArchive,
    attach(store, mirror, root) {
      carton().attach({ root, store, mirror, slice: (d) => ${slice}(d) });
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
      if (!res?.changed) return res;
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
      // Someone else's change was merged in: the store and the queued write continue from head, and in the app the
      // pages are told (main broadcasts it as a project change, which the editor adopts).
      if (entry && entry.document === res.document) store.byId.set(id, { ...entry, document: out.doc });
      self.emit?.({ kind: "changed", id, bundlePath: entry?.bundlePath });
      return { document: out.doc, changed: true };
    },
    // H1, H3: displace-then-install in place of rename(tmp, file).
    install: (tmp, file, seenStamp) => carton().install(tmp, file, seenStamp),
    // H3: timeline.tsx is written the same way, from a temp file next to it.
    async writeFile(file, text) {
      const fsp = require("node:fs/promises"), tmp = path.join(path.dirname(file), "." + path.basename(file) + "." + require("node:crypto").randomUUID() + ".tmp");
      await fsp.writeFile(tmp, text, "utf8");
      try { await carton().install(tmp, file); } catch (e) { await fsp.rm(tmp, { force: true }); throw e; }
    },
    // H1: a document on disk that Carton never wrote is a foreign write, imported when it is read.
    async sawDisk(store, id, doc) {
      const bundlePath = store.byId.get(id)?.bundlePath;
      if (!bundlePath) return;
      try { await carton().sawDisk({ bundlePath, root: store.options.root, doc }); }
      catch (e) { console.warn("[carton] import of an outside save failed:", e?.message ?? e); }
    },
    // H2, H3: the mirror's revision readers read Carton's history, newest first, then any older .revs.
    listRevisions: (mirror, bundlePath) => carton().revisions({ bundlePath, files: () => mirror.__cartonListRevisions(bundlePath) }),
    readRevision: (mirror, bundlePath, rev) => carton().revision({ bundlePath, rev, file: () => mirror.__cartonReadRevision(bundlePath, rev) }),
    history: (mirror, id, rows) => carton().history({ bundlePath: mirror.options.bundles.bundlePathFor(id), rows }),
    // H3: a header rev nothing can rebuild is an error, never a 2-way merge. No header keeps 1.4.0's meaning.
    missingRev(rev, current) {
      if (rev === undefined) return current;
      throw new Error("This timeline was printed from version " + rev + ", which is no longer available. Print it again (cb source print) and redo the edit.");
    },
    // H3: Carton's merge3 in place of Cardboard's item-level 3-way merge; same result shape.
    merge3: (base, current, file, opts, rn) => carton().merge3({ base, current, file, prefer: opts?.prefer, rn }),
    // The apply's result gains carton: {status, ref, conflicts} when its write was committed; nothing when history
    // is off for the project.
    status: (id) => { const r = last.get(id); return r && r.status !== "off" ? { carton: { status: r.status, ref: r.ref, conflicts: r.conflicts?.length ?? 0 } } : {}; },
    // H8 (worker only): the engine thread, the per-agent view watcher, and the worker's carton RPC namespace.
    // emit sends a {kind:"carton"} change to main, which passes it to the tabs.
    worker: (library, emit) => ((self.emit = emit), carton().worker({ library, emit })),
  };
  return self;
})();
`;
