// One party (a person or an agent) editing the shared cut: core's ReplicaQueue and SyncClient over the WebSocket
// transport, exactly the client the app runs, in its own process (and its own network namespace when shaped). It logs
// one JSON line per event with a wall-clock time comparable across processes on this machine; the coordinator
// (sync.ts) turns them into convergence times, losses, duplicates and order checks.
//
//   node party.ts '<json config>'      stdin: "go" (start editing), "final" (print the final log), "quit"
import { createInterface } from "node:readline";
import { monitorEventLoopDelay } from "node:perf_hooks";
import { sync, hashDoc } from "@carton/core";
import { webSocketTransport } from "@carton/server-node";
import { hostMessageBlobs } from "@carton/host-http/client";
import { DOC0, schema, SCHEMA_VERSION, genEdit, rng, now, HOSTS, type HostName } from "./common.ts";

interface Cfg {
  host: HostName;
  projectId: string;
  branch: string;
  token: string;
  who: string;
  kind: "human" | "agent";
  edits: number;
  intervalMs: number;
  seed: number;
  /** Transport options under test (e.g. a dead-link timeout), passed straight through. */
  transport?: Record<string, unknown>;
  backoffMs?: number;
  /** Presence updates a second while editing (a cursor or playhead being dragged); 0 = none. */
  presenceHz?: number;
  /** Other SyncClient options under test (maxBackoffMs…). */
  client?: Record<string, unknown>;
}
const cfg = JSON.parse(process.argv[2]!) as Cfg;
// this process's own scheduling delay: on a busy box it inflates every latency measured here, so it is reported
const lag = monitorEventLoopDelay({ resolution: 10 });
lag.enable();
const out = (o: Record<string, unknown>) => process.stdout.write(JSON.stringify({ t: now(), ...o }) + "\n");
const b = cfg.branch;

const q = new sync.ReplicaQueue(schema);
q.addBranch({ id: b, name: "main", kind: "main", sequencer: { kind: "server", since: 0 } }, DOC0);
q.on((e) => {
  if (e.type === "confirmed") out({ ev: "confirmed", id: e.row.id, seq: e.row.seq, rebase: e.row.rebase, cards: e.lateCards.length, viaList: e.viaList });
  else if (e.type === "remote") for (const r of e.rows) out({ ev: "remote", id: r.id, seq: r.seq });
  else if (e.type === "absorbed") out({ ev: "absorbed", id: e.change.id, cards: e.cards.length, withdrawn: e.withdrawn });
  else if (e.type === "rejected") out({ ev: "rejected", id: e.change.id, reason: e.reason });
});
const origin = HOSTS[cfg.host];
const client = sync.createSyncClient(q, {
  transport: webSocketTransport(cfg.transport ?? {}),
  url: `${origin.replace(/^http/, "ws")}/api/projects/${cfg.projectId}/ws`,
  token: cfg.token,
  branchId: b,
  schemaVersion: SCHEMA_VERSION,
  blobs: hostMessageBlobs({ origin, projectId: cfg.projectId, token: cfg.token }),
  ...(cfg.backoffMs !== undefined ? { backoffMs: cfg.backoffMs } : {}),
  ...(cfg.client ?? {}),
  onEvent: (e) => {
    if (e.type === "status") out({ ev: "status", status: e.status });
    else if (e.type === "offline") out({ ev: "offline", why: e.why });
    else if (e.type === "online") out({ ev: "online" });
    else if (e.type === "keyframe") out({ ev: "keyframe", seq: e.seq });
    else if (e.type === "reject") out({ ev: "reject", id: e.id, reason: e.reason });
    else if (e.type === "rebase") out({ ev: "rebase", n: e.n });
    else if (e.type === "overwritten") out({ ev: "overwritten", id: e.id, by: e.by });
    else if (e.type === "error") out({ ev: "error", error: e.error.slice(0, 300), code: e.code });
  },
});
client.start();

const rand = rng(cfg.seed);
let n = 0;
const committed: string[] = [];
const rid = Array.from(crypto.getRandomValues(new Uint8Array(8)), (x) => x.toString(16).padStart(2, "0")).join("");
function commitOne(): void {
  for (let tries = 0; tries < 10; tries++) {
    const e = genEdit(rand, q.optimistic(b).doc);
    if (!e) continue;
    const id = `${cfg.who}.${rid}.${++n}`;
    const t = now();
    q.commit(b, { id, author: { kind: cfg.kind, id: cfg.who }, ops: e.ops, policy: e.policy, at: Date.now() });
    client.pump();
    committed.push(id);
    out({ ev: "commit", id, t, policy: e.policy, online: client.online });
    return;
  }
}

let presenceSent = 0;
async function edit(): Promise<void> {
  const t0 = now();
  const hz = cfg.presenceHz ?? 0;
  const presence = hz > 0 ? setInterval(() => (client.sendPresence({ kind: cfg.kind, id: cfg.who }, { at: Math.round(now() - t0), playhead: Math.round(rand() * 6000) / 100 }), presenceSent++), 1000 / hz) : null;
  for (let i = 0; i < cfg.edits; i++) {
    // evenly paced with ±40% jitter, so parties don't edit in lockstep
    const at = t0 + i * cfg.intervalMs + (rand() - 0.5) * 0.8 * cfg.intervalMs;
    const wait = at - now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    commitOne();
  }
  if (presence) clearInterval(presence);
  out({ ev: "edits-done", n: committed.length, presenceSent });
}

const rl = createInterface({ input: process.stdin });
rl.on("line", (line) => {
  const cmd = line.trim();
  if (cmd === "go") void edit();
  else if (cmd === "state") out({ ev: "state", head: q.headSeq(b), pending: q.pending(b).length, online: client.online });
  else if (cmd === "final") {
    const head = q.headSeq(b);
    const rows = q.rows(b);
    out({
      ev: "final",
      head,
      pending: q.pending(b).length,
      ids: rows.map((r) => (r.placeholder ? null : r.id)),
      stateHash: hashDoc(q.confirmedState(b, head), schema),
      committed,
      stats: client.stats,
      loopLagMs: { p50: lag.percentile(50) / 1e6, p99: lag.percentile(99) / 1e6, max: lag.max / 1e6 },
    });
  } else if (cmd === "quit") {
    client.stop();
    process.exit(0);
  }
});
out({ ev: "ready" });
