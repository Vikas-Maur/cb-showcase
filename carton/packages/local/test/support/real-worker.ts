// The app's library worker for the engine-backed process tests: the lease holder and Carton on an engine thread
// (worker_thread), as Cardboard's library worker will run them. Prints {ready} once it holds the lease; `exit` on stdin.
//   real-worker <projectDir> <projectId>
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { locateCartonDb } from "@carton/store-sqlite";
import { EngineThread } from "../../src/engine-thread.ts";

const [projectDir, projectId] = process.argv.slice(2);
const { dbPath } = locateCartonDb({ bundleDir: projectDir, projectId });
const th = await EngineThread.start({ dbPath, factory: fileURLToPath(new URL("./real-factory.ts", import.meta.url)) });
process.stdout.write(JSON.stringify({ ready: true, nonce: th.nonce, pid: process.pid }) + "\n");
for await (const line of createInterface({ input: process.stdin })) if (line.trim() === "exit") { await th.stop(); process.exit(0); }
