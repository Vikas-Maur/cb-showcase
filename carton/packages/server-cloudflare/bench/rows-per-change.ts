// Rows written per change in the real ProjectRoom (wrangler dev, workerd's DO SQLite counters: what Cloudflare
// bills), for the Free plan budget (PLAN §17, §18, L6). One writer pushes N changes in P5's mix: 44% style, 40% trim,
// 7% insert, 7% remove (P5's 2% remaps are left out; P5 measured them at 1 row too). Also: rows for a first hello
// (its rid claim), a repeated hello, and presence.
//
//   node bench/rows-per-change.ts [N=1000] [out.json]
//
// Keyframe uploads (one per 64 changes when a replica answers keyframeWanted) are not part of this run.

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { createHmacAuth } from "@carton/server";
import { webSocketTransport } from "@carton/server-node";
import type { sync } from "@carton/core";
import { startDev } from "../test/dev-server.ts";
import { stateDir } from "../test/state.ts";

const N = Number(process.argv[2] ?? 1000);
const OUT = process.argv[3];
const SECRET = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url");
const PROJECT = "rows-bench", BRANCH = "main-rows";

interface Clip { id: string; trackId: string; startTime: number; endTime: number; trimStart: number; trimEnd: number; opacity: number }
const tracks = ["V1", "V2", "V3", "V4"];
const clips = new Map<string, Clip>();
let nextClip = 0;
for (const t of tracks) for (let i = 0; i < 20; i++) {
  const id = `c${nextClip++}`;
  clips.set(id, { id, trackId: t, startTime: i * 10, endTime: i * 10 + 5, trimStart: 0, trimEnd: 5, opacity: 1 });
}
const doc0 = { tracks: tracks.map((id) => ({ id })), timelineItems: [...clips.values()] };

let x = 12345;
const rnd = () => ((x = (x * 1103515245 + 12345) >>> 0) / 2 ** 32);
const pick = () => [...clips.keys()][Math.floor(rnd() * clips.size)]!;
const rid = Buffer.from(crypto.getRandomValues(new Uint8Array(12))).toString("hex");

function next(seq: number): { kind: string; change: Record<string, unknown> } {
  const r = rnd(), id = `${rid}.${seq + 1}`;
  const base = { seq, pending: [] };
  const common = { id, hash: "0".repeat(64), author: { kind: "human", id: "bench" }, branchId: BRANCH, base, intent: null, kinds: null, policy: "merge", at: Date.now(), trackOrder: [] };
  if (r < 0.44) {
    const c = pick();
    return { kind: "style", change: { ...common, ops: [{ op: "set", path: ["timelineItems", c, "opacity"], value: Math.round(rnd() * 100) / 100 }], paths: [`timelineItems/${c}/opacity`], reads: [`timelineItems/${c}`], spans: [] } };
  }
  if (r < 0.84) {
    const c = clips.get(pick())!;
    const ne = Math.round((c.endTime + (rnd() < 0.5 ? -0.5 : 0.5)) * 10) / 10;
    if (ne <= c.startTime + 0.1) return next(seq);
    const ch = { ...common, ops: [{ op: "set", path: ["timelineItems", c.id, "endTime"], value: ne }], paths: [`timelineItems/${c.id}/endTime`, `timelineItems/${c.id}/#time`], reads: [`timelineItems/${c.id}`], spans: [{ track: c.trackId, lo: Math.min(c.endTime, ne, c.startTime), hi: Math.max(c.endTime, ne) }] };
    c.endTime = ne;
    return { kind: "trim", change: ch };
  }
  if (r < 0.91) {
    const t = tracks[Math.floor(rnd() * tracks.length)]!, id2 = `c${nextClip++}`, s = 1000 + nextClip * 10;
    const c: Clip = { id: id2, trackId: t, startTime: s, endTime: s + 3, trimStart: 0, trimEnd: 3, opacity: 1 };
    clips.set(id2, c);
    return { kind: "insert", change: { ...common, ops: [{ op: "insert", path: ["timelineItems", id2], value: c }], paths: [`timelineItems/${id2}`], reads: [`tracks/${t}`], spans: [{ track: t, lo: s, hi: s + 3 }] } };
  }
  const c = clips.get(pick())!;
  clips.delete(c.id);
  return { kind: "remove", change: { ...common, ops: [{ op: "remove", path: ["timelineItems", c.id] }], paths: [`timelineItems/${c.id}`], reads: [], spans: [{ track: c.trackId, lo: c.startTime, hi: c.endTime }] } };
}

const dev = await startDev({ config: join(import.meta.dirname, "..", "test", "wrangler.r2.dev.toml"), state: stateDir(`bench-rows-${Date.now()}`), vars: { AUTH_SECRET: SECRET } });
try {
  const auth = createHmacAuth({ secret: SECRET });
  const token = await auth.issue({ account: "bench", credential: "bench/dev-1", role: "owner", projectId: PROJECT, ttlMs: 3600_000 });
  const conn = await webSocketTransport({ keepaliveMs: 0 }).connect(`ws://127.0.0.1:${dev.port}/api/projects/${PROJECT}/ws`, { token });
  const waiters = new Map<string, (m: sync.ServerMessage) => void>();
  let any: ((m: sync.ServerMessage) => void) | null = null;
  conn.onMessage((m) => {
    const id = (m as { id?: string }).id;
    if ((m.type === "ack" || m.type === "reject") && id && waiters.has(id)) {
      waiters.get(id)!(m);
      waiters.delete(id);
    } else any?.(m);
  });
  const until = (type: string) => new Promise<sync.ServerMessage>((ok) => (any = (m) => m.type === type && ok(m)));
  const rows = async () => ((await (await fetch(`${dev.origin}/__test/stats/${PROJECT}`)).json()) as { stats: { rowsWritten: number; rowsRead: number }; databaseSize: number });

  conn.send({ type: "adopt", branchId: BRANCH, n: 0, stateHash: "", rows: [], rec: { id: BRANCH, name: "main", forkOf: null, owner: "bench", kind: "main", sequencer: { kind: "server", since: 0 } }, doc0, closure: [] } as unknown as sync.ClientMessage);
  await until("adopted");
  const r0 = await rows();
  conn.send({ type: "hello", branchId: BRANCH, have: 0, pending: [], rids: [rid], schemaVersion: 1 } as sync.ClientMessage);
  await until("hello");
  const r1 = await rows();
  conn.send({ type: "hello", branchId: BRANCH, have: 0, pending: [], rids: [rid], schemaVersion: 1 } as sync.ClientMessage);
  await until("hello");
  const r2 = await rows();
  for (let i = 0; i < 20; i++) conn.send({ type: "presence", branchId: BRANCH, actor: { kind: "human", id: "bench" }, state: { at: i } } as sync.ClientMessage);
  await new Promise((r) => setTimeout(r, 300));
  const r3 = await rows();

  const perKind: Record<string, { n: number; rows: number }> = {};
  let rejected = 0;
  const start = await rows();
  for (let seq = 0; seq < N; seq++) {
    const { kind, change } = next(seq);
    const before = await rows();
    const done = new Promise<sync.ServerMessage>((ok) => waiters.set(change.id as string, ok));
    conn.send({ type: "push", branchId: BRANCH, epoch: 1, changes: [change] } as unknown as sync.ClientMessage);
    const m = await done;
    if (m.type !== "ack") {
      rejected++;
      console.error("rejected", JSON.stringify(m).slice(0, 300));
      break;
    }
    const after = await rows();
    const k = (perKind[kind] ??= { n: 0, rows: 0 });
    k.n++;
    k.rows += after.stats.rowsWritten - before.stats.rowsWritten;
  }
  const end = await rows();
  const total = end.stats.rowsWritten - start.stats.rowsWritten;
  const accepted = Object.values(perKind).reduce((a, k) => a + k.n, 0);
  const result = {
    when: new Date().toISOString(),
    node: process.version,
    changes: accepted,
    rejected,
    rowsWrittenTotal: total,
    rowsPerChange: total / accepted,
    perKind: Object.fromEntries(Object.entries(perKind).map(([k, v]) => [k, { n: v.n, rows: v.rows, perChange: v.rows / v.n }])),
    firstHelloRows: r1.stats.rowsWritten - r0.stats.rowsWritten,
    repeatHelloRows: r2.stats.rowsWritten - r1.stats.rowsWritten,
    presence20Rows: r3.stats.rowsWritten - r2.stats.rowsWritten,
    databaseSizeBytes: end.databaseSize,
    bytesPerChange: (end.databaseSize - start.databaseSize) / accepted,
  };
  console.log(JSON.stringify(result, null, 2));
  if (OUT) writeFileSync(OUT, JSON.stringify(result, null, 2));
  conn.close();
} finally {
  await dev.stop();
}
