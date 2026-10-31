// worker-run.js <library-worker.js> <root> — through the real (patched) library worker: read a project, save it as the
// GUI does (whole arrays, with the base the editor adopted), save timeline.tsx as an agent does, and print what
// happened as one JSON line. patches.test.js runs it in its own process (the harness takes over process.parentPort).
const fs = require("fs"), path = require("path");
const [workerFile, root] = process.argv.slice(2);
(async () => {
  const { call, events } = await require("./worker-harness.js").start(workerFile, root);
  const out = {};
  const [p] = await call("projects.list");
  const doc = await call("projects.read", p.id);
  const items = doc.timelineItems.map((it) => (it.type === "text" ? { ...it, fontSize: 150 } : it));
  const saved = await call("projects.updateScoped", { ...doc, timelineItems: items, stateUpdatedAt: Date.now() }, { ownedFields: ["tracks", "timelineItems"], carton: { base: doc.stateUpdatedAt, actor: "person" } });
  out.guiSave = saved.timelineItems.find((i) => i.type === "text").fontSize;
  if (process.env.CARDBOARD_CARTON === "1") out.ping = await call("carton.ping");
  const tsx = path.join((await call("projects.bundleInfo", p.id)).bundlePath, "timeline.tsx");
  fs.writeFileSync(tsx, fs.readFileSync(tsx, "utf8").replace(/fontSize=\{\d+\}/, "fontSize={160}"));
  for (let i = 0; i < 200 && !events.some((e) => e.change?.kind?.startsWith("timeline")); i++) await new Promise((r) => setTimeout(r, 25));
  out.watcher = events.filter((e) => e.kind === "change").map((e) => e.change.kind);
  out.after = (await call("projects.read", p.id)).timelineItems.find((i) => i.type === "text").fontSize;
  console.log(JSON.stringify(out));
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
