// `peer join --machine <name>`: the computer name Carton records with a participant's edits (each author's undo group,
// `local:<user>@<host>` from os.userInfo() and os.hostname(), which `cb history --json` shows), in place of this box's.
// Loaded first in the participant's processes (its daemon, and the cb runs it starts: NODE_OPTIONS=--require), from
// DEMO_MACHINE and DEMO_MACHINE_USER. Nothing else reads them.
const os = require("os");
const host = process.env.DEMO_MACHINE, user = process.env.DEMO_MACHINE_USER;
if (host) {
  os.hostname = () => host;
  const info = os.userInfo.bind(os);
  if (user) os.userInfo = (o) => ({ ...info(o), username: user });
}
