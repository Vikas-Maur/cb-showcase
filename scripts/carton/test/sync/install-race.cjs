// Fault injection for the sync tests (review 2 of fix/demo-sync-bugs, P1: the reviewer's): while the file named by
// CARTON_TEST_INSTALL_RACE exists, the next time Carton links a project.json into place, another program replaces it at
// once (atomically), with the title "Hello" reading "Concurrent outside edit": between Carton's install and anything
// it records of that install. `<file>.hit` says it happened. Loaded into a worker with NODE_OPTIONS=--require.
const fs = require("node:fs"), path = require("node:path");
const { syncBuiltinESMExports } = require("node:module");
const real = fs.linkSync;
fs.linkSync = function (src, dest, ...rest) {
  const out = real.call(this, src, dest, ...rest);
  const flag = process.env.CARTON_TEST_INSTALL_RACE;
  if (flag && path.basename(String(dest)) === "project.json" && fs.existsSync(flag)) {
    fs.unlinkSync(flag);
    const env = JSON.parse(fs.readFileSync(dest, "utf8"));
    env.project.timelineItems.find((i) => i.name === "Hello").textContent = "Concurrent outside edit";
    fs.writeFileSync(dest + ".outside", JSON.stringify(env));
    fs.renameSync(dest + ".outside", dest);
    fs.writeFileSync(flag + ".hit", String(env.project.stateUpdatedAt));
  }
  return out;
};
syncBuiltinESMExports();
