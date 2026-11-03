// carton-ui.js: Carton in Cardboard's editor (scripts/carton/build.js bundles it with @carton/react), in two places
// editor-panel.js mounts:
// - CartonSide: the History or Comments panel, a full-height column beside the agent's chat sidebar, in its look
//   (width, rule, resize handle, header), and the Share dialog (scripts/carton/sync/ui.js ShareDialog: Carton UX
//   redesign PLAN 8.1, in place of the panel's Share tab). The title bar's History and Share icons and its cut chip
//   (scripts/carton/strip-buttons.js) send their commands here (patch-carton.js routes them as carton:command to this
//   page), and this page reports back what is open, the cut it is on and what it is viewing (bridge.reportPanel).
// - CartonStage: a layer over the stage (the preview's column, above the timeline, left of the chat): the conflict
//   cards' floating stack in its bottom-right corner, with "See it", and viewing's frame round the stage (Carton UX
//   redesign PLAN 1.1: no banner over the picture; the frame's label tab only when History's list isn't on screen),
//   the edit-attempt toast (PLAN 1.4), and the timeline's frame and cut label (PLAN 1.5, through editor-panel.js).
// Neither takes keys but its own (Esc closes the panel while focus is in it), so the stage, the timeline's keyboard,
// Ctrl+Z and the chat work as before.
// Carton runs in the library worker. There @carton/react's view model is served to each page (serveUi over the
// worker's carton namespace, scripts/carton/carton-node.js); here remoteUi mirrors it, one connection per project shared
// by both parts. Messages go out through the bridge's carton:call "ui" and come back as carton:event for this page's
// client id. A preview is the editor's own read-only one (the bridge's preview).
import { Component, createElement as h, memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Button, CartonProvider, Dialog, Glyph, actorColor, actorLabel, initials, CommentsPanel, ConflictStack, CutsMenu, FoldInDialog, HistoryPanel, Icon, ViewingFrame, injectCommentsSkin, keptText, remoteComments, remoteUi, useCartonUi, useCuts, versionLabel, words, TeammateCutActions, openCutsMenu, cutRef, pickUndoneText, commentWords } from "@carton/react";
import { injectCardboardSkin, injectStyles } from "@carton/react/skin/cardboard";
// Compare in the editor (Carton UX v2, N1): the comparison on the page's view model, the stage, the change list
import { attachCompare, CompareStage, CompareSide, comparingLabel, useComparing } from "./compare.js";

// Short confirmations over the stage (UI audit P2-4): Restore, Fold in and a conflict card's pick said nothing, so a
// person couldn't tell they had worked. One at a time, gone after 6 s, and kept while the pointer or the keyboard is on
// one (UX redesign PLAN 5.3). Each says what happened and offers the useful next step (DESIGN §6.7): Undo, Redo, the
// cut to switch (back) to. `actions`: its buttons, `{label, run}`; `icon`: "undo" for an undo's own toast.
// `tone` "warning": a failure or a refusal the bridge tells (a save that failed, an undo refused), with the warning
// look Carton's other failures have (the conflict stack, footage still on its way, Offline), not the ✓ of a
// confirmation (laptop, merge/prod-2 N-3), and said at once to a screen reader (role alert). `tone` "viewing": an edit
// tried while viewing (PLAN 1.4, DESIGN §4.3): the eye, "You're looking at …", Back to my edit and its key, Esc; it
// goes when viewing does.
const toasts = {
  // ms: how long one stays when nothing holds it (DESIGN §6.7: 6 s)
  value: null, seq: 0, subs: new Set(), ms: 6000,
  show(text, actions, tone, icon, o) {
    const list = (Array.isArray(actions) ? actions : actions ? [actions] : []).filter(Boolean);
    this.set({ id: ++this.seq, text, ...(list.length ? { actions: list, action: list[0] } : {}), ...(tone ? { tone } : {}), ...(icon ? { icon } : {}), ...(o?.sticky ? { sticky: true } : {}) });
  },
  set(v) { this.value = v; for (const f of this.subs) f(v); },
};
// what the bridge tells (scripts/carton/renderer-bridge.js notice: a save that failed, an undo refused)
const tellFailure = (text) => toasts.show(text, null, "warning");

/**
 * The toasts' Undo and Redo (UX redesign PLAN 5.3): the bridge's undo, Ctrl+Z's own path, for exactly the versions an
 * action made (`made`, the view model's answer). Only an action that made a version offers Undo: a conflict pick of the
 * side already in the timeline makes none, and an Undo there would take back an earlier change (Workstream 7's note).
 * The worker checks that those versions are still what that step would take back; if something landed on top since, it
 * does nothing, and the toast says so. Then the toast says what the step did, with the step back: "Restore undone."
 * [Redo], "Restore redone." [Undo]. `kind`: what the action was (restore, fold, pick, turn); `said`: its words for it.
 * `which` is the person's word (Undo, Redo), `op` the step that does it: Ctrl+Z's undo, unless the action is an undo
 * itself (Undo this turn: `made.by` "redo", the editor's own redo puts the turn back). Each step's answer says what it
 * made in turn, which the other step takes back.
 */
function stepper(bridge) {
  if (typeof bridge?.undoMade !== "function") return null;
  const other = (x) => (x === "undo" ? "redo" : "undo");
  const after = (which, op, kind, said, r) => {
    // moved part-way (an action of several versions, something landed between two of its steps): what was taken back
    // can be put back
    if (r?.status === "moved") return toasts.show(r.made ? words.stepMovedPart(which) : words.stepMoved(which), r.made ? action(other(which), other(op), kind, said, r.made) : null, "warning");
    // refused: the bridge has said why (its notice, the toast now); a clash: the conflict stack shows the cards, each
    // saying why. Either way this toast's part is done, and it closes unless the notice took its place (review of WS5 #2)
    if (r?.status === "refused" || r?.status === "conflicts") return undefined;
    if (r?.status !== "confirmed" && r?.status !== "pending") return toasts.show(words.stepFailed(which), null, "warning");
    // core's own word for what an undo of a restore or a fold was (its log's title) wins over the page's guess
    const k = /restore$/.test(r.told ?? "") ? "restore" : /fold$/.test(r.told ?? "") ? "fold" : kind;
    const text = k === "restore" ? (which === "undo" ? words.restoreUndone : words.restoreRedone)
      : k === "fold" ? (which === "undo" ? words.foldUndone : words.foldRedone)
      : ((which === "undo" ? said?.undone : said?.redone) ?? words.stepDone(which));
    toasts.show(text, r.made ? action(other(which), other(op), kind, said, r.made) : null, null, which === "undo" ? "undo" : null);
  };
  const action = (which, op, kind, said, made) => ({
    label: which === "undo" ? words.undo : words.redo,
    run: () => (op === "undo" ? bridge.undoMade(made) : bridge.redoMade(made)).then((r) => after(which, op, kind, said, r), () => toasts.show(words.stepFailed(which), null, "warning")),
  });
  return {
    undo: (kind, said, made) => (made?.changes?.length ? action("undo", made.by === "redo" ? "redo" : "undo", kind, said, made) : null),
    // Ctrl+Z or redo itself (the bridge's onStep): its step was the person's word
    after: (which, kind, r) => after(which, which, kind, null, r),
  };
}

// (imported here, beside the toasts that use it, rather than in the long import line other workstreams edit)
import { clockOfDay, firstName } from "@carton/react";

/**
 * A landmark's picture (Carton UX v2, DESIGN-V2 §2.2): what the stage shows now, as one 88 × 50 JPEG, drawn from the
 * preview's largest canvas or video into a small canvas of its own (the preview's is only read). Null when there is no
 * picture to take: no preview, a black frame (a canvas the GPU dropped reads black), a frame the page may not read
 * (footage from another origin taints it), or one over 64 KB. History asks for it once per landmark, after the stage
 * has shown that version for a moment, never while anything plays: one small draw, never on the save path.
 */
function stagePicture() {
  const host = document.querySelector("[data-carton-stage-host]");
  // never while comparing (N1): the stage then shows two versions, and its largest picture may be the other one
  if (host?.hasAttribute("data-carton-compare") || host?.querySelector(".carton-compare")) return Promise.resolve(null);
  let best = null, area = 0;
  for (const el of host?.querySelectorAll("canvas, video") ?? []) {
    const r = el.getBoundingClientRect();
    if (r.width >= 80 && r.height >= 45 && r.width * r.height > area) { best = el; area = r.width * r.height; }
  }
  const sw = best ? best.videoWidth || best.width : 0, sh = best ? best.videoHeight || best.height : 0;
  if (!best || !sw || !sh) return Promise.resolve(null);
  try {
    const W = 88, H = 50, c = document.createElement("canvas");
    c.width = W; c.height = H;
    const x = c.getContext("2d", { willReadFrequently: true });
    // the middle of the frame at 88:50 (a 9:16 edit shows its middle)
    const k = Math.min(sw / W, sh / H), cw = W * k, ch = H * k;
    x.drawImage(best, (sw - cw) / 2, (sh - ch) / 2, cw, ch, 0, 0, W, H);
    const d = x.getImageData(0, 0, W, H).data;
    let lit = 0;
    for (let i = 0; i < d.length; i += 16) if (d[i] + d[i + 1] + d[i + 2] > 36) lit++;
    if (lit < 24) return Promise.resolve(null);
    const url = c.toDataURL("image/jpeg", 0.72);
    return Promise.resolve(url.length <= 64 * 1024 ? url : null);
  } catch {
    return Promise.resolve(null);
  }
}

function confirmations(ui, bridge) {
  const steps = stepper(bridge);
  const undo = (kind, said, made) => steps?.undo(kind, said, made) ?? null;
  const actor = (key) => ui.actor?.(key);
  const all = () => ui.history?.().all?.() ?? [];
  const versionByRef = (ref) => all().find((v) => v.ref === ref);
  const versionById = (id) => all().find((v) => v.id === id);
  // each action the view model has, wrapped once with its toast (a host without one keeps going without it)
  const wrap = (name, make) => { if (typeof ui[name] === "function") ui[name] = make(ui[name].bind(ui)); };
  wrap("restore", (restore) => async (ref) => {
    const v = versionByRef(ref);
    const r = await restore(ref);
    // a version named one way everywhere (UX redesign 0.9: its name, an agent's prompt, or "your edit from 12:41 pm")
    toasts.show(words.restoredToast(v ? versionLabel(v, { actor }) : "an earlier version"), undo("restore", null, r?.made));
    return r;
  });
  // "Folded 2 changes from “30s cut” into Main cut." The count is the Fold dialog's (Workstream 6: its button's, which
  // counts as History does), passed with the fold; Undo, and the cut it went into when you're not on it.
  wrap("fold", (fold) => async (from, into, opts) => {
    const r = await fold(from, into, opts);
    if (r?.ok) {
      const cuts = ui.cuts(), a = cuts.find((c) => c.id === from), b = cuts.find((c) => c.id === into);
      const n = Number.isInteger(opts?.count) && opts.count > 0 ? opts.count : null;
      toasts.show(words.foldedInto(n, a ? cutRef(a) : "the cut", b ? cutRef(b) : "this cut"), [
        undo("fold", null, r.made),
        b && !b.current ? { label: words.switchToCut(b.label), run: () => ui.switchCut(into) } : null,
      ]);
    }
    return r;
  });
  // "Fold in the rest" from a partial fold's row: the changes it left out
  wrap("foldRest", (foldRest) => async (versionId) => {
    const v = versionById(versionId);
    const r = await foldRest(versionId);
    if (r?.ok) toasts.show(words.foldedRestToast(v?.leftOut ?? null), undo("fold", null, r.made));
    return r;
  });
  // A conflict card's pick names what was kept, as the card named it (docs/carton-ux DESIGN §6.7): "Kept Claude Code's
  // move of “Interview B”." Undo only when the pick made a version (`made`): one of the side already shown makes none.
  wrap("resolve", (resolve) => async (id, choice) => {
    const c = ui.conflicts().find((x) => x.id === id);
    const r = await resolve(id, choice);
    if (c) toasts.show(keptText(c, choice, actor), undo("pick", { undone: pickUndoneText(c, actor), redone: words.pickRedone }, r?.made));
    return r;
  });
  // Bring back one clip (Carton UX v2, DESIGN-V2 §3.2): "Brought back “B-roll pier” as it was at 10:20 am." [Undo]; one
  // not there then: "Took out “Drone shot”." Nothing when it already was as it was (`how` "same": nothing made).
  wrap("restoreClip", (restoreClip) => async (ref, itemId, o) => {
    const v = versionByRef(ref);
    const r = await restoreClip(ref, itemId, ...(o !== undefined ? [o] : []));
    if (r && r.how !== "same") {
      const name = r.clipName || "the clip";
      // where it went and what else moved, as its confirmation said (N0b's place and ripple, DESIGN-V2 §3.2)
      const taken = r.place?.placed === "new-track" ? words.onNewTrack(r.place.takenBy?.length ? r.place.takenBy.map((t) => `“${t.name}”`).join(" and ") : null) : null;
      const moved = r.ripple ? (r.ripple.direction === "later" ? words.restMovedLater(r.ripple.by) : words.restMovedEarlier(r.ripple.by)) : null;
      const text = [r.how === "removed" ? words.tookOutClipToast(name) : words.broughtBackToast(name, v ? clockOfDay(v.at) : "then"), taken, moved].filter(Boolean).join(" ");
      toasts.show(text, undo("clip", { undone: words.bringBackUndone(name), redone: words.bringBackRedone(name) }, r.made));
    }
    return r;
  });
  // Undo this turn (PLAN 5.4): "Took out Claude Code's “Tighten the intro…” (4 changes)." [Undo], which puts it back
  wrap("undoTurnOf", (undoTurnOf) => async (versionId) => {
    const v = versionById(versionId);
    const r = await undoTurnOf(versionId);
    if (r?.ok && v) {
      const label = versionLabel(v, { actor }), n = v.changes ?? v.turn?.edits ?? 0;
      const said = { undone: words.turnBack(versionLabel(v, { actor, start: true })), redone: words.tookOutAgain(label) };
      toasts.show(n ? words.tookOutToast(label, n) : words.tookOut(label), undo("turn", said, r.made));
    }
    return r;
  });
  // New cut from this version (PLAN 5.2): you're on it now, and the cut you came from is unchanged; Switch back to it
  wrap("newCut", (newCut) => async (name, fromRef) => {
    const home = ui.cuts().find((c) => c.current), v = versionByRef(fromRef);
    const cut = await newCut(name, fromRef);
    if (cut && home && !home.readOnly) {
      // made from your edit as it is now: "You're on “30s Instagram cut” now."; from an older version, which one
      const older = v && fromRef !== home.head;
      const first = older ? words.onCutMadeFrom(cut.label ?? name, versionLabel(v, { actor })) : words.onCutNow(cut.label ?? name);
      toasts.show(`${first} ${words.cutUnchanged(cutRef(home))}`, { label: words.switchBackTo(home.label), run: () => ui.switchCut(home.id) });
    } else if (cut && home) {
      // a copy of a teammate's cut (PLAN 6.2's New cut from it): yours now; theirs was only viewed, so nothing to go back to
      toasts.show(words.onCutNow(cut.label ?? name));
    }
    return cut;
  });
  // Switching cuts (DESIGN §6.3): "You're on “30s Instagram cut” now." [Switch back to Main cut]. Not for a teammate's
  // cut, which is viewing (the chip and the frame say it), nor for the way back from one. A switch that didn't happen
  // (a queued switch a switch by hand overtook: its `onlyFrom`, passed on) says nothing.
  wrap("switchCut", (switchCut) => async (id, o) => {
    const cuts = ui.cuts(), from = cuts.find((c) => c.current), to = cuts.find((c) => c.id === id);
    const r = await switchCut(id, ...(o !== undefined ? [o] : []));
    if (from && to && from.id !== id && !from.readOnly && !to.readOnly && ui.cuts().find((c) => c.current)?.id === id)
      toasts.show(words.onCutRefNow(cutRef(to)), { label: words.switchBackTo(from.label), run: () => ui.switchCut(from.id) });
    return r;
  });
}
/** Ctrl+Z or redo of a restore or a fold (the bridge's onStep): "Restore undone." [Redo], "Fold redone." [Undo]. */
function tellStep(bridge, s) {
  const steps = stepper(bridge);
  if (!steps || !s?.made) return;
  steps.after(s.which, /restore$/.test(s.told) ? "restore" : "fold", { status: "confirmed", told: s.told, made: s.made });
}

function connect(projectId, bridge) {
  const client = projectId + ":" + Math.random().toString(36).slice(2);
  const r = remoteUi((message) => bridge.call("ui", [{ projectId, client, message }]).catch((e) => console.warn("[carton] the History panel lost the worker:", e?.message ?? e)));
  const off = bridge.onEvent((ev) => { if (ev?.client === client && ev.message) r.receive(ev.message); });
  // Each view() or openPreview() asked here is a turn: one still loading when a newer one is asked (another Play, Back,
  // the panel closed: review of feat/ux-1-viewing #3) never swaps the editor once it loads. pendingView(): what is
  // still loading (the worker hasn't set viewing for it yet), so leaving can cancel it too.
  let viewSeq = 0, pending = null;
  r.ui.pendingView = () => pending?.target ?? null;
  // The stage: what the editor shows, and swap(), the one way this page changes it (the bridge's preview). The marks
  // (the chip, the stage's frame, the timeline's frame) follow what it shows, never what it was asked (design QA G1):
  // - swap(ref): asks the editor to show `ref` (null: your edit) and answers as the bridge does, so a caller sees a
  //   failure. Your edit is marked at once: a return is never held up (PLAN 1.1). A version is marked once the bridge
  //   has shown it: a slow load, or one that fails, never leaves your edit passing for it. Latest wins, as in the
  //   bridge: once a newer swap is asked, an older one's answer changes nothing here.
  // - stageRef(): the ref the editor shows (null: your edit).
  // - stageView(): what that is, for the marks to name it (null for your edit): the view model's viewing once it has
  //   said, else the last it said for that ref, else what was asked for it (its kind and row, no label yet). Never the
  //   view model's newer viewing of another ref (review of fix/ux2-a #1, #2: a version still loading took the row's
  //   mark and the chip's label while the one before it was still on screen).
  // - stageLoading(): the ref a swap has been loading for more than 300 ms, else null: the chip's "Loading …".
  // - onStage(f): told when either changes.
  let stageRef = null, loading = null, swapSeq = 0, slow = 0;
  const stageSubs = new Set();
  const setStage = (seq, ref, wait) => {
    if (seq !== swapSeq) return;
    clearTimeout(slow);
    if (stageRef === ref && loading === wait) return;
    stageRef = ref;
    loading = wait;
    for (const f of [...stageSubs]) f();
  };
  const swap = (ref) => {
    const seq = ++swapSeq;
    clearTimeout(slow);
    if (ref == null) { setStage(seq, null, null); return bridge.preview(projectId, null); }
    if (ref !== stageRef) slow = setTimeout(() => setStage(seq, stageRef, ref), 300);
    return Promise.resolve(bridge.preview(projectId, ref)).then(
      (x) => { setStage(seq, ref, null); return x; },
      (e) => { setStage(seq, stageRef, null); throw e; },
    );
  };
  const known = new Map();
  const remember = (v) => {
    known.delete(v.ref);
    known.set(v.ref, v);
    if (known.size > 32) known.delete(known.keys().next().value);
  };
  const offViewing = r.ui.subscribe("viewing", () => { const v = r.ui.viewing(); if (v && typeof v.ref === "string") remember(v); });
  const asked = (t) => {
    if (typeof t?.ref !== "string") return;
    const was = known.get(t.ref);
    // (a label said for this very ref and kind of view stays; asked as something else, it is that now)
    if (was?.label && was.kind === t.kind && was.versionId === t.versionId) return;
    // how it was before a version already named: "Before <its name>", as the view model says it (Before's flip lands
    // from the cache before the view model answers)
    let label = t.label ?? "";
    if (!label && t.kind === "before" && t.versionId !== undefined)
      for (const k of known.values()) if (k.kind === "version" && k.versionId === t.versionId && k.label) label = `Before ${k.label.replace(/^(Your|The)\b/, (w) => w.toLowerCase())}`;
    remember({ ref: t.ref, kind: t.kind, ...(t.versionId !== undefined ? { versionId: t.versionId } : {}), label, short: label });
  };
  r.ui.stageRef = () => stageRef;
  r.ui.stageView = () => {
    if (stageRef == null) return null;
    const v = r.ui.viewing();
    return v && v.ref === stageRef ? v : (known.get(stageRef) ?? null);
  };
  r.ui.stageLoading = () => loading;
  r.ui.onStage = (f) => { stageSubs.add(f); return () => { stageSubs.delete(f); }; };
  // Opening a version: the editor shows it read-only; null returns to current.
  const openPreview = r.ui.openPreview.bind(r.ui);
  r.ui.openPreview = (ref, label) => { ++viewSeq; pending = null; openPreview(ref, label); return swap(ref ?? null); };
  // Viewing (UX redesign 0.5): the worker labels it and checks it loads; the bridge's preview is still the one way the
  // editor swaps (viewAndSwap, below). A conflict's side (its card's See it, PLAN 7.1) brings the card's clip into view:
  // the playhead at its start in the side shown, the clip not selected, so the first Esc is viewing's, not Cardboard's
  // deselect (PLAN 1.3). Each call is a turn (viewSeq): once a newer one is asked, an older one still loading never
  // swaps the editor again.
  const view = r.ui.view.bind(r.ui);
  r.ui.view = async (target) => {
    const seq = ++viewSeq;
    pending = target ? { seq, target } : null;
    const mine = () => seq === viewSeq;
    asked(target);
    try {
      await viewAndSwap(view, () => r.ui.viewing(), (ref) => (mine() ? swap(ref) : Promise.resolve()), mine)(target);
    } finally {
      if (pending?.seq === seq) pending = null;
    }
    if (mine() && target?.kind === "conflict" && r.ui.viewing()?.conflictId === target.conflictId) {
      const item = r.ui.conflicts().find((c) => c.id === target.conflictId)?.item;
      if (item) bridge.reveal?.(item, { select: false });
    }
  };
  confirmations(r.ui, bridge);
  // Compare in the editor (N1): openCompare and the rest (scripts/carton/compare.js). Its stage goes through swap();
  // unmark(): your edit held read-only in place (the bridge's hold), so the stage shows your edit: marked at once, and
  // any swap still loading is no longer the newest
  const offCompare = attachCompare(r.ui, { bridge, projectId, swap, unmark: () => setStage(++swapSeq, null, null), cancelView: () => { ++viewSeq; pending = null; }, view });
  return { ...r, close: () => { offCompare(); off(); offViewing(); } };
}

/**
 * view() and the editor's swap. The worker labels a view and checks it loads; its viewing topic arrives before its
 * answer, so the ref shown is the one it settled on. A target that names its state (Play's and Before's, a comment's
 * "See it as it was": `ref`), and your edit (null), swap the stage at once, while the worker labels it: Before's flip
 * waits on nothing but the bridge's cache, which Play filled ahead (docs/carton-ux PLAN 4.3; review #7: every flip
 * waited a worker round trip first). If the worker can't load it, the stage goes back to what viewing() says; if it
 * settled on another state (a newer view since: the view model and the bridge are both latest-wins), the stage shows
 * that one. If the editor can't show what the worker settled on (the last swap fails), both go back to your edit
 * before the failure reaches the caller (Play's "Couldn't load this version"), so nothing goes on claiming it (design
 * QA G1); `latest()`: whether this is still the newest view asked, so a failure never undoes a newer one.
 */
function viewAndSwap(view, viewing, preview, latest = () => true) {
  return async (target) => {
    const early = target === null ? preview(null) : typeof target?.ref === "string" ? preview(target.ref) : null;
    // (awaited below: a failure while the worker answers isn't unhandled meanwhile)
    early?.catch(() => {});
    try {
      await view(target);
    } catch (e) {
      if (early) {
        await early.catch(() => {});
        await preview(viewing()?.ref ?? null).catch(() => {});
      }
      throw e;
    }
    const settled = target ? (viewing()?.ref ?? null) : null;
    try {
      if (early) {
        await early;
        if (settled === (target ? target.ref : null)) return;
      }
      return await preview(settled);
    } catch (e) {
      if (settled !== null && latest()) {
        await view(null).catch(() => {});
        if (latest()) await preview(null).catch(() => {});
      }
      throw e;
    }
  };
}

/**
 * The confirmation over the stage: Cardboard's toast look, a polite status, its actions as buttons, ✕ to close. It goes
 * after 6 s, but not while the pointer is on it or the keyboard is in it (PLAN 5.3: a hovered toast stays); the 6 s
 * start again when they leave. An action (Undo) shows it is running, and the toast its answer gives takes this one's
 * place; one that gives none closes it.
 * The edit-attempt toast (tone "viewing", Workstream 1) has its action as the primary button and Esc, its key,
 * in place of the ✕.
 */
const keyboardFocus = (el) => { try { return !!el?.matches?.(":focus-visible"); } catch { return true; } };
function Toast() {
  const [t, setT] = useState(toasts.value);
  const [hover, setHover] = useState(false), [focus, setFocus] = useState(false);
  // the action running: { id, i } (the toast it runs for: a toast that takes its place is never shown busy, so the
  // keyboard can move to its first button at once)
  const [busy, setBusy] = useState(null);
  const box = useRef(null), inside = useRef(false), running = useRef(false);
  useEffect(() => { toasts.subs.add(setT); return () => { toasts.subs.delete(setT); }; }, []);
  // A new toast: any action shown running was the last one's. Gone: nothing holds the next one (its element went, and
  // with it the pointer and the focus, without a leave or a blur). One that takes the place of another the keyboard was
  // in (its Undo pressed with Enter): the keyboard stays, on its first button, else nothing holds it.
  useLayoutEffect(() => {
    if (!t) { setHover(false); setFocus(false); inside.current = false; return; }
    const el = box.current;
    if (inside.current && el && !el.contains(document.activeElement)) {
      const b = el.querySelector("button");
      if (b) b.focus({ preventScroll: true });
      else { inside.current = false; setFocus(false); }
    }
  }, [t?.id]);
  const busyAt = busy && t && busy.id === t.id ? busy.i : null;
  const held = hover || focus || busyAt !== null;
  useEffect(() => {
    // (sticky: an agent's offer to open Compare stays until Open, its ✕ or the next one: DESIGN-V2 §1.13)
    if (!t || held || t.sticky) return undefined;
    const id = t.id, timer = setTimeout(() => { if (toasts.value?.id === id) toasts.set(null); }, toasts.ms);
    return () => clearTimeout(timer);
  }, [t, held]);
  if (!t) return null;
  const warn = t.tone === "warning", viewing = t.tone === "viewing";
  const run = (a, i) => {
    if (busyAt !== null) return;
    const id = t.id;
    // the busy button is disabled, which takes the focus from it: the keyboard was here, and stays (review of WS5 #3)
    running.current = true;
    setBusy({ id, i });
    Promise.resolve().then(() => a.run()).catch(() => {}).finally(() => {
      running.current = false;
      setBusy(null);
      // nothing took its place: done
      if (toasts.value?.id === id) toasts.set(null);
    });
  };
  const actions = t.actions ?? (t.action ? [t.action] : []);
  return h("div", {
    ref: box, className: "carton-toast", "data-tone": t.tone ?? undefined, role: warn ? "alert" : "status", "aria-live": warn ? "assertive" : "polite",
    "data-held": held ? "" : undefined, "data-icon": t.icon,
    onMouseEnter: () => setHover(true), onMouseLeave: () => setHover(false),
    // the keyboard's focus only (a click focuses the button too: then the pointer's leaving lets it go)
    onFocus: (e) => { if (keyboardFocus(e.target)) { inside.current = true; setFocus(true); } },
    onBlur: (e) => { if (!running.current && !e.currentTarget.contains(e.relatedTarget)) { inside.current = false; setFocus(false); } },
  },
    t.icon === "compare" ? h(Glyph, { name: "compare", size: 14 }) : h(Icon, { name: warn ? "warning" : viewing ? "eye" : t.icon === "undo" ? "undo" : "check", size: 14 }),
    h("span", { className: "carton-toast-text" }, t.text),
    // (the edit-attempt toast's Back to my edit: the primary button, its key Esc in place of the ✕)
    ...actions.map((a, i) => h(Button, { key: `${t.id}:${i}`, variant: viewing ? "primary" : undefined, keys: viewing ? "Escape" : undefined, busy: busyAt === i, disabled: busyAt !== null && busyAt !== i, onClick: () => run(a, i) }, a.label)),
    viewing ? h("kbd", { className: "carton-toast-key", "aria-hidden": true }, "Esc") : h(Button, { variant: "ghost", icon: "x", label: words.close, onClick: () => toasts.set(null) }));
}

// One connection per project, shared by the side panel and the stage layer; closed when neither uses it.
const conns = new Map();
function useConn(projectId, bridge) {
  const conn = useMemo(() => {
    let e = conns.get(projectId);
    if (!e) conns.set(projectId, (e = { conn: connect(projectId, bridge), users: 0, closing: null }));
    return e.conn;
  }, [projectId, bridge]);
  const [ready, setReady] = useState(false);
  useEffect(() => {
    injectCardboardSkin(document);
    const e = conns.get(projectId);
    if (e?.conn === conn) { e.users++; clearTimeout(e.closing); }
    let live = true;
    conn.ready.then(() => live && setReady(true));
    return () => {
      live = false;
      if (e?.conn !== conn || --e.users > 0) return;
      e.closing = setTimeout(() => { if (e.users === 0 && conns.get(projectId) === e) { conns.delete(projectId); conn.close(); } }, 0);
    };
  }, [projectId, conn]);
  return [conn, ready];
}

const HISTORY_KEY = /Mac|iPhone|iPad/.test(globalThis.navigator?.platform ?? "") ? "⌘⇧H" : "Ctrl+Shift+H";
// Share is a dialog now (PLAN 8.1), not one of the panel's tabs.
const PANELS = { history: { label: "History", icon: "versions", key: HISTORY_KEY }, comments: { label: "Comments", icon: "comment" } };
const TABS = ["history", "comments"];
// Which side panel is open, for the stage layer of this page (both parts live in this module, so it stays in it): the
// card stack folds to its pill while a panel takes the room beside the chat.
const sidePanel = { value: null, subs: new Set(), set(v) { this.value = v; for (const f of this.subs) f(v); } };
// The stage's live chip asks the side panel's part to open Share (both parts live in this module).
const panelRequests = new Set();
// Below this window width the title bar keeps History only, and Share opens from the panel's head (PLAN 2.3; the same
// query as scripts/carton/strip-buttons.js: both pages are the window's width).
const NARROW = "(max-width: 1180px)";
function useNarrowWindow() {
  const [narrow, setNarrow] = useState(() => typeof matchMedia === "function" && matchMedia(NARROW).matches);
  useEffect(() => {
    if (typeof matchMedia !== "function") return undefined;
    const q = matchMedia(NARROW), f = () => setNarrow(q.matches);
    q.addEventListener?.("change", f);
    return () => q.removeEventListener?.("change", f);
  }, []);
  return narrow;
}

// ---------------------------------------------------------------- the title bar's cut chip (PLAN 2.1, 2.2)
// Each cut but Main has a colour: its dot in the chip (and in the cuts menu and History's cut bar, PLAN 6.1). A cut's
// own colour when the view model gives one (Cut.color), else one picked from its id, so it never changes.
const CUT_COLORS = ["#f59e0b", "#22d3ee", "#a78bfa", "#f472b6", "#4ade80", "#fb7185", "#60a5fa", "#facc15"];
export function cutColor(cut) {
  if (typeof cut?.color === "string" && /^#[0-9a-f]{3,8}$/i.test(cut.color)) return cut.color;
  let x = 0x811c9dc5;
  for (const ch of String(cut?.id ?? "")) x = Math.imul(x ^ ch.charCodeAt(0), 0x01000193) >>> 0;
  return CUT_COLORS[x % CUT_COLORS.length];
}
const upFirst = (s) => (typeof s === "string" && s ? s[0].toUpperCase() + s.slice(1) : s);
/**
 * What the editor shows when it isn't your edit (PLAN 0.5's ui.viewing(): {ref, kind, label, short}, or null), and
 * what the view model doesn't say there yet: a teammate's cut switched to (read-only: today's cuts menu switches to
 * it), and a version opened read-only through openPreview(), which the real view model (from-carton.ts) still keeps in
 * preview() only (review of feat/ux-2-8 #1: with viewing() there but null, the chip lost its label and its ✕).
 */
export function viewingOf(ui) {
  const v = typeof ui.viewing === "function" ? ui.viewing() : null;
  if (v) return v;
  const current = ui.cuts().find((c) => c.current);
  if (current?.readOnly) return { ref: current.head, kind: "cut", cutId: current.id, label: current.label, short: current.label };
  const p = ui.preview?.();
  return p ? { ref: p.ref, kind: "version", label: p.label, short: p.label } : null;
}
// Your own cut: the current one, or while a teammate's cut is viewed, your Main cut (the one Back goes to).
const homeCut = (cuts) => {
  const current = cuts.find((c) => c.current);
  return current && !current.readOnly ? current : cuts.find((c) => !c.readOnly && c.kind === "main") ?? cuts.find((c) => !c.readOnly) ?? null;
};
/**
 * The chip's part of the title bar's report: {cut: {name, dot}, viewing: {label, loading}}; null until the cuts are
 * known. Its viewing part says what the stage shows (stageViewingOf; while the view model's label catches up with a
 * swap, the one it has). While a version has been loading for more than 300 ms (connect()'s stageLoading), it says
 * "Loading <it>" (loading: true, a spinner for the eye) and the stage has no frame yet (design QA G1).
 */
export function chipOf(ui) {
  const cuts = ui.cuts();
  const cut = homeCut(cuts);
  if (!cut) return null;
  // comparing (N1): the chip's second part is "⇆ Comparing “Sent to client” with your edit ✕"
  const cmp = ui.comparing?.();
  if (cmp) return { cut: { name: cut.label || cut.name, dot: cut.kind === "main" ? null : cutColor(cut) }, viewing: null, comparing: { label: comparingLabel(cmp) } };
  const v = viewingOf(ui), wait = typeof ui.stageLoading === "function" ? ui.stageLoading() : null;
  let viewing = null;
  if (wait != null) viewing = { label: v?.ref === wait && v.label ? words.loadingView(v.label.replace(/^Your\b/, "your")) : words.loading, loading: true };
  else {
    // only what is on screen names it: until the view model has said what that is, a neutral label (review of
    // fix/ux2-a #2: the version before it, by name, was the label meanwhile)
    const s = stageViewingOf(ui), label = s ? s.label || words.anotherVersion : "";
    // a label from today's callers can start in lower case ("the version from 2:14 PM (Codex)"): the chip starts a phrase
    viewing = label ? { label: upFirst(label) } : null;
  }
  return { cut: { name: cut.label || cut.name, dot: cut.kind === "main" ? null : cutColor(cut) }, viewing };
}
/**
 * Back to your edit (the chip's ✕). A teammate's cut switched to: your own cut again. Anything else viewed: through
 * openPreview(null), the path connect() wraps so the editor swaps back too (bridge.preview); PLAN 0.5 keeps it as
 * view(null)'s alias, and it clears whatever is viewed.
 */
export function backToEdit(ui) {
  // Done comparing (the chip's ✕, Esc, Export: N1)
  if (ui.comparing?.()) return ui.closeCompare();
  const cuts = ui.cuts(), current = cuts.find((c) => c.current), home = homeCut(cuts);
  if (current?.readOnly && home) return ui.switchCut(home.id);
  if (viewingOf(ui)) return ui.openPreview(null);
  // still loading (connect()'s pendingView): asked off, so it never takes the stage when it loads
  if (ui.pendingView?.()) return ui.view(null);
  return undefined;
}
/**
 * What the panel showed goes with it (PLAN 1.3), shown or still loading (a Play whose version hasn't loaded when the
 * panel closes: review of feat/ux-1-viewing #3); a conflict's side belongs to its card on the stage.
 */
const leavesWithPanel = (ui, next) => {
  // closing History ends Compare (DESIGN-V2 §1.7); opening it (an agent's Compare, from Comments: review #6) doesn't
  if (ui.comparing?.()) return next !== "history";
  const v = viewingOf(ui) ?? ui.pendingView?.() ?? null;
  return !!v && v.kind !== "conflict";
};
/**
 * Whether History's list marks what is viewed itself (its row's "👁 Viewing ✕", or a teammate's cut in its cut bar),
 * so the stage frame needs no label (PLAN 1.1): History open on a version or how it was before one; never a conflict's
 * side, nor a version without a row (Comments' "See it as it was").
 */
/**
 * What the stage's marks show (the frame, the timeline's frame): what the editor was told to show (connect()'s
 * stageRef), labelled once the view model says what it is (viewingOf, its ref the one shown); while a swap made at
 * once waits for its label, the frame with no label yet; your edit asked for: nothing, even before the view model
 * catches up. A teammate's cut switched to is your current cut in the editor (no preview): viewingOf's. A view model
 * without stageRef (a host of its own): viewingOf.
 */
export function stageViewingOf(ui) {
  // comparing marks the stage its own way (compare.js): no viewing frame then
  if (ui.comparing?.()) return null;
  const v = viewingOf(ui);
  if (typeof ui.stageRef !== "function") return v;
  if (v?.kind === "cut" && !(typeof ui.viewing === "function" && ui.viewing())) return v;
  const shown = ui.stageRef();
  if (shown == null) return null;
  if (v && v.ref === shown) return v;
  // the view model has moved on (a version still loading) or not caught up (a swap from the cache): what is on screen
  // is connect()'s to say (stageView), with no label when nothing has said it yet
  const s = typeof ui.stageView === "function" ? ui.stageView() : null;
  return s ?? { ref: shown, kind: "version", label: "", short: "" };
}
export function listMarks(panel, v) {
  if (panel !== "history" || !v) return false;
  return v.kind === "cut" || ((v.kind === "version" || v.kind === "before") && typeof v.versionId === "string");
}
const WIDTH = { key: "carton.sidePanelWidth", min: 300, max: 640, initial: 384 };
// The preview keeps at least this much width beside the panel (UI audit P2-13: at a narrow window the panel took it all).
const MIN_STAGE = 320;

/**
 * Where the side panel goes, from the room the preview would have without it (`room`: the stage's width plus the
 * panel's own width while it is in the row). Its chosen width when that leaves the preview MIN_STAGE; narrower, down
 * to its minimum, when that is enough; else it floats over the chat as a drawer (overlay), and the preview keeps the
 * room Cardboard alone gives it. `room` doesn't change with the choice, so the choice never oscillates.
 * The drawer covers the chat column (`chat`: its width, 0 when it is collapsed) and no more when that is at least the
 * minimum; narrower than that, the drawer keeps its minimum and says it reaches past the chat (`over`), so it ends
 * where the stage ends and leaves the timeline and its toolbar clear (baseline P3-7: at 960 px it covered Fullscreen and
 * Hide timeline). It ends there too when the timeline's toolbar reaches under it (`tools`: the toolbar's right edge,
 * its last button's): at 960 px with the chat open the toolbar runs on under the chat column, and the drawer as wide as
 * that column covered Fullscreen and Hide timeline from top to bottom (regress prod3 P3-A).
 */
export function fitPanel({ room, preferred, viewport, chat, tools, min = WIDTH.min, minStage = MIN_STAGE }) {
  if (!(room > 0)) return { mode: "inline", width: preferred };
  if (room - preferred >= minStage) return { mode: "inline", width: preferred };
  if (room - min >= minStage) return { mode: "inline", width: Math.floor(room - minStage) };
  const width = Math.max(Math.min(preferred, viewport - 64), Math.min(min, viewport));
  // not measured: as before; a chat collapsed to nothing is measured (review #2), and all of the drawer is past it
  if (!(chat >= 0)) return { mode: "overlay", width };
  const fits = Math.max(min, Math.min(width, Math.floor(chat)));
  return { mode: "overlay", width: fits, over: fits > chat || tools > viewport - fits };
}

/** The panel's place in the row (fitPanel), kept up to date as the window, the Library or the chat change size. */
function useFit(ref, preferred) {
  const [fit, setFit] = useState({ mode: "inline", width: preferred });
  const fitRef = useRef(fit);
  fitRef.current = fit;
  useLayoutEffect(() => {
    const stage = document.querySelector("[data-carton-stage-host]");
    if (!stage) { setFit({ mode: "inline", width: preferred }); return undefined; }
    const measure = () => {
      const aside = ref.current;
      if (!aside) return;
      const inflow = fitRef.current.mode === "inline" ? aside.getBoundingClientRect().width : 0;
      const box = stage.getBoundingClientRect(), room = box.width + inflow;
      const row = aside.parentElement?.getBoundingClientRect();
      // the chat column: the row's right of the stage, less the panel while it is in the row
      const chat = row ? Math.max(0, row.right - box.right - inflow) : undefined;
      // the timeline toolbar's right end: its last button (Cardboard's own, "Hide timeline" or "Show timeline")
      const tools = document.querySelector('[aria-label="Hide timeline"],[aria-label="Show timeline"]')?.getBoundingClientRect().right;
      const fit = fitPanel({ room, preferred, viewport: window.innerWidth, chat, tools });
      // reaching past the chat, the drawer ends where the stage does: the timeline below stays clear
      const next = { ...fit, ...(row ? { top: row.top, height: fit.over ? Math.max(0, box.bottom - row.top) : row.height } : {}) };
      const was = fitRef.current;
      if (was.mode !== next.mode || was.width !== next.width || (next.mode === "overlay" && (was.top !== next.top || was.height !== next.height))) setFit(next);
    };
    measure();
    const ro = typeof ResizeObserver === "function" ? new ResizeObserver(measure) : null;
    ro?.observe(stage);
    window.addEventListener("resize", measure);
    return () => { ro?.disconnect(); window.removeEventListener("resize", measure); };
  }, [ref, preferred]);
  return fit;
}

/**
 * History in the side panel: the cut it shows, with the cuts menu (switch, a switch that waits for an agent's turn, New
 * cut, Rename, "Fold in changes from a cut…", which opens Fold in: from a cut into a cut, all, some or none of it); on a
 * teammate's cut, what you can do with it (fold it into yours, or copy it as a new cut: UX redesign PLAN 6.2); then
 * the versions, and the Changes view in their place (docs/carton-ux DESIGN §5.4: "Compare with your edit", Shift+click),
 * with Play and Before (§5.3). It replaced the old Compare card and shot strips (PLAN 4.4): this page mounts neither.
 */
function HistorySide({ projectId, bridge, cutsAsk = 0, onCutsAsked }) {
  const cuts = useCuts();
  const [fold, setFold] = useState(null);
  const openFold = useCallback((from, into) => setFold({ from: from.id, into: into.id }), []);
  const current = cuts.find((c) => c.current)?.head;
  const box = useRef(null);
  // The title bar's cut chip (PLAN 2.2, version 1): History opens with its cuts menu open, focus in it, from the list.
  // The menu is History's own (in its cut bar), opened through Workstream 6's openCutsMenu (the newest mounted
  // CutsMenu opens, or the next to mount within 2 s), so the chip's menu and History's are one menu. The request is the
  // side panel's (CartonSide's), consumed there once the menu opened or that wait ran out (review of feat/ux-2-8 #3:
  // kept here, it outlived History closing, and reopening History opened the menu again). The Changes view, open in
  // place of the list and its cut bar, goes back to the list first (its ← History): the cut bar's menu mounts again.
  const ui = useCartonUi();
  useEffect(() => {
    if (!cutsAsk) return undefined;
    box.current?.querySelector(".carton-history[data-changes] .carton-changes-nav button")?.click();
    let live = true;
    openCutsMenu(ui, { within: 2000 }).then(() => { if (live) onCutsAsked?.(); });
    return () => { live = false; };
  }, [cutsAsk, onCutsAsked, ui]);
  // Play runs on your edit (the newest version) or on the version it views, in the editor's own player: its playhead
  // follows Play's, real frames there, at most 10 seeks a second while it plays, and always the last one.
  const seeker = useMemo(() => {
    let last = 0, timer = null, at = 0;
    const go = () => { timer = null; last = performance.now(); bridge.seek?.(at); };
    return {
      onFrame: (t) => {
        at = t;
        if (performance.now() - last >= 100) go();
        else timer ??= setTimeout(go, 100);
      },
      stop: () => { clearTimeout(timer); timer = null; },
    };
  }, [bridge]);
  useEffect(() => seeker.stop, [seeker]);
  // History's cut bar holds Workstream 6's cuts menu (docs/carton-ux DESIGN §6.1) and, on a teammate's cut, its actions
  // under the bar: one element each, so History re-rendering for a new version never re-renders them
  const cutsMenu = useMemo(() => h(CutsMenu, { onFoldIn: openFold }), [openFold]);
  const teammateActions = useMemo(() => h(TeammateCutActions, { onFoldIn: openFold }), [openFold]);
  const selectedClip = useCallback(() => bridge.selectedClip?.() ?? null, [bridge]);
  // What Play needs of the editor (@carton/react's PlayHost): the playhead (followed while playing, set by a click on a
  // change), Before's side checked out ahead so the flip doesn't wait (the bridge keeps it), and your edit's length.
  // Play never selects a clip: Cardboard's own Esc clears a selection first and would swallow the person's Esc.
  const play = useMemo(() => ({
    onFrame: seeker.onFrame,
    seek: (t) => { seeker.stop(); bridge.seek?.(t); },
    prefetch: (ref) => bridge.prefetch?.(projectId, ref),
    length: () => bridge.editLength?.(),
    // a landmark's picture from the stage (Carton UX v2): History takes one when the stage shows a landmark's version
    picture: stagePicture,
  }), [seeker, bridge, projectId]);
  // Compare in the editor (N1, DESIGN-V2 §1.2): every way into the Changes view opens Compare; while comparing,
  // History is its change list
  const comparing = useComparing(ui);
  const onCompare = useCallback((a, b) => void Promise.resolve(ui.openCompare?.(a, b)).catch(() => {}), [ui]);
  const foldIds = useCallback((from, into) => setFold({ from, into }), []);
  return h("div", { ref: box, className: "carton-sidebar-history" },
    comparing ? h(CompareSide, { bridge, onFoldIn: foldIds }) : null,
    // the cuts menu in History's cut bar, and on a teammate's cut what you can do with it under the bar (PLAN 6.2);
    // kept mounted under Compare's list, so the card you came from is still open after it (DESIGN-V2 §1.7)
    h("div", { style: { display: comparing ? "none" : "contents" } },
      h(HistoryPanel, { cuts: cutsMenu, actions: teammateActions, selectedClip, onSeek: play.seek, currentRef: current, play, ...(typeof ui.openCompare === "function" ? { onCompare } : {}) })),
    fold ? h(FoldInDialog, { fromCutId: fold.from, intoCutId: fold.into, onClose: () => setFold(null) }) : null);
}

/** The project's timecoded comments (@carton/comments, served by the worker): pinned at the playhead, a timecode seeks. */
function useComments(projectId, bridge) {
  const conn = useMemo(() => {
    const client = projectId + ":c:" + Math.random().toString(36).slice(2);
    const r = remoteComments((message) => bridge.call("comments", [{ projectId, client, message }]).catch((e) => console.warn("[carton] comments lost the worker:", e?.message ?? e)));
    const off = bridge.onEvent((ev) => { if (ev?.client === client && ev.message) r.receive(ev.message); });
    return { ...r, close: off };
  }, [projectId, bridge]);
  useEffect(() => { injectCommentsSkin(document); return () => { if (typeof conn.close === "function") conn.close(); }; }, [conn]);
  return conn;
}
function CommentsSide({ projectId, bridge }) {
  const conn = useComments(projectId, bridge);
  const [selected, setSelected] = useState(null);
  // "See it as it was" (UX redesign PLAN 9.1, DESIGN §6.8): the version the note was made on, viewed as any version is
  // (ui.view: the editor swaps through the bridge's preview, connect()); a History row's label when it is one
  const ui = useCartonUi();
  const seeAsItWas = useCallback((t) => (t.made ? ui.view({ kind: "version", ref: `${t.made.cut}@${t.made.seq}`, label: commentWords.asItWas }) : undefined), [ui]);
  return h(CommentsPanel, { className: "carton-sidebar-comments", comments: conn.ui, at: () => bridge.playhead?.() ?? null, onSeek: (t) => bridge.seek?.(t), selected, onSelect: setSelected, onSeeAsItWas: seeAsItWas });
}

/** The chat sidebar's resize handle: drag its left edge. The width is kept for next time. */
function useWidth() {
  const [width, setWidth] = useState(() => {
    const w = Number(globalThis.localStorage?.getItem(WIDTH.key));
    return Number.isFinite(w) && w >= WIDTH.min && w <= WIDTH.max ? w : WIDTH.initial;
  });
  const onPointerDown = (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const x0 = e.clientX, w0 = width, el = e.currentTarget;
    el.setPointerCapture(e.pointerId);
    let last = w0;
    const move = (m) => { last = Math.min(WIDTH.max, Math.max(WIDTH.min, w0 + (x0 - m.clientX))); setWidth(last); };
    const up = () => {
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerup", up);
      el.removeEventListener("pointercancel", up);
      try { globalThis.localStorage?.setItem(WIDTH.key, String(Math.round(last))); } catch {}
    };
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", up);
    el.addEventListener("pointercancel", up);
  };
  return [width, onPointerDown];
}

// A throw in Carton's part of the editor stays in it (UI audit P1-1): where nothing caught it before, Cardboard replaced
// the editor's whole tab ("This tab hit a snag"). The side panel says so, with Try again; the layer over the stage
// (preview banner, conflict cards, the footage notice) shows a small Try again in its corner, over nothing else.
// Logged as an `error` with the surface; another panel, or Try again, renders it anew. Cardboard's own preview has
// the same kind of boundary.
export class CartonBoundary extends Component {
  constructor(p) { super(p); this.state = { error: null }; }
  static getDerivedStateFromError(error) { return { error }; }
  componentDidCatch(error) { window.__cbLog?.("error", { msg: String(error?.message ?? error).slice(0, 300), src: "carton-ui.js", panel: this.props.panel }); }
  render() {
    if (!this.state.error) return this.props.children;
    const again = h(Button, { onClick: () => this.setState({ error: null }) }, "Try again");
    if (this.props.panel === "stage")
      return h("div", { className: "carton-stage-snag", role: "alert" }, h("span", null, "Conflict cards and the preview banner hit a snag."), again);
    // a dialog (Share) keeps its frame, so Esc and its ✕ still close it
    if (this.props.onClose)
      return h(Dialog, { title: this.props.title ?? words.share, onClose: this.props.onClose }, h("div", { role: "alert", className: "carton-share-snag" }, h("p", null, "This hit a snag. Nothing you’ve made is lost."), again));
    return h("div", { className: "flex flex-col items-start gap-2 p-4 text-sm text-muted-foreground", role: "alert" },
      h("p", null, "This panel hit a snag. Nothing you’ve made is lost."),
      again);
  }
}

function Sidebar({ panel, setPanel, projectId, bridge, onShare, cutsAsk, onCutsAsked }) {
  const ref = useRef(null);
  const [preferred, onResize] = useWidth();
  const fit = useFit(ref, preferred);
  const width = fit.width;
  // A drawer over the chat when the window is too narrow for the preview, the panel and the chat side by side.
  const overlay = fit.mode === "overlay" ? { position: "fixed", right: 0, top: fit.top ?? 0, height: fit.height ?? "100%", zIndex: 40, boxShadow: "-16px 0 40px -12px #000000b3" } : null;
  // Esc closes it, and only while focus is in it: the editor's own keys are never taken. Viewing is the layer inside
  // it (UI audit P2-1: "… → preview → panel"): Esc returns to your edit first, as the frame's ✕ does, and the next Esc
  // closes the panel (regress 2026-11-02 #4: it closed the panel and left the preview open).
  const ui = useCartonUi();
  const onKeyDown = (e) => {
    // an Esc a handler nearer the page took (a Radix layer's, in the capture phase) is theirs: nothing here
    if (e.key !== "Escape" || e.defaultPrevented || e.nativeEvent?.defaultPrevented) return;
    e.stopPropagation();
    // (comparing too: Esc is Done comparing, and History shows its list again: DESIGN-V2 §1.7)
    if (viewingOf(ui) || ui.comparing?.()) { void Promise.resolve(backToEdit(ui)).catch(() => {}); return; }
    setPanel(null);
  };
  useEffect(() => { ref.current?.focus({ preventScroll: true }); }, [panel]);
  // Below 1180 px the title bar has no Share icon: it joins this head, beside Close (PLAN 2.3). Two labelled tabs, it and
  // Close fit at the panel's 300 px minimum (regress 2026-11-02 P3-3 was three tabs there).
  const narrowWindow = useNarrowWindow();
  const headButton = "flex size-control-sm shrink-0 cursor-pointer items-center justify-center rounded-ui-md text-muted-foreground outline-none transition-colors hover:bg-foreground/[0.06] hover:text-foreground focus-visible:ring-2 focus-visible:ring-white/30";
  // Cardboard's own classes, as its chat sidebar uses them: same width, rule, handle, header and buttons.
  return h("aside", { ref, tabIndex: -1, className: "carton-sidebar relative shrink-0 overflow-hidden bg-[var(--desktop-panel)] outline-none", style: { width, ...overlay }, "data-carton-skin": "cardboard", "data-fit": fit.mode, "aria-label": PANELS[panel].label, onKeyDown },
    h("div", { className: "pointer-events-none absolute inset-y-0 left-0 z-10 w-px bg-white/[0.06]" }),
    h("div", { className: "relative flex h-full flex-col", style: { width } },
      h("div", { className: "group absolute top-0 bottom-0 left-0 z-10 w-1", style: { cursor: "col-resize" }, onPointerDown: onResize, role: "separator", "aria-orientation": "vertical", "aria-label": "Resize" },
        h("div", { className: "pointer-events-none absolute inset-y-0 left-1/2 w-1 -translate-x-1/2 bg-accent/80 opacity-0 transition-opacity group-hover:opacity-100" })),
      h("div", { className: "flex h-[40px] shrink-0 items-center gap-[2px] pr-[16px] pl-[12px]" },
        h("div", { className: "flex min-w-0 flex-1 items-center gap-[2px]", role: "tablist" },
          ...TABS.map((id) => h("button", {
            key: id, type: "button", role: "tab", "aria-selected": panel === id, "aria-label": PANELS[id].label, onClick: () => setPanel(id), title: PANELS[id].key ? `${PANELS[id].label} (${PANELS[id].key})` : undefined, "aria-keyshortcuts": PANELS[id].key ? "Control+Shift+H" : undefined,
            className: "relative flex h-[26px] shrink-0 cursor-pointer items-center gap-[6px] rounded-ui-md px-[8px] text-ui-sm font-medium outline-none transition-colors focus-visible:ring-2 focus-visible:ring-white/30 " +
              (panel === id ? "bg-white/[0.07] text-foreground" : "text-muted-foreground hover:bg-foreground/[0.06] hover:text-foreground"),
          }, h(Icon, { name: PANELS[id].icon, size: 14 }), PANELS[id].label))),
        narrowWindow && onShare ? h("button", { type: "button", "aria-label": words.share, title: words.share, "data-carton-share": "", onClick: onShare, className: headButton }, h(Icon, { name: "users", size: 16 })) : null,
        h("button", { type: "button", "aria-label": "Close", title: "Close (Esc)", onClick: () => setPanel(null), className: headButton },
          h(Icon, { name: "x", size: 16 }))),
      h("div", { className: "carton-sidebar-body relative flex min-h-0 flex-1 flex-col overflow-x-hidden overflow-y-auto" },
        h(CartonBoundary, { key: panel, panel }, panel === "comments" ? h(CommentsSide, { projectId, bridge }) : h(HistorySide, { projectId, bridge, cutsAsk, onCutsAsked })))));
}

/** The Share dialog over the editor (PLAN 8.1), inside its own boundary: a throw keeps the dialog's frame. */
function ShareHost({ projectId, bridge, onClose }) {
  const Share = window.__cartonSyncUi?.ShareDialog;
  if (!Share) return null;
  const name = bridge.projectName ?? null;
  return h("div", { "data-carton-skin": "cardboard" },
    h(CartonBoundary, { panel: "share", onClose, title: (name ? words.shareTitle(name) : words.shareThisProject) }, h(Share, { projectId, bridge, name, onClose })));
}

/**
 * The side panel, beside the chat, and the Share dialog: opened and closed from the title bar's icons, which show the
 * one open; the cut chip's click opens History with its cuts menu (PLAN 2.2, version 1), its ✕ goes back to your edit.
 */
export const CartonSide = memo(function CartonSide({ projectId, bridge }) {
  const [conn, ready] = useConn(projectId, bridge);
  const [panel, setPanelState] = useState(null);
  // Closing the panel, or switching its tab, brings your edit back from what the panel showed you (PLAN 1.3, DESIGN
  // §2): a version History played, a teammate's cut, Comments' "See it as it was". A conflict's side, seen from its
  // card on the stage, stays until that card or Esc leaves it. However the panel closes: its ✕, Esc, Ctrl+Shift+H, the
  // title bar's icon.
  const shownPanel = useRef(panel);
  useEffect(() => {
    const was = shownPanel.current;
    shownPanel.current = panel;
    if (!was || was === panel || !ready) return;
    if (leavesWithPanel(conn.ui, panel)) void Promise.resolve(backToEdit(conn.ui)).catch(() => {});
  }, [panel, ready, conn]);
  const [share, setShare] = useState(false);
  // the chip asked for the cuts menu: a count, so each click asks again; History sets it back to 0 once the menu opens
  const [cutsAsk, setCutsAsk] = useState(0);
  const cutsAsked = useCallback(() => setCutsAsk(0), []);
  const setPanel = useCallback((p) => setPanelState(p), []);
  // Share is a modal dialog: while it is open the editor's shortcut for History is its, not the page's behind it
  // (review of feat/ux-2-8 #2: History opened behind it and took the focus, and Esc then closed History, not Share).
  const shareOpen = useRef(false);
  shareOpen.current = share;
  // Ctrl+Shift+H (Cmd+Shift+H on a Mac) opens and closes History (UI audit P3-7): H is free in Cardboard's keymap,
  // and Shift with Ctrl/Cmd pairs it with Cardboard's own Ctrl+Shift+B ("Report an issue"). Only the editor's page
  // listens (this panel lives there), and only for that exact chord.
  useEffect(() => {
    const onKey = (e) => {
      if (!(e.ctrlKey || e.metaKey) || !e.shiftKey || e.altKey || (e.code !== "KeyH" && e.key !== "H" && e.key !== "h")) return;
      if (shareOpen.current) return;
      e.preventDefault();
      e.stopPropagation();
      setPanelState((p) => (p === "history" ? null : "history"));
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);
  // The title bar: its icons (the same icon again closes what it opened), the cut chip and its ✕.
  useEffect(() => bridge.onCommand?.((ev) => {
    const a = ev?.action;
    // the title bar is outside the Share dialog: its History icon closes Share and opens History
    if (a === "carton-history") { setShare(false); setPanelState((p) => (p === "history" ? null : "history")); }
    else if (a === "carton-share") setShare((o) => !o);
    else if (a === "carton-cuts") { setShare(false); setPanelState("history"); setCutsAsk((n) => n + 1); }
    else if (a === "carton-back") void Promise.resolve(backToEdit(conn.ui)).catch(() => {});
  }), [bridge, conn]);
  useEffect(() => {
    const f = (p) => (p === "share" ? setShare(true) : setPanelState(p));
    panelRequests.add(f);
    return () => { panelRequests.delete(f); };
  }, []);
  // Tell the title bar what it shows (bridge.reportPanel; main hands it to the strip): the panel open (null: none,
  // which also says the strip's Carton parts apply to this tab), a shared project's live summary for the status dot and
  // avatars (P2-11), whether Share is open, and the cut chip's cut and viewing label. Sent again only when what the
  // strip shows changes: the cuts topic changes at every version (a head moves), the chip only when a name, a dot or
  // the viewing label does. The chip's part is sent straight from the topic's notice, without waiting for a render, so a
  // switch (the cuts menu's, or cb cut switch from a terminal) reaches the title bar within the frame it lands in.
  const summary = liveSummary(useLiveStatus(projectId, bridge));
  const summaryKey = summary ? JSON.stringify(summary) : "";
  const report = useRef({ panel: null, live: null, share: false, chip: null, sent: null });
  const send = useCallback(() => {
    const r = report.current;
    const key = JSON.stringify([r.panel, r.live, r.share, r.chip]);
    if (key === r.sent) return;
    r.sent = key;
    bridge.reportPanel?.(r.panel, r.live ?? undefined, { share: r.share, cut: r.chip?.cut ?? null, viewing: r.chip?.viewing ?? null, ...(r.chip?.comparing ? { comparing: r.chip.comparing } : {}) });
  }, [bridge]);
  useEffect(() => {
    Object.assign(report.current, { panel, live: summaryKey ? JSON.parse(summaryKey) : null, share });
    send();
    sidePanel.set(panel);
  }, [panel, summaryKey, share, send]);
  useEffect(() => {
    if (!ready) return undefined;
    const ui = conn.ui;
    const update = () => { report.current.chip = chipOf(ui); send(); };
    update();
    // "viewing": PLAN 0.5's topic, once the view model has it; "preview" and "cuts" until then
    const offs = ["cuts", "preview", "viewing"].map((t) => ui.subscribe(t, update));
    if (typeof ui.onCompare === "function") offs.push(ui.onCompare(update));
    // and the stage: the chip says what it shows, and "Loading …" while a version is slow to come (G1)
    if (typeof ui.onStage === "function") offs.push(ui.onStage(update));
    return () => { for (const off of offs) off(); };
  }, [conn, ready, send]);
  useEffect(() => () => sidePanel.set(null), []);
  // History closed before the menu opened: the request goes with it
  useEffect(() => { if (!panel) setCutsAsk(0); }, [panel]);
  const closeShare = useCallback(() => setShare(false), []);
  if (!panel && !share) return null;
  return h(CartonProvider, { ui: conn.ui },
    panel ? h(Sidebar, { panel, setPanel, projectId, bridge, onShare: () => setShare(true), cutsAsk, onCutsAsked: cutsAsked }) : null,
    share ? h(ShareHost, { projectId, bridge, onClose: closeShare }) : null);
});

/**
 * Opening a shared project whose footage is a teammate's (UI audit P1-9; the editor patch in sync/patches/media.js
 * keeps Cardboard's "Missing Media Files" and its "Remove and Open" away from those clips): what happened, in words.
 * Clips not sent yet show as Offline; it checks every 15 s and says when they have arrived. Closed with its ✕ or Esc.
 * Carton UX redesign PLAN 8.3: clips on their way say so in a title line, "2 clips are still on their way from Leo",
 * then which ones, by name in quotes, and that nothing was removed (`from`: the teammate, when the notice is told).
 */
function MediaNotice({ projectId, bridge }) {
  const [here, setHere] = useState(() => (window.__cartonMediaHere?.projectId === projectId ? window.__cartonMediaHere : null));
  const [closed, setClosed] = useState(false);
  const [arrived, setArrived] = useState(false);
  useEffect(() => {
    const f = (e) => { if (e.detail?.projectId === projectId) { setHere(e.detail); setClosed(false); setArrived(false); } };
    window.addEventListener("carton:media-here", f);
    return () => window.removeEventListener("carton:media-here", f);
  }, [projectId]);
  const waiting = here?.waiting ?? [];
  useEffect(() => {
    if (closed || arrived || !waiting.length || here?.unchecked) return undefined;
    const t = setInterval(() => {
      bridge.call("liveMediaHere", [{ projectId, mediaIds: waiting.map((w) => w.mediaId) }]).then((r) => {
        if (r?.clips && waiting.every((w) => r.clips[w.mediaId] === "playable")) setArrived(true);
      }, () => {});
    }, 15000);
    return () => clearInterval(t);
  }, [bridge, projectId, waiting, closed, arrived]);
  if (closed || !here || (!waiting.length && !here.playable)) return null;
  const names = waiting.slice(0, 2).map((w) => w.fileName).join(", ") + (waiting.length > 2 ? ` and ${waiting.length - 2} more` : "");
  const quoted = waiting.length > 2 ? `${waiting.slice(0, 2).map((w) => `“${w.fileName}”`).join(", ")} and ${waiting.length - 2} more` : waiting.map((w) => `“${w.fileName}”`).join(" and ");
  const onTheirWay = !here.unchecked && !arrived && waiting.length > 0;
  const title = onTheirWay ? words.clipsOnTheirWay(waiting.length, typeof here.from === "string" && here.from ? here.from : "your teammate") : null;
  const text = here.unchecked
    ? `${waiting.length === 1 ? `${names} couldn't be checked, so it shows` : `${waiting.length} clips couldn't be checked (${names}), so they show`} as Offline. Nothing was removed. Close and reopen the project to check again.`
    : arrived
    ? "Your teammate's footage has arrived. Close and reopen the project to play it."
    : waiting.length === 1
      ? words.clipOfflineUntil(quoted)
      : waiting.length
        ? words.clipsOfflineUntil(quoted)
        : "This video plays from preview copies. Its originals stay on your teammate's computer.";
  return h("div", { className: "carton-media-notice", role: "status", "data-waiting": waiting.length && !arrived ? "" : undefined, onKeyDown: (e) => { if (e.key === "Escape") { e.stopPropagation(); setClosed(true); } } },
    // footage on its way: the hourglass, not Offline's cloud, a state of its own (design QA G23)
    h(Icon, { name: waiting.length && !arrived ? "hourglass" : "cloudCheck", size: 14 }),
    h("span", { className: "carton-media-notice-text" }, title ? h("strong", { className: "carton-media-notice-title" }, title) : null, text),
    h(Button, { variant: "ghost", icon: "x", label: words.close, onClick: () => setClosed(true) }));
}

/**
 * A shared project's status where it is always seen (UI audit P2-11: it was only inside the Share tab): who else is
 * here, and Offline or Syncing while edits wait, in the preview's bottom-left corner. Up to date with nobody else here,
 * nothing. A click opens Share. Status words only (§0.1).
 */
/** A shared project's live status (the worker's liveStatus, then its live events), or null. */
function useLiveStatus(projectId, bridge) {
  const [st, setSt] = useState(null);
  useEffect(() => {
    let live = true;
    bridge.call("liveStatus", [{ projectId }]).then((s) => live && setSt(s), () => {});
    const off = bridge.onEvent((ev) => { if (live && ev?.id === projectId && ev.topic === "live") setSt((s) => ({ ...s, ...ev.live })); });
    return () => { live = false; if (typeof off === "function") off(); };
  }, [projectId, bridge]);
  return st;
}
const livePeers = (st) => (Array.isArray(st?.peers) ? st.peers : []).filter((p) => typeof p?.actor?.key === "string" && typeof p.actor.name === "string");
// "Leo, Mia and Director are here": people by their first names (C's firstName, as History, Share and the cards name
// them), an agent by its product name
const hereName = (a) => (a.kind === "human" ? firstName(a.name) : a.name);
const hereWords = (peers) => (peers.length ? `${peers.map((p) => hereName(p.actor)).slice(0, 3).join(", ")}${peers.length > 3 ? ` and ${peers.length - 3} more` : ""} ${peers.length === 1 ? "is" : "are"} here` : "");
/**
 * The title bar's summary of a shared project (UI audit P2-11): its sync state and words, and up to three of the
 * people here, as the strip draws them (scripts/carton/strip-buttons.js). Null for a project that isn't shared.
 */
export function liveSummary(st) {
  if (!st?.shared) return null;
  const peers = livePeers(st);
  const offline = st.status === "offline" || st.status === "stopped", waiting = st.pending ?? 0;
  const state = offline ? "offline" : st.status !== "up-to-date" || waiting ? "syncing" : "ok";
  return {
    state,
    // DESIGN §8: "Offline: 3 changes not sent yet", "Sending 2 changes" (PLAN 8.3)
    words: offline ? words.offlineNotSent(waiting) : state === "syncing" ? (waiting ? words.sending(waiting) : words.syncing) : words.upToDate,
    here: hereWords(peers),
    people: peers.slice(0, 3).map((p) => ({ name: p.actor.name, initials: initials(p.actor.name), color: actorColor(p.actor), idle: !!p.idle })),
    more: Math.max(0, peers.length - 3),
  };
}
function LiveChip({ projectId, bridge }) {
  const st = useLiveStatus(projectId, bridge);
  return h(LiveChipView, { st, onOpen: () => { for (const f of panelRequests) f("share"); } });
}
// Over the preview, only while edits wait (offline or sending): who is here shows in the title bar (P2-11).
function LiveChipView({ st, onOpen, peersToo = false }) {
  if (!st?.shared) return null;
  const peers = peersToo ? livePeers(st) : [];
  const offline = st.status === "offline" || st.status === "stopped";
  const waiting = st.pending ?? 0;
  // PLAN 8.3: "Offline · 3 changes not sent yet", "Sending 2 changes"
  const status = offline ? (waiting ? words.offlineChip(waiting) : words.offline(0)) : st.status !== "up-to-date" && waiting ? words.sending(waiting) : null;
  if (!status && !peers.length) return null;
  const here = hereWords(peers);
  return h("button", { type: "button", className: "carton-live-chip", "data-state": offline ? "offline" : status ? "syncing" : "ok", title: [status, here].filter(Boolean).join(" · ") + ". Open Share", "aria-label": [status, here].filter(Boolean).join(". ") + ". Open Share", onClick: onOpen },
    status ? h(Icon, { name: offline ? "cloudSlash" : "syncing", size: 14 }) : null,
    status ? h("span", null, status) : null,
    peers.length ? h("span", { className: "carton-live-peers", "aria-hidden": true }, ...peers.slice(0, 3).map((p) => h("span", { key: p.actor.key, className: "carton-avatar", "data-idle": p.idle ? "" : undefined, style: { ["--carton-actor"]: actorColor(p.actor), width: 20, height: 20, fontSize: 8 } }, h("span", { className: "carton-avatar-initials" }, initials(p.actor.name)))),
      peers.length > 3 ? h("span", { className: "carton-live-more" }, `+${peers.length - 3}`) : null) : null);
}

/**
 * Join a shared project from the Dashboard (UI audit P2-9): its tile (sync/patches/ui.js) opens this dialog
 * (scripts/carton/sync/ui.js Join: the invite link, who you join as, and Join and open, PLAN 8.2), which opens the
 * project in its tab and closes.
 */
export function JoinDialog({ bridge, onClose }) {
  useEffect(() => { injectCardboardSkin(document); }, []);
  const Join = window.__cartonSyncUi?.Join;
  return h("div", { "data-carton-skin": "cardboard" },
    Join ? h(Join, { bridge, onOpened: onClose, onCancel: onClose })
      : h(Dialog, { title: words.joinTitle, onClose, className: "carton-join-dialog" }, h("p", { className: "carton-error", role: "alert" }, words.failed)));
}

// The timeline's frame and cut label (PLAN 1.5): editor-panel.js renders the timeline's wrapper with
// data-carton-viewing while viewing (the frame, the clips muted) and data-carton-cut on a cut other than Main (its
// name and dot at the right of the timeline's toolbar), from what this page publishes (window.__cartonTimelineMark).
// The timeline is Cardboard's, outside Carton's skin root, so its rules are a sheet of their own, on Cardboard's own
// structure there: the timeline's root (positioned) for the frame, its scroll area (data-timeline-scroll) for the
// muted clips, the toolbar's right-hand group for the label. A rule whose structure moved only stops drawing: the
// stage frame and the chip carry the state alone (the wrapper's anchor itself stops the build, as every patch does).
// (Scoped to the timeline's region: the title bar's chip carries data-carton-viewing and data-carton-cut of its own.)
const TL = '[data-analytics-region="editor-timeline"]';
export const TIMELINE_CSS = `
${TL}[data-carton-viewing]>*{position:relative}
${TL}[data-carton-viewing]>*::after{content:"";position:absolute;inset:0;z-index:40;box-shadow:inset 0 0 0 2px #8ab4ff66;pointer-events:none}
${TL}[data-carton-viewing] [data-timeline-scroll]{opacity:.72}
${TL}[data-carton-cut] .justify-between>.flex-1.justify-end::before{content:var(--carton-cut-label);flex:0 1 auto;min-width:0;max-width:220px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;margin-right:6px;padding-left:14px;
  background:radial-gradient(circle at 4px 50%,var(--carton-cut-dot,#f59e0b) 3.5px,transparent 4px);color:#ffffffb3;font-size:12px;line-height:16px}
`;
// What the timeline's wrapper shows: viewing (any), and your cut's name and dot when it isn't Main and nothing is viewed
// (the timeline shows that cut then). Null fields stay off.
export function timelineMarkOf(ui, projectId) {
  // comparing (N1): its own mark (only Cardboard's clip canvases muted, the frame, room for the strip)
  if (ui.comparing?.()) return { projectId, viewing: false, compare: true, cut: null, dot: null };
  const v = stageViewingOf(ui), chip = chipOf(ui);
  const other = !v && chip?.cut?.dot ? chip.cut : null;
  return { projectId, viewing: !!v, cut: other ? other.name : null, dot: other ? other.dot : null };
}
const sameMark = (a, b) => a === b || (!!a && !!b && a.projectId === b.projectId && a.viewing === b.viewing && !!a.compare === !!b.compare && a.cut === b.cut && a.dot === b.dot);

/**
 * The stage's viewing marks (PLAN 1.1, 1.4, 1.5), in one place so they say one thing: the frame round the stage with
 * the chip's label (its tab only when History's list isn't on screen), Esc back, the edit-attempt toast and the
 * frame's pulse, the timeline's frame and cut label, and Export returning to your edit first (PLAN 1.6).
 */
function StageViewing({ projectId, bridge, panel }) {
  const ui = useCartonUi();
  // what the stage shows when it isn't your edit (stageViewingOf), read again on each topic and each swap
  const [v, setV] = useState(() => stageViewingOf(ui));
  const [pulse, setPulse] = useState(0);
  useEffect(() => {
    injectStyles(document, TIMELINE_CSS, "carton-timeline-css");
    let mark = null;
    const update = () => {
      const next = stageViewingOf(ui);
      setV((was) => (was === next || (was && next && was.ref === next.ref && was.kind === next.kind && was.label === next.label && was.versionId === next.versionId) ? was : next));
      const m = timelineMarkOf(ui, projectId);
      if (!sameMark(m, mark)) { mark = m; window.__cartonTimelineMark?.(m); }
    };
    update();
    const offs = ["viewing", "preview", "cuts"].map((t) => ui.subscribe(t, update));
    if (typeof ui.onStage === "function") offs.push(ui.onStage(update));
    if (typeof ui.onCompare === "function") offs.push(ui.onCompare(update));
    return () => {
      for (const off of offs) off();
      window.__cartonTimelineMark?.({ projectId, viewing: false, cut: null, dot: null });
    };
  }, [ui, projectId]);
  // the edit-attempt toast goes with viewing
  const viewing = !!v;
  useEffect(() => { if (!viewing && toasts.value?.tone === "viewing") toasts.set(null); }, [viewing]);
  // An edit tried while viewing (PLAN 1.4): Cardboard's own refusal path asks here first (the bridge's blocked(), from
  // its xv: every edit its guard refuses), and gets one line and one pulse of the frame in place of its "read-only"
  // note. Back to my edit, and no Restore (DESIGN §4.3). A drag refused at every move pulses once, not at every move.
  const lastTry = useRef(0);
  useEffect(() => bridge.onBlocked?.(() => {
    const now = viewingOf(ui);
    if (!now) return false;
    const t = Date.now();
    if (t - lastTry.current < 1200 && toasts.value?.tone === "viewing") return true;
    lastTry.current = t;
    // (mid-sentence: "You're looking at your edit from 12:41 pm.")
    toasts.show(words.lookingAt(now.label.replace(/^Your\b/, "your")), { label: words.backToMyEdit, run: () => backToEdit(ui) }, "viewing");
    setPulse((n) => n + 1);
    return true;
  }), [bridge, ui]);
  // Export while viewing (PLAN 1.6, DESIGN §9): never what is viewed. Back to your edit first, said in a toast; Export
  // opens once the editor shows your edit (the bridge's beforeExport waits for this).
  useEffect(() => bridge.onBack?.((why) => {
    // (a Play still loading counts: it would take the stage under Export once it loaded)
    if (!viewingOf(ui) && !ui.pendingView?.()) return null;
    if (why === "export") toasts.show(words.backToExport);
    return Promise.resolve(backToEdit(ui));
  }), [bridge, ui]);
  const shown = useMemo(() => (v ? { ...v, label: upFirst(v.label) } : null), [v]);
  const isViewing = useCallback(() => !!stageViewingOf(ui) || !!viewingOf(ui), [ui]);
  const back = useCallback(() => backToEdit(ui), [ui]);
  return h(ViewingFrame, { viewing: shown, label: !listMarks(panel, v), onBack: back, isViewing, escapeState: bridge.selection, pulse });
}

const showToast = (text, actions, tone, icon, o) => toasts.show(text, actions, tone, icon, o);
// Compare's edit-attempt line goes when Compare does
showToast.clearViewing = () => { if (toasts.value?.tone === "viewing") toasts.set(null); };
const openPanel = (p) => { for (const f of panelRequests) f(p); };
/** The layer over the stage: viewing's frame, the conflict cards' floating stack, the toasts and the shared-footage notice. */
export const CartonStage = memo(function CartonStage({ projectId, bridge, player = null, portal = null }) {
  const [conn, ready] = useConn(projectId, bridge);
  // what the bridge tells the person (a save that failed, an undo refused), as a toast over the stage
  useEffect(() => bridge.onNotice?.(tellFailure), [bridge]);
  // Ctrl+Z or redo of a restore or a fold (UX redesign PLAN 5.3): "Restore undone." with Redo
  useEffect(() => bridge.onStep?.((s) => tellStep(bridge, s)), [bridge]);
  // A conflict card's "See it" (docs/carton-ux PLAN 7.1): the card calls ui.view({kind: "conflict"}) itself, which
  // connect() hands to the editor (the bridge's preview, the card's clip in view) and the frame labels ("Claude Code's
  // move of “Interview B”"). "On timeline" selects the clip and moves the playhead there, without viewing.
  const onReveal = useCallback((conflict) => { if (conflict.item) bridge.reveal(conflict.item); }, [bridge]);
  const [panel, setPanel] = useState(sidePanel.value);
  useEffect(() => {
    sidePanel.subs.add(setPanel);
    setPanel(sidePanel.value);
    return () => { sidePanel.subs.delete(setPanel); };
  }, []);
  if (!ready) return null;
  return h(CartonProvider, { ui: conn.ui },
    h("div", { className: "carton-stage", "data-carton-skin": "cardboard" }, h(CartonBoundary, { panel: "stage" },
      h(StageViewing, { projectId, bridge, panel }),
      // Compare in the editor (N1): its stage, the second player (editor-panel.js), the timeline's marks
      h(CompareStage, { projectId, bridge, player, portal, panel, toast: showToast, openPanel }),
      h("div", { className: "carton-stage-banner" }, h(MediaNotice, { projectId, bridge })),
      h("div", { className: "carton-stage-stack" }, h(ConflictStack, { onReveal, collapsed: panel != null })),
      h("div", { className: "carton-stage-toast" }, h(Toast)),
      h("div", { className: "carton-stage-live" }, h(LiveChip, { projectId, bridge })))));
});
export const __forTests = { stagePicture, confirmations, toasts, tellFailure, tellStep, Toast, LiveChipView, MediaNotice, Sidebar, CartonProvider, chipOf, viewingOf, backToEdit, cutColor, viewAndSwap, listMarks, timelineMarkOf, stageViewingOf, StageViewing, sidePanel, conns };
