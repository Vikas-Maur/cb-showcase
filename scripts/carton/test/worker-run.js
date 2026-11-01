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
  const text = (d) => d.timelineItems.find((i) => i.type === "text");
  if (process.env.UNDO === "1") {
    // ⌘Z right after the person's save: undone at head, written into project.json, and announced to the pages; then
    // redone by saving again, so the rest runs as without it.
    const before = events.length;
    out.undo = (await call("carton.undo", { projectId: p.id })).status;
    out.undone = text(await call("projects.read", p.id)).fontSize;
    out.announced = events.slice(before).some((e) => e.change?.kind === "changed");
    const again = await call("projects.read", p.id);
    await call("projects.updateScoped", { ...again, timelineItems: again.timelineItems.map((it) => (it.type === "text" ? { ...it, fontSize: 150 } : it)), stateUpdatedAt: Date.now() }, { ownedFields: ["tracks", "timelineItems"], carton: { base: again.stateUpdatedAt, actor: "person" } });
  }

  const tsx = path.join((await call("projects.bundleInfo", p.id)).bundlePath, "timeline.tsx");
  fs.writeFileSync(tsx, fs.readFileSync(tsx, "utf8").replace(/fontSize=\{\d+\}/, "fontSize={160}"));
  for (let i = 0; i < 200 && !events.some((e) => e.change?.kind?.startsWith("timeline")); i++) await new Promise((r) => setTimeout(r, 25));
  out.watcher = events.filter((e) => e.kind === "change").map((e) => e.change.kind);
  const final = await call("projects.read", p.id);
  out.after = final.timelineItems.find((i) => i.type === "text").fontSize;
  if (lossy) out.video = final.timelineItems.find((i) => i.type === "video");
  const bundlePath = (await call("projects.bundleInfo", p.id)).bundlePath;
  // The History panel's view model, served to a page: does a GUI save's card reach it?
  const panel = (client) => call("carton.ui", { projectId: p.id, client, message: { t: "hello" } });
  const panelCards = (client) => events.filter((e) => e.change?.kind === "carton" && e.change.client === client).flatMap((e) => {
    const m = e.change.message;
    return m.t === "init" ? m.topics.conflicts ?? [] : m.t === "topic" && m.topic === "conflicts" ? m.value ?? [] : [];
  }).length;
  if (process.env.PANEL === "1") await panel("before");
  if (process.env.STALE === "1") {
    // A GUI save made on the version read at the start: its size clashes with the agent's 160 since. Head keeps 160,
    // and the person's 170 is a card kept for the person.
    const stale = doc.timelineItems.map((it) => (it.type === "text" ? { ...it, fontSize: 170 } : it));
    await call("projects.updateScoped", { ...doc, timelineItems: stale, stateUpdatedAt: Date.now() }, { ownedFields: ["tracks", "timelineItems"], carton: { base: doc.stateUpdatedAt, actor: "person" } });
    out.stale = text(await call("projects.read", p.id)).fontSize;
    out.cards = (await call("carton.notices", { bundlePath, actor: "person" })).flatMap((n) => n.cards ?? []).length;
    if (process.env.PANEL === "1") {
      await new Promise((r) => setTimeout(r, 300));
      await panel("after");
      await panel("other");
      await new Promise((r) => setTimeout(r, 300));
      out.panel = { live: panelCards("before"), reopened: panelCards("after") };
      // The panel's latest conflicts for a client, as it would show them.
      const shown = (client) => {
        let list = [];
        for (const e of events) if (e.change?.kind === "carton" && e.change.client === client) {
          const m = e.change.message;
          if (m.t === "init") list = m.topics.conflicts ?? [];
          if (m.t === "topic" && m.topic === "conflicts") list = m.value ?? [];
        }
        return list;
      };
      const first = shown("after")[0];
      out.sides = first && { mine: first.mine.summary, theirs: first.theirs.summary };
      // A second stale save on the same size (180): two kept cards for one field, both shown. Resolving the first (keep
      // the change that was kept) removes only it; the other stays.
      const stale2 = doc.timelineItems.map((it) => (it.type === "text" ? { ...it, fontSize: 180 } : it));
      await call("projects.updateScoped", { ...doc, timelineItems: stale2, stateUpdatedAt: Date.now() }, { ownedFields: ["tracks", "timelineItems"], carton: { base: doc.stateUpdatedAt, actor: "person" } });
      const kept = async () => (await call("carton.notices", { bundlePath, actor: "person" })).flatMap((n) => n.cards ?? []);
      out.keptBefore = (await kept()).length;
      await call("carton.ui", { projectId: p.id, client: "after", message: { t: "call", id: 99, method: "resolve", args: [first.id, "theirs"] } });
      for (let i = 0; i < 100 && !events.some((e) => e.change?.client === "after" && e.change.message?.t === "ret" && e.change.message.id === 99); i++) await new Promise((r) => setTimeout(r, 25));
      await new Promise((r) => setTimeout(r, 200));
      out.keptAfter = (await kept()).map((c) => c.theirs);
      out.shownNext = shown("after").map((c) => c.mine.summary);
      // A third clash on the field (175) after the first panel resolved. The other panel still shows the first card;
      // when it resolves it there (already gone), nothing else goes.
      const stale3 = doc.timelineItems.map((it) => (it.type === "text" ? { ...it, fontSize: 175 } : it));
      await call("projects.updateScoped", { ...doc, timelineItems: stale3, stateUpdatedAt: Date.now() }, { ownedFields: ["tracks", "timelineItems"], carton: { base: doc.stateUpdatedAt, actor: "person" } });
      await new Promise((r) => setTimeout(r, 200));
      const otherFirst = shown("other").find((c) => c.mine.summary === "170");
      await call("carton.ui", { projectId: p.id, client: "other", message: { t: "call", id: 98, method: "resolve", args: [otherFirst?.id, "theirs"] } });
      for (let i = 0; i < 100 && !events.some((e) => e.change?.client === "other" && e.change.message?.t === "ret" && e.change.message.id === 98); i++) await new Promise((r) => setTimeout(r, 25));
      await new Promise((r) => setTimeout(r, 200));
      out.keptAfterOther = (await kept()).map((c) => c.theirs);
      // An agent's clash is the agent's: kept for it, never shown in the person's panel as theirs or as "mine".
      const agentSave = doc.timelineItems.map((it) => (it.type === "text" ? { ...it, fontSize: 190 } : it));
      await call("projects.updateScoped", { ...doc, timelineItems: agentSave, stateUpdatedAt: Date.now() }, { ownedFields: ["tracks", "timelineItems"], carton: { base: doc.stateUpdatedAt, actor: "codex/c7" } });
      await new Promise((r) => setTimeout(r, 300));
      out.agentCards = (await call("carton.notices", { bundlePath, actor: "codex/c7" })).flatMap((n) => n.cards ?? []).length;
      out.panelHasAgent = [...shown("after"), ...shown("other")].some((c) => c.mine.summary === "190" || c.theirs.summary === "190");
      // A card kept by another process (straight into carton.db) shows when a panel opens, and resolving it removes it.
      const facade = require(require("path").join(process.env.CARTON_DIR, "carton-node.cjs"));
      const vid = doc.timelineItems.find((i) => i.type === "video").id, cardPath = "timelineItems/" + vid + "/opacity";
      await facade.internals.writeNotice(bundlePath, "person", [{ kind: "field", path: cardPath, base: 1, ours: 1, theirs: 0.5 }]);
      await panel("legacy");
      await new Promise((r) => setTimeout(r, 300));
      const legacyId = shown("legacy").find((c) => c.path === cardPath)?.id;
      out.legacyShown = !!legacyId;
      await call("carton.ui", { projectId: p.id, client: "legacy", message: { t: "call", id: 97, method: "resolve", args: [legacyId, "theirs"] } });
      for (let i = 0; i < 100 && !events.some((e) => e.change?.client === "legacy" && e.change.message?.t === "ret" && e.change.message.id === 97); i++) await new Promise((r) => setTimeout(r, 25));
      await new Promise((r) => setTimeout(r, 200));
      out.legacyGone = !(await call("carton.notices", { bundlePath, actor: "person" })).some((n) => (n.cards ?? []).some((c) => c.path === cardPath));
    }
  }
  console.log(JSON.stringify(out));
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
