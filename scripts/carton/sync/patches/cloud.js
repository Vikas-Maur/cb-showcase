// H13 in cb (resources/cli/cardboard.mjs): cb's cloud mode (CARDBOARD_CLOUD_PROJECTS=1) pulls the whole project.json
// before each MCP tool call and PUTs it back after. For a project Carton shares (sync/worker.js, "H13"), the pull is the
// lease holder catching up (headless sync: a helper when the app is closed) and head going into project.json, and the
// push is nothing, as every edit already went through the holder. Any other project keeps Cardboard's own path, and
// with Carton off nothing changes.
const PREAMBLE = String.raw`var __cartonSyncCli = (() => {
  let api;
  const sync = () => {
    if (api === undefined) {
      try {
        require(require("node:path").join(process.env.CARTON_DIR || require("node:url").fileURLToPath(new URL("../carton/", import.meta.url)), "carton-node.cjs"));
        api = globalThis.__cartonSync?.cli ?? null;
      } catch (e) { api = null; console.warn("[carton] live sync didn't load; cloud mode runs as Cardboard's:", e?.message ?? e); }
    }
    return api;
  };
  // true: Carton took it (the project is shared through Carton); false: Cardboard's own cloud path runs.
  return {
    pull: async (lib, id) => { const s = __cartonCli.on && sync(); return s ? s.pull(lib, id) : false; },
    push: async (lib, id) => { const s = __cartonCli.on && sync(); return s ? s.push(lib, id) : false; },
  };
})();
`;

module.exports = {
  cli({ cb }) {
    cb.replace("C!==null&&await v.pull(C)", "C!==null&&!(await __cartonSyncCli.pull(s,C))&&await v.pull(C)");
    cb.replace("let F=await v.push(U);", "let F=await __cartonSyncCli.push(s,U)?null:await v.push(U);");
    cb.prepend(PREAMBLE);
  },
};
