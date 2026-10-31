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
  // As the editor saves: through its lossy serializer (times to 0.1 s, unknown fields such as autoReframe dropped)
  // when LOSSY is set, else the items as read.
  const lossy = process.env.LOSSY === "1";
  const asEditor = (it) => { if (!lossy) return it; const { autoReframe, ...rest } = it; for (const k of ["startTime", "endTime", "trimStart", "trimEnd"]) if (typeof rest[k] === "number") rest[k] = Math.round(rest[k] * 10) / 10; return rest; };
  const items = doc.timelineItems.map((it) => asEditor(it.type === "text" ? { ...it, fontSize: 150 } : it));
  const saved = await call("projects.updateScoped", { ...doc, timelineItems: items, stateUpdatedAt: Date.now() }, { ownedFields: ["tracks", "timelineItems"], carton: { base: doc.stateUpdatedAt, actor: "person" } });
  out.guiSave = saved.timelineItems.find((i) => i.type === "text").fontSize;
  if (process.env.CARDBOARD_CARTON === "1") out.ping = await call("carton.ping");
  const tsx = path.join((await call("projects.bundleInfo", p.id)).bundlePath, "timeline.tsx");
  fs.writeFileSync(tsx, fs.readFileSync(tsx, "utf8").replace(/fontSize=\{\d+\}/, "fontSize={160}"));
  for (let i = 0; i < 200 && !events.some((e) => e.change?.kind?.startsWith("timeline")); i++) await new Promise((r) => setTimeout(r, 25));
  out.watcher = events.filter((e) => e.kind === "change").map((e) => e.change.kind);
  const final = await call("projects.read", p.id);
  out.after = final.timelineItems.find((i) => i.type === "text").fontSize;
  if (lossy) out.video = final.timelineItems.find((i) => i.type === "video");
  const bundlePath = (await call("projects.bundleInfo", p.id)).bundlePath;
  const text = (d) => d.timelineItems.find((i) => i.type === "text");
  if (process.env.STALE === "1") {
    // A GUI save made on the version read at the start: its size clashes with the agent's 160 since. Head keeps 160,
    // and the person's 170 is a card kept for the person.
    const stale = doc.timelineItems.map((it) => (it.type === "text" ? { ...it, fontSize: 170 } : it));
    await call("projects.updateScoped", { ...doc, timelineItems: stale, stateUpdatedAt: Date.now() }, { ownedFields: ["tracks", "timelineItems"], carton: { base: doc.stateUpdatedAt, actor: "person" } });
    out.stale = text(await call("projects.read", p.id)).fontSize;
    out.cards = (await call("carton.notices", { bundlePath, actor: "person" })).flatMap((n) => n.cards ?? []).length;
  }
  if (process.env.UNDO === "1") {
    // ⌘Z: the person's last change is undone at head, written into project.json, and announced to the pages.
    const before = events.length;
    out.undo = (await call("carton.undo", { projectId: p.id })).status;
    out.undone = text(await call("projects.read", p.id)).fontSize;
    out.announced = events.slice(before).some((e) => e.change?.kind === "changed");
  }
  console.log(JSON.stringify(out));
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
