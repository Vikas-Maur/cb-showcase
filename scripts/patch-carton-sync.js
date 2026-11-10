// Carton's live-sync and sharing half in Cardboard's bundles (H8's Share panel, Invite to edit and Join, H10, H11's
// "Bring in their changes", H13): carton/docs/INTEGRATION-1.5.0.md §2 and docs/carton-in-the-app.md "Carton: live sync and sharing".
// It runs right after patch-carton.js, on the files it wrote (build-windows.js and scripts/carton/test/stage.js call
// it), and refuses a file that already has these patches. Each part lives in scripts/carton/sync/patches/<part>.js and
// exports `app({ main, worker, index, editor, store })` and/or `cli({ cb, chunk })`, each value being the file's
// `{ replace(from, to, count = 1), prepend(text) }`; every anchor must match exactly `count` times or the build stops.
// With Carton off at run time (CARDBOARD_CARTON=0; it is on by default) nothing here runs: each patch is behind `window.__carton?.on`
// or `__carton.on` / `__cartonMain.on` / `__cartonCli.on`, and the worker's services exist only when the facade loads.
// Usage: node patch-carton-sync.js --app <dist/main.js> <dist/library-worker.js> <index-*.js> <EditorRoute-*.js> <installErrorTelemetry-*.js>
//        node patch-carton-sync.js --cli <cli/cardboard.mjs> <cli/chunks/chunk-AEX5IIG7.mjs>
const fs = require("fs");
const path = require("path");

const MARK = "/*__cartonSync*/";
const PARTS = fs.readdirSync(path.join(__dirname, "carton", "sync", "patches")).filter((f) => f.endsWith(".js")).sort().map((f) => require(path.join(__dirname, "carton", "sync", "patches", f)));

const open = (file) => {
  let src = fs.readFileSync(file, "utf8");
  if (src.includes(MARK)) throw new Error(`${path.basename(file)} already has Carton's sync patches; run its Windows patch script and patch-carton.js first`);
  if (!src.includes("__carton")) throw new Error(`${path.basename(file)} has no Carton patches; run patch-carton.js first`);
  let changed = false;
  return {
    replace(from, to, count = 1) {
      const n = src.split(from).length - 1;
      if (n !== count) throw new Error(`${path.basename(file)}: expected ${count} match(es), found ${n}: ${from}`);
      src = src.split(from).join(to);
      changed = true;
    },
    // At the top, but after a "#!" line (the CLI's files start with one).
    prepend(text) {
      const nl = src.startsWith("#!") ? src.indexOf("\n") + 1 : 0;
      src = src.slice(0, nl) + text + src.slice(nl);
      changed = true;
    },
    save() {
      if (!changed) return;
      // A comment at the top, after a "#!" line when the file has one (the CLI's entry).
      const nl = src.startsWith("#!") ? src.indexOf("\n") + 1 : 0;
      fs.writeFileSync(file, src.slice(0, nl) + MARK + src.slice(nl));
      console.log(`patched ${path.basename(file)} for Carton's live sync (${src.length} bytes)`);
    },
  };
};

const [mode, ...files] = process.argv.slice(2);
const run = (names) => {
  const opened = Object.fromEntries(Object.entries(names).map(([k, f]) => [k, open(f)]));
  for (const part of PARTS) part[mode.slice(2)]?.(opened);
  for (const f of Object.values(opened)) f.save();
};
if (mode === "--app") {
  const [main, worker, index, editor, store] = files;
  if (!store) throw new Error("usage: node patch-carton-sync.js --app <main.js> <library-worker.js> <index-*.js> <EditorRoute-*.js> <installErrorTelemetry-*.js>");
  run({ main, worker, index, editor, store });
} else if (mode === "--cli") {
  const [cb, chunk] = files;
  if (!chunk) throw new Error("usage: node patch-carton-sync.js --cli <cardboard.mjs> <chunk-AEX5IIG7.mjs>");
  run({ cb, chunk });
} else {
  throw new Error("usage: node patch-carton-sync.js --app <five files> | --cli <cardboard.mjs> <chunk-AEX5IIG7.mjs>");
}
