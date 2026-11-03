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
// - H4, one editor action one save (laptop, merge/prod-2 N-1). One undo step of the editor (pushTimelineHistory) can
//   save twice: its timeline (debounced, 300 ms) and the media entry a title or code graphic owns ("Text: W6"), which
//   the editor saves on its own (a delete drops it once its cached files are gone, Kx; adding a title adds it,
//   EditorRoute's iu). Carton made a version of each, in either order, and one Ctrl+Z took back only one of them: the
//   title stayed gone, or came back without its entry. Stock's own undo takes back both (its Xx puts the entry back).
//   Now the editor notes such an entry when its action makes it (ride), the action's timeline save carries it in its
//   scope (board, at the save's two call sites: the debounce and its flush), and the entry's own save then goes with
//   that save (send): one save, one version, one undo step. If the entry's save comes first, it sends the waiting
//   timeline save now (it carries the entry) rather than ahead of it. No timer: the boundary is the editor's own save.
//   A library file's media (an import, a sound) stays a save of its own, as stock's undo never takes it back.
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
  // A preview shorter than the playhead moved it to its end: where it was, where the preview put it, and the store
  // subscription that drops it at the person's first move (preview()). "seeking": the bridge's own seek under way.
  let held = null, seeking = false;
  const release = () => { if (typeof held?.off === "function") held.off(); held = null; };
  // The playhead: Cardboard's playheadTime while paused (its currentTime follows the pointer's hover then), its
  // playback clock while playing.
  const playhead = () => {
    const st = store.state();
    return st.isPlaying ? (store.clock?.() ?? st.currentTime) : (st.playheadTime ?? st.currentTime);
  };
  const seekOwn = (s) => {
    seeking = true;
    try { store.state().setPlaybackPosition?.(s); } finally { seeking = false; }
  };
  let settle;
  const ready = new Promise((r) => (settle = r));
  const handlers = new Map();
  const TIMELINE = new Set(["tracks", "timelineItems", "aspectRatio"]);
  // Cardboard's refusal of an edit while viewing, in Carton's words (UX redesign 0.3; PLAN 1.4 makes it the toast)
  const PREVIEW = "You're looking at an earlier version. Go back to your edit (Esc) to change it.";
  const call = (method, ...args) => store.invoke("carton:call", { method, args });
  // (laptop, final candidate P2-1: a project with no aspect ratio, which an undo right after a recovery made, crashed
  // the tab: the layouts panel splits it. Cardboard's own load gives such a project its default, 16:9; so does this)
  const timelineOf = (p) => ({ tracks: p.tracks ?? [], timelineItems: p.timelineItems ?? [], aspectRatio: typeof p.aspectRatio === "string" && p.aspectRatio ? p.aspectRatio : "16:9" });
  // What the person is told over the stage (scripts/carton/ui.js shows each as a toast); the console has it too.
  const noticeSubs = new Set();
  const notice = (text) => {
    console.info("[carton] " + text);
    for (const f of noticeSubs) try { f(text); } catch {}
  };
  // Laptop, final candidate P1-1: every save of a project failed in the page ("Invalid time value", before anything
  // reached the worker) and nobody was told. Cardboard logs a failed save and goes on; now the person is told too, at
  // most every 20 s, and again after a save that landed.
  const SAVE_FAILED = "Your last change couldn't be saved. It's on screen, but it isn't in the project yet.";
  let saveFailedAt = 0;
  const duration = (items) => items.reduce((d, i) => Math.max(d, i.endTime), 0);
  // H4 (one action, one save): the media entries the editor's actions made, for the editor's project, by entry
  // ("removedMediaIds:<id>" or "ownedMediaIds:<id>"), one per time an action made it, oldest first: { carrier }, null
  // while it waits for its action's timeline save, "boarding" while that save is being sent with it, then that save's
  // promise. An entry's own save takes the oldest out (review #1: the same title deleted again after an undo, while
  // the first delete's save still waited, is a second one, never the first's). Only carried ones are ever dropped,
  // oldest first, past RIDERS (one whose own save never came: its write failed before it), and never one the save
  // just sent carries, nor a waiting one (review #3: a Delete of 65 titles is one action, its entries' saves late).
  const riders = new Map();
  let ridersOf = null, carriedCount = 0;
  const RIDERS = 1024, MEDIA = ["ownedMediaIds", "removedMediaIds"];
  const isCarried = (r) => typeof r?.carrier?.then === "function";
  const take = (key, r) => {
    const q = riders.get(key), i = q ? q.indexOf(r) : -1;
    if (i < 0) return;
    q.splice(i, 1);
    if (!q.length) riders.delete(key);
    if (isCarried(r)) carriedCount--;
  };
  const carry = (r, p) => { if (!isCarried(r)) carriedCount++; r.carrier = p; };
  const trim = (now) => {
    for (const [key, q] of [...riders]) {
      if (carriedCount <= RIDERS) return;
      for (const r of [...q]) if (carriedCount > RIDERS && isCarried(r) && r.carrier !== now) take(key, r);
    }
  };
  const timelineSave = (scope) => (scope?.ownedFields ?? []).some((f) => TIMELINE.has(f));
  // the media entries a save is made of, as rider keys; null when it holds anything else (a field, media details)
  const entriesOf = (scope) => {
    if (!scope || scope.ownedFields?.length || (scope.ownedMediaDataFields && Object.keys(scope.ownedMediaDataFields).length)) return null;
    const keys = MEDIA.flatMap((k) => [...(scope[k] ?? [])].map((id) => k + ":" + id));
    return keys.length ? keys : null;
  };
  // Carton's events reach this page over one IPC listener per channel, however many of its views subscribe
  // (laptop, merge/prod-2: Electron's MaxListenersExceededWarning, 11 main:event listeners, each subscription one)
  const fanOut = new Map();
  const subscribe = (channel, f) => {
    let c = fanOut.get(channel);
    if (!c) {
      c = { subs: new Set(), off: null };
      fanOut.set(channel, c);
      c.off = store.on(channel, (ev) => { for (const g of [...c.subs]) try { g.f(ev); } catch (e) { console.warn("[carton] a " + channel + " handler failed:", e?.message ?? e); } });
    }
    // one entry per subscription (review #5: the same handler subscribed twice is two, each with its own unsubscribe)
    const entry = { f };
    c.subs.add(entry);
    return () => {
      if (!c.subs.delete(entry) || c.subs.size) return;
      fanOut.delete(channel);
      if (typeof c.off === "function") c.off();
    };
  };
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
    // H4 (one action, one save): an editor action made a media entry its item owns (part: {removedMediaIds: [id]} or {ownedMediaIds: [id]}),
    // whose own save follows. Noted only while that action's timeline save waits (armed) in the editor's project;
    // otherwise the entry's save goes alone, as before.
    ride(projectId, part) {
      if (!on || !store || bypass) return;
      const st = store.state();
      if (st.cartonPreview || st.projectId !== projectId || !store.armed()) return;
      if (ridersOf !== projectId) riders.clear(), (ridersOf = projectId), (carriedCount = 0);
      for (const k of MEDIA) for (const id of part?.[k] ?? []) {
        const key = k + ":" + id;
        riders.set(key, [...(riders.get(key) ?? []), { carrier: null }]);
      }
    },
    // H4 (one action, one save): the scope of the editor's timeline save (the debounce's and its flush's), with the entries waiting for it.
    board(projectId, scope) {
      if (!on || ridersOf !== projectId || !riders.size) return scope;
      const add = { ownedMediaIds: [], removedMediaIds: [] };
      for (const [key, q] of riders) for (const r of q) {
        // (still "boarding": the save it boarded never reached send, its document failed to serialize)
        if (isCarried(r)) continue;
        const i = key.indexOf(":");
        add[key.slice(0, i)].push(key.slice(i + 1));
        r.carrier = "boarding";
      }
      if (!add.ownedMediaIds.length && !add.removedMediaIds.length) return scope;
      const out = { ...scope };
      for (const k of MEDIA) if (add[k].length) out[k] = [...new Set([...(scope[k] ?? []), ...add[k]])];
      return out;
    },
    // H4 (one action, one save): every scoped save of the project store (patch-carton: its updateScoped), go() sending it to main. The
    // timeline save that boarded entries is their carrier; an entry's own save then answers with it instead of being
    // sent (it holds nothing more). If it comes while its timeline save still waits, that save goes now, carrying it.
    send(doc, scope, go) {
      if (!on || !riders.size || ridersOf !== doc?.id) return go();
      if (timelineSave(scope)) {
        const p = go(), held = new Set(MEDIA.flatMap((k) => [...(scope[k] ?? [])].map((id) => k + ":" + id)));
        for (const [key, q] of riders) if (held.has(key)) for (const r of q) if (r.carrier === "boarding") carry(r, p);
        trim(p);
        return p;
      }
      const keys = entriesOf(scope);
      if (!keys || !keys.every((k) => riders.has(k))) return go();
      // the oldest of each entry: this save's own
      const mine = keys.map((k) => [k, riders.get(k)[0]]);
      if (!mine.every(([, r]) => isCarried(r)) && store.armed() && store.state().projectId === doc.id) {
        // the waiting timeline save goes first, with the entry (cN sends it before it returns)
        try { void Promise.resolve(store.flush()).catch(() => {}); } catch {}
      }
      const ok = mine.every(([, r]) => isCarried(r)), carriers = [...new Set(mine.map(([, r]) => r.carrier))];
      for (const [k, r] of mine) take(k, r);
      // not carried (its timeline save never went, or failed before it was sent): this save goes itself, as before
      if (!ok) return go();
      return carriers.length === 1 ? carriers[0] : Promise.all(carriers).then((v) => v[0]);
    },
    // A project save that failed in the page (patch-carton: the editor store's scoped save, its catch).
    saveFailed(e) {
      if (!on) return;
      console.warn("[carton] a save failed in the editor:", e?.message ?? e);
      const now = Date.now();
      if (now - saveFailedAt < 20_000) return;
      saveFailedAt = now;
      notice(SAVE_FAILED);
    },
    // ui.js: what to show over the stage
    onNotice(f) { noticeSubs.add(f); return () => noticeSubs.delete(f); },
    // H5: a project:changed that main marked as Carton's. Returns sV's result, or null for Cardboard's own path.
    async receive(host, ev) {
      if (!store || ev.removed) return null;
      const st = store.state();
      if (st.projectId !== ev.id) return null;
      // An undo or redo under way answers with the project it wrote: this event waits for it (replayed after it if
      // the answer didn't hold it), rather than fetching the same project again.
      if (stepping === ev.id) { if (!deferred || (ev.stateUpdatedAt ?? 0) >= (deferred.ev.stateUpdatedAt ?? 0)) deferred = { host, ev }; return { adopted: false, timeline: undefined }; }
      // A preview stays as it is; "Back to my edit" takes head.
      if (st.cartonPreview) { stale = true; return { adopted: false, timeline: undefined }; }
      // The echo of our own save: the editor already shows it, only its base moves.
      if (sent && sent.id === ev.id && sent.rev === ev.stateUpdatedAt) {
        saveFailedAt = 0; // it landed: a later failure is told again
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
        // refused (P2-1: it would leave the project empty): nothing changed, and Cardboard's own undo doesn't run either
        if (r?.status === "refused") return notice(r.error);
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
    // preview, unless the person moved it meanwhile (held: that place and where the preview put it, until a move).
    async preview(projectId, ref) {
      if (!on || !store) return;
      if (ref != null) await store.flush();
      const doc = await call(ref == null ? "head" : "checkout", { projectId, ref });
      const project = store.deserialize(doc), t = timelineOf(project), end = duration(t.timelineItems);
      // a place held for another project (the editor opened another one meanwhile) isn't this one's
      if (held && held.project !== projectId) release();
      if (ref == null) {
        const h = held;
        release();
        // Back to current: the project record and the editor take head, with its base.
        store.projects.setState({ projects: store.projects.getState().projects.map((p) => (p.id === projectId ? project : p)) });
        store.adopt({ ...t, duration: end, cartonBase: project.stateUpdatedAt ?? null, cartonPreview: null });
        stale = false;
        unanswered = null;
        // unmoved: told by the store's own moves when it says them, else by where the playhead is
        if (h && (h.off || playhead() === h.end)) seekOwn(Math.min(h.at, end));
      } else {
        store.adopt({ ...t, duration: end, cartonPreview: { ref } });
        const now = playhead();
        if (held && !held.off && now !== held.end) release();
        if (Number.isFinite(now) && now > end) {
          held ??= { at: now, end, off: null, project: projectId };
          held.end = end;
          seekOwn(end);
          // any other move of the playhead (a click on the ruler, WatchTheChanges, a comment's timecode, play) is
          // the person's: their place is the one to keep (review #3: even one that ends where the preview put it)
          held.off ??= store.subscribe?.((st, prev) => {
            if (!seeking && (st.playheadTime !== prev.playheadTime || (st.isPlaying && !prev.isPlaying) || st.projectId !== prev.projectId)) release();
          }) ?? null;
        }
      }
    },
    get stale() { return stale; },
    // An edit that isn't a write, asked for in a preview (the stage's text editor: Enter on a selected title, a
    // double-click on one; patch-carton.js asks before opening it): refused as Cardboard refuses its own edits there,
    // with its refusal (Cardboard's words: an earlier version is shown, go back to edit) over the timeline (store.refuse is its guard,
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
    onEvent: (f) => subscribe("carton:event", f),
    // The title bar's History and Share icons (the tab strip, another page): main routes them to this page as
    // carton:command, and the page says which panel is open, which main hands to the strip for the icons' pressed look.
    onCommand: (f) => subscribe("carton:command", f),
    // live: a shared project's summary for the strip (sync state, who is here), or nothing.
    reportPanel(panel, live) {
      if (on && store) Promise.resolve(store.invoke("carton:panel", live ? { panel: panel ?? null, live } : { panel: panel ?? null })).catch(() => {});
    },
  };
})();
`;
