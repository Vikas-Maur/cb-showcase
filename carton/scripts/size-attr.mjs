// Run: node carton/scripts/size-attr.mjs carton/packages/core/src <scratch dir> (prints each feature's marginal bytes).
// Feature attribution for the history bundle: copy core/src, stub one feature's code, bundle as size.mjs does.
import { build } from "esbuild";
import { gzipSync } from "node:zlib";
import { cpSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const SRC = process.argv[2], W = process.argv[3];
const measure = async (dir) => {
  const r = await build({ stdin: { contents: `export * from "./history/index.ts";`, resolveDir: dir, loader: "ts" }, bundle: true, minify: true, format: "esm", platform: "neutral", target: "es2023", write: false, logLevel: "silent" });
  const b = r.outputFiles[0].contents;
  return { min: b.length, gz: gzipSync(b, { level: 9 }).length };
};
// replace the bodies of class methods (2-space indent) with a throw
function stubMethods(file, names) {
  let s = readFileSync(file, "utf8");
  for (const n of names) {
    const re = new RegExp(`^  (?:static )?(?:get |set )?${n.replace(/[#$]/g, "\\$&")}\\(`, "m");
    const m = re.exec(s);
    if (!m) throw new Error("no method " + n);
    const open = s.indexOf("{\n", m.index);
    const close = s.indexOf("\n  }\n", open);
    s = s.slice(0, open) + "{\n    throw 0;" + s.slice(close);
  }
  writeFileSync(file, s);
}
function stubFns(file, names) {
  let s = readFileSync(file, "utf8");
  for (const n of names) {
    const m = new RegExp(`^(?:export )?function ${n}\\(`, "m").exec(s);
    if (!m) throw new Error("no fn " + n);
    const open = s.indexOf("{\n", m.index);
    const close = s.indexOf("\n}\n", open);
    s = s.slice(0, open) + "{\n  throw 0;" + s.slice(close);
  }
  writeFileSync(file, s);
}
const variants = {
  "local sequencer (v11 rule, shared with the server)": (d) => {
    const f = d + "/history/history.ts";
    writeFileSync(f, readFileSync(f, "utf8").replace(`import { createLocalSequencer, type LocalSequencer } from "../sequencer/index.ts";`, `import type { LocalSequencer } from "../sequencer/index.ts";\nconst createLocalSequencer = (..._: unknown[]): LocalSequencer => { throw 0; };`));
  },
  "cbproj export/import (+last authors, knowledge, copied-folder ids)": (d) => stubMethods(d + "/history/history.ts", ["exportShallow", "importShallow", "exportFull", "importFull", "lastAuthorMap", "knowledge", "loadKnowledge", "#unclash"]),
  "hand-off closure (Stage F2/F3)": (d) => stubMethods(d + "/history/history.ts", ["closure", "loadClosure"]),
  "cbproj + closure together (+their shared lineage walk)": (d) => stubMethods(d + "/history/history.ts", ["exportShallow", "importShallow", "exportFull", "importFull", "lastAuthorMap", "knowledge", "loadKnowledge", "#unclash", "closure", "loadClosure"]),
  "undo by actor group (+inverse remaps)": (d) => stubMethods(d + "/history/history.ts", ["undoStack", "undo", "planUndo", "#inverted"]),
  "revert, restore, log, names": (d) => stubMethods(d + "/history/history.ts", ["planRevert", "revert", "restore", "restoreTarget", "log", "nameVersion", "names"]),
  "fold-some (atomic, inverse)": (d) => stubMethods(d + "/history/history.ts", ["foldSome", "planFoldSome"]),
  "pins with owner sets": (d) => stubMethods(d + "/history/history.ts", ["pin", "release", "expirePins", "pinRow", "pinRows", "loadPin", "setPins"]),
  "credits (last author per record)": (d) => stubMethods(d + "/history/history.ts", ["creditsDetail", "credits", "#creditsAt", "authorsFrom"]),
  "refs (print, parse, any cut id)": (d) => stubMethods(d + "/history/history.ts", ["parseRef", "refString"]),
  "views (R4-02)": (d) => stubMethods(d + "/history/history.ts", ["printView", "saveView"]),
  "keyframe milestones": (d) => stubMethods(d + "/history/history.ts", ["milestone"]),
  "remap as one op": (d) => stubFns(d + "/history/history.ts", ["remapAsOneOp"]),
  "soft warnings on confirm": (d) => stubFns(d + "/history/history.ts", ["softAfter"]),
  "frozen records handed out": (d) => stubFns(d + "/engine/doc.ts", ["freezeDeep", "seal"]),
  "portable SHA-256": (d) => stubFns(d + "/engine/hash.ts", ["sha256Bytes"]),
};
const base = await measure(SRC);
console.log(`full history bundle: ${base.min} B min, ${base.gz} B min+gz`);
for (const [name, fn] of Object.entries(variants)) {
  rmSync(W, { recursive: true, force: true });
  cpSync(SRC, W, { recursive: true });
  // the package's own package.json (`sideEffects: false`) beside the copy, so it tree-shakes as the real package does
  cpSync(join(SRC, "..", "package.json"), join(W, "package.json"));
  fn(W);
  const m = await measure(W);
  console.log(`${name.padEnd(48)} ${String(base.min - m.min).padStart(6)} B min  ${String(base.gz - m.gz).padStart(5)} B gz`);
}
