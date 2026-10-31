// Template: copy it into your repo and swap the lines marked "← your …" for your own.
// Run the whole sync-protocol system suite (system-v11's scenarios, H1–H4, P9, v14 holes) with the
// sequencer on your own SequencerStorage. The scenarios run in deterministic virtual time around the real
// ReplicaQueue, SyncClient and createSequencer; storage is the one plug-in point. The factory is synchronous and must
// give a fresh, empty storage on every call (each simulated world gets its own).
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after } from "node:test";
import { systemSuite } from "@carton/conformance";
import { nodeSqliteStorage, type NodeSqliteStorage } from "@carton/server-node"; // ← your SequencerStorage

const root = process.env.CARTON_SCRATCH ?? join(tmpdir(), "carton-conformance");
mkdirSync(root, { recursive: true });
const dir = mkdtempSync(join(root, "system-"));
const opened: NodeSqliteStorage[] = [];
after(() => {
  for (const s of opened) s.close();
  rmSync(dir, { recursive: true, force: true });
});
let n = 0;

// quick: true leaves out the slow files (P9's 160 simulated runs, chaos, G1); drop it for the full run.
systemSuite("my-sql", {
  storage: () => {
    const s = nodeSqliteStorage(join(dir, `world-${++n}.db`), { durability: "normal" });
    opened.push(s);
    return s;
  },
  quick: process.env.FULL !== "1",
});
