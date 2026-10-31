// TEMPORARY, test-only: until windows lands seams R1 and R2 (notes/windows-sync.md), the live-sync tests build
// carton-node.cjs from an in-memory copy of scripts/carton/carton-node.js with exactly those two changes, so the
// requests are tested as written. Delete this file, and call ../../build.js directly, once they land.
//   R1: open() merges each extension's openOptions({bundlePath, projectId}) into openLocal's options.
//   R2: commit() on a shared cut asks the extension's commitShared(lc, {doc, base, author, intent, gui}), and treats
//       `pending` like a confirmation that merged nothing in.
const fs = require("fs"), path = require("path");

const ROOT = path.join(__dirname, "..", "..", "..", "..");
const CARTON = path.join(ROOT, "carton");
const FACADE = path.join(ROOT, "scripts", "carton", "carton-node.js");

const once = (src, from, to) => {
  const n = src.split(from).length - 1;
  if (n !== 1) throw new Error(`shim: expected 1 match, found ${n}: ${from.slice(0, 80)}`);
  return src.replace(from, to);
};

function patched() {
  let s = fs.readFileSync(FACADE, "utf8");
  if (/openOptions/.test(s) && /commitShared/.test(s)) return null; // landed: no shim needed
  s = once(s, "const lc = await openLocal({ projectDir: bundlePath, projectId: id, init: first ? { doc: fromHost(first, null) } : undefined });",
    "const lc = await openLocal({ projectDir: bundlePath, projectId: id, init: first ? { doc: fromHost(first, null) } : undefined, ...(await __shimOpenOptions({ bundlePath, projectId: id })) });");
  s = once(s, "const r = await c.commit({ doc: mine, ...(baseRef ? { base: baseRef } : {}), author: actorOf(actor), ...(intent ? { intent } : {}) });",
    "const __ext = extensions.find((e) => e.commitShared), __shared = __ext && (await c.cuts()).find((x) => x.id === c.cut)?.sequencer.kind !== \"local\";\n" +
    "  const r = __shared ? await __ext.commitShared(lc, { doc: mine, base: baseRef, author: actorOf(actor), intent, gui: meta?.base !== undefined && !!baseRef }) : await c.commit({ doc: mine, ...(baseRef ? { base: baseRef } : {}), author: actorOf(actor), ...(intent ? { intent } : {}) });");
  s = once(s, "if (r.status === \"confirmed\" && !r.rebased) {", "if ((r.status === \"confirmed\" && !r.rebased) || r.status === \"pending\") {");
  s += `
async function __shimOpenOptions(o) {
  let out = {};
  for (const e of extensions) {
    if (typeof e.openOptions !== "function") continue;
    try { out = { ...out, ...((await e.openOptions(o)) ?? {}) }; } catch (err) { warnOnce("openOptions:" + (e.name ?? "?"), "an extension's openOptions failed: " + errText(err)); }
  }
  return out;
}
`;
  return s;
}

/** windows' build, then carton-node.cjs again from the shimmed facade (same esbuild options as build.js). */
async function build(resources, assets) {
  await require("../../build.js").build(resources, assets);
  const src = patched();
  if (!src) return;
  const esbuild = require(require.resolve("esbuild", { paths: [CARTON] }));
  await esbuild.build({
    bundle: true, platform: "node", format: "cjs", target: "node24", packages: "bundle", logLevel: "error",
    banner: { js: "const __cartonUrl = require(\"node:url\").pathToFileURL(__filename).href;" },
    define: { "import.meta.url": "__cartonUrl" },
    absWorkingDir: CARTON, nodePaths: [path.join(CARTON, "node_modules")],
    stdin: { contents: `export * from "./carton-node.shim.js";\nimport "./sync/worker.js";\n`, resolveDir: path.dirname(FACADE), sourcefile: "carton-entry.js", loader: "js" },
    plugins: [{ name: "shim", setup(b) {
      b.onResolve({ filter: /carton-node(\.shim)?\.js$/ }, () => ({ path: FACADE, namespace: "file" }));
      b.onLoad({ filter: /scripts[\\/]carton[\\/]carton-node\.js$/ }, () => ({ contents: src, loader: "js", resolveDir: path.dirname(FACADE) }));
    } }],
    outfile: path.join(resources, "carton", "carton-node.cjs"),
  });
}

module.exports = { build };
