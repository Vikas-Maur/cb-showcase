// Windows: the app's own files (app://cardboard/…, the pages' JS, CSS, fonts, images) are read from app.asar without
// leaving a copy of each in %TEMP%, and the copies earlier builds left there are removed. Injected into main.js
// (patch-main.js 16).
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
// is what the stream did too, since app:// answers every request with the whole file (200, no ranges). The read
// happens in the body, as the stream's did, so a file that can't be read fails the same way: a 200 whose body errors.
var __cbAsarBody = (p) => new ReadableStream({
  async start(c) { c.enqueue(new Uint8Array(await require("fs/promises").readFile(p))); c.close(); },
});

// After the window shows: delete the copies earlier builds left in %TEMP%. A file goes only when all of these hold:
// its name is <uuid>.tmp or <uuid>.tmp.<ext> (Chromium's temp-file name, plus the extension Electron adds); it is a
// plain file; it is byte for byte a file in this app.asar with the same size and extension; and it was made before
// Windows last started, so no running Cardboard can still be using it (Electron keeps reopening its copy, so an
// older build still running would lose that file). Nothing else in %TEMP% is read, beyond its name, size and date.
// It stops after 20 s. It is done once (userData\temp-sweep.json) when nothing it should delete is left; a copy
// from since Windows started, one it couldn't delete (in use, antivirus) or a stop at 20 s leave it for the next
// start, at most 20 starts. Files are taken in a random order, so a stopped sweep goes on with others next time.
// One file read at a time, and it gives way to the app between files and while it reads app.asar's index.
var __cbAsarTempName = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.tmp(\.[^.\\/]+)?$/i;
var __cbAsarSweepRun = async ({ appPath, userData, tempDirs, budgetMs = 20000, bootMs = Date.now() - require("os").uptime() * 1000 }) => {
  const fsp = require("fs/promises"), path = require("path");
  const mark = path.join(userData, "temp-sweep.json"), t0 = Date.now();
  let prev = {};
  try { prev = JSON.parse(await fsp.readFile(mark, "utf8")); } catch {}
  if (prev.version >= 1 && (prev.done !== false || prev.tries >= 20)) return null;
  if (!__cbInAsar(appPath)) return null;
  const yieldNow = () => new Promise((r) => setImmediate(r)), late = () => Date.now() - t0 > budgetMs;
  let done = true, n = 0;
  // Every file in app.asar, by size: [{ path, ext }]. stat inside the archive reads its header, not the files.
  // Those calls don't give way to the app by themselves, so it does every 64 entries.
  const bySize = new Map();
  const walk = async (dir) => {
    for (const e of await fsp.readdir(dir, { withFileTypes: true })) {
      if (++n % 64 === 0) { await yieldNow(); if (late()) return void (done = false); }
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { await walk(p); if (!done) return; }
      else if (e.isFile()) {
        const { size } = await fsp.stat(p);
        if (size > 0) (bySize.get(size) ?? bySize.set(size, []).get(size)).push({ path: p, ext: path.extname(p).toLowerCase() });
      }
    }
  };
  await walk(appPath);
  const assets = new Map(), asset = async (p) => assets.get(p) ?? assets.set(p, await fsp.readFile(p)).get(p);
  let deleted = 0, bytes = 0, recent = 0, failed = 0;
  for (const dir of done ? tempDirs : []) {
    let names;
    try { names = await fsp.readdir(dir); } catch (e) { if (e?.code !== "ENOENT") done = false; continue; }
    names = names.filter((name) => __cbAsarTempName.test(name));
    for (let i = names.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [names[i], names[j]] = [names[j], names[i]]; }
    for (const name of names) {
      if (late()) { done = false; break; }
      await yieldNow();
      const file = path.join(dir, name), ext = (__cbAsarTempName.exec(name)[1] ?? "").toLowerCase();
      let st, match = false;
      try {
        st = await fsp.lstat(file);
        const same = st.isFile() ? (bySize.get(st.size) ?? []).filter((a) => a.ext === ext) : [];
        if (!same.length) continue;
        const buf = await fsp.readFile(file);
        for (const a of same) if (buf.equals(await asset(a.path))) { match = true; break; }
      } catch { continue; }
      if (!match) continue;
      if ((st.birthtimeMs || st.mtimeMs) >= bootMs) { recent++; continue; }
      try { await fsp.unlink(file); deleted++, bytes += st.size; } catch (e) { if (e?.code !== "ENOENT") failed++; }
    }
    if (!done) break;
  }
  if (recent || failed) done = false;
  const ms = Date.now() - t0, tries = (prev.version >= 1 ? prev.tries ?? 1 : 0) + 1;
  await fsp.writeFile(mark, JSON.stringify({ version: 1, done, tries, at: new Date().toISOString(), deleted, bytes, recent, failed, ms })).catch(() => {});
  return { deleted, bytes, recent, failed, ms, done };
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
