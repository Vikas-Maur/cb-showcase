// Carton in the editor's pages (H4–H7), injected at the top of the editor store's bundle (installErrorTelemetry-*.js),
// which the main bundle and the editor bundle both import. patch-carton.js places the hooks; carton/docs/
// INTEGRATION-1.4.0.md §4.3 says why each one is where it is.
// - H4: a timeline save carries the version the editor shows (cartonBase), its actor and the recorded remaps, so the
//   worker commits only the person's edits. A preview of an earlier version is read-only.
// - H5: a change from elsewhere is adopted without an undo entry and without dropping a pending save: the armed save
//   goes first, with its base, then the editor takes head and its base in one store step. No change from elsewhere
//   is ever saved again under the person's name (gate G1).
// - H6: Ctrl+Z and redo act as Cardboard's own: the person's own edits and the agent turns they started in the app, in
//   this editor session only (since the project opened here), never a terminal's cb. The worker's answer carries the
//   project it wrote, adopted at once; the undo and redo buttons follow what Carton has left to undo and redo.
// - H7: ripple, gap and silence deletes and ripple trims record what they moved.
// Main says whether Carton is on (carton:call "enabled"). Until it has, and whenever it's off, every hook does what
// Cardboard does. A method the page answers itself (the live-sync half, scripts/carton/sync) is added with
// handle(name, fn): call(name, args) then runs fn(...args) here instead of going to main.
module.exports = String.raw`window.__carton = (() => {
  let on = false, store = null, sent = null, intents = [], stale = false, bypass = false;
  // H6: an undo or redo under way (its project), the change event that came meanwhile (replayed after it), the
  // availability refresh's timer
  let stepping = null, deferred = null, canTimer = null;
  // The editor's own last timeline save not yet answered: the document holds it, whatever the base says (ui-words #3).
  let unanswered = null;
  // A preview shorter than the playhead moved it to its end: where it was, and where the preview put it (preview()).
  let held = null;
  let settle;
  const ready = new Promise((r) => (settle = r));
  const handlers = new Map();
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
      // The base moves only when this editor's last save comes back (its echo) or it adopts head. A save made before
      // then holds the earlier save too: it says so ("after"), so the worker makes it on that save, never on the
      // version before both, where it clashed with the earlier save at head (a card of the person against themself).
      const after = unanswered && unanswered.id === doc.id && (st.cartonBase == null || unanswered.rev > st.cartonBase) ? unanswered.rev : undefined;
      sent = unanswered = { id: doc.id, rev: doc.stateUpdatedAt };
      // the person's own edit: there is something to undo now, and nothing to redo (as the editor's own stacks); the
      // save's echo asks the worker again
      store.raw({ cartonCanUndo: true, cartonCanRedo: false });
      const meta = { actor: "person", base: st.cartonBase ?? undefined, ...(after !== undefined ? { after } : {}), intents: intents.length ? intents : undefined };
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
      // An undo or redo under way answers with the project it wrote: this event waits for it (replayed after it if
      // the answer didn't hold it), rather than fetching the same project again.
      if (stepping === ev.id) { if (!deferred || (ev.stateUpdatedAt ?? 0) >= (deferred.ev.stateUpdatedAt ?? 0)) deferred = { host, ev }; return { adopted: false, timeline: undefined }; }
      // A preview stays as it is; "Return to current" takes head.
      if (st.cartonPreview) { stale = true; return { adopted: false, timeline: undefined }; }
      // The echo of our own save: the editor already shows it, only its base moves.
      if (sent && sent.id === ev.id && sent.rev === ev.stateUpdatedAt) {
        store.raw({ cartonBase: ev.stateUpdatedAt });
        this.refreshCan();
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
      unanswered = null; // the editor shows head now, with its base
      this.refreshCan(); // an agent turn the person started here is theirs to undo; another writer's change isn't
      return { adopted: false, timeline: undefined };
    },
    // H6: what Carton has left to undo and redo, for the buttons (patch-carton: EditorRoute's selectors).
    setCan(can) { if (store && can) store.raw({ cartonCanUndo: !!can.undo, cartonCanRedo: !!can.redo }); },
    refreshCan() {
      if (!on || !store) return;
      clearTimeout(canTimer);
      canTimer = setTimeout(() => {
        const st = store.state();
        if (!st.projectId) return;
        call("undoState", { projectId: st.projectId, ...(st.cartonSince != null ? { since: st.cartonSince } : {}) }).then((c) => { if (c && store.state().projectId === st.projectId) this.setCan(c); }, () => {});
      }, 150);
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
      const id = st.projectId;
      store.flush().then(() => {
        stepping = id;
        const since = store.state().cartonSince;
        return call(which, { projectId: id, ...(since != null ? { since } : {}) });
      }).then((r) => {
        if (r?.status === "unavailable") return own();
        if (r?.can) this.setCan(r.can);
        // the project the step wrote, adopted now, unless the person edited meanwhile (their save goes first: the
        // change event's path below then reads head again)
        const now = store.state();
        if (r?.project && now.projectId === id && !now.cartonPreview && !store.armed() && !store.inflight?.()) {
          const project = store.deserialize(r.project), t = timelineOf(project);
          store.projects.setState({ projects: store.projects.getState().projects.map((p) => (p.id === id ? project : p)) });
          store.adopt({ ...t, duration: duration(t.timelineItems), cartonBase: project.stateUpdatedAt ?? null });
          unanswered = null;
          if (deferred && (deferred.ev.stateUpdatedAt ?? 0) <= (project.stateUpdatedAt ?? 0)) deferred = null;
        }
        // a conflict: the cards are in the conflict stack, each saying why (the worker kept them for the person)
        if (r?.status === "conflicts") console.info("[carton] " + which + " didn't change anything: " + (r.conflicts?.length ?? 0) + " card(s) in the conflict stack");
      }, (e) => { console.warn("[carton] " + which + " failed:", e?.message ?? e); own(); }).finally(() => {
        if (stepping === id) stepping = null;
        const d = deferred;
        deferred = null;
        if (d) this.receive(d.host, d.ev).catch(() => {});
      });
      return true;
    },
    // Compare and the A/B toggle: an earlier version in the editor, read-only (§9). null returns to current.
    // A version shorter than the playhead takes it to its end, where Cardboard's own "jump to end" puts it (final
    // re-check N5: a black stage, "0:09 / 0:08"); back to current, it goes back where the editor had it before the
    // preview, unless the person moved it meanwhile (held: that place, and where the preview put it).
    async preview(projectId, ref) {
      if (!on || !store) return;
      if (ref != null) await store.flush();
      const doc = await call(ref == null ? "head" : "checkout", { projectId, ref });
      const project = store.deserialize(doc), t = timelineOf(project), end = duration(t.timelineItems);
      const seek = (s) => store.state().setPlaybackPosition?.(s);
      if (ref == null) {
        // Back to current: the project record and the editor take head, with its base.
        store.projects.setState({ projects: store.projects.getState().projects.map((p) => (p.id === projectId ? project : p)) });
        store.adopt({ ...t, duration: end, cartonBase: project.stateUpdatedAt ?? null, cartonPreview: null });
        stale = false;
        unanswered = null;
        const h = held;
        held = null;
        if (h && store.state().currentTime === h.end) seek(Math.min(h.at, end));
      } else {
        store.adopt({ ...t, duration: end, cartonPreview: { ref } });
        const now = store.state().currentTime;
        // the person moved it since the last preview put it: their place now is the one to go back to
        if (held && now !== held.end) held = null;
        if (Number.isFinite(now) && now > end) {
          held = { at: held?.at ?? now, end };
          seek(end);
        }
      }
    },
    get stale() { return stale; },
    // An edit that isn't a write, asked for in a preview (the stage's text editor: Enter on a selected title, a
    // double-click on one; patch-carton.js asks before opening it): refused as Cardboard refuses its own edits there,
    // with its "Previewing an earlier version. Return to current to edit." over the timeline (store.refuse is its guard,
    // me()). Baseline P3-9, final re-check N3: the editor opened inside the read-only preview and dropped what was typed.
    // True when refused; never with Carton off or outside a preview.
    refuse() {
      if (!on || !store?.refuse || !store.state().cartonPreview) return false;
      store.refuse();
      return true;
    },
    // Join's "Open": the joined project in a tab of its own, as the Dashboard opens one (main's tabs:open).
    openProject(projectId) {
      if (!on || !store || !projectId) return Promise.reject(new Error("Sharing isn't available for this project right now"));
      return Promise.resolve(store.invoke("tabs:open", { projectId, focus: true, source: "home" }));
    },
    // The project the editor shows (the stage's Carton layer follows it).
    get projectId() { return store?.state().projectId ?? null; },
    // Comments: a new comment is pinned at the playhead; a timecode clicked moves the playhead there.
    playhead() { return on && store ? store.state().currentTime ?? 0 : 0; },
    seek(t) { if (on && store && Number.isFinite(t)) store.state().setPlaybackPosition?.(t); },
    // The editor's clip selection, as its store holds it (a new array when it changes): Esc clears it in the editor
    // without saying so, and the preview banner's Esc leaves that Esc to it (regress 2026-11-02 #4).
    selection: () => (on && store ? store.state().selectedTimelineItemIds ?? null : null),
    // "Show on timeline" (a conflict card's See it): the clip selected and the playhead at its start. False when the
    // editor doesn't show it (another project, or the clip isn't in this version).
    reveal(itemId) {
      if (!on || !store || !itemId) return false;
      const st = store.state(), it = (st.timelineItems ?? []).find((i) => i.id === itemId);
      if (!it) return false;
      st.selectTimelineItem?.(itemId);
      st.setPlaybackPosition?.(it.startTime);
      return true;
    },
    // For the History panel (carton-ui.js): the worker's carton namespace, and its events for the tabs.
    call: (method, args) => (on && handlers.has(method) ? Promise.resolve().then(() => handlers.get(method)(...(args ?? []))) : call(method, ...(args ?? []))),
    handle(name, fn) {
      if (!/^[a-zA-Z]+$/.test(name) || name === "enabled") throw new Error("A Carton method name is letters only, and not enabled: " + name);
      handlers.set(name, fn);
    },
    onEvent: (f) => store.on("carton:event", f),
    // The title bar's History and Share icons (the tab strip, another page): main routes them to this page as
    // carton:command, and the page says which panel is open, which main hands to the strip for the icons' pressed look.
    onCommand: (f) => store.on("carton:command", f),
    // live: a shared project's summary for the strip (sync state, who is here), or nothing.
    reportPanel(panel, live) {
      if (on && store) Promise.resolve(store.invoke("carton:panel", live ? { panel: panel ?? null, live } : { panel: panel ?? null })).catch(() => {});
    },
  };
})();
`;
