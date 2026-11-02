// Windows: the app's own files (app://cardboard/…, the pages' JS, CSS, fonts, images) are read from app.asar without
// leaving a copy of each in %TEMP%, and the copies earlier builds left there are removed once. Injected into main.js
// (patch-main.js 15).
//
// Cardboard's app:// handler streams a file with fs.createReadStream. For a file packed in app.asar, Electron's asar
// support can't hand a stream a real file descriptor, so it copies the file out to a temp file (<uuid>.tmp.<ext> on
// Windows) and opens that. The copy is never deleted: Electron keeps the archive, and its list of copies, until the
// process ends, and doesn't clean up then either. Every launch left ~57 files (~9 MB) in %TEMP%, also after a clean
// quit. macOS purges $TMPDIR, so it never piled up there; Windows keeps %TEMP% unless Storage Sense is on.
// fs.promises.readFile reads a packed file from the archive itself (at its offset in app.asar), with no copy.
module.exports = String.raw`
// A path inside an .asar archive (app.asar\dist\…). app.asar.unpacked\… is a real folder and doesn't match.
var __cbInAsar = (p) => /\.asar(?:[\\/]|$)/i.test(p);
// The whole file, read from the archive. The app's files are small (the largest is under 3 MB); a whole-file read
// is what the stream did too, since app:// answers every request with the whole file (200, no ranges).
var __cbAsarBody = (p) => require("fs/promises").readFile(p);

// Once, after the window shows: delete the copies earlier builds left in %TEMP%. A file goes only when all of these
// hold: its name is <uuid>.tmp or <uuid>.tmp.<ext> (Chromium's temp-file name, plus the extension Electron adds); it
// is a plain file; and it is byte for byte a file in this app.asar with the same size and extension. Nothing else in
// %TEMP% is read, beyond its name and size. Done once: userData\temp-sweep.json records it. It stops after 20 s
// and, if it did, carries on at the next start. One file read at a time, so it costs the app little.
var __cbAsarTempName = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.tmp(\.[^.\\/]+)?$/i;
var __cbAsarSweepRun = async ({ appPath, userData, tempDirs, budgetMs = 20000 }) => {
  const fsp = require("fs/promises"), path = require("path");
  const mark = path.join(userData, "temp-sweep.json"), t0 = Date.now();
  try { if (JSON.parse(await fsp.readFile(mark, "utf8")).version >= 1) return null; } catch {}
  if (!__cbInAsar(appPath)) return null;
  // Every file in app.asar, by size: [{ path, ext }]. stat inside the archive reads its header, not the files.
  const bySize = new Map();
  const walk = async (dir) => {
    for (const e of await fsp.readdir(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) await walk(p);
      else if (e.isFile()) {
        const { size } = await fsp.stat(p);
        if (size > 0) (bySize.get(size) ?? bySize.set(size, []).get(size)).push({ path: p, ext: path.extname(p).toLowerCase() });
      }
    }
  };
  await walk(appPath);
  const assets = new Map(), asset = async (p) => assets.get(p) ?? assets.set(p, await fsp.readFile(p)).get(p);
  let deleted = 0, bytes = 0, done = true;
  for (const dir of tempDirs) {
    let names;
    try { names = await fsp.readdir(dir); } catch { continue; }
    for (const name of names) {
      if (Date.now() - t0 > budgetMs) { done = false; break; }
      const m = __cbAsarTempName.exec(name);
      if (!m) continue;
      const file = path.join(dir, name), ext = (m[1] ?? "").toLowerCase();
      try {
        const st = await fsp.lstat(file);
        const same = st.isFile() ? (bySize.get(st.size) ?? []).filter((a) => a.ext === ext) : [];
        if (!same.length) continue;
        const buf = await fsp.readFile(file);
        let match = false;
        for (const a of same) if (buf.equals(await asset(a.path))) { match = true; break; }
        if (!match) continue;
        await fsp.unlink(file);
        deleted++, bytes += st.size;
      } catch {}
    }
    if (!done) break;
  }
  const ms = Date.now() - t0;
  if (done) await fsp.writeFile(mark, JSON.stringify({ version: 1, at: new Date().toISOString(), deleted, bytes, ms })).catch(() => {});
  return { deleted, bytes, ms, done };
};
var __cbAsarSweepSoon = (w) => {
  let started = false;
  const go = () => {
    if (started) return;
    started = true;
    setTimeout(() => {
      const { app } = require("electron"), os = require("os");
      const tempDirs = [...new Map([process.env.TEMP, process.env.TMP, os.tmpdir()].filter(Boolean).map((d) => [d.toLowerCase(), d])).values()];
      __cbAsarSweepRun({ appPath: app.getAppPath(), userData: app.getPath("userData"), tempDirs })
        .then((r) => { r && typeof __cbLog === "function" && __cbLog("temp-sweep", r); }, () => {});
    }, 10000).unref?.();
  };
  if (w && !w.isDestroyed?.() && w.isVisible?.()) go();
  else w?.once?.("show", go);
  // A start with no window shown (quiet): a minute in.
  setTimeout(go, 60000).unref?.();
};
`;
