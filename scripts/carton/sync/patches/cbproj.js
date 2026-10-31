// H11 "Bring in their changes" (PLAN §13; carton/docs/INTEGRATION-1.4.0.md §4.5) in both copies of Cardboard's .cbproj
// Save As and Open Project: the CLI's (chunk-LL26E55H.mjs) and the library worker's (library-worker.js). The code is
// scripts/carton/sync/cbproj.js, bundled into carton-node.cjs; each patch calls it through a small preamble that loads
// carton-node.cjs the way the store bridge does (the same file, so the same module instance). Every hook is behind
// `__carton.on`: with Carton off the bundles run 1.4.0's code, including its "This project ID already exists in your
// library". If carton-node.cjs can't load, the hooks also fall back to 1.4.0's behaviour.
//   Save As     the entry list Cardboard's own walk made gains `.carton-export/shallow.json` (and loses any old one).
//   Open        a staged project from a .cbproj starts its history from the sender's (prepare runs first on it).
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
// Open Project, before the staged bundle is first read.
var __cartonCbprojSeed = async (bundle) => { await __cartonCbprojApi()?.seed(bundle); };
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
    // Open Project: the staged bundle, extracted and checked, before its staging library first reads it.
    chunk.replace("prepare:async y=>{let x=await Nn({root:QM(y),", "prepare:async y=>{__carton.on&&await __cartonCbprojSeed(y);let x=await Nn({root:QM(y),");
    // Open Project for a .cbproj (openArchive; `cb project open <file.cbproj>`): a project already here is brought up to
    // date in place. `n` is the library's project store.
    chunk.replace("S=async(h,y)=>{let x=await sb(h);return b(x,T=>Zf(", "S=async(h,y)=>{let x=await sb(h);if(__carton.on){let __r=await __cartonCbprojBringIn(x,n);if(__r)return __r}return b(x,T=>Zf(");
  },
  app({ worker }) {
    worker.prepend(preamble(`require("node:path").join(__dirname, "..", "..", "carton")`));
    // The same three in the worker's copy (the app's File > Save As… and Open Project…).
    worker.replace("c=[...await iH(t),...o];await sH(t,c);", "c=[...await iH(t),...o];__carton.on&&(c=await __cartonCbprojExport(t,c));await sH(t,c);");
    worker.replace("prepare:async x=>{let _=await Op({root:(0,tc.dirname)(x),", "prepare:async x=>{__carton.on&&await __cartonCbprojSeed(x);let _=await Op({root:(0,tc.dirname)(x),");
    worker.replace("I=async(y,x)=>{let _=await(0,Ar.realpath)(y);return T(_,N=>qP(", "I=async(y,x)=>{let _=await(0,Ar.realpath)(y);if(__carton.on){let __r=await __cartonCbprojBringIn(_,n);if(__r)return __r}return T(_,N=>qP(");
  },
};
