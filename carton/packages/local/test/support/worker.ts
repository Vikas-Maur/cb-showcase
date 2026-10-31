// The app's library worker for the process tests: a lease holder of kind "worker" (it asks a live helper to hand
// over). Reads commands on stdin: `commit <id> <json ops>` commits as the GUI would; `exit`.
// With `--engine-thread` the holder runs on a worker_thread (as in the library worker), and `stall <ms>` blocks only
// the main loop; without it the holder shares the main loop, so a main-loop stall stops pings too (the control).
import { createInterface } from "node:readline";
import { dirname } from "node:path";
import { Holder, holderSocketPath } from "../../src/holder.ts";
import { Lease } from "../../src/lease.ts";
import { openTestStore } from "./sqlite-store.ts";
import { MiniEngine } from "./mini-engine.ts";

const [dbPath, json] = process.argv.slice(2);
const config = JSON.parse(json);
const store = openTestStore(dbPath);
const engine = new MiniEngine(store, dbPath, config);
const t0 = Date.now();
const holder = new Holder({ lease: new Lease(store), engine, kind: "worker", socketPath: holderSocketPath(dirname(dbPath), "worker"), log: (e) => engine.event({ src: "holder", ...e }) });
await holder.start();
engine.event({ type: "worker-lease", ms: Date.now() - t0 });
process.stdout.write(JSON.stringify({ ready: true, nonce: holder.nonce, ms: Date.now() - t0 }) + "\n");
const block = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
for await (const line of createInterface({ input: process.stdin })) {
  const [cmd, a, b] = line.split(" ");
  if (cmd === "commit") {
    const r = await engine.serve({ id: a, actor: { kind: "human", id: "human:m1" }, op: { kind: "commit", ops: JSON.parse(b) } });
    process.stdout.write(JSON.stringify({ committed: a, r, t: Date.now() }) + "\n");
  } else if (cmd === "stall") block(Number(a));
  else if (cmd === "exit") { await holder.retire("exit"); process.exit(0); }
}
