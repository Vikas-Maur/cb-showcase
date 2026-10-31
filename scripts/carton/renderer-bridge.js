// Carton in the editor's pages (H4–H7), injected at the top of the editor store's bundle (installErrorTelemetry-*.js),
// which the main bundle and the editor bundle both import. patch-carton.js places the hooks; carton/docs/
// INTEGRATION-1.4.0.md §4.3 says why each one is where it is.
// - H4: a timeline save carries the version the editor shows (cartonBase), its actor and the recorded remaps, so the
//   worker commits only the person's edits. A preview of an earlier version is read-only.
// - H5: a change from elsewhere is adopted without an undo entry and without dropping a pending save: the armed save
//   goes first, with its base, then the editor takes head and its base in one store step. No change from elsewhere
//   is ever saved again under the person's name (gate G1).
// - H6: ⌘Z and ⇧⌘Z undo and redo the person's actor group in Carton, never another writer's change.
// - H7: ripple, gap and silence deletes and ripple trims record what they moved.
// Main says whether Carton is on (carton:call "enabled"). Until it has, and whenever it's off, every hook does what
// Cardboard does.
module.exports = String.raw`window.__carton = (() => {
  let on = false, store = null, sent = null, intents = [], stale = false, bypass = false;
  let settle;
  const ready = new Promise((r) => (settle = r));
  const TIMELINE = new Set(["tracks", "timelineItems", "aspectRatio"]);
  const PREVIEW = "Previewing an earlier version. Return to current to edit.";
  const call = (method, ...args) => store.invoke("carton:call", { method, args });
  const timelineOf = (p) => ({ tracks: p.tracks ?? [], timelineItems: p.timelineItems ?? [], aspectRatio: p.aspectRatio });
  const duration = (items) => items.reduce((d, i) => Math.max(d, i.endTime), 0);
  return {
    get on() { return on; },
    ready,
    previewMessage: PREVIEW,
    // H4: the editor store's handles, given once it exists.
    store(s) {
      store = s;
      call("enabled").then((r) => { on = r === true; settle(on); }, () => settle(false));
    },
    saveMeta(doc, scope) {
      if (!on || !store) return undefined;
      const st = store.state();
      if (!(scope?.ownedFields ?? []).some((f) => TIMELINE.has(f)) || st.projectId !== doc.id) return { actor: "person" };
      sent = { id: doc.id, rev: doc.stateUpdatedAt };
      const meta = { actor: "person", base: st.cartonBase ?? undefined, intents: intents.length ? intents : undefined };
      intents = [];
      return meta;
    },
    // H7
    intent(i) { if (on) intents.push(i); },
    // H5: a project:changed that main marked as Carton's. Returns sV's result, or null for Cardboard's own path.
    async receive(host, ev) {
      if (!store || ev.removed) return null;
      const st = store.state();
      if (st.projectId !== ev.id) return null;
      // A preview stays as it is; "Return to current" takes head.
      if (st.cartonPreview) { stale = true; return { adopted: false, timeline: undefined }; }
      // The echo of our own save: the editor already shows it, only its base moves.
      if (sent && sent.id === ev.id && sent.rev === ev.stateUpdatedAt) {
        store.raw({ cartonBase: ev.stateUpdatedAt });
        return { adopted: false, timeline: undefined };
      }
      if (st.cartonBase != null && ev.stateUpdatedAt != null && ev.stateUpdatedAt <= st.cartonBase) return { adopted: false, timeline: undefined };
      // An armed save goes first. If the person edits while it or the read is in flight, that edit's save goes too and
      // head is read again: the adopt below runs only with nothing unsaved, with no await between the check and it.
      // A save counts as unsaved until its write is done, not only while its timer is armed.
      const pending = () => store.armed() || store.inflight?.();
      let doc = null;
      for (let i = 0; i < 20; i++) {
        while (pending()) await store.flush();
        doc = await host.fetch(ev.id);
        if (!pending()) break;
      }
      if (!doc || pending()) return { adopted: false, timeline: undefined };
      const project = host.deserialize(doc), list = host.projects.list();
      host.projects.replace(list.map((p) => (p.id === ev.id ? project : p)));
      const t = timelineOf(project);
      host.editor.adopt({ ...t, duration: duration(t.timelineItems), cartonBase: project.stateUpdatedAt ?? null });
      return { adopted: false, timeline: undefined };
    },
    // H6: true when Carton took the undo (Cardboard's snapshot undo then doesn't run). If Carton has no history for
    // the project, Cardboard's own undo runs after all.
    undo() { return this.step("undo"); },
    redo() { return this.step("redo"); },
    step(which) {
      if (!on || !store || bypass) return false;
      const st = store.state();
      if (!st.projectId || st.cartonPreview) return false;
      const own = () => { bypass = true; try { store.state()[which](); } finally { bypass = false; } };
      store.flush().then(() => call(which, { projectId: st.projectId })).then((r) => { if (r?.status === "unavailable") own(); }, (e) => { console.warn("[carton] " + which + " failed:", e?.message ?? e); own(); });
      return true;
    },
    // Compare and the A/B toggle: an earlier version in the editor, read-only (§9). null returns to current.
    async preview(projectId, ref) {
      if (!on || !store) return;
      if (ref != null) await store.flush();
      const doc = await call(ref == null ? "head" : "checkout", { projectId, ref });
      const project = store.deserialize(doc), t = timelineOf(project);
      if (ref == null) {
        // Back to current: the project record and the editor take head, with its base.
        store.projects.setState({ projects: store.projects.getState().projects.map((p) => (p.id === projectId ? project : p)) });
        store.adopt({ ...t, duration: duration(t.timelineItems), cartonBase: project.stateUpdatedAt ?? null, cartonPreview: null });
        stale = false;
      } else store.adopt({ ...t, duration: duration(t.timelineItems), cartonPreview: { ref } });
    },
    get stale() { return stale; },
    // For the History panel (carton-ui.js): the worker's carton namespace, and its events for the tabs.
    call: (method, args) => call(method, ...(args ?? [])),
    onEvent: (f) => store.on("carton:event", f),
  };
})();
`;
