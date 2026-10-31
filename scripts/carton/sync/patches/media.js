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

module.exports = {
  app({ main }) {
    main.replace('if(!n)return new Response("Source file missing",{status:404});', 'if(!n){const __r=__cartonMain.on?await __cartonSyncMain.media(t):null;if(__r)return __r;return new Response("Source file missing",{status:404})}');
    main.prepend(PREAMBLE);
  },
};
