// codec-run.js <library-worker.js> <root> — through the real (patched) library worker: the store bridge's TimelineCodec
// (globalThis.__cartonTimelineCodec) beside the worker's own `timeline.print`, then, for each file in CODEC_APPLY (a
// JSON list), the worker's own `timeline.apply` of it and the project after. Prints one JSON line. codec.test.js runs
// it in its own process (the harness takes over process.parentPort). CODEC_REV: the rev the codec prints with.
const fs = require("fs");
const [workerFile, root] = process.argv.slice(2);
(async () => {
  const { call } = await require("./worker-harness.js").start(workerFile, root);
  const codec = globalThis.__cartonTimelineCodec;
  const [p] = await call("projects.list");
  const out = { codec: typeof codec };
  if (codec) {
    const project = await call("projects.read", p.id), before = JSON.stringify(project);
    const parse = async (text) => { try { return { project: await codec.parse(text, project) }; } catch (e) { return { error: e.message, name: e.name }; } };
    out.printed = await codec.print(project, process.env.CODEC_REV);
    out.own = await call("timeline.print", p.id);
    out.project = project;
    out.roundTrip = await parse(out.printed);
    out.half = await parse(out.printed.slice(0, Math.floor(out.printed.length / 2)));
    out.untouched = JSON.stringify(project) === before;
  }
  out.applied = [];
  for (const file of JSON.parse(process.env.CODEC_APPLY ?? "[]")) {
    let r;
    try { r = { result: await call("timeline.apply", p.id, fs.readFileSync(file, "utf8")) }; } catch (e) { r = { error: e.message }; }
    out.applied.push({ ...r, after: await call("projects.read", p.id) });
  }
  console.log(JSON.stringify(out));
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
