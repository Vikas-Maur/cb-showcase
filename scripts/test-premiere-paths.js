// Checks patch-worker.js 7 and patch-cli-media.js 7 (Cardboard 1.5.0's Premiere Pro import on Windows): runs the
// path resolver of each patched bundle (XT in the library worker, Nl in the CLI's media chunk) on sample media paths
// as Premiere saves them on Windows, with the path style the patched import call passes on Windows and on a Mac.
// Runs anywhere (no Windows needed).
// Usage: node test-premiere-paths.js <patched dist/library-worker.js> <patched cli/chunks/chunk-*.mjs>
const fs = require("fs");
const assert = require("assert");

// The source of `function <name>(…){…}` in a minified bundle.
const fnSource = (src, name) => {
  const at = src.indexOf(`function ${name}(`);
  if (at < 0) throw new Error(`no function ${name}`);
  let depth = 0, i = src.indexOf("{", at);
  for (; i < src.length; i++) {
    const c = src[i];
    if (c === "/" && src[i - 1] === "(" ) { i = src.indexOf("/", i + 1); continue; } // a regex argument: /\\/g
    if (c === "{") depth++;
    else if (c === "}" && --depth === 0) break;
  }
  return src.slice(at, i + 1);
};
// `var <name>=/…/;` (a regex literal, which can hold "/" inside a class): up to the statement's end.
const varSource = (src, name) => {
  const at = src.indexOf(`var ${name}=/`), end = src.indexOf(";", src.indexOf("]/", at));
  if (at < 0 || end < 0) throw new Error(`no var ${name}`);
  return src.slice(at, end + 1);
};

// The patched call (let C=<fn>(x,<dir>,__cbWin?"win32":"posix"),…) and the resolver it calls, as a function of
// (media, prproj folder, onWindows).
const load = (file) => {
  const src = fs.readFileSync(file, "utf8");
  const call = src.match(/let C=([\w$]+)\(x,([\w$]+),__cbWin\?"win32":"posix"\)/);
  if (!call) throw new Error(`${file}: the Premiere import call isn't patched`);
  const fn = call[1], body = fnSource(src, fn);
  const re = body.match(/r==="posix"&&([\w$]+)\.test/)[1], join = body.match(/n\.push\(([\w$]+)\(/)[1];
  const code = `${varSource(src, re)}${fnSource(src, join)}${body}return [(media,dir,win)=>{const __cbWin=win;return ${fn}(media,dir,__cbWin?"win32":"posix")},(media,dir)=>${fn}(media,dir)];`;
  const [resolve, unpatched] = new Function(code)();
  return { fn, resolve, unpatched };
};

const media = {
  paths: {
    actual: "C:\\Users\\Ana\\Videos\\Shoot\\A001.mp4",
    file: "\\\\?\\D:\\Footage\\A001.mp4",
    relative: ["..\\Videos\\Shoot\\A001.mp4", "/Users/ana/Shoot/A001.mp4", "E:\\Other\\A001.mp4"],
  },
};
const dir = "C:\\Users\\Ana\\Premiere";
const macMedia = { paths: { actual: "/Volumes/Work/A001.mov", file: "", relative: ["../Shoot/A001.mov"] } };

let failed = 0;
for (const file of process.argv.slice(2)) {
  const { fn, resolve, unpatched } = load(file);
  const name = file.split(/[\\/]/).pop();
  const check = (what, got, want) => {
    try { assert.deepStrictEqual(got, want); console.log(`ok   ${name} ${fn}: ${what}`); }
    catch { failed++; console.log(`FAIL ${name} ${fn}: ${what}\n  got  ${JSON.stringify(got)}\n  want ${JSON.stringify(want)}`); }
  };
  // On Windows: Premiere's absolute paths first, then the relative one resolved against the .prproj's folder.
  check("Windows keeps the absolute Windows paths", resolve(media, dir, true), [
    "C:\\Users\\Ana\\Videos\\Shoot\\A001.mp4",
    "\\\\?\\D:\\Footage\\A001.mp4",
    "C:/Users/Ana/Videos/Shoot/A001.mp4",
  ]);
  // Before the patch, Cardboard's call (no path style) on Windows: only the relative path, which here is the same file.
  check("Cardboard's own call drops them", unpatched(media, dir), ["C:/Users/Ana/Videos/Shoot/A001.mp4"]);
  // On a Mac: as Cardboard does, absolute Windows paths are skipped.
  check("a Mac still skips them", resolve(media, dir, false), ["C:/Users/Ana/Videos/Shoot/A001.mp4"]);
  // A project saved on a Mac: the same list on both (its absolute path, then the relative one).
  check("a Mac project's paths on Windows", resolve(macMedia, dir, true), ["/Volumes/Work/A001.mov", "C:/Users/Ana/Shoot/A001.mov"]);
  check("a Mac project's paths on a Mac", resolve(macMedia, "/Users/ana/Premiere", false), ["/Volumes/Work/A001.mov", "/Users/ana/Shoot/A001.mov"]);
}
if (failed) { console.log(`${failed} failed`); process.exit(1); }
console.log("all passed");
