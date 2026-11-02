// Runs Cardboard's library worker (dist/library-worker.js) under plain Node, for tests. Electron starts it as a
// utility process and talks to it over process.parentPort; this stands in for that port. The worker needs nothing
// else from Electron. start() resolves once the worker reports ready; then call(method, ...args) is its RPC (the
// methods main's `library:call` reaches) and `events` holds what it posted (changes, mirror, ingest).
// It takes over process.parentPort and process.argv, so run it in a process of its own.
const path = require("path");

const start = (workerFile, root) => {
  const listeners = [], events = [], replies = new Map();
  let n = 0;
  process.parentPort = {
    postMessage(m) {
      if (m.kind === "reply") replies.get(m.id)?.(m), replies.delete(m.id);
      // The worker asks main to move files to the trash; say it's done.
      else if (m.kind === "host-call") listeners.forEach((l) => l({ data: { kind: "reply", id: m.id, ok: true } }));
      else events.push(m);
    },
    on(ev, cb) { if (ev === "message") listeners.push(cb); },
  };
  const call = (method, ...args) => new Promise((res, rej) => {
    const id = "c" + ++n;
    replies.set(id, (m) => (m.ok ? res(m.data) : rej(new Error(m.error))));
    listeners.forEach((l) => l({ data: { id, method, args } }));
  });
  process.argv.push("--root=" + root, "--account-id=test", "--api-base=http://127.0.0.1:9");
  require(path.resolve(workerFile));
  return new Promise((resolve) => {
    const t = setInterval(() => {
      if (events.some((e) => e.kind === "ready")) clearInterval(t), resolve({ call, events });
    }, 20);
  });
};

module.exports = { start };
