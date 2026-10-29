// Windows: retry fs/promises.rename while another handle has the target open. Cardboard saves
// project.json by writing a temp file and renaming it over the old one. Windows refuses to replace a file
// that anything has open (EPERM), where macOS just replaces it, and Cardboard's own watcher reads
// project.json after every save. So during an import a save often lands while the previous one is being
// read, and that clip's import failed. Up to about 1.3 s (10, 20, 40 … 320 ms), as graceful-fs does.
// Bundles call rename through the module object, (0,X.rename)(…), so replacing it covers every caller.
// The CLI imports it as an ES module binding, which follows the module object only once synced.
// Injected into the library worker (patch-worker.js) and the CLI (patch-cli.js). Not into main: it has
// retries of its own for its writes (4 tries, 50 ms apart), which this would multiply.
module.exports = String.raw`if (process.platform === "win32" && !globalThis.__cbRenameRetry) {
  globalThis.__cbRenameRetry = true;
  const fsp = require("fs/promises"), rename = fsp.rename;
  fsp.rename = async (from, to) => {
    for (let i = 0; ; i++) {
      try { return await rename(from, to); } catch (e) {
        if (i >= 8 || !["EPERM", "EBUSY", "EACCES"].includes(e?.code)) throw e;
        await new Promise((r) => setTimeout(r, 10 * 2 ** Math.min(i, 5)));
      }
    }
  };
  require("module").syncBuiltinESMExports();
}
`;
