// H10 in main (dist/main.js): `cardboard-media://media/<id>` for a clip with no file on this computer, a teammate's clip
// in a shared project, is answered from Carton's range cache over the host (sync/media.js `serve`), instead of 1.4.0's
// "Source file missing". main asks the library worker where the clip lives (carton.liveMediaSource) only after its own
// lookup found no file, so local footage is served exactly as before. carton-node.cjs (with @carton/media) is loaded
// in main the first time a remote clip is asked for.
const PREAMBLE = String.raw`var __cartonSyncMain = (() => {
  let api = null;
  const load = () => {
    if (api) return api;
    const path = require("node:path");
    require(path.join(process.env.CARTON_DIR || path.join(process.resourcesPath, "carton"), "carton-node.cjs"));
    return (api = globalThis.__cartonSync);
  };
  return {
    // A Response for a teammate's clip, or null (main then answers as 1.4.0 does).
    async media(req) {
      const m = /^cardboard-media:\/\/media\/([^/?#]+)/.exec(req.url);
      if (!m) return null;
      let src = null;
      try { src = await __cartonMain.forward("liveMediaSource", [{ mediaId: decodeURIComponent(m[1]) }]); } catch { return null; }
      if (!src) return null;
      try { return await load().media.serve(req, src); }
      catch (e) { console.warn("[carton] a teammate's clip couldn't be streamed:", e?.message ?? e); return null; }
    },
  };
})();
`;

// UI audit P1-9, in the editor (EditorRoute-*.js): opening a joined project landed on Cardboard's "Missing Media
// Files", whose only way on is a red "Remove and Open" that deletes the clips from the timeline (and, live, from
// everyone's). A teammate's clip has no file here by design. 1.4.0's loader inspects each clip's file (`kr.inspect`)
// and sends what it can't find to that dialog; for a project Carton shares it now asks the worker first
// (carton.liveMediaHere), and:
// - a teammate's clip whose preview is on the host counts as available: it plays from there, through main's
//   `cardboard-media://` (above), as the shared preview it is;
// - one not sent yet goes to Cardboard's own "Offline" placeholder under a status of its own ("carton_waiting"), so
//   "Missing Media Files" never lists it and "Remove and Open" (which removes only `not_found`) can't remove it;
// - a clip whose original was on this computer and is gone still gets Cardboard's dialog, as before.
// The stage layer (scripts/carton/ui.js, MediaNotice) says what happened, in words. Carton off, a project that isn't
// shared, or a worker that doesn't answer within 4 s: 1.4.0's own path, unchanged.
const EDITOR = String.raw`const __cbCartonClips = new Map();
async function __cbCartonInspect(projectId, media, inspections) {
  const bridge = window.__carton;
  __cbCartonClips.delete(projectId);
  if (!bridge?.on || !media?.length || !inspections?.get) return inspections;
  const ids = media.filter((m) => { const s = inspections.get(m.id)?.status; return s !== "available" && s !== "needs-permission"; }).map((m) => m.id);
  if (!ids.length) return inspections;
  let r = null;
  try { r = await Promise.race([bridge.call("liveMediaHere", [{ projectId, mediaIds: ids }]), new Promise((ok) => setTimeout(() => ok(null), 4000))]); } catch { r = null; }
  if (!r?.clips) return inspections;
  const out = new Map(inspections), waiting = new Set(), names = new Map(media.map((m) => [m.id, m.data?.fileName || m.id]));
  let playable = 0;
  for (const m of media) {
    const st = r.clips[m.id];
    if (st === "playable") { out.set(m.id, { status: "available", item: m }); playable++; }
    else if (st === "waiting") waiting.add(m.id);
  }
  __cbCartonClips.set(projectId, { waiting, playable, names });
  if (!waiting.size) __cbCartonTell(projectId, [], playable);
  return out;
}
function __cbCartonTell(projectId, waiting, playable) {
  window.__cartonMediaHere = { projectId, waiting, playable };
  try { window.dispatchEvent(new CustomEvent("carton:media-here", { detail: window.__cartonMediaHere })); } catch {}
}
function __cbCartonSplit(projectId, items, offline) {
  const c = __cbCartonClips.get(projectId);
  if (!c?.waiting.size) return items;
  const theirs = items.filter((i) => c.waiting.has(i.mediaId));
  if (theirs.length) offline(theirs.map((i) => ({ ...i, status: "carton_waiting", reason: "carton_waiting" })));
  __cbCartonTell(projectId, theirs.map((i) => ({ mediaId: i.mediaId, fileName: c.names.get(i.mediaId) ?? i.fileName })), c.playable);
  return items.filter((i) => !c.waiting.has(i.mediaId));
}
`;

module.exports = {
  app({ main, editor }) {
    main.replace('if(!n)return new Response("Source file missing",{status:404});', 'if(!n){const __r=__cartonMain.on?await __cartonSyncMain.media(t):null;if(__r)return __r;return new Response("Source file missing",{status:404})}');
    main.prepend(PREAMBLE);
    editor.replace("inspections:await kr.inspect(e.id,e.media)", "inspections:await __cbCartonInspect(e.id,e.media,await kr.inspect(e.id,e.media))");
    editor.replace("return t.missingItems.length>0&&zn.getState().addOfflineMediaBatch(t.missingItems),t}", "return t.missingItems=__cbCartonSplit(e.id,t.missingItems,__w=>zn.getState().addOfflineMediaBatch(__w)),t.missingItems.length>0&&zn.getState().addOfflineMediaBatch(t.missingItems),t}");
    editor.prepend(EDITOR);
  },
};
