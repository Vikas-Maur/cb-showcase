// Fault injection for the sync tests (review of fix/demo-sync-bugs, P2: the reviewer's): while the file named by
// CARTON_TEST_STALL exists, every fetch whose body names a clip's shared record (`carton/media/…`) never answers, as a
// host read stuck on the network would; `<file>.hit` says one did. Loaded into a worker with NODE_OPTIONS=--require.
const fs = require("node:fs");
const real = globalThis.fetch;
globalThis.fetch = async (u, o) => {
  const file = process.env.CARTON_TEST_STALL;
  if (file && o?.body && String(o.body).includes("carton/media/") && fs.existsSync(file)) {
    fs.writeFileSync(file + ".hit", String(u));
    return new Promise(() => {});
  }
  return real(u, o);
};
