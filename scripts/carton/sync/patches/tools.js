// H10 for the agent's ffmpeg-based tools (grab_frame, filmstrip, detect_scenes, probe_media…), in both copies of
// Cardboard's media resolver for them (`inspectable`: the CLI's chunk and the library worker): a clip with no file on
// this computer, in a project Carton shares, is read from the loopback range server instead of failing with "Media …
// is missing on disk". ffmpeg and ffprobe take the URL as their input and seek with Range, so a frame grab fetches what
// it decodes (verified bytes only; a proxy still uploading is a live HLS playlist ffmpeg follows). The probe result is
// cached by media id as for a file. Anything else (Carton off, a project that isn't shared, a clip not shared yet)
// keeps 1.4.0's error.
const preamble = (dir) => String.raw`var __cartonSyncTools = async (bundlePath, mediaId) => {
  if (!__carton.on || !bundlePath) return null;
  try {
    if (!globalThis.__cartonSync) require(require("node:path").join(process.env.CARTON_DIR || ${dir}, "carton-node.cjs"));
    return (await globalThis.__cartonSync?.toolUrlFor?.(bundlePath, mediaId)) ?? null;
  } catch (e) {
    console.warn("[carton] a shared clip couldn't be read from its host:", e?.message ?? e);
    return null;
  }
};
`;

// The CLI's chunk starts with "#!" and imports: the preamble goes after its require shim (it runs later, once require
// exists), as the other sync patches do.
const SHIM = "const require = __createRequire(import.meta.url);\n";

module.exports = {
  cli({ chunk }) {
    chunk.replace(SHIM, SHIM + preamble(`require("node:url").fileURLToPath(new URL("../../carton/", import.meta.url))`));
    // `n` is the library's project index (bundlePathForMedia), `Ds` the probe cached by media id.
    chunk.replace(
      "let y=await i(h);if(!y)throw new Error(`Media ${h} is missing on disk`);return{path:y.nativePath,probe:await Ds(d,h,y.nativePath)}}",
      "let y=await i(h);if(!y){const __u=await __cartonSyncTools(n.bundlePathForMedia(h),h);if(__u)return{path:__u,probe:await Ds(d,h,__u)};throw new Error(`Media ${h} is missing on disk`)}return{path:y.nativePath,probe:await Ds(d,h,y.nativePath)}}",
    );
  },
  app({ worker }) {
    worker.prepend(preamble(`require("node:path").join(__dirname, "..", "..", "carton")`));
    worker.replace(
      "let x=await a(y);if(!x)throw new Error(`Media ${y} is missing on disk`);return{path:x.nativePath,probe:await L4(l,y,x.nativePath)}}",
      "let x=await a(y);if(!x){const __u=await __cartonSyncTools(n.bundlePathForMedia(y),y);if(__u)return{path:__u,probe:await L4(l,y,__u)};throw new Error(`Media ${y} is missing on disk`)}return{path:x.nativePath,probe:await L4(l,y,x.nativePath)}}",
    );
  },
};
