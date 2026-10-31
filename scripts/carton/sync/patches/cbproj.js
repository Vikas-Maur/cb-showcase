// H11 "Bring in their changes" (PLAN §13; carton/docs/INTEGRATION-1.4.0.md §4.5) in both copies of Cardboard's .cbproj
// Save As and Open Project: the CLI's (chunk-LL26E55H.mjs) and the library worker's (library-worker.js). The code is
// scripts/carton/sync/cbproj.js, bundled into carton-node.cjs; each patch calls it through a small preamble that loads
// carton-node.cjs the way the store bridge does (the same file, so the same module instance). Every Carton hook is
// behind `__carton.on`: with Carton off the bundles run 1.4.0's code, including its "This project ID already exists in
// your library". If carton-node.cjs can't load, the hooks also fall back to 1.4.0's behaviour. One step runs with
// Carton off too (round 2 #1, kept by the orchestrator): removing what Carton itself wrote from a staged bundle, its
// `.carton/` folder and its view files in `.scratch/views/` (told by Carton's header or status format: the store
// bridge's cartonView), never anything else. It only acts on projects that contain Carton's data, so a stock .cbproj
// opens exactly as before, and a person's or an agent's own files in `.scratch/views/` stay. It stops someone else's
// carton.db and views from landing silently in a Carton-off library and surfacing as foreign history if Carton is
// switched on later. The archive itself is untouched, so nothing is lost. Opening a project folder goes through the
// same prepare (Cardboard's import options are shared), so its staged copy is scrubbed and seeded the same way and the
// folder itself is untouched. README "Saves on Windows" lists every Carton-off difference.
//   Save As     the entry list Cardboard's own walk made gains `.carton-export/shallow.json` (and loses any old one),
//               and `.carton-export/history.db` with "Include history" (CARTON_CBPROJ_HISTORY=1), a copy in `.carton/tmp/`
//               removed once the zip is written (or failed to be).
//   Open        a staged project from a .cbproj (or a project folder) loses any `.carton/` and Carton view files in it
//               (Carton on or off: Cardboard's extractor takes every member, and a crafted carton.db could carry a
//               shared cut and a helper recipe naming a module a later cb run would load); with Carton on its history
//               then starts from the sender's (prepare runs first on it); whatever Carton opened in the staged
//               bundle is closed when Cardboard's prepare ends, before Cardboard removes its staging folder.
//   Open        a .cbproj of a project the library has, with history: "Bring in their changes" instead of the error.

// The preamble: `dir` is the folder that holds carton-node.cjs, as the store bridge names it in that bundle.
const preamble = (dir) => String.raw`var __cartonCbprojApi = () => {
  if (!globalThis.__cartonCbproj) {
    try { require(require("node:path").join(process.env.CARTON_DIR || ${dir}, "carton-node.cjs")); }
    catch (e) { console.warn("[carton] Carton didn't load; .cbproj files open and save as in Cardboard 1.4.0:", e?.message ?? e); }
  }
  return globalThis.__cartonCbproj ?? null;
};
// Save As: Cardboard's entries, with Carton's (never a reason to fail the save).
var __cartonCbprojExport = async (bundle, entries) => {
  const c = __cartonCbprojApi();
  return c ? c.exportEntries(bundle, entries) : entries;
};
// After the zip is written, or failed to be: the history copy made for it goes.
var __cartonCbprojSaved = (entries) => { globalThis.__cartonCbproj?.saved(entries).catch(() => {}); };
// Open Project, before the staged bundle is first read. Carton's local state never comes from a file: what Carton
// wrote is removed whether Carton is on or not (a bundle opened with Carton off would hand it to Carton once it is
// turned on, as foreign history), case-insensitively where the file system folds case. That is .carton/, and in
// .scratch/views/ only the files __carton.cartonView tells as Carton's views and status files: anything else there
// (a person's or an agent's own files, subfolders) stays, as with Cardboard 1.4.0. Only the staged copy: the .cbproj
// itself is untouched. Cardboard has already refused links and special files in the staged bundle. What can't be
// removed (Windows: something holds a file for good) fails the open.
var __cartonCbprojScrub = async (bundle) => {
  const fs = require("node:fs"), path = require("node:path");
  const fold = process.platform === "win32" || process.platform === "darwin";
  const is = (name, want) => (fold ? name.toLowerCase() : name) === want;
  const names = (dir) => { try { return fs.readdirSync(dir); } catch { return []; } };
  const rm = async (p) => {
    for (let i = 0; ; i++) {
      try { return fs.rmSync(p, { recursive: true, force: true }); } catch (e) {
        if (i >= 50 || !["EPERM", "EBUSY", "EACCES", "ENOTEMPTY"].includes(e.code)) throw e;
        await new Promise((r) => setTimeout(r, 50));
      }
    }
  };
  for (const n of names(bundle)) {
    if (is(n, ".carton")) await rm(path.join(bundle, n));
    else if (is(n, ".scratch")) {
      for (const v of names(path.join(bundle, n))) {
        if (!is(v, "views")) continue;
        const views = path.join(bundle, n, v);
        for (const f of names(views)) if (__carton.cartonView(path.join(views, f))) await rm(path.join(views, f));
      }
    }
  }
};
var __cartonCbprojSeed = async (bundle, on) => {
  await __cartonCbprojScrub(bundle);
  if (on) await __cartonCbprojApi()?.seed(bundle);
};
// Open Project's prepare (Cardboard reads and writes the staged bundle through a staging library), between the seed and
// Cardboard's removal of its staging folder: whatever Carton opened there is closed when prepare ends, worked or not
// (Windows can't remove an open file: Cardboard's clean-up failed with EBUSY on the staged carton.db, CI route 35).
var __cartonCbprojStage = (prepare) => async (bundle) => {
  const on = __carton.on;
  await __cartonCbprojSeed(bundle, on);
  try { return await prepare(bundle); }
  finally { if (on) await globalThis.__cartonCbproj?.release(bundle).catch(() => {}); }
};
// Open Project: the existing project after bringing their changes in, or null for 1.4.0's import.
var __cartonCbprojBringIn = async (file, store) => {
  const c = __cartonCbprojApi();
  return c ? c.bringIn(file, store) : null;
};
`;

// The CLI's chunk starts with "#!" and imports, so the preamble goes after its require shim (functions only: they run
// later, once require exists).
const SHIM = "const require = __createRequire(import.meta.url);\n";

module.exports = {
  cli({ chunk }) {
    chunk.replace(SHIM, SHIM + preamble(`require("node:url").fileURLToPath(new URL("../../carton/", import.meta.url))`));
    // Save As (`cb project save-as`, rp): the entries after the walk and the media copied in from outside the bundle.
    chunk.replace("l=[...await iS(t),...a];await cS(t,l);", "l=[...await iS(t),...a];__carton.on&&(l=await __cartonCbprojExport(t,l));await cS(t,l);");
    // The history copy goes once the zip is written or failed (`l` is the entry list; the zip's write is the try).
    chunk.replace("catch(v){throw await eS(w,{force:!0}),v}return{path:r,size:f,missing:c}}", "catch(v){throw await eS(w,{force:!0}),v}finally{__carton.on&&__cartonCbprojSaved(l)}return{path:r,size:f,missing:c}}");
    // Open Project: the staged bundle, extracted and checked, before its staging library first reads it.
    chunk.replace("prepare:async y=>{let x=await Nn({root:QM(y),", "prepare:__cartonCbprojStage(async y=>{let x=await Nn({root:QM(y),");
    chunk.replace('throw new Error("Project timeline did not apply")}}),b=(h,y)=>', 'throw new Error("Project timeline did not apply")})}),b=(h,y)=>');
    // Open Project for a .cbproj (openArchive; `cb project open <file.cbproj>`): a project already here is brought up to
    // date in place. `n` is the library's project store.
    chunk.replace("S=async(h,y)=>{let x=await sb(h);return b(x,T=>Zf(", "S=async(h,y)=>{let x=await sb(h);if(__carton.on){let __r=await __cartonCbprojBringIn(x,n);if(__r)return __r}return b(x,T=>Zf(");
  },
  app({ worker }) {
    worker.prepend(preamble(`require("node:path").join(__dirname, "..", "..", "carton")`));
    // The same three in the worker's copy (the app's File > Save As… and Open Project…).
    worker.replace("c=[...await iH(t),...o];await sH(t,c);", "c=[...await iH(t),...o];__carton.on&&(c=await __cartonCbprojExport(t,c));await sH(t,c);");
    worker.replace("catch(g){throw await(0,Kr.rm)(b,{force:!0}),g}return{path:r,size:m,missing:s}}", "catch(g){throw await(0,Kr.rm)(b,{force:!0}),g}finally{__carton.on&&__cartonCbprojSaved(c)}return{path:r,size:m,missing:s}}");
    worker.replace("prepare:async x=>{let _=await Op({root:(0,tc.dirname)(x),", "prepare:__cartonCbprojStage(async x=>{let _=await Op({root:(0,tc.dirname)(x),");
    worker.replace('throw new Error("Project timeline did not apply")}}),T=(y,x)=>', 'throw new Error("Project timeline did not apply")})}),T=(y,x)=>');
    worker.replace("I=async(y,x)=>{let _=await(0,Ar.realpath)(y);return T(_,N=>qP(", "I=async(y,x)=>{let _=await(0,Ar.realpath)(y);if(__carton.on){let __r=await __cartonCbprojBringIn(_,n);if(__r)return __r}return T(_,N=>qP(");
  },
};
