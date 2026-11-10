// Lays out Cardboard's bundles the way build-windows.js's work folder has them and runs the Windows patches on
// them, then (with --carton) patch-carton.js. No download, no asar, no Windows needed: the Carton tests run the
// result under Node.
// Usage: node stage.js <pristine> <out> [--carton]
//   <pristine> holds Cardboard's unpacked app (app-asar/, as `asar extract` gives it) and its cli/ folder.
//   <out>/work/asar-src/dist/… and <out>/res/cli/… are written; <out> is emptied first.
const fs = require("fs"), path = require("path"), { execFileSync } = require("child_process");

// A bundle by its name before the hash (index-, EditorRoute-…): the largest of that name (Cardboard has several small
// index-*.js chunks; the app's main one is by far the largest), so the tests don't name one Cardboard version's hashes.
const bundle = (dir, prefix) => {
  const all = fs.readdirSync(dir).filter((f) => f.startsWith(prefix + "-") && /\.m?js$/.test(f));
  if (!all.length) throw new Error(`no ${prefix}-*.js in ${dir}`);
  return path.join(dir, all.sort((a, b) => fs.statSync(path.join(dir, b)).size - fs.statSync(path.join(dir, a)).size)[0]);
};
// The CLI's media chunk (the timeline mirror and the project store, which patch-cli-media.js and patch-carton.js patch):
// the chunk that defines the store's writeNow.
const cliChunk = (cli) => {
  const dir = path.join(cli, "chunks");
  const hit = fs.readdirSync(dir).filter((f) => /^chunk-\w+\.mjs$/.test(f) && fs.readFileSync(path.join(dir, f), "utf8").includes("async writeNow(t){"));
  if (hit.length !== 1) throw new Error(`expected one CLI chunk with the project store in ${dir}, found ${hit.length}`);
  return path.join(dir, hit[0]);
};

const stage = (pristine, out, { carton = false } = {}) => {
  const scripts = path.join(__dirname, "..", "..");
  fs.rmSync(out, { recursive: true, force: true });
  const work = path.join(out, "work"), dist = path.join(work, "asar-src", "dist"), assets = path.join(dist, "renderer", "assets"), cli = path.join(out, "res", "cli");
  fs.cpSync(path.join(pristine, "app-asar"), path.join(work, "asar-src"), { recursive: true });
  fs.cpSync(path.join(pristine, "cli"), cli, { recursive: true, dereference: true });
  const A = { index: bundle(assets, "index"), editor: bundle(assets, "EditorRoute"), store: bundle(assets, "installErrorTelemetry"), tabs: bundle(assets, "tabs") }, chunk = cliChunk(cli);
  const node = (script, ...args) => execFileSync(process.execPath, [path.join(scripts, script), ...args], { stdio: ["ignore", "pipe", "inherit"] });
  node("patch-main.js", path.join(dist, "main.js"));
  node("patch-worker.js", path.join(dist, "library-worker.js"));
  node("patch-renderer.js", A.index, A.editor, A.store);
  node("patch-strip.js", A.tabs);
  node("patch-cli.js", path.join(cli, "cardboard.mjs"), path.join(work, "cardboard.orig.mjs"));
  node("patch-cli-media.js", chunk, path.join(work, "cli-media.orig.mjs"));
  if (carton) {
    node("patch-carton.js", "--app", path.join(dist, "main.js"), path.join(dist, "library-worker.js"), A.index, A.editor, A.store, A.tabs);
    node("patch-carton.js", "--cli", path.join(cli, "cardboard.mjs"), chunk);
    // As build-windows.js does: the live-sync half's patches on top, when it has them.
    if (fs.existsSync(path.join(scripts, "patch-carton-sync.js"))) {
      node("patch-carton-sync.js", "--app", path.join(dist, "main.js"), path.join(dist, "library-worker.js"), A.index, A.editor, A.store);
      node("patch-carton-sync.js", "--cli", path.join(cli, "cardboard.mjs"), chunk);
    }
  }
  return { cli, worker: path.join(dist, "library-worker.js"), main: path.join(dist, "main.js"), assets, chunk, bundles: A };
};

module.exports = { stage, bundle, cliChunk };
if (require.main === module) {
  const [pristine, out] = process.argv.slice(2);
  if (!out) throw new Error("usage: node stage.js <pristine> <out> [--carton]");
  console.log(stage(pristine, out, { carton: process.argv.includes("--carton") }));
}
