// Loaded into a test's library worker with --require (save-cost.test.js): counts the work a save makes, as numbers that
// don't depend on how fast or busy the machine is. worker-proc.js's "test.counters" returns the counts since the last
// call and starts again from zero.
//   fs        every file system call (node:fs, sync and promise), by name: on Windows each is a round trip through
//             NTFS (and often the virus scanner), so their number is what a save costs there
//   mirror    Cardboard's own print of timeline.tsx written to its temp file (the store bridge's writeFile)
//   project   calls of the editor's GUI save projection P (fmsv.cjs): how many items a save projects
const fs = require("fs");
const Module = require("module");
let counts, inside = false;
const reset = () => (counts = { fs: 0, byCall: {}, mirror: 0, project: 0 });
reset();
const MIRROR_TMP = /[\\/]\.timeline\.tsx\.[0-9a-f-]+\.tmp$/;
const count = (name, file) => {
  counts.fs++;
  counts.byCall[name] = (counts.byCall[name] ?? 0) + 1;
  if (name === "promises.writeFile" && typeof file === "string" && MIRROR_TMP.test(file)) counts.mirror++;
};
for (const [obj, prefix] of [[fs, ""], [fs.promises, "promises."]]) {
  for (const k of Object.keys(obj)) {
    const f = obj[k];
    // the functions that reach the file system (not the classes, constants or watchers)
    if (typeof f !== "function" || /^[A-Z]|watch|Stream|^constants$/.test(k) || (prefix === "" && !k.endsWith("Sync"))) continue;
    // One count per call made from outside: Node's own readFileSync calls openSync, readSync and closeSync, which
    // aren't counted again. (statics kept: realpathSync.native)
    obj[k] = Object.assign(function (...a) {
      if (inside) return f.apply(this, a);
      count(prefix + k, a[0]);
      inside = true;
      try { return f.apply(this, a); } finally { inside = false; }
    }, f);
  }
}
// P, cut out of the editor's bundle at build time and loaded by the facade on first use
const load = Module._load;
Module._load = function (request, ...rest) {
  const m = load.call(this, request, ...rest);
  if (typeof request === "string" && /[\\/]fmsv\.cjs$/.test(request) && typeof m === "function" && !m.__counted) {
    const counted = function (...a) { counts.project++; return m.apply(this, a); };
    counted.__counted = true;
    return counted;
  }
  return m;
};
globalThis.__cartonTestCounters = () => { const c = counts; reset(); return c; };
