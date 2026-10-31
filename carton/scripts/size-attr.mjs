// Run: node carton/scripts/size-attr.mjs carton/packages/core/src <scratch dir> (prints each feature's marginal bytes).
// Feature attribution for the history bundle: copy core/src, stub one feature's code, bundle as size.mjs does.
import { build } from "esbuild";
import { gzipSync } from "node:zlib";
import { cpSync, rmSync, readFileSync, writeFileSync } from "node:fs";
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
  "cbproj export/import (+lastAuthorMap, knowledge)": (d) => stubMethods(d + "/history/history.ts", ["exportShallow", "importShallow", "exportFull", "importFull", "lastAuthorMap", "knowledge", "loadKnowledge"]),
  "undo by actor group (+inverse remaps)": (d) => stubMethods(d + "/history/history.ts", ["undoStack", "undo", "#inverted"]),
  "pins with owner sets": (d) => stubMethods(d + "/history/history.ts", ["pin", "release", "expirePins", "pinRow", "pinRows", "loadPin", "setPins"]),
  "views (R4-02)": (d) => stubMethods(d + "/history/history.ts", ["printView", "saveView"]),
  "fold-some (atomic, inverse)": (d) => stubMethods(d + "/history/history.ts", ["foldSome"]),
  "log, names, restore": (d) => stubMethods(d + "/history/history.ts", ["log", "nameVersion", "names", "restore"]),
  "remap as one op": (d) => stubFns(d + "/history/history.ts", ["remapAsOneOp"]),
  "soft warnings on confirm": (d) => stubFns(d + "/history/history.ts", ["softAfter"]),
  "local sequencer (v11 rule)": (d) => {
    const f = d + "/history/history.ts";
    writeFileSync(f, readFileSync(f, "utf8").replace(`import { createLocalSequencer, type LocalSequencer } from "../sequencer/index.ts";`, `import type { LocalSequencer } from "../sequencer/index.ts";\nconst createLocalSequencer = (..._: unknown[]): LocalSequencer => { throw 0; };`));
  },
  "portable SHA-256": (d) => stubFns(d + "/engine/hash.ts", ["sha256Bytes"]),
};
const base = await measure(SRC);
console.log(`full history bundle: ${base.min} B min, ${base.gz} B min+gz`);
for (const [name, fn] of Object.entries(variants)) {
  rmSync(W, { recursive: true, force: true });
  cpSync(SRC, W, { recursive: true });
  fn(W);
  const m = await measure(W);
  console.log(`${name.padEnd(48)} ${String(base.min - m.min).padStart(6)} B min  ${String(base.gz - m.gz).padStart(5)} B gz`);
}
