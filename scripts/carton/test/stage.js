// Lays out Cardboard 1.4.0's bundles the way build-windows.js's work folder has them and runs the Windows patches on
// them, then (with --carton) patch-carton.js. No download, no asar, no Windows needed: the Carton tests run the
// result under Node.
// Usage: node stage.js <pristine> <out> [--carton]
//   <pristine> holds Cardboard's unpacked app (app-asar/, as `asar extract` gives it) and its cli/ folder.
//   <out>/work/asar-src/dist/… and <out>/res/cli/… are written; <out> is emptied first.
const fs = require("fs"), path = require("path"), { execFileSync } = require("child_process");

const stage = (pristine, out, { carton = false } = {}) => {
  const scripts = path.join(__dirname, "..", "..");
  fs.rmSync(out, { recursive: true, force: true });
  const work = path.join(out, "work"), dist = path.join(work, "asar-src", "dist"), assets = path.join(dist, "renderer", "assets"), cli = path.join(out, "res", "cli");
  fs.cpSync(path.join(pristine, "app-asar"), path.join(work, "asar-src"), { recursive: true });
  fs.cpSync(path.join(pristine, "cli"), cli, { recursive: true, dereference: true });
  const node = (script, ...args) => execFileSync(process.execPath, [path.join(scripts, script), ...args], { stdio: ["ignore", "pipe", "inherit"] });
  node("patch-main.js", path.join(dist, "main.js"));
  node("patch-worker.js", path.join(dist, "library-worker.js"));
  node("patch-renderer.js", path.join(assets, "index-DufLJgUU.js"), path.join(assets, "EditorRoute-CuIqwZKP.js"), path.join(assets, "installErrorTelemetry-DxKId8tA.js"));
  node("patch-strip.js", path.join(assets, "tabs-DV5oCzuF.js"));
  node("patch-cli.js", path.join(cli, "cardboard.mjs"), path.join(work, "cardboard.orig.mjs"));
  node("patch-cli-media.js", path.join(cli, "chunks", "chunk-LL26E55H.mjs"), path.join(work, "cli-media.orig.mjs"));
  if (carton) {
    node("patch-carton.js", "--app", path.join(dist, "main.js"), path.join(dist, "library-worker.js"), path.join(assets, "index-DufLJgUU.js"), path.join(assets, "EditorRoute-CuIqwZKP.js"), path.join(assets, "installErrorTelemetry-DxKId8tA.js"), path.join(assets, "tabs-DV5oCzuF.js"));
    node("patch-carton.js", "--cli", path.join(cli, "cardboard.mjs"), path.join(cli, "chunks", "chunk-LL26E55H.mjs"));
    // As build-windows.js does: the live-sync half's patches on top, when it has them.
    if (fs.existsSync(path.join(scripts, "patch-carton-sync.js"))) {
      node("patch-carton-sync.js", "--app", path.join(dist, "main.js"), path.join(dist, "library-worker.js"), path.join(assets, "index-DufLJgUU.js"), path.join(assets, "EditorRoute-CuIqwZKP.js"), path.join(assets, "installErrorTelemetry-DxKId8tA.js"));
      node("patch-carton-sync.js", "--cli", path.join(cli, "cardboard.mjs"), path.join(cli, "chunks", "chunk-LL26E55H.mjs"));
    }
  }
  return { cli, worker: path.join(dist, "library-worker.js"), main: path.join(dist, "main.js"), assets };
};

module.exports = { stage };
if (require.main === module) {
  const [pristine, out] = process.argv.slice(2);
  if (!out) throw new Error("usage: node stage.js <pristine> <out> [--carton]");
  console.log(stage(pristine, out, { carton: process.argv.includes("--carton") }));
}
