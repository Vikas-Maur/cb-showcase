// Bundles Carton for the Windows build (build-windows.js runs it; see carton/docs/INTEGRATION-1.4.0.md §2):
//   <resources>/carton/carton-node.cjs     the facade (carton-node.js) with @carton/* for the library worker, main and cb
//   <resources>/carton/engine-thread-main.js, helper-main.js, factory.js
//                                          @carton/local's engine thread, headless helper and engine factory, which it
//                                          finds beside it
//   <resources>/carton/fmsv.cjs            the editor's GUI save projection, cut out of its bundle (fmsv.js)
//   <assets>/carton-ui.js                  the History panel (ui.js) with @carton/react, on the editor's own React
// esbuild comes from the carton workspace (cd carton && npm ci). The Node side is CommonJS for Electron's Node 24;
// `import.meta.url` is the file's own URL there, so @carton/local finds its sibling scripts.
// Usage: node scripts/carton/build.js <resources> <renderer-assets>
const fs = require("fs"), path = require("path");

const ROOT = path.join(__dirname, "..", "..");
const CARTON = path.join(ROOT, "carton");
const esbuild = require(require.resolve("esbuild", { paths: [CARTON] }));

const build = async (resources, assets) => {
  const out = path.join(resources, "carton");
  fs.rmSync(out, { recursive: true, force: true });
  const node = {
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "node24",
    // node:sqlite and the rest of Node's builtins come from Electron's Node.
    packages: "bundle",
    logLevel: "warning",
    banner: { js: "const __cartonUrl = require(\"node:url\").pathToFileURL(__filename).href;" },
    define: { "import.meta.url": "__cartonUrl" },
    absWorkingDir: CARTON,
    nodePaths: [path.join(CARTON, "node_modules")],
  };
  await esbuild.build({ ...node, entryPoints: [path.join(__dirname, "carton-node.js")], outfile: path.join(out, "carton-node.cjs") });
  // These two wait at the top level, so they are ES modules: the folder's package.json says .js is ESM there
  // (carton-node.cjs keeps its own extension), and require() inside them is Node's own.
  const lib = path.join(CARTON, "packages", "local", "src");
  fs.writeFileSync(path.join(out, "package.json"), JSON.stringify({ type: "module" }) + "\n");
  for (const entry of ["engine-thread-main", "helper-main", "factory"])
    if (fs.existsSync(path.join(lib, entry + ".ts")))
      await esbuild.build({ ...node, format: "esm", banner: { js: "import { createRequire as __cartonRequire } from \"node:module\"; const require = __cartonRequire(import.meta.url);" }, define: {}, entryPoints: [path.join(lib, entry + ".ts")], outfile: path.join(out, entry + ".js") });
  // The GUI save projection the worker diffs a GUI save through: Cardboard's own, from the editor store's bundle.
  fs.writeFileSync(path.join(out, "fmsv.cjs"), require("./fmsv").source(fs.readFileSync(path.join(assets, "installErrorTelemetry-DxKId8tA.js"), "utf8")));
  // The pages: React is the editor's own (window.__cartonReact, set before the import).
  await esbuild.build({
    bundle: true,
    platform: "browser",
    format: "esm",
    target: "chrome140",
    logLevel: "warning",
    entryPoints: [path.join(__dirname, "ui.js")],
    outfile: path.join(assets, "carton-ui.js"),
    absWorkingDir: CARTON,
    nodePaths: [path.join(CARTON, "node_modules")],
    alias: { react: path.join(__dirname, "react-shim.js") },
    minify: true,
  });
  const size = (f) => fs.statSync(f).size;
  console.log(`carton: carton-node.cjs ${size(path.join(out, "carton-node.cjs"))} B, carton-ui.js ${size(path.join(assets, "carton-ui.js"))} B`);
};

module.exports = { build };
if (require.main === module) {
  const [resources, assets] = process.argv.slice(2);
  if (!assets) throw new Error("usage: node scripts/carton/build.js <resources> <renderer-assets>");
  build(resources, assets).catch((e) => { console.error(e); process.exit(1); });
}
