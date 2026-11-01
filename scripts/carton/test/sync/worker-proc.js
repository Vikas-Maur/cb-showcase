// One "computer" for the live-sync tests: Cardboard's real (patched) library worker under Node, through the harness
// that stands in for Electron's utility-process port (../worker-harness.js). Its own app data (XDG_DATA_HOME /
// LOCALAPPDATA) makes it a separate machine: its own install key, sessions and sync settings.
// Protocol, one JSON object per line:
//   stdin  {id, method, args}         a library:call, as main makes it (e.g. "carton.liveShare"); "test.cartonOpen":
//                                     the bundles the facade has a Carton open for; "test.counters": what
//                                     count-calls.cjs counted since the last call (when it was --require'd)
//   stdout {id, ok, data | error}     its answer
//   stdout {event}                    what the worker posted to main (project changes, {kind:"carton"} events)
//   node worker-proc.js <library-worker.js> <root>
const { createInterface } = require("readline");
const [workerFile, root] = process.argv.slice(2);
const out = (x) => process.stdout.write(JSON.stringify(x) + "\n");
// The worker logs to stdout too: only our lines are JSON objects with these keys.
const log = console.log;
console.log = (...a) => process.stderr.write(a.join(" ") + "\n");
console.info = console.log;

(async () => {
  const { call, events } = await require("../worker-harness.js").start(workerFile, root);
  let seen = 0;
  setInterval(() => { while (seen < events.length) out({ event: events[seen++] }); }, 10).unref();
  out({ ready: true, pid: process.pid });
  for await (const line of createInterface({ input: process.stdin })) {
    if (!line.trim()) continue;
    const { id, method, args } = JSON.parse(line);
    if (method === "exit") process.exit(0);
    // The bundles the facade in this process has a Carton open for (the same carton-node.cjs the worker loaded).
    // What the worker did since the last call, as count-calls.cjs counts it (save-cost.test.js; null without it).
    if (method === "test.counters") {
      out({ id, ok: true, data: globalThis.__cartonTestCounters?.() ?? null });
      continue;
    }
    if (method === "test.cartonOpen") {
      try { out({ id, ok: true, data: require(require("path").join(process.env.CARTON_DIR, "carton-node.cjs")).internals.openBundles() }); }
      catch (e) { out({ id, ok: false, error: String(e?.message ?? e) }); }
      continue;
    }
    call(method, ...(args ?? [])).then((data) => out({ id, ok: true, data }), (e) => out({ id, ok: false, error: String(e?.message ?? e) }));
  }
})().catch((e) => { log(JSON.stringify({ fatal: String(e?.stack ?? e) })); process.exit(1); });
setTimeout(() => process.exit(0), 600_000).unref();
