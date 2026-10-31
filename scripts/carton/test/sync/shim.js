// TEMPORARY, test-only: until windows lands seams R1 and R2 (notes/windows-sync.md), the live-sync tests build
// carton-node.cjs from an in-memory copy of scripts/carton/carton-node.js with exactly those two changes, so the
// requests are tested as written. Delete this file, and call ../../build.js directly, once they land.
//   R1: open() merges each extension's openOptions({bundlePath, projectId}) into openLocal's options.
//   R2: commit() on a shared cut asks the extension's commitShared(lc, {doc, base, author, intent, gui}), and treats
//       `pending` like a confirmation that merged nothing in.
//   R4: materializeIn writes description, and media through Cardboard's own media scope (ownedMediaIds for records
//       added or changed, removedMediaIds for records gone: 1.4.0's updateScoped never takes media from ownedFields).
//   R6: before that write, each extension's materializeDoc(next, {bundlePath, projectId, current}) may fill in what
//       only the host knows (a teammate's new clip: where it plays from, its size and duration).
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
  if (/openOptions/.test(s) && /commitShared/.test(s) && /ownedMediaIds/.test(s) && /materializeDoc/.test(s)) return null; // landed: no shim needed
  s = once(s, "const lc = await openLocal({ projectDir: bundlePath, projectId: id, init: first ? { doc: fromHost(first, null) } : undefined });",
    "const lc = await openLocal({ projectDir: bundlePath, projectId: id, init: first ? { doc: fromHost(first, null) } : undefined, ...(await __shimOpenOptions({ bundlePath, projectId: id })) });");
  s = once(s, "const r = await c.commit({ doc: mine, ...(baseRef ? { base: baseRef } : {}), author: actorOf(actor), ...(intent ? { intent } : {}) });",
    "const __ext = extensions.find((e) => e.commitShared), __shared = __ext && (await c.cuts()).find((x) => x.id === c.cut)?.sequencer.kind !== \"local\";\n" +
    "  const r = __shared ? await __ext.commitShared(lc, { doc: mine, base: baseRef, author: actorOf(actor), intent, gui: meta?.base !== undefined && !!baseRef }) : await c.commit({ doc: mine, ...(baseRef ? { base: baseRef } : {}), author: actorOf(actor), ...(intent ? { intent } : {}) });");
  s = once(s, "if (r.status === \"confirmed\" && !r.rebased) {", "if ((r.status === \"confirmed\" && !r.rebased) || r.status === \"pending\") {");
  // R4 + R6: head goes into project.json with description, and media by Cardboard's media scope; extensions fill in
  // what only the host knows first.
  s = once(s, `  const next = await headProject(library.projects.bundlePathFor(projectId), current);
  if (!next) return false;
  await library.projects.updateScoped(next, { ownedFields: ["tracks", "timelineItems", "aspectRatio", "name"], carton: { materialize: true } });`,
    `  const bundlePath = library.projects.bundlePathFor(projectId);
  let next = await headProject(bundlePath, current);
  if (!next) return false;
  for (const e of extensions) {
    if (typeof e.materializeDoc !== "function") continue;
    try { next = (await e.materializeDoc(next, { bundlePath, projectId, current })) ?? next; } catch (err) { warnOnce("materializeDoc:" + (e.name ?? "?"), "an extension's materializeDoc failed: " + errText(err)); }
  }
  const had = new Map((current?.media ?? []).map((m) => [m.id, JSON.stringify(m)]));
  const keep = new Set((next.media ?? []).map((m) => m.id));
  const ownedMediaIds = (next.media ?? []).filter((m) => had.get(m.id) !== JSON.stringify(m)).map((m) => m.id);
  const removedMediaIds = [...had.keys()].filter((mid) => !keep.has(mid));
  await library.projects.updateScoped(next, { ownedFields: ["tracks", "timelineItems", "aspectRatio", "name", "description"], ownedMediaIds, removedMediaIds, carton: { materialize: true } });`);
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
