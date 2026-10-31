// The app's library worker for the process tests: a lease holder of kind "worker" (it asks a live helper to hand
// over, and takes the lease back after being fenced). Reads commands on stdin:
//   commit <id> <json ops>   commit as the GUI would, on the engine
//   stall <ms> [marker]      block the main loop (the marker file is written first: the stall is on once it exists)
//   exit
// With `engineThread: true` in the config the holder runs on a worker_thread, as in the library worker, so a
// main-loop stall doesn't stop pings; without it the holder shares the main loop (the R5-06 control).
import { writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { holderSocketPath, keepLease } from "../../src/holder.ts";
import { EngineThread } from "../../src/engine-thread.ts";
import { Lease } from "../../src/lease.ts";
import { openTestStore } from "./sqlite-store.ts";
import { MiniEngine } from "./mini-engine.ts";

const [dbPath, json] = process.argv.slice(2);
const config = JSON.parse(json);
const t0 = Date.now();
let serve: (req: unknown) => Promise<unknown>;
let nonce: () => string | null;
let retire: () => Promise<void>;
if (config.engineThread) {
  const th = await EngineThread.start({ dbPath, factory: fileURLToPath(new URL("./mini-factory.ts", import.meta.url)), config });
  serve = (req) => th.call("serve", req);
  nonce = () => th.nonce;
  retire = () => th.stop();
} else {
  const store = openTestStore(dbPath);
  const engine = new MiniEngine(store, dbPath, config);
  const lease = keepLease(() => ({ lease: new Lease(store), engine, kind: "worker", socketPath: holderSocketPath(dirname(dbPath), "worker"), log: (e) => engine.event({ src: "holder", ...e }) }));
  await lease.start();
  serve = (req) => engine.serve(req);
  nonce = () => lease.current?.nonce ?? null;
  retire = () => lease.stop();
}
process.stdout.write(JSON.stringify({ ready: true, nonce: nonce(), ms: Date.now() - t0 }) + "\n");
const block = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
for await (const line of createInterface({ input: process.stdin })) {
  const [cmd, a, b] = line.split(" ");
  if (cmd === "commit") {
    const r = await serve({ id: a, actor: { kind: "human", id: "human:m1" }, op: { kind: "commit", ops: JSON.parse(b) } });
    process.stdout.write(JSON.stringify({ committed: a, r, t: Date.now() }) + "\n");
  } else if (cmd === "stall") {
    const s = Date.now();
    // a file, not a stdout line: on Windows a pipe write would only go out after the stall
    if (b) writeFileSync(b, String(s));
    block(Number(a));
    process.stdout.write(JSON.stringify({ stalled: Number(a), from: s, to: Date.now() }) + "\n");
  } else if (cmd === "nonce") process.stdout.write(JSON.stringify({ nonce: nonce() }) + "\n");
  else if (cmd === "exit") { await retire(); process.exit(0); }
}
